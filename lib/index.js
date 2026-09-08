import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import {
  normalizeConfiguredModels,
  renderCatalogResult,
  renderConfiguredModels,
} from './model-catalog.js'

const name = 'dsh-subagent-model-router'
const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'skills', 'llm', 'settings', 'sessionProjections']
const SETTINGS_NAMESPACE = 'subagent-model-router'
const CATALOG_TOOL_NAME = 'model_subagent_catalog'
const CONFIG_TOOL_NAME = 'configure_subagent_models'
const DELEGATION_TOOL_NAME = 'subagent_model'
const WAIT_TOOL_NAME = 'wait-for-subagents'
const SETTINGS_ROUTE = '/dsh-subagent-model-router/settings'
const SETTINGS_BODY_LIMIT = 256 * 1024
const SKILL_URL = new URL('../skills/model-subagent-setup/SKILL.md', import.meta.url)
const SKILL_DIRECTORY_URL = new URL('../skills/model-subagent-setup/', import.meta.url)
const MODEL_SUBAGENT_SECTION_ORDER = 116.25
const WAIT_WATCHDOG_INTERVAL_MS = 10_000
const CONTINUABLE_DELEGATION_TOOL_NAMES = new Set(['subagent', 'subagent_fork', 'auto_agent_run'])

const ModelConfig = z.object({
  alias: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  displayName: z.string(),
  tags: z.array(z.string()).default([]),
  description: z.string().required(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

const SettingsSchema = z.object({
  models: z.array(ModelConfig).default([]),
  subagentProvider: z.string().default('spawn'),
  maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(3),
  enableRunInBackground: z.boolean().default(true),
})

const modelRouteProjectionSchema = zod.union([
  zod.object({
    provider: zod.string(),
    model: zod.string(),
  }),
  zod.null(),
])
const modelRouteProjectionStateSchema = zod.object({
  descriptorSeen: zod.boolean(),
  route: zod.object({
    provider: zod.string(),
    model: zod.string(),
  }).optional(),
})

function sameModelRoute(left, right) {
  return left?.provider === right.provider && left.model === right.model
}

function modelRouteProjectionView(state) {
  return state.route ?? null
}

const subagentModelRouteProjectionDefinition = {
  key: 'subagentModelRoute',
  stateSchema: modelRouteProjectionStateSchema,
  wire: {
    viewSchema: modelRouteProjectionSchema,
    view: modelRouteProjectionView,
  },
  // Legacy DSH projection registries read the wire schema/view at top level.
  schema: modelRouteProjectionSchema,
  view: modelRouteProjectionView,
  init: () => ({ descriptorSeen: false }),
  apply(state, event) {
    if (event.type === 'subagent/descriptor') return { descriptorSeen: true }
    if (!state.descriptorSeen) return state
    const route = event.type === 'request/header'
      ? {
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        }
      : event.type === 'assistant/message'
        ? {
            provider: event.data.message.source.provider,
            model: event.data.message.source.model,
          }
        : undefined
    if (route === undefined || sameModelRoute(state.route, route)) return state
    return { ...state, route }
  },
  stateVersion: 1,
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function normalizeSettings(value = {}) {
  const models = normalizeConfiguredModels(value.models ?? [])
  const subagentProvider = value.subagentProvider ?? 'spawn'
  const maxDepth = value.maxDepth ?? 3
  const enableRunInBackground = value.enableRunInBackground !== false

  if (typeof subagentProvider !== 'string' || subagentProvider.trim().length === 0) {
    throw new Error('dsh-subagent-model-router: subagentProvider must be a non-empty string')
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('dsh-subagent-model-router: maxDepth must be a non-negative safe integer')
  }

  return {
    models,
    subagentProvider: subagentProvider.trim(),
    maxDepth,
    enableRunInBackground,
  }
}

function assertProviderCapabilities(provider, settings) {
  if (!provider.capabilities.depthLimit) {
    throw new Error(`dsh-subagent-model-router: subagent provider "${provider.name}" cannot enforce maxDepth`)
  }
  if (settings.enableRunInBackground && provider.prepareContinuable === undefined) {
    throw new Error(`dsh-subagent-model-router: subagent provider "${provider.name}" does not support continuable background runs`)
  }
}

function outputValueText(values) {
  return values
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withPartialText(error, output) {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

function abortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${WAIT_TOOL_NAME} was cancelled`)
}

async function awaitWithSignal(promise, signal) {
  if (signal.aborted) throw abortReason(signal)
  let removeAbortListener = () => {}
  const aborted = new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    removeAbortListener()
  }
}

function createWatchdogDelay() {
  let timer
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, WAIT_WATCHDOG_INTERVAL_MS)
    }),
    cancel() {
      clearTimeout(timer)
    },
  }
}

function sessionEvents(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session.events)) return session.events
  throw new Error('the subagent session does not expose readable event history')
}

function recoveredAssistantOutput(events) {
  let message
  const partial = []
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data.message.content.length > 0) {
      message = event.data.message.content
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      if (event.data.chunk.text.length > 0) partial.push(event.data.chunk.text)
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length === 0 ? undefined : [{ type: 'text', text }]
}

function recoveredStopReason(events) {
  const stepped = new Set()
  const claimed = new Set()
  let open
  let end
  let droppedUnrun = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        open = event.data.turn
        break
      case 'step/start':
        stepped.add(event.data.turn)
        break
      case 'agent/inbox/spliced':
        if (event.data.removedCount === undefined) break
        if (event.data.outcome === 'canceled') droppedUnrun ||= event.data.inserted.length === 0
        else if (open !== undefined) claimed.add(open)
        break
      case 'turn/end': {
        const { turn, reason } = event.data
        open = undefined
        if (stepped.delete(turn) || (claimed.delete(turn) && reason.kind !== 'completed')) {
          end = reason
          droppedUnrun = false
        }
        break
      }
      default:
        break
    }
  }
  switch (end?.kind) {
    case 'max-tokens': return 'max-tokens'
    case 'aborted':
    case 'interrupted': return 'aborted'
    case 'error': return 'error'
    case 'blocked': return 'refusal'
    case 'completed': return droppedUnrun ? 'aborted' : 'completed'
    case undefined: return droppedUnrun ? 'aborted' : undefined
    default: return 'error'
  }
}

function expectedSettlementSummary(childId, stopReason) {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed': return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted': return `${subject} was stopped before it finished.`
    case 'max-tokens': return `${subject} ran out of room before it finished.`
    case 'refusal': return `${subject} declined the task.`
    case 'error': return `${subject} failed before it finished.`
    default: return undefined
  }
}

function matchingSettlementReason(messages, childId) {
  for (const message of messages) {
    if (message.source?.kind !== 'subagent-settled' || message.source.senderSessionId !== childId) continue
    for (const stopReason of ['completed', 'aborted', 'max-tokens', 'refusal', 'error']) {
      if (message.source.summary === expectedSettlementSummary(childId, stopReason)) return stopReason
    }
  }
  return undefined
}

function matchingSettlementReasonFromEvents(events, childId) {
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced' || event.data.outcome === 'canceled') continue
    const stopReason = matchingSettlementReason(event.data.inserted, childId)
    if (stopReason !== undefined) return stopReason
  }
  return undefined
}

function continuableDelegationRequested(exec) {
  if (!CONTINUABLE_DELEGATION_TOOL_NAMES.has(exec.name)) return false
  const args = exec.arguments
  return typeof args !== 'object'
    || args === null
    || Array.isArray(args)
    || args.run_in_background !== false
}

function continuableChildFromResult(result) {
  if (result.isError || typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) return undefined
  const value = result.value
  if ((value.kind !== 'continuable' && value.kind !== 'background') || typeof value.subagentId !== 'string') return undefined
  return value.subagentId
}

function createOrchestrationTracker(ctx) {
  const states = new Map()
  const recordsByIdentity = new Map()
  const completedRunsByParent = new WeakMap()
  const pendingStartsByParent = new WeakMap()
  const earlySettlements = new Map()
  let startsInFlight = 0
  let nextRecordSequence = 0
  let nextStartSequence = 0
  let nextProvisionalSequence = 0
  let trackerFailure

  const identityKey = (childId, runId) => `${childId}\u0000${runId}`
  const provisionalKey = (childId) => `${childId}\u0000pending:${nextProvisionalSequence += 1}`
  const completedRunsFor = (parent) => {
    let completed = completedRunsByParent.get(parent)
    if (completed === undefined) {
      completed = new Set()
      completedRunsByParent.set(parent, completed)
    }
    return completed
  }
  const rememberCompletedRun = (parent, key) => {
    const completed = completedRunsFor(parent)
    completed.add(key)
    if (completed.size > 256) completed.delete(completed.values().next().value)
  }
  const rememberPendingStart = (parent, info, child) => {
    let pending = pendingStartsByParent.get(parent)
    if (pending === undefined) {
      pending = []
      pendingStartsByParent.set(parent, pending)
    }
    pending.push({ sequence: nextStartSequence += 1, info, child })
  }

  const stateFor = (parent) => {
    if (trackerFailure !== undefined) throw trackerFailure
    let state = states.get(parent)
    if (state === undefined) {
      state = {
        parent,
        children: new Map(),
        starting: 0,
        waiters: new Set(),
        interruptWaiters: new Set(),
        waiting: 0,
        disposed: false,
      }
      states.set(parent, state)
    }
    return state
  }

  const notify = (state) => {
    for (const resolve of state.waiters) resolve()
    state.waiters.clear()
  }

  const prune = (parent, state) => {
    if (states.get(parent) === state && state.starting === 0 && state.children.size === 0 && state.waiting === 0) {
      states.delete(parent)
    }
  }

  const activationBoundary = (agent, events = sessionEvents(agent.session)) => {
    const firstLiveSeq = agent.session.firstLiveSeq
    return Number.isSafeInteger(firstLiveSeq) && firstLiveSeq >= 0 && firstLiveSeq <= events.length
      ? firstLiveSeq
      : events.length
  }

  const updateRecord = (record, model, label, agent) => {
    if (model !== undefined) record.model = model
    if (label !== undefined) record.label = label
    if (record.agent === undefined && agent !== undefined) {
      record.agent = agent
      record.boundary = activationBoundary(agent)
    }
    if (record.settlement !== undefined) {
      if (record.model === undefined) delete record.settlement.model
      else record.settlement.model = record.model
      record.settlement.label = record.label
    }
  }

  const settle = (record, info) => {
    if (record.settlement !== undefined || record.failure !== undefined) return
    record.settlement = {
      subagentId: record.subagentId,
      ...(record.model === undefined ? {} : { model: record.model }),
      label: record.label,
      stopReason: String(info.stopReason),
      output: info.lastAssistantMessage ?? [],
    }
    record.resolve(record.settlement)
  }

  const failRecord = (record, error) => {
    if (record.settlement !== undefined || record.failure !== undefined) return
    record.failure = error
    record.resolve(undefined)
  }

  const latestRecordForChild = (state, childId, predicate = () => true) => {
    let latest
    for (const record of state.children.values()) {
      if (record.subagentId === childId && predicate(record)) latest = record
    }
    return latest
  }

  const bindRunIdentity = (state, record, runId) => {
    if (record.runId !== undefined) return record.runId === runId ? record : undefined
    const key = identityKey(record.subagentId, runId)
    const exact = state.children.get(key)
    if (exact !== undefined) return exact
    state.children.delete(record.key)
    if (recordsByIdentity.get(record.key) === record) recordsByIdentity.delete(record.key)
    record.key = key
    record.runId = runId
    state.children.set(key, record)
    recordsByIdentity.set(key, record)
    const early = earlySettlements.get(key)
    if (early !== undefined) {
      earlySettlements.delete(key)
      settle(record, early)
    }
    return record
  }

  const createRecord = (state, childId, runId, model, label, agent, claimedByTool = false, parentBoundary, childBoundary) => {
    let resolve
    const settled = new Promise((done) => {
      resolve = done
    })
    const key = runId === undefined ? provisionalKey(childId) : identityKey(childId, runId)
    const record = {
      key,
      sequence: nextRecordSequence += 1,
      claimedByTool,
      parent: state.parent,
      subagentId: childId,
      runId,
      model,
      label,
      agent,
      boundary: childBoundary ?? (agent === undefined ? 0 : sessionEvents(agent.session).length),
      parentBoundary: parentBoundary ?? sessionEvents(state.parent.session).length,
      resolve,
      settled,
      settlement: undefined,
      failure: undefined,
    }
    state.children.set(key, record)
    recordsByIdentity.set(key, record)
    const early = earlySettlements.get(key)
    if (early !== undefined) {
      earlySettlements.delete(key)
      settle(record, early)
    }
    return record
  }

  const trackStartEvent = (state, childId, runId, model, label, agent) => {
    if (state.disposed) return
    const key = identityKey(childId, runId)
    let record = state.children.get(key)
    if (record === undefined) {
      const provisional = latestRecordForChild(state, childId, (candidate) => candidate.runId === undefined)
      record = provisional === undefined
        ? createRecord(state, childId, runId, model, label, agent)
        : bindRunIdentity(state, provisional, runId)
    }
    updateRecord(record, model, label, agent)
  }

  const isParkedActivation = (agent, boundary, events = sessionEvents(agent.session)) => (
    agent.status === 'idle'
    && agent.inbox?.hasPending === true
    && recoveredStopReason(events.slice(boundary)) === 'aborted'
  )

  const discoverResidentChildren = (state) => {
    const agents = ctx.get('agents')
    if (typeof agents?.list !== 'function') return
    for (const child of agents.list()) {
      if (child === state.parent
        || (child.status !== 'running' && !(child.status === 'idle' && child.inbox?.hasPending === true))
        || child.session.header?.origin !== 'subagent'
        || child.session.header.parentSession !== state.parent.id
        || [...recordsByIdentity.values()].some((record) => record.subagentId === child.id)) continue
      const events = sessionEvents(child.session)
      const boundary = activationBoundary(child, events)
      if (child.status !== 'running' && !isParkedActivation(child, boundary, events)) continue
      const descriptor = events.findLast((event) => event.type === 'subagent/descriptor')?.data
      if (descriptor?.mode !== 'continuable') continue
      // A retained Agent identifies the exact process-local activation, while its
      // Session boundary identifies the suffix that activation could have
      // produced. Use it rather than the observation time so a terminal turn
      // logged just before discovery remains recoverable from the manager notice.
      createRecord(state, child.id, undefined, descriptor.agentModel, descriptor.label, child, false, undefined, boundary)
    }
  }

  const pausedRecords = (records) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return []
    return records.filter((record) => {
      if (record.settlement !== undefined || record.failure !== undefined || record.agent === undefined) return false
      try {
        return agents.get(record.subagentId) === record.agent && isParkedActivation(record.agent, record.boundary)
      } catch (error) {
        ctx.logger.warn(`${WAIT_TOOL_NAME}: could not inspect parked state for subagent ${record.subagentId}: ${errorMessage(error)}`)
        return false
      }
    })
  }

  const trackToolResult = (activation, childId, model, label, agent) => {
    const { state } = activation
    if (state.disposed) return
    const pending = pendingStartsByParent.get(state.parent)
    // startContinuable reserves a fresh child id before publication, so childId
    // uniquely associates an ambiguous synchronous lifecycle edge with this call.
    const pendingIndex = pending?.findLastIndex((entry) => (
      entry.info.id === childId && entry.sequence > activation.afterStartSequence
    )) ?? -1
    if (pendingIndex >= 0) {
      const [entry] = pending.splice(pendingIndex, 1)
      if (pending.length === 0) pendingStartsByParent.delete(state.parent)
      const record = createRecord(state, childId, entry.info.runId, model, label, agent ?? entry.child, true, activation.parentBoundary)
      updateRecord(record, model, label, agent ?? entry.child)
      return
    }
    const exact = latestRecordForChild(state, childId, (record) => (
      record.runId !== undefined
      && record.sequence > activation.afterSequence
      && record.claimedByTool === false
    ))
    if (exact !== undefined) {
      exact.claimedByTool = true
      updateRecord(exact, model, label, agent)
      return
    }
    const completed = completedRunsFor(state.parent)
    const early = [...earlySettlements.values()].findLast((info) => (
      info.id === childId && !completed.has(identityKey(childId, info.runId))
    ))
    if (early !== undefined) {
      earlySettlements.delete(identityKey(childId, early.runId))
      const record = createRecord(state, childId, early.runId, model, label, agent, true, activation.parentBoundary)
      settle(record, early)
      return
    }
    createRecord(state, childId, undefined, model, label, agent, true, activation.parentBoundary)
  }

  ctx.on('subagent/start', function (info) {
    const parent = carrierKeyOf(this)
    if (parent === undefined || completedRunsFor(parent).has(identityKey(info.id, info.runId))) return
    const child = ctx.get('agents')?.get(info.id)
    const descriptor = child === undefined
      ? undefined
      : sessionEvents(child.session).findLast((event) => event.type === 'subagent/descriptor')?.data
    const existingState = states.get(parent)
    if (descriptor?.mode !== 'continuable') {
      if (existingState?.starting > 0) rememberPendingStart(parent, info, child)
      return
    }
    trackStartEvent(existingState ?? stateFor(parent), info.id, info.runId, descriptor.agentModel, descriptor.label, child)
  })

  ctx.on('subagent/end', (info) => {
    const key = identityKey(info.id, info.runId)
    let record = info.runId === undefined
      ? [...recordsByIdentity.values()].findLast((candidate) => candidate.subagentId === info.id && candidate.settlement === undefined)
      : recordsByIdentity.get(key)
    if (record === undefined && info.runId !== undefined) {
      const provisional = [...states.values()]
        .filter((state) => !completedRunsFor(state.parent).has(key))
        .map((state) => ({
          state,
          record: latestRecordForChild(state, info.id, (candidate) => candidate.runId === undefined),
        }))
        .findLast((candidate) => candidate.record !== undefined)
      if (provisional !== undefined) record = bindRunIdentity(provisional.state, provisional.record, info.runId)
    }
    if (record !== undefined) {
      settle(record, info)
    } else if (startsInFlight > 0) {
      earlySettlements.set(key, info)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent/inbox/spliced' || event.data.outcome === 'canceled') return
    const matchingStates = [...states.values()].filter((state) => state.parent.session === session)
    if (event.data.inserted.some((message) => message.source?.kind === 'subagent-settled')) {
      // The continuation manager persists this notice before publishing
      // subagent/end. Reconcile now so a missed terminal event cannot deadlock a
      // wait, including a child discovered after plugin reload whose runId is
      // not available through the durable descriptor.
      reconcile(matchingStates.flatMap((state) => [...state.children.values()]), event.data.inserted)
    }
    if (event.data.target !== 'next-step'
      || !event.data.inserted.some((message) => message.source?.kind === 'user')) return
    for (const state of matchingStates) {
      if (state.waiting === 0) continue
      for (const resolve of state.interruptWaiters) resolve()
      state.interruptWaiters.clear()
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    state.disposed = true
    startsInFlight -= state.starting
    state.starting = 0
    for (const record of state.children.values()) {
      settle(record, { stopReason: 'aborted', lastAssistantMessage: [] })
      if (recordsByIdentity.get(record.key) === record) recordsByIdentity.delete(record.key)
    }
    state.children.clear()
    states.delete(agent)
    completedRunsByParent.delete(agent)
    pendingStartsByParent.delete(agent)
    notify(state)
    if (startsInFlight === 0) earlySettlements.clear()
  })

  const reconcile = (records, committedMessages = []) => {
    const agents = ctx.get('agents')
    const durableReconciliation = committedMessages.length === 0
    if (agents === undefined) return
    for (const record of records) {
      if (record.settlement !== undefined || record.failure !== undefined) continue
      let noticeReason = matchingSettlementReason(committedMessages, record.subagentId)
      try {
        if (noticeReason === undefined) {
          const parentEvents = sessionEvents(record.parent.session).slice(record.parentBoundary)
          noticeReason = matchingSettlementReasonFromEvents(parentEvents, record.subagentId)
        }
        const current = agents.get(record.subagentId)
        if (record.agent === undefined) updateRecord(record, undefined, undefined, current)
        if (record.agent === undefined) {
          if (noticeReason !== undefined && durableReconciliation) {
            failRecord(record, new Error(`${WAIT_TOOL_NAME}: settlement for subagent ${record.subagentId} cannot be recovered because its retained Agent history is unavailable`))
          }
          continue
        }
        const events = sessionEvents(record.agent.session).slice(record.boundary)
        const stopReason = recoveredStopReason(events)
        if (noticeReason === undefined) continue
        if (stopReason === undefined) {
          if (durableReconciliation) {
            failRecord(record, new Error(`${WAIT_TOOL_NAME}: settlement for subagent ${record.subagentId} cannot be recovered because its retained activation history has no terminal accounting`))
          }
          continue
        }
        if (noticeReason !== stopReason) {
          if (noticeReason === 'error') {
            // Continuation teardown failure overrides the child-log outcome and
            // deliberately withholds output. The manager notice is the only
            // durable terminal evidence available after a missed end event.
            settle(record, { stopReason: 'error', lastAssistantMessage: [] })
          } else if (durableReconciliation) {
            failRecord(record, new Error(`${WAIT_TOOL_NAME}: settlement for subagent ${record.subagentId} cannot be recovered because manager reason ${noticeReason} conflicts with retained history reason ${stopReason}`))
          }
          continue
        }
        settle(record, {
          stopReason,
          lastAssistantMessage: recoveredAssistantOutput(events),
        })
        const run = record.runId === undefined ? 'unpublished activation' : `run ${record.runId}`
        ctx.logger.warn(`${WAIT_TOOL_NAME}: recovered missed terminal event for subagent ${record.subagentId} ${run}`)
      } catch (error) {
        if (noticeReason !== undefined && durableReconciliation) {
          failRecord(record, new Error(`${WAIT_TOOL_NAME}: settlement for subagent ${record.subagentId} cannot be recovered from retained history: ${errorMessage(error)}`))
        } else {
          ctx.logger.warn(`${WAIT_TOOL_NAME}: could not reconcile subagent ${record.subagentId}: ${errorMessage(error)}`)
        }
      }
    }
  }

  ctx.effect(() => () => {
    if (trackerFailure !== undefined) return
    trackerFailure = new Error(`${WAIT_TOOL_NAME}: tracker was disposed before its active waits completed`)
    for (const state of states.values()) {
      state.disposed = true
      state.failure = trackerFailure
      state.starting = 0
      for (const record of state.children.values()) {
        failRecord(record, trackerFailure)
        if (recordsByIdentity.get(record.key) === record) recordsByIdentity.delete(record.key)
      }
      state.children.clear()
      notify(state)
      state.interruptWaiters.clear()
    }
    states.clear()
    startsInFlight = 0
    earlySettlements.clear()
  }, `${WAIT_TOOL_NAME}: orchestration tracker`)

  return {
    begin(parent) {
      const state = stateFor(parent)
      state.starting += 1
      startsInFlight += 1
      return {
        state,
        afterSequence: nextRecordSequence,
        afterStartSequence: nextStartSequence,
        parentBoundary: sessionEvents(parent.session).length,
      }
    },
    track(activation, childId, model, label) {
      trackToolResult(activation, childId, model, label, ctx.get('agents')?.get(childId))
    },
    finish(parent, activation) {
      const { state } = activation
      if (state.disposed) return
      state.starting -= 1
      startsInFlight -= 1
      notify(state)
      if (state.starting === 0) pendingStartsByParent.delete(parent)
      if (startsInFlight === 0) earlySettlements.clear()
      prune(parent, state)
    },
    async wait(parent, signal) {
      const state = stateFor(parent)
      let resolveInterrupt
      const interrupted = new Promise((resolve) => {
        resolveInterrupt = resolve
        state.interruptWaiters.add(resolve)
      })
      const raceInterruption = (promise) => Promise.race([
        promise.then((value) => ({ kind: 'continued', value })),
        interrupted.then(() => ({ kind: 'interrupted' })),
      ])
      const recordIdentity = (record) => ({
        subagentId: record.subagentId,
        ...(record.runId === undefined ? {} : { runId: record.runId }),
      })
      const interruptionOutcome = () => ({
        kind: 'interrupted',
        pending: [...state.children.values()].map(recordIdentity),
      })
      const pausedOutcome = (paused) => ({
        kind: 'paused',
        pending: [...state.children.values()].map(recordIdentity),
        paused: paused.map(recordIdentity),
      })
      const confirmPausedOutcome = async (records) => {
        let paused = pausedRecords(records)
        if (paused.length === 0) return undefined
        // A racing send_message wakes an idle Agent synchronously. Recheck at
        // the next microtask before reporting parked work to the caller.
        await Promise.resolve()
        if (signal.aborted) throw abortReason(signal)
        if (state.failure !== undefined) throw state.failure
        paused = pausedRecords(records)
        return paused.length === 0 ? undefined : pausedOutcome(paused)
      }
      const records = []
      state.waiting += 1
      try {
        while (true) {
          if (state.failure !== undefined) throw state.failure
          while (state.starting > 0) {
            let resolveChange
            const changed = new Promise((resolve) => {
              resolveChange = resolve
              state.waiters.add(resolve)
            })
            try {
              const outcome = await awaitWithSignal(raceInterruption(changed), signal)
              if (outcome.kind === 'interrupted') return interruptionOutcome()
            } finally {
              state.waiters.delete(resolveChange)
            }
          }

          if (state.failure !== undefined) throw state.failure
          discoverResidentChildren(state)
          for (const record of state.children.values()) {
            if (!records.includes(record)) records.push(record)
          }
          const initialPaused = await confirmPausedOutcome(records)
          if (initialPaused !== undefined) return initialPaused
          const allSettled = Promise.all(records.map((record) => record.settled))
          let settlements
          while (settlements === undefined) {
            const watchdog = createWatchdogDelay()
            try {
              const outcome = await awaitWithSignal(raceInterruption(Promise.race([
                allSettled.then((value) => ({ kind: 'settled', value })),
                watchdog.promise.then(() => ({ kind: 'watchdog' })),
              ])), signal)
              if (outcome.kind === 'interrupted') return interruptionOutcome()
              if (outcome.value.kind === 'settled') settlements = outcome.value.value
              else {
                reconcile(records)
                const newlyPaused = await confirmPausedOutcome(records)
                if (newlyPaused !== undefined) return newlyPaused
              }
            } finally {
              watchdog.cancel()
            }
          }

          if (state.failure !== undefined) throw state.failure
          await Promise.resolve()
          if (state.failure !== undefined) throw state.failure
          const hasUnclaimed = [...state.children.values()].some((record) => !records.includes(record))
          if (state.starting > 0 || hasUnclaimed) continue
          const failedRecords = records.filter((record) => record.failure !== undefined)
          if (failedRecords.length > 0) {
            for (const record of failedRecords) {
              if (record.runId !== undefined) rememberCompletedRun(parent, identityKey(record.subagentId, record.runId))
              if (state.children.get(record.key) === record) state.children.delete(record.key)
              if (recordsByIdentity.get(record.key) === record) recordsByIdentity.delete(record.key)
            }
            const failures = failedRecords.map((record) => record.failure)
            if (failures.length === 1) throw failures[0]
            throw new AggregateError(failures, `${WAIT_TOOL_NAME}: multiple subagent settlements could not be recovered`)
          }
          for (const record of records) {
            if (record.runId !== undefined) rememberCompletedRun(parent, identityKey(record.subagentId, record.runId))
            if (state.children.get(record.key) === record) state.children.delete(record.key)
            if (recordsByIdentity.get(record.key) === record) recordsByIdentity.delete(record.key)
          }
          return settlements
        }
      } finally {
        state.interruptWaiters.delete(resolveInterrupt)
        state.waiting -= 1
        prune(parent, state)
      }
    },
  }
}

function registerDelegationStartTracking(ctx, tracker, waitTool) {
  ctx.on('tools/execute', async function (exec, next) {
    const parent = exec.agent
    if (parent === undefined
      || ctx.tools.get(WAIT_TOOL_NAME, parent) !== waitTool
      || !continuableDelegationRequested(exec)) return next()
    const activation = tracker.begin(parent)
    try {
      const result = await next()
      const childId = continuableChildFromResult(result)
      if (childId !== undefined) {
        const args = exec.arguments
        const label = typeof args === 'object' && args !== null && !Array.isArray(args) && typeof args.description === 'string'
          ? args.description
          : undefined
        tracker.track(activation, childId, undefined, label)
      }
      return result
    } finally {
      tracker.finish(parent, activation)
    }
  })
}

async function settleForegroundRun(run, alias) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const failure = stopReasonError(result)
      if (failure !== undefined) throw new Error(withPartialText(failure, result.output))
      return {
        kind: 'foreground',
        runId: run.id,
        model: alias,
        output: result.output,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([
    Promise.resolve().then(() => run.dispose()),
  ])

  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

function providerWording(inheritsConversation) {
  if (inheritsConversation) {
    return {
      description: 'Delegate work to a model-selectable subagent that inherits this conversation\'s completed turns (not the current in-flight turn).',
      promptDescription: 'The task for the subagent. It already sees this conversation\'s completed turns, so state only what is new.',
    }
  }
  return {
    description: 'Delegate a self-contained task to a fresh model-selectable subagent with its own context.',
    promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation, so include everything it needs.',
  }
}

async function collectModelCatalog(ctx, exec) {
  const providerEntries = ctx.llm.listProviders()
  const providers = await Promise.all(providerEntries.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
        })),
      }
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        models: [],
        error: errorMessage(error),
      }
    }
  }))

  const currentProvider = exec.agent?.options?.provider
  const currentModel = exec.agent?.options?.model
  return {
    ...(typeof currentProvider === 'string' && typeof currentModel === 'string'
      ? { current: { provider: currentProvider, model: currentModel } }
      : {}),
    providers,
  }
}

function registerCatalogTool(ctx) {
  ctx.tools.register(defineTool({
    name: CATALOG_TOOL_NAME,
    description: 'List the model routes currently advertised by registered DSH providers. Use this read-only catalog while configuring model-selectable subagents; catalog absence is advisory and does not prove a manually configured route is invalid.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                error: { type: 'string' },
                models: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      description: { type: 'string' },
                      inputModalities: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCatalogResult(value) }],
    },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      return collectModelCatalog(ctx, exec)
    },
  }))
}

function modelRouteValueSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      alias: { type: 'string', required: true },
      provider: { type: 'string', required: true },
      model: { type: 'string', required: true },
      displayName: { type: 'string' },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
      description: { type: 'string', required: true },
      maxTokens: { type: 'integer' },
    },
  }
}

function settingsValueSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      models: {
        type: 'array',
        required: true,
        items: modelRouteValueSchema(),
      },
      subagentProvider: { type: 'string', required: true },
      maxDepth: { type: 'integer', required: true },
      enableRunInBackground: { type: 'boolean', required: true },
    },
  }
}

function renderConfigurationResult(value) {
  const settings = value.settings
  const routes = settings.models.length === 0
    ? '- No model routes configured.'
    : renderConfiguredModels(settings.models)
  return `${value.status === 'updated' ? 'Updated' : 'Current'} subagent model settings.\nTool: ${DELEGATION_TOOL_NAME}; backend: ${settings.subagentProvider}; max depth: ${settings.maxDepth}; background: ${String(settings.enableRunInBackground)}\n${routes}`
}

function registerConfigurationTool(ctx, settingsScope) {
  ctx.tools.register(defineTool({
    name: CONFIG_TOOL_NAME,
    description: 'Read or replace only this plugin\'s subagent model settings through the validated DSH Settings service. Use action "update" only after the user directly asks for a configuration change and explicitly confirms the complete proposed model list. This tool cannot access files or other settings namespaces.',
    parameters: {
      action: {
        type: 'string',
        enum: ['get', 'update'],
        required: true,
        description: 'Use get to inspect current settings. Use update only after explicit user confirmation.',
      },
      models: {
        type: 'array',
        items: modelRouteValueSchema(),
        description: 'For update, the complete replacement model list. Supply an empty array to remove every route.',
      },
      subagent_provider: {
        type: 'string',
        description: 'Optional subagent execution backend; omitted preserves the current value.',
      },
      max_depth: {
        type: 'integer',
        description: 'Optional non-negative delegation-depth limit; omitted preserves the current value.',
      },
      enable_run_in_background: {
        type: 'boolean',
        description: 'Optional durable-background setting; omitted preserves the current value.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            required: true,
            enum: ['current', 'updated'],
          },
          settings: {
            ...settingsValueSchema(),
            required: true,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderConfigurationResult(value) }],
    },
    isConcurrencySafe: (args) => args.action === 'get',
    async execute(args) {
      const current = normalizeSettings(settingsScope.get())
      if (args.action === 'get') {
        return { status: 'current', settings: current }
      }
      if (args.models === undefined) {
        throw new Error(`${CONFIG_TOOL_NAME}: models is required for action "update"`)
      }
      const next = normalizeSettings({
        models: args.models,
        subagentProvider: args.subagent_provider ?? current.subagentProvider,
        maxDepth: args.max_depth ?? current.maxDepth,
        enableRunInBackground: args.enable_run_in_background ?? current.enableRunInBackground,
      })
      await settingsScope.replace(next)
      return {
        status: 'updated',
        settings: normalizeSettings(settingsScope.get()),
      }
    },
  }))
}

function registerWaitTool(ctx, tracker) {
  if (ctx.tools.get(WAIT_TOOL_NAME) !== undefined) return undefined
  const tool = defineTool({
    name: WAIT_TOOL_NAME,
    description: `Wait for every outstanding continuable background subagent started by this agent, including standard delegations and those started through ${DELEGATION_TOOL_NAME}. Call this once after issuing all intended delegations; it blocks until they settle and returns their results, so do not poll. Direct human steering interrupts only the active join without cancelling children. When interrupted, answer the steering message first, then call this tool again before final synthesis to resume the exact pending runs. If it reports paused children with parked input, address that state explicitly: if work should continue, call send_message with appropriate instructions and then wait again; otherwise report the paused state or request direction. Do not blindly re-wait, silently discard, or treat paused children as completed.`,
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subagentId: { type: 'string', required: true },
                model: { type: 'string' },
                label: { type: 'string', required: true },
                stopReason: { type: 'string', required: true },
                output: {
                  type: 'array',
                  required: true,
                  items: { type: 'json' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'interrupted', required: true },
              pending: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subagentId: { type: 'string', required: true },
                    runId: { type: 'string' },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'paused', required: true },
              pending: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subagentId: { type: 'string', required: true },
                    runId: { type: 'string' },
                  },
                },
              },
              paused: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    subagentId: { type: 'string', required: true },
                    runId: { type: 'string' },
                  },
                },
              },
            },
          },
        ],
      },
      render: (_args, settlements) => {
        if (!Array.isArray(settlements)) {
          const count = settlements.pending.length
          if (settlements.kind === 'paused') {
            const ids = settlements.paused.map((entry) => entry.subagentId).join(', ')
            return [{
              type: 'text',
              text: `wait paused because background subagent${settlements.paused.length === 1 ? '' : 's'} ${ids} retained parked input after interruption; address the paused state explicitly—if work should continue, call send_message with appropriate instructions and then call ${WAIT_TOOL_NAME} again; otherwise report the paused state or request direction, and do not treat it as completed (${count} background subagent${count === 1 ? ' remains' : 's remain'} joinable)`,
            }]
          }
          return [{
            type: 'text',
            text: `wait interrupted by direct user steering; answer the steering message now, then call ${WAIT_TOOL_NAME} again before final synthesis (${count} background subagent${count === 1 ? ' remains' : 's remain'} joinable)`,
          }]
        }
        if (settlements.length === 0) {
          return [{ type: 'text', text: '(no outstanding background subagents)' }]
        }
        const blocks = []
        settlements.forEach((entry, index) => {
          if (index > 0) blocks.push({ type: 'text', text: '\n\n' })
          const model = entry.model === undefined ? '' : ` (${entry.model})`
          blocks.push({ type: 'text', text: `${entry.subagentId} [${entry.stopReason}] ${entry.label}${model}` })
          if (entry.output.length > 0) {
            blocks.push({ type: 'text', text: '\n' }, ...entry.output)
          }
        })
        return blocks
      },
    },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${WAIT_TOOL_NAME} requires a calling agent`)
      return tracker.wait(parent, exec.signal)
    },
  })
  ctx.tools.register(tool)
  return tool
}

function createDelegationTool(ctx, tracker, waitTool, config, provider, models) {
  const wording = providerWording(provider.inheritsParentContext)
  const catalog = renderConfiguredModels(models)
  const byAlias = new Map(models.map((model) => [model.alias, model]))
  const backgroundEnabled = config.enableRunInBackground !== false

  return defineTool({
    name: DELEGATION_TOOL_NAME,
    description: `${wording.description} Select only from the configured routes below, using their tags and usage descriptions to choose.\n${catalog}${backgroundEnabled ? '\nRuns in the background by default; set run_in_background to false only when the next action depends on the result.' : ''}`,
    parameters: {
      model: {
        type: 'string',
        enum: models.map((model) => model.alias),
        required: true,
        description: `Configured model alias. Choose from:\n${catalog}`,
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: wording.promptDescription,
      },
      ...(backgroundEnabled ? {
        run_in_background: {
          type: 'boolean',
          description: 'Whether to return a durable subagent id immediately. Defaults to true. Set false to wait for the result.',
        },
      } : {}),
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              model: { type: 'string', required: true },
              output: {
                type: 'array',
                required: true,
                items: { type: 'json' },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'continuable'
          ? `started ${value.model} subagent ${value.subagentId}`
          : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error(`${DELEGATION_TOOL_NAME} requires a calling agent`)
      }
      const selected = byAlias.get(args.model)
      if (selected === undefined) {
        throw new Error(`unknown configured model alias "${String(args.model)}"`)
      }
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        signal: exec.signal,
        maxDepth: config.maxDepth ?? 3,
        agentOptions: {
          provider: selected.provider,
          model: selected.model,
          ...(selected.maxTokens === undefined ? {} : { maxTokens: selected.maxTokens }),
        },
      }

      if (backgroundEnabled && args.run_in_background !== false) {
        const activeTracker = tracker !== undefined && ctx.tools.get(WAIT_TOOL_NAME, parent) === waitTool
          ? tracker
          : undefined
        const startBackground = () => ctx.subagents.startContinuable({
          provider: config.subagentProvider ?? 'spawn',
          label: args.description,
          request,
          signal: exec.signal,
        })
        if (activeTracker === undefined) {
          const started = await startBackground()
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.alias,
          }
        }

        const trackingState = activeTracker.begin(parent)
        try {
          const started = await startBackground()
          activeTracker.track(trackingState, started.childId, selected.alias, args.description)
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.alias,
          }
        } finally {
          activeTracker.finish(parent, trackingState)
        }
      }

      const run = await ctx.subagents.start(config.subagentProvider ?? 'spawn', request)
      return settleForegroundRun(run, selected.alias)
    },
  })
}

async function registerSetupSkill(ctx) {
  const content = await readFile(SKILL_URL, 'utf8')
  ctx.skills.register({
    name: 'model-subagent-setup',
    description: 'Configure which existing DSH model routes an AI agent may use for model-selectable subagents, and generate concise tags and routing descriptions for each choice.',
    whenToUse: 'Use when the user asks to set up, add, remove, review, or improve alternative models for subagents created by dsh-subagent-model-router.',
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
    source: 'bundled',
    resourceBase: {
      kind: 'directory',
      path: fileURLToPath(SKILL_DIRECTORY_URL),
    },
    content,
  })
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isTrustedSettingsOrigin(origin) {
  const configured = process.env.DSH_SUBAGENT_MODEL_ROUTER_TRUSTED_ORIGINS ?? ''
  return configured.split(',').some((value) => {
    const candidate = value.trim()
    if (candidate.length === 0) return false
    try {
      const parsed = new URL(candidate)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin
    } catch {
      return false
    }
  })
}

function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== host) return false
      return loopbackHost || isTrustedSettingsOrigin(parsed.origin)
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readJsonBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > SETTINGS_BODY_LIMIT) {
      throw new Error('settings request exceeds 256 KiB')
    }
  }
  if (text.length === 0) throw new Error('settings request body is required')
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('settings request body must be an object')
  }
  return value
}

function settingsRouteView(settings) {
  const descriptor = settings.describe().find((entry) => String(entry.ns) === SETTINGS_NAMESPACE)
  if (descriptor === undefined) throw new Error(`settings namespace "${SETTINGS_NAMESPACE}" is not registered`)
  return {
    writable: settings.writable,
    descriptor: {
      value: normalizeSettings(descriptor.value),
      revision: descriptor.revision,
    },
  }
}

function registerSettingsRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: SETTINGS_ROUTE,
    async handler(req, res) {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'Subagent model settings are available only over a loopback connection.' })
        return
      }
      if (req.method === 'GET') {
        try {
          sendJson(res, 200, settingsRouteView(ctx.settings))
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) })
        }
        return
      }
      if (req.method !== 'PUT') {
        res.setHeader('allow', 'GET, PUT')
        sendJson(res, 405, { error: 'Method not allowed.' })
        return
      }
      if (!isSameOriginMutation(req)) {
        sendJson(res, 403, { error: 'Settings updates require a same-origin browser request.' })
        return
      }
      if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'Settings updates require application/json.' })
        return
      }
      try {
        const body = await readJsonBody(req)
        if (typeof body.section !== 'object' || body.section === null || Array.isArray(body.section)) {
          throw new Error('settings update requires a section object')
        }
        if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) {
          throw new Error('expectedRevision must be a non-negative safe integer')
        }
        const section = normalizeSettings(body.section)
        await ctx.settings.replace(SETTINGS_NAMESPACE, section, body.expectedRevision)
        sendJson(res, 200, settingsRouteView(ctx.settings))
      } catch (error) {
        const statusCode = error instanceof SyntaxError ? 400 : error?.name === 'SettingsConflictError' ? 409 : 400
        sendJson(res, statusCode, { error: errorMessage(error) })
      }
    },
  }), 'dsh-subagent-model-router: settings web route')
}

async function apply(ctx) {
  ctx.sessionProjections.register(subagentModelRouteProjectionDefinition)
  await registerSetupSkill(ctx)
  registerCatalogTool(ctx)

  const settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, {
    applies: 'live',
    validate(value) {
      const settings = normalizeSettings(value)
      if (settings.models.length === 0) return
      const provider = ctx.subagents.getProvider(settings.subagentProvider)
      if (provider !== undefined) assertProviderCapabilities(provider, settings)
    },
  })
  registerConfigurationTool(ctx, settingsScope)
  registerSettingsRoute(ctx)
  const tracker = ctx.tools.get(WAIT_TOOL_NAME) === undefined
    ? createOrchestrationTracker(ctx)
    : undefined
  const waitTool = tracker === undefined ? undefined : registerWaitTool(ctx, tracker)
  if (waitTool === undefined) {
    ctx.logger.info(`${WAIT_TOOL_NAME} is already registered; model-router wait guidance is disabled`)
  } else {
    registerDelegationStartTracking(ctx, tracker, waitTool)
  }

  let current = normalizeSettings(settingsScope.get())
  let disposeTool

  const unmountTool = () => {
    if (disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  }

  const mountCurrent = (provider) => {
    if (current.models.length === 0 || disposeTool !== undefined) return
    try {
      assertProviderCapabilities(provider, current)
      disposeTool = ctx.tools.register(createDelegationTool(ctx, waitTool === undefined ? undefined : tracker, waitTool, current, provider, current.models))
    } catch (error) {
      ctx.logger.error(errorMessage(error))
    }
  }

  const reconcile = (value) => {
    const next = normalizeSettings(value)
    unmountTool()
    current = next
    if (current.models.length === 0) {
      ctx.logger.info('no model-selectable subagent routes configured; use Settings > Subagent Models or load the model-subagent-setup skill')
      return
    }
    const provider = ctx.subagents.getProvider(current.subagentProvider)
    if (provider === undefined) {
      ctx.logger.info(`subagent provider "${current.subagentProvider}" is not registered yet; ${DELEGATION_TOOL_NAME} will register when it appears`)
      return
    }
    mountCurrent(provider)
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === current.subagentProvider) mountCurrent(provider)
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (providerName === current.subagentProvider) unmountTool()
  })

  ctx.systemPrompt.section({
    name: 'tool:subagent-model-router:models',
    order: MODEL_SUBAGENT_SECTION_ORDER,
    text: (context) => disposeTool === undefined
      || ctx.tools.get(DELEGATION_TOOL_NAME, context.scope) === undefined
      || waitTool === undefined
      || ctx.tools.get(WAIT_TOOL_NAME, context.scope) !== waitTool
      ? ''
      : `For model-selectable delegation, use \`${DELEGATION_TOOL_NAME}\` and choose only from these configured routes. Treat each description as the owner's routing policy rather than guessing from the raw model name. Once you delegate a task, do not also perform that task yourself; continue only with independent work. After issuing all intended background delegations, call \`${WAIT_TOOL_NAME}\` before synthesizing their results or giving a final answer. While a same-session completion goal is active, do not merely state that another model is handling the task and end your turn while background subagents remain outstanding. Ending the turn triggers immediate goal continuation and can race child tracking; call \`${WAIT_TOOL_NAME}\` to join the outstanding work, then synthesize the results and continue or complete the goal. If that wait reports direct-user steering, answer the steering message first, then call \`${WAIT_TOOL_NAME}\` again before final synthesis; the agent loop does not schedule that resumed call automatically.\n${renderConfiguredModels(current.models)}`,
  })

  reconcile(settingsScope.get())
  ctx.effect(() => settingsScope.watch((next) => {
    reconcile(next)
  }), 'dsh-subagent-model-router: settings watcher')
}

export {
  CATALOG_TOOL_NAME,
  CONFIG_TOOL_NAME,
  SETTINGS_NAMESPACE,
  WAIT_TOOL_NAME,
  SettingsSchema,
  subagentModelRouteProjectionDefinition,
  apply,
  inject,
  name,
}

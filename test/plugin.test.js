import assert from 'node:assert/strict'
import test from 'node:test'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import {
  apply,
  inject,
  CATALOG_TOOL_NAME,
  CONFIG_TOOL_NAME,
  SETTINGS_NAMESPACE,
  WAIT_TOOL_NAME,
  subagentModelRouteProjectionDefinition,
} from '../lib/index.js'

const configuredSettings = {
  subagentProvider: 'spawn',
  maxDepth: 4,
  enableRunInBackground: true,
  models: [{
    alias: 'deep',
    provider: 'acme',
    model: 'reasoner',
    displayName: 'Acme Reasoner',
    tags: ['reasoning', 'review'],
    description: 'Use for difficult analysis and review.',
    maxTokens: 8192,
  }],
}

const defaultSettings = {
  subagentProvider: 'spawn',
  maxDepth: 3,
  enableRunInBackground: true,
  models: [],
}

function expectedSettlementSummaryForTest(childId, stopReason) {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed': return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted': return `${subject} was stopped before it finished.`
    case 'max-tokens': return `${subject} ran out of room before it finished.`
    case 'refusal': return `${subject} declined the task.`
    case 'error': return `${subject} failed before it finished.`
    default: throw new Error(`unsupported test stop reason ${stopReason}`)
  }
}

function settlementNoticeForTest(childId, stopReason) {
  return {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: expectedSettlementSummaryForTest(childId, stopReason),
          senderSessionId: childId,
        },
      }],
    },
  }
}

function createContext(options = {}) {
  const registeredTools = new Map()
  if (options.existingWaitTool !== undefined) {
    registeredTools.set(WAIT_TOOL_NAME, options.existingWaitTool)
  }
  const listeners = new Map()
  const sections = []
  const skills = []
  const starts = []
  const continuableStarts = []
  const effects = []
  const projectionDefinitions = []
  const settingsReplacements = []
  let disposed = false
  let settingsValue = options.settings ?? configuredSettings
  let settingsRevision = 0
  let settingsWatcher
  let settingsRegistration
  let webRoute

  const provider = options.provider ?? {
    name: 'spawn',
    inheritsParentContext: false,
    capabilities: {
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    prepareContinuable() {},
  }

  const commitSettings = async (next, expectedRevision) => {
    if (expectedRevision !== undefined && expectedRevision !== settingsRevision) {
      const error = new Error(`settings conflict: expected ${expectedRevision}, actual ${settingsRevision}`)
      error.name = 'SettingsConflictError'
      throw error
    }
    settingsRegistration.options.validate(next)
    const previous = settingsValue
    settingsValue = next
    settingsRevision += 1
    settingsReplacements.push(next)
    if (settingsWatcher !== undefined) settingsWatcher(next, previous)
  }

  const ctx = {
    get(name) {
      if (name === 'agents') return options.agents
      if (name !== 'webServer' || options.withWebServer !== true) return undefined
      return {
        register(route) {
          webRoute = route
          return () => {
            webRoute = undefined
          }
        },
      }
    },
    tools: {
      register(tool) {
        assert.equal(registeredTools.has(tool.name), false, `duplicate tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => registeredTools.delete(tool.name)
      },
      get(name, scope) {
        if (name === WAIT_TOOL_NAME && options.scopedWaitTool !== undefined && options.scopedWaitTool.agent === scope) {
          return options.scopedWaitTool.tool
        }
        return registeredTools.get(name)
      },
    },
    subagents: {
      getProvider(name) {
        return name === provider.name ? provider : undefined
      },
      async start(name, request) {
        starts.push({ name, request })
        return {
          id: 'run-1',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: 'child result' }],
          }),
          async dispose() {
            disposed = true
          },
        }
      },
      async startContinuable(spec) {
        continuableStarts.push(spec)
        const emit = (event, info) => listeners.get(event)?.call(scopeTarget(ctx.subagents, spec.request.parent), info)
        if (options.startContinuable !== undefined) {
          return options.startContinuable(spec, emit)
        }
        emit('subagent/start', {
          runId: 'run-child-1',
          provider: spec.provider,
          id: 'child-1',
          local: true,
        })
        return { childId: 'child-1', messageId: 'message-1' }
      },
    },
    sessionProjections: {
      register(definition) {
        projectionDefinitions.push(definition)
        return () => {
          const index = projectionDefinitions.indexOf(definition)
          if (index >= 0) projectionDefinitions.splice(index, 1)
        }
      },
    },
    settings: {
      writable: true,
      describe() {
        if (settingsRegistration === undefined) return []
        return [{
          ns: settingsRegistration.namespace,
          value: settingsValue,
          revision: settingsRevision,
        }]
      },
      async replace(namespace, next, expectedRevision) {
        assert.equal(namespace, SETTINGS_NAMESPACE)
        await commitSettings(next, expectedRevision)
      },
      register(namespace, schema, registrationOptions) {
        settingsRegistration = { namespace, schema, options: registrationOptions }
        registrationOptions.validate(settingsValue)
        return {
          get() {
            return settingsValue
          },
          async replace(next) {
            await commitSettings(next)
          },
          watch(callback) {
            settingsWatcher = callback
            return () => {
              settingsWatcher = undefined
            }
          },
        }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {}
      },
    },
    llm: {
      listProviders() {
        return [{ id: 'acme', name: 'Acme' }]
      },
      async listModels() {
        return [{
          provider: 'acme',
          id: 'reasoner',
          name: 'Acme Reasoner',
          description: 'A reasoning model',
          inputModalities: ['text'],
        }]
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  return {
    ctx,
    continuableStarts,
    effects,
    disposeEffects() {
      for (const dispose of effects.toReversed()) {
        if (typeof dispose === 'function') dispose()
      }
    },
    emit(event, info, parent) {
      const listener = listeners.get(event)
      if (parent === undefined) listener?.(info)
      else listener?.call(scopeTarget(ctx.subagents, parent), info)
    },
    emitSessionEvent(session, event) {
      listeners.get('session/event')?.(session, event)
    },
    runToolExecution(exec, next) {
      const listener = listeners.get('tools/execute')
      return listener === undefined
        ? next()
        : listener.call(scopeTarget(ctx.tools, exec.agent), exec, next)
    },
    isDisposed: () => disposed,
    listeners,
    projectionDefinitions,
    registeredTools,
    sections,
    settingsRegistration: () => settingsRegistration,
    settingsReplacements,
    skills,
    starts,
    webRoute: () => webRoute,
    updateSettings(next) {
      settingsRegistration.options.validate(next)
      const previous = settingsValue
      settingsValue = next
      settingsRevision += 1
      if (settingsWatcher !== undefined) settingsWatcher(next, previous)
    },
  }
}

async function callWebRoute(route, options = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    setEncoding() {},
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield text
    },
  }
  const responseHeaders = {}
  let responseBody = ''
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders[name.toLowerCase()] = value
    },
    end(value = '') {
      responseBody = value
    },
  }
  await route.handler(req, res)
  return {
    status: res.statusCode,
    headers: responseHeaders,
    body: JSON.parse(responseBody),
  }
}

const executionAgents = new Map()

function execution(options = {}) {
  const agentId = options.agentId ?? 'parent-1'
  let agent = options.agent ?? executionAgents.get(agentId)
  if (agent === undefined) {
    agent = {
      id: agentId,
      options: { provider: 'parent-provider', model: 'parent-model' },
      session: { events: [] },
    }
    executionAgents.set(agentId, agent)
  }
  return {
    agent,
    signal: options.signal ?? new AbortController().signal,
  }
}

test('registers settings, setup skill, catalog, and configured model tool', async () => {
  assert.ok(inject.includes('agents'))
  const state = createContext()
  await apply(state.ctx)

  assert.equal(state.settingsRegistration().namespace, SETTINGS_NAMESPACE)
  assert.equal(state.settingsRegistration().options.applies, 'live')
  assert.deepEqual(state.projectionDefinitions, [subagentModelRouteProjectionDefinition])
  assert.equal(state.skills.length, 1)
  assert.equal(state.skills[0].name, 'model-subagent-setup')
  assert.match(state.skills[0].content, /Call `model_subagent_catalog`/)
  assert.match(state.skills[0].content, /configure_subagent_models/)
  assert.match(state.skills[0].content, /reliable general knowledge/)
  assert.match(state.skills[0].content, /one multi-select question per ambiguous model/)
  assert.match(state.skills[0].content, /when selecting the Luna route/)

  const catalog = state.registeredTools.get(CATALOG_TOOL_NAME)
  const configuration = state.registeredTools.get(CONFIG_TOOL_NAME)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  assert.ok(catalog)
  assert.ok(configuration)
  assert.ok(wait)
  assert.equal(configuration.parameters.properties.tool_name, undefined)
  assert.ok(delegation)
  assert.deepEqual(delegation.parameters.properties.model.enum, ['deep'])
  assert.match(delegation.description, /reasoning, review/)
  assert.match(delegation.description, /Use for difficult analysis and review/)

  const sectionText = state.sections[0].text({ scope: {} })
  assert.match(sectionText, /acme\/reasoner/)
  assert.match(sectionText, /do not also perform that task yourself/)
  assert.match(sectionText, /call `wait-for-subagents`/)
  assert.match(sectionText, /While a same-session completion goal is active, do not merely state that another model is handling the task and end your turn while background subagents remain outstanding\./)
  assert.match(sectionText, /Ending the turn triggers immediate goal continuation and can race child tracking; call `wait-for-subagents` to join the outstanding work, then synthesize the results and continue or complete the goal\./)
  assert.match(sectionText, /answer the steering message first/)
  assert.match(sectionText, /does not schedule that resumed call automatically/)

  const result = await catalog.execute({}, execution())
  assert.deepEqual(result.current, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  assert.equal(result.providers[0].models[0].id, 'reasoner')
})

test('routes foreground work through the selected settings model', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')

  const result = await delegation.execute({
    model: 'deep',
    description: 'Review architecture',
    prompt: 'Review the proposed architecture.',
    run_in_background: false,
  }, execution())

  assert.equal(result.kind, 'foreground')
  assert.equal(result.model, 'deep')
  assert.equal(result.output[0].text, 'child result')
  assert.equal(state.starts.length, 1)
  assert.equal(state.starts[0].name, 'spawn')
  assert.deepEqual(state.starts[0].request.agentOptions, {
    provider: 'acme',
    model: 'reasoner',
    maxTokens: 8192,
  })
  assert.equal(state.starts[0].request.maxDepth, 4)
  assert.equal(state.isDisposed(), true)
})

test('starts a durable background child by default', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')

  const result = await delegation.execute({
    model: 'deep',
    description: 'Investigate issue',
    prompt: 'Investigate the issue.',
  }, execution())

  assert.deepEqual(result, {
    kind: 'continuable',
    subagentId: 'child-1',
    model: 'deep',
  })
  assert.equal(state.continuableStarts.length, 1)
  assert.deepEqual(state.continuableStarts[0].request.agentOptions, {
    provider: 'acme',
    model: 'reasoner',
    maxTokens: 8192,
  })
})

test('tracks and settles a model-routed child through current Session snapshots', async () => {
  const children = new Map()
  const events = [{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'continuable',
      provider: 'spawn',
      label: 'Snapshot investigation',
      agentModel: 'deep',
    },
  }]
  const child = {
    id: 'child-snapshot',
    session: { snapshotEvents: () => events.slice() },
  }
  const state = createContext({
    agents: { get: (id) => children.get(id) },
    startContinuable(spec, emit) {
      children.set(child.id, child)
      emit('subagent/start', {
        runId: 'run-snapshot',
        provider: spec.provider,
        id: child.id,
        local: true,
      })
      return { childId: child.id, messageId: 'message-snapshot' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  const started = await delegation.execute({
    model: 'deep',
    description: 'Snapshot investigation',
    prompt: 'Investigate the current runtime contract.',
  }, execution())
  assert.deepEqual(started, {
    kind: 'continuable',
    subagentId: child.id,
    model: 'deep',
  })

  const waiting = wait.execute({}, execution())
  state.emit('subagent/end', {
    runId: 'run-snapshot',
    provider: 'spawn',
    id: child.id,
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Snapshot-compatible result.' }],
  })
  assert.deepEqual(await waiting, [{
    subagentId: child.id,
    model: 'deep',
    label: 'Snapshot investigation',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Snapshot-compatible result.' }],
  }])
})

test('waits for model-routed background children and returns their results', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Investigate issue',
    prompt: 'Investigate the issue.',
  }, execution())

  let finished = false
  const waiting = wait.execute({}, execution()).then((result) => {
    finished = true
    return result
  })
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/end', {
    id: 'child-1',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Investigation complete.' }],
  })
  assert.deepEqual(await waiting, [{
    subagentId: 'child-1',
    model: 'deep',
    label: 'Investigate issue',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Investigation complete.' }],
  }])
  assert.deepEqual(await wait.execute({}, execution()), [])
})

test('watchdog recovers the observed completion chronology while the exact child remains resumable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children = new Map()
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'watchdog-parent',
      options: { provider: 'parent-provider', model: 'parent-model' },
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const events = [{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'continuable',
      provider: 'spawn',
      label: 'Watchdog investigation',
      agentModel: 'deep',
    },
  }]
  const child = {
    id: 'child-watchdog',
    status: 'running',
    session: { snapshotEvents: () => events.slice() },
  }
  const agents = { get: (id) => children.get(id) }
  const state = createContext({
    agents,
    startContinuable(spec, emit) {
      children.set(child.id, child)
      emit('subagent/start', {
        runId: 'run-watchdog',
        provider: spec.provider,
        id: child.id,
        local: true,
      })
      return { childId: child.id, messageId: 'message-watchdog' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Watchdog investigation',
    prompt: 'Complete while the host is suspended.',
  }, parentExec)
  let finished = false
  const waiting = wait.execute({}, parentExec).then((result) => {
    finished = true
    return result
  })
  t.mock.timers.tick(10_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)

  events.push(
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Recovered result.' }] } },
    },
    { type: 'step/end', data: { turn: 0, step: 0 } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  )
  child.status = 'idle'
  t.mock.timers.tick(10_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false, 'an idle/resumable child is not terminal proof without the manager notice')

  parentEvents.push(
    {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [{ type: 'text', text: 'Child report.' }],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: child.id },
        }],
      },
    },
    {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        start: 1,
        inserted: [{
          content: [{ type: 'text', text: 'Its closing message:' }],
          source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: `Background subagent ${child.id} finished and will do no further work unless you send it more.`,
            senderSessionId: child.id,
          },
        }],
      },
    },
  )

  t.mock.timers.tick(10_000)
  assert.deepEqual(await waiting, [{
    subagentId: 'child-watchdog',
    model: 'deep',
    label: 'Watchdog investigation',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Recovered result.' }],
  }])
})

test('settlement notice immediately recovers a discovered child when subagent/end was missed', async () => {
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'reloaded-missed-end-parent',
      options: { provider: 'parent-provider', model: 'parent-model' },
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const childEvents = [{
    type: 'subagent/descriptor',
    data: {
      version: 3,
      mode: 'continuable',
      provider: 'spawn',
      label: 'Reloaded verifier',
      agentProvider: 'acme',
      agentModel: 'reasoner',
    },
  }]
  const child = {
    id: 'reloaded-missed-end-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === child.id ? child : undefined,
      list: () => [parentExec.agent, child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  let finished = false
  const waiting = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  await Promise.resolve()
  assert.equal(finished, false)

  childEvents.push(
    { type: 'turn/start', data: { turn: 8 } },
    { type: 'step/start', data: { turn: 8, step: 0 } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Reloaded verifier complete.' }] } },
    },
    { type: 'step/end', data: { turn: 8, step: 0 } },
    { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } },
  )
  child.status = 'idle'
  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [{ type: 'text', text: 'Reloaded verifier complete.' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${child.id} finished and will do no further work unless you send it more.`,
          senderSessionId: child.id,
        },
      }],
    },
  }
  parentEvents.push(notice)
  state.emitSessionEvent(parentExec.agent.session, notice)

  assert.deepEqual(await waiting, [{
    subagentId: child.id,
    model: 'reasoner',
    label: 'Reloaded verifier',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Reloaded verifier complete.' }],
  }])
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('watchdog recovers a discovered child when both terminal lifecycle events were missed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'cold-watchdog-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const childEvents = [{
    type: 'subagent/descriptor',
    data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Cold child' },
  }]
  const child = {
    id: 'cold-watchdog-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === child.id ? child : undefined,
      list: () => [child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, parentExec)
  await Promise.resolve()

  childEvents.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Cold result.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  parentEvents.push({
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${child.id} finished and will do no further work unless you send it more.`,
          senderSessionId: child.id,
        },
      }],
    },
  })
  child.status = 'idle'
  t.mock.timers.tick(10_000)

  assert.deepEqual(await waiting, [{
    subagentId: child.id,
    label: 'Cold child',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Cold result.' }],
  }])
})

test('auto_agent_run missed end reconciles without joining stale idle children', async () => {
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'project-agent-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const stale = {
    id: 'stale-ready-child',
    status: 'ready',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Stale' } }],
    },
  }
  const childEvents = [{
    type: 'subagent/descriptor',
    data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Project verifier' },
  }]
  const child = {
    id: 'project-verifier-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const children = new Map([[stale.id, stale]])
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => children.get(id),
      list: () => [stale, ...(children.has(child.id) ? [child] : [])],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  let release
  const dispatch = state.runToolExecution({
    name: 'auto_agent_run',
    arguments: { agent_id: 'reviewer', task: 'Verify lifecycle.', run_in_background: true },
    agent: parentExec.agent,
  }, () => new Promise((resolve) => { release = resolve }))

  state.emit('subagent/start', {
    runId: 'run-project-verifier',
    provider: 'spawn',
    id: child.id,
    local: true,
  }, parentExec.agent)
  children.set(child.id, child)
  release({
    isError: false,
    value: { kind: 'background', agentId: 'reviewer', subagentId: child.id },
    content: [],
  })
  await dispatch
  const waiting = wait.execute({}, parentExec)

  childEvents.push(
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Project verification done.' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  )
  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${child.id} finished and will do no further work unless you send it more.`,
          senderSessionId: child.id,
        },
      }],
    },
  }
  parentEvents.push(notice)
  child.status = 'idle'
  state.emitSessionEvent(parentExec.agent.session, notice)

  const results = await waiting
  assert.deepEqual(results.map((result) => result.subagentId), [child.id])
  assert.equal(results[0].output[0].text, 'Project verification done.')
})

test('pre-boundary completion evidence cannot settle a newly discovered activation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const childId = 'reused-resident-child'
  const oldNotice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${childId} finished and will do no further work unless you send it more.`,
          senderSessionId: childId,
        },
      }],
    },
  }
  const parentEvents = [oldNotice]
  const parentExec = execution({ agent: { id: 'reused-resident-parent', options: {}, session: { events: parentEvents } } })
  const childEvents = [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Reused resident' } },
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'step/start', data: { turn: 0, step: 0 } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ]
  const child = {
    id: childId,
    status: 'running',
    session: { header: { origin: 'subagent', parentSession: parentExec.agent.id }, events: childEvents },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => child, list: () => [child] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  let finished = false
  const waiting = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  t.mock.timers.tick(10_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)

  childEvents.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Fresh activation.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const freshNotice = structuredClone(oldNotice)
  parentEvents.push(freshNotice)
  state.emitSessionEvent(parentExec.agent.session, freshNotice)
  assert.equal((await waiting)[0].output[0].text, 'Fresh activation.')
})

test('reload discovery recovers when the observed running child already logged its terminal turn', async () => {
  const childId = 'terminal-at-discovery-child'
  const terminalOutput = [{ type: 'text', text: 'Already terminal when discovered.' }]
  const childEvents = [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Terminal at discovery' } },
    { type: 'turn/start', data: { turn: 4 } },
    { type: 'step/start', data: { turn: 4, step: 0 } },
    { type: 'assistant/message', data: { message: { content: terminalOutput } } },
    { type: 'step/end', data: { turn: 4, step: 0 } },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ]
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'terminal-at-discovery-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const child = {
    id: childId,
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === childId ? child : undefined,
      list: () => [child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(250) })
  await Promise.resolve()

  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${childId} finished and will do no further work unless you send it more.`,
          senderSessionId: childId,
        },
      }],
    },
  }
  parentEvents.push(notice)
  child.status = 'idle'
  state.emitSessionEvent(parentExec.agent.session, notice)

  assert.deepEqual(await waiting, [{
    subagentId: childId,
    label: 'Terminal at discovery',
    stopReason: 'completed',
    output: terminalOutput,
  }])
})

test('settlement notice immediately reconciles a child first published without a readable Agent', async () => {
  const childId = 'late-readable-child'
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'late-readable-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const children = new Map()
  const state = createContext({
    settings: defaultSettings,
    agents: { get: (id) => children.get(id), list: () => [...children.values()] },
  })
  await apply(state.ctx)
  await state.runToolExecution({
    name: 'subagent',
    arguments: { description: 'Late readable child' },
    agent: parentExec.agent,
  }, async () => ({
    isError: false,
    value: { kind: 'continuable', subagentId: childId },
    content: [],
  }))
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) })
  await Promise.resolve()

  const childEvents = [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Late readable child' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Late readable result.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  children.set(childId, {
    id: childId,
    status: 'idle',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents: () => childEvents.slice(),
    },
  })
  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${childId} finished and will do no further work unless you send it more.`,
          senderSessionId: childId,
        },
      }],
    },
  }
  parentEvents.push(notice)
  state.emitSessionEvent(parentExec.agent.session, notice)

  assert.equal((await waiting)[0].output[0].text, 'Late readable result.')
})

test('reload reconciliation uses the latest turn from a repeated-turn resident Agent', async () => {
  const childId = 'repeated-turn-child'
  const childEvents = [{
    type: 'subagent/descriptor',
    data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Repeated turns' },
  }]
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'repeated-turn-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const child = {
    id: childId,
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => child, list: () => [child] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  let finished = false
  const waiting = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) }).then((value) => {
    finished = true
    return value
  })
  await Promise.resolve()

  childEvents.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'First turn.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Second and final turn.' }] } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  )
  await Promise.resolve()
  assert.equal(finished, false, 'turn completion alone is not activation settlement')

  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: `Background subagent ${childId} finished and will do no further work unless you send it more.`,
          senderSessionId: childId,
        },
      }],
    },
  }
  parentEvents.push(notice)
  state.emitSessionEvent(parentExec.agent.session, notice)

  const [result] = await waiting
  assert.deepEqual(result.output, [{ type: 'text', text: 'Second and final turn.' }])
})

test('malformed recovery history for one child does not starve an independent child', async () => {
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'fault-isolation-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const malformed = {
    id: 'malformed-history-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Malformed' } }],
    },
  }
  const healthy = {
    id: 'healthy-history-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Healthy' } }],
    },
  }
  const children = new Map([[malformed.id, malformed], [healthy.id, healthy]])
  const state = createContext({
    settings: defaultSettings,
    agents: { get: (id) => children.get(id), list: () => [...children.values()] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) })
  await Promise.resolve()

  malformed.session.events.push({ type: 'turn/end' })
  healthy.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Healthy recovery.' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const noticeFor = (childId) => ({
    content: [],
    source: {
      kind: 'subagent-settled',
      form: 'notice',
      summary: `Background subagent ${childId} finished and will do no further work unless you send it more.`,
      senderSessionId: childId,
    },
  })
  const notice = {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [noticeFor(malformed.id), noticeFor(healthy.id)],
    },
  }
  parentEvents.push(notice)
  assert.doesNotThrow(() => state.emitSessionEvent(parentExec.agent.session, notice))

  state.emit('subagent/end', {
    runId: 'malformed-run',
    id: malformed.id,
    stopReason: 'error',
    lastAssistantMessage: [],
  })
  const results = await waiting
  assert.equal(results.find((result) => result.subagentId === healthy.id).output[0].text, 'Healthy recovery.')
  assert.equal(results.find((result) => result.subagentId === malformed.id).stopReason, 'error')
})

test('settlement notice reconciliation remains isolated between independent parents', async () => {
  const makeParent = (id) => {
    const events = []
    return {
      events,
      exec: execution({ agent: { id, options: {}, session: { snapshotEvents: () => events.slice() } } }),
    }
  }
  const leftParent = makeParent('independent-left-parent')
  const rightParent = makeParent('independent-right-parent')
  const makeChild = (id, parent, label) => {
    const events = [{ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label } }]
    return {
      events,
      agent: {
        id,
        status: 'running',
        session: {
          header: { origin: 'subagent', parentSession: parent.exec.agent.id },
          snapshotEvents: () => events.slice(),
        },
      },
    }
  }
  const left = makeChild('independent-left-child', leftParent, 'Left child')
  const right = makeChild('independent-right-child', rightParent, 'Right child')
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => [left.agent, right.agent].find((agent) => agent.id === id),
      list: () => [left.agent, right.agent],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  let rightFinished = false
  const leftWaiting = wait.execute({}, { ...leftParent.exec, signal: AbortSignal.timeout(500) })
  const rightWaiting = wait.execute({}, { ...rightParent.exec, signal: AbortSignal.timeout(500) }).then((value) => {
    rightFinished = true
    return value
  })
  await Promise.resolve()

  const complete = (child, parent, text) => {
    child.events.push(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
    const notice = {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        start: parent.events.length,
        inserted: [{
          content: [],
          source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: `Background subagent ${child.agent.id} finished and will do no further work unless you send it more.`,
            senderSessionId: child.agent.id,
          },
        }],
      },
    }
    parent.events.push(notice)
    state.emitSessionEvent(parent.exec.agent.session, notice)
  }

  complete(left, leftParent, 'Left result.')
  assert.equal((await leftWaiting)[0].output[0].text, 'Left result.')
  await Promise.resolve()
  assert.equal(rightFinished, false)
  complete(right, rightParent, 'Right result.')
  assert.equal((await rightWaiting)[0].output[0].text, 'Right result.')
})

test('waits for standard background children when no model routes are configured', async () => {
  const parentExec = execution({ agentId: 'standard-parent' })
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get(id) {
        assert.equal(id, 'standard-child')
        return {
          session: {
            events: [{
              type: 'subagent/descriptor',
              data: {
                version: 2,
                mode: 'continuable',
                provider: 'spawn',
                label: 'Standard investigation',
              },
            }],
          },
        }
      },
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  assert.equal(state.registeredTools.has('subagent_model'), false)

  state.emit('subagent/start', {
    runId: 'run-standard-child',
    provider: 'spawn',
    id: 'standard-child',
    local: true,
  }, parentExec.agent)
  const waiting = wait.execute({}, parentExec)
  state.emit('subagent/end', {
    runId: 'run-standard-child',
    provider: 'spawn',
    id: 'standard-child',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Standard investigation complete.' }],
  }, parentExec.agent)

  const result = await waiting
  assert.deepEqual(result, [{
    subagentId: 'standard-child',
    label: 'Standard investigation',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Standard investigation complete.' }],
  }])
  assert.deepEqual(wait.output.render({}, result), [
    { type: 'text', text: 'standard-child [completed] Standard investigation' },
    { type: 'text', text: '\n' },
    { type: 'text', text: 'Standard investigation complete.' },
  ])
})

test('does not report empty while standard, fork, or project-agent delegation can still publish a background start', async () => {
  for (const [index, name] of ['subagent', 'subagent_fork', 'auto_agent_run'].entries()) {
    const parentExec = execution({ agentId: `in-flight-${index}` })
    const state = createContext({ settings: defaultSettings })
    await apply(state.ctx)
    const wait = state.registeredTools.get(WAIT_TOOL_NAME)
    let release
    const body = new Promise((resolve) => { release = resolve })
    const dispatch = state.runToolExecution({
      name,
      arguments: { description: `${name} work` },
      agent: parentExec.agent,
    }, () => body)

    let finished = false
    const waiting = wait.execute({}, parentExec).then((value) => {
      finished = true
      return value
    })
    await Promise.resolve()
    assert.equal(finished, false, `${name} must reserve the join before its lifecycle start`)

    release({ isError: true, error: { message: 'not started' }, content: [] })
    await dispatch
    assert.deepEqual(await waiting, [])
  }
})

test('wait includes an in-flight background start before its descriptor lookup is available', async () => {
  const parentExec = execution({ agentId: 'racing-standard-parent' })
  const children = new Map()
  const child = {
    id: 'racing-standard-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{
        type: 'subagent/descriptor',
        data: {
          version: 2,
          mode: 'continuable',
          provider: 'spawn',
          label: 'Racing standard child',
        },
      }],
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => children.get(id),
      list: () => [...children.values()],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  let release
  const body = new Promise((resolve) => { release = resolve })
  const dispatch = state.runToolExecution({
    name: 'subagent',
    arguments: { description: 'Racing standard child' },
    agent: parentExec.agent,
  }, () => body)
  let finished = false
  const waiting = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/start', {
    runId: 'run-racing-standard',
    provider: 'spawn',
    id: child.id,
    local: true,
  }, parentExec.agent)
  children.set(child.id, child)
  release({
    isError: false,
    value: { kind: 'continuable', subagentId: child.id },
    content: [],
  })
  await dispatch
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/end', {
    runId: 'run-racing-standard',
    provider: 'spawn',
    id: child.id,
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Racing child complete.' }],
  }, parentExec.agent)
  const [result] = await waiting
  assert.equal(result.subagentId, child.id)
  assert.equal(result.output[0].text, 'Racing child complete.')
})

test('plugin reload reports an interrupted idle child with parked input and preserves it for resume', async () => {
  const parentExec = execution({ agentId: 'parked-reload-parent' })
  const childEvents = [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Parked child' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
  ]
  const inbox = { hasPending: true, nextTurn: [], nextStep: [{ id: 'parked-message' }] }
  const child = {
    id: 'parked-reload-child',
    status: 'idle',
    inbox,
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === child.id ? child : undefined,
      list: () => [child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  const paused = await wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) })
  assert.deepEqual(paused, {
    kind: 'paused',
    pending: [{ subagentId: child.id }],
    paused: [{ subagentId: child.id }],
  })
  assert.match(wait.output.render({}, paused)[0].text, /call send_message.*then call wait-for-subagents again/)

  child.status = 'running'
  inbox.hasPending = false
  inbox.nextStep = []
  const resumed = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) })
  state.emit('subagent/end', {
    runId: 'parked-resumed-run',
    id: child.id,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Parked child resumed and finished.' }],
  })
  assert.equal((await resumed)[0].output[0].text, 'Parked child resumed and finished.')
  child.status = 'idle'
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('an active wait reports a child that becomes idle with parked input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parentExec = execution({ agentId: 'late-parked-parent' })
  const childEvents = [{
    type: 'subagent/descriptor',
    data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Late parked child' },
  }]
  const inbox = { hasPending: false, nextTurn: [], nextStep: [] }
  const child = {
    id: 'late-parked-child',
    status: 'running',
    inbox,
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents: () => childEvents.slice(),
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => child, list: () => [child] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, parentExec)
  await new Promise((resolve) => setImmediate(resolve))

  childEvents.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 0 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
  )
  child.status = 'idle'
  inbox.hasPending = true
  inbox.nextStep = [{}]
  t.mock.timers.tick(10_000)

  const paused = await waiting
  assert.equal(paused.kind, 'paused')
  assert.deepEqual(paused.paused, [{ subagentId: child.id }])

  child.status = 'running'
  inbox.hasPending = false
  inbox.nextStep = []
  const resumed = wait.execute({}, parentExec)
  state.emit('subagent/end', {
    runId: 'late-parked-run',
    id: child.id,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Late parked child complete.' }],
  })
  assert.equal((await resumed)[0].output[0].text, 'Late parked child complete.')
})

test('an already-aborted wait rejects instead of returning an initial paused outcome', async () => {
  const parentExec = execution({ agentId: 'aborted-paused-parent' })
  const child = {
    id: 'aborted-paused-child',
    status: 'idle',
    inbox: { hasPending: true, nextTurn: [], nextStep: [{}] },
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      events: [
        { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Aborted paused child' } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 0 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
      ],
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => child, list: () => [child] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const controller = new AbortController()
  controller.abort(new Error('cancel paused wait'))
  await assert.rejects(wait.execute({}, execution({ agent: parentExec.agent, signal: controller.signal })), /cancel paused wait/)

  child.status = 'running'
  child.inbox.hasPending = false
  const resumed = wait.execute({}, parentExec)
  state.emit('subagent/end', {
    runId: 'aborted-paused-run',
    id: child.id,
    stopReason: 'aborted',
    lastAssistantMessage: [],
  })
  assert.equal((await resumed)[0].stopReason, 'aborted')
})

test('parked detection excludes running, no-pending, and cleanly completed idle children', async () => {
  const parentExec = execution({ agentId: 'parked-negative-parent' })
  const makeChild = (id, status, hasPending, reason) => ({
    id,
    status,
    inbox: { hasPending, nextTurn: [], nextStep: hasPending ? [{}] : [] },
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      events: [
        { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: id } },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 0 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } },
      ],
    },
  })
  const noPending = makeChild('idle-no-pending', 'idle', false, 'aborted')
  const completed = makeChild('idle-completed-pending', 'idle', true, 'completed')
  const running = makeChild('running-pending', 'running', true, 'aborted')
  const children = [noPending, completed, running]
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => children.find((child) => child.id === id),
      list: () => children,
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const controller = new AbortController()
  const waiting = wait.execute({}, execution({ agent: parentExec.agent, signal: controller.signal }))
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort(new Error('bounded negative parked check'))
  await assert.rejects(waiting, /bounded negative parked check/)

  state.emit('subagent/end', {
    runId: 'running-pending-run',
    id: running.id,
    stopReason: 'aborted',
    lastAssistantMessage: [],
  })
  assert.equal((await wait.execute({}, parentExec))[0].subagentId, running.id)
})

test('plugin reload discovers a genuinely running continuable child', async () => {
  const parentExec = execution({ agentId: 'reloaded-parent' })
  const child = {
    id: 'resident-child',
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{
        type: 'subagent/descriptor',
        data: {
          version: 2,
          mode: 'continuable',
          provider: 'spawn',
          label: 'Resident child',
        },
      }],
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === child.id ? child : undefined,
      list: () => [parentExec.agent, child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  let finished = false
  const waiting = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/end', {
    runId: 'run-resident-child',
    provider: 'spawn',
    id: child.id,
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Resident child complete.' }],
  }, parentExec.agent)
  const [result] = await waiting
  assert.equal(result.subagentId, child.id)
  assert.equal(result.label, 'Resident child')
  assert.equal(result.output[0].text, 'Resident child complete.')
})

test('plugin reload ignores an idle completed continuable child', async () => {
  const parentExec = execution({ agentId: 'reloaded-idle-parent' })
  const child = {
    id: 'resident-idle-child',
    status: 'idle',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      events: [{
        type: 'subagent/descriptor',
        data: {
          version: 2,
          mode: 'continuable',
          provider: 'spawn',
          label: 'Completed resident child',
        },
      }, {
        type: 'turn/start',
        data: { turn: 1 },
      }, {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      }],
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: {
      get: (id) => id === child.id ? child : undefined,
      list: () => [parentExec.agent, child],
    },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 100)
  try {
    assert.deepEqual(await wait.execute({}, execution({ agent: parentExec.agent, signal: controller.signal })), [])
  } finally {
    clearTimeout(timeout)
  }
})

test('a truly empty wait still returns immediately', async () => {
  const state = createContext({ settings: defaultSettings })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  assert.deepEqual(await wait.execute({}, execution({ agentId: 'empty-parent' })), [])
})

test('captures a child that settles before background start returns', async () => {
  const state = createContext({
    startContinuable(_spec, emit) {
      emit('subagent/end', {
        id: 'child-early',
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'Already done.' }],
      })
      return { childId: 'child-early', messageId: 'message-early' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Quick investigation',
    prompt: 'Investigate quickly.',
  }, execution())

  assert.deepEqual(await wait.execute({}, execution()), [{
    subagentId: 'child-early',
    model: 'deep',
    label: 'Quick investigation',
    stopReason: 'completed',
    output: [{ type: 'text', text: 'Already done.' }],
  }])
})

test('does not retain an unrelated ambiguous start emitted during router activation', async () => {
  const parentExec = execution({ agentId: 'ambiguous-start-parent' })
  const state = createContext({
    startContinuable(spec, emit) {
      emit('subagent/start', { runId: 'run-one-shot', id: 'one-shot', provider: spec.provider })
      emit('subagent/start', { runId: 'run-router', id: 'child-router', provider: spec.provider })
      return { childId: 'child-router', messageId: 'message-router' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Router child',
    prompt: 'Track only this router-owned child.',
  }, parentExec)
  state.emit('subagent/end', {
    runId: 'run-one-shot',
    id: 'one-shot',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Unrelated.' }],
  })
  state.emit('subagent/end', {
    runId: 'run-router',
    id: 'child-router',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Router result.' }],
  })

  const results = await wait.execute({}, parentExec)
  assert.deepEqual(results.map((result) => result.subagentId), ['child-router'])
})

test('promotes a provisional record when subagent/start arrives after startContinuable returns', async () => {
  const parentExec = execution({ agentId: 'delayed-start-parent' })
  let emitLifecycle
  const child = {
    session: {
      events: [{
        type: 'subagent/descriptor',
        data: {
          version: 2,
          mode: 'continuable',
          provider: 'spawn',
          label: 'Delayed lifecycle',
          agentModel: 'deep',
        },
      }],
    },
  }
  const state = createContext({
    agents: { get: (id) => id === 'child-delayed' ? child : undefined },
    startContinuable(_spec, emit) {
      emitLifecycle = emit
      return { childId: 'child-delayed', messageId: 'message-delayed' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Delayed lifecycle',
    prompt: 'Complete despite delayed lifecycle delivery.',
  }, parentExec)
  emitLifecycle('subagent/start', {
    runId: 'run-delayed',
    id: 'child-delayed',
    provider: 'spawn',
    local: true,
  })
  state.emit('subagent/end', {
    runId: 'run-delayed',
    id: 'child-delayed',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Delayed lifecycle result.' }],
  })

  const [result] = await wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(250) })
  assert.equal(result.output[0].text, 'Delayed lifecycle result.')
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('binds a missed start from the exact end event and ignores a later duplicate start', async () => {
  const parentExec = execution({ agentId: 'missed-start-parent' })
  const child = {
    session: {
      events: [{
        type: 'subagent/descriptor',
        data: {
          version: 2,
          mode: 'continuable',
          provider: 'spawn',
          label: 'Missed start',
          agentModel: 'deep',
        },
      }],
    },
  }
  const state = createContext({
    agents: { get: (id) => id === 'child-missed' ? child : undefined },
    startContinuable() {
      return { childId: 'child-missed', messageId: 'message-missed' }
    },
  })
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)

  await delegation.execute({
    model: 'deep',
    description: 'Missed start',
    prompt: 'Complete without a delivered start event.',
  }, parentExec)
  state.emit('subagent/end', {
    runId: 'run-missed',
    id: 'child-missed',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Recovered without start.' }],
  })
  const [result] = await wait.execute({}, parentExec)
  assert.equal(result.output[0].text, 'Recovered without start.')

  state.emit('subagent/start', {
    runId: 'run-missed',
    id: 'child-missed',
    provider: 'spawn',
    local: true,
  }, parentExec.agent)
  assert.deepEqual(await wait.execute({}, parentExec), [])

  await delegation.execute({
    model: 'deep',
    description: 'Reused child',
    prompt: 'Run a new activation on the reused child.',
  }, parentExec)
  state.emit('subagent/end', {
    runId: 'run-missed',
    id: 'child-missed',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Late duplicate from the old run.' }],
  })
  let finished = false
  const resumed = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  await Promise.resolve()
  assert.equal(finished, false)
  state.emit('subagent/end', {
    runId: 'run-reused',
    id: 'child-missed',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Exact reused-child result.' }],
  })
  const [reused] = await resumed
  assert.equal(reused.output[0].text, 'Exact reused-child result.')
})

test('preserves non-text child output in wait results', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const output = [
    { type: 'text', text: 'See attachment.' },
    { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
  ]

  await delegation.execute({
    model: 'deep',
    description: 'Inspect image',
    prompt: 'Inspect the image.',
  }, execution())
  state.emit('subagent/end', {
    runId: 'run-child-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: output,
  })

  const [result] = await wait.execute({}, execution())
  assert.deepEqual(result.output, output)
  assert.deepEqual(wait.output.render({}, [result]), [
    { type: 'text', text: 'child-1 [completed] Inspect image (deep)' },
    { type: 'text', text: '\n' },
    ...output,
  ])
})

test('cancelled waits retain child results for a retry', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Retry wait',
    prompt: 'Complete later.',
  }, execution())

  const controller = new AbortController()
  const cancelled = wait.execute({}, execution({ signal: controller.signal }))
  controller.abort(new Error('stop waiting'))
  await assert.rejects(cancelled, /stop waiting/)
  state.emitSessionEvent(execution().agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [], source: { kind: 'user' } }],
    },
  })

  state.emit('subagent/end', {
    runId: 'run-child-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Retry result.' }],
  })
  const [result] = await wait.execute({}, execution())
  assert.equal(result.output[0].text, 'Retry result.')
})

test('direct human steering interrupts an active wait and preserves the exact run for resumption', async () => {
  const parentExec = execution({ agentId: 'steered-parent' })
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Steered work',
    prompt: 'Complete after steering.',
  }, parentExec)

  const waiting = wait.execute({}, parentExec)
  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [{ type: 'text', text: 'Change direction.' }], source: { kind: 'user' } }],
    },
  })
  const interrupted = await waiting
  assert.deepEqual(interrupted, {
    kind: 'interrupted',
    pending: [{ subagentId: 'child-1', runId: 'run-child-1' }],
  })
  assert.match(wait.description, /answer the steering message first/)
  assert.deepEqual(wait.output.render({}, interrupted), [{
    type: 'text',
    text: 'wait interrupted by direct user steering; answer the steering message now, then call wait-for-subagents again before final synthesis (1 background subagent remains joinable)',
  }])

  state.emit('subagent/end', {
    runId: 'run-child-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Resumed exact result.' }],
  })
  const [result] = await wait.execute({}, parentExec)
  assert.equal(result.output[0].text, 'Resumed exact result.')
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('steering and completion races retain the terminal result for the next wait', async () => {
  const parentExec = execution({ agentId: 'racing-parent' })
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Racing work',
    prompt: 'Finish concurrently with steering.',
  }, parentExec)

  const waiting = wait.execute({}, parentExec)
  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [{ type: 'text', text: 'Steer now.' }], source: { kind: 'user' } }],
    },
  })
  state.emit('subagent/end', {
    runId: 'run-child-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Raced result.' }],
  })

  assert.equal((await waiting).kind, 'interrupted')
  const [result] = await wait.execute({}, parentExec)
  assert.equal(result.output[0].text, 'Raced result.')
})

test('wait ignores non-direct steering and stale run completions', async () => {
  const parentExec = execution({ agentId: 'filtered-parent' })
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Identity-bound work',
    prompt: 'Ignore unrelated lifecycle events.',
  }, parentExec)

  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [], source: { kind: 'user' } }],
    },
  })

  let finished = false
  const waiting = wait.execute({}, parentExec).then((value) => {
    finished = true
    return value
  })
  state.emitSessionEvent({}, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [], source: { kind: 'user' } }],
    },
  })
  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{ content: [], source: { kind: 'user' } }],
    },
  })
  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      inserted: [{ content: [], source: { kind: 'model' } }],
    },
  })
  state.emitSessionEvent(parentExec.agent.session, {
    type: 'agent/inbox/spliced',
    data: {
      target: 'next-step',
      start: 0,
      outcome: 'canceled',
      inserted: [{ content: [], source: { kind: 'user' } }],
    },
  })
  state.emit('subagent/end', {
    runId: 'stale-run',
    id: 'child-1',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Stale result.' }],
  })
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/end', {
    runId: 'run-child-1',
    id: 'child-1',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Identity-bound result.' }],
  })
  const [result] = await waiting
  assert.equal(result.output[0].text, 'Identity-bound result.')
})

test('recovery matches the continuation terminal-reason matrix and withholds teardown-failure output', async () => {
  const cases = [
    { name: 'completed', turnReason: 'completed', noticeReason: 'completed', expected: 'completed' },
    { name: 'completed then queued work discarded', turnReason: 'completed', droppedUnrun: true, noticeReason: 'aborted', expected: 'aborted' },
    { name: 'max tokens', turnReason: 'max-tokens', noticeReason: 'max-tokens', expected: 'max-tokens' },
    { name: 'interrupted', turnReason: 'interrupted', noticeReason: 'aborted', expected: 'aborted' },
    { name: 'aborted', turnReason: 'aborted', noticeReason: 'aborted', expected: 'aborted' },
    { name: 'blocked', turnReason: 'blocked', noticeReason: 'refusal', expected: 'refusal' },
    { name: 'error', turnReason: 'error', noticeReason: 'error', expected: 'error' },
    { name: 'teardown failure', turnReason: 'completed', noticeReason: 'error', expected: 'error', outputWithheld: true },
  ]
  for (const [index, entry] of cases.entries()) {
    const childId = `terminal-matrix-child-${index}`
    const parentEvents = []
    const parentExec = execution({
      agent: {
        id: `terminal-matrix-parent-${index}`,
        options: {},
        session: { snapshotEvents: () => parentEvents.slice() },
      },
    })
    const childEvents = [{
      type: 'subagent/descriptor',
      data: { version: 3, mode: 'continuable', provider: 'spawn', label: entry.name },
    }]
    const child = {
      id: childId,
      status: 'running',
      session: {
        header: { origin: 'subagent', parentSession: parentExec.agent.id },
        firstLiveSeq: 1,
        snapshotEvents: () => childEvents.slice(),
      },
    }
    const state = createContext({
      settings: defaultSettings,
      agents: { get: () => child, list: () => [child] },
    })
    await apply(state.ctx)
    const wait = state.registeredTools.get(WAIT_TOOL_NAME)
    const waiting = wait.execute({}, { ...parentExec, signal: AbortSignal.timeout(500) })
    await Promise.resolve()
    childEvents.push(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${entry.name} output` }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: entry.turnReason } } },
    )
    if (entry.droppedUnrun) {
      childEvents.push({
        type: 'agent/inbox/spliced',
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
      })
    }
    const notice = {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [],
          source: {
            kind: 'subagent-settled',
            form: 'notice',
            summary: expectedSettlementSummaryForTest(childId, entry.noticeReason),
            senderSessionId: childId,
          },
        }],
      },
    }
    parentEvents.push(notice)
    state.emitSessionEvent(parentExec.agent.session, notice)
    const [result] = await waiting
    assert.equal(result.stopReason, entry.expected, entry.name)
    assert.deepEqual(result.output, entry.outputWithheld ? [] : [{ type: 'text', text: `${entry.name} output` }], entry.name)
  }
})

test('matching settlement proof fails closed when the retained child is permanently missing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const childId = 'permanently-missing-child'
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'permanently-missing-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => undefined, list: () => [] },
  })
  await apply(state.ctx)
  await state.runToolExecution({
    name: 'subagent',
    arguments: { description: 'Missing child' },
    agent: parentExec.agent,
  }, async () => ({ isError: false, value: { kind: 'continuable', subagentId: childId }, content: [] }))
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, parentExec)
  await new Promise((resolve) => setImmediate(resolve))
  const notice = settlementNoticeForTest(childId, 'completed')
  parentEvents.push(notice)
  state.emitSessionEvent(parentExec.agent.session, notice)
  t.mock.timers.tick(10_000)

  await assert.rejects(waiting, /permanently-missing-child.*retained Agent history is unavailable/)
  assert.deepEqual(await wait.execute({}, parentExec), [])
  assert.doesNotThrow(() => state.emit('agent/disposed', { agent: parentExec.agent }))
})

test('a failed record does not consume a healthy sibling result needed by retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'mixed-recovery-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => undefined, list: () => [] },
  })
  await apply(state.ctx)
  for (const childId of ['mixed-healthy-child', 'mixed-missing-child']) {
    await state.runToolExecution({
      name: 'subagent',
      arguments: { description: childId },
      agent: parentExec.agent,
    }, async () => ({ isError: false, value: { kind: 'continuable', subagentId: childId }, content: [] }))
  }
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, parentExec)
  await new Promise((resolve) => setImmediate(resolve))
  state.emit('subagent/end', {
    runId: 'mixed-healthy-run',
    id: 'mixed-healthy-child',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Retain this healthy result.' }],
  })
  const notice = settlementNoticeForTest('mixed-missing-child', 'completed')
  parentEvents.push(notice)
  state.emitSessionEvent(parentExec.agent.session, notice)
  t.mock.timers.tick(10_000)

  await assert.rejects(waiting, /mixed-missing-child.*retained Agent history is unavailable/)
  const retry = await wait.execute({}, parentExec)
  assert.deepEqual(retry.map((entry) => entry.subagentId), ['mixed-healthy-child'])
  assert.equal(retry[0].output[0].text, 'Retain this healthy result.')
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('matching settlement proof fails closed when retained activation history is corrupt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const childId = 'corrupt-history-child'
  const parentEvents = []
  const parentExec = execution({
    agent: {
      id: 'corrupt-history-parent',
      options: {},
      session: { snapshotEvents: () => parentEvents.slice() },
    },
  })
  let corrupt = false
  const child = {
    id: childId,
    status: 'running',
    session: {
      header: { origin: 'subagent', parentSession: parentExec.agent.id },
      firstLiveSeq: 1,
      snapshotEvents() {
        if (corrupt) throw new Error('corrupt retained log')
        return [{ type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Corrupt history' } }]
      },
    },
  }
  const state = createContext({
    settings: defaultSettings,
    agents: { get: () => child, list: () => [child] },
  })
  await apply(state.ctx)
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const waiting = wait.execute({}, parentExec)
  await new Promise((resolve) => setImmediate(resolve))
  corrupt = true
  const notice = settlementNoticeForTest(childId, 'completed')
  parentEvents.push(notice)
  assert.doesNotThrow(() => state.emitSessionEvent(parentExec.agent.session, notice))
  t.mock.timers.tick(10_000)

  await assert.rejects(waiting, /corrupt-history-child.*corrupt retained log/)
  child.status = 'idle'
  assert.deepEqual(await wait.execute({}, parentExec), [])
})

test('tracker Fiber teardown rejects active waits idempotently and clears watchdog timers', async (t) => {
  const activeTimers = new Set()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    let timer
    timer = originalSetTimeout(() => {
      activeTimers.delete(timer)
      callback(...args)
    }, delay)
    activeTimers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    activeTimers.delete(timer)
    return originalClearTimeout(timer)
  })

  const parentExec = execution({ agentId: 'tracker-disposal-parent' })
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Disposed tracker work',
    prompt: 'Remain pending until tracker disposal.',
  }, parentExec)
  const waiting = wait.execute({}, parentExec)
  await Promise.resolve()
  assert.equal(activeTimers.size, 1)

  state.disposeEffects()
  state.disposeEffects()
  await assert.rejects(waiting, /tracker was disposed before its active waits completed/)
  assert.equal(activeTimers.size, 0)
  await assert.rejects(wait.execute({}, parentExec), /tracker was disposed/)

  const racingParent = execution({ agentId: 'tracker-disposal-settlement-race-parent' })
  const racingState = createContext()
  await apply(racingState.ctx)
  const racingDelegation = racingState.registeredTools.get('subagent_model')
  const racingWait = racingState.registeredTools.get(WAIT_TOOL_NAME)
  await racingDelegation.execute({
    model: 'deep',
    description: 'Disposal settlement race',
    prompt: 'Settle at the disposal boundary.',
  }, racingParent)
  const raced = racingWait.execute({}, racingParent)
  racingState.emit('subagent/end', {
    runId: 'run-child-1',
    id: 'child-1',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Must not escape teardown.' }],
  })
  racingState.disposeEffects()
  await assert.rejects(raced, /tracker was disposed before its active waits completed/)
  assert.equal(activeTimers.size, 0)
})

test('parent disposal releases tracked children and active waits', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  await delegation.execute({
    model: 'deep',
    description: 'Disposed parent work',
    prompt: 'Keep working.',
  }, execution())

  const waiting = wait.execute({}, execution())
  state.emit('agent/disposed', { agent: execution().agent })
  assert.deepEqual(await waiting, [{
    subagentId: 'child-1',
    model: 'deep',
    label: 'Disposed parent work',
    stopReason: 'aborted',
    output: [],
  }])
})

test('disposing an old same-id agent does not clear replacement tracking', async () => {
  const state = createContext()
  await apply(state.ctx)
  const delegation = state.registeredTools.get('subagent_model')
  const wait = state.registeredTools.get(WAIT_TOOL_NAME)
  const oldAgent = { id: 'reused-parent', options: {} }
  const replacement = { id: 'reused-parent', options: {}, session: { events: [] } }
  await delegation.execute({
    model: 'deep',
    description: 'Replacement work',
    prompt: 'Finish replacement work.',
  }, execution({ agent: replacement }))

  let finished = false
  const waiting = wait.execute({}, execution({ agent: replacement })).then((result) => {
    finished = true
    return result
  })
  state.emit('agent/disposed', { agent: oldAgent })
  await Promise.resolve()
  assert.equal(finished, false)

  state.emit('subagent/end', {
    runId: 'run-child-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Replacement complete.' }],
  })
  const [result] = await waiting
  assert.equal(result.output[0].text, 'Replacement complete.')
})

test('existing wait tool suppresses router tracking and guidance', async () => {
  const existingWaitTool = { name: WAIT_TOOL_NAME, description: 'existing wait implementation' }
  const state = createContext({ existingWaitTool })
  await apply(state.ctx)

  assert.equal(state.registeredTools.get(WAIT_TOOL_NAME), existingWaitTool)
  assert.equal(state.listeners.has('subagent/end'), false)
  assert.equal(state.sections[0].text({ scope: {} }), '')
  const delegation = state.registeredTools.get('subagent_model')
  assert.deepEqual(await delegation.execute({
    model: 'deep',
    description: 'Use existing wait',
    prompt: 'Delegate without router tracking.',
  }, execution()), {
    kind: 'continuable',
    subagentId: 'child-1',
    model: 'deep',
  })
})

test('scoped wait shadow suppresses tracking for that parent', async () => {
  const parent = { id: 'scoped-parent', options: {} }
  const scopedWait = { name: WAIT_TOOL_NAME, description: 'scoped wait implementation' }
  const state = createContext({ scopedWaitTool: { agent: parent, tool: scopedWait } })
  await apply(state.ctx)
  const routerWait = state.registeredTools.get(WAIT_TOOL_NAME)
  const delegation = state.registeredTools.get('subagent_model')

  assert.notEqual(routerWait, scopedWait)
  assert.equal(state.ctx.tools.get(WAIT_TOOL_NAME, parent), scopedWait)
  assert.equal(state.sections[0].text({ scope: parent }), '')
  await delegation.execute({
    model: 'deep',
    description: 'Scoped wait work',
    prompt: 'Delegate through the scoped wait owner.',
  }, execution({ agent: parent }))
  assert.deepEqual(await routerWait.execute({}, execution({ agent: parent })), [])
})

test('Web settings route is loopback-only and persists validated revisions', async () => {
  const state = createContext({ withWebServer: true })
  await apply(state.ctx)
  const route = state.webRoute()
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/dsh-subagent-model-router/settings')

  const current = await callWebRoute(route)
  assert.equal(current.status, 200)
  assert.equal(current.body.writable, true)
  assert.equal(current.body.descriptor.revision, 0)
  assert.equal(current.body.descriptor.value.models[0].alias, 'deep')

  const section = {
    ...configuredSettings,
    toolName: 'delegate_model',
    models: [{
      ...configuredSettings.models[0],
      alias: 'fast',
      description: 'Use for quick routine work.',
    }],
  }
  const updated = await callWebRoute(route, {
    method: 'PUT',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
    },
    body: { section, expectedRevision: 0 },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.descriptor.revision, 1)
  assert.equal(updated.body.descriptor.value.models[0].alias, 'fast')
  assert.equal(updated.body.descriptor.value.toolName, undefined)
  assert.ok(state.registeredTools.get('subagent_model'))

  const stale = await callWebRoute(route, {
    method: 'PUT',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': 'application/json',
    },
    body: { section, expectedRevision: 0 },
  })
  assert.equal(stale.status, 409)

  const remote = await callWebRoute(route, { remoteAddress: '192.0.2.10' })
  assert.equal(remote.status, 403)
  const crossOrigin = await callWebRoute(route, {
    method: 'PUT',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'https://example.test',
      'content-type': 'application/json',
    },
    body: { section, expectedRevision: 1 },
  })
  assert.equal(crossOrigin.status, 403)
  const reboundHost = await callWebRoute(route, {
    method: 'PUT',
    headers: {
      host: 'evil.test:3080',
      origin: 'http://evil.test:3080',
      'content-type': 'application/json',
    },
    body: { section, expectedRevision: 1 },
  })
  assert.equal(reboundHost.status, 403)

  const trustedOriginsVariable = 'DSH_SUBAGENT_MODEL_ROUTER_TRUSTED_ORIGINS'
  const previousTrustedOrigins = process.env[trustedOriginsVariable]
  process.env[trustedOriginsVariable] = 'https://dsh.example.test'
  try {
    const trustedProxy = await callWebRoute(route, {
      method: 'PUT',
      headers: {
        host: 'dsh.example.test',
        origin: 'https://dsh.example.test',
        'content-type': 'application/json',
      },
      body: { section, expectedRevision: 1 },
    })
    assert.equal(trustedProxy.status, 200)
    assert.equal(trustedProxy.body.descriptor.revision, 2)
  } finally {
    if (previousTrustedOrigins === undefined) delete process.env[trustedOriginsVariable]
    else process.env[trustedOriginsVariable] = previousTrustedOrigins
  }
})

test('configuration tool reads and updates only the plugin settings namespace', async () => {
  const state = createContext()
  await apply(state.ctx)
  const configuration = state.registeredTools.get(CONFIG_TOOL_NAME)

  const current = await configuration.execute({ action: 'get' }, execution())
  assert.equal(current.status, 'current')
  assert.equal(current.settings.models[0].alias, 'deep')

  const updated = await configuration.execute({
    action: 'update',
    models: [{
      alias: 'fast',
      provider: 'acme',
      model: 'fast-model',
      tags: ['fast', 'routine'],
      description: 'Use for quick routine work.',
    }],
    max_depth: 2,
  }, execution())

  assert.equal(updated.status, 'updated')
  assert.equal(updated.settings.toolName, undefined)
  assert.equal(updated.settings.models[0].displayName, 'fast')
  assert.equal(state.settingsReplacements.length, 1)
  assert.deepEqual(state.settingsReplacements[0], updated.settings)
  assert.ok(state.registeredTools.get('subagent_model'))
  assert.ok(state.registeredTools.get(CONFIG_TOOL_NAME))
})

test('configuration tool requires a complete model list for updates', async () => {
  const state = createContext()
  await apply(state.ctx)
  const configuration = state.registeredTools.get(CONFIG_TOOL_NAME)
  await assert.rejects(
    () => configuration.execute({ action: 'update' }, execution()),
    /models is required/,
  )
  assert.equal(state.settingsReplacements.length, 0)
})

test('hot settings changes replace and remove the model-facing tool', async () => {
  const state = createContext()
  await apply(state.ctx)
  assert.ok(state.registeredTools.get('subagent_model'))

  state.updateSettings({
    ...configuredSettings,
    toolName: 'delegate_model',
    models: [{
      ...configuredSettings.models[0],
      alias: 'fast',
      model: 'fast-model',
      tags: ['fast'],
      description: 'Use for quick routine work.',
    }],
  })

  const replacement = state.registeredTools.get('subagent_model')
  assert.ok(replacement)
  assert.deepEqual(replacement.parameters.properties.model.enum, ['fast'])
  assert.match(state.sections[0].text({ scope: {} }), /fast-model/)

  state.updateSettings(defaultSettings)
  assert.equal(state.registeredTools.has('subagent_model'), false)
  assert.ok(state.registeredTools.get(CATALOG_TOOL_NAME))
  assert.equal(state.sections[0].text({ scope: {} }), '')
})

test('projects the adapter-resolved route only after the child descriptor', async () => {
  const projection = subagentModelRouteProjectionDefinition
  const inherited = {
    type: 'request/header',
    data: { header: { config: { provider: 'parent-provider', model: 'parent-model' } } },
  }
  const descriptor = { type: 'subagent/descriptor' }
  const header = {
    type: 'request/header',
    data: { header: { config: { provider: 'acme', model: 'reasoner' } } },
  }
  const assistant = {
    type: 'assistant/message',
    data: { message: { source: { provider: 'backup', model: 'final-model' } } },
  }

  const initial = projection.init()
  assert.equal(projection.apply(initial, inherited), initial)
  const afterDescriptor = projection.apply(initial, descriptor)
  assert.equal(projection.view(afterDescriptor), null)
  const afterHeader = projection.apply(afterDescriptor, header)
  assert.deepEqual(projection.view(afterHeader), { provider: 'acme', model: 'reasoner' })
  assert.equal(projection.apply(afterHeader, header), afterHeader)
  const afterAssistant = projection.apply(afterHeader, assistant)
  assert.deepEqual(projection.view(afterAssistant), { provider: 'backup', model: 'final-model' })
  assert.deepEqual(projection.wire.view(afterAssistant), { provider: 'backup', model: 'final-model' })
  assert.equal(projection.view(projection.apply(afterAssistant, descriptor)), null)

  assert.deepEqual(projection.stateSchema.parse(afterAssistant), afterAssistant)
  assert.equal(projection.wire.viewSchema.parse(null), null)
  assert.equal(projection.schema.parse(null), null)
  assert.deepEqual(projection.schema.parse({ provider: 'acme', model: 'reasoner' }), {
    provider: 'acme',
    model: 'reasoner',
  })
  assert.throws(() => projection.schema.parse({ provider: 'acme' }))
})

test('empty settings keep only bootstrap setup capabilities', async () => {
  const state = createContext({ settings: defaultSettings })
  await apply(state.ctx)

  assert.ok(state.registeredTools.get(CATALOG_TOOL_NAME))
  assert.ok(state.registeredTools.get(CONFIG_TOOL_NAME))
  assert.ok(state.registeredTools.get(WAIT_TOOL_NAME))
  assert.equal(state.registeredTools.has('subagent_model'), false)
  assert.equal(state.skills[0].name, 'model-subagent-setup')
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].text({ scope: {} }), '')
})

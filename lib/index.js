import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import {
  normalizeConfiguredModels,
  renderCatalogResult,
  renderConfiguredModels,
} from './model-catalog.js'

const name = 'dsh-subagent-model-router'
const inject = ['tools', 'subagents', 'systemPrompt', 'skills', 'llm', 'settings', 'sessionProjections']
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

function sameModelRoute(left, right) {
  return left?.provider === right.provider && left.model === right.model
}

const subagentModelRouteProjectionDefinition = {
  key: 'subagentModelRoute',
  schema: modelRouteProjectionSchema,
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
  view: (state) => state.route ?? null,
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

function createOrchestrationTracker(ctx) {
  const states = new Map()
  const byChildId = new Map()
  const earlySettlements = new Map()
  let startsInFlight = 0

  const stateFor = (parent) => {
    let state = states.get(parent)
    if (state === undefined) {
      state = { children: new Map(), starting: 0, waiters: new Set(), waiting: 0, disposed: false }
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

  const settle = (record, info) => {
    if (record.settlement !== undefined) return
    record.settlement = {
      subagentId: record.subagentId,
      model: record.model,
      label: record.label,
      stopReason: String(info.stopReason),
      output: info.lastAssistantMessage ?? [],
    }
    record.resolve(record.settlement)
  }

  ctx.on('subagent/end', (info) => {
    const record = byChildId.get(info.id)
    if (record !== undefined) {
      settle(record, info)
    } else if (startsInFlight > 0) {
      earlySettlements.set(info.id, info)
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
      byChildId.delete(record.subagentId)
    }
    state.children.clear()
    states.delete(agent)
    notify(state)
    if (startsInFlight === 0) earlySettlements.clear()
  })

  return {
    begin(parent) {
      const state = stateFor(parent)
      state.starting += 1
      startsInFlight += 1
      return state
    },
    track(state, childId, model, label) {
      if (state.disposed) return
      let resolve
      const settled = new Promise((done) => {
        resolve = done
      })
      const record = { subagentId: childId, model, label, resolve, settled, settlement: undefined }
      state.children.set(childId, record)
      byChildId.set(childId, record)
      const early = earlySettlements.get(childId)
      if (early !== undefined) {
        earlySettlements.delete(childId)
        settle(record, early)
      }
    },
    finish(parent, state) {
      if (state.disposed) return
      state.starting -= 1
      startsInFlight -= 1
      notify(state)
      if (startsInFlight === 0) earlySettlements.clear()
      prune(parent, state)
    },
    async wait(parent, signal) {
      const state = stateFor(parent)
      state.waiting += 1
      try {
        while (state.starting > 0) {
          let resolveChange
          const changed = new Promise((resolve) => {
            resolveChange = resolve
            state.waiters.add(resolve)
          })
          try {
            await awaitWithSignal(changed, signal)
          } finally {
            state.waiters.delete(resolveChange)
          }
        }

        const records = [...state.children.values()]
        const settlements = await awaitWithSignal(Promise.all(records.map((record) => record.settled)), signal)
        for (const record of records) {
          if (state.children.get(record.subagentId) === record) state.children.delete(record.subagentId)
          if (byChildId.get(record.subagentId) === record) byChildId.delete(record.subagentId)
        }
        return settlements
      } finally {
        state.waiting -= 1
        prune(parent, state)
      }
    },
  }
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
    description: `Wait for every outstanding background subagent started by this agent through ${DELEGATION_TOOL_NAME}. Call this once after issuing all intended delegations; it blocks until they settle and returns their results, so do not poll.`,
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subagentId: { type: 'string', required: true },
            model: { type: 'string', required: true },
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
      render: (_args, settlements) => {
        if (settlements.length === 0) {
          return [{ type: 'text', text: '(no outstanding model-routed subagents)' }]
        }
        const blocks = []
        settlements.forEach((entry, index) => {
          if (index > 0) blocks.push({ type: 'text', text: '\n\n' })
          blocks.push({ type: 'text', text: `${entry.subagentId} [${entry.stopReason}] ${entry.label} (${entry.model})` })
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

function createDelegationTool(ctx, tracker, config, provider, models) {
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
        const startBackground = () => ctx.subagents.startContinuable({
          provider: config.subagentProvider ?? 'spawn',
          label: args.description,
          request,
          signal: exec.signal,
        })
        if (tracker === undefined) {
          const started = await startBackground()
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.alias,
          }
        }

        const trackingState = tracker.begin(parent)
        try {
          const started = await startBackground()
          tracker.track(trackingState, started.childId, selected.alias, args.description)
          return {
            kind: 'continuable',
            subagentId: started.childId,
            model: selected.alias,
          }
        } finally {
          tracker.finish(parent, trackingState)
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

function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  } catch {
    return false
  }
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
    } catch {
      return false
    }
  }
  return req.headers['sec-fetch-site'] === 'same-origin'
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
      disposeTool = ctx.tools.register(createDelegationTool(ctx, waitTool === undefined ? undefined : tracker, current, provider, current.models))
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
      : `For model-selectable delegation, use \`${DELEGATION_TOOL_NAME}\` and choose only from these configured routes. Treat each description as the owner's routing policy rather than guessing from the raw model name. Once you delegate a task, do not also perform that task yourself; continue only with independent work. After issuing all intended background delegations, call \`${WAIT_TOOL_NAME}\` before synthesizing their results or giving a final answer.\n${renderConfiguredModels(current.models)}`,
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

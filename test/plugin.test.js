import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apply,
  CATALOG_TOOL_NAME,
  CONFIG_TOOL_NAME,
  SETTINGS_NAMESPACE,
} from '../lib/index.js'

const configuredSettings = {
  subagentProvider: 'spawn',
  toolName: 'subagent_model',
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
  toolName: 'subagent_model',
  maxDepth: 3,
  enableRunInBackground: true,
  models: [],
}

function createContext(options = {}) {
  const registeredTools = new Map()
  const listeners = new Map()
  const sections = []
  const skills = []
  const starts = []
  const continuableStarts = []
  const effects = []
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
      get(name) {
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
        return { childId: 'child-1', messageId: 'message-1' }
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
    isDisposed: () => disposed,
    listeners,
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

function execution() {
  return {
    agent: {
      id: 'parent-1',
      options: { provider: 'parent-provider', model: 'parent-model' },
    },
    signal: new AbortController().signal,
  }
}

test('registers settings, setup skill, catalog, and configured model tool', async () => {
  const state = createContext()
  await apply(state.ctx)

  assert.equal(state.settingsRegistration().namespace, SETTINGS_NAMESPACE)
  assert.equal(state.settingsRegistration().options.applies, 'live')
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
  assert.ok(catalog)
  assert.ok(configuration)
  assert.ok(delegation)
  assert.deepEqual(delegation.parameters.properties.model.enum, ['deep'])
  assert.match(delegation.description, /reasoning, review/)
  assert.match(delegation.description, /Use for difficult analysis and review/)

  const sectionText = state.sections[0].text({ scope: {} })
  assert.match(sectionText, /acme\/reasoner/)

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

test('Web settings route is loopback-only and persists validated revisions', async () => {
  const state = createContext({ withWebServer: true })
  await apply(state.ctx)
  const route = state.webRoute()
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/dsh-subagent-dynamic-model/settings')

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
  assert.ok(state.registeredTools.get('delegate_model'))

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
    tool_name: 'delegate_model',
    max_depth: 2,
  }, execution())

  assert.equal(updated.status, 'updated')
  assert.equal(updated.settings.toolName, 'delegate_model')
  assert.equal(updated.settings.models[0].displayName, 'fast')
  assert.equal(state.settingsReplacements.length, 1)
  assert.deepEqual(state.settingsReplacements[0], updated.settings)
  assert.equal(state.registeredTools.has('subagent_model'), false)
  assert.ok(state.registeredTools.get('delegate_model'))
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

  assert.equal(state.registeredTools.has('subagent_model'), false)
  const replacement = state.registeredTools.get('delegate_model')
  assert.ok(replacement)
  assert.deepEqual(replacement.parameters.properties.model.enum, ['fast'])
  assert.match(state.sections[0].text({ scope: {} }), /fast-model/)

  state.updateSettings(defaultSettings)
  assert.equal(state.registeredTools.has('delegate_model'), false)
  assert.ok(state.registeredTools.get(CATALOG_TOOL_NAME))
  assert.equal(state.sections[0].text({ scope: {} }), '')
})

test('empty settings keep only bootstrap setup capabilities', async () => {
  const state = createContext({ settings: defaultSettings })
  await apply(state.ctx)

  assert.ok(state.registeredTools.get(CATALOG_TOOL_NAME))
  assert.ok(state.registeredTools.get(CONFIG_TOOL_NAME))
  assert.equal(state.registeredTools.has('subagent_model'), false)
  assert.equal(state.skills[0].name, 'model-subagent-setup')
  assert.equal(state.sections.length, 1)
  assert.equal(state.sections[0].text({ scope: {} }), '')
})

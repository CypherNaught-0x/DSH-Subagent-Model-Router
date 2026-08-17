import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, CATALOG_TOOL_NAME } from '../lib/index.js'

function createContext(options = {}) {
  const registeredTools = new Map()
  const listeners = new Map()
  const sections = []
  const skills = []
  const starts = []
  const continuableStarts = []
  let disposed = false

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

  const ctx = {
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
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
  }

  return {
    ctx,
    continuableStarts,
    isDisposed: () => disposed,
    listeners,
    registeredTools,
    sections,
    skills,
    starts,
  }
}

const pluginConfig = {
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

function execution() {
  return {
    agent: {
      id: 'parent-1',
      options: { provider: 'parent-provider', model: 'parent-model' },
    },
    signal: new AbortController().signal,
  }
}

test('registers the setup skill, live catalog, and configured model tool', async () => {
  const state = createContext()
  await apply(state.ctx, pluginConfig)

  assert.equal(state.skills.length, 1)
  assert.equal(state.skills[0].name, 'model-subagent-setup')
  assert.match(state.skills[0].content, /Call `model_subagent_catalog`/)

  const catalog = state.registeredTools.get(CATALOG_TOOL_NAME)
  const delegation = state.registeredTools.get('subagent_model')
  assert.ok(catalog)
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

test('routes foreground work through the selected child model', async () => {
  const state = createContext()
  await apply(state.ctx, pluginConfig)
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
  await apply(state.ctx, pluginConfig)
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

test('empty configuration keeps only bootstrap setup capabilities', async () => {
  const state = createContext()
  await apply(state.ctx, {})

  assert.ok(state.registeredTools.get(CATALOG_TOOL_NAME))
  assert.equal(state.registeredTools.has('subagent_model'), false)
  assert.equal(state.skills[0].name, 'model-subagent-setup')
  assert.equal(state.sections.length, 0)
})

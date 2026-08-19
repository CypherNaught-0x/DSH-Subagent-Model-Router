import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function loadClient(options = {}) {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import(`../lib/client.js?test=${Date.now()}`)
  } finally {
    delete globalThis.window
  }

  let stateIndex = 0
  const effectCleanups = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const fallback = typeof initial === 'function' ? initial() : initial
      const value = options.stateValues?.[stateIndex] ?? fallback
      stateIndex += 1
      return [value, () => {}]
    },
    useEffect(effect) {
      if (!options.runEffects) return
      const cleanup = effect()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
    },
    useMemo(factory) {
      return factory()
    },
    useRef(initial) {
      return { current: initial }
    },
  }
  return {
    definition,
    effectCleanups,
    plugin: definition.factory((name) => {
      assert.equal(name, 'react')
      return React
    }),
  }
}

test('client bundle registers a dedicated settings section', async () => {
  const { definition, plugin } = await loadClient()
  assert.equal(definition.id, 'dsh-subagent-model-router')
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'remote', 'sessions'])

  const registrations = []
  const injectionDisposers = []
  const slots = {
    inject(_name, callback) {
      injectionDisposers.push(callback())
      return () => {}
    },
    register(options, component) {
      const registration = { options, component }
      registrations.push(registration)
      return () => {
        const index = registrations.indexOf(registration)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
  const services = {
    slots,
    connection: { api: {}, isLoopback: true },
    remote: { $on: () => () => {} },
    sessions: {
      openSubagent() {},
      setSubagentCatalogOpen() {},
    },
  }
  plugin.apply({
    get(name) {
      return services[name]
    },
    on() {
      return () => {}
    },
  })

  assert.deepEqual(registrations.map((entry) => entry.options), [{
    name: 'conversation.session.header.actions',
    id: 'subagent-model',
    order: -10,
    priority: -1,
  }, {
    name: 'conversation.session.header.actions',
    id: 'subagent-catalog',
    order: 10,
    priority: -1,
    locale: 'subagent',
  }, {
    name: 'settings.section',
    id: 'subagent-model-router',
    order: 25,
    label: 'Subagent Models',
  }])
  const registration = registrations[2]
  const rendered = registration.component()
  assert.equal(rendered.type, 'section')
  assert.equal(rendered.children[0].children[0], 'Subagent Models')
  assert.equal(rendered.children[4].children[0].children[0], 'Models')

  for (const dispose of injectionDisposers.reverse()) dispose()
  assert.equal(registrations.length, 0)
})

function expandFunctionComponents(node) {
  if (Array.isArray(node)) return node.map(expandFunctionComponents)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expandFunctionComponents(node.type(node.props))
  return {
    ...node,
    children: node.children.map(expandFunctionComponents),
  }
}

function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findNode(child, predicate)
      if (match !== undefined) return match
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return findNode(node.children, predicate)
}

test('header chip shows the active route only for an addressed subagent', async () => {
  const { plugin } = await loadClient()
  const route = { provider: 'acme', model: 'reasoner' }
  const chip = expandFunctionComponents(plugin.SubagentModelChip({
    useSession: (selector) => selector({ subagent: { address: {} } }),
    useProjection: () => route,
  }))

  assert.equal(chip.props.title, 'acme/reasoner')
  assert.equal(chip.props['aria-label'], 'acme/reasoner')
  assert.equal(chip.children[0].children[0], 'reasoner')
  assert.equal(plugin.SubagentModelChip({
    useSession: (selector) => selector({ subagent: null }),
    useProjection: () => route,
  }), null)
  assert.equal(plugin.SubagentModelChip({
    useSession: (selector) => selector({ subagent: { address: {} } }),
    useProjection: () => null,
  }), null)
})

test('catalog rows render the active model as an accessible chip', async () => {
  const { plugin } = await loadClient({ stateValues: [true, new Set()] })
  const route = { provider: 'acme', model: 'reasoner' }
  const state = {
    subagentsByParent: {
      parent: {
        state: 'ready',
        error: null,
        parentAvailable: true,
        entries: [{
          kind: 'child',
          id: 'child',
          label: 'Review',
          mode: 'continuable',
          activity: 'running',
          hasChildren: false,
        }],
      },
    },
    byId: {
      child: {
        id: 'child',
        origin: 'subagent',
        parentId: 'parent',
        running: true,
        title: 'Review architecture',
        projectionValues: { subagentModelRoute: route },
      },
    },
  }
  const tree = expandFunctionComponents(plugin.SubagentCatalogAction({
    sessionId: 'parent',
    useSessions: (selector) => selector(state),
    sessions: {
      openSubagent() {},
      refreshSubagents() {},
      setSubagentCatalogOpen() {},
    },
    t: (key) => key,
  }))

  const chip = findNode(tree, (node) => node.props?.title === 'acme/reasoner')
  assert.ok(chip)
  assert.equal(chip.props['aria-label'], 'acme/reasoner')
  assert.equal(chip.children[0].children[0], 'reasoner')
  const row = findNode(tree, (node) => node.props?.role === 'treeitem')
  assert.match(row.props['aria-label'], /acme\/reasoner/)
})

test('catalog unmount closes every expanded descendant with the service receiver intact', async () => {
  const { plugin, effectCleanups } = await loadClient({
    runEffects: true,
    stateValues: [true, new Set(), 0],
  })
  const calls = []
  const sessions = {
    openSubagent() {},
    refreshSubagents() {},
    setSubagentCatalogOpen(id, open) {
      assert.equal(this, sessions)
      calls.push([id, open])
    },
  }
  const state = {
    subagentsByParent: {
      parent: {
        state: 'ready',
        error: null,
        parentAvailable: true,
        entries: [{
          kind: 'child',
          id: 'child',
          label: 'Review',
          mode: 'continuable',
          activity: 'inactive',
          hasChildren: true,
        }],
      },
    },
    byId: {
      child: {
        id: 'child',
        origin: 'subagent',
        parentId: 'parent',
        running: false,
        title: 'Review architecture',
        projectionValues: {},
      },
    },
  }
  const tree = expandFunctionComponents(plugin.SubagentCatalogAction({
    sessionId: 'parent',
    useSessions: (selector) => selector(state),
    sessions,
    t: (key) => key,
  }))
  const disclosure = findNode(tree, (node) => node.props?.['aria-label'] === 'branch.expand')
  disclosure.props.onClick({ preventDefault() {}, stopPropagation() {} })
  for (const cleanup of effectCleanups.reverse()) cleanup()

  assert.deepEqual(calls, [['child', true], ['child', false]])
})

test('client uses the plugin endpoint instead of the rc.6 allowlisted settings API', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\/dsh-subagent-model-router\/settings/)
  assert.match(source, /\/model-subagent-setup/)
  assert.doesNotMatch(source, /label: 'Tool name'/)
  assert.doesNotMatch(source, /api\.settings\.describe/)
  assert.doesNotMatch(source, /api\.settings\.update/)
})

test('package manifest publishes and injects the client bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.6.0')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-subagent'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
})

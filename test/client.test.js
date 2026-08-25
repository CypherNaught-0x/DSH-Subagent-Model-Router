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
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
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
  const effectDisposers = []
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
  let sidebarDecorationRegistrations = 0
  const services = {
    slots,
    betterSidebar: {
      features: [],
      registerSubagentRowDecoration() {
        sidebarDecorationRegistrations += 1
        return () => {}
      },
    },
    connection: { api: {}, isLoopback: true },
    remote: { $on: () => () => {} },
    sessions: {
      openSubagent() {},
      setSubagentCatalogOpen() {},
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    on() {
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      effectDisposers.push(dispose)
      return dispose
    },
    inject(dependencies, callback) {
      if (dependencies.every((name) => services[name] !== undefined)) callback(ctx)
      return { dispose() {} }
    },
  }
  plugin.apply(ctx)

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
  assert.equal(sidebarDecorationRegistrations, 0)
  const registration = registrations[2]
  const rendered = registration.component()
  assert.equal(rendered.type, 'section')
  assert.equal(rendered.children[0].children[0], 'Subagent Models')
  assert.equal(rendered.children[4].children[0].children[0], 'Models')

  for (const dispose of injectionDisposers.reverse()) dispose()
  for (const dispose of effectDisposers.reverse()) dispose()
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

test('native header chip resolves the configured friendly model name', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        descriptor: {
          value: {
            models: [{
              alias: 'deep',
              provider: 'acme',
              model: 'reasoner',
              displayName: 'Acme Reasoner',
            }],
          },
        },
      }
    },
  })
  const effects = []
  try {
    const { plugin } = await loadClient({ stateValues: [true, new Set()] })
    const services = {
      connection: { api: {}, isLoopback: true },
      remote: { $on: () => () => {} },
      sessions: {},
      slots: {
        inject(_name, callback) {
          return callback()
        },
        register() {
          return () => {}
        },
      },
    }
    const ctx = {
      get(name) {
        return services[name]
      },
      on() {
        return () => {}
      },
      effect(callback) {
        const dispose = callback()
        effects.push(dispose)
        return dispose
      },
      inject() {
        return { dispose() {} }
      },
    }
    plugin.apply(ctx)
    await new Promise((resolve) => setImmediate(resolve))

    const chip = expandFunctionComponents(plugin.SubagentModelChip({
      useSession: (selector) => selector({ subagent: { address: {} } }),
      useProjection: () => ({ provider: 'acme', model: 'reasoner' }),
    }))
    assert.equal(chip.props.title, 'Acme Reasoner (acme/reasoner)')
    assert.equal(chip.props['aria-label'], 'Acme Reasoner (acme/reasoner)')
    assert.equal(chip.children[0].children[0], 'Acme Reasoner')

    const catalog = expandFunctionComponents(plugin.SubagentCatalogAction({
      sessionId: 'parent',
      useSessions: (selector) => selector({
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
            projectionValues: {
              subagentModelRoute: { provider: 'acme', model: 'reasoner' },
            },
          },
        },
      }),
      sessions: {
        openSubagent() {},
        refreshSubagents() {},
        setSubagentCatalogOpen() {},
      },
      t: (key) => key,
    }))
    const row = findNode(catalog, (node) => node.props?.role === 'treeitem')
    assert.match(row.props['aria-label'], /Acme Reasoner \(acme\/reasoner\)/)
  } finally {
    for (const dispose of effects.reverse()) dispose()
    globalThis.fetch = originalFetch
  }
})

test('model identity prefers the configured display name and preserves the full route', async () => {
  const { plugin } = await loadClient()
  assert.deepEqual(plugin.modelIdentity({ provider: 'acme', model: 'reasoner' }, [{
    alias: 'deep',
    provider: 'acme',
    model: 'reasoner',
    displayName: 'Acme Reasoner',
  }]), {
    name: 'Acme Reasoner',
    fullRoute: 'acme/reasoner',
    label: 'Acme Reasoner (acme/reasoner)',
  })
  assert.deepEqual(plugin.modelIdentity({ provider: 'other', model: 'reasoner' }), {
    name: 'reasoner',
    fullRoute: 'other/reasoner',
    label: 'other/reasoner',
  })
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

test('maps Better Sidebar Tasks rows to exact nested catalog children', async () => {
  const { plugin } = await loadClient()
  const routeA = { provider: 'acme', model: 'fast' }
  const routeB = { provider: 'acme', model: 'deep' }
  const routeGrandchild = { provider: 'acme', model: 'reviewer' }
  const snapshot = {
    current: 'grandchild',
    byId: {
      root: { id: 'root', displayTitle: 'Main', origin: 'user' },
      a: { id: 'a', displayTitle: 'Review', origin: 'subagent', parentId: 'root', projectionValues: { subagentModelRoute: routeA } },
      b: { id: 'b', displayTitle: 'Review', origin: 'subagent', parentId: 'root', projectionValues: { subagentModelRoute: routeB } },
      grandchild: { id: 'grandchild', displayTitle: 'Verify', origin: 'subagent', parentId: 'a', projectionValues: { subagentModelRoute: routeGrandchild } },
      side: { id: 'side', displayTitle: 'Side: notes', origin: 'subagent', parentId: 'root' },
    },
    subagentsByParent: {
      root: {
        entries: [
          { kind: 'child', id: 'side', label: 'Side: notes' },
          { kind: 'child', id: 'a', label: 'Review' },
          { kind: 'child', id: 'b', label: 'Review' },
        ],
      },
      a: { entries: [{ kind: 'child', id: 'grandchild', label: 'Verify' }] },
    },
  }
  const elements = [{}, {}, {}, {}]
  const labels = [{}, {}, {}, {}]
  const rows = [
    { element: elements[0], labelElement: labels[0], label: 'Main', level: '0', disabled: false },
    { element: elements[1], labelElement: labels[1], label: 'Review', level: '1', disabled: false },
    { element: elements[2], labelElement: labels[2], label: 'Verify', level: '2', disabled: false },
    { element: elements[3], labelElement: labels[3], label: 'Review', level: '1', disabled: false },
  ]

  const assignments = plugin.betterSidebarTaskRowAssignments(snapshot, rows)
  assert.deepEqual(assignments.map((assignment) => assignment.summary.id), ['a', 'grandchild', 'b'])
  assert.deepEqual(assignments.map((assignment) => assignment.summary.projectionValues.subagentModelRoute), [routeA, routeGrandchild, routeB])
  assert.equal(assignments[0].row, elements[1])
  assert.equal(assignments[0].label, labels[1])
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
  assert.doesNotMatch(source, /connection\.isLoopback/)
})

test('package manifest publishes and injects the client bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.7.0')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-subagent'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
  assert.equal(manifest.dependencies['dsh-better-sidebar'], undefined)
})

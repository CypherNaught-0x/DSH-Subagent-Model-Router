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

test('model editor cards keep stable identity through edits and array changes', async () => {
  const { plugin } = await loadClient()
  const draft = plugin.draftFromValue({ models: [
    { alias: 'fast', provider: 'acme', model: 'reasoner', description: 'quick' },
    { alias: 'deep', provider: 'acme', model: 'deliberate', description: 'careful' },
  ] })
  const firstKey = draft.models[0].rowKey
  const secondKey = draft.models[1].rowKey
  const edited = { ...draft.models[0], alias: 'fast-renamed' }
  assert.equal(edited.rowKey, firstKey)
  const afterRemove = [edited]
  assert.equal(afterRemove[0].rowKey, firstKey)
  const added = [...afterRemove, plugin.emptyModel()]
  assert.equal(added[0].rowKey, firstKey)
  assert.notEqual(added[1].rowKey, firstKey)
  assert.notEqual(added[1].rowKey, secondKey)

  const reset = plugin.draftFromValue({ models: [{ alias: 'fast', provider: 'acme', model: 'reasoner', description: 'quick' }] })
  assert.notEqual(reset.models[0].rowKey, firstKey)
  assert.deepEqual(plugin.settingsFromDraft({ ...draft, models: added }), {
    subagentProvider: 'spawn',
    maxDepth: 3,
    enableRunInBackground: true,
    listingInactivityTurns: 20,
    models: [
      { alias: 'fast-renamed', provider: 'acme', model: 'reasoner', tags: [], description: 'quick' },
      { alias: '', provider: '', model: '', tags: [], description: '' },
    ],
  })
})

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
      refreshProjections: async () => {},
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
    name: 'settings.section',
    id: 'subagent-model-router',
    order: 25,
    label: 'Subagent Models',
  }])
  assert.equal(sidebarDecorationRegistrations, 0)
  assert.equal(registrations.some((entry) => entry.options.id === 'subagent-catalog'), false)
  const registration = registrations[1]
  const rendered = registration.component()
  assert.equal(rendered.type, 'section')
  assert.equal(rendered.children[0].children[0], 'Subagent Models')
  assert.match(JSON.stringify(rendered.children[1]), /- id: dsh-subagent-model-router/)
  assert.match(JSON.stringify(rendered.children[1]), /home patch or --patch overlay/)
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

test('Better Sidebar tab registration is optional, late-loadable, and disposable', async () => {
  const { plugin } = await loadClient()
  const registrations = []
  const services = {
    slots: { inject: (_name, callback) => callback(), register: () => () => {} },
    connection: { api: {}, isLoopback: true },
    remote: { $on: () => () => {} },
    sessions: {},
    betterSidebar: { registerTab(descriptor) { registrations.push(descriptor); return () => registrations.splice(registrations.indexOf(descriptor), 1) } },
  }
  const effects = []
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => { const dispose = fn(); effects.push(dispose); return dispose },
    inject: (_deps, callback) => { callback(ctx); return { dispose() {} } },
  }
  plugin.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-subagent-model-router:subagents')
  assert.equal(registrations[0].single, true)
  assert.equal(registrations[0].order, 31)
  effects.reverse().forEach((dispose) => dispose?.())
  assert.equal(registrations.length, 0)
})

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

    const catalog = expandFunctionComponents(plugin.CatalogRows({
      parentSessionId: 'parent',
      catalog: {
        state: 'ready',
        error: null,
        entries: [{ id: 'child', label: 'Review', mode: 'continuable', activity: 'running', createdAt: 1 }],
      },
      catalogs: {},
      summaries: {
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
      configuredModels: [{ alias: 'deep', provider: 'acme', model: 'reasoner', displayName: 'Acme Reasoner' }],
      expanded: new Set(),
      level: 1,
      now: 0,
      openChild() {},
      refreshProjection() {},
      toggleBranch() {},
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

function projectionSnapshot(extra = {}) {
  return {
    ids: ['parent'],
    phase: 'ready',
    projectionsBySession: {
      parent: {
        state: 'idle',
        error: null,
        values: {
          subagentCatalog: [{ id: 'child', label: 'Review', mode: 'continuable', createdAt: 1 }],
        },
      },
    },
    byId: {
      parent: { id: 'parent', origin: 'user' },
      child: {
        id: 'child',
        origin: 'subagent',
        parentId: 'parent',
        running: true,
        title: 'Review architecture',
        projectionValues: { subagentModelRoute: { provider: 'acme', model: 'reasoner' }, subagentTiming: { settledMs: 65000 } },
      },
    },
    ...extra,
  }
}

function sessionsService(snapshot, calls = []) {
  return {
    list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    refreshProjections(id) {
      calls.push(['refresh', id])
      return Promise.resolve()
    },
  }
}

test('catalog rows render the active model as an accessible chip', async () => {
  const { plugin } = await loadClient({ stateValues: [new Set(), 0] })
  const tree = expandFunctionComponents(plugin.BetterSidebarSubagentTab({
    ctx: { get: (name) => name === 'sessions' ? sessionsService(projectionSnapshot()) : undefined },
    scope: { sessionId: 'parent' },
    visible: true,
  }))

  const chip = findNode(tree, (node) => node.props?.title === 'acme/reasoner')
  assert.ok(chip)
  assert.equal(chip.props['aria-label'], 'acme/reasoner')
  assert.equal(chip.children[0].children[0], 'reasoner')
  const row = findNode(tree, (node) => node.props?.role === 'treeitem')
  assert.match(row.props['aria-label'], /acme\/reasoner/)
  const runningDot = findNode(row, (node) => node.props?.className === 'dsh-smr-catalog-dot-running')
  assert.equal(runningDot.props.role, 'img')
  assert.equal(runningDot.props['aria-label'], 'running')
  const meta = findNode(row, (node) => node.props?.style?.flexDirection === 'column' && node.props?.style?.alignItems === 'flex-end')
  assert.ok(meta)
  assert.equal(meta.children[0].props.title, 'acme/reasoner')
})

test('catalogs derive from DSH 0.1.7 subagentCatalog projections', async () => {
  const { plugin } = await loadClient()
  const catalogs = plugin.catalogsFromSnapshot(projectionSnapshot({
    projectionsBySession: {
      parent: projectionSnapshot().projectionsBySession.parent,
      child: { state: 'idle', error: null, values: {} },
      broken: { state: 'error', error: { message: 'offline' }, values: {} },
    },
  }))
  assert.deepEqual(catalogs.parent, {
    state: 'ready',
    error: null,
    entries: [{ id: 'child', label: 'Review', mode: 'continuable', createdAt: 1, activity: 'running' }],
  })
  assert.equal(catalogs.child.state, 'loading')
  assert.equal(catalogs.broken.state, 'error')
  assert.equal(catalogs.broken.error.message, 'offline')
})

test('Better Sidebar tab renders authoritative nested catalog rows without DOM scraping', async () => {
  const { plugin } = await loadClient()
  const tree = expandFunctionComponents(plugin.BetterSidebarSubagentTab({
    ctx: { get: (name) => name === 'sessions' ? sessionsService(projectionSnapshot()) : undefined },
    scope: { sessionId: 'parent' }, visible: true,
  }))
  const row = findNode(tree, (node) => node.props?.role === 'treeitem')
  assert.match(row.props['aria-label'], /acme\/reasoner/)
  assert.match(row.props['aria-label'], /1:05/)
  assert.doesNotMatch(row.props['aria-label'], /duration\.minutes/)
  assert.equal(findNode(tree, (node) => node.props?.['data-dsh-subagent-model-route'] !== undefined), undefined)
  const motionStyles = findNode(tree, (node) => node.type === 'style')
  assert.match(motionStyles.props.dangerouslySetInnerHTML.__html, /prefers-reduced-motion/)
  assert.match(motionStyles.props.dangerouslySetInnerHTML.__html, /dsh-smr-catalog-dot-running/)
})

test('Better Sidebar tab loads catalogs through refreshProjections and opens children through the workspace', async () => {
  const { plugin, effectCleanups } = await loadClient({ runEffects: true, stateValues: [new Set(), 0] })
  const calls = []
  const opened = []
  const tree = expandFunctionComponents(plugin.BetterSidebarSubagentTab({
    ctx: { get: (name) => name === 'sessions' ? sessionsService(projectionSnapshot(), calls) : undefined },
    scope: { sessionId: 'parent' },
    visible: true,
    openChild: (address) => opened.push(address),
  }))
  assert.deepEqual(calls, [['refresh', 'parent']])

  const disclosure = findNode(tree, (node) => node.props?.['aria-label'] === 'Expand Review')
  disclosure.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(calls, [['refresh', 'parent'], ['refresh', 'child']])

  const row = findNode(tree, (node) => node.props?.role === 'treeitem')
  row.props.onClick()
  assert.deepEqual(opened, [{ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }])
  // A running child starts the one-second duration timer; clear it.
  for (const cleanup of effectCleanups.reverse()) cleanup()
})

test('client uses the plugin endpoint instead of the rc.6 allowlisted settings API', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\/dsh-subagent-model-router\/settings/)
  assert.match(source, /\/model-subagent-setup/)
  assert.doesNotMatch(source, /label: 'Tool name'/)
  assert.doesNotMatch(source, /api\.settings\.describe/)
  assert.doesNotMatch(source, /api\.settings\.update/)
  assert.doesNotMatch(source, /connection\.isLoopback/)
  assert.doesNotMatch(source, /subagentsByParent|setSubagentCatalogOpen|openSubagent|refreshSubagents/)
  assert.doesNotMatch(source, /id: 'subagent-catalog'/)
})

test('settings updates are matched against the entry id reported by the Host route', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return {
      ok: true,
      status: 200,
      async json() {
        return { namespace: 'router-copy', writable: true, descriptor: { value: { models: [] }, revision: 0 } }
      },
    }
  }
  const effects = []
  let onDocumentUpdated
  try {
    const { plugin } = await loadClient()
    const services = {
      connection: {},
      remote: { $on: (_event, listener) => { onDocumentUpdated = listener; return () => {} } },
      sessions: {},
      slots: { inject: (_name, callback) => callback(), register: () => () => {} },
    }
    const ctx = {
      get: (name) => services[name],
      on: () => () => {},
      effect: (callback) => { const dispose = callback(); effects.push(dispose); return dispose },
      inject: () => ({ dispose() {} }),
    }
    plugin.apply(ctx)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests, 1)
    onDocumentUpdated('dsh-subagent-model-router')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests, 1)
    onDocumentUpdated('router-copy')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests, 2)
  } finally {
    for (const dispose of effects.reverse()) dispose()
    globalThis.fetch = originalFetch
  }
})

test('package manifest publishes and injects the client bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.9.0')
  assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/schemastery'], '^3.18.4')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-subagent'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
  assert.equal(manifest.dependencies['dsh-better-sidebar'], undefined)
})

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

function findNodes(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, matches)
    return matches
  }
  if (node === null || typeof node !== 'object') return matches
  if (predicate(node)) matches.push(node)
  return findNodes(node.children, predicate, matches)
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
  const runningDot = findNode(row, (node) => node.props?.className === 'dsh-smr-catalog-dot-running')
  assert.equal(runningDot.props.role, 'status')
  assert.equal(runningDot.props['aria-label'], 'activity.running')
  assert.equal(runningDot.props['aria-live'], 'polite')
  assert.equal(runningDot.props['aria-atomic'], 'true')
  const meta = findNode(row, (node) => node.props?.style?.flexDirection === 'column' && node.props?.style?.alignItems === 'flex-end')
  assert.ok(meta)
  assert.equal(meta.children[0].props.title, 'acme/reasoner')
})

test('Better Sidebar tab renders authoritative nested catalog rows without DOM scraping', async () => {
  const { plugin } = await loadClient()
  const state = {
    current: 'parent',
    subagentsByParent: {
      parent: { state: 'ready', error: null, parentAvailable: true, entries: [{ kind: 'child', id: 'child', label: 'Review', mode: 'continuable', activity: 'running', hasChildren: false }] },
    },
    byId: {
      parent: { id: 'parent', origin: 'user' },
      child: { id: 'child', origin: 'subagent', parentId: 'parent', running: true, projectionValues: { subagentModelRoute: { provider: 'acme', model: 'reasoner' }, subagentTiming: { settledMs: 65000 } } },
    },
  }
  const calls = []
  const tree = expandFunctionComponents(plugin.BetterSidebarSubagentTab({
    ctx: { get: (name) => name === 'sessions' ? { list: { getSnapshot: () => state, subscribe: () => () => {} }, setSubagentCatalogOpen: (...args) => calls.push(args) } : undefined },
    scope: { sessionId: 'parent' }, visible: true,
  }))
  const row = findNode(tree, (node) => node.props?.role === 'treeitem')
  assert.match(row.props['aria-label'], /acme\/reasoner/)
  assert.match(row.props['aria-label'], /1:05/)
  assert.doesNotMatch(row.props['aria-label'], /duration\.minutes/)
  assert.equal(findNode(tree, (node) => node.props?.['data-dsh-subagent-model-route'] !== undefined), undefined)
  const motionStyles = findNode(tree, (node) => node.type === 'style')
  const motionCss = motionStyles.props.dangerouslySetInnerHTML.__html
  assert.match(motionCss, /prefers-reduced-motion/)
  assert.match(motionCss, /dsh-smr-catalog-dot-running/)
  assert.match(motionCss, /dshSmrCatalogOrbit/)
  assert.doesNotMatch(motionCss, /scale\(|box-shadow/)
})

test('catalog treeitems keep each child group below its row', async () => {
  const { plugin } = await loadClient({ stateValues: [true, new Set(['inactive:parent', 'child'])] })
  const state = {
    subagentsByParent: {
      parent: { state: 'ready', error: null, parentAvailable: true, entries: [{ kind: 'child', id: 'child', label: 'Parent child', mode: 'continuable', activity: 'inactive', hasChildren: true }] },
      child: { state: 'ready', error: null, parentAvailable: true, entries: [{ kind: 'child', id: 'grandchild', label: 'Nested child', mode: 'one-shot', activity: 'inactive', hasChildren: false }] },
    },
    byId: {
      child: { id: 'child', origin: 'subagent', parentId: 'parent', running: false, projectionValues: {} },
      grandchild: { id: 'grandchild', origin: 'subagent', parentId: 'child', running: false, projectionValues: {} },
    },
  }
  const tree = expandFunctionComponents(plugin.SubagentCatalogAction({
    sessionId: 'parent',
    useSessions: (selector) => selector(state),
    sessions: { openSubagent() {}, refreshSubagents() {}, setSubagentCatalogOpen() {} },
    t: (key) => key,
  }))
  const items = findNodes(tree, (node) => node.props?.role === 'treeitem')
  assert.equal(items.length, 3)
  const parentItem = items.find((item) => item.props['aria-label']?.startsWith('Parent child'))
  assert.ok(parentItem)
  const row = parentItem.children[0]
  const group = parentItem.children[1]
  assert.equal(row.props.role, undefined)
  assert.equal(group.props.role, 'group')
  assert.equal(row.children.some((child) => child?.props?.role === 'group'), false)
  assert.equal(parentItem.props.style.width, '100%')
  assert.equal(group.props.style.marginLeft, 26)
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

test('catalog ordering prioritizes running, resident, and preserves stable order', async () => {
  const { plugin } = await loadClient()
  const entries = [
    { kind: 'child', id: 'inactive', mode: 'one-shot', activity: 'inactive', hasChildren: false },
    { kind: 'child', id: 'resident', mode: 'continuable', activity: 'running', hasChildren: false },
    { kind: 'child', id: 'running', mode: 'one-shot', activity: 'running', hasChildren: false },
    { kind: 'diagnostic', id: 'diagnostic', reason: 'unavailable' },
  ]
  const ordered = plugin.orderedCatalogEntries(entries, {}, {
    inactive: { id: 'inactive', running: false },
    resident: { id: 'resident', running: false },
    running: { id: 'running', running: true },
  })
  assert.deepEqual(ordered.active.map((entry) => entry.id), ['running', 'resident'])
  assert.deepEqual(ordered.inactive.map((entry) => entry.id), ['inactive'])
  assert.deepEqual(ordered.diagnostics.map((entry) => entry.id), ['diagnostic'])
})

test('inactive continuables group without summaries while active descendants preserve ancestry', async () => {
  const { plugin } = await loadClient()
  const child = (id, extras = {}) => ({ kind: 'child', id, mode: 'continuable', activity: 'inactive', hasChildren: false, ...extras })
  const entries = [child('done'), child('ancestor', { hasChildren: true }), child('unknown', { hasChildren: true }), child('run1'), child('run2')]
  const catalogs = { ancestor: { state: 'ready', entries: [child('nested')] } }
  const summaries = { nested: { running: true }, run1: { running: true }, run2: { running: true } }
  const ordered = plugin.orderedCatalogEntries(entries, catalogs, summaries)
  assert.deepEqual(ordered.active.map((e) => e.id), ['ancestor', 'run1', 'run2', 'unknown'])
  assert.deepEqual(ordered.inactive.map((e) => e.id), ['done'])
  summaries.nested.running = false
  summaries.run1.running = false
  const settled = plugin.orderedCatalogEntries(entries, catalogs, summaries)
  assert.deepEqual(settled.inactive.map((e) => e.id), ['done', 'ancestor', 'run1'])
  assert.equal(new Set([...settled.active, ...settled.inactive].map((e) => e.id)).size, entries.length)
})

test('inactive collection is collapsed by default and opens each inactive child once', async () => {
  for (const open of [false, true]) {
    const { plugin } = await loadClient({ stateValues: [true, new Set(open ? ['inactive:parent'] : [])] })
    const entries = ['done-a', 'done-b'].map((id) => ({ kind: 'child', id, label: id, mode: 'continuable', activity: 'inactive', hasChildren: false }))
    const state = { subagentsByParent: { parent: { state: 'ready', entries } }, byId: {} }
    const tree = expandFunctionComponents(plugin.SubagentCatalogAction({ sessionId: 'parent', useSessions: (select) => select(state), sessions: { setSubagentCatalogOpen() {} }, t: (key) => key }))
    const items = findNodes(tree, (node) => node.props?.role === 'treeitem')
    const collection = items.find((node) => node.props['aria-label'] === 'Inactive (2)')
    assert.ok(collection)
    assert.equal(collection.props['aria-expanded'], open)
    assert.equal(collection.props.onClick, undefined, 'descendant clicks must not toggle the collection')
    assert.equal(items.length, open ? 3 : 1)
    let prevented = false
    collection.props.onKeyDown({ key: 'ArrowRight', target: collection, currentTarget: collection, preventDefault() { prevented = true }, stopPropagation() {} })
    assert.equal(prevented, !open, 'right arrow only expands a closed collection')
  }
})

test('sidebar collection expansion never observes synthetic session ids', async () => {
  const { plugin, effectCleanups } = await loadClient({ runEffects: true, stateValues: [new Set(['inactive:parent']), 0] })
  const calls = []
  const state = { current: 'parent', byId: { parent: { id: 'parent', origin: 'user' } }, subagentsByParent: { parent: { state: 'ready', entries: [] } } }
  const sessions = { list: { getSnapshot: () => state, subscribe: () => () => {} }, setSubagentCatalogOpen(id, open) { calls.push([id, open]) } }
  plugin.BetterSidebarSubagentTab({ ctx: { get: () => sessions }, visible: true, scope: { sessionId: 'parent' } })
  for (const cleanup of effectCleanups.reverse()) cleanup()
  assert.ok(calls.every(([id]) => id === 'parent'))
})

test('package manifest publishes and injects the client bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.8.0')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'), false)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-subagent'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
  assert.equal(manifest.dependencies['dsh-better-sidebar'], undefined)
})

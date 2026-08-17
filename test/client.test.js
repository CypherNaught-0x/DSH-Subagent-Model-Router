import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function loadClient() {
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

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }
  return {
    definition,
    plugin: definition.factory((name) => {
      assert.equal(name, 'react')
      return React
    }),
  }
}

test('client bundle registers a dedicated settings section', async () => {
  const { definition, plugin } = await loadClient()
  assert.equal(definition.id, 'dsh-subagent-dynamic-model')
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'remote'])

  let registration
  const slots = {
    inject(name, callback) {
      assert.equal(name, 'settings.section')
      callback()
      return () => {}
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  }
  const services = {
    slots,
    connection: { api: {}, isLoopback: true },
    remote: { $on: () => () => {} },
  }
  plugin.apply({
    get(name) {
      return services[name]
    },
    on() {
      return () => {}
    },
  })

  assert.deepEqual(registration.options, {
    name: 'settings.section',
    id: 'subagent-dynamic-model',
    order: 25,
    label: 'Subagent Models',
  })
  const rendered = registration.component()
  assert.equal(rendered.type, 'section')
  assert.equal(rendered.children[0].children[0], 'Subagent Models')
})

test('client uses the plugin endpoint instead of the rc.6 allowlisted settings API', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /\/dsh-subagent-dynamic-model\/settings/)
  assert.doesNotMatch(source, /api\.settings\.describe/)
  assert.doesNotMatch(source, /api\.settings\.update/)
})

test('package manifest publishes and injects the client bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.version, '0.3.2')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
})

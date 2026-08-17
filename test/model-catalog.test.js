import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeConfiguredModels,
  renderCatalogResult,
  renderConfiguredModels,
} from '../lib/model-catalog.js'

test('normalizes configured routes and removes duplicate tags', () => {
  const models = normalizeConfiguredModels([
    {
      alias: ' fast ',
      provider: 'acme',
      model: 'acme-fast',
      displayName: 'Acme Fast',
      tags: ['fast', 'routine', 'fast'],
      description: ' Use for quick tasks. ',
      maxTokens: 4096,
    },
  ])

  assert.deepEqual(models, [{
    alias: 'fast',
    provider: 'acme',
    model: 'acme-fast',
    displayName: 'Acme Fast',
    tags: ['fast', 'routine'],
    description: 'Use for quick tasks.',
    maxTokens: 4096,
  }])
})

test('rejects duplicate aliases and malformed tags', () => {
  assert.throws(() => normalizeConfiguredModels([
    { alias: 'one', provider: 'a', model: 'm1', description: 'first' },
    { alias: 'one', provider: 'a', model: 'm2', description: 'second' },
  ]), /duplicate model alias/)

  assert.throws(() => normalizeConfiguredModels([
    { alias: 'one', provider: 'a', model: 'm1', description: 'first', tags: ['Not Valid'] },
  ]), /lowercase kebab-case/)
})

test('renders model tags, route, and usage description', () => {
  const [model] = normalizeConfiguredModels([
    {
      alias: 'deep',
      provider: 'acme',
      model: 'reasoner',
      displayName: 'Acme Reasoner',
      tags: ['reasoning', 'review'],
      description: 'Use for difficult analysis.',
    },
  ])

  assert.equal(
    renderConfiguredModels([model]),
    '- deep: Acme Reasoner (acme/reasoner) [tags: reasoning, review] — Use for difficult analysis.',
  )
})

test('renders live catalog errors without losing other providers', () => {
  const text = renderCatalogResult({
    current: { provider: 'acme', model: 'current' },
    providers: [
      {
        id: 'acme',
        name: 'Acme',
        models: [{ id: 'fast', name: 'Fast', description: 'Quick model' }],
      },
      {
        id: 'offline',
        name: 'Offline',
        models: [],
        error: 'not connected',
      },
    ],
  })

  assert.match(text, /Current agent route: acme\/current/)
  assert.match(text, /Fast \(fast\) — Quick model/)
  assert.match(text, /Catalog unavailable: not connected/)
})

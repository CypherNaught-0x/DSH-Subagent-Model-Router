import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

test('DSH peers retain older compatibility and explicitly list the supported 0.2 releases', () => {
  for (const name of ['@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-tools']) {
    assert.deepEqual(manifest.peerDependencies[name].split(' || '), [
      '^0.1.0-rc.6',
      '0.2.0-rc.1',
      '0.2.0-rc.2',
      '0.2.1',
      '0.2.1-rc.1',
      '0.2.1-rc.2',
    ])
  }
})

test('Better Sidebar remains an optional peer', () => {
  assert.equal(manifest.peerDependencies['dsh-better-sidebar'], '>=0.16.0')
  assert.equal(manifest.peerDependenciesMeta['dsh-better-sidebar'].optional, true)
})

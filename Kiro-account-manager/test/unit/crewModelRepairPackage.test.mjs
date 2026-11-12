import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCrewModelRepairPackage } from '../../scripts/lib/crewModelRepairPackage.mjs'

const app = fileURLToPath(new URL('../..', import.meta.url))
function fixture() {
  const prefix = 'resources/crew-model-repair', entries = [], files = new Map()
  function scan(relative) {
    entries.push(relative)
    for (const item of readdirSync(resolve(app, relative), { withFileTypes: true })) {
      const path = `${relative}/${item.name}`
      if (item.isDirectory()) scan(path)
      else { entries.push(path); files.set(path, readFileSync(resolve(app, path))) }
    }
  }
  scan(prefix)
  const helper = 'resources/client-switch/crew-access.py'
  entries.push(helper); files.set(helper, readFileSync(join(app, helper)))
  const read = entry => { assert.ok(files.has(entry), `Missing ${entry}`); return files.get(entry) }
  return { entries, files, args: { entries, readPackaged: read, readUnpacked: read, readSource: read } }
}

test('native Crew repair package includes exact pinned source and preserves unpacked native switching', () => {
  const f = fixture()
  const result = verifyCrewModelRepairPackage(f.args)
  assert.deepEqual(result.contracts, ['0.12.2', '0.12.0'])
  assert.equal(result.nativeAccessHelper, true)
  assert.ok(result.resources >= 19)
})

test('corrupted, missing or undeclared repair resources cannot pass package verification', () => {
  for (const change of ['corrupt', 'missing', 'extra']) {
    const f = fixture(), path = 'resources/crew-model-repair/0.12.2/agent_sdk/kas_model_catalog.py'
    if (change === 'corrupt') f.files.set(path, Buffer.from('wrong bytes'))
    if (change === 'missing') f.args.entries = f.entries.filter(entry => entry !== path)
    if (change === 'extra') f.args.entries = [...f.entries, 'resources/crew-model-repair/__pycache__/unexpected.pyc']
    assert.throws(() => verifyCrewModelRepairPackage(f.args))
  }
})

test('native Crew helper and repair files must have identical unpacked bytes', () => {
  for (const broken of ['resources/client-switch/crew-access.py', 'resources/crew-model-repair/manifest.json']) {
    const f = fixture()
    f.args.readUnpacked = name => name === broken ? Buffer.from('stale') : f.files.get(name)
    assert.throws(() => verifyCrewModelRepairPackage(f.args), /unpacked/)
  }
})

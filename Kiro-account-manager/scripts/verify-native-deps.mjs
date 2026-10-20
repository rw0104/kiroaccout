// Native dependencies ship Node-API prebuilds. Do not force a V8-ABI rebuild for Electron.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
if (process.platform === 'win32' && process.arch === 'x64') {
  const cbor = require('@cbor-extract/cbor-extract-win32-x64/node.napi.node')
  assert.equal(typeof cbor.extractStrings, 'function', 'Windows CBOR Node-API prebuild is required')
} else {
  assert.equal(typeof require('cbor-extract').extractStrings, 'function', 'CBOR native dependency is required')
}
const koffi = require('koffi')
assert.equal(koffi.sizeof('int'), 4, 'Koffi Node-API prebuild must load')
const cbor = require('cbor-x')
const fixture = { format: 'synthetic', values: [1, 2, 3] }
assert.deepEqual(cbor.decode(cbor.encode(fixture)), fixture, 'CBOR encoding must round-trip')
// Loading Electron's JS entry requires its optional development-runtime download.
// The packager downloads its own runtime and verifies it separately; check package metadata here.
assert.ok(existsSync(require.resolve('electron/package.json')), 'Electron package must be installed')
console.log(`Native Node-API dependencies and Electron package verified (${process.platform}-${process.arch}); application not executed`)

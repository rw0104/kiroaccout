import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { verifyMacSignature } from '../../scripts/lib/macSigning.mjs'

const require = createRequire(import.meta.url)
const builder = require('js-yaml').load(readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8'))
const appPath = resolve('synthetic-package', 'Kiro Account Manager.app')
const adhoc = 'CodeDirectory v=20500 size=512 flags=0x10002(adhoc,runtime) hashes=4+5 location=embedded\nSignature=adhoc\n'
const developer = 'CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=4+5 location=embedded\nSignature size=9000\nAuthority=Developer ID Application: Synthetic Publisher (SYNTHETIC)\n'

function runnerFor(details, stream = 'stderr') {
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: '', stderr: '', ...(args.includes('--display') ? { [stream]: details } : {}) }
  }
  return { runner, calls }
}

test('verifies the whole bundle before classifying ad-hoc signatures without claiming notarization', () => {
  const { runner, calls } = runnerFor(adhoc)
  assert.deepEqual(verifyMacSignature(appPath, runner), {
    verified: true, type: 'ad-hoc', hardenedRuntime: true, notarizationVerified: false
  })
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', appPath] },
    { command: '/usr/bin/codesign', args: ['--display', '--verbose=4', appPath] }
  ])
  assert.ok(calls.every(({ options }) => options.encoding === 'utf8' && options.timeout === 60000 && !options.shell))
})

test('classifies Developer ID independently of notarization and supports stdout runner output', () => {
  const { runner } = runnerFor(developer, 'stdout')
  assert.deepEqual(verifyMacSignature(appPath, runner), {
    verified: true, type: 'developer-id', hardenedRuntime: true, notarizationVerified: false
  })
})

test('accepts other valid signatures and reports when hardened runtime is absent', () => {
  const { runner } = runnerFor(developer.replace('0x10000(runtime)', '0x0(none)').replace('Developer ID Application:', 'Apple Development:'))
  assert.deepEqual(verifyMacSignature(appPath, runner), {
    verified: true, type: 'other', hardenedRuntime: false, notarizationVerified: false
  })
})

test('blocks release verification immediately when the bundle signature is invalid', () => {
  let calls = 0
  assert.throws(() => verifyMacSignature(appPath, () => {
    calls++
    return { status: 1, stdout: '', stderr: 'a sealed resource is missing or invalid' }
  }), /code-signature verification failed/)
  assert.equal(calls, 1)
})

test('fails closed when codesign is unavailable, times out, or cannot display the signature', () => {
  for (const result of [undefined, { status: null, error: new Error('ENOENT') }, { status: null, signal: 'SIGTERM' }]) {
    assert.throws(() => verifyMacSignature(appPath, () => result), /code-signature verification failed/)
  }
  assert.throws(() => verifyMacSignature(appPath, (_command, args) => ({
    status: args.includes('--display') ? 1 : 0,
    stdout: '', stderr: ''
  })), /code-signature verification failed/)
})

test('rejects missing signature metadata even after a successful runner exit', () => {
  assert.throws(() => verifyMacSignature(appPath, runnerFor('').runner), /signature details are missing/)
  assert.throws(() => verifyMacSignature(appPath, runnerFor('Signature=adhoc\n').runner), /signature flags are missing/)
})

test('rejects relative paths before invoking codesign', () => {
  assert.throws(() => verifyMacSignature('Kiro Account Manager.app', () => {
    assert.fail('codesign must not run for a relative path')
  }), /absolute app path/)
})

test('macOS release signing gives the app and helpers the entitlements required for ad-hoc hardened runtime', () => {
  assert.equal(builder.mac.identity, '-')
  assert.equal(builder.mac.hardenedRuntime, true)
  assert.equal(typeof builder.mac.entitlements, 'string')
  assert.equal(builder.mac.entitlementsInherit, builder.mac.entitlements)
  const entitlements = require('plist').parse(readFileSync(new URL(`../../${builder.mac.entitlements}`, import.meta.url), 'utf8'))
  assert.equal(entitlements['com.apple.security.cs.allow-jit'], true)
  assert.equal(entitlements['com.apple.security.cs.disable-library-validation'], true)
})

test('release notices stay in macOS Resources rather than reserved bundle code locations', () => {
  const licenses = [
    { from: '../LICENSE', to: 'LICENSE.kiroaccout.txt' },
    { from: '../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }
  ]
  assert.equal(builder.extraFiles, undefined, 'Global extraFiles would place notices directly in macOS Contents')
  assert.equal(builder.mac.extraFiles, undefined)
  assert.deepEqual(builder.mac.extraResources, licenses)
  assert.deepEqual(builder.win.extraFiles, licenses)
  assert.deepEqual(builder.linux.extraFiles, licenses)
})

test('the signing exclusion preserves only the top-level TLS dylib provenance bytes', () => {
  assert.ok(Array.isArray(builder.mac.signIgnore) && builder.mac.signIgnore.length > 0)
  const patterns = builder.mac.signIgnore.map(pattern => new RegExp(pattern))
  const ignored = filename => patterns.some(pattern => pattern.test(filename))
  const contents = '/synthetic-package/Kiro Account Manager.app/Contents'
  for (const arch of ['arm64', 'amd64']) {
    assert.equal(ignored(`${contents}/Resources/tls-client-xgo-1.15.1-darwin-${arch}.dylib`), true)
  }
  for (const file of [
    'Resources/tls-library.json',
    'Resources/koffi.node',
    'Resources/tls-client-xgo.node',
    'Resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
    'Resources/app.asar.unpacked/node_modules/@cbor-extract/cbor-extract-darwin-arm64/node.napi.node',
    'Resources/other.dylib',
    'Resources/nested/tls-client-xgo-1.15.1-darwin-arm64.dylib',
    'Resources/tls-client-xgo-1.15.1-darwin-arm64.dylib.backup',
    'Frameworks/tls-client-xgo-1.15.1-darwin-arm64.dylib',
    'MacOS/Kiro Account Manager'
  ]) {
    assert.equal(ignored(`${contents}/${file}`), false, `Signing must not skip ${file}`)
  }
})

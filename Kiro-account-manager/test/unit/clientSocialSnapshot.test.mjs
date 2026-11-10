import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { resolveIdentity } from '../../src/shared/authIdentity.ts'
import { cliAccessPayload } from '../../src/main/cliAccessAdapter.ts'
import { projectableClientAccess } from '../../src/main/clientAccessProjection.ts'
import { ClientSwitchService } from '../../src/main/clientSwitch.ts'
import { createCrewAccessAdapter } from '../../src/main/crewAccessAdapter.ts'

const ts = createRequire(import.meta.url)('typescript')
const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
const getter = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getClientProjectionAccess')
assert.ok(getter)
function snapshot(top, nested, authMethod = 'social') {
  const account = { id: 'synthetic', userId: 'SYNTHETIC_SUBJECT', idp: 'Google', status: 'active', profileArn: top,
    credentials: { accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresAt: Date.now() + 3600000,
      provider: 'Google', authMethod, profileArn: nested, region: 'us-east-1' } }
  const saved = JSON.parse(JSON.stringify({ accounts: { synthetic: account } }))
  const context = vm.createContext({ store: { get: () => saved }, resolveIdentity, instanceAccountOwnership: { assertAvailable() {} } })
  vm.runInContext(ts.transpileModule(getter.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context.getClientProjectionAccess('synthetic')
}
test('actual snapshot falls back across missing empty whitespace profiles after storage reload and projects the saved profile', () => {
  for (const nested of [undefined, null, '', '   ', 'SYNTHETIC_PROFILE']) {
    const value = snapshot('SYNTHETIC_PROFILE', nested)
    assert.equal(value.profileArn, 'SYNTHETIC_PROFILE')
    const payload = JSON.parse(cliAccessPayload(projectableClientAccess(value)).value)
    assert.equal(payload.profile_arn, 'SYNTHETIC_PROFILE')
    assert.equal(payload.refresh_token, undefined)
  }
})
test('actual snapshot treats whitespace as missing and normalizes matching profile text', () => {
  for (const [top, nested] of [[' ', 'SYNTHETIC_PROFILE'], ['SYNTHETIC_PROFILE', ' SYNTHETIC_PROFILE '], [' SYNTHETIC_PROFILE ', undefined]]) {
    assert.equal(snapshot(top, nested)?.profileArn, 'SYNTHETIC_PROFILE')
  }
})
test('actual snapshot refuses conflicting profiles and explicit conflicting auth method', () => {
  for (const value of [snapshot('SYNTHETIC_PROFILE', 'SYNTHETIC_OTHER'), snapshot('SYNTHETIC_PROFILE', undefined, 'IdC')]) {
    if (value) assert.throws(() => projectableClientAccess(value))
  }
})
test('actual snapshot never fabricates a default Social profile', () => {
  assert.equal(snapshot(undefined, undefined).profileArn, undefined)
})

test('non-string saved profile metadata is rejected instead of masked by a valid fallback', () => {
  for (const invalid of [42, false, {}, []]) {
    for (const value of [snapshot(invalid, 'SYNTHETIC_PROFILE'), snapshot('SYNTHETIC_PROFILE', invalid)]) {
      assert.throws(() => projectableClientAccess(value))
    }
  }
})

test('actual snapshot plus client inspect and execute blocks conflicts without target reads or writes', async () => {
  const calls = []
  const crew = createCrewAccessAdapter({ pythonExecutable: resolve('synthetic-python.exe'), helperPath: resolve('synthetic-helper.py'),
    dataHome: resolve('synthetic-crew-not-created'), authDomainId: 'synthetic-domain' },
    { run: () => { calls.push('helper'); throw Error('unexpected helper') } })
  let account
  const service = new ClientSwitchService({ account: () => account, runtime: async target => ({
    id: target, target, revision: 'synthetic-version', version: 'synthetic', isRunning: async () => false,
    adapter: { authDomainId: 'synthetic-domain', validate: target === 'cli' ? cliAccessPayload : crew.validate,
      readRevision: async () => { calls.push('read'); throw Error('unexpected target read') },
      write: async () => { calls.push('write'); throw Error('unexpected write') } }
  }), projection: { execute: async () => { calls.push('projection'); throw Error('unexpected projection') } },
    bindings: () => [], beginOperation: () => () => {}, platformSupported: () => true })
  account = snapshot('SYNTHETIC_PROFILE', '')
  assert.ok((await service.inspect('synthetic')).targets.every(target => target.status === 'ready'))
  for (const value of [snapshot('SYNTHETIC_PROFILE', 'SYNTHETIC_OTHER'), snapshot(undefined, undefined), snapshot('SYNTHETIC_PROFILE', undefined, 'IdC')]) {
    account = value
    assert.ok((await service.inspect('synthetic')).targets.every(target => target.status === 'blocked'))
    const result = await service.execute({ operationId: 'synthetic-operation', accountId: 'synthetic', target: 'cli' })
    assert.equal(result.credentialWrite, 'not-started')
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_(?:PROFILE|OTHER|ACCESS|REFRESH|SUBJECT)/)
  }
  assert.deepEqual(calls, [])
})

/**
 * Offline reproduction of the unmodified OIDC batch import path.
 *
 * Run from any directory with Node >= 22.13:
 *   node docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs
 *   node docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --ref v1.7.5
 *   node docs/2026-10-19-account-import-login/evidence/oidc-batch-repro.mjs --samples ./samples
 *
 * The default uses invented tokens only. --samples <directory> reads JSON files
 * from that explicit directory, prints anonymized structure/counts only, and never executes their
 * credentials. No Electron, browser, fetch, or account-service call is used.
 * Success returned by verifyAccountCredentials is an OFFLINE STUB acceptance;
 * it does not establish that any token is valid or any real login can succeed.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const refIndex = args.indexOf('--ref')
const ref = refIndex < 0 ? null : args[refIndex + 1]
if (refIndex >= 0 && (!ref || ref.startsWith('-'))) throw new Error('--ref needs a git ref')
const appPath = 'Kiro-account-manager/'
const dialogPath = appPath + 'src/renderer/src/components/accounts/AddAccountDialog.tsx'
const mainPath = appPath + 'src/main/index.ts'
const utilsPath = appPath + 'src/renderer/src/lib/utils.ts'
const readSource = (path) => ref
  ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: repoRoot, encoding: 'utf8' })
  : readFileSync(resolve(repoRoot, path), 'utf8')
const dialog = readSource(dialogPath)
const main = readSource(mainPath)
const utils = readSource(utilsPath)
const hash = (value) => createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex')
const sliceBetween = (source, start, end) => {
  const from = source.indexOf(start)
  assert(from >= 0, `Baseline marker missing: ${start}`)
  const until = source.indexOf(end, from + start.length)
  assert(until >= 0, `Baseline marker missing: ${end}`)
  return source.slice(from, until)
}
const lineOf = (source, marker) => source.slice(0, source.indexOf(marker)).split('\n').length
const handler = sliceBetween(dialog,
  '  const handleOidcBatchAdd = async () => {',
  '  // OIDC 凭证添加账号（验证并添加）')
const splitFunction = utils.slice(utils.indexOf('export function splitCredentialLine(')).replace('export ', '')
const routeFunction = sliceBetween(main,
  'async function refreshTokenByMethod(', 'function generateInvocationId(')
const ipcBlock = sliceBetween(main,
  "  ipcMain.handle('verify-account-credentials',", '      // Step 1:')
const validation = ipcBlock.slice(ipcBlock.indexOf('      const { refreshToken,'))
const previewStart = dialog.indexOf('                      const val = oidcBatchData.trim()')
assert(previewStart >= 0, 'Preview baseline marker missing')
const preview = dialog.slice(previewStart, dialog.indexOf('                    })()}', previewStart))
const previewJson = sliceBetween(preview, '                        const parsed = JSON.parse(val)',
  '                        return <p')
const previewKami = sliceBetween(preview, '                        const kamiLines =',
  '                          return <p')
const buttonStart = dialog.indexOf('                        const parsed = JSON.parse(oidcBatchData.trim())')
assert(buttonStart >= 0, 'Button baseline marker missing')
const buttonJson = sliceBetween(dialog.slice(buttonStart),
  '                        const parsed = JSON.parse(oidcBatchData.trim())',
  '                        return isEn ?')

// Fail loudly if relevant baseline behavior has changed. Do not silently claim
// this experiment reproduces a later parser/normalizer implementation.
for (const marker of [
  'credentials = Array.isArray(parsed) ? parsed : [parsed]',
  "const credProvider = cred.provider || 'BuilderId'",
  "const credAuthMethod = cred.authMethod || ((credProvider === 'BuilderId' || credProvider === 'Enterprise') ? 'IdC' : 'social')",
  'if (!cred.refreshToken)',
  'setOidcBatchImportResult(importResult)',
]) assert(handler.includes(marker), `OIDC handler differs from the analyzed baseline: ${marker}`)
assert(validation.includes("authMethod !== 'social' && (!clientId || !clientSecret)"))
assert(routeFunction.includes("if (authMethod === 'social')"))
const expectedHashes = {
  handler: '75ac1ebc8c8200de7b250888400ae1e24ebc0d73dcce075212462fd167dc9f77',
  ipcGuard: '97f99c9b8476557dba3ba010d113b34bb237ec59f5e1ccad302760aef21dcc71',
  refreshRoute: '97db1e00382614af55b8d3a3cded7756ac2e55a7c9c4d70beeb8abb44991122f',
}
for (const [key, value] of Object.entries({ handler, ipcGuard: validation, refreshRoute: routeFunction })) {
  assert.equal(hash(value), expectedHashes[key], `Analyzed ${key} source changed; review and update the baseline before rerunning`)
}

const transpile = (source) => stripTypeScriptTypes(source, { mode: 'strip' })
const viewCount = vm.runInNewContext(`(oidcBatchData) => {
  const val = oidcBatchData.trim()
  try { ${previewJson}; return { kind: 'JSON', count } }
  catch { ${previewKami}; return { kind: 'Card Key', count: kamiLines.length } }
    return { kind: 'invalid', count: null }
  }
}`)
const buttonCount = vm.runInNewContext(`(oidcBatchData) => {
  try { ${buttonJson}; return count } catch { return null }
}`)
const preflight = vm.runInNewContext(transpile(`(credentials) => {
  ${validation}
  return { success: true, idp }
}`))
const routeContext = vm.createContext({
  refreshSocialToken: () => ({ route: 'social' }),
  refreshOidcToken: () => ({ route: 'oidc' }),
})
vm.runInContext(transpile(routeFunction), routeContext)

const oidc = { refreshToken: 'FAKE_REFRESH', clientId: 'FAKE_CLIENT', clientSecret: 'FAKE_SECRET', provider: 'BuilderId' }
const social = { refreshToken: 'FAKE_SOCIAL', provider: 'Google', authMethod: 'social' }
const cases = [
  ['flat-oidc-object', JSON.stringify(oidc)],
  ['flat-oidc-array-2', JSON.stringify([oidc, { ...oidc, refreshToken: 'FAKE_SECOND' }])],
  ['flat-social-array-2', JSON.stringify([social, { ...social, provider: 'Github' }])],
  ['builder-space-id-alias', JSON.stringify({ ...oidc, provider: 'Builder ID' })],
  ['builder-space-id-explicit-idc', JSON.stringify({ ...oidc, provider: 'Builder ID', authMethod: 'IdC' })],
  ['github-display-capitalization', JSON.stringify({ ...social, provider: 'GitHub' })],
  ['google-lowercase', JSON.stringify({ ...social, provider: 'google' })],
  ['social-capitalized-method', JSON.stringify({ ...social, authMethod: 'Social' })],
  ['social-method-without-provider', JSON.stringify({ refreshToken: 'FAKE_SOCIAL', authMethod: 'social' })],
  ['idp-alias-without-provider', JSON.stringify({ refreshToken: 'FAKE_SOCIAL', idp: 'Google' })],
  ['wrapper-accounts-array-2', JSON.stringify({ version: '1.0', accounts: [oidc, oidc] })],
  ['wrapper-accounts-record-2', JSON.stringify({ accounts: { fake_a: oidc, fake_b: oidc } })],
  ['wrapper-data-array-2', JSON.stringify({ data: [oidc, oidc] })],
  ['nested-credentials-object', JSON.stringify({ email: 'fake@example.invalid', credentials: oidc })],
  ['nested-credentials-array-2', JSON.stringify([{ credentials: oidc }, { credentials: oidc }])],
  ['snake-case-fields', JSON.stringify({ refresh_token: 'FAKE_REFRESH', client_id: 'FAKE_CLIENT', client_secret: 'FAKE_SECRET' })],
  ['pascal-case-fields', JSON.stringify({ RefreshToken: 'FAKE_REFRESH', ClientId: 'FAKE_CLIENT', ClientSecret: 'FAKE_SECRET' })],
  ['missing-idc-client-fields', JSON.stringify({ refreshToken: 'FAKE_REFRESH' })],
  ['wrong-token-object-type', JSON.stringify({ ...oidc, refreshToken: { invalid: true } })],
  ['whitespace-token', JSON.stringify({ ...oidc, refreshToken: '   ' })],
  ['json-null', 'null'],
  ['json-string', '"FAKE_REFRESH"'],
  ['json-empty-array', '[]'],
  ['mixed-valid-null-array', JSON.stringify([oidc, null, social])],
  ['all-existing-account', JSON.stringify(oidc)],
  ['json-markdown-fence', '```json\n' + JSON.stringify([oidc], null, 2) + '\n```'],
  ['json-lines', JSON.stringify(oidc) + '\n' + JSON.stringify(social)],
  ['malformed-trailing-comma', '[\n  {"refreshToken":"FAKE_REFRESH",}\n]'],
  ['card-key-oidc', 'fake@example.invalid----FAKE_PASSWORD----FAKE_REFRESH----FAKE_CLIENT----FAKE_SECRET'],
]

async function executeCase([name, text]) {
  const state = { errors: [], calls: [], added: [], result: null, closed: false }
  const context = vm.createContext({
    oidcBatchData: text, isEn: false, batchImportConcurrency: 100,
    selectedGroupId: 'FAKE_GROUP',
    setError: (error) => { if (error) state.errors.push(error) },
    setIsSubmitting: () => {}, setOidcBatchData: () => {},
    setOidcBatchImportResult: (result) => { if (result) state.result = { ...result } },
    addAccount: (account) => state.added.push({ idp: account.idp, provider: account.credentials.provider, authMethod: account.credentials.authMethod }),
    isAccountExists: () => name === 'all-existing-account', resetForm: () => {},
    onClose: () => { state.closed = true },
    setTimeout: (callback) => callback(),
    window: { api: { verifyAccountCredentials: async (credentials) => {
      const guarded = preflight(credentials)
      const route = guarded.success
        ? await routeContext.refreshTokenByMethod(credentials.refreshToken, credentials.clientId, credentials.clientSecret, credentials.region, credentials.authMethod)
        : { route: 'rejected-before-network' }
      state.calls.push({
        route: route.route, idp: guarded.idp ?? null,
        provider: credentials.provider, authMethod: credentials.authMethod,
        tokenType: typeof credentials.refreshToken,
        tokenNonblankString: typeof credentials.refreshToken === 'string' && Boolean(credentials.refreshToken.trim()),
        clientIdPresent: Boolean(credentials.clientId), clientSecretPresent: Boolean(credentials.clientSecret),
      })
      if (!guarded.success) return guarded
      // Never inspect or transmit the token. Invented account data only.
      return { success: true, data: {
        email: 'offline@example.invalid', userId: 'FAKE_USER',
        accessToken: 'FAKE_ACCESS', refreshToken: 'FAKE_REFRESH_RETURNED', expiresIn: 3600,
        subscriptionType: 'Free', subscriptionTitle: 'Free', usage: { current: 0, limit: 1 },
      } }
    } } },
  })
  vm.runInContext(transpile(splitFunction), context)
  await vm.runInContext(transpile(handler) + '\nhandleOidcBatchAdd()', context, { timeout: 5000 })
  return {
    name, preview: viewCount(text), buttonJsonCount: buttonCount(text),
    submittedTotal: state.result?.total ?? 0,
    offlineStubAccepted: state.result?.success ?? 0,
    failed: state.result?.failed ?? 0,
    errors: [...(state.result?.errors ?? []), ...state.errors],
    calls: state.calls, addedMetadata: state.added, closed: state.closed,
  }
}

const results = []
for (const item of cases) results.push(await executeCase(item))
const byName = Object.fromEntries(results.map((item) => [item.name, item]))
assert.equal(byName['flat-oidc-array-2'].offlineStubAccepted, 2)
assert.equal(byName['flat-social-array-2'].offlineStubAccepted, 2)
assert.equal(byName['builder-space-id-alias'].calls[0].route, 'social')
assert.equal(byName['builder-space-id-alias'].calls[0].idp, 'BuilderId')
assert.equal(byName['builder-space-id-explicit-idc'].calls[0].route, 'oidc')
assert.equal(byName['github-display-capitalization'].calls[0].idp, 'BuilderId')
assert.equal(byName['wrapper-accounts-array-2'].preview.count, 1)
assert.equal(byName['wrapper-accounts-array-2'].failed, 1)
assert.equal(byName['nested-credentials-array-2'].failed, 2)
assert.equal(byName['snake-case-fields'].failed, 1)
assert.equal(byName['wrong-token-object-type'].calls[0].tokenType, 'object')
assert.equal(byName['whitespace-token'].calls[0].tokenNonblankString, false)
assert.equal(byName['mixed-valid-null-array'].offlineStubAccepted, 2)
assert.equal(byName['mixed-valid-null-array'].failed, 1)
assert.equal(byName['all-existing-account'].submittedTotal, 1)
assert.equal(byName['all-existing-account'].offlineStubAccepted, 0)
assert.equal(byName['all-existing-account'].failed, 0)
assert.equal(byName['all-existing-account'].closed, true)

const output = {
  safety: 'Synthetic data; extracted production handler/IPC guards/route; network replaced by offline stubs. Stub acceptance does not validate real tokens.',
  baseline: {
    ref: ref ?? 'working-tree',
    commit: execFileSync('git', ['rev-parse', ref ?? 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    sourceChecksumsSha256: { handler: hash(handler), ipcGuard: hash(validation), refreshRoute: hash(routeFunction) },
    sourceLines: {
      handler: lineOf(dialog, '  const handleOidcBatchAdd = async () => {'),
      parse: lineOf(dialog, '      credentials = Array.isArray(parsed) ? parsed : [parsed]'),
      providerInference: lineOf(dialog, "        const credProvider = cred.provider || 'BuilderId'"),
      ipc: lineOf(main, "  ipcMain.handle('verify-account-credentials',"),
      refreshRoute: lineOf(main, 'async function refreshTokenByMethod('),
    },
  },
  caseCount: results.length,
  results,
}

if (args.includes('--samples')) {
  const allowedKeys = new Set(['accounts', 'data', 'items', 'version', 'exportedAt', 'email', 'id', 'userId', 'password', 'credentials', 'refreshToken', 'clientId', 'clientSecret', 'accessToken', 'authMethod', 'provider', 'region', 'expiresAt', 'profileArn', 'clientIdHash', 'groupId', 'machineId', 'startUrl', 'status'])
  const shapeKeys = (item) => Object.keys(item ?? {}).filter((key) => allowedKeys.has(key)).sort()
  const sampleDirectory = args[args.indexOf('--samples') + 1]
  assert.ok(sampleDirectory && !sampleDirectory.startsWith('--'), '--samples requires an explicit directory')
  output.sampleStructureCounts = readdirSync(sampleDirectory).filter(filename => filename.toLowerCase().endsWith('.json')).sort().map((filename, index) => {
    const parsed = JSON.parse(readFileSync(resolve(sampleDirectory, filename), 'utf8').replace(/^\uFEFF/, ''))
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return {
      sample: `sample-${index + 1}.json`, rootKind: Array.isArray(parsed) ? 'array' : typeof parsed, rowCount: rows.length,
      rowFieldShapes: [...new Set(rows.map((row) => JSON.stringify(shapeKeys(row))))].map((shape) => JSON.parse(shape)),
      nonemptyRefreshTokenStrings: rows.filter((row) => typeof row?.refreshToken === 'string' && row.refreshToken.trim()).length,
      nestedCredentialsCount: rows.filter((row) => row?.credentials && typeof row.credentials === 'object').length,
      rowsWithBothClientFields: rows.filter((row) => row?.clientId && row?.clientSecret).length,
      canonicalGithubCount: rows.filter((row) => row?.provider === 'Github').length,
      canonicalGoogleCount: rows.filter((row) => row?.provider === 'Google').length,
      canonicalBuilderIdCount: rows.filter((row) => row?.provider === 'BuilderId').length,
      builderSpaceIdAliasCount: rows.filter((row) => row?.provider === 'Builder ID').length,
      explicitSocialMethodCount: rows.filter((row) => row?.authMethod === 'social').length,
      explicitIdcMethodCount: rows.filter((row) => row?.authMethod === 'IdC').length,
      inferredSocialMethodCount: rows.filter((row) => (row?.authMethod || ((row?.provider === 'BuilderId' || row?.provider === 'Enterprise' || !row?.provider) ? 'IdC' : 'social')) === 'social').length,
    }
  })
}
console.log(JSON.stringify(output, null, 2))

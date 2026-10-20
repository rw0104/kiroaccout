/**
 * Offline diagnosis of the current JSON file import paths, using extracted source.
 * Run from any directory with Node.js 22.13+ (node:module.stripTypeScriptTypes):
 *   node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs
 * Optional local samples (read only, output contains structures/counts only):
 *   node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --samples ./samples
 * Audit the same source functions at a Git tag/commit without checkout:
 *   node --disable-warning=ExperimentalWarning docs/2026-10-19-account-import-login/evidence/json-import-repro.mjs --source-ref v1.7.5
 *
 * This is a baseline reproducer, not an implementation of the proposed fixes.
 * It asserts observed defects so that evidence is reproducible on the audited commit.
 * It never contacts an API, launches Electron, writes account data, or logs tokens.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const applicationRoot = join(repositoryRoot, 'Kiro-account-manager')
const sourceChecks = []
const refOption = process.argv.indexOf('--source-ref')
const sourceRef = refOption >= 0 ? process.argv[refOption + 1] : null
assert.ok(refOption < 0 || (sourceRef && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sourceRef)), 'Invalid --source-ref')

function extract(relativePath, startMarker, endMarker, includeEnd = false) {
  const source = (sourceRef
    ? execFileSync('git', ['show', '--no-ext-diff', '--no-textconv', `${sourceRef}:Kiro-account-manager/${relativePath}`], { cwd: repositoryRoot, encoding: 'utf8' })
    : readFileSync(join(applicationRoot, relativePath), 'utf8')).replaceAll('\r\n', '\n')
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `Source marker missing in ${relativePath}`)
  assert.equal(source.indexOf(startMarker, start + 1), -1, `Ambiguous source marker in ${relativePath}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(end >= 0, `Source end marker missing in ${relativePath}`)
  const snippet = source.slice(start, end + (includeEnd ? endMarker.length : 0))
  sourceChecks.push({
    file: relativePath,
    startLine: source.slice(0, start).split('\n').length,
    endLine: source.slice(0, start + snippet.length).split('\n').length,
    sha256: createHash('sha256').update(snippet).digest('hex')
  })
  return snippet
}

const storeSource = extract(
  'src/renderer/src/store/accounts.ts',
  '  exportAccounts: (ids) => {',
  '  // ==================== 状态管理'
)
const managerSource = extract(
  'src/renderer/src/components/accounts/AccountManager.tsx',
  '  const handleImport = async (): Promise<void> => {',
  '\n  }',
  true
)
const settingsSource = extract(
  'src/renderer/src/components/pages/SettingsPage.tsx',
  '  const handleImport = async () => {',
  '\n  }',
  true
)
const exportSource = extract(
  'src/renderer/src/components/accounts/ExportDialog.tsx',
  '  const generateContent = (format: ExportFormat): string => {',
  '\n  // 导出处理'
)

function fixture(overrides = {}) {
  return {
    id: 'synthetic-a',
    email: 'synthetic-a@example.invalid',
    idp: 'Google',
    credentials: {
      accessToken: 'SYNTHETIC_ACCESS_NOT_A_TOKEN',
      refreshToken: 'SYNTHETIC_REFRESH_NOT_A_TOKEN',
      provider: 'Google',
      authMethod: 'social',
      region: 'us-east-1'
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: 1 },
    tags: [],
    status: 'unknown',
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides
  }
}

function envelope(accounts, extra = {}) {
  return { version: '1.7.6', exportedAt: 1, accounts, groups: [], tags: [], ...extra }
}

function harness(initial = [], activeGroupTab = 'all') {
  let state = {
    appVersion: '1.7.6',
    accounts: new Map(initial.map(account => [account.id, structuredClone(account)])),
    groups: new Map([['synthetic-group', { id: 'synthetic-group', name: 'Synthetic group' }]]),
    tags: new Map()
  }
  let methods
  let id = 0
  let saveRequests = 0
  let caughtLogs = 0
  const alerts = []
  const results = []
  const sandbox = {
    get: () => ({ ...state, ...methods, saveToStorage: () => { saveRequests++ } }),
    set: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } },
    uuidv4: () => `synthetic-generated-${++id}`,
    generateRandomMachineId: () => '0'.repeat(64),
    alert: text => alerts.push(String(text)),
    console: { error: () => { caughtLogs++ } },
    setIsImporting: () => {},
    activeGroupTab,
    groups: state.groups,
    includeCredentials: true,
    window: { api: { importFromFile: async () => null } }
  }
  const context = vm.createContext(sandbox)
  const evaluate = text => vm.runInContext(stripTypeScriptTypes(text), context)
  methods = evaluate(`const extractedMethods = ({${storeSource}}); extractedMethods`)
  context.importFromExportData = data => {
    const result = methods.importFromExportData(data)
    results.push(result)
    return result
  }
  context.importAccounts = data => {
    const result = methods.importAccounts(data)
    results.push(result)
    return result
  }
  context.exportAccounts = methods.exportAccounts
  return {
    export(format, accounts) {
      context.accounts = accounts
      return evaluate(`(() => {${exportSource}; return generateContent(${JSON.stringify(format)}) })()`)
    },
    async run(route, input) {
      context.window.api.importFromFile = async () => ({ content: input, format: 'json' })
      let exception = null
      try {
        if (route === 'manager') await evaluate(`(() => {${managerSource}; return handleImport() })()`)
        else if (route === 'settings') await evaluate(`(() => {${settingsSource}; return handleImport() })()`)
        else if (route === 'store') results.push(methods.importFromExportData(JSON.parse(input)))
        else if (route === 'simple-store') results.push(methods.importAccounts(JSON.parse(input)))
        else throw new Error('Unknown route')
      } catch (error) {
        // Never return exception messages, which could contain raw JSON in future runtimes.
        exception = error?.name || 'Error'
      }
      const records = Array.from(state.accounts.values())
      return {
        alerts: alerts.map(text => text.startsWith('导入完成') ? 'completed' :
          text === '无效的 JSON 文件格式' ? 'unsupported-json-shape' :
          text === '解析导入文件失败' ? 'parse-or-import-failed' :
          text.startsWith('导入失败:') ? 'settings-import-failed' : 'other'),
        success: results.reduce((total, result) => total + result.success, 0),
        failed: results.reduce((total, result) => total + result.failed, 0),
        resultErrors: results.reduce((total, result) => total + result.errors.length, 0),
        stored: records.length,
        originalIdentitiesRetained: initial.filter(original => {
          const retained = state.accounts.get(original.id)
          return retained?.email === original.email && retained?.idp === original.idp
        }).length,
        structurallyIncomplete: records.filter(account => !account.id || !account.email || !account.credentials).length,
        undefinedIdKeys: state.accounts.has(undefined) ? 1 : 0,
        inActiveGroup: records.filter(account => account.groupId === activeGroupTab).length,
        saveRequests,
        caughtLogs,
        exception
      }
    }
  }
}

const observations = []
async function scenario(name, input, desired, { route = 'manager', initial = [], activeGroupTab, observed } = {}) {
  const test = harness(initial, activeGroupTab)
  const actual = await test.run(route, typeof input === 'string' ? input : JSON.stringify(input))
  for (const [key, value] of Object.entries(observed)) assert.deepEqual(actual[key], value, `${name}: ${key}`)
  observations.push({ name, route, actual, desired, baselineAssertion: 'PASS' })
}

const a = fixture()
const b = fixture({ id: 'synthetic-b', email: 'synthetic-b@example.invalid' })
const flat = {
  email: a.email,
  refreshToken: a.credentials.refreshToken,
  provider: a.idp
}

await scenario('native-full-export-control', envelope([a]), 'Import one complete account.', {
  observed: { success: 1, stored: 1, alerts: ['completed'], structurallyIncomplete: 0 }
})
await scenario('top-level-flat-array', [flat], 'Accept supported flattened credential arrays and import one account.', {
  observed: { success: 0, stored: 0, alerts: ['unsupported-json-shape'] }
})
await scenario('single-flat-object', flat, 'Recognize a supported single credential object.', {
  observed: { success: 0, stored: 0, alerts: ['unsupported-json-shape'] }
})
await scenario('accounts-wrapper-without-version', { accounts: [a] }, 'Detect structure without requiring a truthy version.', {
  observed: { success: 0, stored: 0, alerts: ['unsupported-json-shape'] }
})
await scenario('native-without-optional-metadata', { version: '1.7.6', accounts: [a] }, 'Default absent groups/tags to empty arrays.', {
  observed: { success: 0, stored: 0, alerts: ['parse-or-import-failed'], caughtLogs: 1 }
})
await scenario('native-json-with-utf8-bom', '\ufeff' + JSON.stringify(envelope([a])), 'Strip one leading UTF-8 BOM before parsing.', {
  observed: { success: 0, stored: 0, alerts: ['parse-or-import-failed'] }
})
await scenario('settings-top-level-array', [flat], 'Use the same JSON normalization and diagnostics as account management.', {
  route: 'settings', observed: { success: 0, stored: 0, alerts: ['settings-import-failed'] }
})
await scenario('settings-single-flat-object', flat, 'Accept a supported single credential object.', {
  route: 'settings', observed: { success: 0, stored: 0, alerts: ['settings-import-failed'] }
})

const exportHarness = harness([a])
const ownOidcExport = exportHarness.export('oidc', [a])
assert.equal(Array.isArray(JSON.parse(ownOidcExport)), true)
await scenario('own-oidc-export-file-roundtrip', ownOidcExport, 'Reimport the application\'s own OIDC JSON export from a file.', {
  observed: { success: 0, stored: 0, alerts: ['unsupported-json-shape'] }
})

await scenario('same-email-different-provider-inside-file', envelope([
  a,
  fixture({ id: 'synthetic-b', idp: 'Github', credentials: { ...a.credentials, provider: 'Github' } })
]), 'Preserve both providers; report every input in success/duplicate/failed totals.', {
  observed: { success: 1, stored: 1, failed: 0, resultErrors: 0 }
})
await scenario('same-id-different-accounts', envelope([a, { ...b, id: a.id }]), 'Preserve both identities or report an explicit ID conflict; success count must match retained records.', {
  observed: { success: 2, stored: 1, failed: 0 }
})
await scenario('id-collision-with-existing-different-account', envelope([{ ...b, id: a.id }]), 'Never silently replace a different existing account due to imported ID collision.', {
  initial: [a], observed: { success: 1, stored: 1, failed: 0, originalIdentitiesRetained: 0 }
})
await scenario('invalid-empty-record', envelope([{}]), 'Reject the malformed record with an indexed error; retain zero malformed accounts.', {
  observed: { success: 1, stored: 1, structurallyIncomplete: 1, undefinedIdKeys: 1 }
})
await scenario('one-null-among-valid-records', envelope([a, null, b]), 'Report the null record and import valid siblings according to the partial-import policy.', {
  observed: { success: 0, stored: 0, alerts: ['parse-or-import-failed'] }
})
await scenario('faked-version-wrapper-around-flat-records', envelope([flat, { ...flat, email: b.email }]), 'Normalize flat records before creating internal Account entities.', {
  observed: { success: 2, stored: 1, structurallyIncomplete: 1, undefinedIdKeys: 1 }
})
await scenario('active-group-ignored-by-json-file-import', envelope([a]), 'Apply the documented current-group policy or explicitly preserve backup groups with clear UI semantics.', {
  activeGroupTab: 'synthetic-group', observed: { success: 1, stored: 1, inActiveGroup: 0 }
})
await scenario('settings-duplicate-count-hidden', envelope([a]), 'Report duplicates as their own outcome instead of completed 0/failed 0.', {
  route: 'settings', initial: [a], observed: { success: 0, stored: 1, failed: 0, resultErrors: 1, alerts: ['completed'] }
})
await scenario('simple-store-does-not-deduplicate', [flat, flat], 'Apply the same identity deduplication across all import paths.', {
  route: 'simple-store', observed: { success: 2, stored: 2, failed: 0 }
})
await scenario('simple-store-accepts-empty-record', [{}], 'Validate required fields before creating account entities.', {
  route: 'simple-store', observed: { success: 1, stored: 1, structurallyIncomplete: 1 }
})
const providerlessA = fixture({ credentials: { ...a.credentials, provider: undefined } })
await scenario('existing-providerless-different-idp', envelope([
  fixture({ id: 'synthetic-b', idp: 'Github', credentials: { ...a.credentials, provider: undefined } })
]), 'Use normalized provider/idp identity consistently even when credentials.provider is absent.', {
  initial: [providerlessA], observed: { success: 0, stored: 1, failed: 0, resultErrors: 1 }
})

const localSamples = []
const sampleOption = process.argv.indexOf('--samples')
if (sampleOption >= 0) {
  const sampleDirectory = process.argv[sampleOption + 1]
  assert.ok(sampleDirectory, '--samples requires a local directory')
  const names = readdirSync(sampleDirectory).filter(name => name.toLowerCase().endsWith('.json')).sort()
  for (const [index, name] of names.entries()) {
    const raw = readFileSync(join(sampleDirectory, name), 'utf8')
    let data
    try { data = JSON.parse(raw.replace(/^\ufeff/, '')) }
    catch { localSamples.push({ sample: index + 1, validJson: false }); continue }
    const rows = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [data]
    const objectRows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    const manager = await harness().run('manager', raw)
    const settings = await harness().run('settings', raw)
    localSamples.push({
      sample: `sample-${localSamples.length + 1}.json`,
      validJson: true,
      bom: raw.startsWith('\ufeff'),
      root: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
      count: rows.length,
      rootKeys: data && !Array.isArray(data) && typeof data === 'object' ? Object.keys(data).sort() : [],
      recordKeys: [...new Set(objectRows.flatMap(Object.keys))].sort(),
      nestedCredentialKeys: [...new Set(objectRows.flatMap(row => row.credentials && typeof row.credentials === 'object' ? Object.keys(row.credentials) : []))].sort(),
      manager,
      settings
    })
  }
}

console.log(JSON.stringify({
  runtime: process.version,
  sourceRef: sourceRef || 'working-tree',
  extraction: 'Real checked-out source functions extracted by unique boundary markers, SHA-256 recorded; only TypeScript types stripped.',
  boundaries: 'File dialog IPC, network, persistence, React rendering and error logging are mocked; no live login or credentials are exercised.',
  sourceChecks,
  scenarios: observations,
  localSamples,
  baselineAssertions: `${observations.length}/${observations.length} PASS`
}, null, 2))

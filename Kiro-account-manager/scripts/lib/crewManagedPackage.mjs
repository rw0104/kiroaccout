import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const prefix = 'resources/crew-managed/'
const modules = new Set([
  'kiro_crew.agent_sdk.kas_model_catalog',
  'kiro_crew.acp.session_handle_model_selection',
  'kiro_crew.acp.session_handle_updates',
  'kiro_crew.acp.session_handle_mcp',
  'kiro_crew.dashboard.server',
  'kiro_crew.dashboard.server_runtime.api_entrypoint',
  'kiro_crew.dashboard.server_runtime.model_catalog_events'
])
const support = ['launcher.py', 'overlay.py', 'LICENSE.KiroCrew', 'NOTICE.KiroCrew']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..' || part === '.local' || part === '__pycache__')

/** Inspect package bytes only. This never imports or executes Crew/Python. */
export function verifyCrewManagedPackage({ entries, readPackaged, readUnpacked, readSource }) {
  const read = path => Buffer.from(readPackaged(prefix + path))
  const manifestBytes = read('manifest.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  assert.equal(manifest.schemaVersion, 1, 'Unsupported managed Crew resource manifest')
  assert.equal(manifest.upstream?.name, 'KiroCrew')
  assert.equal(manifest.upstream?.version, '0.12.0')
  assert.equal(manifest.upstream?.commit, 'f315771db6a95704d129c7b722340a676d6bb8a4')
  assert.equal(manifest.upstream?.url, 'https://github.com/kirodotdev/KiroCrew')
  assert.equal(manifest.upstream?.license, 'Apache-2.0')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === modules.size, 'Managed Crew patch set is incomplete')
  const seenModules = new Set()
  const expected = new Map([['manifest.json', undefined]])
  const add = (path, hash) => {
    assert.ok(safePath(path) && digest(hash) && !expected.has(path), 'Invalid or duplicate managed Crew resource')
    expected.set(path, hash)
  }
  for (const file of manifest.files) {
    assert.ok(file && modules.has(file.module) && !seenModules.has(file.module), 'Unexpected managed Crew patch module')
    assert.equal(file.path, `patches/${file.module.replaceAll('.', '/')}.py`, 'Managed Crew module path differs')
    const added = file.module === 'kiro_crew.dashboard.server_runtime.model_catalog_events'
    assert.ok(added ? file.originalNormalizedSha256 === null : digest(file.originalNormalizedSha256), 'Missing upstream compatibility digest')
    seenModules.add(file.module)
    add(file.path, file.sha256)
  }
  assert.ok(Array.isArray(manifest.supportFiles) && manifest.supportFiles.length === support.length, 'Managed Crew support resources are incomplete')
  for (const file of manifest.supportFiles) {
    assert.ok(file && support.includes(file.path), 'Unexpected managed Crew support resource')
    add(file.path, file.sha256)
  }
  const frontend = manifest.frontend
  assert.ok(frontend && /^useWebSocket-[A-Za-z0-9_-]+\.js$/.test(frontend.asset) && digest(frontend.originalSha256), 'Invalid managed Crew frontend compatibility metadata')
  assert.equal(frontend.path, `frontend/${frontend.asset}`)
  assert.equal(frontend.sourcePath, 'frontend/useWebSocket.ts')
  add(frontend.path, frontend.sha256)
  add(frontend.sourcePath, frontend.sourceSha256)

  // ASAR inventories include directories. Admit only declared files and their
  // ancestors, so credentials, test fixtures and bytecode cannot silently ship.
  const allowed = new Set(['resources/crew-managed'])
  for (const path of expected.keys()) {
    const segments = (prefix + path).split('/')
    for (let count = 2; count <= segments.length; count++) allowed.add(segments.slice(0, count).join('/'))
  }
  for (const entry of entries.filter(entry => entry === 'resources/crew-managed' || entry.startsWith(prefix))) {
    assert.ok(allowed.has(entry), `Undeclared managed Crew package entry: ${entry}`)
  }
  for (const [path, hash] of expected) {
    assert.ok(entries.includes(prefix + path), `Managed Crew resource missing: ${path}`)
    const packaged = read(path)
    if (hash) assert.equal(sha256(packaged), hash, `Managed Crew resource hash differs: ${path}`)
    assert.ok(!packaged.includes(13), `Managed Crew resource must use LF: ${path}`)
    assert.doesNotMatch(packaged.toString('utf8'), /private-docs|auto-only-live|CREW_PROBE_PATCH_ROOT/,
      `Private diagnostic material in managed Crew resource: ${path}`)
    if (readUnpacked) assert.deepEqual(Buffer.from(readUnpacked(prefix + path)), packaged, `Managed Crew unpacked copy differs: ${path}`)
    if (readSource) assert.deepEqual(Buffer.from(readSource(prefix + path)), packaged, `Managed Crew package is stale: ${path}`)
  }
  const license = read('LICENSE.KiroCrew').toString('utf8')
  assert.match(license, /Apache License/)
  assert.match(license, /Version 2\.0/)
  const notice = read('NOTICE.KiroCrew').toString('utf8')
  assert.match(notice, /KiroCrew/)
  assert.match(notice, /kiroaccout/i)
  return { upstreamVersion: manifest.upstream.version, patchModules: seenModules.size,
    resources: expected.size, licenseIncluded: true, frontendSourceIncluded: true }
}

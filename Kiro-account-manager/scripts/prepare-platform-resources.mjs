// Download and inspect a native library only. This does not start Electron or send account requests.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseOptions } from './lib/releaseOptions.mjs'
import { tlsLibrarySpec, verifyBinaryArchitecture } from './lib/platformResources.mjs'
import { loadLibraryForValidation } from './lib/nativeValidation.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = releaseOptions(process.argv.slice(2), appRoot)
assert.equal(options.platform, process.platform, 'Prepare resources on the native target OS')
assert.equal(options.arch, process.arch, 'Prepare resources on the native target architecture')
const spec = tlsLibrarySpec(appRoot, options.platform, options.arch)
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (token) headers.Authorization = `Bearer ${token}`
const releaseResponse = await fetch(`https://api.github.com/repos/bogdanfinn/tls-client/releases/tags/v${spec.version}`, { headers, signal: AbortSignal.timeout(60000) })
assert.ok(releaseResponse.ok, `TLS release metadata request failed: HTTP ${releaseResponse.status}`)
const release = await releaseResponse.json()
const asset = release.assets?.find(item => item.name === spec.filename)
assert.ok(asset && asset.browser_download_url === spec.url, 'Expected TLS release asset not found')
assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'TLS release must provide a SHA-256 digest')
const expectedSha256 = asset.digest.slice('sha256:'.length)
const destination = join(options.dist, 'platform-resources', 'current')
mkdirSync(destination, { recursive: true })
assert.ok(readdirSync(destination).every(file => [spec.filename, 'tls-library.json'].includes(file)), 'Remove stale platform resources before changing target')
const bundled = join(appRoot, 'resources', spec.filename)
const cached = join(destination, spec.filename)
let bytes
if (existsSync(cached)) bytes = readFileSync(cached)
else if (existsSync(bundled)) bytes = readFileSync(bundled)
else {
  const response = await fetch(spec.url, { signal: AbortSignal.timeout(120000) })
  assert.ok(response.ok, `TLS library download failed: HTTP ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
}
assert.equal(bytes.length, asset.size, 'TLS library size differs from upstream release')
const sha256 = createHash('sha256').update(bytes).digest('hex')
assert.equal(sha256, expectedSha256, 'TLS library SHA-256 differs from upstream release')
verifyBinaryArchitecture(bytes, spec.platform, spec.arch)
writeFileSync(cached, bytes)
const require = createRequire(import.meta.url)
const library = loadLibraryForValidation(require('koffi'), cached)
for (const [name, result, args] of [
  ['request', 'string', ['string']], ['getCookiesFromSession', 'string', ['string']],
  ['addCookiesToSession', 'string', ['string']], ['freeMemory', 'void', ['string']],
  ['destroyAll', 'string', []], ['destroySession', 'string', ['string']]
]) assert.equal(typeof library.func(name, result, args), 'function', `TLS export is missing: ${name}`)
// Go shared libraries retain runtime threads. Keep the handle until this short-lived process exits.
const report = { ...spec, sha256, size: bytes.length, digestSource: 'github-release-asset', nativeLoadVerified: true, applicationExecuted: false }
writeFileSync(join(destination, 'tls-library.json'), JSON.stringify(report, null, 2) + '\n')
console.log(`TLS library verified and staged: ${spec.filename} (${sha256})`)

// Inspect built files only. Never execute Electron, native addons, or installers.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { releaseArtifactNames, validateStableManifest } from './lib/releaseArtifacts.mjs'
import { releaseOptions } from './lib/releaseOptions.mjs'
import { tlsLibrarySpec, verifyBinaryArchitecture } from './lib/platformResources.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = releaseOptions(process.argv.slice(2), appRoot)
const { platform, arch, dist } = options
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const builder = yaml.load(readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8'))
const directory = platform === 'win32' ? 'win-unpacked' : platform === 'linux' ? 'linux-unpacked' : arch === 'arm64' ? 'mac-arm64' : 'mac'
const unpacked = join(dist, directory)
const contentRoot = platform === 'darwin' ? join(unpacked, `${builder.productName}.app`, 'Contents') : unpacked
const resources = join(contentRoot, platform === 'darwin' ? 'Resources' : 'resources')
const archive = join(resources, 'app.asar')
assert.ok(existsSync(archive), `Build the ${platform}-${arch} package before verifying it`)
const entries = asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, ''))
const allowedRoots = new Set(['out', 'resources', 'node_modules', 'package.json'])
assert.ok(entries.every(entry => allowedRoots.has(entry.split('/')[0])), 'Unexpected top-level files in app.asar')
assert.ok(!entries.some(entry => /(^|\/)(\.env(?:\.[^/]*)?|\.kiro|\.local|\.git|kiro-accounts[^/]*\.json)$/.test(entry)), 'Local state must not be packaged')
assert.ok(!entries.some(entry => /author-avatar|支付宝支付|微信支付|交流群/.test(entry)), 'Old promotional resources must not be packaged')
assert.ok(!entries.some(entry => /^resources\/tls-client-/.test(entry)), 'TLS libraries must be staged separately for the target platform')
for (const entry of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html',
  'node_modules/electron-store/package.json', 'node_modules/undici/package.json',
  'node_modules/tlsclientwrapper/package.json', 'node_modules/tlsclientwrapper/dist/utils/worker.cjs',
  'node_modules/piscina/package.json', 'node_modules/koffi/package.json']) {
  assert.ok(entries.includes(entry), `Required application entry missing: ${entry}`)
}
const koffiPath = `node_modules/koffi/build/koffi/${platform}_${arch}/koffi.node`
const cborPrefix = `node_modules/@cbor-extract/cbor-extract-${platform}-${arch}/`
const cborPath = entries.find(entry => entry.startsWith(cborPrefix) && /\/node\.napi(?:\.glibc)?\.node$/.test(entry))
assert.ok(cborPath, 'Target CBOR Node-API prebuild is missing')
for (const entry of [koffiPath, cborPath]) {
  assert.ok(entries.includes(entry), `Target native addon is missing: ${entry}`)
  const native = join(resources, 'app.asar.unpacked', entry)
  assert.ok(existsSync(native), `Native addon must be unpacked: ${entry}`)
  verifyBinaryArchitecture(readFileSync(native), platform, arch)
}
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packaged.version, metadata.version, 'Package version must match source')
assert.equal(packaged.main, './out/main/index.js')
assert.equal(packaged.repository?.url, 'https://github.com/rw0104/kiroaccout.git', 'Packaged source repository differs')
const tls = tlsLibrarySpec(appRoot, platform, arch)
const tlsReport = JSON.parse(readFileSync(join(resources, 'tls-library.json'), 'utf8'))
for (const key of ['filename', 'version', 'platform', 'arch', 'url']) assert.equal(tlsReport[key], tls[key], `TLS provenance ${key} differs`)
assert.equal(tlsReport.digestSource, 'github-release-asset')
assert.equal(tlsReport.nativeLoadVerified, true, 'TLS library must pass native load verification before packaging')
assert.deepEqual(readdirSync(resources).filter(file => file.startsWith('tls-client-')), [tls.filename], 'Only the target TLS library may be bundled')
const library = readFileSync(join(resources, tls.filename))
assert.equal(library.length, tlsReport.size, 'TLS package size differs from verified library')
assert.equal(createHash('sha256').update(library).digest('hex'), tlsReport.sha256, 'TLS package hash differs from verified library')
verifyBinaryArchitecture(library, platform, arch)
assert.ok(statSync(join(contentRoot, 'LICENSE.kiroaccout.txt')).size > 10000, 'AGPL license must accompany the package')
assert.ok(statSync(join(contentRoot, 'THIRD_PARTY_NOTICES.md')).size > 0, 'Upstream and third-party notices must accompany the package')
const updateConfig = yaml.load(readFileSync(join(resources, 'app-update.yml'), 'utf8'))
assert.equal(updateConfig.provider, 'github')
assert.equal(updateConfig.owner, 'rw0104')
assert.equal(updateConfig.repo, 'kiroaccout')
for (const file of releaseArtifactNames({ ...metadata, platform, arch })) {
  assert.ok(statSync(join(dist, file)).size > 0, `Release artifact missing: ${file}`)
}
if (platform === 'win32' && !metadata.version.includes('-')) {
  const installer = `${metadata.name}-${metadata.version}-x64-setup.exe`
  const payload = readFileSync(join(dist, installer))
  validateStableManifest(yaml.load(readFileSync(join(dist, 'latest.yml'), 'utf8')), {
    version: metadata.version, installer, size: payload.length,
    sha512: createHash('sha512').update(payload).digest('base64')
  })
  const blockmap = JSON.parse(gunzipSync(readFileSync(join(dist, `${installer}.blockmap`))).toString('utf8'))
  assert.ok(Array.isArray(blockmap.files) && blockmap.files.length > 0, 'Installer blockmap must be valid')
}
const executable = platform === 'win32' ? join(unpacked, 'kiro-account-manager.exe')
  : platform === 'linux' ? join(unpacked, 'kiro-account-manager')
    : join(contentRoot, 'MacOS', builder.mac?.executableName || builder.productName)
verifyBinaryArchitecture(readFileSync(executable), platform, arch)
const report = { version: packaged.version, platform, arch, archiveEntries: entries.length,
  updaterRepository: 'rw0104/kiroaccout', licenseIncluded: true, nativeLibraryIncluded: true,
  applicationExecuted: false }
writeFileSync(join(dist, `package-verification-${platform}-${arch}.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))

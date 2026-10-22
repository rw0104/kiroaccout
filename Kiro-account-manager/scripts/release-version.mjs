import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(appRoot, 'package-lock.json'), 'utf8'))
const version = metadata.version
assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)?$/, 'Invalid release version')
assert.equal(lock.version, version, 'Lockfile root version differs')
assert.equal(lock.packages[''].version, version, 'Lockfile package version differs')
const tag = `v${version}`
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, tag, 'Tag and package version differ')
assert.ok(existsSync(join(appRoot, '..', 'docs', 'releases', `${tag}.md`)), 'Versioned release notes are required')
const targets = [
  { platform: 'win32', arch: 'x64', runner: 'windows-latest', package: 'npm run package:win' },
  { platform: 'darwin', arch: 'x64', runner: 'macos-15-intel', package: 'npm run package:mac -- --x64' },
  { platform: 'darwin', arch: 'arm64', runner: 'macos-15', package: 'npm run package:mac -- --arm64' },
  { platform: 'linux', arch: 'x64', runner: 'ubuntu-22.04', package: 'npm run package:linux' }
]
const matrix = { include: targets }
const output = `version=${version}\ntag=${tag}\nprerelease=${version.includes('-')}\nmatrix=${JSON.stringify(matrix)}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
console.log(output.trim())

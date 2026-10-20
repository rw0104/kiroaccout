import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseArtifactNames } from './lib/releaseArtifacts.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const files = [...releaseArtifactNames(metadata), 'SHA256SUMS.txt']
const dist = join(appRoot, 'dist')
const destination = join(dist, 'release-assets', metadata.version)
mkdirSync(destination, { recursive: true })
for (const file of files) {
  assert.ok(statSync(join(dist, file)).size > 0, `Missing release asset: ${file}`)
  copyFileSync(join(dist, file), join(destination, file))
}
assert.deepEqual(readdirSync(destination).sort(), [...files].sort(), 'Unexpected files in release staging directory')
console.log(`Staged ${files.length} release assets for ${metadata.version}`)

// Read-only check for a publish job retried after the release already became public.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checksumFilename, releaseArtifactNames, releaseTargets } from './lib/releaseArtifacts.mjs'

const [dist, commit] = process.argv.slice(2)
assert.ok(dist && /^[0-9a-f]{40}$/.test(commit), 'Expected an asset directory and the tag commit SHA')
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const release = JSON.parse(readFileSync(0, 'utf8'))
assert.equal(release.tagName, `v${metadata.version}`, 'Release tag differs')
assert.equal(release.targetCommitish, commit, 'Release target differs from the built commit')
assert.equal(release.isDraft, false, 'Existing release is still a draft')
assert.equal(release.isPrerelease, metadata.version.includes('-'), 'Release channel differs')

const names = ['SHA256SUMS.txt', ...releaseTargets(metadata.version).flatMap(target =>
  [...releaseArtifactNames({ ...metadata, ...target }), checksumFilename(target)]
)].sort()
assert.deepEqual(readdirSync(dist).sort(), names, 'Staged release asset list differs')
assert.deepEqual(release.assets.map(asset => asset.name).sort(), names, 'Published release asset list differs')
for (const asset of release.assets) {
  const path = join(dist, asset.name)
  assert.equal(asset.state, 'uploaded', `Incomplete upload: ${asset.name}`)
  assert.equal(asset.size, statSync(path).size, `Size differs: ${asset.name}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  assert.equal(asset.digest, `sha256:${hash.digest('hex')}`, `Digest differs: ${asset.name}`)
}
console.log(`Verified ${names.length} published assets for ${release.tagName}`)

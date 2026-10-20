import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseArtifactNames } from './lib/releaseArtifacts.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const files = releaseArtifactNames(metadata)
const dist = join(appRoot, 'dist')
const lines = []
for (const file of files) {
  assert.ok(statSync(join(dist, file)).size > 0, `Release artifact missing or empty: ${file}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(dist, file))) hash.update(chunk)
  lines.push(`${hash.digest('hex')}  ${file}`)
}
const checksumText = lines.join('\n') + '\n'
if (process.argv.includes('--verify')) {
  assert.equal(readFileSync(join(dist, 'SHA256SUMS.txt'), 'utf8').replaceAll('\r\n', '\n'), checksumText, 'Release checksum verification failed')
  console.log(`${files.length} Windows release artifact checksums verified`)
} else {
  writeFileSync(join(dist, 'SHA256SUMS.txt'), checksumText)
  console.log(checksumText.trim())
}

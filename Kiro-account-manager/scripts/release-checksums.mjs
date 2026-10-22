import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseArtifactNames, releaseTargets, checksumFilename } from './lib/releaseArtifacts.mjs'
import { releaseOptions } from './lib/releaseOptions.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const options = releaseOptions(process.argv.slice(2), appRoot, { aggregate: true })
const targets = options.all ? releaseTargets(metadata.version) : [options]
const allLines = []
const allowed = []
for (const target of targets) {
  const files = releaseArtifactNames({ ...metadata, ...target })
  const lines = []
  for (const file of files) {
    assert.ok(statSync(join(options.dist, file)).size > 0, `Release artifact missing or empty: ${file}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(options.dist, file))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${file}`)
  }
  const checksumText = lines.join('\n') + '\n'
  const checksumFile = checksumFilename(target)
  if (options.verify || options.all) {
    assert.equal(readFileSync(join(options.dist, checksumFile), 'utf8').replaceAll('\r\n', '\n'), checksumText, `Checksum verification failed: ${checksumFile}`)
  } else {
    writeFileSync(join(options.dist, checksumFile), checksumText)
  }
  allowed.push(...files, checksumFile)
  allLines.push(...lines)
}
if (options.all) {
  const existing = readdirSync(options.dist).filter(file => file !== 'SHA256SUMS.txt')
  assert.deepEqual(existing.sort(), allowed.sort(), 'Aggregated release contains unexpected or missing assets')
  const combined = allLines.join('\n') + '\n'
  if (options.verify) assert.equal(readFileSync(join(options.dist, 'SHA256SUMS.txt'), 'utf8').replaceAll('\r\n', '\n'), combined, 'Combined release checksum verification failed')
  else writeFileSync(join(options.dist, 'SHA256SUMS.txt'), combined)
}
console.log(`${allLines.length} release artifact checksums ${options.verify || options.all ? 'verified' : 'generated'}`)

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
const files = [
  `${metadata.name}-${metadata.version}-x64-setup.exe`,
  `${metadata.name}-${metadata.version}-x64-windows.zip`
]
const dist = join(appRoot, 'dist')
const lines = []
for (const file of files) {
  assert.ok(statSync(join(dist, file)).size > 1000000, `Release artifact missing or empty: ${file}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(dist, file))) hash.update(chunk)
  lines.push(`${hash.digest('hex')}  ${file}`)
}
const checksumText = lines.join('\n') + '\n'
if (process.argv.includes('--verify')) {
  assert.equal(readFileSync(join(dist, 'SHA256SUMS.txt'), 'utf8').replaceAll('\r\n', '\n'), checksumText, 'Release checksum verification failed')
  console.log('Both Windows release artifact checksums verified')
} else {
  writeFileSync(join(dist, 'SHA256SUMS.txt'), checksumText)
  console.log(checksumText.trim())
}

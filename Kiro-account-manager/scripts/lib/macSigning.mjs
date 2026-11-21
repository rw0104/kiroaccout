import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'

/** Inspect the bundle without launching it or changing its signature.
 * Code-signature integrity does not establish Gatekeeper trust or notarization.
 * The injectable runner keeps release checks testable on every build platform.
 */
export function verifyMacSignature(appPath, runner = spawnSync) {
  assert.ok(typeof appPath === 'string' && isAbsolute(appPath), 'macOS signature verification requires an absolute app path')

  const run = args => {
    const result = runner('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 })
    assert.ok(result && !result.error && result.status === 0, 'macOS code-signature verification failed')
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  }

  run(['--verify', '--deep', '--strict', appPath])
  const details = run(['--display', '--verbose=4', appPath])
  const adHoc = /^Signature=adhoc\s*$/m.test(details)
  const developerId = /^Authority=Developer ID Application:/m.test(details)
  assert.ok(adHoc || /^Signature size=\d+\s*$/m.test(details), 'macOS signature details are missing')
  const flags = details.match(/\bflags=0x([0-9a-f]+)\b/i)?.[1]
  assert.ok(flags, 'macOS signature flags are missing')

  return {
    verified: true,
    type: adHoc ? 'ad-hoc' : developerId ? 'developer-id' : 'other',
    hardenedRuntime: (Number.parseInt(flags, 16) & 0x10000) !== 0,
    notarizationVerified: false
  }
}

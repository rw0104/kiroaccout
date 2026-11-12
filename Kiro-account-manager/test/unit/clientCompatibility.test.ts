import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertCrewAccessContract, assertVerifiedCliAccessVersion, crewAccessContractDigest, crewAccessContractFiles, CREW_ACCESS_CONTRACT_FILES } from '../../src/main/clientCompatibility'

test('the verified native CLI matrix accepts current tested contracts and rejects unknown versions', () => {
  for (const version of ['3.1.0', '3.2.1']) assert.doesNotThrow(() => assertVerifiedCliAccessVersion(version))
  for (const version of ['', '3.2.2', '4.0.0', '3.2.1-preview', '3.2.1\n']) {
    assert.throws(() => assertVerifiedCliAccessVersion(version), { code: 'unsupported-client-version' })
  }
})

test('Crew contract normalization preserves line-ending compatibility but detects source changes', () => {
  const lf = crewAccessContractDigest(file => `# Synthetic ${file}\ndef payload():\n    return 'v1'\n`)
  const crlf = crewAccessContractDigest(file => `# Synthetic ${file}\r\ndef payload():\r\n    return 'v1'\r\n`)
  assert.equal(lf, crlf)
  assert.notEqual(lf, crewAccessContractDigest(file => `# Synthetic ${file}\ndef payload():\n    return 'v2'\n`))
})

test('the official access contract covers security IO dependencies beyond the core facade files',
  { skip: !process.env.KIRO_CREW_TEST_PYTHON }, t => {
    const original = dirname(process.env.KIRO_CREW_TEST_PYTHON!)
    assert.doesNotThrow(() => assertCrewAccessContract(original))
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'crew-contract-fixture-')))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const paths = crewAccessContractFiles(original)
    for (const relative of paths) {
      const destination = join(directory, 'Lib/site-packages/kiro_crew', relative)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(original, 'Lib/site-packages/kiro_crew', relative), destination)
    }
    assert.doesNotThrow(() => assertCrewAccessContract(directory))
    const dependency = 'platform_compat_files.py'
    assert.ok(paths.includes(dependency))
    assert.ok(!(CREW_ACCESS_CONTRACT_FILES as readonly string[]).includes(dependency))
    writeFileSync(join(directory, 'Lib/site-packages/kiro_crew', dependency), '# SYNTHETIC_CHANGED_SECURITY_IO\n')
    assert.throws(() => assertCrewAccessContract(directory), { code: 'unsupported-client-contract' })
  })

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNewerVersion } from '../../src/shared/version.ts'

test('RC update checks never suggest downgrading to an older stable version', () => {
  assert.equal(isNewerVersion('1.7.5', '1.7.6-rc.1'), false)
  assert.equal(isNewerVersion('1.7.6-rc.1', '1.7.5'), true)
  assert.equal(isNewerVersion('v1.7.6', 'v1.7.6-rc.1'), true)
  assert.equal(isNewerVersion('1.7.6-rc.1', '1.7.6'), false)
})

test('SemVer precedence follows the standard prerelease sequence', () => {
  const ordered = [
    '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'
  ]
  for (let lower = 0; lower < ordered.length; lower++) {
    for (let higher = lower + 1; higher < ordered.length; higher++) {
      assert.equal(isNewerVersion(ordered[higher], ordered[lower]), true)
      assert.equal(isNewerVersion(ordered[lower], ordered[higher]), false)
    }
    assert.equal(isNewerVersion(ordered[lower], ordered[lower]), false)
  }
})

test('numeric components and prerelease identifiers compare numerically', () => {
  for (const [latest, current] of [
    ['2.0.0', '1.99.99'], ['1.10.0', '1.9.99'], ['1.7.10', '1.7.9'],
    ['1.7.6-rc.10', '1.7.6-rc.9'], ['1.7.6-rc.1.1', '1.7.6-rc.1'],
    ['9007199254740993.0.0', '9007199254740992.0.0'],
    ['1.0.0-rc.9007199254740993', '1.0.0-rc.9007199254740992']
  ]) {
    assert.equal(isNewerVersion(latest, current), true)
    assert.equal(isNewerVersion(current, latest), false)
  }
})

test('build metadata and the optional v tag prefix do not change precedence', () => {
  for (const version of ['1.7.6', '1.7.6-rc.1']) {
    assert.equal(isNewerVersion(`v${version}+build.01`, `${version}+different`), false)
    assert.equal(isNewerVersion(version, `v${version}+build.01`), false)
  }
  assert.equal(isNewerVersion('v1.7.6+build.01', 'v1.7.6-rc.10+build.02'), true)
})

test('malformed or incomplete versions never offer updates', () => {
  const invalid: unknown[] = [
    undefined, null, 176, {}, [], '', '1', '1.7', 'v1.7', 'V1.7.6', 'vv1.7.6',
    '01.7.6', '1.07.6', '1.7.06', '1.7.6-01', '1.7.6-rc.01',
    '1.7.6-', '1.7.6+', '1.7.6-rc..1', '1.7.6+build..1',
    '1.7.6_rc.1', '1.7.6.1', '1.7.6-rc_1', '1.7.6+build_1',
    ' 1.7.6', '1.7.6 ', '1.7.6\n', '1.7.6\r\n', '1.7.6\u0000'
  ]
  for (const version of invalid) {
    assert.equal(isNewerVersion(version, '1.0.0'), false)
    assert.equal(isNewerVersion('9.0.0', version), false)
  }
})

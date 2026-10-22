import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveKiroSettingsPath } from '../../src/main/kiroSettingsPath'

test('Windows settings follow the configured roaming profile with a home-directory fallback', () => {
  assert.equal(resolveKiroSettingsPath('win32', 'C:\\Synthetic\\home', { APPDATA: 'D:\\Synthetic\\Roaming' }), 'D:\\Synthetic\\Roaming\\Kiro\\User\\settings.json')
  for (const APPDATA of [undefined, '', 'relative-profile']) {
    assert.equal(resolveKiroSettingsPath('win32', 'C:\\Synthetic\\home', { APPDATA }), 'C:\\Synthetic\\home\\AppData\\Roaming\\Kiro\\User\\settings.json')
  }
})

test('macOS settings use Application Support regardless of Windows or XDG overrides', () => {
  assert.equal(resolveKiroSettingsPath('darwin', '/Users/synthetic', { APPDATA: '/wrong', XDG_CONFIG_HOME: '/wrong' }), '/Users/synthetic/Library/Application Support/Kiro/User/settings.json')
})

test('Linux settings honor an absolute XDG config root and ignore empty or relative values', () => {
  assert.equal(resolveKiroSettingsPath('linux', '/home/synthetic', { XDG_CONFIG_HOME: '/synthetic/config' }), '/synthetic/config/Kiro/User/settings.json')
  for (const XDG_CONFIG_HOME of [undefined, '', 'relative-config']) {
    assert.equal(resolveKiroSettingsPath('linux', '/home/synthetic', { XDG_CONFIG_HOME }), '/home/synthetic/.config/Kiro/User/settings.json')
  }
})

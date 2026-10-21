import assert from 'node:assert/strict'
import test from 'node:test'
import { commonWindowsPaths, createWindowsKiroInstallationDiscovery, parseRegOutput, pathFromRegistryValue } from '../../src/main/kiroInstanceDiscovery'

const exe = 'D:\\Kiro\\Kiro.exe'

test('installation discovery parses registry executable values without evaluating them', () => {
  const output = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Kiro.exe',
    '    (Default)    REG_SZ    D:\\Kiro\\Kiro.exe',
    '    Path         REG_SZ    D:\\Kiro',
    '    DisplayIcon  REG_SZ    "D:\\Kiro\\Kiro.exe",0',
    ''
  ].join('\r\n')
  assert.deepEqual(parseRegOutput(output), [exe, exe, exe])
  assert.equal(pathFromRegistryValue('"D:\\Kiro\\Kiro.exe" --open-url'), exe)
  assert.equal(pathFromRegistryValue('D:\\Kiro\\Kiro.exe'), exe)
  assert.equal(pathFromRegistryValue('C:\\evil\\other.exe'), null)
  assert.equal(pathFromRegistryValue('D:\\Kiro\\Kiro.exe & whoami'), exe)
})

test('discovery prioritizes running processes, deduplicates paths and validates every candidate', async () => {
  const inspected: string[] = []
  const service = createWindowsKiroInstallationDiscovery({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    runtime: {
      inspectProcesses: async () => ({ complete: true, currentSid: 'S-1-5-21', processes: [
        { pid: 1, parentPid: 0, executablePath: exe, commandLine: '"D:\\Kiro\\Kiro.exe" --user-data-dir=x' },
        { pid: 2, parentPid: 1, executablePath: 'D:\\Kiro\\Kiro.exe', commandLine: '--type=renderer' }
      ] }),
      inspectInstallation: async path => {
        inspected.push(path)
        if (path.toLowerCase() === exe.toLowerCase() || path === 'C:\\Program Files\\Kiro\\Kiro.exe') {
          return { version: '1.4.13', publisher: 'Amazon.com, Inc.', portableSupported: false }
        }
        throw new Error('invalid candidate')
      }
    },
    readRegistry: async () => [exe, 'C:\\not-kiro\\Kiro.exe'],
    commonPaths: () => ['C:\\Program Files\\Kiro\\Kiro.exe', exe]
  })
  const result = await service.discover()
  assert.equal(result.supported, true)
  assert.deepEqual(result.candidates, [
    { path: exe, version: '1.4.13', publisher: 'Amazon.com, Inc.', portableSupported: false, source: 'running-process' },
    { path: 'C:\\Program Files\\Kiro\\Kiro.exe', version: '1.4.13', publisher: 'Amazon.com, Inc.', portableSupported: false, source: 'common-path' }
  ])
  assert.deepEqual(inspected, [exe, 'C:\\not-kiro\\Kiro.exe', 'C:\\Program Files\\Kiro\\Kiro.exe'])
})

test('non-Windows discovery returns a safe unsupported result', async () => {
  const service = createWindowsKiroInstallationDiscovery({
    platform: 'linux',
    runtime: { inspectProcesses: async () => { throw new Error('must not call') }, inspectInstallation: async () => { throw new Error('must not call') } }
  })
  assert.deepEqual(await service.discover(), { supported: false, candidates: [], message: '目前仅支持 Windows Kiro 客户端发现。' })
})

test('common path candidates are bounded to Windows drive roots', () => {
  const result = commonWindowsPaths({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PATH: 'ignored' })
  assert.ok(result.includes('C:\\Program Files\\Kiro\\Kiro.exe'))
  assert.ok(result.includes('C:\\Users\\test\\AppData\\Local\\Programs\\Kiro\\Kiro.exe'))
  assert.ok(!result.some(path => path.includes('ignored')))
})

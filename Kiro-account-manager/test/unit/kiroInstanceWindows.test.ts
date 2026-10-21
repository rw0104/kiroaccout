import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { win32 } from 'node:path'
import {
  ASSERT_KIRO_DIRECTORY_SCRIPT, ASSERT_KIRO_DIRECTORIES_SCRIPT, CLOSE_KIRO_INSTANCE_SCRIPT, INSPECT_KIRO_INSTALLATION_SCRIPT,
  INSPECT_KIRO_PROCESSES_SCRIPT, LAUNCH_KIRO_INSTANCE_SCRIPT, createWindowsKiroRuntime,
  collectPowerShellOutput, parseKiroProcessInventory, parseWindowsCommandLine, type WindowsPowerShellExecutor
} from '../../src/main/kiroInstanceWindows'

const exe = 'C:\\Synthetic Client\\Kiro.exe'
const profile = 'C:\\Synthetic Profiles\\instance-one\\user-data'
const sid = 'S-1-5-21-100-200-300-1000'
const publisher = 'Amazon.com, Inc.'
const identity = () => ({ pid: 123, parentPid: 40, ownerSid: sid, executablePath: exe,
  startedAt: '2026-10-20T00:00:00.1234567Z', userDataPath: profile })
const installation = () => ({ version: '1.4.13', publisher, portableSupported: false })
const inventory = () => ({ complete: true, currentSid: sid, processes: [{ ...identity(),
  commandLine: `"${exe}" --new-window --user-data-dir "${profile}"` }] })

test('launch helper resolves at verified helper exit even when the GUI retains inherited pipes', async () => {
  for (const outputFirst of [true, false]) {
    let killed = 0
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() { killed++; return true } }) as unknown as ChildProcessWithoutNullStreams
    let settled = false
    const result = collectPowerShellOutput(child, true).then(value => { settled = true; return value })
    if (outputFirst) child.stdout.write('requested\r\n')
    child.emit('exit', 0, null)
    if (!outputFirst) child.stdout.write('requested\r\n')
    await new Promise(resolve => setImmediate(resolve))
    // A real GUI may retain these handles indefinitely. No close event is emitted here.
    assert.equal(settled, true)
    assert.equal(await result, 'requested')
    assert.equal(killed, 0)
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  }
})

test('non-launch helpers drain complete output and a failed launch exit never reports success', async () => {
  const make = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() { return true } }) as unknown as ChildProcessWithoutNullStreams
  const child = make()
  let settled = false
  const result = collectPowerShellOutput(child, false).then(value => { settled = true; return value })
  child.stdout.write('{"complete":')
  child.emit('exit', 0, null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  child.stdout.write('true}')
  child.emit('close', 0, null)
  assert.equal(await result, '{"complete":true}')
  const failed = make()
  const rejected = assert.rejects(collectPowerShellOutput(failed, true))
  failed.stdout.write('requested')
  failed.emit('exit', 1, null)
  await rejected
})

test('Windows argv decoding handles quoted spaces, equals, trailing slashes and duplicate switches', () => {
  assert.deepEqual(parseWindowsCommandLine(`"${exe}" --user-data-dir "${profile}"`), [exe, '--user-data-dir', profile])
  assert.deepEqual(parseWindowsCommandLine('app "" "a b" "a\\\\" "a\\\"b"'), ['app', '', 'a b', 'a\\', 'a"b'])
  assert.deepEqual(parseWindowsCommandLine(`"${exe}" "--user-data-dir=${profile}" --user-data-dir=C:\\other --type=renderer`),
    [exe, `--user-data-dir=${profile}`, '--user-data-dir=C:\\other', '--type=renderer'])
})

test('installation validates version/publisher/portable contract and fails without current publisher evidence', async () => {
  const calls: Array<[string, unknown]> = []
  const execute: WindowsPowerShellExecutor = async (script, payload) => { calls.push([script, payload]); return JSON.stringify(installation()) }
  const runtime = createWindowsKiroRuntime({ trustedPublishers: [publisher], execute })
  assert.deepEqual(await runtime.inspectInstallation(exe), installation())
  assert.equal(calls[0][0], INSPECT_KIRO_INSTALLATION_SCRIPT)
  assert.deepEqual(calls[0][1], { executablePath: exe, trustedPublishers: [publisher] })
  await assert.rejects(createWindowsKiroRuntime({ execute }).inspectInstallation(exe))
  for (const path of ['C:\\A\\..\\Kiro.exe', '\\\\server\\Kiro.exe', 'C:\\Kiro.exe:stream', 'C:\\A\\powershell.exe', 'C:\\A\\Kiro.exe" --inject']) {
    await assert.rejects(runtime.inspectInstallation(path))
  }
  assert.equal(calls.length, 1)
  for (const bad of [{ ...installation(), publisher: 'unknown' }, { ...installation(), version: 'fake' }, { ...installation(), portableSupported: 'yes' }, null]) {
    await assert.rejects(createWindowsKiroRuntime({ trustedPublishers: [publisher], execute: async () => JSON.stringify(bad) }).inspectInstallation(exe))
  }
})

test('incomplete process metadata remains observable and can never be interpreted as stopped', async () => {
  const raw = inventory()
  assert.equal(parseKiroProcessInventory(JSON.stringify(raw)).complete, true)
  for (const field of ['ownerSid', 'executablePath', 'startedAt', 'commandLine']) {
    const incomplete = structuredClone(raw) as unknown as { processes: Array<Record<string, unknown>> }
    delete incomplete.processes[0][field]
    const result = parseKiroProcessInventory(JSON.stringify(incomplete))
    assert.equal(result.complete, false)
    assert.equal(result.processes.length, 1)
  }
  for (const invalid of [{ ...raw, currentSid: '' }, { ...raw, processes: [raw.processes[0], raw.processes[0]] }, { ...raw, processes: [{ ...raw.processes[0], pid: -1 }] }]) {
    assert.throws(() => parseKiroProcessInventory(JSON.stringify(invalid)))
  }
  let script = ''
  const runtime = createWindowsKiroRuntime({ execute: async received => { script = received; return JSON.stringify(raw) } })
  assert.equal((await runtime.inspectProcesses()).complete, true)
  assert.equal(script, INSPECT_KIRO_PROCESSES_SCRIPT)
})

test('launch passes all arguments/environment through stdin payload and rechecks the installation under a read lock', async () => {
  const calls: Array<[string, unknown]> = []
  const runtime = createWindowsKiroRuntime({ trustedPublishers: [publisher], execute: async (script, payload) => {
    calls.push([script, payload]); return 'requested'
  } })
  const args = ['--new-window', '--user-data-dir', profile, '--extensions-dir', 'C:\\Synthetic Profiles\\extensions', '--title', 'literal $(value) & text']
  const env = { HOME: 'C:\\Synthetic Profiles\\home', TEMP: 'C:\\Synthetic Profiles\\temp' }
  await runtime.launch(exe, args, env, 'C:\\Synthetic Profiles\\home')
  assert.equal(calls[0][0], LAUNCH_KIRO_INSTANCE_SCRIPT)
  assert.equal(calls[0][0].includes('Synthetic Profiles'), false)
  const payload = calls[0][1] as { argumentLine: string; env: unknown; cwd: string }
  assert.deepEqual(parseWindowsCommandLine('app ' + payload.argumentLine).slice(1), args)
  assert.deepEqual(payload.env, env)
  assert.equal(payload.cwd, 'C:\\Synthetic Profiles\\home')
  assert.match(LAUNCH_KIRO_INSTANCE_SCRIPT, /UseShellExecute=\$false/)
  assert.match(LAUNCH_KIRO_INSTANCE_SCRIPT, /EnvironmentVariables.Clear\(\)/)
  assert.match(LAUNCH_KIRO_INSTANCE_SCRIPT, /FileShare\]::Read/)
  assert.equal(LAUNCH_KIRO_INSTANCE_SCRIPT.includes('WaitForExit'), false)
  await assert.rejects(runtime.launch(exe, ['bad\0arg'], env, 'C:\\Synthetic Profiles\\home'))
  assert.equal(calls.length, 1)
})

test('close passes complete identities only; fixed helper requires same handle and rejects ambiguity before WM_CLOSE', async () => {
  const calls: Array<[string, unknown]> = []
  const runtime = createWindowsKiroRuntime({ execute: async (script, payload) => { calls.push([script, payload]); return 'requested' } })
  await runtime.requestClose([identity()])
  assert.deepEqual(calls, [[CLOSE_KIRO_INSTANCE_SCRIPT, { processes: [identity()] }]])
  for (const bad of [[], [{ ...identity(), userDataPath: '' }], [{ ...identity(), startedAt: 'unknown' }], [{ ...identity(), ownerSid: 'fake' }]]) {
    await assert.rejects(runtime.requestClose(bad))
  }
  assert.equal(calls.length, 1)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /OpenProcess\(0x1000\|0x100000,false,pid\)/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /GetProcessTimes\(handle/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /OpenProcessToken\(handle/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /NtQueryInformationProcess\(handle,60/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /matches!=1/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /if\(IsChild\) throw/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /roots.Count -ne 1/)
  assert.match(CLOSE_KIRO_INSTANCE_SCRIPT, /PostMessage\(window,0x0010/)
  assert.doesNotMatch(CLOSE_KIRO_INSTANCE_SCRIPT, /TerminateProcess|Stop-Process|taskkill|\.Kill\(/i)
})

test('runtime failure messages redact system exceptions and paths', async () => {
  const runtime = createWindowsKiroRuntime({ trustedPublishers: [publisher], execute: async () => { throw new Error('PRIVATE_PATH token=SECRET') } })
  for (const action of [() => runtime.inspectInstallation(exe), () => runtime.inspectProcesses(), () => runtime.launch(exe, [], {}, 'C:\\Synthetic'), () => runtime.requestClose([identity()])]) {
    await assert.rejects(action(), error => error instanceof Error && !/PRIVATE_PATH|SECRET|token/.test(error.message))
  }
})

test('directory guards inspect ancestors and fail closed on missing verification', async () => {
  const calls: Array<[string, unknown]> = []
  const runtime = createWindowsKiroRuntime({ execute: async (script, payload) => { calls.push([script, payload]); return 'verified' } })
  await runtime.assertSafeDirectory!('C:\\Synthetic Profiles\\instance-one')
  assert.deepEqual(calls, [[ASSERT_KIRO_DIRECTORY_SCRIPT, { path: 'C:\\Synthetic Profiles\\instance-one' }]])
  assert.match(ASSERT_KIRO_DIRECTORY_SCRIPT, /ReparsePoint/)
  await assert.rejects(createWindowsKiroRuntime({ execute: async () => 'unverified' }).assertSafeDirectory!('C:\\Synthetic'))
})

test('batch directory guards check all nested roots in one fixed helper without interpolating paths', async () => {
  const calls: Array<[string, unknown]> = []
  const runtime = createWindowsKiroRuntime({ execute: async (script, payload) => { calls.push([script, payload]); return 'verified' } })
  const paths = ['C:\\Synthetic Profiles\\one', 'C:\\Synthetic Profiles\\one\\home\\.aws\\sso\\cache']
  await runtime.assertSafeDirectories!(paths)
  assert.deepEqual(calls, [[ASSERT_KIRO_DIRECTORIES_SCRIPT, { paths }]])
  assert.match(ASSERT_KIRO_DIRECTORIES_SCRIPT, /foreach \(\$value in \$paths\)/)
  assert.match(ASSERT_KIRO_DIRECTORIES_SCRIPT, /ReparsePoint/)
  for (const invalid of [[], ['C:\\Synthetic\\..\\other'], Array.from({ length: 65 }, () => paths[0])]) await assert.rejects(runtime.assertSafeDirectories!(invalid))
  assert.equal(calls.length, 1)
})

test('constant PowerShell scripts parse and native declarations compile without executing client/process operations', { skip: process.platform !== 'win32' }, () => {
  const scripts = [INSPECT_KIRO_INSTALLATION_SCRIPT, INSPECT_KIRO_PROCESSES_SCRIPT, LAUNCH_KIRO_INSTANCE_SCRIPT, CLOSE_KIRO_INSTANCE_SCRIPT, ASSERT_KIRO_DIRECTORY_SCRIPT, ASSERT_KIRO_DIRECTORIES_SCRIPT]
  for (const script of scripts) assert.ok(Buffer.from(script, 'utf16le').toString('base64').length < 30_000, 'encoded helper must fit Windows argv limit')
  const validation = String.raw`
$ErrorActionPreference='Stop';
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
foreach ($script in $payload.scripts) {
  $tokens=$null; $errors=$null;
  $null=[Management.Automation.Language.Parser]::ParseInput([string]$script,[ref]$tokens,[ref]$errors);
  if ($errors.Count -ne 0) { throw 'PowerShell parse failed' };
};
$source=[regex]::Match($payload.scripts[0],"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@").Groups[1].Value;
if (-not $source) {throw 'native declarations missing'};
Add-Type -TypeDefinition $source;
$argv=[KiroNative]::Args('"C:\Synthetic Client\Kiro.exe" --user-data-dir "C:\Synthetic Profiles\one"');
if ($argv.Length -ne 3 -or $argv[2] -cne 'C:\Synthetic Profiles\one') {throw 'argv'};
Write-Output 'verified';
`
  const executable = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(validation, 'utf16le').toString('base64')], {
    input: JSON.stringify({ scripts }), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  })
  assert.equal(result.status, 0, 'PowerShell scripts and native declarations must compile: ' + result.stderr)
  assert.equal(result.stdout.trim(), 'verified')
})

test('native read-only identity check accepts CIM microsecond time and rejects reused identity fields', { skip: process.platform !== 'win32' }, () => {
  const source = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(INSPECT_KIRO_INSTALLATION_SCRIPT)![1]
  const validation = String.raw`
$ErrorActionPreference='Stop';
$source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source;
$self=Get-CimInstance Win32_Process -Filter ("ProcessId="+$PID);
$created=$self.CreationDate.ToUniversalTime().ToString('o');
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$held=$null;
try {
  # Only inspect this temporary test helper. Never call RequestClose/WM_CLOSE here.
  $held=New-Object KiroNative+HeldProcess([int]$self.ProcessId,[int]$self.ParentProcessId,[string]$self.ExecutablePath,$created,$sid);
  $held.Alive();
} finally { if ($null -ne $held) {$held.Dispose()} };
$cases=@(
  @{parent=([int]$self.ParentProcessId+1);image=[string]$self.ExecutablePath;time=$created;sid=$sid},
  @{parent=[int]$self.ParentProcessId;image=[string]$self.ExecutablePath;time=$self.CreationDate.AddMilliseconds(-1).ToUniversalTime().ToString('o');sid=$sid},
  @{parent=[int]$self.ParentProcessId;image=[string]$self.ExecutablePath;time=$created;sid='S-1-5-18'},
  @{parent=[int]$self.ParentProcessId;image='C:\Synthetic\Kiro.exe';time=$created;sid=$sid}
);
foreach ($case in $cases) {
  $rejected=$false; $held=$null;
  try {$held=New-Object KiroNative+HeldProcess([int]$self.ProcessId,[int]$case.parent,[string]$case.image,[string]$case.time,[string]$case.sid)}
  catch {$rejected=$true}
  finally {if($null -ne $held){$held.Dispose()}};
  if(-not $rejected){throw 'identity mismatch was accepted'};
}; Write-Output 'verified';
`
  const executable = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(validation, 'utf16le').toString('base64')], {
    input: source, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  })
  assert.equal(result.status, 0, 'read-only native process identity verification must work')
  assert.equal(result.stdout.trim(), 'verified')
})

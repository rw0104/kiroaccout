import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { win32 } from 'node:path'
import type { KiroProcessIdentity } from '../shared/kiroInstances'
import type { KiroInstallationInfo, KiroInstanceRuntime, KiroProcessInventory } from './kiroInstanceRuntimeTypes'

const SYSTEM_FAILURE = '无法安全验证 Windows 客户端或进程；未操作现有客户端。'
export type WindowsPowerShellExecutor = (script: string, payload?: unknown) => Promise<string>

/** CommandLineToArgvW-compatible quoting for application arguments, including empty arguments. */
export function parseWindowsCommandLine(value: string): string[] {
  const args: string[] = []
  let offset = 0
  while (offset < value.length) {
    while (/\s/.test(value[offset] ?? '') && offset < value.length) offset++
    if (offset === value.length) break
    let argument = ''; let quoted = false
    while (offset < value.length) {
      if (!quoted && /\s/.test(value[offset])) break
      let slashes = 0
      while (value[offset] === '\\') { slashes++; offset++ }
      if (value[offset] === '"') {
        argument += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2) { argument += '"'; offset++ }
        else if (quoted && value[offset + 1] === '"') { argument += '"'; offset += 2 }
        else { quoted = !quoted; offset++ }
      } else {
        argument += '\\'.repeat(slashes)
        if (offset < value.length && (quoted || !/\s/.test(value[offset]))) argument += value[offset++]
      }
    }
    args.push(argument)
  }
  return args
}

const PREFIX = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);\n`
const NATIVE_SOURCE = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.IO;
public static class KiroNative {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder buffer, ref int length);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int informationClass, IntPtr data, int length, out int returned);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  public static string[] Args(string line) {
    int count; IntPtr pointer=CommandLineToArgvW(line, out count);
    if(pointer==IntPtr.Zero) throw new InvalidOperationException();
    try { string[] result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size)); return result; }
    finally { LocalFree(pointer); }
  }
  static string FullPath(string value) { return Path.GetFullPath(value).TrimEnd('\\'); }
  public sealed class HeldProcess : IDisposable {
    IntPtr handle;
    public int Pid;
    public string[] Arguments;
    public bool IsChild;
    public HeldProcess(int pid,int parentPid,string image,string created,string sid) {
      Pid=pid; handle=OpenProcess(0x1000|0x100000,false,pid);
      if(handle==IntPtr.Zero) throw new InvalidOperationException();
      try {
        Alive();
        int basicReturned; IntPtr basic=Marshal.AllocHGlobal(IntPtr.Size*6);
        try { if(NtQueryInformationProcess(handle,0,basic,IntPtr.Size*6,out basicReturned)!=0||Marshal.ReadIntPtr(basic,IntPtr.Size*5).ToInt64()!=parentPid) throw new InvalidOperationException(); }
        finally { Marshal.FreeHGlobal(basic); }
        long c,e,k,u; if(!GetProcessTimes(handle,out c,out e,out k,out u)) throw new InvalidOperationException();
        DateTime expected=DateTime.Parse(created,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind);
        // CIM CreationDate serializes microseconds; GetProcessTimes retains 100ns ticks.
        // Compare the same microsecond, retaining PID+SID+image+parent+command-line checks on this handle.
        if(c/10!=expected.ToUniversalTime().ToFileTimeUtc()/10) throw new InvalidOperationException();
        int length=32768; StringBuilder name=new StringBuilder(length);
        if(!QueryFullProcessImageName(handle,0,name,ref length)||!String.Equals(FullPath(name.ToString()),FullPath(image),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        IntPtr token; if(!OpenProcessToken(handle,8,out token)) throw new InvalidOperationException();
        try { using(WindowsIdentity identity=new WindowsIdentity(token)) { if(identity.User==null||!String.Equals(identity.User.Value,sid,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException(); } }
        finally { CloseHandle(token); }
        int returned; NtQueryInformationProcess(handle,60,IntPtr.Zero,0,out returned);
        if(returned<=0||returned>1048576) throw new InvalidOperationException();
        IntPtr data=Marshal.AllocHGlobal(returned);
        try {
          if(NtQueryInformationProcess(handle,60,data,returned,out returned)!=0) throw new InvalidOperationException();
          int bytes=(ushort)Marshal.ReadInt16(data); IntPtr text=Marshal.ReadIntPtr(data,IntPtr.Size==8?8:4);
          long start=data.ToInt64(), end=start+returned;
          if(bytes%2!=0||text.ToInt64()<start||text.ToInt64()+bytes>end) throw new InvalidOperationException();
          Arguments=Args(Marshal.PtrToStringUni(text,bytes/2));
        } finally { Marshal.FreeHGlobal(data); }
        if(Arguments.Length<1||!String.Equals(FullPath(Arguments[0]),FullPath(image),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
        foreach(string arg in Arguments) if(arg=="--type"||arg.StartsWith("--type=",StringComparison.Ordinal)) IsChild=true;
        Alive();
      } catch { Dispose(); throw; }
    }
    public void VerifyRoot(string userData) {
      if(IsChild) throw new InvalidOperationException();
      int matches=0;
      for(int i=1;i<Arguments.Length;i++) {
        string arg=Arguments[i], value=null;
        if(arg=="--user-data-dir") { if(++i>=Arguments.Length) throw new InvalidOperationException(); value=Arguments[i]; }
        else if(arg.StartsWith("--user-data-dir=",StringComparison.Ordinal)) value=arg.Substring(16);
        if(value!=null) { matches++; if(!String.Equals(FullPath(value),FullPath(userData),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException(); }
      }
      if(matches!=1) throw new InvalidOperationException();
    }
    public void Alive() { if(handle==IntPtr.Zero||WaitForSingleObject(handle,0)!=258) throw new InvalidOperationException(); }
    public void RequestClose() {
      Alive(); List<IntPtr> windows=new List<IntPtr>();
      EnumWindows(delegate(IntPtr hwnd,IntPtr state) { uint pid; GetWindowThreadProcessId(hwnd,out pid); if(pid==Pid&&IsWindowVisible(hwnd)&&GetWindow(hwnd,4)==IntPtr.Zero) windows.Add(hwnd); return true; },IntPtr.Zero);
      if(windows.Count==0) throw new InvalidOperationException();
      foreach(IntPtr window in windows) { Alive(); if(!PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException(); }
    }
    public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
  }
}
`
const NATIVE = `Add-Type -TypeDefinition @'\n${NATIVE_SOURCE}\n'@;\n`

const INSTALLATION_BODY = String.raw`
$exe=[IO.Path]::GetFullPath([string]$payload.executablePath);
if ($exe -ine [string]$payload.executablePath -or [IO.Path]::GetFileName($exe) -ine 'Kiro.exe' -or $exe -notmatch '^[A-Za-z]:\\') { throw 'path' };
$item=Get-Item -LiteralPath $exe -Force;
if ($item.PSIsContainer) { throw 'file' };
while ($null -ne $item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' };
  if ($item -is [IO.FileInfo]) { $item=$item.Directory } else { $item=$item.Parent };
};
$stream=[IO.File]::Open($exe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
$reader=New-Object IO.BinaryReader($stream,[Text.Encoding]::UTF8,$true);
if ($reader.ReadUInt16() -ne 23117 -or $stream.Length -lt 64) { throw 'PE' };
$stream.Position=60; $peOffset=$reader.ReadUInt32();
if ($peOffset -gt $stream.Length-24) { throw 'PE' };
$stream.Position=$peOffset; if ($reader.ReadUInt32() -ne 17744) { throw 'PE' };
$signature=Get-AuthenticodeSignature -LiteralPath $exe;
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'signature' };
$publisher=$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);
if ($publisher -notin @($payload.trustedPublishers)) { throw 'publisher' };
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName -cne 'Kiro') { throw 'product' };
$productPath=Join-Path ([IO.Path]::GetDirectoryName($exe)) 'resources\app\product.json';
$item=Get-Item -LiteralPath $productPath -Force;
while ($null -ne $item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' };
  if ($item -is [IO.FileInfo]) { $item=$item.Directory } else { $item=$item.Parent };
};
$product=Get-Content -LiteralPath $productPath -Raw -Encoding UTF8 | ConvertFrom-Json;
if ([string]$product.version -notmatch '^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$') { throw 'version' };
$portableSupported=$product.PSObject.Properties.Name -notcontains 'target';
if (-not $portableSupported) {
  $hkcu=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\kiro\shell\open\command');
  $hkcr=[Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('kiro\shell\open\command');
  try {
    $commands=@(); if ($null -ne $hkcu) { $commands+=,$hkcu.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) };
    if ($null -eq $hkcr) { throw 'protocol' }; $commands+=,$hkcr.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);
    foreach ($command in $commands) {
      if ($command -isnot [string]) { throw 'protocol' };
      $arguments=[KiroNative]::Args($command);
      if ($arguments.Length -ne 4 -or $arguments[0] -ine $exe -or $arguments[1] -cne '--open-url' -or $arguments[2] -cne '--' -or $arguments[3] -cne '%1') { throw 'protocol' };
    }
  } finally { if ($null -ne $hkcu) {$hkcu.Dispose()}; if ($null -ne $hkcr) {$hkcr.Dispose()} };
};
`

export const INSPECT_KIRO_INSTALLATION_SCRIPT = PREFIX + NATIVE + `
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json; $stream=$null;
try { ${INSTALLATION_BODY}
[pscustomobject]@{version=[string]$product.version; publisher=$publisher; portableSupported=[bool]$portableSupported} | ConvertTo-Json -Compress;
} finally { if ($null -ne $stream) {$stream.Dispose()} }
`

export const INSPECT_KIRO_PROCESSES_SCRIPT = PREFIX + String.raw`
$complete=$true; $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$rows=@(Get-CimInstance Win32_Process -Filter "Name='Kiro.exe'" | ForEach-Object {
  $process=$_; $owner=$null;
  try { $response=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid; if ($response.ReturnValue -eq 0) {$owner=[string]$response.Sid} } catch {};
  $created=$null; if ($null -ne $process.CreationDate) {$created=$process.CreationDate.ToUniversalTime().ToString('o')};
  if (-not $owner -or -not $process.ExecutablePath -or -not $process.CommandLine -or -not $created -or -not $process.ProcessId -or $null -eq $process.ParentProcessId) {$complete=$false};
  [pscustomobject]@{pid=[int]$process.ProcessId; parentPid=[int]$process.ParentProcessId; ownerSid=$owner; executablePath=[string]$process.ExecutablePath; startedAt=$created; commandLine=[string]$process.CommandLine}
});
[pscustomobject]@{complete=[bool]$complete; currentSid=$currentSid; processes=$rows} | ConvertTo-Json -Depth 4 -Compress;
`

export const LAUNCH_KIRO_INSTANCE_SCRIPT = PREFIX + NATIVE + `
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json; $stream=$null;
try { ${INSTALLATION_BODY}
$start=New-Object Diagnostics.ProcessStartInfo;
$start.FileName=$exe; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.WorkingDirectory=[string]$payload.cwd;
$start.Arguments=[string]$payload.argumentLine;
$start.EnvironmentVariables.Clear();
foreach ($property in $payload.env.PSObject.Properties) { if ($null -ne $property.Value) {$start.EnvironmentVariables[$property.Name]=[string]$property.Value} };
$process=[Diagnostics.Process]::Start($start);
if ($null -eq $process) {throw 'launch'}; $process.Dispose(); Write-Output 'requested';
} finally { if ($null -ne $stream) {$stream.Dispose()} }
`

export const CLOSE_KIRO_INSTANCE_SCRIPT = PREFIX + NATIVE + String.raw`
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$held=New-Object 'System.Collections.Generic.List[KiroNative+HeldProcess]';
try {
  $rows=@($payload.processes); if ($rows.Count -lt 1 -or $rows.Count -gt 256) {throw 'count'};
  $byPid=@{}; $roots=@();
  foreach ($row in $rows) {
    if ($byPid.ContainsKey([int]$row.pid) -or [string]$row.ownerSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {throw 'identity'};
    $process=New-Object KiroNative+HeldProcess([int]$row.pid,[int]$row.parentPid,[string]$row.executablePath,[string]$row.startedAt,[string]$row.ownerSid);
    $held.Add($process); $byPid[[int]$row.pid]=$row;
    if (-not $process.IsChild) {$process.VerifyRoot([string]$row.userDataPath); $roots+=,$process};
  };
  if ($roots.Count -ne 1) {throw 'root'};
  foreach ($row in $rows) {
    $cursor=$row; $visited=@{};
    while ([int]$cursor.pid -ne $roots[0].Pid) {
      if ($visited.ContainsKey([int]$cursor.pid) -or -not $byPid.ContainsKey([int]$cursor.parentPid)) {throw 'orphan'};
      $visited[[int]$cursor.pid]=$true; $parent=$byPid[[int]$cursor.parentPid];
      if ([string]$parent.executablePath -ine [string]$row.executablePath -or [string]$parent.userDataPath -ine [string]$row.userDataPath) {throw 'group'};
      $cursor=$parent;
    };
  };
  foreach ($process in $held) {$process.Alive()};
  $roots[0].RequestClose(); Write-Output 'requested';
} finally { foreach ($process in $held) {$process.Dispose()} }
`

export const ASSERT_KIRO_DIRECTORY_SCRIPT = PREFIX + String.raw`
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$path=[IO.Path]::GetFullPath([string]$payload.path);
if ($path -ine [string]$payload.path -or $path -notmatch '^[A-Za-z]:\\') {throw 'path'};
while (-not (Test-Path -LiteralPath $path)) {
  $parent=[IO.Path]::GetDirectoryName($path); if (-not $parent -or $parent -eq $path) {throw 'directory'}; $path=$parent;
};
$item=Get-Item -LiteralPath $path -Force;
if (-not $item.PSIsContainer) {throw 'directory'};
while ($null -ne $item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse'};
  $item=$item.Parent;
}; Write-Output 'verified';
`

export const ASSERT_KIRO_DIRECTORIES_SCRIPT = PREFIX + String.raw`
$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$paths=@($payload.paths); if ($paths.Count -lt 1 -or $paths.Count -gt 64) {throw 'paths'};
$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase);
foreach ($value in $paths) {
  $path=[IO.Path]::GetFullPath([string]$value);
  if ($path -ine [string]$value -or $path -notmatch '^[A-Za-z]:\\') {throw 'path'};
  while (-not (Test-Path -LiteralPath $path)) {
    $parent=[IO.Path]::GetDirectoryName($path); if (-not $parent -or $parent -eq $path) {throw 'directory'}; $path=$parent;
  };
  $item=Get-Item -LiteralPath $path -Force;
  if (-not $item.PSIsContainer) {throw 'directory'};
  while ($null -ne $item) {
    if (-not $seen.Add($item.FullName)) {break};
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse'};
    $item=$item.Parent;
  };
}; Write-Output 'verified';
`

export const executeKiroWindowsPowerShell: WindowsPowerShellExecutor = (script, payload) => {
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || !systemRoot || !/^[a-z]:\\windows$/i.test(systemRoot)) return Promise.reject(new Error(SYSTEM_FAILURE))
  const child = spawn(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, 'System32') }
    })
  const result = collectPowerShellOutput(child, script === LAUNCH_KIRO_INSTANCE_SCRIPT)
  child.stdin.on('error', () => {})
  child.stdin.end(payload === undefined ? '' : JSON.stringify(payload))
  return result
}

/** A launched GUI can inherit pipes after PowerShell exits. Its lifetime is not the helper lifetime. */
export function collectPowerShellOutput(child: ChildProcessWithoutNullStreams, launchHelper: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''; let settled = false; let exitCode: number | null | undefined
    const finish = (code: number | null, failed = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Detaching inherited pipes never closes or kills the launched GUI process.
      if (launchHelper || failed) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy() }
      if (!failed && code === 0) resolve(output.trim())
      else reject(new Error(SYSTEM_FAILURE))
    }
    const timer = setTimeout(() => { child.kill(); finish(null, true) }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length + chunk.length <= 4_000_000) output += chunk
      else { child.kill(); finish(null, true); return }
      // Both orders are possible: the final output chunk may arrive just after exit.
      if (launchHelper && exitCode === 0 && output.trim() === 'requested') finish(0)
    })
    child.stderr.resume()
    child.once('error', () => finish(null, true))
    child.once('exit', code => {
      exitCode = code
      if (launchHelper && (code !== 0 || output.trim() === 'requested')) finish(code)
    })
    child.once('close', code => finish(code))
  })
}

function quoteArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}
function validLocalPath(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && !/[\x00-\x1f"<>|?*]/.test(value) &&
    value.length < 260 && value.slice(3).split('\\').every(segment => !!segment && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment) && !segment.includes(':')) && win32.normalize(value) === value
}
function parseInstallation(raw: string, publishers: readonly string[]): KiroInstallationInfo {
  const row = JSON.parse(raw) as KiroInstallationInfo
  if (!row || typeof row.version !== 'string' || !/^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/.test(row.version) ||
    typeof row.publisher !== 'string' || !publishers.includes(row.publisher) || typeof row.portableSupported !== 'boolean') throw new Error(SYSTEM_FAILURE)
  return { version: row.version, publisher: row.publisher, portableSupported: row.portableSupported }
}
export function parseKiroProcessInventory(raw: string): KiroProcessInventory {
  const row = JSON.parse(raw) as KiroProcessInventory
  if (!row || typeof row.complete !== 'boolean' || typeof row.currentSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(row.currentSid) || !Array.isArray(row.processes)) throw new Error(SYSTEM_FAILURE)
  let complete = row.complete
  const seen = new Set<number>()
  const processes = row.processes.map(process => {
    if (!process || !Number.isSafeInteger(process.pid) || process.pid <= 0 || !Number.isSafeInteger(process.parentPid) || process.parentPid < 0 || seen.has(process.pid)) throw new Error(SYSTEM_FAILURE)
    seen.add(process.pid)
    if (typeof process.ownerSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(process.ownerSid) ||
      !validLocalPath(process.executablePath) || typeof process.startedAt !== 'string' || !Number.isFinite(Date.parse(process.startedAt)) ||
      typeof process.commandLine !== 'string' || !process.commandLine || process.commandLine.includes('\0')) complete = false
    return { pid: process.pid, parentPid: process.parentPid, ownerSid: process.ownerSid || undefined,
      executablePath: process.executablePath || undefined, startedAt: process.startedAt || undefined, commandLine: process.commandLine || undefined }
  })
  return { currentSid: row.currentSid, complete, processes }
}

/** No credentials, protocol writes, process termination or client patching occur in this adapter. */
export function createWindowsKiroRuntime(options: {
  trustedPublishers?: readonly string[]
  execute?: WindowsPowerShellExecutor
} = {}): KiroInstanceRuntime {
  const execute = options.execute ?? executeKiroWindowsPowerShell
  const trustedPublishers = options.trustedPublishers ?? []
  const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action() } catch { throw new Error(SYSTEM_FAILURE) }
  }
  const installationPayload = (executablePath: string) => {
    if (!validLocalPath(executablePath) || win32.basename(executablePath).toLowerCase() !== 'kiro.exe' || !trustedPublishers.length) throw new Error(SYSTEM_FAILURE)
    return { executablePath, trustedPublishers }
  }
  return {
    assertSafeDirectory: path => guarded(async () => {
      if (!validLocalPath(path) || await execute(ASSERT_KIRO_DIRECTORY_SCRIPT, { path }) !== 'verified') throw new Error(SYSTEM_FAILURE)
    }),
    assertSafeDirectories: paths => guarded(async () => {
      if (!Array.isArray(paths) || !paths.length || paths.length > 64 || paths.some(path => !validLocalPath(path)) ||
          await execute(ASSERT_KIRO_DIRECTORIES_SCRIPT, { paths }) !== 'verified') throw new Error(SYSTEM_FAILURE)
    }),
    inspectInstallation: executablePath => guarded(async () => parseInstallation(await execute(INSPECT_KIRO_INSTALLATION_SCRIPT, installationPayload(executablePath)), trustedPublishers)),
    inspectProcesses: () => guarded(async () => parseKiroProcessInventory(await execute(INSPECT_KIRO_PROCESSES_SCRIPT))),
    launch: (executablePath, args, env, cwd) => guarded(async () => {
      const payload = installationPayload(executablePath)
      if (!validLocalPath(cwd) || args.some(arg => typeof arg !== 'string' || /[\x00-\x1f]/.test(arg)) ||
        Object.entries(env).some(([key, value]) => !key || /[=\x00]/.test(key) || (value !== undefined && (typeof value !== 'string' || value.includes('\0'))))) throw new Error(SYSTEM_FAILURE)
      if (await execute(LAUNCH_KIRO_INSTANCE_SCRIPT, { ...payload, argumentLine: args.map(quoteArgument).join(' '), env, cwd }) !== 'requested') throw new Error(SYSTEM_FAILURE)
    }),
    requestClose: processes => guarded(async () => {
      if (!Array.isArray(processes) || !processes.length || processes.length > 256 || processes.some((item: KiroProcessIdentity) => !item ||
        !Number.isSafeInteger(item.pid) || item.pid <= 0 || !Number.isSafeInteger(item.parentPid) || item.parentPid < 0 ||
        !/^S-1-\d+(?:-\d+)+$/.test(item.ownerSid) || !validLocalPath(item.executablePath) || !validLocalPath(item.userDataPath) ||
        !Number.isFinite(Date.parse(item.startedAt)))) throw new Error(SYSTEM_FAILURE)
      if (await execute(CLOSE_KIRO_INSTANCE_SCRIPT, { processes }) !== 'requested') throw new Error(SYSTEM_FAILURE)
    })
  }
}

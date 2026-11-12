import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { ExternalClientTarget } from '../shared/clientSwitch'
import type { ClientSwitchRuntime } from './clientSwitch'
import { createCliAccessAdapter } from './cliAccessAdapter'
import { createCrewAccessAdapter } from './crewAccessAdapter'
import { assertCrewAccessContract, assertVerifiedCliAccessVersion, ClientCompatibilityError, crewAccessContractFiles, CREW_ACCESS_CONTRACT_FILES } from './clientCompatibility'

const exec = promisify(execFile)
export interface ClientRuntimeConfig { executablePath: string; dataHome?: string }
export interface ClientRuntimeProbe { valid: boolean; publisher: string; version: string }
export interface CrewInstallationInfo {
  executablePath: string
  pythonExecutable: string
  bundleDirectory: string
  revision: string
  version: string
}
export interface ClientRuntimeDependencies {
  readConfig(target: ExternalClientTarget): ClientRuntimeConfig | undefined
  writeConfig(target: ExternalClientTarget, config: ClientRuntimeConfig): void
  helperPath: string
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
  /** Internal test seam. Production verifies Authenticode and the installed version. */
  probeExecutable?: (path: string, target: ExternalClientTarget) => Promise<ClientRuntimeProbe>
  /** Test-only contract seam. Production reads only installed program resources. */
  verifyCompatibility?: (target: ExternalClientTarget, executablePath: string, version: string) => Promise<void>
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const regular = (value: string): boolean => { try { const s = lstatSync(value); return s.isFile() && !s.isSymbolicLink() } catch { return false } }
interface ConfigurationTicket { generation: number; snapshot: string; config: ClientRuntimeConfig | undefined }
interface CachedRuntime {
  fingerprint: string
  statFingerprint: string
  resources: string[]
  runtime: ClientSwitchRuntime
  executablePath: string
  dataHome: string
  ticket: ConfigurationTicket
}

function resourceStats(files: readonly string[]): string {
  return hash(JSON.stringify(files.map(path => {
    const stat = lstatSync(path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsupported-client-resource')
    return [realpathSync(path), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino), String(stat.dev)]
  })))
}

/** Small runtime resources are hashed once per cache miss; the large EXE is verified by Authenticode. */
function resourceContents(files: readonly string[]): string {
  const digest = createHash('sha256')
  for (const path of files.slice(1)) {
    const stat = lstatSync(path)
    if (stat.size > 32 * 1024 * 1024) throw new Error('unsupported-client-resource')
    digest.update(path).update('\0').update(readFileSync(path)).update('\0')
  }
  return digest.digest('hex')
}

/** Installed-client discovery has no auth reads, login commands, or client startup.
 * Resource stamps invalidate compatibility after ordinary updates/replacements. They are
 * not a tamper-proof boundary against a malicious process running as the same OS user.
 */
export class ClientRuntimeRegistry {
  private readonly deps: ClientRuntimeDependencies
  private readonly platform: NodeJS.Platform
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly cache = new Map<ExternalClientTarget, CachedRuntime>()
  private readonly pending = new Map<ExternalClientTarget, { ticket: ConfigurationTicket; task: Promise<ClientSwitchRuntime | undefined> }>()
  private readonly generations = new Map<ExternalClientTarget, number>()
  private readonly observedConfig = new Map<ExternalClientTarget, string>()
  private localDataHome: Promise<string> | undefined
  constructor(deps: ClientRuntimeDependencies) {
    this.deps = deps; this.platform = deps.platform ?? process.platform; this.home = deps.home ?? homedir(); this.env = deps.env ?? process.env
  }

  private configuration(target: ExternalClientTarget): { snapshot: string; config: ClientRuntimeConfig | undefined } {
    const saved = this.deps.readConfig(target)
    if (saved !== undefined && (!saved || typeof saved !== 'object' || typeof saved.executablePath !== 'string' ||
        !isAbsolute(saved.executablePath) || saved.dataHome !== undefined && (typeof saved.dataHome !== 'string' || !isAbsolute(saved.dataHome)))) {
      throw new Error('invalid-client-configuration')
    }
    const config = saved === undefined ? undefined : { executablePath: saved.executablePath,
      ...(saved.dataHome === undefined ? {} : { dataHome: saved.dataHome }) }
    return { config, snapshot: JSON.stringify(config ?? null) }
  }

  private invalidate(target: ExternalClientTarget): number {
    const generation = (this.generations.get(target) ?? 0) + 1
    this.generations.set(target, generation)
    this.cache.delete(target)
    this.pending.delete(target)
    return generation
  }

  private ticket(target: ExternalClientTarget): ConfigurationTicket {
    const current = this.configuration(target)
    if (this.observedConfig.get(target) !== current.snapshot) {
      this.invalidate(target)
      this.observedConfig.set(target, current.snapshot)
    }
    return { ...current, generation: this.generations.get(target) ?? 0 }
  }

  private current(target: ExternalClientTarget, ticket: ConfigurationTicket): boolean {
    if (this.generations.get(target) !== ticket.generation) return false
    try {
      const observed = this.configuration(target)
      if (observed.snapshot === ticket.snapshot) return true
      this.invalidate(target)
      this.observedConfig.set(target, observed.snapshot)
    } catch { this.invalidate(target) }
    return false
  }

  private resources(executablePath: string, target: ExternalClientTarget): string[] {
    if (target === 'cli') return [executablePath]
    const backend = join(dirname(executablePath), 'resources/backend-dist/kirocrew-backend')
    const packages = join(backend, 'Lib/site-packages')
    const metadata = readdirSync(packages, { withFileTypes: true }).filter(entry => /^kirocrew-\d+\.\d+\.\d+\.dist-info$/.test(entry.name))
    if (metadata.length !== 1 || !metadata[0].isDirectory() || metadata[0].isSymbolicLink()) throw new ClientCompatibilityError('unsupported-client-contract')
    return [executablePath, join(backend, 'python.exe'), join(backend, 'python3.dll'), join(backend, 'python312.dll'),
      join(backend, 'BUILD'), join(packages, metadata[0].name, 'METADATA'),
      ...(this.deps.verifyCompatibility ? CREW_ACCESS_CONTRACT_FILES : crewAccessContractFiles(backend))
        .map(module => join(packages, 'kiro_crew', module)), this.deps.helperPath]
  }

  private validateCrewMetadata(files: readonly string[], expectedVersion: string): void {
    const metadata = files.find(path => path.endsWith('METADATA'))
    if (!metadata || lstatSync(metadata).size > 1024 * 1024) throw new ClientCompatibilityError('unsupported-client-contract')
    const text = readFileSync(metadata, 'utf8')
    if (!/^Name: kirocrew\r?$/m.test(text) || text.match(/^Version: (\d+\.\d+\.\d+)\r?$/m)?.[1] !== expectedVersion ||
        basename(dirname(metadata)) !== `kirocrew-${expectedVersion}.dist-info`) throw new ClientCompatibilityError('unsupported-client-version')
  }

  private async verifyCompatibility(target: ExternalClientTarget, executablePath: string, version: string): Promise<void> {
    if (this.deps.verifyCompatibility) await this.deps.verifyCompatibility(target, executablePath, version)
    else if (target === 'crew') assertCrewAccessContract(join(dirname(executablePath), 'resources/backend-dist/kirocrew-backend'))
  }

  private async powershell(script: string, extra: Record<string, string> = {}): Promise<string> {
    const systemRoot = this.env.SystemRoot || 'C:\\Windows'
    const { stdout } = await exec(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
        env: { ...this.env, ...extra, PSModulePath: join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules') } })
    return stdout.trim()
  }

  private async discover(target: ExternalClientTarget): Promise<string | undefined> {
    if (this.platform !== 'win32') return undefined
    const script = target === 'cli'
      ? "$r=Get-ItemProperty -LiteralPath 'HKCU:\\SOFTWARE\\Kiro\\CLI' -ErrorAction SilentlyContinue; if ($r.InstallPath) { Join-Path $r.InstallPath 'kiro-cli.exe' } else { $c=Get-Command kiro-cli.exe -CommandType Application -ErrorAction SilentlyContinue; if ($c) { $c.Source | Select-Object -First 1 } }"
      : "$r=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\67c9cbdc-0708-5589-adc4-9c43c4e62ddb' -ErrorAction SilentlyContinue; if($r.InstallLocation) { Join-Path $r.InstallLocation 'KiroCrew.exe' } else { $keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Kiro ?Crew(?:\\s+\\d.*)?$' } | ForEach-Object { if ($_.InstallLocation) { Join-Path $_.InstallLocation 'KiroCrew.exe' } elseif ($_.DisplayIcon) { $_.DisplayIcon -replace ',\\d+$','' -replace '^\"|\"$','' } } | Select-Object -First 1 }"
    const found = await this.powershell(script).catch(() => '')
    if (found && isAbsolute(found) && regular(found)) return found
    const local = this.env.LOCALAPPDATA || join(this.home, 'AppData/Local')
    const programFiles = this.env.ProgramFiles || 'C:\\Program Files'
    const candidates = target === 'cli'
      ? [join(local, 'Programs/kiro-cli/kiro-cli.exe'), join(programFiles, 'Kiro CLI/kiro-cli.exe')]
      : [join(local, 'Programs/KiroCrew/KiroCrew.exe'), join(local, 'Programs/kirocrew/KiroCrew.exe'), join(programFiles, 'KiroCrew/KiroCrew.exe')]
    return candidates.find(regular)
  }

  private async inspect(executablePath: string, target: ExternalClientTarget): Promise<{ path: string; version: string }> {
    if (this.platform !== 'win32' || !isAbsolute(executablePath) || !regular(executablePath) ||
        basename(executablePath).toLowerCase() !== (target === 'cli' ? 'kiro-cli.exe' : 'kirocrew.exe')) throw new Error('unsupported-client')
    const path = realpathSync(executablePath)
    const injected = this.deps.probeExecutable
    const result = injected ? await injected(path, target) : JSON.parse(await this.powershell(
      "$p=$env:KIRO_SWITCH_PROBE_PATH; $s=Get-AuthenticodeSignature -LiteralPath $p; $v=(Get-Item -LiteralPath $p).VersionInfo; @{valid=($s.Status -eq 'Valid'); publisher=$s.SignerCertificate.Subject; version=$v.ProductVersion} | ConvertTo-Json -Compress",
      { KIRO_SWITCH_PROBE_PATH: path })) as { valid?: boolean; publisher?: string; version?: string }
    if (!result.valid || typeof result.publisher !== 'string' || !/Amazon(?: Web Services|\.com)/i.test(result.publisher)) throw new Error('unverified-publisher')
    let version = result.version || ''
    if (target === 'cli' && !injected) {
      // The official --version path was verified not to initialize auth storage.
      const { stdout } = await exec(path, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096, env: this.env })
      version = stdout.trim().match(/^kiro-cli\s+(\d+\.\d+\.\d+)$/)?.[1] || ''
    } else version = version.trim().match(/^(\d+\.\d+\.\d+)(?:\.0)?$/)?.[1] || ''
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ClientCompatibilityError('unsupported-client-version')
    if (target === 'cli') assertVerifiedCliAccessVersion(version)
    return { path, version }
  }

  async configure(target: ExternalClientTarget, executablePath: string): Promise<void> {
    if (target !== 'cli' && target !== 'crew') throw new Error('invalid-client')
    const ticket = this.ticket(target)
    ticket.generation = this.invalidate(target)
    const files = this.resources(executablePath, target)
    const before = resourceStats(files)
    const verified = await this.inspect(executablePath, target)
    if (!this.current(target, ticket) || resourceStats(files) !== before) throw new Error('client-configuration-changed')
    if (target === 'crew') this.validateCrewMetadata(files, verified.version)
    await this.verifyCompatibility(target, verified.path, verified.version)
    if (!this.current(target, ticket) || resourceStats(this.resources(verified.path, target)) !== before) throw new Error('client-configuration-changed')
    this.deps.writeConfig(target, { executablePath: verified.path })
    this.invalidate(target)
    this.observedConfig.set(target, this.configuration(target).snapshot)
  }

  get(target: ExternalClientTarget): Promise<ClientSwitchRuntime | undefined> {
    if (target !== 'cli' && target !== 'crew' || this.platform !== 'win32') return Promise.resolve(undefined)
    let ticket: ConfigurationTicket
    try { ticket = this.ticket(target) } catch { this.invalidate(target); return Promise.resolve(undefined) }
    const pending = this.pending.get(target)
    if (pending && pending.ticket.generation === ticket.generation && pending.ticket.snapshot === ticket.snapshot) return pending.task
    const task = this.resolve(target, ticket).finally(() => { if (this.pending.get(target)?.task === task) this.pending.delete(target) })
    this.pending.set(target, { ticket, task })
    return task
  }

  /** Describes the same verified official installation used by native switching.
   * The repair service owns model-file checks and never receives account data here.
   */
  async crewInstallation(): Promise<CrewInstallationInfo | undefined> {
    const runtime = await this.get('crew')
    const cached = this.cache.get('crew')
    if (!runtime || !cached || cached.runtime !== runtime || !this.adapter(runtime.id)) return undefined
    const bundleDirectory = join(dirname(cached.executablePath), 'resources/backend-dist/kirocrew-backend')
    return { executablePath: cached.executablePath, pythonExecutable: join(bundleDirectory, 'python.exe'),
      bundleDirectory, revision: runtime.revision, version: runtime.version }
  }

  adapter(runtimeId: string): ClientSwitchRuntime['adapter'] | undefined {
    for (const [target, cached] of this.cache) if (cached.runtime.id === runtimeId) {
      try {
        if (this.current(target, cached.ticket) && resourceStats(this.resources(cached.executablePath, target)) === cached.statFingerprint) return cached.runtime.adapter
      } catch { /* A removed or updated client invalidates its old adapter. */ }
      this.cache.delete(target)
      return undefined
    }
    return undefined
  }

  private async resolve(target: ExternalClientTarget, ticket: ConfigurationTicket): Promise<ClientSwitchRuntime | undefined> {
    const config = ticket.config
    const candidate = config?.executablePath || this.cache.get(target)?.executablePath || await this.discover(target)
    if (!this.current(target, ticket)) return undefined
    if (!candidate || !regular(candidate)) { this.cache.delete(target); return undefined }
    let dataHome = config?.dataHome
    if (!dataHome) {
      if (target === 'crew') dataHome = this.env.KIROCREW_HOME && isAbsolute(this.env.KIROCREW_HOME) ? this.env.KIROCREW_HOME : join(this.home, '.kiro/crew')
      else {
        // Native CLI uses Windows KnownFolder, which can differ from LOCALAPPDATA.
        this.localDataHome ??= this.powershell("[Environment]::GetFolderPath('LocalApplicationData')").catch(error => {
          this.localDataHome = undefined
          throw error
        })
        const local = await this.localDataHome
        if (!local || !isAbsolute(local)) return undefined
        dataHome = join(local, 'kiro-cli')
      }
    }
    if (!this.current(target, ticket)) return undefined
    if (!isAbsolute(dataHome)) return undefined
    dataHome = resolve(dataHome)
    const files = this.resources(candidate, target)
    const stats = resourceStats(files)
    const cached = this.cache.get(target)
    if (cached?.ticket.generation === ticket.generation && cached.statFingerprint === stats && cached.dataHome === dataHome) return cached.runtime
    this.cache.delete(target)
    const verified = await this.inspect(candidate, target)
    if (!this.current(target, ticket) || resourceStats(files) !== stats) return undefined
    if (target === 'crew') this.validateCrewMetadata(files, verified.version)
    await this.verifyCompatibility(target, verified.path, verified.version)
    const contents = resourceContents(files)
    if (resourceStats(this.resources(verified.path, target)) !== stats || !this.current(target, ticket)) return undefined
    const fingerprint = hash(JSON.stringify([verified.path, stats, contents, dataHome, ticket.snapshot]))
    const id = `${target}:${hash(verified.path.toLowerCase()).slice(0, 24)}`
    const domain = `${target}:${hash(dataHome.toLowerCase())}`
    const adapter = target === 'cli'
      ? createCliAccessAdapter({ databasePath: join(dataHome, 'data.sqlite3'), authDomainId: domain })
      : createCrewAccessAdapter({ pythonExecutable: join(dirname(verified.path), 'resources/backend-dist/kirocrew-backend/python.exe'),
        helperPath: this.deps.helperPath, dataHome, authDomainId: domain })
    const runtime: ClientSwitchRuntime = {
      id, target, revision: fingerprint, version: verified.version, adapter,
      isRunning: async () => {
        if (!this.current(target, ticket) || resourceStats(this.resources(verified.path, target)) !== stats) throw new Error('client-configuration-changed')
        const filter = target === 'cli' ? "Name = 'kiro-cli.exe'" : "Name = 'KiroCrew.exe' OR Name = 'python.exe' OR Name = 'node.exe' OR Name = 'kirocrew.exe'"
        const script = `$p=Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction Stop; $found=@($p | Where-Object { ` +
          (target === 'cli' ? '$true' : "$_.Name -eq 'KiroCrew.exe' -or $_.Name -eq 'kirocrew.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:KIRO_SWITCH_CLIENT_ROOT,[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -match 'kiro_crew|kirocrew.*gateway')") +
          ' }); [bool]($found.Count -gt 0) | ConvertTo-Json -Compress'
        return JSON.parse(await this.powershell(script, { KIRO_SWITCH_CLIENT_ROOT: `${dirname(verified.path)}\\` })) === true
      }
    }
    if (!this.current(target, ticket)) return undefined
    this.cache.set(target, { fingerprint, statFingerprint: stats, resources: files, runtime, executablePath: candidate, dataHome, ticket })
    return runtime
  }
}

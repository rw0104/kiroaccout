import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import type { KiroInstallationCandidate, KiroInstallationDiscovery } from '../shared/kiroInstances'
import type { KiroInstanceRuntime, KiroProcessInventory } from './kiroInstanceRuntimeTypes'
import { canonicalWindowsPath, equalWindowsPath } from './kiroInstancePaths'

const execFileAsync = promisify(execFile)
const REGISTRY_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Kiro.exe',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Kiro.exe',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Kiro.exe',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
]

export interface KiroInstallationDiscoveryDependencies {
  platform?: string
  env?: NodeJS.ProcessEnv
  runtime: Pick<KiroInstanceRuntime, 'inspectInstallation' | 'inspectProcesses'>
  /** Injectable for tests; production implementation only reads registry values. */
  readRegistry?: () => Promise<string[]>
  /** Injectable for tests; production discovery does not need to stat candidate files. */
  commonPaths?: () => string[]
}

function isKiroExe(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return win32.basename(canonicalWindowsPath(value)).toLowerCase() === 'kiro.exe' } catch { return false }
}

function pathFromRegistryValue(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = value.trim().replace(/%([^%]+)%/g, (_match, name: string) => env[name] ?? _match)
  if (!raw) return null
  // App Paths and uninstall DisplayIcon values may include a quoted executable
  // followed by arguments. Keep only the executable path and reject expansions.
  const quoted = raw.match(/^"([^\"]+\.exe)"(?:\s|,|$)/i)?.[1]
  const first = quoted ?? raw.split(/\s+/)[0].replace(/^"|"$/g, '')
  if (isKiroExe(first)) return canonicalWindowsPath(first)
  if (/\\Kiro(?:\.exe)?$/i.test(first)) {
    try { return canonicalWindowsPath(win32.join(first, 'Kiro.exe')) }
    catch { return null }
  }
  return null
}

function parseRegOutput(output: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s{2,}/)
    if (fields.length < 2 || !/^REG_/i.test(fields[1])) continue
    const path = pathFromRegistryValue(fields.slice(2).join('  '), env)
    if (path) paths.push(path)
  }
  return paths
}

async function readRegistryDefaults(): Promise<string[]> {
  const paths: string[] = []
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const regExe = win32.join(systemRoot, 'System32', 'reg.exe')
  for (const key of REGISTRY_KEYS) {
    try {
      const result = await execFileAsync(regExe, ['query', key, '/s'], { windowsHide: true, maxBuffer: 1024 * 1024 })
      paths.push(...parseRegOutput(String(result.stdout)))
    } catch {
      // Missing keys and access-denied hives are expected; other sources remain usable.
    }
  }
  return paths
}

function commonWindowsPaths(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env['ProgramW6432'], env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.APPDATA]
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z]:\\/.test(value))
  const suffixes = [
    ['Kiro', 'Kiro.exe'],
    ['Amazon', 'Kiro', 'Kiro.exe'],
    ['Kiro', 'bin', 'Kiro.exe'],
    ['Programs', 'Kiro', 'Kiro.exe'],
    ['Programs', 'Amazon', 'Kiro', 'Kiro.exe']
  ]
  return roots.flatMap(root => suffixes.map(suffix => win32.join(root, ...suffix)))
}

function processPaths(inventory: KiroProcessInventory): string[] {
  if (!inventory.complete) return []
  return inventory.processes.map(row => row.executablePath).filter(isKiroExe)
}

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>(), result: string[] = []
  for (const value of paths) {
    let canonical: string
    try { canonical = canonicalWindowsPath(value) } catch { continue }
    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key); result.push(canonical)
  }
  return result
}

/** Read-only host installation discovery. Every candidate is validated by the signed/product-aware runtime. */
export class KiroInstallationDiscoveryService {
  private readonly deps: Required<Pick<KiroInstallationDiscoveryDependencies, 'platform' | 'env'>> &
    Omit<KiroInstallationDiscoveryDependencies, 'platform' | 'env'>
  constructor(deps: KiroInstallationDiscoveryDependencies) {
    this.deps = {
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      ...deps
    }
  }

  async discover(): Promise<KiroInstallationDiscovery> {
    if (this.deps.platform !== 'win32') return { supported: false, candidates: [], message: '目前仅支持 Windows Kiro 客户端发现。' }
    let inventory: KiroProcessInventory = { complete: false, currentSid: '', processes: [] }
    try { inventory = await this.deps.runtime.inspectProcesses() } catch { /* registry/common paths can still be checked */ }
    let registry: string[] = []
    try { registry = await (this.deps.readRegistry ?? readRegistryDefaults)() } catch { registry = [] }
    const common = this.deps.commonPaths ? this.deps.commonPaths() : commonWindowsPaths(this.deps.env)
    const ordered = [
      ...processPaths(inventory),
      ...registry,
      ...common
    ]
    const candidates: KiroInstallationCandidate[] = []
    const seen = new Set<string>()
    for (const path of dedupe(ordered)) {
      let info
      try { info = await this.deps.runtime.inspectInstallation(path) } catch { continue }
      const key = path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const source: KiroInstallationCandidate['source'] = processPaths(inventory).some(row => equalWindowsPath(row, path))
        ? 'running-process' : registry.some(row => equalWindowsPath(row, path)) ? 'registry' : 'common-path'
      candidates.push({ path, version: info.version, publisher: info.publisher, portableSupported: info.portableSupported, source })
    }
    return {
      supported: true,
      candidates,
      ...(candidates.length ? {} : { message: '未找到可验证的官方 Kiro.exe，请确认客户端已安装。' })
    }
  }
}

export function createWindowsKiroInstallationDiscovery(deps: Omit<KiroInstallationDiscoveryDependencies, 'platform'> & { platform?: string }): KiroInstallationDiscoveryService {
  return new KiroInstallationDiscoveryService(deps)
}

export { parseRegOutput, pathFromRegistryValue, commonWindowsPaths }

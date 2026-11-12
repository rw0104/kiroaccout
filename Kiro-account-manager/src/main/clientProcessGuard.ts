import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export interface CrewProcessInstallation { executablePath: string; pythonExecutable: string; bundleDirectory: string }
interface ProcessRow { Name?: string | null; ExecutablePath?: string | null; CommandLine?: string | null }
const canonical = (path: string): string => resolve(path).toLowerCase()
const failure = (code: string): Error => Object.assign(new Error(code), { code })

/** A conservative stop requirement: never terminates or signals a process. */
export function hasCrewProcess(rows: readonly ProcessRow[], installation: CrewProcessInstallation): boolean {
  const executable = canonical(installation.executablePath)
  const python = canonical(installation.pythonExecutable)
  const bundle = canonical(installation.bundleDirectory).replace(/[\\/]+$/, '')
  if (rows.some(row => !row.ExecutablePath && !row.CommandLine && /^(?:pythonw?|node|kiro[-_]agent)\.exe$/i.test(row.Name || ''))) {
    throw failure('process-state-unknown')
  }
  return rows.some(row => {
    const filename = typeof row.ExecutablePath === 'string' && isAbsolute(row.ExecutablePath) ? canonical(row.ExecutablePath) : undefined
    if (filename && (filename === executable || filename === python || filename.startsWith(bundle + '\\') || filename.startsWith(bundle + '/'))) return true
    // Missing protected process metadata is not proof that the client is stopped.
    if (!filename && /^(?:kirocrew|kiro-crew)\.exe$/i.test(row.Name || '')) return true
    return typeof row.CommandLine === 'string' && /(?:\bkiro_crew\b|\bkirocrew\b[^\r\n]*\bgateway\b)/i.test(row.CommandLine)
  })
}

export async function assertCrewStopped(installation: CrewProcessInstallation): Promise<void> {
  if (process.platform !== 'win32' || ![installation.executablePath, installation.pythonExecutable, installation.bundleDirectory].every(isAbsolute)) {
    throw failure('process-state-unknown')
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const script = '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object Name,ExecutablePath,CommandLine) | ConvertTo-Json -Compress'
  let rows: ProcessRow[]
  try {
    const result = await exec(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PSModulePath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules` } })
    const parsed: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== 'object')) throw new Error()
    rows = parsed as ProcessRow[]
  } catch { throw failure('process-state-unknown') }
  if (hasCrewProcess(rows, installation)) throw failure('client-running')
}

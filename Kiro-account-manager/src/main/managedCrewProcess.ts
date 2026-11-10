import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative } from 'node:path'
import { createCrewAccessAdapter } from './crewAccessAdapter'
import type { ManagedCrewProcess, ManagedCrewProcessState, ManagedCrewRuntime } from './managedCrew'

export interface ManagedCrewInstallation {
  executablePath: string
  pythonExecutable: string
  bundleDirectory: string
  version: string
  revision: string
}

export interface ManagedCrewProcessOptions {
  root: string
  resources: string
  accessHelper: string
  installation: ManagedCrewInstallation
  /** Only internal tests may replace process transport. Renderer input never reaches it. */
  spawn?: typeof spawn
  env?: NodeJS.ProcessEnv
  startupTimeoutMs?: number
  stopTimeoutMs?: number
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function fail(): never { throw new Error('Managed Crew workspace validation failed') }

function present(path: string): boolean {
  try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function regular(path: string, directory: boolean): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail()
}

function privateRoot(root: string): void {
  if (!isAbsolute(root) || root !== resolve(root) || !root.endsWith(join('managed-crew', 'workspace-v1'))) fail()
  for (let parent = root; ; parent = dirname(parent)) {
    if (present(parent)) regular(parent, true)
    if (parent === dirname(parent)) break
  }
}

function childPath(root: string, path: string, directory: boolean): void {
  privateRoot(root)
  const within = relative(root, path)
  if (!within || within.startsWith('..') || isAbsolute(within)) fail()
  for (let current = path; current !== root; current = dirname(current)) {
    if (present(current)) regular(current, current === path ? directory : true)
  }
}

function validateFolders(root: string): void {
  for (const part of ['home', 'home/AppData', 'home/AppData/Local', 'home/AppData/Roaming', 'home/.aws', 'data', 'data/kiro', 'workspace', 'temp']) {
    childPath(root, join(root, part), true)
  }
  for (const part of ['home/.aws/config', 'home/.aws/credentials']) childPath(root, join(root, part), false)
}

function owner(root: string, create: boolean): string | undefined {
  privateRoot(root)
  const filename = join(root, '.kiroaccout-crew-managed.json')
  if (present(filename)) {
    regular(filename, false)
    if (lstatSync(filename).size > 4096) fail()
    const data = JSON.parse(readFileSync(filename, 'utf8'))
    if (data?.schemaVersion !== 1 || !uuid(data.ownerId)) fail()
    return data.ownerId
  }
  if (!create) return undefined
  // Never adopt an existing unmarked directory containing someone else's data.
  if (present(root) && readdirSync(root).length) fail()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const ownerId = randomUUID()
  writeFileSync(filename, JSON.stringify({ schemaVersion: 1, ownerId }), { flag: 'wx', mode: 0o600 })
  return ownerId
}

export function managedCrewEnvironment(root: string, installation: ManagedCrewInstallation, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) {
    if (inherited[key]) env[key] = inherited[key]
  }
  const home = join(root, 'home')
  const system = inherited.SystemRoot || 'C:\\Windows'
  const toolDirectories = (inherited.PATH ?? '').split(';').filter(path => {
    if (!isAbsolute(path)) return false
    try { regular(path, true); return true } catch { return false }
  })
  env.PATH = [...new Set([dirname(installation.pythonExecutable), join(system, 'System32'), system, ...toolDirectories])].join(';')
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    TEMP: join(root, 'temp'), TMP: join(root, 'temp'), KIROCREW_HOME: join(root, 'data'), KIRO_HOME: join(root, 'data/kiro'),
    KIROCREW_OS_HOME: home, KIROCREW_WORKSPACE: join(root, 'workspace'),
    KIROCREW_BUNDLED_KAS_DIR: installation.bundleDirectory, KIROCREW_SKIP_MODEL_DOWNLOAD: '1', KIROCREW_SKIP_APP_STORE_FETCH: '1',
    KIROCREW_HARNESS_ADOPTION_PINS: join(root, 'no-adoption-pins.json'),
    AWS_CONFIG_FILE: join(home, '.aws/config'), AWS_SHARED_CREDENTIALS_FILE: join(home, '.aws/credentials'),
    AWS_EC2_METADATA_DISABLED: 'true', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1'
  })
  // Preserve an explicitly configured transport proxy, without inheriting model
  // API keys, AWS identities, Python hooks or another client's home overrides.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (inherited[key]) env[key] = inherited[key]
  }
  return env
}

function prepareFolders(root: string): void {
  owner(root, true)
  validateFolders(root)
  for (const part of ['home/AppData/Local', 'home/AppData/Roaming', 'home/.aws', 'data', 'data/kiro', 'workspace', 'temp']) {
    const path = join(root, part)
    childPath(root, path, true)
    if (present(path)) regular(path, true)
    else mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  for (const part of ['home/.aws/config', 'home/.aws/credentials']) {
    const path = join(root, part)
    childPath(root, path, false)
    if (present(path)) regular(path, false)
    else writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  }
}

/** No production default path or refresh credential is available to this runtime. */
export function createManagedCrewRuntime(options: ManagedCrewProcessOptions): ManagedCrewRuntime {
  const root = resolve(options.root), resources = resolve(options.resources)
  privateRoot(root)
  const installation = options.installation
  if (installation.version !== '0.12.0' || ![installation.executablePath, installation.pythonExecutable, installation.bundleDirectory, options.accessHelper].every(isAbsolute)) fail()
  const launcher = join(resources, 'launcher.py')
  for (const path of [launcher, join(resources, 'overlay.py'), join(resources, 'manifest.json'), options.accessHelper]) regular(path, false)
  const revision = hash(`${installation.revision}\0${readFileSync(join(resources, 'manifest.json'), 'utf8')}\0${hash(readFileSync(launcher))}`)
  const env = managedCrewEnvironment(root, installation, options.env)
  const spawnChild = options.spawn ?? spawn
  const runtimeId = `crew-managed:${hash(root.toLowerCase()).slice(0, 24)}`
  const domain = `crew-managed:${hash(join(root, 'data').toLowerCase())}`
  const live = new Map<string, { child: ChildProcessWithoutNullStreams; process: ManagedCrewProcess }>()

  const startChild = (args: string[]): ChildProcessWithoutNullStreams => {
    const child = spawnChild(installation.pythonExecutable, ['-I', '-B', launcher, ...args],
      { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    // A gateway can exit between the ownership check and the control write.
    // Its close/status paths decide the outcome; EPIPE must not crash Electron.
    child.stdin.on('error', () => {})
    return child
  }

  const command = async (args: string[], timeout: number): Promise<Record<string, unknown>> => {
    const child = startChild(args)
    let buffer = '', result: Record<string, unknown> | undefined
    child.stdin.end()
    child.stderr.on('data', () => {})
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (error) reject(error)
        else result ? resolve(result) : reject(new Error('Managed Crew helper did not return a result'))
      }
      const timer = setTimeout(() => { child.kill(); finish(new Error('Managed Crew helper timed out')) }, timeout)
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8')
        if (buffer.length > 64 * 1024) { child.kill(); finish(new Error('Invalid helper output')); return }
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          try {
            const value = JSON.parse(line)
            if (value && typeof value === 'object' && ['state', 'stopped', 'error'].includes(value.type)) result = value
          } catch { /* Raw helper text is never logged or exposed. */ }
        }
      })
      child.once('error', () => finish(new Error('Managed Crew helper failed')))
      child.once('close', code => finish(code === 0 && result?.type !== 'error' ? undefined : new Error('Managed Crew helper refused the operation')))
    })
  }

  const status = async (): Promise<ManagedCrewProcessState> => {
    const ownerId = owner(root, false)
    if (!ownerId) return { running: false }
    validateFolders(root)
    const result = await command(['status', '--root', root, '--owner', ownerId], 15000)
    if (result.type !== 'state' || typeof result.running !== 'boolean' || result.ownerId !== ownerId) fail()
    if (!result.running) return { running: false, ownerId }
    if (!uuid(result.sessionId) || !Number.isInteger(result.pid) || Number(result.pid) <= 0 || !Number.isInteger(result.port) ||
        (result.starting === true ? result.port !== 0 : Number(result.port) <= 0 || Number(result.port) >= 65536)) fail()
    return { running: true, ownerId, sessionId: result.sessionId, pid: Number(result.pid), port: Number(result.port), ...(result.starting === true ? { starting: true } : {}) }
  }

  const adapter = createCrewAccessAdapter({ pythonExecutable: installation.pythonExecutable, helperPath: options.accessHelper,
    dataHome: join(root, 'data'), authDomainId: domain }, {
    run: (_exe, args, config) => {
      // The official TokenStore helper is synchronous and has its existing 5s
      // bound. Override every home-related environment field for this workspace.
      return execFileSync(installation.pythonExecutable, [...args], { ...config, env, cwd: root, windowsHide: true })
    }
  })

  const stop = async (process: ManagedCrewProcessState): Promise<void> => {
    if (!process.running) return
    const ownerId = owner(root, false)
    if (!ownerId || process.ownerId !== ownerId || !uuid(process.sessionId) || !Number.isInteger(process.pid) || Number(process.pid) <= 0 ||
        !Number.isInteger(process.port) || (process.starting ? process.port !== 0 : Number(process.port) <= 0 || Number(process.port) > 65535)) fail()
    const tracked = live.get(process.sessionId)
    if (tracked && !tracked.child.stdin.destroyed) {
      tracked.child.stdin.write('{"type":"stop"}\n')
      tracked.child.stdin.end()
      const ended = await Promise.race([tracked.process.exited.then(() => true), new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 10000); timer.unref?.()
      })])
      if (ended && !(await status()).running) return
    }
    await command(['stop', '--root', root, '--owner', ownerId, '--session', process.sessionId,
      '--pid', String(process.pid), '--port', String(process.port)], options.stopTimeoutMs ?? 45000)
    if ((await status()).running) throw new Error('Managed Crew exit is not confirmed')
  }

  return {
    id: runtimeId, revision, version: installation.version, adapter,
    prepare: async () => { prepareFolders(root) }, status, stop,
    async launch(sessionId) {
      if (!uuid(sessionId)) fail()
      validateFolders(root)
      const ownerId = owner(root, false)
      if (!ownerId) fail()
      const child = startChild(['serve', '--root', root, '--owner', ownerId, '--session', sessionId])
      let exitedResolve!: () => void
      const exited = new Promise<void>(resolve => { exitedResolve = resolve })
      child.once('close', () => { live.delete(sessionId); exitedResolve() })
      child.stderr.on('data', () => {})
      return new Promise<ManagedCrewProcess>((resolve, reject) => {
        let buffer = '', settled = false
        const failStart = (): void => {
          if (settled) return
          settled = true; clearTimeout(timer)
          // EOF is an authenticated control channel owned by this parent. The
          // launcher must shut down its own gateway even if READY was not seen.
          child.stdin.end()
          reject(new Error('Managed Crew startup failed'))
        }
        const timer = setTimeout(failStart, options.startupTimeoutMs ?? 120000)
        child.once('error', failStart)
        child.once('close', () => { if (!settled) failStart() })
        child.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8')
          if (buffer.length > 64 * 1024) { failStart(); buffer = ''; return }
          let index: number
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
            let message: Record<string, unknown>
            try { message = JSON.parse(line) } catch { continue }
            if (!message || message.type === 'error') { failStart(); continue }
            if (message.type !== 'ready') continue
            if (message.ownerId !== ownerId || message.sessionId !== sessionId || message.pid !== child.pid ||
                !Number.isInteger(message.port) || Number(message.port) < 1 || Number(message.port) > 65535 ||
                typeof message.urlToken !== 'string' || !message.urlToken || message.urlToken.length > 16384 ||
                Array.from(message.urlToken).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) { failStart(); continue }
            if (settled) { if (!live.has(sessionId)) child.stdin.end(); continue }
            settled = true; clearTimeout(timer)
            const process: ManagedCrewProcess = { running: true, ownerId, sessionId, pid: child.pid!, port: Number(message.port), urlToken: message.urlToken, exited }
            live.set(sessionId, { child, process }); resolve(process)
          }
        })
      })
    }
  }
}

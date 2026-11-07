import { createHash } from 'node:crypto'
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ClientAccessProjectionError, type AccessCredential, type ClientAccessProjectionAdapter } from './clientAccessProjection'

const revisionFiles = ['kas/.vault/secrets.enc', 'kas/.vault/.vault_key', 'kas/signed-in', 'kas/signed-out'] as const
const maxFileBytes = 16 * 1024 * 1024
const hexRevision = /^[a-f0-9]{64}$/
const maxConfigBytes = 2 * 1024 * 1024
const preflightErrors = new Set(['invalid-request', 'target-changed', 'credential-unusable', 'unsupported-engine', 'unsupported-runtime'])

function uncertainWrite(backendConfigured = false): ClientAccessProjectionError {
  return Object.assign(new ClientAccessProjectionError('target-write-uncertain'), {
    // false means no confirmed configuration acknowledgement, not proof of a rollback.
    backendConfigured, targetWriteUncertain: true
  })
}

function crewEngineSettings(dataHome: string): [string, string, boolean] {
  const sections: Record<string, unknown>[] = []
  for (const filename of ['config.json', 'config.local.json']) {
    let content: Buffer
    const path = join(dataHome, filename)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxConfigBytes) throw new Error('invalid-config')
      content = readFileSync(path)
      if (content.length !== stat.size) throw new Error('config-changed')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      sections.push({}); continue
    }
    const data: unknown = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid-config')
    const agent = (data as Record<string, unknown>).agent
    if (agent !== undefined && (!agent || typeof agent !== 'object' || Array.isArray(agent))) throw new Error('invalid-config')
    sections.push((agent ?? {}) as Record<string, unknown>)
  }
  const agent = { ...sections[0], ...sections[1] }
  const provider = Object.hasOwn(agent, 'provider') ? agent.provider : 'acp'
  const backend = Object.hasOwn(agent, 'acp_backend') && agent.acp_backend !== '' ? agent.acp_backend : 'kas'
  const bundle = Object.hasOwn(agent, 'kas_bundle') ? agent.kas_bundle : false
  if (typeof provider !== 'string' || typeof backend !== 'string' || typeof bundle !== 'boolean') throw new Error('invalid-engine')
  return [provider, backend, bundle]
}

export interface CrewAccessAdapterOptions {
  pythonExecutable: string
  helperPath: string
  dataHome: string
  authDomainId: string
  /** Python's operation is bounded; this must not exceed five seconds. */
  timeoutMs?: number
}

export interface CrewAccessAdapterDependencies {
  run?: (executable: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string
}

function regularPath(path: string, directory: boolean): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('invalid-path')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Hashes auth state and effective engine selection, excluding unrelated UI configuration. */
export function readCrewAccessRevision(dataHome: string): string {
  if (!isAbsolute(dataHome)) throw new ClientAccessProjectionError('target-read-failed')
  const hash = createHash('sha256').update('crew-access-v1\0')
  try {
    for (const directory of [dataHome, join(dataHome, 'kas'), join(dataHome, 'kas', '.vault')]) regularPath(directory, true)
    for (const relative of revisionFiles) {
      hash.update(relative).update('\0')
      const path = join(dataHome, ...relative.split('/'))
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) throw new Error('invalid-file')
        const content = readFileSync(path)
        if (content.length !== stat.size) throw new Error('file-changed')
        hash.update('file\0').update(String(content.length)).update('\0').update(content).update('\0')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        hash.update('missing\0')
      }
    }
    return createHash('sha256').update('crew-access-v2\0').update(hash.digest('hex')).update('\0')
      .update(JSON.stringify(crewEngineSettings(dataHome))).update('\0').digest('hex')
  } catch { throw new ClientAccessProjectionError('target-read-failed') }
}

function cleanAccess(access: Readonly<AccessCredential>): AccessCredential {
  const keys = Object.keys(access)
  if (keys.some(key => !['accessToken', 'expiresAt', 'provider', 'authMethod', 'profileArn', 'region', 'startUrl'].includes(key)) ||
      typeof access.accessToken !== 'string' || !access.accessToken.trim() || access.accessToken.length > 512 * 1024 ||
      !Number.isFinite(access.expiresAt) || !['Google', 'Github', 'BuilderId', 'Enterprise'].includes(access.provider) ||
      access.authMethod !== undefined && !['social', 'IdC'].includes(access.authMethod) ||
      access.region !== undefined && (typeof access.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d+$/.test(access.region)) ||
      access.startUrl !== undefined && (typeof access.startUrl !== 'string' || access.startUrl.length > 2048) ||
      access.profileArn !== undefined && (typeof access.profileArn !== 'string' || !access.profileArn || access.profileArn.length > 4096) ||
      access.provider !== 'BuilderId' && !access.profileArn) {
    throw new ClientAccessProjectionError('credential-unusable')
  }
  const social = access.provider === 'Google' || access.provider === 'Github'
  if (access.authMethod !== undefined && access.authMethod !== (social ? 'social' : 'IdC')) throw new ClientAccessProjectionError('credential-unusable')
  return { accessToken: access.accessToken, expiresAt: access.expiresAt, provider: access.provider,
    ...(access.authMethod ? { authMethod: access.authMethod } : {}), ...(access.profileArn ? { profileArn: access.profileArn } : {}),
    ...(access.region ? { region: access.region } : {}) }
}

/** Uses the installed official Crew Python/TokenStore; no private vault implementation. */
export function createCrewAccessAdapter(options: CrewAccessAdapterOptions,
  dependencies: CrewAccessAdapterDependencies = {}): ClientAccessProjectionAdapter {
  const timeout = options.timeoutMs ?? 5000
  if (![options.pythonExecutable, options.helperPath, options.dataHome].every(isAbsolute) ||
      !options.authDomainId || !Number.isInteger(timeout) || timeout < 100 || timeout > 5000) {
    throw new Error('Invalid Crew access adapter configuration')
  }
  const dataHome = resolve(options.dataHome)
  const run = dependencies.run ?? ((executable, args, config) => execFileSync(executable, [...args], config))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:PYTHON|KIRO|AWS_|AMAZON_Q)/i.test(key)) delete env[key]
  env.KIROCREW_HOME = dataHome
  return {
    authDomainId: options.authDomainId,
    validate: access => { cleanAccess(access) },
    readRevision: async () => {
      const first = readCrewAccessRevision(dataHome)
      if (readCrewAccessRevision(dataHome) !== first) throw new ClientAccessProjectionError('target-changed')
      return first
    },
    write: async (access, expectedRevision, assertCurrent, context) => {
      const safeAccess = cleanAccess(access)
      if (!hexRevision.test(expectedRevision) || !context || typeof context.accountId !== 'string' || !context.accountId ||
          context.accountId.length > 512 || !hexRevision.test(context.principalFingerprint)) throw new ClientAccessProjectionError('invalid-request')
      const input = JSON.stringify({ version: 1, dataHome, expectedRevision, access: safeAccess,
        accountIdentity: context.principalFingerprint, explicit: context.explicit })
      // Synchronous execution prevents this manager's JS token/binding callbacks running between
      // its guard and the helper's commit. This is NOT a transaction with another manager process.
      assertCurrent()
      let output: string
      try {
        output = run(options.pythonExecutable, ['-I', '-B', options.helperPath], {
          encoding: 'utf8', input, windowsHide: true, timeout, maxBuffer: 16 * 1024,
          cwd: dirname(options.pythonExecutable), env, stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch { throw uncertainWrite() }
      let response: { ok?: unknown; revision?: unknown; error?: unknown; backendConfigured?: unknown; writeUncertain?: unknown }
      try { response = JSON.parse(output) } catch { throw uncertainWrite() }
      if (!response || typeof response !== 'object' || Array.isArray(response) || response.writeUncertain === true ||
          response.writeUncertain !== undefined && typeof response.writeUncertain !== 'boolean') {
        throw uncertainWrite(response?.backendConfigured === true)
      }
      if (response.ok === false) {
        const knownPreflight = typeof response.error === 'string' && preflightErrors.has(response.error)
        if (!knownPreflight && !(response.error === 'write-failed' && response.writeUncertain === false) ||
            response.writeUncertain !== undefined && typeof response.writeUncertain !== 'boolean') {
          throw uncertainWrite(response.backendConfigured === true)
        }
        const code = response?.error === 'target-changed' ? 'target-changed'
          : response?.error === 'credential-unusable' ? 'credential-unusable' : 'target-write-failed'
        // Config and auth are separate official transactions. Do not suggest the earlier
        // engine selection was rolled back when the later credential operation fails.
        throw Object.assign(new ClientAccessProjectionError(code), {
          backendConfigured: response.backendConfigured === true, targetWriteUncertain: false
        })
      }
      if (response.ok !== true || typeof response.revision !== 'string' || !hexRevision.test(response.revision)) {
        throw uncertainWrite(response.backendConfigured === true)
      }
      return response.revision
    }
  }
}

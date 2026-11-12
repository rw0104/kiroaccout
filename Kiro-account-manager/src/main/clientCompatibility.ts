import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CREW_ACCESS_CONTRACTS } from './crewAccessContracts'

/** These closed-source CLI contracts were exercised with synthetic credentials.
 * New model IDs do not need entries here; this table is only for local storage ABI.
 */
export const VERIFIED_CLI_ACCESS_VERSIONS: readonly string[] = Object.freeze(['3.1.0', '3.2.1'])

export class ClientCompatibilityError extends Error {
  readonly code: 'unsupported-client-version' | 'unsupported-client-contract'
  constructor(code: ClientCompatibilityError['code']) { super(code); this.name = 'ClientCompatibilityError'; this.code = code }
}

export const CREW_ACCESS_CONTRACT_FILES = Object.freeze([
  'auth/__init__.py', 'auth/store.py', 'auth/provider.py', 'auth/refresh.py',
  'secrets/__init__.py', 'secrets/vault.py', 'platform_compat.py', 'platform_lock_compat.py',
  'platform_owner_compat.py', 'platform_compat_links.py', 'windows_acl.py',
  'config/loader_document.py', 'config/loader_locations.py', 'config/sections_agent.py', 'atomic_write.py'
] as const)

export function assertVerifiedCliAccessVersion(version: string): void {
  if (!VERIFIED_CLI_ACCESS_VERSIONS.includes(version)) throw new ClientCompatibilityError('unsupported-client-version')
}

export function crewAccessContractDigest(readSource: (relativePath: string) => string, files: readonly string[] = CREW_ACCESS_CONTRACT_FILES): string {
  const hash = createHash('sha256')
  for (const path of files) hash.update(path).update('\0').update(readSource(path).replaceAll('\r\n', '\n')).update('\0')
  return hash.digest('hex')
}

function sourceReader(bundleDirectory: string): (relativePath: string) => string {
  const root = join(bundleDirectory, 'Lib/site-packages/kiro_crew')
  return relativePath => {
    const path = join(root, ...relativePath.split('/'))
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error()
    const bytes = readFileSync(path)
    if (bytes.length !== stat.size) throw new Error()
    return bytes.toString('utf8')
  }
}

/** Select by the actual access implementation, never by a permissive version range. */
export function crewAccessContractFiles(bundleDirectory: string): readonly string[] {
  try {
    const coreDigest = crewAccessContractDigest(sourceReader(bundleDirectory))
    const contract = CREW_ACCESS_CONTRACTS.find(entry => entry.coreDigest === coreDigest)
    if (!contract) throw new Error()
    return contract.files
  } catch { throw new ClientCompatibilityError('unsupported-client-contract') }
}

export function assertCrewAccessContract(bundleDirectory: string): void {
  try {
    const read = sourceReader(bundleDirectory)
    const coreDigest = crewAccessContractDigest(read)
    const contract = CREW_ACCESS_CONTRACTS.find(entry => entry.coreDigest === coreDigest)
    if (!contract || crewAccessContractDigest(read, contract.files) !== contract.digest) throw new Error()
  } catch { throw new ClientCompatibilityError('unsupported-client-contract') }
}

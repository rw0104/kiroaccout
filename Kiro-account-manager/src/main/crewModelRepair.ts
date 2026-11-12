import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { ClientModelRepairResult, ClientModelRepairState } from '../shared/clientModelRepair'

/** Supplied only by the registry after official-publisher and runtime validation. */
export interface CrewRepairInstallation {
  executablePath: string
  pythonExecutable: string
  bundleDirectory: string
  version: string
  revision: string
}
export interface CrewModelRepairDependencies {
  resourcesRoot: string
  backupRoot: string
  installation(): Promise<CrewRepairInstallation | undefined>
  /** Must reject unknown process state as well as a running selected installation. */
  assertStopped(installation: CrewRepairInstallation): Promise<void>
  /** File publication seam for offline fault-injection tests. */
  replace?: (source: string, destination: string) => void
}
interface RepairFile { target: string; resource: string; beforeSha256: string | null; afterSha256: string; normalized: boolean }
interface RepairContract { id: string; testedVersion: string; upstreamCommit: string; frontendEvent: string; files: RepairFile[]; checks?: Array<{ target: string; sha256: string }> }
interface ObservedFile { definition: RepairFile; path: string; bytes?: Buffer; rawHash: string | null; normalizedHash: string | null; patched: Buffer }
interface JournalFile { target: string; beforeSha256: string | null; afterSha256: string; backup: string | null }
interface Journal { schemaVersion: 1; installationKey: string; contractId: string; state: 'prepared' | 'applied' | 'restored' | 'interrupted'; files: JournalFile[] }
interface Snapshot {
  installation: CrewRepairInstallation
  installationKey: string
  packageRoot: string
  revision: string
  files: ObservedFile[]
  contract?: RepairContract
  kind: 'original' | 'patched' | 'mixed' | 'unknown'
  journal?: Journal
  guards: Map<string, string | null>
}
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const pathText = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.\/-]+$/.test(value) &&
  !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
const normalized = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'))
const pathIdentity = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)

export class CrewModelRepairError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'CrewModelRepairError'; this.code = code }
}
function fail(code: string): never { throw new CrewModelRepairError(code) }
const errorCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'repair-unavailable'

function noLinks(filename: string): void {
  for (let current = resolve(filename); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) fail('linked-path') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (dirname(current) === current) break
  }
}
function boundedFile(filename: string, absent = false, limit = 16 * 1024 * 1024): Buffer | undefined {
  noLinks(filename)
  let before
  try { before = lstatSync(filename) }
  catch (error) { if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!before.isFile() || before.nlink > 1 || before.size > limit) fail('invalid-file')
  const bytes = readFileSync(filename), after = lstatSync(filename)
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) fail('installation-changed')
  return bytes
}
function regularDirectory(directory: string): void {
  noLinks(directory)
  if (!lstatSync(directory).isDirectory()) fail('invalid-directory')
}
function fileIdentity(filename: string): unknown[] {
  noLinks(filename)
  const stat = lstatSync(filename)
  if (!stat.isFile() || stat.nlink > 1) fail('invalid-installation')
  return [pathIdentity(filename), stat.dev, stat.ino, stat.size, stat.mtimeMs]
}
function inside(root: string, relative: string): string {
  if (!pathText(relative)) fail('invalid-resource')
  const target = resolve(root, ...relative.split('/'))
  if (!pathIdentity(target).startsWith(pathIdentity(root) + sep)) fail('invalid-resource')
  return target
}

/** Version-independent source-contract repair; never copies or opens account data. */
export class CrewModelRepairService {
  private readonly deps: CrewModelRepairDependencies
  private readonly contracts: RepairContract[]
  private pending = false
  constructor(deps: CrewModelRepairDependencies) {
    if (!isAbsolute(deps.resourcesRoot) || !isAbsolute(deps.backupRoot)) fail('invalid-configuration')
    this.deps = deps
    const manifest = JSON.parse(boundedFile(join(deps.resourcesRoot, 'manifest.json'))!.toString()) as {
      schemaVersion?: number; license?: string; upstream?: string; contracts?: RepairContract[]
    }
    if (manifest.schemaVersion !== 1 || manifest.license !== 'Apache-2.0' || manifest.upstream !== 'https://github.com/kirodotdev/KiroCrew' ||
        !Array.isArray(manifest.contracts) || manifest.contracts.length < 1 || manifest.contracts.length > 16) fail('invalid-resources')
    for (const contract of manifest.contracts) {
      if (!/^[A-Za-z0-9.-]{1,100}$/.test(contract.id) || !/^\d+\.\d+\.\d+$/.test(contract.testedVersion) ||
          !/^[a-f0-9]{40}$/.test(contract.upstreamCommit) || !Array.isArray(contract.files) || contract.files.length < 1 || contract.files.length > 16) fail('invalid-resources')
      const targets = new Set<string>()
      if (contract.checks !== undefined && (!Array.isArray(contract.checks) || contract.checks.length > 4 ||
          contract.checks.some(check => !/^static\/dist\/assets\/useWebSocket-[A-Za-z0-9_-]+\.js$/.test(check.target) || !hex(check.sha256)))) fail('invalid-resources')
      for (const file of contract.files) {
        if (!pathText(file.target) || !pathText(file.resource) || targets.has(file.target) ||
            file.beforeSha256 !== null && !hex(file.beforeSha256) || !hex(file.afterSha256) || typeof file.normalized !== 'boolean') fail('invalid-resources')
        if (!/^(?:agent_sdk|acp|dashboard)\/[A-Za-z0-9_/]+\.py$/.test(file.target) && !/^static\/dist\/assets\/useWebSocket-[A-Za-z0-9_-]+\.js(?:\.br|\.gz)?$/.test(file.target)) fail('invalid-resource')
        targets.add(file.target)
        if (digest(boundedFile(inside(deps.resourcesRoot, file.resource))!) !== file.afterSha256) fail('resource-hash-mismatch')
      }
    }
    this.contracts = manifest.contracts
  }

  private backupDirectory(key: string): string {
    if (!hex(key)) fail('invalid-backup')
    return inside(this.deps.backupRoot, key)
  }
  private readJournal(key: string, contract?: RepairContract): Journal | undefined {
    const bytes = boundedFile(join(this.backupDirectory(key), 'journal.json'), true, 128 * 1024)
    if (!bytes) return undefined
    const journal = JSON.parse(bytes.toString()) as Journal
    const known = this.contracts.find(item => item.id === journal.contractId)
    if (journal.schemaVersion !== 1 || journal.installationKey !== key || !known || contract && known.id !== contract.id ||
        !['prepared', 'applied', 'restored', 'interrupted'].includes(journal.state) || !Array.isArray(journal.files) || journal.files.length !== known.files.length) fail('invalid-backup')
    for (let index = 0; index < journal.files.length; index++) {
      const file = journal.files[index], expected = known.files[index]
      if (file.target !== expected.target || file.afterSha256 !== expected.afterSha256 ||
          file.beforeSha256 !== null && !hex(file.beforeSha256) ||
          file.backup !== (file.beforeSha256 === null ? null : `original-${index}.bin`)) fail('invalid-backup')
      if (file.backup) {
        const original = boundedFile(join(this.backupDirectory(key), file.backup))!
        if (digest(original) !== file.beforeSha256 ||
            digest(expected.normalized ? normalized(original) : original) !== expected.beforeSha256) fail('invalid-backup')
      } else if (expected.beforeSha256 !== null) fail('invalid-backup')
    }
    return journal
  }

  private knownAddedHelper(file: ObservedFile): boolean {
    return file.definition.beforeSha256 === null && file.rawHash !== null && this.contracts.some(contract =>
      contract.files.some(candidate => candidate.target === file.definition.target && candidate.beforeSha256 === null && candidate.afterSha256 === file.rawHash))
  }

  private async snapshot(): Promise<Snapshot | undefined> {
    const current = await this.deps.installation()
    if (!current) return undefined
    const installation = { ...current }
    if (![installation.executablePath, installation.pythonExecutable, installation.bundleDirectory].every(isAbsolute) ||
        !/^\d+\.\d+\.\d+(?:[.+-][A-Za-z0-9.-]+)?$/.test(installation.version) || !installation.revision) fail('invalid-installation')
    const expectedBundle = join(dirname(installation.executablePath), 'resources/backend-dist/kirocrew-backend')
    if (pathIdentity(expectedBundle) !== pathIdentity(installation.bundleDirectory) ||
        pathIdentity(join(expectedBundle, 'python.exe')) !== pathIdentity(installation.pythonExecutable)) fail('invalid-installation')
    const installationKey = digest(JSON.stringify([fileIdentity(installation.executablePath), fileIdentity(installation.pythonExecutable), installation.version]))
    const packageRoot = join(installation.bundleDirectory, 'Lib/site-packages/kiro_crew')
    regularDirectory(packageRoot)
    let contract: RepairContract | undefined, files: ObservedFile[] = [], kind: Snapshot['kind'] = 'unknown', guards = new Map<string, string | null>()
    const allObserved: unknown[] = []
    for (const candidate of this.contracts) {
      const observed = candidate.files.map(definition => {
        const path = inside(packageRoot, definition.target), bytes = boundedFile(path, true)
        const patched = boundedFile(inside(this.deps.resourcesRoot, definition.resource))!
        if (digest(patched) !== definition.afterSha256) fail('resource-hash-mismatch')
        return { definition, path, bytes, rawHash: bytes ? digest(bytes) : null,
          normalizedHash: bytes ? digest(definition.normalized ? normalized(bytes) : bytes) : null,
          patched }
      })
      const checks = new Map((candidate.checks ?? []).map(check => {
        const bytes = boundedFile(inside(packageRoot, check.target), true)
        return [check.target, bytes ? digest(bytes) : null] as const
      }))
      allObserved.push([candidate.id, observed.map(item => [item.definition.target, item.rawHash]), [...checks]])
      if ((candidate.checks ?? []).every(check => checks.get(check.target) === check.sha256) &&
          observed.every(item => item.normalizedHash === item.definition.beforeSha256 || item.rawHash === item.definition.afterSha256 || this.knownAddedHelper(item))) {
        contract = candidate; files = observed
        guards = checks
        kind = observed.every(item => item.rawHash === item.definition.afterSha256) ? 'patched'
          : observed.every(item => item.normalizedHash === item.definition.beforeSha256 || this.knownAddedHelper(item)) ? 'original' : 'mixed'
        break
      }
    }
    const journal = this.readJournal(installationKey, contract)
    const revision = digest(JSON.stringify([installationKey, installation.revision, allObserved, journal ?? null]))
    return { installation, installationKey, packageRoot, revision, files, contract, kind, journal, guards }
  }

  private state(snapshot: Snapshot | undefined, code?: string): ClientModelRepairState {
    const ready = snapshot?.kind === 'patched' && snapshot.journal?.state !== 'prepared' && snapshot.journal?.state !== 'interrupted'
    const base = { ready, canRepair: false, canRestore: false,
      ...(snapshot ? { version: snapshot.installation.version, revision: snapshot.revision } : {}) }
    if (code) return { ...base, ready: code === 'client-running' && ready, status: code === 'client-running' ? 'running' : 'error', errorCode: code,
      message: code === 'client-running' ? ready ? '模型目录修复已生效；关闭 Crew 后可恢复原文件。' : '请先关闭 Crew 及其后台服务，再修复模型目录。' : '无法安全确认 Crew 安装或进程状态，请重新检测。',
      messageEn: code === 'client-running' ? ready ? 'The catalog fix is installed. Close Crew before restoring files.' : 'Close Crew and its background service before repairing the catalog.' : 'The Crew installation or process state could not be verified. Inspect again.' }
    if (!snapshot || !snapshot.contract) return { ...base, status: 'unsupported', errorCode: 'unsupported-contract',
      message: '此 Crew 安装的模型目录实现尚未通过兼容检查，请更新管理器或使用官方客户端登录。',
      messageEn: 'This Crew catalog implementation is not yet verified. Update the manager or sign in through the official client.' }
    const interrupted = snapshot.kind === 'mixed' || ['prepared', 'interrupted'].includes(snapshot.journal?.state ?? '') ||
      snapshot.kind === 'original' && snapshot.journal?.state === 'applied'
    if (interrupted) return { ...base, status: 'error', errorCode: 'repair-interrupted', canRestore: !!snapshot.journal,
      message: '上次修复未完整完成，请先恢复原文件再重试。', messageEn: 'The previous repair did not finish. Restore the original files before retrying.' }
    if (ready) return { ...base, status: 'repaired', canRestore: !!snapshot.journal,
      message: '原生 Crew 模型目录修复已安装；模型由官方引擎动态加载。',
      messageEn: 'The native Crew catalog fix is installed. Models load dynamically from the official engine.' }
    return { ...base, status: 'needs-repair', canRepair: true,
      message: '检测到已知的异步模型目录问题，可直接修复官方 Crew，无需独立工作区。',
      messageEn: 'A known asynchronous catalog issue was detected. Repair the official Crew directly without a separate workspace.' }
  }

  async inspect(): Promise<ClientModelRepairState> {
    let snapshot: Snapshot | undefined
    try {
      snapshot = await this.snapshot()
      if (snapshot) await this.deps.assertStopped(snapshot.installation)
      return this.state(snapshot)
    } catch (error) { return this.state(snapshot, errorCode(error)) }
  }

  /** Code readiness only. The caller's ordinary client-switch process guard
   * remains responsible for running-client checks; this cannot authorize writes.
   */
  async inspectReadiness(): Promise<ClientModelRepairState> {
    try {
      const state = this.state(await this.snapshot())
      return { ...state, canRepair: false, canRestore: false }
    } catch (error) { return this.state(undefined, errorCode(error)) }
  }

  private ensureDirectory(directory: string): void {
    noLinks(directory); mkdirSync(directory, { recursive: true, mode: 0o700 }); regularDirectory(directory)
  }
  private writeDurable(filename: string, bytes: Buffer): void {
    noLinks(filename)
    const descriptor = openSync(filename, 'wx', 0o600)
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
  private publish(filename: string, bytes: Buffer, expected: string | null): void {
    const present = boundedFile(filename, true)
    if ((present ? digest(present) : null) !== expected) fail('installation-changed')
    regularDirectory(dirname(filename))
    const temporary = join(dirname(filename), `.kiroaccout-model-${randomUUID()}.tmp`)
    try {
      this.writeDurable(temporary, bytes)
      const latest = boundedFile(filename, true)
      if ((latest ? digest(latest) : null) !== expected) fail('installation-changed')
      ;(this.deps.replace ?? renameSync)(temporary, filename)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  private writeJournal(snapshot: Snapshot, journal: Journal): void {
    const path = join(this.backupDirectory(snapshot.installationKey), 'journal.json')
    const before = boundedFile(path, true)
    this.publish(path, Buffer.from(JSON.stringify(journal, null, 2) + '\n'), before ? digest(before) : null)
  }
  private clearBytecode(filename: string): void {
    if (!filename.endsWith('.py')) return
    const directory = join(dirname(filename), '__pycache__')
    if (!existsSync(directory)) return
    regularDirectory(directory)
    const prefix = basename(filename, '.py') + '.'
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.pyc')) continue
      const target = join(directory, name)
      boundedFile(target); unlinkSync(target)
    }
  }
  private async assertCurrent(snapshot: Snapshot, expectedHashes: Map<string, string | null>): Promise<void> {
    const fresh = await this.deps.installation()
    if (!fresh || fresh.version !== snapshot.installation.version || fresh.revision !== snapshot.installation.revision ||
        pathIdentity(fresh.executablePath) !== pathIdentity(snapshot.installation.executablePath) ||
        pathIdentity(fresh.bundleDirectory) !== pathIdentity(snapshot.installation.bundleDirectory) ||
        digest(JSON.stringify([fileIdentity(fresh.executablePath), fileIdentity(fresh.pythonExecutable), fresh.version])) !== snapshot.installationKey) fail('installation-changed')
    await this.deps.assertStopped(fresh)
    for (const [relative, expected] of [...expectedHashes, ...snapshot.guards]) {
      const present = boundedFile(inside(snapshot.packageRoot, relative), true)
      if ((present ? digest(present) : null) !== expected) fail('installation-changed')
    }
  }
  private async change(expectedRevision: string, restore: boolean): Promise<ClientModelRepairState> {
    if (!hex(expectedRevision)) fail('invalid-request')
    if (this.pending) fail('repair-busy')
    this.pending = true
    try {
      const snapshot = await this.snapshot()
      if (!snapshot || snapshot.revision !== expectedRevision) fail('installation-changed')
      await this.deps.assertStopped(snapshot.installation)
      if (!snapshot.contract) fail('unsupported-contract')
      if (restore ? !snapshot.journal || snapshot.journal.state === 'restored' && snapshot.kind === 'original' : snapshot.kind !== 'original') fail('invalid-repair-state')
      const directory = this.backupDirectory(snapshot.installationKey)
      this.ensureDirectory(directory)
      const expected = new Map(snapshot.files.map(file => [file.definition.target, file.rawHash]))
      await this.assertCurrent(snapshot, expected)
      let journal = snapshot.journal
      if (!restore) {
        if (!journal) {
          const files = snapshot.files.map((file, index) => {
            // An official update may leave our old, known added helper behind.
            // The new installation's original baseline still has no such file;
            // never borrow an earlier installation's backup to reconstruct it.
            const originalHash = file.definition.beforeSha256 === null ? null : file.rawHash
            const backup = originalHash !== null ? `original-${index}.bin` : null
            if (backup) {
              const destination = join(directory, backup), existing = boundedFile(destination, true)
              // A crash while preparing backups has not changed the install.
              // Reuse only a byte-identical original, never overwrite an orphan.
              if (existing && digest(existing) !== file.rawHash) fail('invalid-backup')
              if (!existing) this.writeDurable(destination, file.bytes!)
            }
            return { target: file.definition.target, beforeSha256: originalHash, afterSha256: file.definition.afterSha256, backup }
          })
          journal = { schemaVersion: 1, installationKey: snapshot.installationKey, contractId: snapshot.contract.id, state: 'prepared', files }
        } else {
          if (journal.state !== 'restored' || journal.files.some((file, index) =>
            file.beforeSha256 !== expected.get(file.target) && !(file.beforeSha256 === null && this.knownAddedHelper(snapshot.files[index])))) fail('invalid-backup')
          journal = { ...journal, state: 'prepared' }
        }
        this.writeJournal(snapshot, journal)
      }
      const saved = journal!
      const completed: Array<{ path: string; before?: Buffer; afterHash: string | null }> = []
      try {
        for (let index = 0; index < snapshot.files.length; index++) {
          const file = snapshot.files[index], original = saved.files[index]
          await this.assertCurrent(snapshot, expected)
          const wanted = restore ? original.backup ? boundedFile(join(directory, original.backup)) : undefined : file.patched
          if (wanted) this.publish(file.path, wanted, expected.get(file.definition.target)!)
          else {
            const current = boundedFile(file.path, true)
            if ((current ? digest(current) : null) !== expected.get(file.definition.target)) fail('installation-changed')
            if (current) unlinkSync(file.path)
          }
          const afterHash = wanted ? digest(wanted) : null
          completed.push({ path: file.path, before: file.bytes, afterHash })
          expected.set(file.definition.target, afterHash)
          this.clearBytecode(file.path)
        }
        await this.assertCurrent(snapshot, expected)
        this.writeJournal(snapshot, { ...saved, state: restore ? 'restored' : 'applied' })
      } catch (error) {
        let rolledBack = true
        // A concurrently updated/running install is no longer ours to repair or
        // restore, even if an individual file still happens to match our bytes.
        try { await this.assertCurrent(snapshot, expected) } catch { rolledBack = false }
        for (const file of rolledBack ? completed.reverse() : []) {
          try {
            await this.assertCurrent(snapshot, expected)
            const now = boundedFile(file.path, true)
            if ((now ? digest(now) : null) !== file.afterHash) { rolledBack = false; continue }
            if (file.before) this.publish(file.path, file.before, file.afterHash)
            else if (now) unlinkSync(file.path)
            const relative = snapshot.files.find(item => item.path === file.path)!.definition.target
            expected.set(relative, file.before ? digest(file.before) : null)
            this.clearBytecode(file.path)
          } catch { rolledBack = false }
        }
        try { this.writeJournal(snapshot, { ...saved, state: rolledBack ? restore ? 'applied' : 'restored' : 'interrupted' }) }
        catch { /* The prepared journal remains the recovery boundary. */ }
        if (errorCode(error) === 'client-running' || errorCode(error) === 'process-state-unknown' || errorCode(error) === 'installation-changed') throw error
        fail(rolledBack ? 'write-failed' : 'repair-interrupted')
      }
      return await this.inspect()
    } finally { this.pending = false }
  }
  async repair(expectedRevision: string): Promise<ClientModelRepairResult> {
    const state = await this.change(expectedRevision, false)
    return { success: state.ready, state, ...(state.ready ? { message: '模型目录修复已安装，请重新打开官方 Crew。', messageEn: 'The catalog fix is installed. Reopen the official Crew client.' } : {}) }
  }
  async restore(expectedRevision: string): Promise<ClientModelRepairResult> {
    const state = await this.change(expectedRevision, true)
    const success = state.status === 'needs-repair' || state.status === 'running' && !state.ready
    return { success, state, ...(success ? { message: '已恢复此安装版本的原始 Crew 文件。', messageEn: 'The original files for this Crew installation have been restored.' } : {}) }
  }
}

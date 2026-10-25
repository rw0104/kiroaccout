import * as fs from 'node:fs'
import * as path from 'node:path'

export class SteeringFileError extends Error {
  constructor() { super('无法访问 Steering 文件：请使用安全目录内的普通 .md 文件。') }
}

/** Apply the same portable basename policy before any filesystem access. */
export function validateSteeringFilename(filename: unknown): asserts filename is string {
  if (typeof filename !== 'string' || filename.length > 240 || !/\.md$/i.test(filename) ||
      filename.length <= 3 || filename.trim() !== filename || filename.includes('..') ||
      /[\\/:<>"|?*]/u.test(filename) || Array.from(filename).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\s*\./i.test(filename)) {
    throw new SteeringFileError()
  }
}

/** Sync validation keeps the check and local operation in one event-loop turn.
 * No recursive mkdir, symlink following or truncation before descriptor checks.
 * The home itself is a trusted OS-provided root; its .kiro subtree must be physical.
 */
export interface SteeringFiles {
  directory(): string
  list(): string[]
  path(filename: unknown): string
  read(filename: unknown): string
  write(filename: unknown, content: unknown): void
  delete(filename: unknown): void
}

export function createSteeringFiles(homeDir: string, io: typeof fs = fs, paths: typeof path = path): SteeringFiles {
  const failure = (): never => { throw new SteeringFileError() }
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  const inspect = (filename: string): fs.Stats | undefined => {
    try { return io.lstatSync(filename) } catch (error) { if (missing(error)) return undefined; return failure() }
  }
  const inside = (base: string, target: string): boolean => {
    const relative = paths.relative(base, target)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
  }
  const directory = (create = false): string | undefined => {
    const home = io.realpathSync(homeDir)
    let current = home
    for (const name of ['.kiro', 'steering']) {
      current = paths.join(current, name)
      let stat = inspect(current)
      if (!stat && create) {
        // EEXIST may be a concurrent creator: always inspect it before use.
        try { io.mkdirSync(current) } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') return failure() }
        stat = inspect(current)
      }
      if (!stat) return undefined
      if (stat.isSymbolicLink() || !stat.isDirectory()) return failure()
      const real = io.realpathSync(current)
      if (!inside(home, real) || paths.relative(current, real) !== '') return failure()
    }
    return current
  }
  const file = (filename: unknown, createDirectory = false): { root: string; target: string; stat?: fs.Stats } => {
    validateSteeringFilename(filename)
    const root = directory(createDirectory)
    if (!root) return failure()
    const target = paths.join(root, filename)
    const stat = inspect(target)
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return failure()
      const real = io.realpathSync(target)
      if (!inside(root, real) || paths.relative(target, real) !== '') return failure()
    }
    return { root, target, stat }
  }
  const open = (filename: unknown, write: boolean): number => {
    const checked = file(filename, write)
    if (!write && !checked.stat) return failure()
    const flags = (write ? io.constants.O_WRONLY : io.constants.O_RDONLY) |
      (io.constants.O_NOFOLLOW || 0) | (!checked.stat ? io.constants.O_CREAT | io.constants.O_EXCL : 0)
    const fd = io.openSync(checked.target, flags, 0o600)
    try {
      const descriptor = io.fstatSync(fd)
      const after = file(filename)
      if (!after.stat || !descriptor.isFile() || descriptor.nlink !== 1 ||
          descriptor.dev !== after.stat.dev || descriptor.ino !== after.stat.ino ||
          (checked.stat && (descriptor.dev !== checked.stat.dev || descriptor.ino !== checked.stat.ino))) return failure()
      return fd
    } catch (error) { io.closeSync(fd); throw error }
  }
  return {
    directory(): string { return directory(true) ?? failure() },
    list(): string[] {
      const root = directory()
      if (!root) return []
      return io.readdirSync(root).filter(filename => {
        try { return !!file(filename).stat } catch { return false }
      })
    },
    path(filename: unknown): string {
      const checked = file(filename)
      return checked.stat ? checked.target : failure()
    },
    read(filename: unknown): string {
      const fd = open(filename, false)
      try { return io.readFileSync(fd, 'utf-8') } finally { io.closeSync(fd) }
    },
    write(filename: unknown, content: unknown): void {
      validateSteeringFilename(filename)
      if (typeof content !== 'string') return failure()
      const fd = open(filename, true)
      try { io.ftruncateSync(fd, 0); io.writeFileSync(fd, content, 'utf-8') } finally { io.closeSync(fd) }
    },
    delete(filename: unknown): void {
      const checked = file(filename)
      if (!checked.stat) return failure()
      io.unlinkSync(checked.target)
    }
  }
}

export function steeringFileFailure(): string { return new SteeringFileError().message }

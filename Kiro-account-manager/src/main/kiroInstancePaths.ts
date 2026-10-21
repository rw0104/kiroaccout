import * as fs from 'node:fs/promises'
import { win32 } from 'node:path'
import type { KiroInstancePaths } from '../shared/kiroInstances'

export class KiroInstanceError extends Error {}
export const failInstance = (message: string): never => { throw new KiroInstanceError(message) }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function canonicalWindowsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 || !/^[a-z]:\\/i.test(value) ||
      /[\x00-\x1f\x7f"<>|?*]/.test(value) || value.includes('/') || value.slice(2).includes(':')) {
    return failInstance('请选择本地 Windows 盘符上的有效路径。')
  }
  const segments = value.slice(3).split('\\')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment))) {
    return failInstance('路径不能包含空片段、相对跳转或末尾空格。')
  }
  return win32.normalize(value)
}
export function equalWindowsPath(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase() }

export function makeInstancePaths(baseRoot: string, id: string, portable: boolean): KiroInstancePaths {
  if (!UUID.test(id)) return failInstance('实例标识无效。')
  const root = win32.join(canonicalWindowsPath(baseRoot), id.toLowerCase())
  const home = win32.join(root, 'home')
  return {
    root, home, portable: win32.join(root, 'portable'),
    userData: portable ? win32.join(root, 'portable', 'user-data') : win32.join(root, 'user-data'),
    extensions: win32.join(root, 'extensions'), sharedData: win32.join(root, 'shared-data'),
    agentPlugins: win32.join(root, 'agent-plugins'), agentsUserData: win32.join(root, 'agents-user-data'),
    agentsExtensions: win32.join(root, 'agents-extensions'), appData: win32.join(home, 'AppData', 'Roaming'),
    localAppData: win32.join(home, 'AppData', 'Local'), temp: win32.join(root, 'temp')
  }
}

export interface KiroInstanceFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>
  realpath(path: string): Promise<string>
  mkdir(path: string): Promise<unknown>
  readFile(path: string): Promise<string>
  writeMarker(path: string, content: string): Promise<unknown>
}
export const instanceFileSystem: KiroInstanceFileSystem = {
  lstat: path => fs.lstat(path), realpath: path => fs.realpath(path),
  mkdir: path => fs.mkdir(path), readFile: path => fs.readFile(path, 'utf8'),
  writeMarker: (path, content) => fs.writeFile(path, content, { flag: 'wx', encoding: 'utf8' })
}
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

/** Verify every ancestor before creating the next segment; never follow a junction or symlink. */
export async function checkInstanceDirectory(io: KiroInstanceFileSystem, path: string, create: boolean): Promise<void> {
  const canonical = canonicalWindowsPath(path)
  const root = win32.parse(canonical).root
  let cursor = root
  for (const segment of canonical.slice(root.length).split('\\')) {
    cursor = win32.join(cursor, segment)
    let stat
    try { stat = await io.lstat(cursor) }
    catch (error) {
      if (!create || !absent(error)) throw error
      await io.mkdir(cursor)
      stat = await io.lstat(cursor)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) failInstance('实例目录含链接或非目录对象，已阻止操作。')
    if (!equalWindowsPath(canonicalWindowsPath(await io.realpath(cursor)), cursor)) failInstance('实例目录被重定向，已阻止操作。')
  }
}

export async function prepareInstanceDirectories(io: KiroInstanceFileSystem, paths: KiroInstancePaths, id: string): Promise<void> {
  // Creating an instance never reads another profile, credential file or account database.
  for (const path of [...Object.values(paths), win32.join(paths.home, '.aws', 'sso', 'cache'), win32.join(paths.home, '.kiro')]) {
    await checkInstanceDirectory(io, path, true)
  }
  await io.writeMarker(win32.join(paths.root, '.kiro-instance.json'), JSON.stringify({ schemaVersion: 2, id }))
}

export async function verifyInstanceDirectories(io: KiroInstanceFileSystem, paths: KiroInstancePaths, id: string): Promise<void> {
  for (const path of [...Object.values(paths), win32.join(paths.home, '.aws', 'sso', 'cache'), win32.join(paths.home, '.kiro')]) {
    await checkInstanceDirectory(io, path, false)
  }
  const markerPath = win32.join(paths.root, '.kiro-instance.json')
  const stat = await io.lstat(markerPath)
  if (stat.isSymbolicLink() || stat.isDirectory()) failInstance('实例标记无效，已阻止操作。')
  if (!equalWindowsPath(canonicalWindowsPath(await io.realpath(markerPath)), markerPath)) failInstance('实例标记被重定向。')
  const marker: unknown = JSON.parse(await io.readFile(markerPath))
  if (!marker || typeof marker !== 'object' || (marker as any).schemaVersion !== 2 || (marker as any).id !== id || Object.keys(marker).length !== 2) {
    failInstance('实例标记不匹配，已阻止操作。')
  }
}

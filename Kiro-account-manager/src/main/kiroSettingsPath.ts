import { posix, win32 } from 'node:path'

/** Resolve the official IDE's user settings without consulting or touching disk. */
export function resolveKiroSettingsPath(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv = {}
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA && win32.isAbsolute(env.APPDATA)
      ? env.APPDATA
      : win32.join(homeDir, 'AppData', 'Roaming')
    return win32.join(appData, 'Kiro', 'User', 'settings.json')
  }
  if (platform === 'darwin') {
    return posix.join(homeDir, 'Library', 'Application Support', 'Kiro', 'User', 'settings.json')
  }
  // XDG requires an absolute path; empty or relative overrides are ignored.
  const configHome = env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : posix.join(homeDir, '.config')
  return posix.join(configHome, 'Kiro', 'User', 'settings.json')
}

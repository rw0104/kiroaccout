import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

/** This remote UI never receives the manager preload or its trusted IPC identity. */
export const managedCrewWindowOptions = (): BrowserWindowConstructorOptions => ({
  width: 1200, height: 820, minWidth: 720, minHeight: 520,
  show: false, title: 'Crew — 独立工作区', autoHideMenuBar: true,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, partition: 'persist:kiroaccout-crew-managed-v1' }
})

export class ManagedCrewWindowController {
  private window?: BrowserWindow
  private origin?: string
  private closed?: () => void
  constructor(private readonly create: (options: BrowserWindowConstructorOptions) => BrowserWindow) {}

  async open(value: string, onClosed: () => void): Promise<void> {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
        url.pathname !== '/' || !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')) throw new Error('Invalid workspace URL')
    if (this.window && !this.window.isDestroyed()) {
      if (this.origin !== url.origin) throw new Error('Workspace origin changed')
      if (this.window.isMinimized()) this.window.restore()
      this.window.show(); this.window.focus()
      return
    }
    const window = this.create(managedCrewWindowOptions())
    this.window = window; this.origin = url.origin; this.closed = onClosed
    window.on('page-title-updated', event => { event.preventDefault() })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-navigate', (event, target) => {
      try { if (new URL(target).origin === url.origin) return } catch { /* invalid navigation */ }
      event.preventDefault()
    })
    window.webContents.on('will-redirect', (event, target) => {
      try { if (new URL(target).origin === url.origin) return } catch { /* invalid navigation */ }
      event.preventDefault()
    })
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.on('closed', () => {
      if (this.window !== window) return
      const callback = this.closed
      this.window = undefined; this.origin = undefined; this.closed = undefined
      callback?.()
    })
    await window.loadURL(value)
    if (window.isDestroyed() || this.window !== window) throw new Error('Workspace window closed')
    window.show()
  }

  close(): void {
    const window = this.window
    this.closed = undefined
    this.window = undefined; this.origin = undefined
    if (window && !window.isDestroyed()) window.destroy()
  }
}

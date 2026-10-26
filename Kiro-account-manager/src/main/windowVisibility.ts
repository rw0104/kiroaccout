import type { WindowVisibilityState } from '../shared/windowVisibility'

interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  on(event: string, listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    send(channel: string, state: WindowVisibilityState): void
    on(event: string, listener: () => void): unknown
    removeListener(event: string, listener: () => void): unknown
  }
}

/** Reports visual activity only. No timers, authentication or background tasks are stopped. */
export function trackWindowVisibility(window: WindowLike): {
  getSnapshot: () => WindowVisibilityState
  dispose: () => void
} {
  // BrowserWindow.webContents cannot be read once the native window is destroyed.
  // Keep the live reference so closed cleanup only touches EventEmitter listeners.
  const webContents = window.webContents
  let revision = 0
  let visible = !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  let disposed = false
  const getSnapshot = (): WindowVisibilityState => ({ visible, revision })
  const publish = (): void => {
    if (disposed || window.isDestroyed()) return
    const next = window.isVisible() && !window.isMinimized()
    if (next !== visible) { visible = next; revision++ }
    if (!webContents.isDestroyed()) webContents.send('window-visibility-changed', getSnapshot())
  }
  const events = ['show', 'hide', 'minimize', 'restore']
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const event of events) window.removeListener(event, publish)
    window.removeListener('closed', dispose)
    webContents.removeListener('did-finish-load', publish)
  }
  for (const event of events) window.on(event, publish)
  window.on('closed', dispose)
  webContents.on('did-finish-load', publish)
  return { getSnapshot, dispose }
}

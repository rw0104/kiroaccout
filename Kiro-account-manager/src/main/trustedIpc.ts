import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'

/** Frame identity prevents child frames and other BrowserWindows impersonating the UI.
 * The expected entry URL also rejects a main frame that has navigated elsewhere.
 */
export function requireTrustedMainWindow(
  event: IpcMainInvokeEvent,
  window: BrowserWindow | null,
  rendererFile: string,
  devServerUrl?: string
): void {
  if (!window || window.isDestroyed() || !event || event.sender !== window.webContents ||
      !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('不可信的窗口请求。')
  }
  try {
    const actual = new URL(event.senderFrame.url)
    const expected = new URL(devServerUrl || pathToFileURL(rendererFile).href)
    // Hash routing is part of the application UI; other locations are not.
    actual.hash = ''; expected.hash = ''
    if (actual.href !== expected.href) throw new Error()
  } catch { throw new Error('不可信的窗口请求。') }
}

/** Native window activity is authoritative; Chromium may report visible for a hidden window. */
export interface WindowVisibilityState {
  visible: boolean
  revision: number
}

export interface WindowVisibilityApi {
  getWindowVisibility: () => Promise<WindowVisibilityState>
  onWindowVisibilityChanged: (listener: (state: WindowVisibilityState) => void) => () => void
}

/** One native subscription is shared by the app shell and any visible log views. */
export function createWindowVisibilityStore(api: WindowVisibilityApi): {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => boolean
} {
  let visible = false
  let revision = -1
  let generation = 0
  let detach: (() => void) | undefined
  const listeners = new Set<() => void>()
  const accept = (state: WindowVisibilityState): void => {
    if (!state || typeof state.visible !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < revision) return
    revision = state.revision
    if (state.visible === visible) return
    visible = state.visible
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => visible,
    subscribe: listener => {
      listeners.add(listener)
      if (!detach) {
        const current = ++generation
        revision = -1
        detach = api.onWindowVisibilityChanged(state => { if (generation === current) accept(state) })
        void api.getWindowVisibility().then(state => { if (generation === current) accept(state) }).catch(() => {})
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          detach?.()
          detach = undefined
          revision = -1
          visible = false
        }
      }
    }
  }
}

import type { AppUpdateState } from '../../../main/appUpdater'

export interface UpdateStateApi {
  getAppUpdateState: () => Promise<AppUpdateState>
  onAppUpdateState: (handler: (state: AppUpdateState) => void) => () => void
}

/** Subscribe first, then recover the latest snapshot; late queries cannot roll state back. */
export function subscribeUpdateState(api: UpdateStateApi, receive: (state: AppUpdateState) => void, failed: () => void): () => void {
  let active = true
  let revision = -1
  const accept = (state: AppUpdateState): void => {
    if (!active || state.revision < revision) return
    revision = state.revision
    receive(state)
  }
  const unsubscribe = api.onAppUpdateState(accept)
  void api.getAppUpdateState().then(accept).catch(() => { if (active && revision < 0) failed() })
  return () => { active = false; unsubscribe() }
}

export async function acknowledgeUpdateSave(
  requestId: string,
  save: () => Promise<void>,
  confirm: (requestId: string, success: boolean) => void
): Promise<void> {
  try { await save() } catch { confirm(requestId, false); return }
  confirm(requestId, true)
}

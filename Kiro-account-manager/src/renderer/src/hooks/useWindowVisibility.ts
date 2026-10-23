import { useSyncExternalStore } from 'react'
import { createWindowVisibilityStore } from '../../../shared/windowVisibility'

const activity = createWindowVisibilityStore({
  getWindowVisibility: () => window.api.getWindowVisibility(),
  onWindowVisibilityChanged: listener => window.api.onWindowVisibilityChanged(listener)
})

export function useWindowVisibility(): boolean {
  return useSyncExternalStore(activity.subscribe, activity.getSnapshot, () => false)
}

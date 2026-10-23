import { useCallback, useEffect, useRef, useState } from 'react'
import { ProxyLogPoller, type LogViewSnapshot } from '../lib/proxyLogPolling'
import { useWindowVisibility } from './useWindowVisibility'

const empty = (): LogViewSnapshot => ({ logs: [], total: 0, loading: false, received: 0 })

/** Hide pauses visual polling; closing a detail view also drops its retained history. */
export function useProxyLogs(open: boolean, displayLimit: string): LogViewSnapshot & { refresh: () => void; clear: () => Promise<void> } {
  const visible = useWindowVisibility()
  const [state, setState] = useState<LogViewSnapshot>(empty)
  const poller = useRef<ProxyLogPoller | null>(null)
  const limit = displayLimit === 'all' ? 50_000 : Math.max(1, parseInt(displayLimit) || 5000)
  useEffect(() => {
    if (!open) { setState(empty()); return }
    const instance = new ProxyLogPoller({
      fetchPage: (cursor, count) => window.api.proxyGetLogPage(cursor, count),
      changed: setState,
      limit,
      schedule: (run, delay) => setTimeout(run, delay),
      cancel: (id) => clearTimeout(id)
    })
    poller.current = instance
    return () => { instance.dispose(); if (poller.current === instance) poller.current = null }
    // Limit changes are applied without replacing the cursor or pending transport.
  }, [open])
  useEffect(() => { poller.current?.setLimit(limit) }, [limit, open])
  useEffect(() => { poller.current?.setActive(open && visible) }, [open, visible])
  const refresh = useCallback(() => { poller.current?.refresh() }, [])
  const clear = useCallback(async () => {
    const instance = poller.current
    await window.api.proxyClearLogs()
    if (poller.current !== instance) return
    instance?.reset()
    instance?.refresh()
  }, [])
  return { ...state, refresh, clear }
}

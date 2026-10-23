import type { LogEntry, LogPage } from '../../../shared/logHistory'

export interface LogViewSnapshot {
  logs: LogEntry[]
  total: number
  loading: boolean
  error?: 'timeout' | 'request_failed'
  received: number
}

interface LogPollOptions {
  fetchPage: (cursor?: string, limit?: number) => Promise<LogPage>
  changed: (snapshot: LogViewSnapshot) => void
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (id: ReturnType<typeof setTimeout>) => void
  maxBytes?: number
  limit?: number
}

const MAX_ROWS = 50_000
const MAX_BYTES = 8 * 1024 * 1024
const POLL_MS = 1500
const TIMEOUT_MS = 10_000
const PAGES_PER_TURN = 4

/** One transport per view, including after timeout, hide/show or a manual refresh. */
export class ProxyLogPoller {
  private active = false
  private disposed = false
  private generation = 0
  private cursor?: string
  private epoch?: string
  private pending?: Promise<LogPage>
  private timer?: ReturnType<typeof setTimeout>
  private snapshot: LogViewSnapshot = { logs: [], total: 0, loading: false, received: 0 }
  private sizes: number[] = []
  private bytes = 0
  private limit: number
  private changed?: LogPollOptions['changed']
  private readonly schedule: NonNullable<LogPollOptions['schedule']>
  private readonly cancel: NonNullable<LogPollOptions['cancel']>
  private readonly fetchPage: LogPollOptions['fetchPage']
  private readonly maxBytes: number

  constructor(options: LogPollOptions) {
    this.limit = Math.max(1, Math.min(MAX_ROWS, options.limit ?? 5000))
    this.changed = options.changed
    this.schedule = options.schedule ?? ((run, delay) => setTimeout(run, delay))
    this.cancel = options.cancel ?? ((id) => clearTimeout(id))
    this.fetchPage = options.fetchPage
    this.maxBytes = options.maxBytes ?? MAX_BYTES
  }

  private publish(patch: Partial<LogViewSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    this.changed?.(this.snapshot)
  }

  private unschedule(): void {
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = undefined
  }

  private later(delay = POLL_MS): void {
    this.unschedule()
    if (!this.active || this.disposed) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.poll(this.generation)
    }, delay)
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    this.generation++
    this.unschedule()
    if (active) this.refresh()
    else if (this.snapshot.loading) this.publish({ loading: false })
  }

  setLimit(limit: number): void {
    const next = Math.max(1, Math.min(MAX_ROWS, limit))
    if (next === this.limit) return
    const increase = next > this.limit
    this.limit = next
    // A larger local view needs older retained history that the previous limit dropped.
    if (increase) this.reset()
    else this.trim()
    this.refresh()
  }

  reset(): void {
    this.generation++
    this.unschedule()
    this.cursor = this.epoch = undefined
    this.sizes = []
    this.bytes = 0
    this.publish({ logs: [], total: 0, received: 0, loading: false, error: undefined })
  }

  refresh(): void {
    if (!this.active || this.disposed || this.pending) return
    this.unschedule()
    void this.poll(this.generation)
  }

  private trim(): void {
    let remove = 0
    const maximum = this.maxBytes
    while (remove < this.sizes.length && (this.sizes.length - remove > this.limit || this.bytes > maximum)) {
      this.bytes -= this.sizes[remove++]
    }
    if (remove) {
      this.sizes = this.sizes.slice(remove)
      this.publish({ logs: this.snapshot.logs.slice(remove) })
    }
  }

  private accept(page: LogPage): void {
    if (!Array.isArray(page.entries) || page.entries.length > 500 || typeof page.nextCursor !== 'string' || typeof page.epoch !== 'string') throw new Error('Invalid log page')
    const reset = page.reset || this.epoch !== page.epoch
    const previous = reset ? [] : this.snapshot.logs
    const ids = new Set(previous.map((entry) => entry.id).filter(Boolean))
    const added = page.entries.filter((entry) => !entry.id || !ids.has(entry.id))
    if (reset) { this.sizes = []; this.bytes = 0 }
    const encoder = new TextEncoder()
    for (const entry of added) {
      const size = encoder.encode(JSON.stringify(entry)).byteLength
      this.sizes.push(size)
      this.bytes += size
    }
    this.cursor = page.nextCursor
    this.epoch = page.epoch
    const received = (reset ? 0 : this.snapshot.received) + added.length
    // Empty unchanged polls preserve the array reference and do not rerender the log tree.
    if (reset || added.length || page.total !== this.snapshot.total || this.snapshot.loading || this.snapshot.error) {
      this.publish({ logs: added.length ? [...previous, ...added] : previous, total: page.total, received, loading: false, error: undefined })
      this.trim()
    }
  }

  private async poll(generation: number): Promise<void> {
    if (!this.active || this.disposed || this.pending || generation !== this.generation) return
    if (!this.snapshot.logs.length) this.publish({ loading: true, error: undefined })
    let more = false
    for (let pageNumber = 0; pageNumber < PAGES_PER_TURN; pageNumber++) {
      if (!this.active || this.disposed || generation !== this.generation) return
      const before = this.cursor
      const request = Promise.resolve().then(() => this.fetchPage(before, 500))
      this.pending = request
      let timedOut = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      // Keep pending until the actual IPC settles. A timeout must not create a
      // new unresolved IPC every interval or after hide/show.
      void request.then(() => {
        if (this.pending === request) this.pending = undefined
        if (timedOut || generation !== this.generation) this.later(0)
      }, () => {
        if (this.pending === request) this.pending = undefined
        if (timedOut || generation !== this.generation) this.later()
      })
      try {
        const page = await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            timeout = this.schedule(() => { timedOut = true; reject(new Error('timeout')) }, TIMEOUT_MS)
          })
        ])
        if (!this.active || this.disposed || generation !== this.generation) return
        this.accept(page)
        more = page.hasMore && page.nextCursor !== before
        if (!more) break
      } catch {
        if (this.active && !this.disposed && generation === this.generation) this.publish({ loading: false, error: timedOut ? 'timeout' : 'request_failed' })
        if (!timedOut) this.later()
        return
      } finally { if (timeout !== undefined) this.cancel(timeout) }
    }
    // Bound initial/catch-up work; continue large histories in a later turn.
    this.later(more ? 50 : POLL_MS)
  }

  dispose(): void {
    this.active = false
    this.disposed = true
    this.generation++
    this.unschedule()
    this.changed = undefined
    this.snapshot = { logs: [], total: 0, loading: false, received: 0 }
    this.sizes = []
    this.bytes = 0
  }
}

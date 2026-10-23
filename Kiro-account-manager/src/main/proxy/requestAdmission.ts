export type AdmissionFailure = 'queue_full' | 'wait_timeout' | 'cancelled' | 'stopped'

export class RequestAdmissionError extends Error {
  readonly code: AdmissionFailure
  constructor(code: AdmissionFailure) {
    super(code === 'queue_full' ? 'Proxy request queue is full. Retry shortly.'
      : code === 'wait_timeout' ? 'Proxy request queue wait timed out. Retry shortly.'
        : code === 'stopped' ? 'Proxy server is stopping.' : 'Request cancelled.')
    this.name = 'RequestAdmissionError'
    this.code = code
  }
}

interface Waiter {
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: RequestAdmissionError) => void
  cleanup: () => void
}

/** Holds permits and small waiters only; request bodies never enter this queue. */
export class RequestAdmission {
  private active = 0
  private readonly queue: Waiter[] = []
  private limit = 10
  private pendingLimit = 40
  private stopped = false
  private readonly waitMs: number

  constructor(options: { maxConcurrent?: number; waitMs?: number } = {}) {
    this.waitMs = options.waitMs ?? 30000
    this.configure(options.maxConcurrent ?? 10)
  }

  configure(maxConcurrent: number): void {
    this.limit = Number.isFinite(maxConcurrent) && maxConcurrent >= 1 ? Math.floor(maxConcurrent) : 10
    this.pendingLimit = Math.min(this.limit * 4, 128)
    this.drain()
  }

  get state(): { active: number; pending: number; maxConcurrent: number; maxPending: number } {
    return { active: this.active, pending: this.queue.length, maxConcurrent: this.limit, maxPending: this.pendingLimit }
  }

  open(): void {
    this.stopped = false
    this.drain()
  }

  close(): void {
    this.stopped = true
    for (const waiter of this.queue.splice(0)) {
      waiter.cleanup()
      waiter.reject(new RequestAdmissionError('stopped'))
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new RequestAdmissionError('cancelled'))
    if (this.stopped) return Promise.reject(new RequestAdmissionError('stopped'))
    if (this.active < this.limit && this.queue.length === 0) {
      this.active++
      return Promise.resolve(this.permit())
    }
    if (this.queue.length >= this.pendingLimit) return Promise.reject(new RequestAdmissionError('queue_full'))
    return new Promise((resolve, reject) => {
      const cancel = (code: AdmissionFailure): void => {
        const index = this.queue.indexOf(waiter)
        if (index < 0) return
        this.queue.splice(index, 1)
        waiter.cleanup()
        reject(new RequestAdmissionError(code))
      }
      const abort = (): void => cancel('cancelled')
      const timer = setTimeout(() => cancel('wait_timeout'), this.waitMs)
      const waiter: Waiter = {
        signal, resolve, reject,
        cleanup: (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      }
      this.queue.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  private permit(): () => void {
    let released = false
    return (): void => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (!this.stopped && this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!
      waiter.cleanup()
      if (waiter.signal?.aborted) { waiter.reject(new RequestAdmissionError('cancelled')); continue }
      this.active++
      waiter.resolve(this.permit())
    }
  }
}

export function requiresRequestAdmission(method: string, path: string): boolean {
  if (method !== 'POST') return false
  return ['/v1/chat/completions', '/chat/completions', '/v1/responses', '/responses',
    '/v1/messages', '/messages', '/anthropic/v1/messages', '/v1/messages/count_tokens', '/messages/count_tokens'].includes(path)
    || path.startsWith('/v1beta/models/')
}

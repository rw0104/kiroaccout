export interface LogEntry {
  id?: string
  timestamp: string
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  category: string
  message: string
  data?: unknown
  truncated?: boolean
}

export interface LogPage {
  entries: LogEntry[]
  reset: boolean
  epoch: string
  nextCursor: string
  hasMore: boolean
  total: number
}

export const LOG_HISTORY_MAX_BYTES = 8 * 1024 * 1024
export const LOG_ENTRY_MAX_BYTES = 32 * 1024
export const LOG_HISTORY_MAX_COUNT = 50000
export const LOG_PAGE_MAX_BYTES = 512 * 1024
export const LOG_PAGE_MAX_COUNT = 500

/** Copy a bounded diagnostic preview before redaction, never retaining the source graph. */
export function snapshotLogEntry(raw: LogEntry, redact: (value: unknown) => unknown): LogEntry {
  let remaining = 24 * 1024
  let nodes = 256
  let truncated = raw.truncated === true
  const seen = new WeakSet<object>()
  const text = (value: string, limit = 8192): string => {
    const length = Math.max(0, Math.min(value.length, limit, remaining))
    remaining -= length
    const copy = new TextDecoder().decode(new TextEncoder().encode(value.slice(0, length)))
    if (length < value.length) { truncated = true; return `${copy} [truncated]` }
    return copy
  }
  const visit = (value: unknown, depth = 0): unknown => {
    if (--nodes < 0 || remaining <= 0) { truncated = true; return '[truncated]' }
    if (typeof value === 'string') return text(value)
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value !== 'object') return `[${typeof value}]`
    if (seen.has(value)) { truncated = true; return '[circular]' }
    if (depth >= 5) { truncated = true; return '[depth-limit]' }
    seen.add(value)
    if (Array.isArray(value)) {
      const output: unknown[] = []
      let length: number
      try { length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number }
      catch { truncated = true; return ['[unavailable]'] }
      if (!Number.isSafeInteger(length) || length < 0) { truncated = true; return ['[unavailable]'] }
      for (let index = 0; index < Math.min(length, 20); index++) {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (descriptor && !('value' in descriptor)) { truncated = true; output.push('[accessor]') }
          else output.push(visit(descriptor?.value, depth + 1))
        } catch { truncated = true; output.push('[unavailable]') }
      }
      if (length > 20) { truncated = true; output.push(`[truncated ${length - 20} items]`) }
      return output
    }
    const output: Record<string, unknown> = Object.create(null)
    let count = 0
    try {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        if (count++ >= 20 || nodes <= 0 || remaining <= 0) { truncated = true; output['[truncated]'] = true; break }
        const label = text(key, 128)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        // Logging must not invoke application getters or keep accessor closures alive.
        output[label] = descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[accessor]'
      }
    } catch { truncated = true; output['[unavailable]'] = true }
    return output
  }
  const entry: LogEntry = {
    timestamp: text(typeof raw.timestamp === 'string' ? raw.timestamp : '', 64),
    level: raw.level,
    category: text(typeof raw.category === 'string' ? raw.category : 'App', 128),
    message: text(typeof raw.message === 'string' ? raw.message : '', 8192),
    ...(raw.data === undefined ? {} : { data: visit(raw.data) })
  }
  const safe = redact(entry) as LogEntry
  if (truncated) safe.truncated = true
  return safe
}

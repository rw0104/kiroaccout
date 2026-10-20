/** Await each request and handler before scheduling the next poll. */
export function startSerialLoginPolling<T>(options: {
  initialInterval: number
  isCurrent: () => boolean
  poll: () => Promise<T>
  onResult: (result: T) => Promise<number | null>
  onError: () => void
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = options.schedule ?? setTimeout
  const unschedule = options.unschedule ?? clearTimeout
  const next = (interval: number): void => {
    if (stopped || !options.isCurrent()) return
    timer = schedule(() => { void run() }, Math.max(1, interval) * 1000)
  }
  const run = async (): Promise<void> => {
    if (stopped || !options.isCurrent()) return
    try {
      const result = await options.poll()
      if (stopped || !options.isCurrent()) return
      const interval = await options.onResult(result)
      if (interval !== null && !stopped && options.isCurrent()) next(interval)
    } catch {
      if (!stopped && options.isCurrent()) options.onError()
    }
  }
  next(options.initialInterval)
  return () => { stopped = true; if (timer !== undefined) unschedule(timer) }
}

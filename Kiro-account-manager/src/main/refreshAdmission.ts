/** Delay sequence used by the current official authentication scheduler, capped at 30 minutes. */
export function refreshRetryDelayMs(attempt: number): number {
  return attempt <= 4 ? [5000, 10000, 15000, 30000][Math.max(0, attempt - 1)] : Math.min((attempt - 3) * 30000, 1800000)
}

interface Outcome {
  success: boolean
  httpStatus?: number
  responseFormat?: 'json' | 'html' | 'unknown'
  serviceCode?: string
}
interface RouteState {
  active: number
  queued: Array<{ credential: string; resolve: (value: Admission) => void }>
  consecutive: Set<string>
  failures: number
  blockedUntil: number
  probe: boolean
  touchedAt: number
}
export interface RefreshPermit {
  kind: 'permit'
  route: RouteState
  credential: string
  probe: boolean
  completed: boolean
}
type Admission = RefreshPermit | { kind: 'deferred'; retryAfterMs: number }

/** Shared Social-route admission. It schedules no retry timers and never sends requests itself. */
export class RefreshRouteAdmission {
  private readonly routes = new Map<string, RouteState>()
  private queued = 0
  private readonly now: () => number
  constructor(now: () => number) { this.now = now }

  private deferred(route?: RouteState): Admission {
    return { kind: 'deferred', retryAfterMs: Math.min(1800000, Math.max(1, Math.ceil((route?.blockedUntil || this.now() + 1000) - this.now()))) }
  }
  private permit(route: RouteState, credential: string, probe = false): RefreshPermit {
    route.active++
    if (probe) route.probe = true
    return { kind: 'permit', route, credential, probe, completed: false }
  }
  acquire(routeKey: string, credential: string, manual = false): Promise<Admission> {
    const now = this.now()
    for (const [key, route] of this.routes) {
      if (!route.active && !route.queued.length && now - route.touchedAt > 3600000) this.routes.delete(key)
    }
    let route = this.routes.get(routeKey)
    if (!route) {
      if (this.routes.size >= 128) return Promise.resolve(this.deferred())
      route = { active: 0, queued: [], consecutive: new Set(), failures: 0, blockedUntil: 0, probe: false, touchedAt: now }
      this.routes.set(routeKey, route)
    }
    route.touchedAt = now
    if (route.blockedUntil) {
      if (route.probe || route.active >= 4 || !manual && now < route.blockedUntil) return Promise.resolve(this.deferred(route))
      return Promise.resolve(this.permit(route, credential, true))
    }
    if (route.active < 4) return Promise.resolve(this.permit(route, credential))
    if (this.queued >= 256) return Promise.resolve(this.deferred())
    this.queued++
    return new Promise(resolve => {
      const waiter = { credential, resolve }
      if (manual) route.queued.unshift(waiter)
      else route.queued.push(waiter)
    })
  }

  complete(permit: RefreshPermit, outcome?: Outcome): void {
    if (permit.completed) return
    permit.completed = true
    const route = permit.route
    route.active--
    route.touchedAt = this.now()
    if (permit.probe) route.probe = false
    const htmlRefusal = outcome?.httpStatus === 403 && outcome.responseFormat === 'html'
    const reachable = outcome?.success || outcome?.responseFormat === 'json' &&
      !['slow_down', 'server_error', 'temporarily_unavailable'].includes(outcome.serviceCode || '') &&
      (outcome.httpStatus === 401 || [400, 403].includes(outcome.httpStatus || 0) &&
        ['invalid_grant', 'expired_token', 'invalid_client', 'unauthorized_client', 'access_denied',
          'invalid_request', 'invalid_scope', 'unsupported_grant_type'].includes(outcome.serviceCode || ''))
    if (reachable) {
      // A structured service rejection proves the route is reachable, not that its credential is valid.
      route.blockedUntil = 0
      route.failures = 0
      route.consecutive.clear()
    } else if (htmlRefusal || permit.probe && outcome) {
      if (!route.blockedUntil) route.consecutive.add(permit.credential)
      if (permit.probe || !route.blockedUntil && route.consecutive.size >= 3) {
        route.failures = Math.min(63, route.failures + 1)
        route.blockedUntil = this.now() + refreshRetryDelayMs(route.failures)
        route.consecutive.clear()
      }
    } else if (outcome && !route.blockedUntil) route.consecutive.clear()

    if (route.blockedUntil) {
      for (const waiter of route.queued.splice(0)) { this.queued--; waiter.resolve(this.deferred(route)) }
    } else {
      while (route.active < 4 && route.queued.length) {
        const waiter = route.queued.shift()!
        this.queued--
        waiter.resolve(this.permit(route, waiter.credential))
      }
    }
  }
}

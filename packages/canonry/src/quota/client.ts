/**
 * Lease-aware quota client (Track 1 — Canonry Hosted, spec §14).
 *
 * Talks to the canonry-cloud control plane via three HTTP endpoints:
 *
 *   POST {controlPlaneUrl}/quota/check
 *   POST {controlPlaneUrl}/quota/lease
 *   POST {controlPlaneUrl}/quota/lease/{leaseId}/close
 *
 * Auth is the same `cnry_…` API key the tenant container already uses for
 * cross-container calls — the spec assumes the control plane recognises
 * the tenant's bearer. No persistence, no logging beyond return values:
 * the caller decides what to do with quota-exceeded vs. transport errors.
 *
 * Failure semantics:
 *   • RPC (`check`) — fail closed. A transport error throws
 *     `QuotaUnavailableError('rpc-unreachable')` so the caller aborts the
 *     operation rather than running it without an authoritative debit.
 *   • Lease (`lease`) — fail open with a 10%-of-last-grant emergency
 *     reserve. The client caches the last successful grant per
 *     (scope, metricKey) so subsequent lease requests under outage can
 *     fall through to the cached reserve. Once the reserve is exhausted
 *     the client throws `QuotaUnavailableError('lease-reserve-exhausted')`.
 *
 * The fetch implementation is injectable so tests can run without a live
 * control plane. Default uses `globalThis.fetch`.
 */
import {
  QuotaExceededError,
  QuotaUnavailableError,
  type QuotaCheckRequest,
  type QuotaCheckResult,
  type QuotaLeaseCloseRequest,
  type QuotaLeaseCloseResult,
  type QuotaLeaseGrant,
  type QuotaLeaseRequest,
} from './types.js'

export interface QuotaClientOptions {
  /**
   * Base URL of the canonry-cloud control plane (no trailing slash).
   * Typically read from `CANONRY_CONTROL_PLANE_URL` at process start.
   * Falls back to throwing on the first call when absent.
   */
  controlPlaneUrl: string | undefined
  /**
   * Bearer credential the control plane expects. Reuses the tenant's
   * existing `cnry_…` API key by default. Per the trust-boundary rules
   * in AGENTS.md, every key on an instance can talk to the cloud surface;
   * there's no per-call scope tightening.
   */
  apiKey: string | undefined
  /**
   * Override fetch for tests. Same signature as `globalThis.fetch`.
   * Defaults to the runtime's `fetch` implementation.
   */
  fetch?: typeof globalThis.fetch
  /** Request timeout in milliseconds. Defaults to 5_000. */
  timeoutMs?: number
}

interface LeaseHistoryEntry {
  lastGrantedAmount: number
  remainingReserve: number
}

/**
 * Lease-aware quota client. Single-host instances (one canonry container)
 * keep one client per process — there's no shared cache to worry about, so
 * the constructor is cheap.
 */
export class QuotaClient {
  private readonly controlPlaneUrl: string | undefined
  private readonly apiKey: string | undefined
  private readonly fetchFn: typeof globalThis.fetch
  private readonly timeoutMs: number

  /**
   * Per-(scope, metricKey) cache of the last successful lease grant. Used
   * to compute the 10% emergency reserve when the control plane is
   * unreachable. Keyed by `${scope}::${metricKey}` so multiple sites in
   * the same scope don't share a reserve.
   */
  private readonly leaseHistory = new Map<string, LeaseHistoryEntry>()

  constructor(opts: QuotaClientOptions) {
    this.controlPlaneUrl = opts.controlPlaneUrl
    this.apiKey = opts.apiKey
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? 5_000
  }

  /**
   * Synchronous per-call RPC check. Fails closed: if the control plane is
   * unreachable, throws `QuotaUnavailableError('rpc-unreachable')` so the
   * caller aborts the operation.
   *
   * The control plane returns HTTP 200 for both allowed and quota-exceeded
   * outcomes — `allowed=false` does NOT throw on its own. Use
   * `checkOrThrow()` if you want a quota-exceeded result to throw.
   *
   * Per spec §14 the legacy HTTP 429 mapping (with body
   * `{ resets_at }`) is also accepted for forwards-compat with older
   * control-plane builds.
   */
  async check(request: QuotaCheckRequest): Promise<QuotaCheckResult> {
    if (!this.controlPlaneUrl || !this.apiKey) {
      throw new QuotaUnavailableError(
        request.scope,
        'rpc-unreachable',
        'control plane URL or API key not configured',
      )
    }
    const url = `${this.controlPlaneUrl}/quota/check`
    let response: Response
    try {
      response = await this.postJson(url, {
        tenant_id: request.tenantId,
        project_slug: request.projectSlug,
        scope: request.scope,
        metric_key: request.metricKey,
        amount: request.amount,
      })
    } catch (err) {
      throw new QuotaUnavailableError(
        request.scope,
        'rpc-unreachable',
        err instanceof Error ? err.message : String(err),
      )
    }

    if (response.status === 429) {
      const body = await response.json().catch(() => ({})) as { resets_at?: string; remaining?: number }
      return {
        allowed: false,
        remaining: typeof body.remaining === 'number' ? body.remaining : 0,
        resetsAt: typeof body.resets_at === 'string' ? body.resets_at : undefined,
      }
    }
    if (!response.ok) {
      throw new QuotaUnavailableError(
        request.scope,
        'rpc-unreachable',
        `control plane responded ${response.status}`,
      )
    }

    const body = await response.json().catch(() => ({})) as {
      allowed?: boolean
      remaining?: number
      resets_at?: string
    }
    return {
      allowed: body.allowed === true,
      remaining: typeof body.remaining === 'number' ? body.remaining : 0,
      resetsAt: typeof body.resets_at === 'string' ? body.resets_at : undefined,
    }
  }

  /**
   * Convenience wrapper around `check` that throws `QuotaExceededError`
   * when the call is denied. Most call sites want this — they only ever
   * proceed when allowed.
   */
  async checkOrThrow(request: QuotaCheckRequest): Promise<QuotaCheckResult> {
    const result = await this.check(request)
    if (!result.allowed) {
      throw new QuotaExceededError(request.scope, request.metricKey, result.resetsAt)
    }
    return result
  }

  /**
   * Acquire a lease for a high-volume scope. Fails open with a degraded
   * reserve: when the control plane is unreachable AND we have a prior
   * successful grant cached for this (scope, metricKey), we return a
   * synthetic grant of up to 10% of the last grant. The synthetic
   * `leaseId` is prefixed `degraded-` so `close()` recognises it and
   * skips the network round-trip.
   *
   * Once the reserve is exhausted (or no prior grant exists at all),
   * throws `QuotaUnavailableError('lease-reserve-exhausted')`.
   */
  async acquireLease(request: QuotaLeaseRequest): Promise<QuotaLeaseGrant> {
    const cacheKey = `${request.scope}::${request.metricKey}`

    if (!this.controlPlaneUrl || !this.apiKey) {
      // Unconfigured — fall through to degraded path.
      return this.takeDegradedReserve(request, cacheKey, 'control plane URL or API key not configured')
    }

    let response: Response
    try {
      response = await this.postJson(`${this.controlPlaneUrl}/quota/lease`, {
        tenant_id: request.tenantId,
        project_slug: request.projectSlug,
        scope: request.scope,
        metric_key: request.metricKey,
        requested_amount: request.requestedAmount,
        max_duration_seconds: request.maxDurationSeconds,
        idempotency_key: request.idempotencyKey,
      })
    } catch (err) {
      return this.takeDegradedReserve(
        request,
        cacheKey,
        err instanceof Error ? err.message : String(err),
      )
    }

    if (response.status === 429) {
      const body = await response.json().catch(() => ({})) as { resets_at?: string }
      throw new QuotaExceededError(request.scope, request.metricKey, body.resets_at)
    }
    if (!response.ok) {
      return this.takeDegradedReserve(
        request,
        cacheKey,
        `control plane responded ${response.status}`,
      )
    }

    const body = await response.json().catch(() => ({})) as {
      lease_id?: string
      granted_amount?: number
      expires_at?: string
    }
    if (!body.lease_id || typeof body.granted_amount !== 'number' || !body.expires_at) {
      throw new QuotaUnavailableError(
        request.scope,
        'rpc-unreachable',
        'malformed lease grant from control plane',
      )
    }

    const grant: QuotaLeaseGrant = {
      leaseId: body.lease_id,
      grantedAmount: body.granted_amount,
      expiresAt: body.expires_at,
    }

    // Refresh the degraded-mode reserve based on this fresh grant — next
    // outage starts from a known-good baseline. We don't add to the
    // existing reserve; we replace it (the most recent grant is the best
    // estimate of typical demand).
    this.leaseHistory.set(cacheKey, {
      lastGrantedAmount: grant.grantedAmount,
      remainingReserve: Math.floor(grant.grantedAmount * 0.1),
    })

    return grant
  }

  /**
   * Close out a lease, refunding the unused balance. Idempotent on the
   * server side — retries with the same `leaseId` collapse to one refund.
   *
   * Synthetic `degraded-` leases (issued from the local reserve during a
   * control-plane outage) skip the network round-trip and resolve
   * immediately with `refunded=0` since there's nothing on the server
   * side to refund to.
   */
  async closeLease(leaseId: string, request: QuotaLeaseCloseRequest): Promise<QuotaLeaseCloseResult> {
    if (leaseId.startsWith('degraded-')) {
      return { refunded: 0 }
    }
    if (!this.controlPlaneUrl || !this.apiKey) {
      // Unconfigured but real leaseId — refund attempt is futile.
      return { refunded: 0 }
    }
    let response: Response
    try {
      response = await this.postJson(
        `${this.controlPlaneUrl}/quota/lease/${encodeURIComponent(leaseId)}/close`,
        { used_amount: request.usedAmount },
      )
    } catch {
      // Best-effort: a failed close doesn't poison the operation that
      // consumed the lease. The control plane's expiry reaper will
      // eventually mark the lease as expired with no refund.
      return { refunded: 0 }
    }
    if (!response.ok) {
      return { refunded: 0 }
    }
    const body = await response.json().catch(() => ({})) as { refunded?: number }
    return { refunded: typeof body.refunded === 'number' ? body.refunded : 0 }
  }

  // ── internal ──────────────────────────────────────────────────────

  private takeDegradedReserve(
    request: QuotaLeaseRequest,
    cacheKey: string,
    reason: string,
  ): QuotaLeaseGrant {
    const history = this.leaseHistory.get(cacheKey)
    if (!history || history.remainingReserve <= 0) {
      throw new QuotaUnavailableError(
        request.scope,
        'lease-reserve-exhausted',
        reason,
      )
    }

    // Hand out the smaller of the caller's requested amount and the
    // remaining reserve. The reserve can be drained across multiple
    // degraded-mode calls until it's gone.
    const grantedAmount = Math.min(request.requestedAmount, history.remainingReserve)
    history.remainingReserve -= grantedAmount

    return {
      leaseId: `degraded-${cacheKey}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      grantedAmount,
      // Synthetic expiry — caller should treat degraded leases as
      // short-lived. We use the caller's requested duration capped to
      // 60 seconds since the control plane will catch up shortly.
      expiresAt: new Date(Date.now() + Math.min(request.maxDurationSeconds, 60) * 1000).toISOString(),
    }
  }

  /**
   * Internal POST helper with timeout + auth header injection. Throws on
   * any transport error so callers can map it to the appropriate
   * QuotaUnavailableError variant.
   */
  private async postJson(url: string, body: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Convenience constructor that reads `CANONRY_CONTROL_PLANE_URL` and
 * `CANONRY_API_KEY` from `process.env`. Same posture as the rest of the
 * runtime — config flows through env vars in cloud deployments.
 */
export function createQuotaClientFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaClient {
  return new QuotaClient({
    controlPlaneUrl: env.CANONRY_CONTROL_PLANE_URL?.trim().replace(/\/+$/, '') || undefined,
    apiKey: env.CANONRY_API_KEY?.trim() || undefined,
  })
}

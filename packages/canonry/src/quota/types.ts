/**
 * Quota client types (Track 1 — Canonry Hosted, spec §14).
 *
 * Two surfaces:
 *   • RPC mode  — synchronous per-call check for coarse scopes (sweeps,
 *                 discovery, action executions). Latency is acceptable
 *                 because each scope sees at most a few calls per minute.
 *   • Lease mode — pre-issued allowance for high-volume scopes (provider
 *                 tokens, GSC API calls). Caller reserves an amount, uses
 *                 some fraction, then refunds the rest on close.
 *
 * Failure semantics per spec §14:
 *   - RPC scopes fail closed when the control plane is unreachable — the
 *     caller throws so the operation aborts.
 *   - Lease scopes fail open with a degraded-mode cap: 10% of the last
 *     successful grant becomes an emergency reserve, after which the
 *     caller throws. The reserve protects the operator from runaway spend
 *     during a control-plane outage without halting all work immediately.
 */

/** Coarse RPC scopes — one network round-trip per check. */
export type QuotaRpcScope =
  | 'sweeps_per_tenant_per_month'
  | 'discovery_per_tenant_per_month'
  | 'action_executions_per_tenant_per_month'

/** Lease-based scopes — pre-issued allowance, closed-out on completion. */
export type QuotaLeaseScope =
  | 'provider_tokens_per_tenant_per_month'
  | 'gsc_per_site_per_day'
  | 'gsc_per_managed_client_aggregate_per_day'

export type QuotaScope = QuotaRpcScope | QuotaLeaseScope

export interface QuotaCheckRequest {
  /** Tenant scope identifier. Sourced from `cloud_metadata.tenant_id`. */
  tenantId: string
  /** Optional project slug — present for per-project scopes; omit for tenant-wide. */
  projectSlug?: string
  scope: QuotaRpcScope
  /** Free-form metric key — typically a site URL, domain, or `*` for wildcard. */
  metricKey: string
  /** Amount to debit on success. Must be a positive integer. */
  amount: number
}

export interface QuotaCheckResult {
  allowed: boolean
  /** Remaining budget after this debit (0 when allowed=false). */
  remaining: number
  /** ISO-8601 timestamp when the period rolls over and budget resets. */
  resetsAt?: string
}

export interface QuotaLeaseRequest {
  tenantId: string
  projectSlug?: string
  scope: QuotaLeaseScope
  metricKey: string
  /** Amount the caller would like to reserve. Server may grant less. */
  requestedAmount: number
  /** Max lease duration. Server may impose a shorter cap. */
  maxDurationSeconds: number
  /**
   * Idempotency token — when the caller retries a lease request after a
   * network error, pass the same token so the control plane returns the
   * existing lease instead of issuing a second one.
   */
  idempotencyKey?: string
}

export interface QuotaLeaseGrant {
  leaseId: string
  /** Actually granted amount (may be < requestedAmount). */
  grantedAmount: number
  /** ISO-8601 expiry. After this timestamp the lease is reaped server-side. */
  expiresAt: string
}

export interface QuotaLeaseCloseRequest {
  /** Tokens actually used. Must be in [0, grantedAmount]. */
  usedAmount: number
}

export interface QuotaLeaseCloseResult {
  /** Amount returned to the per-tenant budget (grantedAmount - usedAmount). */
  refunded: number
}

/**
 * Lifted from the spec §14 envelope so callers can `instanceof` on it
 * and route quota-exceeded vs. transport errors differently.
 */
export class QuotaExceededError extends Error {
  readonly scope: QuotaScope
  readonly metricKey: string
  readonly resetsAt: string | undefined
  constructor(scope: QuotaScope, metricKey: string, resetsAt?: string) {
    super(`Quota exceeded for ${scope} (${metricKey})${resetsAt ? `; resets at ${resetsAt}` : ''}`)
    this.name = 'QuotaExceededError'
    this.scope = scope
    this.metricKey = metricKey
    this.resetsAt = resetsAt
  }
}

/**
 * Raised when the control plane is unreachable AND the failure-mode
 * for this scope is fail-closed (RPC mode), or when a lease scope has
 * exhausted its emergency reserve and the next call would exceed the
 * 10%-of-last-grant cap.
 */
export class QuotaUnavailableError extends Error {
  readonly scope: QuotaScope
  readonly reason: 'rpc-unreachable' | 'lease-reserve-exhausted'
  constructor(scope: QuotaScope, reason: QuotaUnavailableError['reason'], detail?: string) {
    super(`Quota service unavailable for ${scope}: ${reason}${detail ? ` (${detail})` : ''}`)
    this.name = 'QuotaUnavailableError'
    this.scope = scope
    this.reason = reason
  }
}

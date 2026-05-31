/**
 * Lease-aware quota client (Track 1 — Canonry Hosted).
 *
 * Public surface used by the LLM proxy + GSC sync paths to coordinate with
 * the cloud control plane on tenant budgets. See `client.ts` for the spec.
 */
export {
  QuotaClient,
  createQuotaClientFromEnv,
  type QuotaClientOptions,
} from './client.js'
export {
  QuotaExceededError,
  QuotaUnavailableError,
  type QuotaCheckRequest,
  type QuotaCheckResult,
  type QuotaLeaseCloseRequest,
  type QuotaLeaseCloseResult,
  type QuotaLeaseGrant,
  type QuotaLeaseRequest,
  type QuotaLeaseScope,
  type QuotaRpcScope,
  type QuotaScope,
} from './types.js'

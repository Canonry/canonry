import { z } from 'zod'

/**
 * How one run's providers are dispatched, decided once at queue time (#1201).
 *
 * The provider-level vocabulary (dispatch mode, batch status, usage, prices)
 * lives in `provider-batch.ts`. This module holds what the run layer adds on
 * top of it: the per-slot ledger outcome, the eligibility rules that decide
 * which providers of a run go to a batch API, and the run-detail shapes that
 * report on them.
 */

/**
 * What became of one line of a provider batch (`provider_batch_requests.outcome`).
 * Null on the row until its result has been ingested.
 *
 * - `recorded`     — the answer was parsed and stored as a snapshot
 * - `errored` / `expired` / `canceled` — the provider returned no answer for it
 *   (not billed, so its quota reservation is released)
 * - `parse_failed` — the provider answered, but the answer could not be read
 *   (the sync path throws on the same body, e.g. a failed web search)
 * - `duplicate`    — the slot already had an answer, so nothing was inserted
 */
export const providerBatchRequestOutcomeSchema = z.enum([
  'recorded',
  'errored',
  'expired',
  'canceled',
  'parse_failed',
  'duplicate',
])
export type ProviderBatchRequestOutcome = z.infer<typeof providerBatchRequestOutcomeSchema>
export const ProviderBatchRequestOutcomes = providerBatchRequestOutcomeSchema.enum

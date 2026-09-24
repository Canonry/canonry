import { z } from 'zod'
import type { ProviderConfig } from './provider.js'

/**
 * Batch dispatch for scheduled sweeps (#1201).
 *
 * A provider in `batch` mode submits every slot of a plan run to the
 * provider's asynchronous batch API instead of calling it once per slot. The
 * request body is the one the synchronous path sends, and the response is
 * parsed by the same function, so a batch row is stored in the same shape as
 * a sync row. Only the dispatch differs, and every snapshot records which one
 * produced it.
 */

/** How one provider's slots in one run were dispatched. */
export const providerDispatchModeSchema = z.enum(['sync', 'batch'])
export type ProviderDispatchMode = z.infer<typeof providerDispatchModeSchema>
export const ProviderDispatchModes = providerDispatchModeSchema.enum

/**
 * Per-project preference: provider -> dispatch mode. A provider that is not
 * listed runs `sync`. Only scheduled sweeps read it; a manual run is sync
 * unless the request asks for batch explicitly.
 */
export const providerDispatchModesSchema = z.record(z.string(), providerDispatchModeSchema)
export type ProviderDispatchModesMap = z.infer<typeof providerDispatchModesSchema>

/**
 * Lifecycle of one provider batch (`provider_batches.status`).
 *
 * - `submitting` — the row was written before the submit call. A row left here
 *   by a crash has an UNKNOWN outcome and is never resubmitted automatically.
 * - `submitted`  — the provider accepted it and returned an id; the poller owns it.
 * - `ended`      — the provider finished it; results are ready to ingest.
 * - `ingested`   — every result line was mapped to its slot (recorded or missing).
 * - `cancelled`  — cancelled by the run, or by its deadline, and not ingested.
 * - `failed`     — the provider definitely did not create it (the slots fell back to sync).
 * - `unknown`    — the submit outcome could not be determined (at-most-once rule).
 */
export const providerBatchStatusSchema = z.enum([
  'submitting',
  'submitted',
  'ended',
  'ingested',
  'cancelled',
  'failed',
  'unknown',
])
export type ProviderBatchStatus = z.infer<typeof providerBatchStatusSchema>
export const ProviderBatchStatuses = providerBatchStatusSchema.enum

/** Batch statuses the poller still has work for. A run with one of these is batch-pending. */
export const OUTSTANDING_PROVIDER_BATCH_STATUSES: readonly ProviderBatchStatus[] = [
  ProviderBatchStatuses.submitted,
  ProviderBatchStatuses.ended,
]

/** The price tier one answer was billed at. */
export const pricingTierSchema = z.enum(['standard', 'batch'])
export type PricingTier = z.infer<typeof pricingTierSchema>
export const PricingTiers = pricingTierSchema.enum

/**
 * Billable usage of one answer, read off the provider's own response. Counts
 * are integers and never negative; a provider that does not report a field
 * reports 0 for it.
 *
 * - `inputTokens`       — uncached input tokens (billed at the input rate)
 * - `cachedInputTokens` — cache-read input tokens
 * - `cacheWriteTokens`  — cache-creation input tokens (Claude only; 0 elsewhere)
 * - `outputTokens`      — output tokens, reasoning included
 * - `searchCount`       — web searches the provider executed for this answer
 *   (Claude `usage.server_tool_use.web_search_requests`, OpenAI `web_search_call`
 *   output items, Gemini `groundingMetadata.webSearchQueries` length)
 */
export const providerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  searchCount: z.number().int().nonnegative(),
})
export type ProviderUsage = z.infer<typeof providerUsageSchema>

/**
 * `query_snapshots.usage`: the answer's usage plus its price, estimated when
 * the answer was recorded. Null on rows that predate usage capture.
 *
 * `estimatedCostMicros` is integer micro-USD (1 USD = 1,000,000), or null when
 * no price is known for the model. `priceSource` says where the price came
 * from: the built-in table, an operator override in config.yaml, or null when
 * unpriced.
 */
export const snapshotUsageSchema = providerUsageSchema.extend({
  pricingTier: pricingTierSchema,
  estimatedCostMicros: z.number().int().nonnegative().nullable(),
  priceSource: z.enum(['default', 'override']).nullable(),
})
export type SnapshotUsage = z.infer<typeof snapshotUsageSchema>

/**
 * Price of one model, in USD. Token prices are per million tokens; the search
 * fee is per 1,000 billing units, where the unit is one executed search
 * (`query`) or one grounded answer regardless of how many searches ran
 * (`prompt`, Gemini 2.5).
 *
 * `batchTokenDiscount` is the fraction of the token price charged in batch
 * (0.5 = half price). Search fees are never discounted in batch: every
 * provider that documents it bills search at the full sync price.
 */
export const modelPriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
  outputPerMTok: z.number().nonnegative(),
  searchPer1k: z.number().nonnegative().optional(),
  searchUnit: z.enum(['query', 'prompt']).optional(),
  batchTokenDiscount: z.number().min(0).max(1).optional(),
}).strict()
export type ModelPrice = z.infer<typeof modelPriceSchema>

/**
 * Operator price overrides for one provider (config.yaml
 * `providers.<name>.pricing.models`), keyed by model id. An exact id wins
 * over the built-in table's entry for it.
 */
export const providerPricingSchema = z.object({
  models: z.record(z.string().min(1), modelPriceSchema).default({}),
}).strict()
export type ProviderPricing = z.infer<typeof providerPricingSchema>

/**
 * Instance-level batch settings for one provider (config.yaml
 * `providers.<name>.batch`). Off unless `enabled` is true. Batch mode is not
 * zero-data-retention eligible on Anthropic, so it must stay off for ZDR
 * deployments.
 *
 * - `maxRequestsPerBatch` — split a provider's slots into batches no larger
 *   than this (never above the adapter's own hard limit)
 * - `deadlineHours` — cancel a batch that has not ended this long after it was
 *   submitted, so the run can finalize and be filled the same day
 */
export const providerBatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxRequestsPerBatch: z.number().int().positive().optional(),
  deadlineHours: z.number().positive().optional(),
}).strict()
export type ProviderBatchConfig = z.infer<typeof providerBatchConfigSchema>

/**
 * One tracked-query request as the synchronous path sends it on the wire.
 * `body` is the exact JSON body, after any SDK normalization, so a batch line
 * built from it asks the provider the identical question.
 */
export interface TrackedQueryRequest {
  /** Provider endpoint the body targets, e.g. `/v1/messages`. */
  endpoint: string
  body: Record<string, unknown>
}

/** One line of a batch submission. `customId` is canonry's short request id. */
export interface ProviderBatchRequestInput {
  customId: string
  request: TrackedQueryRequest
}

export interface ProviderBatchSubmitResult {
  providerBatchId: string
  /** When the provider will expire the batch if it has not ended, when it says. */
  expiresAt?: string
}

export type ProviderBatchPollStatus = 'in_progress' | 'canceling' | 'ended'

export interface ProviderBatchRequestCounts {
  processing: number
  succeeded: number
  errored: number
  canceled: number
  expired: number
}

export interface ProviderBatchPollResult {
  status: ProviderBatchPollStatus
  requestCounts?: ProviderBatchRequestCounts
  endedAt?: string
  /** When the provider deletes the results, when it says. */
  resultsExpireAt?: string
}

/**
 * One result line. Lines arrive in any order; map them by `customId`.
 *
 * A `succeeded` line carries the response body in the shape the sync path
 * stores as `apiResponse` (Claude: `result.message`). Every other type left
 * the slot unanswered, and per every provider's docs is not billed.
 */
export type ProviderBatchResultLine =
  | { customId: string; type: 'succeeded'; body: Record<string, unknown> }
  | { customId: string; type: 'errored' | 'canceled' | 'expired'; error: string }

/**
 * Thrown by `submit`. `definite: true` means the provider confirmed no batch
 * was created (a 4xx before acceptance, a local validation failure), so the
 * caller may fall back to sync. `definite: false` means the outcome is
 * unknown (timeout, dropped connection, 5xx after send) and the caller must
 * not resubmit.
 */
export class ProviderBatchSubmitError extends Error {
  readonly definite: boolean
  constructor(message: string, opts: { definite: boolean; cause?: unknown }) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'ProviderBatchSubmitError'
    this.definite = opts.definite
  }
}

/**
 * The optional batch half of a provider adapter. An adapter that has it also
 * implements `buildTrackedQueryRequest` and `parseTrackedQueryResponse`, which
 * are how a batch line is built and how its result is read back.
 */
export interface ProviderBatchCapability {
  /** Provider hard limit on requests in one batch. */
  maxRequestsPerBatch: number
  /** Provider hard limit on the serialized size of one batch, in bytes. */
  maxBytesPerBatch: number
  /** Default hours after submission before canonry cancels a batch that has not ended. */
  defaultDeadlineHours: number
  submit(requests: readonly ProviderBatchRequestInput[], config: ProviderConfig): Promise<ProviderBatchSubmitResult>
  poll(providerBatchId: string, config: ProviderConfig): Promise<ProviderBatchPollResult>
  results(providerBatchId: string, config: ProviderConfig): AsyncIterable<ProviderBatchResultLine>
  cancel(providerBatchId: string, config: ProviderConfig): Promise<void>
}

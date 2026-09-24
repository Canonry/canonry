import { z } from 'zod'
import {
  PricingTiers,
  ProviderDispatchModes,
  type PricingTier,
  type ProviderDispatchMode,
  type ProviderDispatchModesMap,
  type SnapshotUsage,
} from './provider-batch.js'
import { RunTriggers, type RunDispatchModes, type RunTrigger, type RunUsageSummaryRow } from './run.js'

/**
 * How one run's providers are dispatched, decided once at queue time (#1201).
 *
 * The provider-level vocabulary (dispatch mode, batch status, usage, prices)
 * lives in `provider-batch.ts`. This module holds what the run layer adds on
 * top of it: the per-slot ledger outcome, the eligibility rules that decide
 * which providers of a run go to a batch API, and the usage summary the run
 * detail reports.
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

/**
 * Why a provider that was asked to batch runs sync instead.
 *
 * - `not_plan_run`      — the run measures no published plan. Its rows have no
 *   execution id, so a failed line could neither be deduplicated nor filled.
 * - `scoped_run`        — the run measures a slice (a measurement scope or a
 *   query list). Only a full sweep batches.
 * - `probe_run`         — probes are operator checks and always run sync.
 * - `batch_unavailable` — this instance cannot batch the provider: its adapter
 *   has no batch API, or `providers.<name>.batch.enabled` is not true.
 * - `model_not_frozen`  — a slot of the provider has no model frozen in the
 *   run's manifest, so a failed line could never be filled with the same model.
 */
export const providerBatchIneligibilityReasonSchema = z.enum([
  'not_plan_run',
  'scoped_run',
  'probe_run',
  'batch_unavailable',
  'model_not_frozen',
])
export type ProviderBatchIneligibilityReason = z.infer<typeof providerBatchIneligibilityReasonSchema>
export const ProviderBatchIneligibilityReasons = providerBatchIneligibilityReasonSchema.enum

export interface RunDispatchInput {
  /** The trigger the run is stored with (a spot check is stored as `probe`). */
  trigger: RunTrigger | string
  /** The mode the request asked for explicitly. Null or undefined when it did not ask. */
  requestedMode?: ProviderDispatchMode | null
  /** The project's stored preference. Read only for scheduled runs. */
  projectModes?: ProviderDispatchModesMap | null
  /** The providers the run measures: the manifest's for a plan run, the roster for a planless one. */
  providers: readonly string[]
  /** The run's frozen expected slots, or null for a planless run. */
  expectedSlots: ReadonlyArray<{ provider: string; requestedModel?: string }> | null
  /** True when the run measures a subset (a measurement scope or a query list). */
  scoped: boolean
  /** Providers this instance can batch: the adapter has a batch API AND config enables it. */
  batchEligibleProviders?: readonly string[] | null
}

export interface RunDispatchResolution {
  /** The providers frozen onto the run as `batch`. Empty when all run sync. */
  modes: RunDispatchModes
  /** Providers that were asked to batch but run sync, with the reason. */
  ineligible: Partial<Record<string, ProviderBatchIneligibilityReason>>
  /** Every provider that was asked to batch, sorted. */
  requested: string[]
}

function normalizeProviderName(value: string): string {
  return value.trim().toLocaleLowerCase('en')
}

/**
 * Decide, once at queue time, which of a run's providers go to a batch API.
 *
 * Who asks: an explicit `requestedMode` always wins (`sync` asks for nothing,
 * `batch` asks for every provider in the run). Without one, only a SCHEDULED
 * run asks, for the providers its project marks `batch`; manual, API, apply
 * and backfill runs stay sync. A preference for a provider the run does not
 * measure is ignored.
 *
 * Who may: a provider is eligible only on a full plan sweep that is not a
 * probe, only when this instance can batch it, and only when every one of its
 * slots froze a model. A run-level reason is reported for every provider
 * before any provider-level one, since fixing the provider would not help.
 */
export function resolveRunDispatchModes(input: RunDispatchInput): RunDispatchResolution {
  const runProviders = [...new Set(input.providers.map(normalizeProviderName).filter(Boolean))].sort()
  let requested: string[]
  if (input.requestedMode === ProviderDispatchModes.sync) {
    requested = []
  } else if (input.requestedMode === ProviderDispatchModes.batch) {
    requested = runProviders
  } else if (input.trigger === RunTriggers.scheduled) {
    const preferred = new Set(Object.entries(input.projectModes ?? {})
      .filter(([, mode]) => mode === ProviderDispatchModes.batch)
      .map(([provider]) => normalizeProviderName(provider)))
    requested = runProviders.filter(provider => preferred.has(provider))
  } else {
    requested = []
  }

  const runLevel: ProviderBatchIneligibilityReason | null = input.expectedSlots === null
    ? ProviderBatchIneligibilityReasons.not_plan_run
    : input.scoped
      ? ProviderBatchIneligibilityReasons.scoped_run
      : input.trigger === RunTriggers.probe
        ? ProviderBatchIneligibilityReasons.probe_run
        : null

  const batchable = new Set((input.batchEligibleProviders ?? []).map(normalizeProviderName))
  const modes: RunDispatchModes = {}
  const ineligible: Partial<Record<string, ProviderBatchIneligibilityReason>> = {}
  for (const provider of requested) {
    if (runLevel) {
      ineligible[provider] = runLevel
      continue
    }
    if (!batchable.has(provider)) {
      ineligible[provider] = ProviderBatchIneligibilityReasons.batch_unavailable
      continue
    }
    const slots = (input.expectedSlots ?? []).filter(slot => normalizeProviderName(slot.provider) === provider)
    if (slots.length === 0 || slots.some(slot => !slot.requestedModel?.trim())) {
      ineligible[provider] = ProviderBatchIneligibilityReasons.model_not_frozen
      continue
    }
    modes[provider] = ProviderDispatchModes.batch
  }
  return { modes, ineligible, requested }
}

/** Why `provider` runs sync, as one sentence. The only wording of each reason. */
export function describeBatchIneligibility(provider: string, reason: ProviderBatchIneligibilityReason): string {
  switch (reason) {
    case ProviderBatchIneligibilityReasons.not_plan_run:
      return 'the project has no published measurement plan; batch dispatch needs a plan run, whose missing answers can be filled.'
    case ProviderBatchIneligibilityReasons.scoped_run:
      return 'the run measures a slice (a measurement scope or a query list); only a full sweep can batch.'
    case ProviderBatchIneligibilityReasons.probe_run:
      return 'probe runs always run sync.'
    case ProviderBatchIneligibilityReasons.batch_unavailable:
      return `this instance cannot batch ${provider}: its adapter has no batch API, or providers.${provider}.batch.enabled is not true in config.yaml.`
    case ProviderBatchIneligibilityReasons.model_not_frozen:
      return 'some of its answers have no model frozen in the run, so a failed batch line could never be filled with the same model.'
  }
}

/** The refusal for a batch request that no provider of the run can honour, naming each provider's reason. */
export function batchDispatchRefusalMessage(ineligible: Partial<Record<string, ProviderBatchIneligibilityReason>>): string {
  const lines = Object.entries(ineligible)
    .flatMap(([provider, reason]) => reason ? [`${provider}: ${describeBatchIneligibility(provider, reason)}`] : [])
    .sort()
  return [
    'No provider in this run can use batch dispatch.',
    ...(lines.length ? lines : ['The run measures no provider.']),
    'Run it without dispatchMode (or with dispatchMode "sync") to call the providers directly.',
  ].join(' ')
}

/** One stored answer as the usage summary reads it. */
export interface RunUsageSource {
  provider: string
  usage: SnapshotUsage | null
}

const PRICING_TIER_ORDER: readonly PricingTier[] = [PricingTiers.standard, PricingTiers.batch]

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Sum a run's stored usage per provider and price tier: the one computation
 * behind the run detail's `usage`, so no surface adds it up differently.
 *
 * An answer with no usage (it predates capture, or its provider reports none)
 * is counted nowhere: it is unmeasured, not free. Cost sums the priced answers
 * only; a group with no priced answer reports `null`, never a zero that reads
 * as free. Rows sort by provider, then standard before batch.
 */
export function summarizeRunUsage(rows: readonly RunUsageSource[]): RunUsageSummaryRow[] {
  const groups = new Map<string, RunUsageSummaryRow>()
  for (const row of rows) {
    if (!row.usage) continue
    const key = `${row.provider}\u0000${row.usage.pricingTier}`
    const group = groups.get(key) ?? {
      provider: row.provider,
      pricingTier: row.usage.pricingTier,
      answers: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      searchCount: 0,
      estimatedCostMicros: null,
      unpricedAnswers: 0,
    }
    group.answers += 1
    group.inputTokens += row.usage.inputTokens
    group.cachedInputTokens += row.usage.cachedInputTokens
    group.cacheWriteTokens += row.usage.cacheWriteTokens
    group.outputTokens += row.usage.outputTokens
    group.searchCount += row.usage.searchCount
    if (row.usage.estimatedCostMicros === null) {
      group.unpricedAnswers += 1
    } else {
      group.estimatedCostMicros = (group.estimatedCostMicros ?? 0) + row.usage.estimatedCostMicros
    }
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => compareText(left.provider, right.provider)
    || PRICING_TIER_ORDER.indexOf(left.pricingTier) - PRICING_TIER_ORDER.indexOf(right.pricingTier))
}

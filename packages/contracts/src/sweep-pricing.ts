import { PricingTiers, modelPriceSchema } from './provider-batch.js'
import type { ModelPrice, PricingTier, ProviderPricing, ProviderUsage, SnapshotUsage } from './provider-batch.js'

/**
 * Cost estimates for sweep answers (#1201).
 *
 * Every answer's usage is priced once, when it is recorded, and the estimate
 * is stored on the snapshot. A price is looked up by exact model id: an
 * operator override from config.yaml first, then the built-in table. A model
 * neither knows is left unpriced (`estimatedCostMicros: null`) rather than
 * guessed from a similar id.
 */

/** Where a price came from. */
export type ModelPriceSource = NonNullable<SnapshotUsage['priceSource']>

export interface ResolvedModelPrice {
  price: ModelPrice
  source: ModelPriceSource
}

const SearchUnits = modelPriceSchema.shape.searchUnit.unwrap().enum

// Anthropic bills web search at $10 per 1,000 searches executed, at the full
// price in batch; the batch discount halves token prices only.
const CLAUDE_SEARCH_AND_BATCH = {
  searchPer1k: 10,
  searchUnit: SearchUnits.query,
  batchTokenDiscount: 0.5,
} as const satisfies Partial<ModelPrice>

/**
 * Built-in prices, USD per million tokens, keyed by provider then exact model
 * id. Claude only; other providers are priced through config.yaml overrides.
 *
 * Verified 2026-09-24 against Anthropic's model table
 * (https://platform.claude.com/docs/en/about-claude/pricing). A cache read is
 * priced at the listed rate where the table lists one and at 0.1× input
 * otherwise; a cache write at 1.25× input (see `estimateAnswerCostMicros`).
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, Readonly<Record<string, ModelPrice>>>> = {
  claude: {
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.2, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cachedInputPerMTok: 0.25, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, ...CLAUDE_SEARCH_AND_BATCH },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, ...CLAUDE_SEARCH_AND_BATCH },
  },
}

/** Cache reads default to a tenth of the input price, cache writes to 1.25×. */
const DEFAULT_CACHED_INPUT_MULTIPLIER = 0.1
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25
/** Batch token price as a fraction of standard when the price does not say. */
const DEFAULT_BATCH_TOKEN_DISCOUNT = 0.5

/**
 * Price one model: an override for the exact id wins, then the built-in table.
 * Returns null when neither has the id. Lookups are own-property only, so an
 * id like `constructor` never resolves to an object prototype member.
 */
export function resolveModelPrice(
  provider: string,
  model: string,
  overrides?: ProviderPricing,
): ResolvedModelPrice | null {
  if (overrides && Object.hasOwn(overrides.models, model)) {
    return { price: overrides.models[model]!, source: 'override' }
  }
  const table = Object.hasOwn(DEFAULT_MODEL_PRICES, provider) ? DEFAULT_MODEL_PRICES[provider]! : undefined
  if (table && Object.hasOwn(table, model)) {
    return { price: table[model]!, source: 'default' }
  }
  return null
}

/**
 * Estimated cost of one answer, in integer micro-USD (1 USD = 1,000,000).
 *
 * A token count times a USD-per-million-tokens price is already micro-USD, so
 * tokens are summed at their rates directly; the batch tier then scales the
 * token total by `batchTokenDiscount`. The search fee is per 1,000 billing
 * units — every executed search (`query`), or one per answer that searched at
 * all (`prompt`) — and is never discounted. Rounded once, at the end.
 */
export function estimateAnswerCostMicros(usage: ProviderUsage, price: ModelPrice, tier: PricingTier): number {
  const cachedInputRate = price.cachedInputPerMTok ?? DEFAULT_CACHED_INPUT_MULTIPLIER * price.inputPerMTok
  const cacheWriteRate = price.cacheWritePerMTok ?? DEFAULT_CACHE_WRITE_MULTIPLIER * price.inputPerMTok
  const tokenMicros =
    usage.inputTokens * price.inputPerMTok
    + usage.cachedInputTokens * cachedInputRate
    + usage.cacheWriteTokens * cacheWriteRate
    + usage.outputTokens * price.outputPerMTok
  const tierMultiplier = tier === PricingTiers.batch ? price.batchTokenDiscount ?? DEFAULT_BATCH_TOKEN_DISCOUNT : 1

  const billedSearchUnits = price.searchUnit === SearchUnits.prompt
    ? (usage.searchCount > 0 ? 1 : 0)
    : usage.searchCount
  // $ per 1,000 units → micro-USD per unit is ×1,000.
  const searchMicros = billedSearchUnits * (price.searchPer1k ?? 0) * 1_000

  return Math.round(tokenMicros * tierMultiplier + searchMicros)
}

export interface SnapshotUsageContext {
  provider: string
  /** The model the request asked for; prices are keyed by requested id. */
  model: string
  tier: PricingTier
  overrides?: ProviderPricing
}

/**
 * The `query_snapshots.usage` value for one answer: its usage plus the price
 * estimate. Null when the response reported no usage, so a row that could not
 * be measured is never stored as a zero-cost one.
 */
export function buildSnapshotUsage(usage: ProviderUsage | undefined, context: SnapshotUsageContext): SnapshotUsage | null {
  if (!usage) return null
  const resolved = resolveModelPrice(context.provider, context.model, context.overrides)
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    searchCount: usage.searchCount,
    pricingTier: context.tier,
    estimatedCostMicros: resolved ? estimateAnswerCostMicros(usage, resolved.price, context.tier) : null,
    priceSource: resolved?.source ?? null,
  }
}

/**
 * Read one count off a provider's usage object as a non-negative integer.
 * A missing, non-numeric, non-finite, or negative value reads as 0, so a
 * provider that omits a field reports none of it rather than breaking the row.
 */
export function usageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

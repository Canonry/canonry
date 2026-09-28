import { describe, test, expect } from 'vitest'

import {
  DEFAULT_MODEL_PRICES,
  buildSnapshotUsage,
  estimateAnswerCostMicros,
  resolveModelPrice,
  usageCount,
} from '../src/sweep-pricing.js'
import { PricingTiers, modelPriceSchema, snapshotUsageSchema } from '../src/provider-batch.js'
import type { ModelPrice, ProviderUsage } from '../src/provider-batch.js'

const ZERO_USAGE: ProviderUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  searchCount: 0,
}

// Every token field and the search count are non-zero, so each rate is exercised.
const MIXED_USAGE: ProviderUsage = {
  inputTokens: 1_000,
  cachedInputTokens: 2_000,
  cacheWriteTokens: 500,
  outputTokens: 800,
  searchCount: 3,
}

const SONNET_4_6 = DEFAULT_MODEL_PRICES.claude!['claude-sonnet-4-6']!
const OPUS_5_5 = DEFAULT_MODEL_PRICES.claude!['claude-opus-5-5']!

describe('DEFAULT_MODEL_PRICES', () => {
  test('pins the Claude table: input/output per MTok, listed cache reads, $10 per 1k searches, half-price batch tokens', () => {
    const search = { searchPer1k: 10, searchUnit: 'query', batchTokenDiscount: 0.5 }
    expect(DEFAULT_MODEL_PRICES).toEqual({
      claude: {
        'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cachedInputPerMTok: 0.2, ...search },
        'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cachedInputPerMTok: 0.25, ...search },
        'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, ...search },
        'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, ...search },
        'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, ...search },
        'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, ...search },
        'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, ...search },
        'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, ...search },
        'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, ...search },
        'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, ...search },
      },
    })
  })

  test('every built-in entry is a valid ModelPrice', () => {
    for (const models of Object.values(DEFAULT_MODEL_PRICES)) {
      for (const price of Object.values(models)) {
        expect(modelPriceSchema.safeParse(price).success).toBe(true)
      }
    }
  })
})

describe('resolveModelPrice', () => {
  test('returns the built-in price for an exact model id', () => {
    expect(resolveModelPrice('claude', 'claude-sonnet-4-6')).toEqual({ price: SONNET_4_6, source: 'default' })
  })

  test('an operator override for the exact id beats the built-in table', () => {
    const override: ModelPrice = { inputPerMTok: 1.5, outputPerMTok: 7.5 }
    expect(resolveModelPrice('claude', 'claude-sonnet-4-6', { models: { 'claude-sonnet-4-6': override } }))
      .toEqual({ price: override, source: 'override' })
  })

  test('an override prices a model the table does not know', () => {
    const override: ModelPrice = { inputPerMTok: 0.3, outputPerMTok: 2.5, searchPer1k: 35, searchUnit: 'prompt' }
    expect(resolveModelPrice('gemini', 'gemini-2.5-flash', { models: { 'gemini-2.5-flash': override } }))
      .toEqual({ price: override, source: 'override' })
  })

  test('an override for a different model does not shadow the built-in price', () => {
    const overrides = { models: { 'claude-haiku-4-5': { inputPerMTok: 9, outputPerMTok: 9 } } }
    expect(resolveModelPrice('claude', 'claude-sonnet-4-6', overrides)).toEqual({ price: SONNET_4_6, source: 'default' })
  })

  test('an unknown model is unpriced, never matched by prefix', () => {
    expect(resolveModelPrice('claude', 'claude-sonnet-4-6-20260214')).toBeNull()
    expect(resolveModelPrice('claude', 'claude-sonnet')).toBeNull()
    expect(resolveModelPrice('openai', 'gpt-5.4')).toBeNull()
  })

  test('a model id is looked up under its own provider only', () => {
    expect(resolveModelPrice('openai', 'claude-sonnet-4-6')).toBeNull()
  })

  test('object prototype keys are not prices', () => {
    expect(resolveModelPrice('claude', 'toString')).toBeNull()
    expect(resolveModelPrice('constructor', 'claude-sonnet-4-6')).toBeNull()
    expect(resolveModelPrice('claude', 'constructor', { models: {} })).toBeNull()
  })
})

describe('estimateAnswerCostMicros', () => {
  test('zero usage costs nothing on either tier', () => {
    expect(estimateAnswerCostMicros(ZERO_USAGE, SONNET_4_6, PricingTiers.standard)).toBe(0)
    expect(estimateAnswerCostMicros(ZERO_USAGE, SONNET_4_6, PricingTiers.batch)).toBe(0)
  })

  test('standard tier: each token class at its own rate plus the per-search fee', () => {
    // input 1000 × $3 = 3000; cached 2000 × $0.30 (0.1× input) = 600;
    // cache write 500 × $3.75 (1.25× input) = 1875; output 800 × $15 = 12000;
    // 3 searches × $10 / 1000 = $0.03 = 30000 micros.
    expect(estimateAnswerCostMicros(MIXED_USAGE, SONNET_4_6, PricingTiers.standard)).toBe(3_000 + 600 + 1_875 + 12_000 + 30_000)
  })

  test('batch tier halves the tokens but never the search fee, rounding once at the end', () => {
    // tokens 17475 × 0.5 = 8737.5, + 30000 search = 38737.5 → 38738.
    expect(estimateAnswerCostMicros(MIXED_USAGE, SONNET_4_6, PricingTiers.batch)).toBe(38_738)
  })

  test('a listed cache-read price is used instead of 0.1× input', () => {
    const usage: ProviderUsage = { ...ZERO_USAGE, inputTokens: 10_000, cachedInputTokens: 50_000, outputTokens: 2_000, searchCount: 1 }
    // 10000 × $4 + 50000 × $0.20 + 2000 × $20 = 90000; one search = 10000.
    expect(estimateAnswerCostMicros(usage, OPUS_5_5, PricingTiers.standard)).toBe(100_000)
    expect(estimateAnswerCostMicros(usage, OPUS_5_5, PricingTiers.batch)).toBe(55_000)
  })

  test('explicit cache prices replace the multipliers', () => {
    const price: ModelPrice = { inputPerMTok: 2, cachedInputPerMTok: 1, cacheWritePerMTok: 4, outputPerMTok: 0 }
    const usage: ProviderUsage = { ...ZERO_USAGE, cachedInputTokens: 100, cacheWriteTokens: 100 }
    expect(estimateAnswerCostMicros(usage, price, PricingTiers.standard)).toBe(100 + 400)
  })

  test('the query unit bills every executed search', () => {
    const price: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0, searchPer1k: 14, searchUnit: 'query' }
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, searchCount: 4 }, price, PricingTiers.standard)).toBe(56_000)
  })

  test('an unset search unit bills per executed search', () => {
    const price: ModelPrice = { inputPerMTok: 0, outputPerMTok: 0, searchPer1k: 14 }
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, searchCount: 4 }, price, PricingTiers.standard)).toBe(56_000)
  })

  test('the prompt unit bills one fee per grounded answer however many searches ran', () => {
    const price: ModelPrice = { inputPerMTok: 0.3, outputPerMTok: 2.5, searchPer1k: 35, searchUnit: 'prompt' }
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, searchCount: 4 }, price, PricingTiers.standard)).toBe(35_000)
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, searchCount: 1 }, price, PricingTiers.standard)).toBe(35_000)
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, searchCount: 0 }, price, PricingTiers.standard)).toBe(0)
    // The fee stays whole in batch; only the tokens are halved: 1000 × 2.5 × 0.5 = 1250.
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, outputTokens: 1_000, searchCount: 2 }, price, PricingTiers.batch)).toBe(1_250 + 35_000)
  })

  test('a price with no search fee charges nothing for searches', () => {
    const price: ModelPrice = { inputPerMTok: 1, outputPerMTok: 2 }
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, inputTokens: 10, outputTokens: 10, searchCount: 5 }, price, PricingTiers.standard)).toBe(30)
  })

  test('an explicit batch discount is applied as given', () => {
    const noDiscount: ModelPrice = { inputPerMTok: 1, outputPerMTok: 1, batchTokenDiscount: 1 }
    const quarter: ModelPrice = { inputPerMTok: 1, outputPerMTok: 1, batchTokenDiscount: 0.25 }
    const usage: ProviderUsage = { ...ZERO_USAGE, inputTokens: 100, outputTokens: 100 }
    expect(estimateAnswerCostMicros(usage, noDiscount, PricingTiers.batch)).toBe(200)
    expect(estimateAnswerCostMicros(usage, quarter, PricingTiers.batch)).toBe(50)
    expect(estimateAnswerCostMicros(usage, quarter, PricingTiers.standard)).toBe(200)
  })

  test('rounding boundaries: a sub-micro total rounds to 0, a half micro rounds up', () => {
    // 1 cached token at 0.1 × $3 = 0.3 micros.
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, cachedInputTokens: 1 }, SONNET_4_6, PricingTiers.standard)).toBe(0)
    // 1 input token at $3 in batch = 1.5 micros.
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, inputTokens: 1 }, SONNET_4_6, PricingTiers.batch)).toBe(2)
    // 1 input token at $1 in batch = 0.5 micros.
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, inputTokens: 1 }, DEFAULT_MODEL_PRICES.claude!['claude-haiku-4-5']!, PricingTiers.batch)).toBe(1)
    // Rounded once: 3 cached tokens are 0.9 micros → 1, not 3 × round(0.3) = 0.
    expect(estimateAnswerCostMicros({ ...ZERO_USAGE, cachedInputTokens: 3 }, SONNET_4_6, PricingTiers.standard)).toBe(1)
  })

  test('the result is always an integer', () => {
    const cost = estimateAnswerCostMicros({ ...ZERO_USAGE, inputTokens: 7, cachedInputTokens: 11, outputTokens: 13 }, SONNET_4_6, PricingTiers.batch)
    // (7 × 3 + 11 × 0.3 + 13 × 15) × 0.5 = (21 + 3.3 + 195) × 0.5 = 109.65 → 110.
    expect(cost).toBe(110)
    expect(Number.isInteger(cost)).toBe(true)
  })
})

describe('buildSnapshotUsage', () => {
  test('returns null when the response carried no usage', () => {
    expect(buildSnapshotUsage(undefined, { provider: 'claude', model: 'claude-sonnet-4-6', tier: PricingTiers.standard })).toBeNull()
  })

  test('prices a known model from the built-in table', () => {
    const snapshot = buildSnapshotUsage(MIXED_USAGE, { provider: 'claude', model: 'claude-sonnet-4-6', tier: PricingTiers.batch })
    expect(snapshot).toEqual({
      ...MIXED_USAGE,
      pricingTier: 'batch',
      estimatedCostMicros: 38_738,
      priceSource: 'default',
    })
    expect(snapshotUsageSchema.safeParse(snapshot).success).toBe(true)
  })

  test('an override prices the answer and is recorded as the source', () => {
    const snapshot = buildSnapshotUsage(MIXED_USAGE, {
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      tier: PricingTiers.standard,
      overrides: { models: { 'claude-sonnet-4-6': { inputPerMTok: 1, outputPerMTok: 1 } } },
    })
    // 1000 × 1 + 2000 × 0.1 + 500 × 1.25 + 800 × 1 = 2625; no search fee in the override.
    expect(snapshot).toEqual({ ...MIXED_USAGE, pricingTier: 'standard', estimatedCostMicros: 2_625, priceSource: 'override' })
  })

  test('an unknown model keeps its usage with a null cost and a null source', () => {
    const snapshot = buildSnapshotUsage(MIXED_USAGE, { provider: 'openai', model: 'gpt-5.4', tier: PricingTiers.standard })
    expect(snapshot).toEqual({ ...MIXED_USAGE, pricingTier: 'standard', estimatedCostMicros: null, priceSource: null })
    expect(snapshotUsageSchema.safeParse(snapshot).success).toBe(true)
  })

  test('copies only the usage fields', () => {
    const withExtra = { ...ZERO_USAGE, rawProviderField: 42 } as ProviderUsage
    const snapshot = buildSnapshotUsage(withExtra, { provider: 'claude', model: 'claude-haiku-4-5', tier: PricingTiers.standard })
    expect(snapshot).toEqual({ ...ZERO_USAGE, pricingTier: 'standard', estimatedCostMicros: 0, priceSource: 'default' })
  })
})

describe('usageCount', () => {
  test('keeps a non-negative integer', () => {
    expect(usageCount(0)).toBe(0)
    expect(usageCount(1_234)).toBe(1_234)
  })

  test('reads a missing, non-numeric, or non-finite value as 0', () => {
    expect(usageCount(undefined)).toBe(0)
    expect(usageCount(null)).toBe(0)
    expect(usageCount('12')).toBe(0)
    expect(usageCount(Number.NaN)).toBe(0)
    expect(usageCount(Number.POSITIVE_INFINITY)).toBe(0)
  })

  test('clamps a negative value to 0 and truncates a fraction', () => {
    expect(usageCount(-5)).toBe(0)
    expect(usageCount(7.9)).toBe(7)
  })
})

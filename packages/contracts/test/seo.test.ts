import { describe, expect, it } from 'vitest'
import { seoProfileInputSchema, seoQuoteSchema, seoSyncInputSchema } from '../src/seo.js'

describe('SEO public admission contracts', () => {
  it('requires bounded explicit profile scope and rejects upstream options that could expand spend', () => {
    const input = {
      name: 'Organic research', connectionId: 'primary', capabilities: ['keyword-metrics'],
      targets: [], keywords: ['coffee'], locationCode: 2840, languageCode: 'en', limit: 100,
      scope: { kind: 'property', key: 'store', expectedPlanRevision: 3 },
    }
    expect(seoProfileInputSchema.parse(input).scope).toEqual({ kind: 'property', key: 'store', expectedPlanRevision: 3 })
    expect(seoProfileInputSchema.safeParse({ ...input, includeClickstreamData: true }).success).toBe(false)
    expect(seoProfileInputSchema.safeParse({ ...input, limit: 1001 }).success).toBe(false)
    expect(seoProfileInputSchema.safeParse({ ...input, locationCode: undefined }).success).toBe(false)
  })

  it('has no customer-controlled funding claims in either the intent or submission', () => {
    const quote = {
      token: 'opaque', expiresAt: '2026-10-22T18:00:00Z', profileId: 'p', profileRevision: 1,
      taskCount: 1, targets: [], capabilities: ['keyword-metrics'], availability: 'ready', reason: null,
    }
    expect(seoQuoteSchema.safeParse(quote).success).toBe(true)
    expect(seoQuoteSchema.safeParse({ ...quote, maxCostMicros: 123 }).success).toBe(false)
    expect(seoSyncInputSchema.safeParse({ quoteToken: 'opaque', idempotencyKey: 'stable', fundingMode: 'hosted' }).success).toBe(false)
  })
})

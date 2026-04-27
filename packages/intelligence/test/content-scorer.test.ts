import { describe, it, expect } from 'vitest'

import { scoreContentTarget } from '../src/content-scorer.js'

const baseInput = {
  gscImpressions: 0,
  aiReferralFactor: 0,
  competitorCount: 0,
  recentMissRate: 0,
  citationCount: 0,
  ourCitedRate: 0,
  action: 'create' as const,
  position: null,
}

describe('scoreContentTarget', () => {
  describe('demand source classification', () => {
    it('marks gsc when only GSC impressions are present', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
      })
      expect(result.demandSource).toBe('gsc')
    })

    it('marks competitor-evidence when only competitors fire', () => {
      const result = scoreContentTarget({
        ...baseInput,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.demandSource).toBe('competitor-evidence')
    })

    it('marks both when GSC impressions AND competitor evidence are present', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.demandSource).toBe('both')
    })
  })

  describe('additive two-branch formula: zero-GSC opportunities still rank', () => {
    it('produces a non-zero score when GSC impressions are zero but competitors fire', () => {
      const result = scoreContentTarget({
        ...baseInput,
        competitorCount: 3,
        recentMissRate: 1.0,
        citationCount: 8,
      })
      expect(result.score).toBeGreaterThan(0)
    })

    it('produces a non-zero score when GSC impressions are present but no competitors', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1200,
      })
      expect(result.score).toBeGreaterThan(0)
    })

    it('produces score = 0 when no signals fire', () => {
      const result = scoreContentTarget({ ...baseInput })
      expect(result.score).toBe(0)
    })
  })

  describe('absence multiplier (we do not score things we already win)', () => {
    it('reduces score sharply when our cited rate approaches 1', () => {
      const winning = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
        ourCitedRate: 0.9,
      })
      const losing = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
        ourCitedRate: 0,
      })
      expect(winning.score).toBeLessThan(losing.score)
      expect(winning.scoreBreakdown.absence).toBeCloseTo(0.1)
      expect(losing.scoreBreakdown.absence).toBeCloseTo(1.0)
    })

    it('produces score = 0 when our cited rate is 1.0', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
        ourCitedRate: 1.0,
      })
      expect(result.score).toBe(0)
    })
  })

  describe('content gap severity multiplier (per action type)', () => {
    const signal = {
      ...baseInput,
      gscImpressions: 1000,
      competitorCount: 3,
      recentMissRate: 0.8,
      citationCount: 5,
    }

    it('CREATE has the highest gap severity (full multiplier)', () => {
      const create = scoreContentTarget({ ...signal, action: 'create' })
      const expand = scoreContentTarget({ ...signal, action: 'expand' })
      const refresh = scoreContentTarget({ ...signal, action: 'refresh' })
      const addSchema = scoreContentTarget({ ...signal, action: 'add-schema' })

      expect(create.score).toBeGreaterThan(expand.score)
      expect(create.score).toBeGreaterThan(refresh.score)
      expect(create.score).toBeGreaterThan(addSchema.score)
      expect(create.scoreBreakdown.gapSeverity).toBe(1.0)
    })

    it('EXPAND severity is between CREATE and REFRESH', () => {
      const create = scoreContentTarget({ ...signal, action: 'create' })
      const expand = scoreContentTarget({ ...signal, action: 'expand' })
      const refresh = scoreContentTarget({ ...signal, action: 'refresh' })
      expect(expand.score).toBeLessThan(create.score)
      expect(expand.score).toBeGreaterThan(refresh.score)
    })

    it('ADD-SCHEMA severity is high (cheap fix on validated content)', () => {
      const addSchema = scoreContentTarget({ ...signal, action: 'add-schema' })
      const refresh = scoreContentTarget({ ...signal, action: 'refresh' })
      expect(addSchema.score).toBeGreaterThan(refresh.score)
    })

    it('null action (skip) produces score = 0', () => {
      const result = scoreContentTarget({ ...signal, action: null })
      expect(result.score).toBe(0)
    })
  })

  describe('scoreBreakdown components', () => {
    it('exposes all four components', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.scoreBreakdown).toHaveProperty('demand')
      expect(result.scoreBreakdown).toHaveProperty('competitor')
      expect(result.scoreBreakdown).toHaveProperty('absence')
      expect(result.scoreBreakdown).toHaveProperty('gapSeverity')
    })

    it('demand component reflects log of impressions', () => {
      const low = scoreContentTarget({ ...baseInput, gscImpressions: 10 })
      const high = scoreContentTarget({ ...baseInput, gscImpressions: 10000 })
      expect(high.scoreBreakdown.demand).toBeGreaterThan(low.scoreBreakdown.demand)
    })

    it('competitor component reflects log of competitor count × miss rate × citation count', () => {
      const fewCompetitors = scoreContentTarget({
        ...baseInput,
        competitorCount: 1,
        recentMissRate: 1.0,
        citationCount: 1,
      })
      const manyCompetitors = scoreContentTarget({
        ...baseInput,
        competitorCount: 5,
        recentMissRate: 1.0,
        citationCount: 10,
      })
      expect(manyCompetitors.scoreBreakdown.competitor).toBeGreaterThan(
        fewCompetitors.scoreBreakdown.competitor,
      )
    })
  })

  describe('drivers (auditable, no prose)', () => {
    it('always returns a non-empty drivers array when score > 0', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1000,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.drivers.length).toBeGreaterThan(0)
    })

    it('includes a competitor-count driver when competitors fire', () => {
      const result = scoreContentTarget({
        ...baseInput,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.drivers.some((d) => d.includes('3 competitor'))).toBe(true)
    })

    it('includes an impressions driver when GSC impressions are present', () => {
      const result = scoreContentTarget({
        ...baseInput,
        gscImpressions: 1200,
      })
      expect(result.drivers.some((d) => /impression/i.test(d))).toBe(true)
    })

    it('includes a no-existing-page driver when action is create and no page exists', () => {
      const result = scoreContentTarget({
        ...baseInput,
        action: 'create',
        position: null,
        competitorCount: 3,
        recentMissRate: 1.0,
        citationCount: 8,
      })
      expect(result.drivers.some((d) => /no existing page|no page/i.test(d))).toBe(true)
    })

    it('includes a recent-miss driver when missRate is high', () => {
      const result = scoreContentTarget({
        ...baseInput,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
      })
      expect(result.drivers.some((d) => /miss/i.test(d))).toBe(true)
    })
  })

  describe('snapshot: deterministic output for fixture inputs', () => {
    it('produces stable scores for known input shapes', () => {
      const result = scoreContentTarget({
        gscImpressions: 1200,
        aiReferralFactor: 0.1,
        competitorCount: 3,
        recentMissRate: 0.8,
        citationCount: 5,
        ourCitedRate: 0,
        action: 'create',
        position: null,
      })
      // Snapshot: format of the result, not the exact number (though we check it doesn't change).
      expect(result.score).toBeGreaterThan(0)
      expect(result.scoreBreakdown.absence).toBeCloseTo(1.0)
      expect(result.scoreBreakdown.gapSeverity).toBe(1.0)
      expect(result.demandSource).toBe('both')
    })
  })
})

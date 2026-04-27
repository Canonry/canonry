import { describe, it, expect } from 'vitest'

import { matchesQuery } from '../src/page-matcher.js'

describe('matchesQuery', () => {
  describe('substring match (slugified query)', () => {
    it('matches when full query slug appears in path', () => {
      expect(matchesQuery('/blog/best-crm-for-saas', 'best crm for saas')).toBe(true)
    })

    it('matches when query slug appears within nested path', () => {
      expect(matchesQuery('/blog/saas/best-crm-for-saas-2026', 'best crm for saas')).toBe(true)
    })
  })

  describe('token overlap (default minOverlap = 2)', () => {
    it('matches with ≥2 meaningful token overlap', () => {
      expect(matchesQuery('/blog/saas-crm-comparison', 'best crm for saas')).toBe(true)
    })

    it('does not match with only 1 token overlap', () => {
      expect(matchesQuery('/blog/marketing-tools', 'best crm for saas')).toBe(false)
    })

    it('does not match with 0 token overlap', () => {
      expect(matchesQuery('/blog/payment-processing', 'best crm for saas')).toBe(false)
    })
  })

  describe('minOverlap option', () => {
    it('accepts 1-token overlap when minOverlap=1', () => {
      expect(matchesQuery('/blog/saas-platforms', 'best crm for saas', { minOverlap: 1 })).toBe(true)
    })

    it('rejects 1-token overlap when minOverlap=2 (default)', () => {
      expect(matchesQuery('/blog/saas-platforms', 'best crm for saas')).toBe(false)
    })
  })

  describe('stopword handling', () => {
    it('ignores stopwords when counting overlap', () => {
      // "for" and "the" are stopwords; only "best" overlaps meaningfully → 1 (below default threshold)
      expect(matchesQuery('/blog/the-best-tools-for-marketing', 'best for the saas')).toBe(false)
    })
  })

  describe('case insensitivity', () => {
    it('matches case-insensitively on substring path', () => {
      expect(matchesQuery('/blog/Best-CRM-for-SaaS', 'best crm for saas')).toBe(true)
    })

    it('matches case-insensitively on token overlap', () => {
      expect(matchesQuery('/Blog/Best-CRM-Tools', 'best crm tools')).toBe(true)
    })
  })

  describe('non-matches', () => {
    it.each(['/about', '/contact', '/'])('rejects navigational path %s', (path) => {
      expect(matchesQuery(path, 'best crm for saas')).toBe(false)
    })
  })

  describe('full URL handling', () => {
    it('extracts path from a full https URL', () => {
      expect(
        matchesQuery('https://example.com/blog/best-crm-for-saas', 'best crm for saas'),
      ).toBe(true)
    })

    it('extracts path from a full http URL', () => {
      expect(
        matchesQuery('http://example.com/blog/best-crm-for-saas', 'best crm for saas'),
      ).toBe(true)
    })

    it('handles trailing slashes', () => {
      expect(matchesQuery('/blog/best-crm-for-saas/', 'best crm for saas')).toBe(true)
    })
  })

  describe('empty inputs', () => {
    it('returns false for empty url', () => {
      expect(matchesQuery('', 'best crm for saas')).toBe(false)
    })

    it('returns false for empty query', () => {
      expect(matchesQuery('/blog/x', '')).toBe(false)
    })
  })
})

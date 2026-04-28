import { describe, it, expect } from 'vitest'

import { isBlogShapedQuery } from '../src/query-shape.js'

describe('isBlogShapedQuery', () => {
  describe('blog-shaped (informational / commercial-investigation)', () => {
    it.each([
      'best crm for saas',
      'how to set up a payment api',
      'best email marketing software',
      'what is mrr',
      'saas billing guide',
      'compare a and b',
      'top 10 frameworks',
      'why use typescript',
    ])('accepts %s', (query) => {
      expect(isBlogShapedQuery(query)).toBe(true)
    })
  })

  describe('transactional', () => {
    it.each([
      'buy crm software',
      'crm software pricing',
      'discount on subscription',
      'free trial',
      'cheap crm tool',
      'enterprise plan cost',
    ])('rejects %s', (query) => {
      expect(isBlogShapedQuery(query)).toBe(false)
    })
  })

  describe('navigational / branded', () => {
    it.each([
      'example.com',
      'crm software login',
      'sign in to brand',
      'contact sales',
      'support page',
      'download brand app',
      'brand.io homepage',
    ])('rejects %s', (query) => {
      expect(isBlogShapedQuery(query)).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('rejects empty string', () => {
      expect(isBlogShapedQuery('')).toBe(false)
    })

    it('rejects whitespace-only', () => {
      expect(isBlogShapedQuery('   ')).toBe(false)
    })

    it('handles input case-insensitively', () => {
      expect(isBlogShapedQuery('BUY CRM software')).toBe(false)
      expect(isBlogShapedQuery('Best CRM for SaaS')).toBe(true)
    })

    it('strips leading/trailing whitespace before classification', () => {
      expect(isBlogShapedQuery('  best crm guide  ')).toBe(true)
      expect(isBlogShapedQuery('  buy crm  ')).toBe(false)
    })
  })
})

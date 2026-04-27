import { describe, it, expect } from 'vitest'

import { classifyContentAction } from '../src/content-classifier.js'

describe('classifyContentAction', () => {
  describe('AEO-first principle: cited check before SEO rank', () => {
    it('CREATE when no page exists', () => {
      expect(
        classifyContentAction({
          ourPage: null,
          ourPageInGroundingSources: false,
          ourPageHasSchema: null,
        }),
      ).toBe('create')
    })

    it('REFRESH when page ranks well in SEO but is NOT cited', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 4, source: 'gsc' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: true,
        }),
      ).toBe('refresh')
    })

    it('EXPAND when page ranks 11–30 and is NOT cited', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 22, source: 'gsc' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: true,
        }),
      ).toBe('expand')
    })

    it('CREATE when page exists but ranks > 30 and is NOT cited', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 50, source: 'gsc' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: true,
        }),
      ).toBe('create')
    })

    it('ADD-SCHEMA when page is cited but lacks schema (the lock-in case)', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 6, source: 'gsc' },
          ourPageInGroundingSources: true,
          ourPageHasSchema: false,
        }),
      ).toBe('add-schema')
    })

    it('returns null (skip) when page is cited and already has schema', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 6, source: 'gsc' },
          ourPageInGroundingSources: true,
          ourPageHasSchema: true,
        }),
      ).toBeNull()
    })

    it('AEO citation overrides poor SEO rank: cited at #50 still triggers add-schema', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 50, source: 'gsc' },
          ourPageInGroundingSources: true,
          ourPageHasSchema: false,
        }),
      ).toBe('add-schema')
    })
  })

  describe('audit availability', () => {
    it('returns null (skip) when cited and schema audit is unavailable', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 6, source: 'gsc' },
          ourPageInGroundingSources: true,
          ourPageHasSchema: null,
        }),
      ).toBeNull()
    })

    it('REFRESH path is unaffected by schema-audit availability when not cited', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 4, source: 'gsc' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: null,
        }),
      ).toBe('refresh')
    })

    it('EXPAND path is unaffected by schema-audit availability when not cited', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 22, source: 'gsc' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: null,
        }),
      ).toBe('expand')
    })
  })

  describe('inventory-sourced pages', () => {
    it('classifies inventory-matched pages by the same SEO triage rules when not cited', () => {
      // Inventory match means the page exists but GSC doesn't have an exact-query
      // rank — treat position as effectively unknown (worst case = high position).
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 100, source: 'inventory' },
          ourPageInGroundingSources: false,
          ourPageHasSchema: true,
        }),
      ).toBe('create')
    })

    it('inventory-matched and cited still triggers add-schema or skip', () => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position: 0, source: 'inventory' },
          ourPageInGroundingSources: true,
          ourPageHasSchema: false,
        }),
      ).toBe('add-schema')
    })
  })

  describe('exhaustive coverage of the 2x2 (cited × rank) matrix', () => {
    it.each([
      // [position, cited, hasSchema, expected]
      [4, false, true, 'refresh'],
      [4, false, false, 'refresh'],
      [4, true, false, 'add-schema'],
      [4, true, true, null],
      [22, false, true, 'expand'],
      [22, false, false, 'expand'],
      [22, true, false, 'add-schema'],
      [22, true, true, null],
      [50, false, true, 'create'],
      [50, true, true, null],
      [50, true, false, 'add-schema'],
    ])('pos=%i cited=%s hasSchema=%s → %s', (position, cited, hasSchema, expected) => {
      expect(
        classifyContentAction({
          ourPage: { url: '/blog/x', position, source: 'gsc' },
          ourPageInGroundingSources: cited,
          ourPageHasSchema: hasSchema,
        }),
      ).toBe(expected)
    })
  })
})

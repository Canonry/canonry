import { describe, expect, it } from 'vitest'
import { isRetiredFeatureNameCopy } from '../../../eslint-rules/canonry-vocabulary.js'

/**
 * Locks the predicate behind `canonry-vocabulary/no-retired-feature-name`.
 * The site crawl and audit is "Agent Readiness" in every surface; its earlier
 * names must not come back into UI copy, while the machine tokens that still
 * carry them (route segments, run kind, trend surface) stay legal.
 */
describe('isRetiredFeatureNameCopy', () => {
  it('flags each retired name in UI copy, in any case and spacing', () => {
    for (const text of [
      'Site Health',
      'Site health scans',
      'View a Site Health scan',
      'Technical AEO refreshed',
      'Technical AEO audit',
      'No technical audit yet',
      'Trigger technical audits',
      'Page health',
      'Page health could not load',
      '\n        Site Health\n      ',
      ' Site  Health finished',
      'Agent Readiness scan queued',
      'Run an Agent Readiness scan',
      'Agent Readiness  scans',
    ]) {
      expect(isRetiredFeatureNameCopy(text), text).toBe(true)
    }
  })

  it('leaves machine tokens, the new names and audit factor names alone', () => {
    for (const text of [
      'technical-aeo',
      'site-health',
      'site-audit',
      '/projects/acme/technical-aeo',
      'getApiV1ProjectsByNameTechnicalAeo',
      'TechnicalAeoSection',
      'Agent Readiness',
      'Agent Readiness score',
      'Agent Readiness audit scan queued',
      'Run an Agent Readiness audit scan',
      'Scan settings',
      'This scan stopped at the page limit, so some pages were not checked.',
      'Technical SEO',
      'Health',
      'page state',
    ]) {
      expect(isRetiredFeatureNameCopy(text), text).toBe(false)
    }
  })

  it('ignores non-string values', () => {
    expect(isRetiredFeatureNameCopy(undefined)).toBe(false)
    expect(isRetiredFeatureNameCopy(42)).toBe(false)
    expect(isRetiredFeatureNameCopy(null)).toBe(false)
  })
})

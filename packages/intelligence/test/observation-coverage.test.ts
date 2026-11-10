import { describe, it, expect } from 'vitest'
import { detectGains } from '../src/gains.js'
import { detectFirstCitations } from '../src/first-citations.js'
import { detectProviderPickups } from '../src/provider-pickups.js'
import { detectCompetitorGains, detectCompetitorLosses } from '../src/competitor-changes.js'
import { detectRegressions } from '../src/regressions.js'
import { observedKeys } from '../src/observation-coverage.js'
import type { RunData, Snapshot } from '../src/types.js'

function run(runId: string, snapshots: Snapshot[]): RunData {
  return { runId, projectId: 'p', completedAt: '2026-01-01T00:00:00Z', snapshots }
}
function snap(query: string, provider: string, cited: boolean, competitors?: string[]): Snapshot {
  return { query, provider, cited, citedCompetitorDomains: competitors ?? [] }
}

// A provider call that throws writes NO snapshot row — that is what
// `status='partial'` means. Absence of a row is absence of evidence, and every
// detector that reads "not in the previous set" must not read it as a "no".
describe('absence of an observation is not a negative observation', () => {
  describe('detectGains', () => {
    it('does not report a gain for a pair the baseline never measured', () => {
      // Baseline: openai errored, so only gemini has rows.
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [snap('q1', 'gemini', true), snap('q1', 'openai', true)])

      expect(detectGains(current, previous)).toHaveLength(0)
    })

    it('does not report a gain when the baseline was written without web search', () => {
      // Baseline answer ran without search (not-used) — not a negative observation
      const previous = run('r1', [{ ...snap('q1', 'openai', false), retrievalStatus: 'not-used' }])
      const current = run('r2', [snap('q1', 'openai', true)])

      expect(detectGains(current, previous)).toHaveLength(0)
    })

    it('does not report a gain when the current answer was written without web search', () => {
      const previous = run('r1', [snap('q1', 'openai', false)])
      const current = run('r2', [{ ...snap('q1', 'openai', true), retrievalStatus: 'not-used' }])

      expect(detectGains(current, previous)).toHaveLength(0)
    })

    it('still reports a gain when the baseline measured the pair and found it uncited', () => {
      const previous = run('r1', [snap('q1', 'openai', false)])
      const current = run('r2', [snap('q1', 'openai', true)])

      const gains = detectGains(current, previous)
      expect(gains).toHaveLength(1)
      expect(gains[0]!.provider).toBe('openai')
    })
  })

  describe('detectProviderPickups', () => {
    it('does not report a pickup for a provider the baseline never asked', () => {
      // gemini cited q1 both runs; openai errored in the baseline.
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [snap('q1', 'gemini', true), snap('q1', 'openai', true)])

      expect(detectProviderPickups(current, previous)).toHaveLength(0)
    })

    it('does not report a pickup when the baseline answer was not-used', () => {
      const previous = run('r1', [
        snap('q1', 'gemini', true),
        { ...snap('q1', 'openai', false), retrievalStatus: 'not-used' },
      ])
      const current = run('r2', [snap('q1', 'gemini', true), snap('q1', 'openai', true)])

      expect(detectProviderPickups(current, previous)).toHaveLength(0)
    })

    it('still reports a pickup when the baseline asked that provider and got a no', () => {
      const previous = run('r1', [snap('q1', 'gemini', true), snap('q1', 'openai', false)])
      const current = run('r2', [snap('q1', 'gemini', true), snap('q1', 'openai', true)])

      const pickups = detectProviderPickups(current, previous)
      expect(pickups).toHaveLength(1)
      expect(pickups[0]!.provider).toBe('openai')
    })
  })

  describe('detectFirstCitations', () => {
    it('does not report a first citation for a query the baseline never measured', () => {
      // q2 is newly added (or every provider errored on it) — no baseline rows.
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [snap('q1', 'gemini', true), snap('q2', 'gemini', true)])

      expect(detectFirstCitations(current, previous)).toHaveLength(0)
    })

    it('does not report a first citation when the baseline answer was not-used', () => {
      const previous = run('r1', [{ ...snap('q2', 'gemini', false), retrievalStatus: 'not-used' }])
      const current = run('r2', [snap('q2', 'gemini', true)])

      expect(detectFirstCitations(current, previous)).toHaveLength(0)
    })

    it('still reports a first citation when the baseline measured the query and no provider cited it', () => {
      const previous = run('r1', [snap('q2', 'gemini', false)])
      const current = run('r2', [snap('q2', 'gemini', true)])

      const first = detectFirstCitations(current, previous)
      expect(first).toHaveLength(1)
      expect(first[0]!.query).toBe('q2')
    })
  })

  describe('detectCompetitorGains / Losses', () => {
    const tracked = { trackedCompetitors: ['rival.com'] }

    it('does not report a competitor gain on a query the baseline never measured', () => {
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [
        snap('q1', 'gemini', true),
        snap('q2', 'gemini', false, ['rival.com']),
      ])

      expect(detectCompetitorGains(current, previous, tracked)).toHaveLength(0)
    })

    it('does not report a competitor gain on a query whose baseline was not-used', () => {
      const previous = run('r1', [{ ...snap('q2', 'gemini', false), retrievalStatus: 'not-used' }])
      const current = run('r2', [snap('q2', 'gemini', false, ['rival.com'])])

      expect(detectCompetitorGains(current, previous, tracked)).toHaveLength(0)
    })

    it('does not report a competitor loss on a query the CURRENT run failed to ask', () => {
      // The mirror case: a loss is claimed from absence on the current side.
      const previous = run('r1', [snap('q1', 'gemini', false, ['rival.com'])])
      const current = run('r2', [])

      expect(detectCompetitorLosses(current, previous, tracked)).toHaveLength(0)
    })

    it('does not report a competitor loss on a query whose CURRENT answer was not-used', () => {
      const previous = run('r1', [snap('q1', 'gemini', false, ['rival.com'])])
      const current = run('r2', [{ ...snap('q1', 'gemini', false), retrievalStatus: 'not-used' }])

      expect(detectCompetitorLosses(current, previous, tracked)).toHaveLength(0)
    })

    it('still reports a real competitor gain and a real loss', () => {
      const previous = run('r1', [snap('q1', 'gemini', false), snap('q2', 'gemini', false, ['rival.com'])])
      const current = run('r2', [snap('q1', 'gemini', false, ['rival.com']), snap('q2', 'gemini', false)])

      expect(detectCompetitorGains(current, previous, tracked)).toEqual([
        { query: 'q1', competitorDomain: 'rival.com' },
      ])
      expect(detectCompetitorLosses(current, previous, tracked)).toEqual([
        { query: 'q2', competitorDomain: 'rival.com' },
      ])
    })
  })

  describe('detectRegressions (already correct — pinned so it stays that way)', () => {
    it('does not report a regression for a pair the current run failed to measure', () => {
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [])

      expect(detectRegressions(current, previous)).toHaveLength(0)
    })

    it('does not report a regression when the current answer was written without web search', () => {
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [{ ...snap('q1', 'gemini', false), retrievalStatus: 'not-used' }])

      expect(detectRegressions(current, previous)).toHaveLength(0)
    })

    it('still reports a real regression', () => {
      const previous = run('r1', [snap('q1', 'gemini', true)])
      const current = run('r2', [snap('q1', 'gemini', false)])

      expect(detectRegressions(current, previous)).toHaveLength(1)
    })
  })

  describe('observedKeys', () => {
    it('counts a row regardless of whether it was cited', () => {
      const r = run('r1', [snap('q1', 'gemini', true), snap('q2', 'gemini', false)])
      expect(observedKeys(r, s => s.query)).toEqual(new Set(['q1', 'q2']))
    })

    it('excludes rows where retrievalStatus is not-used', () => {
      const r = run('r1', [
        snap('q1', 'gemini', true),
        { ...snap('q2', 'gemini', false), retrievalStatus: 'not-used' },
      ])
      expect(observedKeys(r, s => s.query)).toEqual(new Set(['q1']))
    })

    it('is empty for a run that measured nothing', () => {
      expect(observedKeys(run('r1', []), s => s.query).size).toBe(0)
    })
  })
})

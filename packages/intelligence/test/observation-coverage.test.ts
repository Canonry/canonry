import { describe, it, expect } from 'vitest'
import { detectGains } from '../src/gains.js'
import { detectFirstCitations } from '../src/first-citations.js'
import { detectProviderPickups } from '../src/provider-pickups.js'
import { detectCompetitorGains, detectCompetitorLosses } from '../src/competitor-changes.js'
import { detectRegressions } from '../src/regressions.js'
import { detectPersistentGaps } from '../src/persistent-gaps.js'
import { observedKeys } from '../src/observation-coverage.js'
import type { RunData, Snapshot } from '../src/types.js'

function run(runId: string, snapshots: Snapshot[]): RunData {
  return { runId, projectId: 'p', completedAt: '2026-01-01T00:00:00Z', snapshots }
}
/** `cited: null` is an answer whose engine returns no sources: citation not measured. */
function snap(query: string, provider: string, cited: boolean | null, competitors?: string[]): Snapshot {
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

    it('does not report a competitor loss on a query the CURRENT run failed to ask', () => {
      // The mirror case: a loss is claimed from absence on the current side.
      const previous = run('r1', [snap('q1', 'gemini', false, ['rival.com'])])
      const current = run('r2', [])

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

    it('is empty for a run that measured nothing', () => {
      expect(observedKeys(run('r1', []), s => s.query).size).toBe(0)
    })

    it('leaves out a row whose citation was not measured', () => {
      const r = run('r1', [snap('q1', 'local', null), snap('q2', 'local', null), snap('q2', 'gemini', false)])
      expect(observedKeys(r, s => s.query)).toEqual(new Set(['q2']))
    })
  })
})

// An answer whose engine returns no sources (a local model, `cited: null`)
// observed the answer but nothing about citation. It must behave like a
// missing row for every citation detector, while a measured answer beside it
// still drives the real transition.
describe('an answer whose citation was not measured is not a negative observation', () => {
  it('detectFirstCitations: a query only an engine without sources answered was never measured uncited', () => {
    // The baseline asked only Local; Gemini is added and cites q1.
    const previous = run('r1', [snap('q1', 'local', null)])
    const current = run('r2', [snap('q1', 'local', null), snap('q1', 'gemini', true)])

    expect(detectFirstCitations(current, previous)).toHaveLength(0)
  })

  it('detectFirstCitations: still reports one when a measured engine beside it found the query uncited', () => {
    const previous = run('r1', [snap('q1', 'local', null), snap('q1', 'gemini', false)])
    const current = run('r2', [snap('q1', 'local', null), snap('q1', 'gemini', true)])

    expect(detectFirstCitations(current, previous).map(c => `${c.query}:${c.provider}`)).toEqual(['q1:gemini'])
  })

  it('detectGains: a pair not measured in the baseline was never told no', () => {
    const previous = run('r1', [snap('q1', 'openai', null)])
    const current = run('r2', [snap('q1', 'openai', true)])

    expect(detectGains(current, previous)).toHaveLength(0)
  })

  it('detectProviderPickups: a provider not measured in the baseline did not pick the query up', () => {
    const previous = run('r1', [snap('q1', 'gemini', true), snap('q1', 'openai', null)])
    const current = run('r2', [snap('q1', 'gemini', true), snap('q1', 'openai', true)])

    expect(detectProviderPickups(current, previous)).toHaveLength(0)
  })

  it('detectRegressions: a cited pair now not measured has not lost its citation', () => {
    const previous = run('r1', [snap('q1', 'openai', true)])
    const current = run('r2', [snap('q1', 'openai', null)])

    expect(detectRegressions(current, previous)).toHaveLength(0)
  })

  it('detectCompetitorGains: a query only an engine without sources answered never showed the rival absent', () => {
    const tracked = { trackedCompetitors: ['rival.com'] }
    const previous = run('r1', [snap('q1', 'local', null)])
    const current = run('r2', [snap('q1', 'local', null), snap('q1', 'gemini', false, ['rival.com'])])

    expect(detectCompetitorGains(current, previous, tracked)).toHaveLength(0)
  })

  it('detectCompetitorLosses: a rival does not drop off a query only an engine without sources answered now', () => {
    const tracked = { trackedCompetitors: ['rival.com'] }
    const previous = run('r1', [snap('q1', 'gemini', false, ['rival.com'])])
    const current = run('r2', [snap('q1', 'local', null)])

    expect(detectCompetitorLosses(current, previous, tracked)).toHaveLength(0)
  })

  it('detectCompetitorGains / Losses: still fire for measured answers beside one without sources', () => {
    const tracked = { trackedCompetitors: ['rival.com'] }
    const previous = run('r1', [snap('q1', 'local', null), snap('q1', 'gemini', false), snap('q2', 'local', null), snap('q2', 'gemini', false, ['rival.com'])])
    const current = run('r2', [snap('q1', 'local', null), snap('q1', 'gemini', false, ['rival.com']), snap('q2', 'local', null), snap('q2', 'gemini', false)])

    expect(detectCompetitorGains(current, previous, tracked)).toEqual([{ query: 'q1', competitorDomain: 'rival.com' }])
    expect(detectCompetitorLosses(current, previous, tracked)).toEqual([{ query: 'q2', competitorDomain: 'rival.com' }])
  })

  it('detectPersistentGaps: runs where only an engine without sources answered are never an uncited streak', () => {
    const runs = [1, 2, 3].map(n => run(`r${n}`, [snap('q1', 'local', null)]))

    expect(detectPersistentGaps(runs, 3)).toEqual([])
  })

  it('detectPersistentGaps: a run with no measured answer breaks the streak; measured misses beside Local still count', () => {
    const measuredMiss = (id: string) => run(id, [snap('q1', 'local', null), snap('q1', 'gemini', false)])
    // r2 measured nothing for q1, so only r3..r5 count: a streak of 3.
    const runs = [measuredMiss('r1'), run('r2', [snap('q1', 'local', null)]), measuredMiss('r3'), measuredMiss('r4'), measuredMiss('r5')]

    expect(detectPersistentGaps(runs, 3)).toEqual([{ query: 'q1', streak: 3, threshold: 3 }])
    expect(detectPersistentGaps(runs, 4)).toEqual([])
  })
})

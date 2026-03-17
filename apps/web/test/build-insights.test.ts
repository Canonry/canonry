import { test, expect } from 'vitest'

import type { CitationInsightVm } from '../src/view-models.js'
import type { ApiTimelineEntry, ApiSnapshot } from '../src/api.js'
import { buildInsights, type InsightInput } from '../src/build-dashboard.js'

/* ── helpers ─────────────────────────────────────────── */

function makeEvidence(overrides: Partial<CitationInsightVm> & { keyword: string; provider: string; citationState: CitationInsightVm['citationState'] }): CitationInsightVm {
  return {
    id: `ev_${overrides.keyword}_${overrides.provider}`,
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    changeLabel: '',
    runHistory: [],
    ...overrides,
  }
}

function makeTimeline(keyword: string, runs: { citationState: string; transition: string }[], providerRuns?: Record<string, { citationState: string; transition: string }[]>): ApiTimelineEntry {
  return {
    keyword,
    runs: runs.map((r, i) => ({ runId: `run_${i}`, createdAt: `2026-03-${10 + i}T00:00:00Z`, ...r })),
    providerRuns: providerRuns
      ? Object.fromEntries(
          Object.entries(providerRuns).map(([p, pRuns]) => [
            p,
            pRuns.map((r, i) => ({ runId: `run_${i}`, createdAt: `2026-03-${10 + i}T00:00:00Z`, ...r })),
          ]),
        )
      : undefined,
  }
}

function makeSnapshot(keyword: string, provider: string, citationState: string, competitorOverlap: string[] = []): ApiSnapshot {
  return {
    id: `snap_${keyword}_${provider}`,
    runId: 'run_0',
    keywordId: `kw_${keyword}`,
    keyword,
    provider,
    citationState,
    answerText: null,
    citedDomains: [],
    competitorOverlap,
    groundingSources: [],
    searchQueries: [],
    model: null,
    createdAt: '2026-03-13T00:00:00Z',
  }
}

function stableInput(): InsightInput {
  return {
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })],
    timeline: [makeTimeline('kw1', [
      { citationState: 'cited', transition: 'cited' },
      { citationState: 'cited', transition: 'cited' },
    ])],
    latestSnapshots: [makeSnapshot('kw1', 'gemini', 'cited')],
    previousSnapshots: [makeSnapshot('kw1', 'gemini', 'cited')],
    trackedCompetitors: [],
  }
}

/* ── tests ───────────────────────────────────────────── */

test('stable: no changes produces a single stable insight', () => {
  const insights = buildInsights(stableInput())
  expect(insights.length).toBe(1)
  expect(insights[0]!.id).toBe('insight_stable')
  expect(insights[0]!.tone).toBe('neutral')
})

test('lost citation: per-provider lost surfaces with correct keyword count', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'lost' }),
      makeEvidence({ keyword: 'kw1', provider: 'openai', citationState: 'cited' }),
      makeEvidence({ keyword: 'kw2', provider: 'gemini', citationState: 'lost' }),
    ],
    timeline: [
      makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }]),
      makeTimeline('kw2', [{ citationState: 'not-cited', transition: 'lost' }]),
    ],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const lost = insights.find(i => i.id === 'insight_lost')
  expect(lost).toBeTruthy()
  expect(lost!.tone).toBe('negative')
  // 2 affected phrases (kw1/gemini, kw2/gemini) across 2 keywords
  expect(lost!.affectedPhrases.length).toBe(2)
  expect(lost!.title).toMatch(/2 keyword/)
  // Each affected phrase has a single provider
  expect(lost!.affectedPhrases[0]!.provider).toBe('gemini')
})

test('lost citation: keyword cited by one provider but lost on another still flags the loss', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'lost' }),
      makeEvidence({ keyword: 'kw1', provider: 'openai', citationState: 'cited' }),
    ],
    timeline: [makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const lost = insights.find(i => i.id === 'insight_lost')
  expect(lost).toBeTruthy()
  expect(lost!.affectedPhrases.length).toBe(1)
  expect(lost!.affectedPhrases[0]!.provider).toBe('gemini')
})

test('first citation: keyword newly cited for the first time', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'emerging' }),
    ],
    timeline: [makeTimeline('kw1', [
      { citationState: 'not-cited', transition: 'new' },
      { citationState: 'cited', transition: 'emerging' },
    ])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const first = insights.find(i => i.id === 'insight_first_citation')
  expect(first).toBeTruthy()
  expect(first!.tone).toBe('positive')
  expect(first!.actionLabel).toBe('New')
  expect(first!.affectedPhrases.length).toBe(1)
  expect(first!.affectedPhrases[0]!.keyword).toBe('kw1')
})

test('first citation: first observation that is cited (transition=new, state=cited)', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' }),
    ],
    timeline: [makeTimeline('kw1', [{ citationState: 'cited', transition: 'new' }])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const first = insights.find(i => i.id === 'insight_first_citation')
  expect(first).toBeTruthy()
})

test('new provider pickup: keyword already cited by another provider gains a new one', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' }),
      makeEvidence({ keyword: 'kw1', provider: 'openai', citationState: 'emerging' }),
    ],
    timeline: [makeTimeline('kw1', [
      { citationState: 'cited', transition: 'cited' },
      { citationState: 'cited', transition: 'cited' },
    ])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const pickup = insights.find(i => i.id === 'insight_provider_pickup')
  expect(pickup).toBeTruthy()
  expect(pickup!.tone).toBe('positive')
  expect(pickup!.affectedPhrases.length).toBe(1)
  expect(pickup!.affectedPhrases[0]!.provider).toBe('openai')

  // Should NOT appear as a first citation
  const first = insights.find(i => i.id === 'insight_first_citation')
  expect(first).toBe(undefined)
})

test('single-provider emerging is first citation, not provider pickup', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'emerging' }),
    ],
    timeline: [makeTimeline('kw1', [
      { citationState: 'not-cited', transition: 'new' },
      { citationState: 'cited', transition: 'emerging' },
    ])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  expect(insights.find(i => i.id === 'insight_first_citation')).toBeTruthy()
  expect(insights.find(i => i.id === 'insight_provider_pickup')).toBe(undefined)
})

test('competitor gained: competitor appears on keywords it was not cited on before', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' }),
      makeEvidence({ keyword: 'kw2', provider: 'gemini', citationState: 'cited' }),
    ],
    timeline: [
      makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }]),
      makeTimeline('kw2', [{ citationState: 'cited', transition: 'cited' }]),
    ],
    latestSnapshots: [
      makeSnapshot('kw1', 'gemini', 'cited', ['rival.com']),
      makeSnapshot('kw2', 'gemini', 'cited', ['rival.com']),
    ],
    previousSnapshots: [
      makeSnapshot('kw1', 'gemini', 'cited', []),
      makeSnapshot('kw2', 'gemini', 'cited', []),
    ],
    trackedCompetitors: ['rival.com'],
  })

  const gained = insights.find(i => i.id === 'insight_comp_gained_rival.com')
  expect(gained).toBeTruthy()
  expect(gained!.tone).toBe('negative')
  expect(gained!.affectedPhrases.length).toBe(2)
  expect(gained!.title).toMatch(/rival\.com appeared on 2 keyword/)
})

test('competitor gained: only tracked competitors are flagged', () => {
  const insights = buildInsights({
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })],
    timeline: [makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }])],
    latestSnapshots: [makeSnapshot('kw1', 'gemini', 'cited', ['untracked.com'])],
    previousSnapshots: [makeSnapshot('kw1', 'gemini', 'cited', [])],
    trackedCompetitors: [],
  })

  expect(insights.length).toBe(1)
  expect(insights[0]!.id).toBe('insight_stable')
})

test('competitor lost: competitor drops out of citations', () => {
  const insights = buildInsights({
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })],
    timeline: [makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }])],
    latestSnapshots: [makeSnapshot('kw1', 'gemini', 'cited', [])],
    previousSnapshots: [makeSnapshot('kw1', 'gemini', 'cited', ['rival.com'])],
    trackedCompetitors: ['rival.com'],
  })

  const lost = insights.find(i => i.id === 'insight_comp_lost_rival.com')
  expect(lost).toBeTruthy()
  expect(lost!.tone).toBe('neutral')
  expect(lost!.title).toMatch(/rival\.com dropped from 1 keyword/)
})

test('persistent gap: keyword uncited for 3+ runs', () => {
  const insights = buildInsights({
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'not-cited' })],
    timeline: [makeTimeline('kw1', [
      { citationState: 'not-cited', transition: 'new' },
      { citationState: 'not-cited', transition: 'not-cited' },
      { citationState: 'not-cited', transition: 'not-cited' },
    ])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  const gap = insights.find(i => i.id === 'insight_persistent_gap')
  expect(gap).toBeTruthy()
  expect(gap!.tone).toBe('caution')
  expect(gap!.title).toMatch(/1 keyword/)
})

test('persistent gap: not triggered below threshold', () => {
  const insights = buildInsights({
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'not-cited' })],
    timeline: [makeTimeline('kw1', [
      { citationState: 'not-cited', transition: 'new' },
      { citationState: 'not-cited', transition: 'not-cited' },
    ])],
    latestSnapshots: [],
    previousSnapshots: [],
    trackedCompetitors: [],
  })

  expect(insights.find(i => i.id === 'insight_persistent_gap')).toBe(undefined)
})

test('multiple signal types can fire simultaneously', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'lost' }),
      makeEvidence({ keyword: 'kw2', provider: 'openai', citationState: 'emerging' }),
      makeEvidence({ keyword: 'kw3', provider: 'gemini', citationState: 'not-cited' }),
    ],
    timeline: [
      makeTimeline('kw1', [
        { citationState: 'cited', transition: 'cited' },
        { citationState: 'not-cited', transition: 'lost' },
      ]),
      makeTimeline('kw2', [
        { citationState: 'not-cited', transition: 'new' },
        { citationState: 'cited', transition: 'emerging' },
      ]),
      makeTimeline('kw3', [
        { citationState: 'not-cited', transition: 'new' },
        { citationState: 'not-cited', transition: 'not-cited' },
        { citationState: 'not-cited', transition: 'not-cited' },
      ]),
    ],
    latestSnapshots: [
      makeSnapshot('kw1', 'gemini', 'not-cited', ['rival.com']),
    ],
    previousSnapshots: [
      makeSnapshot('kw1', 'gemini', 'cited', []),
    ],
    trackedCompetitors: ['rival.com'],
  })

  expect(insights.find(i => i.id === 'insight_lost')).toBeTruthy()
  expect(insights.find(i => i.id === 'insight_first_citation')).toBeTruthy()
  expect(insights.find(i => i.id === 'insight_persistent_gap')).toBeTruthy()
  expect(insights.find(i => i.id === 'insight_comp_gained_rival.com')).toBeTruthy()
})

test('render order: lost before competitor before pickup before first-citation before gap', () => {
  const insights = buildInsights({
    evidence: [
      makeEvidence({ keyword: 'kw_lost', provider: 'gemini', citationState: 'lost' }),
      makeEvidence({ keyword: 'kw_pickup', provider: 'gemini', citationState: 'cited' }),
      makeEvidence({ keyword: 'kw_pickup', provider: 'openai', citationState: 'emerging' }),
      makeEvidence({ keyword: 'kw_first', provider: 'gemini', citationState: 'emerging' }),
      makeEvidence({ keyword: 'kw_gap', provider: 'gemini', citationState: 'not-cited' }),
    ],
    timeline: [
      makeTimeline('kw_lost', [
        { citationState: 'cited', transition: 'cited' },
        { citationState: 'not-cited', transition: 'lost' },
      ]),
      makeTimeline('kw_pickup', [
        { citationState: 'cited', transition: 'cited' },
        { citationState: 'cited', transition: 'cited' },
      ]),
      makeTimeline('kw_first', [
        { citationState: 'not-cited', transition: 'new' },
        { citationState: 'cited', transition: 'emerging' },
      ]),
      makeTimeline('kw_gap', [
        { citationState: 'not-cited', transition: 'new' },
        { citationState: 'not-cited', transition: 'not-cited' },
        { citationState: 'not-cited', transition: 'not-cited' },
        { citationState: 'not-cited', transition: 'not-cited' },
      ]),
    ],
    latestSnapshots: [
      makeSnapshot('kw_lost', 'gemini', 'not-cited', ['rival.com']),
    ],
    previousSnapshots: [
      makeSnapshot('kw_lost', 'gemini', 'cited', []),
    ],
    trackedCompetitors: ['rival.com'],
  })

  const ids = insights.map(i => i.id)
  const lostIdx = ids.indexOf('insight_lost')
  const compIdx = ids.indexOf('insight_comp_gained_rival.com')
  const pickupIdx = ids.indexOf('insight_provider_pickup')
  const firstIdx = ids.indexOf('insight_first_citation')
  const gapIdx = ids.indexOf('insight_persistent_gap')

  expect(lostIdx).not.toBe(-1)
  expect(compIdx).not.toBe(-1)
  expect(pickupIdx).not.toBe(-1)
  expect(firstIdx).not.toBe(-1)
  expect(gapIdx).not.toBe(-1)

  expect(lostIdx < compIdx).toBeTruthy()
  expect(compIdx < pickupIdx).toBeTruthy()
  expect(pickupIdx < firstIdx).toBeTruthy()
  expect(firstIdx < gapIdx).toBeTruthy()
})

test('no previous snapshots: competitor signals gracefully absent', () => {
  const insights = buildInsights({
    evidence: [makeEvidence({ keyword: 'kw1', provider: 'gemini', citationState: 'cited' })],
    timeline: [makeTimeline('kw1', [{ citationState: 'cited', transition: 'cited' }])],
    latestSnapshots: [makeSnapshot('kw1', 'gemini', 'cited', ['rival.com'])],
    previousSnapshots: [],
    trackedCompetitors: ['rival.com'],
  })

  // Without previous snapshots, every competitor keyword looks "gained" since previous set is empty
  const gained = insights.find(i => i.id === 'insight_comp_gained_rival.com')
  expect(gained).toBeTruthy()
})

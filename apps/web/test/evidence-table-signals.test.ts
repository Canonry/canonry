import { expect, test } from 'vitest'

import {
  summarizeSignalHistory,
  summarizeSignalsForItems,
} from '../src/components/project/EvidenceTable.js'
import type { CitationInsightVm, RunHistoryPoint } from '../src/view-models.js'

function point(overrides: Partial<RunHistoryPoint>): RunHistoryPoint {
  return {
    runId: overrides.runId ?? 'run',
    createdAt: overrides.createdAt ?? '2026-06-01T00:00:00Z',
    citationState: overrides.citationState ?? 'not-cited',
    answerMentioned: overrides.answerMentioned,
    visibilityState: overrides.visibilityState,
    ...overrides,
  }
}

function item(history: RunHistoryPoint[]): CitationInsightVm {
  return {
    id: crypto.randomUUID(),
    query: 'test query',
    provider: 'gemini',
    model: null,
    location: null,
    citationState: 'not-cited',
    answerMentioned: history.at(-1)?.answerMentioned,
    changeLabel: '',
    answerSnippet: '',
    citedDomains: [],
    evidenceUrls: [],
    competitorDomains: [],
    relatedTechnicalSignals: [],
    groundingSources: [],
    summary: '',
    runHistory: history,
  } as CitationInsightVm
}

test('summarizeSignalHistory detects a new mention independently from citation state', () => {
  const history = [
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: true }),
  ]

  expect(summarizeSignalHistory(history, 'mentions')).toMatchObject({ label: 'New mention', tone: 'positive' })
  expect(summarizeSignalHistory(history, 'citations')).toMatchObject({ label: 'No citation', tone: 'neutral' })
})

test('summarizeSignalHistory detects a new citation without treating it as a mention', () => {
  const history = [
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'cited', answerMentioned: false }),
  ]

  expect(summarizeSignalHistory(history, 'mentions')).toMatchObject({ label: 'No mention', tone: 'neutral' })
  expect(summarizeSignalHistory(history, 'citations')).toMatchObject({ label: 'New citation', tone: 'positive' })
})

test('summarizeSignalsForItems aggregates provider rows into latest-run chips', () => {
  const stableProvider = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
  ])
  const gainingProvider = item([
    point({ runId: 'r1', createdAt: '2026-06-01T00:00:00Z', citationState: 'not-cited', answerMentioned: false }),
    point({ runId: 'r2', createdAt: '2026-06-02T00:00:00Z', citationState: 'cited', answerMentioned: true }),
  ])

  expect(summarizeSignalsForItems([stableProvider, gainingProvider])).toEqual([
    { key: 'mentions', label: 'New mention', tone: 'positive' },
    { key: 'citations', label: 'New citation', tone: 'positive' },
  ])
})

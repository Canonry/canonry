import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { aggregateSentiment, createSentimentEvaluationDefinition, emptySentimentCounts } from '@ainyc/canonry-contracts'
import type { SentimentEvidenceItem, SentimentSettings, SentimentSummary } from '@ainyc/canonry-contracts'
import { SentimentSection, SentimentEvidenceDrawer, SentimentReport, SENTIMENT_COPY } from '../src/components/project/SentimentSection.js'
import { sentimentSelectionFromVisibility, sentimentQueryKey } from '../src/queries/sentiment.js'

afterEach(cleanup)
function summary(): SentimentSummary {
  return { ...aggregateSentiment([]), state: 'complete', provisional: false, reason: null,
    selection: { mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run', revision: 3, provider: 'openai', model: 'source-model', location: 'Chicago', evaluationDefinitionId: 'definition-a' }, evaluationDefinition: createSentimentEvaluationDefinition(),
    coverage: { selected: 10, eligibleAssessments: 10, unadmittedAssessments: 0, judged: 5, distinctSourceAnswers: 8, expectedProviderSlots: 10, completedProviderSlots: 10, counts: { ...emptySentimentCounts(), favorable: 3, mixed: 1, unfavorable: 1, factual: 5 } },
    score: { ...aggregateSentiment([]).score, favorableRate: 0.601, favorableDisplay: '60.1%', mixedRate: 0.2, mixedDisplay: '20%', unfavorableRate: 0.199, unfavorableDisplay: '19.9%', interval: { low: 0.23, high: 0.88 } },
    themes: [{ theme: { id: 'price', name: 'Price', description: 'Value', source: 'custom', evaluationStatus: 'custom-not-evaluated' }, discussed: 3, praised: 2, criticized: 3, both: 2, unclassified: 1 }], breakdowns: [] }
}
function settings(configure = false): SentimentSettings {
  return { installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 2, preset: 'default', themes: [], evaluationDefinitionId: 'definition-a', actions: { configure, backfill: configure }, experimental: true, disclosure: 'Experimental sentiment' }
}
describe('sentiment presentation', () => {
  it('renders exact API values, branded denominators, and overlapping themes', () => {
    render(<SentimentReport summary={summary()} settings={settings()} onOpenEvidence={vi.fn()} />)
    expect(screen.getByLabelText('Branded favorable share').textContent).toContain('60.1%')
    expect(screen.getByText('5 judged of 10 selected assessments')).toBeTruthy()
    expect(screen.getByText('8 distinct source answers')).toBeTruthy()
    expect(screen.getByText('Custom theme: not evaluated')).toBeTruthy()
    expect(within(screen.getByRole('row', { name: /Price/ })).getByText('2', { selector: '[data-overlap]' })).toBeTruthy()
    expect(screen.getByRole('button', { name: summary().score.limitation })).toBeTruthy()
  })
  it.each(['disabled', 'not-measured', 'processing', 'canceled', 'partial', 'failed'] as const)('preserves %s without inventing a zero', state => {
    const dto = summary(); dto.state = state; dto.score = aggregateSentiment([]).score; dto.coverage.judged = 0
    render(<SentimentReport summary={dto} settings={settings()} onOpenEvidence={vi.fn()} />)
    expect(screen.getByText(SENTIMENT_COPY.states[state])).toBeTruthy()
    expect(screen.getByLabelText('Branded favorable share').textContent).toContain('Unavailable')
  })
  it('shows no evaluative answers distinctly from not measured', () => {
    const dto = summary(); dto.coverage.judged = 0; dto.score = aggregateSentiment([]).score
    render(<SentimentReport summary={dto} settings={settings()} onOpenEvidence={vi.fn()} />)
    expect(screen.getByText(SENTIMENT_COPY.noJudgments)).toBeTruthy()
  })
  it('removes write controls when server permissions change', () => {
    const onConfigure = vi.fn()
    const view = render(<SentimentReport summary={summary()} settings={settings(true)} onOpenEvidence={vi.fn()} onConfigure={onConfigure} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage sentiment' }))
    expect(onConfigure).toHaveBeenCalledOnce()
    view.rerender(<SentimentReport summary={summary()} settings={settings(false)} onOpenEvidence={vi.fn()} onConfigure={onConfigure} />)
    expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
  })
  it('shows verbatim quotations and a truthful empty complaint in the evidence drawer', () => {
    const item: SentimentEvidenceItem = { assessmentId: 'a', runId: 'run', sourceSnapshotId: 'snapshot', sourceText: 'North Hall is excellent.', sourceTextHash: 'hash', subject: { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: [], urls: [], mentionNotApplicable: false }, subjectHash: 'subject', context: { queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'openai', requestedModel: 'source-model', servedModel: 'source-model', location: 'Chicago', locationContext: null, revision: 3, usageEdges: [] }, evaluationDefinitionId: 'definition-a', outcome: 'favorable', conclusion: [{ id: 's1', text: 'North Hall is excellent.', start: 0, end: 24 }], complaint: null, themes: [], returnedModel: 'jev-1.13.0', reason: null }
    render(<SentimentEvidenceDrawer item={item} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Sentiment evidence: North Hall' })).toBeTruthy()
    expect(screen.getByText('No complaint was identified.')).toBeTruthy()
    expect(screen.getByText('North Hall is excellent.', { selector: 'blockquote' })).toBeTruthy()
    expect(screen.getByText('definition-a')).toBeTruthy()
  })
})
describe('sentiment cache identity', () => {
  it('carries full Advanced selection and separates market and evaluator caches', () => {
    const selection = sentimentSelectionFromVisibility({ measurementScope: 'property', measurementScopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', measurementRunId: 'run', revision: 3 }, 'advanced', 'definition-a')
    expect(selection).toEqual({ mode: 'advanced', scope: 'property', scopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', runId: 'run', revision: 3, evaluationDefinitionId: 'definition-a' })
    expect(sentimentQueryKey('project', 'evidence', selection)).not.toEqual(sentimentQueryKey('project', 'evidence', { ...selection, evaluationDefinitionId: 'definition-b' }))
    expect(sentimentQueryKey('project', 'evidence', selection)).not.toEqual(sentimentQueryKey('project', 'evidence', { ...selection, marketKey: 'other' }))
  })
})


import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mockFetch, jsonResponse } from './mock-fetch.js'
import { fetchSentiment, heyClient } from '../src/api.js'

describe('sentiment generated SDK and administrator flow', () => {
  it('preserves nullable DTOs and every filter under a non-root base path', async () => {
    const original = heyClient.getConfig()
    heyClient.setConfig({ baseUrl: 'http://localhost/smoke' })
    const dto = summary(); dto.score = aggregateSentiment([]).score
    let requested = ''
    const restore = mockFetch(url => { requested = url; return jsonResponse(dto) })
    try {
      const selection = { ...dto.selection, runId: dto.selection.runId!, revision: dto.selection.revision!, evaluationDefinitionId: dto.selection.evaluationDefinitionId! }
      expect(await fetchSentiment('north project', selection)).toEqual(dto)
      const url = new URL(requested)
      expect(url.pathname).toBe('/smoke/api/v1/projects/north%20project/sentiment')
      for (const [key, value] of Object.entries(selection)) if (value !== undefined) expect(url.searchParams.get(key)).toBe(String(value))
    } finally { restore(); heyClient.setConfig(original) }
  })
  it('previews without admission and reuses the request key after an uncertain response', async () => {
    const dto = summary()
    const receipt = { id: 'job', projectId: 'project', origin: 'backfill', state: 'pending', enablementEpoch: 1, evaluationDefinitionId: 'definition-a', selection: { mode: 'advanced', scope: 'property', scopeKey: 'north', marketKey: 'chicago', queryClass: 'branded' }, createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z', counts: { ...emptySentimentCounts(), pending: 1 }, selected: 1, cancellationReason: null, attempts: [] }
    const admissions: unknown[] = []
    const restore = mockFetch((url, init) => {
      const path = new URL(url).pathname
      if (path.endsWith('/sentiment/settings')) return jsonResponse(settings(true))
      if (path.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
      if (path.endsWith('/sentiment/backfill-preview')) return jsonResponse({ previewToken: 'frozen-preview', expiresAt: '2026-09-28T11:00:00Z', selection: { ...dto.selection, runId: 'run' }, evaluationDefinitionId: 'definition-a', eligibleAssessments: 1, alreadyClassified: 0, skipped: [], estimatedInputTokens: 1234, estimatedCostUsd: 0.01, estimateMethod: 'fixture estimate' })
      if (path.endsWith('/sentiment/backfills')) { admissions.push(JSON.parse(String(init?.body))); return admissions.length === 1 ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Response was interrupted' } }, 500) : jsonResponse(receipt) }
      if (path.endsWith('/sentiment')) return jsonResponse(dto)
      return jsonResponse({ error: 'unexpected path' }, 404)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentSection projectName="project" selection={{ mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run' }} /></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      const confirm = await screen.findByRole('button', { name: 'Confirm sentiment backfill' })
      expect(admissions).toHaveLength(0)
      fireEvent.click(confirm)
      await screen.findByText(/Response was interrupted/)
      fireEvent.click(screen.getByRole('button', { name: 'Confirm sentiment backfill' }))
      await screen.findByText('Backfill submitted. Progress is available in Recent jobs.')
      expect(admissions).toHaveLength(2)
      expect(admissions[0]).toEqual(admissions[1])
    } finally { cleanup(); client.clear(); restore() }
  })
  it('stops a write after permission changes during an open session', async () => {
    let allowed = true
    let writes = 0
    const restore = mockFetch((url, init) => {
      if (init?.method === 'PUT' || init?.method === 'POST') writes++
      if (new URL(url).pathname.endsWith('/settings')) return jsonResponse(settings(allowed))
      if (new URL(url).pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
      return jsonResponse(summary())
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentSection projectName="project" selection={{ mode: 'simple', queryClass: 'branded', scope: 'project' }} /></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      allowed = false
      fireEvent.click(screen.getByRole('button', { name: 'Save sentiment settings' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull())
      expect(writes).toBe(0)
    } finally { cleanup(); client.clear(); restore() }
  })
})

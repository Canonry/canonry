import { useState, type ComponentProps, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { aggregateSentiment, createSentimentEvaluationDefinition, emptySentimentCounts } from '@ainyc/canonry-contracts'
import type { SentimentEvidenceItem, SentimentSettings, SentimentSummary, SentimentAssessmentSummary } from '@ainyc/canonry-contracts'
import { SentimentScopeProvider, SentimentControls, SentimentHeadlines, SentimentQueryScore, SentimentAnswerOutcome, SentimentOverviewMetric, SentimentEvidenceDrawer, useSentimentResolvedSource, SENTIMENT_COPY, showsSentimentOverview } from '../src/components/project/SentimentSection.js'
import { sentimentSelectionFromVisibility, sentimentSelectionForSimpleEvidence, sentimentQueryKey, sentimentSummaryRefetchInterval } from '../src/queries/sentiment.js'
import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { AccountProvider } from '../src/contexts/account-context.js'

vi.mock('../src/hooks/use-drawer.js', () => ({ useDrawer: () => ({ openEvidence: vi.fn() }) }))
afterEach(cleanup)
function summary(): SentimentSummary {
  return { ...aggregateSentiment([]), state: 'complete', provisional: false, reason: null,
    selection: { mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run', revision: 3, provider: 'openai', model: 'source-model', location: 'Chicago', evaluationDefinitionId: 'definition-a' }, evaluationDefinition: createSentimentEvaluationDefinition(),
    coverage: { selected: 10, eligibleAssessments: 10, unadmittedAssessments: 0, judged: 5, distinctSourceAnswers: 8, expectedProviderSlots: 10, completedProviderSlots: 10, counts: { ...emptySentimentCounts(), favorable: 3, mixed: 1, unfavorable: 1, factual: 5 } },
    score: { ...aggregateSentiment([]).score, favorableRate: 0.601, favorableDisplay: '60.1%', mixedRate: 0.2, mixedDisplay: '20%', unfavorableRate: 0.199, unfavorableDisplay: '19.9%', interval: { low: 0.23, high: 0.88 } },
    configured: true, queries: [], breakdowns: [] }
}
function settings(configure = false): SentimentSettings {
  return { installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 2, evaluationDefinitionId: 'definition-a', actions: { configure, backfill: configure }, experimental: true, disclosure: 'Experimental sentiment' }
}
function SentimentSection(props: Omit<ComponentProps<typeof SentimentScopeProvider>, 'children'>) {
  return <SentimentScopeProvider {...props}><SentimentControls /><SentimentHeadlines /></SentimentScopeProvider>
}
function renderScope(children: ReactNode, options: { enabled?: boolean; configure?: boolean; branded?: SentimentSummary; nonBrand?: SentimentSummary } = {}) {
  const branded = options.branded ?? summary()
  const nonBrand = options.nonBrand ?? { ...summary(), selection: { ...summary().selection, queryClass: 'non-brand' as const }, score: { ...summary().score, favorableRate: 0.25, favorableDisplay: '25%' } }
  const requests: URL[] = []
  const restore = mockFetch(url => {
    const request = new URL(url); requests.push(request)
    if (request.pathname.endsWith('/settings')) return jsonResponse({ ...settings(options.configure), enabled: options.enabled ?? true })
    if (request.pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
    if (request.pathname.endsWith('/evidence')) return jsonResponse({ state: 'complete', selection: branded.selection, items: [], nextCursor: null })
    return jsonResponse(request.searchParams.get('queryClass') === 'non-brand' ? nonBrand : branded)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', provider: 'openai', model: 'source-model', runId: 'run', revision: 3 }}>{children}</SentimentScopeProvider></QueryClientProvider>)
  return { requests, client, view, close: () => { cleanup(); client.clear(); restore() } }
}
function assessment(overrides: Partial<SentimentAssessmentSummary> = {}): SentimentAssessmentSummary {
  return { assessmentId: 'assessment-openai', sourceSnapshotId: 'snapshot-openai', runId: 'run', subjectId: 'north', subjectLabel: 'North Hall', executionNodeKey: null, provider: 'openai', requestedModel: 'source-model', servedModel: 'source-model', location: 'Chicago', evaluationDefinitionId: 'definition-a', state: 'complete', outcome: 'favorable', reason: null, ...overrides }
}
function summaryWithAssessments(items: SentimentAssessmentSummary[]): SentimentSummary {
  const dto = summary(); const { state, reason, provisional, coverage, score } = dto
  dto.selection.provider = undefined; dto.selection.model = undefined
  dto.queries = [{ queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', sourceSnapshotIds: [...new Set(items.map(item => item.sourceSnapshotId))], state, reason, provisional, coverage, score, locations: [], assessments: items }]
  return dto
}
describe('sentiment presentation', () => {
  it('renders independent branded and non-brand API values with no theme controls', async () => {
    const page = renderScope(<><SentimentHeadlines /><SentimentControls /></>)
    try {
      expect((await screen.findByLabelText('Branded favorable share')).textContent).toContain('60.1%')
      expect((await screen.findByLabelText('Non-brand favorable share')).textContent).toContain('25%')
      expect(screen.getAllByText(/5 judged of 10 selected assessments/)).toHaveLength(2)
      expect(screen.queryByText(/theme/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
    } finally { page.close() }
  })
  it('lists branded first on the project page and shows each judged n and interval in the shared percent format', async () => {
    const page = renderScope(<SentimentHeadlines />)
    try {
      const branded = await screen.findByLabelText('Branded favorable share')
      const nonBrand = await screen.findByLabelText('Non-brand favorable share')
      expect(branded.compareDocumentPosition(nonBrand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // Visible next to the value, not only inside the collapsed method details, and never as raw 0.23.
      expect(branded.textContent).toBe('60.1%5 judged95% interval 23.0% to 88.0%')
      expect(screen.getAllByText('95% Wilson interval: 23.0% to 88.0%')).toHaveLength(2)
      expect(document.body.textContent).not.toContain('0.23')
    } finally { page.close() }
  })
  it('shows only the selected query class and preserves zero judgments as unavailable', async () => {
    const dto = summary(); dto.coverage.judged = 0; dto.score = aggregateSentiment([]).score
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      expect((await screen.findByLabelText('Branded favorable share')).textContent).toContain('Unavailable')
      expect(screen.getByText(SENTIMENT_COPY.noJudgments)).toBeTruthy()
      expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
    } finally { page.close() }
  })
  it.each(['not-measured', 'processing', 'canceled', 'partial', 'failed'] as const)('preserves %s without inventing a zero', async state => {
    const dto = summary(); dto.state = state; dto.score = aggregateSentiment([]).score; dto.coverage.judged = 0
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try { expect(await screen.findByText(SENTIMENT_COPY.states[state])).toBeTruthy(); expect(screen.getByLabelText('Branded favorable share').textContent).toContain('Unavailable') } finally { page.close() }
  })
  it('keeps enable reachable while default-off projects do not request summaries', async () => {
    const page = renderScope(<><SentimentHeadlines /><SentimentControls /></>, { enabled: false, configure: true })
    try {
      await screen.findByRole('button', { name: 'Enable sentiment' })
      expect(screen.queryByLabelText('Favorable answer scores')).toBeNull()
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(0)
    } finally { page.close() }
  })
  it('renders branded as the primary overview figure with its judged count and interval, then non-brand', () => {
    const dto = summary(); dto.provisional = true; dto.state = 'partial'
    const value = { configured: false, branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'], coverage: { ...dto.coverage, judged: 3, selected: 4 }, score: { ...dto.score, favorableDisplay: '25.0%', interval: { low: 0.05, high: 0.6 } } } }
    const view = render(<SentimentOverviewMetric value={value} />)
    expect(screen.queryByText('Favorable')).toBeNull()
    view.rerender(<SentimentOverviewMetric value={{ ...value, configured: true }} />)
    const branded = screen.getByLabelText('Branded favorable share')
    const nonBrand = screen.getByLabelText('Non-brand favorable share')
    expect(branded.compareDocumentPosition(nonBrand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(branded.hasAttribute('data-sentiment-primary')).toBe(true)
    // Server display value, judged n and the Wilson interval in the shared percent format; never the raw 0.23.
    expect(branded.textContent).toBe('Branded60.1%*5 judged · 95% interval 23.0%–88.0%')
    expect(nonBrand.textContent).toBe('Non-brand25.0%*3 judged · 95% interval 5.0%–60.0%')
    expect(nonBrand.hasAttribute('data-sentiment-primary')).toBe(false)
    expect(screen.getAllByRole('img', { name: 'Provisional' })).toHaveLength(2)
    const info = screen.getByRole('button', { name: /Favorable answers divided/ })
    const label = info.getAttribute('aria-label')!
    expect(label).toContain('Branded: 60.1%, 5 of 10 judged, 95% interval 23.0% to 88.0%. Provisional. Sentiment results are partial.')
    expect(label).toContain('Non-brand: 25.0%, 3 of 4 judged, 95% interval 5.0% to 60.0%.')
    expect(label.indexOf('Branded:')).toBeLessThan(label.indexOf('Non-brand:'))
    fireEvent.pointerDown(info)
    fireEvent.focus(info)
    fireEvent.click(info, { detail: 1 })
    expect(info.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(info, { key: 'Escape' })
    expect(info.getAttribute('aria-expanded')).toBe('false')
  })
  it('shows only the judged count when nothing was judged, with no interval', () => {
    const empty = { ...aggregateSentiment([]), reason: null, runIds: ['run'], selection: summary().selection }
    render(<SentimentOverviewMetric value={{ configured: true, branded: empty, nonBrand: empty }} />)
    expect(screen.getByLabelText('Branded favorable share').textContent).toBe('BrandedUnavailable0 judged')
    expect(screen.queryByText(/interval/)).toBeNull()
  })
  it('hides the overview figure inside an embed, as the project page does', () => {
    const value = { configured: true, branded: { ...summary(), runIds: ['run'] }, nonBrand: { ...summary(), runIds: ['run'] } }
    window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
    try {
      expect(showsSentimentOverview(value)).toBe(false)
      const { container } = render(<SentimentOverviewMetric value={value} />)
      expect(container.innerHTML).toBe('')
    } finally { delete window.__CANONRY_CONFIG__ }
    expect(showsSentimentOverview(value)).toBe(true)
    expect(showsSentimentOverview({ ...value, configured: false })).toBe(false)
  })
  it('places favorable in the existing query table and class filtering changes its headlines', async () => {
    const dto = summary(); const { state, reason, provisional, coverage, score } = dto
    dto.queries = [{ queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], state, reason, provisional, coverage, score, assessments: [], locations: [] }]
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', queryId: 'q', sourceSnapshotId: 'snapshot', query: 'Is North Hall good?', queryClass: 'branded' }]} />, { branded: dto })
    try {
      await screen.findByRole('columnheader', { name: 'Favorable' })
      const score = await screen.findByRole('button', { name: 'View Branded sentiment evidence for Is North Hall good?' })
      expect(score.textContent).toContain('60.1%')
      const row = score.closest('tr')!
      const queryToggle = within(row).getByRole('button', { name: 'Is North Hall good?', exact: true })
      fireEvent.keyDown(score, { key: 'Enter' })
      expect(queryToggle.getAttribute('aria-expanded')).toBe('false')
      fireEvent.change(screen.getByRole('combobox', { name: 'Query class' }), { target: { value: 'branded' } })
      expect(screen.getByLabelText('Branded favorable share')).toBeTruthy()
      expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
      fireEvent.click(score)
      expect(queryToggle.getAttribute('aria-expanded')).toBe('false')
      await screen.findByRole('dialog', { name: 'Sentiment evidence: Is North Hall good?' })
    } finally { page.close() }
  })
  it('resolves deleted queries by exact source identity and location without per-row reads', async () => {
    const dto = summary(); dto.provisional = true; dto.state = 'partial'
    const { state, reason, provisional, coverage, score } = dto
    dto.queries = [{ queryId: 'deleted-query', queryText: 'Is North Hall good?', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], state, reason, provisional, coverage, score, assessments: [], locations: [{ location: 'Chicago', sourceSnapshotIds: ['snapshot'], state, reason, provisional, coverage, score: { ...score, favorableDisplay: '31.7%' } }] }]
    const page = renderScope(<><SentimentQueryScore sourceSnapshotIds={['snapshot']} queryClass="branded" location="Chicago" /><SentimentQueryScore queryId="different-query" queryClass="branded" /><SentimentQueryScore queryId="deleted-query" sourceSnapshotIds={['newer-snapshot']} queryClass="branded" /></>, { branded: dto })
    try {
      const button = await screen.findByRole('button', { name: 'View Branded sentiment evidence for Is North Hall good?' })
      expect(button.textContent).toContain('31.7%')
      expect(button.textContent).toContain('5 judged')
      expect(button.textContent).toContain('Provisional')
      expect(screen.getAllByText('Unavailable')).toHaveLength(2)
      fireEvent.click(button)
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
      const requested = page.requests.find(url => url.pathname.endsWith('/evidence'))!
      expect(Object.fromEntries(requested.searchParams)).toMatchObject({ queryId: 'deleted-query', queryClass: 'branded', location: 'Chicago', runId: 'run', revision: '3', scope: 'property', scopeKey: 'north', marketKey: 'chicago', provider: 'openai', model: 'source-model', evaluationDefinitionId: 'definition-a' })
    } finally { page.close() }
  })
  it('matches an Advanced query to its own execution node and narrows its evidence to that node', async () => {
    const dto = summary()
    const { state, reason, provisional, coverage, score } = dto
    const row = (node: string, display: string) => ({ queryId: 'q', executionNodeKey: node, queryText: 'Is North Hall good?', queryClass: 'branded' as const, sourceSnapshotIds: [`snapshot-${node}`], state, reason, provisional, coverage, score: { ...score, favorableDisplay: display }, assessments: [], locations: [] })
    dto.queries = [row('node-a', '100%'), row('node-b', '0%')]
    const page = renderScope(<SentimentQueryScore queryId="q" sourceSnapshotIds={['snapshot-node-b']} queryClass="branded" />, { branded: dto })
    try {
      const button = await screen.findByRole('button', { name: 'View Branded sentiment evidence for Is North Hall good?' })
      expect(button.textContent).toContain('0%')
      fireEvent.click(button)
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const requested = page.requests.find(url => url.pathname.endsWith('/evidence'))!
      expect(Object.fromEntries(requested.searchParams)).toMatchObject({ queryId: 'q', executionNodeKey: 'node-b' })
    } finally { page.close() }
  })
  it('reads Unavailable, not Loading, for query and engine cells when the view has no saved source evidence', async () => {
    const requests: URL[] = []
    const restore = mockFetch(url => { const request = new URL(url); requests.push(request); return request.pathname.endsWith('/settings') ? jsonResponse(settings()) : jsonResponse(summary()) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider hasSourceEvidence={false} projectName="project" selection={{ mode: 'simple', scope: 'project', queryClass: 'branded' }}>
        <SentimentQueryScore queryId="q" queryClass="branded" /><SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot']} queryClass="branded" provider="openai" location={null} />
      </SentimentScopeProvider></QueryClientProvider>)
      await waitFor(() => expect(client.getQueryData(sentimentQueryKey('project', 'settings'))).toBeTruthy())
      await waitFor(() => expect(screen.getAllByText('Unavailable')).toHaveLength(2))
      expect(screen.queryByText('Loading…')).toBeNull()
      expect(requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(0)
    } finally { cleanup(); client.clear(); restore() }
  })
  it('shows verbatim quotations and a truthful empty complaint in the evidence drawer', () => {
    const item: SentimentEvidenceItem = { assessmentId: 'a', runId: 'run', sourceSnapshotId: 'snapshot', sourceText: 'North Hall is excellent.', sourceTextHash: 'hash', subject: { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: [], urls: [], mentionNotApplicable: false }, subjectHash: 'subject', context: { queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'openai', requestedModel: 'source-model', servedModel: 'source-model', location: 'Chicago', locationContext: null, revision: 3, usageEdges: [] }, evaluationDefinitionId: 'definition-a', outcome: 'favorable', conclusion: [{ id: 's1', text: 'North Hall is excellent.', start: 0, end: 24 }], complaint: null, returnedModel: 'jev-1.13.0', reason: null }
    render(<SentimentEvidenceDrawer item={item} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Sentiment evidence: North Hall' })).toBeTruthy()
    expect(screen.getByText('No complaint was identified.')).toBeTruthy()
    expect(screen.getByText('North Hall is excellent.', { selector: 'blockquote' })).toBeTruthy()
    expect(screen.getByText('definition-a')).toBeTruthy()
  })
})
describe('per-engine sentiment', () => {
  it('shows opposite stored engine outcomes in expanded rows and opens only the chosen assessment', async () => {
    const dto = summaryWithAssessments([assessment(), assessment({ assessmentId: 'assessment-gemini', sourceSnapshotId: 'snapshot-gemini', provider: 'gemini', outcome: 'unfavorable' })])
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    const items = ['openai', 'gemini'].map(provider => ({ ...seed, id: provider, provider, queryId: 'q', sourceSnapshotId: `snapshot-${provider}`, query: 'Is North Hall good?', queryClass: 'branded' as const, location: 'Chicago' }))
    const page = renderScope(<EvidenceTable evidence={items} />, { branded: dto })
    try {
      await screen.findByRole('columnheader', { name: 'Favorable' })
      fireEvent.click(screen.getByRole('button', { name: 'Is North Hall good?', exact: true }))
      const favorable = await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' })
      const unfavorable = screen.getByRole('button', { name: 'View gemini sentiment evidence for North Hall: Unfavorable' })
      expect(within(favorable.closest('tr')!).getByText('openai')).toBeTruthy()
      expect(within(unfavorable.closest('tr')!).getByText('gemini')).toBeTruthy()
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
      expect(page.requests.filter(url => url.pathname.endsWith('/evidence'))).toHaveLength(0)
      fireEvent.click(unfavorable)
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const evidence = page.requests.filter(url => url.pathname.endsWith('/evidence'))
      expect(evidence).toHaveLength(1)
      expect(evidence[0]!.searchParams.get('assessmentId')).toBe('assessment-gemini')
      expect(evidence[0]!.searchParams.get('queryId')).toBe('q')
      expect(evidence[0]!.searchParams.get('runId')).toBe('run')
    } finally { page.close() }
  })
  it('keeps shared-source Property judgments separate and refuses an unrelated source or model', async () => {
    const dto = summaryWithAssessments([assessment(), assessment({ assessmentId: 'assessment-south', subjectId: 'south', subjectLabel: 'South Hall', outcome: 'unfavorable' })])
    const props = { queryId: 'q', sourceSnapshotIds: ['snapshot-openai'], queryClass: 'branded' as const, provider: 'openai', model: 'source-model', location: 'Chicago' }
    const page = renderScope(<><SentimentAnswerOutcome {...props} showSubjects /><SentimentAnswerOutcome {...props} sourceSnapshotIds={['older-snapshot']} /><SentimentAnswerOutcome {...props} model="other-model" /></>, { branded: dto })
    try {
      expect((await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' })).textContent).toBe('North Hall · Favorable')
      expect(screen.getByRole('button', { name: 'View openai sentiment evidence for South Hall: Unfavorable' }).textContent).toBe('South Hall · Unfavorable')
      expect(screen.getAllByText('Unavailable')).toHaveLength(2)
      expect(screen.queryByText('Mixed')).toBeNull()
    } finally { page.close() }
  })
  it.each([
    ['factual', 'complete', 'Factual'], ['subject-not-mentioned', 'complete', 'Not mentioned'],
    ['mixed', 'complete', 'Mixed'], ['pending', 'processing', 'Pending'], ['running', 'processing', 'Classifying'],
    ['failed', 'failed', 'Failed'], ['canceled', 'canceled', 'Canceled'],
    [null, 'not-measured', 'Not classified'], [null, 'unsupported', 'Unavailable'],
  ] as const)('keeps %s / %s separate from negative sentiment', async (outcome, state, label) => {
    const dto = summaryWithAssessments([assessment({ outcome, state, assessmentId: outcome ? 'assessment' : null, reason: outcome ? null : 'No compatible stored judgment.' })])
    const page = renderScope(<SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot-openai']} queryClass="branded" provider="openai" location="Chicago" />, { branded: dto })
    try {
      await waitFor(() => expect(screen.getByLabelText('openai sentiment').textContent).toContain(label))
      expect(screen.queryByText('0%')).toBeNull()
      expect(screen.queryByText('Unfavorable')).toBeNull()
      if (!outcome) expect(screen.getByRole('button', { name: 'No compatible stored judgment.' })).toBeTruthy()
    } finally { page.close() }
  })
  it('uses the controlled engine for both class reads and recovers All engines without stale model scope', async () => {
    const reads: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url); reads.push(request)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings())
      const dto = summaryWithAssessments([assessment()]); dto.selection = { ...dto.selection, queryClass: request.searchParams.get('queryClass') as 'branded' | 'non-brand', provider: request.searchParams.get('provider') ?? undefined, model: undefined }
      dto.score.favorableDisplay = request.searchParams.get('provider') === 'openai' ? '100%' : '50%'
      return jsonResponse(dto)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    function View({ locationEmpty = false }: { locationEmpty?: boolean }) {
      const [provider, setProvider] = useState('')
      const evidence = [{ ...seed, provider: 'gemini', sourceRunId: 'gemini-run', queryClass: 'branded' as const }, ...(!locationEmpty ? [{ ...seed, provider: 'openai', sourceRunId: 'openai-run', queryClass: 'branded' as const }] : [])]
      const selection = sentimentSelectionForSimpleEvidence({ mode: 'advanced', scope: 'project', queryClass: 'branded', provider: 'stale-engine', model: 'stale-model', runId: 'stale-run', revision: 9 }, evidence, provider)
      return <SentimentScopeProvider hasSourceEvidence={Boolean(selection.runId || selection.runIds?.length)} projectName="project" selection={selection}><EvidenceTable evidence={evidence} providerSelection={provider} onProviderSelectionChange={setProvider} /></SentimentScopeProvider>
    }
    try {
      const view = render(<QueryClientProvider client={client}><View /></QueryClientProvider>)
      await waitFor(() => expect(screen.getByLabelText('Branded favorable share').textContent).toContain('50%'))
      fireEvent.change(screen.getByRole('combobox', { name: 'Answer engine' }), { target: { value: 'openai' } })
      await waitFor(() => expect(screen.getByLabelText('Branded favorable share').textContent).toContain('100%'))
      const summaries = reads.filter(url => url.pathname.endsWith('/sentiment'))
      expect(summaries).toHaveLength(4)
      expect(summaries.slice(-2).every(url => url.searchParams.get('provider') === 'openai')).toBe(true)
      expect(summaries.every(url => !url.searchParams.has('model') && !url.searchParams.has('revision'))).toBe(true)
      expect(summaries.slice(-2).every(url => url.searchParams.get('runId') === 'openai-run' && !url.searchParams.has('runIds[]'))).toBe(true)
      view.rerender(<QueryClientProvider client={client}><View locationEmpty /></QueryClientProvider>)
      await waitFor(() => expect(screen.getByLabelText('Favorable answer scores').textContent).toContain('Unavailable'))
      expect(screen.getByRole('combobox', { name: 'Answer engine' })).toHaveProperty('value', 'openai')
      expect(screen.queryByLabelText('Branded favorable share')).toBeNull()
      expect(reads.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(4)
      fireEvent.change(screen.getByRole('combobox', { name: 'Answer engine' }), { target: { value: '' } })
      await waitFor(() => expect(screen.getByLabelText('Branded favorable share').textContent).toContain('50%'))
    } finally { cleanup(); client.clear(); restore() }
  })
})

describe('sentiment polling', () => {
  function withCounts(state: SentimentSummary['state'], counts: Partial<SentimentSummary['coverage']['counts']>, unadmittedAssessments = 0): SentimentSummary {
    const dto = summary(); dto.state = state; dto.provisional = state !== 'complete'
    dto.coverage = { ...dto.coverage, unadmittedAssessments, counts: { ...emptySentimentCounts(), favorable: 99, ...counts } }
    return dto
  }
  it.each([
    ['one permanently failed assessment', withCounts('partial', { failed: 1 }), false, false],
    ['canceled work', withCounts('partial', { canceled: 3 }), false, false],
    ['an unadmitted coverage gap', withCounts('partial', {}, 4), false, false],
    ['a complete summary', withCounts('complete', {}), false, false],
    ['no summary yet', undefined, false, false],
    ['pending work', withCounts('partial', { pending: 1 }), false, 5000],
    ['running work', withCounts('processing', { running: 1 }), false, 5000],
    ['work waiting to retry', withCounts('partial', { 'waiting-to-retry': 1, failed: 1 }), false, 5000],
    ['an active job the administrator can see', withCounts('partial', { failed: 1 }), true, 5000],
  ] as const)('polls a class summary with %s', (_label, dto, jobsActive, expected) => {
    expect(sentimentSummaryRefetchInterval(dto, jobsActive)).toBe(expected)
  })
  it('stops re-reading both class summaries once their remaining work is terminal', async () => {
    const terminal = withCounts('partial', { failed: 1 })
    const page = renderScope(<SentimentHeadlines />, { branded: terminal, nonBrand: { ...terminal, selection: { ...terminal.selection, queryClass: 'non-brand' } } })
    try {
      await screen.findByLabelText('Branded favorable share')
      await screen.findByLabelText('Non-brand favorable share')
      const queries = page.client.getQueryCache().findAll({ queryKey: ['sentiment', 'project', 'summary'] })
      expect(queries).toHaveLength(2)
      for (const query of queries) {
        const interval = query.observers[0]!.options.refetchInterval as (value: typeof query) => number | false
        expect(query.state.data).toMatchObject({ state: 'partial' })
        expect(interval(query)).toBe(false)
      }
    } finally { page.close() }
  })
})

describe('sentiment cache identity', () => {
  it('uses the displayed Simple snapshot group instead of a stale Advanced URL run', () => {
    const previous = { mode: 'advanced' as const, scope: 'project' as const, queryClass: 'branded' as const, runId: 'older-run', runIds: ['stale-group'], revision: 7 }
    expect(sentimentSelectionForSimpleEvidence(previous, [{ provider: 'openai', sourceRunId: 'west-run' }, { provider: 'gemini', sourceRunId: 'east-run' }, { provider: 'openai', sourceRunId: 'west-run' }])).toEqual({ ...previous, mode: 'simple', provider: undefined, model: undefined, runId: undefined, runIds: ['east-run', 'west-run'], revision: undefined })
    expect(sentimentSelectionForSimpleEvidence(previous, [{ provider: 'openai', sourceRunId: 'latest-run' }])).toEqual({ ...previous, mode: 'simple', provider: undefined, model: undefined, runId: 'latest-run', runIds: undefined, revision: undefined })
  })
  it('resets a carried Advanced scope, scope key and market to the whole Simple project', () => {
    const carried = { mode: 'advanced' as const, scope: 'group' as const, scopeKey: 'north-group', marketKey: 'chicago', queryClass: 'non-brand' as const, runId: 'older-run', revision: 4 }
    const simple = sentimentSelectionForSimpleEvidence(carried, [{ provider: 'openai', sourceRunId: 'latest-run' }])
    expect(simple).toMatchObject({ mode: 'simple', scope: 'project', queryClass: 'non-brand', runId: 'latest-run' })
    expect(simple.scopeKey).toBeUndefined()
    expect(simple.marketKey).toBeUndefined()
    expect(simple.revision).toBeUndefined()
  })
  it('carries full Advanced selection and separates market and evaluator caches', () => {
    const selection = sentimentSelectionFromVisibility({ measurementScope: 'property', measurementScopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', measurementRunId: 'run', revision: 3 }, 'advanced', 'definition-a')
    expect(selection).toEqual({ mode: 'advanced', scope: 'property', scopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', runId: 'run', revision: 3, evaluationDefinitionId: 'definition-a' })
    expect(sentimentQueryKey('project', 'evidence', selection)).not.toEqual(sentimentQueryKey('project', 'evidence', { ...selection, evaluationDefinitionId: 'definition-b' }))
    expect(sentimentQueryKey('project', 'evidence', selection)).not.toEqual(sentimentQueryKey('project', 'evidence', { ...selection, marketKey: 'other' }))
    expect(sentimentQueryKey('project', 'evidence', { ...selection, assessmentId: 'one' })).not.toEqual(sentimentQueryKey('project', 'evidence', { ...selection, assessmentId: 'two' }))
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
  it('asks for engine and location detail and follows every query page into one summary', async () => {
    const dto = summary()
    const { state, reason, provisional, coverage, score } = dto
    const row = (queryId: string) => ({ queryId, executionNodeKey: null, queryText: queryId, queryClass: 'branded' as const, sourceSnapshotIds: [queryId], state, reason, provisional, coverage, score, assessments: [], locations: [] })
    const requested: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url); requested.push(request)
      return request.searchParams.get('queryCursor') === 'page-2'
        ? jsonResponse({ ...dto, queries: [row('q-2')], queryPage: { total: 2, limit: 500, nextCursor: null } })
        : jsonResponse({ ...dto, queries: [row('q-1')], queryPage: { total: 2, limit: 500, nextCursor: 'page-2' } })
    })
    try {
      const read = await fetchSentiment('project', { mode: 'advanced', queryClass: 'branded', scope: 'project', runIds: ['north', 'south'] })
      expect(read.queries.map(item => item.queryId)).toEqual(['q-1', 'q-2'])
      expect(read.queryPage).toEqual({ total: 2, limit: 500, nextCursor: null })
      expect(requested).toHaveLength(2)
      for (const url of requested) {
        expect(url.searchParams.getAll('include')).toEqual(['assessments', 'locations'])
        expect(url.searchParams.get('queryLimit')).toBe('500')
        // Array parameters stay repeated, so grouped runs are never joined into one ID.
        expect(url.searchParams.getAll('runIds')).toEqual(['north', 'south'])
      }
      expect(requested[1]!.searchParams.get('queryCursor')).toBe('page-2')
    } finally { restore() }
  })
  it('lists job summaries with attempt totals and reads attempt receipts only when a job is opened', async () => {
    const job = { id: 'job', projectId: 'project', origin: 'backfill', state: 'complete', enablementEpoch: 1, evaluationDefinitionId: 'definition-a', selection: { mode: 'advanced', scope: 'project', queryClass: 'branded', runId: 'run' }, createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z', counts: { ...emptySentimentCounts(), favorable: 1 }, selected: 1, cancellationReason: null, attemptCount: 2 }
    const attempt = (id: string, errorCode: string | null) => ({ id, workItemId: 'work', dispatchedAt: '2026-09-28T10:00:00Z', completedAt: '2026-09-28T10:00:01Z', returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 1200, outputTokens: 5 }, errorCode })
    const requested: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url); requested.push(request)
      if (request.pathname.endsWith('/sentiment/settings')) return jsonResponse(settings(true))
      if (request.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [job] })
      if (request.pathname.endsWith('/sentiment/jobs/job')) return request.searchParams.get('attemptCursor') === 'older'
        ? jsonResponse({ ...job, attempts: [attempt('first', 'TIMEOUT')], attemptCount: 2, nextAttemptCursor: null })
        : jsonResponse({ ...job, attempts: [attempt('second', null)], attemptCount: 2, nextAttemptCursor: 'older' })
      if (request.pathname.endsWith('/sentiment')) return jsonResponse(summary())
      return jsonResponse({ error: 'unexpected path' }, 404)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentSection projectName="project" selection={{ mode: 'advanced', queryClass: 'branded', scope: 'project', runId: 'run' }} /></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      expect(await screen.findByText('Attempts: 2')).toBeTruthy()
      expect(requested.some(url => url.pathname.endsWith('/sentiment/jobs/job'))).toBe(false)
      const details = screen.getByText('Job details').closest('details')!
      details.open = true; fireEvent(details, new Event('toggle'))
      expect(await screen.findByText(/Request complete; 1200 input tokens/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Older attempts' }))
      expect(await screen.findByText(/TIMEOUT; 1200 input tokens/)).toBeTruthy()
      expect(requested.filter(url => url.pathname.endsWith('/sentiment/jobs/job')).map(url => url.searchParams.get('attemptCursor'))).toEqual([null, 'older'])
    } finally { cleanup(); client.clear(); restore() }
  })
  it('waits for the resolved Advanced run before either summary is requested', async () => {
    const reads: URL[] = []
    const restore = mockFetch(url => { const request = new URL(url); if (request.pathname.endsWith('/settings')) return jsonResponse(settings()); reads.push(request); return jsonResponse(summary()) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Resolved({ runId }: { runId?: string }) { useSentimentResolvedSource(runId, 7); return <SentimentHeadlines /> }
    const tree = (runId?: string) => <QueryClientProvider client={client}><SentimentScopeProvider waitForResolvedRun projectName="project" selection={{ mode: 'advanced', scope: 'property', scopeKey: 'north', queryClass: 'branded' }}><Resolved runId={runId} /></SentimentScopeProvider></QueryClientProvider>
    try {
      const view = render(tree())
      await waitFor(() => expect(client.getQueryData(sentimentQueryKey('project', 'settings'))).toBeTruthy())
      expect(reads).toHaveLength(0)
      view.rerender(tree('older-filtered-run'))
      await screen.findByLabelText('Branded favorable share')
      expect(reads).toHaveLength(2)
      for (const request of reads) { expect(request.searchParams.get('runId')).toBe('older-filtered-run'); expect(request.searchParams.get('revision')).toBe('7') }
    } finally { cleanup(); client.clear(); restore() }
  })
  it('dismisses evidence and management when the resolved Advanced run or revision changes', async () => {
    const requests: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url); requests.push(request)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings(true))
      if (request.pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
      const runId = request.searchParams.get('runId') ?? 'run-a'
      const dto = summaryWithAssessments([assessment({ runId, sourceSnapshotId: `${runId}-snapshot`, assessmentId: `${runId}-assessment` })])
      dto.selection = { ...dto.selection, runId, revision: Number(request.searchParams.get('revision')), queryClass: request.searchParams.get('queryClass') === 'non-brand' ? 'non-brand' : 'branded' }
      if (request.pathname.endsWith('/evidence')) return jsonResponse({ state: 'complete', selection: dto.selection, items: [], nextCursor: null })
      return jsonResponse(dto)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Resolved({ runId, revision }: { runId: string; revision: number }) {
      useSentimentResolvedSource(runId, revision)
      return <><SentimentControls /><SentimentAnswerOutcome queryId="q" sourceSnapshotIds={[`${runId}-snapshot`]} queryClass="branded" provider="openai" location="Chicago" /></>
    }
    const tree = (runId: string, revision: number) => <QueryClientProvider client={client}><SentimentScopeProvider waitForResolvedRun projectName="project" selection={{ mode: 'advanced', scope: 'property', scopeKey: 'north', queryClass: 'branded' }}><Resolved runId={runId} revision={revision} /></SentimentScopeProvider></QueryClientProvider>
    try {
      const view = render(tree('run-a', 7))
      fireEvent.click(await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' }))
      await screen.findByRole('dialog', { name: 'Sentiment evidence: Is North Hall good? · openai · North Hall' })
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      expect(requests.find(url => url.pathname.endsWith('/evidence'))?.searchParams.get('runId')).toBe('run-a')
      // Re-rendering an unchanged source must not dismiss the selected evidence.
      view.rerender(tree('run-a', 7))
      expect(screen.getByRole('dialog')).toBeTruthy()
      view.rerender(tree('run-b', 7))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(requests.filter(url => url.pathname.endsWith('/sentiment') && url.searchParams.get('runId') === 'run-b')).toHaveLength(2))
      fireEvent.click(screen.getByRole('button', { name: 'Manage sentiment' }))
      await screen.findByRole('dialog', { name: 'Manage sentiment' })
      view.rerender(tree('run-b', 8))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    } finally { cleanup(); client.clear(); restore() }
  })

  it('preserves exact grouped run IDs in evidence and clears them for a single-sweep preview', async () => {
    const dto = summary(); dto.selection = { ...dto.selection, mode: 'simple', scope: 'project', runId: null, runIds: ['east-run', 'west-run'] }
    const { state, reason, provisional, coverage, score } = dto
    dto.queries = [{ queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], state, reason, provisional, coverage, score, assessments: [], locations: [] }]
    const requests: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url); requests.push(request)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings(true))
      if (request.pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
      if (request.pathname.endsWith('/evidence')) return jsonResponse({ state: 'complete', selection: dto.selection, items: [], nextCursor: null })
      if (request.pathname.endsWith('/backfill-preview')) return jsonResponse({ previewToken: null, expiresAt: null, selection: { mode: 'simple', scope: 'project', queryClass: 'branded', runId: 'east-run' }, evaluationDefinitionId: 'definition-a', eligibleAssessments: 0, alreadyClassified: 0, skipped: [], estimatedInputTokens: 0, estimatedCostUsd: 0, estimateMethod: 'fixture' })
      return jsonResponse(dto)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'simple', scope: 'project', queryClass: 'branded', runIds: ['east-run', 'west-run'] }} runOptions={[{ id: 'east-run', label: 'East sweep' }]}><SentimentControls /><SentimentQueryScore queryId="q" queryClass="branded" /></SentimentScopeProvider></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'View Branded sentiment evidence for Is North Hall good?' }))
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const evidence = requests.find(url => url.pathname.endsWith('/evidence'))!
      expect(evidence.searchParams.getAll('runIds')).toEqual(['east-run', 'west-run'])
      expect(evidence.searchParams.has('runId')).toBe(false)
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Manage sentiment' }))
      fireEvent.change(screen.getByRole('combobox', { name: 'Saved sweep' }), { target: { value: 'east-run' } })
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByText('Eligible assessments')
      const preview = requests.find(url => url.pathname.endsWith('/backfill-preview'))!
      expect(preview.searchParams.get('runId')).toBe('east-run')
      expect(preview.searchParams.has('runIds')).toBe(false)
    } finally { cleanup(); client.clear(); restore() }
  })
  it('backfills the whole chosen sweep by default and narrows to the view only when asked, showing what was covered and skipped', async () => {
    const previews: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/sentiment/settings')) return jsonResponse(settings(true))
      if (request.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
      if (request.pathname.endsWith('/sentiment/backfill-preview')) {
        previews.push(request)
        const echoed = Object.fromEntries(request.searchParams)
        const narrowed = request.searchParams.has('provider')
        return jsonResponse({ previewToken: narrowed ? null : 'frozen-preview', expiresAt: null, selection: { ...echoed, ...(echoed.revision ? { revision: Number(echoed.revision) } : {}) }, evaluationDefinitionId: 'definition-a', eligibleAssessments: narrowed ? 0 : 12, alreadyClassified: 0, skipped: narrowed ? [] : [{ runId: 'run', reason: 'incomplete-run', count: 1 }, { runId: 'run', reason: 'excluded-non-brand', count: 4 }, { runId: 'run', reason: 'a-newer-reason', count: 2 }], estimatedInputTokens: 10, estimatedCostUsd: null, estimateMethod: 'fixture' })
      }
      return jsonResponse(summary())
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = { mode: 'advanced' as const, queryClass: 'branded' as const, scope: 'property' as const, scopeKey: 'north', marketKey: 'chicago', provider: 'openai', model: 'source-model', location: 'Chicago', runId: 'run', revision: 3 }
    try {
      render(<QueryClientProvider client={client}><SentimentSection projectName="project" selection={view} /></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      const limit = screen.getByRole('checkbox', { name: /Limit to the current view/ }) as HTMLInputElement
      expect(limit.checked).toBe(false)
      expect(limit.closest('label')!.textContent).toContain('engine openai · model source-model · location Chicago · property north · market chicago · revision 3')
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByText('Branded queries · whole sweep')
      expect(Object.fromEntries(previews[0]!.searchParams)).toEqual({ mode: 'auto', scope: 'project', queryClass: 'branded', runId: 'run' })
      const skipped = screen.getByRole('list', { name: 'Skipped assessments' })
      expect([...skipped.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Incomplete sweep: 1', 'Non-brand answers (backfill that class separately): 4', 'A newer reason: 2'])
      expect((screen.getByRole('button', { name: 'Confirm sentiment backfill' }) as HTMLButtonElement).disabled).toBe(false)

      fireEvent.click(limit)
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByText('Branded queries · engine openai · model source-model · location Chicago · property north · market chicago · revision 3')
      expect(Object.fromEntries(previews[1]!.searchParams)).toMatchObject({ mode: 'advanced', queryClass: 'branded', runId: 'run', provider: 'openai', model: 'source-model', location: 'Chicago', scope: 'property', scopeKey: 'north', marketKey: 'chicago', revision: '3' })
      expect(screen.getByText('No saved answers in this selection can be classified.')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Confirm sentiment backfill' }) as HTMLButtonElement).disabled).toBe(true)
    } finally { cleanup(); client.clear(); restore() }
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
  it('disables both open write controls when the account becomes view-only before action permissions refresh', async () => {
    let writes = 0
    const dto = summary()
    const restore = mockFetch((url, init) => {
      if (init?.method === 'PUT' || init?.method === 'POST') writes++
      const path = new URL(url).pathname
      if (path.endsWith('/sentiment/settings')) return jsonResponse(settings(true))
      if (path.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
      if (path.endsWith('/sentiment/backfill-preview')) return jsonResponse({ previewToken: 'frozen-preview', expiresAt: '2026-09-28T11:00:00Z', selection: dto.selection, evaluationDefinitionId: 'definition-a', eligibleAssessments: 1, alreadyClassified: 0, skipped: [], estimatedInputTokens: 1234, estimatedCostUsd: 0.01, estimateMethod: 'fixture estimate' })
      return jsonResponse(dto)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const tree = (role: 'admin' | 'viewer') => <AccountProvider account={{ name: 'operator', role }}><QueryClientProvider client={client}><SentimentSection projectName="project" selection={{ mode: 'simple', queryClass: 'branded', scope: 'project', runId: 'run' }} /></QueryClientProvider></AccountProvider>
    try {
      const page = render(tree('admin'))
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByRole('button', { name: 'Confirm sentiment backfill' })
      page.rerender(tree('viewer'))
      const save = screen.getByRole('button', { name: 'Save sentiment settings' }) as HTMLButtonElement
      const confirm = screen.getByRole('button', { name: 'Confirm sentiment backfill' }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      expect(confirm.disabled).toBe(true)
      fireEvent.click(save)
      fireEvent.click(confirm)
      expect(writes).toBe(0)
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

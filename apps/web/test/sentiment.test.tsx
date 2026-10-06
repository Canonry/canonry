import { useState, type ComponentProps, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { aggregateSentiment, createSentimentEvaluationDefinition, emptySentimentCounts } from '@ainyc/canonry-contracts'
import type { SentimentEvidenceItem, SentimentSettings, SentimentSummary, SentimentAssessmentSummary } from '@ainyc/canonry-contracts'
import { SentimentScopeProvider, SentimentControls, SentimentHeadlines, SentimentQueryScore, SentimentAnswerOutcome, SentimentOverviewMetric, useSentimentResolvedSource, SENTIMENT_COPY, SENTIMENT_MIN_RATED, sentimentRatedShare } from '../src/components/project/SentimentSection.js'
import { sentimentSelectionFromVisibility, sentimentSelectionForSimpleEvidence, sentimentQueryKey, sentimentSummaryRefetchInterval } from '../src/queries/sentiment.js'
import { EvidenceTable } from '../src/components/project/EvidenceTable.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { compileAppStyles, parseCompiledCss, compiledDeclarations, compiledDeclarationValues, compiledElementProperty, resolvedCompiledProperty, cssLengthPx } from './compiled-app-css.js'

vi.mock('../src/hooks/use-drawer.js', () => ({ useDrawer: () => ({ openEvidence: vi.fn() }) }))
afterEach(cleanup)
function summary(): SentimentSummary {
  return { ...aggregateSentiment([]), state: 'complete', provisional: false, reason: null,
    selection: { mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run', revision: 3, provider: 'openai', model: 'source-model', location: 'Chicago', evaluationDefinitionId: 'definition-a' }, evaluationDefinition: createSentimentEvaluationDefinition(),
    // 12 assessments of 8 answers: 10 judged assessments rate 6 of the 8 answers, 75.0%, never 10 of 12.
    coverage: { selected: 12, eligibleAssessments: 12, unadmittedAssessments: 0, judged: 10, distinctSourceAnswers: 8, eligibleAnswers: 8, ratedAnswers: 6, ratedAnswerRate: 0.75, expectedProviderSlots: 12, completedProviderSlots: 12, counts: { ...emptySentimentCounts(), favorable: 6, mixed: 2, unfavorable: 2, factual: 2 } },
    score: { ...aggregateSentiment([]).score, favorableRate: 0.601, favorableDisplay: '60.1%', mixedRate: 0.2, mixedDisplay: '20%', unfavorableRate: 0.199, unfavorableDisplay: '19.9%', interval: { low: 0.23, high: 0.88 } },
    configured: true, queries: [], breakdowns: [] }
}
function settings(configure = false): SentimentSettings {
  return { installEnabled: true, enabled: true, ready: true, readinessReasons: [], model: 'jev-1.13.0', enablementEpoch: 1, completionBoundary: 2, evaluationDefinitionId: 'definition-a', actions: { configure, backfill: configure }, experimental: true, disclosure: 'Experimental sentiment' }
}
function SentimentSection(props: Omit<ComponentProps<typeof SentimentScopeProvider>, 'children'>) {
  return <SentimentScopeProvider {...props}><SentimentControls /><SentimentHeadlines /></SentimentScopeProvider>
}
function renderScope(children: ReactNode, options: { enabled?: boolean; configure?: boolean; branded?: SentimentSummary; nonBrand?: SentimentSummary; evidence?: SentimentEvidenceItem[] } = {}) {
  const branded = options.branded ?? summary()
  const nonBrand = options.nonBrand ?? { ...summary(), selection: { ...summary().selection, queryClass: 'non-brand' as const }, score: { ...summary().score, favorableRate: 0.25, favorableDisplay: '25%' } }
  const requests: URL[] = []
  const restore = mockFetch(url => {
    const request = new URL(url); requests.push(request)
    if (request.pathname.endsWith('/settings')) return jsonResponse({ ...settings(options.configure), enabled: options.enabled ?? true })
    if (request.pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
    if (request.pathname.endsWith('/evidence')) return jsonResponse({ state: 'complete', selection: branded.selection, items: options.evidence ?? [], nextCursor: null })
    return jsonResponse(request.searchParams.get('queryClass') === 'non-brand' ? nonBrand : branded)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', provider: 'openai', model: 'source-model', runId: 'run', revision: 3 }}>{children}</SentimentScopeProvider></QueryClientProvider>)
  return { requests, client, view, close: () => { cleanup(); client.clear(); restore() } }
}
/** A class line's Details chevron, in the line's last column, and the dropdown panel it opens. */
function classDetails(row: Element) {
  const toggle = row.querySelector<HTMLButtonElement>(':scope > button.sentiment-class-details-toggle')
  const panel = toggle ? document.getElementById(toggle.getAttribute('aria-controls')!) : null
  return { toggle, panel }
}
/** The app's empty value for a metric with no figure. */
const EMPTY_VALUE = '\u2014'
/** An element's text as a sighted reader sees it: without its screen-reader-only parts. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('.sr-only').forEach(node => node.remove())
  return copy.textContent ?? ''
}
/** A class line's Favorable and Rated columns and the note under its bar, as they read on screen. */
function figures(row: Element) {
  return {
    favorable: visibleText(row.querySelector(':scope > .sentiment-class-favorable')!),
    rated: visibleText(row.querySelector(':scope > .sentiment-class-ratings')!),
    note: row.querySelector(':scope > .sentiment-class-note')?.textContent ?? null,
  }
}
/** An empty Favorable column: the muted empty value, saying why in its tooltip and to a screen reader. */
function expectEmptyFavorable(cell: Element) {
  const mark = cell.querySelector<HTMLElement>(':scope > .sentiment-class-empty')!
  expect(mark.textContent).toBe(EMPTY_VALUE)
  expect(mark.getAttribute('aria-hidden')).toBe('true')
  expect(mark.title).toBe('Shown from 10 ratings')
  expect(cell.querySelector('.sr-only')!.textContent).toBe('Shown from 10 ratings')
  expect(cell.querySelector('.sentiment-class-share')).toBeNull()
}
/**
 * A Rated column, named for its class: only the share of answers rated on
 * screen, the count behind it in its tooltip and, after the share, to a screen
 * reader. Nothing else: no count, word or second metric on screen.
 */
function expectRated(row: Element, label: string, display: string, detail: string) {
  const cell = row.querySelector<HTMLElement>(':scope > .sentiment-class-ratings')!
  expect(cell.getAttribute('role')).toBe('group')
  expect(cell.getAttribute('aria-label')).toBe(`${label} share rated`)
  expect([...cell.children].map(child => child.getAttribute('aria-hidden'))).toEqual(['true', null])
  const [figure, spoken] = [...cell.children] as HTMLElement[]
  expect(visibleText(cell)).toBe(display)
  expect(figure!.textContent).toBe(display)
  expect(figure!.title).toBe(detail)
  expect(spoken!.textContent).toBe(`${display}, ${detail}`)
}
/** An empty Rated column: the muted empty value, saying why (no answers by default) in its tooltip and to a screen reader. */
function expectEmptyRated(row: Element, label: string, detail: string = SENTIMENT_COPY.noAnswers) {
  const cell = row.querySelector<HTMLElement>(':scope > .sentiment-class-ratings')!
  expect(cell.getAttribute('aria-label')).toBe(`${label} share rated`)
  expect([...cell.children].map(child => child.getAttribute('aria-hidden'))).toEqual(['true', null])
  const [mark, spoken] = [...cell.children] as HTMLElement[]
  expect(visibleText(cell)).toBe(EMPTY_VALUE)
  expect(mark!.textContent).toBe(EMPTY_VALUE)
  expect(mark!.title).toBe(detail)
  expect(spoken!.textContent).toBe(detail)
  expect(SENTIMENT_COPY.noAnswers).toBe('No answers yet')
  expect(SENTIMENT_COPY.ratedUnavailable).toBe('Unavailable')
}
function evidenceItem(overrides: Partial<SentimentEvidenceItem> = {}): SentimentEvidenceItem {
  return { ...{ assessmentId: 'a', runId: 'run', sourceSnapshotId: 'snapshot', sourceText: 'North Hall is excellent.', sourceTextHash: 'hash', subject: { id: 'north', displayName: 'North Hall', aliases: ['North Hall'], qualifiedAliases: [], urls: [], mentionNotApplicable: false }, subjectHash: 'subject', context: { queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', provider: 'openai', requestedModel: 'source-model', servedModel: 'source-model', location: 'Chicago', locationContext: null, revision: 3, usageEdges: [] }, evaluationDefinitionId: 'definition-a', outcome: 'favorable', conclusion: [{ id: 's1', text: 'North Hall is excellent.', start: 0, end: 24 }], complaint: null, returnedModel: 'jev-1.13.0', reason: null }, ...overrides }
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
      // Each class's Details count answers rated, 6 of 8, never assessments judged, 10 of 12.
      expect(screen.getAllByText('6 of 8')).toHaveLength(2)
      expect(screen.queryByText('10 of 12')).toBeNull()
      expect(screen.queryByText(/theme/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
    } finally { page.close() }
  })
  it('keeps headlines concise and moves coverage and uncertainty into closed details', async () => {
    const page = renderScope(<SentimentHeadlines />)
    try {
      const branded = await screen.findByLabelText('Branded favorable share')
      const nonBrand = await screen.findByLabelText('Non-brand favorable share')
      expect(branded.compareDocumentPosition(nonBrand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(branded.textContent).toBe('60.1%')
      expect(figures(branded.parentElement!)).toEqual({ favorable: '60.1%', rated: '75.0%', note: null })
      expect(branded.parentElement!.textContent).not.toContain('interval')
      const { toggle, panel: details } = classDetails(branded.parentElement!) as { toggle: HTMLButtonElement; panel: HTMLElement }
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(details.hidden).toBe(true)
      expect(within(branded.parentElement!).getByRole('button', { name: 'Branded details' })).toBe(toggle)
      expect(within(details).getByText('6 of 8')).toBeTruthy()
      // Admitted answers alone ("Source answers") are no longer a row: Rated answers carries the answer count.
      expect(within(details).queryByText('Source answers')).toBeNull()
      expect(within(details).getByText('Factual')).toBeTruthy()
      expect(within(details).getByText('23.0% to 88.0%')).toBeTruthy()
      expect(within(details).getByRole('button', { name: summary().score.limitation, hidden: true })).toBeTruthy()
      expect(screen.queryByText('Experimental sentiment')).toBeNull()
      expect(screen.queryByText('Coverage and method')).toBeNull()
      expect(document.body.textContent).not.toContain('0.23')
    } finally { page.close() }
  })
  it('hides the favorable share below ten ratings and keeps the rated outcomes in Details', async () => {
    // ainyc's branded class: 2 of 12 rated, 1 favorable and 1 mixed, 50.0% on the wire.
    const dto = summary()
    dto.coverage = { ...dto.coverage, judged: 2, distinctSourceAnswers: 12, eligibleAnswers: 12, ratedAnswers: 2, ratedAnswerRate: 0.16666667, counts: { ...emptySentimentCounts(), favorable: 1, mixed: 1, factual: 6, 'ambiguous-subject': 3, 'wrong-subject': 1 } }
    dto.score = { ...dto.score, favorableRate: 0.5, favorableDisplay: '50.0%' }
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      // The Favorable column holds only the empty value; Rated still holds the share rated, 2 of 12.
      expect(figures(headline.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '16.7%', note: null })
      expectEmptyFavorable(headline)
      expect(headline.textContent).toBe('—Shown from 10 ratings')
      expect(document.body.textContent).not.toContain('50.0%')
      const { toggle, panel: details } = classDetails(headline.parentElement!) as { toggle: HTMLButtonElement; panel: HTMLElement }
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(details.hidden).toBe(true)
      const rows = [...details.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')!.textContent, row.querySelector('dd')!.textContent])
      expect(rows).toEqual(expect.arrayContaining([
        ['Rated answers', '2 of 12'],
        ['Favorable', '1'],
        ['Mixed', '1'],
        ['Favorable share', 'Shown from 10 ratings'],
      ]))
      // An outcome with no ratings is not listed.
      expect(rows.some(([label]) => label === 'Unfavorable')).toBe(false)
    } finally { page.close() }
    for (const [judged, favorable, kind, segmentCount] of [
      [0, '—', 'empty', 0], [1, '—', 'too-few', 0], [9, '—', 'too-few', 0],
      [10, '37.5%', 'rated', 2], [44, '37.5%', 'rated', 2],
    ] as const) {
      const value = summary()
      value.coverage = { ...value.coverage, judged, ratedAnswers: judged, eligibleAnswers: 44, ratedAnswerRate: 0.25,
        counts: { ...emptySentimentCounts(), favorable: judged === 0 ? 0 : 1, mixed: judged === 0 ? 0 : judged - 1 } }
      // The server display deliberately differs from 1/judged. The UI passes it through.
      value.score = { ...value.score, favorableRate: judged === 0 ? null : 0.375, favorableDisplay: judged === 0 ? 'Unavailable' : '37.5%' }
      const mounted = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: value })
      try {
        const cell = await screen.findByLabelText('Branded favorable share')
        expect(visibleText(cell), `${judged} ratings favorable`).toBe(favorable)
        expect(figures(cell.parentElement!).rated, `${judged} ratings server share`).toBe('25.0%')
        const bar = cell.parentElement!.querySelector<HTMLElement>('.sentiment-bar')!
        expect(bar.dataset.sentimentBar, `${judged} ratings track`).toBe(kind)
        expect(bar.querySelectorAll('[data-outcome]').length, `${judged} ratings segments`).toBe(segmentCount)
        if (judged < 10) expectEmptyFavorable(cell)
        else expect(cell.textContent).toBe('37.5%')
      } finally { mounted.close() }
    }
  })
  it('shows the favorable share from exactly ten ratings, without the rated outcome rows', async () => {
    const page = renderScope(<SentimentHeadlines queryClass="branded" />)
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      expect(headline.textContent).toBe('60.1%')
      expect(headline.querySelector('.sentiment-class-share')!.textContent).toBe('60.1%')
      expect(figures(headline.parentElement!)).toEqual({ favorable: '60.1%', rated: '75.0%', note: null })
      expect(headline.querySelector('.sentiment-class-empty')).toBeNull()
      const details = classDetails(headline.parentElement!).panel!
      expect(within(details).queryByText('Favorable share')).toBeNull()
      expect(within(details).queryByText('Mixed')).toBeNull()
    } finally { page.close() }
  })
  it('shows only the selected query class and preserves zero judgments as unavailable', async () => {
    const dto = summary(); dto.coverage = { ...dto.coverage, judged: 0, ratedAnswers: 0, ratedAnswerRate: 0 }; dto.score = aggregateSentiment([]).score
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      // Zero ratings of 8 answers: the same empty value, a measured 0% rated, and the state under the bar.
      expect(figures(headline.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: SENTIMENT_COPY.noJudgments })
      expectEmptyFavorable(headline)
      expect(screen.queryByText('Unavailable')).toBeNull()
      expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
    } finally { page.close() }
  })
  it.each([['not-measured', 'No ratings yet.'], ['processing', 'Analyzing sentiment…'], ['canceled', 'Analysis canceled.'], ['partial', 'Partial results.'], ['failed', 'Analysis failed.']] as const)('preserves %s without inventing a zero', async (state, label) => {
    const dto = summary(); dto.state = state; dto.score = aggregateSentiment([]).score; dto.coverage.judged = 0
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try { expect(await screen.findByText(label)).toBeTruthy(); expect(screen.getByLabelText('Branded favorable share').textContent).not.toContain('0%') } finally { page.close() }
  })
  it('omits empty counts and methodology for an unmeasured class', async () => {
    const dto = { ...summary(), ...aggregateSentiment([]) }
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      expect(figures(headline.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: EMPTY_VALUE, note: 'No ratings yet.' })
      // No eligible answers: Rated is the empty value too, never 0%.
      expectEmptyRated(headline.parentElement!, 'Branded')
      expect(classDetails(headline.parentElement!).toggle).toBeNull()
      expect(headline.parentElement!.querySelector('.sentiment-class-details')).toBeNull()
      expect(screen.queryByText(/0 judged|Unavailable|95%/)).toBeNull()
    } finally { page.close() }
  })
  it('reads Unavailable, never "No answers yet", when an older server sends no answer counts', async () => {
    // A class with answers and ratings from a server that predates the Rated fields.
    const { eligibleAnswers: _eligible, ratedAnswers: _rated, ratedAnswerRate: _rate, ...older } = summary().coverage
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: { ...summary(), coverage: older } })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      expect(figures(headline.parentElement!)).toMatchObject({ rated: EMPTY_VALUE })
      expectEmptyRated(headline.parentElement!, 'Branded', SENTIMENT_COPY.ratedUnavailable)
      expect(screen.queryByText(SENTIMENT_COPY.noAnswers)).toBeNull()
      expect([...classDetails(headline.parentElement!).panel!.querySelectorAll('dt')].map(term => term.textContent)).not.toContain(SENTIMENT_COPY.details.ratedAnswers)
    } finally { page.close() }
  })
  it('rates over every eligible answer: 0 of 2 before admission, 1 of 2 once one is rated, with no judged over selected', async () => {
    const before = { ...summary(), ...aggregateSentiment([], { eligibleAssessments: 2, eligibleAnswers: 2 }) }
    const rated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'openai', sourceSnapshotId: 'openai', outcome: 'favorable' }], { eligibleAssessments: 2, eligibleAnswers: 2 }), selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    expect([before.coverage.selected, rated.coverage.judged, rated.coverage.selected]).toEqual([0, 1, 1])
    const page = renderScope(<SentimentHeadlines />, { branded: before, nonBrand: rated })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      const lineFor = (label: string) => screen.getByLabelText(`${label} favorable share`).closest('.sentiment-class')!
      const rows = (label: string) => [...classDetails(lineFor(label)).panel!.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])
      // Nothing admitted yet, but two answers are eligible: a measured 0%, never "No answers yet".
      expectRated(lineFor('Branded'), 'Branded', '0%', '0 of 2 answers rated')
      expect(rows('Branded')).toEqual([[SENTIMENT_COPY.details.ratedAnswers, '0 of 2'], [SENTIMENT_COPY.details.unadmitted, '2']])
      // One answer rated, one not admitted: 50.0%, never 100% of the one admitted.
      expectRated(lineFor('Non-brand'), 'Non-brand', '50.0%', '1 of 2 answers rated')
      expect(rows('Non-brand')).toEqual(expect.arrayContaining([[SENTIMENT_COPY.details.ratedAnswers, '1 of 2'], [SENTIMENT_COPY.details.unadmitted, '1']]))
      expect(lineFor('Non-brand').querySelector('.sentiment-class-ratings')!.textContent).not.toContain('100%')
    } finally { page.close() }
  })
  it('does not claim opinions are absent when completed assessments could not be rated', async () => {
    const dto = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]) }
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      expect(figures(headline.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: 'No ratings available.' })
      expect(within(classDetails(headline.parentElement!).panel!).getByText('Unsupported language')).toBeTruthy()
      expect(headline.textContent).not.toContain('0%')
    } finally { page.close() }
  })
  it('keeps measured zero and partial results visible while hiding empty coverage rows', async () => {
    const dto = summary(); dto.provisional = true; dto.state = 'partial'
    dto.coverage.unadmittedAssessments = 3
    dto.score = { ...dto.score, favorableRate: 0, favorableDisplay: '0%' }
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      // A measured 0% is a figure, not the empty value; partial results sit under the bar.
      expect(figures(headline.parentElement!)).toEqual({ favorable: '0%', rated: '75.0%', note: 'Partial results' })
      const details = classDetails(headline.parentElement!).panel!
      expect(within(details).getByText('Assessments not yet analyzed')).toBeTruthy()
      expect(within(details).getByText('3')).toBeTruthy()
      expect(within(details).queryByText('Pending')).toBeNull()
    } finally { page.close() }
  })
  it('keeps data processing disclosure in Manage sentiment only', async () => {
    const page = renderScope(<><SentimentHeadlines /><SentimentControls /></>, { configure: true })
    try {
      const manage = await screen.findByRole('button', { name: 'Manage sentiment' })
      expect(screen.queryByText('Experimental sentiment')).toBeNull()
      fireEvent.click(manage)
      expect(await screen.findByText('Experimental sentiment')).toBeTruthy()
    } finally { page.close() }
  })
  it('keeps enable reachable while default-off projects do not request summaries', async () => {
    const page = renderScope(<><SentimentHeadlines /><SentimentControls /></>, { enabled: false, configure: true })
    try {
      await screen.findByRole('button', { name: 'Enable sentiment' })
      expect(screen.queryByLabelText('Favorable answer scores')).toBeNull()
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(0)
    } finally { page.close() }
  })
  it('renders one overall API score with its evidence only in the tooltip', () => {
    const dto = summary(); dto.provisional = true; dto.state = 'partial'
    const overall = { queryClass: 'all' as const, state: dto.state, reason: dto.reason, provisional: dto.provisional, coverage: dto.coverage, score: { ...dto.score, favorableDisplay: '71.2%', favorableRate: 0.712 }, runIds: ['run'] }
    const value = { configured: true, overall, branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'], score: { ...dto.score, favorableDisplay: '25.0%' } } }
    const { container } = render(<SentimentOverviewMetric value={value} />)
    expect(screen.getByText('Sentiment', { exact: true })).toBeTruthy()
    expect(screen.getByText('71.2%', { exact: false })).toBeTruthy()
    expect(screen.queryByLabelText('Branded favorable share')).toBeNull()
    expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
    expect(container.querySelectorAll('.metric-inline-value')).toHaveLength(1)
    expect(container.querySelector('.metric-inline-value')?.textContent).toContain('all query classes')
    expect(screen.queryByText(/10 judged/)).toBeNull()
    expect(screen.queryByText('Unavailable')).toBeNull()
    const info = screen.getByRole('button', { name: /Overall sentiment/ })
    expect(info.getAttribute('aria-label')).toContain('10 of 12 judged')
    expect(info.getAttribute('aria-label')).toContain('95% interval 23.0% to 88.0%')
    expect(info.getAttribute('aria-label')).toContain('Provisional')
    fireEvent.pointerDown(info)
    fireEvent.focus(info)
    fireEvent.click(info, { detail: 1 })
    expect(info.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(info, { key: 'Escape' })
    expect(info.getAttribute('aria-expanded')).toBe('false')
  })
  it('shows measured zero overall sentiment as a number', () => {
    const dto = summary()
    const overall = { queryClass: 'all' as const, ...dto, runIds: ['run'], score: { ...dto.score, favorableRate: 0, favorableDisplay: '0.0%' } }
    render(<SentimentOverviewMetric value={{ configured: true, overall, branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'] } }} />)
    expect(screen.getByText('0.0%', { exact: false })).toBeTruthy()
  })
  it.each(['missing', 'unjudged', 'disabled', 'unavailable'] as const)('hides %s overall sentiment without reserving a metric slot', state => {
    const dto = summary()
    const overall = { queryClass: 'all' as const, ...dto, ...(state === 'unjudged' ? aggregateSentiment([]) : {}), reason: null, runIds: ['run'] }
    if (state === 'unavailable') overall.score = aggregateSentiment([]).score
    const value = { configured: state !== 'disabled', branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'] }, ...(state === 'missing' ? {} : { overall }) }
    const { container } = render(<SentimentOverviewMetric value={value} />)
    expect(container.innerHTML).toBe('')
  })
  it('hides the overview figure inside an embed, as the project page does', () => {
    const dto = summary()
    const value = { configured: true, overall: { queryClass: 'all' as const, ...dto, runIds: ['run'] }, branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'] } }
    const original = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
    const page = render(<SentimentOverviewMetric value={value} />)
    try {
      expect(page.container.innerHTML).toBe('')
      delete window.__CANONRY_CONFIG__
      page.rerender(<SentimentOverviewMetric value={value} />)
      expect(within(page.container).getByText('60.1%', { exact: false })).toBeTruthy()
      page.rerender(<SentimentOverviewMetric value={{ ...value, configured: false }} />)
      expect(page.container.innerHTML).toBe('')
    } finally { window.__CANONRY_CONFIG__ = original }
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
      const queryToggle = within(row).getByRole('button', { name: 'Is North Hall good?' })
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
      expect(button.textContent).toContain('10 judged')
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
  it('shows verbatim quotations and a truthful empty complaint in the evidence drawer', async () => {
    const item = evidenceItem()
    const page = renderScope(<SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot']} queryClass="branded" provider="openai" location="Chicago" />, {
      branded: summaryWithAssessments([assessment({ assessmentId: 'a', sourceSnapshotId: 'snapshot' })]), evidence: [{ ...item, sourceText: 'North Hall is excellent. A factual follow-up mentions parking.' }],
    })
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' }))
      const dialog = await screen.findByRole('dialog', { name: 'Sentiment evidence: Is North Hall good? · openai · North Hall' })
      await within(dialog).findByText('definition-a')
      expect([...dialog.querySelectorAll('blockquote')].map(node => node.textContent)).toEqual(['North Hall is excellent.'])
      expect(dialog.textContent).toContain('No complaint was identified.')
      expect(within(dialog).getByText('hash')).toBeTruthy()
      const requests = page.requests.filter(url => url.pathname.endsWith('/evidence'))
      expect(requests).toHaveLength(1)
      expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run', revision: '3', location: 'Chicago', evaluationDefinitionId: 'definition-a', queryId: 'q', assessmentId: 'a', provider: 'openai', model: 'source-model', limit: '50' })
    } finally { page.close() }
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
      fireEvent.click(screen.getByRole('button', { name: 'Is North Hall good?' }))
      const favorable = await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' })
      const unfavorable = screen.getByRole('button', { name: 'View gemini sentiment evidence for North Hall: Unfavorable' })
      expect(within(favorable.closest('tr')!).getByText('OpenAI')).toBeTruthy()
      expect(within(unfavorable.closest('tr')!).getByText('Gemini')).toBeTruthy()
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
      await waitFor(() => expect(screen.getByLabelText('Favorable answer scores').textContent).toContain('No saved answers.'))
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
    const running = withCounts('processing', { running: 1 })
    const terminal = withCounts('partial', { failed: 1 })
    const reads: URL[] = []
    const counts = { branded: 0, 'non-brand': 0 }
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings())
      const queryClass = request.searchParams.get('queryClass') === 'non-brand' ? 'non-brand' : 'branded'
      reads.push(request)
      counts[queryClass]++
      const dto = counts[queryClass] === 1 ? running : terminal
      return jsonResponse({ ...dto, selection: { ...dto.selection, queryClass } })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Leave notification/RTL timeouts real; only the owner's refetch intervals use the controlled clock.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', queryClass: 'branded', scope: 'property', scopeKey: 'north', runId: 'run' }}><SentimentHeadlines /></SentimentScopeProvider></QueryClientProvider>)
      await screen.findByLabelText('Branded favorable share')
      await screen.findByLabelText('Non-brand favorable share')
      expect(reads.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(4999) })
      expect(reads.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      await waitFor(() => expect(counts).toEqual({ branded: 2, 'non-brand': 2 }))
      await waitFor(() => expect(client.isFetching()).toBe(0))
      await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
      expect(counts).toEqual({ branded: 2, 'non-brand': 2 })
      expect(reads.map(url => url.searchParams.get('queryClass'))).toEqual(['branded', 'non-brand', 'branded', 'non-brand'])
    } finally { cleanup(); client.clear(); restore(); vi.useRealTimers() }
  })
})

/** A class summary built the way the server builds it, so its rates are its counts over its ratings. */
function measured(queryClass: 'branded' | 'non-brand', outcomes: Partial<Record<SentimentAssessmentSummary['outcome'] & string, number>>): SentimentSummary {
  const items = Object.entries(outcomes).flatMap(([outcome, count]) => Array.from({ length: count ?? 0 }, (_, index) => ({ assessmentId: `${outcome}-${index}`, sourceSnapshotId: `${outcome}-${index}`, outcome: outcome as SentimentAssessmentSummary['outcome'] & string })))
  const base = summary()
  return { ...base, ...aggregateSentiment(items), state: 'complete', provisional: false, selection: { ...base.selection, queryClass } }
}
function barFor(label: string) { return screen.getByLabelText(`${label} favorable share`).closest('.sentiment-class')!.querySelector<HTMLElement>('.sentiment-bar')! }
function segments(bar: HTMLElement) { return [...bar.querySelectorAll<HTMLElement>('[data-outcome]')].map(segment => [segment.dataset.outcome, Number(segment.style.flexGrow), segment.title]) }

describe('sentiment share rated', () => {
  it('formats the server share of answers rated like the Favorable column, with the server counts behind it', () => {
    const cases: [ratedAnswers: number, eligibleAnswers: number, ratedAnswerRate: number, display: string][] = [
      [16, 20, 0.8, '80.0%'], [1, 32, 0.03125, '3.1%'], [3, 12, 0.25, '25.0%'], [4, 44, 0.09090909, '9.1%'],
      [2, 12, 0.16666667, '16.7%'], [1, 3, 0.33333333, '33.3%'], [2, 3, 0.66666667, '66.7%'], [1, 16, 0.0625, '6.3%'],
      [0, 12, 0, '0%'], [20, 20, 1, '100%'], [1, 3000, 0.00033333, '<0.1%'], [2999, 3000, 0.99966667, '>99.9%'],
    ]
    expect(cases.map(([ratedAnswers, eligibleAnswers, ratedAnswerRate]) => sentimentRatedShare({ ratedAnswers, eligibleAnswers, ratedAnswerRate }).display)).toEqual(cases.map(([, , , display]) => display))
    expect(sentimentRatedShare({ ratedAnswers: 16, eligibleAnswers: 20, ratedAnswerRate: 0.8 }).detail).toBe('16 of 20 answers rated')
    expect(sentimentRatedShare({ ratedAnswers: 1, eligibleAnswers: 1, ratedAnswerRate: 1 }).detail).toBe('1 of 1 answer rated')
  })
  it('shows the server share, never a judged over selected division', () => {
    // The review's case: two eligible answers, one rated, one not yet admitted. 1 of 2, not 1 of 1.
    expect(sentimentRatedShare({ ratedAnswers: 1, eligibleAnswers: 2, ratedAnswerRate: 0.5 })).toEqual({ display: '50.0%', detail: '1 of 2 answers rated', empty: false })
    // The figure is the server's rate as sent; the counts only label it.
    expect(sentimentRatedShare({ ratedAnswers: 1, eligibleAnswers: 2, ratedAnswerRate: 0.25 }).display).toBe('25.0%')
  })
  it('shows a measured 0% before admission, while answers are eligible', () => {
    expect(sentimentRatedShare({ ratedAnswers: 0, eligibleAnswers: 2, ratedAnswerRate: 0 })).toEqual({ display: '0%', detail: '0 of 2 answers rated', empty: false })
  })
  it('shows the empty value and "No answers yet" only when there are no eligible answers', () => {
    expect(sentimentRatedShare({ ratedAnswers: 0, eligibleAnswers: 0, ratedAnswerRate: null })).toEqual({ display: EMPTY_VALUE, detail: 'No answers yet', empty: true })
    // A server older than the answer fields sends none of them: unavailable, with no claim about answers.
    expect(sentimentRatedShare({})).toEqual({ display: EMPTY_VALUE, detail: 'Unavailable', empty: true })
    expect(sentimentRatedShare({ ratedAnswers: 3, ratedAnswerRate: 0.5 })).toEqual({ display: EMPTY_VALUE, detail: 'Unavailable', empty: true })
    // A withheld share (sentiment off) is empty too, but never claims there are no answers.
    expect(sentimentRatedShare({ ratedAnswers: 0, eligibleAnswers: 4, ratedAnswerRate: null })).toEqual({ display: EMPTY_VALUE, detail: SENTIMENT_COPY.states.disabled, empty: true })
  })
})

describe('sentiment bars', () => {
  // Tank Air's two classes on the live engine: branded 9 favorable and 7 mixed of
  // 16 ratings (plus 4 factual), non-brand 1 favorable of 1 rating.
  const branded = () => measured('branded', { favorable: 9, mixed: 7, factual: 4 })
  const nonBrand = () => measured('non-brand', { favorable: 1, 'subject-not-mentioned': 30, 'ambiguous-subject': 1 })

  it('splits each class bar by its rated counts, one segment per outcome with ratings', async () => {
    const dto = measured('branded', { favorable: 5, mixed: 3, unfavorable: 2, factual: 6 })
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      await screen.findByLabelText('Branded favorable share')
      const bar = barFor('Branded')
      expect(bar.getAttribute('data-sentiment-bar')).toBe('rated')
      // Each segment grows by its own count, so the widths are the counts.
      expect(segments(bar)).toEqual([
        ['favorable', 5, 'Favorable: 5 of 10 ratings'],
        ['mixed', 3, 'Mixed: 3 of 10 ratings'],
        ['unfavorable', 2, 'Unfavorable: 2 of 10 ratings'],
      ])
      const total = segments(bar).reduce((sum, [, grow]) => sum + (grow as number), 0)
      expect(total).toBe(dto.coverage.judged)
      // The same proportions the server reports, never a second calculation.
      expect(segments(bar).map(([, grow]) => (grow as number) / total)).toEqual([dto.score.favorableRate, dto.score.mixedRate, dto.score.unfavorableRate])
      expect(bar.getAttribute('aria-label')).toBe('Branded: 5 favorable, 3 mixed, 2 unfavorable, 50.0% favorable of 10 ratings')
    } finally { page.close() }
  })

  it('reads Tank Air branded as one bar line: label, bar, Favorable, Rated, then the Details chevron', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const value = await screen.findByLabelText('Branded favorable share')
      const row = value.closest('.sentiment-class')!
      // The share alone in Favorable, the share rated alone in Rated (16 of 20): no sentence.
      expect(figures(row)).toEqual({ favorable: '56.3%', rated: '80.0%', note: null })
      expect(value.textContent).toBe('56.3%')
      expectRated(row, 'Branded', '80.0%', '16 of 20 answers rated')
      const children = [...row.children]
      const bar = barFor('Branded')
      // Label with its ⓘ, the bar, the two figure columns, the chevron in the
      // last column, then the dropdown panel it opens.
      const order = [children[0]!, bar, value, screen.getByRole('group', { name: 'Branded share rated' }), screen.getByRole('button', { name: 'Branded details' })]
      for (let index = 1; index < order.length; index++) expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(children[0]!.textContent).toBe('Branded')
      expect(within(children[0] as HTMLElement).getByRole('button', { name: 'The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.' })).toBeTruthy()
      expect(bar.getAttribute('role')).toBe('img')
      expect(bar.getAttribute('aria-label')).toBe('Branded: 9 favorable, 7 mixed, 0 unfavorable, 56.3% favorable of 16 ratings')
      // An outcome with no ratings draws no segment.
      expect(segments(bar).map(([outcome, grow]) => [outcome, grow])).toEqual([['favorable', 9], ['mixed', 7]])
      const { toggle, panel } = classDetails(row) as { toggle: HTMLButtonElement; panel: HTMLElement }
      expect(toggle.getAttribute('type')).toBe('button')
      // Chevron only: no visible word, named for its class.
      expect(toggle.textContent).toBe('')
      expect(toggle.getAttribute('aria-label')).toBe('Branded details')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(panel.id).toBe(toggle.getAttribute('aria-controls'))
      expect(panel.hidden).toBe(true)
      expect(within(panel).getByText('16 of 20')).toBeTruthy()
      expect(within(panel).getByText('Factual')).toBeTruthy()
      expect(within(panel).getByText(/to/, { selector: 'dd' })).toBeTruthy()
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(panel.hidden).toBe(false)
      expect(within(panel).getByRole('button', { name: branded().score.limitation })).toBeTruthy()
      fireEvent.click(toggle)
      expect(panel.hidden).toBe(true)
      // Both classes keep their own ⓘ and their own Details.
      const group = screen.getByRole('group', { name: 'Favorable answer scores' })
      expect(within(group).getAllByRole('button', { name: 'The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.' })).toHaveLength(2)
      const chevrons = within(group).getAllByRole('button', { name: /details$/ })
      expect(chevrons.map(button => button.getAttribute('aria-label'))).toEqual(['Branded details', 'Non-brand details'])
      expect(new Set(chevrons.map(button => button.getAttribute('aria-controls'))).size).toBe(2)
    } finally { page.close() }
  })

  it('shows the server share of answers rated in Rated, with its counts in its tooltip, its screen-reader text and Details', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      const lineFor = (label: string) => screen.getByLabelText(`${label} favorable share`).closest('.sentiment-class')!
      // Tank Air: branded 16 of 20 answers rated, non-brand 1 of 32.
      expect([branded(), nonBrand()].map(value => [value.coverage.ratedAnswers, value.coverage.eligibleAnswers, value.coverage.ratedAnswerRate])).toEqual([[16, 20, 0.8], [1, 32, 0.03125]])
      expectRated(lineFor('Branded'), 'Branded', '80.0%', '16 of 20 answers rated')
      expectRated(lineFor('Non-brand'), 'Non-brand', '3.1%', '1 of 32 answers rated')
      expect(screen.getByRole('group', { name: 'Branded share rated' })).toBe(lineFor('Branded').querySelector('.sentiment-class-ratings'))
      // The raw count is not removed: Details still lists it beside the share.
      for (const [label, count] of [['Branded', '16 of 20'], ['Non-brand', '1 of 32']] as const) {
        const panel = classDetails(lineFor(label)).panel!
        expect([...panel.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])).toContainEqual([SENTIMENT_COPY.details.ratedAnswers, count])
      }
      // The Favorable column is untouched: the share from ten ratings, the empty value below.
      expect(figures(lineFor('Branded')).favorable).toBe('56.3%')
      expectEmptyFavorable(screen.getByLabelText('Non-brand favorable share'))
    } finally { page.close() }
  })

  it('names the figure columns Favorable and Rated, with what Rated counts in its tooltip, and adds no tab stop', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      const header = document.querySelector<HTMLElement>('.sentiment-headlines-columns')!
      expect(header.getAttribute('aria-hidden')).toBe('true')
      expect([...header.children].map(child => [child.textContent, (child as HTMLElement).title])).toEqual([
        ['Favorable', ''],
        ['Rated', 'Share of answers rated favorable, mixed or unfavorable'],
      ])
      expect(header.querySelector('button, a, [tabindex]')).toBeNull()
    } finally { page.close() }
  })

  it('draws a class below ten ratings as a plain track beside an empty Favorable column and its share rated, with no favorable share anywhere', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const value = await screen.findByLabelText('Non-brand favorable share')
      expect(nonBrand().score.favorableDisplay).toBe('100%')
      expect(figures(value.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '3.1%', note: null })
      expectEmptyFavorable(value)
      // 1 of 32 rounds half up on the tenth: 3.125% reads 3.1%.
      expectRated(value.parentElement!, 'Non-brand', '3.1%', '1 of 32 answers rated')
      const bar = barFor('Non-brand')
      expect(bar.getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(bar.classList.contains('sentiment-bar-track')).toBe(true)
      // No proportional segments: one favorable rating would fill the bar and
      // show the 100% share the empty Favorable column hides.
      expect(bar.querySelectorAll('[data-outcome]')).toHaveLength(0)
      expect(bar.children).toHaveLength(0)
      // The counts stay in the bar's label and in Details.
      expect(bar.getAttribute('role')).toBe('img')
      expect(bar.getAttribute('aria-label')).toBe('Non-brand: 1 favorable, 0 mixed, 0 unfavorable, 1 rating, favorable share shown from 10 ratings')
      expect(bar.getAttribute('aria-label')).not.toContain('100%')
      const row = bar.closest('.sentiment-class')!
      const { toggle, panel } = classDetails(row) as { toggle: HTMLButtonElement; panel: HTMLElement }
      expect(row.textContent!.replace(panel.textContent!, '')).not.toContain('100%')
      // No column or label in the line says "too few" or counts toward the minimum.
      const said = [row.textContent!.replace(panel.textContent!, ''), ...[...row.querySelectorAll('[aria-label], [title]')].filter(element => !panel.contains(element)).flatMap(element => [element.getAttribute('aria-label') ?? '', element.getAttribute('title') ?? ''])].join(' | ')
      expect(said).not.toMatch(/too few|\bof 10\b|needed/i)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(panel.textContent).toContain(`Shown from ${SENTIMENT_MIN_RATED} ratings`)
      expect([...panel.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])).toEqual(expect.arrayContaining([[SENTIMENT_COPY.details.ratedAnswers, '1 of 32'], ['Favorable', '1']]))
      // The branded bar beside it keeps its segments.
      expect(barFor('Branded').querySelectorAll('[data-outcome]')).toHaveLength(2)
    } finally { page.close() }
  })

  it('draws no segments and no legend when every class is below ten ratings (ainyc)', async () => {
    // ainyc on Sep 30: branded 1 favorable and 2 mixed, 3 ratings of 12 answers;
    // non-brand 4 favorable, 4 ratings of 44 answers.
    const page = renderScope(<SentimentHeadlines />, { branded: measured('branded', { favorable: 1, mixed: 2, factual: 7, 'subject-not-mentioned': 1, 'wrong-subject': 1 }), nonBrand: measured('non-brand', { favorable: 4, factual: 3, 'subject-not-mentioned': 36, 'ambiguous-subject': 1 }) })
    try {
      for (const [label, rated, count] of [['Branded', '25.0%', '3 of 12 answers rated'], ['Non-brand', '9.1%', '4 of 44 answers rated']] as const) {
        const value = await screen.findByLabelText(`${label} favorable share`)
        expect(figures(value.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated, note: null })
        expectEmptyFavorable(value)
        expectRated(value.parentElement!, label, rated, count)
      }
      for (const label of ['Branded', 'Non-brand']) expect(barFor(label).getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(document.querySelectorAll('[data-outcome]')).toHaveLength(0)
      expect(document.querySelector('.sentiment-legend')).toBeNull()
      expect(barFor('Branded').getAttribute('aria-label')).toBe('Branded: 1 favorable, 2 mixed, 0 unfavorable, 3 ratings, favorable share shown from 10 ratings')
      const rows = (label: string) => [...classDetails(barFor(label).closest('.sentiment-class')!).panel!.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])
      expect(rows('Branded')).toEqual(expect.arrayContaining([['Favorable', '1'], ['Mixed', '2']]))
      expect(rows('Non-brand')).toEqual(expect.arrayContaining([['Favorable', '4']]))
    } finally { page.close() }
  })

  it('draws an empty bar beside the existing wording when a class has no ratings, and no legend when no class does', async () => {
    const unmeasured = { ...summary(), ...aggregateSentiment([]) }
    const unrated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]), selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    const page = renderScope(<SentimentHeadlines />, { branded: unmeasured, nonBrand: unrated })
    try {
      expect(figures((await screen.findByLabelText('Branded favorable share')).parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: EMPTY_VALUE, note: 'No ratings yet.' })
      expect(figures((await screen.findByLabelText('Non-brand favorable share')).parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: 'No ratings available.' })
      for (const label of ['Branded', 'Non-brand']) {
        const bar = barFor(label)
        expect(bar.getAttribute('data-sentiment-bar')).toBe('empty')
        expect(bar.getAttribute('aria-hidden')).toBe('true')
        expect(bar.getAttribute('role')).toBeNull()
        expect(bar.children).toHaveLength(0)
      }
      // A class with nothing to disclose has no chevron; its column stays, so its bar still ends level.
      expect(classDetails(barFor('Branded').closest('.sentiment-class')!).toggle).toBeNull()
      expect(classDetails(barFor('Non-brand').closest('.sentiment-class')!).toggle).not.toBeNull()
      expect(screen.queryByRole('img')).toBeNull()
      expect(document.querySelector('.sentiment-legend')).toBeNull()
    } finally { page.close() }
  })

  it('names the segment colors in a legend under the last bar once a bar has segments, and adds no tab stop', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const group = screen.getByRole('group', { name: 'Favorable answer scores' })
      const legend = document.querySelector<HTMLElement>('.sentiment-legend')!
      expect(group.lastElementChild).toBe(legend)
      expect(legend.getAttribute('aria-hidden')).toBe('true')
      expect([...legend.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Favorable', 'Mixed', 'Unfavorable'])
      expect([...legend.querySelectorAll('li span')].map(element => compiledElementProperty(css, element, 'background-color'))).toEqual([
        'var(--color-info-400)', 'var(--color-caution-400)', 'var(--color-negative-400)',
      ])
      expect([...barFor('Branded').children].map(element => compiledElementProperty(css, element, 'background-color'))).toEqual(['var(--color-info-400)', 'var(--color-caution-400)'])
      // The bars are images with text, never focus stops; the ⓘ and Details stay the only controls.
      for (const bar of document.querySelectorAll('.sentiment-bar')) {
        expect(bar.getAttribute('tabindex')).toBeNull()
        expect(bar.querySelector('button, a, [tabindex], summary')).toBeNull()
      }
      // Neither the column header nor a figure is a tab stop.
      expect(group.querySelector('.sentiment-headlines-columns')!.querySelector('button, a, [tabindex]')).toBeNull()
      // Controls inside a closed Details panel are not reachable until it opens.
      const focusable = [...group.querySelectorAll<HTMLElement>('button')].filter(element => !element.closest('[hidden]')).map(element => element.getAttribute('aria-label'))
      expect(focusable).toEqual(['The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.', 'Branded details', 'The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.', 'Non-brand details'])
    } finally { page.close() }
  })

  it('puts the legend and the section actions in one row above the full-width bars, and opens the action panel under the bars', async () => {
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    const actions = <><button type="button">Manage sentiment</button><button type="button">Manage queries</button></>
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', queryId: 'q', sourceSnapshotId: 'snapshot', query: 'Is North Hall good?', queryClass: 'branded' }]} actions={actions} actionPanel={<div data-testid="query-editor" />} />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const scores = await screen.findByRole('group', { name: 'Favorable answer scores' })
      await screen.findByLabelText('Non-brand favorable share')
      const section = scores.parentElement!
      // First one compact row (legend left, actions right), then the bars on
      // their own at the section's full width (nothing sits beside them), then
      // the query editor.
      const editor = screen.getByTestId('query-editor')
      expect(scores.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(section.contains(editor)).toBe(true)
      const toolbar = section.children[0] as HTMLElement
      const legend = toolbar.querySelector('ul')!
      expect([...legend.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Favorable', 'Mixed', 'Unfavorable'])
      expect(toolbar.compareDocumentPosition(scores) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(within(toolbar.children[1] as HTMLElement).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage sentiment', 'Manage queries'])
      // The column header, then one line per class.
      expect([...scores.querySelectorAll('[data-query-class]')].map(child => child.getAttribute('data-query-class'))).toEqual(['branded', 'non-brand'])
      // One legend, in the row above the bars rather than inside them.
      expect(document.querySelectorAll('.sentiment-legend')).toHaveLength(1)
      expect(scores.querySelector('.sentiment-legend')).toBeNull()
    } finally { page.close() }
  })

  it('keeps the legend alone in the row above the bars when the section has no actions (an embed)', async () => {
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    const original = window.__CANONRY_CONFIG__
    window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', query: 'Is North Hall good?', queryClass: 'branded' }]} />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const scores = await screen.findByRole('group', { name: 'Favorable answer scores' })
      await screen.findByLabelText('Non-brand favorable share')
      const section = scores.parentElement!
      const toolbar = section.children[0] as HTMLElement
      expect([...toolbar.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Favorable', 'Mixed', 'Unfavorable'])
      expect(toolbar.querySelector('button')).toBeNull()
      expect(screen.queryByRole('button', { name: /Manage sentiment|Manage queries/ })).toBeNull()
      expect(toolbar.compareDocumentPosition(scores) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      expect(scores.querySelector('.sentiment-legend')).toBeNull()
    } finally { page.close(); window.__CANONRY_CONFIG__ = original }
  })

  it('keeps the actions row when sentiment is off', async () => {
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', query: 'Is North Hall good?', queryClass: 'branded' }]} actions={<button type="button">Manage queries</button>} />, { enabled: false })
    try {
      const manage = await screen.findByRole('button', { name: 'Manage queries' })
      const toolbar = manage.parentElement!.parentElement!
      expect(within(toolbar).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage queries'])
      expect(screen.getByRole('table').compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0)
      expect(screen.queryByRole('group', { name: 'Favorable answer scores' })).toBeNull()
      expect(document.querySelector('.sentiment-legend')).toBeNull()
    } finally { page.close() }
  })
})

describe('sentiment Details dropdown', () => {
  const branded = () => measured('branded', { favorable: 9, mixed: 7, factual: 4 })
  const nonBrand = () => measured('non-brand', { favorable: 1, 'subject-not-mentioned': 30, 'ambiguous-subject': 1 })
  /** A panel's rows as [label, value], the ⓘ's trailing space trimmed. */
  const rows = (panel: HTMLElement) => [...panel.querySelectorAll('dl > div')].map(row => [row.querySelector('dt')!.textContent!.trim(), row.querySelector('dd')!.textContent])
  const lineFor = (label: string) => screen.getByLabelText(`${label} favorable share`).closest('.sentiment-class')!
  const dropdownFor = (label: string) => classDetails(lineFor(label)) as { toggle: HTMLButtonElement; panel: HTMLElement }

  it('is a chevron button named "<class> details" with a non-modal panel named by its class, not a menu', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      for (const label of ['Branded', 'Non-brand']) {
        const { toggle, panel } = dropdownFor(label)
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(toggle.getAttribute('aria-controls')).toBe(panel.id)
        expect(toggle.hasAttribute('aria-haspopup')).toBe(false)
        expect(toggle.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
        expect(toggle.textContent).toBe('')
        expect(within(lineFor(label) as HTMLElement).getByRole('button', { name: `${label} details` })).toBe(toggle)
        // Last in the line before its panel, after both figure columns.
        expect(screen.getByRole('group', { name: `${label} share rated` }).compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(panel.getAttribute('role')).toBe('group')
        expect(document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toBe(label)
        expect(panel.querySelector('.sentiment-class-details-title')!.textContent).toBe(label)
        // The panel follows its button in the DOM, so it is next in tab order once open.
        expect(toggle.nextElementSibling).toBe(panel)
      }
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.queryByRole('menuitem')).toBeNull()
      fireEvent.click(dropdownFor('Branded').toggle)
      expect(screen.getByRole('group', { name: 'Branded' })).toBe(dropdownFor('Branded').panel)
    } finally { page.close() }
  })

  it('opens on click, keeps one panel open at a time, and closes on a second click, an outside click, Escape and focus leaving', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      const brandedDropdown = dropdownFor('Branded')
      const nonBrandDropdown = dropdownFor('Non-brand')
      const state = () => [brandedDropdown, nonBrandDropdown].map(({ toggle, panel }) => [toggle.getAttribute('aria-expanded'), panel.hidden])
      expect(state()).toEqual([['false', true], ['false', true]])
      fireEvent.click(brandedDropdown.toggle)
      expect(state()).toEqual([['true', false], ['false', true]])
      // Only one open: opening non-brand closes branded.
      fireEvent.click(nonBrandDropdown.toggle)
      expect(state()).toEqual([['false', true], ['true', false]])
      fireEvent.click(nonBrandDropdown.toggle)
      expect(state()).toEqual([['false', true], ['false', true]])
      // A click inside the open panel keeps it open; one outside closes it.
      fireEvent.click(brandedDropdown.toggle)
      fireEvent.pointerDown(brandedDropdown.panel.querySelector('dd')!)
      expect(state()).toEqual([['true', false], ['false', true]])
      fireEvent.pointerDown(document.body)
      expect(state()).toEqual([['false', true], ['false', true]])
      // Escape closes it and returns focus to its button.
      fireEvent.click(brandedDropdown.toggle)
      brandedDropdown.panel.querySelector<HTMLButtonElement>('.info-tooltip-trigger')!.focus()
      fireEvent.focusIn(brandedDropdown.panel.querySelector('.info-tooltip-trigger')!)
      expect(state()).toEqual([['true', false], ['false', true]])
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(state()).toEqual([['false', true], ['false', true]])
      expect(document.activeElement).toBe(brandedDropdown.toggle)
      // Other keys leave it open.
      fireEvent.click(brandedDropdown.toggle)
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      expect(state()).toEqual([['true', false], ['false', true]])
      // Focus moving past the panel (Tab to the next line) closes it.
      fireEvent.focusIn(within(lineFor('Non-brand') as HTMLElement).getByRole('button', { name: 'The favorable share of favorable, mixed and unfavorable ratings. Each rating evaluates one subject in an answer. Branded and non-brand queries are measured separately.' }))
      expect(state()).toEqual([['false', true], ['false', true]])
    } finally { page.close() }
  })

  it('lists every Details row in the panel: label, value, the 95% range with its ⓘ', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      const brandedPanel = dropdownFor('Branded').panel
      expect(rows(brandedPanel)).toEqual([
        ['Rated answers', '16 of 20'],
        ['Factual', '4'],
        ['95% confidence range', '33.2% to 76.9%'],
      ])
      // Too few: the rated outcomes and the share's threshold join the rows.
      const nonBrandPanel = dropdownFor('Non-brand').panel
      expect(rows(nonBrandPanel)).toEqual([
        ['Rated answers', '1 of 32'],
        ['Favorable', '1'],
        ['Favorable share', 'Shown from 10 ratings'],
        ['Subject not mentioned', '30'],
        ['Ambiguous subject', '1'],
        ['95% confidence range', '20.7% to 100%'],
      ])
      for (const panel of [brandedPanel, nonBrandPanel]) {
        const range = [...panel.querySelectorAll('dl > div')].at(-1)!
        expect(within(range as HTMLElement).getByRole('button', { name: branded().score.limitation, hidden: true })).toBeTruthy()
      }
      // The line below ten ratings keeps its grey track, the empty Favorable value and its share rated, with no favorable share.
      expect(barFor('Non-brand').getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(figures(lineFor('Non-brand'))).toEqual({ favorable: EMPTY_VALUE, rated: '3.1%', note: null })
    } finally { page.close() }
  })

  it('keeps a reason under the rows and shows no Details for a class with nothing to disclose', async () => {
    const unmeasured = { ...summary(), ...aggregateSentiment([]) }
    const unrated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]), reason: 'Answers were in an unsupported language.', selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    const page = renderScope(<SentimentHeadlines />, { branded: unmeasured, nonBrand: unrated })
    try {
      await screen.findByLabelText('Non-brand favorable share')
      // Zero ratings, nothing measured: the empty bar and the state, no Details.
      expect(figures(lineFor('Branded'))).toEqual({ favorable: EMPTY_VALUE, rated: EMPTY_VALUE, note: 'No ratings yet.' })
      expect(classDetails(lineFor('Branded')).toggle).toBeNull()
      expect(lineFor('Branded').querySelector('.sentiment-class-details')).toBeNull()
      expect(barFor('Branded').getAttribute('data-sentiment-bar')).toBe('empty')
      // Zero ratings with assessments: 0 of 1 answer rated, and its Details still opens with what was found.
      expect(figures(lineFor('Non-brand'))).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: 'No ratings available.' })
      expectRated(lineFor('Non-brand'), 'Non-brand', '0%', '0 of 1 answer rated')
      const { toggle, panel } = dropdownFor('Non-brand')
      fireEvent.click(toggle)
      expect(panel.hidden).toBe(false)
      expect(rows(panel)).toEqual([['Rated answers', '0 of 1'], ['Unsupported language', '1']])
      expect(panel.lastElementChild!.textContent).toBe('Answers were in an unsupported language.')
      expect(panel.querySelector('dl')!.compareDocumentPosition(within(panel).getByText('Answers were in an unsupported language.')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    } finally { page.close() }
  })
})

describe('sentiment bar styles', () => {
  it('keeps the legend swatches in their colors under forced colors, like the bar segments', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    for (const selector of ['.sentiment-bar-segment', '.sentiment-legend-swatch']) {
      expect(compiledDeclarations(css, selector, '@media (forced-colors: active)')).toMatchObject({ 'forced-color-adjust': 'none' })
    }
  })

  it('runs each class line the full width on shared columns: label, the bar as the one flexible column, then fixed Favorable, Rated and chevron columns', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const headlines = compiledDeclarations(css, '.sentiment-headlines')
    expect(headlines).toMatchObject({ display: 'grid', container: 'sentiment-headlines / inline-size' })
    const tracks = headlines['grid-template-columns']!.split(/ (?![^(]*\))/)
    expect(tracks).toHaveLength(5)
    expect(tracks.map(track => track.includes('fr'))).toEqual([false, true, false, false, false])
    expect(tracks[1]).toBe('minmax(0, 1fr)')
    expect(tracks.slice(2).map(value => cssLengthPx(value, css)).every(value => value > 0)).toBe(true)
    const line = compiledDeclarations(css, '.sentiment-class')
    expect(line).toMatchObject({ position: 'relative', display: 'grid', 'grid-column': '1 / -1', 'grid-template-columns': 'subgrid' })
    expect(compiledDeclarationValues(css, '.sentiment-class', 'grid-template-columns')).toContain(headlines['grid-template-columns'])
    expect(compiledDeclarations(css, '.sentiment-headlines-columns')).toMatchObject({ display: 'grid', 'grid-column': '1 / -1', 'grid-template-columns': 'subgrid' })
    for (const selector of ['.sentiment-headlines-columns', '.mention-share-row-head']) {
      expect(compiledDeclarations(css, selector)).toMatchObject({ 'text-transform': 'uppercase', 'font-size': '10px', 'letter-spacing': '0.08em', color: 'var(--color-text-muted)' })
      expect(resolvedCompiledProperty(css, selector, 'font-weight')).toBe('500')
    }
    for (const [name, column] of [['favorable', '3'], ['ratings', '4']] as const) {
      expect(compiledDeclarations(css, `.sentiment-headlines-${name}`)).toMatchObject({ 'grid-column': column, 'text-align': 'right' })
      expect(compiledDeclarations(css, `.sentiment-class-${name}`)).toMatchObject({ 'grid-column': column, 'grid-row': '1', 'text-align': 'right' })
    }
    for (const selector of ['.sentiment-class-favorable', '.sentiment-class-ratings']) expect(resolvedCompiledProperty(css, selector, 'font-variant-numeric')).toBe('tabular-nums')
    expect(compiledDeclarations(css, '.sentiment-class-empty')).toMatchObject({ color: 'var(--color-text-muted)' })
    expect(compiledDeclarations(css, '.sentiment-class-details-toggle')).toMatchObject({ 'grid-column': '5', 'grid-row': '1' })
    expect(compiledDeclarations(css, '.sentiment-class-label')).toMatchObject({ 'grid-column': '1' })
    expect(compiledDeclarations(css, '.sentiment-bar')).toMatchObject({ 'grid-column': '1 / -1', 'grid-row': '2' })
    const wide = '@container sentiment-headlines (min-width: 40rem)'
    expect(compiledDeclarations(css, '.sentiment-bar', wide)).toMatchObject({ 'grid-column': '2', 'grid-row': '1' })
    expect(compiledDeclarations(css, '.sentiment-class-note', wide)).toMatchObject({ 'grid-column': '2 / -1', 'grid-row': '2' })
    for (const selector of ['.sentiment-class-favorable', '.sentiment-class-ratings', '.sentiment-class-details-toggle', '.sentiment-headlines-columns']) {
      expect(compiledDeclarationValues(css, selector, 'grid-column', wide)).toEqual([])
    }
    expect(compiledDeclarations(css, '.query-evidence-toolbar')).toMatchObject({ 'justify-content': 'space-between' })
    expect(compiledDeclarations(css, '.query-evidence-actions')).toMatchObject({ 'margin-left': 'auto' })
    expect(compiledDeclarations(css, '.query-evidence-toolbar:empty')).toMatchObject({ display: 'none' })
  })

  it('gives the chevron a 44px hit area that fits the line pitch', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const button = compiledDeclarations(css, '.sentiment-class-details-toggle')
    const hit = compiledDeclarations(css, '.sentiment-class-details-toggle::before')
    expect(button.position).toBe('relative')
    expect(hit.position).toBe('absolute')
    expect(hit.content).toMatch(/^(['"])\1$/)
    const inset = cssLengthPx(hit.inset!, css)
    const width = cssLengthPx(button.width!, css) - 2 * inset
    const height = cssLengthPx(button.height!, css) - 2 * inset
    expect(width, 'compiled target width at the default 16px root').toBeGreaterThanOrEqual(44)
    expect(height, 'compiled target height at the default 16px root').toBeGreaterThanOrEqual(44)
    const pitch = cssLengthPx(button.height!, css) + cssLengthPx(compiledDeclarations(css, '.sentiment-headlines')['row-gap']!, css)
    expect(pitch, 'neighboring line targets do not overlap').toBeGreaterThanOrEqual(height)
  })

  it('floats the Details panel under its button, on screen and past the section clip', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const panel = compiledDeclarations(css, '.sentiment-class-details')
    expect(panel).toMatchObject({ position: 'absolute', top: '100%', 'z-index': '10', 'max-width': '100%', 'background-color': 'var(--color-bg-elevated)' })
    expect(cssLengthPx(panel.right!, css)).toBe(0)
    expect(cssLengthPx(panel.width!, css)).toBeGreaterThan(0)
    expect(panel).not.toHaveProperty('display')
    expect(compiledDeclarations(css, '.overview-disclosure:has(.sentiment-class-details:not([hidden]))')).toMatchObject({ overflow: 'visible' })
    expect(compiledDeclarations(css, '.sentiment-details-list > div')).toMatchObject({ 'justify-content': 'space-between' })
    expect(cssLengthPx(compiledDeclarations(css, '.sentiment-details-list > div')['min-height']!, css)).toBeGreaterThanOrEqual(28)
    expect(resolvedCompiledProperty(css, '.sentiment-details-list dd', 'font-variant-numeric')).toBe('tabular-nums')
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
  it('carries full Advanced selection and separates market and evaluator caches', async () => {
    const selection = sentimentSelectionFromVisibility({ measurementScope: 'property', measurementScopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', measurementRunId: 'run', revision: 3 }, 'advanced', 'definition-a')
    expect(selection).toEqual({ mode: 'advanced', scope: 'property', scopeKey: 'north', marketKey: 'chicago', queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', runId: 'run', revision: 3, evaluationDefinitionId: 'definition-a' })
    const reads: URL[] = []
    const pendingEvidence: (() => void)[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings())
      reads.push(request)
      const market = request.searchParams.get('marketKey') ?? 'chicago'
      const evaluator = request.searchParams.get('evaluationDefinitionId') ?? 'definition-a'
      const sourceSelection = { ...selection, marketKey: market, evaluationDefinitionId: evaluator, queryClass: request.searchParams.get('queryClass') === 'non-brand' ? 'non-brand' as const : 'branded' as const }
      if (request.pathname.endsWith('/evidence')) {
        const identity = request.searchParams.get('assessmentId')
        const text = market === 'madison' ? evaluator === 'definition-b' ? 'Madison evaluator B quotation.' : 'Madison evaluator A quotation.' : identity === 'two' ? 'Chicago second assessment quotation.' : 'Chicago first assessment quotation.'
        const receipt = { state: 'complete', selection: sourceSelection, items: [evidenceItem({ assessmentId: identity!, sourceText: text, conclusion: [{ id: 'literal', text, start: 0, end: text.length }], evaluationDefinitionId: evaluator })], nextCursor: null }
        return new Promise<Response>(resolve => { pendingEvidence.push(() => resolve(jsonResponse(receipt))) })
      }
      const dto = summaryWithAssessments([assessment({ assessmentId: 'one' }), assessment({ assessmentId: 'two', subjectId: 'south', subjectLabel: 'South Hall', outcome: 'mixed' })])
      return jsonResponse({ ...dto, selection: sourceSelection })
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (marketKey: string, evaluationDefinitionId: string) => <QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ ...selection, marketKey, evaluationDefinitionId }}><SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot-openai']} queryClass="branded" provider="openai" location="Chicago" /></SentimentScopeProvider></QueryClientProvider>
    try {
      const page = render(tree('chicago', 'definition-a'))
      const steps = [
        ['chicago', 'definition-a', 'View openai sentiment evidence for North Hall: Favorable', 'one', 'Chicago first assessment quotation.'],
        ['chicago', 'definition-a', 'View openai sentiment evidence for South Hall: Mixed', 'two', 'Chicago second assessment quotation.'],
        ['madison', 'definition-a', 'View openai sentiment evidence for North Hall: Favorable', 'one', 'Madison evaluator A quotation.'],
        ['madison', 'definition-b', 'View openai sentiment evidence for North Hall: Favorable', 'one', 'Madison evaluator B quotation.'],
      ] as const
      for (const [marketKey, evaluationDefinitionId, name, assessmentId, quotation] of steps) {
        page.rerender(tree(marketKey, evaluationDefinitionId))
        await waitFor(() => expect(client.isFetching()).toBe(0))
        fireEvent.click(await screen.findByRole('button', { name }))
        await waitFor(() => expect(pendingEvidence).toHaveLength(1))
        expect(screen.queryByText('Loading sentiment evidence…')).not.toBeNull()
        expect(screen.queryByText(/(?:Chicago|Madison).+quotation\./, { selector: 'blockquote' })).toBeNull()
        await act(async () => { pendingEvidence.shift()!() })
        expect(await screen.findByText(quotation, { selector: 'blockquote' })).toBeTruthy()
        const evidence = reads.filter(url => url.pathname.endsWith('/evidence'))
        expect(Object.fromEntries(evidence.at(-1)!.searchParams)).toEqual({ mode: 'advanced', scope: 'property', scopeKey: 'north', marketKey, queryClass: 'branded', model: 'source-model', provider: 'openai', location: 'Chicago', runId: 'run', revision: '3', evaluationDefinitionId, queryId: 'q', assessmentId, limit: '50' })
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      }
      expect(reads.filter(url => url.pathname.endsWith('/evidence'))).toHaveLength(4)
    } finally { for (const release of pendingEvidence) release(); cleanup(); client.clear(); restore() }
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
    const key = '11111111-1111-4111-8111-111111111111'
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(key).mockReturnValue('22222222-2222-4222-8222-222222222222')
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
      expect(admissions).toEqual([{ previewToken: 'frozen-preview', idempotencyKey: '11111111-1111-4111-8111-111111111111' }, { previewToken: 'frozen-preview', idempotencyKey: '11111111-1111-4111-8111-111111111111' }])
    } finally { cleanup(); client.clear(); restore(); uuid.mockRestore() }
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

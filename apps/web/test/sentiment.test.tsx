import { useState, type ComponentProps, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { aggregateSentiment, createSentimentEvaluationDefinition, emptySentimentCounts } from '@ainyc/canonry-contracts'
import type { SentimentEvidenceItem, SentimentOutcome, SentimentSettings, SentimentSummary, SentimentAssessmentSummary } from '@ainyc/canonry-contracts'
import { SentimentScopeProvider, SentimentControls, SentimentHeadlines, SentimentQueryScore, SentimentAnswerOutcome, SentimentOverviewMetric, useSentimentResolvedSource, SENTIMENT_COPY, SENTIMENT_MIN_RATED, sentimentRatedShare, showsSentimentOverview } from '../src/components/project/SentimentSection.js'
import { sentimentSelectionFromVisibility, sentimentSelectionForSimpleEvidence, sentimentQueryKey, sentimentSummaryRefetchInterval } from '../src/queries/sentiment.js'
import { EvidenceTable, QueryEvidenceSummary } from '../src/components/project/EvidenceTable.js'
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
/** Both class summaries have loaded: non-brand is read even where it draws no line of its own. */
function summariesLoaded(client: QueryClient) {
  const queries = client.getQueryCache().findAll({ queryKey: ['sentiment', 'project', 'summary'] })
  return queries.length === 2 && queries.every(query => query.state.status === 'success')
}
/** A class line's Details chevron, in the line's last column, and the dropdown panel it opens. */
function classDetails(row: Element) {
  const toggle = row.querySelector<HTMLButtonElement>(':scope > button.sentiment-class-details-toggle')
  const panel = toggle ? document.getElementById(toggle.getAttribute('aria-controls')!) : null
  return { toggle, panel }
}
/** The app's empty value for a metric with no figure. */
const EMPTY_VALUE = '\u2014'
/**
 * The plain outcome names the component shows in Details, engine rows and
 * evidence. The map is private to the component, so the shipped strings are
 * pinned here, once.
 */
const OUTCOME_COPY = {
  factual: 'Named, no opinion',
  'subject-not-mentioned': 'Not named in the answer',
  'ambiguous-subject': 'Unclear which one was meant',
  'unsupported-language': 'Not in English',
  pending: 'Waiting to be rated',
} as const
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
  it('renders only the branded API value in the all-queries view, with no theme controls', async () => {
    const page = renderScope(<><SentimentHeadlines /><SentimentControls /></>)
    try {
      expect((await screen.findByLabelText('Branded favorable share')).textContent).toBe('60.1%')
      // Sentiment is a branded figure: the non-brand favorable share (25% on the wire) is never drawn.
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
      expect(document.querySelectorAll('.sentiment-class')).toHaveLength(1)
      expect(document.querySelector('.sentiment-class')!.getAttribute('data-query-class')).toBe('branded')
      expect(document.body.textContent).not.toContain('25%')
      // The branded Details count answers with an opinion, 6 of 8, never assessments judged, 10 of 12.
      expect(screen.getAllByText('6 of 8')).toHaveLength(1)
      expect(screen.queryByText('10 of 12')).toBeNull()
      expect(screen.queryByText(/theme/i)).toBeNull()
      expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
      // Both class summaries are still read: non-brand feeds its unfavorable and mixed line.
      expect(page.requests.filter(url => url.pathname.endsWith('/sentiment')).map(url => url.searchParams.get('queryClass')).sort()).toEqual(['branded', 'non-brand'])
    } finally { page.close() }
  })
  it('keeps headlines concise and moves coverage and uncertainty into closed details', async () => {
    const page = renderScope(<SentimentHeadlines />)
    try {
      const branded = await screen.findByLabelText('Branded favorable share')
      expect(branded.textContent).toBe('60.1%')
      expect(figures(branded.parentElement!)).toEqual({ favorable: '60.1%', rated: '75.0%', note: null })
      expect(branded.parentElement!.textContent).not.toContain('interval')
      const { toggle, panel: details } = classDetails(branded.parentElement!) as { toggle: HTMLButtonElement; panel: HTMLElement }
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(details.hidden).toBe(true)
      expect(within(branded.parentElement!).getByRole('button', { name: 'Branded details' })).toBe(toggle)
      expect(within(details).getByText('6 of 8')).toBeTruthy()
      // Admitted answers alone ("Source answers") are no longer a row: answers with an opinion carry the answer count.
      expect(within(details).queryByText('Source answers')).toBeNull()
      expect(within(details).getByText(OUTCOME_COPY.factual)).toBeTruthy()
      expect(within(details).getByText(SENTIMENT_COPY.details.interval)).toBeTruthy()
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
        [SENTIMENT_COPY.details.ratedAnswers, '2 of 12'],
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
    const rated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'openai', sourceSnapshotId: 'openai', outcome: 'favorable' }], { eligibleAssessments: 2, eligibleAnswers: 2 }) }
    expect([before.coverage.selected, rated.coverage.judged, rated.coverage.selected]).toEqual([0, 1, 1])
    const lineFor = () => screen.getByLabelText('Branded favorable share').closest('.sentiment-class')!
    const rows = () => [...classDetails(lineFor()).panel!.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])
    // Sentiment draws one branded line, so each case is its own branded read.
    const first = renderScope(<SentimentHeadlines />, { branded: before })
    try {
      await screen.findByLabelText('Branded favorable share')
      // Nothing admitted yet, but two answers are eligible: a measured 0%, never "No answers yet".
      expectRated(lineFor(), 'Branded', '0%', '0 of 2 answers rated')
      expect(rows()).toEqual([[SENTIMENT_COPY.details.ratedAnswers, '0 of 2'], [SENTIMENT_COPY.details.unadmitted, '2']])
    } finally { first.close() }
    const second = renderScope(<SentimentHeadlines />, { branded: rated })
    try {
      await screen.findByLabelText('Branded favorable share')
      // One answer rated, one not admitted: 50.0%, never 100% of the one admitted.
      expectRated(lineFor(), 'Branded', '50.0%', '1 of 2 answers rated')
      expect(rows()).toEqual(expect.arrayContaining([[SENTIMENT_COPY.details.ratedAnswers, '1 of 2'], [SENTIMENT_COPY.details.unadmitted, '1']]))
      expect(lineFor().querySelector('.sentiment-class-ratings')!.textContent).not.toContain('100%')
    } finally { second.close() }
  })
  it('does not claim opinions are absent when completed assessments could not be rated', async () => {
    const dto = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]) }
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const headline = await screen.findByLabelText('Branded favorable share')
      expect(figures(headline.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: 'No ratings available.' })
      expect(within(classDetails(headline.parentElement!).panel!).getByText(OUTCOME_COPY['unsupported-language'])).toBeTruthy()
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
      expect(within(details).getByText(SENTIMENT_COPY.details.unadmitted)).toBeTruthy()
      expect(SENTIMENT_COPY.details.unadmitted).toBe('Checks not yet analyzed')
      expect(within(details).getByText('3')).toBeTruthy()
      // No pending work: no "waiting to be rated" row.
      expect(within(details).queryByText(OUTCOME_COPY.pending)).toBeNull()
      // The checks the favorable share leaves out sit under their own caption, after the figures.
      const caption = details.querySelector<HTMLElement>(':scope > .sentiment-details-caption')!
      expect(caption.tagName).toBe('P')
      expect(caption.textContent).toBe(SENTIMENT_COPY.details.checksCaption)
      expect(SENTIMENT_COPY.details.checksCaption).toBe('Not counted in the favorable share:')
      const [figuresList, checksList] = [...details.querySelectorAll<HTMLElement>(':scope > dl')]
      expect(caption.previousElementSibling).toBe(figuresList)
      expect(caption.nextElementSibling).toBe(checksList)
      const terms = (list: HTMLElement) => [...list.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent!.trim(), item.querySelector('dd')!.textContent])
      expect(terms(figuresList!)).toEqual([[SENTIMENT_COPY.details.ratedAnswers, '6 of 8'], [SENTIMENT_COPY.details.interval, '23.0% to 88.0%']])
      expect(terms(checksList!)).toEqual([[SENTIMENT_COPY.details.unadmitted, '3'], [OUTCOME_COPY.factual, '2']])
    } finally { page.close() }
  })
  it('adds no checks caption when nothing was left out of the favorable share', async () => {
    const dto = measured('branded', { favorable: 7, mixed: 2, unfavorable: 1 })
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { branded: dto })
    try {
      const details = classDetails((await screen.findByLabelText('Branded favorable share')).parentElement!).panel!
      expect(details.querySelector('.sentiment-details-caption')).toBeNull()
      expect(details.textContent).not.toContain(SENTIMENT_COPY.details.checksCaption)
      // The second list is there but empty: no no-opinion rows to introduce.
      expect([...details.querySelectorAll(':scope > dl')].map(list => list.children.length)).toEqual([2, 0])
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
  it('renders the branded API score with its evidence only in the tooltip, never the overall or non-brand score', () => {
    const dto = summary(); dto.provisional = true; dto.state = 'partial'
    // Three different scores, so the figure can only have come from branded.
    const overall = { queryClass: 'all' as const, state: dto.state, reason: dto.reason, provisional: dto.provisional, coverage: { ...dto.coverage, judged: 30, selected: 40 }, score: { ...dto.score, favorableDisplay: '64.0%', favorableRate: 0.64 }, runIds: ['run'] }
    const value = { configured: true, overall, branded: { ...dto, runIds: ['run'], score: { ...dto.score, favorableDisplay: '71.2%', favorableRate: 0.712 } }, nonBrand: { ...dto, runIds: ['run'], score: { ...dto.score, favorableDisplay: '25.0%' } } }
    const { container } = render(<SentimentOverviewMetric value={value} />)
    expect(screen.getByText('Sentiment', { exact: true })).toBeTruthy()
    expect(container.querySelectorAll('.metric-inline-value')).toHaveLength(1)
    expect(container.querySelector('.metric-inline-value')!.textContent).toBe('71.2% favorable judgments, branded queries')
    expect(visibleText(container.querySelector('.metric-inline-value')!)).toBe('71.2%')
    expect(container.textContent).not.toContain('64.0%')
    expect(container.textContent).not.toContain('25.0%')
    expect(container.textContent).not.toContain('all query classes')
    expect(screen.queryByLabelText('Branded favorable share')).toBeNull()
    expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
    expect(screen.queryByText(/10 judged/)).toBeNull()
    expect(screen.queryByText('Unavailable')).toBeNull()
    const info = screen.getByRole('button', { name: name => name.startsWith(SENTIMENT_COPY.overall) })
    // The branded counts, 10 of 12 judged, never the overall 30 of 40.
    expect(info.getAttribute('aria-label')).toBe(`${SENTIMENT_COPY.overall} 10 of 12 judged, 95% interval 23.0% to 88.0%. Provisional. ${SENTIMENT_COPY.states.partial}`)
    expect(info.getAttribute('aria-label')).not.toContain('30 of 40')
    fireEvent.pointerDown(info)
    fireEvent.focus(info)
    fireEvent.click(info, { detail: 1 })
    expect(info.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(info, { key: 'Escape' })
    expect(info.getAttribute('aria-expanded')).toBe('false')
  })
  it('shows measured zero branded sentiment as a number', () => {
    const dto = summary()
    const overall = { queryClass: 'all' as const, ...dto, runIds: ['run'] }
    const { container } = render(<SentimentOverviewMetric value={{ configured: true, overall, branded: { ...dto, runIds: ['run'], score: { ...dto.score, favorableRate: 0, favorableDisplay: '0.0%' } }, nonBrand: { ...dto, runIds: ['run'] } }} />)
    expect(container.querySelector('.metric-inline-value')!.textContent).toBe('0.0% favorable judgments, branded queries')
  })
  it('reads the branded score whether or not the server sends an overall one', () => {
    const dto = summary()
    const value = { configured: true, branded: { ...dto, runIds: ['run'] }, nonBrand: { ...dto, runIds: ['run'], score: { ...dto.score, favorableDisplay: '25.0%' } } }
    expect(showsSentimentOverview(value)).toBe(true)
    const { container } = render(<SentimentOverviewMetric value={value} />)
    expect(container.querySelector('.metric-inline-value')!.textContent).toBe('60.1% favorable judgments, branded queries')
  })
  it.each(['unjudged', 'disabled', 'unavailable'] as const)('hides %s branded sentiment without reserving a metric slot, even beside judged overall and non-brand scores', state => {
    const dto = summary()
    const branded = { ...dto, ...(state === 'unjudged' ? aggregateSentiment([]) : {}), reason: null, runIds: ['run'] }
    if (state === 'unavailable') branded.score = aggregateSentiment([]).score
    // Overall and non-brand both carry a judged favorable share; neither stands in for branded.
    const value = { configured: state !== 'disabled', overall: { queryClass: 'all' as const, ...dto, runIds: ['run'] }, branded, nonBrand: { ...dto, runIds: ['run'] } }
    expect([value.overall.score.favorableDisplay, value.nonBrand.coverage.judged]).toEqual(['60.1%', 10])
    const { container } = render(<SentimentOverviewMetric value={value} />)
    expect(container.innerHTML).toBe('')
  })
  it('reads "too few" below ten branded ratings, whatever the overall count', () => {
    const dto = summary()
    const branded = { ...dto, ...aggregateSentiment([{ assessmentId: 'a', sourceSnapshotId: 'a', outcome: 'favorable' }, { assessmentId: 'b', sourceSnapshotId: 'b', outcome: 'mixed' }]), reason: null, runIds: ['run'] }
    const { container } = render(<SentimentOverviewMetric value={{ configured: true, overall: { queryClass: 'all' as const, ...dto, runIds: ['run'] }, branded, nonBrand: { ...dto, runIds: ['run'] } }} />)
    expect(container.querySelector('.metric-inline-value')!.textContent).toBe(`${SENTIMENT_COPY.tooFew} ratings for a favorable share, 2 of ${SENTIMENT_MIN_RATED} needed, branded queries`)
    expect(container.textContent).not.toContain('%')
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
      await screen.findByRole('columnheader', { name: 'Sentiment' })
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
      await screen.findByRole('columnheader', { name: 'Sentiment' })
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
    ['factual', 'complete', OUTCOME_COPY.factual], ['subject-not-mentioned', 'complete', 'Not mentioned'],
    ['mixed', 'complete', 'Mixed'], ['pending', 'processing', OUTCOME_COPY.pending], ['running', 'processing', 'Classifying'],
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
      // Non-brand draws no line of its own, but its summary is still read (for its unfavorable and mixed answers).
      await waitFor(() => expect(reads.filter(url => url.pathname.endsWith('/sentiment'))).toHaveLength(2))
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

  it('reads the branded class as one bar line: label, bar, Favorable, With opinion, then the Details chevron', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const value = await screen.findByLabelText('Branded favorable share')
      const row = value.closest('.sentiment-class')!
      // The share alone in Favorable, the share with an opinion alone beside it (16 of 20): no sentence.
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
      expect(within(children[0] as HTMLElement).getByRole('button', { name: SENTIMENT_COPY.favorable })).toBeTruthy()
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
      expect(within(panel).getByText(OUTCOME_COPY.factual)).toBeTruthy()
      expect(within(panel).getByText(/to/, { selector: 'dd' })).toBeTruthy()
      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(panel.hidden).toBe(false)
      expect(within(panel).getByRole('button', { name: branded().score.limitation })).toBeTruthy()
      fireEvent.click(toggle)
      expect(panel.hidden).toBe(true)
      // Branded is the one line: one ⓘ and one Details, and no non-brand figure beside it.
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      const group = screen.getByRole('group', { name: 'Favorable answer scores' })
      expect(group.querySelectorAll('.sentiment-class')).toHaveLength(1)
      expect(within(group).getAllByRole('button', { name: SENTIMENT_COPY.favorable })).toHaveLength(1)
      const chevrons = within(group).getAllByRole('button', { name: /details$/ })
      expect(chevrons.map(button => button.getAttribute('aria-label'))).toEqual(['Branded details'])
      expect(screen.queryByLabelText('Non-brand favorable share')).toBeNull()
    } finally { page.close() }
  })

  it('shows the server share of answers with an opinion, with its counts in its tooltip, its screen-reader text and Details', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      const line = (await screen.findByLabelText('Branded favorable share')).closest('.sentiment-class')!
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      // Branded 16 of 20 answers rated; non-brand's 1 of 32 has no line to show it.
      expect([branded(), nonBrand()].map(value => [value.coverage.ratedAnswers, value.coverage.eligibleAnswers, value.coverage.ratedAnswerRate])).toEqual([[16, 20, 0.8], [1, 32, 0.03125]])
      expectRated(line, 'Branded', '80.0%', '16 of 20 answers rated')
      expect(screen.getByRole('group', { name: 'Branded share rated' })).toBe(line.querySelector('.sentiment-class-ratings'))
      expect(screen.queryByRole('group', { name: 'Non-brand share rated' })).toBeNull()
      expect(document.body.textContent).not.toContain('3.1%')
      // The raw count is not removed: Details still lists it beside the share.
      const panel = classDetails(line).panel!
      expect([...panel.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])).toContainEqual([SENTIMENT_COPY.details.ratedAnswers, '16 of 20'])
      // The Favorable column is untouched: the share from ten ratings.
      expect(figures(line).favorable).toBe('56.3%')
    } finally { page.close() }
  })

  it('names the figure columns Favorable and With opinion, with what the second counts in its tooltip, and adds no tab stop', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const header = document.querySelector<HTMLElement>('.sentiment-headlines-columns')!
      expect(header.getAttribute('aria-hidden')).toBe('true')
      expect([...header.children].map(child => [child.className, child.textContent, (child as HTMLElement).title])).toEqual([
        ['sentiment-headlines-favorable', 'Favorable', ''],
        ['sentiment-headlines-ratings', 'With opinion', 'Share of answers that give an opinion (favorable, mixed or unfavorable) about who they name'],
      ])
      expect(SENTIMENT_COPY.columns).toEqual({ favorable: 'Favorable', rated: 'With opinion' })
      expect(SENTIMENT_COPY.rated).toBe('Share of answers that give an opinion (favorable, mixed or unfavorable) about who they name')
      expect(header.querySelector('button, a, [tabindex]')).toBeNull()
    } finally { page.close() }
  })

  it('draws a branded class below ten ratings as a plain track beside an empty Favorable column and its share with an opinion, with no favorable share anywhere', async () => {
    // One favorable rating among 32 answers: 100% on the wire, too few ratings to show it.
    const few = measured('branded', { favorable: 1, 'subject-not-mentioned': 30, 'ambiguous-subject': 1 })
    const page = renderScope(<SentimentHeadlines />, { branded: few, nonBrand: nonBrand() })
    try {
      const value = await screen.findByLabelText('Branded favorable share')
      expect(few.score.favorableDisplay).toBe('100%')
      expect(figures(value.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '3.1%', note: null })
      expectEmptyFavorable(value)
      // 1 of 32 rounds half up on the tenth: 3.125% reads 3.1%.
      expectRated(value.parentElement!, 'Branded', '3.1%', '1 of 32 answers rated')
      const bar = barFor('Branded')
      expect(bar.getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(bar.classList.contains('sentiment-bar-track')).toBe(true)
      // No proportional segments: one favorable rating would fill the bar and
      // show the 100% share the empty Favorable column hides.
      expect(bar.querySelectorAll('[data-outcome]')).toHaveLength(0)
      expect(bar.children).toHaveLength(0)
      // The counts stay in the bar's label and in Details.
      expect(bar.getAttribute('role')).toBe('img')
      expect(bar.getAttribute('aria-label')).toBe('Branded: 1 favorable, 0 mixed, 0 unfavorable, 1 rating, favorable share shown from 10 ratings')
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
      // No bar draws segments, so no legend names their colors.
      expect(document.querySelector('.sentiment-legend')).toBeNull()
    } finally { page.close() }
  })

  it('draws no segments and no legend while branded is below ten ratings, even when non-brand has enough', async () => {
    // Branded 1 favorable and 2 mixed, 3 ratings of 12 answers; non-brand 12
    // favorable ratings, enough to draw a bar had it a line.
    const page = renderScope(<SentimentHeadlines />, { branded: measured('branded', { favorable: 1, mixed: 2, factual: 7, 'subject-not-mentioned': 1, 'wrong-subject': 1 }), nonBrand: measured('non-brand', { favorable: 12, factual: 3, 'subject-not-mentioned': 29 }) })
    try {
      const value = await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      expect(figures(value.parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '25.0%', note: null })
      expectEmptyFavorable(value)
      expectRated(value.parentElement!, 'Branded', '25.0%', '3 of 12 answers rated')
      expect(barFor('Branded').getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(document.querySelectorAll('[data-outcome]')).toHaveLength(0)
      expect(document.querySelector('.sentiment-legend')).toBeNull()
      expect(document.querySelector('[data-query-class="non-brand"]')).toBeNull()
      expect(barFor('Branded').getAttribute('aria-label')).toBe('Branded: 1 favorable, 2 mixed, 0 unfavorable, 3 ratings, favorable share shown from 10 ratings')
      const rows = [...classDetails(barFor('Branded').closest('.sentiment-class')!).panel!.querySelectorAll('dl > div')].map(item => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent])
      expect(rows).toEqual(expect.arrayContaining([['Favorable', '1'], ['Mixed', '2']]))
    } finally { page.close() }
  })

  it('draws an empty bar beside the existing wording when branded has no ratings, and no legend', async () => {
    const unmeasured = { ...summary(), ...aggregateSentiment([]) }
    const unrated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]) }
    const expectEmptyBar = () => {
      const bar = barFor('Branded')
      expect(bar.getAttribute('data-sentiment-bar')).toBe('empty')
      expect(bar.getAttribute('aria-hidden')).toBe('true')
      expect(bar.getAttribute('role')).toBeNull()
      expect(bar.children).toHaveLength(0)
      expect(screen.queryByRole('img')).toBeNull()
      expect(document.querySelector('.sentiment-legend')).toBeNull()
      return bar.closest('.sentiment-class')!
    }
    const first = renderScope(<SentimentHeadlines />, { branded: unmeasured, nonBrand: nonBrand() })
    try {
      expect(figures((await screen.findByLabelText('Branded favorable share')).parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: EMPTY_VALUE, note: SENTIMENT_COPY.states['not-measured'] })
      // Nothing to disclose: no chevron; its column stays, so the bar still ends level.
      expect(classDetails(expectEmptyBar()).toggle).toBeNull()
    } finally { first.close() }
    const second = renderScope(<SentimentHeadlines />, { branded: unrated, nonBrand: nonBrand() })
    try {
      expect(figures((await screen.findByLabelText('Branded favorable share')).parentElement!)).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: SENTIMENT_COPY.noJudgments })
      expect(classDetails(expectEmptyBar()).toggle).not.toBeNull()
    } finally { second.close() }
  })

  it('names the segment colors in a legend under the Sentiment title once the bar has segments, and adds no tab stop', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const group = screen.getByRole('group', { name: 'Favorable answer scores' })
      // The title and its subtitle, the legend under them, the column header, then the one branded line.
      expect([...group.children].map(child => child.getAttribute('data-query-class') ?? child.className)).toEqual(['sentiment-headlines-title', 'sentiment-legend', 'sentiment-headlines-columns', 'branded'])
      const title = group.querySelector<HTMLElement>('.sentiment-headlines-title')!
      expect(within(title).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
      expect(title.querySelector('.sentiment-headlines-subtitle')!.textContent).toBe(SENTIMENT_COPY.subtitle)
      expect([SENTIMENT_COPY.title, SENTIMENT_COPY.subtitle]).toEqual(['Sentiment', 'How AI answers describe you in queries that name you'])
      // Without `manage` the title row has no control.
      expect(title.querySelector('button')).toBeNull()
      const legend = document.querySelector<HTMLElement>('.sentiment-legend')!
      expect(title.nextElementSibling).toBe(legend)
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
      expect(focusable).toEqual([SENTIMENT_COPY.favorable, 'Branded details'])
    } finally { page.close() }
  })

  it('puts the section actions above the Sentiment block and Manage sentiment in its title row, and opens the action panel under the bars', async () => {
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    // The page passes only its own actions; the Sentiment block brings Manage sentiment.
    const actions = <button type="button">Manage queries</button>
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', queryId: 'q', sourceSnapshotId: 'snapshot', query: 'Is North Hall good?', queryClass: 'branded' }]} actions={actions} actionPanel={<div data-testid="query-editor" />} />, { branded: branded(), nonBrand: nonBrand(), configure: true })
    try {
      const scores = await screen.findByRole('group', { name: 'Favorable answer scores' })
      await screen.findByLabelText('Branded favorable share')
      const section = scores.parentElement!
      expect(section.className).toBe('query-evidence')
      // The actions row, then the Sentiment block at the section's full width
      // (nothing sits beside it), then the query editor.
      expect([...section.children].slice(0, 4).map(child => child.className || child.getAttribute('data-testid'))).toEqual(['query-evidence-toolbar', 'sentiment-headlines', 'query-editor', 'query-evidence-view-row'])
      const toolbar = section.children[0] as HTMLElement
      // The actions row holds the section's own actions: no legend, no Manage sentiment.
      expect([...toolbar.children].map(child => child.className)).toEqual(['query-evidence-actions'])
      expect(within(toolbar).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage queries'])
      // Manage sentiment sits in the block's title row, beside its heading, once.
      const title = scores.querySelector<HTMLElement>('.sentiment-headlines-title')!
      expect(within(title).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
      expect(within(title).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage sentiment'])
      expect(screen.getAllByRole('button', { name: 'Manage sentiment' })).toHaveLength(1)
      // The title row, the legend under it, the column header, then one line.
      expect([...scores.children].map(child => child.getAttribute('data-query-class') ?? child.className)).toEqual(['sentiment-headlines-title', 'sentiment-legend', 'sentiment-headlines-columns', 'branded'])
      expect(document.querySelectorAll('.sentiment-legend')).toHaveLength(1)
      fireEvent.click(within(title).getByRole('button', { name: 'Manage sentiment' }))
      expect(await screen.findByRole('dialog', { name: 'Manage sentiment' })).toBeTruthy()
    } finally { page.close() }
  })

  it('renders no actions row and no Manage sentiment when the section has no actions (an embed), keeping the legend under the title', async () => {
    const seed = createDashboardFixture({}).dashboard.projects[0]!.visibilityEvidence[0]!
    // An administrator's settings, so only the missing actions keep Manage sentiment out.
    const page = renderScope(<EvidenceTable evidence={[{ ...seed, id: 'north', query: 'Is North Hall good?', queryClass: 'branded' }]} />, { branded: branded(), nonBrand: nonBrand(), configure: true })
    try {
      const scores = await screen.findByRole('group', { name: 'Favorable answer scores' })
      await screen.findByLabelText('Branded favorable share')
      const section = scores.parentElement!
      expect([...section.children].slice(0, 2).map(child => child.className)).toEqual(['sentiment-headlines', 'query-evidence-view-row'])
      expect(section.querySelector('.query-evidence-toolbar')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
      expect(scores.querySelector('.sentiment-headlines-title button')).toBeNull()
      expect([...scores.children].map(child => child.getAttribute('data-query-class') ?? child.className)).toEqual(['sentiment-headlines-title', 'sentiment-legend', 'sentiment-headlines-columns', 'branded'])
    } finally { page.close() }
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

  it('is a chevron button named "Branded details" with a non-modal panel named by its class, not a menu', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      const { toggle, panel } = dropdownFor('Branded')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.getAttribute('aria-controls')).toBe(panel.id)
      expect(toggle.hasAttribute('aria-haspopup')).toBe(false)
      expect(toggle.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
      expect(toggle.textContent).toBe('')
      expect(within(lineFor('Branded') as HTMLElement).getByRole('button', { name: 'Branded details' })).toBe(toggle)
      // Last in the line before its panel, after both figure columns.
      expect(toggle.previousElementSibling!.className).toBe('sentiment-class-ratings')
      expect(panel.getAttribute('role')).toBe('group')
      expect(document.getElementById(panel.getAttribute('aria-labelledby')!)!.textContent).toBe('Branded')
      expect(panel.querySelector('.sentiment-class-details-title')!.textContent).toBe('Branded')
      // The panel follows its button in the DOM, so it is next in tab order once open.
      expect(toggle.nextElementSibling).toBe(panel)
      // Non-brand has no line, so no Details of its own.
      expect(screen.queryByRole('button', { name: 'Non-brand details' })).toBeNull()
      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.queryByRole('menuitem')).toBeNull()
      fireEvent.click(toggle)
      expect(screen.getByRole('group', { name: 'Branded' })).toBe(panel)
    } finally { page.close() }
  })

  it('opens on click and closes on a second click, an outside click, Escape and focus leaving', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const dropdown = dropdownFor('Branded')
      const state = () => [dropdown.toggle.getAttribute('aria-expanded'), dropdown.panel.hidden]
      expect(state()).toEqual(['false', true])
      fireEvent.click(dropdown.toggle)
      expect(state()).toEqual(['true', false])
      fireEvent.click(dropdown.toggle)
      expect(state()).toEqual(['false', true])
      // A click inside the open panel keeps it open; one outside closes it.
      fireEvent.click(dropdown.toggle)
      fireEvent.pointerDown(dropdown.panel.querySelector('dd')!)
      expect(state()).toEqual(['true', false])
      fireEvent.pointerDown(document.body)
      expect(state()).toEqual(['false', true])
      // Escape closes it and returns focus to its button.
      fireEvent.click(dropdown.toggle)
      dropdown.panel.querySelector<HTMLButtonElement>('.info-tooltip-trigger')!.focus()
      fireEvent.focusIn(dropdown.panel.querySelector('.info-tooltip-trigger')!)
      expect(state()).toEqual(['true', false])
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(state()).toEqual(['false', true])
      expect(document.activeElement).toBe(dropdown.toggle)
      // Other keys leave it open.
      fireEvent.click(dropdown.toggle)
      fireEvent.keyDown(document, { key: 'ArrowDown' })
      expect(state()).toEqual(['true', false])
      // Focus moving to a control outside the panel (the line's own ⓘ) closes it.
      fireEvent.focusIn(within(lineFor('Branded').querySelector<HTMLElement>('.sentiment-class-label')!).getByRole('button', { name: SENTIMENT_COPY.favorable }))
      expect(state()).toEqual(['false', true])
    } finally { page.close() }
  })

  it('lists every Details row in the panel: the figures with the 95% range and its ⓘ, then the checks left out under their caption', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: branded(), nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const panel = dropdownFor('Branded').panel
      // The figures, the caption, then the no-opinion checks the share leaves out.
      expect([...panel.children].map(child => child.className)).toEqual(['sentiment-class-details-title', 'sentiment-details-list', 'sentiment-details-caption', 'sentiment-details-list'])
      expect(rows(panel)).toEqual([
        [SENTIMENT_COPY.details.ratedAnswers, '16 of 20'],
        [SENTIMENT_COPY.details.interval, '33.2% to 76.9%'],
        [OUTCOME_COPY.factual, '4'],
      ])
      expect(SENTIMENT_COPY.details.interval).toBe('Likely range (95%)')
      const range = [...panel.querySelector('dl')!.children].at(-1)! as HTMLElement
      expect(within(range).getByRole('button', { name: branded().score.limitation, hidden: true })).toBeTruthy()
    } finally { page.close() }
    // Too few: the rated outcomes and the share's threshold join the figures.
    const few = measured('branded', { favorable: 1, 'subject-not-mentioned': 30, 'ambiguous-subject': 1 })
    const second = renderScope(<SentimentHeadlines />, { branded: few, nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      const panel = dropdownFor('Branded').panel
      expect(rows(panel)).toEqual([
        [SENTIMENT_COPY.details.ratedAnswers, '1 of 32'],
        ['Favorable', '1'],
        ['Favorable share', `Shown from ${SENTIMENT_MIN_RATED} ratings`],
        [SENTIMENT_COPY.details.interval, '20.7% to 100%'],
        [OUTCOME_COPY['subject-not-mentioned'], '30'],
        [OUTCOME_COPY['ambiguous-subject'], '1'],
      ])
      for (const list of panel.querySelectorAll('dl')) expect(list.className).toBe('sentiment-details-list')
      const range = [...panel.querySelector('dl')!.children].at(-1)! as HTMLElement
      expect(within(range).getByRole('button', { name: few.score.limitation, hidden: true })).toBeTruthy()
      // The line below ten ratings keeps its grey track, the empty Favorable value and its share with an opinion.
      expect(barFor('Branded').getAttribute('data-sentiment-bar')).toBe('too-few')
      expect(figures(lineFor('Branded'))).toEqual({ favorable: EMPTY_VALUE, rated: '3.1%', note: null })
    } finally { second.close() }
  })

  it('keeps a reason under the rows and shows no Details for a class with nothing to disclose', async () => {
    const unmeasured = { ...summary(), ...aggregateSentiment([]) }
    const unrated = { ...summary(), ...aggregateSentiment([{ assessmentId: 'foreign', sourceSnapshotId: 'foreign', outcome: 'unsupported-language' }]), reason: 'Answers were in an unsupported language.' }
    const first = renderScope(<SentimentHeadlines />, { branded: unmeasured, nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      // Zero ratings, nothing measured: the empty bar and the state, no Details.
      expect(figures(lineFor('Branded'))).toEqual({ favorable: EMPTY_VALUE, rated: EMPTY_VALUE, note: 'No ratings yet.' })
      expect(classDetails(lineFor('Branded')).toggle).toBeNull()
      expect(lineFor('Branded').querySelector('.sentiment-class-details')).toBeNull()
      expect(barFor('Branded').getAttribute('data-sentiment-bar')).toBe('empty')
    } finally { first.close() }
    const second = renderScope(<SentimentHeadlines />, { branded: unrated, nonBrand: nonBrand() })
    try {
      await screen.findByLabelText('Branded favorable share')
      // Zero ratings with assessments: 0 of 1 answer rated, and its Details still opens with what was found.
      expect(figures(lineFor('Branded'))).toEqual({ favorable: EMPTY_VALUE, rated: '0%', note: SENTIMENT_COPY.noJudgments })
      expectRated(lineFor('Branded'), 'Branded', '0%', '0 of 1 answer rated')
      const { toggle, panel } = dropdownFor('Branded')
      fireEvent.click(toggle)
      expect(panel.hidden).toBe(false)
      expect(rows(panel)).toEqual([[SENTIMENT_COPY.details.ratedAnswers, '0 of 1'], [OUTCOME_COPY['unsupported-language'], '1']])
      expect(SENTIMENT_COPY.details.ratedAnswers).toBe('Answers with an opinion')
      expect(panel.lastElementChild!.textContent).toBe('Answers were in an unsupported language.')
      expect(panel.lastElementChild!.className).toBe('sentiment-class-details-reason')
    } finally { second.close() }
  })
})

describe('most criticized properties', () => {
  /** A Property breakdown row with its own rated counts, built the way the server builds one. */
  function propertyRow(key: string, label: string, counts: { favorable: number; mixed: number; unfavorable: number }) {
    const items = Object.entries(counts).flatMap(([outcome, count]) => Array.from({ length: count }, (_, index) => ({ assessmentId: `${key}-${outcome}-${index}`, sourceSnapshotId: `${key}-${outcome}-${index}`, outcome: outcome as 'favorable' | 'mixed' | 'unfavorable' })))
    return { ...aggregateSentiment(items), reason: null, dimension: 'property' as const, key, label, queryClass: 'branded' as const }
  }
  /**
   * Four Properties and an engine row. The server ranks C, A, B; a client-side
   * sort by criticism (A 4, B 3, C 1) or by label would read A, B, C, so the
   * list proves nothing here re-ranks the server's order. D has no criticism and
   * is never listed. The engine row shares a key with nothing listed and is ignored.
   */
  function withProperties(criticized: SentimentSummary['criticizedProperties'], selection: Partial<SentimentSummary['selection']> = {}): SentimentSummary {
    const dto = measured('branded', { favorable: 9, mixed: 7, factual: 4 })
    dto.selection = { ...dto.selection, ...selection }
    dto.breakdowns = [
      propertyRow('prop-a', 'Property A', { favorable: 1, mixed: 1, unfavorable: 3 }),
      propertyRow('prop-b', 'Property B', { favorable: 2, mixed: 3, unfavorable: 0 }),
      propertyRow('prop-c', 'Property C', { favorable: 4, mixed: 0, unfavorable: 1 }),
      propertyRow('prop-d', 'Property D', { favorable: 5, mixed: 0, unfavorable: 0 }),
      { ...propertyRow('openai', 'OpenAI', { favorable: 0, mixed: 9, unfavorable: 9 }), dimension: 'provider' as const },
    ]
    if (criticized) dto.criticizedProperties = criticized
    return dto
  }
  async function openBrandedDetails() {
    const line = (await screen.findByLabelText('Branded favorable share')).closest('.sentiment-class')!
    const { toggle, panel } = classDetails(line) as { toggle: HTMLButtonElement; panel: HTMLElement }
    fireEvent.click(toggle)
    expect(panel.hidden).toBe(false)
    return panel
  }
  /** The last evidence read's parameters, `outcome` as its repeated values. */
  const evidenceParams = (page: ReturnType<typeof renderScope>): Record<string, string | string[]> => {
    const request = page.requests.filter(url => url.pathname.endsWith('/evidence')).at(-1)!
    return { ...Object.fromEntries(request.searchParams), outcome: request.searchParams.getAll('outcome') }
  }

  it('lists the server\'s criticized Properties in its order, each with its counts and a bar of them, and "N of total" when more exist', async () => {
    expect(SENTIMENT_COPY.properties).toEqual({ title: 'Most criticized locations', evidence: 'unfavorable and mixed', viewAll: 'View all unfavorable and mixed answers', allEvidence: 'Branded queries, unfavorable and mixed' })
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties({ total: 7, keys: ['prop-c', 'prop-a', 'prop-b'] }) })
    try {
      const panel = await openBrandedDetails()
      // A group named by its subtitle: the title and how many of the criticized Properties it shows.
      const group = panel.querySelector<HTMLElement>('.sentiment-details-properties')!
      expect(group.getAttribute('role')).toBe('group')
      const subtitle = group.querySelector<HTMLElement>('.sentiment-details-subtitle')!
      expect(group.getAttribute('aria-labelledby')).toBe(subtitle.id)
      expect(subtitle.textContent).toBe(`${SENTIMENT_COPY.properties.title} · 3 of 7`)
      expect(subtitle.querySelector('.sentiment-details-subtitle-count')!.textContent).toBe(' · 3 of 7')
      const items = [...group.querySelectorAll('li')]
      // The server's order, C, A, B: never re-ranked by counts or label.
      expect(items.map(item => item.querySelector('button')!.textContent)).toEqual(['Property C', 'Property A', 'Property B'])
      expect(items.map(item => item.querySelector('button')!.getAttribute('aria-label'))).toEqual(['Property C', 'Property A', 'Property B'].map(label => `View unfavorable and mixed answers for ${label}`))
      // Each Property's own favorable count of its own ratings.
      expect(items.map(item => item.querySelector('.sentiment-property-count')!.textContent)).toEqual(['4 of 5 favorable', '1 of 5 favorable', '2 of 5 favorable'])
      // Its bar is its counts: one segment per rated outcome, grown by its count.
      const bars = items.map(item => item.querySelector<HTMLElement>('[role="img"]')!)
      expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
        'Property C: 4 favorable, 0 mixed, 1 unfavorable, 5 ratings',
        'Property A: 1 favorable, 1 mixed, 3 unfavorable, 5 ratings',
        'Property B: 2 favorable, 3 mixed, 0 unfavorable, 5 ratings',
      ])
      expect(bars.map(segments)).toEqual([
        [['favorable', 4, ''], ['unfavorable', 1, '']],
        [['favorable', 1, ''], ['mixed', 1, ''], ['unfavorable', 3, '']],
        [['favorable', 2, ''], ['mixed', 3, '']],
      ])
      expect(group.textContent).not.toContain('Property D')
      expect(group.textContent).not.toContain('OpenAI')
      expect(within(group).getByRole('button', { name: SENTIMENT_COPY.properties.viewAll })).toBeTruthy()
    } finally { page.close() }
  })

  it('names no count when every criticized Property is shown', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties({ total: 2, keys: ['prop-b', 'prop-c'] }) })
    try {
      const panel = await openBrandedDetails()
      const group = within(panel).getByRole('group', { name: SENTIMENT_COPY.properties.title })
      expect(group.querySelector('.sentiment-details-subtitle')!.textContent).toBe(SENTIMENT_COPY.properties.title)
      expect(group.querySelector('.sentiment-details-subtitle-count')).toBeNull()
      expect([...group.querySelectorAll('li button')].map(button => button.textContent)).toEqual(['Property B', 'Property C'])
    } finally { page.close() }
  })

  it.each<[string, SentimentSummary['criticizedProperties']]>([
    ['an older server that sends no ranking', undefined],
    ['a ranking with no criticized Property', { total: 0, keys: [] }],
  ])('lists nothing for %s', async (_label, criticized) => {
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties(criticized) })
    try {
      const panel = await openBrandedDetails()
      expect(panel.querySelector('.sentiment-details-properties')).toBeNull()
      expect(panel.textContent).not.toContain(SENTIMENT_COPY.properties.title)
      expect(within(panel).queryByRole('button', { name: SENTIMENT_COPY.properties.viewAll })).toBeNull()
    } finally { page.close() }
  })

  it('opens a Property\'s unfavorable and mixed answers scoped to that Property, keeping the view\'s market', async () => {
    // A group view inside one market: the Property narrows the scope and the market stays.
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties({ total: 3, keys: ['prop-c', 'prop-a', 'prop-b'] }, { scope: 'group', scopeKey: 'north-group', marketKey: 'chicago' }) })
    try {
      const panel = await openBrandedDetails()
      fireEvent.click(within(panel).getByRole('button', { name: 'View unfavorable and mixed answers for Property A' }))
      expect(await screen.findByRole('dialog', { name: `Sentiment evidence: Property A, ${SENTIMENT_COPY.properties.evidence}` })).toBeTruthy()
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      expect(evidenceParams(page)).toMatchObject({ queryClass: 'branded', scope: 'property', scopeKey: 'prop-a', marketKey: 'chicago', runId: 'run', revision: '3', provider: 'openai', model: 'source-model', evaluationDefinitionId: 'definition-a', outcome: ['mixed', 'unfavorable'] })
    } finally { page.close() }
  })

  it('opens a Property from a market view with that market as its market, not every market', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties({ total: 3, keys: ['prop-c', 'prop-a', 'prop-b'] }, { scope: 'market', scopeKey: 'denver', marketKey: undefined }) })
    try {
      const panel = await openBrandedDetails()
      fireEvent.click(within(panel).getByRole('button', { name: 'View unfavorable and mixed answers for Property C' }))
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const params = evidenceParams(page)
      expect(params).toMatchObject({ queryClass: 'branded', scope: 'property', scopeKey: 'prop-c', marketKey: 'denver', outcome: ['mixed', 'unfavorable'] })
      expect(params.marketKey).not.toBe('chicago')
    } finally { page.close() }
  })

  it('opens every branded unfavorable and mixed answer in the view from "View all"', async () => {
    const page = renderScope(<SentimentHeadlines />, { branded: withProperties({ total: 3, keys: ['prop-c', 'prop-a', 'prop-b'] }, { scope: 'group', scopeKey: 'north-group', marketKey: 'chicago' }) })
    try {
      const panel = await openBrandedDetails()
      fireEvent.click(within(panel).getByRole('button', { name: SENTIMENT_COPY.properties.viewAll }))
      expect(await screen.findByRole('dialog', { name: `Sentiment evidence: ${SENTIMENT_COPY.properties.allEvidence}` })).toBeTruthy()
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      // The view's own scope, never narrowed to a Property.
      expect(evidenceParams(page)).toMatchObject({ queryClass: 'branded', scope: 'group', scopeKey: 'north-group', marketKey: 'chicago', runId: 'run', outcome: ['mixed', 'unfavorable'] })
    } finally { page.close() }
  })
})

describe('non-brand unfavorable and mixed answers', () => {
  /** A non-brand summary with its own unfavorable and mixed counts, built the way the server builds one. */
  function nonBrandWith(outcomes: Partial<Record<SentimentAssessmentSummary['outcome'] & string, number>>, overrides: Partial<SentimentSummary> = {}): SentimentSummary {
    return { ...measured('non-brand', outcomes), ...overrides }
  }
  const criticism = () => screen.queryByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
  const note = () => document.querySelector('.sentiment-nonbrand-note')

  it('shows the server\'s non-brand unfavorable and mixed counts under the branded line and opens those answers', async () => {
    expect(SENTIMENT_COPY.nonBrand).toMatchObject({ label: 'Non-brand queries', view: 'View answers', evidence: 'Non-brand queries, unfavorable and mixed' })
    // 3 unfavorable and 1 mixed: distinct counts, so neither can stand in for the other.
    const nonBrand = nonBrandWith({ favorable: 40, mixed: 1, unfavorable: 3, factual: 6 })
    const page = renderScope(<SentimentHeadlines />, { nonBrand })
    try {
      const group = await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
      const scores = screen.getByRole('group', { name: 'Favorable answer scores' })
      // Under the branded line, inside the Sentiment block.
      expect(scores.lastElementChild).toBe(group)
      expect(group.previousElementSibling!.getAttribute('data-query-class')).toBe('branded')
      const counts = [...group.querySelectorAll('.sentiment-nonbrand-counts > span')]
      expect(counts.map(count => [count.textContent, count.querySelector('span')!.className])).toEqual([
        ['3 unfavorable', 'sentiment-legend-swatch progress-fill-negative'],
        ['1 mixed', 'sentiment-legend-swatch progress-fill-caution'],
      ])
      // No share: the favorable count (40) and a percentage never appear.
      expect(group.textContent).not.toContain('%')
      expect(group.textContent).not.toContain('40')
      expect(within(group).getByRole('button', { name: SENTIMENT_COPY.nonBrand.help })).toBeTruthy()
      fireEvent.click(within(group).getByRole('button', { name: SENTIMENT_COPY.nonBrand.view }))
      expect(await screen.findByRole('dialog', { name: `Sentiment evidence: ${SENTIMENT_COPY.nonBrand.evidence}` })).toBeTruthy()
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const request = page.requests.filter(url => url.pathname.endsWith('/evidence')).at(-1)!
      expect(Object.fromEntries(request.searchParams)).toMatchObject({ queryClass: 'non-brand', scope: 'property', scopeKey: 'north', marketKey: 'chicago', runId: 'run', revision: '3', provider: 'openai', model: 'source-model', evaluationDefinitionId: 'definition-a' })
      expect(request.searchParams.getAll('outcome')).toEqual(['mixed', 'unfavorable'])
    } finally { page.close() }
  })

  it('names only the outcomes that happened', async () => {
    const page = renderScope(<SentimentHeadlines />, { nonBrand: nonBrandWith({ favorable: 12, unfavorable: 2 }) })
    try {
      const group = await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
      expect([...group.querySelectorAll('.sentiment-nonbrand-counts > span')].map(count => count.textContent)).toEqual(['2 unfavorable'])
      expect(group.textContent).not.toContain('mixed')
    } finally { page.close() }
  })

  it('shows nothing for non-brand in the all-queries view when no answer was unfavorable or mixed', async () => {
    const page = renderScope(<SentimentHeadlines />, { nonBrand: nonBrandWith({ favorable: 12, factual: 4 }) })
    try {
      await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      expect(criticism()).toBeNull()
      expect(note()).toBeNull()
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.nonBrand.label)
    } finally { page.close() }
  })

  it('never shows the non-brand line in the branded view', async () => {
    const page = renderScope(<SentimentHeadlines queryClass="branded" />, { nonBrand: nonBrandWith({ favorable: 12, mixed: 2, unfavorable: 3 }) })
    try {
      await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(summariesLoaded(page.client)).toBe(true))
      expect(criticism()).toBeNull()
      expect(note()).toBeNull()
    } finally { page.close() }
  })

  it('shows the branded line and the non-brand counts in the non-brand view', async () => {
    const page = renderScope(<SentimentHeadlines queryClass="non-brand" />, { nonBrand: nonBrandWith({ favorable: 12, mixed: 2 }) })
    try {
      expect((await screen.findByLabelText('Branded favorable share')).textContent).toBe('60.1%')
      expect(document.querySelectorAll('.sentiment-class')).toHaveLength(1)
      const group = await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
      expect([...group.querySelectorAll('.sentiment-nonbrand-counts > span')].map(count => count.textContent)).toEqual(['2 mixed'])
    } finally { page.close() }
  })

  it('says "none so far", never "none", while assessments are still unadmitted', async () => {
    const base = nonBrandWith({ favorable: 12, factual: 2 })
    const gap = { ...base, coverage: { ...base.coverage, unadmittedAssessments: 3, eligibleAssessments: base.coverage.eligibleAssessments + 3 } }
    expect([gap.state, gap.provisional]).toEqual(['complete', false])
    const page = renderScope(<SentimentHeadlines queryClass="non-brand" />, { nonBrand: gap })
    try {
      await waitFor(() => expect(note()?.textContent).toBe(SENTIMENT_COPY.nonBrand.noneSoFar))
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.nonBrand.none)
    } finally { page.close() }
  })

  it('marks unfavorable and mixed counts from an unfinished read as partial', async () => {
    const page = renderScope(<SentimentHeadlines queryClass="all" />, { nonBrand: nonBrandWith({ favorable: 8, unfavorable: 1 }, { state: 'partial', provisional: true }) })
    try {
      const group = await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
      expect([...group.querySelectorAll('.sentiment-nonbrand-counts > span')].map(count => count.textContent)).toEqual(['1 unfavorable', SENTIMENT_COPY.partial])
    } finally { page.close() }
  })

  it.each([
    ['none', 'complete', false, SENTIMENT_COPY.nonBrand.none],
    ['none so far while provisional', 'partial', true, SENTIMENT_COPY.nonBrand.noneSoFar],
  ] as const)('says %s in the non-brand view once its answers are rated', async (_label, state, provisional, copy) => {
    const page = renderScope(<SentimentHeadlines queryClass="non-brand" />, { nonBrand: nonBrandWith({ favorable: 12, factual: 2 }, { state, provisional }) })
    try {
      await waitFor(() => expect(note()?.textContent).toBe(copy))
      expect(criticism()).toBeNull()
      expect(screen.queryByRole('button', { name: SENTIMENT_COPY.nonBrand.view })).toBeNull()
    } finally { page.close() }
    expect([SENTIMENT_COPY.nonBrand.none, SENTIMENT_COPY.nonBrand.noneSoFar]).toEqual(['No unfavorable or mixed answers in non-brand queries.', 'No unfavorable or mixed answers in non-brand queries so far.'])
  })

  it.each([
    ['not-measured', SENTIMENT_COPY.nonBrand.notRated],
    ['failed', `${SENTIMENT_COPY.nonBrand.label}: ${SENTIMENT_COPY.states.failed}`],
    ['canceled', `${SENTIMENT_COPY.nonBrand.label}: ${SENTIMENT_COPY.states.canceled}`],
    ['unsupported', `${SENTIMENT_COPY.nonBrand.label}: ${SENTIMENT_COPY.states.unsupported}`],
    ['processing', `${SENTIMENT_COPY.nonBrand.label}: ${SENTIMENT_COPY.states.processing}`],
    // A partial read can be terminal (failed or canceled work): it says so, never "Analyzing".
    ['partial', `${SENTIMENT_COPY.nonBrand.label}: ${SENTIMENT_COPY.states.partial}`],
  ] as const)('says non-brand is not rated rather than "none" while it is %s with no ratings', async (state, copy) => {
    const unrated = { ...nonBrandWith({}), ...aggregateSentiment([]), state, provisional: state !== 'not-measured' && state !== 'failed', selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    const page = renderScope(<SentimentHeadlines queryClass="non-brand" />, { nonBrand: unrated })
    try {
      await waitFor(() => expect(note()?.textContent).toBe(copy))
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.nonBrand.none)
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.nonBrand.noneSoFar)
    } finally { page.close() }
    expect(SENTIMENT_COPY.nonBrand.notRated).toBe('Non-brand answers are not rated yet.')
  })

  it('says it is loading non-brand in the non-brand view until that summary arrives', async () => {
    let release: ((response: Response) => void) | undefined
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings())
      if (request.searchParams.get('queryClass') === 'non-brand') return new Promise<Response>(resolve => { release = resolve })
      return jsonResponse(summary())
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', scope: 'project', queryClass: 'non-brand', runId: 'run' }}><SentimentHeadlines queryClass="non-brand" /></SentimentScopeProvider></QueryClientProvider>)
      await screen.findByLabelText('Branded favorable share')
      expect(screen.getByRole('status').textContent).toBe('Loading non-brand sentiment…')
      expect(screen.getByRole('status').className).toBe('sentiment-nonbrand-note')
      release!(jsonResponse({ ...nonBrandWith({ favorable: 12, unfavorable: 1 }) }))
      expect([...(await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })).querySelectorAll('.sentiment-nonbrand-counts > span')].map(count => count.textContent)).toEqual(['1 unfavorable'])
      expect(screen.queryByRole('status')).toBeNull()
    } finally { release?.(jsonResponse(summary())); cleanup(); client.clear(); restore() }
  })

  it('offers Retry when the non-brand summary fails in the non-brand view, and shows nothing for it in the all-queries view', async () => {
    let fail = true
    const reads: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse(settings())
      if (request.searchParams.get('queryClass') === 'non-brand') {
        reads.push(request)
        return fail ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Sentiment read failed' } }, 500) : jsonResponse(nonBrandWith({ favorable: 12, mixed: 4 }))
      }
      return jsonResponse(summary())
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = (view: 'all' | 'non-brand') => <QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', scope: 'project', queryClass: 'branded', runId: 'run' }}><SentimentHeadlines queryClass={view} /></SentimentScopeProvider></QueryClientProvider>
    try {
      const view = render(tree('all'))
      await screen.findByLabelText('Branded favorable share')
      await waitFor(() => expect(reads).toHaveLength(1))
      await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['sentiment', 'project', 'summary'] }).some(query => query.state.status === 'error')).toBe(true))
      // The all-queries view lists exceptions only: a failed read adds nothing there.
      expect(screen.queryByRole('alert')).toBeNull()
      expect(note()).toBeNull()
      view.rerender(tree('non-brand'))
      const alert = await screen.findByRole('alert')
      expect(alert.className).toBe('sentiment-nonbrand-note')
      expect(alert.textContent).toBe('Couldn’t load non-brand sentiment. Retry')
      fail = false
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
      const group = await screen.findByRole('group', { name: SENTIMENT_COPY.nonBrand.label })
      expect([...group.querySelectorAll('.sentiment-nonbrand-counts > span')].map(count => count.textContent)).toEqual(['4 mixed'])
      expect(reads).toHaveLength(2)
      expect(screen.queryByRole('alert')).toBeNull()
    } finally { cleanup(); client.clear(); restore() }
  })

  it('shows nothing for non-brand when the view has no saved answers', async () => {
    const restore = mockFetch(url => new URL(url).pathname.endsWith('/settings') ? jsonResponse(settings()) : jsonResponse(nonBrandWith({ mixed: 2, unfavorable: 2 })))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentScopeProvider hasSourceEvidence={false} projectName="project" selection={{ mode: 'simple', scope: 'project', queryClass: 'branded' }}><SentimentHeadlines queryClass="non-brand" /></SentimentScopeProvider></QueryClientProvider>)
      await waitFor(() => expect(screen.getByLabelText('Favorable answer scores').textContent).toContain('No saved answers.'))
      expect(criticism()).toBeNull()
      expect(note()).toBeNull()
    } finally { cleanup(); client.clear(); restore() }
  })
})

describe('non-brand query rows', () => {
  function nonBrandRows(rowCounts: { unfavorable: number; mixed: number; favorable: number }, locationCounts?: { unfavorable: number; mixed: number; favorable: number }): SentimentSummary {
    const build = (counts: { unfavorable: number; mixed: number; favorable: number }) => aggregateSentiment(Object.entries(counts).flatMap(([outcome, count]) => Array.from({ length: count }, (_, index) => ({ assessmentId: `${outcome}-${index}`, sourceSnapshotId: 'snapshot', outcome: outcome as 'favorable' | 'mixed' | 'unfavorable' }))))
    const dto = { ...summary(), selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    const row = build(rowCounts)
    dto.queries = [{ ...row, reason: null, queryId: 'q', queryText: 'apartments near transit', queryClass: 'non-brand', sourceSnapshotIds: ['snapshot'], assessments: [], locations: locationCounts ? [{ ...build(locationCounts), reason: null, location: 'Chicago', sourceSnapshotIds: ['snapshot'] }] : [] }]
    return dto
  }

  it('shows a non-brand row\'s unfavorable and mixed counts, never a favorable share, and opens those answers', async () => {
    // 9 favorable of 12 ratings would read 75.0%; the row shows only 2 unfavorable and 1 mixed.
    const nonBrand = nonBrandRows({ favorable: 9, mixed: 1, unfavorable: 2 })
    expect(nonBrand.queries[0]!.score.favorableDisplay).toBe('75.0%')
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="non-brand" showLabel />, { nonBrand })
    try {
      const button = await screen.findByRole('button', { name: 'View unfavorable and mixed answers for apartments near transit' })
      expect([...button.children].map(child => [child.textContent, child.className.split(' ').at(-1)])).toEqual([
        [SENTIMENT_COPY.nonBrand.rowLabel, 'text-secondary'],
        ['2 unfavorable', 'text-negative'],
        ['1 mixed', 'text-caution'],
      ])
      expect(SENTIMENT_COPY.nonBrand.rowLabel).toBe('Unfavorable or mixed')
      expect(button.textContent).not.toContain('%')
      expect(button.textContent).not.toContain('judged')
      fireEvent.click(button)
      expect(await screen.findByRole('dialog', { name: 'Sentiment evidence: apartments near transit, unfavorable and mixed' })).toBeTruthy()
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const request = page.requests.filter(url => url.pathname.endsWith('/evidence')).at(-1)!
      expect(Object.fromEntries(request.searchParams)).toMatchObject({ queryClass: 'non-brand', queryId: 'q', runId: 'run', revision: '3', scope: 'property', scopeKey: 'north', marketKey: 'chicago' })
      expect(request.searchParams.getAll('outcome')).toEqual(['mixed', 'unfavorable'])
    } finally { page.close() }
  })

  it('reads a muted em dash, with its meaning for a screen reader, when a non-brand row has no unfavorable or mixed answers', async () => {
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="non-brand" />, { nonBrand: nonBrandRows({ favorable: 12, mixed: 0, unfavorable: 0 }) })
    try {
      const spoken = await screen.findByText(SENTIMENT_COPY.nonBrand.rowNone)
      const cell = spoken.parentElement!
      expect(cell.className).toContain('text-muted')
      const mark = cell.querySelector<HTMLElement>('[aria-hidden="true"]')!
      expect(mark.textContent).toBe(EMPTY_VALUE)
      expect(mark.title).toBe(SENTIMENT_COPY.nonBrand.rowNone)
      expect(spoken.className).toBe('sr-only')
      expect(SENTIMENT_COPY.nonBrand.rowNone).toBe('No unfavorable or mixed answers')
      expect(visibleText(cell)).toBe(EMPTY_VALUE)
      expect(cell.textContent).not.toContain('%')
      expect(screen.queryByRole('button')).toBeNull()
    } finally { page.close() }
  })

  // Only a final read (complete, not provisional, nothing unadmitted) establishes "no unfavorable or mixed answers".
  function unfinishedRow(outcomes: SentimentOutcome[], gap = 0, serviceState?: Pick<SentimentSummary, 'state' | 'provisional'>): SentimentSummary {
    const row = aggregateSentiment(outcomes.map((outcome, index) => ({ assessmentId: `${outcome}-${index}`, sourceSnapshotId: `snapshot-${index}`, outcome })), { eligibleAssessments: outcomes.length + gap })
    const dto = { ...summary(), selection: { ...summary().selection, queryClass: 'non-brand' as const } }
    dto.queries = [{ ...row, ...serviceState, reason: null, queryId: 'q', queryText: 'apartments near transit', queryClass: 'non-brand', sourceSnapshotIds: outcomes.map((_, index) => `snapshot-${index}`), assessments: [], locations: [] }]
    return dto
  }
  it.each([
    ['unadmitted (eligible, never stored)', [] as SentimentOutcome[], 2, undefined, SENTIMENT_COPY.states['not-measured']],
    ['pending', ['pending', 'running'] as SentimentOutcome[], 0, undefined, SENTIMENT_COPY.states.processing],
    ['waiting to retry', ['waiting-to-retry'] as SentimentOutcome[], 0, undefined, SENTIMENT_COPY.states.processing],
    ['failed', ['failed'] as SentimentOutcome[], 0, undefined, SENTIMENT_COPY.states.failed],
    ['canceled', ['canceled'] as SentimentOutcome[], 0, undefined, SENTIMENT_COPY.states.canceled],
    ['partial (one rating, one failed)', ['favorable', 'failed'] as SentimentOutcome[], 0, undefined, SENTIMENT_COPY.states.partial],
    // The service marks a coverage gap partial and provisional even when every stored assessment finished.
    ['partial (coverage gap)', ['favorable'] as SentimentOutcome[], 2, { state: 'partial' as const, provisional: true }, SENTIMENT_COPY.states.partial],
  ])('keeps a %s non-brand row in its own state, never "no unfavorable or mixed answers"', async (_label, outcomes, gap, serviceState, copy) => {
    const nonBrand = unfinishedRow(outcomes, gap, serviceState)
    const row = nonBrand.queries[0]!
    expect(row.coverage.counts.unfavorable + row.coverage.counts.mixed).toBe(0)
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="non-brand" showLabel />, { nonBrand })
    try {
      const cell = (await screen.findByText(copy)).parentElement!
      expect([...cell.children].map(child => child.textContent)).toEqual([SENTIMENT_COPY.nonBrand.rowLabel, copy])
      expect(cell.className).toContain('text-secondary')
      expect(cell.textContent).not.toContain(SENTIMENT_COPY.nonBrand.rowNone)
      expect(cell.textContent).not.toContain(EMPTY_VALUE)
      expect(screen.queryByRole('button')).toBeNull()
    } finally { page.close() }
  })

  it('marks counts from an unfinished non-brand row as partial', async () => {
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="non-brand" />, { nonBrand: unfinishedRow(['unfavorable', 'pending']) })
    try {
      const button = await screen.findByRole('button', { name: 'View unfavorable and mixed answers for apartments near transit' })
      expect([...button.children].map(child => [child.textContent, child.className.split(' ').at(-1)])).toEqual([['1 unfavorable', 'text-negative'], ['Provisional', 'text-caution']])
    } finally { page.close() }
  })

  it('reads a location\'s own counts, not the query\'s', async () => {
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="non-brand" location="Chicago" />, { nonBrand: nonBrandRows({ favorable: 4, mixed: 3, unfavorable: 5 }, { favorable: 2, mixed: 0, unfavorable: 1 }) })
    try {
      const button = await screen.findByRole('button', { name: 'View unfavorable and mixed answers for apartments near transit' })
      expect([...button.children].map(child => child.textContent)).toEqual(['1 unfavorable'])
      fireEvent.click(button)
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      const request = page.requests.filter(url => url.pathname.endsWith('/evidence')).at(-1)!
      expect(request.searchParams.get('location')).toBe('Chicago')
      expect(request.searchParams.getAll('outcome')).toEqual(['mixed', 'unfavorable'])
    } finally { page.close() }
  })

  it('keeps the favorable share and its rating count on branded rows', async () => {
    const dto = summary(); const { state, reason, provisional, coverage, score } = dto
    dto.queries = [{ queryId: 'q', queryText: 'Is North Hall good?', queryClass: 'branded', sourceSnapshotIds: ['snapshot'], state, reason, provisional, coverage, score, assessments: [], locations: [] }]
    const page = renderScope(<SentimentQueryScore queryId="q" queryClass="branded" />, { branded: dto })
    try {
      const button = await screen.findByRole('button', { name: 'View Branded sentiment evidence for Is North Hall good?' })
      expect(button.textContent).toBe('60.1%10 judged')
      fireEvent.click(button)
      await screen.findByText('No stored sentiment evidence for this query and scope.')
      // A branded row opens every judged answer, not only the criticism.
      expect(page.requests.filter(url => url.pathname.endsWith('/evidence')).at(-1)!.searchParams.has('outcome')).toBe(false)
    } finally { page.close() }
  })
})

describe('sentiment outcome tones', () => {
  const TONE_CLASS = { favorable: 'text-positive', mixed: 'text-caution', unfavorable: 'text-negative', factual: 'text-neutral' } as const
  it.each([
    ['favorable', 'Favorable'], ['mixed', 'Mixed'], ['unfavorable', 'Unfavorable'], ['factual', OUTCOME_COPY.factual],
  ] as const)('tones a %s evidence badge by its outcome', async (outcome, label) => {
    const page = renderScope(<SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot']} queryClass="branded" provider="openai" location="Chicago" />, {
      branded: summaryWithAssessments([assessment({ assessmentId: 'a', sourceSnapshotId: 'snapshot', outcome })]), evidence: [evidenceItem({ outcome })],
    })
    try {
      fireEvent.click(await screen.findByRole('button', { name: `View openai sentiment evidence for North Hall: ${label}` }))
      const dialog = await screen.findByRole('dialog', { name: 'Sentiment evidence: Is North Hall good? · openai · North Hall' })
      const badge = await within(dialog).findByText(label, { selector: 'div' })
      expect(badge.className).toContain(TONE_CLASS[outcome])
      for (const other of Object.values(TONE_CLASS).filter(tone => tone !== TONE_CLASS[outcome])) expect(badge.className).not.toContain(other)
    } finally { page.close() }
  })

  it('tones each engine row badge by its outcome', async () => {
    const dto = summaryWithAssessments([
      assessment(),
      assessment({ assessmentId: 'assessment-south', subjectId: 'south', subjectLabel: 'South Hall', outcome: 'unfavorable' }),
      assessment({ assessmentId: 'assessment-west', subjectId: 'west', subjectLabel: 'West Hall', outcome: 'mixed' }),
      assessment({ assessmentId: 'assessment-east', subjectId: 'east', subjectLabel: 'East Hall', outcome: 'factual' }),
    ])
    const page = renderScope(<SentimentAnswerOutcome queryId="q" sourceSnapshotIds={['snapshot-openai']} queryClass="branded" provider="openai" location="Chicago" showSubjects />, { branded: dto })
    try {
      await screen.findByRole('button', { name: 'View openai sentiment evidence for North Hall: Favorable' })
      const tone = (subject: string, label: string) => screen.getByRole('button', { name: `View openai sentiment evidence for ${subject}: ${label}` }).querySelector('div')!.className
      expect(tone('North Hall', 'Favorable')).toContain(TONE_CLASS.favorable)
      expect(tone('South Hall', 'Unfavorable')).toContain(TONE_CLASS.unfavorable)
      expect(tone('West Hall', 'Mixed')).toContain(TONE_CLASS.mixed)
      expect(tone('East Hall', OUTCOME_COPY.factual)).toContain(TONE_CLASS.factual)
    } finally { page.close() }
  })
})

describe('sentiment block title and Manage sentiment', () => {
  /** Settings for an administrator, with sentiment on or off for the project and the installation. */
  function adminSettings(enabled: boolean, installEnabled = true): SentimentSettings {
    return { ...settings(true), enabled, installEnabled }
  }
  function renderBlock(view: ReactNode, value: SentimentSettings, provider: Partial<ComponentProps<typeof SentimentScopeProvider>> = {}) {
    const reads: URL[] = []
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/settings')) return jsonResponse(value)
      if (request.pathname.endsWith('/jobs')) return jsonResponse({ jobs: [] })
      reads.push(request)
      return jsonResponse(summary())
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><SentimentScopeProvider projectName="project" selection={{ mode: 'advanced', scope: 'project', queryClass: 'branded' }} {...provider}>{view}</SentimentScopeProvider></QueryClientProvider>)
    return { reads, client, close: () => { cleanup(); client.clear(); restore() } }
  }
  const title = () => document.querySelector<HTMLElement>('.sentiment-headlines-title')

  it.each([
    ['off for the project', false, true, 'Enable sentiment'],
    ['off for the installation', true, false, 'Manage sentiment'],
  ] as const)('says "Sentiment is off." under the title, beside the switch, when settings say sentiment is %s', async (_label, enabled, installEnabled, control) => {
    const block = renderBlock(<SentimentHeadlines manage />, adminSettings(enabled, installEnabled))
    try {
      await screen.findByRole('button', { name: control })
      const row = title()!
      expect(within(row).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
      expect(row.querySelector('.sentiment-headlines-subtitle')!.textContent).toBe(SENTIMENT_COPY.states.disabled)
      expect(SENTIMENT_COPY.states.disabled).toBe('Sentiment is off.')
      expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual([control])
      // No scores block and no summary read.
      expect(screen.queryByRole('group', { name: 'Favorable answer scores' })).toBeNull()
      expect(block.reads).toHaveLength(0)
    } finally { block.close() }
  })

  it('never says "Sentiment is off." while settings are on and the sweep is still resolving', async () => {
    // Advanced waits for its resolved sweep; nothing resolves it here.
    const block = renderBlock(<SentimentHeadlines manage />, adminSettings(true), { waitForResolvedRun: true })
    try {
      const manage = await screen.findByRole('button', { name: 'Manage sentiment' })
      const row = title()!
      expect(row.contains(manage)).toBe(true)
      expect(within(row).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
      expect(row.querySelector('.sentiment-headlines-subtitle')).toBeNull()
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.states.disabled)
      expect(block.reads).toHaveLength(0)
    } finally { block.close() }
  })

  it('never says "Sentiment is off." in an unclassified view while settings are on', async () => {
    const block = renderBlock(<SentimentHeadlines queryClass="unclassified" manage />, adminSettings(true))
    try {
      await screen.findByRole('button', { name: 'Manage sentiment' })
      expect(title()!.querySelector('.sentiment-headlines-subtitle')).toBeNull()
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.states.disabled)
      expect(screen.queryByRole('group', { name: 'Favorable answer scores' })).toBeNull()
    } finally { block.close() }
  })

  it('shows no title row to a reader who cannot configure sentiment while it is off', async () => {
    const block = renderBlock(<SentimentHeadlines manage />, { ...adminSettings(false), actions: { configure: false, backfill: false } })
    try {
      await waitFor(() => expect(block.client.getQueryData(sentimentQueryKey('project', 'settings'))).toBeTruthy())
      expect(title()).toBeNull()
      expect(document.body.textContent).not.toContain(SENTIMENT_COPY.states.disabled)
      expect(screen.queryByRole('button', { name: 'Enable sentiment' })).toBeNull()
    } finally { block.close() }
  })

  it('shows no title row and no switch without `manage`, even to an administrator while sentiment is off', async () => {
    const block = renderBlock(<SentimentHeadlines />, adminSettings(false))
    try {
      await waitFor(() => expect(block.client.getQueryData(sentimentQueryKey('project', 'settings'))).toBeTruthy())
      expect(title()).toBeNull()
      expect(screen.queryByRole('button', { name: 'Enable sentiment' })).toBeNull()
    } finally { block.close() }
  })

  it('puts Manage sentiment in the Simple Query evidence title row when the section has actions, and nowhere in an embed', async () => {
    const withActions = renderBlock(<QueryEvidenceSummary queryClass="all" actions={<button type="button">Manage queries</button>} />, adminSettings(true), { selection: { mode: 'simple', scope: 'project', queryClass: 'branded', runId: 'run' } })
    try {
      await screen.findByLabelText('Branded favorable share')
      const row = title()!
      expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage sentiment'])
      expect(within(document.querySelector<HTMLElement>('.query-evidence-actions')!).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage queries'])
    } finally { withActions.close() }
    const embed = renderBlock(<QueryEvidenceSummary queryClass="all" />, adminSettings(true), { selection: { mode: 'simple', scope: 'project', queryClass: 'branded', runId: 'run' } })
    try {
      await screen.findByLabelText('Branded favorable share')
      expect(screen.queryByRole('button', { name: 'Manage sentiment' })).toBeNull()
      expect(document.querySelector('.query-evidence-toolbar')).toBeNull()
      expect(within(title()!).getByRole('heading', { level: 3 }).textContent).toBe(SENTIMENT_COPY.title)
    } finally { embed.close() }
  })

  it('keeps Manage sentiment reachable in the actions row while query evidence loads or fails (no query class, no block)', async () => {
    const block = renderBlock(<QueryEvidenceSummary actions={<button type="button">Manage queries</button>} />, adminSettings(true))
    try {
      await waitFor(() => expect(block.client.getQueryData(sentimentQueryKey('project', 'settings'))).toBeTruthy())
      expect([...document.querySelector('.query-evidence-toolbar')!.children].map(child => child.className)).toEqual(['query-evidence-actions'])
      const actions = document.querySelector<HTMLElement>('.query-evidence-actions')!
      await waitFor(() => expect(within(actions).getAllByRole('button').map(button => button.textContent)).toEqual(['Manage sentiment', 'Manage queries']))
      expect(screen.getAllByRole('button', { name: 'Manage sentiment' })).toHaveLength(1)
      expect(screen.queryByRole('group', { name: 'Favorable answer scores' })).toBeNull()
    } finally { block.close() }
  })
})

describe('sentiment bar styles', () => {
  it('keeps the legend swatches in their colors under forced colors, like the bar segments', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    for (const selector of ['.sentiment-bar-segment', '.sentiment-legend-swatch']) {
      expect(compiledDeclarations(css, selector, '@media (forced-colors: active)')).toMatchObject({ 'forced-color-adjust': 'none' })
    }
  })

  it('runs each class line the full width on shared columns: label, the bar as the one flexible column, then fixed Favorable, With opinion and chevron columns', async () => {
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

  it('spans the title row, the legend under it and the non-brand line across every column of the block', async () => {
    const css = parseCompiledCss(await compileAppStyles([]))
    // Inside the grid each would otherwise fall into the label column alone.
    for (const selector of ['.sentiment-headlines-title', '.sentiment-headlines > .sentiment-legend', '.sentiment-nonbrand', '.sentiment-nonbrand-note']) {
      expect(compiledDeclarations(css, selector), selector).toMatchObject({ 'grid-column': '1 / -1' })
    }
    expect(compiledDeclarations(css, '.sentiment-headlines-title')).toMatchObject({ 'justify-content': 'space-between' })
    // A Property's bar runs under its name and count.
    expect(compiledDeclarations(css, '.sentiment-property-bar')).toMatchObject({ 'grid-column': '1 / -1' })
    // The no-opinion caption wraps inside the fixed-width panel.
    expect(compiledDeclarations(css, '.sentiment-details-caption')).toMatchObject({ 'overflow-wrap': 'break-word' })
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
      expect(limit.closest('label')!.textContent).toContain('engine openai · model source-model · search location Chicago · location north · market chicago · revision 3')
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByText('Branded queries · whole sweep')
      expect(Object.fromEntries(previews[0]!.searchParams)).toEqual({ mode: 'auto', scope: 'project', queryClass: 'branded', runId: 'run' })
      const skipped = screen.getByRole('list', { name: 'Skipped assessments' })
      expect([...skipped.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Incomplete sweep: 1', 'Non-brand answers (backfill that class separately): 4', 'A newer reason: 2'])
      expect((screen.getByRole('button', { name: 'Confirm sentiment backfill' }) as HTMLButtonElement).disabled).toBe(false)

      fireEvent.click(limit)
      fireEvent.click(screen.getByRole('button', { name: 'Preview sentiment backfill' }))
      await screen.findByText('Branded queries · engine openai · model source-model · search location Chicago · location north · market chicago · revision 3')
      expect(Object.fromEntries(previews[1]!.searchParams)).toMatchObject({ mode: 'advanced', queryClass: 'branded', runId: 'run', provider: 'openai', model: 'source-model', location: 'Chicago', scope: 'property', scopeKey: 'north', marketKey: 'chicago', revision: '3' })
      expect(screen.getByText('No saved answers in this selection can be classified.')).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Confirm sentiment backfill' }) as HTMLButtonElement).disabled).toBe(true)
    } finally { cleanup(); client.clear(); restore() }
  })
  it('keeps "location" for the engine\'s place in a Simple view, which has no Property to tell it from', async () => {
    const dto = summary(); dto.selection = { mode: 'simple', queryClass: 'branded', scope: 'project', runId: 'run', provider: 'openai', location: 'Chicago', evaluationDefinitionId: 'definition-a' }
    const restore = mockFetch(url => {
      const request = new URL(url)
      if (request.pathname.endsWith('/sentiment/settings')) return jsonResponse(settings(true))
      if (request.pathname.endsWith('/sentiment/jobs')) return jsonResponse({ jobs: [] })
      return jsonResponse(dto)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    try {
      render(<QueryClientProvider client={client}><SentimentSection projectName="project" selection={{ mode: 'simple', queryClass: 'branded', scope: 'project', provider: 'openai', location: 'Chicago', runId: 'run' }} /></QueryClientProvider>)
      fireEvent.click(await screen.findByRole('button', { name: 'Manage sentiment' }))
      expect(screen.getByRole('checkbox', { name: /Limit to the current view/ }).closest('label')!.textContent).toContain('engine openai · location Chicago')
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

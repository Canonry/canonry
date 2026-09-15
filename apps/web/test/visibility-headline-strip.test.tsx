import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import type { VisibilityReportComparison, VisibilityReportPopulationClass, VisibilityReportRate, VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { REPORT_CHANGE_COPY, REPORT_CLASS_NOUN, VisibilityReportView } from '../src/components/project/VisibilityTrendSection.js'

afterEach(cleanup)

// A midday-UTC sweep reads as the same calendar date in every zone from UTC-11 to UTC+11.
const PREVIOUS_RUN = { id: 'run-1', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:30:00.000Z' }
const PREVIOUS_DATE = 'Sep 6, 2026'
const CLASS_LABEL = { 'non-brand': 'Non-brand queries', branded: 'Branded queries', unknown: 'Unclassified queries' } as const

const VALUE_CLASS = 'text-3xl font-semibold tabular-nums text-heading'
const DETAIL_CLASS = 'text-sm tabular-nums text-secondary'
const REASON_CLASS = 'text-lg text-secondary'

function rate(numerator: number, denominator: number): VisibilityReportRate {
  return { numerator, denominator, rate: numerator / denominator }
}
const NOT_MEASURED: VisibilityReportRate = { numerator: null, denominator: null, rate: null, reason: 'no-population' }
const NOT_APPLICABLE: VisibilityReportRate = { numerator: null, denominator: null, rate: null, reason: 'not-applicable' }

// Current sweep: 24 of 36 answers mention, 24 of 36 cite, 12 of 12 Properties mentioned.
const CURRENT = { mentionCoverage: rate(24, 36), citationCoverage: rate(24, 36), propertyReach: rate(12, 12) }

/** The server's own delta: current rate minus previous rate, which the response schema re-checks. */
function change(current: VisibilityReportRate, previous: VisibilityReportRate) {
  return { state: 'available' as const, previous, delta: current.rate! - previous.rate! }
}

/** Down 3 of 36 answers mentioning, up 6 of 36 answers citing, no change in Property reach. */
const MOVED: VisibilityReportComparison = {
  state: 'available',
  previousRun: PREVIOUS_RUN,
  mentionCoverage: change(CURRENT.mentionCoverage, rate(27, 36)),
  citationCoverage: change(CURRENT.citationCoverage, rate(18, 36)),
  propertyReach: change(CURRENT.propertyReach, rate(12, 12)),
}

interface FixtureOptions {
  queryClass?: VisibilityReportPopulationClass
  scope?: 'project' | 'property'
  runId?: string | null
  queryCount?: number
  answerCount?: number
  summary?: Partial<typeof CURRENT>
  comparison?: VisibilityReportComparison
}

function headlineReport({ queryClass = 'non-brand', scope = 'project', runId = 'run-2', queryCount = 12, answerCount = 36, summary, comparison }: FixtureOptions = {}): VisibilityReportResponse {
  const provenance = { kind: 'frozen-advanced' as const, definitionRevision: 2 }
  const scopeOptions = [
    { id: 'project', label: 'Whole site', kind: 'project' as const, targetCount: 12 },
    { id: 'coastal-maine', label: 'Coastal Maine', kind: 'group' as const, targetCount: 4 },
    { id: 'harbor-house', label: 'Harbor House', kind: 'property' as const, targetCount: 1 },
  ]
  const rates = { ...CURRENT, ...(scope === 'property' ? { propertyReach: NOT_APPLICABLE } : {}), ...summary }
  // Parsed so every fixture is a response the server could send, including the delta invariant.
  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'advanced', queryClass, scope: scopeOptions.find(option => option.kind === scope)!,
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: 2, run: { id: runId, explicit: false }, provenance,
      measurement: { state: 'measured', activeRevision: 2, measuredRevision: 2, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-13T12:30:00.000Z' },
      availability: { state: 'available' },
    },
    scopeOptions,
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'all' }] },
    populations: [{
      queryClass,
      summary: { queryCount, answerCount, ...rates, outcomes: { bothSignals: 12, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 12 } },
      trend: [
        { runId: 'run-1', createdAt: PREVIOUS_RUN.createdAt, revision: 2, provenance, queryCount, answerCount, mentionCoverage: rate(27, 36), citationCoverage: rate(18, 36), continuity: { state: 'first', comparedRunId: null } },
        { runId: 'run-2', createdAt: '2026-09-13T12:00:00.000Z', revision: 2, provenance, queryCount, answerCount, mentionCoverage: rates.mentionCoverage, citationCoverage: rates.citationCoverage, continuity: { state: 'comparable', comparedRunId: 'run-1' } },
      ],
      ...(comparison ? { comparison } : {}),
      queries: { items: [], total: 0, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
      competitorAvailability: { state: 'available' }, competitors: [], observedCompetitors: [],
      breakdown: {
        groups: [{ id: 'coastal-maine', label: 'Coastal Maine', queryCount: 4, mentionCoverage: { numerator: 667, denominator: 1000, rate: 0.667 }, citationCoverage: NOT_MEASURED }],
        properties: [{ id: 'harbor-house', label: 'Harbor House', queryCount: 4, mentionCoverage: rate(3, 4), citationCoverage: rate(2, 4) }],
      },
    }],
  })
}

function strip(queryClass: VisibilityReportPopulationClass = 'non-brand'): HTMLElement {
  return screen.getByLabelText(`${CLASS_LABEL[queryClass]} headline results`)
}

/** Every `dd` in the cell labelled `label`, as [text, exact class list]. */
function cell(label: string, queryClass: VisibilityReportPopulationClass = 'non-brand'): Array<[string, string]> {
  const term = within(strip(queryClass)).getByText(label, { selector: 'dt span' })
  return [...term.closest('div')!.querySelectorAll('dd')].map(definition => [definition.textContent ?? '', definition.className])
}

const MENTION_LABEL = 'Answers mentioning a property'
const CITATION_LABEL = 'Answers citing a property'
const REACH_LABEL = 'Properties mentioned'
const FIGURES = {
  [MENTION_LABEL]: [['66.7%', VALUE_CLASS], ['24 of 36 answers', DETAIL_CLASS]],
  [CITATION_LABEL]: [['66.7%', VALUE_CLASS], ['24 of 36 answers', DETAIL_CLASS]],
  [REACH_LABEL]: [['100%', VALUE_CLASS], ['12 of 12 properties', DETAIL_CLASS]],
} satisfies Record<string, Array<[string, string]>>

describe('headline strip', () => {
  it('pins the change-line copy table and class nouns', () => {
    expect(REPORT_CLASS_NOUN).toEqual({ 'non-brand': 'non-brand queries', branded: 'branded queries', unknown: 'unclassified queries' })
    expect(REPORT_CHANGE_COPY.up('8.3', PREVIOUS_DATE, 'non-brand queries')).toBe('Up 8.3 pts vs Sep 6, 2026 · non-brand queries')
    expect(REPORT_CHANGE_COPY.down('8.3', PREVIOUS_DATE, 'branded queries')).toBe('Down 8.3 pts vs Sep 6, 2026 · branded queries')
    expect(REPORT_CHANGE_COPY.none(PREVIOUS_DATE, 'unclassified queries')).toBe('No change vs Sep 6, 2026 · unclassified queries')
    expect(REPORT_CHANGE_COPY.noPreviousRun).toBe('No earlier sweep to compare')
    expect(REPORT_CHANGE_COPY.definitionChanged(PREVIOUS_DATE)).toBe('Not compared: setup changed since Sep 6, 2026')
    expect(REPORT_CHANGE_COPY.definitionChanged(null)).toBe('Not compared: setup changed')
    expect(REPORT_CHANGE_COPY.modelChanged(PREVIOUS_DATE)).toBe('Not compared: engines or models changed since Sep 6, 2026')
    expect(REPORT_CHANGE_COPY.modelChanged(null)).toBe('Not compared: engines or models changed')
    expect(REPORT_CHANGE_COPY.legacyUnknown).toBe('Not compared: older sweep lacks comparison details')
    expect(REPORT_CHANGE_COPY.partialRun).toBe('Not compared: a sweep was incomplete')
    expect(REPORT_CHANGE_COPY.scopedRun).toBe('Not compared: this sweep covered part of the project')
    expect(REPORT_CHANGE_COPY.previousUnavailable).toBe('No earlier value to compare')
    expect(REPORT_CHANGE_COPY.explanation).toBe('Change compares this sweep with the sweep before it when both completed and used the same setup, engines and models.')
  })

  it('renders three large rates with denominators and a class-labelled change in words and tone', () => {
    render(<VisibilityReportView report={headlineReport({ comparison: MOVED })} onSelectionChange={() => {}} />)
    const noun = REPORT_CLASS_NOUN['non-brand']
    expect(strip().tagName).toBe('DL')
    expect(strip().children).toHaveLength(3)
    expect(strip().dataset.columns).toBe('3')
    expect(cell(MENTION_LABEL)).toEqual([...FIGURES[MENTION_LABEL], [REPORT_CHANGE_COPY.down('8.3', PREVIOUS_DATE, noun), 'text-sm text-negative']])
    expect(cell(CITATION_LABEL)).toEqual([...FIGURES[CITATION_LABEL], [REPORT_CHANGE_COPY.up('16.7', PREVIOUS_DATE, noun), 'text-sm text-positive']])
    expect(cell(REACH_LABEL)).toEqual([...FIGURES[REACH_LABEL], [REPORT_CHANGE_COPY.none(PREVIOUS_DATE, noun), 'text-sm text-secondary']])
    expect(screen.queryByText('Queries measured')).toBeNull()
  })

  it.each(['branded', 'unknown'] as const)('names the %s class on every change line that prints a figure', queryClass => {
    render(<VisibilityReportView report={headlineReport({ queryClass, comparison: MOVED })} onSelectionChange={() => {}} />)
    const noun = REPORT_CLASS_NOUN[queryClass]
    expect(cell(MENTION_LABEL, queryClass).at(-1)).toEqual([REPORT_CHANGE_COPY.down('8.3', PREVIOUS_DATE, noun), 'text-sm text-negative'])
    expect(cell(CITATION_LABEL, queryClass).at(-1)).toEqual([REPORT_CHANGE_COPY.up('16.7', PREVIOUS_DATE, noun), 'text-sm text-positive'])
    expect(cell(REACH_LABEL, queryClass).at(-1)).toEqual([REPORT_CHANGE_COPY.none(PREVIOUS_DATE, noun), 'text-sm text-secondary'])
  })

  it('reads a change under 0.05 points as <0.1 in its own direction', () => {
    const comparison: VisibilityReportComparison = {
      ...MOVED,
      mentionCoverage: change(CURRENT.mentionCoverage, rate(2399, 3600)),
      citationCoverage: change(CURRENT.citationCoverage, rate(2401, 3600)),
    }
    render(<VisibilityReportView report={headlineReport({ comparison })} onSelectionChange={() => {}} />)
    expect(cell(MENTION_LABEL).at(-1)).toEqual([REPORT_CHANGE_COPY.up('<0.1', PREVIOUS_DATE, 'non-brand queries'), 'text-sm text-positive'])
    expect(cell(CITATION_LABEL).at(-1)).toEqual([REPORT_CHANGE_COPY.down('<0.1', PREVIOUS_DATE, 'non-brand queries'), 'text-sm text-negative'])
  })

  it.each([
    ['no-previous-run', null, REPORT_CHANGE_COPY.noPreviousRun],
    ['definition-changed', PREVIOUS_RUN, REPORT_CHANGE_COPY.definitionChanged(PREVIOUS_DATE)],
    ['definition-changed', null, REPORT_CHANGE_COPY.definitionChanged(null)],
    ['model-changed', PREVIOUS_RUN, REPORT_CHANGE_COPY.modelChanged(PREVIOUS_DATE)],
    ['model-changed', null, REPORT_CHANGE_COPY.modelChanged(null)],
    ['legacy-unknown', PREVIOUS_RUN, REPORT_CHANGE_COPY.legacyUnknown],
    ['partial-run', PREVIOUS_RUN, REPORT_CHANGE_COPY.partialRun],
    ['scoped-run', null, REPORT_CHANGE_COPY.scopedRun],
  ] as const)('explains an unavailable %s comparison (previous run %o) without a class suffix', (reason, previousRun, expected) => {
    render(<VisibilityReportView report={headlineReport({ comparison: { state: 'unavailable', reason, previousRun } })} onSelectionChange={() => {}} />)
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) {
      expect(cell(label)).toEqual([...FIGURES[label], [expected, 'text-sm text-secondary']])
    }
    expect(expected).not.toContain('·')
  })

  it('prints no change line when no sweep is selected', () => {
    render(<VisibilityReportView report={headlineReport({ runId: null, comparison: { state: 'unavailable', reason: 'no-selected-run', previousRun: null } })} onSelectionChange={() => {}} />)
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) expect(cell(label)).toEqual(FIGURES[label])
  })

  it('prints a line only for a missing previous value, not for an unavailable or inapplicable current value', () => {
    const comparison: VisibilityReportComparison = {
      state: 'available',
      previousRun: PREVIOUS_RUN,
      mentionCoverage: { state: 'unavailable', reason: 'previous-unavailable' },
      citationCoverage: { state: 'unavailable', reason: 'current-unavailable' },
      propertyReach: { state: 'unavailable', reason: 'not-applicable' },
    }
    render(<VisibilityReportView report={headlineReport({ comparison })} onSelectionChange={() => {}} />)
    expect(cell(MENTION_LABEL)).toEqual([...FIGURES[MENTION_LABEL], [REPORT_CHANGE_COPY.previousUnavailable, 'text-sm text-secondary']])
    expect(cell(CITATION_LABEL)).toEqual(FIGURES[CITATION_LABEL])
    expect(cell(REACH_LABEL)).toEqual(FIGURES[REACH_LABEL])
  })

  it('prints no change line when the server omits comparison', () => {
    render(<VisibilityReportView report={headlineReport()} onSelectionChange={() => {}} />)
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) expect(cell(label)).toEqual(FIGURES[label])
  })

  it('shows the reason for a null rate and never a change line beside it', () => {
    render(<VisibilityReportView report={headlineReport({ summary: { mentionCoverage: NOT_MEASURED }, comparison: { state: 'unavailable', reason: 'no-previous-run', previousRun: null } })} onSelectionChange={() => {}} />)
    expect(cell(MENTION_LABEL)).toEqual([['Not measured', REASON_CLASS]])
    expect(cell(CITATION_LABEL)).toEqual([...FIGURES[CITATION_LABEL], [REPORT_CHANGE_COPY.noPreviousRun, 'text-sm text-secondary']])
  })

  it('renders exactly two cells for a Property scope', () => {
    // A Property scope has no Property reach, so the server marks that change not applicable.
    const comparison: VisibilityReportComparison = { ...MOVED, propertyReach: { state: 'unavailable', reason: 'not-applicable' } }
    render(<VisibilityReportView report={headlineReport({ scope: 'property', comparison })} onSelectionChange={() => {}} />)
    expect(strip().children).toHaveLength(2)
    expect(strip().dataset.columns).toBe('2')
    expect(within(strip()).getAllByText(/answers$/, { selector: 'dt span' }).map(term => term.textContent)).toEqual(['Mentioned answers', 'Cited answers'])
    expect(within(strip()).queryByText(REACH_LABEL)).toBeNull()
    expect(cell('Mentioned answers').at(-1)).toEqual([REPORT_CHANGE_COPY.down('8.3', PREVIOUS_DATE, 'non-brand queries'), 'text-sm text-negative'])
  })

  it.each([
    [12, 36, 'non-brand', '12 non-brand queries · 36 answers'],
    [1, 1, 'branded', '1 branded query · 1 answer'],
    [1, 2, 'unknown', '1 unclassified query · 2 answers'],
    [2, 1, 'unknown', '2 unclassified queries · 1 answer'],
  ] as const)('captions %i queries and %i answers for the %s class', (queryCount, answerCount, queryClass, caption) => {
    render(<VisibilityReportView report={headlineReport({ queryClass, queryCount, answerCount })} onSelectionChange={() => {}} />)
    const section = screen.getByRole('region', { name: CLASS_LABEL[queryClass], exact: true })
    expect(within(section).getByText(caption)).toBeTruthy()
    expect(within(section).getByRole('button', { name: REPORT_CHANGE_COPY.explanation })).toBeTruthy()
  })

  it('toggles trend series from the checkbox legend without ever emptying the chart', () => {
    render(<VisibilityReportView report={headlineReport({ comparison: MOVED })} onSelectionChange={() => {}} />)
    const legend = screen.getByRole('group', { name: 'Trend legend' })
    const mentioned = within(legend).getByRole('checkbox', { name: 'Mentioned' }) as HTMLInputElement
    const cited = within(legend).getByRole('checkbox', { name: 'Cited' }) as HTMLInputElement
    const chart = screen.getByRole('img', { name: 'Non-brand queries mention and citation trend' })
    expect(within(legend).getAllByRole('checkbox')).toHaveLength(2)
    expect([mentioned.checked, mentioned.disabled, cited.checked, cited.disabled]).toEqual([true, false, true, false])
    expect(chart.getAttribute('data-visible-series')).toBe('mentioned cited')

    fireEvent.click(cited)
    expect(chart.getAttribute('data-visible-series')).toBe('mentioned')
    expect([mentioned.checked, mentioned.disabled, cited.checked, cited.disabled]).toEqual([true, true, false, false])

    fireEvent.click(cited)
    expect(chart.getAttribute('data-visible-series')).toBe('mentioned cited')
    fireEvent.click(mentioned)
    expect(chart.getAttribute('data-visible-series')).toBe('cited')
    expect([mentioned.checked, mentioned.disabled, cited.checked, cited.disabled]).toEqual([false, false, true, true])
  })

  it('draws breakdown bars at the server rate and omits them for a null rate', () => {
    render(<VisibilityReportView report={headlineReport()} onSelectionChange={() => {}} />)
    const breakdown = screen.getByRole('region', { name: 'Scope breakdown' })
    const cells = (name: string) => [...within(breakdown).getByRole('button', { name }).closest('tr')!.querySelectorAll('td')]
    const bar = (td: HTMLElement) => {
      const track = td.querySelector<HTMLElement>('.report-rate-bar')
      const fill = track?.querySelector<HTMLElement>('.report-rate-bar-fill')
      return track ? { track: track.className, fill: fill?.className, width: fill?.style.width } : null
    }

    const [, , groupMentioned, groupCited] = cells('Coastal Maine')
    expect(bar(groupMentioned!)).toEqual({ track: 'report-rate-bar', fill: 'report-rate-bar-fill progress-fill-neutral', width: '66.7%' })
    expect(groupCited!.textContent).toBe('Not measured')
    expect(bar(groupCited!)).toBeNull()

    fireEvent.click(within(breakdown).getByRole('button', { name: 'Properties' }))
    const [, , propertyMentioned, propertyCited] = cells('Harbor House')
    expect(bar(propertyMentioned!)?.width).toBe('75%')
    expect(bar(propertyCited!)?.width).toBe('50%')
  })

  it('orders the strip, trend chart, breakdown, Property outcomes, and query results', () => {
    render(<VisibilityReportView report={headlineReport({ comparison: MOVED })} onSelectionChange={() => {}} />)
    const ordered = [
      strip(),
      screen.getByRole('img', { name: 'Non-brand queries mention and citation trend' }),
      screen.getByRole('region', { name: 'Scope breakdown' }),
      screen.getByText('Property outcomes', { selector: 'summary' }).closest('details')!,
      document.querySelector<HTMLElement>('details[data-query-results="non-brand"]')!,
    ]
    for (const [index, element] of ordered.slice(1).entries()) {
      expect(ordered[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    }
  })
})

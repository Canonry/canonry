import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'
import type { VisibilityReportComparison, VisibilityReportPopulationClass, VisibilityReportRate, VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { CHART_SERIES_COLORS, CHART_TONE } from '../src/components/shared/ChartPrimitives.js'
import { REPORT_CHANGE_COPY, REPORT_CLASS_NOUN, REPORT_HEADLINE_HELP, VisibilityReportView } from '../src/components/project/VisibilityTrendSection.js'

// jsdom lays out no SVG, so each Recharts Line renders as a span carrying the
// props that decide what is drawn: its series key, stroke, dash, and dot.
vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const nul = () => null
  return {
    ...actual,
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    CartesianGrid: nul,
    XAxis: nul,
    YAxis: nul,
    Tooltip: nul,
    Line: ({ dataKey, stroke, strokeDasharray, dot }: { dataKey: string; stroke: string; strokeDasharray?: string; dot?: { fill?: string; strokeDasharray?: string } }) =>
      <span data-line={dataKey} data-stroke={stroke} data-dasharray={strokeDasharray ?? ''} data-dot-fill={dot?.fill ?? ''} data-dot-dasharray={dot?.strokeDasharray ?? ''} />,
  }
})

afterEach(cleanup)

// A midday-UTC sweep reads as the same calendar date in every zone from UTC-11 to UTC+11.
const DISPLAYED_RUN_AT = '2026-09-13T12:00:00.000Z'
const PREVIOUS_RUN = { id: 'run-1', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:30:00.000Z' }
/** Same year as the displayed sweep, so the caption drops the year. */
const PREVIOUS_DATE = 'Sep 6'
const EARLIER_YEAR_RUN = { id: 'run-0', createdAt: '2025-12-28T12:00:00.000Z', completedAt: '2025-12-28T12:30:00.000Z' }
const EARLIER_YEAR_DATE = 'Dec 28, 2025'
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
  mode?: 'simple' | 'advanced'
  queryClass?: VisibilityReportPopulationClass
  scope?: 'project' | 'property'
  runId?: string | null
  queryCount?: number
  answerCount?: number
  summary?: Partial<typeof CURRENT>
  comparison?: VisibilityReportComparison
}

function headlineReport({ mode = 'advanced', queryClass = 'non-brand', scope = 'project', runId = 'run-2', queryCount = 12, answerCount = 36, summary, comparison }: FixtureOptions = {}): VisibilityReportResponse {
  const provenance = mode === 'advanced' ? { kind: 'frozen-advanced' as const, definitionRevision: 2 } : { kind: 'frozen-simple' as const, definitionRevision: null }
  const scopeOptions = [
    { id: 'project', label: 'Whole site', kind: 'project' as const, targetCount: 12 },
    { id: 'coastal-maine', label: 'Coastal Maine', kind: 'group' as const, targetCount: 4 },
    { id: 'harbor-house', label: 'Harbor House', kind: 'property' as const, targetCount: 1 },
  ]
  const rates = { ...CURRENT, ...(scope === 'property' || mode === 'simple' ? { propertyReach: NOT_APPLICABLE } : {}), ...summary }
  const previousAt = comparison?.previousRun?.createdAt ?? PREVIOUS_RUN.createdAt
  // Parsed so every fixture is a response the server could send, including the delta invariant.
  return visibilityReportResponseSchema.parse({
    selection: {
      mode, queryClass, scope: scopeOptions.find(option => option.kind === scope)!,
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: mode === 'advanced' ? 2 : null, run: { id: runId, explicit: false }, provenance,
      measurement: { state: 'measured', activeRevision: mode === 'advanced' ? 2 : null, measuredRevision: mode === 'advanced' ? 2 : null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-13T12:30:00.000Z' },
      availability: { state: 'available' },
    },
    scopeOptions,
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'all' }] },
    populations: [{
      queryClass,
      summary: { queryCount, answerCount, ...rates, outcomes: { bothSignals: 12, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 12 } },
      trend: [
        { runId: 'run-1', createdAt: previousAt, revision: mode === 'advanced' ? 2 : null, provenance, queryCount, answerCount, mentionCoverage: rate(27, 36), citationCoverage: rate(18, 36), continuity: { state: 'first', comparedRunId: null } },
        { runId: 'run-2', createdAt: DISPLAYED_RUN_AT, revision: mode === 'advanced' ? 2 : null, provenance, queryCount, answerCount, mentionCoverage: rates.mentionCoverage, citationCoverage: rates.citationCoverage, continuity: { state: 'comparable', comparedRunId: 'run-1' } },
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

/** The tile whose label is `label`, as its own element. */
function tile(label: string, queryClass: VisibilityReportPopulationClass = 'non-brand'): HTMLElement {
  return within(strip(queryClass)).getByText(label, { selector: 'dt span' }).closest('div')!
}

/** Every `dd` in that tile, as [text, exact class list]. */
function cell(label: string, queryClass: VisibilityReportPopulationClass = 'non-brand'): Array<[string, string]> {
  return [...tile(label, queryClass).querySelectorAll('dd')].map(definition => [definition.textContent ?? '', definition.className])
}

/** The value row's own spans: the rate, its screen-reader class suffix, then any change. */
function valueRow(label: string, queryClass: VisibilityReportPopulationClass = 'non-brand'): Array<[string, string]> {
  const value = tile(label, queryClass).querySelector('dd')!
  return [...value.children].map(part => [part.textContent ?? '', part.className])
}

/** What a sighted reader sees: the same text with every screen-reader-only span removed. */
function visibleText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove()
  return copy.textContent ?? ''
}

function section(queryClass: VisibilityReportPopulationClass = 'non-brand'): HTMLElement {
  return screen.getByRole('region', { name: CLASS_LABEL[queryClass], exact: true })
}

function caption(queryClass: VisibilityReportPopulationClass = 'non-brand'): string {
  return section(queryClass).querySelector('.report-headline-caption')!.textContent ?? ''
}

const MENTION_LABEL = 'Answers mentioning a property'
const CITATION_LABEL = 'Answers citing a property'
const REACH_LABEL = 'Properties mentioned'
const SR_CLASS_SUFFIX = ` · ${REPORT_CLASS_NOUN['non-brand']}`
const FIGURES = {
  [MENTION_LABEL]: ['66.7%', '24 of 36 answers'],
  [CITATION_LABEL]: ['66.7%', '24 of 36 answers'],
  [REACH_LABEL]: ['100%', '12 of 12 properties'],
} satisfies Record<string, [string, string]>

/** The two `dd`s of a tile with no change beside its value. */
function figure(label: keyof typeof FIGURES, queryClass: VisibilityReportPopulationClass = 'non-brand'): Array<[string, string]> {
  const [value, detail] = FIGURES[label]
  return [[`${value} · ${REPORT_CLASS_NOUN[queryClass]}`, 'report-headline-value'], [detail, DETAIL_CLASS]]
}

describe('headline strip', () => {
  it('pins the change words, class nouns and tile help', () => {
    expect(REPORT_CLASS_NOUN).toEqual({ 'non-brand': 'non-brand queries', branded: 'branded queries', unknown: 'unclassified queries' })
    expect(REPORT_CHANGE_COPY.up('8.3')).toBe('Up 8.3 pts')
    expect(REPORT_CHANGE_COPY.down('8.3')).toBe('Down 8.3 pts')
    expect(REPORT_CHANGE_COPY.none).toBe('No change')
    expect(REPORT_CHANGE_COPY.previousUnavailable).toBe('No earlier value')
    expect(REPORT_CHANGE_COPY.comparedWith(PREVIOUS_DATE)).toBe('vs Sep 6 sweep')
    expect(REPORT_CHANGE_COPY.noPreviousRun).toBe('No earlier sweep to compare')
    expect(REPORT_CHANGE_COPY.definitionChanged(PREVIOUS_DATE)).toBe('Not compared: setup changed since Sep 6')
    expect(REPORT_CHANGE_COPY.definitionChanged(null)).toBe('Not compared: setup changed')
    expect(REPORT_CHANGE_COPY.modelChanged(PREVIOUS_DATE)).toBe('Not compared: engines or models changed since Sep 6')
    expect(REPORT_CHANGE_COPY.modelChanged(null)).toBe('Not compared: engines or models changed')
    expect(REPORT_CHANGE_COPY.legacyUnknown).toBe('Not compared: older sweep lacks comparison details')
    expect(REPORT_CHANGE_COPY.partialRun).toBe('Not compared: a sweep was incomplete')
    expect(REPORT_CHANGE_COPY.scopedRun).toBe('Not compared: this sweep covered part of the project')
    expect(REPORT_CHANGE_COPY.explanation).toBe('Change compares this sweep with the sweep before it when both completed and used the same setup, engines and models.')
    // Mention reads the answer text and Cited reads the source links, in both modes.
    expect(REPORT_HEADLINE_HELP.simpleMention).toBe('Mentioned counts answers naming your brand in the answer text, not in the source links.')
    expect(REPORT_HEADLINE_HELP.simpleCitation).toBe('Cited counts answers linking to your site in the sources behind the answer, not in the answer text.')
    expect(REPORT_HEADLINE_HELP.advancedMention).toBe('An answer counts when it mentions any assigned property. This does not mean every property was mentioned.')
    expect(REPORT_HEADLINE_HELP.advancedCitation).toBe('An answer counts when it cites a matching URL for any assigned property. This does not mean every property was cited.')
    // Server truth: eligible = the property has a name to match (`mentionEligible`),
    // reach counts a property once across its answers, and one unknown property
    // makes the whole rate unavailable rather than partial.
    expect(REPORT_HEADLINE_HELP.propertyReach).toBe('Selected properties named in at least one measured answer, out of the selected properties that have a name to match on. It counts properties, not answers, and shows no rate while any of those properties is unmeasured.')
  })

  it('renders separate tiles with the change inline beside each value', () => {
    render(<VisibilityReportView report={headlineReport({ comparison: MOVED })} onSelectionChange={() => {}} />)
    expect(strip().tagName).toBe('DL')
    expect(strip().children).toHaveLength(3)
    expect(strip().dataset.columns).toBe('3')
    // One quiet surface per tile: the strip itself carries no shared frame.
    expect(strip().className).toBe('report-headline mt-3')
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) {
      expect(tile(label).className).toBe('report-headline-tile')
    }
    expect(valueRow(MENTION_LABEL)).toEqual([['66.7%', VALUE_CLASS], [SR_CLASS_SUFFIX, 'sr-only'], ['Down 8.3 pts', 'text-sm text-negative']])
    expect(valueRow(CITATION_LABEL)).toEqual([['66.7%', VALUE_CLASS], [SR_CLASS_SUFFIX, 'sr-only'], ['Up 16.7 pts', 'text-sm text-positive']])
    expect(valueRow(REACH_LABEL)).toEqual([['100%', VALUE_CLASS], [SR_CLASS_SUFFIX, 'sr-only'], ['No change', 'text-sm text-secondary']])
    // One supporting line under the value, and nothing else.
    expect(cell(REACH_LABEL).map(([, className]) => className)).toEqual(['report-headline-value', DETAIL_CLASS])
    expect(cell(REACH_LABEL).at(-1)).toEqual(['12 of 12 properties', DETAIL_CLASS])
    expect(screen.queryByText('Queries measured')).toBeNull()
  })

  it('reads a change under 0.05 points as <0.1 in its own direction', () => {
    const comparison: VisibilityReportComparison = {
      ...MOVED,
      mentionCoverage: change(CURRENT.mentionCoverage, rate(2399, 3600)),
      citationCoverage: change(CURRENT.citationCoverage, rate(2401, 3600)),
    }
    render(<VisibilityReportView report={headlineReport({ comparison })} onSelectionChange={() => {}} />)
    expect(valueRow(MENTION_LABEL).at(-1)).toEqual(['Up <0.1 pts', 'text-sm text-positive'])
    expect(valueRow(CITATION_LABEL).at(-1)).toEqual(['Down <0.1 pts', 'text-sm text-negative'])
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
    expect(valueRow(MENTION_LABEL).at(-1)).toEqual([REPORT_CHANGE_COPY.previousUnavailable, 'text-sm text-secondary'])
    expect(cell(CITATION_LABEL)).toEqual(figure(CITATION_LABEL))
    expect(cell(REACH_LABEL)).toEqual(figure(REACH_LABEL))
  })

  it('names the comparison once in the caption and never in a tile', () => {
    render(<VisibilityReportView report={headlineReport({ comparison: MOVED })} onSelectionChange={() => {}} />)
    expect(caption()).toBe(`12 queries · 36 answers · vs ${PREVIOUS_DATE} sweep`)
    expect(within(section()).getByRole('button', { name: REPORT_CHANGE_COPY.explanation })).toBeTruthy()
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) {
      expect(visibleText(tile(label))).not.toContain('vs ')
    }
  })

  it('keeps the year on a previous sweep from another year', () => {
    const comparison: VisibilityReportComparison = { ...MOVED, previousRun: EARLIER_YEAR_RUN }
    render(<VisibilityReportView report={headlineReport({ comparison })} onSelectionChange={() => {}} />)
    expect(caption()).toBe(`12 queries · 36 answers · vs ${EARLIER_YEAR_DATE} sweep`)
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
  ] as const)('captions an unavailable %s comparison (previous run %o) in place of the sweep date', (reason, previousRun, expected) => {
    render(<VisibilityReportView report={headlineReport({ comparison: { state: 'unavailable', reason, previousRun } })} onSelectionChange={() => {}} />)
    expect(caption()).toBe(`12 queries · 36 answers · ${expected}`)
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) expect(cell(label)).toEqual(figure(label))
  })

  it('captions no comparison at all when no sweep is selected', () => {
    render(<VisibilityReportView report={headlineReport({ runId: null, comparison: { state: 'unavailable', reason: 'no-selected-run', previousRun: null } })} onSelectionChange={() => {}} />)
    expect(caption()).toBe('12 queries · 36 answers')
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) expect(cell(label)).toEqual(figure(label))
  })

  it('captions no comparison when the server omits it', () => {
    render(<VisibilityReportView report={headlineReport()} onSelectionChange={() => {}} />)
    expect(caption()).toBe('12 queries · 36 answers')
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) expect(cell(label)).toEqual(figure(label))
  })

  it('shows the reason for a null rate and never a change beside it', () => {
    // A null current rate has no available change, so the server marks that metric unavailable.
    const comparison: VisibilityReportComparison = { ...MOVED, mentionCoverage: { state: 'unavailable', reason: 'current-unavailable' } }
    render(<VisibilityReportView report={headlineReport({ summary: { mentionCoverage: NOT_MEASURED }, comparison })} onSelectionChange={() => {}} />)
    expect(cell(MENTION_LABEL)).toEqual([[`Not measured · ${REPORT_CLASS_NOUN['non-brand']}`, REASON_CLASS]])
    expect(valueRow(CITATION_LABEL).at(-1)).toEqual(['Up 16.7 pts', 'text-sm text-positive'])
  })

  it.each([
    [12, 36, 'non-brand', '12 queries · 36 answers'],
    [1, 1, 'branded', '1 query · 1 answer'],
    [1, 2, 'unknown', '1 query · 2 answers'],
    [2, 1, 'unknown', '2 queries · 1 answer'],
  ] as const)('captions %i queries and %i answers for the %s class without naming the class', (queryCount, answerCount, queryClass, expected) => {
    render(<VisibilityReportView report={headlineReport({ queryClass, queryCount, answerCount })} onSelectionChange={() => {}} />)
    expect(caption(queryClass)).toBe(expected)
  })

  it.each(['non-brand', 'branded', 'unknown'] as const)('shows the %s class in the heading and keeps it in each tile for screen readers', queryClass => {
    render(<VisibilityReportView report={headlineReport({ queryClass, comparison: MOVED })} onSelectionChange={() => {}} />)
    const noun = REPORT_CLASS_NOUN[queryClass]
    expect(within(section(queryClass)).getByRole('heading', { level: 2, name: CLASS_LABEL[queryClass] })).toBeTruthy()
    expect(caption(queryClass)).not.toContain(noun.split(' ')[0])
    for (const label of [MENTION_LABEL, CITATION_LABEL, REACH_LABEL] as const) {
      const cellTile = tile(label, queryClass)
      expect([...cellTile.querySelectorAll('.sr-only')].map(node => node.textContent)).toEqual([` · ${noun}`])
      expect(cellTile.querySelector('dd')!.textContent).toContain(` · ${noun}`)
      expect(visibleText(cellTile)).not.toContain(noun)
    }
  })

  it.each([
    ['advanced aggregate', { mode: 'advanced', scope: 'project' } as const, [[MENTION_LABEL, 'advancedMention'], [CITATION_LABEL, 'advancedCitation'], [REACH_LABEL, 'propertyReach']] as const],
    ['advanced property', { mode: 'advanced', scope: 'property' } as const, [['Mentioned answers', 'advancedMention'], ['Cited answers', 'advancedCitation']] as const],
    ['simple', { mode: 'simple', scope: 'project' } as const, [['Mentioned answers', 'simpleMention'], ['Cited answers', 'simpleCitation']] as const],
  ])('gives every %s tile label its own help button', (_name, options, expected) => {
    const comparison: VisibilityReportComparison = { ...MOVED, propertyReach: { state: 'unavailable', reason: 'not-applicable' } }
    render(<VisibilityReportView report={headlineReport({ ...options, comparison: options.scope === 'property' || options.mode === 'simple' ? comparison : MOVED })} onSelectionChange={() => {}} />)
    expect(strip().children).toHaveLength(expected.length)
    expect(strip().dataset.columns).toBe(String(expected.length))
    for (const [label, help] of expected) {
      expect(within(tile(label)).getByRole('button', { name: REPORT_HEADLINE_HELP[help] })).toBeTruthy()
    }
  })

  it('renders exactly two tiles for a Property scope', () => {
    // A Property scope has no Property reach, so the server marks that change not applicable.
    const comparison: VisibilityReportComparison = { ...MOVED, propertyReach: { state: 'unavailable', reason: 'not-applicable' } }
    render(<VisibilityReportView report={headlineReport({ scope: 'property', comparison })} onSelectionChange={() => {}} />)
    expect(strip().children).toHaveLength(2)
    expect(strip().dataset.columns).toBe('2')
    expect(within(strip()).getAllByText(/answers$/, { selector: 'dt span' }).map(term => term.textContent)).toEqual(['Mentioned answers', 'Cited answers'])
    expect(within(strip()).queryByText(REACH_LABEL)).toBeNull()
    expect(valueRow('Mentioned answers').at(-1)).toEqual(['Down 8.3 pts', 'text-sm text-negative'])
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

  it('omits an unchecked series from every continuity segment and draws Cited dashed with hollow dots', () => {
    const report = headlineReport({ comparison: MOVED })
    // A model change between the two sweeps splits the trend into two segments.
    report.populations[0]!.trend[1]!.continuity = { state: 'model-changed', comparedRunId: 'run-1' }
    render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
    const chart = screen.getByRole('img', { name: 'Non-brand queries mention and citation trend' })
    const lines = () => [...chart.querySelectorAll<HTMLElement>('[data-line]')].map(line => ({ ...line.dataset }))
    const mentioned = (segment: number) => ({ line: `mentioned-${segment}`, stroke: CHART_SERIES_COLORS[1], dasharray: '', dotFill: CHART_SERIES_COLORS[1], dotDasharray: '' })
    const cited = (segment: number) => ({ line: `cited-${segment}`, stroke: CHART_TONE.positive, dasharray: '6 4', dotFill: 'var(--chart-tooltip-bg)', dotDasharray: 'none' })
    expect(lines()).toEqual([mentioned(0), cited(0), mentioned(1), cited(1)])

    const legend = screen.getByRole('group', { name: 'Trend legend' })
    fireEvent.click(within(legend).getByRole('checkbox', { name: 'Cited' }))
    expect(lines()).toEqual([mentioned(0), mentioned(1)])

    fireEvent.click(within(legend).getByRole('checkbox', { name: 'Cited' }))
    fireEvent.click(within(legend).getByRole('checkbox', { name: 'Mentioned' }))
    expect(lines()).toEqual([cited(0), cited(1)])
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

import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { VisibilityReportView, VisibilityResultsToolbar } from '../src/components/project/VisibilityTrendSection.js'
import { formatObservedInstantLabel, observedInstant } from '../src/components/shared/ChartPrimitives.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'

afterEach(cleanup)

function fixture(kind: 'project' | 'group' | 'property' = 'project'): VisibilityReportResponse {
  const rate = { numerator: 4, denominator: 4, rate: 1 }
  const scope = { id: kind === 'project' ? 'project' : kind === 'group' ? 'metro-alpha' : 'p1', label: kind === 'project' ? 'Whole site' : kind === 'group' ? 'Metro Alpha' : 'Northstar One', kind, targetCount: kind === 'property' ? 1 : 15 }
  const row = { queryCount: 2, mentionCoverage: rate, citationCoverage: rate }
  return {
    selection: {
      mode: 'advanced', queryClass: 'non-brand', scope,
      provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: 2, run: { id: 'run-2', explicit: false },
      provenance: { kind: 'frozen-advanced', definitionRevision: 2 },
      measurement: { state: 'measured', activeRevision: 3, measuredRevision: 2, awaitingSweep: true, pendingAssignmentCount: 15, completedAt: '2026-09-01T10:00:00Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: 15 },
      { id: 'metro-alpha', label: 'Metro Alpha', kind: 'group', targetCount: 15 },
      { id: 'market-alpha', label: 'Metro Alpha', kind: 'market', targetCount: 15 },
      { id: 'p1', label: 'Northstar One', kind: 'property', targetCount: 1 },
    ],
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'none' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: { queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, propertyReach: { numerator: 15, denominator: 15, rate: 1 }, outcomes: { bothSignals: 15, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 15 } },
      trend: [{ runId: 'run-2', createdAt: '2026-09-01T10:00:00Z', revision: 2, provenance: { kind: 'frozen-advanced', definitionRevision: 2 }, queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, continuity: { state: 'first', comparedRunId: null } }],
      queries: { items: [], total: 0, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
      competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
      breakdown: { groups: [{ ...row, id: 'metro-alpha', label: 'Metro Alpha' }], properties: [{ ...row, id: 'p1', label: 'Northstar One' }] },
    }],
  }
}

test('labels aggregate answer coverage separately from property reach and explains the chart', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  expect(screen.getByText('Answers mentioning a property')).toBeTruthy()
  expect(screen.getByText('Answers citing a property')).toBeTruthy()
  expect(screen.getByText('Properties mentioned')).toBeTruthy()
  const legend = screen.getByRole('group', { name: 'Trend legend' })
  expect(within(legend).getAllByRole('checkbox')).toHaveLength(2)
  expect((within(legend).getByRole('checkbox', { name: 'Mentioned' }) as HTMLInputElement).checked).toBe(true)
  expect((within(legend).getByRole('checkbox', { name: 'Cited' }) as HTMLInputElement).checked).toBe(true)
  const outcomes = screen.getByText('Property outcomes', { selector: 'summary > span' }).closest('details')!
  expect(outcomes.open).toBe(false)
  expect(screen.queryByText('Trend data and comparability')).toBeNull()
  const data = screen.getByRole('table', { name: 'Non-brand queries trend data' })
  expect(data.parentElement!.classList.contains('sr-only')).toBe(true)
  expect(within(data).getAllByRole('row')).toHaveLength(2)
  expect(screen.getByText('First measurement. A trend appears after another comparable run.')).toBeTruthy()
  const trend = screen.getByRole('img', { name: /mention and citation trend/ })
  const breakdown = screen.getByRole('region', { name: 'Scope breakdown' })
  expect(trend.compareDocumentPosition(breakdown) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(breakdown.compareDocumentPosition(outcomes) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
})

/**
 * The whole explanation, asserted verbatim. It is the accessible name of the
 * trigger, so a screen reader user and a sighted user read the same sentence.
 */
const OUTCOMES_HELP = "Counts properties, not answers. The buckets do not overlap and add up to the total. Cited only means the engine used the property's page as a source without naming it in the answer. Not measured covers a property with no eligible completed measurement, and one where only one of the two signals was measured: calling that mentioned but not cited would assert an absence nothing measured. Neither signal means both were measured and neither was found. One verified mention or citation stands, and a later uncertain answer cannot erase it."

function outcomesDisclosure() {
  return screen.getByText('Property outcomes', { selector: 'summary > span' }).closest('details')!
}

test('Property outcomes counts properties from the server total and keeps its explanation out of the summary', () => {
  const report = fixture()
  // Five distinct counts, so each label is pinned to its own server key and a
  // rotated tuple list cannot pass. They deliberately do not sum to the total:
  // the response schema forbids that drift, which is the point — the count must
  // be the server's own `total`, never a sum the UI computed for itself.
  report.populations[0]!.summary.outcomes = { bothSignals: 5, mentionedOnly: 4, citedOnly: 3, neither: 2, notMeasured: 1, total: 12 }
  render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
  const outcomes = outcomesDisclosure()
  const summary = outcomes.querySelector('summary')!
  expect(within(summary).getByText('12 properties')).toBeTruthy()

  // Every bucket keeps its label, its order, and its own server count.
  expect([...outcomes.querySelectorAll('strong')].map(count => [count.textContent, count.nextElementSibling?.textContent])).toEqual([
    ['5', 'mentioned and cited'],
    ['4', 'mentioned only'],
    ['3', 'cited only'],
    ['2', 'neither signal'],
    ['1', 'not measured'],
  ])

  // A button inside a <summary> toggles the disclosure when clicked and joins
  // the summary's accessible name, so the explanation lives in the panel.
  const help = within(outcomes).getByRole('button', { name: OUTCOMES_HELP, hidden: true })
  expect(help.closest('summary')).toBeNull()
  expect(summary.querySelector('button')).toBeNull()
})

/**
 * `citedOnly` is reached only on `mention === false && citation === true`, and
 * neither `targetPresence` nor `outcomeCounts` reads a competitor signal. The
 * copy may therefore say the property was cited and not named; it must not say
 * a rival was recommended instead, because this partition measured no rival.
 */
test('the outcomes explanation claims no competitor finding the buckets never measure', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  const help = within(outcomesDisclosure()).getByRole('button', { name: OUTCOMES_HELP, hidden: true })
  expect(help.getAttribute('aria-label')).not.toMatch(/recommend|somebody else|competitor|rival/i)
})

/**
 * The collapsed rows at the foot of the tab came from two components and read
 * as two designs: bold labels with counts in 64px rows here, small quiet labels
 * in 44px rows on the project page, a gap in the middle of the stack, and a
 * focus ring on only some of them. One shared row keeps them one list.
 */
test('the report detail rows share one disclosure row pattern', () => {
  render(<VisibilityReportView report={fixture()} onSelectionChange={() => {}} />)
  const rows = [...document.querySelectorAll('details.visibility-disclosure')]
  expect(rows.map(row => row.querySelector('.visibility-disclosure-label')?.textContent)).toEqual(['Property outcomes', 'Query results', 'Competitors'])
  for (const row of rows) {
    // The row carries no utilities of its own: drift lands in the stylesheet,
    // where the compiled-rule test in design-tokens.test.ts can see it.
    expect(row.querySelector('summary')!.className).toBe('visibility-disclosure-summary')
    expect(row.querySelector('summary > .visibility-disclosure-meta')).toBeTruthy()
    // Every opened panel pays its bottom space through the same class.
    expect(row.querySelector('summary + .visibility-disclosure-panel')).toBeTruthy()
  }
})

test('a single property reads as one property', () => {
  const report = fixture()
  report.populations[0]!.summary.outcomes = { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 }
  render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
  expect(within(outcomesDisclosure().querySelector('summary')!).getByText('1 property')).toBeTruthy()
})

test('a group opens its properties while a property avoids a redundant group summary', () => {
  const { rerender } = render(<VisibilityReportView report={fixture('group')} onSelectionChange={() => {}} />)
  const breakdown = screen.getByRole('region', { name: 'Scope breakdown' })
  expect(within(breakdown).getByRole('button', { name: 'Northstar One' })).toBeTruthy()
  expect(within(breakdown).queryByRole('button', { name: 'Metro Alpha' })).toBeNull()
  rerender(<VisibilityReportView report={fixture('property')} onSelectionChange={() => {}} />)
  expect(screen.queryByRole('region', { name: 'Scope breakdown' })).toBeNull()
})

test('keeps the dated measured report unchanged when future assignments are pending', () => {
  const report = fixture()
  const current = structuredClone(report)
  current.selection.measurement.activeRevision = current.selection.measurement.measuredRevision
  current.selection.measurement.awaitingSweep = false
  current.selection.measurement.pendingAssignmentCount = 0
  const props = { onSelectionChange: () => {} }
  const { container, rerender } = render(<VisibilityReportView report={current} {...props} />)
  const measuredView = container.innerHTML
  rerender(<VisibilityReportView report={report} {...props} />)
  expect(container.innerHTML).toBe(measuredView)
  cleanup()

  // The results toolbar is the dated header, and pending assignments leave it unchanged too.
  const selection = parseVisibilitySelection({ queryClass: 'non-brand' })
  const toolbar = render(<VisibilityResultsToolbar report={current} selection={selection} {...props} />)
  const measuredToolbar = toolbar.container.innerHTML
  expect(within(toolbar.container).getByText(formatObservedInstantLabel(observedInstant(current.selection.measurement.completedAt!)), { selector: 'span' })).toBeTruthy()
  toolbar.rerender(<VisibilityResultsToolbar report={report} selection={selection} {...props} />)
  expect(toolbar.container.innerHTML).toBe(measuredToolbar)
})

test.each(['simple', 'advanced'] as const)('keeps %s comparison warnings beside the chart with accessible history', mode => {
  const report = fixture()
  report.selection.mode = mode
  const population = report.populations[0]!
  const first = population.trend[0]!
  population.trend.push(...(['definition-changed', 'model-changed', 'legacy-unknown'] as const).map((state, index) => ({ ...first, runId: `run-${index + 3}`, createdAt: `2026-09-0${index + 2}T10:00:00Z`, continuity: { state, comparedRunId: first.runId } })))
  render(<VisibilityReportView report={report} onSelectionChange={() => {}} />)
  const chart = screen.getByRole('img', { name: /mention and citation trend/ })
  const description = document.getElementById(chart.getAttribute('aria-describedby')!)!
  expect(description.textContent).toContain('Gaps mark changes to what was measured.')
  expect(description.textContent).toContain('Gaps mark changes to answer engines or models.')
  expect(description.textContent).toContain('Older runs lack the details needed for comparison.')
  const data = screen.getByRole('table', { name: 'Non-brand queries trend data' })
  expect(within(data).getAllByRole('row')).toHaveLength(5)
})

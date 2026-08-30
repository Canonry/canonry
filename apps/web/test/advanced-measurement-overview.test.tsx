import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MeasurementPortfolioSummaryResponse } from '@ainyc/canonry-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AdvancedMeasurementOverview,
  type AdvancedMeasurementMetric,
  type AdvancedMeasurementOverviewProps,
  type AdvancedMeasurementOverviewReport,
  type AdvancedMeasurementProperty,
} from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'

afterEach(cleanup)

function ratio(numerator: number, denominator: number): AdvancedMeasurementMetric {
  return { numerator, denominator }
}

function unavailable(reason: string): AdvancedMeasurementMetric {
  return { numerator: null, denominator: null, reason }
}

function portfolioSummary(): MeasurementPortfolioSummaryResponse {
  const coverage = { state: 'available' as const, value: 0.5, numerator: 1, denominator: 2 }
  return {
    portfolio: { groupKey: null, label: null, measurementScope: 'full' },
    measurement: {
      state: 'complete',
      displayedRunId: 'run-1',
      planRevision: 2,
      completedAt: '2026-08-02T12:00:00.000Z',
    },
    queryClass: 'non-brand',
    metrics: {
      propertiesMentioned: { state: 'available', value: 1, numerator: 1, denominator: 2, rate: 0.5 },
      mentionCoverage: coverage,
      citationCoverage: coverage,
    },
    weakestProperties: [],
    markets: [],
    totalProperties: 2,
    truncated: false,
  }
}

function property(
  id: string,
  name: string,
  overrides: Partial<AdvancedMeasurementProperty> = {},
): AdvancedMeasurementProperty {
  return {
    id,
    name,
    mentionCoverage: ratio(3, 4),
    citationCoverage: ratio(2, 4),
    status: { label: 'Measured', tone: 'positive' },
    assignedQueries: ['best office space downtown'],
    urls: ['https://example.com/downtown'],
    evidence: [
      { id: `${id}-1`, kind: 'this-property', query: 'best office space downtown', url: 'https://example.com/downtown', tone: 'positive' },
      { id: `${id}-2`, kind: 'another-property', query: 'best office space downtown', url: 'https://example.com/uptown', tone: 'caution' },
      { id: `${id}-3`, kind: 'owned-unassigned', query: 'best office space downtown', url: 'https://example.com/other', tone: 'caution' },
      { id: `${id}-4`, kind: 'external', query: 'best office space downtown', url: 'https://rival.example/listing', tone: 'neutral' },
      { id: `${id}-5`, kind: 'multiple-properties', query: 'best office space downtown', url: 'https://example.com/shared', tone: 'caution' },
      { id: `${id}-6`, kind: 'invalid-url', query: 'best office space downtown', url: 'not a URL', tone: 'negative' },
    ],
    ...overrides,
  }
}

function report(overrides: Partial<AdvancedMeasurementOverviewReport> = {}): AdvancedMeasurementOverviewReport {
  const downtown = property('downtown', 'Downtown Office')
  const uptown = property('uptown', 'Uptown Office', {
    mentionCoverage: ratio(1, 4),
    citationCoverage: ratio(1, 4),
  })

  const nonBrand = {
    aggregate: {
      metrics: {
        propertiesMentioned: ratio(3, 4),
        mentionCoverage: ratio(6, 8),
        citationCoverage: ratio(2, 8),
      },
      properties: [downtown, uptown],
    },
    groups: [
      {
        id: 'metro',
        label: 'Metro offices',
        confirmedCompetitorCount: 1,
        aggregate: {
          metrics: {
            propertiesMentioned: ratio(1, 2),
            mentionCoverage: ratio(1, 2),
            citationCoverage: ratio(1, 2),
          },
          properties: [downtown],
          shareOfVoice: [
            { name: 'Example Co.', coverage: ratio(5, 8) },
            { name: 'Rival Co.', coverage: ratio(3, 8) },
          ],
        },
      },
    ],
  }

  const branded = {
    aggregate: {
      metrics: {
        propertiesMentioned: ratio(2, 2),
        mentionCoverage: ratio(7, 8),
        citationCoverage: ratio(6, 8),
      },
      properties: [downtown, uptown],
    },
    groups: [
      {
        id: 'metro',
        label: 'Metro offices',
        confirmedCompetitorCount: 1,
        aggregate: {
          metrics: {
            propertiesMentioned: ratio(1, 1),
            mentionCoverage: ratio(4, 4),
            citationCoverage: ratio(3, 4),
          },
          properties: [downtown],
          shareOfVoice: [{ name: 'Example Co.', coverage: ratio(4, 4) }],
        },
      },
    ],
  }

  return {
    classReporting: 'available',
    latestMeasurement: {
      status: { label: 'Complete', tone: 'positive' },
      completedSlots: 8,
      totalSlots: 8,
      date: 'Aug 2, 2026',
    },
    overall: nonBrand,
    classScopes: { nonBrand, branded },
    flaggedResults: [{ id: 'flag-1', property: 'Downtown Office', summary: 'One ambiguous source-to-Property match.', tone: 'caution' }],
    ...overrides,
  }
}

/**
 * The base fixture uses the non-brand scope for the legacy `overall` fallback,
 * but a test that overrides
 * `classScopes.nonBrand` replaces only that half — leaving `overall` pointing
 * at the unmodified scope and the override invisible. This keeps the two in
 * step, exactly as the base fixture does.
 */
function syncOverall(r: AdvancedMeasurementOverviewReport): AdvancedMeasurementOverviewReport {
  return r.classScopes ? { ...r, overall: r.classScopes.nonBrand } : r
}

function renderOverviewReturning(overrides: Partial<AdvancedMeasurementOverviewProps> = {}) {
  const props = { report: report(), canEdit: true, ...overrides }
  return render(<AdvancedMeasurementOverview {...props} report={syncOverall(props.report)} />)
}

function renderOverview(overrides: Partial<AdvancedMeasurementOverviewProps> = {}) {
  const onRunMeasurement = vi.fn()
  const onRepublishSetup = vi.fn()
  const props: AdvancedMeasurementOverviewProps = {
    report: report(),
    canEdit: true,
    onRunMeasurement,
    onRepublishSetup,
    ...overrides,
  }
  render(<AdvancedMeasurementOverview {...props} report={syncOverall(props.report)} />)
  return { onRunMeasurement, onRepublishSetup }
}

describe('AdvancedMeasurementOverview', () => {
  // The section counts Properties and nothing else. An assignment-denominated
  // rate beside a Property count is what made the two rows irreconcilable, so
  // the aggregate percentages are gone; per-Property rates stay in the table.
  it('leads with the measurement date and no assignment-denominated rate', () => {
    renderOverview()

    expect(screen.getByText('Aug 2, 2026')).toBeTruthy()
    expect(screen.queryByLabelText('Coverage')).toBeNull()
    expect(screen.queryByText('25%')).toBeNull()
    expect(screen.queryByText('75%')).toBeNull()
  })

  it('keeps unavailable measurements unavailable instead of rendering zero or repeating their reason', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              metrics: {
                ...current.classScopes!.nonBrand.aggregate.metrics,
                mentionCoverage: unavailable('No complete source evidence is available.'),
                citationCoverage: unavailable('No complete source evidence is available.'),
              },
            },
          },
        },
      },
    })

    // The aggregate rates are gone with the hero, so an unavailable aggregate
    // is reported once, in words, on the status line — never as a 0.
    expect(screen.getAllByText('No complete source evidence is available.')).toHaveLength(1)
    expect(screen.queryByText('0 of 0 (0%)')).toBeNull()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('keeps measurement status and the next action on one concise line', () => {
    renderOverview()

    const statusLine = screen.getByLabelText('Measurement status and next action')
    expect(statusLine.textContent).toContain('Complete')
    // A completed measurement's progress slots are always full (8 of 8) and
    // tell the reader nothing, so the strip omits them once the run is done.
    expect(statusLine.textContent).not.toContain('8 of 8')
    expect(statusLine.textContent).not.toContain('slots completed')
    expect(statusLine.textContent).toContain('Aug 2, 2026')
    expect(statusLine.textContent).toContain('1 ambiguous source-to-Property match.')
  })

  it('does not render an unavailable slot denominator as zero', () => {
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          completedSlots: 0,
          totalSlots: 0,
        },
      },
    })

    expect(screen.queryByText('Measurement progress unavailable')).toBeNull()
    expect(screen.queryByText('0 of 0 slots completed')).toBeNull()
  })

  it('swaps to the selected group precomputed aggregate', () => {
    renderOverview()

    fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Metro offices' }))

    // The group holds only Downtown, so the row set is what proves the swap.
    expect(screen.getByRole('button', { name: 'Show details for Downtown Office' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show details for Uptown Office' })).toBeNull()
  })

  it('filters only table rows when searching', () => {
    renderOverview()

    fireEvent.change(screen.getByLabelText('Search properties'), { target: { value: 'uptown' } })

    expect(screen.getByRole('button', { name: 'Show details for Uptown Office' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show details for Downtown Office' })).toBeNull()
    expect(screen.queryByText('Ambiguous matches (1)')).toBeNull()
  })

  it('withholds stale report content while a server view changes', () => {
    renderOverview({ isViewLoading: true })

    expect(screen.getByText('Updating results…')).toBeTruthy()
    expect(screen.queryByText('Complete')).toBeNull()
    expect(screen.queryByText('No action needed.')).toBeNull()
    expect(screen.queryByText('Downtown Office')).toBeNull()
  })

  it('reveals inline drill-down evidence with customer-facing labels', () => {
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))

    expect(screen.getByText('Assigned queries')).toBeTruthy()
    expect(screen.getAllByText('best office space downtown').length).toBeGreaterThan(0)
    expect(screen.getByText('URLs')).toBeTruthy()
    expect(screen.getByText('Matches this Property')).toBeTruthy()
    expect(screen.getByText('Matches another Property')).toBeTruthy()
    expect(screen.getByText('Site URL not included in a Property')).toBeTruthy()
    expect(screen.getByText('External URL')).toBeTruthy()
    expect(screen.getByText('Matches multiple Properties')).toBeTruthy()
    expect(screen.getByText('Invalid URL')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Sibling')
    expect(document.body.textContent).not.toContain('owned-unassigned')
    expect(document.body.textContent).not.toContain('Owned URL without an assignment')
  })

  it('links a Property name to its own page without losing the inline expansion', () => {
    renderOverview({
      // preventDefault keeps jsdom from attempting a real document navigation;
      // the href assertion below is what proves the link was rendered.
      renderPropertyLink: ({ id, name }) => (
        <a href={`/properties/${id}`} onClick={event => event.preventDefault()}>{name}</a>
      ),
    })

    const link = screen.getByRole('link', { name: 'Downtown Office' })
    expect(link.getAttribute('href')).toBe('/properties/downtown')

    // A click on the link must navigate, not toggle the row it sits in.
    fireEvent.click(link)
    expect(screen.queryByText('Assigned queries')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show details for Downtown Office' })).toBeTruthy()
  })

  it('renders the Property name as plain text when no link renderer is supplied', () => {
    renderOverview()

    expect(screen.queryByRole('link', { name: 'Downtown Office' })).toBeNull()
    expect(screen.getAllByText('Downtown Office').length).toBeGreaterThan(0)
  })

  it('expands a Property by clicking anywhere on its row', () => {
    renderOverview()

    const details = screen.getByRole('button', { name: 'Show details for Downtown Office' })
    const row = details.closest('tr')
    expect(row).toBeTruthy()

    fireEvent.click(row!)

    expect(screen.getByText('Assigned queries')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide details for Downtown Office' })).toBeTruthy()
  })

  // Each expansion adds an engine sub-row per provider plus a details panel, so
  // two open at once push the rest of a several-hundred-row table off screen.
  it('opens one Property at a time, collapsing the previously open one', () => {
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))
    expect(screen.getByRole('button', { name: 'Hide details for Downtown Office' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Uptown Office' }))

    expect(screen.getByRole('button', { name: 'Hide details for Uptown Office' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show details for Downtown Office' })).toBeTruthy()
  })

  it('collapses the open Property when it is clicked again, leaving none open', () => {
    renderOverview()

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide details for Downtown Office' }))

    expect(screen.getByRole('button', { name: 'Show details for Downtown Office' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show details for Uptown Office' })).toBeTruthy()
    expect(screen.queryByText('Assigned queries')).toBeNull()
  })

  it('badges bridged property and evidence rows as Historical', () => {
    const current = report()
    const first = current.classScopes!.nonBrand.aggregate.properties[0]!
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              properties: [{
                ...first,
                historical: true,
                evidence: [{ ...first.evidence[0]!, historical: true }],
              }],
            },
          },
        },
      },
    })

    expect(screen.getByText('Historical')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))
    expect(screen.getAllByText('Historical')).toHaveLength(2)
  })

  it('badges bridged history at report level when no cited URL can carry the provenance', () => {
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          includesBridgedHistory: true,
        },
      },
    })

    expect(screen.getByText('Includes historical data')).toBeTruthy()
  })

  it('shows competitor share of voice only for a selected non-brand group', () => {
    renderOverview()

    expect(screen.getByText('Query type')).toBeTruthy()
    expect(screen.queryByText('Brand share of voice')).toBeNull()
    fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Metro offices' }))
    // Share of voice is a NON-BRAND question — a brand's share of its own name
    // is meaningless — so the default All-queries view must not show it.
    expect(screen.queryByText('Brand share of voice')).toBeNull()
    fireEvent.click(within(screen.getByLabelText('Query type')).getByRole('radio', { name: 'Non-brand' }))
    expect(screen.getByText('Brand share of voice')).toBeTruthy()
    expect(screen.getByText('Example Co.')).toBeTruthy()
    expect(screen.getByText('Rival Co.')).toBeTruthy()
    fireEvent.click(within(screen.getByLabelText('Query type')).getByRole('radio', { name: 'Branded' }))
    expect(screen.queryByText('Brand share of voice')).toBeNull()
    expect((screen.getByText('Ambiguous matches (1)').closest('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('hides competitor share of voice when a group has no confirmed competitors', () => {
    const current = report()
    const nonBrand = current.classScopes!.nonBrand
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...nonBrand,
            groups: nonBrand.groups.map(group => ({ ...group, confirmedCompetitorCount: 0 })),
          },
        },
      },
    })

    fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Metro offices' }))
    expect(screen.queryByText('Brand share of voice')).toBeNull()
  })

  // Rates live on the Property rows now that the aggregate hero is gone. An
  // impossible ratio (numerator above denominator) must read as unavailable
  // there rather than as a number somebody could act on.
  it('treats an invalid metric denominator as unavailable', () => {
    const current = report()
    const scope = current.classScopes!.nonBrand
    const [first, ...rest] = scope.aggregate.properties
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...scope,
            aggregate: {
              ...scope.aggregate,
              properties: [{ ...first!, mentionCoverage: { numerator: 2, denominator: 1 } }, ...rest],
            },
          },
        },
      },
    })

    expect(screen.queryByText('2 of 1 (200%)')).toBeNull()
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0)
  })

  it('makes version-one class reporting visibly unavailable and offers republish to editors', () => {
    const { onRepublishSetup } = renderOverview({
      report: {
        ...report(),
        classReporting: 'plan-v1',
        classScopes: undefined,
        latestMeasurement: {
          status: { label: 'Not measured', tone: 'neutral' },
          completedSlots: 0,
          totalSlots: 0,
          date: 'Date unavailable',
        },
      },
    })

    expect(screen.getByText('Setup update required.')).toBeTruthy()
    expect(screen.queryByText('Republish setup to enable Non-brand and Branded reporting.')).toBeNull()
    expect(screen.queryByText('Measurement progress unavailable')).toBeNull()
    expect(screen.queryByText('Date unavailable')).toBeNull()
    // Query type is a radiogroup; while setup needs republishing the whole
    // group and every option inside it are disabled.
    const queryTypeGroup = screen.getByLabelText('Query type')
    expect(queryTypeGroup.getAttribute('aria-disabled')).toBe('true')
    for (const radio of within(queryTypeGroup).getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText('Setup update required.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Republish setup' }))
    expect(onRepublishSetup).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
  })

  it('keeps version-one property coverage rates even while aggregate class metrics are unavailable', () => {
    const current = report()
    const completeProperty = property('complete-office', 'Complete Office', {
      mentionCoverage: ratio(1, 1),
      citationCoverage: ratio(1, 1),
    })
    renderOverview({
      report: {
        ...current,
        classReporting: 'plan-v1',
        classScopes: undefined,
        overall: {
          ...current.overall!,
          aggregate: {
            ...current.overall!.aggregate,
            properties: [completeProperty],
          },
        },
      },
    })

    const propertyRow = screen.getByRole('button', { name: 'Show details for Complete Office' }).closest('tr')
    expect(propertyRow).toBeTruthy()
    expect(within(propertyRow!).getAllByText('1 of 1 (100%)')).toHaveLength(2)
  })

  it('keeps the report visible to viewers without mutation buttons', () => {
    renderOverview({ canEdit: false })

    expect(screen.getAllByText('3 of 4 (75%)').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Republish setup' })).toBeNull()
  })

  it('does not show a disabled or misleading action before the scoped runner is wired', () => {
    renderOverview({ onRunMeasurement: undefined })

    expect(screen.queryByRole('button', { name: 'Run measurement' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Republish setup' })).toBeNull()
  })

  it('guards measurement and republish actions while they are pending', () => {
    const running = render(
      <AdvancedMeasurementOverview
        report={report()}
        canEdit
        isRunningMeasurement
        onRunMeasurement={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Starting measurement…' })).toHaveProperty('disabled', true)
    running.unmount()

    render(
      <AdvancedMeasurementOverview
        report={{ ...report(), classReporting: 'plan-v1', classScopes: undefined }}
        canEdit
        isRepublishingSetup
        onRepublishSetup={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Opening setup…' })).toHaveProperty('disabled', true)
  })

  it('labels every capped property list with its shown and total counts', () => {
    const current = report()
    const properties = Array.from({ length: 51 }, (_, index) => property(`property-${index}`, `Property ${index + 1}`))
    renderOverview({
      report: {
        ...current,
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              properties,
            },
          },
        },
      },
    })

    expect(screen.getByText('Showing 50 of 51')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show all 51 properties' })).toBeTruthy()
  })
})

describe('query type offers every lane the API accepts', () => {
  it('shows All queries, Non-brand, and Branded simultaneously as radio options', () => {
    renderOverview()
    const control = screen.getByLabelText('Query type')
    const radios = within(control).getAllByRole('radio')
    expect(radios.map(radio => radio.textContent)).toEqual(['All queries', 'Non-brand', 'Branded'])
  })

  it('selecting All keeps the control on All rather than snapping back', () => {
    renderOverview()
    const control = screen.getByLabelText('Query type')
    fireEvent.click(within(control).getByRole('radio', { name: 'All queries' }))
    expect(within(control).getByRole('radio', { name: 'All queries' }).getAttribute('aria-checked')).toBe('true')
    expect(within(control).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('false')
  })
})

describe('status strip (defect 1)', () => {
  it('does not render "32 of 32"-style progress once the measurement is complete', () => {
    // The default fixture's latestMeasurement is { label: 'Complete', tone: 'positive', completedSlots: 8, totalSlots: 8 }.
    renderOverview()
    expect(screen.queryByText('8 of 8')).toBeNull()
  })

  it('renders the progress label while a measurement is genuinely in progress', () => {
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          status: { label: 'Running', tone: 'neutral' },
          completedSlots: 5,
          totalSlots: 32,
        },
      },
    })
    expect(screen.getByText('5 of 32')).toBeTruthy()
  })

  it('hides the progress label for a failed measurement even when slots are partially filled', () => {
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          status: { label: 'Failed', tone: 'negative' },
          completedSlots: 5,
          totalSlots: 32,
        },
      },
    })
    expect(screen.queryByText('5 of 32')).toBeNull()
  })

  it('hides the progress label on a FINISHED measurement that carries a warning', () => {
    // The regression this locks: deriving "in progress" from tone alone treats
    // `caution` as running, so a complete-but-warned run printed "32 of 32" —
    // the exact constant the whole change removes. Slots are complete here, so
    // nothing may render regardless of what the tone says.
    renderOverview({
      report: {
        ...report(),
        latestMeasurement: {
          ...report().latestMeasurement,
          status: { label: 'Complete with warnings', tone: 'caution' },
          completedSlots: 32,
          totalSlots: 32,
        },
      },
    })
    expect(screen.queryByText('32 of 32')).toBeNull()
  })

  it('points the row chevron down when collapsed and up when expanded', () => {
    renderOverview()

    // The toggle carries no visible text, so the chevron IS the affordance: an
    // empty button and a button whose icon never turns both leave the row
    // looking inert, and neither is visible to the accessible-name lookups the
    // rest of this suite uses.
    const toggle = screen.getByRole('button', { name: 'Show details for Downtown Office' })
    const chevron = toggle.querySelector('svg')
    expect(chevron).toBeTruthy()
    expect(chevron!.getAttribute('class')).not.toContain('rotate-180')
    // Reduced motion is honoured the way the repo's other chevron is
    // (`.task-center-chevron`), not left to an unguarded transition.
    expect(chevron!.getAttribute('class')).toContain('motion-reduce:transition-none')

    fireEvent.click(toggle)

    const expandedToggle = screen.getByRole('button', { name: 'Hide details for Downtown Office' })
    expect(expandedToggle.querySelector('svg')!.getAttribute('class')).toContain('rotate-180')
  })

  it('never renders "No action needed." — the ToneBadge already says the state is healthy', () => {
    renderOverview({ canEdit: false, report: { ...report(), flaggedResults: [] } })

    expect(screen.queryByText('No action needed.')).toBeNull()
    expect(screen.queryByText(/No action/)).toBeNull()
    // With nothing left to say, the status line is just the badge and the date —
    // no empty/placeholder span takes the old fallback's place.
    const statusLine = screen.getByLabelText('Measurement status and next action')
    expect(statusLine.textContent).toBe('CompleteAug 2, 2026')
  })

  it('renders nextActionText verbatim when the server supplies one', () => {
    renderOverview({ report: { ...report(), nextActionText: 'Finish setup.' } })
    expect(screen.getByText('Finish setup.')).toBeTruthy()
  })

  it('renders the unavailable-properties count with correct singular/plural agreement', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        flaggedResults: [],
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: { ...current.classScopes!.nonBrand.aggregate, unavailablePropertyCount: 2 },
          },
        },
      },
    })
    expect(screen.getByText('2 properties are unavailable.')).toBeTruthy()

    cleanup()
    renderOverview({
      report: {
        ...current,
        flaggedResults: [],
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: { ...current.classScopes!.nonBrand.aggregate, unavailablePropertyCount: 1 },
          },
        },
      },
    })
    expect(screen.getByText('1 property is unavailable.')).toBeTruthy()
  })

  it('names ambiguous source matches with correct singular/plural agreement', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        flaggedResults: [{ id: 'flag-1', property: 'Downtown Office', summary: 'x', tone: 'caution', count: 3 }],
      },
    })
    expect(screen.getByText('3 ambiguous source-to-Property matches.')).toBeTruthy()
  })

  it('falls through to metricReasons.plan_v1 when the setup needs republishing', () => {
    renderOverview({ report: { ...report(), classReporting: 'plan-v1', classScopes: undefined } })
    expect(screen.getByText('Setup update required.')).toBeTruthy()
  })

  it('still surfaces a headline-metric unavailable reason ahead of the unavailable/flagged fallbacks', () => {
    const current = report()
    renderOverview({
      report: {
        ...current,
        flaggedResults: [],
        classScopes: {
          ...current.classScopes!,
          nonBrand: {
            ...current.classScopes!.nonBrand,
            aggregate: {
              ...current.classScopes!.nonBrand.aggregate,
              metrics: {
                ...current.classScopes!.nonBrand.aggregate.metrics,
                mentionCoverage: unavailable('no_completed_run'),
              },
            },
          },
        },
      },
    })
    expect(screen.getByText('Not measured yet.')).toBeTruthy()
  })
})

describe('control row (defect 2)', () => {
  function serverViewReport(overrides: Partial<AdvancedMeasurementOverviewReport> = {}): AdvancedMeasurementOverviewReport {
    const base = report()
    const nonBrand = base.classScopes!.nonBrand
    return {
      ...base,
      currentView: {
        scope: { kind: 'all' },
        queryClass: 'non-brand',
        aggregate: nonBrand.aggregate,
        propertyTotal: nonBrand.aggregate.properties.length,
        nextCursor: null,
      },
      availableGroups: nonBrand.groups.map(group => ({ id: group.id, label: group.label })),
      ...overrides,
    }
  }

  function manyGroups(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `group-${index + 1}`,
      label: `Group ${index + 1}`,
      confirmedCompetitorCount: 0,
      aggregate: {
        metrics: { propertiesMentioned: ratio(1, 1), mentionCoverage: ratio(1, 1), citationCoverage: ratio(1, 1) },
        properties: [],
      },
    }))
  }

  it('renders Query type as a radiogroup wearing the shared segmented skin, with aria-checked state', () => {
    renderOverview()
    const control = screen.getByLabelText('Query type')
    expect(control.getAttribute('role')).toBe('radiogroup')
    // The house classes, not bespoke utilities: `.segmented` / `.segmented-option`
    // are what the GSC, Activity, Visibility-trend and Technical-AEO controls
    // already use, and `.segmented-option` is where the focus-visible ring is
    // defined (styles.css). Asserting the shared class is what stops this
    // control drifting into a second visual language for the same widget.
    expect(control.className).toContain('segmented')
    const allRadio = within(control).getByRole('radio', { name: 'All queries' })
    expect(allRadio.getAttribute('aria-checked')).toBe('true')
    expect(allRadio.className).toContain('segmented-option')
    expect(allRadio.className).toContain('segmented-option-active')
    // An unchecked option wears the base class WITHOUT the active modifier.
    const brandedRadio = within(control).getByRole('radio', { name: 'Branded' })
    expect(brandedRadio.className).toContain('segmented-option')
    expect(brandedRadio.className).not.toContain('segmented-option-active')
    expect(within(control).getByRole('radio', { name: 'Non-brand' }).getAttribute('aria-checked')).toBe('false')
  })

  it('is keyboard operable: an arrow key moves both focus and the checked option', () => {
    renderOverview()
    const control = screen.getByLabelText('Query type')
    const allRadio = within(control).getByRole('radio', { name: 'All queries' })
    const nonBrandRadio = within(control).getByRole('radio', { name: 'Non-brand' })
    expect(allRadio.getAttribute('aria-checked')).toBe('true')

    fireEvent.keyDown(allRadio, { key: 'ArrowRight' })

    expect(nonBrandRadio.getAttribute('aria-checked')).toBe('true')
    expect(allRadio.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(nonBrandRadio)
  })

  it('selecting a Query type option issues the same server-view request a select would have', () => {
    const onViewChange = vi.fn()
    renderOverview({ report: serverViewReport(), onViewChange })

    fireEvent.click(within(screen.getByLabelText('Query type')).getByRole('radio', { name: 'Branded' }))

    expect(onViewChange).toHaveBeenCalledTimes(1)
    expect(onViewChange).toHaveBeenCalledWith({ scope: 'all', queryClass: 'branded' })
  })

  it('renders Group as a segmented control (radiogroup) when five or fewer groups exist', () => {
    renderOverview()
    const control = screen.getByLabelText('Group')
    expect(control.getAttribute('role')).toBe('radiogroup')
    const radios = within(control).getAllByRole('radio')
    expect(radios.map(radio => radio.textContent)).toEqual(['All properties', 'Metro offices'])
  })

  it('selecting a Group segment issues the same server-view request a select would have', () => {
    const onViewChange = vi.fn()
    renderOverview({ report: serverViewReport(), onViewChange })

    fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Metro offices' }))

    expect(onViewChange).toHaveBeenCalledTimes(1)
    expect(onViewChange).toHaveBeenCalledWith({ scope: 'group', groupKey: 'metro', queryClass: 'non-brand' })
  })

  it('renders Group as a <select> once more than five groups exist, and still requests the chosen group', () => {
    const onViewChange = vi.fn()
    const withManyGroups = serverViewReport({
      availableGroups: manyGroups(6).map(group => ({ id: group.id, label: group.label })),
    })
    renderOverview({ report: withManyGroups, onViewChange })

    const control = screen.getByLabelText('Group')
    expect(control.tagName).toBe('SELECT')
    expect([...(control as HTMLSelectElement).options].map(option => option.textContent)).toEqual([
      'All properties', 'Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6',
    ])

    fireEvent.change(control, { target: { value: 'group-3' } })
    expect(onViewChange).toHaveBeenCalledWith({ scope: 'group', groupKey: 'group-3', queryClass: 'non-brand' })
  })

  it('moves Search out of the filter cluster to the right side of the row (ml-auto)', () => {
    renderOverview()
    const search = screen.getByLabelText('Search properties')
    const searchWrapper = search.closest('div')
    expect(searchWrapper?.className).toContain('ml-auto')
  })

  it('debounces the search box before requesting a server view, then requests it with the typed text', () => {
    vi.useFakeTimers()
    try {
      const onViewChange = vi.fn()
      renderOverview({ report: serverViewReport(), onViewChange })

      fireEvent.change(screen.getByLabelText('Search properties'), { target: { value: 'up' } })
      expect(onViewChange).not.toHaveBeenCalled()

      vi.advanceTimersByTime(249)
      expect(onViewChange).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(onViewChange).toHaveBeenCalledTimes(1)
      expect(onViewChange).toHaveBeenCalledWith({ scope: 'all', queryClass: 'non-brand', search: 'up' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('responsive structure', () => {
  // jsdom cannot lay out Tailwind, so these assert the STRUCTURE that makes the
  // layout survive a narrow viewport. Each corresponds to a way this surface
  // has broken or could break at width.

  it('keeps the wide properties table scrolling inside its own container, never the page', () => {
    const { container } = renderOverviewReturning()
    const table = container.querySelector('table.evidence-table.min-w-\\[720px\\]')
    expect(table).toBeTruthy()

    // The min-width belongs to the TABLE. If it sits on the scroll container
    // (or any ancestor) instead, the container can no longer be narrower than
    // its content, so the whole page scrolls sideways rather than the table.
    const scroller = table!.parentElement!
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.className).not.toMatch(/min-w-/)

    let ancestor: HTMLElement | null = scroller.parentElement
    while (ancestor && ancestor !== container) {
      expect(ancestor.className).not.toMatch(/min-w-\[/)
      ancestor = ancestor.parentElement
    }
  })

  it('lets the control row wrap instead of clipping its controls', () => {
    const { container } = renderOverviewReturning()
    const label = container.querySelector('#advanced-measurement-group-label')!
    const row = label.closest('div')!.parentElement!
    expect(row.className).toContain('flex-wrap')
  })

  it('lets a segmented control wrap its options, so many markets do not overflow', () => {
    const { container } = renderOverviewReturning()
    for (const group of container.querySelectorAll('[role="radiogroup"]')) {
      // `.segmented` is inline-flex; without wrap, a tenant with twenty markets
      // pushes options off the edge with no way to reach them.
      expect(group.className).toContain('flex-wrap')
    }
  })
})

describe('row detail', () => {
  const withDetail = () => {
    const base = report()
    const scope = base.classScopes!.nonBrand
    const [first, ...rest] = scope.aggregate.properties
    return {
      ...base,
      classScopes: {
        ...base.classScopes!,
        nonBrand: {
          ...scope,
          aggregate: {
            ...scope.aggregate,
            properties: [{
              ...first!,
              market: 'Metro offices',
              urls: ['example.com/downtown', 'example.com/downtown-2'],
              mentionCoverage: ratio(3, 4),
              citationCoverage: ratio(2, 4),
              providers: [
                { provider: 'openai', mentionCoverage: ratio(2, 2), citationCoverage: ratio(1, 2) },
                { provider: 'gemini', mentionCoverage: ratio(1, 2), citationCoverage: ratio(1, 2) },
              ],
            }, ...rest],
          },
        },
      },
    }
  }

  it('identifies a row by its market and URL count, not the name alone', () => {
    renderOverview({ report: withDetail() })
    // At portfolio scale "Downtown Office" is not enough to know which one.
    expect(screen.getByText('Metro offices · 2 URLs')).toBeTruthy()
  })

  it('expands into per-engine sub-rows whose numbers add up to the row above', () => {
    renderOverview({ report: withDetail() })
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))

    const engineRows = [...document.querySelectorAll('tr.measurement-subrow')]
    expect(engineRows.map(row => row.querySelector('.measurement-subrow-name')?.textContent))
      .toEqual(['openai', 'gemini'])

    // The invariant: read down a column and the sub-rows total the parent.
    // Cell order matches the header — name, mention, citation.
    const numerators = (row: Element) => [...row.querySelectorAll('td')]
      .map(td => /^(\d+) of (\d+)/.exec(td.textContent ?? ''))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ numerator: Number(match[1]), denominator: Number(match[2]) }))

    const openai = numerators(engineRows[0]!)
    const gemini = numerators(engineRows[1]!)
    expect(openai).toHaveLength(2)
    expect(gemini).toHaveLength(2)

    // Mention: 2 + 1 = 3, matching the parent's 3 of 4. Citation: 1 + 1 = 2 of 4.
    expect(openai[0]!.numerator + gemini[0]!.numerator).toBe(3)
    expect(openai[1]!.numerator + gemini[1]!.numerator).toBe(2)
    // Each engine's denominator is a share of the parent's, never the whole.
    expect(openai[0]!.denominator + gemini[0]!.denominator).toBe(4)
  })

  it('renders no engine sub-rows when the split is absent, rather than an empty shell', () => {
    renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Downtown Office' }))
    expect(document.querySelectorAll('tr.measurement-subrow').length).toBe(0)
  })
})

describe('outcome count row', () => {
  const withOutcomes = (outcomes: NonNullable<NonNullable<AdvancedMeasurementOverviewReport['currentView']>['outcomes']>) => ({
    ...report(),
    currentView: {
      scope: { kind: 'all' as const },
      queryClass: 'non-brand' as const,
      aggregate: report().classScopes!.nonBrand.aggregate,
      propertyTotal: outcomes.total,
      nextCursor: null,
      outcomes,
    },
  })

  // "one signal" pooled two states with OPPOSITE fixes — cited-but-not-mentioned
  // means the engine read the page and recommended somebody else — and hid the
  // actionable half behind a hover. Each state is now named on screen.
  it('names each outcome instead of pooling the two one-signal states', () => {
    renderOverview({ report: withOutcomes({
      bothSignals: 14, mentionedOnly: 11, citedOnly: 6, neither: 9, notMeasured: 7, total: 47,
    }) })

    const row = screen.getByLabelText('Property outcomes')
    expect(within(row).getByText('14')).toBeTruthy()
    expect(within(row).getByText('11')).toBeTruthy()
    expect(within(row).getByText('6')).toBeTruthy()
    expect(within(row).getByText('9')).toBeTruthy()
    expect(row.textContent).toContain('mentioned and cited')
    expect(row.textContent).toContain('mentioned only')
    expect(row.textContent).toContain('cited only')
    expect(row.textContent).toContain('neither signal')
    // The pooled label and its tooltip are gone.
    expect(row.textContent).not.toContain('one signal')
    expect(screen.queryByRole('button', { name: /which signal/i })).toBeNull()
  })

  // A rendered 0 in the exception bucket reads as a measured finding.
  it('hides not-measured when nothing is unmeasured, and shows it when something is', () => {
    const { unmount } = renderOverviewReturning({ report: withOutcomes({
      bothSignals: 1, mentionedOnly: 0, citedOnly: 1, neither: 4, notMeasured: 0, total: 6,
    }) })
    expect(screen.getByLabelText('Property outcomes').textContent).not.toContain('not measured')
    unmount()

    renderOverview({ report: withOutcomes({
      bothSignals: 1, mentionedOnly: 0, citedOnly: 1, neither: 3, notMeasured: 1, total: 6,
    }) })
    expect(screen.getByLabelText('Property outcomes').textContent).toContain('not measured')
  })

  it('renders nothing at all when the server sent no outcomes, rather than zeroes', () => {
    renderOverview()
    expect(screen.queryByLabelText('Property outcomes')).toBeNull()
  })

  it.each(['loading', 'error'] as const)('keeps loaded outcomes visible while the Portfolio pulse is %s', (portfolioSummaryState) => {
    renderOverview({
      report: withOutcomes({
        bothSignals: 1, mentionedOnly: 1, citedOnly: 1, neither: 1, notMeasured: 1, total: 5,
      }),
      portfolioSummaryState,
    })

    expect(screen.getAllByLabelText('Property outcomes')).toHaveLength(1)
  })

  it('lets a ready Portfolio pulse own the outcome partition exactly once', () => {
    renderOverview({
      report: withOutcomes({
        bothSignals: 1, mentionedOnly: 1, citedOnly: 1, neither: 1, notMeasured: 1, total: 5,
      }),
      portfolioSummaryState: 'ready',
      portfolioSummary: portfolioSummary(),
    })

    expect(screen.getAllByLabelText('Property outcomes')).toHaveLength(1)
  })

  it('does not flash the cached Pulse while a cleared search is still applied by the parent', () => {
    renderOverview({
      report: withOutcomes({
        bothSignals: 1, mentionedOnly: 1, citedOnly: 1, neither: 1, notMeasured: 1, total: 5,
      }),
      viewSearch: 'harbor',
      portfolioSummaryState: 'ready',
      portfolioSummary: portfolioSummary(),
    })

    const box = screen.getByPlaceholderText('Search properties')
    expect(screen.queryByRole('heading', { name: 'Portfolio pulse' })).toBeNull()
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.queryByRole('heading', { name: 'Portfolio pulse' })).toBeNull()
  })

  // The parent trims the term before storing it, so a pause after a space
  // echoes back a shorter string. Writing that echo into the controlled input
  // deletes the space the user just typed, and the next word merges onto the
  // last one: "Downtown " + "Office" becomes "DowntownOffice", which matches
  // nothing.
  it('does not eat a trailing space when the trimmed term echoes back', () => {
    const { rerender } = renderOverviewReturning({
      report: { ...report(), currentView: undefined },
      viewSearch: '',
    })
    const box = screen.getByPlaceholderText('Search properties') as HTMLInputElement

    fireEvent.change(box, { target: { value: 'Downtown ' } })
    expect(box.value).toBe('Downtown ')

    rerender(
      <AdvancedMeasurementOverview
        report={{ ...report(), currentView: undefined }}
        canEdit
        viewSearch="Downtown"
      />,
    )

    expect(box.value).toBe('Downtown ')
  })

  // While a new view loads, the cache still holds the PREVIOUS scope's counts.
  // Every other data block swaps to a skeleton for exactly that reason; leaving
  // this one up presents non-brand numbers as the branded view's split.
  it('hides the counts while a new view is loading rather than showing the old ones', () => {
    renderOverview({
      isViewLoading: true,
      report: withOutcomes({
        bothSignals: 14, mentionedOnly: 11, citedOnly: 6, neither: 9, notMeasured: 7, total: 47,
      }),
    })

    expect(screen.queryByLabelText('Property outcomes')).toBeNull()
  })

  // The unit is stated once, on the heading line the row sits under, and the
  // row sums to it — there is no second population on screen to reconcile with.
  it('states the unit once, on the line the counts sum to', () => {
    renderOverview({ report: withOutcomes({
      bothSignals: 1, mentionedOnly: 0, citedOnly: 1, neither: 4, notMeasured: 0, total: 6,
    }) })

    expect(screen.getByText('6 properties')).toBeTruthy()
    const row = screen.getByLabelText('Property outcomes')
    // 1 + 0 + 1 + 4 = 6, visibly.
    expect(row.textContent).not.toContain('assignment')
    expect(screen.queryByRole('button', { name: /Sums to/ })).toBeNull()
  })
})


describe('sorting and status', () => {
  const serverView = (overrides = {}) => {
    const base = report()
    return {
      ...base,
      currentView: {
        scope: { kind: 'all' as const },
        queryClass: 'all' as const,
        aggregate: base.classScopes!.nonBrand.aggregate,
        propertyTotal: 2,
        nextCursor: null,
        ...overrides,
      },
    }
  }

  // At portfolio scale the whole job is finding the Properties that are
  // failing. The API has supported six sort tokens all along; the table never
  // sent one, so the only ordering available was alphabetical.
  it('sorts by a column, and toggles direction on a second click', () => {
    const onViewChange = vi.fn()
    renderOverview({ report: serverView(), onViewChange })

    const mention = screen.getByRole('button', { name: /sort by mention/i })
    fireEvent.click(mention)
    expect(onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'mentionCoverage-asc' }))

    fireEvent.click(screen.getByRole('button', { name: /sort by mention/i }))
    expect(onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'mentionCoverage-desc' }))
  })

  it('tells assistive tech which column is sorted and which way', () => {
    renderOverview({ report: serverView({ sort: 'citationCoverage-desc' }), onViewChange: vi.fn() })
    const header = screen.getByRole('columnheader', { name: /citation/i })
    expect(header.getAttribute('aria-sort')).toBe('descending')
    expect(screen.getByRole('columnheader', { name: /mention/i }).getAttribute('aria-sort')).toBe('none')
  })

  // A column of identical green "Complete" badges spends a full column of
  // portfolio width saying nothing. The exceptions are the only part worth
  // reading, so they move beside the name and the column goes.
  it('drops the status column and badges only the rows that need attention', () => {
    const base = report()
    const scope = base.classScopes!.nonBrand
    const [first, second] = scope.aggregate.properties
    renderOverview({
      report: {
        ...base,
        classScopes: {
          ...base.classScopes!,
          nonBrand: {
            ...scope,
            aggregate: {
              ...scope.aggregate,
              properties: [
                { ...first!, status: { label: 'Complete', tone: 'positive' as const } },
                { ...second!, status: { label: 'Ambiguous match', tone: 'caution' as const } },
              ],
            },
          },
        },
      },
    })

    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull()
    const table = screen.getByRole('table', { name: /property measurement results/i })
    // The unremarkable case earns no badge at all. (The run's own "Complete"
    // status lives in the header, outside this table.)
    expect(within(table).queryByText('Complete')).toBeNull()
    // The exception still shows, next to the Property it belongs to.
    expect(within(table).getByText('Ambiguous match')).toBeTruthy()
  })
})

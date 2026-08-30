import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MeasurementOverviewResponse,
  MeasurementPlanResponse,
  MeasurementReportResponse,
} from '@ainyc/canonry-api-client'

import { AdvancedMeasurementOverview } from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'
import {
  adaptV2MeasurementOverview,
  areV2OverviewPagesCompatible,
} from '../src/components/project/advanced-measurement/v2-overview-adapter.js'

afterEach(cleanup)

type ActivePlan = NonNullable<MeasurementPlanResponse['active']>

function fixture(count = 213): { activePlan: ActivePlan; overview: MeasurementOverviewResponse } {
  const targets = Array.from({ length: count }, (_, index) => ({
    stableKey: `property-${index + 1}`,
    label: `Property ${index + 1}`,
    aliases: [`Property ${index + 1}`],
    urlMatchers: [{ kind: 'prefix' as const, host: 'northstar.example', pathPrefix: `/properties/${index + 1}`, pathCase: 'insensitive' as const }],
    mentionNotApplicable: false,
    discoveryIdentity: `sitemap:${index + 1}`,
  }))
  const querySnapshots = [{
    queryId: 'query-nearby',
    queryText: 'apartments near downtown',
    provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-02T12:00:00.000Z' },
  }]
  const executionNodes = [{
    stableKey: 'execution-nearby',
    queryId: 'query-nearby',
    queryText: 'apartments near downtown',
    context: { providers: ['openai'], models: { openai: 'model-a' }, location: null },
    expectedSnapshots: 1,
  }]
  const assignments = targets.map(target => ({
    targetKey: target.stableKey,
    queryId: 'query-nearby',
    queryClass: 'non-brand' as const,
    executionNodeKey: 'execution-nearby',
  }))
  const usageEdges = assignments.map(assignment => ({
    executionNodeKey: assignment.executionNodeKey,
    targetKey: assignment.targetKey,
    queryId: assignment.queryId,
  }))
  const activePlan: ActivePlan = {
    revision: 2,
    checksum: 'a'.repeat(64),
    createdAt: '2026-08-02T12:00:00.000Z',
    plan: {
      schemaVersion: 2,
      identities: { projectBrand: { canonicalHost: 'northstar.example', ownedHosts: ['northstar.example'], names: ['Northstar'] } },
      targets,
      groups: [{ stableKey: 'downtown', label: 'Downtown', targetKeys: targets.slice(0, 12).map(target => target.stableKey), competitors: [] }],
      querySnapshots,
      assignments,
      executionNodes,
      usageEdges,
      compiledChecksum: 'b'.repeat(64),
    },
  }
  const overview: MeasurementOverviewResponse = {
    mode: 'active-v2',
    scope: { kind: 'all', label: 'All Properties' },
    queryClass: 'non-brand',
    measurement: { state: 'not_measured', completed: 0, expected: 213 },
    nextAction: { kind: 'run_measurement' },
    metrics: {
      propertiesMentioned: { state: 'unavailable', reason: 'no_completed_run' },
      mentionCoverage: { state: 'unavailable', reason: 'no_completed_run' },
      citationCoverage: { state: 'unavailable', reason: 'no_completed_run' },
      brandPresence: { state: 'unavailable', reason: 'no_completed_run' },
      sov: { state: 'unavailable', reason: 'no_completed_run' },
    },
    properties: {
      items: targets.slice(0, 50).map(target => ({
        targetKey: target.stableKey,
        label: target.label,
        mentionCoverage: { state: 'unavailable' as const, reason: 'no_completed_run' as const },
        citationCoverage: { state: 'unavailable' as const, reason: 'no_completed_run' as const },
        flags: 0,
      })),
      nextCursor: 'page-2',
      totalEstimate: count,
    },
    flags: { total: 0 },
  }
  return { activePlan, overview }
}

describe('version-two measurement overview adapter', () => {
  it('refuses to merge pages that crossed from no run to a newly completed run', () => {
    const { overview } = fixture(2)
    const nextPage = structuredClone(overview)
    nextPage.measurement.displayedRunId = 'run-new'
    expect(areV2OverviewPagesCompatible([overview, nextPage])).toBe(false)
    overview.measurement.displayedRunId = 'run-new'
    expect(areV2OverviewPagesCompatible([overview, nextPage])).toBe(true)
  })

  it('renders the first bounded page immediately and requests server views and later pages', () => {
    const { activePlan, overview } = fixture()
    const report = adaptV2MeasurementOverview({ overview, activePlan })
    const onViewChange = vi.fn()
    const onLoadMore = vi.fn()
    const onPropertyExpand = vi.fn()

    render(
      <AdvancedMeasurementOverview
        report={report}
        canEdit
        onViewChange={onViewChange}
        onLoadMore={onLoadMore}
        onPropertyExpand={onPropertyExpand}
      />,
    )

    expect(screen.getByText('Ready to measure.')).toBeTruthy()
    expect(screen.queryByText('Date unavailable')).toBeNull()
    expect(screen.getByText('Showing 50 of 213')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect(onLoadMore).toHaveBeenCalledWith('page-2')

    // Group renders as a segmented radiogroup at <=5 groups, so it is clicked
    // by option label rather than driven with a `change` event.
    fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Downtown' }))
    expect(onViewChange).toHaveBeenCalledWith({ scope: 'group', groupKey: 'downtown', queryClass: 'non-brand' })

    const row = screen.getByRole('button', { name: 'Show details for Property 1' }).closest('tr')!
    fireEvent.click(row)
    expect(onPropertyExpand).toHaveBeenCalledWith('property-1')
    expect(screen.getByText('No source evidence is available.')).toBeTruthy()
  })

  it('keeps search typing immediate while sending only the latest server view after a short pause', () => {
    vi.useFakeTimers()
    try {
      const { activePlan, overview } = fixture()
      const onViewChange = vi.fn()
      render(
        <AdvancedMeasurementOverview
          report={adaptV2MeasurementOverview({ overview, activePlan })}
          canEdit
          onViewChange={onViewChange}
        />,
      )

      const search = screen.getByRole('searchbox', { name: 'Search properties' }) as HTMLInputElement
      fireEvent.change(search, { target: { value: 'h' } })
      fireEvent.change(search, { target: { value: 'har' } })
      fireEvent.change(search, { target: { value: 'harbor' } })

      expect(search.value).toBe('harbor')
      expect(onViewChange).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(249))
      expect(onViewChange).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(1))
      expect(onViewChange).toHaveBeenCalledTimes(1)
      expect(onViewChange).toHaveBeenLastCalledWith({
        scope: 'all',
        queryClass: 'non-brand',
        search: 'harbor',
      })

      fireEvent.change(search, { target: { value: 'old' } })
      act(() => vi.advanceTimersByTime(200))
      fireEvent.change(search, { target: { value: 'latest' } })
      act(() => vi.advanceTimersByTime(50))
      expect(onViewChange).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(200))
      expect(onViewChange).toHaveBeenCalledTimes(2)
      expect(onViewChange).toHaveBeenLastCalledWith({
        scope: 'all',
        queryClass: 'non-brand',
        search: 'latest',
      })

      onViewChange.mockClear()
      fireEvent.change(search, { target: { value: 'queued' } })
      fireEvent.click(within(screen.getByLabelText('Group')).getByRole('radio', { name: 'Downtown' }))
      expect(onViewChange).toHaveBeenCalledTimes(1)
      expect(onViewChange).toHaveBeenLastCalledWith({
        scope: 'group',
        groupKey: 'downtown',
        queryClass: 'non-brand',
        search: 'queued',
      })
      act(() => vi.advanceTimersByTime(250))
      expect(onViewChange).toHaveBeenCalledTimes(1)

      fireEvent.click(within(screen.getByLabelText('Query type')).getByRole('radio', { name: 'Branded' }))
      expect(onViewChange).toHaveBeenLastCalledWith({
        scope: 'group',
        groupKey: 'downtown',
        queryClass: 'branded',
        search: 'queued',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('indexes evidence once by its assigned Property and translates sibling language', () => {
    const { activePlan, overview } = fixture(2)
    if (activePlan.plan.schemaVersion !== 2) throw new Error('Expected a version-two fixture.')
    activePlan.plan.assignments.push({
      ...activePlan.plan.assignments[0]!,
      executionNodeKey: 'execution-nearby-second-location',
    })
    activePlan.plan.targets[0]!.urlMatchers.push({ kind: 'host', host: 'homes.northstar.example' })
    overview.properties = { items: overview.properties.items.slice(0, 2), nextCursor: null, totalEstimate: 2 }
    const evidenceReport = {
      revision: 2,
      run: null,
      groups: [],
      targets: [],
      diagnostics: {
        bridgedObservationIds: [], historicalObservationIds: [], evidenceIncompleteObservationIds: [], ambiguousObservationIds: [], unmatchedObservationIds: [],
      },
      evidence: [{
        observationId: 'observation-1', expectedSlotId: 'slot-1', executionId: 'execution-nearby',
        usageEdgeId: 'target:property-1:query-nearby:execution-nearby', usageEdgeType: 'target', provider: 'openai',
        queryText: 'apartments near downtown', location: null, sourceUrl: 'https://northstar.example/properties/2',
        bridged: false, historical: false, evidenceComplete: true, classification: 'sibling',
        normalizedUrl: 'https://northstar.example/properties/2', matchedTargetIds: ['property-2'], matchedUrlIds: ['property-2:url:0'],
      }],
    } as MeasurementReportResponse
    const report = adaptV2MeasurementOverview({ overview, activePlan, report: evidenceReport })

    expect(report.currentView?.aggregate.properties[0]?.evidence).toHaveLength(1)
    expect(report.currentView?.aggregate.properties[0]?.evidence[0]?.kind).toBe('another-property')
    expect(report.currentView?.aggregate.properties[0]?.evidence[0]?.provider).toBe('openai')
    expect(report.currentView?.aggregate.properties[0]?.assignedQueries).toEqual(['apartments near downtown'])
    expect(report.currentView?.aggregate.properties[0]?.urls).toEqual([
      'https://northstar.example/properties/1/*',
      'https://homes.northstar.example/*',
    ])
    expect(report.currentView?.aggregate.properties[1]?.evidence).toHaveLength(0)
  })

  it('badges run-level historical provenance before deep evidence is fetched', () => {
    const { activePlan, overview } = fixture(1)
    overview.measurement.includesHistoricalData = true
    overview.measurement.displayedRunId = 'run-historical'

    const report = adaptV2MeasurementOverview({
      overview,
      activePlan,
      reportState: 'loading',
    })
    render(<AdvancedMeasurementOverview report={report} canEdit />)

    expect(report.latestMeasurement.includesBridgedHistory).toBe(true)
    expect(report.currentView?.aggregate.properties[0]?.evidence).toEqual([])
    expect(screen.getByText('Includes historical data')).toBeTruthy()
  })

  it('rejects the API property scope instead of relabeling it as All Properties', () => {
    const { activePlan, overview } = fixture(1)
    overview.scope = { kind: 'property', key: 'property-1', label: 'Property 1' }
    expect(() => adaptV2MeasurementOverview({ overview, activePlan })).toThrow('All Properties or group scope')
  })

  it('keeps server-wide ambiguous-source totals visible before the matching Property page is loaded', () => {
    const { activePlan, overview } = fixture()
    overview.flags.total = 3
    overview.nextAction = { kind: 'review_flags', count: 3 }
    const onLoadMore = vi.fn()

    render(
      <AdvancedMeasurementOverview
        report={adaptV2MeasurementOverview({ overview, activePlan })}
        canEdit
        onLoadMore={onLoadMore}
      />,
    )

    expect(screen.getByText('3 ambiguous source-to-Property matches.')).toBeTruthy()
    fireEvent.click(screen.getByText('Ambiguous matches (3)'))
    expect(screen.getByText('Showing details for 0 of 3 ambiguous matches')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more Properties' }))
    expect(onLoadMore).toHaveBeenCalledWith('page-2')
  })

  it('shows an honest evidence error when the deep report fails or belongs to another run', () => {
    const { activePlan, overview } = fixture(1)
    overview.properties = { items: overview.properties.items.slice(0, 1), nextCursor: null, totalEstimate: 1 }
    overview.measurement.displayedRunId = 'run-a'
    const onRetryEvidence = vi.fn()

    const loading = adaptV2MeasurementOverview({ overview, activePlan, reportState: 'loading' })
    render(<AdvancedMeasurementOverview report={loading} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Loading evidence…')).toBeTruthy()
    cleanup()

    const failed = adaptV2MeasurementOverview({ overview, activePlan, reportState: 'error' })
    render(<AdvancedMeasurementOverview report={failed} canEdit onRetryEvidence={onRetryEvidence} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Evidence could not be loaded.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry evidence' }))
    expect(onRetryEvidence).toHaveBeenCalledOnce()
    cleanup()

    const mismatched = adaptV2MeasurementOverview({
      overview,
      activePlan,
      report: { ...({} as MeasurementReportResponse), revision: 2, run: { id: 'run-b' } } as MeasurementReportResponse,
    })
    render(<AdvancedMeasurementOverview report={mismatched} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Show details for Property 1' }))
    expect(screen.getByText('Evidence could not be loaded.')).toBeTruthy()
  })
})

describe('the All question lane', () => {
  // Shipping the All option without teaching the adapter about it crashed the
  // page with "requires a Branded or Non-brand query filter" the moment it was
  // selected. These cover the places that assumed exactly one class.
  it('adapts an all-class overview instead of throwing', () => {
    const { activePlan, overview } = fixture()
    expect(() => adaptV2MeasurementOverview({
      overview: { ...overview, queryClass: 'all' },
      activePlan,
    })).not.toThrow()
  })

  it('carries the all class through to the rendered view', () => {
    const { activePlan, overview } = fixture()
    const report = adaptV2MeasurementOverview({
      overview: { ...overview, queryClass: 'all' },
      activePlan,
    })
    expect(report.currentView?.queryClass).toBe('all')
  })

  it('lists questions from every lane rather than none', () => {
    const { activePlan, overview } = fixture()
    const all = adaptV2MeasurementOverview({ overview: { ...overview, queryClass: 'all' }, activePlan })
    const branded = adaptV2MeasurementOverview({ overview: { ...overview, queryClass: 'branded' }, activePlan })
    const count = (r: typeof all) => r.currentView!.aggregate.properties.reduce((n, p) => n + p.assignedQueries.length, 0)
    // All must be a superset: filtering to one lane can only ever remove questions.
    expect(count(all)).toBeGreaterThanOrEqual(count(branded))
  })
})

describe('property row detail', () => {
  it('carries the per-engine split, with both signals, in stable provider order', () => {
    const { activePlan, overview } = fixture(2)
    overview.properties.items[0]!.mentionCoverage = { state: 'available', value: 1, numerator: 4, denominator: 4 }
    overview.properties.items[0]!.citationCoverage = { state: 'available', value: .75, numerator: 3, denominator: 4 }
    overview.properties.items[0]!.providers = [
      { provider: 'openai', mentionCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 },
        citationCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 } },
      { provider: 'gemini', mentionCoverage: { state: 'available', value: 1, numerator: 2, denominator: 2 },
        citationCoverage: { state: 'available', value: .5, numerator: 1, denominator: 2 } },
    ]

    const report = adaptV2MeasurementOverview({ overview, activePlan })
    const property = report.currentView!.aggregate.properties[0]!

    expect(property.providers?.map(p => p.provider)).toEqual(['openai', 'gemini'])
    // The invariant the first design broke: the engine split must ADD UP to the
    // row it sits under. A panel showing three engines of /2 beneath a row of
    // /4 reconciles with nothing and cannot both be true.
    const sum = (pick: 'mentionCoverage' | 'citationCoverage') => property.providers!
      .reduce((total, p) => total + (p[pick].numerator ?? 0), 0)
    expect(sum('mentionCoverage')).toBe(property.mentionCoverage.numerator)
    expect(sum('citationCoverage')).toBe(property.citationCoverage.numerator)
  })

  it('names the market a property belongs to, so a row is identifiable at portfolio scale', () => {
    const { activePlan, overview } = fixture(2)
    const report = adaptV2MeasurementOverview({ overview, activePlan })
    const property = report.currentView!.aggregate.properties[0]!
    // The plan puts property-1..12 in the Downtown group.
    expect(property.market).toBe('Downtown')
    expect(property.urls.length).toBeGreaterThan(0)
  })

  it('leaves the market undefined rather than inventing one for an ungrouped property', () => {
    const { activePlan, overview } = fixture(213)
    const report = adaptV2MeasurementOverview({ overview, activePlan })
    // Only the first 12 targets are in a group; a later one belongs to none.
    const ungrouped = report.currentView!.aggregate.properties.find(p => p.id === 'property-40')
    expect(ungrouped).toBeTruthy()
    expect(ungrouped!.market).toBeUndefined()
  })
})

describe('outcome counts', () => {
  it('carries the scope-wide split through to the report', () => {
    const { activePlan, overview } = fixture(47)
    overview.outcomes = {
      bothSignals: 14, mentionedOnly: 11, citedOnly: 6, neither: 9, notMeasured: 7, total: 47,
    }
    const report = adaptV2MeasurementOverview({ overview, activePlan })

    // "one signal" is the pair collapsed for display; the split survives for the
    // tooltip because cited-only is the actionable half and must stay legible.
    expect(report.currentView!.outcomes).toEqual({
      bothSignals: 14, mentionedOnly: 11, citedOnly: 6, neither: 9, notMeasured: 7, total: 47,
    })
  })

  it('does not invent outcome counts when the server omits them', () => {
    const { activePlan, overview } = fixture(2)
    delete (overview as { outcomes?: unknown }).outcomes
    const report = adaptV2MeasurementOverview({ overview, activePlan })
    expect(report.currentView!.outcomes).toBeUndefined()
  })
})

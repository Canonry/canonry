import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AdvancedMeasurementLanding } from '../src/components/project/advanced-measurement/AdvancedMeasurementLanding.js'
import type { AdvancedMeasurementOverviewReport } from '../src/components/project/advanced-measurement/AdvancedMeasurementOverview.js'

afterEach(cleanup)

const unavailable = { numerator: null, denominator: null, reason: 'plan_v1' } as const

const report: AdvancedMeasurementOverviewReport = {
  classReporting: 'plan-v1',
  latestMeasurement: {
    status: { label: 'Complete', tone: 'positive' },
    completedSlots: 4,
    totalSlots: 4,
    date: 'Aug 2, 2026',
  },
  overall: {
    aggregate: {
      metrics: {
        propertiesMentioned: unavailable,
        mentionCoverage: unavailable,
        citationCoverage: unavailable,
      },
      properties: [],
    },
    groups: [],
  },
  flaggedResults: [],
}

const availableReport: AdvancedMeasurementOverviewReport = {
  ...report,
  classReporting: 'available',
  classScopes: {
    nonBrand: report.overall,
    branded: report.overall,
  },
}

function pagedReport(): AdvancedMeasurementOverviewReport {
  return {
    ...availableReport,
    currentView: {
      scope: { kind: 'all' },
      queryClass: 'non-brand',
      aggregate: {
        metrics: {
          propertiesMentioned: { numerator: 1, denominator: 1 },
          mentionCoverage: { numerator: 1, denominator: 1 },
          citationCoverage: { numerator: 1, denominator: 1 },
        },
        properties: [{
          id: 'loaded-property',
          name: 'Loaded Property',
          mentionCoverage: { numerator: 1, denominator: 1 },
          citationCoverage: { numerator: 1, denominator: 1 },
          status: { label: 'Measured', tone: 'positive' },
          assignedQueries: [],
          urls: [],
          evidence: [],
        }],
      },
      propertyTotal: 51,
      nextCursor: 'next-page',
    },
  }
}

describe('advanced measurement landing', () => {
  it('keeps the existing overview for a Simple project without advertising advanced setup', () => {
    const onOpenSetup = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'set-up' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up advanced measurement' })).toBeNull()
    expect(onOpenSetup).not.toHaveBeenCalled()
  })

  it('keeps a draft-only project on the existing overview without exposing its setup action', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'continue' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        onOpenSetup={vi.fn()}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue advanced setup' })).toBeNull()
  })

  it('replaces the existing overview when a published setup is active', () => {
    const onOpenSetup = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview-v1', setupAction: 'republish' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        report={report}
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.queryByText('Existing project overview')).toBeNull()
    expect(screen.getByText('Setup update required.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Republish setup' }))
    expect(onOpenSetup).toHaveBeenCalledTimes(1)
  })

  it('shows the same landing to a viewer without setup actions', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'simple-overview', setupAction: 'set-up' }}
        canEdit={false}
        simpleOverview={<p>Existing project overview</p>}
      />,
    )

    expect(screen.getByText('Existing project overview')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  // Was: asserted an Edit setup action beside Run measurement. Editing a
  // published plan moved to Settings — on the results surface it was a control
  // unrelated to reading the numbers, sitting between headline and table.
  it('renders the active current setup with Run measurement', () => {
    const onOpenSetup = vi.fn()
    const onRunMeasurement = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={<p>Existing project overview</p>}
        report={availableReport}
        onOpenSetup={onOpenSetup}
        onRunMeasurement={onRunMeasurement}
      />,
    )

    expect(screen.queryByText('Existing project overview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run measurement' }))
    expect(onRunMeasurement).toHaveBeenCalledTimes(1)
  })

  it('distinguishes loading from failure and preserves the setup action', () => {
    const onOpenSetup = vi.fn()
    const view = render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={null}
        reportState="loading"
        onOpenSetup={onOpenSetup}
      />,
    )

    expect(screen.getByLabelText('Loading advanced measurement report')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull()

    const onRetryReport = vi.fn()
    view.rerender(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={null}
        reportState="error"
        onOpenSetup={onOpenSetup}
        onRetryReport={onRetryReport}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('Could not load the advanced measurement report.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry report' }))
    expect(onRetryReport).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull()
  })

  it('preserves loaded Properties and retries a failed later page inline', () => {
    const onLoadMore = vi.fn()
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced-overview', setupAction: 'edit' }}
        canEdit
        simpleOverview={null}
        report={pagedReport()}
        reportState="error"
        isLoadMoreError
        onLoadMore={onLoadMore}
      />,
    )

    expect(screen.getByText('Loaded Property')).toBeTruthy()
    expect(screen.queryByText('Could not load the advanced measurement report.')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Could not load more locations.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more locations' }))
    expect(onLoadMore).toHaveBeenCalledWith('next-page')
  })
})

describe('editing a published plan is not a control on the results page', () => {
  it('does not offer Edit setup once results are being read', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced', setupAction: 'edit' }}
        canEdit
        report={report}
        onOpenSetup={vi.fn()}
      />,
    )
    // Was a button between the headline numbers and the property table. It
    // lives in Settings now; nothing here changes what is measured.
    expect(screen.queryByRole('button', { name: 'Edit setup' })).toBeNull()
  })

  it('still surfaces unpublished changes, which report pending work', () => {
    render(
      <AdvancedMeasurementLanding
        mode={{ surface: 'advanced', setupAction: 'republish' }}
        canEdit
        onOpenSetup={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Republish setup' })).toBeTruthy()
  })
})

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MeasurementPortfolioSummaryResponse } from '@ainyc/canonry-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PortfolioPulse } from '../src/components/project/advanced-measurement/PortfolioPulse.js'

afterEach(cleanup)

const available = (numerator: number, denominator: number) => ({
  state: 'available' as const,
  value: numerator / denominator,
  numerator,
  denominator,
})

const count = (numerator: number, denominator: number, rate = numerator / denominator) => ({
  state: 'available' as const,
  value: numerator,
  numerator,
  denominator,
  rate,
})

const unavailable = (reason: 'no_completed_run' | 'no_population' = 'no_completed_run') => ({
  state: 'unavailable' as const,
  reason,
})

function summary(overrides: Partial<MeasurementPortfolioSummaryResponse> = {}): MeasurementPortfolioSummaryResponse {
  return {
    portfolio: { groupKey: null, label: null, measurementScope: 'full' },
    measurement: {
      state: 'complete',
      displayedRunId: 'run-1',
      planRevision: 2,
      completedAt: '2026-08-27T14:00:00.000Z',
    },
    queryClass: 'non-brand',
    metrics: {
      propertiesMentioned: count(178, 200),
      mentionCoverage: available(194, 224),
      citationCoverage: available(171, 224),
    },
    weakestProperties: [],
    markets: [
      {
        groupKey: 'west',
        label: 'West',
        propertyCount: 16,
        propertiesMentioned: count(12, 16),
        mentionCoverage: available(14, 20),
        citationCoverage: available(8, 20),
      },
      {
        groupKey: 'east',
        label: 'East',
        propertyCount: 19,
        propertiesMentioned: count(18, 19),
        mentionCoverage: available(18, 20),
        citationCoverage: available(16, 20),
      },
    ],
    totalProperties: 200,
    truncated: false,
    ...overrides,
  }
}

describe('PortfolioPulse', () => {
  it('shows the compact portfolio metrics and keeps all five outcomes distinct', () => {
    render(<PortfolioPulse
      state="ready"
      summary={summary()}
      outcomes={{ bothSignals: 178, mentionedOnly: 16, citedOnly: 7, neither: 4, notMeasured: 13, total: 218 }}
    />)

    expect(screen.getByRole('heading', { name: 'Portfolio pulse' })).toBeTruthy()
    const countTile = screen.getByText('Properties mentioned').closest('div')!
    expect(within(countTile).getByText('178 of 200')).toBeTruthy()
    expect(within(countTile).getByText('89%')).toBeTruthy()
    expect(screen.getByText('87%')).toBeTruthy()
    expect(screen.getByText('194 of 224 answers')).toBeTruthy()
    expect(screen.getByText('76%')).toBeTruthy()
    expect(screen.getByText('171 of 224 answers')).toBeTruthy()

    const outcomes = screen.getByLabelText('Property outcomes')
    expect(outcomes.textContent).toContain('Mentioned and cited178')
    expect(outcomes.textContent).toContain('Mention only16')
    expect(outcomes.textContent).toContain('Citation only7')
    expect(outcomes.textContent).toContain('Neither4')
    expect(outcomes.textContent).toContain('Not measured13')
    expect(outcomes.textContent).not.toContain('Review')
    expect(screen.getByRole('button', { name: 'One or both signals missing. Not the same as neither.' })).toBeTruthy()

    const mentionOnlySegment = document.querySelector('[data-outcome="mention"]')!
    const citationOnlySegment = document.querySelector('[data-outcome="citation"]')!
    expect(mentionOnlySegment.className).toContain('--chart-series-2')
    expect(citationOnlySegment.className).toContain('--chart-series-3')
    expect(mentionOnlySegment.className).not.toMatch(/positive|caution|negative/)
    expect(citationOnlySegment.className).not.toMatch(/positive|caution|negative/)
  })

  it('uses the server-supplied count rate instead of recomputing it in the UI', () => {
    render(<PortfolioPulse state="ready" summary={summary({
      metrics: {
        ...summary().metrics,
        propertiesMentioned: count(178, 200, 0.42),
      },
    })} />)

    const countTile = screen.getByText('Properties mentioned').closest('div')!
    expect(within(countTile).getByText('42%')).toBeTruthy()
    expect(within(countTile).queryByText('89%')).toBeNull()
  })

  it('renders unavailable data as unavailable, never as a measured zero', () => {
    const base = summary()
    render(<PortfolioPulse
      state="ready"
      summary={summary({
        metrics: {
          propertiesMentioned: unavailable(),
          mentionCoverage: unavailable('no_population'),
          citationCoverage: unavailable(),
        },
        markets: [{
          ...base.markets[0]!,
          mentionCoverage: unavailable(),
          citationCoverage: unavailable('no_population'),
        }],
      })}
    />)

    const countTile = screen.getByText('Properties mentioned').closest('div')!
    expect(within(countTile).getByText('Not measured')).toBeTruthy()
    expect(countTile.textContent).not.toContain('0')
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0)
    expect(screen.getAllByText('No matching queries').length).toBeGreaterThan(0)
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('preserves server order and opens a Group without summing overlapping membership', () => {
    const onSelectGroup = vi.fn()
    render(<PortfolioPulse state="ready" summary={summary()} onSelectGroup={onSelectGroup} />)

    const table = screen.getByRole('table', { name: /Advanced measurement Groups/ })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map(row => within(row).getAllByRole('cell')[0]?.textContent)).toEqual(['West', 'East'])
    expect(screen.getByText('200 Properties')).toBeTruthy()
    expect(screen.queryByText('35 Properties')).toBeNull()

    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'West' }))
    expect(onSelectGroup).toHaveBeenCalledWith('west')
  })

  it('uses the same shell for one Group and returns to the portfolio', () => {
    const onOpenPortfolio = vi.fn()
    render(<PortfolioPulse
      state="ready"
      summary={summary({
        portfolio: { groupKey: 'west', label: 'West', measurementScope: 'full' },
        markets: [],
        totalProperties: 16,
      })}
      onOpenPortfolio={onOpenPortfolio}
    />)

    expect(screen.getByRole('heading', { name: 'West' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Groups' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio' }))
    expect(onOpenPortfolio).toHaveBeenCalledTimes(1)
  })

  it('reuses the project trend at Portfolio scope without presenting it as Group history', () => {
    const trend = <section aria-label="Project visibility trend">Project trend</section>
    const view = render(<PortfolioPulse state="ready" summary={summary()} projectTrend={trend} />)

    expect(screen.getByLabelText('Project visibility trend')).toBeTruthy()
    expect(screen.getByText('Project-wide · all tracked queries')).toBeTruthy()

    view.rerender(<PortfolioPulse
      state="ready"
      summary={summary({
        portfolio: { groupKey: 'west', label: 'West', measurementScope: 'full' },
        markets: [],
        totalProperties: 16,
      })}
      projectTrend={trend}
    />)
    expect(screen.queryByLabelText('Project visibility trend')).toBeNull()
  })

  it('labels a spot check without changing its measured population', () => {
    render(<PortfolioPulse state="ready" summary={summary({
      portfolio: { groupKey: null, label: null, measurementScope: 'spot_check' },
      totalProperties: 12,
    })} />)

    expect(screen.getByText('Spot check')).toBeTruthy()
    expect(screen.getByText('12 Properties')).toBeTruthy()
  })

  it('contains loading, error, and no-Group states inside the Pulse region', () => {
    const { unmount } = render(<PortfolioPulse state="loading" />)
    expect(screen.getByLabelText('Loading Portfolio pulse')).toBeTruthy()
    unmount()

    const onRetry = vi.fn()
    const errorView = render(<PortfolioPulse
      state="error"
      onRetry={onRetry}
      projectTrend={<section aria-label="Project visibility trend">Project trend</section>}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Project visibility trend')).toBeTruthy()
    errorView.unmount()

    render(<PortfolioPulse state="ready" summary={summary({ markets: [] })} />)
    expect(screen.getByText('No Groups configured.')).toBeTruthy()
  })
})

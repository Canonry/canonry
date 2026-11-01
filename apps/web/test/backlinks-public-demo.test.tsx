import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passthrough, ComposedChart: passthrough, Line: () => null, ReferenceArea: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }
})

import type { TrendsResponse } from '@canonry/canonry-contracts'
import { BacklinksSection } from '../src/components/project/BacklinksSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

function oneReleaseTrend(): TrendsResponse {
  const at = '2026-09-01T00:00:00.000Z'
  const figure = (key: string, label: string, unit: 'count' | 'fraction', value: number) => ({
    key, label, unit, better: unit === 'count' ? 'higher' as const : 'neither' as const, value, asOf: '2026-09-01', change: null,
    series: [{ date: '2026-09-01', observedAt: at, value }], recordedFrom: '2026-09-01',
  })
  return {
    project: 'test-project', surface: 'backlinks', window: 'all', startDate: '2026-09-01', endDate: '2026-09-01',
    groups: [{ key: 'backlinks', label: 'Backlinks', figures: [
      figure('referring-domains', 'Referring domains', 'count', 12),
      figure('hosts', 'Total linking hosts', 'count', 25),
      figure('top-10-concentration', 'Top-10 concentration', 'fraction', 0.5),
    ] }],
  }
}

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

test('public demo retains stored backlinks without administrator controls', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]
    if (path === '/api/v1/backlinks/syncs/latest') return jsonResponse(null)
    if (path === '/api/v1/projects/test-project/runs') return jsonResponse([])
    // One release so far: the figures stand alone, with no trend to chart yet.
    if (path === '/api/v1/projects/test-project/trends') return jsonResponse(oneReleaseTrend())
    if (path === '/api/v1/projects/test-project/backlinks/summary') return jsonResponse({
      projectId: 'p1', release: 'cc-main-2026-jul-aug-sep', targetDomain: 'example.com',
      totalLinkingDomains: 12, totalHosts: 25, top10HostsShare: '0.5', queriedAt: '2026-09-01T00:00:00.000Z', source: 'commoncrawl',
    })
    if (path === '/api/v1/projects/test-project/backlinks/domains') return jsonResponse({
      source: 'commoncrawl', summary: null, total: 1, rows: [{ linkingDomain: 'linker.com', numHosts: 3 }],
    })
    throw new Error(`Unexpected fetch: ${path}`)
  })
  onTestFinished(restoreFetch)

  render(<BacklinksSection projectName="test-project" />)

  await waitFor(() => expect(screen.getByText('linker.com')).not.toBeNull())
  // The stored share travels as a decimal string ('0.5') and reads as a percent.
  expect(screen.getByText('Top-10 concentration').closest('dt')?.nextElementSibling?.textContent).toBe('50.0%')
  expect(screen.getByText('Referring domains', { selector: 'dt span' }).closest('dt')?.nextElementSibling?.textContent).toBe('12')
  expect(screen.getByText('One release so far. The trend starts with the next one.')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Open admin' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Re-run extract' })).toBeNull()
})

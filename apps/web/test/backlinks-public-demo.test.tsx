import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: passthrough, ComposedChart: passthrough, Area: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null }
})

import { BacklinksSection } from '../src/components/project/BacklinksSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

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
    if (path === '/api/v1/projects/test-project/backlinks/history') return jsonResponse([])
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
  expect(screen.queryByRole('button', { name: 'Open admin' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Re-run extract' })).toBeNull()
})

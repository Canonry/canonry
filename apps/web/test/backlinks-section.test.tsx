import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { BacklinksSection } from '../src/components/project/BacklinksSection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

type BingEmptyCase = 'zero-raw' | 'all-filtered'

function installBacklinksApiMock(kind: BingEmptyCase) {
  const restoreFetch = mockFetch((url) => {
    const parsed = new URL(url)
    const path = pathOf(url).split('?')[0]!
    const source = parsed.searchParams.get('source') ?? 'commoncrawl'

    if (path === '/api/v1/projects/azcoatings/backlinks/sources') {
      return jsonResponse({
        projectId: 'project-1',
        targetDomain: 'azcoatingsllc.com',
        anyConnected: true,
        anyData: true,
        sources: [
          {
            source: 'commoncrawl',
            connected: false,
            hasData: false,
            latestRelease: null,
            totalLinkingDomains: 0,
            lastSyncedAt: null,
          },
          {
            source: 'bing-webmaster',
            connected: true,
            hasData: true,
            latestRelease: 'bing-2026-07-09',
            totalLinkingDomains: 0,
            lastSyncedAt: '2026-07-09T16:00:00.000Z',
          },
        ],
      })
    }

    if (path === '/api/v1/backlinks/syncs/latest') return jsonResponse(null)
    if (path === '/api/v1/projects/azcoatings/backlinks/history') return jsonResponse([])
    if (path === '/api/v1/projects/azcoatings/runs') return jsonResponse([])

    if (path === '/api/v1/projects/azcoatings/backlinks/summary') {
      if (source !== 'bing-webmaster') return jsonResponse(null)
      return jsonResponse({
        projectId: 'project-1',
        release: 'bing-2026-07-09',
        targetDomain: 'azcoatingsllc.com',
        totalLinkingDomains: 0,
        totalHosts: 0,
        top10HostsShare: '0',
        queriedAt: '2026-07-09T16:00:00.000Z',
        source: 'bing-webmaster',
        ...(kind === 'all-filtered'
          ? { excludedLinkingDomains: 4, excludedHosts: 12 }
          : {}),
      })
    }

    if (path === '/api/v1/projects/azcoatings/backlinks/domains') {
      return jsonResponse({
        source,
        summary: null,
        total: 0,
        rows: [],
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)
}

test('Bing empty state says the API returned zero raw inbound links when nothing was filtered', async () => {
  installBacklinksApiMock('zero-raw')

  render(<BacklinksSection projectName="azcoatings" />)

  expect(await screen.findByText('No Bing inbound links returned')).toBeTruthy()
  expect(screen.getByText(/0 inbound-link rows/)).toBeTruthy()
  expect(screen.getByText(/There were no referring domains to filter/)).toBeTruthy()
  expect(screen.queryByText(/every inbound link/i)).toBeNull()
})

test('Bing empty state reports hidden crawler/proxy domains when filtered rows exist', async () => {
  installBacklinksApiMock('all-filtered')

  render(<BacklinksSection projectName="azcoatings" />)

  expect(await screen.findByText('No non-crawler referring domains')).toBeTruthy()
  await waitFor(() => {
    expect(screen.getByText(/4 crawler\/proxy referring domains/)).toBeTruthy()
  })
  expect(screen.queryByText(/0 inbound-link rows/)).toBeNull()
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GbpSection } from '../src/components/project/GbpSection.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

afterEach(cleanup)

function renderGbpSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GbpSection projectName="test-project" />
    </QueryClientProvider>,
  )
}

const gbpConnection = {
  id: 'conn-1',
  domain: 'gjelina.com',
  connectionType: 'gbp',
  scopes: ['https://www.googleapis.com/auth/business.manage'],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
}

test('renders connected GBP data: scorecard, keywords, and locations', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) {
      return jsonResponse([gbpConnection])
    }
    if (urlPath.endsWith('/projects/test-project/gbp/summary')) {
      return jsonResponse({
        scope: { locationName: null, locationCount: 1 },
        performance: {
          totals: { WEBSITE_CLICKS: 100, BUSINESS_DIRECTION_REQUESTS: 40 },
          recent7d: { WEBSITE_CLICKS: 20, BUSINESS_DIRECTION_REQUESTS: 10 },
          prior7d: { WEBSITE_CLICKS: 100, BUSINESS_DIRECTION_REQUESTS: 10 },
          deltaPct: { WEBSITE_CLICKS: -80, BUSINESS_DIRECTION_REQUESTS: 0 },
        },
        keywords: { total: 1, thresholdedCount: 0, thresholdedPct: 0 },
        placeActions: { total: 1, hasReservationCta: false, hasBookingCta: true, hasDirectMerchantCta: false },
        lodging: { lodgingLocationCount: 1, populatedLodgingCount: 0, emptyLodgingCount: 1 },
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({
        locations: [{
          id: 'loc-1', projectId: 'p1', accountName: 'accounts/1', locationName: 'locations/123',
          displayName: 'Gjelina Venice', primaryCategoryDisplayName: 'Hotel',
          storefrontAddress: '1429 Abbot Kinney Blvd', websiteUri: 'https://gjelina.com',
          selected: true, syncedAt: '2026-05-20T00:00:00.000Z',
          createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z',
        }],
        totalDiscovered: 1,
        totalSelected: 1,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) {
      return jsonResponse({
        keywords: [{
          locationName: 'locations/123', periodStart: '2026-04', periodEnd: '2026-04',
          keyword: 'venice beach hotel', valueCount: 50, valueThreshold: null,
        }],
        total: 1,
        thresholdedPct: 0,
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // Wait on a summary-dependent tile (its query resolves after the connection one).
  await waitFor(() => expect(screen.getByText('Website clicks')).toBeTruthy())
  expect(screen.getByText('Google Business Profile')).toBeTruthy()
  expect(screen.getByText('Connected')).toBeTruthy()
  // Server-computed delta (the component does no math).
  expect(screen.getByText('-80%')).toBeTruthy()
  // Keyword row + location row.
  expect(screen.getByText('venice beach hotel')).toBeTruthy()
  expect(screen.getByText('Gjelina Venice')).toBeTruthy()
  // Lodging gap surfaced (empty profile).
  expect(screen.getByText('1 empty')).toBeTruthy()
})

test('self-gates to nothing when the project has no GBP connection', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) {
      // Only a GSC connection — no GBP.
      return jsonResponse([{ ...gbpConnection, connectionType: 'gsc' }])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  const { container } = renderGbpSection()

  // Give the connections query a tick to resolve, then assert nothing rendered.
  await waitFor(() => expect(container.querySelector('section')).toBeNull())
  expect(screen.queryByText('Google Business Profile')).toBeNull()
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function makeLocation(over: Record<string, unknown>) {
  return {
    id: 'loc-1', projectId: 'p1', accountName: 'accounts/1', locationName: 'locations/123',
    displayName: 'Gjelina Venice', primaryCategoryDisplayName: 'Hotel',
    storefrontAddress: '1429 Abbot Kinney Blvd', websiteUri: 'https://gjelina.com',
    placeId: 'ChIJ-place-123', mapsUri: 'https://maps.google.com/?cid=123',
    selected: true, syncedAt: '2026-05-20T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z',
    ...over,
  }
}

function emptySummary() {
  return {
    scope: { locationName: null, locationCount: 1 },
    performance: { totals: {}, recent7d: {}, prior7d: {}, deltaPct: {} },
    keywords: { total: 0, thresholdedCount: 0, thresholdedPct: 0 },
    placeActions: { total: 0, hasReservationCta: false, hasBookingCta: false, hasDirectMerchantCta: false },
    lodging: { lodgingLocationCount: 0, populatedLodgingCount: 0, emptyLodgingCount: 0 },
  }
}

test('renders connected GBP data: scorecard, keywords, and public listing', async () => {
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
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
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
    if (urlPath.endsWith('/projects/test-project/gbp/places')) {
      return jsonResponse({
        places: [{
          locationName: 'locations/123', placeId: 'ChIJ-place-123', tier: 'atmosphere',
          amenities: ['Pool', 'Free Wi-Fi', 'Spa'], syncedAt: '2026-05-20T00:00:00.000Z', place: {},
        }],
        total: 1,
      })
    }
    if (urlPath.endsWith('/projects/test-project/insights')) {
      return jsonResponse([])
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
  // Keyword row.
  expect(screen.getByText('venice beach hotel')).toBeTruthy()
  // Lodging gap surfaced (empty profile).
  expect(screen.getByText('1 empty')).toBeTruthy()
  // Public listing (Places) amenities render; the location name shows in that card.
  expect(screen.getByText('Pool')).toBeTruthy()
  expect(screen.getByText('Free Wi-Fi')).toBeTruthy()
  expect(screen.getByText('Gjelina Venice')).toBeTruthy()
  // Single tracked location → no scope selector.
  expect(screen.queryByText('All locations')).toBeNull()
})

test('renders the owner-vs-public amenity gap insight (server-computed)', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([gbpConnection])
    if (urlPath.endsWith('/projects/test-project/gbp/summary')) return jsonResponse(emptySummary())
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) {
      return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/places')) {
      return jsonResponse({
        places: [{
          locationName: 'locations/123', placeId: 'ChIJ-place-123', tier: 'atmosphere',
          amenities: ['Pool', 'Spa'], syncedAt: '2026-05-20T00:00:00.000Z', place: {},
        }],
        total: 1,
      })
    }
    if (urlPath.endsWith('/projects/test-project/insights')) {
      return jsonResponse([{
        id: 'ins-1', projectId: 'p1', runId: 'r1', type: 'gbp-listing-discrepancy',
        severity: 'high', title: 'Gjelina Venice: public listing shows 2 amenities your GBP profile doesn’t',
        query: 'locations/123', provider: 'gbp',
        recommendation: { action: 'Populate amenities', reason: 'Google’s rendered listing advertises Pool, Spa but your GBP profile has none.' },
        dismissed: false, createdAt: '2026-05-21T00:00:00.000Z',
      }])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  await waitFor(() => expect(
    screen.getByText('Gjelina Venice: public listing shows 2 amenities your GBP profile doesn’t'),
  ).toBeTruthy())
  expect(screen.getByText(/Google’s rendered listing advertises Pool, Spa/)).toBeTruthy()
})

test('shows a location scope selector when multiple locations are tracked', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([gbpConnection])
    if (urlPath.endsWith('/projects/test-project/gbp/summary')) return jsonResponse(emptySummary())
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({
        locations: [
          makeLocation({}),
          makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'AZ Coatings', placeId: null, mapsUri: null }),
        ],
        totalDiscovered: 2,
        totalSelected: 2,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // Two tracked locations → the scope selector renders with an "All" option + each location.
  await waitFor(() => expect(screen.getByText('All locations')).toBeTruthy())
  expect(screen.getByText('Gjelina Venice')).toBeTruthy()
  expect(screen.getByText('AZ Coatings')).toBeTruthy()
})

test('falls back to the aggregate scope when the scoped location is untracked', async () => {
  let bTracked = true
  // Record the scope of every /gbp/summary fetch so we can prove the section
  // re-reads in aggregate after the scoped location is untracked.
  const summaryScopes: string[] = []
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([gbpConnection])
    if (urlPath.endsWith('/projects/test-project/gbp/summary')) {
      summaryScopes.push(/[?&]locationName=/.test(url) ? 'scoped' : 'aggregate')
      return jsonResponse(emptySummary())
    }
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({
        locations: [
          makeLocation({}),
          makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'AZ Coatings', placeId: null, mapsUri: null, selected: bTracked }),
        ],
        totalDiscovered: 2,
        totalSelected: bTracked ? 2 : 1,
      })
    }
    if (urlPath.includes('/gbp/locations/') && urlPath.endsWith('/selection') && init?.method === 'PUT') {
      bTracked = false
      return jsonResponse(makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'AZ Coatings', selected: false }))
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // Scope to the second location → reads re-fetch with ?locationName=.
  await waitFor(() => expect(screen.getByRole('tab', { name: 'AZ Coatings' })).toBeTruthy())
  fireEvent.click(screen.getByRole('tab', { name: 'AZ Coatings' }))
  await waitFor(() => expect(summaryScopes).toContain('scoped'))

  // Untrack that same location via the Manage locations panel.
  fireEvent.click(screen.getByRole('button', { name: /Manage locations/ }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Untrack' })[1]!)

  // Selector disappears (one tracked location left) and the scope resets to
  // aggregate — without the reset the section stays stuck on the untracked one.
  await waitFor(() => expect(screen.queryByText('All locations')).toBeNull())
  await waitFor(() => expect(summaryScopes.at(-1)).toBe('aggregate'))
})

test('shows a connect empty-state when the project has no GBP connection', async () => {
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) {
      // Only a GSC connection — no GBP.
      return jsonResponse([{ ...gbpConnection, connectionType: 'gsc' }])
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // The dedicated tab renders an explicit empty state (not nothing) so direct
  // navigation isn't a blank page. No data endpoints are fetched.
  await waitFor(() => expect(screen.getByText(/No Google Business Profile is connected/)).toBeTruthy())
  expect(screen.getByText('Google Business Profile')).toBeTruthy()
})

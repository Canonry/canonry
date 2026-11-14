import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// Recharts needs a sized container (jsdom has none); stub it like the other
// chart-bearing section tests so we assert on the textual layer, not the SVG.
vi.mock('recharts', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    ResponsiveContainer: passthrough,
    ComposedChart: passthrough,
    Line: () => null,
    Area: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
    ReferenceArea: () => null,
  }
})

import { act } from '@testing-library/react'

import {
  GBP_CONNECT_COPY,
  GBP_DISCONNECT_COPY,
  GBP_DISCOVER_COPY,
  GBP_MANAGED_EMPTY_COPY,
  GbpSection,
  completionTone,
  gbpLodgingSourceState,
  gbpOwnerProfileFacts,
  gbpPlaceActionsSourceState,
  gbpPlacesSourceState,
} from '../src/components/project/GbpSection.js'
import { AccountProvider, type ApiKeyAccess, type SignedInAccount } from '../src/contexts/account-context.js'
import { getRunTrackerState, removeTrackedRun, resetRunTracker } from '../src/lib/run-tracker-store.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { mockFetch, jsonResponse } from './mock-fetch.js'

// The run tracker is a module-global store backed by sessionStorage; reset it
// around every test so a queued gbp-sync run from one test never leaks into the
// button state of the next.
beforeEach(() => {
  resetRunTracker()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  resetRunTracker()
  window.sessionStorage.clear()
})

function renderGbpSection({
  account = null,
  apiKey = null,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}: { account?: SignedInAccount | null; apiKey?: ApiKeyAccess | null; queryClient?: QueryClient } = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={account} apiKey={apiKey}>
        <GbpSection projectName="test-project" projectId="p1" />
      </AccountProvider>
    </QueryClientProvider>,
  )
}

const signedInViewer: SignedInAccount = { name: 'Viewer', role: 'viewer' }
/** A full-access key bound to one project: it may write, but is not an administrator. */
const projectScopedKey: ApiKeyAccess = { id: 'key-1', scopes: ['*'], projectId: 'p1', readOnly: false }

/** Request log for a test: "METHOD /path" for every fetch the section makes. */
function recordRequests() {
  const requests: string[] = []
  return {
    requests,
    record(url: string, init?: RequestInit) {
      requests.push(`${init?.method ?? 'GET'} ${url.split('?')[0]!.replace(/^https?:\/\/[^/]+/, '')}`)
    },
  }
}

const gbpConnection = {
  id: 'conn-1',
  domain: 'harborline.example.com',
  connectionType: 'gbp',
  scopes: ['https://www.googleapis.com/auth/business.manage'],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
}

function makeLocation(over: Record<string, unknown>) {
  return {
    id: 'loc-1', projectId: 'p1', accountName: 'accounts/1', locationName: 'locations/123',
    displayName: 'Harborline Bayside', primaryCategoryDisplayName: 'Hotel',
    storefrontAddress: '100 Example Ave', websiteUri: 'https://harborline.example.com',
    placeId: 'ChIJ-place-123', mapsUri: 'https://maps.google.com/?cid=123',
    additionalCategories: ['Boutique hotel'],
    description: 'A small hotel by the bay.',
    serviceArea: null,
    regularHours: { periods: [] },
    primaryPhone: '+13105550100',
    openStatus: 'OPEN',
    openingDate: '2024',
    selected: true, syncedAt: '2026-05-20T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z',
    ...over,
  }
}

function emptySummary() {
  return {
    scope: { locationName: null, locationCount: 1 },
    performance: { totals: {}, recent7d: {}, prior7d: {}, deltaPct: {} },
    freshness: { dataThroughDate: null, latestStoredDate: null, pendingDays: 0 },
    timeseries: [],
    keywords: { total: 0, thresholdedCount: 0, thresholdedPct: 0 },
    placeActions: { total: 0, hasReservationCta: false, hasBookingCta: false, hasDirectMerchantCta: false },
    lodging: { lodgingLocationCount: 0, populatedLodgingCount: 0, emptyLodgingCount: 0 },
    profileCompleteness: {
      locationCount: 1,
      withSecondaryCategories: 0,
      secondaryCategoryTotal: 0,
      withDescription: 0,
      withServiceArea: 0,
      withHours: 0,
      withPrimaryPhone: 0,
      permanentlyClosed: 0,
      temporarilyClosed: 0,
    },
  }
}

test('GBP source-state helpers keep owner-only API absences neutral', () => {
  const sparseLocation = makeLocation({
    additionalCategories: [],
    description: null,
    regularHours: null,
    primaryPhone: null,
    websiteUri: null,
    serviceArea: null,
  })
  const facts = Object.fromEntries(gbpOwnerProfileFacts(sparseLocation).map((fact) => [fact.label, fact]))

  expect(facts.Description).toMatchObject({ value: 'not returned', tone: 'neutral' })
  expect(facts.Hours).toMatchObject({ value: 'not returned', tone: 'neutral' })
  expect(facts.Phone).toMatchObject({ value: 'not returned', tone: 'neutral' })
  expect(facts.Website).toMatchObject({ value: 'not returned', tone: 'neutral' })
  expect(facts.Secondary).toMatchObject({ value: 'not returned', tone: 'neutral' })
  expect(gbpLodgingSourceState({
    locationName: 'locations/123',
    populatedGroupCount: 0,
    syncedAt: '2026-05-20T00:00:00.000Z',
    attributes: { name: 'locations/123/lodging' },
  })).toMatchObject({
    tone: 'neutral',
    label: '0 groups returned',
  })
  expect(gbpPlaceActionsSourceState([{
    locationName: 'locations/123',
    placeActionLinkName: 'locations/123/placeActionLinks/1',
    placeActionType: 'BOOK',
    uri: 'https://booking.example/harborline',
    isPreferred: false,
    providerType: 'AGGREGATOR',
  }])).toMatchObject({
    tone: 'neutral',
    label: '1 aggregator CTA',
  })
  expect(gbpPlacesSourceState(null, 'https://maps.google.com/?cid=123')).toMatchObject({
    tone: 'neutral',
    label: 'Public listing not checked',
  })
})

test('profile-completeness aggregate tone can still warn when the server count is empty', () => {
  expect(completionTone(0, 2, 'caution')).toBe('caution')
  expect(completionTone(0, 2, 'neutral')).toBe('neutral')
  expect(completionTone(1, 2, 'caution')).toBe('caution')
  expect(completionTone(2, 2, 'caution')).toBe('positive')
})

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
          totals: { WEBSITE_CLICKS: 100, BUSINESS_DIRECTION_REQUESTS: 40, BUSINESS_BOOKINGS: 0 },
          recent7d: { WEBSITE_CLICKS: 20, BUSINESS_DIRECTION_REQUESTS: 10 },
          prior7d: { WEBSITE_CLICKS: 18, BUSINESS_DIRECTION_REQUESTS: 10 },
          deltaPct: { WEBSITE_CLICKS: 11, BUSINESS_DIRECTION_REQUESTS: 0 },
        },
        freshness: { dataThroughDate: '2026-05-19', latestStoredDate: '2026-05-20', pendingDays: 1 },
        timeseries: [
          { date: '2026-05-18', pending: false, metrics: { WEBSITE_CLICKS: 12, BUSINESS_DIRECTION_REQUESTS: 5, BUSINESS_BOOKINGS: 0 } },
          { date: '2026-05-19', pending: false, metrics: { WEBSITE_CLICKS: 18, BUSINESS_DIRECTION_REQUESTS: 7, BUSINESS_BOOKINGS: 0 } },
          { date: '2026-05-20', pending: true, metrics: { WEBSITE_CLICKS: 0, BUSINESS_DIRECTION_REQUESTS: 0, BUSINESS_BOOKINGS: 0 } },
        ],
        keywords: { total: 1, thresholdedCount: 0, thresholdedPct: 0 },
        placeActions: { total: 1, hasReservationCta: false, hasBookingCta: true, hasDirectMerchantCta: false },
        lodging: { lodgingLocationCount: 1, populatedLodgingCount: 0, emptyLodgingCount: 1 },
        profileCompleteness: {
          locationCount: 1,
          withSecondaryCategories: 1,
          secondaryCategoryTotal: 1,
          withDescription: 1,
          withServiceArea: 0,
          withHours: 1,
          withPrimaryPhone: 1,
          permanentlyClosed: 0,
          temporarilyClosed: 0,
        },
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) {
      return jsonResponse({
        keywords: [
          {
            locationName: 'locations/123', periodStart: '2026-04', periodEnd: '2026-04',
            keyword: 'bayside boutique hotel', valueCount: 50, valueThreshold: null,
          },
          {
            locationName: 'locations/123', periodStart: '2026-04', periodEnd: '2026-04',
            keyword: 'boutique hotel bayside', valueCount: 20, valueThreshold: null,
          },
          {
            locationName: 'locations/123', periodStart: '2026-04', periodEnd: '2026-04',
            keyword: 'hotel near the pier', valueCount: null, valueThreshold: 15,
          },
        ],
        total: 3,
        // 1 of 3 keywords redacted: 33.333333 on the wire.
        thresholdedPct: 33.333333,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/lodging')) {
      return jsonResponse({
        lodging: [{
          locationName: 'locations/123',
          populatedGroupCount: 0,
          syncedAt: '2026-05-20T00:00:00.000Z',
          attributes: { name: 'locations/123/lodging' },
        }],
        total: 1,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) {
      return jsonResponse({
        placeActions: [{
          locationName: 'locations/123',
          placeActionLinkName: 'locations/123/placeActionLinks/1',
          placeActionType: 'BOOK',
          uri: 'https://booking.example/harborline',
          isPreferred: false,
          providerType: 'AGGREGATOR',
        }],
        total: 1,
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

  // Wait on a summary-dependent label (the profile-action totals row).
  await waitFor(() => expect(screen.getByText('Website clicks')).toBeTruthy())
  // The help sits beside the heading, not inside it, where browsers would
  // read its label as part of the heading's name.
  const heading = screen.getByRole('heading', { name: 'Google Business Profile' })
  const help = screen.getByRole('button', { name: 'How AI answer engines and Maps surface this business: performance, search terms, and how your public listing compares to the profile you control.' })
  expect(heading.contains(help)).toBe(false)
  expect(screen.getByText('Connected')).toBeTruthy()
  // Graph-first: exact profile-action totals render with human labels (no raw BUSINESS_* keys).
  expect(screen.getByText('Profile actions · daily')).toBeTruthy()
  expect(screen.getByText('Direction requests')).toBeTruthy()
  // Honest freshness — the reporting-lag tail is surfaced, never shown as a drop.
  expect(screen.getByText(/Data through/)).toBeTruthy()
  // All-zero series (bookings) collapse to a footnote instead of occupying a tile.
  expect(screen.getByText(/Not active:/)).toBeTruthy()
  // Keyword row, and the redacted share through the shared percent format.
  expect(screen.getByText('bayside boutique hotel')).toBeTruthy()
  expect(screen.getByText('33.3% privacy-thresholded')).toBeTruthy()
  // Owner-only surfaces are back in the dashboard, but source-labeled and
  // neutral when the API simply returned no owner-controlled value.
  expect(screen.getByText('Owner profile · Business Information')).toBeTruthy()
  expect(screen.getByText('Source evidence')).toBeTruthy()
  expect(screen.getByText('0 groups returned')).toBeTruthy()
  expect(screen.getByText('1 aggregator CTA')).toBeTruthy()
  expect(screen.getByText('3 signals detected')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Details' }))
  // Expanded public-listing details preserve the Places signals without making
  // them owner-controlled truth.
  expect(screen.getByText('Pool, Free Wi-Fi, Spa')).toBeTruthy()
  expect(screen.getByText('Harborline Bayside')).toBeTruthy()
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
    if (urlPath.endsWith('/projects/test-project/gbp/lodging')) return jsonResponse({ lodging: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) return jsonResponse({ placeActions: [], total: 0 })
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
        severity: 'high', title: 'Harborline Bayside: public listing shows 2 amenities your GBP profile doesn’t',
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
    screen.getByText('Harborline Bayside: public listing shows 2 amenities your GBP profile doesn’t'),
  ).toBeTruthy())
  // The reason is heavy explanatory text, so it lives in an InfoTooltip rather
  // than inline — exposed to assistive tech (and tests) via the trigger
  // button's accessible name, not as visible body copy.
  expect(
    screen.getByRole('button', { name: /Google’s rendered listing advertises Pool, Spa/ }),
  ).toBeTruthy()
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
          makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'Blue Kettle', placeId: null, mapsUri: null }),
        ],
        totalDiscovered: 2,
        totalSelected: 2,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/lodging')) return jsonResponse({ lodging: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) return jsonResponse({ placeActions: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // Two tracked locations → the scope selector renders with an "All" option + each location.
  await waitFor(() => expect(screen.getByText('All locations')).toBeTruthy())
  const selector = screen.getByRole('combobox', { name: 'Location' })
  expect(selector).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Harborline Bayside' })).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Blue Kettle' })).toBeTruthy()
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
          makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'Blue Kettle', placeId: null, mapsUri: null, selected: bTracked }),
        ],
        totalDiscovered: 2,
        totalSelected: bTracked ? 2 : 1,
      })
    }
    if (urlPath.includes('/gbp/locations/') && urlPath.endsWith('/selection') && init?.method === 'PUT') {
      bTracked = false
      return jsonResponse(makeLocation({ id: 'loc-2', locationName: 'locations/456', displayName: 'Blue Kettle', selected: false }))
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/lodging')) return jsonResponse({ lodging: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) return jsonResponse({ placeActions: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // Scope to the second location → reads re-fetch with ?locationName=.
  const selector = await screen.findByRole('combobox', { name: 'Location' })
  fireEvent.change(selector, { target: { value: 'locations/456' } })
  await waitFor(() => expect(summaryScopes).toContain('scoped'))

  // Untrack that same location via the Manage locations panel.
  fireEvent.click(screen.getByRole('button', { name: /Manage locations/ }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Untrack' })[1]!)

  // Selector disappears (one tracked location left) and the scope resets to
  // aggregate — without the reset the section stays stuck on the untracked one.
  await waitFor(() => expect(screen.queryByText('All locations')).toBeNull())
  await waitFor(() => expect(summaryScopes.at(-1)).toBe('aggregate'))
})

/** The stored GBP reads a connected section makes on mount. */
function connectedGbpRead(urlPath: string, locations: unknown[]): Response | null {
  if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([gbpConnection])
  if (urlPath.endsWith('/projects/test-project/gbp/summary')) return jsonResponse(emptySummary())
  if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
    return jsonResponse({ locations, totalDiscovered: locations.length, totalSelected: locations.length })
  }
  if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
  if (urlPath.endsWith('/projects/test-project/gbp/lodging')) return jsonResponse({ lodging: [], total: 0 })
  if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) return jsonResponse({ placeActions: [], total: 0 })
  if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
  if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
  return null
}

const settingsResponse = (configured: boolean) =>
  jsonResponse({ providers: [], providerCatalog: [], google: { configured }, bing: { configured: false } })

test('the public demo keeps the CLI setup guide and offers no connect control', async () => {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  onTestFinished(() => { delete window.__CANONRY_CONFIG__ })
  const restoreFetch = mockFetch((url) => {
    const urlPath = url.split('?')[0]!
    // Only a GSC connection — no GBP. Settings are never read here.
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([{ ...gbpConnection, connectionType: 'gsc' }])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // The dedicated tab renders a setup guide (not nothing) so direct navigation
  // isn't a blank page. No data endpoints are fetched.
  await waitFor(() => expect(screen.getByText('Connect Google Business Profile')).toBeTruthy())
  const guide = screen.getByText('Connect using the CLI', { selector: 'summary' })
  expect(guide.closest('details')?.open).toBe(false)
  fireEvent.click(guide)
  expect(guide.closest('details')?.open).toBe(true)
  expect(screen.getByText(/canonry gbp connect test-project/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: GBP_CONNECT_COPY.connect })).toBeNull()
})

test('Connect starts the shared Google OAuth flow as gbp and shows the connection once the popup reports it', async () => {
  let connected = false
  const connectBodies: unknown[] = []
  const popup = { closed: false } as unknown as Window
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup)
  onTestFinished(() => openSpy.mockRestore())
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/api/v1/settings')) return settingsResponse(true)
    if (urlPath.endsWith('/projects/test-project/google/connect') && init?.method === 'POST') {
      connectBodies.push(JSON.parse(String(init.body)))
      return jsonResponse({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
        redirectUri: 'http://localhost:4100/api/v1/google/callback',
      })
    }
    if (!connected && urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([])
    const read = connectedGbpRead(urlPath, [makeLocation({})])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  const connect = await screen.findByRole('button', { name: GBP_CONNECT_COPY.connect })
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false))
  // The CLI path stays available behind main's closed disclosure, below Connect.
  const guide = screen.getByText('Connect using the CLI', { selector: 'summary' })
  expect(guide.closest('details')?.open).toBe(false)
  expect(connect.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(connect)

  await waitFor(() => expect(openSpy).toHaveBeenCalledOnce())
  expect(openSpy.mock.calls[0]![0]).toBe('https://accounts.google.com/o/oauth2/v2/auth?client_id=test')
  expect(connectBodies).toHaveLength(1)
  expect(connectBodies[0]).toMatchObject({ type: 'gbp' })
  expect(screen.getByRole('status').textContent).toBe(GBP_CONNECT_COPY.waiting)

  // A message for another connection type does not end this flow. An accepted
  // message would switch the status to "refreshing" at once, so the status
  // still reading "waiting" proves this one was ignored.
  connected = true
  fireEvent(window, new MessageEvent('message', {
    origin: 'http://localhost:4100',
    source: popup,
    data: { type: 'canonry:google-oauth-complete', connectionType: 'gsc' },
  }))
  expect(screen.getByRole('status').textContent).toBe(GBP_CONNECT_COPY.waiting)

  fireEvent(window, new MessageEvent('message', {
    origin: 'http://localhost:4100',
    source: popup,
    data: { type: 'canonry:google-oauth-complete', connectionType: 'gbp' },
  }))
  await screen.findByText('Connected')
})

test('Connect without Google OAuth app credentials says so and starts nothing', async () => {
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/api/v1/settings')) return settingsResponse(false)
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([])
    // No POST /google/connect is expected.
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  await screen.findByText('App credentials missing')
  fireEvent.click(screen.getByRole('button', { name: GBP_CONNECT_COPY.connect }))
  expect((await screen.findByRole('alert')).textContent).toBe(GBP_CONNECT_COPY.credentialsMissing)
})

test('a connection with no locations discovers the chosen account with the tracking choice', async () => {
  const discoverBodies: unknown[] = []
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/accounts')) {
      return jsonResponse({
        accounts: [
          { name: 'accounts/1', accountName: 'Harborline Group', type: 'LOCATION_GROUP', role: 'OWNER' },
          { name: 'accounts/2', accountName: 'Bayside Hotels', type: 'LOCATION_GROUP', role: 'MANAGER' },
        ],
        total: 2,
      })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/locations/discover') && init?.method === 'POST') {
      discoverBodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ locations: [makeLocation({ selected: false })], totalDiscovered: 1, totalSelected: 0 })
    }
    const read = connectedGbpRead(urlPath, [])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // The panel that discovers opens on its own, with the account picker filled.
  await screen.findByText(GBP_DISCOVER_COPY.noneDiscovered)
  const picker = await screen.findByLabelText(GBP_DISCOVER_COPY.accountLabel)
  await screen.findByRole('option', { name: 'Bayside Hotels (accounts/2)' })
  fireEvent.change(picker, { target: { value: 'accounts/2' } })
  fireEvent.click(screen.getByLabelText(GBP_DISCOVER_COPY.trackNew))
  fireEvent.click(screen.getByRole('button', { name: GBP_DISCOVER_COPY.discover }))

  await waitFor(() => expect(discoverBodies).toEqual([{ accountName: 'accounts/2', selectAllNew: false }]))
})

test('later discovery reuses the project account and never reads the live account list', async () => {
  const discoverBodies: unknown[] = []
  const log = recordRequests()
  const restoreFetch = mockFetch((url, init) => {
    log.record(url, init)
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/locations/discover') && init?.method === 'POST') {
      discoverBodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
    }
    // GET /gbp/accounts is a live Google read and must not happen here.
    const read = connectedGbpRead(urlPath, [makeLocation({})])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  fireEvent.click(await screen.findByRole('button', { name: /Manage locations \(1\)/ }))
  expect(screen.queryByLabelText(GBP_DISCOVER_COPY.accountLabel)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: GBP_DISCOVER_COPY.refresh }))

  await waitFor(() => expect(discoverBodies).toEqual([{ selectAllNew: true }]))
  // The mock would answer an accounts read with an error that the hidden
  // picker never shows, so check the request log itself.
  expect(log.requests.some((request) => request.endsWith('/gbp/accounts'))).toBe(false)
})

test("Disconnect asks before clearing the project's Business Profile data, and keeps keyboard focus", async () => {
  let deletes = 0
  let connected = true
  let connectionReads = 0
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/connection') && init?.method === 'DELETE') {
      deletes += 1
      connected = false
      return new Response(null, { status: 204 })
    }
    if (urlPath.endsWith('/projects/test-project/google/connections')) {
      connectionReads += 1
      if (!connected) return jsonResponse([])
    }
    if (urlPath.endsWith('/api/v1/settings')) return settingsResponse(true)
    const read = connectedGbpRead(urlPath, [makeLocation({})])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)
  // The app's client: its write-refresh interceptor, not this section, refetches
  // the connection after the DELETE.
  const queryClient = createQueryClient()
  onTestFinished(() => queryClient.clear())

  renderGbpSection({ queryClient })

  const disconnect = await screen.findByRole('button', { name: GBP_DISCONNECT_COPY.disconnect })
  fireEvent.click(disconnect)
  const confirm = screen.getByRole('group', { name: GBP_DISCONNECT_COPY.confirmTitle })
  expect(confirm.textContent).toContain(GBP_DISCONNECT_COPY.confirmBody)
  expect(deletes).toBe(0)

  // Cancel closes the confirmation and returns focus to the control that opened it.
  const cancel = screen.getByRole('button', { name: GBP_DISCONNECT_COPY.cancel })
  cancel.focus()
  fireEvent.click(cancel)
  expect(screen.queryByRole('group', { name: GBP_DISCONNECT_COPY.confirmTitle })).toBeNull()
  expect(document.activeElement).toBe(disconnect)
  expect(deletes).toBe(0)

  const readsBeforeDisconnect = connectionReads
  fireEvent.click(disconnect)
  fireEvent.click(screen.getByRole('button', { name: GBP_DISCONNECT_COPY.confirm }))
  await waitFor(() => expect(deletes).toBe(1))

  // One refetch of the connection, then focus lands on the new Connect button.
  const connect = await screen.findByRole('button', { name: GBP_CONNECT_COPY.connect })
  await waitFor(() => expect(document.activeElement).toBe(connect))
  expect(connectionReads).toBe(readsBeforeDisconnect + 1)
})

test('Disconnect shows the ownership refusal in the confirmation and clears it when reopened', async () => {
  const message = 'This Google GBP connection is owned by a different project. Disconnect from the owning project instead.'
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/connection') && init?.method === 'DELETE') {
      return jsonResponse({ error: { code: 'VALIDATION_ERROR', message } }, 400)
    }
    const read = connectedGbpRead(urlPath, [makeLocation({})])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  const queryClient = createQueryClient()
  onTestFinished(() => queryClient.clear())
  renderGbpSection({ queryClient })

  const disconnect = await screen.findByRole('button', { name: GBP_DISCONNECT_COPY.disconnect })
  fireEvent.click(disconnect)
  const confirmation = within(screen.getByRole('group', { name: GBP_DISCONNECT_COPY.confirmTitle }))
  fireEvent.click(confirmation.getByRole('button', { name: GBP_DISCONNECT_COPY.confirm }))

  expect((await confirmation.findByRole('alert')).textContent).toBe(message)
  expect(screen.getByText('Connected')).toBeTruthy()
  fireEvent.click(confirmation.getByRole('button', { name: GBP_DISCONNECT_COPY.cancel }))
  expect(document.activeElement).toBe(disconnect)
  fireEvent.click(disconnect)
  expect(within(screen.getByRole('group', { name: GBP_DISCONNECT_COPY.confirmTitle })).queryByRole('alert')).toBeNull()
})

test('a signed-in viewer sees a managed empty state and no admin-only reads', async () => {
  const log = recordRequests()
  const restoreFetch = mockFetch((url, init) => {
    log.record(url, init)
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection({ account: signedInViewer })

  await screen.findByRole('heading', { name: 'Connect Google Business Profile' })
  expect(screen.getByText(GBP_MANAGED_EMPTY_COPY)).toBeTruthy()
  // No Connect, and no false "App credentials missing" from a refused /settings read.
  expect(screen.queryByRole('button', { name: GBP_CONNECT_COPY.connect })).toBeNull()
  expect(screen.queryByText('App credentials missing')).toBeNull()
  expect(screen.getByText('Connect using the CLI', { selector: 'summary' })).toBeTruthy()
  expect(log.requests).toEqual(['GET /api/v1/projects/test-project/google/connections'])
})

test('a viewer of a connection with no locations gets no account picker and no live account read', async () => {
  const log = recordRequests()
  const restoreFetch = mockFetch((url, init) => {
    log.record(url, init)
    const read = connectedGbpRead(url.split('?')[0]!, [])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection({ account: signedInViewer })

  await screen.findByText(GBP_DISCOVER_COPY.noneDiscoveredManaged)
  // No picker stuck on "Loading accounts…"; the discover control is shown off.
  expect(screen.queryByLabelText(GBP_DISCOVER_COPY.accountLabel)).toBeNull()
  expect((screen.getByRole('button', { name: GBP_DISCOVER_COPY.discover }) as HTMLButtonElement).disabled).toBe(true)
  expect(log.requests.some((request) => request.endsWith('/gbp/accounts'))).toBe(false)
})

test("a project-scoped key discovers the connection's default account without listing accounts", async () => {
  const discoverBodies: unknown[] = []
  const log = recordRequests()
  const restoreFetch = mockFetch((url, init) => {
    log.record(url, init)
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/locations/discover') && init?.method === 'POST') {
      discoverBodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
    }
    const read = connectedGbpRead(urlPath, [])
    if (read) return read
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection({ apiKey: projectScopedKey })

  await screen.findByText(GBP_DISCOVER_COPY.noneDiscoveredDefaultAccount)
  expect(screen.queryByLabelText(GBP_DISCOVER_COPY.accountLabel)).toBeNull()
  const discover = screen.getByRole('button', { name: GBP_DISCOVER_COPY.discover }) as HTMLButtonElement
  expect(discover.disabled).toBe(false)
  fireEvent.click(discover)

  // Same body as `canonry gbp locations discover`: no account, so the server
  // uses the one the connection can see.
  await waitFor(() => expect(discoverBodies).toEqual([{ selectAllNew: true }]))
  expect(log.requests.some((request) => request.endsWith('/gbp/accounts'))).toBe(false)
})

test('Sync queues a gbp-sync run, stays disabled, and hands off to the run tracker', async () => {
  const restoreFetch = mockFetch((url, init) => {
    const urlPath = url.split('?')[0]!
    if (urlPath.endsWith('/projects/test-project/gbp/sync') && init?.method === 'POST') {
      // POST /gbp/sync queues an async run and returns immediately.
      return jsonResponse({ runId: 'gbp-run-1', status: 'running' })
    }
    if (urlPath.endsWith('/projects/test-project/google/connections')) return jsonResponse([gbpConnection])
    if (urlPath.endsWith('/projects/test-project/gbp/summary')) return jsonResponse(emptySummary())
    if (urlPath.endsWith('/projects/test-project/gbp/locations')) {
      return jsonResponse({ locations: [makeLocation({})], totalDiscovered: 1, totalSelected: 1 })
    }
    if (urlPath.endsWith('/projects/test-project/gbp/keywords')) return jsonResponse({ keywords: [], total: 0, thresholdedPct: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/lodging')) return jsonResponse({ lodging: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/place-actions')) return jsonResponse({ placeActions: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/gbp/places')) return jsonResponse({ places: [], total: 0 })
    if (urlPath.endsWith('/projects/test-project/insights')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? ''}`)
  })
  onTestFinished(restoreFetch)

  renderGbpSection()

  // The Sync action is enabled once the connection resolves.
  const syncButton = await screen.findByRole('button', { name: 'Sync' })
  expect(syncButton.hasAttribute('disabled')).toBe(false)

  fireEvent.click(syncButton)

  // The button stays disabled and reads "Syncing…" while the queued run is in
  // flight — it does not snap back to "Sync" the instant the POST returns. (The
  // global RunNotificationObserver, not mounted here, clears the tracked run on
  // completion, which is what re-enables it in the app.)
  await waitFor(() => expect(screen.getByRole('button', { name: /Syncing/ })).toBeTruthy())
  expect(screen.getByRole('button', { name: /Syncing/ }).hasAttribute('disabled')).toBe(true)

  // The async run is handed to the global run tracker (which polls it to
  // completion and then invalidates the GBP queries) rather than invalidating
  // eagerly here while the data is still stale.
  const tracked = Object.values(getRunTrackerState().runs)
  expect(tracked).toHaveLength(1)
  expect(tracked[0]).toMatchObject({
    runId: 'gbp-run-1',
    projectId: 'p1',
    kind: 'gbp-sync',
    sourceAction: 'gbp-sync',
  })

  // When the run reaches a terminal status the observer drops it from the
  // tracker (RunNotificationObserver → removeTrackedRun). Simulate that and
  // assert the Sync button re-enables — i.e. it stays disabled *until the sync
  // is complete*, not just for the POST.
  act(() => removeTrackedRun('gbp-run-1'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sync' }).hasAttribute('disabled')).toBe(false))
})

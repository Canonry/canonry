import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { formatDate } from '@ainyc/canonry-contracts'
import type { GaSearchLandingPagesResponse } from '@ainyc/canonry-contracts'

import { GoogleOrganicSearchPagesPanel, SEARCH_LANDING_COPY } from '../src/components/project/ActivitySection.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

afterEach(cleanup)

const ENDPOINT = '/api/v1/projects/test-project/ga/search-landing-pages'
const SYNCED_AT = '2026-10-08T15:00:00.000Z'

/**
 * A stored 28-day window whose rows deliberately do NOT add up to the Total
 * (GA4 reported 87 pages, three are served here): the panel must print GA4's
 * Total, never a sum of what it shows. All values are synthetic.
 */
function readyWindow(overrides: Partial<GaSearchLandingPagesResponse> = {}): GaSearchLandingPagesResponse {
  return {
    source: 'ga4-search-console-link',
    status: 'ready',
    error: null,
    syncedAt: SYNCED_AT,
    attemptedAt: SYNCED_AT,
    window: '28d',
    windowStart: '2026-09-10',
    windowEnd: '2026-10-07',
    windowDays: 28,
    timeZone: 'America/Los_Angeles',
    subjectToThresholding: false,
    dataLossFromOtherRow: false,
    total: {
      organicGoogleSearchClicks: 837,
      organicGoogleSearchImpressions: 41422,
      organicGoogleSearchClickThroughRate: 0.02020665,
      organicGoogleSearchAveragePosition: 7.31567765921491,
      activeUsers: 1093,
    },
    reportRowCount: 87,
    rowsCapped: false,
    totalRows: 3,
    limit: 1000,
    offset: 0,
    rows: [
      { landingPage: '/', organicGoogleSearchClicks: 612, organicGoogleSearchImpressions: 13940, organicGoogleSearchClickThroughRate: 0.04390244, organicGoogleSearchAveragePosition: 7.2103299856527974, activeUsers: 734 },
      { landingPage: '/pricing', organicGoogleSearchClicks: 57, organicGoogleSearchImpressions: 3120, organicGoogleSearchClickThroughRate: 0.01826923, organicGoogleSearchAveragePosition: 5.1301282051282051, activeUsers: 71 },
      { landingPage: '/members?ref=newsletter', organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 4 },
    ],
    ...overrides,
  }
}

function neverSynced(): GaSearchLandingPagesResponse {
  return readyWindow({
    status: 'never-synced',
    syncedAt: null,
    attemptedAt: null,
    windowStart: null,
    windowEnd: null,
    windowDays: null,
    timeZone: null,
    total: null,
    reportRowCount: null,
    totalRows: 0,
    rows: [],
  })
}

/** Serves `respond(window)` for the panel's read and records every request URL. */
function serve(respond: (window: string | null) => Response | Promise<Response>): string[] {
  const requests: string[] = []
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    if (!path.startsWith(ENDPOINT)) throw new Error(`Unexpected fetch: ${url}`)
    requests.push(path)
    return respond(new URL(url).searchParams.get('window'))
  })
  onTestFinished(restore)
  return requests
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GoogleOrganicSearchPagesPanel projectName="test-project" />
    </QueryClientProvider>,
  )
}

/** Each body row's cells as text, the Total row first as rendered. */
function bodyRows(): string[][] {
  const table = screen.getByRole('table', { name: SEARCH_LANDING_COPY.heading })
  const [, ...rows] = within(table).getAllByRole('row')
  return rows.map(row => within(row).getAllByRole('cell').map(cell => cell.textContent ?? ''))
}

const TOTAL_CELL = `${SEARCH_LANDING_COPY.totalLabel} ${SEARCH_LANDING_COPY.totalScope}`

test('shows a loading line while the stored report is read', async () => {
  serve(() => new Promise<Response>(() => {}))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.loading)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

test('prints GA4\'s Total first and the API rows as served, never a sum of them', async () => {
  const requests = serve(() => jsonResponse(readyWindow()))

  renderPanel()

  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })
  // The read asks for GA4's default window and the whole stored page set.
  expect(requests).toEqual([`${ENDPOINT}?window=28d&limit=1000`])
  expect(screen.getByText(`${formatDate('2026-09-10')} to ${formatDate('2026-10-07')} (America/Los_Angeles)`)).toBeTruthy()
  expect(bodyRows()).toEqual([
    // GA4's Total: 837 clicks, while the three rows add up to 669.
    [TOTAL_CELL, '837', '41,422', '2.0%', '7.3', '1,093'],
    ['/', '612', '13,940', '4.4%', '7.2', '734'],
    ['/pricing', '57', '3,120', '1.8%', '5.1', '71'],
    // No impressions: CTR and position are undefined, never 0.
    ['/members?ref=newsletter', '0', '0', 'n/a', 'n/a', '4'],
  ])
  expect(screen.queryByTestId('ga-search-landing-status')).toBeNull()
  expect(screen.queryByText(SEARCH_LANDING_COPY.noSearchTraffic)).toBeNull()
})

test('keeps the Total fixed while the filter narrows the rows', async () => {
  serve(() => jsonResponse(readyWindow()))
  renderPanel()
  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter Google organic search landing pages' }), { target: { value: 'pricing' } })

  expect(bodyRows()).toEqual([
    [TOTAL_CELL, '837', '41,422', '2.0%', '7.3', '1,093'],
    ['/pricing', '57', '3,120', '1.8%', '5.1', '71'],
  ])

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter Google organic search landing pages' }), { target: { value: 'no-such-page' } })

  expect(bodyRows()).toEqual([[TOTAL_CELL, '837', '41,422', '2.0%', '7.3', '1,093']])
  expect(screen.getByText(SEARCH_LANDING_COPY.noFilterMatch)).toBeTruthy()
})

test('says the filter searched only the loaded pages when more are stored', async () => {
  // Three of 1,500 stored pages are loaded: a miss here is not a miss in the window.
  serve(() => jsonResponse(readyWindow({ totalRows: 1500 })))
  renderPanel()
  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })

  fireEvent.change(screen.getByRole('searchbox', { name: 'Filter Google organic search landing pages' }), { target: { value: 'no-such-page' } })

  expect(screen.getByText(SEARCH_LANDING_COPY.noFilterMatchInLoaded(3))).toBeTruthy()
  expect(screen.queryByText(SEARCH_LANDING_COPY.noFilterMatch)).toBeNull()
  expect(screen.getByText('Showing the top 3 of 1,500 stored pages by clicks.')).toBeTruthy()
})

test('requests the picked window and shows that window\'s own Total', async () => {
  const requests = serve((window) => jsonResponse(window === '7d'
    ? readyWindow({
        window: '7d',
        windowStart: '2026-10-01',
        windowDays: 7,
        total: { organicGoogleSearchClicks: 301, organicGoogleSearchImpressions: 9876, organicGoogleSearchClickThroughRate: 0.03047792, organicGoogleSearchAveragePosition: 5.25, activeUsers: 377 },
        totalRows: 1,
        rows: [{ landingPage: '/', organicGoogleSearchClicks: 250, organicGoogleSearchImpressions: 4100, organicGoogleSearchClickThroughRate: 0.06097561, organicGoogleSearchAveragePosition: 6.04, activeUsers: 310 }],
      })
    : readyWindow()))
  renderPanel()
  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })

  const picker = screen.getByRole('group', { name: SEARCH_LANDING_COPY.windowLabel })
  expect(within(picker).getAllByRole('button').map(button => button.textContent)).toEqual(['7d', '28d', '90d'])
  fireEvent.click(within(picker).getByRole('button', { name: '7d' }))

  await waitFor(() => expect(bodyRows()[0]).toEqual([TOTAL_CELL, '301', '9,876', '3.0%', '5.3', '377']))
  expect(requests.at(-1)).toBe(`${ENDPOINT}?window=7d&limit=1000`)
  expect(bodyRows()).toHaveLength(2)
  expect(within(picker).getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe('true')
})

test('tells a never-synced project to sync GA4', async () => {
  serve(() => jsonResponse(neverSynced()))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.neverSynced)).toBeTruthy()
  expect(screen.getByText(SEARCH_LANDING_COPY.neverSyncedAction)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})

test('says a ready window with no pages may need the Search Console link', async () => {
  serve(() => jsonResponse(readyWindow({
    total: { organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 0 },
    reportRowCount: 0,
    totalRows: 0,
    rows: [],
  })))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.noSearchTraffic)).toBeTruthy()
  expect(screen.getByText(SEARCH_LANDING_COPY.noSearchTrafficAction)).toBeTruthy()
  expect(bodyRows()).toEqual([[TOTAL_CELL, '0', '0', 'n/a', 'n/a', '0']])
})

test('gives the Search Console link hint when pages are listed but the Total has no clicks or impressions', async () => {
  // GA4 lists pages with active users and no Google organic search data.
  serve(() => jsonResponse(readyWindow({
    total: { organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 9 },
    reportRowCount: 2,
    totalRows: 2,
    rows: [
      { landingPage: '/', organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 6 },
      { landingPage: '/members?ref=newsletter', organicGoogleSearchClicks: 0, organicGoogleSearchImpressions: 0, organicGoogleSearchClickThroughRate: null, organicGoogleSearchAveragePosition: null, activeUsers: 3 },
    ],
  })))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.noSearchTraffic)).toBeTruthy()
  expect(screen.getByText(SEARCH_LANDING_COPY.noSearchTrafficAction)).toBeTruthy()
  expect(bodyRows()).toEqual([
    [TOTAL_CELL, '0', '0', 'n/a', 'n/a', '9'],
    ['/', '0', '0', 'n/a', 'n/a', '6'],
    ['/members?ref=newsletter', '0', '0', 'n/a', 'n/a', '3'],
  ])
})

test('gives no Search Console link hint when the Total has search data but no pages are stored', async () => {
  // Thresholding can withhold every row while GA4's Total still counts them.
  serve(() => jsonResponse(readyWindow({ subjectToThresholding: true, totalRows: 0, rows: [] })))

  renderPanel()

  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })
  expect(bodyRows()).toEqual([[TOTAL_CELL, '837', '41,422', '2.0%', '7.3', '1,093']])
  expect(screen.queryByText(SEARCH_LANDING_COPY.noSearchTraffic)).toBeNull()
  expect(screen.queryByText(SEARCH_LANDING_COPY.noSearchTrafficAction)).toBeNull()
})

test('notes an unavailable refresh beside the last good snapshot', async () => {
  const reason = 'GA4 API error (400): Field organicGoogleSearchClicks is not available for this property.'
  serve(() => jsonResponse(readyWindow({ status: 'unavailable', error: reason, attemptedAt: '2026-10-09T15:00:00.000Z' })))

  renderPanel()

  const status = await screen.findByTestId('ga-search-landing-status')
  expect(within(status).getByText(SEARCH_LANDING_COPY.unavailableBadge)).toBeTruthy()
  // Google's own message rides the badge's tooltip.
  expect(within(status).getByRole('button', { name: reason })).toBeTruthy()
  expect(status.textContent).toContain(`${SEARCH_LANDING_COPY.previousSnapshot} `)
  // The same fix the no-snapshot card and the CLI give.
  expect(within(status).getByText(SEARCH_LANDING_COPY.unavailableAction)).toBeTruthy()
  // The previous snapshot is still the API's, Total first.
  expect(bodyRows()[0]).toEqual([TOTAL_CELL, '837', '41,422', '2.0%', '7.3', '1,093'])
  expect(screen.queryByText(SEARCH_LANDING_COPY.unavailable)).toBeNull()
})

test('says a failed first refresh failed, with Google\'s message, when there is no snapshot', async () => {
  serve(() => jsonResponse({ ...neverSynced(), status: 'error', error: 'GA4 API error (500): backend error', attemptedAt: SYNCED_AT }))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.refreshFailed)).toBeTruthy()
  expect(screen.getByText('GA4 API error (500): backend error')).toBeTruthy()
  const status = screen.getByTestId('ga-search-landing-status')
  expect(within(status).getByText(SEARCH_LANDING_COPY.refreshFailedBadge)).toBeTruthy()
  // No snapshot exists, so there is none to call the last good one.
  expect(status.textContent).not.toContain(SEARCH_LANDING_COPY.previousSnapshot)
  expect(screen.queryByText(SEARCH_LANDING_COPY.neverSynced)).toBeNull()
  expect(screen.queryByRole('table')).toBeNull()
})

test('explains how to link Search Console when the first attempt was refused', async () => {
  serve(() => jsonResponse({ ...neverSynced(), status: 'unavailable', error: 'GA4 returned no Search Console rows (NO_LINK)', attemptedAt: SYNCED_AT }))

  renderPanel()

  expect(await screen.findByText(SEARCH_LANDING_COPY.unavailable)).toBeTruthy()
  expect(screen.getByText(SEARCH_LANDING_COPY.unavailableAction)).toBeTruthy()
  const status = screen.getByTestId('ga-search-landing-status')
  expect(within(status).getByText(SEARCH_LANDING_COPY.unavailableBadge)).toBeTruthy()
  // No snapshot exists, so there is none to call the last good one.
  expect(status.textContent).not.toContain(SEARCH_LANDING_COPY.previousSnapshot)
  expect(screen.queryByRole('table')).toBeNull()
})

test('flags a failed refresh, keeps the snapshot, and marks thresholding', async () => {
  serve(() => jsonResponse(readyWindow({ status: 'error', error: 'GA4 API rate limit exceeded', subjectToThresholding: true })))

  renderPanel()

  const status = await screen.findByTestId('ga-search-landing-status')
  expect(within(status).getByText(SEARCH_LANDING_COPY.refreshFailedBadge)).toBeTruthy()
  expect(within(status).getByRole('button', { name: 'GA4 API rate limit exceeded' })).toBeTruthy()
  expect(within(status).getByText(SEARCH_LANDING_COPY.thresholdedBadge)).toBeTruthy()
  expect(within(status).getByRole('button', { name: SEARCH_LANDING_COPY.thresholded })).toBeTruthy()
  expect(status.textContent).toContain(SEARCH_LANDING_COPY.previousSnapshot)
  expect(bodyRows()).toHaveLength(4)
})

test('says when GA4 reported more pages than were stored', async () => {
  serve(() => jsonResponse(readyWindow({ rowsCapped: true, reportRowCount: 18700 })))

  renderPanel()

  expect(await screen.findByText('GA4 reported 18,700 pages; the 3 with the most clicks are stored.')).toBeTruthy()
})

test('shows an alert with a retry when the read fails', async () => {
  let failing = true
  const requests = serve(() => failing
    ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'database is locked' } }, 500)
    : jsonResponse(readyWindow()))

  renderPanel()

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(SEARCH_LANDING_COPY.loadError)
  expect(screen.queryByRole('table')).toBeNull()

  failing = false
  fireEvent.click(within(alert).getByRole('button', { name: SEARCH_LANDING_COPY.retry }))

  await screen.findByRole('table', { name: SEARCH_LANDING_COPY.heading })
  expect(requests).toHaveLength(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

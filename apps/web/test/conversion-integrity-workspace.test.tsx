import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ConversionIntegrityWorkspace, gtmSelectionSummary } from '../src/components/project/ConversionIntegrityWorkspace.js'
import { getRunTrackerState, resetRunTracker } from '../src/lib/run-tracker-store.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const capturedAt = '2026-08-14T12:00:00.000Z'

const contract = {
  id: 'contract_purchase',
  projectId: 'project_example',
  name: 'Payment confirmed',
  eventName: 'purchase',
  googleAds: {
    customerId: '5550001234',
    conversionActionId: 'payment-confirmed',
    conversionId: '12345678901',
    conversionLabel: 'ExampleLabel0000_X1-',
    campaignIds: ['g_s_bayside-hotels'],
    requireBiddableGoal: true,
    requirePrimaryAction: true,
  },
  gtm: {
    accountId: 'account_example',
    containerId: 'GTM-TEST123',
    tagId: 'tag_purchase_confirmation',
    triggerIds: ['purchase-trigger'],
    variableIds: ['value-variable', 'transaction-id-variable', 'currency-variable'],
  },
  runtime: {
    verificationRequired: true,
    requireTransactionId: true,
    requireValue: true,
    requireCurrency: true,
    productionHosts: ['example.com'],
  },
  createdAt: capturedAt,
  updatedAt: capturedAt,
}

const adsConnection = {
  id: 'ads_connection',
  projectId: 'project_example',
  scopes: ['https://www.googleapis.com/auth/adwords'],
  selection: { loginCustomerId: null, customerId: '5550001234', selectedAt: capturedAt },
  lastValidatedAt: capturedAt,
  lastInventorySnapshotAt: capturedAt,
  lastMetricsSnapshotAt: null,
  createdAt: capturedAt,
  updatedAt: capturedAt,
}

const gtmConnection = {
  id: 'gtm_connection',
  projectId: 'project_example',
  scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
  selection: { accountId: 'account_example', containerId: 'GTM-TEST123', workspaceId: null, selectedAt: capturedAt },
  lastValidatedAt: capturedAt,
  lastSnapshotAt: capturedAt,
  createdAt: capturedAt,
  updatedAt: capturedAt,
}

afterEach(() => {
  cleanup()
  resetRunTracker()
})

function queuedRun(id: string, kind: 'google-ads-sync' | 'gtm-sync') {
  return {
    id,
    projectId: 'project_example',
    kind,
    status: 'queued',
    trigger: 'manual',
    createdAt: capturedAt,
  }
}

function googleAdsStatus(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    status: 'connected',
    connection: adsConnection,
    selectedCustomer: {
      resourceName: 'customers/5550001234',
      customerId: '5550001234',
      parentCustomerId: null,
      descriptiveName: 'Example Hotel',
      currencyCode: 'USD',
      timeZone: 'America/Los_Angeles',
      manager: false,
      hidden: false,
      testAccount: false,
      level: 0,
      status: 'enabled',
    },
    ...overrides,
  }
}

function gtmStatus(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    status: 'connected',
    connection: gtmConnection,
    selection: gtmConnection.selection,
    ...overrides,
  }
}

function renderWorkspace(projectName = 'example', projectId = 'project_example') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ConversionIntegrityWorkspace projectId={projectId} projectName={projectName} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient }
}

type MarketingFixture = {
  projectName?: string
  googleAds?: unknown
  gtm?: unknown
  contracts?: unknown[]
  googleAdsSnapshots?: unknown
  gtmSnapshots?: unknown
  integrity?: (contractId: string) => unknown
  googleAdsCustomers?: unknown
  gtmAccounts?: unknown
  gtmContainers?: unknown
  gtmWorkspaces?: unknown
  googleAdsRun?: unknown
  gtmRun?: unknown
  gtmSelectionResponse?: unknown
  createdContract?: unknown
  googleAdsDisconnect?: { body: unknown; status?: number }
  gtmDisconnect?: { body: unknown; status?: number }
  onRequest?: (path: string, init?: RequestInit) => void
}

function installMarketingFetch(fixture: MarketingFixture, requested: string[]) {
  const projectName = fixture.projectName ?? 'example'
  const prefix = `/api/v1/projects/${projectName}`
  const googleAds = fixture.googleAds ?? googleAdsStatus()
  const gtm = fixture.gtm ?? gtmStatus()

  const restore = mockFetch((url, init) => {
    const path = pathOf(url)
    requested.push(path)
    fixture.onRequest?.(path, init)
    if (path === `${prefix}/google-ads/connection` && init?.method === 'DELETE') {
      return jsonResponse(fixture.googleAdsDisconnect?.body ?? { provider: 'google-ads', disconnected: true }, fixture.googleAdsDisconnect?.status ?? 200)
    }
    if (path === `${prefix}/gtm/connection` && init?.method === 'DELETE') {
      return jsonResponse(fixture.gtmDisconnect?.body ?? { provider: 'gtm', disconnected: true }, fixture.gtmDisconnect?.status ?? 200)
    }
    if (path.startsWith(`${prefix}/google-ads/status`)) return jsonResponse(googleAds)
    if (path.startsWith(`${prefix}/gtm/status`)) return jsonResponse(gtm)
    if (path.startsWith(`${prefix}/google-ads/snapshots`)) {
      return jsonResponse(fixture.googleAdsSnapshots ?? { snapshots: [], nextCursor: null, total: 0 })
    }
    if (path.startsWith(`${prefix}/gtm/snapshots`)) {
      return jsonResponse(fixture.gtmSnapshots ?? { snapshots: [], nextCursor: null, total: 0 })
    }
    if (path.startsWith(`${prefix}/conversion-tracking/contracts/`) && path.includes('/integrity')) {
      const contractId = path.split('/').at(-2) ?? ''
      return jsonResponse(fixture.integrity?.(contractId) ?? { error: { message: 'Unexpected integrity read' } }, fixture.integrity ? 200 : 500)
    }
    if (path === `${prefix}/conversion-tracking/contracts` && init?.method === 'POST') {
      return jsonResponse(fixture.createdContract ?? { error: { message: 'Unexpected contract write' } }, fixture.createdContract ? 200 : 500)
    }
    if (path === `${prefix}/conversion-tracking/options`) {
      return jsonResponse({
        googleAds: {
          customerId: '5550001234',
          syncedAt: '2026-08-24T23:11:24.362Z',
          conversionActions: [
            { id: 'refund-confirmed', name: 'Refund confirmed', detail: 'PURCHASE', active: true },
          ],
        },
        gtm: {
          containerId: 'GTM-K7X2P9',
          syncedAt: '2026-08-24T23:11:25.154Z',
          tags: [{ id: 'tag_refund_confirmation', name: 'Refund confirmation', detail: 'awct', active: true }],
        },
      })
    }
    if (path.startsWith(`${prefix}/conversion-tracking/contracts`)) return jsonResponse(fixture.contracts ?? [])
    if (path.startsWith(`${prefix}/google-ads/sync`) && init?.method === 'POST') {
      return jsonResponse(fixture.googleAdsRun ?? queuedRun('run_google_ads_sync', 'google-ads-sync'))
    }
    if (path.startsWith(`${prefix}/gtm/sync`) && init?.method === 'POST') {
      return jsonResponse(fixture.gtmRun ?? queuedRun('run_gtm_sync', 'gtm-sync'))
    }
    if (path.startsWith(`${prefix}/gtm/selection`) && init?.method === 'PUT') {
      return jsonResponse(fixture.gtmSelectionResponse ?? gtm)
    }
    if (path.startsWith(`${prefix}/google-ads/customers`)) {
      return jsonResponse(fixture.googleAdsCustomers ?? {
        customers: [], totalAccessible: 0, truncated: false, selection: adsConnection.selection, fetchedAt: capturedAt,
      })
    }
    if (path.startsWith(`${prefix}/gtm/accounts/`) && path.includes('/containers/') && path.includes('/workspaces')) {
      return jsonResponse(fixture.gtmWorkspaces ?? {
        accountId: 'account_example', containerId: 'GTM-TEST123', workspaces: [], totalAccessible: 0, truncated: false, fetchedAt: capturedAt,
      })
    }
    if (path.startsWith(`${prefix}/gtm/accounts/`) && path.includes('/containers')) {
      return jsonResponse(fixture.gtmContainers ?? {
        accountId: 'account_example', containers: [], totalAccessible: 0, truncated: false, fetchedAt: capturedAt,
      })
    }
    if (path.startsWith(`${prefix}/gtm/accounts`)) {
      return jsonResponse(fixture.gtmAccounts ?? { accounts: [], totalAccessible: 0, truncated: false, fetchedAt: capturedAt })
    }
    return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
  })
  onTestFinished(restore)
}

function installScrollSpy(reducedMotion = false) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: reducedMotion }))
  const scrollIntoView = vi.fn()
  const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  onTestFinished(() => {
    vi.unstubAllGlobals()
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })
  return scrollIntoView
}

describe('ConversionIntegrityWorkspace', () => {
  test('reads the generated Google Ads, GTM, snapshot, and integrity endpoints into one workspace', async () => {
    const requested: string[] = []
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      requested.push(path)

      if (path.startsWith('/api/v1/projects/example/google-ads/status')) {
        return jsonResponse({
          connected: true,
          status: 'connected',
          connection: adsConnection,
          selectedCustomer: {
            resourceName: 'customers/5550001234',
            customerId: '5550001234',
            parentCustomerId: null,
            descriptiveName: 'Example Hotel',
            currencyCode: 'USD',
            timeZone: 'America/Los_Angeles',
            manager: false,
            hidden: false,
            testAccount: false,
            level: 0,
            status: 'enabled',
          },
        })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/status')) {
        return jsonResponse({
          connected: true,
          status: 'connected',
          connection: gtmConnection,
          selection: gtmConnection.selection,
        })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts/contract_purchase/integrity')) {
        return jsonResponse({
          assessment: {
            contract,
            status: 'runtime-unverified',
            evaluatedAt: capturedAt,
            findings: [{
              code: 'runtime-event-not-observed',
              subject: 'purchase',
              outcome: 'unknown',
              status: 'runtime-unverified',
              evidenceIds: ['ads_inventory', 'gtm_live'],
            }],
          },
          googleAdsSnapshot: null,
          gtmSnapshot: null,
        })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) {
        return jsonResponse([contract])
      }
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 1 })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 1 })
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ConversionIntegrityWorkspace projectId="project_example" projectName="example" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('Runtime verification needed')).toBeTruthy())

    expect(screen.getByText('Payment confirmed')).toBeTruthy()
    expect(screen.getByText('Example Hotel')).toBeTruthy()
    // The selection names the container it points at, not the fields that
    // happen to be filled in. "Selected account and container" read the same
    // for every project on the instance.
    expect(screen.getByText('Container GTM-TEST123 · account account_example')).toBeTruthy()
    expect(screen.getByText('Static API evidence does not prove that a browser tag fired or that Google Ads recorded a conversion.')).toBeTruthy()
    expect(requested).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/api\/v1\/projects\/example\/google-ads\/status/),
      expect.stringMatching(/^\/api\/v1\/projects\/example\/gtm\/status/),
      expect.stringMatching(/^\/api\/v1\/projects\/example\/google-ads\/snapshots/),
      expect.stringMatching(/^\/api\/v1\/projects\/example\/gtm\/snapshots/),
      expect.stringMatching(/^\/api\/v1\/projects\/example\/conversion-tracking\/contracts$/),
      expect.stringMatching(/^\/api\/v1\/projects\/example\/conversion-tracking\/contracts\/contract_purchase\/integrity/),
    ]))

    queryClient.clear()
  })

  test.each([
    {
      provider: 'Google Ads',
      changeAction: 'Change Google Ads account',
      connectionPath: '/api/v1/projects/example/google-ads/connection',
      connectAction: 'Connect Google Ads',
    },
    {
      provider: 'Tag Manager',
      changeAction: 'Change Tag Manager container',
      connectionPath: '/api/v1/projects/example/gtm/connection',
      connectAction: 'Connect Google Tag Manager',
    },
  ])('disconnects $provider only after inline confirmation and retains saved evidence', async ({
    provider,
    changeAction,
    connectionPath,
    connectAction,
  }) => {
    const requests: Array<{ path: string; method: string }> = []
    let disconnectedProvider: string | null = null
    const restore = mockFetch((url, init) => {
      const path = pathOf(url)
      const method = init?.method ?? 'GET'
      requests.push({ path, method })

      if (path === connectionPath && method === 'DELETE') {
        disconnectedProvider = provider
        return jsonResponse({ provider: provider === 'Google Ads' ? 'google-ads' : 'gtm', disconnected: true })
      }
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) {
        return jsonResponse(disconnectedProvider === 'Google Ads'
          ? { connected: false, status: 'not-connected', connection: null, selectedCustomer: null }
          : googleAdsStatus())
      }
      if (path.startsWith('/api/v1/projects/example/gtm/status')) {
        return jsonResponse(disconnectedProvider === 'Tag Manager'
          ? { connected: false, status: 'not-connected', connection: null, selection: null }
          : gtmStatus())
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts/contract_purchase/integrity')) {
        return jsonResponse({
          assessment: {
            contract,
            status: 'runtime-unverified',
            evaluatedAt: capturedAt,
            findings: [],
          },
          googleAdsSnapshot: null,
          gtmSnapshot: null,
        })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) return jsonResponse([contract])
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots')) {
        return jsonResponse({ snapshots: [{ id: 'ads_retained', kind: 'inventory', capturedAt }], nextCursor: null, total: 1 })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [{ id: 'gtm_retained', kind: 'live', capturedAt }], nextCursor: null, total: 1 })
      }
      if (path.startsWith('/api/v1/projects/example/google-ads/customers')) {
        return jsonResponse({ customers: [googleAdsStatus().selectedCustomer], totalAccessible: 1, truncated: false, selection: adsConnection.selection, fetchedAt: capturedAt })
      }
      if (path.includes('/gtm/accounts/account_example/containers/GTM-TEST123/workspaces')) {
        return jsonResponse({ accountId: 'account_example', containerId: 'GTM-TEST123', workspaces: [], totalAccessible: 0, truncated: false, fetchedAt: capturedAt })
      }
      if (path.includes('/gtm/accounts/account_example/containers')) {
        return jsonResponse({ accountId: 'account_example', containers: [{ id: 'GTM-TEST123', name: 'Production container' }], totalAccessible: 1, truncated: false, fetchedAt: capturedAt })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/accounts')) {
        return jsonResponse({ accounts: [{ id: 'account_example', name: 'Example account' }], totalAccessible: 1, truncated: false, fetchedAt: capturedAt })
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()
    const changeButton = await screen.findByRole('button', { name: changeAction })
    fireEvent.click(changeButton)

    const disconnectTrigger = await screen.findByRole('button', { name: `Disconnect ${provider}` })
    disconnectTrigger.focus()
    fireEvent.click(disconnectTrigger)
    expect(requests.some((request) => request.path === connectionPath && request.method === 'DELETE')).toBe(false)
    expect(screen.getByRole('group', { name: `Confirm disconnect ${provider}` })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep connected' })))

    fireEvent.click(screen.getByRole('button', { name: 'Keep connected' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: `Disconnect ${provider}` })))

    fireEvent.click(screen.getByRole('button', { name: `Disconnect ${provider}` }))
    fireEvent.click(screen.getByRole('button', { name: `Disconnect ${provider}` }))

    await waitFor(() => expect(screen.getByRole('button', { name: connectAction })).toBeTruthy())
    expect(requests.filter((request) => request.path === connectionPath && request.method === 'DELETE')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Payment confirmed' })).toBeTruthy()
    expect(screen.getByText('ads_retained')).toBeTruthy()
    expect(screen.getByText('gtm_retained')).toBeTruthy()

    queryClient.clear()
  })

  test('keeps disconnect confirmation open and surfaces a provider error when the request fails', async () => {
    const requested: string[] = []
    installMarketingFetch({
      contracts: [contract],
      integrity: () => ({
        assessment: { contract, status: 'runtime-unverified', evaluatedAt: capturedAt, findings: [] },
        googleAdsSnapshot: null,
        gtmSnapshot: null,
      }),
      googleAdsDisconnect: {
        body: { error: { message: 'Google Ads disconnect unavailable' } },
        status: 503,
      },
    }, requested)

    const { queryClient } = renderWorkspace()
    fireEvent.click(await screen.findByRole('button', { name: 'Change Google Ads account' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Google Ads' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Google Ads' }))

    await waitFor(() => expect(screen.getByText('Google Ads disconnect unavailable')).toBeTruthy())
    expect(screen.getByRole('group', { name: 'Confirm disconnect Google Ads' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disconnect Google Ads' }).hasAttribute('disabled')).toBe(false)
    expect(requested).toContain('/api/v1/projects/example/google-ads/connection')

    queryClient.clear()
  })

  test('treats a saved Google Ads customer without a confirming snapshot as stale, then tracks the queued sync without eager refetches', async () => {
    const requested: string[] = []
    installMarketingFetch({
      googleAds: googleAdsStatus({ status: 'selection-required', selectedCustomer: null }),
      gtm: gtmStatus(),
    }, requested)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Google Ads evidence' })).toBeTruthy())
    expect(screen.getByText('Selected customer 5550001234')).toBeTruthy()

    const storedReadCount = requested.filter((path) => path.includes('/google-ads/status') || path.includes('/google-ads/snapshots')).length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Google Ads evidence' }))

    await waitFor(() => expect(getRunTrackerState().runs.run_google_ads_sync).toMatchObject({
      projectId: 'project_example',
      kind: 'google-ads-sync',
      sourceAction: 'google-ads-sync',
    }))
    expect(requested.filter((path) => path.includes('/google-ads/status') || path.includes('/google-ads/snapshots'))).toHaveLength(storedReadCount)
    expect(screen.getByRole('button', { name: 'Working…' }).hasAttribute('disabled')).toBe(true)

    queryClient.clear()
  })

  test('tracks a queued GTM sync without eagerly rereading stale evidence', async () => {
    const requested: string[] = []
    installMarketingFetch({ gtm: gtmStatus({ status: 'stale' }) }, requested)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Tag Manager evidence' })).toBeTruthy())
    const storedReadCount = requested.filter((path) => path.includes('/gtm/status') || path.includes('/gtm/snapshots')).length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Tag Manager evidence' }))

    await waitFor(() => expect(getRunTrackerState().runs.run_gtm_sync).toMatchObject({
      projectId: 'project_example',
      kind: 'gtm-sync',
      sourceAction: 'gtm-sync',
    }))
    expect(requested.filter((path) => path.includes('/gtm/status') || path.includes('/gtm/snapshots'))).toHaveLength(storedReadCount)

    queryClient.clear()
  })

  test('reveals the Google Ads connection form and returns focus to its opener on cancel', async () => {
    const requested: string[] = []
    installMarketingFetch({
      googleAds: { connected: false, status: 'not-connected', connection: null, selectedCustomer: null },
      contracts: [],
    }, requested)
    const scrollIntoView = installScrollSpy(true)

    const { queryClient } = renderWorkspace()

    const connectTrigger = await screen.findByRole('button', { name: 'Connect Google Ads' })
    connectTrigger.focus()
    fireEvent.click(connectTrigger)

    const heading = await screen.findByRole('heading', { name: 'Connect read-only access' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }))
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(connectTrigger))

    queryClient.clear()
  })

  test('opens the existing Google Ads and Tag Manager selection forms from connected-state controls', async () => {
    const requested: string[] = []
    installMarketingFetch({}, requested)
    const scrollIntoView = installScrollSpy()

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Change Google Ads account' })).toBeTruthy())
    const googleAdsTrigger = screen.getByRole('button', { name: 'Change Google Ads account' })
    googleAdsTrigger.focus()
    fireEvent.click(googleAdsTrigger)
    const googleAdsHeading = await screen.findByRole('heading', { name: 'Select customer context' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }))
    expect(document.activeElement).toBe(googleAdsHeading)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(googleAdsTrigger))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Change Tag Manager container' })).toBeTruthy())
    const gtmTrigger = screen.getByRole('button', { name: 'Change Tag Manager container' })
    fireEvent.click(gtmTrigger)
    const gtmHeading = await screen.findByRole('heading', { name: 'Select container context' })
    await waitFor(() => expect(document.activeElement).toBe(gtmHeading))

    queryClient.clear()
  })

  test('retries failed Google Ads discovery locally and preserves a saved customer outside a truncated response', async () => {
    const requested: string[] = []
    let customerReads = 0
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      requested.push(path)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots') || path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) return jsonResponse([])
      if (path.startsWith('/api/v1/projects/example/google-ads/customers')) {
        customerReads += 1
        if (customerReads === 1) return jsonResponse({ error: { message: 'Customer discovery unavailable' } }, 503)
        return jsonResponse({
          customers: [{ customerId: '1234567890', descriptiveName: 'Another account', parentCustomerId: null }],
          totalAccessible: 2,
          truncated: true,
          selection: adsConnection.selection,
          fetchedAt: capturedAt,
        })
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    const changeSelection = await screen.findByRole('button', { name: 'Change Google Ads account' })
    fireEvent.click(changeSelection)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Customer discovery unavailable'))
    expect(screen.getByRole('option', { name: 'Saved customer 5550001234 (access not verified)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save customer selection' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry customer list' }))
    await waitFor(() => expect(screen.getByText('Incomplete result: showing 1 of 2 accessible customers. Use the CLI or API if the resource is not shown.')).toBeTruthy())
    expect((screen.getByLabelText('Customer account') as HTMLSelectElement).value).toBe('5550001234')
    expect(screen.getByRole('option', { name: 'Saved customer 5550001234 (not in the current result)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save customer selection' }).hasAttribute('disabled')).toBe(false)
    expect(customerReads).toBe(2)

    queryClient.clear()
  })

  test('blocks a saved Google Ads customer that a complete discovery response no longer exposes', async () => {
    const requested: string[] = []
    installMarketingFetch({
      googleAdsCustomers: {
        customers: [{ customerId: '1234567890', descriptiveName: 'Available account', parentCustomerId: null }],
        totalAccessible: 1,
        truncated: false,
        selection: adsConnection.selection,
        fetchedAt: capturedAt,
      },
    }, requested)

    const { queryClient } = renderWorkspace()

    fireEvent.click(await screen.findByRole('button', { name: 'Change Google Ads account' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('saved customer is no longer accessible'))

    const savedOption = screen.getByRole('option', { name: 'Saved customer 5550001234 (no longer accessible)' }) as HTMLOptionElement
    expect(savedOption.disabled).toBe(true)
    expect(screen.getByText('1 accessible customer found.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save customer selection' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText('Customer account'), { target: { value: '1234567890' } })
    expect(screen.queryByText(/saved customer is no longer accessible/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save customer selection' }).hasAttribute('disabled')).toBe(false)

    queryClient.clear()
  })

  test('hydrates a saved GTM account, container, and workspace once, then clears only dependent children on a deliberate account change', async () => {
    const requested: string[] = []
    const gtmSelectionWrites: RequestInit[] = []
    const savedGtmConnection = {
      ...gtmConnection,
      selection: {
        accountId: 'account_saved',
        containerId: 'container_saved',
        workspaceId: 'workspace_saved',
        selectedAt: capturedAt,
      },
    }
    installMarketingFetch({
      gtm: gtmStatus({
        status: 'selection-required',
        connection: savedGtmConnection,
        selection: savedGtmConnection.selection,
      }),
      gtmAccounts: {
        accounts: [
          { id: 'account_saved', name: 'Saved account' },
          { id: 'account_changed', name: 'Changed account' },
        ],
      },
      gtmContainers: { containers: [{ id: 'container_saved', name: 'Saved container' }] },
      gtmWorkspaces: { workspaces: [{ id: 'workspace_saved', name: 'Draft workspace' }] },
      onRequest: (path, init) => {
        if (path.includes('/gtm/selection') && init?.method === 'PUT') gtmSelectionWrites.push(init)
      },
    }, requested)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Tag Manager container' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Select Tag Manager container' }))

    await waitFor(() => expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('account_saved'))
    expect((screen.getByLabelText('Container') as HTMLSelectElement).value).toBe('container_saved')
    expect((screen.getByLabelText('Draft workspace (optional)') as HTMLSelectElement).value).toBe('workspace_saved')

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account_saved' } })
    expect((screen.getByLabelText('Container') as HTMLSelectElement).value).toBe('container_saved')
    expect((screen.getByLabelText('Draft workspace (optional)') as HTMLSelectElement).value).toBe('workspace_saved')

    fireEvent.click(screen.getByRole('button', { name: 'Save container selection' }))
    await waitFor(() => expect(gtmSelectionWrites).toHaveLength(1))
    expect(JSON.parse(String(gtmSelectionWrites[0]?.body))).toMatchObject({
      accountId: 'account_saved',
      containerId: 'container_saved',
      workspaceId: 'workspace_saved',
    })

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Select container context' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Select Tag Manager container' }))
    await waitFor(() => expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('account_saved'))

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account_changed' } })
    expect((screen.getByLabelText('Container') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('Draft workspace (optional)') as HTMLSelectElement).value).toBe('')

    queryClient.clear()
  })

  test('retains saved GTM choices and makes truncated account, container, and workspace discovery explicit', async () => {
    const requested: string[] = []
    const savedGtmConnection = {
      ...gtmConnection,
      selection: {
        accountId: 'account_saved',
        containerId: 'container_saved',
        workspaceId: 'workspace_saved',
        selectedAt: capturedAt,
      },
    }
    installMarketingFetch({
      gtm: gtmStatus({
        status: 'selection-required',
        connection: savedGtmConnection,
        selection: savedGtmConnection.selection,
      }),
      gtmAccounts: { accounts: [], totalAccessible: 1, truncated: true, fetchedAt: capturedAt },
      gtmContainers: { accountId: 'account_saved', containers: [], totalAccessible: 1, truncated: true, fetchedAt: capturedAt },
      gtmWorkspaces: { accountId: 'account_saved', containerId: 'container_saved', workspaces: [], totalAccessible: 1, truncated: true, fetchedAt: capturedAt },
    }, requested)

    const { queryClient } = renderWorkspace()

    const selectContainer = await screen.findByRole('button', { name: 'Select Tag Manager container' })
    fireEvent.click(selectContainer)
    await waitFor(() => expect((screen.getByLabelText('Account') as HTMLSelectElement).value).toBe('account_saved'))
    await waitFor(() => expect(screen.getAllByText(/Use the CLI or API if the resource is not shown\./)).toHaveLength(3))
    expect((screen.getByLabelText('Container') as HTMLSelectElement).value).toBe('container_saved')
    expect((screen.getByLabelText('Draft workspace (optional)') as HTMLSelectElement).value).toBe('workspace_saved')
    expect(screen.getByRole('option', { name: 'Saved account account_saved (not in the current result)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Saved container container_saved (not in the current result)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Saved draft workspace workspace_saved (not in the current result)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(false)

    queryClient.clear()
  })

  test('keeps Tag Manager selection disabled until every saved-resource discovery completes', async () => {
    let resolveAccounts: ((response: Response) => void) | undefined
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots') || path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) return jsonResponse([])
      if (path.includes('/gtm/accounts/account_example/containers/GTM-TEST123/workspaces')) {
        return jsonResponse({
          accountId: 'account_example',
          containerId: 'GTM-TEST123',
          workspaces: [],
          totalAccessible: 0,
          truncated: false,
          fetchedAt: capturedAt,
        })
      }
      if (path.includes('/gtm/accounts/account_example/containers')) {
        return jsonResponse({
          accountId: 'account_example',
          containers: [{ id: 'GTM-TEST123', name: 'Production container' }],
          totalAccessible: 1,
          truncated: false,
          fetchedAt: capturedAt,
        })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/accounts')) {
        return new Promise<Response>((resolve) => { resolveAccounts = resolve })
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    fireEvent.click(await screen.findByRole('button', { name: 'Change Tag Manager container' }))
    await waitFor(() => expect(screen.getByText('1 accessible container found.')).toBeTruthy())
    expect(screen.getByRole('option', { name: 'Saved account account_example (checking access)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(true)

    resolveAccounts?.(jsonResponse({
      accounts: [{ id: 'account_example', name: 'Example account' }],
      totalAccessible: 1,
      truncated: false,
      fetchedAt: capturedAt,
    }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(false))

    queryClient.clear()
  })

  test('lets an operator clear an inaccessible optional draft workspace', async () => {
    const requested: string[] = []
    const savedGtmConnection = {
      ...gtmConnection,
      selection: {
        accountId: 'account_saved',
        containerId: 'container_saved',
        workspaceId: 'workspace_removed',
        selectedAt: capturedAt,
      },
    }
    installMarketingFetch({
      gtm: gtmStatus({ connection: savedGtmConnection, selection: savedGtmConnection.selection }),
      gtmAccounts: {
        accounts: [{ id: 'account_saved', name: 'Saved account' }],
        totalAccessible: 1,
        truncated: false,
        fetchedAt: capturedAt,
      },
      gtmContainers: {
        accountId: 'account_saved',
        containers: [{ id: 'container_saved', name: 'Saved container' }],
        totalAccessible: 1,
        truncated: false,
        fetchedAt: capturedAt,
      },
      gtmWorkspaces: {
        accountId: 'account_saved',
        containerId: 'container_saved',
        workspaces: [],
        totalAccessible: 0,
        truncated: false,
        fetchedAt: capturedAt,
      },
    }, requested)

    const { queryClient } = renderWorkspace()

    fireEvent.click(await screen.findByRole('button', { name: 'Change Tag Manager container' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('saved draft workspace is no longer accessible'))
    const staleWorkspace = screen.getByRole('option', { name: 'Saved draft workspace workspace_removed (no longer accessible)' }) as HTMLOptionElement
    expect(staleWorkspace.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByLabelText('Draft workspace (optional)'), { target: { value: '' } })
    expect(screen.queryByText(/saved draft workspace is no longer accessible/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(false)

    queryClient.clear()
  })

  test('allows a live-container selection when optional workspace discovery fails', async () => {
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots') || path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) return jsonResponse([])
      if (path.includes('/gtm/accounts/account_example/containers/GTM-TEST123/workspaces')) {
        return jsonResponse({ error: { message: 'Workspace discovery unavailable' } }, 503)
      }
      if (path.includes('/gtm/accounts/account_example/containers')) {
        return jsonResponse({
          accountId: 'account_example',
          containers: [{ id: 'GTM-TEST123', name: 'Production container' }],
          totalAccessible: 1,
          truncated: false,
          fetchedAt: capturedAt,
        })
      }
      if (path.startsWith('/api/v1/projects/example/gtm/accounts')) {
        return jsonResponse({
          accounts: [{ id: 'account_example', name: 'Example account' }],
          totalAccessible: 1,
          truncated: false,
          fetchedAt: capturedAt,
        })
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    fireEvent.click(await screen.findByRole('button', { name: 'Change Tag Manager container' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Workspace discovery unavailable'))
    expect((screen.getByLabelText('Draft workspace (optional)') as HTMLSelectElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Save container selection' }).hasAttribute('disabled')).toBe(false)

    queryClient.clear()
  })

  test('requires an explicit contract choice when multiple contracts exist and does not read an arbitrary integrity result', async () => {
    const requested: string[] = []
    const otherContract = { ...contract, id: 'contract_refund', name: 'Refund confirmed', eventName: 'refund' }
    installMarketingFetch({
      contracts: [otherContract, contract],
      integrity: (contractId) => {
        const selected = contractId === contract.id ? contract : otherContract
        return {
          assessment: {
            contract: selected,
            status: 'configured',
            evaluatedAt: capturedAt,
            findings: [],
          },
          googleAdsSnapshot: null,
          gtmSnapshot: null,
        }
      },
    }, requested)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select conversion' })).toBeTruthy())
    expect(requested.some((path) => path.includes('/conversion-tracking/contracts/') && path.includes('/integrity'))).toBe(false)

    fireEvent.change(screen.getByLabelText('Conversion to inspect'), { target: { value: contract.id } })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Payment confirmed' })).toBeTruthy())
    expect(requested).toContain(`/api/v1/projects/example/conversion-tracking/contracts/${contract.id}/integrity`)
    expect(requested.some((path) => path.includes(`${otherContract.id}/integrity`))).toBe(false)

    queryClient.clear()
  })

  test('focuses assessment findings and retains the exact integrity snapshot anchors', async () => {
    const requested: string[] = []
    installMarketingFetch({
      contracts: [contract],
      integrity: () => ({
        assessment: {
          contract,
          status: 'configured',
          evaluatedAt: capturedAt,
          findings: [{
            code: 'ads-goal-not-biddable',
            subject: 'payment-confirmed',
            outcome: 'fail',
            status: 'configured',
            evidenceIds: ['ads_integrity_anchor', 'gtm_integrity_anchor'],
          }],
        },
        googleAdsSnapshot: { id: 'ads_integrity_anchor', kind: 'inventory', capturedAt },
        gtmSnapshot: { id: 'gtm_integrity_anchor', kind: 'live', capturedAt },
      }),
    }, requested)
    const scrollIntoView = installScrollSpy()

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Review findings' })).toBeTruthy())
    expect(screen.getByText('(ads_integrity_anchor)')).toBeTruthy()
    expect(screen.getByText('(gtm_integrity_anchor)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Review findings' }))
    const findings = document.getElementById('conversion-integrity-findings')
    expect(findings).toBeTruthy()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' }))
    expect(document.activeElement).toBe(findings)

    queryClient.clear()
  })

  test('adds a second contract and selects its refreshed record for integrity inspection', async () => {
    const requested: string[] = []
    const scrollIntoView = installScrollSpy()
    const contracts = [contract]
    const createdContract = {
      ...contract,
      id: 'contract_refund',
      name: 'Refund confirmed',
      eventName: 'refund',
      googleAds: {
        ...contract.googleAds,
        conversionActionId: 'refund-confirmed',
      },
      gtm: {
        ...contract.gtm,
        tagId: 'tag_refund_confirmation',
      },
    }
    let created = false
    installMarketingFetch({
      contracts,
      createdContract,
      integrity: (contractId) => {
        const selected = contractId === createdContract.id ? createdContract : contract
        return {
          assessment: {
            contract: selected,
            status: 'configured',
            evaluatedAt: capturedAt,
            findings: [],
          },
          googleAdsSnapshot: null,
          gtmSnapshot: null,
        }
      },
      onRequest: (path, init) => {
        if (!created && path === '/api/v1/projects/example/conversion-tracking/contracts' && init?.method === 'POST') {
          contracts.push(createdContract)
          created = true
        }
      },
    }, requested)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add conversion' })).toBeTruthy())
    const addContractTrigger = screen.getByRole('button', { name: 'Add conversion' })
    addContractTrigger.focus()
    fireEvent.click(addContractTrigger)
    const contractHeading = await screen.findByRole('heading', { name: 'Declare the expected path' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(document.activeElement).toBe(contractHeading)
    expect(contractHeading.getAttribute('tabindex')).toBe('-1')
    expect((screen.getByLabelText('Conversion name') as HTMLInputElement).maxLength).toBe(120)
    const additionalRules = screen.getByText('Additional matching rules').closest('details')
    expect(additionalRules?.open).toBe(false)
    fireEvent.click(screen.getByText('Additional matching rules'))
    expect(additionalRules?.open).toBe(true)

    fireEvent.change(screen.getByLabelText('Conversion name'), { target: { value: createdContract.name } })
    fireEvent.change(screen.getByLabelText('Website event'), { target: { value: createdContract.eventName } })
    // Offered as a select from synced inventory, not a hand-typed id: copying an
    // opaque number out of another console fails only after saving, and a typo
    // produces a contract that silently checks the wrong thing.
    expect(screen.getByLabelText(/Google Ads conversion action/).tagName).toBe('SELECT')
    expect(screen.getByLabelText(/Tag Manager tag/).tagName).toBe('SELECT')
    fireEvent.change(screen.getByLabelText(/Google Ads conversion action/), { target: { value: createdContract.googleAds.conversionActionId } })
    fireEvent.change(screen.getByLabelText(/Tag Manager tag/), { target: { value: createdContract.gtm.tagId } })
    fireEvent.click(screen.getByRole('button', { name: 'Save conversion contract' }))

    await waitFor(() => expect((screen.getByLabelText('Conversion to inspect') as HTMLSelectElement).value).toBe(createdContract.id))
    expect(screen.getByRole('heading', { name: createdContract.name })).toBeTruthy()
    expect(requested).toContain('/api/v1/projects/example/conversion-tracking/contracts')
    await waitFor(() => expect(document.activeElement).toBe(addContractTrigger))

    queryClient.clear()
  })

  test('resets selection-panel draft state when a keyed project changes', async () => {
    const requested: string[] = []
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      requested.push(path)
      const project = path.includes('/projects/project_two/') ? 'project_two' : 'project_one'
      if (path.includes('/google-ads/status')) {
        return jsonResponse({
          ...googleAdsStatus({ status: 'selection-required', selectedCustomer: null }),
          connection: { ...adsConnection, projectId: project, selection: { customerId: null, loginCustomerId: null, selectedAt: null } },
        })
      }
      if (path.includes('/gtm/status')) return jsonResponse({ connected: false, status: 'not-connected', connection: null, selection: null })
      if (path.includes('/conversion-tracking/contracts')) return jsonResponse([])
      if (path.includes('/snapshots')) return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      if (path.includes('/google-ads/customers')) return jsonResponse({ customers: [] })
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function KeyedWorkspace({ projectId }: { projectId: string }) {
      return <ConversionIntegrityWorkspace key={projectId} projectId={projectId} projectName={projectId} />
    }

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <KeyedWorkspace projectId="project_one" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Google Ads account' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Select Google Ads account' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Select customer context' })).toBeTruthy())

    rerender(
      <QueryClientProvider client={queryClient}>
        <KeyedWorkspace projectId="project_two" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Select customer context' })).toBeNull())
    expect(requested.some((path) => path.includes('/projects/project_two/google-ads/status'))).toBe(true)

    queryClient.clear()
  })

  test('keeps a failed contracts read distinct from an empty contract list', async () => {
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots') || path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) {
        return jsonResponse({ error: { message: 'Contracts service unavailable' } }, 503)
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Contracts service unavailable'))
    expect(screen.queryByText('No conversion declared')).toBeNull()

    queryClient.clear()
  })

  test('surfaces failed integrity and snapshot reads instead of collapsing them into empty evidence', async () => {
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots')) {
        return jsonResponse({ error: { message: 'Google Ads snapshots unavailable' } }, 503)
      }
      if (path.startsWith('/api/v1/projects/example/gtm/snapshots')) return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts/contract_purchase/integrity')) {
        return jsonResponse({ error: { message: 'Integrity endpoint unavailable' } }, 503)
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) return jsonResponse([contract])
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    await waitFor(() => expect(screen.getByText('Assessment unavailable')).toBeTruthy())
    expect(screen.getByText('Integrity endpoint unavailable')).toBeTruthy()
    expect(screen.getByText('Google Ads snapshots unavailable')).toBeTruthy()
    expect(screen.getByText('Stored snapshots unavailable')).toBeTruthy()

    queryClient.clear()
  })

  test('keeps initial contract loading distinct from an empty contract list', () => {
    const restore = mockFetch((url) => {
      const path = pathOf(url)
      if (path.startsWith('/api/v1/projects/example/google-ads/status')) return jsonResponse(googleAdsStatus())
      if (path.startsWith('/api/v1/projects/example/gtm/status')) return jsonResponse(gtmStatus())
      if (path.startsWith('/api/v1/projects/example/google-ads/snapshots') || path.startsWith('/api/v1/projects/example/gtm/snapshots')) {
        return jsonResponse({ snapshots: [], nextCursor: null, total: 0 })
      }
      if (path.startsWith('/api/v1/projects/example/conversion-tracking/contracts')) {
        return new Promise<Response>(() => {})
      }
      return jsonResponse({ error: { message: `Unexpected request: ${path}` } }, 500)
    })
    onTestFinished(restore)

    const { queryClient } = renderWorkspace()

    expect(screen.getByRole('status').textContent).toContain('Loading conversion setup')
    expect(screen.getByRole('status').closest('section')?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelectorAll('.page-skeleton-card')).toHaveLength(2)
    expect(screen.queryByText('No conversion declared')).toBeNull()

    queryClient.clear()
  })
})

describe('gtmSelectionSummary', () => {
  test('names the container, its account, and a pinned draft workspace', () => {
    expect(gtmSelectionSummary('GTM-TEST123', 'account_example', null))
      .toBe('Container GTM-TEST123 · account account_example')
    expect(gtmSelectionSummary('GTM-TEST123', 'account_example', 'workspace_7'))
      .toBe('Container GTM-TEST123 · account account_example · workspace workspace_7')
  })
})


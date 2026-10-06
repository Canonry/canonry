import { describe, expect, it, vi } from 'vitest'
import {
  googleAdsRawSnapshotDtoSchema,
  gtmRawSnapshotDtoSchema,
} from '@ainyc/canonry-contracts'
import type { CanonryConfig } from '../src/config.js'
import { upsertGoogleAdsConnection } from '../src/google-ads-config.js'
import {
  createGoogleMarketingCredentialStore,
  createGoogleMarketingRuntime,
} from '../src/google-marketing-runtime.js'
import { upsertGtmConnection } from '../src/gtm-config.js'

const NOW = '2026-08-14T12:00:00.000Z'
const PROJECT = { id: 'project_1', name: 'example-hotel' }

function baseConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    google: {
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    },
  }
}

function googleAdsConfig(expired = false) {
  return {
    ...baseConfig(),
    googleAds: {
      developerToken: 'config-developer-token',
      connections: [{
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        accessToken: 'old-ads-access-token',
        refreshToken: 'ads-refresh-token',
        tokenExpiresAt: expired ? '2026-08-14T11:00:00.000Z' : '2026-08-14T14:00:00.000Z',
        scopes: ['https://www.googleapis.com/auth/adwords'],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    },
  } satisfies CanonryConfig
}

function gtmConfig(expired = false): CanonryConfig {
  return {
    ...baseConfig(),
    gtm: {
      connections: [{
        projectId: PROJECT.id,
        projectName: PROJECT.name,
        accessToken: 'old-gtm-access-token',
        refreshToken: 'gtm-refresh-token',
        tokenExpiresAt: expired ? '2026-08-14T11:00:00.000Z' : '2026-08-14T14:00:00.000Z',
        scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    },
  }
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function queryFrom(init: RequestInit | undefined): string {
  const parsed: unknown = JSON.parse(String(init?.body ?? '{}'))
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('query' in parsed) ||
    typeof parsed.query !== 'string'
  ) {
    throw new Error('Expected a GAQL query')
  }
  return parsed.query
}

function fixedNow(): Date {
  return new Date(NOW)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('Google marketing live reads', () => {
  it('refreshes and saves Ads credentials privately while returning named customer DTOs', async () => {
    const config = googleAdsConfig(true)
    const saved = vi.fn(async (_patch: Partial<CanonryConfig>) => undefined)
    const refresh = vi.fn(async () => ({
      access_token: 'new-ads-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/adwords',
    }))
    const authorizationHeaders: string[] = []
    const developerHeaders: string[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
      developerHeaders.push(new Headers(init?.headers).get('developer-token') ?? '')
      const url = String(input)
      if (url.endsWith('/customers:listAccessibleCustomers')) {
        return jsonResponse({ resourceNames: ['customers/1234567890'] })
      }
      return jsonResponse([{ results: [{
        customer: {
          resourceName: 'customers/1234567890',
          id: '1234567890',
          descriptiveName: 'Example Hotel',
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: false,
          testAccount: false,
          status: 'ENABLED',
        },
      }], requestId: 'customer-request' }])
    }
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: saved,
      env: { GOOGLE_ADS_DEVELOPER_TOKEN: 'env-developer-token' },
      fetch,
      now: fixedNow,
      refreshAccessToken: refresh,
    })

    const customers = await runtime.listGoogleAdsCustomers(PROJECT, { maxCustomers: 10 })
    const customer = await runtime.getGoogleAdsCustomer(PROJECT, {
      customerId: '123-456-7890',
    })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(config.googleAds?.connections?.[0]).toMatchObject({
      accessToken: 'new-ads-access-token',
      tokenExpiresAt: '2026-08-14T13:00:00.000Z',
      updatedAt: NOW,
    })
    expect(authorizationHeaders).toEqual([
      'Bearer new-ads-access-token',
      'Bearer new-ads-access-token',
      'Bearer new-ads-access-token',
    ])
    expect(developerHeaders).toEqual([
      'env-developer-token',
      'env-developer-token',
      'env-developer-token',
    ])
    expect(customers.customers[0]).toMatchObject({
      customerId: '1234567890',
      descriptiveName: 'Example Hotel',
      currencyCode: 'USD',
      timeZone: 'America/New_York',
      status: 'enabled',
    })
    expect(customer.descriptiveName).toBe('Example Hotel')
    const serialized = JSON.stringify({ customers, customer })
    expect(serialized).not.toContain('new-ads-access-token')
    expect(serialized).not.toContain('ads-refresh-token')
    expect(serialized).not.toContain('env-developer-token')
  })

  it('shares one in-flight refresh across concurrent reads of the same credential generation', async () => {
    const config = googleAdsConfig(true)
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<{
      access_token: string
      expires_in: number
      token_type: string
    }>()
    const refresh = vi.fn(async () => {
      refreshStarted.resolve()
      return releaseRefresh.promise
    })
    const saved = vi.fn(async () => undefined)
    const store = createGoogleMarketingCredentialStore({
      config,
      saveConfigPatch: saved,
      now: fixedNow,
      refreshAccessToken: refresh,
    })

    const first = store.getCredential(PROJECT, 'google-ads')
    await refreshStarted.promise
    const second = store.getCredential(PROJECT, 'google-ads')
    expect(refresh).toHaveBeenCalledTimes(1)

    releaseRefresh.resolve({
      access_token: 'shared-refreshed-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { accessToken: 'shared-refreshed-access-token' },
      { accessToken: 'shared-refreshed-access-token' },
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('does not restore an old Ads principal after reconnect wins an in-flight refresh', async () => {
    const config = googleAdsConfig(true)
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<{
      access_token: string
      expires_in: number
      token_type: string
    }>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('A replaced principal must not reach the provider')
    })
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
      refreshAccessToken: async () => {
        refreshStarted.resolve()
        return releaseRefresh.promise
      },
    })

    const pending = runtime.listGoogleAdsCustomers(PROJECT)
    await refreshStarted.promise
    const previous = config.googleAds!.connections![0]!
    upsertGoogleAdsConnection(config, {
      ...previous,
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
      tokenExpiresAt: '2026-08-14T14:00:00.000Z',
      // Deliberately retain the timestamp: the generation, not wall time,
      // separates two OAuth principals that reconnect in the same millisecond.
      updatedAt: previous.updatedAt,
    })
    releaseRefresh.resolve({
      access_token: 'principal-a-refreshed-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    })

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })
    expect(config.googleAds!.connections![0]).toMatchObject({
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts a separate Ads refresh for an expired reconnect instead of joining the old principal', async () => {
    const config = googleAdsConfig(true)
    const refreshStarted = deferred<void>()
    const releaseOldRefresh = deferred<{
      access_token: string
      expires_in: number
      token_type: string
    }>()
    const refresh = vi.fn(async (_clientId: string, _clientSecret: string, refreshToken: string) => {
      if (refreshToken === 'ads-refresh-token') {
        refreshStarted.resolve()
        return releaseOldRefresh.promise
      }
      expect(refreshToken).toBe('principal-b-refresh-token')
      return {
        access_token: 'principal-b-refreshed-access-token',
        expires_in: 3_600,
        token_type: 'Bearer',
      }
    })
    const store = createGoogleMarketingCredentialStore({
      config,
      saveConfigPatch: () => undefined,
      now: fixedNow,
      refreshAccessToken: refresh,
    })

    const oldRead = store.getCredential(PROJECT, 'google-ads')
    await refreshStarted.promise
    const previous = config.googleAds!.connections![0]!
    upsertGoogleAdsConnection(config, {
      ...previous,
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
      tokenExpiresAt: '2026-08-14T11:00:00.000Z',
    })

    const reconnectedRead = store.getCredential(PROJECT, 'google-ads')
    releaseOldRefresh.resolve({
      access_token: 'principal-a-refreshed-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    })

    await expect(oldRead).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })
    await expect(reconnectedRead).resolves.toEqual({
      accessToken: 'principal-b-refreshed-access-token',
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(config.googleAds!.connections![0]).toMatchObject({
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-refreshed-access-token',
      refreshToken: 'principal-b-refresh-token',
    })
  })

  it('does not restore a refreshed Ads principal over a reconnect when persistence fails', async () => {
    const config = googleAdsConfig(true)
    const saved = vi.fn(async () => {
      const refreshed = config.googleAds!.connections![0]!
      upsertGoogleAdsConnection(config, {
        ...refreshed,
        credentialGeneration: 'reconnect-principal-b',
        accessToken: 'principal-b-access-token',
        refreshToken: 'principal-b-refresh-token',
        tokenExpiresAt: '2026-08-14T14:00:00.000Z',
        updatedAt: refreshed.updatedAt,
      })
      throw new Error('simulated config save failure')
    })
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: saved,
      fetch: async () => {
        throw new Error('Provider must not run after a failed credential save')
      },
      now: fixedNow,
      refreshAccessToken: async () => ({
        access_token: 'principal-a-refreshed-access-token',
        expires_in: 3_600,
        token_type: 'Bearer',
      }),
    })

    await expect(runtime.listGoogleAdsCustomers(PROJECT)).rejects.toThrow('simulated config save failure')
    expect(config.googleAds!.connections![0]).toMatchObject({
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
    })
  })

  it('rolls back a failed refresh when its credential generation is still current', async () => {
    const config = googleAdsConfig(true)
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: async () => {
        throw new Error('simulated config save failure')
      },
      fetch: async () => {
        throw new Error('Provider must not run after a failed credential save')
      },
      now: fixedNow,
      refreshAccessToken: async () => ({
        access_token: 'refreshed-access-token',
        expires_in: 3_600,
        token_type: 'Bearer',
      }),
    })

    await expect(runtime.listGoogleAdsCustomers(PROJECT)).rejects.toThrow('simulated config save failure')
    expect(config.googleAds!.connections![0]).toMatchObject({
      accessToken: 'old-ads-access-token',
      refreshToken: 'ads-refresh-token',
      tokenExpiresAt: '2026-08-14T11:00:00.000Z',
    })
  })

  it('does not restore an old GTM principal after reconnect wins an in-flight refresh', async () => {
    const config = gtmConfig(true)
    const refreshStarted = deferred<void>()
    const releaseRefresh = deferred<{
      access_token: string
      expires_in: number
      token_type: string
    }>()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('A replaced principal must not reach the provider')
    })
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
      refreshAccessToken: async () => {
        refreshStarted.resolve()
        return releaseRefresh.promise
      },
    })

    const pending = runtime.listGtmAccounts(PROJECT)
    await refreshStarted.promise
    const previous = config.gtm!.connections![0]!
    upsertGtmConnection(config, {
      ...previous,
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
      tokenExpiresAt: '2026-08-14T14:00:00.000Z',
      updatedAt: previous.updatedAt,
    })
    releaseRefresh.resolve({
      access_token: 'principal-a-refreshed-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    })

    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })
    expect(config.gtm!.connections![0]).toMatchObject({
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts a separate GTM refresh for an expired reconnect instead of joining the old principal', async () => {
    const config = gtmConfig(true)
    const refreshStarted = deferred<void>()
    const releaseOldRefresh = deferred<{
      access_token: string
      expires_in: number
      token_type: string
    }>()
    const refresh = vi.fn(async (_clientId: string, _clientSecret: string, refreshToken: string) => {
      if (refreshToken === 'gtm-refresh-token') {
        refreshStarted.resolve()
        return releaseOldRefresh.promise
      }
      expect(refreshToken).toBe('principal-b-refresh-token')
      return {
        access_token: 'principal-b-refreshed-access-token',
        expires_in: 3_600,
        token_type: 'Bearer',
      }
    })
    const store = createGoogleMarketingCredentialStore({
      config,
      saveConfigPatch: () => undefined,
      now: fixedNow,
      refreshAccessToken: refresh,
    })

    const oldRead = store.getCredential(PROJECT, 'gtm')
    await refreshStarted.promise
    const previous = config.gtm!.connections![0]!
    upsertGtmConnection(config, {
      ...previous,
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-access-token',
      refreshToken: 'principal-b-refresh-token',
      tokenExpiresAt: '2026-08-14T11:00:00.000Z',
    })

    const reconnectedRead = store.getCredential(PROJECT, 'gtm')
    releaseOldRefresh.resolve({
      access_token: 'principal-a-refreshed-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    })

    await expect(oldRead).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })
    await expect(reconnectedRead).resolves.toEqual({
      accessToken: 'principal-b-refreshed-access-token',
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(config.gtm!.connections![0]).toMatchObject({
      credentialGeneration: 'reconnect-principal-b',
      accessToken: 'principal-b-refreshed-access-token',
      refreshToken: 'principal-b-refresh-token',
    })
  })

  it('discovers linked Ads clients under an accessible manager with the required login context', async () => {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/customers:listAccessibleCustomers')) {
        return jsonResponse({ resourceNames: ['customers/9999999999'] })
      }
      const query = queryFrom(init)
      if (query.includes('\nFROM customer\n')) {
        return jsonResponse([{ results: [{ customer: {
          resourceName: 'customers/9999999999',
          id: '9999999999',
          descriptiveName: 'Agency manager',
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: true,
          testAccount: false,
          status: 'ENABLED',
        } }] }])
      }
      if (query.includes('\nFROM customer_client\n')) {
        return jsonResponse([{ results: [
          { customerClient: {
            resourceName: 'customers/9999999999/customerClients/9999999999',
            clientCustomer: 'customers/9999999999',
            id: '9999999999',
            descriptiveName: 'Agency manager',
            currencyCode: 'USD',
            timeZone: 'America/New_York',
            manager: true,
            hidden: false,
            testAccount: false,
            status: 'ENABLED',
            level: '0',
          } },
          { customerClient: {
            resourceName: 'customers/9999999999/customerClients/1234567890',
            clientCustomer: 'customers/1234567890',
            id: '1234567890',
            descriptiveName: 'Example Hotel',
            currencyCode: 'USD',
            timeZone: 'America/Los_Angeles',
            manager: false,
            hidden: false,
            testAccount: false,
            status: 'ENABLED',
            level: '1',
          } },
        ] }])
      }
      throw new Error(`Unexpected Google Ads URL: ${url}`)
    }
    const runtime = createGoogleMarketingRuntime({
      config: googleAdsConfig(),
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
    })

    const result = await runtime.listGoogleAdsCustomers(PROJECT)

    expect(result).toMatchObject({ totalAccessible: 2, truncated: false })
    expect(result.customers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        customerId: '9999999999', parentCustomerId: null, manager: true, level: 0,
      }),
      expect.objectContaining({
        customerId: '1234567890', parentCustomerId: '9999999999',
        descriptiveName: 'Example Hotel', manager: false, level: 1,
      }),
    ]))
  })

  it('returns bounded contract DTOs for GTM accounts, containers, and workspaces', async () => {
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/accounts')) {
        return jsonResponse({ account: [
          { accountId: 'a1', path: 'accounts/a1', name: 'Hotel account' },
          { accountId: 'a2', path: 'accounts/a2', name: 'Agency account' },
        ] })
      }
      if (url.endsWith('/accounts/a1/containers')) {
        return jsonResponse({ container: [{
          accountId: 'a1',
          containerId: 'c1',
          path: 'accounts/a1/containers/c1',
          name: 'Hotel web',
          publicId: 'GTM-HOTEL',
          domainName: ['example.com'],
          usageContext: ['web'],
        }] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces')) {
        return jsonResponse({ workspace: [{
          accountId: 'a1',
          containerId: 'c1',
          workspaceId: 'w1',
          path: 'accounts/a1/containers/c1/workspaces/w1',
          name: 'Default workspace',
        }] })
      }
      throw new Error(`Unexpected GTM URL: ${url}`)
    }
    const runtime = createGoogleMarketingRuntime({
      config: gtmConfig(),
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
    })

    const accounts = await runtime.listGtmAccounts(PROJECT, { maxResults: 1 })
    const containers = await runtime.listGtmContainers(PROJECT, 'accounts/a1')
    const workspaces = await runtime.listGtmWorkspaces(
      PROJECT,
      'accounts/a1',
      'accounts/a1/containers/c1',
    )

    expect(accounts).toMatchObject({ totalAccessible: 2, truncated: true, fetchedAt: NOW })
    expect(accounts.accounts.map(account => account.name)).toEqual(['Hotel account'])
    expect(containers.containers[0]).toMatchObject({ id: 'c1', publicId: 'GTM-HOTEL' })
    expect(workspaces.workspaces[0]).toMatchObject({ id: 'w1', name: 'Default workspace' })
  })
})

describe('Google Ads sync', () => {
  it('returns sanitized inventory and customer-local trailing 31-day metrics without conflating actions and goals', async () => {
    const queries: string[] = []
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const query = queryFrom(init)
      queries.push(query)
      if (query.includes('\nFROM customer\n')) {
        return jsonResponse([{ results: [{ customer: {
          resourceName: 'customers/1234567890',
          id: '1234567890',
          descriptiveName: 'Example Hotel',
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: false,
          testAccount: false,
          status: 'ENABLED',
        } }] }])
      }
      if (query.includes('metrics.impressions')) {
        return jsonResponse([{ results: [{
          segments: { date: '2026-08-13' },
          campaign: {
            resourceName: 'customers/1234567890/campaigns/1',
            id: '1',
            name: 'Hotel search',
            status: 'ENABLED',
          },
          metrics: {
            impressions: '100',
            clicks: '10',
            costMicros: '2500000',
            conversions: 2,
            conversionsValue: 123.45,
          },
        }] }])
      }
      if (query.includes('FROM conversion_action')) {
        return jsonResponse([{ results: [
          {
            conversionAction: {
              resourceName: 'customers/1234567890/conversionActions/action-secondary',
              id: 'action-secondary',
              name: 'Booking secondary',
              status: 'ENABLED',
              type: 'WEBPAGE',
              category: 'PURCHASE',
              origin: 'WEBSITE',
              primaryForGoal: false,
              includeInConversionsMetric: false,
              tagSnippets: [{ eventSnippet: 'RAW-SECRET-EVENT-SNIPPET' }],
            },
          },
          {
            conversionAction: {
              resourceName: 'customers/1234567890/conversionActions/action-primary',
              id: 'action-primary',
              name: 'Booking primary',
              status: 'ENABLED',
              type: 'WEBPAGE',
              category: 'PURCHASE',
              origin: 'WEBSITE',
              primaryForGoal: true,
              includeInConversionsMetric: true,
              tagSnippets: [{ globalSiteTag: 'RAW-SECRET-PRIMARY-SNIPPET' }],
            },
          },
        ] }])
      }
      if (query.includes('FROM customer_conversion_goal')) {
        return jsonResponse([{ results: [{ customerConversionGoal: {
          resourceName: 'customers/1234567890/customerConversionGoals/PURCHASE~WEBSITE',
          category: 'PURCHASE',
          origin: 'WEBSITE',
          biddable: true,
        } }] }])
      }
      if (query.includes('FROM campaign_conversion_goal')) {
        return jsonResponse([{ results: [{
          campaignConversionGoal: {
            resourceName: 'customers/1234567890/campaignConversionGoals/3~PURCHASE~WEBSITE',
            campaign: 'customers/1234567890/campaigns/3',
            category: 'PURCHASE',
            origin: 'WEBSITE',
            biddable: false,
          },
          campaign: {
            resourceName: 'customers/1234567890/campaigns/3',
            id: '3',
            name: 'Campaign goal',
            status: 'ENABLED',
          },
        }] }])
      }
      if (query.includes('FROM custom_conversion_goal')) {
        return jsonResponse([{ results: [{ customConversionGoal: {
          resourceName: 'customers/1234567890/customConversionGoals/custom-1',
          id: 'custom-1',
          name: 'Booking custom goal',
          status: 'ENABLED',
          conversionActions: [
            'customers/1234567890/conversionActions/action-secondary',
          ],
        } }] }])
      }
      if (query.includes('FROM conversion_goal_campaign_config')) {
        return jsonResponse([{ results: [
          {
            conversionGoalCampaignConfig: {
              resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/1',
              campaign: 'customers/1234567890/campaigns/1',
              goalConfigLevel: 'CUSTOMER',
            },
            campaign: {
              resourceName: 'customers/1234567890/campaigns/1',
              id: '1',
              name: 'Hotel search',
              status: 'ENABLED',
            },
          },
          {
            conversionGoalCampaignConfig: {
              resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/2',
              campaign: 'customers/1234567890/campaigns/2',
              customConversionGoal: 'customers/1234567890/customConversionGoals/custom-1',
              goalConfigLevel: 'CUSTOMER',
            },
            campaign: {
              resourceName: 'customers/1234567890/campaigns/2',
              id: '2',
              name: 'Custom goal',
              status: 'ENABLED',
            },
          },
          {
            conversionGoalCampaignConfig: {
              resourceName: 'customers/1234567890/conversionGoalCampaignConfigs/3',
              campaign: 'customers/1234567890/campaigns/3',
              goalConfigLevel: 'CAMPAIGN',
            },
            campaign: {
              resourceName: 'customers/1234567890/campaigns/3',
              id: '3',
              name: 'Campaign goal',
              status: 'ENABLED',
            },
          },
        ] }])
      }
      if (query.includes('FROM campaign')) {
        return jsonResponse([{ results: ['1', '2', '3'].map(id => ({ campaign: {
          resourceName: `customers/1234567890/campaigns/${id}`,
          id,
          name: `Campaign ${id}`,
          status: 'ENABLED',
          advertisingChannelType: 'SEARCH',
          biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
        } })) }])
      }
      throw new Error(`Unexpected GAQL query: ${query}`)
    }
    let sequence = 0
    const config = googleAdsConfig()
    config.googleAds.connections[0]!.tokenExpiresAt = '2026-08-15T01:30:00.000Z'
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: () => undefined,
      env: { GOOGLE_ADS_DEVELOPER_TOKEN: 'env-developer-token' },
      fetch,
      // This is still August 14 in the selected customer's New York zone.
      now: () => new Date('2026-08-15T00:30:00.000Z'),
      randomUUID: () => `snapshot_${++sequence}`,
    })

    const result = await runtime.syncGoogleAds({
      project: PROJECT,
      connectionId: 'ads_connection_1',
      runId: 'ads_run_1',
      selection: { customerId: '1234567890' },
    })

    expect(googleAdsRawSnapshotDtoSchema.parse(result.accessibleCustomers))
      .toEqual(result.accessibleCustomers)
    expect(googleAdsRawSnapshotDtoSchema.parse(result.inventory)).toEqual(result.inventory)
    expect(googleAdsRawSnapshotDtoSchema.parse(result.metrics)).toEqual(result.metrics)
    expect(result.inventory.payload.kind).toBe('inventory')
    if (result.inventory.payload.kind !== 'inventory') throw new Error('Expected inventory')
    const secondary = result.inventory.payload.data.conversionActions
      .find(action => action.id === 'action-secondary')
    expect(secondary).toMatchObject({ primaryForGoal: false, includeInConversionsMetric: false })
    expect(result.inventory.payload.data.campaignConversionGoalsComplete).toBe(true)

    const customerCampaign = result.effectiveGoalGraph.campaigns
      .find(campaign => campaign.campaignId === '1')
    expect(customerCampaign?.goals[0]).toMatchObject({
      source: 'customer-goal',
      biddable: true,
      primaryConversionActionIds: ['action-primary'],
      secondaryConversionActionIds: ['action-secondary'],
    })
    const customCampaign = result.effectiveGoalGraph.campaigns
      .find(campaign => campaign.campaignId === '2')
    expect(customCampaign?.goals[0]).toMatchObject({
      source: 'custom-goal',
      biddable: null,
      secondaryConversionActionIds: ['action-secondary'],
    })
    const campaignGoal = result.effectiveGoalGraph.campaigns
      .find(campaign => campaign.campaignId === '3')
    expect(campaignGoal?.goals[0]).toMatchObject({
      source: 'campaign-goal',
      biddable: false,
      primaryConversionActionIds: ['action-primary'],
    })

    expect(result.metrics?.payload.kind).toBe('campaign-metrics')
    if (result.metrics?.payload.kind !== 'campaign-metrics') throw new Error('Expected metrics')
    expect(result.metrics.payload.data.query).toEqual({
      campaignIds: ['1', '2', '3'],
      startDate: '2026-07-15',
      endDate: '2026-08-14',
    })
    expect(result.metrics.payload.data.rows[0]).toMatchObject({
      impressions: 100,
      clicks: 10,
      costMicros: 2_500_000,
      conversions: 2,
      conversionValueMicros: 123_450_000,
    })
    const metricsQuery = queries.find(query => query.includes('metrics.impressions'))
    expect(metricsQuery).toContain("segments.date BETWEEN '2026-07-15' AND '2026-08-14'")
    expect(metricsQuery).toContain('LIMIT 1551')
    expect(result.accessibleCustomers.payload.kind).toBe('accessible-customers')
    if (result.accessibleCustomers.payload.kind !== 'accessible-customers') {
      throw new Error('Expected accessible customers')
    }
    expect(result.accessibleCustomers.payload.data).toMatchObject({
      customers: [expect.objectContaining({
        customerId: '1234567890',
        descriptiveName: 'Example Hotel',
        status: 'enabled',
      })],
      selection: { loginCustomerId: null, customerId: '1234567890', selectedAt: null },
    })
    expect(result.inventory.metadata).toMatchObject({
      id: 'snapshot_2',
      projectId: PROJECT.id,
      connectionId: 'ads_connection_1',
      runId: 'ads_run_1',
      kind: 'inventory',
      customerId: '1234567890',
    })
    expect(result.inventory.metadata.rawPayloadSha256).toBeNull()
    expect(result.inventory.metadata.rawPayloadBytes).toBeNull()
    expect(result.inventory.metadata.redactedFieldCount).toBe(2)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('old-ads-access-token')
    expect(serialized).not.toContain('ads-refresh-token')
    expect(serialized).not.toContain('env-developer-token')
    expect(serialized).not.toContain('RAW-SECRET-EVENT-SNIPPET')
    expect(serialized).not.toContain('RAW-SECRET-PRIMARY-SNIPPET')
  })

  it('rejects metrics windows over 31 days before making a provider request', async () => {
    let calls = 0
    const runtime = createGoogleMarketingRuntime({
      config: googleAdsConfig(),
      saveConfigPatch: () => undefined,
      fetch: async () => {
        calls++
        return jsonResponse({})
      },
      now: fixedNow,
    })

    await expect(runtime.syncGoogleAds({
      project: PROJECT,
      connectionId: 'ads_connection_1',
      runId: 'ads_run_1',
      selection: { customerId: '1234567890' },
      metricsQuery: {
        campaignIds: ['1'],
        startDate: '2026-07-14',
        endDate: '2026-08-14',
      },
    })).rejects.toThrow('at most 31')
    expect(calls).toBe(0)
  })
})

describe('GTM sync', () => {
  it('returns only cast-free redacted DTOs and leaves custom HTML/templates unknown', async () => {
    const config = gtmConfig(true)
    const saved = vi.fn(async (_patch: Partial<CanonryConfig>) => undefined)
    const refresh = vi.fn(async () => ({
      access_token: 'new-gtm-access-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    }))
    const authorizationHeaders: string[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
      const url = String(input)
      if (url.endsWith('/accounts')) {
        return jsonResponse({ account: [{
          accountId: 'a1', path: 'accounts/a1', name: 'Hotel account',
        }] })
      }
      if (url.endsWith('/accounts/a1/containers')) {
        return jsonResponse({ container: [{
          accountId: 'a1',
          containerId: 'c1',
          path: 'accounts/a1/containers/c1',
          name: 'Hotel web',
          publicId: 'GTM-HOTEL',
          domainName: ['example.com'],
          usageContext: ['web'],
        }] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces')) {
        return jsonResponse({ workspace: [{
          accountId: 'a1',
          containerId: 'c1',
          workspaceId: 'w1',
          path: 'accounts/a1/containers/c1/workspaces/w1',
          name: 'Default workspace',
        }] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/versions:live')) {
        return jsonResponse({
          accountId: 'a1',
          containerId: 'c1',
          containerVersionId: 'v1',
          path: 'accounts/a1/containers/c1/versions/v1',
          name: 'Live',
          tag: [{
            accountId: 'a1',
            containerId: 'c1',
            tagId: 'tag-html',
            name: 'Opaque booking HTML',
            type: 'html',
            parameter: [{ key: 'html', type: 'template', value: 'RAW-SECRET-CUSTOM-HTML' }],
          }],
          trigger: [],
          variable: [],
        })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/status')) {
        return jsonResponse({ mergeConflict: [] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/tags')) {
        return jsonResponse({ tag: [{
          accountId: 'a1',
          containerId: 'c1',
          workspaceId: 'w1',
          tagId: 'tag-template',
          name: 'Opaque custom template',
          type: 'cvt_booking',
          parameter: [{ key: 'template', type: 'template', value: 'RAW-SECRET-TEMPLATE' }],
        }] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/triggers')) {
        return jsonResponse({ trigger: [] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/variables')) {
        return jsonResponse({ variable: [] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/folders')) {
        return jsonResponse({ folder: [] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1/built_in_variables')) {
        return jsonResponse({ builtInVariable: [] })
      }
      if (url.endsWith('/accounts/a1/containers/c1/workspaces/w1')) {
        return jsonResponse({
          accountId: 'a1',
          containerId: 'c1',
          workspaceId: 'w1',
          path: 'accounts/a1/containers/c1/workspaces/w1',
          name: 'Default workspace',
        })
      }
      throw new Error(`Unexpected GTM URL: ${url}`)
    }
    const runtime = createGoogleMarketingRuntime({
      config,
      saveConfigPatch: saved,
      fetch,
      now: fixedNow,
      randomUUID: () => 'gtm_snapshot_1',
      refreshAccessToken: refresh,
    })

    const snapshot = await runtime.syncGtm({
      project: PROJECT,
      connectionId: 'gtm_connection_1',
      runId: 'gtm_run_1',
      selection: { accountId: 'a1', containerId: 'c1', workspaceId: 'w1' },
      expectedEventName: 'purchase',
      expectedHostname: 'example.com',
    })

    expect(gtmRawSnapshotDtoSchema.parse(snapshot)).toEqual(snapshot)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(authorizationHeaders.every(header => header === 'Bearer new-gtm-access-token')).toBe(true)
    expect(snapshot.metadata).toMatchObject({
      id: 'gtm_snapshot_1',
      projectId: PROJECT.id,
      connectionId: 'gtm_connection_1',
      runId: 'gtm_run_1',
      kind: 'container',
      accountId: 'a1',
      containerId: 'c1',
      workspaceId: 'w1',
    })
    expect(snapshot.metadata.redactedFieldCount).toBeGreaterThanOrEqual(2)
    expect(snapshot.metadata.rawPayloadSha256).toBeNull()
    expect(snapshot.metadata.rawPayloadBytes).toBeNull()
    if (snapshot.payload.kind !== 'container') throw new Error('Expected container snapshot')
    expect(snapshot.payload.data.live?.graph.googleAdsTagAssessments[0]).toMatchObject({
      recognition: 'unknown',
      recognitionReason: 'custom-html',
      reviewReasons: expect.arrayContaining(['custom-html-opaque']),
    })
    expect(snapshot.payload.data.draft?.graph.googleAdsTagAssessments[0]).toMatchObject({
      recognition: 'unknown',
      recognitionReason: 'custom-template',
      reviewReasons: expect.arrayContaining(['unsupported-tag-type']),
    })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('new-gtm-access-token')
    expect(serialized).not.toContain('gtm-refresh-token')
    expect(serialized).not.toContain('RAW-SECRET-CUSTOM-HTML')
    expect(serialized).not.toContain('RAW-SECRET-TEMPLATE')
  })
})

describe('Google marketing credential identity', () => {
  it('does not use a deleted project credential for a recreated project with the same name', async () => {
    const deletedProject = { id: 'project_deleted', name: PROJECT.name }
    const recreatedProject = { id: 'project_recreated', name: PROJECT.name }
    const adsConfig = googleAdsConfig()
    const tagManagerConfig = gtmConfig()
    adsConfig.googleAds!.connections![0]!.projectId = deletedProject.id
    tagManagerConfig.gtm!.connections![0]!.projectId = deletedProject.id
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('Provider requests must not run for a different project ID')
    })

    const adsRuntime = createGoogleMarketingRuntime({
      config: adsConfig,
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
    })
    const tagManagerRuntime = createGoogleMarketingRuntime({
      config: tagManagerConfig,
      saveConfigPatch: () => undefined,
      fetch,
      now: fixedNow,
    })

    await expect(adsRuntime.listGoogleAdsCustomers(recreatedProject)).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
    })
    await expect(tagManagerRuntime.listGtmAccounts(recreatedProject)).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

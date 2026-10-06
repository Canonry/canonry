import { describe, expect, it, test } from 'vitest'
import {
  buildCampaignSpendRankingQuery,
  buildDailyCampaignMetricsQuery,
  GOOGLE_ADS_API_VERSION,
  GoogleAdsApiError,
  GoogleAdsClient,
  buildDailyConversionMetricsQuery,
} from '../src/index.js'
import type { GoogleAdsFetch } from '../src/index.js'

const credentials = {
  accessToken: 'access-secret-value',
  developerToken: 'developer-secret-value',
  loginCustomerId: '123-456-7890',
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function queryFrom(init: RequestInit | undefined): string {
  const body = JSON.parse(String(init?.body ?? '{}')) as { query?: unknown }
  if (typeof body.query !== 'string') throw new Error('Expected a GAQL query')
  return body.query
}

describe('GoogleAdsClient request contract', () => {
  it('lists accessible customers with required headers and no login-customer header', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetch: GoogleAdsFetch = async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse(
        { resourceNames: ['customers/1111111111', 'customers/2222222222'] },
        200,
        { 'request-id': 'req-accessible' },
      )
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    const result = await client.listAccessibleCustomers()

    expect(capturedUrl).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
    )
    expect(capturedInit?.method).toBe('GET')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${credentials.accessToken}`)
    expect(headers.get('developer-token')).toBe(credentials.developerToken)
    expect(headers.get('login-customer-id')).toBeNull()
    expect(result.data.resourceNames).toEqual(['customers/1111111111', 'customers/2222222222'])
    expect(result.metadata).toEqual({
      apiVersion: GOOGLE_ADS_API_VERSION,
      operation: 'list-accessible-customers',
      requestId: 'req-accessible',
    })
    expect(JSON.stringify(result.metadata)).not.toContain(credentials.accessToken)
    expect(JSON.stringify(result.metadata)).not.toContain(credentials.developerToken)
    expect(JSON.stringify(client)).toBe('{}')
  })

  it('normalizes an omitted protobuf repeated field to an empty customer list', async () => {
    const client = new GoogleAdsClient(credentials, {
      fetch: async () => jsonResponse({}),
    })

    await expect(client.listAccessibleCustomers()).resolves.toMatchObject({
      data: { resourceNames: [] },
    })
  })

  it('returns named customer details for safe account selection', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetch: GoogleAdsFetch = async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse([{ results: [{
        customer: {
          resourceName: 'customers/9876543210',
          id: '9876543210',
          descriptiveName: 'Example Hotel',
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: false,
          status: 'ENABLED',
          conversionTrackingSetting: {
            conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF',
          },
        },
      }], requestId: 'req-customer-detail' }])
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    const result = await client.getCustomerDetails('987-654-3210')

    expect(capturedUrl).toContain('/customers/9876543210/googleAds:searchStream')
    expect(new Headers(capturedInit?.headers).get('login-customer-id')).toBe('1234567890')
    const query = queryFrom(capturedInit)
    expect(query).toContain('customer.descriptive_name')
    expect(query).toContain('customer.currency_code')
    expect(query).toContain('customer.time_zone')
    expect(query).toContain('customer.manager')
    expect(query).toContain('customer.status')
    expect(query).toContain('customer.conversion_tracking_setting.google_ads_conversion_customer')
    expect(result.data).toMatchObject({
      descriptiveName: 'Example Hotel',
      currencyCode: 'USD',
      timeZone: 'America/New_York',
      manager: false,
      status: 'ENABLED',
    })
    expect(result.metadata).toEqual({
      apiVersion: GOOGLE_ADS_API_VERSION,
      operation: 'customer-details',
      requestId: 'req-customer-detail',
    })
  })

  it('bounds accessible customer detail discovery and reports truncation explicitly', async () => {
    const detailIds: string[] = []
    const fetch: GoogleAdsFetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/customers:listAccessibleCustomers')) {
        return jsonResponse({ resourceNames: [
          'customers/1111111111',
          'customers/2222222222',
          'customers/3333333333',
        ] }, 200, { 'request-id': 'req-accessible-details' })
      }
      const customerId = /\/customers\/(\d{10})\//.exec(url)?.[1]
      if (!customerId) throw new Error('Expected a customer detail request')
      detailIds.push(customerId)
      return jsonResponse([{ results: [{
        customer: {
          resourceName: `customers/${customerId}`,
          id: customerId,
          descriptiveName: customerId === '1111111111' ? 'Example Hotel' : 'Agency Manager',
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: customerId === '2222222222',
          status: 'ENABLED',
        },
      }], requestId: `req-${customerId}` }])
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    const result = await client.listAccessibleCustomerDetails({ maxCustomers: 2 })

    expect(detailIds).toEqual(['1111111111', '2222222222'])
    expect(result.data).toMatchObject({
      totalAccessible: 3,
      attempted: 2,
      returned: 2,
      truncated: true,
      omitted: 1,
      failures: [],
    })
    expect(result.data.customers.map(customer => customer.descriptiveName)).toEqual([
      'Example Hotel',
      'Agency Manager',
    ])
    expect(result.metadata.requests.map(request => request.operation)).toEqual([
      'list-accessible-customers',
      'customer-details',
      'customer-details',
    ])
  })

  it('keeps customer discovery usable when one accessible account cannot be queried', async () => {
    const fetch: GoogleAdsFetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/customers:listAccessibleCustomers')) {
        return jsonResponse({ resourceNames: [
          'customers/1111111111',
          'customers/2222222222',
        ] })
      }
      if (url.includes('/customers/2222222222/')) {
        return jsonResponse({
          error: { message: 'Customer is not available', status: 'PERMISSION_DENIED' },
        }, 403, { 'request-id': 'req-denied-customer' })
      }
      return jsonResponse([{ results: [{
        customer: {
          resourceName: 'customers/1111111111',
          id: '1111111111',
          descriptiveName: 'Example Hotel',
        },
      }], requestId: 'req-example' }])
    }
    const client = new GoogleAdsClient(credentials, { fetch, retry: { maxRetries: 0 } })

    const result = await client.listAccessibleCustomerDetails({ maxCustomers: 2 })

    expect(result.data.customers).toHaveLength(1)
    expect(result.data.customers[0]?.descriptiveName).toBe('Example Hotel')
    expect(result.data.failures).toEqual([{
      resourceName: 'customers/2222222222',
      customerId: '2222222222',
      status: 403,
      providerStatus: 'PERMISSION_DENIED',
      requestId: 'req-denied-customer',
      message: 'Google Ads API error (403): Customer is not available',
    }])
    expect(result.metadata.requests).toHaveLength(3)
    expect(result.metadata.requests[2]).toMatchObject({
      operation: 'customer-details',
      requestId: 'req-denied-customer',
    })
  })

  it('returns bounded manager-to-client links with explicit truncation', async () => {
    let capturedInit: RequestInit | undefined
    const clients = ['1111111111', '2222222222', '3333333333']
    const fetch: GoogleAdsFetch = async (_input, init) => {
      capturedInit = init
      return jsonResponse([{ results: clients.map((id, index) => ({
        customerClient: {
          resourceName: `customers/9999999999/customerClients/${id}`,
          clientCustomer: `customers/${id}`,
          id,
          descriptiveName: index === 1 ? 'Example Hotel' : `Account ${index + 1}`,
          currencyCode: 'USD',
          timeZone: 'America/New_York',
          manager: index === 0,
          hidden: false,
          status: 'ENABLED',
          level: String(index === 0 ? 0 : 1),
        },
      })) }])
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    const result = await client.getCustomerClients('9999999999', {
      maxDepth: 2,
      maxCustomers: 2,
    })

    const query = queryFrom(capturedInit)
    expect(query).toContain('customer_client.descriptive_name')
    expect(query).toContain('customer_client.manager')
    expect(query).toContain('customer_client.status')
    expect(query).toContain('WHERE customer_client.level <= 2')
    expect(query).toContain('LIMIT 3')
    expect(result.data).toMatchObject({ maxDepth: 2, returned: 2, truncated: true })
    expect(result.data.customerClients.map(customer => customer.descriptiveName)).toEqual([
      'Account 1',
      'Example Hotel',
    ])
  })

  it('rejects unbounded account discovery before making a request', async () => {
    let calls = 0
    const client = new GoogleAdsClient(credentials, {
      fetch: async () => {
        calls++
        return jsonResponse({})
      },
    })

    await expect(client.listAccessibleCustomerDetails({ maxCustomers: 101 }))
      .rejects.toThrow('between 1 and 100')
    await expect(client.getCustomerClients('9999999999', { maxDepth: 11 }))
      .rejects.toThrow('between 0 and 10')
    await expect(client.getCustomerClients('9999999999', { maxCustomers: 1_001 }))
      .rejects.toThrow('between 1 and 1000')
    expect(calls).toBe(0)
  })

  it('queries campaigns with normalized customer headers and bidding configuration fields', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetch: GoogleAdsFetch = async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return jsonResponse([{ results: [], requestId: 'req-campaigns' }])
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    const result = await client.getCampaigns('987-654-3210', { limit: 250 })

    expect(capturedUrl).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/9876543210/googleAds:searchStream`,
    )
    expect(capturedInit?.method).toBe('POST')
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get('login-customer-id')).toBe('1234567890')
    const query = queryFrom(capturedInit)
    expect(query).toContain('campaign.bidding_strategy_type')
    expect(query).toContain('campaign.maximize_conversions.target_cpa_micros')
    expect(query).toContain('campaign.maximize_conversion_value.target_roas')
    expect(query).toContain('campaign_budget.amount_micros')
    expect(query).toContain('bidding_strategy.target_roas.target_roas')
    expect(query).toContain("WHERE campaign.status != 'REMOVED'")
    expect(query).toContain('LIMIT 250')
    expect(result.metadata.requestId).toBe('req-campaigns')
  })

  it('queries conversion actions with role, value, source, and tag evidence', async () => {
    let capturedInit: RequestInit | undefined
    const fetch: GoogleAdsFetch = async (_input, init) => {
      capturedInit = init
      return jsonResponse([{ results: [] }], 200, { 'google-ads-request-id': 'req-actions' })
    }
    const client = new GoogleAdsClient(credentials, { fetch })

    await client.getConversionActions('9876543210')

    const query = queryFrom(capturedInit)
    expect(query).toContain('conversion_action.primary_for_goal')
    expect(query).toContain('conversion_action.category')
    expect(query).toContain('conversion_action.origin')
    expect(query).toContain('conversion_action.value_settings.always_use_default_value')
    expect(query).toContain('conversion_action.google_analytics_4_settings.event_name')
    expect(query).toContain('conversion_action.tag_snippets')
  })
})

describe('GoogleAdsClient retry and errors', () => {
  it('retries a rate limit and honors Retry-After', async () => {
    let calls = 0
    const delays: number[] = []
    const fetch: GoogleAdsFetch = async () => {
      calls++
      if (calls === 1) {
        return jsonResponse(
          { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } },
          429,
          { 'Retry-After': '2', 'request-id': 'req-rate-limit' },
        )
      }
      return jsonResponse({ resourceNames: ['customers/1111111111'] })
    }
    const client = new GoogleAdsClient(credentials, {
      fetch,
      retry: {
        maxRetries: 1,
        sleep: async (delayMs) => { delays.push(delayMs) },
      },
    })

    const result = await client.listAccessibleCustomers()

    expect(calls).toBe(2)
    expect(delays).toEqual([2_000])
    expect(result.data.resourceNames).toEqual(['customers/1111111111'])
  })

  it('does not retry authentication failures', async () => {
    let calls = 0
    const fetch: GoogleAdsFetch = async () => {
      calls++
      return jsonResponse(
        { error: { message: 'Invalid OAuth token', status: 'UNAUTHENTICATED' } },
        401,
      )
    }
    const client = new GoogleAdsClient(credentials, {
      fetch,
      retry: { maxRetries: 3, sleep: async () => undefined },
    })

    await expect(client.listAccessibleCustomers()).rejects.toMatchObject({
      name: 'GoogleAdsApiError',
      status: 401,
      providerStatus: 'UNAUTHENTICATED',
    })
    expect(calls).toBe(1)
  })

  it('returns safe request diagnostics and redacts secrets from provider errors', async () => {
    const fetch: GoogleAdsFetch = async () => jsonResponse({
      error: {
        message:
          `Authorization: Bearer ${credentials.accessToken}; ` +
          `developer-token=${credentials.developerToken}`,
        status: 'INVALID_ARGUMENT',
        details: [{ requestId: 'req-from-error-details' }],
      },
    }, 400)
    const client = new GoogleAdsClient(credentials, { fetch, retry: { maxRetries: 0 } })

    const error = await client.getCampaigns('9876543210').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GoogleAdsApiError)
    expect(error).toMatchObject({
      status: 400,
      providerStatus: 'INVALID_ARGUMENT',
      requestId: 'req-from-error-details',
    })
    const serialized = `${(error as Error).message}\n${JSON.stringify(error)}`
    expect(serialized).not.toContain(credentials.accessToken)
    expect(serialized).not.toContain(credentials.developerToken)
    expect(serialized).toContain('***')
  })

  it('sanitizes network errors before retry or propagation', async () => {
    const fetch: GoogleAdsFetch = async () => {
      throw new Error(`fetch failed for Bearer ${credentials.accessToken}`)
    }
    const client = new GoogleAdsClient(credentials, { fetch, retry: { maxRetries: 0 } })

    const error = await client.listAccessibleCustomers().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GoogleAdsApiError)
    expect((error as Error).message).not.toContain(credentials.accessToken)
    expect((error as Error).message).toContain('Bearer ***')
  })
})

describe('bounded daily metric queries', () => {
  it('builds a bounded campaign query with exact dates, deduplicated IDs, and primary/all metrics', () => {
    const query = buildDailyCampaignMetricsQuery({
      startDate: '2026-01-01',
      endDate: '2026-03-31',
      campaignIds: ['42', '7', '42'],
      limit: 500,
    })

    expect(query).toContain("segments.date BETWEEN '2026-01-01' AND '2026-03-31'")
    expect(query).toContain('campaign.id IN (42, 7)')
    expect(query).toContain('metrics.cost_micros')
    expect(query).toContain('metrics.conversions')
    expect(query).toContain('metrics.all_conversions')
    expect(query).toContain('metrics.conversions_value')
    expect(query).toContain('LIMIT 500')
  })

  it('builds conversion-action daily rows without repeating spend metrics', () => {
    const query = buildDailyConversionMetricsQuery({
      startDate: '2026-08-01',
      endDate: '2026-08-14',
    })

    expect(query).toContain('segments.conversion_action')
    expect(query).toContain('segments.conversion_action_name')
    expect(query).toContain('metrics.all_conversions_value')
    expect(query).not.toContain('metrics.cost_micros')
  })

  it('rejects invalid, reversed, and overlong date windows before any request', () => {
    expect(() => buildDailyCampaignMetricsQuery({
      startDate: '2026-02-30',
      endDate: '2026-03-01',
    })).toThrow('real calendar date')
    expect(() => buildDailyCampaignMetricsQuery({
      startDate: '2026-03-02',
      endDate: '2026-03-01',
    })).toThrow('on or before')
    expect(() => buildDailyCampaignMetricsQuery({
      startDate: '2026-01-01',
      endDate: '2026-04-01',
    })).toThrow('cannot exceed 90 days')
  })

  it('rejects unsafe campaign IDs and unbounded result limits', () => {
    expect(() => buildDailyCampaignMetricsQuery({
      startDate: '2026-08-01',
      endDate: '2026-08-14',
      campaignIds: ['1) OR TRUE'],
    })).toThrow('digits only')
    expect(() => buildDailyCampaignMetricsQuery({
      startDate: '2026-08-01',
      endDate: '2026-08-14',
      limit: 10_001,
    })).toThrow('between 1 and 10000')
  })
})

describe('campaign selection covers where the money went', () => {
  test('the daily query keeps removed campaigns when scoped to explicit ids', () => {
    // A campaign deleted mid-window still spent real money in it. Excluding
    // REMOVED dropped that spend while coverage still read complete, and the
    // filter is redundant anyway once campaign.id IN (...) scopes the query.
    const scoped = buildDailyCampaignMetricsQuery({
      startDate: '2026-08-01',
      endDate: '2026-08-14',
      campaignIds: ['111', '222'],
    })
    expect(scoped).not.toContain("campaign.status != 'REMOVED'")
    expect(scoped).toContain('campaign.id IN (111, 222)')
  })

  test('the unscoped daily query still bounds itself to live campaigns', () => {
    // Without an id filter there is nothing else bounding the scan.
    const unscoped = buildDailyCampaignMetricsQuery({ startDate: '2026-08-01', endDate: '2026-08-14' })
    expect(unscoped).toContain("campaign.status != 'REMOVED'")
  })

  test('the ranking query aggregates by campaign and orders by spend', () => {
    const ranking = buildCampaignSpendRankingQuery({ startDate: '2026-08-01', endDate: '2026-08-14', limit: 50 })
    // No segments.date in the SELECT, or the API returns a row per campaign-day
    // instead of one aggregated row per campaign.
    expect(ranking).not.toContain('segments.date,')
    expect(ranking).toContain('ORDER BY metrics.cost_micros DESC')
    expect(ranking).toContain("segments.date BETWEEN '2026-08-01' AND '2026-08-14'")
    // Removed campaigns must be rankable, or their spend is invisible again.
    expect(ranking).not.toContain("campaign.status != 'REMOVED'")
  })
})

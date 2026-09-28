import { describe, expect, test, vi } from 'vitest'

import { gaRefreshDays, refreshAllIntegrations, type DataRefreshClient } from '../src/data-refresh.js'

function makeClient(overrides: Partial<DataRefreshClient> = {}): DataRefreshClient {
  return {
    gscSync: vi.fn(async () => ({})),
    bingInspectSitemap: vi.fn(async () => ({})),
    gaSync: vi.fn(async () => ({})),
    triggerGbpSync: vi.fn(async () => ({ runId: 'r', status: 'running' })),
    triggerAdsSync: vi.fn(async () => ({ runId: 'a', status: 'queued' })),
    triggerGoogleAdsSync: vi.fn(async () => ({ id: 'google-ads-run', status: 'queued' })),
    triggerGtmSync: vi.fn(async () => ({ id: 'gtm-run', status: 'queued' })),
    ...overrides,
  }
}

describe('gaRefreshDays', () => {
  test('covers the closed report month through day 3, and 30 days otherwise', () => {
    // 2026-09-01..2026-10-03 is 33 days; 2025-12-01..2026-01-01 is 32.
    expect(gaRefreshDays(new Date('2026-10-03T23:59:59Z'))).toBe(33)
    expect(gaRefreshDays(new Date('2026-01-01T00:00:00Z'))).toBe(32)
    // February is short: 2026-02-01..2026-03-02 is exactly 30 days.
    expect(gaRefreshDays(new Date('2026-03-02T12:00:00Z'))).toBe(30)
    expect(gaRefreshDays(new Date('2026-03-03T12:00:00Z'))).toBe(31)
    expect(gaRefreshDays(new Date('2026-10-04T00:00:00Z'))).toBe(30)
  })

  test('asks the scheduled GA sync for the report-day window', async () => {
    const client = makeClient()
    await refreshAllIntegrations(client, 'proj', new Date('2026-10-02T06:00:00Z'))
    expect(client.gaSync).toHaveBeenCalledWith('proj', { days: 32 })
  })
})

describe('refreshAllIntegrations', () => {
  test('fans out every integration sync for the project with explicit Google provider calls', async () => {
    const client = makeClient()

    await refreshAllIntegrations(client, 'proj', new Date('2026-09-28T12:00:00Z'))

    expect(client.gscSync).toHaveBeenCalledTimes(1)
    expect(client.gscSync).toHaveBeenCalledWith('proj', {})
    expect(client.bingInspectSitemap).toHaveBeenCalledWith('proj', {})
    expect(client.gaSync).toHaveBeenCalledWith('proj', { days: 30 })
    expect(client.triggerGbpSync).toHaveBeenCalledWith('proj', {})
    // Existing `ads` remains OpenAI / ChatGPT Ads, rather than being reused
    // for Google Ads. The Google provider calls are independently explicit.
    expect(client.triggerAdsSync).toHaveBeenCalledWith('proj')
    expect(client.triggerGoogleAdsSync).toHaveBeenCalledWith('proj')
    expect(client.triggerGtmSync).toHaveBeenCalledWith('proj')
  })

  test('one integration failing does not block the others and never throws', async () => {
    const client = makeClient({
      bingInspectSitemap: vi.fn(async () => {
        throw new Error('Bing is not connected for this project')
      }),
    })

    await expect(refreshAllIntegrations(client, 'proj')).resolves.toBeUndefined()

    // The remaining six still fired despite Bing rejecting.
    expect(client.gscSync).toHaveBeenCalledTimes(1)
    expect(client.gaSync).toHaveBeenCalledTimes(1)
    expect(client.triggerGbpSync).toHaveBeenCalledTimes(1)
    expect(client.triggerAdsSync).toHaveBeenCalledTimes(1)
    expect(client.triggerGoogleAdsSync).toHaveBeenCalledTimes(1)
    expect(client.triggerGtmSync).toHaveBeenCalledTimes(1)
  })

  test('all integrations failing still resolves (fire-and-forget)', async () => {
    const boom = vi.fn(async () => {
      throw new Error('not connected')
    })
    const client = makeClient({
      gscSync: boom,
      bingInspectSitemap: boom,
      gaSync: boom,
      triggerGbpSync: boom,
      triggerAdsSync: boom,
      triggerGoogleAdsSync: boom,
      triggerGtmSync: boom,
    })

    await expect(refreshAllIntegrations(client, 'proj')).resolves.toBeUndefined()
    expect(boom).toHaveBeenCalledTimes(7)
  })
})

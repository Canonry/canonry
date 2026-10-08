import { describe, expect, test, vi } from 'vitest'

import { gaRefreshDays, refreshAllIntegrations, type DataRefreshClient } from '../src/data-refresh.js'
import { addLogListener, type LogEntry } from '../src/logger.js'

function makeClient(overrides: Partial<DataRefreshClient> = {}): DataRefreshClient {
  return {
    gscSync: vi.fn(async () => ({ id: 'gsc-run', status: 'queued' })),
    bingInspectSitemap: vi.fn(async () => ({ id: 'bing-run', status: 'queued' })),
    gaSync: vi.fn(async () => ({ synced: true })),
    triggerGbpSync: vi.fn(async () => ({ runId: 'gbp-run', status: 'running' })),
    triggerAdsSync: vi.fn(async () => ({ runId: 'ads-run', status: 'queued' })),
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

  test('logs refreshed only for the synchronous GA sync and queued, with the run id, for the rest', async () => {
    const entries: LogEntry[] = []
    const remove = addLogListener(entry => { if (entry.module === 'DataRefresh') entries.push(entry) })
    const client = makeClient({
      // An endpoint that refuses (not connected) still logs as a failure.
      bingInspectSitemap: vi.fn(async () => { throw new Error('No Bing site configured') }),
    })

    try {
      await refreshAllIntegrations(client, 'proj', new Date('2026-09-28T12:00:00Z'))
    } finally {
      remove()
    }

    const byIntegration = Object.fromEntries(entries.map(entry => [entry.integration, entry]))
    expect(byIntegration.ga).toMatchObject({ action: 'integration.refreshed', projectName: 'proj' })
    expect(byIntegration.bing).toMatchObject({ action: 'integration.refresh-failed', error: 'No Bing site configured' })
    // A queued run's real outcome lands later on its run row, so the log
    // names the run instead of claiming the sync succeeded.
    expect(byIntegration.gsc).toMatchObject({ action: 'integration.queued', runId: 'gsc-run', runStatus: 'queued' })
    expect(byIntegration.gbp).toMatchObject({ action: 'integration.queued', runId: 'gbp-run', runStatus: 'running' })
    expect(byIntegration.ads).toMatchObject({ action: 'integration.queued', runId: 'ads-run', runStatus: 'queued' })
    expect(byIntegration['google-ads']).toMatchObject({ action: 'integration.queued', runId: 'google-ads-run', runStatus: 'queued' })
    expect(byIntegration.gtm).toMatchObject({ action: 'integration.queued', runId: 'gtm-run', runStatus: 'queued' })
    expect(entries.filter(entry => entry.action === 'integration.refreshed').map(entry => entry.integration)).toEqual(['ga'])
    expect(entries).toHaveLength(7)
  })
})

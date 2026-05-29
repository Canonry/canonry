import { describe, expect, test, vi } from 'vitest'

import { refreshAllIntegrations, type DataRefreshClient } from '../src/data-refresh.js'

function makeClient(overrides: Partial<DataRefreshClient> = {}): DataRefreshClient {
  return {
    gscSync: vi.fn(async () => ({})),
    bingInspectSitemap: vi.fn(async () => ({})),
    gaSync: vi.fn(async () => ({})),
    triggerGbpSync: vi.fn(async () => ({ runId: 'r', status: 'running' })),
    ...overrides,
  }
}

describe('refreshAllIntegrations', () => {
  test('fires all four integration syncs for the project', async () => {
    const client = makeClient()

    await refreshAllIntegrations(client, 'proj')

    expect(client.gscSync).toHaveBeenCalledTimes(1)
    expect(client.gscSync).toHaveBeenCalledWith('proj', {})
    expect(client.bingInspectSitemap).toHaveBeenCalledWith('proj', {})
    expect(client.gaSync).toHaveBeenCalledWith('proj', { days: 30 })
    expect(client.triggerGbpSync).toHaveBeenCalledWith('proj', {})
  })

  test('one integration failing does not block the others and never throws', async () => {
    const client = makeClient({
      bingInspectSitemap: vi.fn(async () => {
        throw new Error('Bing is not connected for this project')
      }),
    })

    await expect(refreshAllIntegrations(client, 'proj')).resolves.toBeUndefined()

    // The remaining three still fired despite Bing rejecting.
    expect(client.gscSync).toHaveBeenCalledTimes(1)
    expect(client.gaSync).toHaveBeenCalledTimes(1)
    expect(client.triggerGbpSync).toHaveBeenCalledTimes(1)
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
    })

    await expect(refreshAllIntegrations(client, 'proj')).resolves.toBeUndefined()
    expect(boom).toHaveBeenCalledTimes(4)
  })
})

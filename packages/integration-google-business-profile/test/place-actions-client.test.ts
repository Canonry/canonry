import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listPlaceActionLinks } from '../src/place-actions-client.js'

describe('listPlaceActionLinks', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('maps place action links into typed rows', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        placeActionLinks: [
          { name: 'locations/1/placeActionLinks/aaa', placeActionType: 'RESERVATION', uri: 'https://book.example.com', isPreferred: true, providerType: 'MERCHANT' },
          { name: 'locations/1/placeActionLinks/bbb', placeActionType: 'BOOK', uri: 'https://expedia.com/x', providerType: 'AGGREGATOR' },
        ],
      }),
    })
    const rows = await listPlaceActionLinks('tok', 'locations/1')
    expect(rows).toEqual([
      { placeActionLinkName: 'locations/1/placeActionLinks/aaa', placeActionType: 'RESERVATION', uri: 'https://book.example.com', isPreferred: true, providerType: 'MERCHANT' },
      { placeActionLinkName: 'locations/1/placeActionLinks/bbb', placeActionType: 'BOOK', uri: 'https://expedia.com/x', isPreferred: false, providerType: 'AGGREGATOR' },
    ])
  })

  it('returns [] when a location has no CTAs (the common real-world case)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({}) })
    expect(await listPlaceActionLinks('tok', 'locations/1')).toEqual([])
  })

  it('paginates across nextPageToken', async () => {
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ placeActionLinks: [{ name: 'l/1/p/a', placeActionType: 'BOOK' }], nextPageToken: 'p2' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ placeActionLinks: [{ name: 'l/1/p/b', placeActionType: 'ORDER_FOOD' }] }) })
    const rows = await listPlaceActionLinks('tok', 'locations/1')
    expect(rows.map(r => r.placeActionType)).toEqual(['BOOK', 'ORDER_FOOD'])
    expect(fetchSpy.mock.calls[1]![0]).toContain('pageToken=p2')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listLocations, formatStorefrontAddress } from '../src/locations-client.js'

describe('listLocations', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  function mockLocations(locations: unknown[]) {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ locations }),
    })
  }

  it('requests metadata.placeId and metadata.mapsUri in the default readMask', async () => {
    mockLocations([])
    await listLocations('tok', 'accounts/1')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const url = new URL(fetchSpy.mock.calls[0]![0] as string)
    const readMask = url.searchParams.get('readMask') ?? ''
    const fields = readMask.split(',')
    // Place ID + Maps link are what let us join a GBP location to the Places API.
    expect(fields).toContain('metadata.placeId')
    expect(fields).toContain('metadata.mapsUri')
    // The Phase-1 fields must still be present — this is additive.
    expect(fields).toContain('name')
    expect(fields).toContain('title')
  })

  it('returns the placeId + mapsUri carried in a location metadata block', async () => {
    mockLocations([
      {
        name: 'locations/1',
        title: 'Gjelina Hotel',
        metadata: { placeId: 'ChIJplaceid123', mapsUri: 'https://maps.google.com/?cid=42' },
      },
    ])
    const out = await listLocations('tok', 'accounts/1')
    expect(out).toHaveLength(1)
    expect(out[0]!.metadata?.placeId).toBe('ChIJplaceid123')
    expect(out[0]!.metadata?.mapsUri).toBe('https://maps.google.com/?cid=42')
  })

  it('leaves metadata undefined when Google omits it (location not on Maps)', async () => {
    mockLocations([{ name: 'locations/2', title: 'Off-Maps Location' }])
    const out = await listLocations('tok', 'accounts/1')
    expect(out[0]!.metadata?.placeId).toBeUndefined()
  })
})

describe('formatStorefrontAddress', () => {
  it('flattens the address parts present, skipping the missing ones', () => {
    expect(formatStorefrontAddress({
      name: 'locations/1',
      storefrontAddress: { addressLines: ['123 Main St'], locality: 'Venice', administrativeArea: 'CA', postalCode: '90291', regionCode: 'US' },
    })).toBe('123 Main St, Venice, CA, 90291, US')
  })

  it('returns null when there is no storefront address', () => {
    expect(formatStorefrontAddress({ name: 'locations/1' })).toBeNull()
  })
})

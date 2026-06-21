import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { listLocations, formatStorefrontAddress, buildLocationProfileFields } from '../src/locations-client.js'

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

  it('requests the owner-content profile fields in the default readMask', async () => {
    mockLocations([])
    await listLocations('tok', 'accounts/1')
    const url = new URL(fetchSpy.mock.calls[0]![0] as string)
    const fields = (url.searchParams.get('readMask') ?? '').split(',')
    // The owner-authored profile content AEO answer engines weight (categories,
    // description, service area, hours, phone, open state) must be requested.
    // `categories` is requested WHOLE: the locations.list readMask rejects a
    // nested path into the repeated `additionalCategories` array (400), so the
    // nested form must never be used.
    expect(fields).toContain('categories')
    expect(fields).not.toContain('categories.additionalCategories.displayName')
    expect(fields).toContain('profile.description')
    expect(fields).toContain('serviceArea')
    expect(fields).toContain('regularHours')
    expect(fields).toContain('phoneNumbers')
    expect(fields).toContain('openInfo')
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

describe('buildLocationProfileFields', () => {
  it('extracts the full owner-content profile from a populated location', () => {
    const out = buildLocationProfileFields({
      name: 'locations/1',
      title: 'AZ Coatings',
      categories: {
        primaryCategory: { displayName: 'Roofing contractor' },
        additionalCategories: [{ displayName: 'Insulation contractor' }, { displayName: 'Waterproofing service' }],
      },
      profile: { description: 'AZ Coatings specializes in commercial roof restoration.' },
      serviceArea: { businessType: 'CUSTOMER_LOCATION_ONLY', places: { placeInfos: [{ placeName: 'Almont, MI' }] } },
      regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 7 }, closeDay: 'MONDAY', closeTime: { hours: 18, minutes: 30 } }] },
      phoneNumbers: { primaryPhone: '(248) 925-7414' },
      openInfo: { status: 'OPEN', openingDate: { year: 2021, month: 12, day: 1 } },
    })
    expect(out.additionalCategories).toEqual(['Insulation contractor', 'Waterproofing service'])
    expect(out.description).toBe('AZ Coatings specializes in commercial roof restoration.')
    expect(out.serviceArea).toEqual({ businessType: 'CUSTOMER_LOCATION_ONLY', places: { placeInfos: [{ placeName: 'Almont, MI' }] } })
    expect(out.regularHours).toEqual({ periods: [{ openDay: 'MONDAY', openTime: { hours: 7 }, closeDay: 'MONDAY', closeTime: { hours: 18, minutes: 30 } }] })
    expect(out.primaryPhone).toBe('(248) 925-7414')
    expect(out.openStatus).toBe('OPEN')
    expect(out.openingDate).toBe('2021-12-01')
  })

  it('returns empty/null defaults for a bare location (no profile content)', () => {
    const out = buildLocationProfileFields({ name: 'locations/2', title: 'Bare' })
    expect(out.additionalCategories).toEqual([])
    expect(out.description).toBeNull()
    expect(out.serviceArea).toBeNull()
    expect(out.regularHours).toBeNull()
    expect(out.primaryPhone).toBeNull()
    expect(out.openStatus).toBeNull()
    expect(out.openingDate).toBeNull()
  })

  it('drops additional categories with no displayName and trims to the names', () => {
    const out = buildLocationProfileFields({
      name: 'locations/3',
      categories: { additionalCategories: [{ displayName: 'Spa' }, {}, { displayName: 'Event venue' }] },
    })
    expect(out.additionalCategories).toEqual(['Spa', 'Event venue'])
  })

  it('formats a partial opening date (year only, year+month) without fabricating precision', () => {
    expect(buildLocationProfileFields({ name: 'locations/4', openInfo: { openingDate: { year: 2019 } } }).openingDate).toBe('2019')
    expect(buildLocationProfileFields({ name: 'locations/5', openInfo: { openingDate: { year: 2020, month: 3 } } }).openingDate).toBe('2020-03')
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

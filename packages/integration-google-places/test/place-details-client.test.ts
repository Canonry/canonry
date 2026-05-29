import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPlaceDetails, buildPlaceDetailsFieldMask, hashPlaceDetails } from '../src/place-details-client.js'
import { PlacesApiError } from '../src/types.js'

describe('hashPlaceDetails', () => {
  it('is stable regardless of key order', () => {
    const a = hashPlaceDetails({ id: 'x', servesBreakfast: true, allowsDogs: false })
    const b = hashPlaceDetails({ allowsDogs: false, id: 'x', servesBreakfast: true })
    expect(a).toBe(b)
  })

  it('changes when an amenity value changes', () => {
    const a = hashPlaceDetails({ id: 'x', servesBreakfast: true })
    const b = hashPlaceDetails({ id: 'x', servesBreakfast: false })
    expect(a).not.toBe(b)
  })
})

describe('buildPlaceDetailsFieldMask', () => {
  it('atmosphere tier includes the amenity booleans + editorialSummary', () => {
    const fields = buildPlaceDetailsFieldMask('atmosphere').split(',')
    expect(fields).toContain('servesBreakfast')
    expect(fields).toContain('allowsDogs')
    expect(fields).toContain('parkingOptions')
    expect(fields).toContain('accessibilityOptions')
    expect(fields).toContain('editorialSummary')
    expect(fields).toContain('id')
  })

  it('pro tier keeps accessibilityOptions but DROPS the Atmosphere amenity fields (cost guard)', () => {
    const fields = buildPlaceDetailsFieldMask('pro').split(',')
    expect(fields).toContain('accessibilityOptions')
    expect(fields).toContain('id')
    // These are Enterprise+Atmosphere-only — must not leak into a Pro request,
    // or the call would be billed at the higher SKU.
    expect(fields).not.toContain('servesBreakfast')
    expect(fields).not.toContain('allowsDogs')
    expect(fields).not.toContain('editorialSummary')
  })
})

describe('getPlaceDetails', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  function ok(body: unknown) {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(body) })
  }
  function err(status: number, gStatus: string, message = 'boom') {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status,
      text: async () => JSON.stringify({ error: { code: status, status: gStatus, message } }),
    })
  }

  it('GETs /v1/places/{placeId} with the API key + field-mask headers', async () => {
    ok({ id: 'ChIJabc' })
    await getPlaceDetails('ChIJabc', 'KEY123')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJabc')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe('KEY123')
    // Default tier is atmosphere → amenity fields are requested.
    expect(headers['X-Goog-FieldMask']).toContain('servesBreakfast')
  })

  it('uses the pro field mask when tier=pro', async () => {
    ok({ id: 'ChIJabc' })
    await getPlaceDetails('ChIJabc', 'KEY', { tier: 'pro' })
    const headers = fetchSpy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-Goog-FieldMask']).not.toContain('servesBreakfast')
    expect(headers['X-Goog-FieldMask']).toContain('accessibilityOptions')
  })

  it('honors an explicit fieldMask override', async () => {
    ok({ id: 'ChIJabc' })
    await getPlaceDetails('ChIJabc', 'KEY', { fieldMask: 'id,websiteUri' })
    const headers = fetchSpy.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['X-Goog-FieldMask']).toBe('id,websiteUri')
  })

  it('URL-encodes the place id', async () => {
    ok({ id: 'a/b' })
    await getPlaceDetails('a/b', 'KEY')
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://places.googleapis.com/v1/places/a%2Fb')
  })

  it('parses amenity booleans, accessibilityOptions, and editorialSummary', async () => {
    ok({
      id: 'ChIJabc',
      types: ['lodging', 'hotel'],
      servesBreakfast: true,
      allowsDogs: false,
      parkingOptions: { freeParkingLot: true },
      accessibilityOptions: { wheelchairAccessibleEntrance: true },
      editorialSummary: { text: 'A boutique hotel in Venice.', languageCode: 'en' },
    })
    const place = await getPlaceDetails('ChIJabc', 'KEY')
    expect(place.servesBreakfast).toBe(true)
    expect(place.allowsDogs).toBe(false)
    expect(place.parkingOptions?.freeParkingLot).toBe(true)
    expect(place.accessibilityOptions?.wheelchairAccessibleEntrance).toBe(true)
    expect(place.editorialSummary?.text).toBe('A boutique hotel in Venice.')
    expect(place.types).toEqual(['lodging', 'hotel'])
  })

  it('throws PlacesApiError(400, INVALID_ARGUMENT) on a bad request', async () => {
    err(400, 'INVALID_ARGUMENT', 'Invalid field mask')
    await expect(getPlaceDetails('ChIJabc', 'KEY')).rejects.toMatchObject({
      constructor: PlacesApiError, status: 400, reason: 'INVALID_ARGUMENT',
    })
  })

  it('throws PlacesApiError(403, PERMISSION_DENIED) when the key is not authorized', async () => {
    err(403, 'PERMISSION_DENIED', 'API key not authorized')
    await expect(getPlaceDetails('ChIJabc', 'KEY')).rejects.toMatchObject({ status: 403, reason: 'PERMISSION_DENIED' })
  })

  it('throws PlacesApiError(404, NOT_FOUND) for a stale place id', async () => {
    err(404, 'NOT_FOUND')
    const e = await getPlaceDetails('ChIJgone', 'KEY').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(PlacesApiError)
    expect((e as PlacesApiError).status).toBe(404)
  })

  it('does NOT retry a 403 (fails fast, one call)', async () => {
    err(403, 'PERMISSION_DENIED')
    await expect(getPlaceDetails('ChIJabc', 'KEY')).rejects.toBeInstanceOf(PlacesApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries a transient 503 then succeeds', async () => {
    err(503, 'UNAVAILABLE')
    ok({ id: 'ChIJabc', servesBreakfast: true })
    const place = await getPlaceDetails('ChIJabc', 'KEY', { retry: { sleep: async () => {} } })
    expect(place.servesBreakfast).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

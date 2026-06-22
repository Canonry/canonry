import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAttributes, countAttributes, hashAttributes } from '../src/attributes-client.js'
import { GbpApiError } from '../src/types.js'

// Captured verbatim from the live Business Information API
// (GET /v1/locations/{id}/attributes) for a real location — getAttributes
// returns ONLY the attributes the owner has set, with one of four value
// carriers (values / uriValues / repeatedEnumValue). See PR description.
const REAL_GJELINA_RESPONSE = {
  name: 'locations/13162902540120712264/attributes',
  attributes: [
    { name: 'attributes/welcomes_lgbtq', valueType: 'BOOL', values: [true] },
    { name: 'attributes/url_text_messaging', valueType: 'URL', uriValues: [{ uri: 'sms:+13109362146' }] },
    { name: 'attributes/url_instagram', valueType: 'URL', uriValues: [{ uri: 'https://www.instagram.com/gjelinahotel/' }] },
  ],
}

describe('countAttributes', () => {
  it('counts the set attributes (getAttributes returns only set ones)', () => {
    expect(countAttributes([
      { name: 'attributes/a', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] },
      { name: 'attributes/b', valueType: 'URL', values: [], unsetValues: [], uris: ['https://x'] },
    ])).toBe(2)
    expect(countAttributes([])).toBe(0)
  })
})

describe('hashAttributes', () => {
  it('is stable across attribute order', () => {
    const a = hashAttributes([
      { name: 'attributes/a', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] },
      { name: 'attributes/b', valueType: 'URL', values: [], unsetValues: [], uris: ['https://x'] },
    ])
    const b = hashAttributes([
      { name: 'attributes/b', valueType: 'URL', values: [], unsetValues: [], uris: ['https://x'] },
      { name: 'attributes/a', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] },
    ])
    expect(a).toBe(b)
  })

  it('changes when a value changes', () => {
    const a = hashAttributes([{ name: 'attributes/a', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] }])
    const b = hashAttributes([{ name: 'attributes/a', valueType: 'BOOL', values: [false], unsetValues: [], uris: [] }])
    expect(a).not.toBe(b)
  })

  it('changes when an explicit REPEATED_ENUM unset value changes', () => {
    const a = hashAttributes([{ name: 'attributes/a', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['check'], uris: [] }])
    const b = hashAttributes([{ name: 'attributes/a', valueType: 'REPEATED_ENUM', values: ['cash'], unsetValues: ['credit_card'], uris: [] }])
    expect(a).not.toBe(b)
  })
})

describe('getAttributes', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('normalizes the real BOOL + URL response into flat values/uris', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(REAL_GJELINA_RESPONSE) })
    const out = await getAttributes('tok', 'locations/13162902540120712264')
    expect(out).toEqual([
      { name: 'attributes/welcomes_lgbtq', valueType: 'BOOL', values: [true], unsetValues: [], uris: [] },
      { name: 'attributes/url_text_messaging', valueType: 'URL', values: [], unsetValues: [], uris: ['sms:+13109362146'] },
      { name: 'attributes/url_instagram', valueType: 'URL', values: [], unsetValues: [], uris: ['https://www.instagram.com/gjelinahotel/'] },
    ])
  })

  it('calls the Business Information host on the /attributes sub-collection', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ name: 'locations/1/attributes' }) })
    await getAttributes('tok', 'locations/1')
    const url = String(fetchSpy.mock.calls[0]![0])
    expect(url).toBe('https://mybusinessbusinessinformation.googleapis.com/v1/locations/1/attributes')
  })

  it('flattens REPEATED_ENUM set/unset values and ENUM values', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        name: 'locations/1/attributes',
        attributes: [
          { name: 'attributes/payments', valueType: 'REPEATED_ENUM', repeatedEnumValue: { setValues: ['cash', 'credit_card'], unsetValues: ['check'] } },
          { name: 'attributes/service_option', valueType: 'ENUM', values: ['dine_in'] },
        ],
      }),
    })
    const out = await getAttributes('tok', 'locations/1')
    expect(out).toEqual([
      { name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: ['cash', 'credit_card'], unsetValues: ['check'], uris: [] },
      { name: 'attributes/service_option', valueType: 'ENUM', values: ['dine_in'], unsetValues: [], uris: [] },
    ])
  })

  it('preserves REPEATED_ENUM attributes that only carry unsetValues', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        name: 'locations/1/attributes',
        attributes: [
          { name: 'attributes/payments', valueType: 'REPEATED_ENUM', repeatedEnumValue: { unsetValues: ['check'] } },
        ],
      }),
    })
    const out = await getAttributes('tok', 'locations/1')
    expect(out).toEqual([
      { name: 'attributes/payments', valueType: 'REPEATED_ENUM', values: [], unsetValues: ['check'], uris: [] },
    ])
  })

  it('returns [] when the location has no set attributes', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ name: 'locations/1/attributes' }) })
    expect(await getAttributes('tok', 'locations/1')).toEqual([])
  })

  it('returns [] on 404 (no attributes resource for this location)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }) })
    expect(await getAttributes('tok', 'locations/1')).toEqual([])
  })

  it('rethrows non-404 errors (e.g. 403)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }) })
    await expect(getAttributes('tok', 'locations/1')).rejects.toBeInstanceOf(GbpApiError)
  })
})

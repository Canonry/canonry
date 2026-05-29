import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getLodging, countPopulatedGroups, hashLodging } from '../src/lodging-client.js'
import { GbpApiError } from '../src/types.js'

describe('countPopulatedGroups', () => {
  it('counts non-empty top-level attribute groups, excluding name/metadata', () => {
    const lodging = {
      name: 'locations/1/lodging',
      metadata: { someFlag: true },
      pools: { pool: true },
      connectivity: { wifiAvailable: true },
      pets: {},                 // empty object — not populated
      parking: null,            // null — not populated
      property: { builtYear: 2010 },
    }
    expect(countPopulatedGroups(lodging)).toBe(3) // pools, connectivity, property
  })

  it('returns 0 for an empty profile (only name) — the real-world hotel case', () => {
    expect(countPopulatedGroups({ name: 'locations/1/lodging' })).toBe(0)
  })

  it('treats empty arrays as not populated', () => {
    expect(countPopulatedGroups({ name: 'x', amenities: [] })).toBe(0)
    expect(countPopulatedGroups({ name: 'x', amenities: ['pool'] })).toBe(1)
  })
})

describe('hashLodging', () => {
  it('is stable for equal content regardless of key order', () => {
    const a = hashLodging({ name: 'x', pools: { pool: true }, pets: { allowed: false } })
    const b = hashLodging({ pets: { allowed: false }, name: 'x', pools: { pool: true } })
    expect(a).toBe(b)
  })

  it('changes when content changes', () => {
    const a = hashLodging({ name: 'x', pools: { pool: true } })
    const b = hashLodging({ name: 'x', pools: { pool: false } })
    expect(a).not.toBe(b)
  })
})

describe('getLodging', () => {
  const fetchSpy = vi.fn()
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    fetchSpy.mockReset()
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('returns the raw lodging resource on 200', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      text: async () => JSON.stringify({ name: 'locations/1/lodging', pools: { pool: true } }),
    })
    const out = await getLodging('tok', 'locations/1')
    expect(out).toEqual({ name: 'locations/1/lodging', pools: { pool: true } })
  })

  it('returns null for a non-lodging location (400 FAILED_PRECONDITION)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 400,
      text: async () => JSON.stringify({
        error: { code: 400, status: 'FAILED_PRECONDITION', message: 'This operation is not supported for this location.' },
      }),
    })
    expect(await getLodging('tok', 'locations/1')).toBeNull()
  })

  it('rethrows non-400 errors (e.g. 403)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 403,
      text: async () => JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }),
    })
    await expect(getLodging('tok', 'locations/1')).rejects.toBeInstanceOf(GbpApiError)
  })
})

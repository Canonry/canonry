import crypto from 'node:crypto'
import { GBP_LODGING_BASE } from './constants.js'
import { gbpFetchGet } from './http.js'
import { GbpApiError } from './types.js'
import type { GbpFetchOptions } from './types.js'

export type GbpLodging = Record<string, unknown>

/**
 * Fetch the full Lodging resource for a location. Returns `null` when the
 * location is not a lodging-category property — Google answers that with
 * HTTP 400 `FAILED_PRECONDITION` (not a 404), which we map to null so the
 * sync worker can skip it cleanly. Other errors propagate.
 */
export async function getLodging(
  accessToken: string,
  locationName: string,
  opts: GbpFetchOptions = {},
): Promise<GbpLodging | null> {
  const url = `${GBP_LODGING_BASE}/${locationName}/lodging?readMask=*`
  try {
    return await gbpFetchGet<GbpLodging>(url, accessToken, opts)
  } catch (err) {
    if (err instanceof GbpApiError && err.status === 400) {
      // Not a lodging-capable location — caller treats this as "no lodging".
      return null
    }
    throw err
  }
}

/**
 * Count non-empty top-level attribute groups in a Lodging resource, excluding
 * the bookkeeping fields `name` and `metadata`. An empty object/array/null is
 * not "populated". Zero means the hotel has no structured amenities set — an
 * AEO gap, not an error.
 */
export function countPopulatedGroups(lodging: GbpLodging): number {
  let count = 0
  for (const [key, value] of Object.entries(lodging)) {
    if (key === 'name' || key === 'metadata') continue
    if (isPopulated(value)) count++
  }
  return count
}

function isPopulated(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  // A scalar (string/number/boolean) counts as populated.
  return true
}

/**
 * Stable content hash of a Lodging resource for snapshot-on-change. Key order
 * is normalized so an equivalent payload hashes identically across syncs.
 */
export function hashLodging(lodging: GbpLodging): string {
  return crypto.createHash('sha256').update(stableStringify(lodging)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

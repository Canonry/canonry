import crypto from 'node:crypto'
import { GBP_BUSINESS_INFO_BASE } from './constants.js'
import { gbpFetchGet } from './http.js'
import { GbpApiError } from './types.js'
import type { GbpFetchOptions } from './types.js'

/**
 * One owner-set Business Profile attribute, normalized to a flat shape. The
 * Business Information API carries an attribute's value in one of three fields
 * depending on `valueType` (`values` for BOOL/ENUM, `uriValues` for URL,
 * `repeatedEnumValue` for REPEATED_ENUM); we flatten them into `values`
 * (positive scalars/enum values), `unsetValues` (explicit false enum values),
 * and `uris` (links) so consumers don't branch on the carrier.
 */
export interface GbpAttribute {
  /** Attribute id, e.g. `attributes/welcomes_lgbtq`. */
  name: string
  /** `BOOL` | `ENUM` | `URL` | `REPEATED_ENUM` (whatever Google returns). */
  valueType: string
  /** Scalar values: booleans (BOOL), enum strings (ENUM), or set enum strings (REPEATED_ENUM). */
  values: (boolean | string)[]
  /** Explicit false values from REPEATED_ENUM attributes. Absent enum values remain unknown. */
  unsetValues: string[]
  /** URL values (URL attributes), flattened from `uriValues[].uri`. */
  uris: string[]
}

interface RawAttribute {
  name?: string
  valueType?: string
  values?: unknown[]
  uriValues?: { uri?: string }[]
  repeatedEnumValue?: { setValues?: string[]; unsetValues?: string[] }
}

interface RawAttributesResponse {
  name?: string
  attributes?: RawAttribute[]
}

/**
 * Fetch the owner-set attributes for a location via the Business Information
 * API (`GET /v1/{location}/attributes`). Unlike the Lodging API this works for
 * any business category and returns ONLY the attributes the owner has set
 * (amenities, service options, accessibility, social URLs, identity tags like
 * women-owned). Returns `[]` when the location has none, or on a 404 (no
 * attributes resource); other errors propagate so the sync surfaces auth/quota
 * failures. There is no readMask and no pagination — the resource is returned
 * whole.
 */
export async function getAttributes(
  accessToken: string,
  locationName: string,
  opts: GbpFetchOptions = {},
): Promise<GbpAttribute[]> {
  const url = `${GBP_BUSINESS_INFO_BASE}/${locationName}/attributes`
  let res: RawAttributesResponse
  try {
    res = await gbpFetchGet<RawAttributesResponse>(url, accessToken, opts)
  } catch (err) {
    if (err instanceof GbpApiError && err.status === 404) return []
    throw err
  }
  return (res.attributes ?? [])
    .map(normalizeAttribute)
    .filter((a) => a.name.length > 0)
}

function normalizeAttribute(raw: RawAttribute): GbpAttribute {
  const values: (boolean | string)[] = []
  for (const v of raw.values ?? []) {
    if (typeof v === 'boolean' || typeof v === 'string') values.push(v)
  }
  for (const s of raw.repeatedEnumValue?.setValues ?? []) values.push(s)
  const unsetValues = [...(raw.repeatedEnumValue?.unsetValues ?? [])]
  const uris: string[] = []
  for (const u of raw.uriValues ?? []) {
    if (u.uri) uris.push(u.uri)
  }
  return { name: raw.name ?? '', valueType: raw.valueType ?? '', values, unsetValues, uris }
}

/** Number of owner-set attributes (the API returns only set ones, so this is just the length). */
export function countAttributes(attrs: GbpAttribute[]): number {
  return attrs.length
}

/**
 * Stable content hash of a normalized attribute list for snapshot-on-change.
 * Order-independent so an equivalent payload hashes identically across syncs.
 */
export function hashAttributes(attrs: GbpAttribute[]): string {
  const sorted = [...attrs].sort((a, b) => a.name.localeCompare(b.name))
  return crypto.createHash('sha256').update(stableStringify(sorted)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

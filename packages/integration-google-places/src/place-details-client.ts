import crypto from 'node:crypto'
import { PLACES_API_BASE, PLACES_ATMOSPHERE_FIELDS, PLACES_PRO_FIELDS } from './constants.js'
import type { PlacesTier } from './constants.js'
import { placesFetchGet } from './http.js'
import type { PlaceDetails, PlacesFetchOptions } from './types.js'

export interface GetPlaceDetailsOptions extends PlacesFetchOptions {
  /** Field-mask tier. Default 'atmosphere' (richest; powers the cross-reference). */
  tier?: PlacesTier
  /** Explicit field mask override; wins over `tier` when set. */
  fieldMask?: string
  /** BCP-47 language for localized text fields (e.g. editorialSummary). */
  languageCode?: string
}

/**
 * Build the `X-Goog-FieldMask` for a tier. The mask determines the SKU billed,
 * so 'pro' deliberately omits the amenity booleans + editorialSummary that live
 * only in the Enterprise + Atmosphere SKU.
 */
export function buildPlaceDetailsFieldMask(tier: PlacesTier): string {
  const fields = tier === 'atmosphere' ? PLACES_ATMOSPHERE_FIELDS : PLACES_PRO_FIELDS
  return fields.join(',')
}

/**
 * Fetch Place Details (New) for a Google Maps Place ID. The place id comes from
 * a GBP location's `metadata.placeId`. Throws `PlacesApiError` on failure (incl.
 * 404 for a stale place id) — callers in the sync layer catch and treat Places
 * as best-effort supplemental data, never failing the run on a Places error.
 */
export async function getPlaceDetails(
  placeId: string,
  apiKey: string,
  opts: GetPlaceDetailsOptions = {},
): Promise<PlaceDetails> {
  const fieldMask = opts.fieldMask ?? buildPlaceDetailsFieldMask(opts.tier ?? 'atmosphere')
  const url = new URL(`${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`)
  if (opts.languageCode) url.searchParams.set('languageCode', opts.languageCode)
  return placesFetchGet<PlaceDetails>(url.toString(), apiKey, fieldMask, opts)
}

/** Recursively sort object keys so equal content hashes identically. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null' // JSON.stringify(undefined) is undefined; normalize for a stable hash
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Stable content hash of a Place Details resource — drives snapshot-on-change
 * so an unchanged listing doesn't accrue a new `gbp_place_details` row each
 * sync. Mirrors `hashLodging` in the GBP package.
 */
export function hashPlaceDetails(place: PlaceDetails): string {
  return crypto.createHash('sha256').update(stableStringify(place)).digest('hex')
}

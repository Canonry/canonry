import {
  GBP_BUSINESS_INFO_BASE,
  GBP_DEFAULT_PAGE_SIZE,
  GBP_LOCATIONS_DEFAULT_READ_MASK,
  GBP_MAX_PAGES,
} from './constants.js'
import { gbpFetchGet } from './http.js'
import type { GbpDate, GbpFetchOptions, GbpLocation } from './types.js'

interface ListLocationsResponse {
  locations?: GbpLocation[]
  nextPageToken?: string
}

export interface ListLocationsOptions extends GbpFetchOptions {
  /** Comma-separated FieldMask. Defaults to a Phase-1-appropriate mask. */
  readMask?: string
}

/**
 * List every location under an account that the OAuth user has access to.
 * Fully paginated. Pass `accountName` in resource-name form ("accounts/{n}").
 */
export async function listLocations(
  accessToken: string,
  accountName: string,
  opts: ListLocationsOptions = {},
): Promise<GbpLocation[]> {
  const readMask = opts.readMask ?? GBP_LOCATIONS_DEFAULT_READ_MASK
  const collected: GbpLocation[] = []
  let pageToken: string | undefined
  let page = 0
  do {
    const url = new URL(`${GBP_BUSINESS_INFO_BASE}/${accountName}/locations`)
    url.searchParams.set('readMask', readMask)
    url.searchParams.set('pageSize', String(GBP_DEFAULT_PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await gbpFetchGet<ListLocationsResponse>(url.toString(), accessToken, opts)
    if (res.locations) collected.push(...res.locations)
    pageToken = res.nextPageToken
    page++
  } while (pageToken && page < GBP_MAX_PAGES)
  return collected
}

/**
 * Flatten the storefront address to a single human-readable line.
 * Used when persisting to `gbp_locations.storefront_address`.
 */
export function formatStorefrontAddress(loc: GbpLocation): string | null {
  const addr = loc.storefrontAddress
  if (!addr) return null
  const parts = [
    ...(addr.addressLines ?? []),
    addr.locality,
    addr.administrativeArea,
    addr.postalCode,
    addr.regionCode,
  ].filter((p): p is string => Boolean(p))
  return parts.length ? parts.join(', ') : null
}

/** The owner-content profile fields persisted onto a `gbp_locations` row. */
export interface LocationProfileFields {
  /** Secondary category display names (the primary stays in its own column). */
  additionalCategories: string[]
  /** Owner business description (`profile.description`), up to ~750 chars. */
  description: string | null
  /** Raw Service Area resource (SAB geo footprint), stored faithfully. */
  serviceArea: Record<string, unknown> | null
  /** Raw regular-hours resource, stored faithfully. */
  regularHours: Record<string, unknown> | null
  /** Primary phone number (NAP). */
  primaryPhone: string | null
  /** openInfo.status — OPEN / CLOSED_PERMANENTLY / CLOSED_TEMPORARILY. */
  openStatus: string | null
  /** openInfo.openingDate flattened to the precision Google gave (YYYY[-MM[-DD]]). */
  openingDate: string | null
}

/**
 * Derive the persisted owner-content profile fields from a Location resource.
 * Centralizes the mapping so the discover insert + update branches stay in sync,
 * and keeps the extraction unit-testable. `serviceArea` / `regularHours` are
 * passed through verbatim (we record presence + the raw shape, not a reshape).
 */
export function buildLocationProfileFields(loc: GbpLocation): LocationProfileFields {
  return {
    additionalCategories: (loc.categories?.additionalCategories ?? [])
      .map((c) => c.displayName)
      .filter((n): n is string => Boolean(n)),
    description: loc.profile?.description ?? null,
    serviceArea: loc.serviceArea ?? null,
    regularHours: loc.regularHours ?? null,
    primaryPhone: loc.phoneNumbers?.primaryPhone ?? null,
    openStatus: loc.openInfo?.status ?? null,
    openingDate: formatOpeningDate(loc.openInfo?.openingDate),
  }
}

/**
 * Flatten a Google civil date to a string at the precision actually provided —
 * year-only, year-month, or full date. Never fabricates a day/month Google
 * omitted (a year-only opening date stays "2019", not "2019-01-01").
 */
function formatOpeningDate(date?: GbpDate): string | null {
  if (!date?.year) return null
  let out = String(date.year)
  if (date.month) {
    out += `-${String(date.month).padStart(2, '0')}`
    if (date.day) out += `-${String(date.day).padStart(2, '0')}`
  }
  return out
}

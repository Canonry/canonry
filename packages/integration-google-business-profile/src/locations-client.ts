import {
  GBP_BUSINESS_INFO_BASE,
  GBP_DEFAULT_PAGE_SIZE,
  GBP_LOCATIONS_DEFAULT_READ_MASK,
  GBP_MAX_PAGES,
} from './constants.js'
import { gbpFetchGet } from './http.js'
import type { GbpFetchOptions, GbpLocation } from './types.js'

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

import { GBP_BUSINESS_INFO_BASE, GBP_DEFAULT_PAGE_SIZE, GBP_MAX_PAGES } from './constants.js'
import { gbpFetchGet } from './http.js'
import type { GbpFetchOptions } from './types.js'

interface PlaceActionLink {
  /** "locations/{l}/placeActionLinks/{id}" */
  name: string
  placeActionType: string
  uri?: string
  isPreferred?: boolean
  providerType?: string
}

interface ListPlaceActionLinksResponse {
  placeActionLinks?: PlaceActionLink[]
  nextPageToken?: string
}

export interface GbpPlaceActionRow {
  placeActionLinkName: string
  placeActionType: string
  uri: string | null
  isPreferred: boolean
  providerType: string | null
}

/**
 * List the booking / reservation / order CTAs ("place action links") for a
 * location. Fully paginated. Lives on the Business Information v1 host.
 */
export async function listPlaceActionLinks(
  accessToken: string,
  locationName: string,
  opts: GbpFetchOptions = {},
): Promise<GbpPlaceActionRow[]> {
  const collected: GbpPlaceActionRow[] = []
  let pageToken: string | undefined
  let page = 0
  do {
    const url = new URL(`${GBP_BUSINESS_INFO_BASE}/${locationName}/placeActionLinks`)
    url.searchParams.set('pageSize', String(GBP_DEFAULT_PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await gbpFetchGet<ListPlaceActionLinksResponse>(url.toString(), accessToken, opts)
    for (const link of res.placeActionLinks ?? []) {
      collected.push({
        placeActionLinkName: link.name,
        placeActionType: link.placeActionType,
        uri: link.uri ?? null,
        isPreferred: link.isPreferred ?? false,
        providerType: link.providerType ?? null,
      })
    }
    pageToken = res.nextPageToken
    page++
  } while (pageToken && page < GBP_MAX_PAGES)
  return collected
}

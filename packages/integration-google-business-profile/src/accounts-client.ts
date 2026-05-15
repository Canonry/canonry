import { GBP_ACCOUNT_MANAGEMENT_BASE, GBP_DEFAULT_PAGE_SIZE, GBP_MAX_PAGES } from './constants.js'
import { gbpFetchGet } from './http.js'
import type { GbpAccount, GbpFetchOptions } from './types.js'

interface ListAccountsResponse {
  accounts?: GbpAccount[]
  nextPageToken?: string
}

/**
 * List every account the OAuth user has access to (directly or as a manager).
 * Fully paginated — collects all pages internally.
 */
export async function listAccounts(accessToken: string, opts: GbpFetchOptions = {}): Promise<GbpAccount[]> {
  const collected: GbpAccount[] = []
  let pageToken: string | undefined
  let page = 0
  do {
    const url = new URL(`${GBP_ACCOUNT_MANAGEMENT_BASE}/accounts`)
    url.searchParams.set('pageSize', String(GBP_DEFAULT_PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await gbpFetchGet<ListAccountsResponse>(url.toString(), accessToken, opts)
    if (res.accounts) collected.push(...res.accounts)
    pageToken = res.nextPageToken
    page++
  } while (pageToken && page < GBP_MAX_PAGES)
  return collected
}

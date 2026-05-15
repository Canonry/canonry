// Resource shapes from the GBP APIs we touch in Phase 1.

export interface GbpAccount {
  /** "accounts/{n}" */
  name: string
  accountName?: string
  type?: string
  role?: string
}

export interface GbpStorefrontAddress {
  regionCode?: string
  languageCode?: string
  postalCode?: string
  administrativeArea?: string
  locality?: string
  addressLines?: string[]
}

export interface GbpLocation {
  /** "locations/{n}" */
  name: string
  title?: string
  storefrontAddress?: GbpStorefrontAddress
  websiteUri?: string
  categories?: {
    primaryCategory?: { displayName?: string }
    additionalCategories?: { displayName?: string }[]
  }
}

/**
 * Structured error from any GBP API.
 *
 * `reason` is the value Google returns under `error.details[].reason`,
 * e.g. `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `RATE_LIMIT_EXCEEDED`,
 * `API_DISABLED`, `CONSUMER_INVALID`. Callers in `packages/api-routes`
 * branch on this to map to the right `AppError` factory.
 */
export class GbpApiError extends Error {
  public readonly status: number
  public readonly reason: string | null
  public readonly body: unknown

  constructor(message: string, status: number, reason: string | null, body: unknown) {
    super(message)
    this.name = 'GbpApiError'
    this.status = status
    this.reason = reason
    this.body = body
  }
}

export interface GbpFetchOptions {
  /** Optional `x-goog-user-project` value for quota attribution. */
  quotaProject?: string
}

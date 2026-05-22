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
 *
 * `quotaLimitValue` is parsed from `error.details[0].metadata.quota_limit_value`
 * when the response is a `RATE_LIMIT_EXCEEDED`. Specifically: `0` means the
 * project has not been approved through Google's API access form (the gate);
 * any non-zero value means an approved project temporarily exceeded its
 * per-minute cap, which is retryable.
 */
export class GbpApiError extends Error {
  public readonly status: number
  public readonly reason: string | null
  public readonly body: unknown
  public readonly quotaLimitValue: number | null

  constructor(message: string, status: number, reason: string | null, body: unknown, quotaLimitValue: number | null = null) {
    super(message)
    this.name = 'GbpApiError'
    this.status = status
    this.reason = reason
    this.body = body
    this.quotaLimitValue = quotaLimitValue
  }
}

/**
 * Retry policy configurable per call. Defaults are based on Google's official
 * guidance at https://developers.google.com/my-business/content/limits:
 *
 *   sleep_time = random.uniform(0, base_delay * (2 ** attempt))
 *   base_delay = 1.0 (seconds)
 *   max_retries = 5
 *
 * Only 429 (and transient 503) trigger retry. 401/403/404/etc. fail fast.
 * A 429 with `quota_limit_value == 0` is the access-form gate — retrying
 * doesn't help — so we also skip retry there even though it's a 429.
 */
export interface GbpRetryOptions {
  /** Maximum number of retries (not counting the initial attempt). Default 5. */
  maxRetries?: number
  /** Base delay in milliseconds. Default 1000 (Google's documented 1.0s). */
  baseDelayMs?: number
  /** Override the sleep function for testing. */
  sleep?: (ms: number) => Promise<void>
}

export interface GbpFetchOptions {
  /** Optional `x-goog-user-project` value for quota attribution. */
  quotaProject?: string
  /** Retry policy override. */
  retry?: GbpRetryOptions
}

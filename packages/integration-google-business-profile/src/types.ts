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

/**
 * Output-only location metadata. `placeId` is the Google Maps Place ID — present
 * only when the location appears on Maps — and is the key that links a GBP
 * location to the Places API (used to pull supplemental rendered-listing data).
 * `mapsUri` is the public Maps link. Requesting these requires `metadata.*` in
 * the readMask.
 */
export interface GbpLocationMetadata {
  placeId?: string
  mapsUri?: string
}

/** A Google "civil date": any of the components may be omitted (e.g. year-only). */
export interface GbpDate {
  year?: number
  month?: number
  day?: number
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
  // Owner-authored profile content. `serviceArea` / `regularHours` are stored
  // faithfully as JSON (we surface presence, not a reshaped schema), so they are
  // typed as passthrough objects rather than a brittle mirror of Google's shape.
  profile?: { description?: string }
  serviceArea?: Record<string, unknown>
  regularHours?: Record<string, unknown>
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] }
  openInfo?: { status?: string; openingDate?: GbpDate }
  metadata?: GbpLocationMetadata
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

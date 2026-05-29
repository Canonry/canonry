// Resource shapes from the Places API (New) Place Details endpoint. Only the
// fields we request (see constants.ts field-mask tiers) are modelled. Every
// field is optional because Google omits anything it has no data for.

export interface PlaceLocalizedText {
  text?: string
  languageCode?: string
}

export interface PlaceAccessibilityOptions {
  wheelchairAccessibleParking?: boolean
  wheelchairAccessibleEntrance?: boolean
  wheelchairAccessibleRestroom?: boolean
  wheelchairAccessibleSeating?: boolean
}

export interface PlaceParkingOptions {
  freeParkingLot?: boolean
  paidParkingLot?: boolean
  freeStreetParking?: boolean
  paidStreetParking?: boolean
  valetParking?: boolean
  freeGarageParking?: boolean
  paidGarageParking?: boolean
}

/**
 * Place Details (New) response, trimmed to the fields canonry requests. The
 * amenity booleans + `editorialSummary` come from the Enterprise + Atmosphere
 * SKU; `accessibilityOptions` from Pro; identity fields from Essentials/Pro.
 */
export interface PlaceDetails {
  id?: string
  types?: string[]
  primaryType?: string
  primaryTypeDisplayName?: PlaceLocalizedText
  googleMapsUri?: string
  websiteUri?: string
  businessStatus?: string
  accessibilityOptions?: PlaceAccessibilityOptions
  editorialSummary?: PlaceLocalizedText
  parkingOptions?: PlaceParkingOptions
  servesBreakfast?: boolean
  servesLunch?: boolean
  servesDinner?: boolean
  servesBrunch?: boolean
  restroom?: boolean
  goodForChildren?: boolean
  goodForGroups?: boolean
  allowsDogs?: boolean
  outdoorSeating?: boolean
  reservable?: boolean
}

/**
 * Structured error from the Places API. `reason` is the value Google returns
 * under `error.status` (e.g. `INVALID_ARGUMENT`, `PERMISSION_DENIED`,
 * `NOT_FOUND`, `RESOURCE_EXHAUSTED`) so callers can branch:
 *   - 400 INVALID_ARGUMENT  → bad place id or field mask (our bug)
 *   - 403 PERMISSION_DENIED  → API key not authorized / Places API not enabled
 *   - 404 NOT_FOUND          → stale place id (the location dropped off Maps)
 *   - 429 RESOURCE_EXHAUSTED → rate limited (retryable)
 */
export class PlacesApiError extends Error {
  public readonly status: number
  public readonly reason: string | null
  public readonly body: unknown

  constructor(message: string, status: number, reason: string | null, body: unknown) {
    super(message)
    this.name = 'PlacesApiError'
    this.status = status
    this.reason = reason
    this.body = body
  }
}

export interface PlacesRetryOptions {
  /** Maximum number of retries (not counting the initial attempt). Default 3. */
  maxRetries?: number
  /** Base delay in milliseconds. Default 500. */
  baseDelayMs?: number
  /** Override the sleep function for testing. */
  sleep?: (ms: number) => Promise<void>
}

export interface PlacesFetchOptions {
  /** Retry policy override. */
  retry?: PlacesRetryOptions
}

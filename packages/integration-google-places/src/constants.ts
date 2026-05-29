// Places API (New) base host. Place Details is GET /v1/places/{placeId}.
// Auth is a plain API key via the `X-Goog-Api-Key` header (NOT OAuth — that is
// the key difference from the Business Profile APIs), and every request MUST
// carry an `X-Goog-FieldMask` listing the fields to return.
export const PLACES_API_BASE = 'https://places.googleapis.com/v1'

// HTTP timeout (30 s) — matches the GBP / integration-google convention.
export const PLACES_REQUEST_TIMEOUT_MS = 30_000

/**
 * Field-mask tiers, named after Google's Place Details SKUs. The request is
 * billed at the HIGHEST tier among the fields requested, so the mask is the
 * cost lever.
 *
 *   - `pro`        → IDs, types, Maps link, website, accessibility. Billed at
 *                    Place Details Pro ($17/1k, 5k free/month). `accessibilityOptions`
 *                    is the only amenity-style field at this tier.
 *   - `atmosphere` → Pro fields PLUS the amenity booleans + editorial summary
 *                    that actually power the GBP cross-reference. Billed at
 *                    Place Details Enterprise + Atmosphere ($25/1k, 1k free/month).
 *
 * For a typical operator book (a handful of hotels, weekly refresh) atmosphere
 * stays inside the 1k/month free tier — see the Place Details pricing note in
 * the package AGENTS.md.
 */
export type PlacesTier = 'atmosphere' | 'pro'

// Pro-tier fields. `accessibilityOptions` is the cheapest amenity-ish signal.
export const PLACES_PRO_FIELDS = [
  'id',
  'types',
  'primaryType',
  'primaryTypeDisplayName',
  'googleMapsUri',
  'websiteUri',
  'businessStatus',
  'accessibilityOptions',
] as const

// Amenity + summary fields that only exist at the Enterprise + Atmosphere SKU.
// These are what we cross-reference against the GBP structured lodging profile.
export const PLACES_ATMOSPHERE_FIELDS = [
  ...PLACES_PRO_FIELDS,
  'editorialSummary',
  'servesBreakfast',
  'servesLunch',
  'servesDinner',
  'servesBrunch',
  'restroom',
  'goodForChildren',
  'goodForGroups',
  'allowsDogs',
  'parkingOptions',
  'outdoorSeating',
  'reservable',
] as const

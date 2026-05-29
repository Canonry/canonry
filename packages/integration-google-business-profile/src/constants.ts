// Single OAuth scope used across the entire GBP API family. No read-only variant exists.
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage'

// API hosts — each sub-API lives on its own subdomain.
export const GBP_ACCOUNT_MANAGEMENT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
export const GBP_BUSINESS_INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
// Reviews and Local Posts still live on the legacy v4 host — Google never migrated them.
export const GBP_LEGACY_V4_BASE = 'https://mybusiness.googleapis.com/v4'
// Performance API — daily metrics + monthly search keywords.
export const GBP_PERFORMANCE_BASE = 'https://businessprofileperformance.googleapis.com/v1'
// Lodging API — hotel structured attributes.
export const GBP_LODGING_BASE = 'https://mybusinesslodging.googleapis.com/v1'

// The 11 DailyMetric enum values the Performance API supports. We sync all of
// them — zeros are cheap and which ones carry data varies by business type
// (a hotel gets BOOKINGS, a roofing contractor gets DIRECTION_REQUESTS, etc.).
export const GBP_DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_CONVERSATIONS',
  'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
  'BUSINESS_BOOKINGS',
  'BUSINESS_FOOD_ORDERS',
  'BUSINESS_FOOD_MENU_CLICKS',
] as const

// HTTP timeout (30 s) — matches the integration-google convention.
export const GBP_REQUEST_TIMEOUT_MS = 30_000

// Default pagination page size for listing endpoints. The Business Information
// API caps at 100; we pick a value that's safely under the cap for all surfaces.
export const GBP_DEFAULT_PAGE_SIZE = 100

// Safety limit: max pagination iterations to avoid infinite loops.
export const GBP_MAX_PAGES = 200

// Default readMask for listLocations — covers everything Phase 1 needs.
export const GBP_LOCATIONS_DEFAULT_READ_MASK = [
  'name',
  'title',
  'storefrontAddress',
  'websiteUri',
  'categories.primaryCategory.displayName',
].join(',')

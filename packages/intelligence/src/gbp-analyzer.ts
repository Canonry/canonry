import type { InsightSeverity, InsightType } from './types.js'

/**
 * Pure analyzers for Google Business Profile (local-AEO) signals. Take
 * per-location aggregates (already computed by the caller via the shared GBP
 * summary math + the keyword monthly series) and return location-scoped insight
 * drafts. No DB, no I/O, no timestamps — the caller assigns id + createdAt when
 * it persists. Severity thresholds live here so the dashboard, CLI, and Aero
 * all classify identically.
 */

/** Headline conversion metrics worth alerting on when they fall week-over-week. */
export const GBP_HEADLINE_METRICS = ['BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS', 'CALL_CLICKS'] as const

/** A headline metric must drop at least this % week-over-week to surface. */
export const GBP_METRIC_DROP_PCT = 40
/** A drop at or beyond this % is escalated from medium → high. */
export const GBP_METRIC_SEVERE_PCT = 70
/** The prior 7d window must have at least this many events (noise guard). */
export const GBP_METRIC_MIN_BASELINE = 10

/** A keyword must drop at least this % month-over-month to surface. */
export const GBP_KEYWORD_DROP_PCT = 40
/** A keyword drop at or beyond this % is escalated from medium → high. */
export const GBP_KEYWORD_SEVERE_PCT = 70
/** The prior month must have at least this many impressions (noise guard). */
export const GBP_KEYWORD_MIN_BASELINE = 20

/** Sentinel `provider` for GBP insights — they are location-scoped, not provider-scoped. */
export const GBP_INSIGHT_PROVIDER = 'gbp'

/** A keyword's impressions in the most recent complete month vs the prior month. */
export interface GbpKeywordPoint {
  keyword: string
  /** Impressions in the most recent complete month, or null when Google redacted. */
  recent: number | null
  /** Impressions in the prior month, or null when Google redacted. */
  prior: number | null
}

/** Per-location aggregates an analyzer needs. The caller derives these from the
 *  GBP summary math (metrics/lodging/place-actions) + the keyword monthly series. */
export interface GbpLocationSignals {
  /** Resource name ("locations/{n}") — the stable, unique location key. */
  locationName: string
  /** Human-readable name shown in the insight. */
  displayName: string
  metricRecent7d: Record<string, number>
  metricPrior7d: Record<string, number>
  /** Per-metric % change recent-vs-prior; null when the prior window was 0. */
  metricDeltaPct: Record<string, number | null>
  /** True when the location has a lodging profile at all (hotel/lodging category). */
  lodgingCapable: boolean
  /** True when the lodging profile has zero populated attribute groups. */
  lodgingEmpty: boolean
  /**
   * True when the owner has set no business description (`profile.description`).
   * Reliably owner-readable from the GBP API, so unlike `lodgingEmpty` this is a
   * real, confirmable completeness gap rather than a verify nudge.
   */
  descriptionMissing: boolean
  /**
   * Amenities Google's *rendered* public listing asserts, derived from the
   * Places API (#648). Empty when Places enrichment is off/unconfigured or the
   * location has no Place Details snapshot. When the GBP profile is empty but
   * this is non-empty, the listing-discrepancy insight fires with these as
   * evidence (superseding the generic lodging-gap insight).
   */
  placesAmenities: string[]
  placeActionCount: number
  hasDirectMerchantCta: boolean
  /** Most recent complete month with keyword data (YYYY-MM), or null. */
  keywordRecentMonth: string | null
  /** Prior month with keyword data (YYYY-MM), or null when there's no baseline. */
  keywordPriorMonth: string | null
  keywordPoints: GbpKeywordPoint[]
}

/** An insight before the persistence layer assigns it an id + createdAt. */
export interface GbpInsightDraft {
  /** The location this insight belongs to (used to build a stable, unique id). */
  locationName: string
  type: InsightType
  severity: InsightSeverity
  title: string
  /** Display label (the location's display name). */
  query: string
  provider: string
  recommendation?: { action: string; target?: string; reason: string }
}

const METRIC_LABELS: Record<string, string> = {
  BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
  WEBSITE_CLICKS: 'Website clicks',
  CALL_CLICKS: 'Call clicks',
}

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric
}

/** Join amenities into a readable clause: "a", "a and b", "a, b, and c". */
function formatAmenityList(amenities: string[]): string {
  if (amenities.length === 1) return amenities[0]!
  if (amenities.length === 2) return `${amenities[0]} and ${amenities[1]}`
  return `${amenities.slice(0, -1).join(', ')}, and ${amenities[amenities.length - 1]}`
}

/** Analyze per-location GBP signals into location-scoped insight drafts. */
export function analyzeGbp(signals: GbpLocationSignals[]): GbpInsightDraft[] {
  const drafts: GbpInsightDraft[] = []
  for (const loc of signals) {
    const base = { locationName: loc.locationName, query: loc.displayName, provider: GBP_INSIGHT_PROVIDER }

    // 1. canonry can't read structured Lodging attributes for this hotel.
    //    `getLodging` returns the GBP Lodging resource, which is empty by
    //    default even for well-managed hotels: the owner-facing "Hotel details"
    //    amenity panel (breakfast / wifi / parking / pets / accessibility)
    //    writes to a separate attribute surface the Lodging API does not return.
    //    So `populatedGroupCount === 0` means "canonry can't confirm structured
    //    attributes via the API", NOT "the owner set no amenities". These are
    //    verify-nudges, not confirmed gaps — framed and severitied accordingly.
    if (loc.lodgingCapable && loc.lodgingEmpty) {
      if (loc.placesAmenities.length > 0) {
        // The Places API independently shows amenities while the Lodging API
        // returns nothing. Worth a look, but it does NOT prove the owner left
        // them unset: Places can read amenities the Lodging API can't, so the
        // likeliest cause is the "Hotel details" panel is filled and simply not
        // exposed via the Lodging API. Surface it as a verify, not a defect.
        const amenityList = formatAmenityList(loc.placesAmenities)
        drafts.push({
          ...base,
          type: 'gbp-listing-discrepancy',
          severity: 'medium',
          title: `${loc.displayName}: public listing advertises ${loc.placesAmenities.length} amenit${loc.placesAmenities.length === 1 ? 'y' : 'ies'} canonry can’t confirm via the GBP API`,
          recommendation: {
            action: 'Verify these amenities are set in the Google Business Profile "Hotel details" panel so the structured profile matches what the public listing advertises.',
            reason: `Google’s rendered listing advertises ${amenityList}, but the GBP Lodging API returns no structured attributes for this location. The Lodging API does not expose the owner-set "Hotel details" amenity panel, so the amenities may already be set there and simply not be readable via the API. Verify in Hotel details: if any are missing, add them, since the structured attributes are the amenity data you directly control and that AI answer engines cite.`,
          },
        })
      } else {
        drafts.push({
          ...base,
          type: 'gbp-lodging-gap',
          severity: 'low',
          title: `${loc.displayName}: structured lodging attributes not readable via the GBP API`,
          recommendation: {
            action: 'Verify the hotel amenities in the Google Business Profile "Hotel details" panel. If they are already set there, no change is needed.',
            reason: 'The GBP Lodging API returns no structured attributes for this location. That resource is commonly empty even for complete hotels, because the owner-set "Hotel details" amenity panel (breakfast, wifi, parking, accessibility, and the like) writes to a separate surface the Lodging API does not expose. Treat this as a verify, not a confirmed gap: confirm the amenities are set in Hotel details, the amenity source you directly control and that AI answer engines cite.',
          },
        })
      }
    }

    // 2. No business description set. Unlike the lodging gap this is a reliable,
    //    owner-readable signal (`profile.description` comes straight from the
    //    Business Information API), so it is a real completeness gap. Low
    //    severity: a quick, owner-controlled improvement, not a regression.
    if (loc.descriptionMissing) {
      drafts.push({
        ...base,
        type: 'gbp-description-missing',
        severity: 'low',
        title: `${loc.displayName}: no business description set`,
        recommendation: {
          action: 'Add a business description (up to 750 characters) in the Google Business Profile.',
          reason: 'The owner description is the cheapest owner-controlled prose an AI answer engine can lift to describe the business, and it seeds the entity attributes (specialties, service area, differentiators) models draw on. It reads straight from the GBP API, so an empty one is a real, easily-closed gap.',
        },
      })
    }

    // 3. No direct-merchant booking CTA — only aggregator/OTA links present.
    if (loc.placeActionCount > 0 && !loc.hasDirectMerchantCta) {
      drafts.push({
        ...base,
        type: 'gbp-cta-gap',
        severity: 'medium',
        title: `${loc.displayName}: no direct booking link (only aggregator CTAs)`,
        recommendation: {
          action: 'Add a direct (merchant-owned) booking or reservation link as the preferred place action',
          reason: 'Only aggregator/OTA links are present, so AI engines surface third-party booking paths instead of the property’s own site.',
        },
      })
    }

    // 3. Headline metric fell sharply week-over-week (within the synced window).
    const worstMetric = pickWorstMetricDrop(loc)
    if (worstMetric) {
      const abs = Math.abs(worstMetric.deltaPct)
      drafts.push({
        ...base,
        type: 'gbp-metric-drop',
        severity: abs >= GBP_METRIC_SEVERE_PCT ? 'high' : 'medium',
        title: `${loc.displayName}: ${metricLabel(worstMetric.metric)} down ${abs}% week-over-week`,
        recommendation: {
          action: 'Investigate the local-visibility drop (profile changes, category edits, new competition)',
          reason: `${metricLabel(worstMetric.metric)} fell from ${worstMetric.prior} to ${worstMetric.recent} (last 7d vs the prior 7d).`,
        },
      })
    }

    // 4. A head search term's impressions dropped month-over-month.
    const worstKeyword = pickWorstKeywordDrop(loc)
    if (worstKeyword) {
      const window = loc.keywordPriorMonth && loc.keywordRecentMonth
        ? ` (${loc.keywordPriorMonth}→${loc.keywordRecentMonth})`
        : ''
      drafts.push({
        ...base,
        type: 'gbp-keyword-drop',
        severity: worstKeyword.dropPct >= GBP_KEYWORD_SEVERE_PCT ? 'high' : 'medium',
        title: `${loc.displayName}: "${worstKeyword.keyword}" impressions down ${worstKeyword.dropPct}% month-over-month${window}`,
        recommendation: {
          action: 'Check whether the property still ranks for this local search term and refresh the profile',
          reason: `Search-keyword impressions for "${worstKeyword.keyword}" fell from ${worstKeyword.prior} to ${worstKeyword.recent} month-over-month.`,
        },
      })
    }
  }
  return drafts
}

function pickWorstMetricDrop(loc: GbpLocationSignals): { metric: string; deltaPct: number; recent: number; prior: number } | null {
  let worst: { metric: string; deltaPct: number; recent: number; prior: number } | null = null
  for (const metric of GBP_HEADLINE_METRICS) {
    const delta = loc.metricDeltaPct[metric]
    const prior = loc.metricPrior7d[metric] ?? 0
    if (delta == null || delta > -GBP_METRIC_DROP_PCT || prior < GBP_METRIC_MIN_BASELINE) continue
    if (!worst || delta < worst.deltaPct) {
      worst = { metric, deltaPct: delta, recent: loc.metricRecent7d[metric] ?? 0, prior }
    }
  }
  return worst
}

function pickWorstKeywordDrop(loc: GbpLocationSignals): { keyword: string; dropPct: number; recent: number; prior: number } | null {
  if (!loc.keywordPriorMonth || !loc.keywordRecentMonth) return null
  let worst: { keyword: string; dropPct: number; recent: number; prior: number } | null = null
  for (const point of loc.keywordPoints) {
    if (point.recent == null || point.prior == null || point.prior < GBP_KEYWORD_MIN_BASELINE) continue
    const dropPct = Math.round(((point.prior - point.recent) / point.prior) * 100)
    if (dropPct < GBP_KEYWORD_DROP_PCT) continue
    if (!worst || dropPct > worst.dropPct) {
      worst = { keyword: point.keyword, dropPct, recent: point.recent, prior: point.prior }
    }
  }
  return worst
}

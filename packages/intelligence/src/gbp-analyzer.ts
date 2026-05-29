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

    // 1. Lodging profile empty — the GBP API exposes only owner-configured
    //    attributes, so an empty profile is the operator's blind spot. Google's
    //    rendered listing may still synthesize amenities from Hotel Center, OTAs,
    //    and Places/user data, but that synthesized data is NOT what the
    //    structured profile (the source AI answer engines read) exposes.
    if (loc.lodgingCapable && loc.lodgingEmpty) {
      if (loc.placesAmenities.length > 0) {
        // Evidence-backed (#648 Phase B): the Places API confirms the public
        // listing shows specific amenities the empty GBP profile exposes none
        // of. This supersedes the generic lodging-gap with concrete proof.
        const amenityList = formatAmenityList(loc.placesAmenities)
        drafts.push({
          ...base,
          type: 'gbp-listing-discrepancy',
          severity: 'high',
          title: `${loc.displayName}: public listing shows ${loc.placesAmenities.length} amenit${loc.placesAmenities.length === 1 ? 'y' : 'ies'} your GBP profile doesn’t`,
          recommendation: {
            action: 'Populate the hotel’s structured amenity attributes in Google Business Profile to match what its public listing already advertises — the amenity source you directly control',
            reason: `Google’s rendered listing advertises ${amenityList} (synthesized from Hotel Center / OTAs / Places), but your GBP structured profile has zero populated attributes. The structured attributes are what AI answer engines cite and the only amenity data you control, so the public listing is making promises your profile can’t back.`,
          },
        })
      } else {
        drafts.push({
          ...base,
          type: 'gbp-lodging-gap',
          severity: 'high',
          title: `${loc.displayName}: lodging profile has no structured attributes`,
          recommendation: {
            action: 'Populate the hotel’s structured amenity attributes in Google Business Profile — the amenity source you directly control',
            reason: 'The GBP API exposes only owner-configured attributes, and this profile has none. Google’s rendered listing may still show amenities it synthesizes from Hotel Center, OTAs, and user data — so the public listing can differ from this profile — but the structured attributes are what AI answer engines cite and the only amenity data you control.',
          },
        })
      }
    }

    // 2. No direct-merchant booking CTA — only aggregator/OTA links present.
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

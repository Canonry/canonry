import { z } from 'zod'
import { aiReferralEngineSchema } from './ai-referral-engine.js'
import { fraction } from './ratio-unit.js'

function dedupeStable(values: readonly string[], caseInsensitive = false): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function normalizeMarketingHost(value: string): string | null {
  try {
    const hasScheme = value.includes('://')
    const parsed = new URL(hasScheme ? value : `https://${value}`)
    if (!hasScheme && (parsed.pathname !== '/' || parsed.search || parsed.hash)) return null
    if (parsed.username || parsed.password || parsed.port) return null
    const host = parsed.hostname.trim().toLowerCase().replace(/^www\./, '')
    if (!host || host.includes('/') || host.includes('?') || host.includes('#')) return null
    return host
  } catch {
    return null
  }
}

// `.overwrite()` preserves the string/array output type in JSON Schema, unlike
// `.transform()`. That keeps this normalization contract representable in the
// generated OpenAPI document and typed SDK.
const marketingHostSchema = z.string().trim().min(1)
  .refine(value => normalizeMarketingHost(value) !== null, {
    message: 'Marketing hosts must be valid hostnames without credentials or ports',
  })
  .overwrite(value => normalizeMarketingHost(value) ?? value)

const brandTermSchema = z.string().trim().min(1)
const ga4EventNameSchema = z.string().trim().regex(/^[a-z]\w{0,39}$/i, {
  message: 'GA4 event names must start with a letter and contain only letters, numbers, or underscores',
})

export const measurementConfigSchema = z.object({
  marketingHosts: z.array(marketingHostSchema)
    .overwrite(values => dedupeStable(values, true)),
  brandTerms: z.array(brandTermSchema)
    .overwrite(values => dedupeStable(values, true)),
  leadEventNames: z.array(ga4EventNameSchema)
    .overwrite(values => dedupeStable(values)),
})

export type MeasurementConfig = z.infer<typeof measurementConfigSchema>

function createDefaultMeasurementConfig(): MeasurementConfig {
  return {
    marketingHosts: [],
    brandTerms: [],
    leadEventNames: ['generate_lead'],
  }
}

// This is a safe exported reference for comparison and display. Parsing at an
// outer boundary must use the factory below, never this object, so callers do
// not accidentally share mutable arrays with one another.
export const DEFAULT_MEASUREMENT_CONFIG: MeasurementConfig = Object.freeze({
  marketingHosts: Object.freeze([]) as unknown as string[],
  brandTerms: Object.freeze([]) as unknown as string[],
  leadEventNames: Object.freeze(['generate_lead']) as unknown as string[],
})

export const defaultMeasurementConfig = () => createDefaultMeasurementConfig()

export const gaMeasurementComponentStatusSchema = z.enum(['never-synced', 'ready', 'error'])
export type GaMeasurementComponentStatus = z.infer<typeof gaMeasurementComponentStatusSchema>

export const gaLeadAttributionScopeSchema = z.enum(['landing-page', 'channel'])
export type GaLeadAttributionScope = z.infer<typeof gaLeadAttributionScopeSchema>

export const gaMeasurementAnalysisWindowSchema = z.enum(['30d', '60d', '90d'])
export type GaMeasurementAnalysisWindow = z.infer<typeof gaMeasurementAnalysisWindowSchema>
export const gaMeasurementHostScopeSchema = z.enum(['marketing', 'all'])
export type GaMeasurementHostScope = z.infer<typeof gaMeasurementHostScopeSchema>

const analysisDateSchema = z.iso.date()
const analysisPeriodSchema = z.object({
  label: z.enum(['earliest', 'middle', 'previous', 'latest']),
  startDate: analysisDateSchema,
  endDate: analysisDateSchema,
})
const analysisSessionPeriodSchema = analysisPeriodSchema.extend({
  sessions: z.number().int().nonnegative(),
})
const analysisEventPeriodSchema = analysisPeriodSchema.extend({
  eventCount: z.number().int().nonnegative(),
})
const analysisClickPeriodSchema = analysisPeriodSchema.extend({
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
})
const analysisDemandPeriodSchema = analysisPeriodSchema.extend({
  propertyClicks: z.number().int().nonnegative(),
  propertyImpressions: z.number().int().nonnegative(),
  reportedQueryClicks: z.number().int().nonnegative(),
  reportedQueryImpressions: z.number().int().nonnegative(),
  brandedClicks: z.number().int().nonnegative(),
  brandedImpressions: z.number().int().nonnegative(),
  nonBrandedClicks: z.number().int().nonnegative(),
  nonBrandedImpressions: z.number().int().nonnegative(),
  unreportedClicks: z.number().int().nonnegative(),
  unreportedImpressions: z.number().int().nonnegative(),
})

/**
 * Lead events and sessions from one AI engine (or a total) in one 30-day
 * bucket and one traffic class. Both counts are keyed on the same GA4
 * `sessionSource` and the same paid/organic classification, so the rate
 * compares a numerator and denominator drawn from the same sessions.
 */
const analysisAiEngineLeadPeriodSchema = analysisPeriodSchema.extend({
  /** Configured lead events whose session came from this engine. */
  eventCount: z.number().int().nonnegative(),
  /** Sessions from this engine, read from acquisition under the same host and path filters. */
  sessions: z.number().int().nonnegative(),
  /**
   * `eventCount / sessions`: lead events per AI session. It can exceed 1 when
   * one session fires several lead events. `null` when the bucket has no
   * sessions, or when `leadRateAvailable` is false on the block.
   */
  leadRate: fraction(z.number().nonnegative()).nullable(),
})

/**
 * Why `leads.aiEngines` withholds every lead rate:
 * - `no-data`: no lead sync has run, or no stored GA row falls inside the
 *   filters, and the block is empty.
 * - `sync-not-ready`: the latest acquisition or lead sync did not succeed, so
 *   one side may be stale while the other is current.
 * - `channel-leads-unfiltered`: lead events are channel-scoped (GA4 could not
 *   attribute them to a landing page, so host and path filters cannot narrow
 *   them) while those filters narrow the sessions.
 * - `sessions-behind-leads`: stored lead events run past the last stored
 *   acquisition date, so the latest bucket holds leads for days with no
 *   sessions.
 */
export const aiEngineLeadRateUnavailableReasonSchema = z.enum([
  'no-data',
  'sync-not-ready',
  'channel-leads-unfiltered',
  'sessions-behind-leads',
])
export type AiEngineLeadRateUnavailableReason = z.infer<typeof aiEngineLeadRateUnavailableReasonSchema>
export const AiEngineLeadRateUnavailableReasons = aiEngineLeadRateUnavailableReasonSchema.enum

/**
 * One traffic class (`classifyAiReferralTrafficClass` on each row's source,
 * medium, channel group and landing page) of the AI engine breakdown. Paid
 * and organic never share a row or a rate.
 */
const analysisAiEngineLeadClassSchema = z.object({
  /**
   * Every row of this class combined (the engines plus `unattributed`), one
   * entry per bucket. Empty without a lead timeline.
   */
  periods: z.array(analysisAiEngineLeadPeriodSchema),
  /**
   * One row per engine with a lead event or a session of this class in the
   * window, ranked by latest-bucket lead events, then total lead events, then
   * sessions.
   */
  engines: z.array(z.object({
    engine: aiReferralEngineSchema,
    label: z.string(),
    /** The stored `sessionSource` values attributed to this engine in the window. */
    sources: z.array(z.string()),
    periods: z.array(analysisAiEngineLeadPeriodSchema),
  })),
  /**
   * Rows in GA4's own AI channel group (`GA4_AI_ASSISTANT_CHANNEL_GROUP`)
   * whose source matches none of the engines. They count toward `periods`, so
   * the AI channel never reads higher than this block. All zero (and no
   * sources) when every AI channel row matched an engine.
   */
  unattributed: z.object({
    sources: z.array(z.string()),
    periods: z.array(analysisAiEngineLeadPeriodSchema),
  }),
})

const analysisAiEngineLeadsSchema = z.object({
  /**
   * False when a rate would divide unlike data; `leadRateUnavailableReason`
   * says why. The counts stay populated and every `leadRate` is null.
   */
  leadRateAvailable: z.boolean(),
  /** Null exactly when `leadRateAvailable` is true. */
  leadRateUnavailableReason: aiEngineLeadRateUnavailableReasonSchema.nullable(),
  /** Sessions and lead events with no paid attribution evidence. */
  organic: analysisAiEngineLeadClassSchema,
  /** Paid AI clicks (for example tagged ChatGPT ads: `cpc`, `Paid Other`) and their lead events. */
  paid: analysisAiEngineLeadClassSchema,
})

/**
 * GA4 engagement + returning users for one 30-day bucket.
 *
 * Every metric is nullable, and `metricsAvailable` says which of the two
 * readings a null means: absent (the days in this bucket predate the metrics)
 * versus a real measured value that happens to be 0. A client report must
 * render the absent case as "not measured", never as a zero.
 *
 * `dailyTotalUsers` / `dailyNewUsers` are named for what they are: sums of
 * per-day, GA4-deduplicated counts. A visitor who returns on three days
 * contributes to three of them, so these are NOT period-unique user counts and
 * must never be labelled as such.
 *
 * There is deliberately no returning-users figure here. GA4 exposes no such
 * metric, and `totalUsers - newUsers` does not reconstruct one: a visitor can
 * be first-seen AND return inside the same range, so they are counted on both
 * sides and the subtraction understates the result. The only correct source is
 * the `newVsReturning` dimension, which changes the row shape of the whole sync
 * and belongs in its own change.
 */
const analysisEngagementPeriodSchema = analysisPeriodSchema.extend({
  /** Sessions over the bucket. Additive, so this is a plain sum. */
  sessions: z.number().int().nonnegative(),
  /**
   * Sessions-weighted engagement rate over the days that carry a reading.
   * A rate is not additive; sessions are, and GA4's engagementRate is
   * engagedSessions / sessions, so the weighted mean reconstructs the bucket
   * rate exactly. `null` when no day in the bucket carries a reading.
   */
  engagementRate: fraction(z.number().min(0).max(1)).nullable(),
  dailyTotalUsers: z.number().int().nonnegative().nullable(),
  dailyNewUsers: z.number().int().nonnegative().nullable(),
  /** False when the bucket has no engagement reading at all. */
  metricsAvailable: z.boolean(),
  daysInPeriod: z.number().int().nonnegative(),
  daysWithEngagementRate: z.number().int().nonnegative(),
  daysWithUserSplit: z.number().int().nonnegative(),
})

export const gaMeasurementAnalysisDtoSchema = z.object({
  window: gaMeasurementAnalysisWindowSchema,
  bucketDays: z.literal(30),
  filters: z.object({
    hostScope: gaMeasurementHostScopeSchema,
    marketingHosts: z.array(z.string()),
    pathPrefix: z.string().nullable(),
    brandTerms: z.array(z.string()),
    queryMixScope: z.literal('property'),
  }),
  acquisition: z.object({
    status: gaMeasurementComponentStatusSchema,
    error: z.string().nullable(),
    syncedAt: z.string().datetime().nullable(),
    periods: z.array(analysisSessionPeriodSchema),
    channels: z.array(z.object({
      channelGroup: z.string(),
      periods: z.array(analysisSessionPeriodSchema),
    })),
    pages: z.array(z.object({
      hostName: z.string(),
      landingPage: z.string(),
      periods: z.array(analysisSessionPeriodSchema),
    })),
  }),
  leads: z.object({
    status: gaMeasurementComponentStatusSchema,
    error: z.string().nullable(),
    syncedAt: z.string().datetime().nullable(),
    attributionScope: gaLeadAttributionScopeSchema.nullable(),
    hostAndPathFiltersApplied: z.boolean(),
    periods: z.array(analysisEventPeriodSchema),
    channels: z.array(z.object({
      channelGroup: z.string(),
      periods: z.array(analysisEventPeriodSchema),
    })),
    /**
     * Lead events broken down by the AI engine that sent the session (GA4
     * `sessionSource` through `aiEngineForReferralSource`) and by traffic
     * class, with the same engine's sessions and the lead rate. Finer than
     * GA4's own AI channel group in `channels`, which does not say which
     * engine and pools paid with organic.
     */
    aiEngines: analysisAiEngineLeadsSchema,
  }),
  engagement: z.object({
    status: z.enum(['ready', 'unavailable']),
    /**
     * Earliest date the project holds ANY engagement reading for, ignoring the
     * requested window. Everything before it is unmeasured, not zero — this is
     * the field a client report reads to label (or truncate) the pre-migration
     * span instead of drawing a flat zero line across it.
     */
    availableFromDate: analysisDateSchema.nullable(),
    latestDate: analysisDateSchema.nullable(),
    periods: z.array(analysisEngagementPeriodSchema),
  }),
  searchDemand: z.object({
    status: z.enum(['ready', 'unavailable']),
    periods: z.array(analysisDemandPeriodSchema),
    queries: z.array(z.object({
      query: z.string(),
      classification: z.enum(['branded', 'non-branded']),
      periods: z.array(analysisClickPeriodSchema),
    })),
    pages: z.array(z.object({
      hostName: z.string(),
      landingPage: z.string(),
      periods: z.array(analysisClickPeriodSchema),
    })),
    latestDate: analysisDateSchema.nullable(),
  }),
})
export type GaMeasurementAnalysisDto = z.infer<typeof gaMeasurementAnalysisDtoSchema>

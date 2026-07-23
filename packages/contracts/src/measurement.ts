import { z } from 'zod'

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

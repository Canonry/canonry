import { z } from 'zod'
import type { SourceCategory } from './source-categories.js'

export const metricsWindowSchema = z.enum(['7d', '30d', '90d', 'all'])
export type MetricsWindow = z.infer<typeof metricsWindowSchema>
export const trendDirectionSchema = z.enum(['improving', 'declining', 'stable'])
export type TrendDirection = z.infer<typeof trendDirectionSchema>
export type GapCategory = 'cited' | 'gap' | 'uncited'

// Mode toggle for analytics views — `mentioned` = brand appears in the answer
// prose; `cited` = domain appears in the source/grounding list. See AGENTS.md
// "Vocabulary (Critical)" for the full distinction.
export const visibilityMetricModeSchema = z.enum(['mentioned', 'cited'])
export type VisibilityMetricMode = z.infer<typeof visibilityMetricModeSchema>
export const VisibilityMetricModes = visibilityMetricModeSchema.enum

/** Citation + mention rates for one provider (or the overall roll-up) within a window or bucket. */
export const providerMetricSchema = z.object({
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
})
export type ProviderMetric = z.infer<typeof providerMetricSchema>

/**
 * One time bucket of the citation/mention trend. `byProvider` carries the
 * same metrics computed per provider over the bucket's normalized snapshot
 * set, so the dashboard can plot a line per provider over time.
 */
export const timeBucketSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  citationRate: z.number(),
  cited: z.number().int(),
  total: z.number().int(),
  queryCount: z.number().int(),
  mentionRate: z.number(),
  mentionedCount: z.number().int(),
  byProvider: z.record(z.string(), providerMetricSchema),
})
export type TimeBucket = z.infer<typeof timeBucketSchema>

export const queryChangeEventSchema = z.object({
  date: z.string(),
  delta: z.number().int(),
  label: z.string(),
})
export type QueryChangeEvent = z.infer<typeof queryChangeEventSchema>

export const brandMetricsDtoSchema = z.object({
  window: metricsWindowSchema,
  buckets: z.array(timeBucketSchema),
  overall: providerMetricSchema,
  byProvider: z.record(z.string(), providerMetricSchema),
  trend: trendDirectionSchema,
  mentionTrend: trendDirectionSchema,
  queryChanges: z.array(queryChangeEventSchema),
})
export type BrandMetricsDto = z.infer<typeof brandMetricsDtoSchema>

export interface GapQuery {
  query: string
  queryId: string
  category: GapCategory
  providers: string[]
  competitorsCiting: string[]
  consistency: { citedRuns: number; totalRuns: number; mentionedRuns: number }
}

export interface GapAnalysisDto {
  cited: GapQuery[]
  gap: GapQuery[]
  uncited: GapQuery[]
  mentionedQueries: GapQuery[]
  mentionGap: GapQuery[]
  notMentioned: GapQuery[]
  runId: string
  window: MetricsWindow
}

export interface SourceCategoryCount {
  category: SourceCategory
  label: string
  count: number
  percentage: number
  topDomains: Array<{ domain: string; count: number }>
}

export interface SourceBreakdownDto {
  overall: SourceCategoryCount[]
  byQuery: Record<string, SourceCategoryCount[]>
  runId: string
  window: MetricsWindow
}

export function parseWindow(value?: string): MetricsWindow {
  if (value === '7d' || value === '30d' || value === '90d' || value === 'all') return value
  return 'all'
}

export function windowCutoff(window: MetricsWindow): string | null {
  if (window === 'all') return null
  const days = window === '7d' ? 7 : window === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

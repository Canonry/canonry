import { z } from 'zod'
import { fraction } from './ratio-unit.js'

export type InsightType =
  | 'regression'
  | 'gain'
  | 'opportunity'
  | 'first-citation'
  | 'provider-pickup'
  | 'persistent-gap'
  | 'competitor-gained'
  | 'competitor-lost'
  // Google Business Profile (local-AEO) insights — produced after a gbp-sync
  // run, scoped to a location rather than a (query, provider) pair.
  | 'gbp-lodging-gap'
  | 'gbp-listing-discrepancy'
  | 'gbp-cta-gap'
  | 'gbp-description-missing'
  | 'gbp-metric-drop'
  | 'gbp-keyword-drop'

export const insightSeveritySchema = z.enum(['critical', 'high', 'medium', 'low'])
export type InsightSeverity = z.infer<typeof insightSeveritySchema>

/** What an insight asks of the operator: write content, investigate a drop, or monitor a win. */
export const insightActionGroupSchema = z.enum(['write', 'investigate', 'monitor'])
export type InsightActionGroup = z.infer<typeof insightActionGroupSchema>
export const InsightActionGroups = insightActionGroupSchema.enum

/** The action each insight type calls for. Only `monitor` insights are wins; every other type needs action. */
export const insightActionGroupByType: Record<InsightType, InsightActionGroup> = {
  // Content-required: a missing or competitive answer needs new or updated material.
  opportunity: InsightActionGroups.write,
  'persistent-gap': InsightActionGroups.write,
  'competitor-gained': InsightActionGroups.write,
  'competitor-lost': InsightActionGroups.write,
  // Diagnostic: something previously cited dropped, so find out why first.
  regression: InsightActionGroups.investigate,
  // Observational: positive movement; keep watching that it doesn't reverse.
  gain: InsightActionGroups.monitor,
  'first-citation': InsightActionGroups.monitor,
  'provider-pickup': InsightActionGroups.monitor,
  // GBP: profile gaps need content or profile work; metric and keyword drops need diagnosis.
  'gbp-lodging-gap': InsightActionGroups.write,
  'gbp-listing-discrepancy': InsightActionGroups.write,
  'gbp-cta-gap': InsightActionGroups.write,
  'gbp-description-missing': InsightActionGroups.write,
  'gbp-metric-drop': InsightActionGroups.investigate,
  'gbp-keyword-drop': InsightActionGroups.investigate,
}

export interface InsightDto {
  id: string
  projectId: string
  runId: string | null
  type: InsightType
  severity: InsightSeverity
  title: string
  query: string
  provider: string
  recommendation?: {
    action: string
    target?: string
    reason: string
  }
  cause?: {
    cause: string
    competitorDomain?: string
    details?: string
  }
  dismissed: boolean
  createdAt: string
}

export const healthSnapshotDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  overallCitedRate: fraction(),
  /**
   * Share of (query × provider) pairs where the project was MENTIONED in the
   * answer text. Independent of `overallCitedRate` — never derived from it.
   * Legacy snapshots persisted before the mention columns existed read back
   * as 0 (the API coalesces NULL→0).
   */
  overallMentionRate: fraction(),
  totalPairs: z.number().int().nonnegative(),
  citedPairs: z.number().int().nonnegative(),
  /** Count of pairs mentioned in the answer text. Legacy rows read back as 0. */
  mentionedPairs: z.number().int().nonnegative(),
  providerBreakdown: z.record(z.string(), z.object({
    citedRate: fraction(),
    mentionRate: fraction(),
    cited: z.number().int().nonnegative(),
    mentioned: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })),
  createdAt: z.string(),
  /**
   * `'ready'` when the snapshot reflects real data; `'no-data'` for the
   * sentinel returned by `/health/latest` when a project has no health
   * snapshots yet (newly created, or only failed runs). Numeric fields are
   * zero and `providerBreakdown` is `{}` in the no-data case.
   */
  status: z.enum(['ready', 'no-data']),
  /** Reason for `status === 'no-data'`. Absent when `status === 'ready'`. */
  reason: z.literal('no-runs-yet').optional(),
})

export type HealthSnapshotDto = z.infer<typeof healthSnapshotDtoSchema>

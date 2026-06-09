import { z } from 'zod'
import { runStatusSchema } from './run.js'

/**
 * Technical AEO — site-wide technical audit surfaced from `@ainyc/aeo-audit`'s
 * `runSitemapAudit`. A `site-audit` run crawls the project's sitemap, audits
 * every reachable HTML page across the aeo-audit ranking factors, and rolls the
 * per-page reports up into a single 0–100 site score + per-factor scorecard.
 *
 * These DTOs are the public contract for the dashboard "Technical AEO" page,
 * the `canonry technical-aeo …` CLI, and the matching MCP tools. The underlying
 * run/schedule kind stays `site-audit` (the existing `RunKinds` value); the
 * product surface is named "Technical AEO".
 */

/** Per-factor / per-page health bucket — mirrors aeo-audit's `scoreToStatus`. */
export const siteAuditFactorStatusSchema = z.enum(['pass', 'partial', 'fail'])
export type SiteAuditFactorStatus = z.infer<typeof siteAuditFactorStatusSchema>
export const SiteAuditFactorStatuses = siteAuditFactorStatusSchema.enum

/**
 * Bucket a 0–100 score into pass / partial / fail. Same thresholds aeo-audit
 * uses (`pass ≥ 70`, `partial 40–69`, `fail < 40`) — kept here as a pure helper
 * so canonry can classify the site-level factor averages it computes itself
 * without taking a dependency on the audit package.
 */
export function factorStatusFromScore(score: number): SiteAuditFactorStatus {
  if (score >= 70) return SiteAuditFactorStatuses.pass
  if (score >= 40) return SiteAuditFactorStatuses.partial
  return SiteAuditFactorStatuses.fail
}

/** Direction of the latest score relative to the previous site-audit run. */
export const siteAuditTrendDirectionSchema = z.enum(['up', 'down', 'flat'])
export type SiteAuditTrendDirection = z.infer<typeof siteAuditTrendDirectionSchema>
export const SiteAuditTrendDirections = siteAuditTrendDirectionSchema.enum

/**
 * Site-level rollup of one ranking factor across every successfully-audited
 * page. `avgScore` is the mean of that factor's per-page scores;
 * `pagesPassing + pagesPartial + pagesFailing` always equals the number of
 * successfully-audited pages.
 */
export const siteAuditFactorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  avgScore: z.number(),
  /** Canonry's own pass/partial/fail banding of `avgScore` (aeo-audit v3 is gradeless). */
  status: siteAuditFactorStatusSchema,
  pagesPassing: z.number().int().nonnegative(),
  pagesPartial: z.number().int().nonnegative(),
  pagesFailing: z.number().int().nonnegative(),
})
export type SiteAuditFactorSummaryDto = z.infer<typeof siteAuditFactorSummarySchema>

/**
 * A factor that scores poorly across many pages — the "fix this once, lift the
 * whole site" list. Produced by aeo-audit (`affectedPages` = pages scoring
 * < 70 for the factor); canonry adds `affectedPct` server-side so the dashboard
 * and CLI render the same share without recomputing it.
 */
export const siteAuditCrossCuttingIssueSchema = z.object({
  factorId: z.string(),
  factorName: z.string(),
  avgScore: z.number(),
  affectedPages: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  /** `round(affectedPages / totalPages * 100)`, `0` when `totalPages` is `0`. Computed by canonry, not aeo-audit. */
  affectedPct: z.number().int().nonnegative(),
  topRecommendations: z.array(z.string()).default([]),
})
export type SiteAuditCrossCuttingIssueDto = z.infer<typeof siteAuditCrossCuttingIssueSchema>

/**
 * The Technical AEO scorecard for a project — the latest completed/partial
 * `site-audit` run, with the delta vs the prior run computed server-side.
 *
 * When the project has never been audited, `hasData` is `false`, `runId` /
 * `auditedAt` are `null`, the numeric fields are `0`, and the arrays are empty
 * — consumers should branch on `hasData` and render an onboarding state rather
 * than treating the zeros as a real score.
 */
export const siteAuditScoreSchema = z.object({
  project: z.string(),
  hasData: z.boolean(),
  runId: z.string().nullable(),
  runStatus: runStatusSchema.nullable(),
  sitemapUrl: z.string().nullable(),
  auditedAt: z.string().nullable(),
  aggregateScore: z.number(),
  pagesDiscovered: z.number().int().nonnegative(),
  pagesAudited: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative(),
  pagesErrored: z.number().int().nonnegative(),
  /** `aggregateScore - previousScore`, or `null` when there is no prior run. */
  deltaScore: z.number().nullable(),
  trend: siteAuditTrendDirectionSchema.nullable(),
  previousScore: z.number().nullable(),
  previousAuditedAt: z.string().nullable(),
  factors: z.array(siteAuditFactorSummarySchema).default([]),
  crossCuttingIssues: z.array(siteAuditCrossCuttingIssueSchema).default([]),
  prioritizedFixes: z.array(z.string()).default([]),
})
export type SiteAuditScoreDto = z.infer<typeof siteAuditScoreSchema>

/** One factor's score on a single audited page (findings/recommendations are rolled up at the site level, not stored per page). */
export const siteAuditPageFactorSchema = z.object({
  id: z.string(),
  name: z.string(),
  weight: z.number(),
  score: z.number(),
})
export type SiteAuditPageFactorDto = z.infer<typeof siteAuditPageFactorSchema>

/** One audited page in the latest site-audit run. `status='error'` pages carry an `error` message and no factors. */
export const siteAuditPageSchema = z.object({
  url: z.string(),
  overallScore: z.number(),
  status: z.enum(['success', 'error']),
  error: z.string().nullable().optional(),
  factors: z.array(siteAuditPageFactorSchema).default([]),
})
export type SiteAuditPageDto = z.infer<typeof siteAuditPageSchema>

export const siteAuditPagesResponseSchema = z.object({
  project: z.string(),
  runId: z.string().nullable(),
  auditedAt: z.string().nullable(),
  /** Total pages in the latest run matching the filter (before `limit`/`offset`). */
  total: z.number().int().nonnegative(),
  pages: z.array(siteAuditPageSchema).default([]),
})
export type SiteAuditPagesResponseDto = z.infer<typeof siteAuditPagesResponseSchema>

/** One historical data point for the aggregate-score trend chart. */
export const siteAuditTrendPointSchema = z.object({
  runId: z.string(),
  auditedAt: z.string(),
  aggregateScore: z.number(),
  pagesAudited: z.number().int().nonnegative(),
})
export type SiteAuditTrendPointDto = z.infer<typeof siteAuditTrendPointSchema>

export const siteAuditTrendResponseSchema = z.object({
  project: z.string(),
  points: z.array(siteAuditTrendPointSchema).default([]),
})
export type SiteAuditTrendResponseDto = z.infer<typeof siteAuditTrendResponseSchema>

/** Body for `POST /projects/:name/technical-aeo/runs`. */
export const siteAuditRunRequestSchema = z.object({
  /** Override the sitemap URL. Defaults to `https://<canonicalDomain>/sitemap.xml`. */
  sitemapUrl: z.string().url().optional(),
  /** Cap the number of pages audited (highest sitemap `<priority>` first). */
  limit: z.number().int().positive().max(2000).optional(),
})
export type SiteAuditRunRequest = z.infer<typeof siteAuditRunRequestSchema>

export const siteAuditRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
})
export type SiteAuditRunResponseDto = z.infer<typeof siteAuditRunResponseSchema>

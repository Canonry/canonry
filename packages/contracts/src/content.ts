import { z } from 'zod'

import { providerNameSchema } from './provider.js'
import { DiscoveryCompetitorTypes, discoveryCompetitorTypeSchema, type DiscoveryCompetitorType } from './discovery.js'

// ─── Enums ───────────────────────────────────────────────────────────────────

export const contentActionSchema = z.enum(['create', 'expand', 'refresh', 'add-schema'])
export type ContentAction = z.infer<typeof contentActionSchema>
export const ContentActions = contentActionSchema.enum

/** Title-cased label for `ContentAction` — never render the raw enum to UI. */
export function contentActionLabel(action: ContentAction): string {
  switch (action) {
    case 'create': return 'Create'
    case 'expand': return 'Expand'
    case 'refresh': return 'Refresh'
    case 'add-schema': return 'Add schema'
  }
}

export const demandSourceSchema = z.enum(['gsc', 'competitor-evidence', 'both'])
export type DemandSource = z.infer<typeof demandSourceSchema>
export const DemandSources = demandSourceSchema.enum

export const actionConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type ActionConfidence = z.infer<typeof actionConfidenceSchema>
export const ActionConfidences = actionConfidenceSchema.enum

/** Title-cased label for `ActionConfidence` — never render the raw enum to UI. */
export function actionConfidenceLabel(confidence: ActionConfidence): string {
  switch (confidence) {
    case 'high': return 'High'
    case 'medium': return 'Medium'
    case 'low': return 'Low'
  }
}

export const pageTypeSchema = z.enum([
  'blog-post',
  'comparison',
  'listicle',
  'how-to',
  'guide',
  'glossary',
])
export type PageType = z.infer<typeof pageTypeSchema>
export const PageTypes = pageTypeSchema.enum

export const contentActionStateSchema = z.enum([
  'proposed',
  'briefed',
  'payload-generated',
  'draft-created',
  'published',
  'validated',
  'dismissed',
])
export type ContentActionState = z.infer<typeof contentActionStateSchema>
export const ContentActionStates = contentActionStateSchema.enum

// ─── winnabilityClass (winnability gate) ─────────────────────────────────────────
//
// Deterministic judgment of whether a query's cited surface is worth pursuing
// with first-party content. Derived (no LLM) by classifying the domains
// actually cited for the query through the discovery domain classifier:
//
//   - `ceded`   — the cited surface is dominated by aggregators (`ota-aggregator`)
//                 or editorial media (`editorial-media`). A head term the site
//                 cannot realistically win with its own content; do not chase it.
//   - `ownable` — everything else (a direct-competitor surface, our own domain,
//                 `other`/`unknown`, or no/uncovered citation). Worth a brief.
//
// Fail open: when in doubt (no classification coverage), it is `ownable`.

export const winnabilityClassSchema = z.enum(['ownable', 'ceded'])
export type WinnabilityClass = z.infer<typeof winnabilityClassSchema>
export const WinnabilityClasses = winnabilityClassSchema.enum

/** Title-cased label for `WinnabilityClass` — never render the raw enum to UI. */
export function winnabilityClassLabel(winnabilityClass: WinnabilityClass): string {
  switch (winnabilityClass) {
    case 'ownable': return 'Ownable'
    case 'ceded': return 'Ceded'
  }
}

/**
 * Citation-weighted share of the cited surface at or above which a query is
 * `ceded`. Conservative default: a surface is only ceded when aggregators +
 * editorial media make up a majority (≥60%) of the cited citations. Inclusive
 * at the boundary.
 */
export const CEDED_SURFACE_THRESHOLD = 0.6

/** One cited domain on a query's answer surface and how often it was cited. */
export interface CitedSurfaceDomain {
  /** Normalized domain (protocol/www stripped, lowercased). */
  domain: string
  citationCount: number
}

/**
 * Pure derivation of a content target's `winnabilityClass` from the domains cited
 * for its query and a `(domain → classification)` lookup produced by discovery.
 *
 * Weighting is by citation count, not domain count: one aggregator cited 40×
 * dominates three blogs cited once each. The `ceded` share is the fraction of
 * total citations attributed to `ota-aggregator` / `editorial-media` domains;
 * every cited domain (classified or not) counts in the denominator so
 * unclassified domains dilute toward `ownable` (the safe direction).
 *
 * Fails open to `{ ownable, winnability: null }` when there is no cited surface
 * or none of the cited domains carry a classification — we never hide a target
 * just because the gate lacks data. `winnability` is `1 - cededShare` (clamped)
 * when assessed, `null` when failed open.
 *
 * Domains must be pre-normalized; this helper does no normalization so it stays
 * a pure, dependency-free math function.
 */
export function deriveWinnabilityClass(
  citedSurfaceDomains: readonly CitedSurfaceDomain[],
  domainClasses: ReadonlyMap<string, DiscoveryCompetitorType>,
  threshold: number = CEDED_SURFACE_THRESHOLD,
): { winnabilityClass: WinnabilityClass; winnability: number | null } {
  const hasCoverage = citedSurfaceDomains.some((d) => domainClasses.has(d.domain))
  if (citedSurfaceDomains.length === 0 || domainClasses.size === 0 || !hasCoverage) {
    return { winnabilityClass: WinnabilityClasses.ownable, winnability: null }
  }

  let total = 0
  let ceded = 0
  for (const { domain, citationCount } of citedSurfaceDomains) {
    total += citationCount
    const cls = domainClasses.get(domain)
    if (cls === DiscoveryCompetitorTypes['ota-aggregator'] || cls === DiscoveryCompetitorTypes['editorial-media']) {
      ceded += citationCount
    }
  }

  if (total === 0) {
    return { winnabilityClass: WinnabilityClasses.ownable, winnability: null }
  }

  const cededShare = ceded / total
  const winnability = Math.min(1, Math.max(0, 1 - cededShare))
  return {
    winnabilityClass: cededShare >= threshold ? WinnabilityClasses.ceded : WinnabilityClasses.ownable,
    winnability,
  }
}

// ─── Shared sub-shapes ───────────────────────────────────────────────────────

const ourBestPageSchema = z.object({
  url: z.string(),
  gscImpressions: z.number().nonnegative(),
  gscClicks: z.number().nonnegative(),
  // Null when the page came from the inventory fallback (no GSC ranking data).
  gscAvgPosition: z.number().nonnegative().nullable(),
  organicSessions: z.number().nonnegative(),
})

const winningCompetitorSchema = z.object({
  domain: z.string(),
  url: z.string(),
  title: z.string(),
  citationCount: z.number().int().nonnegative(),
})

const scoreBreakdownSchema = z.object({
  demand: z.number(),
  competitor: z.number(),
  absence: z.number(),
  gapSeverity: z.number(),
})

const existingActionRefSchema = z.object({
  actionId: z.string(),
  state: contentActionStateSchema,
  lastUpdated: z.string(),
})

// ─── ContentTargetRowDto ─────────────────────────────────────────────────────

export const contentTargetRowDtoSchema = z.object({
  targetRef: z.string(),
  query: z.string(),
  action: contentActionSchema,
  ourBestPage: ourBestPageSchema.nullable(),
  winningCompetitor: winningCompetitorSchema.nullable(),
  score: z.number(),
  scoreBreakdown: scoreBreakdownSchema,
  drivers: z.array(z.string()),
  demandSource: demandSourceSchema,
  actionConfidence: actionConfidenceSchema,
  existingAction: existingActionRefSchema.nullable(),
  /**
   * Deterministic winnability gate. `ceded` ⇒ the cited surface is dominated by
   * aggregators/editorial and not worth chasing; `ownable` ⇒ worth a brief.
   * Derived (no LLM) from the discovery domain classifier.
   */
  winnabilityClass: winnabilityClassSchema,
  /**
   * Citation-weighted complement of the ceded share (`1 - cededShare`), in
   * `[0, 1]`. `null` when the gate failed open (no classification coverage for
   * the cited surface) — distinct from a computed `1.0`.
   */
  winnability: z.number().min(0).max(1).nullable(),
})

export type ContentTargetRowDto = z.infer<typeof contentTargetRowDtoSchema>

export const contentTargetsResponseDtoSchema = z.object({
  targets: z.array(contentTargetRowDtoSchema),
  contextMetrics: z.object({
    totalAiReferralSessions: z.number().int().nonnegative(),
    latestRunId: z.string(),
    runTimestamp: z.string(),
  }),
})

export type ContentTargetsResponseDto = z.infer<typeof contentTargetsResponseDtoSchema>

// ─── Content target dismissals ──────────────────────────────────────────────
//
// Manual "mark addressed" affordance for content opportunities. Recommendations
// are recomputed on every report load from live GSC/GA inventory; a dismissal
// row drops the matching recommendation from the report until explicitly
// un-dismissed. See `packages/db/src/schema.ts → contentTargetDismissals` and
// the AGENTS.md "Report parity" rule.

export const contentTargetDismissalDtoSchema = z.object({
  targetRef: z.string(),
  addressedUrl: z.string().nullable(),
  note: z.string().nullable(),
  dismissedAt: z.string(),
})

export type ContentTargetDismissalDto = z.infer<typeof contentTargetDismissalDtoSchema>

export const contentTargetDismissalsResponseDtoSchema = z.object({
  dismissals: z.array(contentTargetDismissalDtoSchema),
})

export type ContentTargetDismissalsResponseDto = z.infer<typeof contentTargetDismissalsResponseDtoSchema>

export const contentTargetDismissRequestSchema = z.object({
  targetRef: z.string().min(1),
  /** URL of the page the user wrote that addresses this recommendation. Stored verbatim for the audit trail; not currently used to suppress the slug-token matcher. */
  addressedUrl: z.string().url().optional(),
  /** Free-form note (e.g. "covered in our Q1 content sprint"). 500 char cap is the API surface limit; the DB column is unbounded. */
  note: z.string().max(500).optional(),
})

export type ContentTargetDismissRequest = z.infer<typeof contentTargetDismissRequestSchema>

// ─── Recommendation explanations (LLM rationale per card) ──────────────────
//
// Phase 1 of the LLM-augmented recommendation engine. The heuristic
// classifier produces the structured recommendation; an on-demand LLM
// call ("Why this?" button in the UI) explains the reasoning and
// suggests concrete next steps in natural language. Cached per
// (project, target_ref, prompt_version) so repeat clicks are free.

export const recommendationExplanationDtoSchema = z.object({
  targetRef: z.string(),
  /** Version of the prompt template used. Bumping the version invalidates the cache forward without touching the table. */
  promptVersion: z.string(),
  /** Provider that produced the explanation (e.g. "claude", "gemini"). */
  provider: z.string(),
  /** Model id within that provider (e.g. "claude-sonnet-4-6"). */
  model: z.string(),
  /** Markdown-formatted rationale + recommended next steps. */
  responseText: z.string(),
  /** Estimated cost in millicents (1/100 of a cent). 0 when unknown. */
  costMillicents: z.number().int().nonnegative(),
  generatedAt: z.string(),
})

export type RecommendationExplanationDto = z.infer<typeof recommendationExplanationDtoSchema>

export const recommendationExplainRequestSchema = z.object({
  /**
   * Optional provider override (e.g. "claude" to force Claude even if
   * the project's default is Gemini). Falls through to project default
   * → auto-detect when omitted.
   */
  provider: z.string().optional(),
  /**
   * Optional model override within the chosen provider. Falls through to
   * the `analyze`-tier default model when omitted.
   */
  model: z.string().optional(),
  /**
   * Force a fresh LLM call even if a cached explanation exists for the
   * current prompt version. Use sparingly — defeats the cache.
   */
  forceRefresh: z.boolean().optional(),
})

export type RecommendationExplainRequest = z.infer<typeof recommendationExplainRequestSchema>

// ─── Content briefs (LLM brief synthesis, gated to ownable targets) ─────────
//
// The brief mode of the content explainer. Where the explanation says *why* a
// target matters in prose, the brief synthesizes the structured plan an
// operator acts on: the angle, the why-winnable rationale, and the schema
// hookup. Gated server-side to `ownable` targets — a brief is never generated
// for a `ceded` head term. Cached independently of explanations in
// `recommendation_briefs`, keyed (project, target_ref, prompt_version).

export const contentBriefDtoSchema = z.object({
  /** The query the brief is for (echoed from the recommendation). */
  targetQuery: z.string().trim().min(1),
  /** Always `ownable` in practice — the gate rejects `ceded` before synthesis. */
  winnabilityClass: winnabilityClassSchema,
  /** The differentiated content angle to take. */
  angle: z.string().trim().min(1),
  /** Why this query is winnable, citing the cited-surface signal. */
  whyWinnable: z.string().trim().min(1),
  /** The schema.org type or markup to add or extend. */
  schemaHookup: z.string().trim().min(1),
  /** Why the cited surface is controllable (the ownable-vs-ceded reasoning). */
  controllableSurfaceRationale: z.string().trim().min(1),
})

export type ContentBriefDto = z.infer<typeof contentBriefDtoSchema>

export const recommendationBriefDtoSchema = z.object({
  targetRef: z.string(),
  /** Version of the brief prompt template; bumping invalidates the cache forward. */
  promptVersion: z.string(),
  provider: z.string(),
  model: z.string(),
  brief: contentBriefDtoSchema,
  /** Estimated cost in millicents (1/100 of a cent). 0 when unknown. */
  costMillicents: z.number().int().nonnegative(),
  generatedAt: z.string(),
})

export type RecommendationBriefDto = z.infer<typeof recommendationBriefDtoSchema>

// ─── Domain classifications (read surface for the winnability gate) ──────────

export const domainClassificationDtoSchema = z.object({
  domain: z.string(),
  competitorType: discoveryCompetitorTypeSchema,
  hits: z.number().int().nonnegative(),
  updatedAt: z.string(),
})

export type DomainClassificationDto = z.infer<typeof domainClassificationDtoSchema>

export const domainClassificationsResponseDtoSchema = z.object({
  classifications: z.array(domainClassificationDtoSchema),
})

export type DomainClassificationsResponseDto = z.infer<typeof domainClassificationsResponseDtoSchema>

// ─── ContentSources ──────────────────────────────────────────────────────────

const contentGroundingSourceSchema = z.object({
  uri: z.string(),
  title: z.string(),
  domain: z.string(),
  isOurDomain: z.boolean(),
  isCompetitor: z.boolean(),
  citationCount: z.number().int().nonnegative(),
  providers: z.array(providerNameSchema),
})

export const contentSourceRowDtoSchema = z.object({
  query: z.string(),
  groundingSources: z.array(contentGroundingSourceSchema),
})

export type ContentSourceRowDto = z.infer<typeof contentSourceRowDtoSchema>

export const contentSourcesResponseDtoSchema = z.object({
  sources: z.array(contentSourceRowDtoSchema),
  latestRunId: z.string(),
})

export type ContentSourcesResponseDto = z.infer<typeof contentSourcesResponseDtoSchema>

// ─── ContentGaps ─────────────────────────────────────────────────────────────

export const contentGapRowDtoSchema = z.object({
  query: z.string(),
  competitorDomains: z.array(z.string()),
  competitorCount: z.number().int().nonnegative(),
  missRate: z.number().min(0).max(1),
  lastSeenInRunId: z.string(),
})

export type ContentGapRowDto = z.infer<typeof contentGapRowDtoSchema>

export const contentGapsResponseDtoSchema = z.object({
  gaps: z.array(contentGapRowDtoSchema),
  latestRunId: z.string(),
})

export type ContentGapsResponseDto = z.infer<typeof contentGapsResponseDtoSchema>

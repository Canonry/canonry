import crypto from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  buildContentTargetRows,
  buildContentSourceRows,
  buildContentGapRows,
} from '@ainyc/canonry-intelligence'
import {
  contentTargetDismissRequestSchema,
  notFound,
  providerError,
  recommendationExplainRequestSchema,
  winnabilityClassSchema,
  WinnabilityClasses,
  validationError,
  type ContentBriefDto,
  type ContentGapsResponseDto,
  type ContentSourcesResponseDto,
  type ContentTargetDismissalDto,
  type ContentTargetDismissalsResponseDto,
  type ContentTargetRowDto,
  type ContentTargetsResponseDto,
  type DomainClassificationsResponseDto,
  type RecommendationBriefDto,
  type RecommendationExplainRequest,
  type RecommendationExplanationDto,
  type WinnabilityClass,
} from '@ainyc/canonry-contracts'
import {
  contentTargetDismissals,
  domainClassifications,
  recommendationBriefs,
  recommendationExplanations,
  type DatabaseClient,
} from '@ainyc/canonry-db'

import { resolveProject } from './helpers.js'
import { loadOrchestratorInput } from './content-data.js'

/**
 * Pluggable LLM explainer for content recommendations. The api-routes
 * package stays LLM-agnostic — canonry wires the real implementation
 * (pi-ai + capability-tier model selection) via
 * `ApiRoutesOptions.explainContentRecommendation`. Without an
 * implementation provided, the analyze endpoint returns 503 NO_PROVIDER.
 *
 * Contract:
 *   - `input` carries the full recommendation context the prompt template
 *     needs (the recommendation row itself plus project domain + any
 *     overrides the caller specified).
 *   - Implementation returns the rendered text plus metadata (provider,
 *     model, cost) that the route persists alongside.
 */
export interface ExplainContentRecommendationFn {
  (input: ExplainContentRecommendationInput): Promise<ExplainContentRecommendationResult>
}

export interface ExplainContentRecommendationInput {
  projectId: string
  projectName: string
  canonicalDomain: string
  recommendation: ContentTargetRowDto
  /** Caller-supplied provider override (e.g. "claude") or undefined to use project default. */
  providerOverride?: string
  /** Caller-supplied model override within the chosen provider, or undefined to use the analyze-tier default. */
  modelOverride?: string
}

export interface ExplainContentRecommendationResult {
  promptVersion: string
  provider: string
  model: string
  responseText: string
  costMillicents: number
}

/**
 * Pluggable LLM brief synthesizer for content recommendations. Like the
 * explainer, the api-routes package stays LLM-agnostic — canonry wires the
 * implementation. Where the explainer returns prose, the synthesizer returns a
 * STRUCTURED `ContentBriefDto`. Gated to `ownable` targets server-side, so the
 * implementation is only ever called for a winnable surface.
 */
export interface SynthesizeContentBriefFn {
  (input: SynthesizeContentBriefInput): Promise<SynthesizeContentBriefResult>
}

export interface SynthesizeContentBriefInput {
  projectId: string
  projectName: string
  canonicalDomain: string
  recommendation: ContentTargetRowDto
  providerOverride?: string
  modelOverride?: string
}

export interface SynthesizeContentBriefResult {
  promptVersion: string
  provider: string
  model: string
  brief: ContentBriefDto
  costMillicents: number
}

export interface ContentRoutesOptions {
  explainContentRecommendation?: ExplainContentRecommendationFn
  briefContentRecommendation?: SynthesizeContentBriefFn
  /**
   * Current brief prompt version, used to scope the brief cache lookup. Wired
   * from canonry's `RECOMMENDATION_BRIEF_PROMPT_VERSION`. When set, the lookup
   * filters by `(projectId, targetRef, promptVersion)` so a prompt-version bump
   * invalidates stale briefs forward — unlike the prompt-version-blind
   * explanation lookup. When omitted, falls back to most-recent.
   */
  briefPromptVersion?: string
}

/**
 * Load the set of dismissed `targetRef`s for a project. Caller filters
 * orchestrator output through this set so dismissed recommendations don't
 * resurface on the next report load. Exported so `report.ts` can share the
 * same load path (single source of truth for the dismissal filter).
 */
export function loadDismissedTargetRefs(
  db: DatabaseClient,
  projectId: string,
): Set<string> {
  const rows = db
    .select({ targetRef: contentTargetDismissals.targetRef })
    .from(contentTargetDismissals)
    .where(eq(contentTargetDismissals.projectId, projectId))
    .all()
  return new Set(rows.map((r) => r.targetRef))
}

function formatDismissalRow(row: typeof contentTargetDismissals.$inferSelect): ContentTargetDismissalDto {
  return {
    targetRef: row.targetRef,
    addressedUrl: row.addressedUrl,
    note: row.note,
    dismissedAt: row.dismissedAt,
  }
}

function formatExplanationRow(row: typeof recommendationExplanations.$inferSelect): RecommendationExplanationDto {
  return {
    targetRef: row.targetRef,
    promptVersion: row.promptVersion,
    provider: row.provider,
    model: row.model,
    responseText: row.responseText,
    costMillicents: row.costMillicents,
    generatedAt: row.generatedAt,
  }
}

function formatBriefRow(row: typeof recommendationBriefs.$inferSelect): RecommendationBriefDto {
  return {
    targetRef: row.targetRef,
    promptVersion: row.promptVersion,
    provider: row.provider,
    model: row.model,
    brief: row.brief,
    costMillicents: row.costMillicents,
    generatedAt: row.generatedAt,
  }
}

/**
 * Look up a recommendation by `targetRef` for a project. Recompute from
 * the orchestrator — `targetRef` is a stable hash, so a recommendation
 * surfaced today by `buildContentTargetRows` is the same one the user
 * clicked Explain on. Returns `null` if the orchestrator no longer
 * surfaces the recommendation (target dismissed, query removed, etc.) —
 * caller maps that to 404.
 */
function findRecommendationByRef(
  db: DatabaseClient,
  project: { id: string; canonicalDomain: string; ownedDomains: string[] },
  targetRef: string,
): ContentTargetRowDto | null {
  const input = loadOrchestratorInput(db, project)
  const rows = buildContentTargetRows(input)
  return rows.find((r) => r.targetRef === targetRef) ?? null
}

export async function contentRoutes(app: FastifyInstance, opts: ContentRoutesOptions = {}) {
  // GET /projects/:name/content/targets — ranked, action-typed opportunity list
  app.get<{
    Params: { name: string }
    Querystring: {
      limit?: string
      ['include-in-progress']?: string
      ['winnability-class']?: string
      ['surface-class']?: string
      ownable?: string
    }
  }>('/projects/:name/content/targets', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const includeInProgress = request.query['include-in-progress'] === 'true'
    const limit = parseLimitParam(request.query.limit)
    if (request.query['surface-class'] !== undefined) {
      throw validationError('"surface-class" was renamed to "winnability-class"')
    }
    const winnabilityClassFilter = parseWinnabilityClassFilter(request.query['winnability-class'], request.query.ownable)

    const input = loadOrchestratorInput(app.db, project)
    let rows = buildContentTargetRows(input)
    if (!includeInProgress) {
      rows = rows.filter((r) => r.existingAction === null)
    }
    // Filter persistently-dismissed recommendations. Same filter applied in
    // report.ts so SPA report, HTML report, and this endpoint stay aligned.
    const dismissed = loadDismissedTargetRefs(app.db, project.id)
    if (dismissed.size > 0) {
      rows = rows.filter((r) => !dismissed.has(r.targetRef))
    }
    if (winnabilityClassFilter) {
      rows = rows.filter((r) => r.winnabilityClass === winnabilityClassFilter)
    }
    // Surface ownable targets ahead of ceded ones. buildContentTargetRows
    // already returns rows in score-desc order; a STABLE sort keeps that order
    // within each class, so the net order is ownable-by-score then ceded-by-score.
    rows = [...rows].sort((a, b) => winnabilityClassRank(a.winnabilityClass) - winnabilityClassRank(b.winnabilityClass))
    if (limit !== undefined) {
      rows = rows.slice(0, limit)
    }

    const response: ContentTargetsResponseDto = {
      targets: rows,
      contextMetrics: {
        totalAiReferralSessions: input.totalAiReferralSessions,
        latestRunId: input.latestRunId,
        runTimestamp: input.latestRunTimestamp,
      },
    }
    return response
  })

  // GET /projects/:name/content/sources — URL-level competitive evidence map
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/sources', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentSourceRows(input)

    const response: ContentSourcesResponseDto = {
      sources: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })

  // GET /projects/:name/content/gaps — competitor-only-cited queries
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/gaps', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentGapRows(input)

    const response: ContentGapsResponseDto = {
      gaps: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })

  // GET /projects/:name/content/dismissals — list current dismissals
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/dismissals', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(contentTargetDismissals)
      .where(eq(contentTargetDismissals.projectId, project.id))
      .orderBy(contentTargetDismissals.dismissedAt)
      .all()
    const response: ContentTargetDismissalsResponseDto = {
      dismissals: rows.map(formatDismissalRow),
    }
    return response
  })

  // POST /projects/:name/content/dismissals — mark a recommendation addressed
  app.post<{
    Params: { name: string }
    Body: unknown
  }>('/projects/:name/content/dismissals', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = contentTargetDismissRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
    }
    const { targetRef, addressedUrl, note } = parsed.data
    const now = new Date().toISOString()

    // Idempotent upsert by (project_id, target_ref). Re-dismissing the same
    // ref overwrites addressed_url/note and refreshes dismissed_at so the
    // audit trail reflects the most recent action. Drizzle's
    // onConflictDoUpdate keeps this single-statement.
    app.db
      .insert(contentTargetDismissals)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        targetRef,
        addressedUrl: addressedUrl ?? null,
        note: note ?? null,
        dismissedAt: now,
      })
      .onConflictDoUpdate({
        target: [contentTargetDismissals.projectId, contentTargetDismissals.targetRef],
        set: {
          addressedUrl: addressedUrl ?? null,
          note: note ?? null,
          dismissedAt: now,
        },
      })
      .run()

    const row = app.db
      .select()
      .from(contentTargetDismissals)
      .where(and(
        eq(contentTargetDismissals.projectId, project.id),
        eq(contentTargetDismissals.targetRef, targetRef),
      ))
      .get()
    // `row` is non-null by construction — we just upserted it. The guard is
    // defensive against a deletion race; in practice the only way it returns
    // null is a CASCADE from a concurrent project delete.
    if (!row) throw notFound('contentTargetDismissal', targetRef)
    return formatDismissalRow(row)
  })

  // DELETE /projects/:name/content/dismissals/:targetRef — un-dismiss
  app.delete<{
    Params: { name: string; targetRef: string }
  }>('/projects/:name/content/dismissals/:targetRef', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { targetRef } = request.params
    const result = app.db
      .delete(contentTargetDismissals)
      .where(and(
        eq(contentTargetDismissals.projectId, project.id),
        eq(contentTargetDismissals.targetRef, targetRef),
      ))
      .run()
    if (result.changes === 0) {
      throw notFound('contentTargetDismissal', targetRef)
    }
    return reply.status(204).send()
  })

  // GET /projects/:name/content/recommendations/:targetRef/analysis —
  // return the most recent cached explanation (any prompt version) or
  // 404 if none exists. The SPA hits this on card mount so already-
  // analyzed cards render their cached rationale without re-paying the
  // LLM cost or waiting for a network round trip.
  app.get<{
    Params: { name: string; targetRef: string }
  }>('/projects/:name/content/recommendations/:targetRef/analysis', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db
      .select()
      .from(recommendationExplanations)
      .where(and(
        eq(recommendationExplanations.projectId, project.id),
        eq(recommendationExplanations.targetRef, request.params.targetRef),
      ))
      .orderBy(desc(recommendationExplanations.generatedAt))
      .limit(1)
      .get()
    if (!row) {
      // 404 here is "no cached explanation" — distinguished from "no
      // matching recommendation exists" which the POST handler returns.
      // GET is a fast cache-only read; the SPA falls through to the
      // POST flow when this 404s.
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No cached explanation for this targetRef.' } })
    }
    return reply.send(formatExplanationRow(row))
  })

  // POST /projects/:name/content/recommendations/:targetRef/analyze —
  // generate (or return cached) LLM-backed explanation for the
  // recommendation identified by `targetRef`. Uses an injected
  // `explainContentRecommendation` implementation (canonry wires the
  // pi-ai integration with capability-tier model selection). Returns
  // 503 NO_PROVIDER when no implementation is wired — this keeps the
  // api-routes package LLM-agnostic so it can ship without a hard pi-ai
  // dependency.
  app.post<{
    Params: { name: string; targetRef: string }
    Body: unknown
  }>('/projects/:name/content/recommendations/:targetRef/analyze', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const explainer = opts.explainContentRecommendation
    if (!explainer) {
      throw providerError(
        'No AI provider configured for content explanations. Configure a provider via `canonry settings` or set an API key env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY).',
      )
    }

    // Parse the request body (all fields optional) so unknown shapes
    // surface as a clean 400 before we touch the LLM helper.
    const parsed = recommendationExplainRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
    }
    const body: RecommendationExplainRequest = parsed.data
    const { targetRef } = request.params

    // Re-derive the recommendation context from the orchestrator. The
    // targetRef is a stable hash of (projectId, query, action), so a
    // recommendation surfaced now is the same one the user clicked on.
    // If it's not in the current set (orchestrator stopped surfacing
    // it — query removed, dismissed, etc.) we 404 rather than analyze a
    // stale rec.
    const recommendation = findRecommendationByRef(app.db, project, targetRef)
    if (!recommendation) {
      throw notFound('contentRecommendation', targetRef)
    }

    // Cache lookup — return the most recent prompt-version-matched row
    // unless the caller forced a refresh. Cache key is (projectId,
    // targetRef, promptVersion); bumping the prompt version is the
    // forward-compatible way to invalidate across all rows.
    if (!body.forceRefresh) {
      const cached = app.db
        .select()
        .from(recommendationExplanations)
        .where(and(
          eq(recommendationExplanations.projectId, project.id),
          eq(recommendationExplanations.targetRef, targetRef),
        ))
        .orderBy(desc(recommendationExplanations.generatedAt))
        .limit(1)
        .get()
      if (cached) return reply.send(formatExplanationRow(cached))
    }

    // No cache (or forceRefresh) — call the LLM via the injected
    // explainer. Errors from the explainer bubble up as 502/503 via the
    // global handler; the explainer is responsible for surfacing
    // provider-specific failure modes (rate limits, auth) cleanly.
    const result = await explainer({
      projectId: project.id,
      projectName: project.name,
      canonicalDomain: project.canonicalDomain,
      recommendation,
      providerOverride: body.provider,
      modelOverride: body.model,
    })

    // Upsert keyed by (projectId, targetRef, promptVersion). On
    // forceRefresh we INSERT-OR-REPLACE so the new generation overwrites
    // the previous one at the same prompt version (most recent wins).
    const now = new Date().toISOString()
    app.db
      .insert(recommendationExplanations)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        targetRef,
        promptVersion: result.promptVersion,
        provider: result.provider,
        model: result.model,
        responseText: result.responseText,
        costMillicents: result.costMillicents,
        generatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          recommendationExplanations.projectId,
          recommendationExplanations.targetRef,
          recommendationExplanations.promptVersion,
        ],
        set: {
          provider: result.provider,
          model: result.model,
          responseText: result.responseText,
          costMillicents: result.costMillicents,
          generatedAt: now,
        },
      })
      .run()

    const row = app.db
      .select()
      .from(recommendationExplanations)
      .where(and(
        eq(recommendationExplanations.projectId, project.id),
        eq(recommendationExplanations.targetRef, targetRef),
        eq(recommendationExplanations.promptVersion, result.promptVersion),
      ))
      .get()
    if (!row) throw notFound('recommendationExplanation', targetRef)
    return reply.send(formatExplanationRow(row))
  })

  // GET /projects/:name/content/recommendations/:targetRef/brief — return the
  // cached structured brief (current prompt version) or 404. Cache-only read;
  // the SPA falls through to the POST flow when this 404s. Reads the dedicated
  // recommendation_briefs table, so it never collides with explanations.
  app.get<{
    Params: { name: string; targetRef: string }
  }>('/projects/:name/content/recommendations/:targetRef/brief', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { targetRef } = request.params
    const recommendation = findRecommendationByRef(app.db, project, targetRef)
    if (!recommendation) {
      throw notFound('contentRecommendation', targetRef)
    }
    if (recommendation.winnabilityClass === WinnabilityClasses.ceded) {
      throw validationError(
        `Cannot return a brief for "${recommendation.query}": its cited surface is now ceded (dominated by aggregators/editorial).`,
      )
    }
    const row = lookupCachedBrief(app.db, project.id, targetRef, opts.briefPromptVersion)
    if (!row) throw notFound('recommendationBrief', request.params.targetRef)
    return reply.send(formatBriefRow(row))
  })

  // POST /projects/:name/content/recommendations/:targetRef/brief — synthesize
  // (or return cached) a STRUCTURED content brief. Gated to `ownable` targets:
  // a `ceded` head term is rejected with 400 before any LLM call, so a brief is
  // never produced for a surface we should not chase. Sibling of the analyze
  // route (no behavior change to the shipped explain endpoint); 503 when no
  // synthesizer is wired.
  app.post<{
    Params: { name: string; targetRef: string }
    Body: unknown
  }>('/projects/:name/content/recommendations/:targetRef/brief', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const synthesizer = opts.briefContentRecommendation
    if (!synthesizer) {
      throw providerError(
        'No AI provider configured for content briefs. Configure a provider via `canonry settings` or set an API key env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ZAI_API_KEY).',
      )
    }

    const parsed = recommendationExplainRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
    }
    const body: RecommendationExplainRequest = parsed.data
    const { targetRef } = request.params

    const recommendation = findRecommendationByRef(app.db, project, targetRef)
    if (!recommendation) {
      throw notFound('contentRecommendation', targetRef)
    }

    // The winnability gate — never synthesize a brief for a ceded head term.
    if (recommendation.winnabilityClass === WinnabilityClasses.ceded) {
      throw validationError(
        `Cannot synthesize a brief for "${recommendation.query}": its cited surface is ceded (dominated by aggregators/editorial). This is not a query first-party content can realistically win.`,
      )
    }

    if (!body.forceRefresh) {
      const cached = lookupCachedBrief(app.db, project.id, targetRef, opts.briefPromptVersion)
      if (cached) return reply.send(formatBriefRow(cached))
    }

    const result = await synthesizer({
      projectId: project.id,
      projectName: project.name,
      canonicalDomain: project.canonicalDomain,
      recommendation,
      providerOverride: body.provider,
      modelOverride: body.model,
    })

    const now = new Date().toISOString()
    app.db
      .insert(recommendationBriefs)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        targetRef,
        promptVersion: result.promptVersion,
        provider: result.provider,
        model: result.model,
        brief: result.brief,
        costMillicents: result.costMillicents,
        generatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          recommendationBriefs.projectId,
          recommendationBriefs.targetRef,
          recommendationBriefs.promptVersion,
        ],
        set: {
          provider: result.provider,
          model: result.model,
          brief: result.brief,
          costMillicents: result.costMillicents,
          generatedAt: now,
        },
      })
      .run()

    const row = app.db
      .select()
      .from(recommendationBriefs)
      .where(and(
        eq(recommendationBriefs.projectId, project.id),
        eq(recommendationBriefs.targetRef, targetRef),
        eq(recommendationBriefs.promptVersion, result.promptVersion),
      ))
      .get()
    if (!row) throw notFound('recommendationBrief', targetRef)
    return reply.send(formatBriefRow(row))
  })

  // GET /projects/:name/content/domain-classifications — the per-domain
  // cited-surface classifications discovery has produced for the project, the
  // read surface behind the winnabilityClass winnability gate. Powers
  // `canonry content map`.
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/domain-classifications', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(domainClassifications)
      .where(eq(domainClassifications.projectId, project.id))
      .orderBy(desc(domainClassifications.hits))
      .all()
    const response: DomainClassificationsResponseDto = {
      classifications: rows.map((r) => ({
        domain: r.domain,
        competitorType: r.competitorType,
        hits: r.hits,
        updatedAt: r.updatedAt,
      })),
    }
    return response
  })
}

/**
 * Cache lookup for a structured brief. Filters by `promptVersion` when the
 * route was wired with the current brief prompt version (so a version bump
 * invalidates stale briefs forward); otherwise returns the most recent row.
 */
function lookupCachedBrief(
  db: DatabaseClient,
  projectId: string,
  targetRef: string,
  promptVersion: string | undefined,
): typeof recommendationBriefs.$inferSelect | undefined {
  const conditions = [
    eq(recommendationBriefs.projectId, projectId),
    eq(recommendationBriefs.targetRef, targetRef),
  ]
  if (promptVersion !== undefined) {
    conditions.push(eq(recommendationBriefs.promptVersion, promptVersion))
  }
  return db
    .select()
    .from(recommendationBriefs)
    .where(and(...conditions))
    .orderBy(desc(recommendationBriefs.generatedAt))
    .limit(1)
    .get()
}

function parseLimitParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw validationError('"limit" must be a non-negative integer')
  }
  return parsed
}

/**
 * Resolve the optional winnabilityClass filter from the `winnability-class`
 * param and the `ownable` convenience flag. The explicit `winnability-class`
 * wins; `ownable` is shorthand for `winnability-class=ownable`. Returns
 * `undefined` for no filter.
 */
function parseWinnabilityClassFilter(raw: string | undefined, ownable: string | undefined): WinnabilityClass | undefined {
  if (raw !== undefined) {
    const parsed = winnabilityClassSchema.safeParse(raw)
    if (!parsed.success) {
      throw validationError('"winnability-class" must be "ownable" or "ceded"')
    }
    return parsed.data
  }
  if (ownable === 'true') return WinnabilityClasses.ownable
  return undefined
}

/** ownable sorts before ceded. */
function winnabilityClassRank(winnabilityClass: WinnabilityClass): number {
  return winnabilityClass === WinnabilityClasses.ownable ? 0 : 1
}

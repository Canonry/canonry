/**
 * Pure orchestrator for the content recommendation engine.
 *
 * Takes pre-fetched per-query evidence + project context and produces the
 * three canonical surfaces consumed by API/CLI/UI/Aero:
 *
 *   - buildContentTargetRows  → ranked, action-typed opportunity list
 *   - buildContentSourceRows  → URL-level competitive evidence map
 *   - buildContentGapRows     → competitor-only-cited queries
 *
 * No I/O. Inputs are produced by the data layer (api-routes/content-data.ts)
 * which performs the DB queries. Keeping this layer pure means the scoring
 * and classification can be unit-tested with synthetic inputs and snapshot-
 * tested with golden fixtures.
 */

import type {
  ContentTargetRowDto,
  ContentSourceRowDto,
  ContentGapRowDto,
  CitedSurfaceDomain,
  DiscoveryCompetitorType,
  ProviderName,
} from '@ainyc/canonry-contracts'
import { deriveSurfaceClass } from '@ainyc/canonry-contracts'

import { classifyContentAction } from './content-classifier.js'
import { scoreContentTarget } from './content-scorer.js'
import { calculateActionConfidence } from './content-confidence.js'
import type { SitePage } from './site-inventory.js'

// ─── Per-query evidence (output of data layer / aggregator) ─────────────────

export interface GroundingUrlEvidence {
  uri: string
  title: string
  domain: string
  citationCount: number
  providers: ProviderName[]
}

export type CompetitorGroundingUrl = GroundingUrlEvidence

export interface CandidateQuery {
  query: string

  // GSC ranking signal (null if no GSC entry for this query)
  gscPage: string | null
  gscPosition: number | null
  gscImpressions: number
  gscClicks: number
  gscCtr: number

  // Snapshot-derived signal
  ourCitedRate: number
  /**
   * True iff our domain was cited in any provider's snapshot of the most
   * recent answer-visibility run for this query. Distinct from
   * `ourGroundingUrls.length > 0`, which unions across the whole window —
   * intermittent old citations should not suppress current targets.
   */
  ourCitedInLatestRun: boolean
  competitorDomains: string[]
  competitorCitationCount: number
  recentMissRate: number
  ourGroundingUrls: GroundingUrlEvidence[]
  competitorGroundingUrls: GroundingUrlEvidence[]
  /**
   * Every non-own domain cited for this query with its citation count —
   * the FULL cited surface, NOT filtered to tracked competitors. The
   * surfaceClass winnability gate reads this so aggregators/editorial that
   * are not tracked competitors (the common case) still count toward "ceded".
   * `competitorGroundingUrls` is the tracked-competitor subset and must not be
   * used for the gate.
   */
  citedSurfaceDomains: CitedSurfaceDomain[]
  runsOfHistory: number
}

export interface ExistingActionRef {
  actionId: string
  state:
    | 'proposed'
    | 'briefed'
    | 'payload-generated'
    | 'draft-created'
    | 'published'
    | 'validated'
    | 'dismissed'
  lastUpdated: string
}

export interface OrchestratorInput {
  projectId: string
  ownDomain: string
  competitors: string[]

  candidateQueries: CandidateQuery[]
  /**
   * Optional terms to ignore when grouping recommendation targets by user intent.
   * Report callers pass the active market tokens here so "roof coating" and
   * "roof coating michigan" do not become duplicate content recommendations.
   */
  queryIntentModifiers?: readonly string[]
  inventory: SitePage[]
  wpSchemaAudit: Map<string, boolean>
  gaTrafficByPage: Map<string, number>

  totalAiReferralSessions: number
  latestRunId: string
  latestRunTimestamp: string

  /** PR 1: always empty. PR 3 lights this up from `content_actions`. */
  inProgressActions: Map<string, ExistingActionRef>

  /**
   * Per-domain cited-surface classifications from discovery, keyed by
   * normalized domain. Drives the deterministic surfaceClass gate. Empty map
   * (no discovery run yet) ⇒ every target fails open to `ownable`.
   */
  domainClasses: Map<string, DiscoveryCompetitorType>
}

// ─── Targets ────────────────────────────────────────────────────────────────

export function buildContentTargetRows(input: OrchestratorInput): ContentTargetRowDto[] {
  const rows: ContentTargetRowDto[] = []

  for (const cq of input.candidateQueries) {
    const ourPage = resolveOurPage(cq, input.inventory)
    const ourPageInGroundingSources = cq.ourCitedInLatestRun
    const ourPageHasSchema = ourPage ? input.wpSchemaAudit.get(ourPage.url) ?? null : null

    const action = classifyContentAction({
      ourPage,
      ourPageInGroundingSources,
      ourPageHasSchema,
    })

    if (!action) continue

    // Skip rows with no demand signal at all — recommending a target with
    // zero GSC traffic, zero competitor citations, and no AI citation of
    // our own gives the scorer nothing to anchor `demandSource` on and
    // produces a misleading row at score 0.
    const hasGsc = cq.gscImpressions > 0
    const hasCompetitor = cq.competitorDomains.length > 0
    if (!hasGsc && !hasCompetitor && !cq.ourCitedInLatestRun) continue

    const aiReferralFactor = computeAiReferralFactor(
      input.totalAiReferralSessions,
      cq.competitorCitationCount,
    )

    const scoring = scoreContentTarget({
      gscImpressions: cq.gscImpressions,
      aiReferralFactor,
      competitorCount: cq.competitorDomains.length,
      recentMissRate: cq.recentMissRate,
      citationCount: cq.competitorCitationCount,
      ourCitedRate: cq.ourCitedRate,
      action,
      position: ourPage?.position ?? null,
    })

    const actionConfidence = calculateActionConfidence({
      hasGsc: cq.gscPage !== null,
      gscImpressions: cq.gscImpressions,
      runsOfHistory: cq.runsOfHistory,
      hasCompetitorEvidence: cq.competitorDomains.length > 0,
      hasInventoryMatch: ourPage?.source === 'inventory',
    })

    const targetRef = computeTargetRef({
      projectId: input.projectId,
      query: cq.query,
      action,
    })

    const winningCompetitor = pickTopCompetitor(cq.competitorGroundingUrls)
    const ourBestPage = ourPage
      ? {
          url: ourPage.url,
          gscImpressions: cq.gscImpressions,
          gscClicks: cq.gscClicks,
          gscAvgPosition: cq.gscPosition,
          organicSessions: input.gaTrafficByPage.get(ourPage.url) ?? 0,
        }
      : null

    const { surfaceClass, winnability } = deriveSurfaceClass(cq.citedSurfaceDomains, input.domainClasses)

    rows.push({
      targetRef,
      query: cq.query,
      action,
      ourBestPage,
      winningCompetitor,
      score: scoring.score,
      scoreBreakdown: scoring.scoreBreakdown,
      drivers: scoring.drivers,
      demandSource: scoring.demandSource,
      actionConfidence,
      existingAction: input.inProgressActions.get(targetRef) ?? null,
      surfaceClass,
      winnability,
    })
  }

  return dedupeByIntent(
    rows.sort((a, b) => b.score - a.score),
    input.queryIntentModifiers ?? [],
  )
}

// ─── Sources ────────────────────────────────────────────────────────────────

export function buildContentSourceRows(input: OrchestratorInput): ContentSourceRowDto[] {
  return input.candidateQueries.map((cq) => ({
    query: cq.query,
    groundingSources: [
      ...cq.ourGroundingUrls.map((g) => ({
        uri: g.uri,
        title: g.title,
        domain: g.domain,
        isOurDomain: true,
        isCompetitor: false,
        citationCount: g.citationCount,
        providers: g.providers,
      })),
      ...cq.competitorGroundingUrls.map((g) => ({
        uri: g.uri,
        title: g.title,
        domain: g.domain,
        isOurDomain: false,
        isCompetitor: true,
        citationCount: g.citationCount,
        providers: g.providers,
      })),
    ],
  }))
}

// ─── Gaps ───────────────────────────────────────────────────────────────────

export function buildContentGapRows(input: OrchestratorInput): ContentGapRowDto[] {
  const gaps: ContentGapRowDto[] = []
  for (const cq of input.candidateQueries) {
    if (cq.competitorDomains.length === 0) continue
    if (cq.ourCitedRate >= 1) continue
    gaps.push({
      query: cq.query,
      competitorDomains: cq.competitorDomains,
      competitorCount: cq.competitorDomains.length,
      missRate: clamp01(cq.recentMissRate),
      lastSeenInRunId: input.latestRunId,
    })
  }
  // Highest miss-rate first, then by competitor count.
  return gaps.sort((a, b) => {
    if (b.missRate !== a.missRate) return b.missRate - a.missRate
    return b.competitorCount - a.competitorCount
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveOurPage(
  cq: CandidateQuery,
  inventory: SitePage[],
): { url: string; position: number; source: 'gsc' | 'inventory' } | null {
  if (cq.gscPage && cq.gscPosition !== null) {
    return { url: cq.gscPage, position: cq.gscPosition, source: 'gsc' }
  }

  // Inventory fallback: find a blog-shaped page whose slug overlaps with the query.
  for (const page of inventory) {
    if (slugMatchesQuery(page.url, cq.query)) {
      // Position unknown — treat as 100 (worst case = effectively invisible).
      return { url: page.url, position: 100, source: 'inventory' }
    }
  }

  return null
}

function slugMatchesQuery(url: string, query: string): boolean {
  // Lightweight inline matcher — full page-matcher.ts is used elsewhere; here we
  // just need a quick "is the query meaningfully present in the slug?" check.
  const slug = url.toLowerCase()
  const queryAsSlug = query.toLowerCase().trim().replace(/\s+/g, '-')
  if (slug.includes(queryAsSlug)) return true

  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
  const slugTokens = new Set(slug.split(/[/\s\-_.]+/))
  const overlap = queryTokens.filter((t) => slugTokens.has(t)).length
  return overlap >= 2
}

function computeAiReferralFactor(totalAiReferralSessions: number, competitorCount: number): number {
  if (totalAiReferralSessions <= 0) return 0
  // Crude project-level AI traffic indicator. More AI traffic + more competitors
  // = higher boost. Capped at 1.0 to avoid runaway scores.
  const baseline = Math.min(totalAiReferralSessions / 1000, 0.5)
  const competitorBoost = competitorCount > 0 ? 0.1 : 0
  return Math.min(baseline + competitorBoost, 1.0)
}

const QUERY_INTENT_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'for',
  'from',
  'in',
  'near',
  'of',
  'on',
  'or',
  'the',
  'to',
])

function dedupeByIntent(
  rows: ContentTargetRowDto[],
  modifiers: readonly string[],
): ContentTargetRowDto[] {
  if (rows.length <= 1 || modifiers.length === 0) return rows

  const seen = new Set<string>()
  const result: ContentTargetRowDto[] = []
  const modifierTokens = new Set(
    modifiers.flatMap(tokenizeQuery).map(normalizeToken).filter(Boolean),
  )

  for (const row of rows) {
    const key = intentKey(row.query, modifierTokens)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }

  return result
}

function intentKey(query: string, modifierTokens: ReadonlySet<string>): string {
  const tokens = tokenizeQuery(query)
    .map(normalizeToken)
    .filter(Boolean)
    .filter(token => !QUERY_INTENT_STOPWORDS.has(token))
    .filter(token => !modifierTokens.has(token))
  return [...new Set(tokens)].sort().join(' ')
}

function tokenizeQuery(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function normalizeToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function pickTopCompetitor(
  competitors: CompetitorGroundingUrl[],
): { domain: string; url: string; title: string; citationCount: number } | null {
  if (competitors.length === 0) return null
  const top = [...competitors].sort((a, b) => b.citationCount - a.citationCount)[0]!
  return {
    domain: top.domain,
    url: top.uri,
    title: top.title,
    citationCount: top.citationCount,
  }
}

function computeTargetRef(input: {
  projectId: string
  query: string
  action: string
}): string {
  // The ref is the recommendation's *intent identity* — what the user
  // would dismiss if they marked it "addressed" in the report. It must
  // stay stable across orchestrator runs even when run-level state
  // shifts. Two run-level signals to deliberately exclude:
  //
  //   1. `targetPage` — the orchestrator's view of "best matching owned
  //      page" shifts whenever GSC inventory updates (a different page
  //      starts ranking for the query, the previous best page drops
  //      off, etc.). Including it meant the SAME recommendation
  //      (same query, same action) would get a NEW ref on every report
  //      load if the inventory shifted at all, so persisted dismissals
  //      stopped matching after one cycle.
  //   2. Anything tied to runId / location / sweep timestamp — same
  //      reason; the dismissal is on the recommendation, not the
  //      snapshot.
  //
  // When the action type itself shifts (`create` → `refresh` because a
  // page now exists for the query), that's a new conceptual
  // recommendation and the new ref is correct: a "refresh" dismissal
  // shouldn't suppress a future "create" suggestion.
  const key = [input.projectId, input.query, input.action].join('|')
  // Stable hash — same inputs produce the same ref. Not a security
  // boundary, just a deterministic identifier for client-side
  // reference + matching against persisted dismissals.
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  }
  return `tgt_${(hash >>> 0).toString(36)}`
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

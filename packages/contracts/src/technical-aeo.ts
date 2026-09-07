import { z } from 'zod'
import { runStatusSchema } from './run.js'

// Keep this as an explicit union instead of `.nullable()`: OpenAPI 3.0 emits
// the latter as `nullable: true` beside an enum, which some client generators
// (including hey-api) discard. The union produces a correct `| null` client
// type while retaining the same runtime contract.
const nullableRunStatusSchema = z.union([runStatusSchema, z.null()])

/**
 * Technical AEO — site-wide technical audit surfaced from
 * `@canonry/aeo-audit`'s `runSiteCrawl`. A `site-audit` run discovers pages
 * from the root, robots/sitemaps, and internal links; audits each reachable
 * HTML page; and rolls the reports into a site score plus crawl graph.
 *
 * These DTOs are the public contract for the dashboard's visible "Site Health"
 * tab, the `canonry technical-aeo …` CLI, and the matching MCP tools. The
 * stable route/API/embed key stays `technical-aeo`; the underlying run and
 * schedule kind stays `site-audit` (the existing `RunKinds` value).
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
  runStatus: nullableRunStatusSchema,
  sitemapUrl: z.string().nullable(),
  auditedAt: z.string().nullable(),
  aggregateScore: z.number(),
  pagesDiscovered: z.number().int().nonnegative(),
  pagesAudited: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative(),
  pagesErrored: z.number().int().nonnegative(),
  /** `aggregateScore - previousScore`, or `null` when there is no prior run. */
  deltaScore: z.number().nullable(),
  trend: z.union([siteAuditTrendDirectionSchema, z.null()]),
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

/** Read-only crawl persistence is distinct from the legacy scorecard tables. */
export const siteCrawlDeadLinkStateSchema = z.enum(['disabled', 'complete', 'partial', 'unavailable'])
export type SiteCrawlDeadLinkState = z.infer<typeof siteCrawlDeadLinkStateSchema>
export const SiteCrawlDeadLinkStates = siteCrawlDeadLinkStateSchema.enum

export const siteCrawlCountsSchema = z.object({
  pagesDiscovered: z.number().int().nonnegative(),
  pagesFetched: z.number().int().nonnegative(),
  pagesEligible: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
})
export type SiteCrawlCountsDto = z.infer<typeof siteCrawlCountsSchema>

/**
 * `found` counts links whose target ANSWERED with 4xx/5xx. `unverified` counts
 * targets the crawler could not fetch at all — a timeout, a reset connection,
 * throttling under crawl concurrency — which is a fact about the crawl and not
 * about the link. Unverified links are excluded from `found` AND from
 * `checked`, and must never be rendered as broken. A scan predating the split
 * reports `unverified: 0`; that is the column default, not a measurement.
 */
const siteCrawlDeadLinksSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unavailable') }),
  z.object({ state: z.literal('disabled') }),
  z.object({ state: z.literal('complete'), checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), unverified: z.number().int().nonnegative() }),
  z.object({ state: z.literal('partial'), checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), unverified: z.number().int().nonnegative() }),
])

/**
 * Latest (or selected) persisted crawl. `hasCrawlData=false` is intentionally
 * not backfilled from legacy `site_audit_*` rows: their scorecard data does not
 * imply a page graph. `legacyAuditAvailable` lets consumers retain that view.
 */
export const siteCrawlSummarySchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  legacyAuditAvailable: z.boolean(),
  runId: z.string().nullable(),
  runStatus: nullableRunStatusSchema,
  /** Root URL originally requested by the operator; null for legacy snapshots. */
  requestedRootUrl: z.string().nullable(),
  /** Effective root followed by the crawl after any supported host redirect. */
  rootUrl: z.string().nullable(),
  crawlSchemaVersion: z.string().nullable().optional(),
  engineVersion: z.string().nullable().optional(),
  normalizationVersion: z.string().nullable().optional(),
  indexabilityVersion: z.string().nullable().optional(),
  linkScoreVersion: z.string().nullable().optional(),
  effectiveOptions: z.record(z.string(), z.unknown()).default({}),
  complete: z.boolean(),
  termination: z.string().nullable(),
  detailsAvailable: z.boolean(),
  counts: siteCrawlCountsSchema,
  deadLinks: siteCrawlDeadLinksSummarySchema,
})
export type SiteCrawlSummaryDto = z.infer<typeof siteCrawlSummarySchema>

/**
 * Why a crawl stopped early. Mirrors `CrawlTerminationReason` from
 * @canonry/aeo-audit, plus two values canonry itself writes: `complete` when
 * the crawl finished on its own, and `unknown`, the NOT NULL column default in
 * `packages/db` that a row keeps when nothing ever set a reason. `unknown` is
 * in the set precisely because it is persisted and reader-visible: leaving it
 * out would render the raw token in client copy. Persisted rows stay
 * string-backed for forward compatibility, so consumers match against this set
 * and keep a raw fallback.
 */
export const siteCrawlTerminationSchema = z.enum([
  'complete',
  'unknown',
  'max-pages',
  'max-edges',
  'max-fetches',
  'max-duration',
  'max-bytes',
  'max-page-bytes',
  'max-depth',
  'max-links-per-page',
  'max-query-variants',
  'max-sitemap-fanout',
  'max-sitemap-urls',
  'root-host-redirect',
])
export type SiteCrawlTermination = z.infer<typeof siteCrawlTerminationSchema>

/**
 * A link from a page to itself.
 *
 * Self-links carry no navigational meaning: they are not a link to or from
 * another page, and the crawl engine already leaves them out of a page's
 * inbound and outbound metrics. Defined once here so every writer and reader
 * uses the same rule, and compared on the normalized URLs the crawl stores.
 */
export function isSelfLink(sourceUrl: string, targetUrl: string): boolean {
  return sourceUrl === targetUrl
}

/** Shared meaning behind Site Health node color across API, agents, and UI. */
/**
 * What a crawled page is, for a reader.
 *
 * `hidden` means the SITE told answer engines not to index it. That is a claim
 * about intent, so it is kept narrow: only a noindex directive, a canonical
 * pointing elsewhere, or a robots.txt block earn it. A `.txt`, a PDF, or a
 * redirect are not hidden, and calling them hidden reads as a defect. It is
 * actively wrong for `llms.txt` and `llms-full.txt`, whose whole purpose is to
 * be fetched by answer engines.
 */
export const siteHealthStateSchema = z.enum([
  'eligible',
  'hidden',
  /** Fetched, but not an HTML page: a text file, a PDF, an image. Not a fault. */
  'resource',
  /** Fetched and redirected elsewhere. Moved, not hidden. */
  'redirect',
  'failed',
  'unchecked',
])
export type SiteHealthState = z.infer<typeof siteHealthStateSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteHealthStates = siteHealthStateSchema.enum
/**
 * Legend order: what a reader should scan first. Derived from the schema so a
 * new state cannot be added without deciding where it appears.
 */
export const SITE_GRAPH_LEGEND_STATES = siteHealthStateSchema.options

/** Exact state vocabulary emitted by @canonry/aeo-audit's Site Crawl contract. */
export const SiteCrawlFetchStates = {
  discovered: 'discovered',
  robotsBlocked: 'robots-blocked',
  html: 'html',
  redirect: 'redirect',
  nonHtml: 'non-html',
  fetchError: 'fetch-error',
} as const
export type SiteCrawlFetchState = (typeof SiteCrawlFetchStates)[keyof typeof SiteCrawlFetchStates]
/** States reached only after an HTTP fetch was attempted. */
export const SiteCrawlFetchedStates = [
  SiteCrawlFetchStates.html,
  SiteCrawlFetchStates.redirect,
  SiteCrawlFetchStates.nonHtml,
  SiteCrawlFetchStates.fetchError,
] as const satisfies readonly SiteCrawlFetchState[]

/** Exact indexability vocabulary emitted by @canonry/aeo-audit's Site Crawl contract. */
export const SiteCrawlIndexabilityStates = {
  indexable: 'indexable',
  noindex: 'noindex',
  blocked: 'blocked',
  unknown: 'unknown',
} as const
export type SiteCrawlIndexabilityState = (typeof SiteCrawlIndexabilityStates)[keyof typeof SiteCrawlIndexabilityStates]

/** Machine reasons that carry a canonical-identity decision from the crawler. */
export const SiteCrawlIndexabilityReasons = {
  robotsDisallow: 'robots-disallow',
  redirectTerminal: 'redirect-terminal',
  metaRobotsNoindex: 'meta-robots-noindex',
  xRobotsNoindex: 'x-robots-noindex',
  canonicalToOther: 'canonical-to-other',
  notHtmlOrUnavailable: 'not-html-or-unavailable',
} as const
export type SiteCrawlIndexabilityReason = (typeof SiteCrawlIndexabilityReasons)[keyof typeof SiteCrawlIndexabilityReasons]

/**
 * Rows remain string-backed for forward-compatible persisted crawl history, but
 * classification only recognizes the exact crawler values declared above.
 */
export interface SiteHealthStateInput {
  fetchState: string
  indexabilityState: string
  indexabilityReasons?: readonly string[]
  /** Resolved canonical identity. It is null when that target was not a crawl node. */
  canonicalNodeKey?: string | null
  /** Stable identity of this persisted crawl page. */
  nodeKey?: string
}

function pointsToOtherCanonical(input: SiteHealthStateInput): boolean {
  return input.indexabilityReasons?.some((reason) => reason === SiteCrawlIndexabilityReasons.canonicalToOther) === true
    || (input.nodeKey !== undefined
      && input.canonicalNodeKey !== null
      && input.canonicalNodeKey !== undefined
      && input.canonicalNodeKey !== input.nodeKey)
}

export function deriveSiteHealthState(input: SiteHealthStateInput): SiteHealthState {
  // Fetch state is decisive: a failed request cannot be visually eligible.
  switch (input.fetchState) {
    case SiteCrawlFetchStates.fetchError:
      return 'failed'
    case SiteCrawlFetchStates.discovered:
      return 'unchecked'
    // A non-HTML resource was fetched successfully. It is simply not a page,
    // which is a fact about its type, not a problem with the site.
    case SiteCrawlFetchStates.nonHtml:
      return 'resource'
    // A redirect moved; nothing about it says "do not index me".
    case SiteCrawlFetchStates.redirect:
      return 'redirect'
    // robots.txt IS the site telling engines not to fetch this, so it is the
    // one fetch state that genuinely belongs with the hidden pages.
    case SiteCrawlFetchStates.robotsBlocked:
      return 'hidden'
    case SiteCrawlFetchStates.html:
      break
    default:
      // Unrecognized persisted values are not crawler states and cannot prove a page's health.
      return 'unchecked'
  }

  // Never infer canonical identity from textual URL presentation (e.g. trailing slashes).
  if (pointsToOtherCanonical(input)) return 'hidden'

  switch (input.indexabilityState) {
    case SiteCrawlIndexabilityStates.indexable:
      return 'eligible'
    case SiteCrawlIndexabilityStates.noindex:
    case SiteCrawlIndexabilityStates.blocked:
      return 'hidden'
    case SiteCrawlIndexabilityStates.unknown:
    default:
      return 'unchecked'
  }
}

/**
 * Share of a scan's fetched pages that must carry the same
 * (target page, anchor text) link before it counts as a nav, header, or footer
 * link rather than an editorial one.
 *
 * This is the FALLBACK rule. `placementLinkDecision` decides every link the
 * page's own landmarks answer for; ubiquity runs only where the DOM is silent,
 * and on scans captured before the crawler recorded placement at all. It is
 * kept because those scans are real and reclassifying them is impossible: a
 * pre-4.7.0 crawl never recorded where a link sat, and inventing a placement
 * for it would be a lie.
 *
 * Measured on three live sites through the crawl API. Links are bimodal: a
 * (target, anchor) pair sits on almost every page or on almost none, and the
 * middle is nearly empty.
 *
 * - 18 pages / 46 pairs: 4 pairs at >=90%, 3 at >=70%, 1 at >=50%, 6 at 20-50%,
 *   32 under 20%.
 * - 37 pages / 68 pairs: 15 pairs at >=90%, then exactly ONE pair anywhere
 *   between 20% and 90%.
 * - 50 pages / 136 pairs: 20 at >=90%, 4 at >=70%, 1 at >=50%, 1 at 20-50%,
 *   110 under 20%.
 *
 * 0.7 sits inside that empty middle on all three, so the exact value is not
 * load bearing. It is defined here once and imported by the publish path, the
 * migration backfill, and the tests.
 */
export const TEMPLATE_LINK_RATIO_THRESHOLD = 0.7

/**
 * Fetched pages a scan needs before ubiquity means anything. On a five-page
 * site every link is on most pages, so the ratio cannot separate a footer from
 * a body link.
 *
 * The floor gates the UBIQUITY rule only. Where a link sits in its page is a
 * fact about that one page, so placement classifies a five-page scan perfectly
 * well; below the floor such a scan reports `applied-placement` (or
 * `applied-placement-partial` when some links sit on pages with no landmarks).
 * A scan with no placement at all and fewer pages than this marks nothing and
 * reports `unavailable-too-few-pages` instead of an empty, confident-looking
 * result.
 */
export const TEMPLATE_LINK_MIN_FETCHED_PAGES = 15

/**
 * Where one link occurrence sat in the page, as the crawler's landmark ruleset
 * saw it. Mirrors `CrawlLinkPlacement` from `@canonry/aeo-audit` (4.7.0+).
 *
 * This is DOM ground truth, not a guess: `navigation` means the occurrence sat
 * inside a nav, header, footer, or aside landmark (or the equivalent ARIA
 * role), `content` means it sat inside a main or article landmark, and
 * `unknown` means the page declares no landmark that answers the question.
 * `unknown` is an absence of evidence and must never be read as either answer.
 */
export const siteCrawlLinkPlacementSchema = z.enum(['navigation', 'content', 'unknown'])
export type SiteCrawlLinkPlacement = z.infer<typeof siteCrawlLinkPlacementSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteCrawlLinkPlacements = siteCrawlLinkPlacementSchema.enum

/**
 * One link's occurrences split by where they sat. A single stored link row
 * aggregates every occurrence of the same (source page, target page) pair, and
 * those occurrences can sit in different parts of the page, so this is counts
 * rather than one verdict: a page linking a target once from its nav and once
 * from its prose yields `{ navigation: 1, content: 1, unknown: 0 }`.
 */
export const siteCrawlPlacementOccurrencesSchema = z.object({
  navigation: z.number().int().nonnegative(),
  content: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
})
export type SiteCrawlPlacementOccurrencesDto = z.infer<typeof siteCrawlPlacementOccurrencesSchema>

/**
 * Which rule decided one link's `isTemplate`.
 *
 * The two rules do not measure the same thing, so a consumer reading a count
 * must be able to tell which one produced it. `placement` is DOM ground truth.
 * `ubiquity` is the inference from how many pages carry the link, which cannot
 * see an editorial link whose anchor text matches the nav's.
 *
 * `unmeasured` is the honest answer for a link NEITHER rule had evidence about:
 * the page declared no landmark AND the scan is below the ubiquity floor, or
 * the edge is a redirect/canonical that has no position in a page at all, or
 * its target was never resolved to a fetched page. Such a link is still a
 * content link, because "not shown to be chrome" is what a content link means
 * here and has always meant here (`isTemplateLinkRatio(null)` is false). What
 * `unmeasured` adds is that no rule proved it, so a consumer can subtract it
 * from a count rather than being told a confident number.
 *
 * This is deliberately an EVIDENCE grade, not a third bucket. Every link is in
 * exactly one of the content and template buckets, on every surface, because a
 * third bucket that only two of six readers understood is precisely how the
 * counts came to disagree.
 */
export const siteHealthLinkClassificationSourceSchema = z.enum([
  'placement',
  'ubiquity',
  'unmeasured',
])
export type SiteHealthLinkClassificationSource = z.infer<typeof siteHealthLinkClassificationSourceSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteHealthLinkClassificationSources = siteHealthLinkClassificationSourceSchema.enum

/**
 * Whether template-link detection ran for a scan, and WHICH rule produced its
 * numbers. Consumers must branch on this: an empty template-link list means
 * "none found" only under one of the `applied*` values.
 *
 * The `applied*` values are ordered by how much of the scan came from DOM
 * ground truth:
 *
 * - `applied` — every link was decided by ubiquity. This is what a scan
 *   captured before the crawler recorded placement reports, and it is the
 *   weaker rule: a link written in prose whose anchor text matches the nav's is
 *   indistinguishable from the nav link itself.
 * - `applied-placement` — every link was decided by where it sits in the page.
 * - `applied-placement-with-ubiquity` — placement decided the links the page's
 *   landmarks answered for, and ubiquity decided the rest. The two rules are
 *   mixed in one reported number, which is exactly why this value exists.
 * - `applied-placement-partial` — placement decided the links the landmarks
 *   answered for, and at least one real page link had no evidence from either
 *   rule, because the scan is below the page floor the fallback needs. Those
 *   links are still counted as content, which is what "not shown to be chrome"
 *   means here; `templateSource` is what marks them `unmeasured` so a consumer
 *   can subtract them.
 *
 * `unavailable-legacy-scan` covers a scan whose links were never classified,
 * which is also the honest answer for a response that resolved no crawl at
 * all. The migration backfills every stored scan, so it survives for rows
 * written after the migration by an older engine image, the same way
 * `SiteCrawlPagesFilterState` does.
 */
export const siteHealthTemplateDetectionSchema = z.enum([
  'applied',
  'applied-placement',
  'applied-placement-with-ubiquity',
  'applied-placement-partial',
  'unavailable-too-few-pages',
  'unavailable-legacy-scan',
])
export type SiteHealthTemplateDetection = z.infer<typeof siteHealthTemplateDetectionSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteHealthTemplateDetections = siteHealthTemplateDetectionSchema.enum

/** Every state detection itself can produce; the last is a read-time fallback. */
export type SiteHealthTemplateDetectionOutcome = Exclude<
  SiteHealthTemplateDetection,
  'unavailable-legacy-scan'
>

/**
 * Whether a scan classified its links at all, so a consumer knows an empty
 * content-only list is a real zero rather than "we could not tell".
 *
 * Exhaustive on purpose: a new detection value is a compile error here until
 * someone decides which side of the line it falls on.
 */
export function isTemplateDetectionApplied(detection: SiteHealthTemplateDetection): boolean {
  switch (detection) {
    case 'applied':
    case 'applied-placement':
    case 'applied-placement-with-ubiquity':
    case 'applied-placement-partial':
      return true
    case 'unavailable-too-few-pages':
    case 'unavailable-legacy-scan':
      return false
  }
}

/**
 * Whether a scan's link classification used DOM placement at all. A consumer
 * comparing two scans needs this to know a count moved because the site
 * changed, not because the rule did.
 */
export function isPlacementTemplateDetection(detection: SiteHealthTemplateDetection): boolean {
  switch (detection) {
    case 'applied-placement':
    case 'applied-placement-with-ubiquity':
    case 'applied-placement-partial':
      return true
    case 'applied':
    case 'unavailable-too-few-pages':
    case 'unavailable-legacy-scan':
      return false
  }
}

/** Which links a link read returns. `content` excludes nav, header, and footer links. */
export const siteHealthLinkKindSchema = z.enum(['all', 'content', 'template'])
export type SiteHealthLinkKind = z.infer<typeof siteHealthLinkKindSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteHealthLinkKinds = siteHealthLinkKindSchema.enum

/**
 * Anchor identity for template detection: case folded, trimmed, and with
 * internal runs of whitespace collapsed, so the same nav item written across
 * two source lines is one anchor. An empty result is a real anchor (a logo or
 * icon link has no text) and is deliberately kept rather than dropped.
 */
export function normalizeTemplateAnchorText(anchor: string): string {
  return anchor.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * How a stored edge came to exist. Mirrors `CrawlEdgeType` from
 * `@canonry/aeo-audit`, plus the historical `link` default that predates the
 * column carrying the crawler's own value.
 *
 * Only `anchor` is a link a person can click on a page, which is the only kind
 * the nav-vs-content question means anything for: a redirect or canonical edge
 * has no position in a page, so it can never carry placement and can never be
 * "a page with no landmarks".
 */
export const siteCrawlEdgeRelationSchema = z.enum(['anchor', 'redirect', 'canonical', 'link'])
export type SiteCrawlEdgeRelation = z.infer<typeof siteCrawlEdgeRelationSchema>
/** Named members so consumers never re-type the literal at a call site. */
export const SiteCrawlEdgeRelations = siteCrawlEdgeRelationSchema.enum

/**
 * Whether the nav-vs-content question is even askable of this edge.
 *
 * Persisted rows stay string-backed for forward compatibility, so this takes a
 * raw string rather than the union and answers false for anything it does not
 * recognize: a future relation is not an anchor link until someone says so.
 */
export function isAnchorLinkRelation(relation: string): boolean {
  return relation === SiteCrawlEdgeRelations.anchor
}

/** One persisted link, reduced to exactly what template detection reads. */
export interface TemplateLinkEdgeInput {
  edgeKey: string
  sourceNodeKey: string
  /** Null when the crawl never resolved the target to a page it observed. */
  targetNodeKey: string | null
  anchors: readonly string[]
  /**
   * Raw stored relation. Only anchor edges can report a page that declares no
   * landmarks, so this is what keeps a redirect from being counted as evidence
   * that the SITE is missing markup.
   */
  relation: string
  /**
   * Null when this scan recorded no placement for this link: a crawl captured
   * before the landmark ruleset existed. Absence is a real state, never zeros.
   */
  placementOccurrences?: SiteCrawlPlacementOccurrencesDto | null
}

/**
 * What a link's DOM placement says about it, or null when placement says
 * nothing at all.
 *
 * The two policies that matter, both approved and both asymmetric on purpose:
 *
 * 1. ANY content occurrence makes the link editorial. One persisted row
 *    aggregates every occurrence between the same two pages, so a target that
 *    is both in the footer and named once in prose is one row. The prose link
 *    genuinely exists, so the connection is editorial however many nav repeats
 *    share the row. This is the whole reason placement beats ubiquity: 53
 *    editorial links added to canonry.ai moved the measured content-link count
 *    by ZERO under the ubiquity rule, because good anchor text reuses the
 *    destination's name and therefore matches the nav's anchor exactly.
 * 2. Navigation plus unknown, with no content, is chrome. `unknown` is silence,
 *    not a counter-claim, so the navigation evidence stands alone.
 *
 * All-unknown (or all-zero, which is what a non-anchor edge carries) returns
 * null: the DOM answered nothing, and the caller owns the fallback.
 */
export function placementLinkDecision(
  occurrences: SiteCrawlPlacementOccurrencesDto | null | undefined,
): Extract<SiteCrawlLinkPlacement, 'navigation' | 'content'> | null {
  if (!occurrences) return null
  if (occurrences.content > 0) return SiteCrawlLinkPlacements.content
  if (occurrences.navigation > 0) return SiteCrawlLinkPlacements.navigation
  return null
}

/**
 * Distinct source pages per (target page, anchor) pair.
 *
 * Kept as an explicit accumulator rather than a one-shot over an edge array so
 * both writers can stream a crawl's links in batches. The accumulator itself is
 * bounded by DISTINCT pairs (low hundreds on real sites) and by pages, never by
 * the million-row link budget.
 */
export interface TemplateLinkPairIndex {
  readonly sourcePagesByPair: Map<string, Set<string>>
}

export function createTemplateLinkPairIndex(): TemplateLinkPairIndex {
  return { sourcePagesByPair: new Map() }
}

/** Unit separator: neither a node key nor normalized anchor text can contain it. */
function templateLinkPairKey(targetNodeKey: string, normalizedAnchor: string): string {
  return `${targetNodeKey}\u001F${normalizedAnchor}`
}

/** Record one batch of links against the index. Safe to call repeatedly. */
export function observeTemplateLinkEdges(
  index: TemplateLinkPairIndex,
  edges: Iterable<TemplateLinkEdgeInput>,
): void {
  for (const edge of edges) {
    if (edge.targetNodeKey == null) continue
    for (const anchor of edge.anchors) {
      const key = templateLinkPairKey(edge.targetNodeKey, normalizeTemplateAnchorText(anchor))
      const sources = index.sourcePagesByPair.get(key)
      if (sources) sources.add(edge.sourceNodeKey)
      else index.sourcePagesByPair.set(key, new Set([edge.sourceNodeKey]))
    }
  }
}

/**
 * Share of fetched pages carrying this link's LEAST ubiquitous anchor, or null
 * when nothing about the link is measurable (an unresolved target, or no
 * anchor at all).
 *
 * The MINIMUM is the whole rule, and it is what makes a link editorial as soon
 * as any one of its anchors is.
 *
 * One persisted link row aggregates EVERY anchor the crawl saw between the
 * same two pages. A site with a comprehensive footer links from nearly every
 * page to nearly every page, so an in-prose link to a footer-linked target
 * lands in the SAME row as that page's footer link. This function used to take
 * the maximum, which handed that row the footer's ubiquity: the editorial link
 * was marked chrome, hidden from the map, and dropped from content counts.
 * Most sites have a comprehensive footer, so most sites had this.
 *
 * Taking the minimum asks the right question. The pair index is keyed by
 * (target, ANCHOR), so a footer link and a body link to the same target are
 * different pairs with different ubiquity. Reading the least ubiquitous one
 * means: does any anchor on this link appear on few enough pages to be
 * editorial? A page carrying only the footer link still has one anchor, still
 * ubiquitous, and stays chrome. The nav mesh does not come back, because a
 * page's edge only becomes editorial when that page really does link the
 * target in its own words.
 *
 * The residual error now runs the safe way. A nav whose anchor text varies by
 * page (a breadcrumb reading "Home" on some pages and "Back to home" on
 * others) splits into low-ubiquity pairs and can read as editorial. That draws
 * a link that exists; the old direction HID links that exist, on a map whose
 * whole purpose is showing editorial structure.
 */
export function templateLinkRatio(
  index: TemplateLinkPairIndex,
  pagesFetched: number,
  edge: TemplateLinkEdgeInput,
): number | null {
  if (edge.targetNodeKey == null || edge.anchors.length === 0) return null
  if (!Number.isFinite(pagesFetched) || pagesFetched <= 0) return null
  let least: number | null = null
  for (const anchor of edge.anchors) {
    const sources = index.sourcePagesByPair.get(
      templateLinkPairKey(edge.targetNodeKey, normalizeTemplateAnchorText(anchor)),
    )
    // Unreachable for a resolved target: every caller builds the index from
    // the same link set it then measures, so each anchor here was observed.
    // Skipping contributes no evidence either way rather than inventing a
    // zero, which would persist as a confident "editorial" for a link nothing
    // was ever recorded about.
    if (!sources) continue
    // A source page outside the fetched count (a redirect node, say) must not
    // push the share above 1.
    const ratio = Math.min(1, sources.size / pagesFetched)
    if (least == null || ratio < least) least = ratio
  }
  // Six decimals so the persisted number is stable across runs of the same
  // crawl rather than carrying float noise into an equality assertion.
  return least == null ? null : Math.round(least * 1_000_000) / 1_000_000
}

/**
 * The single threshold comparison. An unmeasurable link is never a template
 * link.
 *
 * Paired with the minimum in `templateLinkRatio`, this reads as: chrome only
 * when EVERY anchor on the link is ubiquitous. One editorial anchor is enough
 * to make the whole link editorial, which is the direction that shows links
 * rather than hiding them.
 */
export function isTemplateLinkRatio(ratio: number | null): boolean {
  return ratio != null && ratio >= TEMPLATE_LINK_RATIO_THRESHOLD
}

/**
 * Whether the ubiquity rule means anything for a scan of this size. It is a
 * whole-scan property, so it gates the fallback rather than any one link.
 */
export function templateLinkUbiquityAvailable(pagesFetched: number): boolean {
  return Number.isFinite(pagesFetched) && pagesFetched >= TEMPLATE_LINK_MIN_FETCHED_PAGES
}

/**
 * Whether a scan recorded DOM placement at all.
 *
 * Keyed off the crawl summary's landmark ruleset version rather than off the
 * links, because a scan with zero links still has to report which rule it would
 * have used, and because absence has to survive a scan whose every link happens
 * to be `unknown`.
 */
export function templateLinkPlacementAvailable(rulesetVersion: string | null | undefined): boolean {
  return typeof rulesetVersion === 'string' && rulesetVersion.trim().length > 0
}

/**
 * Running evidence tally for one scan's classification.
 *
 * Whole-scan state cannot be decided per link, and BOTH writers (the one-shot
 * classifier and the streaming publish pass) have to reach the same answer over
 * the same links. They therefore share this accumulator rather than each
 * counting for itself, which is what stopped the two from drifting.
 */
export interface TemplateLinkDetectionTally {
  /** At least one link was decided by real ubiquity evidence. */
  usedUbiquityFallback: boolean
  /** At least one ANCHOR link had no evidence from either rule. */
  leftUnmeasuredAnchor: boolean
}

export function createTemplateLinkDetectionTally(): TemplateLinkDetectionTally {
  return { usedUbiquityFallback: false, leftUnmeasuredAnchor: false }
}

/**
 * Fold one link's decision into the scan tally.
 *
 * Both conditions are scoped to real evidence about a real page link, and for
 * the same reason. A redirect or canonical edge carries no anchor and no
 * placement BY CONSTRUCTION, so it reaches neither rule with anything to
 * measure. Counting it as a ubiquity fallback would put nearly every scan in
 * the mixed state; counting it as an unmeasured anchor would tell a customer
 * with perfectly marked-up pages that "some pages mark out no menu or main
 * area". Both would be false, and both would be false on almost every scan,
 * which is worse than saying nothing.
 */
export function observeTemplateLinkDetection(
  tally: TemplateLinkDetectionTally,
  edge: Pick<TemplateLinkEdgeInput, 'relation'>,
  classification: TemplateLinkClassification,
): void {
  if (classification.source === SiteHealthLinkClassificationSources.ubiquity) {
    tally.usedUbiquityFallback = true
  }
  if (
    classification.source === SiteHealthLinkClassificationSources.unmeasured
    && isAnchorLinkRelation(edge.relation)
  ) {
    tally.leftUnmeasuredAnchor = true
  }
}

/** Which rules a scan's classification actually used. */
export function templateLinkDetection(input: {
  placementAvailable: boolean
  ubiquityAvailable: boolean
  tally: TemplateLinkDetectionTally
}): SiteHealthTemplateDetectionOutcome {
  if (!input.placementAvailable) {
    return input.ubiquityAvailable
      ? SiteHealthTemplateDetections.applied
      : SiteHealthTemplateDetections['unavailable-too-few-pages']
  }
  if (input.tally.usedUbiquityFallback) return SiteHealthTemplateDetections['applied-placement-with-ubiquity']
  if (input.tally.leftUnmeasuredAnchor) return SiteHealthTemplateDetections['applied-placement-partial']
  return SiteHealthTemplateDetections['applied-placement']
}

export interface TemplateLinkClassification {
  edgeKey: string
  /**
   * Always a real answer. A link no rule could measure is `false`, because
   * "not shown to be chrome" is what a content link has always meant here, and
   * `source` is what says nothing proved it. There is no third bucket: one
   * existed briefly and only two of six readers understood it, which is exactly
   * how the counts came to disagree.
   */
  isTemplate: boolean
  /**
   * Ubiquity of the link's least ubiquitous anchor. Non-null exactly when
   * `source` is `ubiquity`, by construction: the ratio IS that rule's evidence,
   * so a link it could not measure is not attributed to it.
   */
  templateRatio: number | null
  /** Which rule produced `isTemplate`, or that none could. */
  source: SiteHealthLinkClassificationSource
}

export interface TemplateLinkClassificationResult {
  detection: SiteHealthTemplateDetectionOutcome
  edges: TemplateLinkClassification[]
}

/** Everything one link's decision needs beyond the link itself. */
export interface TemplateLinkClassificationContext {
  index: TemplateLinkPairIndex
  pagesFetched: number
  /**
   * Whether the SCAN recorded placement, from its landmark ruleset version.
   *
   * The scan is the authority, not the row. A row's placement is only read when
   * its scan says placement was recorded, so the reported detection state can
   * never claim one rule while the links were decided by the other.
   */
  placementAvailable: boolean
  /** False below the page floor: the fallback is unavailable, not just unused. */
  ubiquityAvailable: boolean
}

/**
 * Classify ONE link. Placement first, ubiquity only where the DOM is silent.
 *
 * Placement is measured ground truth about the page; ubiquity is an inference
 * from repetition across pages. When both are available they are not weighed
 * against each other, because they are not the same kind of evidence: the DOM
 * wins outright and the ubiquity rule never sees the link.
 */
export function classifyTemplateLinkEdge(
  edge: TemplateLinkEdgeInput,
  context: TemplateLinkClassificationContext,
): TemplateLinkClassification {
  const placement = context.placementAvailable ? placementLinkDecision(edge.placementOccurrences) : null
  if (placement !== null) {
    return {
      edgeKey: edge.edgeKey,
      isTemplate: placement === SiteCrawlLinkPlacements.navigation,
      templateRatio: null,
      source: SiteHealthLinkClassificationSources.placement,
    }
  }
  // The ratio is null for a link the fallback cannot measure at all: an
  // unresolved target, no anchor, or a redirect/canonical edge. Attributing
  // those to `ubiquity` would claim a rule that measured nothing, and would
  // falsify the "ratio present exactly when source is ubiquity" invariant. One
  // grade covers every no-evidence case, including the sub-floor scan where the
  // fallback never ran at all.
  const ratio = context.ubiquityAvailable
    ? templateLinkRatio(context.index, context.pagesFetched, edge)
    : null
  if (ratio == null) {
    return {
      edgeKey: edge.edgeKey,
      isTemplate: false,
      templateRatio: null,
      source: SiteHealthLinkClassificationSources.unmeasured,
    }
  }
  return {
    edgeKey: edge.edgeKey,
    isTemplate: isTemplateLinkRatio(ratio),
    templateRatio: ratio,
    source: SiteHealthLinkClassificationSources.ubiquity,
  }
}

/**
 * One-shot classification over a whole link set. Deterministic: the result is
 * ordered by `edgeKey` and depends on nothing but the input, so the same crawl
 * always classifies the same way.
 *
 * With no placement and below the page floor this marks NOTHING and says why,
 * rather than returning an empty template set that would read as "this site has
 * no nav". Placement has no page floor: where a link sits is a fact about one
 * page, so a five-page scan that recorded landmarks classifies normally.
 */
export function classifyTemplateLinks(input: {
  pagesFetched: number
  /** The crawl summary's landmark ruleset version; null for a pre-4.7.0 crawl. */
  placementRulesetVersion: string | null
  edges: readonly TemplateLinkEdgeInput[]
}): TemplateLinkClassificationResult {
  const ordered = [...input.edges].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
  const placementAvailable = templateLinkPlacementAvailable(input.placementRulesetVersion)
  const ubiquityAvailable = templateLinkUbiquityAvailable(input.pagesFetched)
  // With neither rule in force nothing is measured, so every link comes back
  // `unmeasured` and the scan says `unavailable-too-few-pages`. That falls out
  // of the per-link rule rather than needing its own branch, which is what
  // keeps this classifier and the streaming one from drifting.
  const index = createTemplateLinkPairIndex()
  if (ubiquityAvailable) observeTemplateLinkEdges(index, ordered)
  const context = { index, pagesFetched: input.pagesFetched, placementAvailable, ubiquityAvailable }
  const tally = createTemplateLinkDetectionTally()
  const edges = ordered.map((edge) => {
    const classification = classifyTemplateLinkEdge(edge, context)
    observeTemplateLinkDetection(tally, edge, classification)
    return classification
  })
  return {
    detection: templateLinkDetection({ placementAvailable, ubiquityAvailable, tally }),
    edges,
  }
}

/**
 * Which rule decided one PERSISTED link, read back from the row plus its
 * scan's detection state.
 *
 * Derived rather than stored so there is exactly one place the answer comes
 * from, and so an older row can never disagree with the scan it belongs to.
 *
 * Both inputs are load bearing. The SCAN decides whether placement was ever
 * recorded, so a row cannot claim a rule its scan never ran. The stored RATIO
 * decides whether ubiquity actually measured anything, so an edge the fallback
 * could not measure (an unresolved target, no anchor, a redirect) is reported
 * as `unmeasured` rather than being credited to a rule that produced no number.
 * That is what makes "ratio non-null exactly when source is `ubiquity`" true of
 * persisted rows and not just of freshly computed ones.
 */
export function templateLinkSource(
  detection: SiteHealthTemplateDetection,
  edge: {
    isTemplate: boolean | null
    templateRatio: number | null
    placementOccurrences: SiteCrawlPlacementOccurrencesDto | null
  },
): SiteHealthLinkClassificationSource {
  // A row that was never classified at all (a scan published before any of
  // this) has no rule to name.
  if (edge.isTemplate == null) return SiteHealthLinkClassificationSources.unmeasured
  if (
    isPlacementTemplateDetection(detection)
    && placementLinkDecision(edge.placementOccurrences) != null
  ) {
    return SiteHealthLinkClassificationSources.placement
  }
  return edge.templateRatio != null
    ? SiteHealthLinkClassificationSources.ubiquity
    : SiteHealthLinkClassificationSources.unmeasured
}

export const siteCrawlPageSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  path: z.string(),
  parentPath: z.string(),
  discoverySource: z.string(),
  fetchState: z.string(),
  httpStatus: z.number().int().nullable(),
  canonicalUrl: z.string().nullable(),
  indexabilityState: z.string(),
  indexabilityReasons: z.array(z.string()).default([]),
  auditState: z.string(),
  auditScore: z.number().nullable(),
  inventoryEligible: z.boolean(),
  depth: z.number().int().nullable(),
  inboundUniqueEdges: z.number().int().nonnegative(),
  outboundUniqueEdges: z.number().int().nonnegative(),
  inboundOccurrences: z.number().int().nonnegative(),
  outboundOccurrences: z.number().int().nonnegative(),
  linkScoreRaw: z.number().nullable(),
  linkScoreNormalized: z.number().nullable(),
  healthState: siteHealthStateSchema,
})
export type SiteCrawlPageDto = z.infer<typeof siteCrawlPageSchema>

/** One stable, page-scoped finding emitted by the audit engine. */
export const siteCrawlAuditFindingSchema = z.object({
  type: z.enum(['found', 'missing', 'info', 'timeout', 'unreachable']),
  /** Stable machine code; UI and agents must not key behavior off `message`. */
  code: z.string().min(1),
  message: z.string().min(1),
})
export type SiteCrawlAuditFindingDto = z.infer<typeof siteCrawlAuditFindingSchema>

/**
 * One factor that contributes to a page's aggregate audit score, with the
 * exact evidence and remediation emitted for that page in the selected run.
 */
export const siteCrawlAuditFactorSchema = siteAuditPageFactorSchema.extend({
  status: siteAuditFactorStatusSchema,
  /** `null` means the engine did not explicitly classify applicability. */
  applicable: z.boolean().nullable(),
  findings: z.array(siteCrawlAuditFindingSchema).default([]),
  recommendations: z.array(z.string()).default([]),
})
export type SiteCrawlAuditFactorDto = z.infer<typeof siteCrawlAuditFactorSchema>

/** High-impact page defect detected independently of the weighted score. */
export const siteCrawlCriticalDefectSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['critical', 'warning']),
  detail: z.string().min(1),
  recommendation: z.string().min(1),
})
export type SiteCrawlCriticalDefectDto = z.infer<typeof siteCrawlCriticalDefectSchema>

/**
 * One-page audit evidence read. This stays separate from the 20k-node graph
 * projection so selecting a node can load evidence without inflating every
 * graph node with finding prose.
 */
const siteCrawlPageAuditProvenanceSchema = z.object({
  project: z.string(),
  runId: z.string(),
  complete: z.boolean(),
  termination: z.string().nullable(),
})
const siteCrawlPageAuditIdentitySchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  auditState: z.string(),
})

export const siteCrawlPageAuditSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('no-crawl'),
    project: z.string(),
    runId: z.null(),
  }),
  siteCrawlPageAuditProvenanceSchema.extend({ state: z.literal('details-unavailable') }),
  siteCrawlPageAuditProvenanceSchema.extend({ state: z.literal('not-found') }),
  siteCrawlPageAuditProvenanceSchema.merge(siteCrawlPageAuditIdentitySchema).extend({
    state: z.literal('not-audited'),
    auditScore: z.null(),
    factors: z.array(siteCrawlAuditFactorSchema).length(0).default([]),
    criticalDefects: z.array(siteCrawlCriticalDefectSchema).length(0).default([]),
  }),
  siteCrawlPageAuditProvenanceSchema.merge(siteCrawlPageAuditIdentitySchema).extend({
    state: z.literal('ready'),
    auditScore: z.number(),
    /** Old crawl rows retain factor scores but did not persist evidence prose. */
    evidenceState: z.enum(['complete', 'scores-only']),
    factors: z.array(siteCrawlAuditFactorSchema).default([]),
    criticalDefects: z.array(siteCrawlCriticalDefectSchema).default([]),
  }),
])
export type SiteCrawlPageAuditDto = z.infer<typeof siteCrawlPageAuditSchema>

/**
 * Whether a requested `healthState` filter actually ran.
 *
 * Site Health state is persisted at publish time and backfilled for existing
 * scans, so `applied` is the normal answer. `unavailable-legacy-scan` remains
 * for the one case a backfill cannot reach: a page written AFTER the migration
 * by an older engine image that does not know the column. Tenants keep their
 * provision-time image, so that is a real state, and saying so beats letting an
 * empty list read as "no hidden pages".
 */
export const siteCrawlPagesFilterStateSchema = z.enum(['applied', 'unavailable-legacy-scan'])
export type SiteCrawlPagesFilterState = z.infer<typeof siteCrawlPagesFilterStateSchema>

export const siteCrawlPagesResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  /** Null when no `healthState` filter was requested. */
  healthStateFilter: z.union([siteCrawlPagesFilterStateSchema, z.null()]).default(null),
  pages: z.array(siteCrawlPageSchema).default([]),
})
export type SiteCrawlPagesResponseDto = z.infer<typeof siteCrawlPagesResponseSchema>

export const siteCrawlStructureChildSchema = z.object({
  path: z.string(),
  /** URL of the exact folder landing page, null for a synthetic hierarchy node. */
  url: z.string().nullable(),
  hasPage: z.boolean(),
  pageCount: z.number().int().positive(),
  inventoryEligibleCount: z.number().int().nonnegative(),
  fetchedCount: z.number().int().nonnegative(),
})
export type SiteCrawlStructureChildDto = z.infer<typeof siteCrawlStructureChildSchema>

export const siteCrawlStructureResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  parentPath: z.string(),
  nextCursor: z.string().nullable(),
  children: z.array(siteCrawlStructureChildSchema).default([]),
})
export type SiteCrawlStructureResponseDto = z.infer<typeof siteCrawlStructureResponseSchema>

export const siteCrawlEdgeSchema = z.object({
  edgeKey: z.string(),
  sourceNodeKey: z.string(),
  sourceUrl: z.string(),
  targetNodeKey: z.string().nullable(),
  targetUrl: z.string(),
  relation: z.string(),
  internal: z.boolean(),
  followable: z.boolean(),
  occurrences: z.number().int().positive(),
  followableOccurrences: z.number().int().nonnegative(),
  nofollowOccurrences: z.number().int().nonnegative(),
  anchors: z.array(z.string()).default([]),
  /**
   * True when this link is nav, header, or footer chrome. Null means this link
   * was never classified, which `templateSource` and the response's
   * `templateDetection` explain; it never means "not a nav link".
   */
  isTemplate: z.union([z.boolean(), z.null()]),
  /**
   * Share of fetched pages carrying this link's LEAST ubiquitous anchor: the
   * most editorial thing anyone says when linking these two pages. At or above
   * the threshold means every anchor on the link is chrome. Present exactly
   * when `templateSource` is `ubiquity`, because it is that rule's evidence.
   */
  templateRatio: z.union([z.number(), z.null()]),
  /**
   * Which rule decided `isTemplate`. Read this before comparing counts across
   * scans: `placement` and `ubiquity` do not measure the same thing.
   */
  templateSource: siteHealthLinkClassificationSourceSchema,
  /**
   * Where this link's occurrences sat in the page. Null when the scan predates
   * the crawler's landmark ruleset, which is why the ubiquity fallback still
   * exists.
   */
  placementOccurrences: z.union([siteCrawlPlacementOccurrencesSchema, z.null()]),
})
export type SiteCrawlEdgeDto = z.infer<typeof siteCrawlEdgeSchema>

export const siteCrawlGraphNodeSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  path: z.string(),
  depth: z.number().int().nonnegative().nullable(),
  indexabilityState: z.string(),
  fetchState: z.string(),
  auditState: z.string(),
  auditScore: z.number().nullable(),
  inventoryEligible: z.boolean(),
  inboundUniqueEdges: z.number().int().nonnegative(),
  outboundUniqueEdges: z.number().int().nonnegative(),
  linkScoreNormalized: z.number().nullable(),
  healthState: siteHealthStateSchema,
  /** Publish-time ForceAtlas2 coordinate. Reads never run layout physics. */
  x: z.number(),
  /** Publish-time ForceAtlas2 coordinate. Reads never run layout physics. */
  y: z.number(),
})
export type SiteCrawlGraphNodeDto = z.infer<typeof siteCrawlGraphNodeSchema>

export const siteCrawlGraphEdgeSchema = z.object({
  edgeKey: z.string(),
  sourceNodeKey: z.string(),
  targetNodeKey: z.string(),
  followable: z.boolean(),
  occurrences: z.number().int().positive(),
  /**
   * True for a nav, header, or footer link. Template links are published in
   * the sample so a viewer can switch them on without a refetch, but they were
   * excluded from the layout, so switching them on must never move a node.
   */
  isTemplate: z.boolean(),
})
export type SiteCrawlGraphEdgeDto = z.infer<typeof siteCrawlGraphEdgeSchema>

/**
 * Why a scan has no usable map. Consumers key copy off these exact values, so
 * the set is closed and named rather than inlined at the one use site.
 */
export const siteCrawlGraphLayoutUnavailableReasonSchema = z.enum([
  'no-crawl',
  'legacy-snapshot',
  'details-unavailable',
  'layout-failed',
  'empty-crawl',
])
export type SiteCrawlGraphLayoutUnavailableReason = z.infer<typeof siteCrawlGraphLayoutUnavailableReasonSchema>

export const siteCrawlGraphLayoutSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    version: z.string().min(1),
    computedAt: z.string().min(1),
    /**
     * True when nav, header, and footer links were kept out of the physics, so
     * positions describe content structure. False for a scan published before
     * template detection: its links are classified by the migration backfill
     * and can still be filtered, but its node positions were computed with the
     * nav mesh included. Re-running the scan is what updates them.
     */
    templateLinksExcluded: z.boolean(),
  }),
  z.object({
    state: z.literal('unavailable'),
    version: z.null(),
    reason: siteCrawlGraphLayoutUnavailableReasonSchema,
  }),
])
export type SiteCrawlGraphLayoutDto = z.infer<typeof siteCrawlGraphLayoutSchema>

/**
 * A persisted, deterministic graph projection for an interactive Site Health
 * map. `total*` reflects graph-compatible persisted crawl rows; `omitted*`
 * explains what the publish/read caps intentionally leave out. Layout state is
 * explicit because snapshots written before layout support remain valid.
 */
export const siteCrawlGraphResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  /**
   * Server-owned identity of the crawl root, resolved from the snapshot root
   * URL (or the depth-0 page). Consumers must not infer the home page from a
   * path or a link score. It is null when the crawl persisted no page detail,
   * and it can name a page that graph sampling left out of `nodes`.
   */
  rootNodeKey: z.string().nullable(),
  layout: siteCrawlGraphLayoutSchema,
  /** Whether nav and footer links could be told apart for this scan. */
  templateDetection: siteHealthTemplateDetectionSchema,
  /** Echo of the requested `linkKind`, so a caller knows what `edges` holds. */
  linkKind: siteHealthLinkKindSchema,
  /** Total canonical pages in the persisted crawl before graph sampling. */
  totalNodes: z.number().int().nonnegative(),
  /**
   * Total graph-compatible internal anchor edges before graph sampling. This
   * keeps counting EVERY link, whatever `linkKind` was requested, so the
   * content and template counts below split a number that never moved.
   */
  totalEdges: z.number().int().nonnegative(),
  /** Share of `totalEdges` classified as nav, header, or footer links. */
  totalTemplateEdges: z.number().int().nonnegative(),
  /** `totalEdges - totalTemplateEdges`. Equals `totalEdges` when detection is unavailable. */
  totalContentEdges: z.number().int().nonnegative(),
  nodes: z.array(siteCrawlGraphNodeSchema).default([]),
  edges: z.array(siteCrawlGraphEdgeSchema).default([]),
  omittedNodes: z.number().int().nonnegative(),
  omittedEdges: z.number().int().nonnegative(),
  /** True when publish/read caps or a layout failure omit graph rows. */
  sampled: z.boolean(),
})
export type SiteCrawlGraphResponseDto = z.infer<typeof siteCrawlGraphResponseSchema>

/** Site Health publish/read caps. They deliberately do not change crawl budgets. */
export const SITE_CRAWL_GRAPH_DEFAULT_MAX_NODES = 20_000
export const SITE_CRAWL_GRAPH_MAX_NODES = 20_000
export const SITE_CRAWL_GRAPH_DEFAULT_MAX_EDGES = 50_000
export const SITE_CRAWL_GRAPH_MAX_EDGES = 50_000

export const siteHealthSubgraphRelationSchema = z.enum([
  'focus',
  'inbound',
  'outbound',
  'both',
  'transitive',
])
export type SiteHealthSubgraphRelation = z.infer<typeof siteHealthSubgraphRelationSchema>

export const siteHealthSubgraphNodeSchema = siteCrawlPageSchema.extend({
  distance: z.number().int().nonnegative(),
  relationToFocus: siteHealthSubgraphRelationSchema,
})
export type SiteHealthSubgraphNodeDto = z.infer<typeof siteHealthSubgraphNodeSchema>

/** Compact canonical graph neighborhood for agents; never includes layout coordinates. */
export const siteHealthSubgraphResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  /** Selected snapshot provenance. Historical partial crawls stay explicit. */
  complete: z.boolean(),
  termination: z.string().nullable(),
  state: z.enum(['no-crawl', 'details-unavailable', 'ready']),
  focusNodeKey: z.string().nullable(),
  focusUrl: z.string().nullable(),
  hops: z.number().int().min(0).max(3),
  totalNodes: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
  nodes: z.array(siteHealthSubgraphNodeSchema).default([]),
  edges: z.array(siteCrawlEdgeSchema).default([]),
  omittedNodes: z.number().int().nonnegative(),
  omittedEdges: z.number().int().nonnegative(),
  /** `lower-bound` means totals and omissions are minimums because traversal hit a cap. */
  countAccuracy: z.enum(['exact', 'lower-bound']),
  truncated: z.boolean(),
})
export type SiteHealthSubgraphResponseDto = z.infer<typeof siteHealthSubgraphResponseSchema>

export const SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_NODES = 25
export const SITE_HEALTH_SUBGRAPH_MAX_NODES = 200
export const SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_EDGES = 50
export const SITE_HEALTH_SUBGRAPH_MAX_EDGES = 500

export const siteHealthNodeReferenceSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  path: z.string(),
})
export type SiteHealthNodeReferenceDto = z.infer<typeof siteHealthNodeReferenceSchema>

/** Directed, followable shortest path over canonical internal-link observations. */
export const siteHealthPathResponseSchema = z.object({
  project: z.string(),
  runId: z.string().nullable(),
  /** Selected snapshot provenance. `unreachable` on a partial crawl is not a site-wide claim. */
  complete: z.boolean(),
  termination: z.string().nullable(),
  state: z.enum(['no-crawl', 'details-unavailable', 'found', 'unreachable', 'truncated']),
  from: siteHealthNodeReferenceSchema.nullable(),
  to: siteHealthNodeReferenceSchema.nullable(),
  maxDepth: z.number().int().positive(),
  visitedNodes: z.number().int().nonnegative(),
  nodes: z.array(siteCrawlPageSchema).default([]),
  edges: z.array(siteCrawlEdgeSchema).default([]),
})
export type SiteHealthPathResponseDto = z.infer<typeof siteHealthPathResponseSchema>

export const SITE_HEALTH_PATH_DEFAULT_MAX_DEPTH = 12
export const SITE_HEALTH_PATH_MAX_DEPTH = 24
export const SITE_HEALTH_PATH_MAX_VISITED_NODES = 5_000

export const siteHealthChangeKindSchema = z.enum(['added', 'removed', 'changed'])
export type SiteHealthChangeKind = z.infer<typeof siteHealthChangeKindSchema>

export const siteHealthPageChangeSchema = z.object({
  entity: z.literal('page'),
  change: siteHealthChangeKindSchema,
  key: z.string(),
  changedFields: z.array(z.string()).default([]),
  before: siteCrawlPageSchema.nullable(),
  after: siteCrawlPageSchema.nullable(),
})
export type SiteHealthPageChangeDto = z.infer<typeof siteHealthPageChangeSchema>

export const siteHealthLinkChangeSchema = z.object({
  entity: z.literal('link'),
  change: siteHealthChangeKindSchema,
  key: z.string(),
  changedFields: z.array(z.string()).default([]),
  before: siteCrawlEdgeSchema.nullable(),
  after: siteCrawlEdgeSchema.nullable(),
})
export type SiteHealthLinkChangeDto = z.infer<typeof siteHealthLinkChangeSchema>

export const siteHealthChangeRecordSchema = z.discriminatedUnion('entity', [
  siteHealthPageChangeSchema,
  siteHealthLinkChangeSchema,
])
export type SiteHealthChangeRecordDto = z.infer<typeof siteHealthChangeRecordSchema>

const siteHealthChangeCountsSchema = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
})

export const siteHealthChangesFiltersSchema = z.object({
  scope: z.enum(['all', 'pages', 'links']),
  change: z.enum(['all', 'added', 'removed', 'changed']),
})
export type SiteHealthChangesFilters = z.infer<typeof siteHealthChangesFiltersSchema>

export const siteHealthChangesResponseSchema = z.discriminatedUnion('state', [
  z.object({
    project: z.string(),
    state: z.literal('unavailable'),
    reason: z.enum(['no-crawl', 'insufficient-history', 'details-unavailable', 'partial-not-comparable']),
    fromRunId: z.string().nullable(),
    toRunId: z.string().nullable(),
  }),
  z.object({
    project: z.string(),
    state: z.literal('incompatible'),
    reason: z.literal('incompatible-versions'),
    fromRunId: z.string(),
    toRunId: z.string(),
    mismatchedVersions: z.array(z.string()).min(1),
  }),
  z.object({
    project: z.string(),
    state: z.literal('ready'),
    fromRunId: z.string(),
    toRunId: z.string(),
    versions: z.object({
      crawlSchema: z.string(),
      normalization: z.string(),
      indexability: z.string(),
      linkScore: z.string(),
    }),
    /** The filters whose post-filter counts and records this page represents. */
    filters: siteHealthChangesFiltersSchema,
    /** Continuations omit summary work; reuse the exact summary from the first page. */
    summaryState: z.enum(['exact', 'omitted-on-continuation']),
    summary: z.object({
      pages: siteHealthChangeCountsSchema,
      links: siteHealthChangeCountsSchema,
    }).nullable(),
    total: z.number().int().nonnegative().nullable(),
    nextCursor: z.string().nullable(),
    changes: z.array(siteHealthChangeRecordSchema).default([]),
  }),
])
export type SiteHealthChangesResponseDto = z.infer<typeof siteHealthChangesResponseSchema>

export const SITE_HEALTH_CHANGES_DEFAULT_LIMIT = 25
export const SITE_HEALTH_CHANGES_MAX_LIMIT = 100

export const siteCrawlInternalLinksResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  /** Total links matching every requested filter, `linkKind` included. */
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  /** Whether nav and footer links could be told apart for this scan. */
  templateDetection: siteHealthTemplateDetectionSchema,
  /** Echo of the requested `linkKind`, so a caller knows what `total` counts. */
  linkKind: siteHealthLinkKindSchema,
  edges: z.array(siteCrawlEdgeSchema).default([]),
})
export type SiteCrawlInternalLinksResponseDto = z.infer<typeof siteCrawlInternalLinksResponseSchema>

export const siteCrawlNeighborsResponseSchema = z.object({
  project: z.string(),
  hasCrawlData: z.boolean(),
  runId: z.string().nullable(),
  nodeKey: z.string().nullable(),
  url: z.string().nullable(),
  /** Whether nav and footer links could be told apart for this scan. */
  templateDetection: siteHealthTemplateDetectionSchema,
  /** Echo of the requested `linkKind`, so a caller knows what the lists hold. */
  linkKind: siteHealthLinkKindSchema,
  inbound: z.array(siteCrawlEdgeSchema).default([]),
  outbound: z.array(siteCrawlEdgeSchema).default([]),
  inboundTruncated: z.boolean(),
  outboundTruncated: z.boolean(),
})
export type SiteCrawlNeighborsResponseDto = z.infer<typeof siteCrawlNeighborsResponseSchema>

export const siteCrawlDeadLinkSchema = z.object({
  findingKey: z.string(),
  severity: z.string(),
  sourceNodeKey: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  targetNodeKey: z.string().nullable(),
  targetUrl: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()).default({}),
})
export type SiteCrawlDeadLinkDto = z.infer<typeof siteCrawlDeadLinkSchema>

/**
 * Dead-link checks are opt-in; disabled and unavailable never masquerade as an
 * empty list. Every row in `deadLinks` carries a 4xx/5xx status code, because
 * that status is the only evidence a link is broken. Targets the crawler could
 * not fetch are counted in `unverified` and are deliberately NOT listed here —
 * every consumer of this array renders a row as a broken link, and a crawl
 * timeout is not evidence of one.
 */
export const siteCrawlDeadLinksResponseSchema = z.discriminatedUnion('state', [
  z.object({ project: z.string(), runId: z.string().nullable(), state: z.literal('unavailable'), legacyAuditAvailable: z.boolean() }),
  z.object({ project: z.string(), runId: z.string(), state: z.literal('disabled'), checkDeadLinks: z.literal(false) }),
  z.object({
    project: z.string(), runId: z.string(), state: z.literal('complete'), checkDeadLinks: z.literal(true),
    checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), unverified: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(), deadLinks: z.array(siteCrawlDeadLinkSchema).default([]),
  }),
  z.object({
    project: z.string(), runId: z.string(), state: z.literal('partial'), checkDeadLinks: z.literal(true),
    checked: z.number().int().nonnegative(), found: z.number().int().nonnegative(), unverified: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(), deadLinks: z.array(siteCrawlDeadLinkSchema).default([]),
  }),
])
export type SiteCrawlDeadLinksResponseDto = z.infer<typeof siteCrawlDeadLinksResponseSchema>

/** Canonry-local crawl defaults. These are part of request identity. */
export const SITE_AUDIT_DEFAULT_PAGE_LIMIT = 1_000
export const SITE_AUDIT_MAX_PAGE_LIMIT = 50_000
/**
 * There is deliberately no default edge limit. The crawl engine derives the
 * edge budget from the resolved page count, and any flat default applied here
 * would cap below that derivation on a large site, silently ending page
 * admission long before the page budget is spent.
 */
export const SITE_AUDIT_MAX_EDGE_LIMIT = 1_000_000

/** Body for `POST /projects/:name/technical-aeo/runs`. */
export const siteAuditRunRequestSchema = z.object({
  /** @deprecated Prefer the configured project sitemap; retained for compatibility. */
  sitemapUrl: z.string().url().optional(),
  /** @deprecated Prefer `maxPages`; retained for compatibility. */
  limit: z.number().int().positive().max(2000).optional(),
  /** Crawl page budget. When omitted, Canonry crawls up to 1,000 pages. */
  maxPages: z.number().int().positive().max(50_000).optional(),
  /** Internal-link observation budget. When omitted, the crawl engine derives it from the page count. */
  maxEdges: z.number().int().positive().max(1_000_000).optional(),
  /** Maximum crawl depth from the root. */
  maxDepth: z.number().int().min(0).max(100).optional(),
  /** Off by default; derives findings only from observed internal targets. External links are never probed. */
  checkDeadLinks: z.boolean().default(false),
})
export type SiteAuditRunRequest = z.infer<typeof siteAuditRunRequestSchema>

/**
 * Canonical production semantics for one requested crawl. The route persists
 * this before work starts so only requests with the same output identity can
 * consolidate onto an in-flight run. `limit` and `maxPages` intentionally
 * collapse to one field because `limit` is only a compatibility alias.
 *
 * `maxEdges` is nullable on purpose: `null` means the operator chose no edge
 * budget and the engine derives one, which is a DIFFERENT crawl from any
 * explicit number — including the number that used to be substituted here.
 *
 * schemaVersion 2 supersedes 1, where an omitted `maxEdges` was persisted as
 * the literal 100000 and could not be told apart from an explicit 100000.
 * A version-1 row is therefore never identity-equal to a version-2 request.
 */
export interface SiteAuditEffectiveRequest {
  schemaVersion: 2
  sitemapUrl: string | null
  maxPages: number
  /** `null` = unset; the crawl engine derives the budget from the page count. */
  maxEdges: number | null
  maxDepth: number | null
  checkDeadLinks: boolean
}

export function normalizeSiteAuditRunRequest(request: Partial<SiteAuditRunRequest>): SiteAuditEffectiveRequest {
  return {
    schemaVersion: 2,
    sitemapUrl: request.sitemapUrl ? new URL(request.sitemapUrl).toString() : null,
    maxPages: request.maxPages ?? request.limit ?? SITE_AUDIT_DEFAULT_PAGE_LIMIT,
    maxEdges: request.maxEdges ?? null,
    maxDepth: request.maxDepth ?? null,
    checkDeadLinks: request.checkDeadLinks === true,
  }
}

/**
 * Stable, versioned identity key for exact in-flight request comparison.
 * Positional, so an unset `maxEdges` serializes as `null` and matches another
 * unset request while staying distinct from every explicit number.
 */
export function siteAuditRequestIdentity(request: SiteAuditEffectiveRequest): string {
  return JSON.stringify([
    request.schemaVersion,
    request.sitemapUrl,
    request.maxPages,
    request.maxEdges,
    request.maxDepth,
    request.checkDeadLinks,
  ])
}

export const siteAuditRunResponseSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
})
export type SiteAuditRunResponseDto = z.infer<typeof siteAuditRunResponseSchema>

/**
 * One entry in the Site Health scan history. `hasCrawlData` separates a scan
 * that published a page and internal-link graph from a legacy score-only scan
 * that predates crawl persistence: both are real, selectable history, but only
 * the first can open the map, inventory, or structure views.
 */
export const siteHealthScanSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  hasCrawlData: z.boolean(),
})
export type SiteHealthScanDto = z.infer<typeof siteHealthScanSchema>

/** Non-probe site-audit runs for one project, newest first. */
export const siteHealthScansResponseSchema = z.object({
  project: z.string(),
  scans: z.array(siteHealthScanSchema).default([]),
})
export type SiteHealthScansResponseDto = z.infer<typeof siteHealthScansResponseSchema>

export const SITE_HEALTH_SCANS_DEFAULT_LIMIT = 20
export const SITE_HEALTH_SCANS_MAX_LIMIT = 100

/** Stable lifecycle stage for one exact stored Site Health crawl. */
export const siteAuditRunPhaseSchema = z.enum([
  'queued',
  'discovering',
  'checking',
  'arranging-map',
  'completed',
  'partial',
  'failed',
  'cancelled',
])
export type SiteAuditRunPhase = z.infer<typeof siteAuditRunPhaseSchema>

/** The graph layout is a separately persisted terminal artifact. */
export const siteAuditRunLayoutSchema = z.object({
  state: z.enum(['pending', 'ready', 'unavailable']),
  layoutVersion: z.string().nullable(),
  failureCode: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type SiteAuditRunLayoutDto = z.infer<typeof siteAuditRunLayoutSchema>

/** Mutable counters from the latest durable crawl attempt. Never a percentage. */
export const siteAuditRunAttemptProgressSchema = z.object({
  id: z.string(),
  state: z.string(),
  pagesDiscovered: z.number().int().nonnegative(),
  pagesFetched: z.number().int().nonnegative(),
  pagesEligible: z.number().int().nonnegative(),
  pagesErrored: z.number().int().nonnegative(),
  edgesDiscovered: z.number().int().nonnegative(),
  lastUpdatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
})
export type SiteAuditRunAttemptProgressDto = z.infer<typeof siteAuditRunAttemptProgressSchema>

/**
 * Exact stored progress for one non-probe `site-audit` run. This route never
 * starts or polls external work; it exposes only durable run, attempt, and
 * layout state so an onboarding surface can resume truthfully after reload.
 */
export const siteAuditRunProgressSchema = z.object({
  project: z.string(),
  runId: z.string(),
  status: runStatusSchema,
  phase: siteAuditRunPhaseSchema,
  attempt: siteAuditRunAttemptProgressSchema.nullable(),
  layout: siteAuditRunLayoutSchema,
  error: z.string().nullable(),
})
export type SiteAuditRunProgressDto = z.infer<typeof siteAuditRunProgressSchema>

/** Exact lifecycle state for a bounded, in-progress Page Health preview. */
export const siteAuditLivePageHealthStateSchema = z.enum(['waiting', 'collecting', 'terminal'])
export type SiteAuditLivePageHealthState = z.infer<typeof siteAuditLivePageHealthStateSchema>

/** One low-score page selected from the active crawl attempt without finding prose. */
export const siteAuditLivePageHealthExampleSchema = z.object({
  nodeKey: z.string(),
  url: z.string(),
  auditScore: z.number(),
  checksNeedingAttention: z.number().int().nonnegative(),
})
export type SiteAuditLivePageHealthExampleDto = z.infer<typeof siteAuditLivePageHealthExampleSchema>

/**
 * A small, durable preview for an exact active site-audit run. It is never a
 * final scorecard: terminal runs deliberately omit examples so callers switch
 * to the immutable Page Health results once the crawl has published.
 */
export const siteAuditLivePageHealthSchema = z.object({
  project: z.string(),
  runId: z.string(),
  status: runStatusSchema,
  state: siteAuditLivePageHealthStateSchema,
  attemptId: z.string().nullable(),
  pagesAudited: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  examples: z.array(siteAuditLivePageHealthExampleSchema).max(12).default([]),
})
export type SiteAuditLivePageHealthDto = z.infer<typeof siteAuditLivePageHealthSchema>

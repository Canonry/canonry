import crypto from 'node:crypto'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { FastifyInstance } from 'fastify'
import {
  runs,
  projects,
  siteAuditPages,
  siteAuditSnapshots,
  siteCrawlEdges,
  siteCrawlAttempts,
  siteCrawlFindings,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlRunRequests,
  siteCrawlSnapshots,
} from '@ainyc/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  deriveSiteHealthState,
  siteHealthStateSchema,
  factorStatusFromScore,
  SiteAuditTrendDirections,
  SiteCrawlFetchedStates,
  normalizeSiteAuditRunRequest,
  missingDependency,
  notFound,
  operationInProgress,
  siteAuditPageFactorSchema,
  siteAuditRequestIdentity,
  siteAuditRunRequestSchema,
  siteCrawlAuditFactorSchema,
  siteCrawlCriticalDefectSchema,
  siteHealthLinkKindSchema,
  siteHealthTemplateDetectionSchema,
  SiteHealthLinkKinds,
  SiteHealthTemplateDetections,
  templateLinkSource,
  validationError,
  type RunStatus,
  type SiteAuditPageDto,
  type SiteAuditLivePageHealthDto,
  type SiteAuditPagesResponseDto,
  type SiteAuditRunPhase,
  type SiteAuditRunProgressDto,
  type SiteAuditScoreDto,
  type SiteAuditTrendResponseDto,
  type SiteCrawlDeadLinksResponseDto,
  type SiteCrawlEdgeDto,
  type SiteCrawlGraphResponseDto,
  type SiteCrawlInternalLinksResponseDto,
  type SiteCrawlNeighborsResponseDto,
  type SiteCrawlPageDto,
  type SiteCrawlPageAuditDto,
  type SiteCrawlPagesFilterState,
  type SiteCrawlPagesResponseDto,
  type SiteCrawlPlacementOccurrencesDto,
  type SiteCrawlStructureResponseDto,
  type SiteCrawlSummaryDto,
  type SiteHealthChangeRecordDto,
  type SiteHealthChangesResponseDto,
  type SiteHealthLinkKind,
  type SiteHealthPathResponseDto,
  type SiteHealthState,
  type SiteHealthTemplateDetection,
  type SiteHealthScansResponseDto,
  type SiteHealthSubgraphRelation,
  type SiteHealthSubgraphResponseDto,
  SITE_CRAWL_GRAPH_DEFAULT_MAX_EDGES,
  SITE_CRAWL_GRAPH_DEFAULT_MAX_NODES,
  SITE_CRAWL_GRAPH_MAX_EDGES,
  SITE_CRAWL_GRAPH_MAX_NODES,
  SITE_HEALTH_CHANGES_DEFAULT_LIMIT,
  SITE_HEALTH_CHANGES_MAX_LIMIT,
  SITE_HEALTH_PATH_DEFAULT_MAX_DEPTH,
  SITE_HEALTH_PATH_MAX_DEPTH,
  SITE_HEALTH_PATH_MAX_VISITED_NODES,
  SITE_HEALTH_SCANS_DEFAULT_LIMIT,
  SITE_HEALTH_SCANS_MAX_LIMIT,
  SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_EDGES,
  SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_NODES,
  SITE_HEALTH_SUBGRAPH_MAX_EDGES,
  SITE_HEALTH_SUBGRAPH_MAX_NODES,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

const FETCHED_SITE_CRAWL_STATES: ReadonlySet<string> = new Set([
  ...SiteCrawlFetchedStates,
  // Snapshots published before the full-crawl contract used this aggregate
  // state. Keep historical structure counts truthful without admitting it to
  // the current crawler vocabulary.
  'fetched',
])

export interface TechnicalAeoRoutesOptions {
  /**
   * Fired after a `site-audit` run row is created. Wire this in the host server
   * to `executeSiteAudit(...).then(() => runCoordinator.onRunCompleted(...))`.
   */
  onSiteAuditRequested?: (runId: string, projectId: string, opts?: {
    sitemapUrl?: string
    /** @deprecated Compatibility alias for maxPages. */
    limit?: number
    maxPages?: number
    maxEdges?: number
    maxDepth?: number
    checkDeadLinks?: boolean
  }) => void
}

/** Run statuses that count as a real, surfaceable site audit. */
const SURFACEABLE_STATUSES = [RunStatuses.completed, RunStatuses.partial]

function siteAuditRunPhase(
  status: RunStatus,
  attempt: typeof siteCrawlAttempts.$inferSelect | undefined,
  layoutState: 'pending' | 'ready' | 'unavailable',
): SiteAuditRunPhase {
  switch (status) {
    case RunStatuses.queued:
      return 'queued'
    case RunStatuses.running:
      return (attempt?.pagesFetched ?? 0) > 0 ? 'checking' : 'discovering'
    case RunStatuses.completed:
      return attempt && layoutState === 'pending' ? 'arranging-map' : 'completed'
    case RunStatuses.partial:
      return attempt && layoutState === 'pending' ? 'arranging-map' : 'partial'
    case RunStatuses.failed:
      return 'failed'
    case RunStatuses.cancelled:
      return 'cancelled'
  }
}

function emptyScore(projectName: string): SiteAuditScoreDto {
  return {
    project: projectName,
    hasData: false,
    runId: null,
    runStatus: null,
    sitemapUrl: null,
    auditedAt: null,
    aggregateScore: 0,
    pagesDiscovered: 0,
    pagesAudited: 0,
    pagesSkipped: 0,
    pagesErrored: 0,
    deltaScore: null,
    trend: null,
    previousScore: null,
    previousAuditedAt: null,
    factors: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
  }
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(max, Math.floor(n))
}

function parseBoundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = parsePositiveInt(value, fallback, max)
  return Math.max(1, parsed)
}

/** Closed vocabulary: an unknown value is a request error, never an empty list. */
function parseSiteHealthState(value: unknown): SiteHealthState | null {
  if (value === undefined || value === '') return null
  const allowed = siteHealthStateSchema.safeParse(value)
  if (!allowed.success) {
    throw validationError(`"healthState" must be one of: ${siteHealthStateSchema.options.join(', ')}`)
  }
  return allowed.data
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return null
}

/** Opaque offset cursor. Every list is bounded, and callers cannot select raw offsets. */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url')
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return 0
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { offset?: unknown }
    return typeof parsed.offset === 'number' && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0
      ? Math.min(parsed.offset, 1_000_000)
      : 0
  } catch {
    return 0
  }
}

function normalizeParentPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '/'
  const bare = value.trim().split(/[?#]/, 1)[0] ?? '/'
  const prefixed = bare.startsWith('/') ? bare : `/${bare}`
  const collapsed = prefixed.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

/** A persisted crawl is capped by the run request contract at 50,000 pages. */
const MAX_STRUCTURE_SOURCE_ROWS = 50_000

/** Folder identity deliberately folds trailing slashes without changing URL identity. */
function structureHierarchyPath(path: string): string {
  if (path.length <= 1) return path
  return path.replace(/\/+$/, '') || '/'
}

/**
 * Project one persisted page into the immediate child folder below `parentPath`.
 * This stays in JS so path delimiters are never handed to a dialect-specific
 * SQL function (or to LIKE, where literal `%` and `_` become wildcards).
 */
function structureChildPath(parentPath: string, path: string): string | null {
  const hierarchyPath = structureHierarchyPath(path)
  if (hierarchyPath === parentPath) return null

  const relative = parentPath === '/'
    ? hierarchyPath.startsWith('/') ? hierarchyPath.slice(1) : ''
    : hierarchyPath.startsWith(`${parentPath}/`) ? hierarchyPath.slice(parentPath.length + 1) : ''
  if (relative.length === 0) return null

  const separator = relative.indexOf('/')
  const segment = separator === -1 ? relative : relative.slice(0, separator)
  return parentPath === '/' ? `/${segment}` : `${parentPath}/${segment}`
}

function mapCrawlPage(row: typeof siteCrawlPages.$inferSelect): SiteCrawlPageDto {
  return {
    nodeKey: row.nodeKey,
    url: row.url,
    finalUrl: row.finalUrl,
    path: row.path,
    parentPath: row.parentPath,
    discoverySource: row.discoverySource,
    fetchState: row.fetchState,
    httpStatus: row.httpStatus,
    canonicalUrl: row.canonicalUrl,
    indexabilityState: row.indexabilityState,
    indexabilityReasons: row.indexabilityReasons,
    auditState: row.auditState,
    auditScore: row.auditScore,
    inventoryEligible: row.inventoryEligible,
    depth: row.depth,
    inboundUniqueEdges: row.inboundUniqueEdges,
    outboundUniqueEdges: row.outboundUniqueEdges,
    inboundOccurrences: row.inboundOccurrences,
    outboundOccurrences: row.outboundOccurrences,
    linkScoreRaw: row.linkScoreRaw,
    linkScoreNormalized: row.linkScoreNormalized,
    healthState: deriveSiteHealthState(row),
  }
}

function mapCrawlPageAuditEvidence(row: typeof siteCrawlPages.$inferSelect): Pick<
  Extract<SiteCrawlPageAuditDto, { state: 'ready' }>,
  'evidenceState' | 'factors' | 'criticalDefects'
> {
  const fields = row.auditFields
  const rawFactors = Array.isArray(fields.factors) ? fields.factors : []
  const rawCriticalDefects = Array.isArray(fields.criticalDefects) ? fields.criticalDefects : []
  const parsedFactors = rawFactors.map((factor) => siteCrawlAuditFactorSchema.safeParse(factor))
  const parsedCriticalDefects = rawCriticalDefects.map((defect) => siteCrawlCriticalDefectSchema.safeParse(defect))
  const complete = fields.schemaVersion === '1.0'
    && Array.isArray(fields.factors)
    && Array.isArray(fields.criticalDefects)
    && parsedFactors.every((result) => result.success)
    && parsedCriticalDefects.every((result) => result.success)

  const factors = parsedFactors.flatMap((result, index) => {
    if (result.success) return [result.data]
    const legacy = siteAuditPageFactorSchema.safeParse(rawFactors[index])
    return legacy.success
      ? [{
          ...legacy.data,
          status: factorStatusFromScore(legacy.data.score),
          applicable: null,
          findings: [],
          recommendations: [],
        }]
      : []
  })

  return {
    evidenceState: complete ? 'complete' : 'scores-only',
    factors,
    criticalDefects: parsedCriticalDefects.flatMap((result) => result.success ? [result.data] : []),
  }
}

const LIVE_PAGE_HEALTH_CANDIDATE_LIMIT = 48
const LIVE_PAGE_HEALTH_EXAMPLE_LIMIT = 12

/**
 * The live preview intentionally projects no finding prose. Invalid or legacy
 * evidence is skipped rather than guessed, while an explicitly inapplicable
 * factor cannot make a page appear actionable.
 */
function countLivePageHealthChecks(auditFields: Record<string, unknown>): number {
  const rawFactors = Array.isArray(auditFields.factors) ? auditFields.factors : []
  const rawCriticalDefects = Array.isArray(auditFields.criticalDefects) ? auditFields.criticalDefects : []
  let checks = 0
  for (const rawFactor of rawFactors) {
    const factor = siteCrawlAuditFactorSchema.safeParse(rawFactor)
    if (factor.success && factor.data.applicable !== false && factor.data.status !== 'pass') checks++
  }
  for (const rawCriticalDefect of rawCriticalDefects) {
    if (siteCrawlCriticalDefectSchema.safeParse(rawCriticalDefect).success) checks++
  }
  return checks
}

/**
 * A link's placement counts, or null when this scan recorded none.
 *
 * The three columns are written together, so one NULL means the observation is
 * absent entirely. Zeros are a real, different answer: a redirect edge has no
 * position in a page, and an all-`unknown` link sits on a page that declares no
 * landmark. Coalescing absence to zeros would erase that distinction.
 */
function mapPlacementOccurrences(
  row: Pick<
    typeof siteCrawlEdges.$inferSelect,
    'placementNavigationOccurrences' | 'placementContentOccurrences' | 'placementUnknownOccurrences'
  >,
): SiteCrawlPlacementOccurrencesDto | null {
  const navigation = row.placementNavigationOccurrences
  const content = row.placementContentOccurrences
  const unknown = row.placementUnknownOccurrences
  if (navigation == null || content == null || unknown == null) return null
  return { navigation, content, unknown }
}

/**
 * The scan's detection state is required, not optional: which rule produced a
 * link's `isTemplate` is only answerable against the scan it belongs to, and a
 * count a consumer cannot attribute to a rule is exactly the thing this change
 * exists to prevent.
 */
function mapCrawlEdge(
  row: typeof siteCrawlEdges.$inferSelect,
  detection: SiteHealthTemplateDetection,
): SiteCrawlEdgeDto {
  const placementOccurrences = mapPlacementOccurrences(row)
  return {
    edgeKey: row.edgeKey,
    sourceNodeKey: row.sourceNodeKey,
    sourceUrl: row.sourceUrl,
    targetNodeKey: row.targetNodeKey,
    targetUrl: row.targetUrl,
    relation: row.relation,
    internal: row.internal,
    followable: row.followable,
    occurrences: row.occurrences,
    followableOccurrences: row.followableOccurrences,
    nofollowOccurrences: row.nofollowOccurrences,
    anchors: row.anchors,
    isTemplate: row.isTemplate,
    templateRatio: row.templateRatio,
    templateSource: templateLinkSource(detection, {
      isTemplate: row.isTemplate,
      templateRatio: row.templateRatio,
      placementOccurrences,
    }),
    placementOccurrences,
  }
}

/**
 * Whether nav/footer detection ran for this scan.
 *
 * A persisted value outside the closed set (a row written by a newer engine
 * image, say) is reported as unclassified rather than echoed raw: a consumer
 * keys copy off these values, and an unknown one must not read as `applied`.
 */
function templateDetectionOf(value: string | null): SiteHealthTemplateDetection {
  const parsed = siteHealthTemplateDetectionSchema.safeParse(value)
  return parsed.success ? parsed.data : SiteHealthTemplateDetections['unavailable-legacy-scan']
}

/** Closed vocabulary: an unknown value is a request error, never an empty list. */
function parseLinkKind(value: unknown): SiteHealthLinkKind {
  if (value === undefined || value === '') return SiteHealthLinkKinds.all
  const allowed = siteHealthLinkKindSchema.safeParse(value)
  if (!allowed.success) {
    throw validationError(`"linkKind" must be one of: ${siteHealthLinkKindSchema.options.join(', ')}`)
  }
  return allowed.data
}

/**
 * The `linkKind` filter, or undefined for `all`.
 *
 * A scan whose links were never classified holds NULL, and NULL is not `false`
 * in SQL, so an unclassified scan correctly matches NEITHER `content` nor
 * `template`. The response's `templateDetection` is what tells the caller that
 * the resulting empty list means "could not tell", not "none".
 */
function linkKindFilter(linkKind: SiteHealthLinkKind): SQL | undefined {
  if (linkKind === SiteHealthLinkKinds.content) return eq(siteCrawlEdges.isTemplate, false)
  if (linkKind === SiteHealthLinkKinds.template) return eq(siteCrawlEdges.isTemplate, true)
  return undefined
}

/** Distinct aliases bound graph edges to the caller's retained node ranks. */
const graphSourceNode = alias(siteCrawlGraphNodes, 'site_crawl_graph_source_node')
const graphTargetNode = alias(siteCrawlGraphNodes, 'site_crawl_graph_target_node')

interface CrawlDetailScope {
  projectId: string
  runId: string
  attemptId: string
}

interface SiteHealthChangeKeyRow {
  entity: 'page' | 'link'
  change: 'added' | 'removed' | 'changed'
  key: string
}

interface SiteHealthChangeCounts {
  added: number
  removed: number
  changed: number
}

interface SiteHealthChangesSummary {
  pages: SiteHealthChangeCounts
  links: SiteHealthChangeCounts
}

interface SiteHealthChangesCursor {
  v: 1
  fromRunId: string
  toRunId: string
  scope: 'all' | 'pages' | 'links'
  change: 'all' | 'added' | 'removed' | 'changed'
  entity: 'page' | 'link'
  key: string
}

/** SQLite null-safe semantic comparisons. The aliases are fixed by the bounded summary/keyset queries below. */
const PAGE_CHANGE_PREDICATE = sql`(
  current.url IS NOT previous.url
  OR current.final_url IS NOT previous.final_url
  OR current.path IS NOT previous.path
  OR current.parent_path IS NOT previous.parent_path
  OR current.discovery_source IS NOT previous.discovery_source
  OR current.fetch_state IS NOT previous.fetch_state
  OR current.http_status IS NOT previous.http_status
  OR current.canonical_url IS NOT previous.canonical_url
  OR current.indexability_state IS NOT previous.indexability_state
  OR current.indexability_reasons IS NOT previous.indexability_reasons
  OR current.audit_state IS NOT previous.audit_state
  OR current.audit_score IS NOT previous.audit_score
  OR current.inventory_eligible IS NOT previous.inventory_eligible
  OR current.depth IS NOT previous.depth
  OR current.inbound_unique_edges IS NOT previous.inbound_unique_edges
  OR current.outbound_unique_edges IS NOT previous.outbound_unique_edges
  OR current.inbound_occurrences IS NOT previous.inbound_occurrences
  OR current.outbound_occurrences IS NOT previous.outbound_occurrences
  OR current.link_score_raw IS NOT previous.link_score_raw
  OR current.link_score_normalized IS NOT previous.link_score_normalized
)`

const LINK_CHANGE_PREDICATE = sql`(
  current.source_node_key IS NOT previous.source_node_key
  OR current.source_url IS NOT previous.source_url
  OR current.target_node_key IS NOT previous.target_node_key
  OR current.target_url IS NOT previous.target_url
  OR current.relation IS NOT previous.relation
  OR current.followable IS NOT previous.followable
  OR current.occurrences IS NOT previous.occurrences
  OR current.followable_occurrences IS NOT previous.followable_occurrences
  OR current.nofollow_occurrences IS NOT previous.nofollow_occurrences
  OR current.anchors IS NOT previous.anchors
)`

function encodeSiteHealthChangesCursor(cursor: SiteHealthChangesCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeSiteHealthChangesCursor(
  value: unknown,
  context: Pick<SiteHealthChangesCursor, 'fromRunId' | 'toRunId' | 'scope' | 'change'>,
): SiteHealthChangesCursor | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 2_048) throw validationError('Invalid Site Health changes cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SiteHealthChangesCursor>
    const valid = parsed.v === 1
      && parsed.fromRunId === context.fromRunId
      && parsed.toRunId === context.toRunId
      && parsed.scope === context.scope
      && parsed.change === context.change
      && (parsed.entity === 'page' || parsed.entity === 'link')
      && typeof parsed.key === 'string'
      && parsed.key.length > 0
      && parsed.key.length <= 2_048
    if (!valid) throw new Error('context mismatch')
    return parsed as SiteHealthChangesCursor
  } catch {
    throw validationError('Site Health changes cursor does not match this snapshot comparison and filter')
  }
}

function compareChangeKeys(left: SiteHealthChangeKeyRow, right: SiteHealthChangeKeyRow): number {
  return Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
}

function valueChanged(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) || Array.isArray(after) || (before && typeof before === 'object') || (after && typeof after === 'object')) {
    return JSON.stringify(before) !== JSON.stringify(after)
  }
  return before !== after
}

const PAGE_CHANGE_FIELDS = [
  'url', 'finalUrl', 'path', 'parentPath', 'discoverySource', 'fetchState', 'httpStatus',
  'canonicalUrl', 'indexabilityState', 'indexabilityReasons', 'auditState', 'auditScore',
  'inventoryEligible', 'depth', 'inboundUniqueEdges', 'outboundUniqueEdges',
  'inboundOccurrences', 'outboundOccurrences', 'linkScoreRaw', 'linkScoreNormalized',
] as const satisfies ReadonlyArray<keyof SiteCrawlPageDto>

/**
 * `isTemplate` and `templateRatio` are deliberately absent. Both are derived
 * from the WHOLE scan, so adding one page shifts every ratio and comparing a
 * pre-detection scan to a classified one would mark every link changed. That
 * would drown the real link additions and removals this diff exists to show.
 */
const LINK_CHANGE_FIELDS = [
  'sourceNodeKey', 'sourceUrl', 'targetNodeKey', 'targetUrl', 'relation', 'internal',
  'followable', 'occurrences', 'followableOccurrences', 'nofollowOccurrences', 'anchors',
] as const satisfies ReadonlyArray<keyof SiteCrawlEdgeDto>

function changedFields<T extends Record<string, unknown>>(
  before: T | null,
  after: T | null,
  fields: readonly (keyof T)[],
): string[] {
  if (!before || !after) return []
  return fields.filter((field) => valueChanged(before[field], after[field])).map(String)
}

export async function technicalAeoRoutes(app: FastifyInstance, opts: TechnicalAeoRoutesOptions) {
  /** Resolve only a real, visible site-audit crawl in this exact project. */
  const resolveCrawl = (projectId: string, runId?: string) => {
    const filters = [
      eq(siteCrawlSnapshots.projectId, projectId),
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    if (runId) {
      // Historical inspection may intentionally select an older partial
      // snapshot. It is never the default current graph.
      filters.push(eq(siteCrawlSnapshots.runId, runId))
    } else {
      // A live/current graph is an immutable successful publication only.
      // In-progress attempt rows are deliberately excluded, and a later
      // partial crawl cannot displace the prior complete graph.
      filters.push(eq(siteCrawlSnapshots.complete, true), eq(runs.status, RunStatuses.completed))
    }
    return app.db
      .select({ snapshot: siteCrawlSnapshots, runStatus: runs.status })
      .from(siteCrawlSnapshots)
      .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
      .where(and(...filters))
      .orderBy(desc(siteCrawlSnapshots.createdAt), desc(siteCrawlSnapshots.runId))
      .limit(1)
      .get()
  }

  const detailScopeFor = (projectId: string, snapshot: typeof siteCrawlSnapshots.$inferSelect): CrawlDetailScope | null => (
    snapshot.detailsAvailable && snapshot.attemptId
      ? { projectId, runId: snapshot.runId, attemptId: snapshot.attemptId }
      : null
  )

  const pageInScope = (
    scope: CrawlDetailScope,
    selector: { nodeKey?: string; url?: string },
  ): typeof siteCrawlPages.$inferSelect | null => {
    if (!selector.nodeKey && !selector.url) return null
    return app.db.select().from(siteCrawlPages).where(and(
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
      selector.nodeKey
        ? eq(siteCrawlPages.nodeKey, selector.nodeKey)
        : eq(siteCrawlPages.url, selector.url!),
    )).orderBy(asc(siteCrawlPages.nodeKey)).limit(1).get() ?? null
  }

  const rootPageInScope = (
    scope: CrawlDetailScope,
    rootUrl: string,
  ): typeof siteCrawlPages.$inferSelect | null => pageInScope(scope, { url: rootUrl }) ?? app.db
    .select().from(siteCrawlPages).where(and(
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
      eq(siteCrawlPages.depth, 0),
    )).orderBy(asc(siteCrawlPages.nodeKey)).limit(1).get() ?? null

  /**
   * True when `runId` names a real, surfaceable, non-probe site-audit run in
   * this project. Every crawl-scoped read uses it to separate two very
   * different misses: a run that exists but predates crawl persistence (a
   * legacy score-only scan, which must answer with its honest no-crawl shape)
   * from a runId this project never had (which stays a 404).
   */
  const isSurfaceableAuditRun = (projectId: string, runId: string): boolean => Boolean(app.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(
      eq(runs.id, runId),
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ))
    .limit(1)
    .get())

  /** Refuse only a runId this project never surfaced; legacy scans fall through. */
  const assertKnownAuditRun = (projectId: string, runId: string | undefined): void => {
    if (runId && !isSurfaceableAuditRun(projectId, runId)) throw notFound('Site crawl run', runId)
  }

  /** Legacy rows are a scorecard only: they never stand in for a crawl graph. */
  const hasLegacyAudit = (projectId: string): boolean => Boolean(app.db
    .select({ runId: siteAuditSnapshots.runId })
    .from(siteAuditSnapshots)
    .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
    .where(and(
      eq(siteAuditSnapshots.projectId, projectId),
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ))
    .limit(1)
    .get())

  const emptyCrawlSummary = (projectName: string, legacyAuditAvailable: boolean): SiteCrawlSummaryDto => ({
    project: projectName,
    hasCrawlData: false,
    legacyAuditAvailable,
    runId: null,
    runStatus: null,
    requestedRootUrl: null,
    rootUrl: null,
    effectiveOptions: {},
    complete: false,
    termination: null,
    detailsAvailable: false,
    counts: { pagesDiscovered: 0, pagesFetched: 0, pagesEligible: 0, edges: 0, findings: 0 },
    deadLinks: { state: 'unavailable' },
  })

  // GET /projects/:name/technical-aeo — latest scorecard, or one historical run, + delta vs prior run.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string }
  }>('/projects/:name/technical-aeo', async (request): Promise<SiteAuditScoreDto> => {
    const project = resolveProject(app.db, request.params.name)
    const baseFilters = [
      eq(siteAuditSnapshots.projectId, project.id),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    const targetFilters = request.query.runId
      ? [...baseFilters, eq(siteAuditSnapshots.runId, request.query.runId)]
      : baseFilters
    const latest = app.db
      .select({ snap: siteAuditSnapshots, runStatus: runs.status })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...targetFilters))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()

    if (!latest) {
      if (request.query.runId) throw notFound('Site audit run', request.query.runId)
      return emptyScore(project.name)
    }

    const snap = latest.snap
    const previous = app.db
      .select({ snap: siteAuditSnapshots })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...baseFilters, lt(siteAuditSnapshots.createdAt, snap.createdAt)))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()?.snap ?? null
    const deltaScore = previous ? snap.aggregateScore - previous.aggregateScore : null
    const trend = deltaScore == null
      ? null
      : deltaScore > 0
        ? SiteAuditTrendDirections.up
        : deltaScore < 0
          ? SiteAuditTrendDirections.down
          : SiteAuditTrendDirections.flat

    return {
      project: project.name,
      hasData: true,
      runId: snap.runId,
      runStatus: latest.runStatus as RunStatus,
      sitemapUrl: snap.sitemapUrl,
      auditedAt: snap.auditedAt,
      aggregateScore: snap.aggregateScore,
      pagesDiscovered: snap.pagesDiscovered,
      pagesAudited: snap.pagesAudited,
      pagesSkipped: snap.pagesSkipped,
      pagesErrored: snap.pagesErrored,
      deltaScore,
      trend,
      previousScore: previous?.aggregateScore ?? null,
      previousAuditedAt: previous?.auditedAt ?? null,
      factors: snap.factorAverages,
      crossCuttingIssues: snap.crossCuttingIssues,
      prioritizedFixes: snap.prioritizedFixes,
    }
  })

  // GET /projects/:name/technical-aeo/pages — per-page breakdown of the latest or selected run.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; status?: string; sort?: string; limit?: string; offset?: string }
  }>('/projects/:name/technical-aeo/pages', async (request): Promise<SiteAuditPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)

    // Latest surfaceable site-audit run for this project, or the explicitly selected run.
    const targetFilters = [
      eq(siteAuditSnapshots.projectId, project.id),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      inArray(runs.status, SURFACEABLE_STATUSES),
      notProbeRun(),
    ]
    if (request.query.runId) targetFilters.push(eq(siteAuditSnapshots.runId, request.query.runId))
    const latest = app.db
      .select({ runId: siteAuditSnapshots.runId, auditedAt: siteAuditSnapshots.auditedAt })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(...targetFilters))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()

    if (!latest && request.query.runId) {
      throw notFound('Site audit run', request.query.runId)
    }
    if (!latest) {
      return { project: project.name, runId: null, auditedAt: null, total: 0, pages: [] }
    }

    const statusFilter = request.query.status === 'success' || request.query.status === 'error'
      ? request.query.status
      : null
    const conds = [eq(siteAuditPages.projectId, project.id), eq(siteAuditPages.runId, latest.runId)]
    if (statusFilter) conds.push(eq(siteAuditPages.status, statusFilter))
    const where = and(...conds)

    const totalRow = app.db.select({ value: count() }).from(siteAuditPages).where(where).get()
    const total = totalRow?.value ?? 0

    const limit = parsePositiveInt(request.query.limit, 100, 500)
    const offset = parsePositiveInt(request.query.offset, 0, Number.MAX_SAFE_INTEGER)
    const orderBy = request.query.sort === 'score-desc'
      ? desc(siteAuditPages.overallScore)
      : request.query.sort === 'url'
        ? asc(siteAuditPages.url)
        : asc(siteAuditPages.overallScore)

    const rows = app.db
      .select()
      .from(siteAuditPages)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)
      .all()

    const pages: SiteAuditPageDto[] = rows.map((row) => ({
      url: row.url,
      overallScore: row.overallScore,
      status: row.status === 'error' ? 'error' : 'success',
      error: row.error,
      factors: row.factors,
    }))

    return { project: project.name, runId: latest.runId, auditedAt: latest.auditedAt, total, pages }
  })

  // GET /projects/:name/technical-aeo/trend — aggregate score over time (oldest-first).
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/technical-aeo/trend', async (request): Promise<SiteAuditTrendResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const limit = parsePositiveInt(request.query.limit, 30, 365)

    const rows = app.db
      .select({
        runId: siteAuditSnapshots.runId,
        auditedAt: siteAuditSnapshots.auditedAt,
        aggregateScore: siteAuditSnapshots.aggregateScore,
        pagesAudited: siteAuditSnapshots.pagesAudited,
      })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(
        eq(siteAuditSnapshots.projectId, project.id),
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
      ))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(limit)
      .all()

    return { project: project.name, points: rows.reverse() }
  })

  // GET /projects/:name/technical-aeo/crawl — persisted crawl metadata only;
  // legacy scorecard rows never fabricate a graph-shaped response.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string }
  }>('/projects/:name/technical-aeo/crawl', async (request): Promise<SiteCrawlSummaryDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    const legacyAuditAvailable = hasLegacyAudit(project.id)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return emptyCrawlSummary(project.name, legacyAuditAvailable)
    }

    const snapshot = target.snapshot
    const deadLinks = !snapshot.checkDeadLinks || snapshot.deadLinkState === 'disabled'
      ? { state: 'disabled' as const }
      : snapshot.deadLinkState === 'complete'
        ? { state: 'complete' as const, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound, unverified: snapshot.deadLinksUnverified }
        : snapshot.deadLinkState === 'partial'
          ? { state: 'partial' as const, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound, unverified: snapshot.deadLinksUnverified }
          : { state: 'unavailable' as const }

    return {
      project: project.name,
      hasCrawlData: true,
      legacyAuditAvailable,
      runId: snapshot.runId,
      runStatus: target.runStatus as RunStatus,
      requestedRootUrl: snapshot.requestedRootUrl,
      rootUrl: snapshot.rootUrl,
      crawlSchemaVersion: snapshot.crawlSchemaVersion,
      engineVersion: snapshot.engineVersion,
      normalizationVersion: snapshot.normalizationVersion,
      indexabilityVersion: snapshot.indexabilityVersion,
      linkScoreVersion: snapshot.linkScoreVersion,
      effectiveOptions: snapshot.effectiveOptions,
      complete: snapshot.complete,
      termination: snapshot.termination,
      detailsAvailable: snapshot.detailsAvailable,
      counts: {
        pagesDiscovered: snapshot.pagesDiscovered,
        pagesFetched: snapshot.pagesFetched,
        pagesEligible: snapshot.pagesEligible,
        edges: snapshot.edgesDiscovered,
        findings: snapshot.findingsCount,
      },
      deadLinks,
    }
  })

  // GET /projects/:name/technical-aeo/graph — the persisted Site Health
  // projection. Sampling and ForceAtlas2 run exactly once at snapshot publish;
  // reads only scan the bounded 20k/50k derived tables.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; maxNodes?: string; maxEdges?: string; linkKind?: string }
  }>('/projects/:name/technical-aeo/graph', async (request): Promise<SiteCrawlGraphResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const linkKind = parseLinkKind(request.query.linkKind)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return {
        project: project.name, hasCrawlData: false, runId: null, rootNodeKey: null,
        layout: { state: 'unavailable', version: null, reason: 'no-crawl' },
        // Nothing was classified because nothing was crawled.
        templateDetection: SiteHealthTemplateDetections['unavailable-legacy-scan'],
        linkKind,
        totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
        nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
      }
    }

    const snapshot = target.snapshot
    const templateDetection = templateDetectionOf(snapshot.templateDetection)
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, rootNodeKey: null,
        layout: { state: 'unavailable', version: null, reason: 'details-unavailable' },
        templateDetection, linkKind,
        totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
        nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
      }
    }
    // The home page is the one node an operator always needs to find, so its
    // identity is server-owned rather than guessed from a path or a depth.
    const rootNodeKey = rootPageInScope(
      { projectId: project.id, runId: snapshot.runId, attemptId: snapshot.attemptId },
      snapshot.rootUrl,
    )?.nodeKey ?? null

    const persistedLayout = app.db.select().from(siteCrawlGraphLayouts).where(and(
      eq(siteCrawlGraphLayouts.projectId, project.id),
      eq(siteCrawlGraphLayouts.runId, snapshot.runId),
      eq(siteCrawlGraphLayouts.attemptId, snapshot.attemptId),
    )).limit(1).get()
    if (!persistedLayout) {
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, rootNodeKey,
        layout: { state: 'unavailable', version: null, reason: 'legacy-snapshot' },
        templateDetection, linkKind,
        totalNodes: 0, totalEdges: 0, totalTemplateEdges: 0, totalContentEdges: 0,
        nodes: [], edges: [], omittedNodes: 0, omittedEdges: 0, sampled: false,
      }
    }
    if (persistedLayout.state !== 'ready' || !persistedLayout.layoutVersion) {
      const totalNodes = persistedLayout.totalNodes
      const totalEdges = persistedLayout.totalEdges
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, rootNodeKey,
        layout: {
          state: 'unavailable', version: null,
          reason: persistedLayout.failureCode === 'empty-crawl' ? 'empty-crawl' : 'layout-failed',
        },
        templateDetection, linkKind,
        totalNodes,
        totalEdges,
        totalTemplateEdges: persistedLayout.totalTemplateEdges,
        totalContentEdges: Math.max(0, totalEdges - persistedLayout.totalTemplateEdges),
        nodes: [], edges: [], omittedNodes: totalNodes, omittedEdges: totalEdges,
        sampled: totalNodes > 0 || totalEdges > 0,
      }
    }

    const maxNodes = parseBoundedLimit(request.query.maxNodes, SITE_CRAWL_GRAPH_DEFAULT_MAX_NODES, SITE_CRAWL_GRAPH_MAX_NODES)
    const maxEdges = parseBoundedLimit(request.query.maxEdges, SITE_CRAWL_GRAPH_DEFAULT_MAX_EDGES, SITE_CRAWL_GRAPH_MAX_EDGES)
    const graphScope = [
      eq(siteCrawlGraphNodes.projectId, project.id),
      eq(siteCrawlGraphNodes.runId, snapshot.runId),
      eq(siteCrawlGraphNodes.attemptId, snapshot.attemptId),
    ]
    const nodeRows = app.db.select({
      nodeKey: siteCrawlPages.nodeKey,
      url: siteCrawlPages.url,
      path: siteCrawlPages.path,
      depth: siteCrawlPages.depth,
      indexabilityState: siteCrawlPages.indexabilityState,
      indexabilityReasons: siteCrawlPages.indexabilityReasons,
      canonicalNodeKey: siteCrawlPages.canonicalNodeKey,
      fetchState: siteCrawlPages.fetchState,
      auditState: siteCrawlPages.auditState,
      auditScore: siteCrawlPages.auditScore,
      inventoryEligible: siteCrawlPages.inventoryEligible,
      inboundUniqueEdges: siteCrawlPages.inboundUniqueEdges,
      outboundUniqueEdges: siteCrawlPages.outboundUniqueEdges,
      linkScoreNormalized: siteCrawlPages.linkScoreNormalized,
      x: siteCrawlGraphNodes.x,
      y: siteCrawlGraphNodes.y,
    }).from(siteCrawlGraphNodes).innerJoin(siteCrawlPages, and(
      eq(siteCrawlPages.projectId, siteCrawlGraphNodes.projectId),
      eq(siteCrawlPages.runId, siteCrawlGraphNodes.runId),
      eq(siteCrawlPages.attemptId, siteCrawlGraphNodes.attemptId),
      eq(siteCrawlPages.nodeKey, siteCrawlGraphNodes.nodeKey),
    )).where(and(...graphScope, lt(siteCrawlGraphNodes.sampleRank, maxNodes)))
      .orderBy(asc(siteCrawlGraphNodes.sampleRank)).all()
    const nodes = nodeRows.map(({ indexabilityReasons, canonicalNodeKey, ...row }) => ({
      ...row,
      healthState: deriveSiteHealthState({ ...row, indexabilityReasons, canonicalNodeKey }),
    }))
    // The map keeps template links in the payload and hides them client side,
    // so switching them on costs no refetch and cannot move a node. A caller
    // that wants a smaller payload asks for one with `linkKind`.
    const graphLinkKindFilter = linkKind === SiteHealthLinkKinds.all
      ? undefined
      : eq(siteCrawlGraphEdges.isTemplate, linkKind === SiteHealthLinkKinds.template)
    const edges = app.db.select({
      edgeKey: siteCrawlGraphEdges.edgeKey,
      sourceNodeKey: siteCrawlGraphEdges.sourceNodeKey,
      targetNodeKey: siteCrawlGraphEdges.targetNodeKey,
      followable: siteCrawlGraphEdges.followable,
      occurrences: siteCrawlGraphEdges.occurrences,
      isTemplate: siteCrawlGraphEdges.isTemplate,
    }).from(siteCrawlGraphEdges)
      .innerJoin(graphSourceNode, and(
        eq(graphSourceNode.projectId, siteCrawlGraphEdges.projectId),
        eq(graphSourceNode.runId, siteCrawlGraphEdges.runId),
        eq(graphSourceNode.attemptId, siteCrawlGraphEdges.attemptId),
        eq(graphSourceNode.nodeKey, siteCrawlGraphEdges.sourceNodeKey),
        lt(graphSourceNode.sampleRank, maxNodes),
      ))
      .innerJoin(graphTargetNode, and(
        eq(graphTargetNode.projectId, siteCrawlGraphEdges.projectId),
        eq(graphTargetNode.runId, siteCrawlGraphEdges.runId),
        eq(graphTargetNode.attemptId, siteCrawlGraphEdges.attemptId),
        eq(graphTargetNode.nodeKey, siteCrawlGraphEdges.targetNodeKey),
        lt(graphTargetNode.sampleRank, maxNodes),
      ))
      .where(and(
        eq(siteCrawlGraphEdges.projectId, project.id),
        eq(siteCrawlGraphEdges.runId, snapshot.runId),
        eq(siteCrawlGraphEdges.attemptId, snapshot.attemptId),
        lt(siteCrawlGraphEdges.sampleRank, maxEdges),
        graphLinkKindFilter,
      ))
      .orderBy(asc(siteCrawlGraphEdges.sampleRank)).all()
    const totalNodes = persistedLayout.totalNodes
    const totalEdges = persistedLayout.totalEdges
    const totalTemplateEdges = persistedLayout.totalTemplateEdges
    const omittedNodes = Math.max(0, totalNodes - nodes.length)
    const omittedEdges = Math.max(0, totalEdges - edges.length)
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      rootNodeKey,
      layout: {
        state: 'ready',
        version: persistedLayout.layoutVersion,
        computedAt: persistedLayout.createdAt,
        templateLinksExcluded: persistedLayout.templateLinksExcluded,
      },
      templateDetection,
      linkKind,
      totalNodes,
      // Deliberately still every graph-compatible link, whatever `linkKind`
      // asked for. The two counts below split it; none of the three moves
      // because a caller narrowed the payload.
      totalEdges,
      totalTemplateEdges,
      totalContentEdges: Math.max(0, totalEdges - totalTemplateEdges),
      nodes,
      edges,
      omittedNodes,
      omittedEdges,
      sampled: omittedNodes > 0 || omittedEdges > 0,
    }
  })

  // GET /projects/:name/technical-aeo/subgraph — a bounded canonical
  // neighborhood for agents. It deliberately excludes visualization layout.
  app.get<{
    Params: { name: string }
    Querystring: {
      runId?: string
      nodeKey?: string
      url?: string
      hops?: string
      maxNodes?: string
      maxEdges?: string
    }
  }>('/projects/:name/technical-aeo/subgraph', async (request): Promise<SiteHealthSubgraphResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const hops = Math.min(3, parsePositiveInt(request.query.hops, 1, 3))
    const maxNodes = parseBoundedLimit(
      request.query.maxNodes,
      SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_NODES,
      SITE_HEALTH_SUBGRAPH_MAX_NODES,
    )
    const maxEdges = parseBoundedLimit(
      request.query.maxEdges,
      SITE_HEALTH_SUBGRAPH_DEFAULT_MAX_EDGES,
      SITE_HEALTH_SUBGRAPH_MAX_EDGES,
    )
    const target = resolveCrawl(project.id, request.query.runId)
    const empty = (
      state: 'no-crawl' | 'details-unavailable',
      runId: string | null,
      hasCrawlData: boolean,
      complete: boolean,
      termination: string | null,
    ): SiteHealthSubgraphResponseDto => ({
      project: project.name,
      hasCrawlData,
      runId,
      complete,
      termination,
      state,
      focusNodeKey: null,
      focusUrl: null,
      hops,
      totalNodes: 0,
      totalEdges: 0,
      nodes: [],
      edges: [],
      omittedNodes: 0,
      omittedEdges: 0,
      countAccuracy: state === 'no-crawl' ? 'exact' : 'lower-bound',
      truncated: false,
    })
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return empty('no-crawl', null, false, false, null)
    }
    const snapshot = target.snapshot
    const scope = detailScopeFor(project.id, snapshot)
    if (!scope) return empty('details-unavailable', snapshot.runId, true, snapshot.complete, snapshot.termination)

    const explicitFocus = Boolean(request.query.nodeKey || request.query.url)
    const focus = explicitFocus
      ? pageInScope(scope, { nodeKey: request.query.nodeKey, url: request.query.url })
      : rootPageInScope(scope, snapshot.rootUrl)
    if (!focus) {
      if (explicitFocus) throw notFound('Site crawl page', request.query.nodeKey ?? request.query.url!)
      return {
        ...empty('details-unavailable', snapshot.runId, true, snapshot.complete, snapshot.termination),
        truncated: false,
      }
    }

    const distances = new Map<string, number>([[focus.nodeKey, 0]])
    const directRelations = new Map<string, Exclude<SiteHealthSubgraphRelation, 'focus' | 'transitive'>>()
    const edgeRows = new Map<string, typeof siteCrawlEdges.$inferSelect>()
    const omittedNodeKeys = new Set<string>()
    const omittedEdgeKeys = new Set<string>()
    const seenEdgeKeys = new Set<string>()
    let frontier = [focus.nodeKey]
    let queryTruncated = false

    for (let distance = 0; distance < hops && frontier.length > 0; distance += 1) {
      const candidates = app.db.select().from(siteCrawlEdges).where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        eq(siteCrawlEdges.internal, true),
        isNotNull(siteCrawlEdges.targetNodeKey),
        or(
          inArray(siteCrawlEdges.sourceNodeKey, frontier),
          inArray(siteCrawlEdges.targetNodeKey, frontier),
        ),
      )).orderBy(asc(siteCrawlEdges.edgeKey))
        .limit(maxEdges + maxNodes + 1)
        .all()
      if (candidates.length > maxEdges + maxNodes) queryTruncated = true

      const next = new Set<string>()
      for (const edge of candidates.slice(0, maxEdges + maxNodes)) {
        if (!edge.targetNodeKey || seenEdgeKeys.has(edge.edgeKey)) continue
        seenEdgeKeys.add(edge.edgeKey)
        const sourceInFrontier = frontier.includes(edge.sourceNodeKey)
        const neighborKey = sourceInFrontier ? edge.targetNodeKey : edge.sourceNodeKey
        if (!distances.has(neighborKey)) {
          if (distances.size < maxNodes) {
            distances.set(neighborKey, distance + 1)
            next.add(neighborKey)
          } else {
            omittedNodeKeys.add(neighborKey)
          }
        }
        if (distance === 0 && neighborKey !== focus.nodeKey) {
          const direction = edge.sourceNodeKey === focus.nodeKey ? 'outbound' : 'inbound'
          const prior = directRelations.get(neighborKey)
          directRelations.set(neighborKey, prior && prior !== direction ? 'both' : direction)
        }
        if (distances.has(edge.sourceNodeKey) && distances.has(edge.targetNodeKey)) {
          if (edgeRows.size < maxEdges) edgeRows.set(edge.edgeKey, edge)
          else omittedEdgeKeys.add(edge.edgeKey)
        } else {
          omittedEdgeKeys.add(edge.edgeKey)
        }
      }
      frontier = [...next].sort()
    }

    const nodeKeys = [...distances.keys()]
    const pageRows = nodeKeys.length === 0 ? [] : app.db.select().from(siteCrawlPages).where(and(
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
      inArray(siteCrawlPages.nodeKey, nodeKeys),
    )).all()
    const persistedNodeKeys = new Set(pageRows.map((row) => row.nodeKey))
    // Traversal visits edges adjacent to the previous frontier. Links wholly
    // within the final hop are never visited, so a cheap bounded probe keeps
    // an induced-neighborhood edge count from being presented as exact.
    const outermostNodeKeys = pageRows
      .filter((row) => distances.get(row.nodeKey) === hops)
      .map((row) => row.nodeKey)
    const omittedOutermostEdge = outermostNodeKeys.length === 0
      ? undefined
      : app.db.select({ edgeKey: siteCrawlEdges.edgeKey }).from(siteCrawlEdges).where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        eq(siteCrawlEdges.internal, true),
        isNotNull(siteCrawlEdges.targetNodeKey),
        inArray(siteCrawlEdges.sourceNodeKey, outermostNodeKeys),
        inArray(siteCrawlEdges.targetNodeKey, outermostNodeKeys),
      )).limit(1).get()
    if (omittedOutermostEdge && !seenEdgeKeys.has(omittedOutermostEdge.edgeKey)) {
      omittedEdgeKeys.add(omittedOutermostEdge.edgeKey)
    }
    const nodes = pageRows.map((row) => ({
      ...mapCrawlPage(row),
      distance: distances.get(row.nodeKey) ?? 0,
      relationToFocus: row.nodeKey === focus.nodeKey
        ? 'focus' as const
        : directRelations.get(row.nodeKey) ?? 'transitive' as const,
    })).sort((a, b) => a.distance - b.distance || a.nodeKey.localeCompare(b.nodeKey))
    // Parsed once for the scan, not once per edge: it is a property of the
    // snapshot, and every other call site already reads it that way.
    const subgraphDetection = templateDetectionOf(snapshot.templateDetection)
    const edges = [...edgeRows.values()]
      .filter((edge) => edge.targetNodeKey && persistedNodeKeys.has(edge.sourceNodeKey) && persistedNodeKeys.has(edge.targetNodeKey))
      .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey))
      .map((row) => mapCrawlEdge(row, subgraphDetection))
    const omittedNodes = omittedNodeKeys.size + Math.max(0, distances.size - pageRows.length)
    const omittedEdges = omittedEdgeKeys.size + (queryTruncated ? 1 : 0) + Math.max(0, edgeRows.size - edges.length)
    const truncated = omittedNodes > 0 || omittedEdges > 0
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      complete: snapshot.complete,
      termination: snapshot.termination,
      state: 'ready',
      focusNodeKey: focus.nodeKey,
      focusUrl: focus.url,
      hops,
      totalNodes: nodes.length + omittedNodes,
      totalEdges: edges.length + omittedEdges,
      nodes,
      edges,
      omittedNodes,
      omittedEdges,
      countAccuracy: truncated ? 'lower-bound' : 'exact',
      truncated,
    }
  })

  // GET /projects/:name/technical-aeo/path — directed shortest path over
  // followable internal anchor links, with a hard exploration budget.
  app.get<{
    Params: { name: string }
    Querystring: {
      runId?: string
      fromNodeKey?: string
      fromUrl?: string
      toNodeKey?: string
      toUrl?: string
      maxDepth?: string
    }
  }>('/projects/:name/technical-aeo/path', async (request): Promise<SiteHealthPathResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const maxDepth = parseBoundedLimit(
      request.query.maxDepth,
      SITE_HEALTH_PATH_DEFAULT_MAX_DEPTH,
      SITE_HEALTH_PATH_MAX_DEPTH,
    )
    if (!request.query.toNodeKey && !request.query.toUrl) {
      throw validationError('toNodeKey or toUrl is required')
    }
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return {
        project: project.name, runId: null, state: 'no-crawl', from: null, to: null,
        complete: false, termination: null,
        maxDepth, visitedNodes: 0, nodes: [], edges: [],
      }
    }
    const snapshot = target.snapshot
    const scope = detailScopeFor(project.id, snapshot)
    if (!scope) {
      return {
        project: project.name, runId: snapshot.runId, state: 'details-unavailable', from: null, to: null,
        complete: snapshot.complete, termination: snapshot.termination,
        maxDepth, visitedNodes: 0, nodes: [], edges: [],
      }
    }
    const explicitFrom = Boolean(request.query.fromNodeKey || request.query.fromUrl)
    const fromPage = explicitFrom
      ? pageInScope(scope, { nodeKey: request.query.fromNodeKey, url: request.query.fromUrl })
      : rootPageInScope(scope, snapshot.rootUrl)
    if (!fromPage) throw notFound('Site crawl page', request.query.fromNodeKey ?? request.query.fromUrl ?? snapshot.rootUrl)
    const toPage = pageInScope(scope, { nodeKey: request.query.toNodeKey, url: request.query.toUrl })
    if (!toPage) throw notFound('Site crawl page', request.query.toNodeKey ?? request.query.toUrl!)
    const reference = (row: typeof siteCrawlPages.$inferSelect) => ({
      nodeKey: row.nodeKey,
      url: row.url,
      path: row.path,
    })

    const predecessor = new Map<string, { nodeKey: string; edge: typeof siteCrawlEdges.$inferSelect }>()
    const visited = new Set<string>([fromPage.nodeKey])
    let frontier = [fromPage.nodeKey]
    let found = fromPage.nodeKey === toPage.nodeKey
    let truncated = false

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && !found; depth += 1) {
      const candidates = app.db.select().from(siteCrawlEdges).where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        eq(siteCrawlEdges.internal, true),
        eq(siteCrawlEdges.followable, true),
        eq(siteCrawlEdges.relation, 'anchor'),
        isNotNull(siteCrawlEdges.targetNodeKey),
        inArray(siteCrawlEdges.sourceNodeKey, frontier),
      )).orderBy(asc(siteCrawlEdges.edgeKey))
        .limit(SITE_HEALTH_PATH_MAX_VISITED_NODES + 1)
        .all()
      if (candidates.length > SITE_HEALTH_PATH_MAX_VISITED_NODES) truncated = true

      const candidateTargetKeys = [...new Set(candidates
        .map((edge) => edge.targetNodeKey)
        .filter((nodeKey): nodeKey is string => nodeKey != null))]
      const persistedTargetKeys = new Set(candidateTargetKeys.length === 0 ? [] : app.db
        .select({ nodeKey: siteCrawlPages.nodeKey })
        .from(siteCrawlPages)
        .where(and(
          eq(siteCrawlPages.projectId, scope.projectId),
          eq(siteCrawlPages.runId, scope.runId),
          eq(siteCrawlPages.attemptId, scope.attemptId),
          inArray(siteCrawlPages.nodeKey, candidateTargetKeys),
        )).all().map((row) => row.nodeKey))
      const next = new Set<string>()
      for (const edge of candidates.slice(0, SITE_HEALTH_PATH_MAX_VISITED_NODES)) {
        if (!edge.targetNodeKey || !persistedTargetKeys.has(edge.targetNodeKey) || visited.has(edge.targetNodeKey)) continue
        if (visited.size >= SITE_HEALTH_PATH_MAX_VISITED_NODES) {
          truncated = true
          break
        }
        visited.add(edge.targetNodeKey)
        predecessor.set(edge.targetNodeKey, { nodeKey: edge.sourceNodeKey, edge })
        next.add(edge.targetNodeKey)
        if (edge.targetNodeKey === toPage.nodeKey) {
          found = true
          break
        }
      }
      frontier = [...next].sort()
    }

    if (!found) {
      return {
        project: project.name,
        runId: snapshot.runId,
        complete: snapshot.complete,
        termination: snapshot.termination,
        state: truncated || frontier.length > 0 ? 'truncated' : 'unreachable',
        from: reference(fromPage),
        to: reference(toPage),
        maxDepth,
        visitedNodes: visited.size,
        nodes: [],
        edges: [],
      }
    }

    const pathKeys = [toPage.nodeKey]
    const pathEdges: Array<typeof siteCrawlEdges.$inferSelect> = []
    while (pathKeys[0] !== fromPage.nodeKey) {
      const step = predecessor.get(pathKeys[0]!)
      if (!step) break
      pathEdges.unshift(step.edge)
      pathKeys.unshift(step.nodeKey)
    }
    const pathRows = app.db.select().from(siteCrawlPages).where(and(
      eq(siteCrawlPages.projectId, scope.projectId),
      eq(siteCrawlPages.runId, scope.runId),
      eq(siteCrawlPages.attemptId, scope.attemptId),
      inArray(siteCrawlPages.nodeKey, pathKeys),
    )).all()
    const pageByKey = new Map(pathRows.map((row) => [row.nodeKey, row]))
    const pathDetection = templateDetectionOf(snapshot.templateDetection)
    return {
      project: project.name,
      runId: snapshot.runId,
      complete: snapshot.complete,
      termination: snapshot.termination,
      state: 'found',
      from: reference(fromPage),
      to: reference(toPage),
      maxDepth,
      visitedNodes: visited.size,
      nodes: pathKeys.map((key) => mapCrawlPage(pageByKey.get(key)!)),
      edges: pathEdges.map((row) => mapCrawlEdge(row, pathDetection)),
    }
  })

  // GET /projects/:name/technical-aeo/changes — exact canonical page/link
  // changes between two immutable complete snapshots. ForceAtlas2 x/y are not
  // part of identity and never create a change.
  app.get<{
    Params: { name: string }
    Querystring: {
      fromRunId?: string
      toRunId?: string
      scope?: string
      change?: string
      cursor?: string
      limit?: string
    }
  }>('/projects/:name/technical-aeo/changes', async (request): Promise<SiteHealthChangesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const scopeFilter = request.query.scope ?? 'all'
    if (scopeFilter !== 'all' && scopeFilter !== 'pages' && scopeFilter !== 'links') {
      throw validationError('scope must be all, pages, or links')
    }
    const changeFilter = request.query.change ?? 'all'
    if (changeFilter !== 'all' && changeFilter !== 'added' && changeFilter !== 'removed' && changeFilter !== 'changed') {
      throw validationError('change must be all, added, removed, or changed')
    }

    const completeSnapshotFilters = [
      eq(siteCrawlSnapshots.projectId, project.id),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      eq(runs.status, RunStatuses.completed),
      eq(siteCrawlSnapshots.complete, true),
      notProbeRun(),
    ]
    const afterTarget = request.query.toRunId
      ? resolveCrawl(project.id, request.query.toRunId)
      : app.db.select({ snapshot: siteCrawlSnapshots, runStatus: runs.status })
        .from(siteCrawlSnapshots)
        .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
        .where(and(...completeSnapshotFilters))
        .orderBy(desc(siteCrawlSnapshots.createdAt), desc(siteCrawlSnapshots.runId))
        .limit(1)
        .get()
    if (request.query.toRunId && !afterTarget) throw notFound('Site crawl run', request.query.toRunId)
    const beforeTarget = request.query.fromRunId
      ? resolveCrawl(project.id, request.query.fromRunId)
      : afterTarget
        ? app.db.select({ snapshot: siteCrawlSnapshots, runStatus: runs.status })
          .from(siteCrawlSnapshots)
          .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
          .where(and(
            ...completeSnapshotFilters,
            or(
              lt(siteCrawlSnapshots.createdAt, afterTarget.snapshot.createdAt),
              and(
                eq(siteCrawlSnapshots.createdAt, afterTarget.snapshot.createdAt),
                lt(siteCrawlSnapshots.runId, afterTarget.snapshot.runId),
              ),
            ),
          ))
          .orderBy(desc(siteCrawlSnapshots.createdAt), desc(siteCrawlSnapshots.runId))
          .limit(1)
          .get()
        : undefined
    if (request.query.fromRunId && !beforeTarget) throw notFound('Site crawl run', request.query.fromRunId)
    if (!afterTarget) {
      return { project: project.name, state: 'unavailable', reason: 'no-crawl', fromRunId: null, toRunId: null }
    }
    if (!beforeTarget) {
      return {
        project: project.name, state: 'unavailable', reason: 'insufficient-history',
        fromRunId: null, toRunId: afterTarget.snapshot.runId,
      }
    }

    const beforeSnapshot = beforeTarget.snapshot
    const afterSnapshot = afterTarget.snapshot
    if (beforeSnapshot.runId === afterSnapshot.runId) {
      throw validationError('fromRunId and toRunId must identify different crawls')
    }
    const crawlOrder = beforeSnapshot.createdAt.localeCompare(afterSnapshot.createdAt)
    if (crawlOrder > 0 || (crawlOrder === 0 && beforeSnapshot.runId >= afterSnapshot.runId)) {
      throw validationError('fromRunId must identify a crawl earlier than toRunId')
    }
    if (!beforeSnapshot.complete || !afterSnapshot.complete
      || beforeTarget.runStatus !== RunStatuses.completed || afterTarget.runStatus !== RunStatuses.completed) {
      return {
        project: project.name, state: 'unavailable', reason: 'partial-not-comparable',
        fromRunId: beforeSnapshot.runId, toRunId: afterSnapshot.runId,
      }
    }
    const beforeScope = detailScopeFor(project.id, beforeSnapshot)
    const afterScope = detailScopeFor(project.id, afterSnapshot)
    if (!beforeScope || !afterScope) {
      return {
        project: project.name, state: 'unavailable', reason: 'details-unavailable',
        fromRunId: beforeSnapshot.runId, toRunId: afterSnapshot.runId,
      }
    }

    const versions = {
      crawlSchema: [beforeSnapshot.crawlSchemaVersion, afterSnapshot.crawlSchemaVersion],
      normalization: [beforeSnapshot.normalizationVersion, afterSnapshot.normalizationVersion],
      indexability: [beforeSnapshot.indexabilityVersion, afterSnapshot.indexabilityVersion],
      linkScore: [beforeSnapshot.linkScoreVersion, afterSnapshot.linkScoreVersion],
    } as const
    const mismatchedVersions = Object.entries(versions)
      .filter(([, pair]) => pair[0] !== pair[1])
      .map(([name]) => name)
    if (mismatchedVersions.length > 0) {
      return {
        project: project.name, state: 'incompatible', reason: 'incompatible-versions',
        fromRunId: beforeSnapshot.runId, toRunId: afterSnapshot.runId, mismatchedVersions,
      }
    }

    const cursor = decodeSiteHealthChangesCursor(request.query.cursor, {
      fromRunId: beforeSnapshot.runId,
      toRunId: afterSnapshot.runId,
      scope: scopeFilter,
      change: changeFilter,
    })
    const loadSummary = (): SiteHealthChangesSummary => {
      type AfterCounts = { added: number; changed: number }
      type RemovedCount = { removed: number }
      const includeAdded = changeFilter === 'all' || changeFilter === 'added'
      const includeRemoved = changeFilter === 'all' || changeFilter === 'removed'
      const includeChanged = changeFilter === 'all' || changeFilter === 'changed'
      const zero = (): SiteHealthChangeCounts => ({ added: 0, removed: 0, changed: 0 })
      const summary: SiteHealthChangesSummary = { pages: zero(), links: zero() }

      if (scopeFilter !== 'links') {
        if (includeAdded || includeChanged) {
          const addedExpression = includeAdded
            ? sql`COALESCE(SUM(CASE WHEN previous.id IS NULL THEN 1 ELSE 0 END), 0)`
            : sql`0`
          const changedExpression = includeChanged
            ? sql`COALESCE(SUM(CASE WHEN previous.id IS NOT NULL AND ${PAGE_CHANGE_PREDICATE} THEN 1 ELSE 0 END), 0)`
            : sql`0`
          const [counts = { added: 0, changed: 0 }] = app.db.all<AfterCounts>(sql`
            SELECT ${addedExpression} AS added, ${changedExpression} AS changed
            FROM site_crawl_pages AS current
            LEFT JOIN site_crawl_pages AS previous
              ON previous.project_id = ${beforeScope.projectId}
              AND previous.run_id = ${beforeScope.runId}
              AND previous.attempt_id = ${beforeScope.attemptId}
              AND previous.node_key = current.node_key
            WHERE current.project_id = ${afterScope.projectId}
              AND current.run_id = ${afterScope.runId}
              AND current.attempt_id = ${afterScope.attemptId}
          `)
          summary.pages.added = Number(counts.added)
          summary.pages.changed = Number(counts.changed)
        }
        if (includeRemoved) {
          const [counts = { removed: 0 }] = app.db.all<RemovedCount>(sql`
            SELECT COUNT(*) AS removed
            FROM site_crawl_pages AS previous
            LEFT JOIN site_crawl_pages AS current
              ON current.project_id = ${afterScope.projectId}
              AND current.run_id = ${afterScope.runId}
              AND current.attempt_id = ${afterScope.attemptId}
              AND current.node_key = previous.node_key
            WHERE previous.project_id = ${beforeScope.projectId}
              AND previous.run_id = ${beforeScope.runId}
              AND previous.attempt_id = ${beforeScope.attemptId}
              AND current.id IS NULL
          `)
          summary.pages.removed = Number(counts.removed)
        }
      }

      if (scopeFilter !== 'pages') {
        if (includeAdded || includeChanged) {
          const addedExpression = includeAdded
            ? sql`COALESCE(SUM(CASE WHEN previous.id IS NULL THEN 1 ELSE 0 END), 0)`
            : sql`0`
          const changedExpression = includeChanged
            ? sql`COALESCE(SUM(CASE WHEN previous.id IS NOT NULL AND ${LINK_CHANGE_PREDICATE} THEN 1 ELSE 0 END), 0)`
            : sql`0`
          const [counts = { added: 0, changed: 0 }] = app.db.all<AfterCounts>(sql`
            SELECT ${addedExpression} AS added, ${changedExpression} AS changed
            FROM site_crawl_edges AS current
            LEFT JOIN site_crawl_edges AS previous
              ON previous.project_id = ${beforeScope.projectId}
              AND previous.run_id = ${beforeScope.runId}
              AND previous.attempt_id = ${beforeScope.attemptId}
              AND previous.internal = 1
              AND previous.edge_key = current.edge_key
            WHERE current.project_id = ${afterScope.projectId}
              AND current.run_id = ${afterScope.runId}
              AND current.attempt_id = ${afterScope.attemptId}
              AND current.internal = 1
          `)
          summary.links.added = Number(counts.added)
          summary.links.changed = Number(counts.changed)
        }
        if (includeRemoved) {
          const [counts = { removed: 0 }] = app.db.all<RemovedCount>(sql`
            SELECT COUNT(*) AS removed
            FROM site_crawl_edges AS previous
            LEFT JOIN site_crawl_edges AS current
              ON current.project_id = ${afterScope.projectId}
              AND current.run_id = ${afterScope.runId}
              AND current.attempt_id = ${afterScope.attemptId}
              AND current.internal = 1
              AND current.edge_key = previous.edge_key
            WHERE previous.project_id = ${beforeScope.projectId}
              AND previous.run_id = ${beforeScope.runId}
              AND previous.attempt_id = ${beforeScope.attemptId}
              AND previous.internal = 1
              AND current.id IS NULL
          `)
          summary.links.removed = Number(counts.removed)
        }
      }
      return summary
    }
    const summary = cursor ? null : loadSummary()
    const limit = parseBoundedLimit(request.query.limit, SITE_HEALTH_CHANGES_DEFAULT_LIMIT, SITE_HEALTH_CHANGES_MAX_LIMIT)
    const sumCounts = (counts: SiteHealthChangeCounts): number => counts.added + counts.removed + counts.changed
    const total = summary
      ? sumCounts(summary.pages) + sumCounts(summary.links)
      : null
    const collectEntity = (
      entity: 'page' | 'link',
      afterKey: string,
      wanted: number,
    ): SiteHealthChangeKeyRow[] => {
      if (wanted <= 0) return []
      const includeAfter = changeFilter === 'all' || changeFilter === 'added' || changeFilter === 'changed'
      const includeRemoved = changeFilter === 'all' || changeFilter === 'removed'
      const table = entity === 'page' ? 'site_crawl_pages' : 'site_crawl_edges'
      const keyColumn = entity === 'page' ? 'node_key' : 'edge_key'
      const internalCurrent = entity === 'link' ? sql`AND current.internal = 1` : sql``
      const internalPreviousJoin = entity === 'link' ? sql`AND previous.internal = 1` : sql``
      const internalPrevious = entity === 'link' ? sql`AND previous.internal = 1` : sql``
      const internalCurrentJoin = entity === 'link' ? sql`AND current.internal = 1` : sql``
      const difference = entity === 'page' ? PAGE_CHANGE_PREDICATE : LINK_CHANGE_PREDICATE
      const afterKind = changeFilter === 'added'
        ? sql`previous.id IS NULL`
        : changeFilter === 'changed'
          ? sql`previous.id IS NOT NULL AND ${difference}`
          : sql`previous.id IS NULL OR (previous.id IS NOT NULL AND ${difference})`
      const afterRows = includeAfter ? app.db.all<SiteHealthChangeKeyRow>(sql`
        SELECT ${entity} AS entity,
          CASE WHEN previous.id IS NULL THEN 'added' ELSE 'changed' END AS change,
          current.${sql.raw(keyColumn)} AS key
        FROM ${sql.raw(table)} AS current
        LEFT JOIN ${sql.raw(table)} AS previous
          ON previous.project_id = ${beforeScope.projectId}
          AND previous.run_id = ${beforeScope.runId}
          AND previous.attempt_id = ${beforeScope.attemptId}
          ${internalPreviousJoin}
          AND previous.${sql.raw(keyColumn)} = current.${sql.raw(keyColumn)}
        WHERE current.project_id = ${afterScope.projectId}
          AND current.run_id = ${afterScope.runId}
          AND current.attempt_id = ${afterScope.attemptId}
          ${internalCurrent}
          AND current.${sql.raw(keyColumn)} > ${afterKey}
          AND (${afterKind})
        ORDER BY current.${sql.raw(keyColumn)} ASC
        LIMIT ${wanted}
      `) : []
      const removedRows = includeRemoved ? app.db.all<SiteHealthChangeKeyRow>(sql`
        SELECT ${entity} AS entity, 'removed' AS change, previous.${sql.raw(keyColumn)} AS key
        FROM ${sql.raw(table)} AS previous
        LEFT JOIN ${sql.raw(table)} AS current
          ON current.project_id = ${afterScope.projectId}
          AND current.run_id = ${afterScope.runId}
          AND current.attempt_id = ${afterScope.attemptId}
          ${internalCurrentJoin}
          AND current.${sql.raw(keyColumn)} = previous.${sql.raw(keyColumn)}
        WHERE previous.project_id = ${beforeScope.projectId}
          AND previous.run_id = ${beforeScope.runId}
          AND previous.attempt_id = ${beforeScope.attemptId}
          ${internalPrevious}
          AND previous.${sql.raw(keyColumn)} > ${afterKey}
          AND current.id IS NULL
        ORDER BY previous.${sql.raw(keyColumn)} ASC
        LIMIT ${wanted}
      `) : []
      const merged: SiteHealthChangeKeyRow[] = []
      let afterIndex = 0
      let removedIndex = 0
      while (merged.length < wanted && (afterIndex < afterRows.length || removedIndex < removedRows.length)) {
        const afterRow = afterRows.at(afterIndex)
        const removedRow = removedRows.at(removedIndex)
        if (!removedRow || (afterRow && compareChangeKeys(afterRow, removedRow) <= 0)) {
          merged.push(afterRow!)
          afterIndex += 1
        } else {
          merged.push(removedRow)
          removedIndex += 1
        }
      }
      return merged
    }

    const keyRows: SiteHealthChangeKeyRow[] = []
    const wanted = limit + 1
    if (scopeFilter !== 'links' && cursor?.entity !== 'link') {
      keyRows.push(...collectEntity('page', cursor?.entity === 'page' ? cursor.key : '', wanted))
    }
    if (keyRows.length < wanted && scopeFilter !== 'pages') {
      keyRows.push(...collectEntity('link', cursor?.entity === 'link' ? cursor.key : '', wanted - keyRows.length))
    }
    const visibleKeys = keyRows.slice(0, limit)
    const pageKeys = visibleKeys.filter((row) => row.entity === 'page').map((row) => row.key)
    const linkKeys = visibleKeys.filter((row) => row.entity === 'link').map((row) => row.key)
    const pageRowsFor = (scope: CrawlDetailScope) => pageKeys.length === 0 ? [] : app.db
      .select().from(siteCrawlPages).where(and(
        eq(siteCrawlPages.projectId, scope.projectId),
        eq(siteCrawlPages.runId, scope.runId),
        eq(siteCrawlPages.attemptId, scope.attemptId),
        inArray(siteCrawlPages.nodeKey, pageKeys),
      )).all()
    const edgeRowsFor = (scope: CrawlDetailScope) => linkKeys.length === 0 ? [] : app.db
      .select().from(siteCrawlEdges).where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        eq(siteCrawlEdges.internal, true),
        inArray(siteCrawlEdges.edgeKey, linkKeys),
      )).all()
    const beforePages = new Map(pageRowsFor(beforeScope).map((row) => [row.nodeKey, mapCrawlPage(row)]))
    const afterPages = new Map(pageRowsFor(afterScope).map((row) => [row.nodeKey, mapCrawlPage(row)]))
    // Each side is attributed against ITS OWN scan. The two can disagree: a
    // re-crawl on a newer engine classifies by placement while the older side
    // is still ubiquity, and a link that "changed" because the rule changed
    // must be readable as exactly that.
    const beforeDetection = templateDetectionOf(beforeSnapshot.templateDetection)
    const afterDetection = templateDetectionOf(afterSnapshot.templateDetection)
    const beforeLinks = new Map(edgeRowsFor(beforeScope).map((row) => [row.edgeKey, mapCrawlEdge(row, beforeDetection)]))
    const afterLinks = new Map(edgeRowsFor(afterScope).map((row) => [row.edgeKey, mapCrawlEdge(row, afterDetection)]))
    const changes: SiteHealthChangeRecordDto[] = visibleKeys.map((row) => {
      if (row.entity === 'page') {
        const before = beforePages.get(row.key) ?? null
        const after = afterPages.get(row.key) ?? null
        const pageChangedFields = changedFields(before, after, PAGE_CHANGE_FIELDS)
        if (before && after && before.healthState !== after.healthState) pageChangedFields.push('healthState')
        return {
          entity: 'page', change: row.change, key: row.key,
          changedFields: pageChangedFields, before, after,
        }
      }
      const before = beforeLinks.get(row.key) ?? null
      const after = afterLinks.get(row.key) ?? null
      return {
        entity: 'link', change: row.change, key: row.key,
        changedFields: changedFields(before, after, LINK_CHANGE_FIELDS), before, after,
      }
    })
    return {
      project: project.name,
      state: 'ready',
      fromRunId: beforeSnapshot.runId,
      toRunId: afterSnapshot.runId,
      versions: {
        crawlSchema: afterSnapshot.crawlSchemaVersion,
        normalization: afterSnapshot.normalizationVersion,
        indexability: afterSnapshot.indexabilityVersion,
        linkScore: afterSnapshot.linkScoreVersion,
      },
      filters: { scope: scopeFilter, change: changeFilter },
      summaryState: cursor ? 'omitted-on-continuation' : 'exact',
      summary,
      total,
      nextCursor: keyRows.length > limit && visibleKeys.length > 0
        ? encodeSiteHealthChangesCursor({
          v: 1,
          fromRunId: beforeSnapshot.runId,
          toRunId: afterSnapshot.runId,
          scope: scopeFilter,
          change: changeFilter,
          entity: visibleKeys.at(-1)!.entity,
          key: visibleKeys.at(-1)!.key,
        })
        : null,
      changes,
    }
  })

  // GET /projects/:name/technical-aeo/crawl/pages/audit — one page's exact
  // weighted factors and independent critical defects. Evidence is loaded on
  // selection so the 20k-node visualization DTO stays compact.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: unknown; nodeKey?: unknown; url?: unknown }
  }>('/projects/:name/technical-aeo/crawl/pages/audit', async (request): Promise<SiteCrawlPageAuditDto> => {
    const project = resolveProject(app.db, request.params.name)
    const scalarQueryString = (value: unknown, name: string): string | undefined => {
      if (value === undefined) return undefined
      if (typeof value !== 'string') throw validationError(`${name} must be provided once`)
      return value
    }
    const runId = scalarQueryString(request.query.runId, 'runId')
    const nodeKey = scalarQueryString(request.query.nodeKey, 'nodeKey')?.trim()
    const url = scalarQueryString(request.query.url, 'url')?.trim()
    if (Number(Boolean(nodeKey)) + Number(Boolean(url)) !== 1) {
      throw validationError('Provide exactly one of nodeKey or url')
    }

    const target = resolveCrawl(project.id, runId)
    if (!target) {
      assertKnownAuditRun(project.id, runId)
      return { state: 'no-crawl', project: project.name, runId: null }
    }
    const snapshot = target.snapshot
    const provenance = {
      project: project.name,
      runId: snapshot.runId,
      complete: snapshot.complete,
      termination: snapshot.termination,
    }
    const scope = detailScopeFor(project.id, snapshot)
    if (!scope) return { state: 'details-unavailable', ...provenance }

    const page = pageInScope(scope, nodeKey ? { nodeKey } : { url: url! })
    if (!page) return { state: 'not-found', ...provenance }
    const identity = {
      nodeKey: page.nodeKey,
      url: page.url,
      auditState: page.auditState,
    }
    if (page.auditScore == null) {
      return {
        state: 'not-audited',
        ...provenance,
        ...identity,
        auditScore: null,
        factors: [],
        criticalDefects: [],
      }
    }

    return {
      state: 'ready',
      ...provenance,
      ...identity,
      auditScore: page.auditScore,
      ...mapCrawlPageAuditEvidence(page),
    }
  })

  // GET /projects/:name/technical-aeo/crawl/pages — filterable, cursor-paged
  // crawl nodes. A crawl summary may exist before detail persistence finishes.
  app.get<{
    Params: { name: string }
    Querystring: {
      runId?: string
      cursor?: string
      limit?: string
      inventoryEligible?: string
      fetchState?: string
      indexabilityState?: string
      healthState?: string
      auditState?: string
      nodeKey?: string
      sort?: string
    }
  }>('/projects/:name/technical-aeo/crawl/pages', async (request): Promise<SiteCrawlPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return { project: project.name, hasCrawlData: false, runId: null, total: 0, nextCursor: null, healthStateFilter: null, pages: [] }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return { project: project.name, hasCrawlData: true, runId: snapshot.runId, total: 0, nextCursor: null, healthStateFilter: null, pages: [] }
    }

    const filters = [
      eq(siteCrawlPages.projectId, project.id),
      eq(siteCrawlPages.runId, snapshot.runId),
      eq(siteCrawlPages.attemptId, snapshot.attemptId),
    ]
    // Addressing one page by key is the same bounded read as the list, so a
    // client that already holds a node key never has to page to find its row.
    if (request.query.nodeKey) filters.push(eq(siteCrawlPages.nodeKey, request.query.nodeKey))
    const inventoryEligible = parseBoolean(request.query.inventoryEligible)
    if (inventoryEligible != null) filters.push(eq(siteCrawlPages.inventoryEligible, inventoryEligible))
    if (request.query.fetchState) filters.push(eq(siteCrawlPages.fetchState, request.query.fetchState))
    if (request.query.indexabilityState) filters.push(eq(siteCrawlPages.indexabilityState, request.query.indexabilityState))
    if (request.query.auditState) filters.push(eq(siteCrawlPages.auditState, request.query.auditState))
    const healthState = parseSiteHealthState(request.query.healthState)
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const orderBy = request.query.sort === 'score-desc'
      ? [desc(siteCrawlPages.auditScore), asc(siteCrawlPages.nodeKey)] as const
      : request.query.sort === 'score-asc'
        ? [asc(siteCrawlPages.auditScore), asc(siteCrawlPages.nodeKey)] as const
        : request.query.sort === 'path'
          ? [asc(siteCrawlPages.path), asc(siteCrawlPages.nodeKey)] as const
          : [asc(siteCrawlPages.url), asc(siteCrawlPages.nodeKey)] as const

    // Health state is written at publish time by the contract's own
    // `deriveSiteHealthState` and backfilled by migration 130, so filtering it
    // is an ordinary indexed WHERE. A NULL can still appear if an older engine
    // image wrote the page after that migration; recomputing here would be the
    // O(all pages) read this replaced, and deriving it in SQL would be a second
    // implementation that drifts. Say the filter did not run instead.
    let healthStateFilter: SiteCrawlPagesFilterState | null = null
    if (healthState) {
      // Scoped to the SNAPSHOT, never to the request's other filters. A probe
      // narrowed by nodeKey (or fetch state, or audit state) answers about one
      // slice, so the same snapshot could report `applied` to the inspector and
      // `unavailable-legacy-scan` to the list, and `applied` would silently
      // omit legacy rows that belong in the result.
      const legacyRow = app.db.select({ id: siteCrawlPages.id }).from(siteCrawlPages)
        .where(and(
          eq(siteCrawlPages.projectId, project.id),
          eq(siteCrawlPages.runId, snapshot.runId),
          eq(siteCrawlPages.attemptId, snapshot.attemptId),
          isNull(siteCrawlPages.healthState),
        )).limit(1).get()
      healthStateFilter = legacyRow ? 'unavailable-legacy-scan' : 'applied'
      if (healthStateFilter === 'applied') filters.push(eq(siteCrawlPages.healthState, healthState))
    }
    if (healthStateFilter === 'unavailable-legacy-scan') {
      return {
        project: project.name,
        hasCrawlData: true,
        runId: snapshot.runId,
        total: 0,
        nextCursor: null,
        healthStateFilter,
        pages: [],
      }
    }

    const where = and(...filters)
    const total = app.db.select({ value: count() }).from(siteCrawlPages).where(where).get()?.value ?? 0
    const rows = app.db.select().from(siteCrawlPages).where(where).orderBy(...orderBy).limit(limit).offset(offset).all()
    const nextOffset = offset + rows.length
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      healthStateFilter,
      pages: rows.map(mapCrawlPage),
    }
  })

  // GET /projects/:name/technical-aeo/structure — one path level only. This
  // deliberately cannot materialize an unbounded site tree.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; parentPath?: string; cursor?: string; limit?: string }
  }>('/projects/:name/technical-aeo/structure', async (request): Promise<SiteCrawlStructureResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const parentPath = normalizeParentPath(request.query.parentPath)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return { project: project.name, hasCrawlData: false, runId: null, parentPath, nextCursor: null, children: [] }
    }
    const snapshot = target.snapshot
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return { project: project.name, hasCrawlData: true, runId: snapshot.runId, parentPath, nextCursor: null, children: [] }
    }

    // A crawl cannot persist more than MAX_STRUCTURE_SOURCE_ROWS pages. Read
    // only the columns needed for a one-level projection, then aggregate in
    // JS. This keeps delimiter parsing dialect-neutral and treats `%` / `_`
    // literally instead of giving them LIKE semantics.
    const sourceRows = app.db
      .select({
        path: siteCrawlPages.path,
        url: siteCrawlPages.url,
        inventoryEligible: siteCrawlPages.inventoryEligible,
        fetchState: siteCrawlPages.fetchState,
      })
      .from(siteCrawlPages)
      .where(and(
        eq(siteCrawlPages.projectId, project.id),
        eq(siteCrawlPages.runId, snapshot.runId),
        eq(siteCrawlPages.attemptId, snapshot.attemptId),
      ))
      .limit(MAX_STRUCTURE_SOURCE_ROWS + 1)
      .all()
    if (sourceRows.length > MAX_STRUCTURE_SOURCE_ROWS) {
      throw validationError(`Persisted crawl exceeds the ${MAX_STRUCTURE_SOURCE_ROWS}-page structure limit`)
    }

    const children = new Map<string, {
      url: string | null
      hasPage: boolean
      pageCount: number
      inventoryEligibleCount: number
      fetchedCount: number
    }>()
    for (const row of sourceRows) {
      const childPath = structureChildPath(parentPath, row.path)
      if (!childPath) continue
      const child = children.get(childPath) ?? {
        url: null,
        hasPage: false,
        pageCount: 0,
        inventoryEligibleCount: 0,
        fetchedCount: 0,
      }
      child.pageCount++
      if (row.inventoryEligible) child.inventoryEligibleCount++
      if (FETCHED_SITE_CRAWL_STATES.has(row.fetchState)) child.fetchedCount++
      if (structureHierarchyPath(row.path) === childPath) {
        child.hasPage = true
        // Preserve the old SQL `max(url)` tie break when both `/docs` and
        // `/docs/` are observed as distinct URL identities.
        if (child.url == null || row.url > child.url) child.url = row.url
      }
      children.set(childPath, child)
    }

    const limit = parseBoundedLimit(request.query.limit, 50, 100)
    const offset = decodeCursor(request.query.cursor)
    const sortedChildren = [...children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
    const page = sortedChildren.slice(offset, offset + limit + 1)
    const hasMore = page.length > limit
    const visible = hasMore ? page.slice(0, limit) : page
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      parentPath,
      nextCursor: hasMore ? encodeCursor(offset + visible.length) : null,
      children: visible.map(([path, child]) => ({
        path,
        url: child.url,
        hasPage: child.hasPage,
        pageCount: child.pageCount,
        inventoryEligibleCount: child.inventoryEligibleCount,
        fetchedCount: child.fetchedCount,
      })),
    }
  })

  // GET /projects/:name/technical-aeo/internal-links — cursor-paged internal
  // edges, never the full graph in one response.
  app.get<{
    Params: { name: string }
    Querystring: {
      runId?: string
      cursor?: string
      limit?: string
      sourceUrl?: string
      targetUrl?: string
      followable?: string
      linkKind?: string
    }
  }>('/projects/:name/technical-aeo/internal-links', async (request): Promise<SiteCrawlInternalLinksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const linkKind = parseLinkKind(request.query.linkKind)
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return {
        project: project.name, hasCrawlData: false, runId: null, total: 0, nextCursor: null,
        templateDetection: SiteHealthTemplateDetections['unavailable-legacy-scan'], linkKind, edges: [],
      }
    }
    const snapshot = target.snapshot
    const templateDetection = templateDetectionOf(snapshot.templateDetection)
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, total: 0, nextCursor: null,
        templateDetection, linkKind, edges: [],
      }
    }

    const filters: (SQL | undefined)[] = [
      eq(siteCrawlEdges.projectId, project.id),
      eq(siteCrawlEdges.runId, snapshot.runId),
      eq(siteCrawlEdges.attemptId, snapshot.attemptId),
      eq(siteCrawlEdges.internal, true),
      linkKindFilter(linkKind),
    ]
    if (request.query.sourceUrl) filters.push(eq(siteCrawlEdges.sourceUrl, request.query.sourceUrl))
    if (request.query.targetUrl) filters.push(eq(siteCrawlEdges.targetUrl, request.query.targetUrl))
    const followable = parseBoolean(request.query.followable)
    if (followable != null) filters.push(eq(siteCrawlEdges.followable, followable))
    const where = and(...filters)
    const total = app.db.select({ value: count() }).from(siteCrawlEdges).where(where).get()?.value ?? 0
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const rows = app.db
      .select()
      .from(siteCrawlEdges)
      .where(where)
      .orderBy(asc(siteCrawlEdges.edgeKey))
      .limit(limit)
      .offset(offset)
      .all()
    const nextOffset = offset + rows.length
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      templateDetection,
      linkKind,
      edges: rows.map((row) => mapCrawlEdge(row, templateDetection)),
    }
  })

  // GET /projects/:name/technical-aeo/internal-links/neighbors — a bounded
  // local graph neighborhood for one canonical node/URL.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; nodeKey?: string; url?: string; limit?: string; linkKind?: string }
  }>('/projects/:name/technical-aeo/internal-links/neighbors', async (request): Promise<SiteCrawlNeighborsResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const linkKind = parseLinkKind(request.query.linkKind)
    if (!request.query.nodeKey && !request.query.url) {
      throw validationError('Provide nodeKey or url')
    }
    const target = resolveCrawl(project.id, request.query.runId)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return {
        project: project.name, hasCrawlData: false, runId: null, nodeKey: request.query.nodeKey ?? null, url: request.query.url ?? null,
        templateDetection: SiteHealthTemplateDetections['unavailable-legacy-scan'], linkKind,
        inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
      }
    }
    const snapshot = target.snapshot
    const templateDetection = templateDetectionOf(snapshot.templateDetection)
    if (!snapshot.detailsAvailable || !snapshot.attemptId) {
      return {
        project: project.name, hasCrawlData: true, runId: snapshot.runId, nodeKey: request.query.nodeKey ?? null, url: request.query.url ?? null,
        templateDetection, linkKind,
        inbound: [], outbound: [], inboundTruncated: false, outboundTruncated: false,
      }
    }
    const scope = [
      eq(siteCrawlEdges.projectId, project.id),
      eq(siteCrawlEdges.runId, snapshot.runId),
      eq(siteCrawlEdges.attemptId, snapshot.attemptId),
      eq(siteCrawlEdges.internal, true),
      linkKindFilter(linkKind),
    ]
    const inboundMatch = request.query.nodeKey && request.query.url
      ? or(eq(siteCrawlEdges.targetNodeKey, request.query.nodeKey), eq(siteCrawlEdges.targetUrl, request.query.url))
      : request.query.nodeKey
        ? eq(siteCrawlEdges.targetNodeKey, request.query.nodeKey)
        : eq(siteCrawlEdges.targetUrl, request.query.url!)
    const outboundMatch = request.query.nodeKey && request.query.url
      ? or(eq(siteCrawlEdges.sourceNodeKey, request.query.nodeKey), eq(siteCrawlEdges.sourceUrl, request.query.url))
      : request.query.nodeKey
        ? eq(siteCrawlEdges.sourceNodeKey, request.query.nodeKey)
        : eq(siteCrawlEdges.sourceUrl, request.query.url!)
    const limit = parseBoundedLimit(request.query.limit, 50, 100)
    const inboundRows = app.db.select().from(siteCrawlEdges).where(and(...scope, inboundMatch)).orderBy(asc(siteCrawlEdges.edgeKey)).limit(limit + 1).all()
    const outboundRows = app.db.select().from(siteCrawlEdges).where(and(...scope, outboundMatch)).orderBy(asc(siteCrawlEdges.edgeKey)).limit(limit + 1).all()
    return {
      project: project.name,
      hasCrawlData: true,
      runId: snapshot.runId,
      nodeKey: request.query.nodeKey ?? null,
      url: request.query.url ?? null,
      templateDetection,
      linkKind,
      inbound: inboundRows.slice(0, limit).map((row) => mapCrawlEdge(row, templateDetection)),
      outbound: outboundRows.slice(0, limit).map((row) => mapCrawlEdge(row, templateDetection)),
      inboundTruncated: inboundRows.length > limit,
      outboundTruncated: outboundRows.length > limit,
    }
  })

  // GET /projects/:name/technical-aeo/dead-links — no crawl opt-in is a
  // distinct state, never a deceptive empty list.
  app.get<{
    Params: { name: string }
    Querystring: { runId?: string; cursor?: string; limit?: string }
  }>('/projects/:name/technical-aeo/dead-links', async (request): Promise<SiteCrawlDeadLinksResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const target = resolveCrawl(project.id, request.query.runId)
    const legacyAuditAvailable = hasLegacyAudit(project.id)
    if (!target) {
      assertKnownAuditRun(project.id, request.query.runId)
      return { project: project.name, runId: null, state: 'unavailable', legacyAuditAvailable }
    }
    const snapshot = target.snapshot
    if (!snapshot.checkDeadLinks || snapshot.deadLinkState === 'disabled') {
      return { project: project.name, runId: snapshot.runId, state: 'disabled', checkDeadLinks: false }
    }
    if (snapshot.deadLinkState === 'unavailable') {
      return { project: project.name, runId: snapshot.runId, state: 'unavailable', legacyAuditAvailable }
    }
    if (!snapshot.attemptId) {
      return { project: project.name, runId: snapshot.runId, state: 'partial', checkDeadLinks: true, checked: snapshot.deadLinksChecked, found: snapshot.deadLinksFound, unverified: snapshot.deadLinksUnverified, total: 0, nextCursor: null, deadLinks: [] }
    }
    const where = and(
      eq(siteCrawlFindings.projectId, project.id),
      eq(siteCrawlFindings.runId, snapshot.runId),
      eq(siteCrawlFindings.attemptId, snapshot.attemptId),
      eq(siteCrawlFindings.findingType, 'dead-link'),
      // Belt and braces on the client-facing surface: a row without a status
      // code is not evidence of a broken link, and this response is where such
      // a row would be read as one. Migration 140 removed every stored row that
      // looked like this and the writer can no longer produce one, so this
      // matches nothing today — it is here because a rolling deploy can still
      // run an older writer against a migrated database for a few minutes, and
      // a fabricated broken link shown to a client is not worth the saved
      // predicate. Applied to `total` as well as the rows, or the count would
      // promise a page the list cannot fill.
      isNotNull(sql`json_extract(${siteCrawlFindings.evidence}, '$.statusCode')`),
    )
    const total = app.db.select({ value: count() }).from(siteCrawlFindings).where(where).get()?.value ?? 0
    const limit = parseBoundedLimit(request.query.limit, 100, 200)
    const offset = decodeCursor(request.query.cursor)
    const rows = app.db.select().from(siteCrawlFindings).where(where).orderBy(asc(siteCrawlFindings.findingKey)).limit(limit).offset(offset).all()
    const nextOffset = offset + rows.length
    const deadLinks = rows.map((row) => ({
      findingKey: row.findingKey,
      severity: row.severity,
      sourceNodeKey: row.sourceNodeKey,
      sourceUrl: row.sourceUrl,
      targetNodeKey: row.targetNodeKey,
      targetUrl: row.targetUrl,
      evidence: row.evidence,
    }))
    const state = snapshot.deadLinkState === 'complete' ? 'complete' as const : 'partial' as const
    return {
      project: project.name,
      runId: snapshot.runId,
      state,
      checkDeadLinks: true,
      checked: snapshot.deadLinksChecked,
      found: snapshot.deadLinksFound,
      unverified: snapshot.deadLinksUnverified,
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      deadLinks,
    }
  })

  // GET /projects/:name/technical-aeo/runs — Site Health scan history. Every
  // non-probe site-audit run is listed, including the legacy score-only ones,
  // so selecting a scan never depends on guessing which runs kept a crawl.
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/technical-aeo/runs', async (request): Promise<SiteHealthScansResponseDto> => {
    const project = resolveProject(app.db, request.params.name)
    const limit = parseBoundedLimit(request.query.limit, SITE_HEALTH_SCANS_DEFAULT_LIMIT, SITE_HEALTH_SCANS_MAX_LIMIT)
    const rows = app.db
      .select({
        runId: runs.id,
        status: runs.status,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        notProbeRun(),
      ))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .all()

    // Exactly the snapshots `resolveCrawl` would resolve, so `hasCrawlData`
    // and the crawl-scoped reads can never disagree about the same run.
    const runIds = rows.map((row) => row.runId)
    const crawlRunIds = new Set(runIds.length === 0 ? [] : app.db
      .select({ runId: siteCrawlSnapshots.runId })
      .from(siteCrawlSnapshots)
      .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
      .where(and(
        eq(siteCrawlSnapshots.projectId, project.id),
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
        inArray(siteCrawlSnapshots.runId, runIds),
      ))
      .all()
      .map((row) => row.runId))

    return {
      project: project.name,
      scans: rows.map((row) => ({
        ...row,
        status: row.status as RunStatus,
        hasCrawlData: crawlRunIds.has(row.runId),
      })),
    }
  })

  // GET /projects/:name/technical-aeo/runs/:runId/progress — exact stored
  // progress only. It never polls an executor, fetches a page, or invokes a
  // provider: onboarding can safely resume after a reload without inventing a
  // progress percentage for an unknown final corpus.
  app.get<{
    Params: { name: string; runId: string }
  }>('/projects/:name/technical-aeo/runs/:runId/progress', async (request): Promise<SiteAuditRunProgressDto> => {
    const project = resolveProject(app.db, request.params.name)
    const run = app.db.select().from(runs).where(and(
      eq(runs.id, request.params.runId),
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['site-audit']),
      notProbeRun(),
    )).get()
    if (!run) throw notFound('Site audit run', request.params.runId)

    const attempt = app.db.select().from(siteCrawlAttempts).where(and(
      eq(siteCrawlAttempts.projectId, project.id),
      eq(siteCrawlAttempts.runId, run.id),
    )).orderBy(desc(siteCrawlAttempts.attemptNumber), desc(siteCrawlAttempts.updatedAt)).limit(1).get()
    const persistedLayout = attempt
      ? app.db.select().from(siteCrawlGraphLayouts).where(and(
        eq(siteCrawlGraphLayouts.projectId, project.id),
        eq(siteCrawlGraphLayouts.runId, run.id),
        eq(siteCrawlGraphLayouts.attemptId, attempt.id),
      )).get()
      : undefined
    const layoutState = persistedLayout?.state === 'ready' || persistedLayout?.state === 'unavailable'
      ? persistedLayout.state
      : run.status === RunStatuses.completed || run.status === RunStatuses.partial
        ? 'unavailable'
        : 'pending'

    return {
      project: project.name,
      runId: run.id,
      status: run.status as RunStatus,
      phase: siteAuditRunPhase(run.status as RunStatus, attempt, layoutState),
      attempt: attempt
        ? {
          id: attempt.id,
          state: attempt.state,
          pagesDiscovered: attempt.pagesDiscovered,
          pagesFetched: attempt.pagesFetched,
          pagesEligible: attempt.pagesEligible,
          pagesErrored: attempt.pagesErrored,
          edgesDiscovered: attempt.edgesDiscovered,
          lastUpdatedAt: attempt.updatedAt,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
          error: attempt.error,
        }
        : null,
      layout: {
        state: layoutState,
        layoutVersion: persistedLayout?.layoutVersion ?? null,
        failureCode: persistedLayout?.failureCode ?? null,
        updatedAt: persistedLayout?.updatedAt ?? null,
      },
      error: run.error ?? attempt?.error ?? null,
    }
  })

  // GET /projects/:name/technical-aeo/runs/:runId/page-health-preview — a
  // small, durable preview for the active onboarding scan. This deliberately
  // exposes neither final scorecards nor finding prose: terminal reads hand
  // the caller back to the immutable Page Health snapshot instead.
  app.get<{
    Params: { name: string; runId: string }
  }>('/projects/:name/technical-aeo/runs/:runId/page-health-preview', async (request): Promise<SiteAuditLivePageHealthDto> => (
    app.db.transaction((tx) => {
      const project = tx.select().from(projects).where(eq(projects.name, request.params.name)).get()
      if (!project) throw notFound('Project', request.params.name)

      const run = tx.select().from(runs).where(and(
        eq(runs.id, request.params.runId),
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        notProbeRun(),
      )).get()
      if (!run) throw notFound('Site audit run', request.params.runId)

      const attempt = tx.select().from(siteCrawlAttempts).where(and(
        eq(siteCrawlAttempts.projectId, project.id),
        eq(siteCrawlAttempts.runId, run.id),
      )).orderBy(desc(siteCrawlAttempts.attemptNumber), desc(siteCrawlAttempts.updatedAt)).limit(1).get()
      const state = run.status === RunStatuses.queued
        ? 'waiting'
        : run.status === RunStatuses.running
          ? 'collecting'
          : 'terminal'
      const base = {
        project: project.name,
        runId: run.id,
        status: run.status as RunStatus,
        state,
        attemptId: attempt?.id ?? null,
        updatedAt: attempt?.updatedAt ?? null,
      } as const

      if (!attempt) {
        return { ...base, pagesAudited: 0, examples: [] }
      }

      const auditedWhere = and(
        eq(siteCrawlPages.projectId, project.id),
        eq(siteCrawlPages.runId, run.id),
        eq(siteCrawlPages.attemptId, attempt.id),
        eq(siteCrawlPages.auditState, 'success'),
      )
      const pagesAudited = tx.select({ value: count() }).from(siteCrawlPages).where(auditedWhere).get()?.value ?? 0

      if (state !== 'collecting') {
        return { ...base, pagesAudited, examples: [] }
      }

      const candidates = tx.select({
        nodeKey: siteCrawlPages.nodeKey,
        url: siteCrawlPages.url,
        auditScore: siteCrawlPages.auditScore,
        auditFields: siteCrawlPages.auditFields,
      }).from(siteCrawlPages).where(and(
        auditedWhere,
        isNotNull(siteCrawlPages.auditScore),
        lt(siteCrawlPages.auditScore, 70),
      )).orderBy(asc(siteCrawlPages.auditScore), asc(siteCrawlPages.nodeKey)).limit(LIVE_PAGE_HEALTH_CANDIDATE_LIMIT).all()
      const examples = candidates.flatMap((candidate) => {
        if (candidate.auditScore == null) return []
        const checksNeedingAttention = countLivePageHealthChecks(candidate.auditFields)
        return checksNeedingAttention > 0
          ? [{
              nodeKey: candidate.nodeKey,
              url: candidate.url,
              auditScore: candidate.auditScore,
              checksNeedingAttention,
            }]
          : []
      }).slice(0, LIVE_PAGE_HEALTH_EXAMPLE_LIMIT)

      return { ...base, pagesAudited, examples }
    })
  ))

  // POST /projects/:name/technical-aeo/runs — exact-identity consolidation.
  app.post<{
    Params: { name: string }
    Body: { sitemapUrl?: string; limit?: number; maxPages?: number; maxEdges?: number; maxDepth?: number; checkDeadLinks?: boolean }
  }>('/projects/:name/technical-aeo/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = siteAuditRunRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid site-audit request')
    }
    if (!opts.onSiteAuditRequested) {
      throw missingDependency('Site Health execution is not available on this deployment.', {
        reason: 'no-site-audit-handler',
      })
    }

    const effectiveRequest = normalizeSiteAuditRunRequest(parsed.data)
    const identityKey = siteAuditRequestIdentity(effectiveRequest)
    const result = app.db.transaction((tx) => {
      const existing = tx
        .select({
          id: runs.id,
          status: runs.status,
          identityKey: siteCrawlRunRequests.identityKey,
          effectiveOptions: siteCrawlRunRequests.effectiveOptions,
        })
        .from(runs)
        .leftJoin(siteCrawlRunRequests, and(
          eq(siteCrawlRunRequests.projectId, runs.projectId),
          eq(siteCrawlRunRequests.runId, runs.id),
        ))
        .where(and(
          eq(runs.projectId, project.id),
          eq(runs.kind, RunKinds['site-audit']),
          inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
        ))
        .get()
      if (existing) {
        if (existing.identityKey === identityKey) {
          return { runId: existing.id, status: existing.status as RunStatus, created: false }
        }
        throw operationInProgress(
          `A Technical AEO crawl is already ${existing.status} with different request options.`,
          {
            activeRunId: existing.id,
            activeStatus: existing.status,
            activeOptions: existing.effectiveOptions,
            requestedOptions: effectiveRequest,
          },
        )
      }

      const now = new Date().toISOString()
      const runId = crypto.randomUUID()
      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['site-audit'],
        status: RunStatuses.queued,
        trigger: RunTriggers.manual,
        createdAt: now,
      }).run()
      tx.insert(siteCrawlRunRequests).values({
        runId,
        projectId: project.id,
        identityKey,
        effectiveOptions: effectiveRequest,
        createdAt: now,
      }).run()
      return { runId, status: RunStatuses.queued, created: true }
    })

    if (result.created) {
      opts.onSiteAuditRequested(result.runId, project.id, {
        sitemapUrl: effectiveRequest.sitemapUrl ?? undefined,
        limit: parsed.data.limit,
        maxPages: effectiveRequest.maxPages,
        // Stays undefined when unset so the engine derives the edge budget
        // from the page count instead of inheriting a flat ceiling here.
        maxEdges: effectiveRequest.maxEdges ?? undefined,
        maxDepth: effectiveRequest.maxDepth ?? undefined,
        checkDeadLinks: effectiveRequest.checkDeadLinks,
      })
    }

    return { runId: result.runId, status: result.status }
  })
}

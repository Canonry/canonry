import crypto from 'node:crypto'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { runs, siteAuditPages, siteAuditSnapshots } from '@ainyc/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  SiteAuditTrendDirections,
  siteAuditRunRequestSchema,
  validationError,
  type RunStatus,
  type SiteAuditPageDto,
  type SiteAuditPagesResponseDto,
  type SiteAuditScoreDto,
  type SiteAuditTrendResponseDto,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'

export interface TechnicalAeoRoutesOptions {
  /**
   * Fired after a `site-audit` run row is created. Wire this in the host server
   * to `executeSiteAudit(...).then(() => runCoordinator.onRunCompleted(...))`.
   */
  onSiteAuditRequested?: (runId: string, projectId: string, opts?: { sitemapUrl?: string; limit?: number }) => void
}

/** Run statuses that count as a real, surfaceable site audit. */
const SURFACEABLE_STATUSES = [RunStatuses.completed, RunStatuses.partial]

function emptyScore(projectName: string): SiteAuditScoreDto {
  return {
    project: projectName,
    hasData: false,
    runId: null,
    runStatus: null,
    sitemapUrl: null,
    auditedAt: null,
    aggregateScore: 0,
    aggregateGrade: '',
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

export async function technicalAeoRoutes(app: FastifyInstance, opts: TechnicalAeoRoutesOptions) {
  // GET /projects/:name/technical-aeo — latest scorecard + delta vs prior run.
  app.get<{ Params: { name: string } }>('/projects/:name/technical-aeo', async (request): Promise<SiteAuditScoreDto> => {
    const project = resolveProject(app.db, request.params.name)

    const rows = app.db
      .select({ snap: siteAuditSnapshots, runStatus: runs.status })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(
        eq(siteAuditSnapshots.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
      ))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(2)
      .all()

    const latest = rows[0]
    if (!latest) return emptyScore(project.name)

    const snap = latest.snap
    const previous = rows[1]?.snap ?? null
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
      aggregateGrade: snap.aggregateGrade,
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

  // GET /projects/:name/technical-aeo/pages — per-page breakdown of the latest run.
  app.get<{
    Params: { name: string }
    Querystring: { status?: string; sort?: string; limit?: string; offset?: string }
  }>('/projects/:name/technical-aeo/pages', async (request): Promise<SiteAuditPagesResponseDto> => {
    const project = resolveProject(app.db, request.params.name)

    // Latest surfaceable site-audit run for this project.
    const latest = app.db
      .select({ runId: siteAuditSnapshots.runId, auditedAt: siteAuditSnapshots.auditedAt })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(
        eq(siteAuditSnapshots.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
      ))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(1)
      .get()

    if (!latest) {
      return { project: project.name, runId: null, auditedAt: null, total: 0, pages: [] }
    }

    const statusFilter = request.query.status === 'success' || request.query.status === 'error'
      ? request.query.status
      : null
    const conds = [eq(siteAuditPages.runId, latest.runId)]
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
      overallGrade: row.overallGrade,
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
        aggregateGrade: siteAuditSnapshots.aggregateGrade,
        pagesAudited: siteAuditSnapshots.pagesAudited,
      })
      .from(siteAuditSnapshots)
      .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
      .where(and(
        eq(siteAuditSnapshots.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, SURFACEABLE_STATUSES),
        notProbeRun(),
      ))
      .orderBy(desc(siteAuditSnapshots.createdAt))
      .limit(limit)
      .all()

    return { project: project.name, points: rows.reverse() }
  })

  // POST /projects/:name/technical-aeo/runs — trigger a site-audit run (idempotent).
  app.post<{
    Params: { name: string }
    Body: { sitemapUrl?: string; limit?: number }
  }>('/projects/:name/technical-aeo/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = siteAuditRunRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid site-audit request')
    }

    // Idempotent: if a site-audit run is already queued/running, return it
    // rather than starting a second (a large audit can run for minutes).
    const existing = app.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
      ))
      .get()
    if (existing) {
      return { runId: existing.id, status: existing.status as RunStatus }
    }

    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['site-audit'],
      status: RunStatuses.queued,
      trigger: RunTriggers.manual,
      createdAt: now,
    }).run()

    opts.onSiteAuditRequested?.(runId, project.id, {
      sitemapUrl: parsed.data.sitemapUrl,
      limit: parsed.data.limit,
    })

    return { runId, status: RunStatuses.queued }
  })
}

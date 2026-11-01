import { and, asc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  backlinkSummaries,
  bingCoverageSnapshots,
  gscCoverageSnapshots,
  runs,
  siteAuditSnapshots,
} from '@canonry/canonry-db'
import {
  BacklinkSources,
  RunKinds,
  RunStatuses,
  TREND_SURFACE_DEFAULT_WINDOW,
  TrendBetter,
  TrendSurfaces,
  TrendUnits,
  WINDOW_SETS,
  buildLevelTrendFigure,
  parseWindowIn,
  trendSurfaceSchema,
  trendWindowSpan,
  validationError,
  type TrendGroup,
  type TrendReading,
  type TrendSurface,
  type TrendsResponse,
} from '@canonry/canonry-contracts'
import { computeFilteredSummary } from './backlinks.js'
import { notProbeRun, resolveProject } from './helpers.js'

/** A group's stored readings, keyed by figure, before the window is applied. */
interface GroupReadings {
  key: string
  label: string
  figures: Array<{
    key: string
    label: string
    unit: (typeof TrendUnits)[keyof typeof TrendUnits]
    better: (typeof TrendBetter)[keyof typeof TrendBetter]
    readings: TrendReading[]
  }>
}

/** Site-audit runs whose scores the dashboard surfaces: the same set as the score trend. */
const SURFACEABLE_STATUSES = [RunStatuses.completed, RunStatuses.partial]

function parseSurface(value: string | undefined): TrendSurface {
  const parsed = trendSurfaceSchema.safeParse(value)
  if (!parsed.success) {
    throw validationError(`Invalid surface "${value ?? ''}". Must be one of: ${trendSurfaceSchema.options.join(', ')}.`, {
      field: 'surface',
      value: value ?? null,
      allowed: [...trendSurfaceSchema.options],
    })
  }
  return parsed.data
}

/**
 * GET /projects/:name/trends?surface=&window=
 *
 * The figures a dashboard tab's trend card leads with, each with its readings
 * over the window and the change since the window's first reading. Reads stored
 * rows only; nothing here calls a provider.
 */
export async function trendsRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: { surface?: string; window?: string }
  }>('/projects/:name/trends', async (request): Promise<TrendsResponse> => {
    const project = resolveProject(app.db, request.params.name)
    const surface = parseSurface(request.query.surface)
    const window = parseWindowIn(request.query.window, WINDOW_SETS.metrics, { fallback: TREND_SURFACE_DEFAULT_WINDOW[surface] })

    const groups = readSurface(app, project.id, surface).filter(group => group.figures.some(figure => figure.readings.some(reading => reading.value !== null)))
    const span = trendWindowSpan(groups.flatMap(group => group.figures.flatMap(figure => figure.readings.filter(reading => reading.value !== null).map(reading => reading.date))), window)
    const built: TrendGroup[] = groups.map(group => ({
      key: group.key,
      label: group.label,
      figures: group.figures.map(figure => buildLevelTrendFigure({ ...figure, span })),
    }))
    return {
      project: project.name,
      surface,
      window,
      startDate: span?.startDate ?? null,
      endDate: span?.endDate ?? null,
      groups: built,
    }
  })
}

function readSurface(app: FastifyInstance, projectId: string, surface: TrendSurface): GroupReadings[] {
  switch (surface) {
    case TrendSurfaces['index-coverage']: {
      const google = app.db
        .select({ date: gscCoverageSnapshots.date, indexed: gscCoverageSnapshots.indexed, notIndexed: gscCoverageSnapshots.notIndexed })
        .from(gscCoverageSnapshots)
        .where(eq(gscCoverageSnapshots.projectId, projectId))
        .orderBy(asc(gscCoverageSnapshots.date))
        .all()
      const bing = app.db
        .select({ date: bingCoverageSnapshots.date, indexed: bingCoverageSnapshots.indexed, notIndexed: bingCoverageSnapshots.notIndexed })
        .from(bingCoverageSnapshots)
        .where(eq(bingCoverageSnapshots.projectId, projectId))
        .orderBy(asc(bingCoverageSnapshots.date))
        .all()
      const coverage = (key: string, label: string, rows: Array<{ date: string; indexed: number; notIndexed: number }>): GroupReadings => ({
        key,
        label,
        figures: [
          { key: 'indexed', label: 'Indexed', unit: TrendUnits.count, better: TrendBetter.higher, readings: rows.map(row => ({ date: row.date, value: row.indexed })) },
          { key: 'not-indexed', label: 'Not indexed', unit: TrendUnits.count, better: TrendBetter.lower, readings: rows.map(row => ({ date: row.date, value: row.notIndexed })) },
        ],
      })
      return [coverage('google', 'Google', google), coverage('bing', 'Bing', bing)]
    }
    case TrendSurfaces['site-health']: {
      const rows = app.db
        .select({ auditedAt: siteAuditSnapshots.auditedAt, aggregateScore: siteAuditSnapshots.aggregateScore, pagesAudited: siteAuditSnapshots.pagesAudited })
        .from(siteAuditSnapshots)
        .innerJoin(runs, eq(siteAuditSnapshots.runId, runs.id))
        .where(and(
          eq(siteAuditSnapshots.projectId, projectId),
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['site-audit']),
          inArray(runs.status, SURFACEABLE_STATUSES),
          notProbeRun(),
        ))
        // Each scan is a moment: keep every one, oldest first.
        .orderBy(asc(siteAuditSnapshots.auditedAt))
        .all()
      return [{
        key: 'site-health',
        label: 'Site Health',
        figures: [
          { key: 'score', label: 'Site score', unit: TrendUnits.score, better: TrendBetter.higher, readings: rows.map(row => ({ date: row.auditedAt, observedAt: row.auditedAt, value: row.aggregateScore })) },
          { key: 'pages-checked', label: 'Pages checked', unit: TrendUnits.count, better: TrendBetter.neither, readings: rows.map(row => ({ date: row.auditedAt, observedAt: row.auditedAt, value: row.pagesAudited })) },
        ],
      }]
    }
    case TrendSurfaces.backlinks: {
      // The same crawler- and proxy-excluded totals the Backlinks tab shows for
      // a release, so a trend never disagrees with the figure beside it. A
      // release whose domain rows are missing reads as unknown, never zero.
      const rows = app.db
        .select()
        .from(backlinkSummaries)
        .where(and(eq(backlinkSummaries.projectId, projectId), eq(backlinkSummaries.source, BacklinkSources.commoncrawl)))
        .orderBy(asc(backlinkSummaries.queriedAt))
        .all()
        .map((row) => {
          const filtered = computeFilteredSummary(app.db, row)
          const known = filtered.totalLinkingDomains + (filtered.excludedLinkingDomains ?? 0) > 0 || row.totalLinkingDomains === 0
          return {
            queriedAt: row.queriedAt,
            totalLinkingDomains: known ? filtered.totalLinkingDomains : null,
            totalHosts: known ? filtered.totalHosts : null,
            top10HostsShare: known ? Number(filtered.top10HostsShare) : null,
          }
        })
      return [{
        key: 'backlinks',
        label: 'Backlinks',
        figures: [
          { key: 'referring-domains', label: 'Referring domains', unit: TrendUnits.count, better: TrendBetter.higher, readings: rows.map(row => ({ date: row.queriedAt, observedAt: row.queriedAt, value: row.totalLinkingDomains })) },
          { key: 'hosts', label: 'Total linking hosts', unit: TrendUnits.count, better: TrendBetter.higher, readings: rows.map(row => ({ date: row.queriedAt, observedAt: row.queriedAt, value: row.totalHosts })) },
          { key: 'top-10-concentration', label: 'Top-10 concentration', unit: TrendUnits.fraction, better: TrendBetter.neither, readings: rows.map(row => ({ date: row.queriedAt, observedAt: row.queriedAt, value: row.top10HostsShare })) },
        ],
      }]
    }
  }
}

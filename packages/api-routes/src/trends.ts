import { and, asc, eq } from 'drizzle-orm'
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
  TREND_SURFACE_DEFAULT_WINDOW,
  TrendBetter,
  TrendSurfaces,
  TrendUnits,
  WINDOW_SETS,
  buildLevelTrendFigure,
  isCalendarDate,
  parseWindowIn,
  trendSurfaceSchema,
  trendWindowSpan,
  validationError,
  type MetricsWindow,
  type TrendDateRange,
  type TrendGroup,
  type TrendReading,
  type TrendSurface,
  type TrendsResponse,
} from '@canonry/canonry-contracts'
import { compareReleaseIds, formatReleaseWindow, releaseWindowEndMonth } from '@canonry/canonry-integration-commoncrawl'
import { computeFilteredReleaseTotals } from './backlinks.js'
import { resolveProject } from './helpers.js'
import { surfaceableSiteAuditFilters } from './technical-aeo.js'

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

function parseDate(field: 'startDate' | 'endDate', value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!isCalendarDate(value)) throw validationError(`Invalid ${field} "${value}". Use a calendar date, YYYY-MM-DD.`, { field, value })
  return value
}

/** The window, or the caller's own date range; never both, so a span is never ambiguous. */
function parseSelection(query: { window?: string; startDate?: string; endDate?: string }, surface: TrendSurface): MetricsWindow | TrendDateRange {
  const startDate = parseDate('startDate', query.startDate)
  const endDate = parseDate('endDate', query.endDate)
  if (startDate === undefined && endDate === undefined) {
    return parseWindowIn(query.window, WINDOW_SETS.metrics, { fallback: TREND_SURFACE_DEFAULT_WINDOW[surface] })
  }
  if (query.window !== undefined) {
    throw validationError('Pass window or a startDate/endDate range, not both.', { field: 'window', value: query.window })
  }
  if (startDate && endDate && startDate > endDate) {
    throw validationError(`startDate ${startDate} is after endDate ${endDate}.`, { field: 'startDate', value: startDate })
  }
  return { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) }
}

/**
 * GET /projects/:name/trends?surface=&window= (or &startDate=&endDate=)
 *
 * The figures a dashboard tab's trend card leads with, each with its readings
 * over the window and the change since the window's first reading. Reads stored
 * rows only; nothing here calls a provider.
 */
export async function trendsRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: { surface?: string; window?: string; startDate?: string; endDate?: string }
  }>('/projects/:name/trends', async (request): Promise<TrendsResponse> => {
    const project = resolveProject(app.db, request.params.name)
    const surface = parseSurface(request.query.surface)
    const selection = parseSelection(request.query, surface)

    const groups = readSurface(app, project.id, surface).filter(group => group.figures.some(figure => figure.readings.some(reading => reading.value !== null)))
    const span = trendWindowSpan(groups.flatMap(group => group.figures.flatMap(figure => figure.readings.filter(reading => reading.value !== null).map(reading => reading.date))), selection)
    const built: TrendGroup[] = groups.map(group => ({
      key: group.key,
      label: group.label,
      figures: group.figures.map(figure => buildLevelTrendFigure({ ...figure, span })),
    }))
    return {
      project: project.name,
      surface,
      window: typeof selection === 'string' ? selection : null,
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
        // The scans the Technical AEO score trend charts, so the two never disagree.
        .where(and(...surfaceableSiteAuditFilters(projectId)))
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
      const totals = computeFilteredReleaseTotals(app.db, projectId, BacklinkSources.commoncrawl)
      const rows = app.db
        .select({ release: backlinkSummaries.release, totalLinkingDomains: backlinkSummaries.totalLinkingDomains, queriedAt: backlinkSummaries.queriedAt })
        .from(backlinkSummaries)
        .where(and(eq(backlinkSummaries.projectId, projectId), eq(backlinkSummaries.source, BacklinkSources.commoncrawl)))
        .all()
        // A release is a crawl window: it reads at the window's last month, in
        // crawl order, however late it was extracted.
        .sort((a, b) => compareReleaseIds(a.release, b.release))
        .map((row) => {
          const filtered = totals.get(row.release)
          const known = (filtered?.domainRows ?? 0) > 0 || row.totalLinkingDomains === 0
          const windowEnd = releaseWindowEndMonth(row.release)
          return {
            date: windowEnd ?? row.queriedAt,
            observedAt: windowEnd ? null : row.queriedAt,
            label: formatReleaseWindow(row.release) ?? row.release,
            linkingDomains: known ? filtered?.linkingDomains ?? 0 : null,
            hosts: known ? filtered?.hosts ?? 0 : null,
            top10HostsShare: known ? filtered?.top10HostsShare ?? 0 : null,
          }
        })
      const readings = (value: (row: typeof rows[number]) => number | null): TrendReading[] =>
        rows.map(row => ({ date: row.date, observedAt: row.observedAt, label: row.label, value: value(row) }))
      return [{
        key: 'backlinks',
        label: 'Backlinks',
        figures: [
          { key: 'referring-domains', label: 'Referring domains', unit: TrendUnits.count, better: TrendBetter.higher, readings: readings(row => row.linkingDomains) },
          { key: 'hosts', label: 'Total linking hosts', unit: TrendUnits.count, better: TrendBetter.higher, readings: readings(row => row.hosts) },
          { key: 'top-10-concentration', label: 'Top-10 concentration', unit: TrendUnits.fraction, better: TrendBetter.neither, readings: readings(row => row.top10HostsShare) },
        ],
      }]
    }
  }
}

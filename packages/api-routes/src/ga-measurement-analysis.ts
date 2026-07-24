import { and, eq, gte, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gscDailyTotals,
  gscQueryDailyTotals,
  gscSearchData,
} from '@ainyc/canonry-db'
import {
  filterBrandedSeedCandidates,
  gaMeasurementAnalysisDtoSchema,
  gaMeasurementAnalysisWindowSchema,
  gaMeasurementHostScopeSchema,
  hostOf,
  normalizeUrlPath,
  validationError,
} from '@ainyc/canonry-contracts'
import type {
  GaMeasurementAnalysisDto,
  GaMeasurementAnalysisWindow,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

type Database = FastifyInstance['db']
type WindowDays = 30 | 60 | 90
type PeriodLabel = 'earliest' | 'middle' | 'previous' | 'latest'
type Period = {
  label: PeriodLabel
  startDate: string
  endDate: string
}

export interface GaMeasurementAnalysisOptions {
  window?: string
  hostScope?: string
  pathPrefix?: string
  limit?: string | number
}

function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

function windowDays(window: GaMeasurementAnalysisWindow): WindowDays {
  if (window === '30d') return 30
  if (window === '60d') return 60
  return 90
}

function buildPeriods(anchor: string, days: WindowDays): Period[] {
  const labels: PeriodLabel[] = days === 30
    ? ['latest']
    : days === 60
      ? ['previous', 'latest']
      : ['earliest', 'middle', 'latest']

  return labels.map((label, index) => ({
    label,
    startDate: addDays(anchor, -days + index * 30 + 1),
    endDate: addDays(anchor, -days + (index + 1) * 30),
  }))
}

function aggregateByKey<T extends { date: string }>(
  rows: T[],
  periods: Period[],
  keyOf: (row: T) => string,
  valueOf: (row: T) => number,
): Map<string, number[]> {
  const result = new Map<string, number[]>()
  for (const row of rows) {
    const periodIndex = periods.findIndex(
      period => row.date >= period.startDate && row.date <= period.endDate,
    )
    if (periodIndex < 0) continue
    const values = result.get(keyOf(row)) ?? Array<number>(periods.length).fill(0)
    values[periodIndex] = (values[periodIndex] ?? 0) + valueOf(row)
    result.set(keyOf(row), values)
  }
  return result
}

function sessionPeriods(periods: Period[], values: number[]) {
  return periods.map((period, index) => ({
    ...period,
    sessions: values[index] ?? 0,
  }))
}

function eventPeriods(periods: Period[], values: number[]) {
  return periods.map((period, index) => ({
    ...period,
    eventCount: values[index] ?? 0,
  }))
}

function clickPeriods(periods: Period[], clicks: number[], impressions: number[]) {
  return periods.map((period, index) => ({
    ...period,
    clicks: clicks[index] ?? 0,
    impressions: impressions[index] ?? 0,
  }))
}

function rankEntries(entries: Iterable<[string, number[]]>): Array<[string, number[]]> {
  const score = (values: number[]) => ({
    latest: values.at(-1) ?? 0,
    total: values.reduce((sum, value) => sum + value, 0),
  })
  return [...entries].sort(([leftKey, leftValues], [rightKey, rightValues]) => {
    const left = score(leftValues)
    const right = score(rightValues)
    return right.latest - left.latest
      || right.total - left.total
      || leftKey.localeCompare(rightKey)
  })
}

function normalizeHost(value: string): string {
  return hostOf(value) ?? value.trim().toLowerCase().replace(/^www\./, '')
}

function stableUnique(values: string[], normalize: (value: string) => string): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = normalize(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function matchesHost(value: string, marketingHosts: string[]): boolean {
  const normalized = normalizeHost(value)
  return marketingHosts.some(
    candidate => normalized === candidate || normalized.endsWith(`.${candidate}`),
  )
}

function normalizeLandingPage(value: string | null | undefined): string {
  return normalizeUrlPath(value) ?? '/'
}

function normalizePathPrefix(value: string | undefined): string | null {
  if (!value) return null
  const normalized = normalizeLandingPage(value)
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function matchesPathPrefix(value: string, prefix: string | null): boolean {
  if (!prefix) return true
  const pathname = value.split('?')[0] ?? value
  if (prefix === '/') return true
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function splitKey(key: string): [string, string] {
  const separator = key.indexOf('\u0000')
  if (separator < 0) return [key, '/']
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function parseGscPage(row: typeof gscSearchData.$inferSelect) {
  try {
    const url = new URL(row.page)
    return {
      ...row,
      hostName: url.hostname,
      landingPage: normalizeLandingPage(url.pathname),
    }
  } catch {
    return null
  }
}

export function buildGaMeasurementAnalysis(
  db: Database,
  projectName: string,
  options: GaMeasurementAnalysisOptions = {},
): GaMeasurementAnalysisDto {
  const parsedWindow = gaMeasurementAnalysisWindowSchema.safeParse(options.window ?? '90d')
  if (!parsedWindow.success) {
    throw validationError('"window" must be one of: 30d, 60d, 90d')
  }
  const parsedHostScope = gaMeasurementHostScopeSchema.safeParse(
    options.hostScope ?? 'marketing',
  )
  if (!parsedHostScope.success) {
    throw validationError('"hostScope" must be one of: marketing, all')
  }
  const limit = Number(options.limit ?? 100)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationError('"limit" must be an integer between 1 and 100')
  }

  const project = resolveProject(db, projectName)
  const days = windowDays(parsedWindow.data)
  const pathPrefix = normalizePathPrefix(options.pathPrefix)
  const marketingHosts = stableUnique(
    [
      project.canonicalDomain,
      ...project.ownedDomains,
      ...project.measurement.marketingHosts,
    ],
    normalizeHost,
  )
  const brandTerms = stableUnique(
    [project.displayName, ...project.aliases, ...project.measurement.brandTerms],
    value => value.trim(),
  )
  const hostIsIncluded = (hostName: string) => (
    parsedHostScope.data === 'all' || matchesHost(hostName, marketingHosts)
  )
  const pageIsIncluded = (landingPage: string) => (
    matchesPathPrefix(landingPage, pathPrefix)
  )

  const scopedConditions = (hostColumn: typeof gaAcquisitionDaily.hostName | typeof gaLeadEventsDaily.hostName, pathColumn: typeof gaAcquisitionDaily.landingPageNormalized | typeof gaLeadEventsDaily.landingPageNormalized) => {
    const conditions = []
    if (parsedHostScope.data === 'marketing') {
      const normalizedHost = sql`replace(lower(${hostColumn}), 'www.', '')`
      conditions.push(or(...marketingHosts.flatMap(host => [
        sql`${normalizedHost} = ${host}`,
        sql`${normalizedHost} like ${`%.${host}`}`,
      ])))
    }
    if (pathPrefix && pathPrefix !== '/') {
      conditions.push(or(sql`${pathColumn} = ${pathPrefix}`, sql`${pathColumn} like ${`${pathPrefix}/%`}`))
    }
    return conditions
  }
  const acquisitionScope = scopedConditions(gaAcquisitionDaily.hostName, gaAcquisitionDaily.landingPageNormalized)
  const leadLandingScope = scopedConditions(gaLeadEventsDaily.hostName, gaLeadEventsDaily.landingPageNormalized)
  const acquisitionAnchor = db.select({ date: sql<string | null>`max(${gaAcquisitionDaily.date})` })
    .from(gaAcquisitionDaily).where(and(eq(gaAcquisitionDaily.projectId, project.id), ...acquisitionScope)).get()?.date ?? null
  const leadAnchor = db.select({ date: sql<string | null>`max(${gaLeadEventsDaily.date})` })
    .from(gaLeadEventsDaily).where(and(eq(gaLeadEventsDaily.projectId, project.id), or(
      eq(gaLeadEventsDaily.attributionScope, 'channel'),
      and(eq(gaLeadEventsDaily.attributionScope, 'landing-page'), ...leadLandingScope),
    ))).get()?.date ?? null
  const gaAnchor = [acquisitionAnchor, leadAnchor].filter((date): date is string => date !== null).sort().at(-1) ?? null
  const gaPeriods = gaAnchor ? buildPeriods(gaAnchor, days) : []
  const gaStartDate = gaPeriods[0]?.startDate
  const acquisitionRows = gaStartDate ? db.select().from(gaAcquisitionDaily).where(and(eq(gaAcquisitionDaily.projectId, project.id), gte(gaAcquisitionDaily.date, gaStartDate))).all() : []
  const leadRows = gaStartDate ? db.select().from(gaLeadEventsDaily).where(and(eq(gaLeadEventsDaily.projectId, project.id), gte(gaLeadEventsDaily.date, gaStartDate))).all() : []
  const gscAnchor = db.select({ date: sql<string | null>`max(${gscDailyTotals.date})` })
    .from(gscDailyTotals).where(eq(gscDailyTotals.projectId, project.id)).get()?.date ?? null
  const gscPeriods = gscAnchor ? buildPeriods(gscAnchor, days) : []
  const gscStartDate = gscPeriods[0]?.startDate
  const propertyRows = gscStartDate ? db.select().from(gscDailyTotals).where(and(eq(gscDailyTotals.projectId, project.id), gte(gscDailyTotals.date, gscStartDate))).all() : []
  const queryRows = gscStartDate ? db.select().from(gscQueryDailyTotals).where(and(eq(gscQueryDailyTotals.projectId, project.id), gte(gscQueryDailyTotals.date, gscStartDate))).all() : []
  const rawPageRows = gscStartDate ? db.select().from(gscSearchData).where(and(eq(gscSearchData.projectId, project.id), gte(gscSearchData.date, gscStartDate))).all() : []
  const state = db.select().from(gaMeasurementSyncStates)
    .where(eq(gaMeasurementSyncStates.projectId, project.id)).get()
  const acquisition = acquisitionRows.filter((row) => {
    const landingPage = row.landingPageNormalized ?? normalizeLandingPage(row.landingPage)
    return hostIsIncluded(row.hostName) && pageIsIncluded(landingPage)
  })
  const acquisitionTotals = aggregateByKey(
    acquisition,
    gaPeriods,
    () => 'all',
    row => row.sessions,
  ).get('all') ?? []
  const acquisitionChannels = aggregateByKey(
    acquisition,
    gaPeriods,
    row => row.channelGroup,
    row => row.sessions,
  )
  const acquisitionPages = aggregateByKey(
    acquisition,
    gaPeriods,
    row => (
      `${row.hostName}\u0000${row.landingPageNormalized ?? normalizeLandingPage(row.landingPage)}`
    ),
    row => row.sessions,
  )

  const selectedLeadRows = leadRows.filter(row => (
    gaPeriods.some(period => row.date >= period.startDate && row.date <= period.endDate)
  ))
  const hasLeadTimeline = leadRows.length > 0 || state?.leadSyncedAt != null
  const hasChannelOnlyLeads = selectedLeadRows.some(row => row.attributionScope === 'channel')
  const stateLeadScope = state === undefined ? null : state.leadAttributionScope
  const firstObservedLeadScope = selectedLeadRows.length > 0
    ? selectedLeadRows[0]!.attributionScope
    : null
  const attributionScope = hasChannelOnlyLeads
    ? 'channel'
    : stateLeadScope ?? firstObservedLeadScope
  const hostAndPathFiltersApplied = attributionScope === 'landing-page'
  const leads = selectedLeadRows.filter((row) => {
    if (row.attributionScope === 'channel') return true
    const landingPage = row.landingPageNormalized ?? normalizeLandingPage(row.landingPage)
    return hostIsIncluded(row.hostName) && pageIsIncluded(landingPage)
  })
  const leadTotals = aggregateByKey(
    leads,
    gaPeriods,
    () => 'all',
    row => row.eventCount,
  ).get('all') ?? []
  const leadChannels = aggregateByKey(
    leads,
    gaPeriods,
    row => row.channelGroup,
    row => row.eventCount,
  )

  const propertyClicks = aggregateByKey(
    propertyRows,
    gscPeriods,
    () => 'all',
    row => row.clicks,
  ).get('all') ?? []
  const propertyImpressions = aggregateByKey(
    propertyRows,
    gscPeriods,
    () => 'all',
    row => row.impressions,
  ).get('all') ?? []
  const queryClicks = aggregateByKey(
    queryRows,
    gscPeriods,
    () => 'all',
    row => row.clicks,
  ).get('all') ?? []
  const queryImpressions = aggregateByKey(
    queryRows,
    gscPeriods,
    () => 'all',
    row => row.impressions,
  ).get('all') ?? []

  const brandedQueries = new Set(filterBrandedSeedCandidates({
    candidates: queryRows.map(row => row.query),
    brandNames: brandTerms,
    canonicalDomains: [project.canonicalDomain, ...project.ownedDomains],
  }).droppedBranded)
  const brandedClicks = aggregateByKey(
    queryRows.filter(row => brandedQueries.has(row.query)),
    gscPeriods,
    () => 'all',
    row => row.clicks,
  ).get('all') ?? []
  const brandedImpressions = aggregateByKey(
    queryRows.filter(row => brandedQueries.has(row.query)),
    gscPeriods,
    () => 'all',
    row => row.impressions,
  ).get('all') ?? []
  const perQueryClicks = aggregateByKey(
    queryRows,
    gscPeriods,
    row => row.query,
    row => row.clicks,
  )
  const perQueryImpressions = aggregateByKey(
    queryRows,
    gscPeriods,
    row => row.query,
    row => row.impressions,
  )

  const gscPageRows = rawPageRows
    .map(parseGscPage)
    .filter(row => row !== null)
    .filter(row => hostIsIncluded(row.hostName) && pageIsIncluded(row.landingPage))
  const perPageClicks = aggregateByKey(
    gscPageRows,
    gscPeriods,
    row => `${row.hostName}\u0000${row.landingPage}`,
    row => row.clicks,
  )
  const perPageImpressions = aggregateByKey(
    gscPageRows,
    gscPeriods,
    row => `${row.hostName}\u0000${row.landingPage}`,
    row => row.impressions,
  )

  return gaMeasurementAnalysisDtoSchema.parse({
    window: parsedWindow.data,
    bucketDays: 30,
    filters: {
      hostScope: parsedHostScope.data,
      marketingHosts,
      pathPrefix,
      brandTerms,
      queryMixScope: 'property',
    },
    acquisition: {
      status: state?.acquisitionStatus ?? 'never-synced',
      error: state?.acquisitionError ?? null,
      syncedAt: state?.acquisitionSyncedAt ?? null,
      periods: gaAnchor ? sessionPeriods(gaPeriods, acquisitionTotals) : [],
      channels: rankEntries(acquisitionChannels).map(([channelGroup, values]) => ({
        channelGroup,
        periods: sessionPeriods(gaPeriods, values),
      })),
      pages: rankEntries(acquisitionPages)
        .slice(0, limit)
        .map(([key, values]) => {
          const [hostName, landingPage] = splitKey(key)
          return {
            hostName,
            landingPage,
            periods: sessionPeriods(gaPeriods, values),
          }
        }),
    },
    leads: {
      status: state?.leadStatus ?? 'never-synced',
      error: state?.leadError ?? null,
      syncedAt: state?.leadSyncedAt ?? null,
      attributionScope,
      hostAndPathFiltersApplied,
      periods: gaAnchor && hasLeadTimeline ? eventPeriods(gaPeriods, leadTotals) : [],
      channels: rankEntries(leadChannels).map(([channelGroup, values]) => ({
        channelGroup,
        periods: eventPeriods(gaPeriods, values),
      })),
    },
    searchDemand: gscAnchor === null
      ? {
          status: 'unavailable',
          periods: [],
          queries: [],
          pages: [],
          latestDate: null,
        }
      : {
          status: 'ready',
          latestDate: gscAnchor,
          periods: gscPeriods.map((period, index) => ({
            ...period,
            propertyClicks: propertyClicks[index] ?? 0,
            propertyImpressions: propertyImpressions[index] ?? 0,
            reportedQueryClicks: queryClicks[index] ?? 0,
            reportedQueryImpressions: queryImpressions[index] ?? 0,
            brandedClicks: brandedClicks[index] ?? 0,
            brandedImpressions: brandedImpressions[index] ?? 0,
            nonBrandedClicks: Math.max(
              0,
              (queryClicks[index] ?? 0) - (brandedClicks[index] ?? 0),
            ),
            nonBrandedImpressions: Math.max(
              0,
              (queryImpressions[index] ?? 0) - (brandedImpressions[index] ?? 0),
            ),
            unreportedClicks: Math.max(
              0,
              (propertyClicks[index] ?? 0) - (queryClicks[index] ?? 0),
            ),
            unreportedImpressions: Math.max(
              0,
              (propertyImpressions[index] ?? 0) - (queryImpressions[index] ?? 0),
            ),
          })),
          queries: rankEntries(perQueryClicks)
            .slice(0, limit)
            .map(([query, values]) => ({
              query,
              classification: brandedQueries.has(query) ? 'branded' : 'non-branded',
              periods: clickPeriods(
                gscPeriods,
                values,
                perQueryImpressions.get(query) ?? [],
              ),
            })),
          pages: rankEntries(perPageImpressions)
            .slice(0, limit)
            .map(([key, impressions]) => {
              const [hostName, landingPage] = splitKey(key)
              return {
                hostName,
                landingPage,
                periods: clickPeriods(
                  gscPeriods,
                  perPageClicks.get(key) ?? [],
                  impressions,
                ),
              }
            }),
        },
  })
}

export async function gaMeasurementAnalysisRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: {
      window?: string
      hostScope?: string
      pathPrefix?: string
      limit?: string
    }
  }>('/projects/:name/ga/measurement-analysis', request => (
    buildGaMeasurementAnalysis(app.db, request.params.name, request.query)
  ))
}

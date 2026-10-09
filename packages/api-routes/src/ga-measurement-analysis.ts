import { and, eq, gte, lte, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  gaAcquisitionDaily,
  gaDailyTotals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gscDailyTotals,
  gscQueryDailyTotals,
  gscSearchData,
} from '@ainyc/canonry-db'
import {
  AiEngineLeadRateUnavailableReasons,
  aiEngineForReferralSource,
  aiReferralEngineLabel,
  AiReferralTrafficClasses,
  classifyAiReferralTrafficClass,
  filterBrandedSeedCandidates,
  gaMeasurementAnalysisDtoSchema,
  gaMeasurementAnalysisWindowSchema,
  gaMeasurementHostScopeSchema,
  hostOf,
  hostMatchesAnyDomain,
  isGa4AiAssistantChannel,
  normalizeUrlPath,
  RatioUnits,
  roundRatio,
  validationError,
} from '@ainyc/canonry-contracts'
import type {
  AiEngineLeadRateUnavailableReason,
  AiReferralEngine,
  AiReferralTrafficClass,
  GaMeasurementAnalysisDto,
  GaMeasurementAnalysisWindow,
  GaMeasurementComponentStatus,
} from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

type Database = FastifyInstance['db']
type WindowDays = 30 | 60 | 90
type PeriodLabel = 'earliest' | 'middle' | 'previous' | 'latest'
const UNKNOWN_LANDING_PAGE = '(not set)'
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

// Plain code-unit order, so the wire order of raw source strings does not
// depend on the server's locale.
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

function aiEngineLeadPeriods(
  periods: Period[],
  eventCounts: number[],
  sessionCounts: number[],
  leadRateAvailable: boolean,
) {
  return periods.map((period, index) => {
    const eventCount = eventCounts[index] ?? 0
    const sessions = sessionCounts[index] ?? 0
    return {
      ...period,
      eventCount,
      sessions,
      leadRate: leadRateAvailable && sessions > 0
        ? roundRatio(eventCount / sessions, RatioUnits.fraction)
        : null,
    }
  })
}

type AiSourceRow = {
  date: string
  source: string
  medium: string
  channelGroup: string
  landingPage: string
}

const UNATTRIBUTED_AI = '(unattributed)'
type AiAttributionKey = AiReferralEngine | typeof UNATTRIBUTED_AI

type AttributedAiRow = {
  date: string
  source: string
  key: AiAttributionKey
  trafficClass: AiReferralTrafficClass
  value: number
}

/** One traffic class of the breakdown: engine rows, the unattributed AI channel rows, and their total. */
function buildAiEngineLeadClass(input: {
  periods: Period[]
  leads: AttributedAiRow[]
  sessions: AttributedAiRow[]
  leadRateAvailable: boolean
}) {
  const { periods, leadRateAvailable } = input
  const sourcesByKey = new Map<AiAttributionKey, Set<string>>()
  for (const row of [...input.leads, ...input.sessions]) {
    const sources = sourcesByKey.get(row.key) ?? new Set<string>()
    sources.add(row.source)
    sourcesByKey.set(row.key, sources)
  }
  const leadsByKey = aggregateByKey(input.leads, periods, row => row.key, row => row.value)
  const sessionsByKey = aggregateByKey(input.sessions, periods, row => row.key, row => row.value)
  const zeros = Array<number>(periods.length).fill(0)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  const countsFor = (key: AiAttributionKey) => ({
    leads: leadsByKey.get(key) ?? zeros,
    sessions: sessionsByKey.get(key) ?? zeros,
  })
  const sourcesFor = (key: AiAttributionKey) => (
    [...(sourcesByKey.get(key) ?? [])].sort(compareCodeUnits)
  )
  const engineRows = [...sourcesByKey.keys()]
    .filter((key): key is AiReferralEngine => key !== UNATTRIBUTED_AI)
    .map(engine => ({ engine, ...countsFor(engine) }))
    .sort((left, right) => (
      (right.leads.at(-1) ?? 0) - (left.leads.at(-1) ?? 0)
      || sum(right.leads) - sum(left.leads)
      || (right.sessions.at(-1) ?? 0) - (left.sessions.at(-1) ?? 0)
      || sum(right.sessions) - sum(left.sessions)
      || left.engine.localeCompare(right.engine)
    ))
  const unattributed = countsFor(UNATTRIBUTED_AI)
  const allRows = [...engineRows, unattributed]
  const totalLeads = periods.map((_, index) => sum(allRows.map(row => row.leads[index] ?? 0)))
  const totalSessions = periods.map((_, index) => sum(allRows.map(row => row.sessions[index] ?? 0)))

  return {
    periods: aiEngineLeadPeriods(periods, totalLeads, totalSessions, leadRateAvailable),
    engines: engineRows.map(row => ({
      engine: row.engine,
      label: aiReferralEngineLabel(row.engine),
      sources: sourcesFor(row.engine),
      periods: aiEngineLeadPeriods(periods, row.leads, row.sessions, leadRateAvailable),
    })),
    unattributed: {
      sources: sourcesFor(UNATTRIBUTED_AI),
      periods: aiEngineLeadPeriods(periods, unattributed.leads, unattributed.sessions, leadRateAvailable),
    },
  }
}

/**
 * Attribute lead and session rows to an AI engine and a traffic class. Both
 * sides go through `aiEngineForReferralSource` on GA4 `sessionSource` and
 * `classifyAiReferralTrafficClass`, on the same evidence: when the lead rows
 * are channel-scoped they carry no landing page, so `landingPageEvidence` is
 * false and neither side reads one. A row whose source matches no engine is
 * kept, as unattributed, only when GA4 put it in its own AI channel group.
 *
 * `paidOnlyByLandingPage` is true when some attributed row is paid with its
 * landing page and organic without it: dropping the landing page moved it to
 * organic, so the paid/organic split (and every rate on it) is not honest.
 */
function attributeAiEngineRows(input: {
  leads: Array<AiSourceRow & { eventCount: number }>
  sessions: Array<AiSourceRow & { sessions: number }>
  landingPageEvidence: boolean
}): { leads: AttributedAiRow[]; sessions: AttributedAiRow[]; paidOnlyByLandingPage: boolean } {
  const engineBySource = new Map<string, AiReferralEngine | null>()
  const engineOf = (source: string) => {
    let engine = engineBySource.get(source)
    if (engine === undefined) {
      engine = aiEngineForReferralSource(source)
      engineBySource.set(source, engine)
    }
    return engine
  }
  let paidOnlyByLandingPage = false
  const attribute = <T extends AiSourceRow>(
    rows: T[],
    valueOf: (row: T) => number,
  ): AttributedAiRow[] => rows.flatMap((row) => {
    const engine = engineOf(row.source)
    if (engine === null && !isGa4AiAssistantChannel(row.channelGroup)) return []
    const evidence = { source: row.source, medium: row.medium, channelGroup: row.channelGroup }
    // The raw landing page keeps the utm parameters the classifier reads.
    const withLandingPage = classifyAiReferralTrafficClass({ ...evidence, landingPage: row.landingPage })
    const trafficClass = input.landingPageEvidence
      ? withLandingPage
      : classifyAiReferralTrafficClass({ ...evidence, landingPage: null })
    if (trafficClass !== withLandingPage) paidOnlyByLandingPage = true
    return [{
      date: row.date,
      source: row.source,
      key: engine ?? UNATTRIBUTED_AI,
      trafficClass,
      value: valueOf(row),
    }]
  })
  const leads = attribute(input.leads, row => row.eventCount)
  const sessions = attribute(input.sessions, row => row.sessions)
  return { leads, sessions, paidOnlyByLandingPage }
}

/**
 * Lead events and sessions per AI engine, in the same buckets as the channel
 * breakdown, split into organic and paid. Both sides arrive here attributed
 * on the same evidence and already host/path filtered the way the channel
 * breakdown filters them, so a rate divides like by like unless the caller
 * gives a reason it cannot.
 */
function buildAiEngineLeads(input: {
  periods: Period[]
  leads: AttributedAiRow[]
  sessions: AttributedAiRow[]
  leadRateUnavailableReason: AiEngineLeadRateUnavailableReason | null
}) {
  const leadRateAvailable = input.leadRateUnavailableReason === null
  const classBlock = (trafficClass: AiReferralTrafficClass) => buildAiEngineLeadClass({
    periods: input.periods,
    leads: input.leads.filter(row => row.trafficClass === trafficClass),
    sessions: input.sessions.filter(row => row.trafficClass === trafficClass),
    leadRateAvailable,
  })

  return {
    leadRateAvailable,
    leadRateUnavailableReason: input.leadRateUnavailableReason,
    organic: classBlock(AiReferralTrafficClasses.organic),
    paid: classBlock(AiReferralTrafficClasses.paid),
  }
}

function latestDate(rows: Array<{ date: string }>): string | null {
  let latest: string | null = null
  for (const row of rows) {
    if (latest === null || row.date > latest) latest = row.date
  }
  return latest
}

/** True when some day with a stored lead row has no stored acquisition row at all. */
function hasLeadDayWithoutSessions(
  acquisitionRows: Array<{ date: string }>,
  leadRows: Array<{ date: string }>,
): boolean {
  const acquisitionDates = new Set(acquisitionRows.map(row => row.date))
  return leadRows.some(row => !acquisitionDates.has(row.date))
}

/**
 * Why a lead rate would divide unlike data, or null when it is honest. The
 * coverage checks read the unfiltered rows of the window: acquisition and
 * leads are separate sync components, and when acquisition stops landing (or
 * skips days) while leads keep landing, a bucket holds leads for days with no
 * stored sessions.
 */
function aiEngineLeadRateUnavailableReason(input: {
  hasData: boolean
  acquisitionStatus: GaMeasurementComponentStatus | undefined
  leadStatus: GaMeasurementComponentStatus | undefined
  channelLeadsUnfiltered: boolean
  paidOnlyByLandingPage: boolean
  latestAcquisitionDate: string | null
  latestLeadDate: string | null
  leadDayWithoutSessions: boolean
}): AiEngineLeadRateUnavailableReason | null {
  if (!input.hasData) return AiEngineLeadRateUnavailableReasons['no-data']
  if (input.acquisitionStatus !== 'ready' || input.leadStatus !== 'ready') {
    return AiEngineLeadRateUnavailableReasons['sync-not-ready']
  }
  if (input.channelLeadsUnfiltered) return AiEngineLeadRateUnavailableReasons['channel-leads-unfiltered']
  if (input.paidOnlyByLandingPage) return AiEngineLeadRateUnavailableReasons['paid-split-needs-landing-page']
  if (
    input.latestLeadDate !== null
    && (input.latestAcquisitionDate === null || input.latestAcquisitionDate < input.latestLeadDate)
  ) {
    return AiEngineLeadRateUnavailableReasons['sessions-behind-leads']
  }
  if (input.leadDayWithoutSessions) return AiEngineLeadRateUnavailableReasons['sessions-missing-on-lead-days']
  return null
}

type EngagementRow = typeof gaDailyTotals.$inferSelect

/**
 * Rolls the property-level daily series up into one bucket per period.
 *
 * Two aggregation rules, both load-bearing:
 *
 * 1. `engagementRate` is a RATE, so it is weighted by sessions rather than
 *    averaged. GA4's engagementRate is engagedSessions / sessions and sessions
 *    ARE additive, so the weighted mean equals the bucket's true rate. A plain
 *    mean would let a 3-session day outvote a 3,000-session one.
 * 2. Every metric stays `null` when no day in the bucket carries a reading.
 *    Days written before the metrics existed hold NULL, and reporting those as
 *    0 would draw a real "nobody engaged, nobody returned" line for the whole
 *    pre-migration span.
 */
function engagementPeriods(periods: Period[], rows: EngagementRow[]) {
  return periods.map((period) => {
    const inPeriod = rows.filter(row => row.date >= period.startDate && row.date <= period.endDate)

    const rateDays = inPeriod.filter(row => row.engagementRate !== null)
    const weight = rateDays.reduce((sum, row) => sum + row.sessions, 0)
    const weighted = rateDays.reduce((sum, row) => sum + row.engagementRate! * row.sessions, 0)

    const splitDays = inPeriod.filter(row => row.newUsers !== null)
    const dailyTotalUsers = splitDays.reduce((sum, row) => sum + row.users, 0)
    const dailyNewUsers = splitDays.reduce((sum, row) => sum + row.newUsers!, 0)

    return {
      ...period,
      sessions: inPeriod.reduce((sum, row) => sum + row.sessions, 0),
      // A bucket whose reading-days had no sessions has no rate to report; the
      // weighted mean would be 0/0.
      engagementRate: rateDays.length > 0 && weight > 0 ? weighted / weight : null,
      dailyTotalUsers: splitDays.length > 0 ? dailyTotalUsers : null,
      dailyNewUsers: splitDays.length > 0 ? dailyNewUsers : null,
      // Null on a zero denominator too: a share of no users is not 0%.
      metricsAvailable: rateDays.length > 0 || splitDays.length > 0,
      daysInPeriod: inPeriod.length,
      daysWithEngagementRate: rateDays.length,
      daysWithUserSplit: splitDays.length,
    }
  })
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
  return hostMatchesAnyDomain(value, marketingHosts)
}

function normalizeLandingPage(value: string | null | undefined): string {
  return normalizeUrlPath(value) ?? UNKNOWN_LANDING_PAGE
}

function normalizePathPrefix(value: string | undefined): string | null {
  if (!value) return null
  const normalized = normalizeUrlPath(value)
  if (!normalized) return null
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
  if (separator < 0) return [key, UNKNOWN_LANDING_PAGE]
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

  const scopedConditions = (
    hostColumn: typeof gaAcquisitionDaily.hostName | typeof gaLeadEventsDaily.hostName,
    normalizedPathColumn: typeof gaAcquisitionDaily.landingPageNormalized | typeof gaLeadEventsDaily.landingPageNormalized,
    rawPathColumn: typeof gaAcquisitionDaily.landingPage | typeof gaLeadEventsDaily.landingPage,
  ) => {
    const conditions = []
    if (parsedHostScope.data === 'marketing') {
      const lowerHost = sql`lower(${hostColumn})`
      const normalizedHost = sql`case when ${lowerHost} like 'www.%' then substr(${lowerHost}, 5) else ${lowerHost} end`
      conditions.push(or(...marketingHosts.flatMap(host => [
        sql`${normalizedHost} = ${host}`,
        sql`${normalizedHost} like ${`%.${host}`}`,
      ])))
    }
    if (pathPrefix && pathPrefix !== '/') {
      const rawPath = sql`case when instr(${rawPathColumn}, '?') = 0 then ${rawPathColumn} else substr(${rawPathColumn}, 1, instr(${rawPathColumn}, '?') - 1) end`
      const landingPath = sql`case when trim(coalesce(${normalizedPathColumn}, '')) = '' then ${rawPath} else ${normalizedPathColumn} end`
      conditions.push(or(sql`${landingPath} = ${pathPrefix}`, sql`${landingPath} like ${`${pathPrefix}/%`}`))
    }
    return conditions
  }
  const acquisitionScope = scopedConditions(gaAcquisitionDaily.hostName, gaAcquisitionDaily.landingPageNormalized, gaAcquisitionDaily.landingPage)
  const leadLandingScope = scopedConditions(gaLeadEventsDaily.hostName, gaLeadEventsDaily.landingPageNormalized, gaLeadEventsDaily.landingPage)
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
  const acquisitionRows = gaStartDate ? db.select().from(gaAcquisitionDaily).where(and(eq(gaAcquisitionDaily.projectId, project.id), gte(gaAcquisitionDaily.date, gaStartDate), lte(gaAcquisitionDaily.date, gaAnchor!))).all() : []
  const leadRows = gaStartDate ? db.select().from(gaLeadEventsDaily).where(and(eq(gaLeadEventsDaily.projectId, project.id), gte(gaLeadEventsDaily.date, gaStartDate), lte(gaLeadEventsDaily.date, gaAnchor!))).all() : []
  // The engagement series is anchored on its OWN table rather than on the
  // acquisition/lead anchor: `ga_daily_totals` is written by every GA sync,
  // while acquisition and leads are a separate measurement sync that may never
  // have run. Same pattern `searchDemand` already uses for the GSC anchor.
  const engagementAnchor = db.select({ date: sql<string | null>`max(${gaDailyTotals.date})` })
    .from(gaDailyTotals).where(eq(gaDailyTotals.projectId, project.id)).get()?.date ?? null
  const engagementPeriodWindow = engagementAnchor ? buildPeriods(engagementAnchor, days) : []
  const engagementStartDate = engagementPeriodWindow[0]?.startDate
  const engagementRows = engagementStartDate
    ? db.select().from(gaDailyTotals).where(and(
        eq(gaDailyTotals.projectId, project.id),
        gte(gaDailyTotals.date, engagementStartDate),
        lte(gaDailyTotals.date, engagementAnchor!),
      )).all()
    : []
  // Ignores the requested window on purpose: this is the date the metric began
  // existing for the project, which is what tells a caller that an earlier gap
  // is unmeasured rather than empty.
  const engagementAvailableFrom = db.select({
    date: sql<string | null>`min(${gaDailyTotals.date})`,
  }).from(gaDailyTotals).where(and(
    eq(gaDailyTotals.projectId, project.id),
    or(
      sql`${gaDailyTotals.engagementRate} is not null`,
      sql`${gaDailyTotals.newUsers} is not null`,
    ),
  )).get()?.date ?? null

  const gscAnchor = db.select({ date: sql<string | null>`max(${gscDailyTotals.date})` })
    .from(gscDailyTotals).where(eq(gscDailyTotals.projectId, project.id)).get()?.date ?? null
  const gscPeriods = gscAnchor ? buildPeriods(gscAnchor, days) : []
  const gscStartDate = gscPeriods[0]?.startDate
  const propertyRows = gscStartDate ? db.select().from(gscDailyTotals).where(and(eq(gscDailyTotals.projectId, project.id), gte(gscDailyTotals.date, gscStartDate), lte(gscDailyTotals.date, gscAnchor!))).all() : []
  const queryRows = gscStartDate ? db.select().from(gscQueryDailyTotals).where(and(eq(gscQueryDailyTotals.projectId, project.id), gte(gscQueryDailyTotals.date, gscStartDate), lte(gscQueryDailyTotals.date, gscAnchor!))).all() : []
  const rawPageRows = gscStartDate ? db.select().from(gscSearchData).where(and(eq(gscSearchData.projectId, project.id), gte(gscSearchData.date, gscStartDate), lte(gscSearchData.date, gscAnchor!))).all() : []
  const state = db.select().from(gaMeasurementSyncStates)
    .where(eq(gaMeasurementSyncStates.projectId, project.id)).get()
  const acquisition = acquisitionRows.filter((row) => {
    const landingPage = normalizeLandingPage(row.landingPageNormalized ?? row.landingPage)
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
      `${row.hostName}\u0000${normalizeLandingPage(row.landingPageNormalized ?? row.landingPage)}`
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
    const landingPage = normalizeLandingPage(row.landingPageNormalized ?? row.landingPage)
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
  // Channel-scoped lead rows carry no landing page, so the host/path filters
  // that narrow the session side cannot narrow them. A rate is only honest
  // when those filters are no-ops (every host, whole site).
  const filtersNarrowSessions = parsedHostScope.data === 'marketing'
    || (pathPrefix !== null && pathPrefix !== '/')
  // Without a lead timeline there is nothing to divide, so the block stays
  // empty even when AI sessions exist.
  const hasAiEngineLeadData = gaAnchor !== null && hasLeadTimeline
  // Channel-scoped lead rows carry no landing page either, so the sessions
  // are classified without theirs: otherwise one session's lead and the
  // session itself could land in different traffic classes.
  const aiEngineRows = attributeAiEngineRows({
    leads: hasAiEngineLeadData ? leads : [],
    sessions: hasAiEngineLeadData ? acquisition : [],
    landingPageEvidence: attributionScope !== 'channel',
  })
  const aiEngineLeads = buildAiEngineLeads({
    periods: hasAiEngineLeadData ? gaPeriods : [],
    leads: aiEngineRows.leads,
    sessions: aiEngineRows.sessions,
    leadRateUnavailableReason: aiEngineLeadRateUnavailableReason({
      hasData: hasAiEngineLeadData,
      acquisitionStatus: state?.acquisitionStatus,
      leadStatus: state?.leadStatus,
      channelLeadsUnfiltered: attributionScope === 'channel' && filtersNarrowSessions,
      paidOnlyByLandingPage: aiEngineRows.paidOnlyByLandingPage,
      latestAcquisitionDate: latestDate(acquisitionRows),
      latestLeadDate: latestDate(leadRows),
      leadDayWithoutSessions: hasLeadDayWithoutSessions(acquisitionRows, leadRows),
    }),
  })

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
      aiEngines: aiEngineLeads,
    },
    engagement: {
      status: engagementAnchor === null ? 'unavailable' : 'ready',
      availableFromDate: engagementAvailableFrom,
      latestDate: engagementAnchor,
      periods: engagementPeriods(engagementPeriodWindow, engagementRows),
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

import { and, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  gaAcquisitionDaily,
  gaDailyTotals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gaSyncCoverage,
} from '@canonry/canonry-db'
import {
  AiReferralTrafficClasses,
  SOCIAL_PLATFORM_RANKING_MIN_SESSIONS,
  breakdownShares,
  buildStackedDailySeries,
  classifyAiReferralTrafficClass,
  formatPercent,
  formatPerThousand,
  percentOf,
  shareOf,
  socialPlatformForReferralSource,
  socialPlatformLabel,
} from '@canonry/canonry-contracts'
import type {
  AiEngineLeadRateUnavailableReason,
  AiReferralTrafficClass,
  GA4SocialPlatformPerformanceDto,
  GA4SocialPlatformPerformanceRowDto,
  GA4SocialPlatformPerformanceSourceDto,
  GA4SocialPlatformTrafficClassDto,
  MeasurementConfig,
  SocialPlatform,
} from '@canonry/canonry-contracts'
import { hasLeadDayWithoutSessions, latestDate, leadRateUnavailableReason, resolveLeadEvents } from './ga-lead-rate.js'

type Database = FastifyInstance['db']

/** GA4's own social channel groups: a source in them stays even when no platform matches it. */
const SOCIAL_CHANNEL_GROUPS = new Set(['Organic Social', 'Paid Social'])

/** Charted platforms before the rest fold into `other`. */
const CHART_SERIES_LIMIT = 5

/** A source, medium and channel group with its summed value (sessions or counted events). */
export interface SourceKeyRow {
  source: string
  medium: string
  channelGroup: string
  value: number
}

export interface DailySourceRow {
  date: string
  source: string
  channelGroup: string
  sessions: number
}

interface PlatformGroup {
  key: string
  platform: SocialPlatform | null
}

/**
 * The platform a GA4 row belongs to, or null when the row is not social.
 *
 * A source that names a platform counts in any channel group (an ad tagged
 * `fb_ads` that GA4 files under Paid Other is still Facebook). A source no
 * platform matches counts only when GA4 itself filed it as social, and then
 * forms its own group, as the GA4 social channel table does. Inside the
 * Social channel the match is the same one `groupSocialPlatforms` makes.
 */
export function socialPlatformGroupFor(source: string, channelGroup: string): PlatformGroup | null {
  const socialChannel = SOCIAL_CHANNEL_GROUPS.has(channelGroup)
  // Outside GA4's Social channel a one-letter word (`x` in `promo-x`) is too
  // weak to name a platform; there only a hostname or a longer word counts.
  const platform = socialPlatformForReferralSource(source, socialChannel ? {} : { minLabelLength: 2 })
  if (platform) return { key: platform, platform }
  if (socialChannel) return { key: `source:${source}`, platform: null }
  return null
}

function groupLabel(group: PlatformGroup, source: string): string {
  return group.platform ? socialPlatformLabel(group.platform) : source
}

/** Paid vs organic from the row's own source, medium and channel group; the landing page is never read, on either side. */
function trafficClassOf(row: { source: string; medium: string; channelGroup: string }): AiReferralTrafficClass {
  return classifyAiReferralTrafficClass({
    source: row.source,
    medium: row.medium,
    channelGroup: row.channelGroup,
    landingPage: null,
  })
}

/** Conversions per 1,000 sessions, to two decimals; null when it cannot be measured. */
export function conversionsPerThousand(conversions: number | null, sessions: number, available: boolean): number | null {
  if (!available || conversions === null || sessions <= 0) return null
  return Number(((conversions / sessions) * 1000).toFixed(2))
}

function rateFields(conversions: number | null, sessions: number, available: boolean) {
  const perThousand = conversionsPerThousand(conversions, sessions, available)
  return {
    conversions,
    conversionsPerThousandSessions: perThousand,
    conversionsPerThousandSessionsDisplay: formatPerThousand(perThousand),
  }
}

function sourceKey(row: { source: string; medium: string; channelGroup: string }): string {
  return `${row.source}\u0000${row.medium}\u0000${row.channelGroup}`
}

// Plain code-unit order, so ties never depend on the server's locale.
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

export interface SocialPlatformPerformanceInput {
  /** Acquisition sessions in the window, summed by source, medium and channel group (every channel). */
  sessionRows: readonly SourceKeyRow[]
  /** Counted conversion events in the window by the same key; null when no conversion event is measured. */
  conversionRows: readonly SourceKeyRow[] | null
  /** Acquisition sessions by date, source and channel group, for the chart. */
  dailyRows: readonly DailySourceRow[]
  /** True when acquisition rows are stored for the window at all. */
  hasAcquisitionRows: boolean
  /** GA4 sessions for the window from the daily totals (once per session); null when not stored. */
  siteSessions: number | null
  /** Every counted conversion event in the window, all channels; null when none is measured. */
  siteConversions: number | null
  /** `/ga/traffic` `totalSessions`, the base of `sharePct`. */
  totalSessions: number
  countedEventNames: readonly string[]
  conversionRateUnavailableReason: AiEngineLeadRateUnavailableReason | null
  minSessions?: number
}

interface PlatformAccumulator {
  key: string
  platform: SocialPlatform | null
  label: string
  sessions: number
  paidSessions: number
  organicSessions: number
  conversions: number
  paidConversions: number
  organicConversions: number
  channelSessions: Map<string, number>
  sources: Map<string, {
    source: string
    medium: string
    channelGroup: string
    trafficClass: AiReferralTrafficClass
    sessions: number
    conversions: number
  }>
}

/**
 * Sessions, conversions and a ranking per social or creator platform.
 *
 * Pure over pre-aggregated rows so the invariants are testable: every row is
 * classified once, by the same rule on both sides, and lands in exactly one
 * platform; the platforms' sessions add up to `sessions`; paid plus organic
 * equals each platform's sessions; and a rank only ever goes to a platform
 * with at least `minSessions` sessions while rates are available.
 */
export function buildSocialPlatformPerformance(input: SocialPlatformPerformanceInput): GA4SocialPlatformPerformanceDto {
  const minSessions = input.minSessions ?? SOCIAL_PLATFORM_RANKING_MIN_SESSIONS
  const conversionsMeasured = input.conversionRows !== null
  const rateAvailable = conversionsMeasured && input.conversionRateUnavailableReason === null

  if (!input.hasAcquisitionRows) {
    return {
      status: 'unavailable',
      unavailableReason: 'sessions-not-synced',
      sessions: 0,
      sharePct: 0,
      sharePctDisplay: formatPercent(null),
      paidSessions: 0,
      paidShare: 0,
      conversions: null,
      conversionRateAvailable: false,
      conversionRateUnavailableReason: input.conversionRateUnavailableReason,
      countedEventNames: [...input.countedEventNames],
      minSessions,
      site: { sessions: input.siteSessions, ...rateFields(input.siteConversions, input.siteSessions ?? 0, false) },
      platforms: [],
      daily: buildStackedDailySeries([], { limit: CHART_SERIES_LIMIT, otherLabel: 'Other' }),
    }
  }

  const platforms = new Map<string, PlatformAccumulator>()
  const accumulate = (row: SourceKeyRow, side: 'sessions' | 'conversions') => {
    const group = socialPlatformGroupFor(row.source, row.channelGroup)
    if (!group) return
    let platform = platforms.get(group.key)
    if (!platform) {
      platform = {
        key: group.key,
        platform: group.platform,
        label: groupLabel(group, row.source),
        sessions: 0,
        paidSessions: 0,
        organicSessions: 0,
        conversions: 0,
        paidConversions: 0,
        organicConversions: 0,
        channelSessions: new Map(),
        sources: new Map(),
      }
      platforms.set(group.key, platform)
    }
    const trafficClass = trafficClassOf(row)
    const key = sourceKey(row)
    let source = platform.sources.get(key)
    if (!source) {
      source = { source: row.source, medium: row.medium, channelGroup: row.channelGroup, trafficClass, sessions: 0, conversions: 0 }
      platform.sources.set(key, source)
    }
    const paid = trafficClass === AiReferralTrafficClasses.paid
    if (side === 'sessions') {
      source.sessions += row.value
      platform.sessions += row.value
      if (paid) platform.paidSessions += row.value
      else platform.organicSessions += row.value
      platform.channelSessions.set(row.channelGroup, (platform.channelSessions.get(row.channelGroup) ?? 0) + row.value)
    } else {
      source.conversions += row.value
      platform.conversions += row.value
      if (paid) platform.paidConversions += row.value
      else platform.organicConversions += row.value
      if (!platform.channelSessions.has(row.channelGroup)) platform.channelSessions.set(row.channelGroup, 0)
    }
  }
  for (const row of input.sessionRows) accumulate(row, 'sessions')
  for (const row of input.conversionRows ?? []) accumulate(row, 'conversions')

  const ordered = [...platforms.values()].sort((a, b) => (
    b.sessions - a.sessions || compareCodeUnits(a.label, b.label)
  ))
  const totalSessions = ordered.reduce((sum, platform) => sum + platform.sessions, 0)
  const paidSessions = ordered.reduce((sum, platform) => sum + platform.paidSessions, 0)
  const totalConversions = conversionsMeasured
    ? ordered.reduce((sum, platform) => sum + platform.conversions, 0)
    : null
  const platformShares = breakdownShares(ordered.map(platform => platform.sessions))
  const allSources = ordered.flatMap(platform => [...platform.sources.values()])
  const sourceShares = new Map(allSources.map((source, index) => [source, index]))
  const sourceShareValues = breakdownShares(allSources.map(source => source.sessions))

  const conversionsOf = (value: number) => (conversionsMeasured ? value : null)
  const classBlock = (sessions: number, conversions: number): GA4SocialPlatformTrafficClassDto => ({
    sessions,
    ...rateFields(conversionsOf(conversions), sessions, rateAvailable),
  })

  const rows: GA4SocialPlatformPerformanceRowDto[] = ordered.map((platform, index) => {
    const sources: GA4SocialPlatformPerformanceSourceDto[] = [...platform.sources.values()]
      .sort((a, b) => (
        b.sessions - a.sessions
        || b.conversions - a.conversions
        || compareCodeUnits(sourceKey(a), sourceKey(b))
      ))
      .map(source => ({
        source: source.source,
        medium: source.medium,
        channelGroup: source.channelGroup,
        trafficClass: source.trafficClass,
        sessions: source.sessions,
        share: sourceShareValues[sourceShares.get(source)!] ?? 0,
        ...rateFields(conversionsOf(source.conversions), source.sessions, rateAvailable),
      }))
    return {
      key: platform.key,
      platform: platform.platform,
      label: platform.label,
      sessions: platform.sessions,
      organicSessions: platform.organicSessions,
      paidSessions: platform.paidSessions,
      share: platformShares[index] ?? 0,
      ...rateFields(conversionsOf(platform.conversions), platform.sessions, rateAvailable),
      enoughSessions: platform.sessions >= minSessions,
      rank: null,
      paid: classBlock(platform.paidSessions, platform.paidConversions),
      organic: classBlock(platform.organicSessions, platform.organicConversions),
      channelGroups: [...platform.channelSessions.entries()]
        .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
        .map(([channelGroup]) => channelGroup),
      sources,
    }
  })

  // Rank only what the rule allows: enough sessions and a measurable rate.
  const ranked = rows
    .filter(row => row.enoughSessions && row.conversionsPerThousandSessions !== null)
    .sort((a, b) => (
      b.conversionsPerThousandSessions! - a.conversionsPerThousandSessions!
      || (b.conversions ?? 0) - (a.conversions ?? 0)
      || b.sessions - a.sessions
      || compareCodeUnits(a.label, b.label)
    ))
  ranked.forEach((row, index) => { row.rank = index + 1 })

  const labelByKey = new Map(rows.map(row => [row.key, row.label]))
  const daily = buildStackedDailySeries(
    input.dailyRows.flatMap((row) => {
      const group = socialPlatformGroupFor(row.source, row.channelGroup)
      if (!group) return []
      return [{ date: row.date, key: group.key, label: labelByKey.get(group.key) ?? groupLabel(group, row.source), sessions: row.sessions }]
    }),
    { limit: CHART_SERIES_LIMIT, otherLabel: 'Other' },
  )

  return {
    status: 'ready',
    unavailableReason: null,
    sessions: totalSessions,
    sharePct: percentOf(totalSessions, input.totalSessions) ?? 0,
    sharePctDisplay: formatPercent(shareOf(totalSessions, input.totalSessions)),
    paidSessions,
    paidShare: shareOf(paidSessions, totalSessions) ?? 0,
    conversions: totalConversions,
    conversionRateAvailable: rateAvailable,
    conversionRateUnavailableReason: input.conversionRateUnavailableReason,
    countedEventNames: [...input.countedEventNames],
    minSessions,
    site: {
      sessions: input.siteSessions,
      ...rateFields(input.siteConversions, input.siteSessions ?? 0, rateAvailable),
    },
    platforms: rows,
    daily,
  }
}

/**
 * Reads the stored GA4 acquisition and lead event rows for one window and
 * builds the platform block. `dateConditions` is the `/ga/traffic` window, so
 * the block measures the same dates as every other figure in that response.
 */
export function loadSocialPlatformPerformance(db: Database, input: {
  projectId: string
  measurement: Pick<MeasurementConfig, 'leadEventNames' | 'countKeyEvents'>
  dateConditions: (column: typeof gaAcquisitionDaily.date | typeof gaLeadEventsDaily.date | typeof gaDailyTotals.date) => SQL[]
  totalSessions: number
}): GA4SocialPlatformPerformanceDto {
  const acquisitionWhere = and(eq(gaAcquisitionDaily.projectId, input.projectId), ...input.dateConditions(gaAcquisitionDaily.date))
  const state = db.select().from(gaMeasurementSyncStates)
    .where(eq(gaMeasurementSyncStates.projectId, input.projectId)).get()
  const { countedEventNames, reportedEventNames } = resolveLeadEvents(input.measurement, state)

  // The days the acquisition table covers, over every source.
  const acquisitionDates = db.select({ date: gaAcquisitionDaily.date })
    .from(gaAcquisitionDaily).where(acquisitionWhere).groupBy(gaAcquisitionDaily.date).all()

  // Which sources can land in a platform: only they need the session read below.
  const platformSources = [...new Set(db.select({ source: gaAcquisitionDaily.source, channelGroup: gaAcquisitionDaily.channelGroup })
    .from(gaAcquisitionDaily)
    .where(acquisitionWhere)
    .groupBy(gaAcquisitionDaily.source, gaAcquisitionDaily.channelGroup)
    .all()
    .filter(row => socialPlatformGroupFor(row.source, row.channelGroup) !== null)
    .map(row => row.source))]

  // Sessions per day and source key, each session once. GA4's hostName is
  // event-scoped, so a session that reaches a second host (a separate checkout
  // domain) is a row on each host, while its landing page, which is
  // session-scoped, is the same on every row. The largest host row for a
  // landing page is therefore every session that landed there; summing the
  // host rows would count the crossing sessions again.
  const readPlatformSessions = () => {
    const perLandingPage = db.select({
      date: gaAcquisitionDaily.date,
      channelGroup: gaAcquisitionDaily.channelGroup,
      source: gaAcquisitionDaily.source,
      medium: gaAcquisitionDaily.medium,
      sessions: sql<number>`MAX(${gaAcquisitionDaily.sessions})`.as('sessions'),
    })
      .from(gaAcquisitionDaily)
      .where(and(acquisitionWhere, inArray(gaAcquisitionDaily.source, platformSources)))
      .groupBy(
        gaAcquisitionDaily.date,
        gaAcquisitionDaily.channelGroup,
        gaAcquisitionDaily.source,
        gaAcquisitionDaily.medium,
        gaAcquisitionDaily.landingPage,
      )
      .as('per_landing_page')
    return db.select({
      date: perLandingPage.date,
      channelGroup: perLandingPage.channelGroup,
      source: perLandingPage.source,
      medium: perLandingPage.medium,
      sessions: sql<number>`SUM(${perLandingPage.sessions})`,
    })
      .from(perLandingPage)
      .groupBy(perLandingPage.date, perLandingPage.channelGroup, perLandingPage.source, perLandingPage.medium)
      .all()
  }
  const dailyKeyRows = platformSources.length > 0 ? readPlatformSessions() : []
  const sessionTotals = new Map<string, SourceKeyRow>()
  const dailyRows: DailySourceRow[] = []
  for (const row of dailyKeyRows) {
    // A source can be a platform in one channel group and not in another
    // (an unmatched source counts only in GA4 Social).
    if (socialPlatformGroupFor(row.source, row.channelGroup) === null) continue
    const value = row.sessions ?? 0
    const key = `${row.source}\u0000${row.medium}\u0000${row.channelGroup}`
    const total = sessionTotals.get(key)
    if (total) total.value += value
    else sessionTotals.set(key, { source: row.source, medium: row.medium, channelGroup: row.channelGroup, value })
    dailyRows.push({ date: row.date, source: row.source, channelGroup: row.channelGroup, sessions: value })
  }
  const sessionRows = [...sessionTotals.values()]

  const leadWhere = reportedEventNames.length > 0
    ? and(
        eq(gaLeadEventsDaily.projectId, input.projectId),
        inArray(gaLeadEventsDaily.eventName, reportedEventNames),
        ...input.dateConditions(gaLeadEventsDaily.date),
      )
    : null
  const hasLeadTimeline = reportedEventNames.length > 0 && (state?.leadSyncedAt != null || (leadWhere !== null && db
    .select({ found: sql<number>`1` }).from(gaLeadEventsDaily).where(leadWhere).limit(1).get() !== undefined))
  const conversionRows = leadWhere && hasLeadTimeline
    ? db.select({
        source: gaLeadEventsDaily.source,
        medium: gaLeadEventsDaily.medium,
        channelGroup: gaLeadEventsDaily.channelGroup,
        value: sql<number>`SUM(${gaLeadEventsDaily.eventCount})`,
      })
        .from(gaLeadEventsDaily)
        .where(leadWhere)
        .groupBy(gaLeadEventsDaily.source, gaLeadEventsDaily.medium, gaLeadEventsDaily.channelGroup)
        .all()
        .map(row => ({ ...row, value: row.value ?? 0 }))
    : null
  const leadDates = leadWhere && hasLeadTimeline
    ? db.selectDistinct({ date: gaLeadEventsDaily.date }).from(gaLeadEventsDaily).where(leadWhere).all()
    : []

  // The whole-site reference divides every counted conversion by GA4's
  // daily session totals, which count a session once. Only when the totals
  // cover every day the acquisition table does: a partial total would pair a
  // full window of conversions with part of its sessions.
  const acquisitionDays = acquisitionDates.map(row => row.date)
  const siteTotals = acquisitionDays.length > 0
    ? db.select({
        days: sql<number>`COUNT(DISTINCT ${gaDailyTotals.date})`,
        sessions: sql<number | null>`SUM(${gaDailyTotals.sessions})`,
      }).from(gaDailyTotals).where(and(
        eq(gaDailyTotals.projectId, input.projectId),
        ...input.dateConditions(gaDailyTotals.date),
        inArray(gaDailyTotals.date, acquisitionDays),
      )).get()
    : undefined
  const siteSessions = siteTotals && siteTotals.days === acquisitionDays.length ? siteTotals.sessions : null
  const siteConversionsRow = leadWhere && hasLeadTimeline
    ? db.select({ conversions: sql<number | null>`SUM(${gaLeadEventsDaily.eventCount})` }).from(gaLeadEventsDaily).where(leadWhere).get()
    : null

  // Where the lead history starts: the earliest of the first day a lead sync
  // recorded as covered (its receipts include days with no conversions) and
  // the first stored lead event (history synced before receipts were kept).
  // A window reaching back before it holds sessions whose conversions were
  // never fetched.
  const firstLeadReceipt = reportedEventNames.length > 0
    ? db.select({ date: sql<string | null>`MIN(${gaSyncCoverage.date})` })
        .from(gaSyncCoverage)
        .where(and(eq(gaSyncCoverage.projectId, input.projectId), eq(gaSyncCoverage.component, 'leads')))
        .get()?.date ?? null
    : null
  const firstLeadRow = reportedEventNames.length > 0
    ? db.select({ date: sql<string | null>`MIN(${gaLeadEventsDaily.date})` })
        .from(gaLeadEventsDaily)
        .where(and(eq(gaLeadEventsDaily.projectId, input.projectId), inArray(gaLeadEventsDaily.eventName, reportedEventNames)))
        .get()?.date ?? null
    : null
  const leadHistoryStart = [firstLeadReceipt, firstLeadRow]
    .filter((date): date is string => date !== null)
    .sort()[0] ?? null
  const firstAcquisitionDate = acquisitionDays.reduce<string | null>(
    (first, date) => (first === null || date < first ? date : first),
    null,
  )

  const conversionRateUnavailableReason = leadRateUnavailableReason({
    hasData: conversionRows !== null && acquisitionDates.length > 0,
    acquisitionStatus: state?.acquisitionStatus ?? undefined,
    leadStatus: state?.leadStatus ?? undefined,
    // Every host and the whole site on both sides, so a channel-scoped lead
    // row (no landing page) is never narrowed differently from its sessions.
    channelLeadsUnfiltered: false,
    // Neither side reads the landing page (see `trafficClassOf`).
    paidOnlyByLandingPage: false,
    latestAcquisitionDate: latestDate(acquisitionDates),
    latestLeadDate: latestDate(leadDates),
    leadDayWithoutSessions: hasLeadDayWithoutSessions(acquisitionDates, leadDates),
    sessionsBeforeLeads: leadHistoryStart !== null && firstAcquisitionDate !== null && firstAcquisitionDate < leadHistoryStart,
  })

  return buildSocialPlatformPerformance({
    sessionRows,
    conversionRows,
    dailyRows,
    hasAcquisitionRows: acquisitionDates.length > 0,
    siteSessions,
    siteConversions: conversionRows === null ? null : (siteConversionsRow?.conversions ?? 0),
    totalSessions: input.totalSessions,
    countedEventNames: reportedEventNames.length > 0 ? reportedEventNames : countedEventNames,
    conversionRateUnavailableReason,
  })
}

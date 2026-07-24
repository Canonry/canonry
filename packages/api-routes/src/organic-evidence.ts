import { and, desc, eq, gte, lte, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  crawlerEventsHourly,
  gaAiReferrals,
  gaAcquisitionDaily,
  gaTrafficSnapshots,
  gscDailyTotals,
  gscQueryDailyTotals,
  gscSearchData,
  querySnapshots,
  runs,
  trafficSources,
} from '@ainyc/canonry-db'
import {
  AiReferralTrafficClasses,
  CitationStates,
  RunKinds,
  RunStatuses,
  VerificationStatuses,
  hostOf,
  normalizeUrlPath,
  organicEvidencePeriodSchema,
  validationError,
  type OrganicEvidenceDto,
} from '@ainyc/canonry-contracts'
import { buildBrandTokens, categorizeQueryByIntent } from '@ainyc/canonry-intelligence'
import { notProbeRun, resolveProject } from './helpers.js'
import { buildGaMeasurementAnalysis } from './ga-measurement-analysis.js'

const zero = () => ({ clicks: 0, impressions: 0 })
const UNKNOWN_LANDING_PATH = '(not set)'
const PAGE_DETAIL_LIMIT = 50
const daysBefore = (end: string, days: number) => {
  const date = new Date(`${end}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}
const normalizedPath = (value: string | null | undefined) => {
  const normalized = normalizeUrlPath(value) ?? UNKNOWN_LANDING_PATH
  return normalized.split('?')[0] || '/'
}
const inRange = (date: string, startDate: string, endDate: string) => date >= startDate && date <= endDate
const normalizedHost = (value: string) => value.trim().toLowerCase().replace(/^www\./, '')
const matchesMarketingHost = (value: string, marketingHosts: string[]) => {
  const hostname = normalizedHost(value)
  return marketingHosts.some(candidate =>
    hostname === candidate || hostname.endsWith(`.${candidate}`))
}
const pageMatchesMarketingHost = (value: string, marketingHosts: string[]) => {
  return matchesMarketingHost(hostOf(value) ?? '', marketingHosts)
}


function buildCohorts(endDate: string, periodDays: 60 | 90) {
  const names = periodDays === 60
    ? (['prior', 'latest'] as const)
    : (['earliest', 'middle', 'latest'] as const)
  return names.map((name, index) => {
    const offset = (names.length - index - 1) * 30
    const cohortEnd = daysBefore(endDate, offset)
    return { name, startDate: daysBefore(cohortEnd, 29), endDate: cohortEnd }
  })
}

function sumSearchRows(rows: Array<{ clicks: number; impressions: number }>) {
  return rows.reduce(
    (totals, row) => ({ clicks: totals.clicks + row.clicks, impressions: totals.impressions + row.impressions }),
    zero(),
  )
}

function summarizeServer(
  crawlers: Array<typeof crawlerEventsHourly.$inferSelect>,
  fetches: Array<typeof aiUserFetchEventsHourly.$inferSelect>,
  referrals: Array<typeof aiReferralEventsHourly.$inferSelect>,
) {
  const total = referrals.reduce((count, row) => count + row.sessionsOrHits, 0)
  const paid = referrals.reduce((count, row) => count + row.paidSessionsOrHits, 0)
  const organic = referrals.reduce((count, row) => count + row.organicSessionsOrHits, 0)
  return {
    crawlerHits: {
      verified: crawlers
        .filter(row => row.verificationStatus === VerificationStatuses.verified)
        .reduce((count, row) => count + row.hits, 0),
      claimedUnverified: crawlers
        .filter(row => row.verificationStatus === VerificationStatuses.claimed_unverified)
        .reduce((count, row) => count + row.hits, 0),
      unknownAiLike: crawlers
        .filter(row => row.verificationStatus === VerificationStatuses.unknown_ai_like)
        .reduce((count, row) => count + row.hits, 0),
    },
    userFetchHits: {
      verified: fetches
        .filter(row => row.verificationStatus === VerificationStatuses.verified)
        .reduce((count, row) => count + row.hits, 0),
      claimedUnverified: fetches
        .filter(row => row.verificationStatus === VerificationStatuses.claimed_unverified)
        .reduce((count, row) => count + row.hits, 0),
      unknownAiLike: fetches
        .filter(row => row.verificationStatus === VerificationStatuses.unknown_ai_like)
        .reduce((count, row) => count + row.hits, 0),
    },
    referralSessions: { total, paid, organic, unknown: Math.max(0, total - paid - organic) },
  }
}

function comparisonDetail(latest: number, prior: number): string {
  if (prior === 0) return `${latest} in the latest cohort versus 0 in the prior cohort`
  const change = Math.round(((latest - prior) / prior) * 100)
  return `${latest} in the latest cohort versus ${prior} prior (${change >= 0 ? '+' : ''}${change}%)`
}

function aggregateCoverage(row: { startDate: string | null; endDate: string | null; observedDays: number } | undefined) {
  return row?.startDate && row.endDate
    ? { startDate: row.startDate, endDate: row.endDate, observedDays: Number(row.observedDays) }
    : null
}

export function buildOrganicEvidence(
  db: FastifyInstance['db'],
  projectName: string,
  periodDays: 60 | 90,
): OrganicEvidenceDto {
  const project = resolveProject(db, projectName)
  const measurement = buildGaMeasurementAnalysis(db, projectName, {
    window: `${periodDays}d`,
    hostScope: 'marketing',
    limit: 100,
  })
  const nativeAcquisition = measurement.acquisition
  const nativeAcquisitionActive = nativeAcquisition.status !== 'never-synced'
  const marketingHosts = measurement.filters.marketingHosts
  const normalizedMarketingHosts = [...new Set(marketingHosts.map(normalizedHost).filter(Boolean))]
  const nativeStartDate = nativeAcquisition.periods[0]?.startDate
  const nativeEndDate = nativeAcquisition.periods.at(-1)?.endDate
  const gscCoverage = aggregateCoverage(db.select({
    startDate: sql<string>`min(${gscDailyTotals.date})`,
    endDate: sql<string>`max(${gscDailyTotals.date})`,
    observedDays: sql<number>`count(distinct ${gscDailyTotals.date})`,
  }).from(gscDailyTotals).where(eq(gscDailyTotals.projectId, project.id)).get())
  const legacyGaCoverage = aggregateCoverage(db.select({
    startDate: sql<string>`min(${gaTrafficSnapshots.date})`,
    endDate: sql<string>`max(${gaTrafficSnapshots.date})`,
    observedDays: sql<number>`count(distinct ${gaTrafficSnapshots.date})`,
  }).from(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, project.id)).get())
  const nativeCoverage = nativeAcquisitionActive && normalizedMarketingHosts.length
    ? aggregateCoverage(db.select({
      startDate: sql<string>`min(${gaAcquisitionDaily.date})`,
      endDate: sql<string>`max(${gaAcquisitionDaily.date})`,
      observedDays: sql<number>`count(distinct ${gaAcquisitionDaily.date})`,
    }).from(gaAcquisitionDaily).where(and(
      eq(gaAcquisitionDaily.projectId, project.id),
      or(...normalizedMarketingHosts.map(candidate =>
        sql`lower(trim(${gaAcquisitionDaily.hostName})) = ${candidate} or lower(trim(${gaAcquisitionDaily.hostName})) like ${`%.${candidate}`}`)),
    )).get())
    : null
  const gaCoverage = nativeAcquisitionActive
    ? nativeCoverage
    : legacyGaCoverage
  const asOfDate = gscCoverage?.endDate ?? gaCoverage?.endDate ?? null
  const gscEndDate = gscCoverage?.endDate
  const gaEndDate = nativeAcquisitionActive ? nativeEndDate : gaCoverage?.endDate
  const gscCohorts = gscEndDate ? buildCohorts(gscEndDate, periodDays) : []
  const gaCohorts = gaEndDate ? buildCohorts(gaEndDate, periodDays) : []
  const gscStartDate = gscEndDate ? daysBefore(gscEndDate, periodDays - 1) : null
  const gaStartDate = gaEndDate ? daysBefore(gaEndDate, periodDays - 1) : null
  const startDate = gscStartDate ?? gaStartDate ?? new Date().toISOString().slice(0, 10)
  const endDate = gscEndDate ?? gaEndDate ?? startDate
  const isInWindow = (date: string) => inRange(date, startDate, endDate)

  const gscRows = gscStartDate && gscEndDate
    ? db.select().from(gscDailyTotals).where(and(
      eq(gscDailyTotals.projectId, project.id),
      gte(gscDailyTotals.date, gscStartDate),
      lte(gscDailyTotals.date, gscEndDate),
    )).all()
    : []
  const gaRows = gaStartDate && gaEndDate
    ? db.select().from(gaTrafficSnapshots).where(and(
      eq(gaTrafficSnapshots.projectId, project.id),
      gte(gaTrafficSnapshots.date, gaStartDate),
      lte(gaTrafficSnapshots.date, gaEndDate),
    )).all()
    : []
  const nativeAcquisitionRows = nativeAcquisitionActive && nativeStartDate && nativeEndDate
    ? db.select().from(gaAcquisitionDaily).where(and(
      eq(gaAcquisitionDaily.projectId, project.id),
      gte(gaAcquisitionDaily.date, nativeStartDate),
      lte(gaAcquisitionDaily.date, nativeEndDate),
    )).all().filter(row => matchesMarketingHost(row.hostName, marketingHosts))
    : []
  const nativeOrganicRows = nativeAcquisitionRows.filter(row => row.channelGroup === 'Organic Search')
  const nativeWindowOrganicRows = nativeOrganicRows

  const gscWindow = gscRows.filter(row => isInWindow(row.date))
  const propertyTotals = sumSearchRows(gscWindow)
  let namedBrand = zero()
  let namedNonBrand = zero()
  let suppressedOrUnreportedResidual = zero()
  if (measurement.searchDemand.status === 'ready') {
    namedBrand = measurement.searchDemand.periods.reduce(
      (sum, period) => ({
        clicks: sum.clicks + period.brandedClicks,
        impressions: sum.impressions + period.brandedImpressions,
      }),
      zero(),
    )
    namedNonBrand = measurement.searchDemand.periods.reduce(
      (sum, period) => ({
        clicks: sum.clicks + period.nonBrandedClicks,
        impressions: sum.impressions + period.nonBrandedImpressions,
      }),
      zero(),
    )
    suppressedOrUnreportedResidual = measurement.searchDemand.periods.reduce(
      (sum, period) => ({
        clicks: sum.clicks + period.unreportedClicks,
        impressions: sum.impressions + period.unreportedImpressions,
      }),
      zero(),
    )
  } else {
    const brandTokens = buildBrandTokens(
      project.canonicalDomain,
      [project.displayName, ...project.aliases],
    )
    const namedRows = db.select().from(gscQueryDailyTotals)
      .where(and(
        eq(gscQueryDailyTotals.projectId, project.id),
        gte(gscQueryDailyTotals.date, startDate),
        lte(gscQueryDailyTotals.date, endDate),
      )).all()
    for (const row of namedRows) {
      const isBrand = categorizeQueryByIntent(row.query, brandTokens) === 'brand'
      const target = isBrand ? namedBrand : namedNonBrand
      target.clicks += row.clicks
      target.impressions += row.impressions
    }
    suppressedOrUnreportedResidual = {
      clicks: Math.max(0, propertyTotals.clicks - namedBrand.clicks - namedNonBrand.clicks),
      impressions: Math.max(
        0,
        propertyTotals.impressions - namedBrand.impressions - namedNonBrand.impressions,
      ),
    }
  }
  const gsc = gscRows.length ? {
    propertyTotals,
    namedBrand,
    namedNonBrand,
    suppressedOrUnreportedResidual,
    cohorts: gscCohorts.map(cohort => ({
      ...cohort,
      totals: sumSearchRows(gscRows.filter(row => inRange(row.date, cohort.startDate, cohort.endDate))),
    })),
  } : null

  const pageSearchRows = db.select().from(gscSearchData)
    .where(and(eq(gscSearchData.projectId, project.id), gte(gscSearchData.date, startDate), lte(gscSearchData.date, endDate))).all()
    .filter(row => pageMatchesMarketingHost(row.page, marketingHosts))
  const gaWindow = gaStartDate && gaEndDate ? gaRows.filter(row => inRange(row.date, gaStartDate, gaEndDate)) : []
  const legacyGaCohorts = gaCohorts.map(cohort => ({
    ...cohort,
    organicSessions: gaRows
      .filter(row => inRange(row.date, cohort.startDate, cohort.endDate))
      .reduce((count, row) => count + row.organicSessions, 0),
  }))
  let ga4 = gaRows.length ? {
    organicSessions: gaWindow.reduce((count, row) => count + row.organicSessions, 0),
    cohorts: legacyGaCohorts,
  } : null

  if (nativeAcquisitionActive && nativeAcquisition.periods.length === 0) {
    ga4 = null
  } else if (nativeAcquisitionActive) {
    const organic = nativeAcquisition.channels.find(row => row.channelGroup === 'Organic Search')
    const nativeCohort = (period: typeof nativeAcquisition.periods[number]) => ({
      name: period.label === 'previous' ? 'prior' as const : period.label,
      startDate: period.startDate,
      endDate: period.endDate,
    })
    ga4 = {
      organicSessions: organic?.periods.reduce((sum, row) => sum + row.sessions, 0) ?? 0,
      cohorts: nativeAcquisition.periods.map((period, index) => ({
        ...nativeCohort(period),
        organicSessions: organic?.periods[index]?.sessions ?? 0,
      })),
    }
  }

  const allGaAiRows = db.select().from(gaAiReferrals)
    .where(and(eq(gaAiReferrals.projectId, project.id), gte(gaAiReferrals.date, gaStartDate ?? startDate), lte(gaAiReferrals.date, gaEndDate ?? endDate))).all()
    .filter(row => row.sourceDimension === 'session')
  const aiRows = gaStartDate && gaEndDate
    ? allGaAiRows.filter(row => inRange(row.date, gaStartDate, gaEndDate))
    : []
  const gaAiReferralSummary = allGaAiRows.length ? {
    paidSessions: aiRows
      .filter(row => row.trafficClass === AiReferralTrafficClasses.paid)
      .reduce((count, row) => count + row.sessions, 0),
    organicSessions: aiRows
      .filter(row => row.trafficClass === AiReferralTrafficClasses.organic)
      .reduce((count, row) => count + row.sessions, 0),
  } : null

  const serverSources = db.select().from(trafficSources).where(eq(trafficSources.projectId, project.id)).all()
  const serverStart = `${startDate}T00:00:00`
  const serverEnd = `${endDate}T23:59:59.999Z`
  const allCrawlers = db.select().from(crawlerEventsHourly)
    .where(and(eq(crawlerEventsHourly.projectId, project.id), gte(crawlerEventsHourly.tsHour, serverStart), lte(crawlerEventsHourly.tsHour, serverEnd))).all()
  const allFetches = db.select().from(aiUserFetchEventsHourly)
    .where(and(eq(aiUserFetchEventsHourly.projectId, project.id), gte(aiUserFetchEventsHourly.tsHour, serverStart), lte(aiUserFetchEventsHourly.tsHour, serverEnd))).all()
  const allReferrals = db.select().from(aiReferralEventsHourly)
    .where(and(eq(aiReferralEventsHourly.projectId, project.id), gte(aiReferralEventsHourly.tsHour, serverStart), lte(aiReferralEventsHourly.tsHour, serverEnd))).all()
  const [serverCoverageRow] = db.all(sql`
    select
      min(day) as startDate,
      max(day) as endDate,
      count(distinct day) as observedDays
    from (
      select substr(${crawlerEventsHourly.tsHour}, 1, 10) as day
      from ${crawlerEventsHourly}
      where ${crawlerEventsHourly.projectId} = ${project.id}
      union
      select substr(${aiUserFetchEventsHourly.tsHour}, 1, 10) as day
      from ${aiUserFetchEventsHourly}
      where ${aiUserFetchEventsHourly.projectId} = ${project.id}
      union
      select substr(${aiReferralEventsHourly.tsHour}, 1, 10) as day
      from ${aiReferralEventsHourly}
      where ${aiReferralEventsHourly.projectId} = ${project.id}
    )
  `) as Array<{
    startDate: string | null
    endDate: string | null
    observedDays: number
  }>
  const serverCoverage = aggregateCoverage(serverCoverageRow)
  const serverInWindow = (timestamp: string) => isInWindow(timestamp.slice(0, 10))
  const crawlers = allCrawlers.filter(row => serverInWindow(row.tsHour))
  const fetches = allFetches.filter(row => serverInWindow(row.tsHour))
  const referrals = allReferrals.filter(row => serverInWindow(row.tsHour))
  const server = serverSources.length ? summarizeServer(crawlers, fetches, referrals) : null

  const latest = db.select().from(runs).where(and(
    eq(runs.projectId, project.id),
    eq(runs.kind, RunKinds['answer-visibility']),
    eq(runs.status, RunStatuses.completed),
    notProbeRun(),
  )).orderBy(desc(runs.createdAt)).get()
  const snapshots = latest
    ? db.select().from(querySnapshots).where(eq(querySnapshots.runId, latest.id)).all()
    : []
  const completedAt = latest ? latest.finishedAt ?? latest.createdAt : null
  const visibility = latest && completedAt ? {
    runId: latest.id,
    completedAt,
    ageDays: Math.max(0, (Date.now() - new Date(completedAt).getTime()) / 86_400_000),
    answerPairs: snapshots.length,
    mentionedPairs: snapshots.filter(snapshot => snapshot.answerMentioned === true).length,
    citedPairs: snapshots.filter(snapshot => snapshot.citationState === CitationStates.cited).length,
  } : null

  type PageEvidence = OrganicEvidenceDto['pages'][number]
  const pageMap = new Map<string, PageEvidence>()
  const ensurePage = (value: string | null | undefined) => {
    const key = normalizedPath(value)
    const existing = pageMap.get(key)
    if (existing) return existing
    const created: PageEvidence = {
      path: key,
      gsc: zero(),
      ga4OrganicSessions: 0,
      server: {
        crawlerHits: { verified: 0, claimedUnverified: 0, unknownAiLike: 0 },
        userFetchHits: { verified: 0, claimedUnverified: 0, unknownAiLike: 0 },
        referralSessions: { total: 0, paid: 0, organic: 0, unknown: 0 },
      },
    }
    pageMap.set(key, created)
    return created
  }
  for (const row of pageSearchRows) {
    const page = ensurePage(row.page)
    page.gsc.clicks += row.clicks
    page.gsc.impressions += row.impressions
  }
  if (nativeAcquisition.status === 'never-synced') for (const row of gaWindow) {
    ensurePage(row.landingPageNormalized ?? row.landingPage).ga4OrganicSessions += row.organicSessions
  }
  if (nativeAcquisition.status !== 'never-synced') for (const row of nativeWindowOrganicRows) {
    ensurePage(row.landingPageNormalized ?? row.landingPage).ga4OrganicSessions += row.sessions
  }

  for (const row of crawlers) {
    const counts = ensurePage(row.pathNormalized).server.crawlerHits
    if (row.verificationStatus === VerificationStatuses.verified) counts.verified += row.hits
    else if (row.verificationStatus === VerificationStatuses.claimed_unverified) counts.claimedUnverified += row.hits
    else counts.unknownAiLike += row.hits
  }
  for (const row of fetches) {
    const counts = ensurePage(row.pathNormalized).server.userFetchHits
    if (row.verificationStatus === VerificationStatuses.verified) counts.verified += row.hits
    else if (row.verificationStatus === VerificationStatuses.claimed_unverified) counts.claimedUnverified += row.hits
    else counts.unknownAiLike += row.hits
  }
  for (const row of referrals) {
    const counts = ensurePage(row.landingPathNormalized).server.referralSessions
    counts.total += row.sessionsOrHits
    counts.paid += row.paidSessionsOrHits
    counts.organic += row.organicSessionsOrHits
    counts.unknown = Math.max(0, counts.total - counts.paid - counts.organic)
  }
  const pageMatchCount = pageMap.size
  const pages = [...pageMap.values()].sort((a, b) =>
    b.gsc.impressions - a.gsc.impressions
      || b.ga4OrganicSessions - a.ga4OrganicSessions
      || (b.server.userFetchHits.verified + b.server.userFetchHits.claimedUnverified + b.server.userFetchHits.unknownAiLike)
        - (a.server.userFetchHits.verified + a.server.userFetchHits.claimedUnverified
          + a.server.userFetchHits.unknownAiLike)
      || a.path.localeCompare(b.path),
  ).slice(0, PAGE_DETAIL_LIMIT)

  const findings: OrganicEvidenceDto['findings'] = []
  const latestGsc = gsc?.cohorts.at(-1)
  const priorGsc = gsc?.cohorts.at(-2)
  if (gsc && latestGsc && priorGsc) {
    const visibilityIncreased = latestGsc.totals.impressions > priorGsc.totals.impressions
    if (visibilityIncreased) {
      findings.push({
        tone: 'positive',
        title: 'Search visibility increased',
        detail: `Google showed the site ${comparisonDetail(latestGsc.totals.impressions, priorGsc.totals.impressions)} (${latestGsc.startDate} to ${latestGsc.endDate} versus ${priorGsc.startDate} to ${priorGsc.endDate}).`,
      })
    }
    if (visibilityIncreased && latestGsc.totals.clicks <= priorGsc.totals.clicks) {
      findings.push({
        tone: 'caution',
        title: 'Search clicks have not followed visibility yet',
        detail: `The site recorded ${latestGsc.totals.clicks} Google clicks in the latest cohort versus ${priorGsc.totals.clicks} prior.`,
      })
    }
  }
  const latestGa = ga4?.cohorts.at(-1)
  const priorGa = ga4?.cohorts.at(-2)
  if (ga4 && latestGa && priorGa) {
    findings.push({
      tone: 'neutral',
      title: 'Organic sessions remain a separate outcome',
      detail: `GA4 organic sessions were ${comparisonDetail(latestGa.organicSessions, priorGa.organicSessions)}; visibility alone does not establish lead impact.`,
    })
  }
  const latestLead = measurement.leads.periods.at(-1)?.eventCount ?? 0
  const priorLead = measurement.leads.periods.at(-2)?.eventCount ?? 0
  if (measurement.leads.status === 'ready' && measurement.leads.periods.length > 1) {
    findings.push({
      tone: 'neutral',
      title: 'Lead trend is measured, not causal',
      detail: `GA4 lead events were ${comparisonDetail(latestLead, priorLead)}; this association is not causal proof.`,
    })
  }
  const paidLatest = measurement.acquisition.channels
    .find(row => row.channelGroup === 'Paid Search')?.periods.at(-1)?.sessions ?? 0
  const brandedLatest = measurement.searchDemand.periods.at(-1)?.brandedClicks ?? 0
  if (paidLatest > 0 && brandedLatest > 0) {
    findings.push({
      tone: 'neutral',
      title: 'Paid-assisted brand search remains plausible',
      detail: `${paidLatest} Paid Search sessions (${measurement.acquisition.periods.at(-1)?.startDate} to ${measurement.acquisition.periods.at(-1)?.endDate}) and ${brandedLatest} branded clicks (${measurement.searchDemand.periods.at(-1)?.startDate} to ${measurement.searchDemand.periods.at(-1)?.endDate}) were observed in their source-specific latest cohorts; this is not proof of paid assistance.`,
    })
  }

  const fetchTotal = server
    ? server.userFetchHits.verified + server.userFetchHits.claimedUnverified + server.userFetchHits.unknownAiLike
    : 0
  if (server && fetchTotal > 0) {
    findings.push({
      tone: 'positive',
      title: 'AI user-agent fetches reached site content',
      detail: `Server logs recorded ${fetchTotal} on-demand AI user-agent fetches in this window. These are request observations, not visits or leads; verification tiers are reported separately.`,
    })
  }
  if (server?.referralSessions.unknown) {
    findings.push({
      tone: 'caution',
      title: 'Some AI referrals are unclassified',
      detail: 'Historical server rows without paid/organic class evidence remain unknown and are not counted as organic AI traffic.',
    })
  }

  const limitations: OrganicEvidenceDto['limitations'] = [
    { code: 'units-not-combined', detail: 'GSC clicks/impressions, GA4 sessions, server hits, and sampled answer observations are reported separately.' },
    { code: 'gsc-residual', detail: 'The GSC residual represents suppressed or unreported named queries and is not labelled non-brand.' },
    { code: 'page-grain-gsc', detail: 'Page GSC counts come from detailed page/query rows; property totals remain the canonical headline totals.' },
  ]
  if (pageMatchCount > PAGE_DETAIL_LIMIT) {
    limitations.push({
      code: 'page-detail-truncated',
      detail: `Page evidence is limited to the top ${PAGE_DETAIL_LIMIT} of ${pageMatchCount} matching pages.`,
    })
  }
  if (measurement.leads.status === 'ready') {
    limitations.push({
      code: 'lead-attribution-not-causal',
      detail: 'GA4 lead attribution is observational and does not prove SEO caused leads.',
    })
  } else if (measurement.leads.status === 'error') {
    limitations.push({
      code: 'lead-sync-error',
      detail: measurement.leads.error ?? 'GA4 lead sync failed.',
    })
  } else {
    limitations.push({
      code: 'lead-data-unavailable',
      detail: 'GA4 lead data has not been synced.',
    })
  }
  if (measurement.leads.attributionScope === 'channel') {
    limitations.push({
      code: 'lead-channel-scope',
      detail: 'Lead attribution is channel-level; marketing-host and path filters do not apply.',
    })
  }
  if (measurement.acquisition.status === 'error') {
    limitations.push({
      code: 'acquisition-sync-error',
      detail: measurement.acquisition.error
        ? `${measurement.acquisition.error}; last-good rows remain visible when available.`
        : 'GA4 acquisition sync failed; last-good rows remain visible when available.',
    })
  }
  if (measurement.acquisition.status === 'never-synced' && gaRows.length) {
    limitations.push({
      code: 'legacy-ga-fallback',
      detail: 'Legacy GA snapshots are used only because native acquisition data has never synced.',
    })
    limitations.push({
      code: 'no-lead-attribution',
      detail: 'Legacy GA fallback has no GA4 lead attribution.',
    })
  }

  if (gscCoverage?.endDate && gaCoverage?.endDate && gscCoverage.endDate !== gaCoverage.endDate) {
    limitations.push({
      code: 'source-specific-cohort-anchors',
      detail: `GSC cohorts end ${gscCoverage.endDate}; GA4 cohorts end ${gaCoverage.endDate}. Sources are not forced onto a shared date.`,
    })
  }

  if (serverCoverage && serverCoverage.startDate > startDate) {
    limitations.push({
      code: 'partial-server-window',
      detail: `Server evidence begins ${serverCoverage.startDate}, after the requested window begins ${startDate}.`,
    })
  }
  if (server && (server.crawlerHits.claimedUnverified > 0
    || server.userFetchHits.claimedUnverified > 0
    || server.crawlerHits.unknownAiLike > 0
    || server.userFetchHits.unknownAiLike > 0)) {
    limitations.push({
      code: 'unverified-ai-user-agents',
      detail: 'Claimed-unverified and heuristic AI requests are user-agent evidence without operator IP verification and are reported separately from verified requests.',
    })
  }
  if (visibility && visibility.ageDays > 30) {
    limitations.push({
      code: 'stale-visibility-sweep',
      detail: `The latest answer-visibility sweep is ${Math.floor(visibility.ageDays)} days old and may not represent current model behavior.`,
    })
  }

  return {
    contractVersion: 'organic-evidence/v1',
    periodDays,
    asOfDate,
    coverage: { gsc: !!gsc, ga4: !!ga4, server: !!server, visibility: !!visibility },
    sourceCoverage: {
      gsc: gscCoverage,
      ga4: gaCoverage,
      server: serverCoverage,
      visibility: visibility ? { completedAt: visibility.completedAt, ageDays: visibility.ageDays } : null,
    },
    gsc,
    ga4,
    gaAiReferrals: gaAiReferralSummary,
    server,
    visibility,
    pages,
    measurement,
    findings,
    limitations,
  }
}

export async function organicEvidenceRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: { period?: string } }>(
    '/projects/:name/organic-evidence',
    async request => {
      const parsed = organicEvidencePeriodSchema.safeParse(
        request.query.period === undefined ? 90 : Number(request.query.period),
      )
      if (!parsed.success) throw validationError('period must be 60 or 90')
      return buildOrganicEvidence(app.db, request.params.name, parsed.data)
    },
  )
}

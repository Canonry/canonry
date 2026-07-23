import { and, desc, eq } from 'drizzle-orm'
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
  RunKinds,
  RunStatuses,
  VerificationStatuses,
  normalizeUrlPath,
  organicEvidencePeriodSchema,
  validationError,
  type OrganicEvidenceDto,
} from '@ainyc/canonry-contracts'
import { buildBrandTokens } from '@ainyc/canonry-intelligence'
import { notProbeRun, resolveProject } from './helpers.js'
import { buildGaMeasurementAnalysis } from './ga-measurement-analysis.js'

const zero = () => ({ clicks: 0, impressions: 0 })
const daysBefore = (end: string, days: number) => {
  const date = new Date(`${end}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}
const normalizedPath = (value: string | null | undefined) => {
  const normalized = normalizeUrlPath(value) ?? '/'
  return normalized.split('?')[0] || '/'
}
const isBlogPath = (value: string | null | undefined) => {
  const valuePath = normalizedPath(value)
  return valuePath === '/blog' || valuePath.startsWith('/blog/')
}
const inRange = (date: string, startDate: string, endDate: string) => date >= startDate && date <= endDate

function sourceCoverage(dates: string[]) {
  const unique = [...new Set(dates)].sort()
  return unique.length
    ? { startDate: unique[0], endDate: unique[unique.length - 1], observedDays: unique.length }
    : null
}

function buildCohorts(endDate: string, periodDays: 60 | 90): OrganicEvidenceDto['cohorts'] {
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

export function buildOrganicEvidence(
  db: FastifyInstance['db'],
  projectName: string,
  periodDays: 60 | 90,
): OrganicEvidenceDto {
  const project = resolveProject(db, projectName)
  const measurement = buildGaMeasurementAnalysis(db, projectName, { window: periodDays + 'd', hostScope: 'marketing', limit: 100 })
  const gscRows = db.select().from(gscDailyTotals).where(eq(gscDailyTotals.projectId, project.id)).all()
  const gaRows = db.select().from(gaTrafficSnapshots).where(eq(gaTrafficSnapshots.projectId, project.id)).all()
  const gscCoverage = sourceCoverage(gscRows.map(row => row.date))
  let gaCoverage = sourceCoverage(gaRows.map(row => row.date))
  const gaDates = new Set(gaRows.map(row => row.date))
  const latestSharedDate = [...new Set(gscRows.map(row => row.date))]
    .filter(date => gaDates.has(date)).sort().at(-1)
  const asOfDate = gscCoverage && gaCoverage
    ? latestSharedDate ?? [gscCoverage.endDate, gaCoverage.endDate].sort()[0]
    : gscCoverage?.endDate ?? gaCoverage?.endDate ?? null
  const endDate = asOfDate ?? new Date().toISOString().slice(0, 10)
  const startDate = daysBefore(endDate, periodDays - 1)
  const cohorts = buildCohorts(endDate, periodDays)
  const isInWindow = (date: string) => inRange(date, startDate, endDate)

  const gscWindow = gscRows.filter(row => isInWindow(row.date))
  const propertyTotals = sumSearchRows(gscWindow)
  const brandTokens = buildBrandTokens(project.canonicalDomain, [project.displayName, ...project.aliases])
  const namedRows = db.select().from(gscQueryDailyTotals)
    .where(eq(gscQueryDailyTotals.projectId, project.id)).all()
    .filter(row => isInWindow(row.date))
  const namedBrand = zero()
  const namedNonBrand = zero()
  for (const row of namedRows) {
    const compactQuery = row.query.toLowerCase().replace(/[^a-z0-9]/g, '')
    const isBrand = brandTokens.some(token => compactQuery.includes(token.replace(/[^a-z0-9]/g, '')))
    const target = isBrand ? namedBrand : namedNonBrand
    target.clicks += row.clicks
    target.impressions += row.impressions
  }
  const suppressedOrUnreportedResidual = {
    clicks: Math.max(0, propertyTotals.clicks - namedBrand.clicks - namedNonBrand.clicks),
    impressions: Math.max(0, propertyTotals.impressions - namedBrand.impressions - namedNonBrand.impressions),
  }
  let gsc = gscRows.length ? {
    propertyTotals,
    namedBrand,
    namedNonBrand,
    suppressedOrUnreportedResidual,
    cohorts: cohorts.map(cohort => ({
      ...cohort,
      totals: sumSearchRows(gscRows.filter(row => inRange(row.date, cohort.startDate, cohort.endDate))),
    })),
  } : null

  if (gsc && measurement.searchDemand.status === "ready") {
    const totals = (classification: "branded" | "non-branded") => measurement.searchDemand.queries.filter(row => row.classification === classification).reduce((sum, row) => ({ clicks: sum.clicks + row.periods.reduce((inner, period) => inner + period.clicks, 0), impressions: sum.impressions + row.periods.reduce((inner, period) => inner + period.impressions, 0) }), zero())
    const namedBrand = totals("branded")
    const namedNonBrand = totals("non-branded")
    gsc = { ...gsc, namedBrand, namedNonBrand, suppressedOrUnreportedResidual: { clicks: Math.max(0, gsc.propertyTotals.clicks - namedBrand.clicks - namedNonBrand.clicks), impressions: Math.max(0, gsc.propertyTotals.impressions - namedBrand.impressions - namedNonBrand.impressions) } }
  }

  const pageSearchRows = db.select().from(gscSearchData)
    .where(eq(gscSearchData.projectId, project.id)).all()
    .filter(row => isInWindow(row.date))
  let blogGscCohorts = cohorts.map(cohort => ({
    ...cohort,
    totals: sumSearchRows(pageSearchRows.filter(row =>
      isBlogPath(row.page) && inRange(row.date, cohort.startDate, cohort.endDate))),
  }))

  if (measurement.searchDemand.status === "ready") {
    blogGscCohorts = measurement.searchDemand.periods.map((_period, index) => ({ ...cohorts[index]!, totals: measurement.searchDemand.pages.filter(page => isBlogPath(page.landingPage)).reduce((sum, page) => ({ clicks: sum.clicks + (page.periods[index]?.clicks ?? 0), impressions: sum.impressions + (page.periods[index]?.impressions ?? 0) }), zero()) }))
  }

  const gaWindow = gaRows.filter(row => isInWindow(row.date))
  const gaCohorts = cohorts.map(cohort => ({
    ...cohort,
    organicSessions: gaRows
      .filter(row => inRange(row.date, cohort.startDate, cohort.endDate))
      .reduce((count, row) => count + row.organicSessions, 0),
  }))
  let blogGaCohorts = cohorts.map(cohort => ({
    ...cohort,
    organicSessions: gaRows
      .filter(row => isBlogPath(row.landingPageNormalized ?? row.landingPage)
        && inRange(row.date, cohort.startDate, cohort.endDate))
      .reduce((count, row) => count + row.organicSessions, 0),
  }))
  let ga4 = gaRows.length ? {
    organicSessions: gaWindow.reduce((count, row) => count + row.organicSessions, 0),
    blogOrganicSessions: gaWindow
      .filter(row => isBlogPath(row.landingPageNormalized ?? row.landingPage))
      .reduce((count, row) => count + row.organicSessions, 0),
    cohorts: gaCohorts,
  } : null

  const nativeAcquisition = measurement.acquisition
  const nativeOrganicRows = nativeAcquisition.status === "never-synced" ? [] : db.select().from(gaAcquisitionDaily).where(eq(gaAcquisitionDaily.projectId, project.id)).all().filter(row => row.channelGroup === "Organic Search" && [project.canonicalDomain, ...project.ownedDomains, ...project.measurement.marketingHosts].some(candidate => { const current = row.hostName.toLowerCase().replace("www.", ""); const target = candidate.toLowerCase().replace("www.", ""); return current === target || current.endsWith("." + target) }))
  if (nativeAcquisition.status !== 'never-synced') {
    gaCoverage = sourceCoverage(nativeOrganicRows.map(row => row.date))
    const organic = nativeAcquisition.channels.find(row => row.channelGroup === 'Organic Search')
    const blogPages = nativeOrganicRows.filter(row => isBlogPath(row.landingPageNormalized ?? row.landingPage))
    ga4 = { organicSessions: organic?.periods.reduce((sum, row) => sum + row.sessions, 0) ?? 0, blogOrganicSessions: blogPages.reduce((sum, page) => sum + page.sessions, 0), cohorts: nativeAcquisition.periods.map((_row, index) => ({ ...cohorts[index]!, organicSessions: organic?.periods[index]?.sessions ?? 0 })) }
    blogGaCohorts = nativeAcquisition.periods.map((period, index) => ({ ...cohorts[index]!, organicSessions: nativeOrganicRows.filter(row => isBlogPath(row.landingPageNormalized ?? row.landingPage) && inRange(row.date, period.startDate, period.endDate)).reduce((sum, row) => sum + row.sessions, 0) }))
  }

  const allGaAiRows = db.select().from(gaAiReferrals)
    .where(eq(gaAiReferrals.projectId, project.id)).all()
    .filter(row => row.sourceDimension === 'session')
  const aiRows = allGaAiRows.filter(row => isInWindow(row.date))
  const gaAiReferralSummary = allGaAiRows.length ? {
    paidSessions: aiRows
      .filter(row => row.trafficClass === AiReferralTrafficClasses.paid)
      .reduce((count, row) => count + row.sessions, 0),
    organicSessions: aiRows
      .filter(row => row.trafficClass === AiReferralTrafficClasses.organic)
      .reduce((count, row) => count + row.sessions, 0),
  } : null

  const serverSources = db.select().from(trafficSources).where(eq(trafficSources.projectId, project.id)).all()
  const allCrawlers = db.select().from(crawlerEventsHourly)
    .where(eq(crawlerEventsHourly.projectId, project.id)).all()
  const allFetches = db.select().from(aiUserFetchEventsHourly)
    .where(eq(aiUserFetchEventsHourly.projectId, project.id)).all()
  const allReferrals = db.select().from(aiReferralEventsHourly)
    .where(eq(aiReferralEventsHourly.projectId, project.id)).all()
  const serverCoverage = sourceCoverage([
    ...allCrawlers.map(row => row.tsHour.slice(0, 10)),
    ...allFetches.map(row => row.tsHour.slice(0, 10)),
    ...allReferrals.map(row => row.tsHour.slice(0, 10)),
  ])
  const serverInWindow = (timestamp: string) => isInWindow(timestamp.slice(0, 10))
  const crawlers = allCrawlers.filter(row => serverInWindow(row.tsHour))
  const fetches = allFetches.filter(row => serverInWindow(row.tsHour))
  const referrals = allReferrals.filter(row => serverInWindow(row.tsHour))
  const server = serverSources.length ? summarizeServer(crawlers, fetches, referrals) : null
  const blogServer = serverSources.length ? summarizeServer(
    crawlers.filter(row => isBlogPath(row.pathNormalized)),
    fetches.filter(row => isBlogPath(row.pathNormalized)),
    referrals.filter(row => isBlogPath(row.landingPathNormalized)),
  ) : null

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
    citedPairs: snapshots.filter(snapshot => snapshot.citationState === 'cited').length,
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
  if (nativeAcquisition.status !== 'never-synced') for (const row of nativeOrganicRows) {
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
  const pages = [...pageMap.values()].sort((a, b) =>
    b.gsc.impressions - a.gsc.impressions
      || b.ga4OrganicSessions - a.ga4OrganicSessions
      || (b.server.userFetchHits.verified + b.server.userFetchHits.claimedUnverified + b.server.userFetchHits.unknownAiLike)
        - (a.server.userFetchHits.verified + a.server.userFetchHits.claimedUnverified
          + a.server.userFetchHits.unknownAiLike)
      || a.path.localeCompare(b.path),
  ).slice(0, 50)

  const findings: OrganicEvidenceDto['findings'] = []
  const latestBlogGsc = blogGscCohorts.at(-1)
  const priorBlogGsc = blogGscCohorts.at(-2)
  if (gsc && latestBlogGsc && priorBlogGsc) {
    if (latestBlogGsc.totals.impressions > priorBlogGsc.totals.impressions) {
      findings.push({
        tone: 'positive',
        title: 'Blog search visibility increased',
        detail: `Google showed blog pages ${comparisonDetail(latestBlogGsc.totals.impressions, priorBlogGsc.totals.impressions)} (${latestBlogGsc.startDate} to ${latestBlogGsc.endDate} versus ${priorBlogGsc.startDate} to ${priorBlogGsc.endDate}).`,
      })
    }
    if (latestBlogGsc.totals.clicks <= priorBlogGsc.totals.clicks) {
      findings.push({
        tone: 'caution',
        title: 'Blog clicks have not followed visibility yet',
        detail: `Blog pages recorded ${latestBlogGsc.totals.clicks} Google clicks in the latest cohort versus ${priorBlogGsc.totals.clicks} prior.`,
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
  if (measurement.leads.status === 'ready' && measurement.leads.periods.length > 1) findings.push({ tone: 'neutral', title: 'Lead trend is measured, not causal', detail: 'GA4 lead events were ' + comparisonDetail(latestLead, priorLead) + '; this association is not causal proof.' })
  const paidLatest = measurement.acquisition.channels.find(row => row.channelGroup === 'Paid Search')?.periods.at(-1)?.sessions ?? 0
  const brandedLatest = measurement.searchDemand.periods.at(-1)?.brandedClicks ?? 0
  if (paidLatest > 0 && brandedLatest > 0) findings.push({ tone: 'neutral', title: 'Paid-assisted brand search remains plausible', detail: String(paidLatest) + ' Paid Search sessions and ' + String(brandedLatest) + ' branded clicks coincide in the latest cohort; this is not proof of paid assistance.' })

  const blogFetchTotal = blogServer
    ? blogServer.userFetchHits.verified + blogServer.userFetchHits.claimedUnverified
      + blogServer.userFetchHits.unknownAiLike
    : 0
  if (blogServer && blogFetchTotal > 0) {
    findings.push({
      tone: 'positive',
      title: 'AI user-agent fetches reached blog content',
      detail: `Server logs recorded ${blogFetchTotal} on-demand AI user-agent fetches of blog paths in this window. These are request observations, not visits or leads; verification tiers are reported separately.`,
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
    { code: 'page-grain-gsc', detail: 'Page and blog GSC counts come from detailed page/query rows; property totals remain the canonical headline totals.' },
  ]
  if (measurement.leads.status === 'ready') limitations.push({ code: 'lead-attribution-not-causal', detail: 'GA4 lead trends are measured but do not establish causality.' })
  else if (measurement.leads.status === 'error') limitations.push({ code: 'lead-sync-error', detail: measurement.leads.error ?? 'GA4 lead sync failed.' })
  else limitations.push({ code: 'lead-data-unavailable', detail: 'GA4 lead data has not been synced.' })
  if (measurement.leads.attributionScope === 'channel') limitations.push({ code: 'lead-channel-scope', detail: 'Lead rows are channel-scoped, so host and path filters are unavailable.' })
  if (measurement.acquisition.status === 'error') limitations.push({ code: 'acquisition-sync-error', detail: measurement.acquisition.error ?? 'GA4 acquisition sync failed.' })
  if (measurement.acquisition.status === 'never-synced' && gaRows.length) limitations.push({ code: 'legacy-ga-fallback', detail: 'Legacy GA snapshots are used only because native acquisition data has never synced.' })
  if (measurement.acquisition.status === 'never-synced' && gaRows.length) limitations.push({ code: 'no-lead-attribution', detail: 'Legacy GA fallback has no GA4 lead attribution.' })

  if (gscCoverage && gaCoverage && !latestSharedDate) {
    limitations.push({
      code: 'no-shared-gsc-ga4-date',
      detail: 'GSC and GA4 have no identical observed date; cohorts use the earlier source end date as a fallback.',
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
    cohorts,
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
    blog: {
      pathRule: '/blog and descendants',
      gsc: gscRows.length ? { cohorts: blogGscCohorts } : null,
      ga4: gaRows.length ? { cohorts: blogGaCohorts } : null,
      server: blogServer,
    },
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

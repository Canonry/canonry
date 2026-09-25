import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { aiReferralEventsHourly as referrals, gaAiReferrals, trafficSources, type DatabaseClient } from '@ainyc/canonry-db'
import { aiReferralClassCounts, inclusiveDayCount, notFound, referralAssessmentQuerySchema, validationError, type ReferralAssessment, type ReferralAssessmentQuery } from '@ainyc/canonry-contracts'
import { countableReferralCondition, referralLandedCondition } from './ai-referral-status.js'
import { resolveProject } from './helpers.js'
import { resolveWinningDimensions } from './ga-ai-referral-aggregation.js'

const DEFAULT_BURST_THRESHOLD = 100
const DEFAULT_RATIO_THRESHOLD = 3

/** DB-only assessment. Existing totals and ingest classifications are immutable. */
export function buildReferralAssessment(db: DatabaseClient, projectName: string, input: ReferralAssessmentQuery): ReferralAssessment {
  const parsed = referralAssessmentQuerySchema.safeParse(input)
  if (!parsed.success) throw validationError(parsed.error.message)
  const query = parsed.data
  const days = inclusiveDayCount(query.startDate, query.endDate)
  if (days === null || days < 1 || days > 366) throw validationError('Select an inclusive date window of 1 to 366 days.')
  const project = resolveProject(db, projectName)
  if (query.sourceId && !db.select({ id: trafficSources.id }).from(trafficSources)
    .where(and(eq(trafficSources.projectId, project.id), eq(trafficSources.id, query.sourceId))).get()) {
    throw notFound('Traffic source', query.sourceId)
  }
  const where = and(
    eq(referrals.projectId, project.id),
    gte(referrals.tsHour, `${query.startDate}T00:00:00.000Z`),
    lte(referrals.tsHour, `${query.endDate}T23:59:59.999Z`),
    query.sourceId ? eq(referrals.sourceId, query.sourceId) : undefined,
  )!
  const burstThreshold = query.burstThreshold ?? DEFAULT_BURST_THRESHOLD
  const ratioThreshold = query.ratioThreshold ?? DEFAULT_RATIO_THRESHOLD
  const limit = query.limit ?? 100

  const sumCounts = (condition: SQL) => {
    const row = db.select({
      rows: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${referrals.sessionsOrHits}), 0)`,
      paid: sql<number>`coalesce(sum(${referrals.paidSessionsOrHits}), 0)`,
      organic: sql<number>`coalesce(sum(${referrals.organicSessionsOrHits}), 0)`,
    }).from(referrals).where(and(where, condition)).get()
    return { rows: Number(row?.rows ?? 0), counts: aiReferralClassCounts(Number(row?.total ?? 0), Number(row?.paid ?? 0), Number(row?.organic ?? 0)) }
  }
  const { rows: observedRows, counts: raw } = sumCounts(sql`1 = 1`)
  // Redirects win the partition for an asset answered with a redirect. Keep
  // status-based hops separate from non-hop subresources and candidate bursts.
  const redirects = sumCounts(sql`not (${referralLandedCondition()})`).counts
  const subresources = sumCounts(and(referralLandedCondition(), sql`not (${countableReferralCondition()})`)!).counts
  const countable = sumCounts(countableReferralCondition()).counts

  // Group before applying the threshold. Referrer/evidence/status splits are
  // different observations of the same normalized-path hour, not separate tests.
  const candidates = db.select({
    sourceId: referrals.sourceId, product: referrals.product,
    landingPathNormalized: referrals.landingPathNormalized, tsHour: referrals.tsHour,
    total: sql<number>`sum(${referrals.sessionsOrHits})`.as('total'),
    paid: sql<number>`sum(${referrals.paidSessionsOrHits})`.as('paid'),
    organic: sql<number>`sum(${referrals.organicSessionsOrHits})`.as('organic'),
  }).from(referrals).where(and(where, countableReferralCondition()))
    .groupBy(referrals.sourceId, referrals.product, referrals.landingPathNormalized, referrals.tsHour)
    .having(sql`sum(${referrals.sessionsOrHits}) >= ${burstThreshold}`).as('candidates')
  const candidateTotals = db.select({
    groups: sql<number>`count(*)`,
    total: sql<number>`coalesce(sum(${candidates.total}), 0)`,
    paid: sql<number>`coalesce(sum(${candidates.paid}), 0)`,
    organic: sql<number>`coalesce(sum(${candidates.organic}), 0)`,
  }).from(candidates).get()
  const suspected = aiReferralClassCounts(Number(candidateTotals?.total ?? 0), Number(candidateTotals?.paid ?? 0), Number(candidateTotals?.organic ?? 0))
  const bursts = db.select().from(candidates)
    .orderBy(sql`${candidates.total} desc`, candidates.tsHour, candidates.sourceId, candidates.product, candidates.landingPathNormalized)
    .limit(limit).all().map(row => ({
      sourceId: row.sourceId, product: row.product, landingPathNormalized: row.landingPathNormalized, tsHour: row.tsHour,
      counts: aiReferralClassCounts(Number(row.total), Number(row.paid), Number(row.organic)),
    }))
  const adjustedEstimate = aiReferralClassCounts(countable.total - suspected.total, countable.paid - suspected.paid, countable.organic - suspected.organic)

  // Reduce landing-page rows in SQL before applying the shared winning-lens
  // primitive. Never sum alternate GA attribution dimensions as separate visits.
  const gaRows = db.select({
    date: gaAiReferrals.date, source: gaAiReferrals.source, medium: gaAiReferrals.medium,
    trafficClass: gaAiReferrals.trafficClass, sourceDimension: gaAiReferrals.sourceDimension,
    channelGroup: gaAiReferrals.channelGroup, sessions: sql<number>`sum(${gaAiReferrals.sessions})`,
  }).from(gaAiReferrals).where(and(eq(gaAiReferrals.projectId, project.id), gte(gaAiReferrals.date, query.startDate), lte(gaAiReferrals.date, query.endDate)))
    .groupBy(gaAiReferrals.date, gaAiReferrals.source, gaAiReferrals.medium, gaAiReferrals.trafficClass, gaAiReferrals.sourceDimension, gaAiReferrals.channelGroup).all()
  const gaSessions = gaRows.length ? resolveWinningDimensions(gaRows).reduce((sum, row) => sum + row.paidSessions + row.organicSessions, 0) : null
  const observedRatio = observedRows > 0 && gaSessions !== null && gaSessions > 0 ? countable.total / gaSessions : null
  // Current traffic sync records retain only a latest watermark, not an
  // interval ledger. GA stores date labels but no property reporting timezone.
  // Neither row presence nor min/max dates proves a comparable complete window.
  const reasons = ['server-coverage-unproven', 'ga-coverage-unproven', 'ga-time-zone-unknown', 'server-and-ga-units-differ']
  if (observedRows === 0) reasons.push('server-data-missing')
  if (gaSessions === null) reasons.push('ga-data-missing')
  else if (gaSessions === 0) reasons.push('ga-observed-zero')
  if (query.sourceId) reasons.push('ga-not-source-scoped')
  if (query.endDate >= new Date().toISOString().slice(0, 10)) reasons.push('window-not-completed')
  const evidenceTotal = Number(candidateTotals?.groups ?? 0)
  return {
    scope: { project: project.name, sourceId: query.sourceId ?? null, attribution: 'project-source-only', unavailableDimensions: ['property', 'target', 'market'] },
    window: { startDate: query.startDate, endDate: query.endDate, timeZone: 'UTC' },
    rule: { version: 'hourly-normalized-path-v1', burstThreshold, ratioThreshold, calibration: query.burstThreshold === undefined ? 'uncalibrated-default' : 'request-override', grouping: ['sourceId', 'product', 'landingPathNormalized', 'tsHour'], confirmsAutomation: false },
    totals: { raw, redirects, subresources, countable, suspected, adjustedEstimate },
    bursts,
    evidence: { total: evidenceTotal, returned: bursts.length, truncated: evidenceTotal > bursts.length },
    comparison: { status: 'unavailable', serverCountable: countable.total, serverObservation: observedRows === 0 ? 'missing' : countable.total === 0 ? 'observed-zero' : 'observed-positive', gaSessions, gaObservation: gaSessions === null ? 'missing' : gaSessions === 0 ? 'observed-zero' : 'observed-positive', observedRatio, observedRatioAboveThreshold: observedRatio === null ? null : observedRatio > ratioThreshold, ratio: null, reasons, gaScope: 'project' },
    caveats: [
      'Suspected counts are every countable stored hit in a threshold-qualified hour, not confirmed automation. Legitimate traffic peaks can qualify; low-volume automation can remain.',
      'The adjusted estimate subtracts candidate bursts from countable totals. Raw evidence and existing report headlines are unchanged; this does not replace GA.',
      'A normalized path can combine numeric IDs, UUIDs and query variants from multiple pages.',
      'Stored server counts use batch-local one-minute actor windows. Transport batching and missing client IPs affect these counts; they are not GA sessions or verified human visits.',
      'Sources may overlap. No cross-source deduplication or Property, Target, or market attribution is available in these stored rows.',
      'The default threshold of 100 is a conservative review trigger, not calibrated against real traffic distributions.',
      'The observed server/GA quotient is descriptive only. Complete matching coverage and GA timezone are unknown, so no ratio warning or human-traffic conclusion is justified.',
    ],
  }
}

export async function referralAssessmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/traffic/referral-assessment', async request => {
    const input = { ...request.query }
    for (const key of ['burstThreshold', 'ratioThreshold', 'limit']) {
      if (input[key] !== undefined) input[key] = Number(input[key])
    }
    const parsed = referralAssessmentQuerySchema.safeParse(input)
    if (!parsed.success) throw validationError(parsed.error.message)
    return buildReferralAssessment(app.db, request.params.name, parsed.data)
  })
}

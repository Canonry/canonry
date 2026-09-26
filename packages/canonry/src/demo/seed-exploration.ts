import { and, eq } from 'drizzle-orm'
import { factorStatusFromScore, percentOf, siteAuditPageFactorSchema } from '@ainyc/canonry-contracts'
import {
  aiReferralEventsHourly, aiUserFetchEventsHourly, crawlerEventsHourly,
  discoverySessions, discoveryProbes, researchRuns, researchRunQueries, siteAuditPages, siteAuditSnapshots, siteCrawlPages,
  trafficSources, type DatabaseClient,
} from '@ainyc/canonry-db'
import type { DemoSeedContext } from './types.js'

/** Browsable stored examples, with no ingestion or research execution. */
export function seedDemoExploration(db: DatabaseClient, context: DemoSeedContext): void {
  const createdAt = context.now.toISOString()
  for (const project of [context.simple, context.portfolio]) {
    const sourceId = `${project.id}-traffic`
    const shared = { projectId: project.id, sourceId, createdAt, updatedAt: createdAt }
    db.insert(trafficSources).values({ id: sourceId, projectId: project.id, sourceType: 'cloudflare', displayName: `${project.displayName} website`, status: 'active', lastSyncedAt: createdAt, configJson: { zoneName: project.domain }, createdAt, updatedAt: createdAt }).run()
    for (let hour = 1; hour <= 24; hour++) {
      const date = new Date(context.now.getTime() - hour * 3600000)
      date.setUTCMinutes(0, 0, 0)
      const tsHour = date.toISOString()
      db.insert(crawlerEventsHourly).values({ ...shared, tsHour, botId: 'gptbot', operator: 'openai', verificationStatus: 'claimed_unverified', pathNormalized: '/', status: 200, hits: 3 + hour % 4 }).run()
      db.insert(aiUserFetchEventsHourly).values({ ...shared, tsHour, botId: 'chatgpt-user', operator: 'openai', verificationStatus: 'claimed_unverified', pathNormalized: '/services/', status: 200, hits: 1 + hour % 2 }).run()
      db.insert(aiReferralEventsHourly).values({ ...shared, tsHour, product: 'chatgpt', operator: 'openai', sourceDomain: 'demo-answer-engine.example', evidenceType: 'referer', landingPathNormalized: '/services/', status: 200, sessionsOrHits: 2, organicSessionsOrHits: 2 }).run()
    }
    const runId = `demo-signals-${project.id}-crawl`
    const root = `https://${project.domain}/`
    seedPageAudits(db, project.id, runId, root, createdAt)
    const researchRunId = `${project.id}-research`
    db.insert(researchRuns).values({ id: researchRunId, projectId: project.id, status: 'completed', provider: 'openai', requestedModel: 'demo-model', resolvedModel: 'demo-model', totalQueries: 2, completedQueries: 2, failedQueries: 0, startedAt: createdAt, finishedAt: createdAt, createdAt }).run()
    const topics = project.id === context.simple.id
      ? ['How do homeowners compare roofing materials?', 'What should a roof repair estimate include?']
      : ['What amenities matter most for a family resort stay?', 'How should travelers compare coastal resorts?']
    const discoveryId = `${project.id}-discovery`
    db.insert(discoverySessions).values({ id: discoveryId, projectId: project.id, status: 'completed', icpDescription: `Fictional research example for ${project.displayName}.`, buyerDescription: 'People comparing local services and planning a purchase.', seedProvider: 'openai', seedProviders: ['openai'], seedCountRaw: 2, seedCount: 2, canonicalCount: 2, probeCount: 2, citedCount: 1, aspirationalCount: 1, wastedCount: 0, startedAt: createdAt, finishedAt: createdAt, createdAt }).run()
    db.insert(discoveryProbes).values(topics.map((query, i) => ({ id: `${discoveryId}-${i}`, sessionId: discoveryId, projectId: project.id, query, bucket: i === 0 ? 'cited' : 'aspirational', citationState: i === 0 ? 'cited' : 'not-cited', answerMentioned: i === 0, citedDomains: i === 0 ? [project.domain] : ['comparison-guide.example'], createdAt }))).run()
    db.insert(researchRunQueries).values(topics.map((queryText, position) => ({ id: `${researchRunId}-${position}`, researchRunId, position, queryText, status: 'completed', requestedModel: 'demo-model', resolvedModel: 'demo-model', servedModel: 'demo-model', answerText: `Fictional sample answer: compare clear pricing, service details, and independent reviews. ${project.displayName} illustrates a business with useful comparison guidance.`, groundingSources: [{ uri: `${root}guides/`, title: `${project.displayName} comparison guide` }], citedDomains: [project.domain], answerMentioned: true, citationState: 'cited', startedAt: createdAt, finishedAt: createdAt, createdAt }))).run()
  }
}

/** Keep the scorecard, page list, and crawl map on the same stored evidence. */
function seedPageAudits(db: DatabaseClient, projectId: string, runId: string, root: string, createdAt: string): void {
  const crawlPages = db.select().from(siteCrawlPages).where(and(eq(siteCrawlPages.projectId, projectId), eq(siteCrawlPages.runId, runId))).all()
  const audited = crawlPages.filter(page => page.auditState === 'success' && page.auditScore !== null)
  const pages = audited.map((page, index) => {
    const factors = siteAuditPageFactorSchema.array().parse(page.auditFields.factors)
    return { id: `${projectId}-audit-page-${index}`, projectId, runId, url: page.url, overallScore: page.auditScore!, status: 'success', factors, createdAt }
  })
  const factors = pages.flatMap(page => page.factors)
  const factorAverages = [...new Set(factors.map(factor => factor.id))].map(id => {
    const matching = factors.filter(factor => factor.id === id)
    const first = matching[0]!
    const avgScore = Math.round(matching.reduce((sum, factor) => sum + factor.score, 0) / matching.length)
    return {
      id, name: first.name, weight: first.weight, avgScore, status: factorStatusFromScore(avgScore),
      pagesPassing: matching.filter(factor => factorStatusFromScore(factor.score) === 'pass').length,
      pagesPartial: matching.filter(factor => factorStatusFromScore(factor.score) === 'partial').length,
      pagesFailing: matching.filter(factor => factorStatusFromScore(factor.score) === 'fail').length,
    }
  })
  const crossCuttingIssues = factorAverages.filter(factor => factor.pagesPartial + factor.pagesFailing > 0).map(factor => ({
    factorId: factor.id, factorName: factor.name, avgScore: factor.avgScore,
    affectedPages: factor.pagesPartial + factor.pagesFailing, totalPages: pages.length,
    affectedPct: percentOf(factor.pagesPartial + factor.pagesFailing, pages.length) ?? 0,
    topRecommendations: [`Complete ${factor.name.toLowerCase()} details on the affected pages.`],
  }))
  db.insert(siteAuditSnapshots).values({
    id: `${projectId}-audit`, projectId, runId, sitemapUrl: `${root}sitemap.xml`, auditedAt: createdAt,
    aggregateScore: Math.round(pages.reduce((sum, page) => sum + page.overallScore, 0) / pages.length),
    pagesDiscovered: crawlPages.length, pagesAudited: pages.length,
    pagesErrored: crawlPages.filter(page => page.fetchState === 'fetch-error').length,
    pagesSkipped: crawlPages.filter(page => page.auditState === 'not-applicable').length,
    factorAverages, crossCuttingIssues, prioritizedFixes: crossCuttingIssues.flatMap(issue => issue.topRecommendations), createdAt,
  }).run()
  for (let i = 0; i < pages.length; i += 100) db.insert(siteAuditPages).values(pages.slice(i, i + 100)).run()
}

import {
  aiReferralEventsHourly, aiUserFetchEventsHourly, crawlerEventsHourly,
  researchRuns, researchRunQueries, siteAuditPages, siteAuditSnapshots,
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
    const paths = ['', 'services/', 'guides/', 'contact/']
    const scores = [92, 86, 74, 60]
    const factor = { id: 'structured-data', name: 'Structured Data', weight: 1 }
    db.insert(siteAuditSnapshots).values({ id: `${project.id}-audit`, projectId: project.id, runId, sitemapUrl: `${root}sitemap.xml`, auditedAt: createdAt, aggregateScore: 78, pagesDiscovered: 4, pagesAudited: 4, factorAverages: [{ ...factor, avgScore: 78, status: 'pass', pagesPassing: 3, pagesPartial: 1, pagesFailing: 0 }], crossCuttingIssues: [{ factorId: factor.id, factorName: factor.name, avgScore: 78, affectedPages: 2, totalPages: 4, affectedPct: 50, topRecommendations: ['Add complete organization and service details to the page markup.'] }], prioritizedFixes: ['Add service details to the guides and contact pages.'], createdAt }).run()
    db.insert(siteAuditPages).values(paths.map((path, i) => ({ id: `${project.id}-audit-page-${i}`, projectId: project.id, runId, url: `${root}${path}`, overallScore: scores[i]!, status: 'success', factors: [{ ...factor, score: scores[i]! }], createdAt }))).run()
    const researchRunId = `${project.id}-research`
    db.insert(researchRuns).values({ id: researchRunId, projectId: project.id, status: 'completed', provider: 'openai', requestedModel: 'demo-model', resolvedModel: 'demo-model', totalQueries: 2, completedQueries: 2, failedQueries: 0, startedAt: createdAt, finishedAt: createdAt, createdAt }).run()
    const topics = project.id === context.simple.id
      ? ['How do homeowners compare roofing materials?', 'What should a roof repair estimate include?']
      : ['What amenities matter most for a family resort stay?', 'How should travelers compare coastal resorts?']
    db.insert(researchRunQueries).values(topics.map((queryText, position) => ({ id: `${researchRunId}-${position}`, researchRunId, position, queryText, status: 'completed', requestedModel: 'demo-model', resolvedModel: 'demo-model', servedModel: 'demo-model', answerText: `Fictional sample answer: compare clear pricing, service details, and independent reviews. ${project.displayName} illustrates a business with useful comparison guidance.`, groundingSources: [{ uri: `${root}guides/`, title: `${project.displayName} comparison guide` }], citedDomains: [project.domain], answerMentioned: true, citationState: 'cited', startedAt: createdAt, finishedAt: createdAt, createdAt }))).run()
  }
}

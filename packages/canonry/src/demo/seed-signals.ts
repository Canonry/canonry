/**
 * Stored-only data for the public demo.  These records intentionally use .example
 * domains and explicit fixture copy: they are never credentials or live provider
 * responses, and this module never starts a job or makes a network request.
 */
import {
  adsAdGroups,
  adsAds,
  adsCampaigns,
  adsConnections,
  adsInsightsDaily,
  auditLog,
  backlinkDomains,
  backlinkSummaries,
  bingConnections,
  bingCoverageSnapshots,
  bingKeywordStats,
  bingUrlInspections,
  conversionTrackingContracts,
  gaAcquisitionDaily,
  gaAiReferrals,
  gaDailyTotals,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gaTrafficSnapshots,
  gaTrafficSummaries,
  gaTrafficWindowSummaries,
  gbpDailyMetrics,
  gbpKeywordImpressions,
  gbpKeywordMonthly,
  gbpLocations,
  gbpPlaceActions,
  googleConnections,
  gscCoverageSnapshots,
  gscDailyTotals,
  gscDataWatermarks,
  gscQueryDailyTotals,
  gscSearchData,
  gscUrlInspections,
  healthSnapshots,
  insights,
  runs,
  siteCrawlAttempts,
  siteCrawlEdges,
  siteCrawlFindings,
  siteCrawlGraphEdges,
  siteCrawlGraphLayouts,
  siteCrawlGraphNodes,
  siteCrawlPages,
  siteCrawlSnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { DemoSeedContext, DemoSeedProject } from './types.js'
import { seedPortfolioCrawl } from './seed-portfolio-crawl.js'

const day = (at: Date, offset: number): string => {
  const value = new Date(at)
  value.setUTCDate(value.getUTCDate() + offset)
  return value.toISOString().slice(0, 10)
}

const at = (date: string): string => `${date}T12:00:00.000Z`

export async function seedDemoSignals(db: DatabaseClient, context: DemoSeedContext): Promise<void> {
  for (const [index, project] of [context.simple, context.portfolio].entries()) {
    await seedProjectSignals(db, project, context.now, index)
  }
}

async function seedProjectSignals(db: DatabaseClient, project: DemoSeedProject, now: Date, variant: number): Promise<void> {
  const nowIso = now.toISOString()
  const prefix = `demo-signals-${project.id}`
  const syncRunId = `${prefix}-sync`
  const crawlRunId = `${prefix}-crawl`
  const root = `https://${project.domain}/`
  const attemptId = `${prefix}-crawl-attempt`
  const campaignId = `${prefix}-campaign`
  const groupId = `${prefix}-ad-group`
  const locationName = `locations/demo-${variant + 1}`

  db.insert(runs).values([
    { id: syncRunId, projectId: project.id, kind: 'data-refresh', status: 'completed', trigger: 'manual', startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso },
    { id: crawlRunId, projectId: project.id, kind: 'site-audit', status: 'completed', trigger: 'manual', startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso },
  ]).run()

  // Safe connection metadata lets the existing status readers render context;
  // neither table holds OAuth material.
  db.insert(googleConnections).values({ id: `${prefix}-gsc`, domain: project.domain, connectionType: 'gsc', propertyId: `sc-domain:${project.domain}`, scopes: [], createdByProjectId: project.id, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(bingConnections).values({ id: `${prefix}-bing`, domain: project.domain, siteUrl: root, createdByProjectId: project.id, createdAt: nowIso, updatedAt: nowIso }).run()
  // GA connection rows contain a required private key, so GA status metadata
  // belongs in the demo server's synthetic credential store rather than SQLite.

  const searchTerms = variant === 0
    ? ['roof replacement costs', 'emergency roof repair options']
    : ['family resorts near the coast', 'coastal resort amenities']
  const dates = Array.from({ length: 14 }, (_, i) => day(now, i - 14))
  for (const [i, date] of dates.entries()) {
    const clicks = 34 + i * 3 + variant * 5
    const impressions = 620 + i * 31 + variant * 55
    db.insert(gscDailyTotals).values({ id: `${prefix}-gsc-total-${date}`, projectId: project.id, date, clicks, impressions, position: (8.8 - i * 0.08).toFixed(2), createdAt: at(date) }).run()
    for (const [termIndex, query] of searchTerms.entries()) {
      const queryClicks = Math.max(3, Math.round(clicks / (termIndex + 2)))
      const queryImpressions = Math.round(impressions / (termIndex + 2))
      db.insert(gscQueryDailyTotals).values({ id: `${prefix}-gsc-query-${i}-${termIndex}`, projectId: project.id, date, query, clicks: queryClicks, impressions: queryImpressions, position: (7.1 + termIndex + i * 0.03).toFixed(2), syncedAt: nowIso, syncRunId, createdAt: at(date) }).run()
      db.insert(gscSearchData).values({ id: `${prefix}-gsc-page-${i}-${termIndex}`, projectId: project.id, syncRunId, date, query, page: termIndex === 0 ? root : `${root}services/`, country: 'usa', device: 'DESKTOP', clicks: queryClicks, impressions: queryImpressions, ctr: (queryClicks / queryImpressions).toFixed(4), position: (7.1 + termIndex).toFixed(2), createdAt: at(date) }).run()
    }
    db.insert(gaDailyTotals).values({ id: `${prefix}-ga-total-${date}`, projectId: project.id, date, sessions: 92 + i * 4 + variant * 11, users: 71 + i * 3 + variant * 8, engagementRate: 0.58 + i * 0.004, newUsers: 29 + i, syncedAt: nowIso, syncRunId, createdAt: at(date) }).run()
    db.insert(gaTrafficSnapshots).values({ id: `${prefix}-ga-page-${date}`, projectId: project.id, date, landingPage: '/', landingPageNormalized: '/', sessions: 62 + i * 3, organicSessions: 39 + i * 2, directSessions: 14 + i, users: 48 + i * 2, syncedAt: nowIso, syncRunId }).run()
    db.insert(gaAcquisitionDaily).values({ id: `${prefix}-ga-acquisition-${date}`, projectId: project.id, date, channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: project.domain, landingPage: '/', landingPageNormalized: '/', sessions: 39 + i * 2, syncedAt: nowIso, syncRunId, createdAt: at(date) }).run()
    db.insert(gaLeadEventsDaily).values({ id: `${prefix}-ga-lead-${date}`, projectId: project.id, date, eventName: 'generate_lead', channelGroup: 'Organic Search', source: 'google', medium: 'organic', hostName: project.domain, landingPage: '/', landingPageNormalized: '/', attributionScope: 'landing-page', eventCount: 3 + (i % 4), syncedAt: nowIso, syncRunId, createdAt: at(date) }).run()
    db.insert(gaAiReferrals).values({ id: `${prefix}-ga-ai-${date}`, projectId: project.id, date, source: i % 2 ? 'demo-answer-engine.example' : 'demo-ai-referral.example', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', channelGroup: 'Referral', landingPage: '/', landingPageNormalized: '/', sessions: 4 + (i % 3), users: 3 + (i % 2), syncedAt: nowIso, syncRunId }).run()
    db.insert(bingCoverageSnapshots).values({ id: `${prefix}-bing-coverage-${date}`, projectId: project.id, syncRunId, date, indexed: 48 + i, notIndexed: 3, unknown: 2, createdAt: at(date) }).run()
  }
  db.insert(gscDataWatermarks).values({ projectId: project.id, dataThroughDate: dates.at(-1)!, syncedThroughDate: dates.at(-1)!, updatedAt: nowIso }).run()
  db.insert(gscCoverageSnapshots).values({ id: `${prefix}-gsc-coverage`, projectId: project.id, syncRunId, date: dates.at(-1)!, indexed: 1, notIndexed: 0, unknownPages: 0, verifiedByInspection: 1, derivedFromImpressions: 0, reasonBreakdown: {}, createdAt: nowIso }).run()
  db.insert(gscUrlInspections).values({ id: `${prefix}-gsc-inspection`, projectId: project.id, syncRunId, url: `${root}services/`, indexingState: 'INDEXING_ALLOWED', verdict: 'PASS', coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL', robotsTxtState: 'ALLOWED', crawlTime: nowIso, lastCrawlResult: 'SUCCESSFUL', isMobileFriendly: true, richResults: ['Sample FAQ'], referringUrls: [root], inspectedAt: nowIso, createdAt: nowIso }).run()
  db.insert(bingKeywordStats).values(searchTerms.map((query, i) => ({ id: `${prefix}-bing-keyword-${i}`, projectId: project.id, query, impressions: 310 - i * 70, clicks: 22 - i * 4, ctr: '0.071', averagePosition: String(6 + i), syncedAt: nowIso, createdAt: nowIso }))).run()
  db.insert(bingUrlInspections).values({ id: `${prefix}-bing-inspection`, projectId: project.id, url: root, httpCode: 200, inIndex: true, lastCrawledDate: dates.at(-2)!, inIndexDate: dates.at(-8)!, inspectedAt: nowIso, syncRunId, createdAt: nowIso, documentSize: 24120, anchorCount: 18, discoveryDate: dates[0]! }).run()
  db.insert(gaMeasurementSyncStates).values({ projectId: project.id, acquisitionStatus: 'ready', acquisitionSyncedAt: nowIso, leadStatus: 'ready', leadSyncedAt: nowIso, leadAttributionScope: 'landing-page', updatedAt: nowIso }).run()
  db.insert(gaTrafficSummaries).values({ id: `${prefix}-ga-summary`, projectId: project.id, periodStart: dates[0]!, periodEnd: dates.at(-1)!, totalSessions: 1610, totalOrganicSessions: 980, totalUsers: 1214, syncedAt: nowIso, syncRunId }).run()
  db.insert(gaTrafficWindowSummaries).values({ id: `${prefix}-ga-window`, projectId: project.id, windowKey: '30d', periodStart: dates[0]!, periodEnd: dates.at(-1)!, totalSessions: 1610, totalOrganicSessions: 980, totalDirectSessions: 284, totalUsers: 1214, syncedAt: nowIso, syncRunId }).run()

  if (variant === 1) await seedPortfolioCrawl(db, { project, prefix, root, crawlRunId, attemptId, nowIso })
  else seedCrawl(db, { project, prefix, root, crawlRunId, attemptId, nowIso })
  seedLocalAndCommercialSignals(db, { project, prefix, root, syncRunId, campaignId, groupId, locationName, nowIso, dates })

  db.insert(healthSnapshots).values({ id: `${prefix}-health`, projectId: project.id, runId: syncRunId, overallCitedRate: '0.61', overallMentionRate: '0.74', totalPairs: 42, citedPairs: 26, mentionedPairs: 31, providerBreakdown: { openai: { citedRate: 0.62, mentionRate: 0.76, cited: 13, mentioned: 16, total: 21 }, perplexity: { citedRate: 0.6, mentionRate: 0.71, cited: 13, mentioned: 15, total: 21 } }, createdAt: nowIso }).run()
  db.insert(insights).values([
    { id: `${prefix}-insight-1`, projectId: project.id, runId: syncRunId, type: 'opportunity', severity: 'medium', title: 'Expand service comparison guidance', query: searchTerms[0]!, provider: 'openai', recommendation: { action: 'Draft a comparison section', target: `${root}services/`, reason: 'Sample insight for the public dashboard.' }, cause: { cause: 'Sample answer-history gap', details: 'This is stored sample data.' }, dismissed: false, createdAt: nowIso },
    { id: `${prefix}-insight-2`, projectId: project.id, runId: syncRunId, type: 'persistent-gap', severity: 'low', title: 'Review one internal link target', query: searchTerms[1]!, provider: 'perplexity', recommendation: { action: 'Repair the illustrative link', target: `${root}guides/`, reason: 'Sample finding for the public dashboard.' }, cause: { cause: 'Sample crawl finding', details: 'This is stored sample data.' }, dismissed: false, createdAt: nowIso },
  ]).run()
  db.insert(auditLog).values([
    { id: `${prefix}-audit-1`, projectId: project.id, actor: 'sample-data', action: 'demo.seeded', entityType: 'project', entityId: project.id, diff: 'Synthetic public demo signals seeded; no provider was contacted.', createdAt: nowIso },
    { id: `${prefix}-audit-2`, projectId: project.id, actor: 'sample-data', action: 'demo.site-health.snapshot', entityType: 'site-crawl', entityId: crawlRunId, diff: 'Synthetic completed crawl graph and findings stored.', createdAt: nowIso },
  ]).run()
}

function seedCrawl(db: DatabaseClient, input: { project: DemoSeedProject; prefix: string; root: string; crawlRunId: string; attemptId: string; nowIso: string }): void {
  const { project, prefix, root, crawlRunId, attemptId, nowIso } = input
  const pages = [
    ['home', root, '/', '/', 0, 91],
    ['services', `${root}services/`, '/services/', '/', 1, 84],
    ['guides', `${root}guides/`, '/guides/', '/', 1, 76],
    ['contact', `${root}contact/`, '/contact/', '/', 1, 69],
  ] as const
  db.insert(siteCrawlAttempts).values({ id: attemptId, projectId: project.id, runId: crawlRunId, attemptNumber: 1, state: 'completed', lastEventSequence: 12, pagesDiscovered: pages.length, pagesFetched: pages.length, pagesEligible: pages.length, pagesErrored: 0, edgesDiscovered: 4, startedAt: nowIso, finishedAt: nowIso, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(siteCrawlSnapshots).values({ id: `${prefix}-crawl-snapshot`, projectId: project.id, runId: crawlRunId, attemptId, rootUrl: root, requestedRootUrl: root, crawlSchemaVersion: 'demo-1', engineVersion: 'sample-seed', normalizationVersion: 'demo-1', indexabilityVersion: 'demo-1', linkScoreVersion: 'demo-1', effectiveOptions: { sampleData: true }, pageBudget: 50, edgeBudget: 100, maxDepth: 3, checkDeadLinks: true, complete: true, termination: 'complete', detailsAvailable: true, pagesDiscovered: pages.length, pagesFetched: pages.length, pagesEligible: pages.length, pagesErrored: 0, edgesDiscovered: 4, findingsCount: 2, deadLinkState: 'complete', deadLinksChecked: 4, deadLinksFound: 1, deadLinksUnverified: 0, templateDetection: 'applied-placement', linkPlacementRulesetVersion: 'demo-1', createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(siteCrawlPages).values(pages.map(([nodeKey, url, path, parentPath, depth, auditScore], i) => ({ id: `${prefix}-page-${nodeKey}`, projectId: project.id, runId: crawlRunId, attemptId, nodeKey, url, path, parentPath, discoverySource: i === 0 ? 'root' : 'crawl', fetchState: 'fetched', fetchedAt: nowIso, httpStatus: 200, contentType: 'text/html', finalUrl: url, canonicalUrl: url, canonicalNodeKey: nodeKey, indexabilityState: 'indexable', healthState: auditScore < 75 ? 'warning' : 'healthy', auditState: 'completed', auditScore, auditFields: { sampleData: true }, inventoryEligible: true, depth, inboundUniqueEdges: i === 0 ? 0 : 1, outboundUniqueEdges: i === 0 ? 3 : 1, inboundOccurrences: i === 0 ? 0 : 1, outboundOccurrences: i === 0 ? 3 : 1, linkScoreRaw: 1 - i * 0.1, linkScoreNormalized: 1 - i * 0.1, createdAt: nowIso, updatedAt: nowIso }))).run()
  const edges = [['home-services', 'home', 'services'], ['home-guides', 'home', 'guides'], ['home-contact', 'home', 'contact'], ['guides-contact', 'guides', 'contact']] as const
  db.insert(siteCrawlEdges).values(edges.map(([edgeKey, sourceNodeKey, targetNodeKey], i) => ({ id: `${prefix}-edge-${edgeKey}`, projectId: project.id, runId: crawlRunId, attemptId, edgeKey, sourceNodeKey, sourceUrl: pages.find(p => p[0] === sourceNodeKey)![1], targetNodeKey, targetUrl: pages.find(p => p[0] === targetNodeKey)![1], relation: 'link', internal: true, followable: true, occurrences: i + 1, followableOccurrences: i + 1, nofollowOccurrences: 0, anchors: ['Sample internal link'], isTemplate: i === 2, placementNavigationOccurrences: i === 2 ? 1 : 0, placementContentOccurrences: i === 2 ? 0 : 1, placementUnknownOccurrences: 0, createdAt: nowIso, updatedAt: nowIso }))).run()
  db.insert(siteCrawlGraphLayouts).values({ id: `${prefix}-layout`, projectId: project.id, runId: crawlRunId, attemptId, state: 'ready', layoutVersion: 'demo-forceatlas2', totalNodes: pages.length, totalEdges: edges.length, totalTemplateEdges: 1, nodeCount: pages.length, edgeCount: edges.length, templateLinksExcluded: true, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(siteCrawlGraphNodes).values(pages.map(([nodeKey], sampleRank) => ({ id: `${prefix}-graph-node-${nodeKey}`, projectId: project.id, runId: crawlRunId, attemptId, nodeKey, sampleRank, x: sampleRank * 20, y: sampleRank % 2 ? 18 : -12, createdAt: nowIso }))).run()
  db.insert(siteCrawlGraphEdges).values(edges.map(([edgeKey, sourceNodeKey, targetNodeKey], sampleRank) => ({ id: `${prefix}-graph-edge-${edgeKey}`, projectId: project.id, runId: crawlRunId, attemptId, edgeKey, sampleRank, sourceNodeKey, targetNodeKey, followable: true, occurrences: sampleRank + 1, isTemplate: sampleRank === 2, createdAt: nowIso }))).run()
  db.insert(siteCrawlFindings).values([
    { id: `${prefix}-finding-link`, projectId: project.id, runId: crawlRunId, attemptId, findingKey: 'demo-broken-link', findingType: 'dead-link', severity: 'medium', sourceNodeKey: 'guides', sourceUrl: `${root}guides/`, targetUrl: `${root}retired-demo-page/`, evidence: { statusCode: 404, note: 'Sample data: illustrative broken link.' }, createdAt: nowIso, updatedAt: nowIso },
    { id: `${prefix}-finding-meta`, projectId: project.id, runId: crawlRunId, attemptId, findingKey: 'demo-title-review', findingType: 'page-audit', severity: 'low', sourceNodeKey: 'contact', sourceUrl: `${root}contact/`, evidence: { note: 'Sample data: missing page title.' }, createdAt: nowIso, updatedAt: nowIso },
  ]).run()
}

function seedLocalAndCommercialSignals(db: DatabaseClient, input: { project: DemoSeedProject; prefix: string; root: string; syncRunId: string; campaignId: string; groupId: string; locationName: string; nowIso: string; dates: string[] }): void {
  const { project, prefix, root, syncRunId, campaignId, groupId, locationName, nowIso, dates } = input
  db.insert(gbpLocations).values({ id: `${prefix}-gbp-location`, projectId: project.id, accountName: 'accounts/demo-fixture', locationName, displayName: `${project.displayName} - Sample`, primaryCategoryDisplayName: 'Home and travel services', storefrontAddress: '100 Example Avenue, Demo City', websiteUri: root, placeId: `demo-place-${project.id}`, mapsUri: `https://maps.example/${project.id}`, description: 'Sample listing for the public, view-only Canonry dashboard.', selected: true, syncedAt: nowIso, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(gbpDailyMetrics).values(dates.slice(-7).flatMap((date, i) => [
    { id: `${prefix}-gbp-impressions-${date}`, projectId: project.id, locationName, date, metric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', value: 44 + i * 2, syncRunId },
    { id: `${prefix}-gbp-clicks-${date}`, projectId: project.id, locationName, date, metric: 'WEBSITE_CLICKS', value: 7 + (i % 3), syncRunId },
  ])).run()
  db.insert(gbpKeywordImpressions).values({ id: `${prefix}-gbp-keyword`, projectId: project.id, locationName, periodStart: dates[0]!.slice(0, 7), periodEnd: dates.at(-1)!.slice(0, 7), keyword: 'sample local service', valueCount: 148, valueThreshold: null, syncRunId }).run()
  db.insert(gbpKeywordMonthly).values({ id: `${prefix}-gbp-monthly`, projectId: project.id, locationName, month: dates.at(-1)!.slice(0, 7), keyword: 'sample local service', valueCount: 148, valueThreshold: null, syncRunId, syncedAt: nowIso }).run()
  db.insert(gbpPlaceActions).values({ id: `${prefix}-gbp-action`, projectId: project.id, locationName, placeActionLinkName: `${locationName}/placeActionLinks/demo`, placeActionType: 'APPOINTMENT', uri: `${root}contact/`, isPreferred: true, providerType: 'MERCHANT', syncRunId }).run()
  db.insert(backlinkSummaries).values({ id: `${prefix}-backlinks`, projectId: project.id, source: 'commoncrawl', release: 'DEMO-2026-09', targetDomain: project.domain, totalLinkingDomains: 3, totalHosts: 12, top10HostsShare: '0.42', queriedAt: nowIso, createdAt: nowIso }).run()
  db.insert(backlinkDomains).values(['partners.demo.example', 'local-guides.demo.example', 'trade-directory.demo.example'].map((linkingDomain, i) => ({ id: `${prefix}-backlink-domain-${i}`, projectId: project.id, source: 'commoncrawl' as const, release: 'DEMO-2026-09', targetDomain: project.domain, linkingDomain, numHosts: 5 - i, createdAt: nowIso }))).run()
  db.insert(adsConnections).values({ id: `${prefix}-ads-connection`, projectId: project.id, adAccountId: `demo-account-${project.id}`, displayName: 'Sample Ad Account', currencyCode: 'USD', timezone: 'UTC', status: 'active', reviewStatus: 'approved', integrityReviewStatus: 'sample', integrityDecision: 'synthetic', lastSyncedAt: nowIso, conversionTrackingConfigured: true, createdAt: nowIso, updatedAt: nowIso }).run()
  db.insert(adsCampaigns).values({ id: campaignId, projectId: project.id, name: 'Spring travel campaign', description: 'Sample stored campaign for the public dashboard.', status: 'ACTIVE', biddingType: 'MAXIMIZE_CONVERSIONS', dailySpendLimitMicros: 45000000, conversionEventSettingIds: ['demo-conversion-setting'], targeting: { sampleData: true }, syncRunId, syncedAt: nowIso }).run()
  db.insert(adsAdGroups).values({ id: groupId, projectId: project.id, campaignId, name: 'Service comparison intent', description: 'Sample stored ad group.', status: 'ACTIVE', billingEventType: 'CPC', maxBidMicros: 3200000, contextHints: ['sample service\nsample comparison'], syncRunId, syncedAt: nowIso }).run()
  db.insert(adsAds).values({ id: `${prefix}-ad`, projectId: project.id, adGroupId: groupId, name: 'Sample responsive ad', status: 'ACTIVE', creative: { sampleData: true, headline: 'Sample service guidance' }, reviewStatus: 'APPROVED', syncRunId, syncedAt: nowIso }).run()
  db.insert(adsInsightsDaily).values(dates.slice(-7).map((date, i) => ({ id: `${prefix}-ads-insight-${date}`, projectId: project.id, level: 'campaign', entityId: campaignId, date, impressions: 340 + i * 20, clicks: 22 + i, spendMicros: 1800000 + i * 100000, conversions: 2 + (i % 3), syncRunId }))).run()
  db.insert(conversionTrackingContracts).values({ id: `${prefix}-conversion`, projectId: project.id, name: 'Sample lead', eventName: 'generate_lead', googleAds: { customerId: 'demo-customer', conversionActionId: 'demo-action', conversionId: 'AW-123456', conversionLabel: 'demo-label', campaignIds: [campaignId], requireBiddableGoal: true, requirePrimaryAction: true }, gtm: { accountId: 'demo-account', containerId: 'demo-container', tagId: 'demo-tag', triggerIds: ['demo-trigger'], variableIds: ['demo-value', 'demo-currency'] }, runtime: { verificationRequired: true, requireTransactionId: true, requireValue: true, requireCurrency: true, productionHosts: [project.domain] }, createdAt: nowIso, updatedAt: nowIso }).run()
}

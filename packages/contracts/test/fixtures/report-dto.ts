/**
 * Shared `ProjectReportDto` fixtures for BOTH report renderers.
 *
 * The downloadable HTML report (`packages/api-routes/src/report-renderer.ts`)
 * and the in-app SPA report (`apps/web/src/pages/ReportPage.tsx`) render the
 * same DTO. Their tests import these builders so a parity assertion on one
 * surface is an assertion about the same data on the other.
 *
 * Every builder returns a fresh object, so a test may mutate what it gets.
 *
 * - `emptyReport()`: a project with no data in any section.
 * - `richReport()`: every section populated once. The HTML byte snapshots in
 *   `packages/api-routes/test/__snapshots__/report-html/` pin its output, so
 *   changing a value here changes those files. Extend `fullReport()` instead.
 * - `reportWithChangeHistory()`: `richReport()` plus provider movements, wins,
 *   regressions, and a citation trend long enough to chart.
 * - `fullReport()`: `richReport()` plus every conditional block the renderers
 *   branch on (enough history, crossover chips, cited URLs, a competitor source
 *   category, weak market handling, redirect-blocked referrals, unverified
 *   crawled-path hits, a repeated insight, a wide content gap).
 * - `advancedReport()`: `richReport()` with an Advanced visibility selection.
 * - `truncatedReport()`: `fullReport()` with every list long enough to reach
 *   the renderers' caps, which no other fixture does.
 */
import type { ProjectReportDto, ReportVisibility } from '../../src/index.js'
import { MIN_TREND_POINTS } from '../../src/trend-stability.js'

export function emptyReport(): ProjectReportDto {
  return {
    meta: {
      generatedAt: '2026-05-01T12:00:00.000Z',
      project: {
        id: 'p-1',
        name: 'demo',
        displayName: 'Demo',
        canonicalDomain: 'demo.example.com',
        country: 'US',
        language: 'en',
      },
      location: null,
      providerLocationHandling: [],
      periodStart: null,
      periodEnd: null,
      periodDays: 30,
    },
    executiveSummary: {
      citationRate: 0,
      citedQueryCount: 0,
      totalQueryCount: 0,
      mentionRate: 0,
      mentionedQueryCount: 0,
      trend: 'unknown',
      queryCount: 0,
      competitorCount: 0,
      providerCount: 0,
      gsc: null,
      ga: null,
      findings: [],
    },
    citationScorecard: { queries: [], providers: [], matrix: [], providerRates: [] },
    competitorLandscape: { projectCitationCount: 0, competitors: [] },
    mentionLandscape: {
      projectMentionCount: 0,
      totalAnswerSnapshots: 0,
      competitors: [],
      scope: 'non-brand',
      nonBrand: { projectMentionCount: 0, totalAnswerSnapshots: 0, competitors: [] },
      branded: { projectMentionCount: 0, totalAnswerSnapshots: 0, competitors: [] },
    },
    aiSourceOrigin: { categories: [], topDomains: [] },
    gsc: null,
    ga: null,
    socialReferrals: null,
    aiReferrals: null,
    serverActivity: null,
    indexingHealth: null,
    citationsTrend: [],
    whatsChanged: {
      enoughHistory: false,
      headline: 'Building baseline (0 of 4 checks completed). Trends appear after a few more checks.',
      citationRate: null,
      mentionRate: null,
      citedQueryCount: null,
      mentionedQueryCount: null,
      gscClicksDelta: null,
      aiReferralsDelta: null,
      comparisonWindowDays: 15,
      providerMovements: [],
      wins: [],
      regressions: [],
    },
    insights: [],
    recommendedNextSteps: [],
    actionPlan: [],
    clientSummary: {
      headline: 'No tracked queries have completed a visibility sweep yet',
      overview: 'No visibility data yet.',
      actionItems: [],
      confidenceNotes: [],
    },
    agencyDiagnostics: {
      priorities: [],
      diagnostics: [],
    },
    contentOpportunities: [],
    contentGaps: [],
    groundingSources: [],
  }
}

export function richReport(): ProjectReportDto {
  const clientAction: ProjectReportDto['actionPlan'][number] = {
    audience: 'both',
    priority: 10,
    horizon: 'short-term',
    category: 'content',
    title: 'Create content for "best aeo platform"',
    action: 'Publish a client-safe guide that directly answers the priority query.',
    why: ['AI engines already cite competitors for this query.'],
    evidence: ['rival.com is the current winning cited source'],
    successMetric: 'The client is cited for "best aeo platform" in a future sweep.',
    confidence: 'high',
  }
  const agencyAction: ProjectReportDto['actionPlan'][number] = {
    audience: 'agency',
    priority: 20,
    horizon: 'short-term',
    category: 'provider',
    title: 'Diagnose zero-citation providers',
    action: 'Inspect provider answers and source lists for model-specific gaps.',
    why: ['Provider-level misses isolate where retrieval differs by model family.'],
    evidence: ['openai: 0/2 cited query-provider pairs'],
    successMetric: 'OpenAI cites the client on at least one tracked query.',
    confidence: 'high',
  }
  return {
    meta: {
      generatedAt: '2026-05-02T12:00:00.000Z',
      project: {
        id: 'p-2',
        name: 'rich',
        displayName: 'Rich Project',
        canonicalDomain: 'rich.example.com',
        country: 'US',
        language: 'en',
      },
      location: {
        label: 'michigan',
        city: 'Detroit',
        region: 'Michigan',
        country: 'US',
        otherConfiguredLabels: ['florida'],
      },
      providerLocationHandling: [
        { provider: 'gemini', treatment: 'prompt', description: 'Location appended to the query text the Gemini model receives.' },
        { provider: 'openai', treatment: 'request-param', description: 'Location sent as a structured `user_location` field on OpenAI’s web_search tool.' },
      ],
      periodStart: '2026-04-01T00:00:00Z',
      periodEnd: '2026-04-30T00:00:00Z',
      // Deliberately distinct from whatsChanged.comparisonWindowDays below so
      // these tests prove the server-activity labels read meta.periodDays while
      // the what's-changed traffic-delta labels read comparisonWindowDays —
      // independent wiring, not a shared constant.
      periodDays: 7,
    },
    executiveSummary: {
      citationRate: 65,
      citedQueryCount: 3,
      totalQueryCount: 5,
      mentionRate: 40,
      mentionedQueryCount: 2,
      trend: 'up',
      queryCount: 5,
      competitorCount: 3,
      providerCount: 2,
      gsc: { clicks: 1000, impressions: 5000, ctr: 0.2, avgPosition: 4.5, periodStart: '2026-04-01', periodEnd: '2026-04-30' },
      ga: { sessions: 12000, users: 9000, periodStart: '2026-04-01', periodEnd: '2026-04-30' },
      findings: [
        { title: 'Citation rate at 65.0%', detail: 'Up from previous run.', tone: 'positive' },
        { title: '1 critical regression', detail: 'Lost citation', tone: 'negative' },
      ],
    },
    citationScorecard: {
      queries: ['aeo platform', 'answer engine'],
      providers: ['gemini', 'openai'],
      matrix: [
        [
          { citationState: 'cited', answerMentioned: true, model: 'g-2.0' },
          { citationState: 'not-cited', answerMentioned: false, model: 'gpt-4o' },
        ],
        [
          { citationState: 'not-cited', answerMentioned: false, model: 'g-2.0' },
          { citationState: 'cited', answerMentioned: true, model: 'gpt-4o' },
        ],
      ],
      providerRates: [
        { provider: 'gemini', citedCount: 1, mentionedCount: 1, totalCount: 2, citationRate: 50, mentionRate: 50 },
        { provider: 'openai', citedCount: 1, mentionedCount: 1, totalCount: 2, citationRate: 50, mentionRate: 50 },
      ],
    },
    competitorLandscape: {
      projectCitationCount: 4,
      competitors: [
        { domain: 'rival.com', citationCount: 3, totalCount: 4, pressureLabel: 'High', citedQueries: ['aeo platform'], sharePct: 0, theirCitedPages: [] },
        { domain: 'other.com', citationCount: 1, totalCount: 4, pressureLabel: 'Low', citedQueries: ['answer engine'], sharePct: 0, theirCitedPages: [] },
      ],
    },
    mentionLandscape: {
      // Top level mirrors `nonBrand` — the competitive view the section leads with.
      // Shares are what the producers send: two decimals, so 2 of 6 named is 33.33.
      projectMentionCount: 3,
      totalAnswerSnapshots: 4,
      competitors: [
        { domain: 'rival.com', mentionCount: 2, totalCount: 4, pressureLabel: 'Moderate', mentionedQueries: ['aeo platform'], sharePct: 33.33 },
        { domain: 'other.com', mentionCount: 1, totalCount: 4, pressureLabel: 'Low', mentionedQueries: ['answer engine'], sharePct: 16.67 },
      ],
      scope: 'non-brand',
      nonBrand: {
        projectMentionCount: 3,
        totalAnswerSnapshots: 4,
        competitors: [
          { domain: 'rival.com', mentionCount: 2, totalCount: 4, pressureLabel: 'Moderate', mentionedQueries: ['aeo platform'], sharePct: 33.33 },
          { domain: 'other.com', mentionCount: 1, totalCount: 4, pressureLabel: 'Low', mentionedQueries: ['answer engine'], sharePct: 16.67 },
        ],
      },
      branded: {
        projectMentionCount: 2,
        totalAnswerSnapshots: 2,
        competitors: [
          { domain: 'rival.com', mentionCount: 0, totalCount: 2, pressureLabel: 'None', mentionedQueries: [], sharePct: 0 },
          { domain: 'other.com', mentionCount: 0, totalCount: 2, pressureLabel: 'None', mentionedQueries: [], sharePct: 0 },
        ],
      },
    },
    aiSourceOrigin: {
      categories: [
        { category: 'forum', label: 'Forums & Q&A', count: 5, sharePct: 50 },
        { category: 'news', label: 'News & Media', count: 3, sharePct: 30 },
      ],
      topDomains: [
        { domain: 'reddit.com', count: 4, isCompetitor: false },
        { domain: 'rival.com', count: 2, isCompetitor: true },
      ],
    },
    gsc: {
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      totalClicks: 1000,
      totalImpressions: 5000,
      ctr: 0.2,
      avgPosition: 4.5,
      topQueries: [
        { query: 'rich brand', clicks: 800, impressions: 3000, ctr: 0.27, avgPosition: 1.5, category: 'brand' },
        { query: 'best aeo', clicks: 200, impressions: 2000, ctr: 0.1, avgPosition: 5.5, category: 'industry' },
      ],
      categoryBreakdown: [
        { category: 'brand', clicks: 800, impressions: 3000, sharePct: 80 },
        { category: 'industry', clicks: 200, impressions: 2000, sharePct: 20 },
      ],
      trend: [
        { date: '2026-04-01', clicks: 100, impressions: 500 },
        { date: '2026-04-02', clicks: 200, impressions: 1000 },
      ],
      trackedButNoGsc: [],
      gscButNotTracked: [],
    },
    ga: {
      totalSessions: 12000,
      totalUsers: 9000,
      totalOrganicSessions: 8000,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      topLandingPages: [
        { page: '/', sessions: 6000, users: 4500, organicSessions: 4000 },
      ],
      channelBreakdown: [
        { channel: 'Organic Search', sessions: 8000, sharePct: 66.67 },
        { channel: 'Direct', sessions: 4000, sharePct: 33.33 },
      ],
    },
    socialReferrals: {
      totalSessions: 1500,
      organicSessions: 1000,
      paidSessions: 500,
      channels: [
        { channelGroup: 'Organic Social', sessions: 1000, sharePct: 66.67 },
        { channelGroup: 'Paid Social', sessions: 500, sharePct: 33.33 },
      ],
      topCampaigns: [
        { source: 'linkedin.com', medium: 'referral', sessions: 700 },
      ],
    },
    // Sessions only. The users fields are deprecated and never emitted; the
    // fixture omits them so it matches what the report actually produces.
    aiReferrals: {
      totalSessions: 200,
      paidSessions: 150,
      organicSessions: 50,
      bySource: [
        { source: 'chatgpt.com', sessions: 150, paidSessions: 150, organicSessions: 0, sharePct: 75 },
        { source: 'gemini.google.com', sessions: 50, paidSessions: 0, organicSessions: 50, sharePct: 25 },
      ],
      trend: [
        { date: '2026-04-15', sessions: 100 },
        { date: '2026-04-16', sessions: 100 },
      ],
      topLandingPages: [
        { page: '/', sessions: 120 },
      ],
    },
    serverActivity: {
      windowStart: '2026-04-25T00:00:00.000Z',
      windowEnd: '2026-05-02T00:00:00.000Z',
      hasData: true,
      verifiedCrawlerHits: { current: 234, prior: 117, deltaPct: 100 },
      unverifiedCrawlerHits: { current: 15, prior: 5, deltaPct: 200 },
      aiUserFetchHits: { current: 42, prior: 18, deltaPct: 133.33 },
      referralArrivals: { current: 12, prior: 6, deltaPct: 100 },
      referralRedirects: 0,
      referralArrivalsByClass: {
        paid: { current: 9, prior: 4, deltaPct: 125 },
        organic: { current: 2, prior: 2, deltaPct: 0 },
        unclassified: { current: 1, prior: 0, deltaPct: null },
      },
      referralArrivalsClassSummary: 'Paid 9 · Organic 2 · Unclassified 1',
      byOperator: [
        { operator: 'OpenAI', verifiedHits: 140, unverifiedHits: 10, userFetchHits: 32, referralArrivals: 8, deltaPct: 75 },
        { operator: 'Anthropic', verifiedHits: 70, unverifiedHits: 0, userFetchHits: 0, referralArrivals: 3, deltaPct: 40 },
        { operator: 'Google AI', verifiedHits: 24, unverifiedHits: 5, userFetchHits: 0, referralArrivals: 1, deltaPct: null },
        { operator: 'Perplexity', verifiedHits: 0, unverifiedHits: 0, userFetchHits: 10, referralArrivals: 0, deltaPct: null },
      ],
      topCrawledPaths: [
        { path: '/blog/foo', verifiedHits: 80, unverifiedHits: 0, distinctOperators: 2 },
        { path: '/pricing', verifiedHits: 50, unverifiedHits: 0, distinctOperators: 1 },
      ],
      referralProducts: [
        { product: 'ChatGPT', arrivals: 8, distinctLandingPaths: 3 },
        { product: 'Claude', arrivals: 3, distinctLandingPaths: 1 },
      ],
      dailyTrend: [
        { date: '2026-04-29', verifiedCrawlerHits: 30, unverifiedCrawlerHits: 0, userFetchHits: 4, referralArrivals: 2 },
        { date: '2026-04-30', verifiedCrawlerHits: 45, unverifiedCrawlerHits: 0, userFetchHits: 8, referralArrivals: 3 },
      ],
      topReferralLandingPaths: [
        { path: '/landing', arrivals: 5, distinctProducts: 2 },
      ],
    },
    indexingHealth: {
      provider: 'google',
      total: 100,
      indexed: 80,
      notIndexed: 20,
      deindexed: 0,
      unknown: 0,
      indexedPct: 80,
    },
    citationsTrend: [
      { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 25, mentionedQueryCount: 1, providerRates: [{ provider: 'gemini', citationRate: 50, mentionRate: 25 }] },
      { runId: 'r-2', date: '2026-04-15T00:00:00Z', citationRate: 65, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [{ provider: 'gemini', citationRate: 65, mentionRate: 40 }] },
    ],
    whatsChanged: {
      enoughHistory: false,
      headline: 'Building baseline (2 of 4 checks completed). Trends appear after a few more checks.',
      citationRate: null,
      mentionRate: null,
      citedQueryCount: null,
      mentionedQueryCount: null,
      gscClicksDelta: null,
      aiReferralsDelta: null,
      comparisonWindowDays: 14,
      providerMovements: [],
      wins: [],
      regressions: [],
    },
    insights: [
      {
        id: 'i-1',
        type: 'regression',
        severity: 'critical',
        title: 'Lost citation on aeo platform',
        query: 'aeo platform',
        provider: 'gemini',
        recommendation: 'review-content — /landing — rival outranking',
        createdAt: '2026-04-30T00:00:00Z',
        instanceCount: 1,
      },
    ],
    recommendedNextSteps: [
      { horizon: 'immediate', title: 'Resolve 1 critical regression', rationale: 'Lost citation on aeo platform.' },
    ],
    actionPlan: [clientAction, agencyAction],
    clientSummary: {
      headline: '2 of 5 tracked queries mention the brand in AI answers',
      overview: 'Rich Project is mentioned on 40.0% of tracked queries and cited on 65.0%. There is not enough comparable run history yet to call a mention trend.',
      actionItems: [clientAction],
      confidenceNotes: ['This summary is scoped to the michigan run location.'],
    },
    agencyDiagnostics: {
      priorities: [clientAction, agencyAction],
      diagnostics: [
        {
          title: 'Provider citation coverage',
          detail: 'One provider returned zero client citations.',
          severity: 'negative',
          evidence: ['openai: 0/2'],
        },
      ],
    },
    contentOpportunities: [
      {
        targetRef: 'rich:create:best-aeo-platform',
        query: 'best aeo platform',
        action: 'create',
        ourBestPage: null,
        winningCompetitor: {
          domain: 'rival.com',
          url: 'https://rival.com/best-aeo',
          title: 'Best AEO',
          citationCount: 3,
        },
        score: 87.5,
        scoreBreakdown: { demand: 0.6, competitor: 0.8, absence: 1, gapSeverity: 1 },
        drivers: ['high competitor density', 'no own page'],
        demandSource: 'competitor-evidence',
        actionConfidence: 'high',
        existingAction: null,
        winnabilityClass: 'ownable',
        winnability: 0.9,
      },
      {
        targetRef: 'rich:refresh:answer-engine-optimization',
        query: 'answer engine optimization',
        action: 'refresh',
        ourBestPage: {
          url: '/blog/answer-engine-optimization',
          gscImpressions: 1500,
          gscClicks: 120,
          gscAvgPosition: 4,
          organicSessions: 200,
        },
        winningCompetitor: null,
        score: 62.1,
        scoreBreakdown: { demand: 0.7, competitor: 0.3, absence: 0.5, gapSeverity: 0.4 },
        drivers: ['existing page ranks weakly'],
        demandSource: 'gsc',
        actionConfidence: 'medium',
        existingAction: null,
        winnabilityClass: 'ceded',
        winnability: 0.1,
      },
    ],
    contentGaps: [
      {
        query: 'best aeo platform',
        competitorDomains: ['rival.com'],
        competitorCount: 1,
        missRate: 1,
        lastSeenInRunId: 'r-2',
      },
    ],
    groundingSources: [
      {
        query: 'best aeo platform',
        groundingSources: [
          {
            uri: 'https://rival.com/best-aeo',
            title: 'Best AEO',
            domain: 'rival.com',
            isOurDomain: false,
            isCompetitor: true,
            citationCount: 3,
            providers: ['gemini'],
          },
        ],
      },
    ],
  }
}

/** richReport() plus the change history it leaves out: provider movements, wins, regressions, and a trend long enough to chart. */
export function reportWithChangeHistory(): ProjectReportDto {
  const report = richReport()
  const regression = report.insights[0]!
  report.whatsChanged.providerMovements = [{ provider: 'gemini', prior: 50, current: 65, deltaAbs: 15, direction: 'up' }]
  report.whatsChanged.wins = [{ ...regression, id: 'i-2', type: 'gain', severity: 'high', title: 'Gained citation on answer engine', query: 'answer engine' }]
  report.whatsChanged.regressions = [regression]
  report.citationsTrend = Array.from({ length: MIN_TREND_POINTS }, (_, index) => ({
    ...report.citationsTrend[1]!,
    runId: `r-${index + 1}`,
    date: `2026-04-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
  }))
  return report
}

/**
 * richReport() with every conditional block the renderers branch on switched
 * on, so an outline taken from it names every heading, tile, table and note a
 * section can show. Values are chosen so each branch is visible in the output:
 * a repeated win (`× 2`), a repeated insight (`× 3`), an insight with no
 * recommendation, a gap with six domains (`, +1 more`), and a browser-geo
 * provider that triggers the market-scope warning.
 */
export function fullReport(): ProjectReportDto {
  const report = richReport()
  const regression = report.insights[0]!

  report.meta.providerLocationHandling.push({
    provider: 'cdp:chatgpt',
    treatment: 'browser-geo',
    description: 'Location set through the browser session geolocation.',
  })

  report.citationScorecard.queries.push('aeo tools')
  report.citationScorecard.matrix.push([
    { citationState: 'cited', answerMentioned: null, model: 'g-2.0' },
    null,
  ])

  report.competitorLandscape.competitors[0]!.theirCitedPages = [
    { url: 'https://rival.com/best-aeo', citedFor: ['aeo platform', 'answer engine'] },
  ]

  report.aiSourceOrigin.categories.push({ category: 'competitor', label: 'Tracked competitors', count: 2, sharePct: 20 })

  report.gsc!.trackedButNoGsc = ['answer engine']
  report.gsc!.gscButNotTracked = ['aeo software pricing']

  report.ga!.topLandingPages.push({ page: '/pricing?gclid=abc&utm_source=x', sessions: 900, organicSessions: 0 })

  report.serverActivity = {
    ...report.serverActivity!,
    referralRedirects: 120,
    topCrawledPaths: [
      { path: '/blog/foo', verifiedHits: 80, unverifiedHits: 15, distinctOperators: 2 },
      { path: '/pricing', verifiedHits: 50, unverifiedHits: 0, distinctOperators: 1 },
    ],
  }

  report.whatsChanged = {
    ...report.whatsChanged,
    enoughHistory: true,
    headline: 'Citation coverage rose 15 points across the last 3 checks.',
    citationRate: { current: 65, prior: 50, deltaAbs: 15, deltaPct: 30, direction: 'up', window: 3 },
    mentionRate: { current: 40, prior: 45, deltaAbs: -5, deltaPct: -11.11, direction: 'down', window: 3 },
    citedQueryCount: { current: 3.3, prior: 2.7, deltaAbs: 0.6, deltaPct: 22.22, direction: 'up', window: 3 },
    mentionedQueryCount: { current: 2, prior: 2, deltaAbs: 0, deltaPct: 0, direction: 'flat', window: 3 },
    gscClicksDelta: { current: 520, prior: 480, deltaAbs: 40, deltaPct: 8.33, direction: 'up' },
    aiReferralsDelta: { current: 110, prior: 90, deltaAbs: 20, deltaPct: 22.22, direction: 'up' },
    providerMovements: [
      { provider: 'gemini', prior: 50, current: 65, deltaAbs: 15, direction: 'up' },
      { provider: 'openai', prior: 50, current: 49, deltaAbs: -1, direction: 'flat' },
    ],
    wins: [{ ...regression, id: 'i-2', type: 'gain', severity: 'high', title: 'Gained citation on answer engine', query: 'answer engine', instanceCount: 2 }],
    regressions: [regression],
  }

  report.citationsTrend = [
    { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 25, mentionedQueryCount: 1, providerRates: [{ provider: 'gemini', citationRate: 50, mentionRate: 25 }, { provider: 'openai', citationRate: 25, mentionRate: 25 }] },
    { runId: 'r-2', date: '2026-04-08T00:00:00Z', citationRate: 55, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 30, mentionedQueryCount: 1, providerRates: [{ provider: 'gemini', citationRate: 55, mentionRate: 30 }, { provider: 'openai', citationRate: 30, mentionRate: 25 }] },
    { runId: 'r-3', date: '2026-04-15T00:00:00Z', citationRate: 60, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [{ provider: 'gemini', citationRate: 60, mentionRate: 40 }, { provider: 'openai', citationRate: 40, mentionRate: 30 }] },
    { runId: 'r-4', date: '2026-04-22T00:00:00Z', citationRate: 65, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [{ provider: 'gemini', citationRate: 65, mentionRate: 40 }, { provider: 'openai', citationRate: 50, mentionRate: 40 }] },
  ]

  report.insights = [
    { ...regression, instanceCount: 3 },
    {
      id: 'i-3',
      type: 'opportunity',
      severity: 'medium',
      title: 'Opportunity on best aeo platform',
      query: 'best aeo platform',
      provider: 'openai',
      recommendation: null,
      createdAt: '2026-04-29T00:00:00Z',
      instanceCount: 1,
    },
  ]

  report.agencyDiagnostics.diagnostics.push(
    {
      title: 'Search demand mismatch',
      detail: 'Two tracked queries have no Search Console impressions.',
      severity: 'caution',
      evidence: ['answer engine', 'aeo tools', 'aeo platform', 'best aeo'],
    },
    {
      title: 'Location caveat',
      detail: 'This report is scoped to the latest run location.',
      severity: 'caution',
      evidence: ['Current location: michigan'],
    },
  )

  report.recommendedNextSteps.push({
    horizon: 'short-term',
    title: 'Refresh the answer engine optimization page',
    rationale: 'The existing page ranks weakly for a query competitors own.',
  })

  report.contentGaps.push({
    query: 'aeo software comparison',
    competitorDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'],
    competitorCount: 6,
    missRate: 0.5,
    lastSeenInRunId: 'r-4',
  })

  return report
}

/** An Advanced portfolio selection: two measured query-class populations, one with unverified property identity. */
export function advancedVisibility(): ReportVisibility {
  const missing = { numerator: null, denominator: null, rate: null, reason: 'identity-ambiguous' as const }
  const selection: ReportVisibility['selection'] = {
    mode: 'advanced', queryClass: 'all', scope: { id: 'project', label: 'Example portfolio', kind: 'project', targetCount: 2 },
    provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: 1,
    run: { id: 'baseline', explicit: false }, provenance: { kind: 'frozen-advanced', definitionRevision: 1 },
    availability: { state: 'available' }, measurement: { state: 'measured', activeRevision: 1, measuredRevision: 1,
      awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-01T12:00:00.000Z' },
  }
  return { selection, populations: [
    { queryClass: 'non-brand', trend: [], summary: { queryCount: 2, answerCount: 6,
      mentionCoverage: { numerator: 2, denominator: 6, rate: 1 / 3 }, citationCoverage: { numerator: 1, denominator: 6, rate: 1 / 6 },
      propertyReach: { numerator: 1, denominator: 2, rate: 0.5 }, outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 1, notMeasured: 0, total: 2 } } },
    { queryClass: 'branded', trend: [], summary: { queryCount: 1, answerCount: 3,
      mentionCoverage: missing, citationCoverage: { numerator: 0, denominator: 3, rate: 0 }, propertyReach: missing,
      outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 2, total: 2 } } },
  ] }
}

/** A Simple project's frozen selection with one measured non-brand population. */
export function simpleVisibility(): ReportVisibility {
  const measured = { numerator: 3, denominator: 6, rate: 0.5 }
  return { selection: {
    mode: 'simple', queryClass: 'all', scope: { id: 'project', label: 'Example', kind: 'project', targetCount: 1 },
    provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: null,
    run: { id: 'latest', explicit: false }, provenance: { kind: 'frozen-simple', definitionRevision: null },
    availability: { state: 'available' }, measurement: { state: 'measured', activeRevision: null,
      measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-01T10:00:00Z' },
  }, populations: [{ queryClass: 'non-brand', summary: { queryCount: 2, answerCount: 6, mentionCoverage: measured,
    citationCoverage: measured, propertyReach: measured, outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 1, notMeasured: 0, total: 2 } },
    trend: [{ runId: 'latest', createdAt: '2026-09-01T10:00:00Z', revision: null, provenance: { kind: 'frozen-simple', definitionRevision: null },
      queryCount: 2, answerCount: 6, mentionCoverage: measured, citationCoverage: measured,
      continuity: { state: 'comparable', comparedRunId: null } }],
  }] }
}

/** richReport() with an Advanced visibility selection, which removes the legacy-only sections from both audiences. */
export function advancedReport(): ProjectReportDto {
  const report = richReport()
  report.visibility = advancedVisibility()
  return report
}

/**
 * fullReport() with every list long enough to reach the renderers' caps.
 *
 * No other fixture reaches one. `fullReport()` carries two content
 * opportunities, two content gaps and one cited query per competitor, so
 * changing the opportunity table's `slice(0, 10)` to 5, or the cited-query
 * cell's `reportTruncatedList(…, 5)` to 2, leaves BOTH renderers' output
 * identical — the byte snapshots included — and no guard at any level can see
 * it. Every cap here is PAIRED with one in `ReportPage.tsx`, so an unexercised
 * one is a divergence waiting to happen: eight opportunities in the app and
 * five in the downloaded file, with CI green.
 *
 * It is a fixture of its own rather than a larger `fullReport()` because
 * growing a shared fixture rewrites every byte snapshot taken from it.
 */
export function truncatedReport(): ProjectReportDto {
  const report = fullReport()
  const opportunity = report.contentOpportunities[0]!
  const gap = report.contentGaps[0]!

  // Past the opportunity table's 10, the opportunity cards' 3, and the client
  // summary's deduped 5. Distinct queries, because the client summary dedupes
  // by query before it truncates.
  report.contentOpportunities = CAPPED_QUERIES.map((query, index) => ({
    ...opportunity,
    targetRef: `rich:create:${query.replace(/\s+/g, '-')}`,
    query,
    score: 90 - index,
  }))
  // Past the content-gap table's 10.
  report.contentGaps = CAPPED_QUERIES.map((query, index) => ({
    ...gap,
    query,
    competitorCount: index + 1,
    missRate: 1,
  }))
  // Past the cited-query cell's 5, so its `+N more` suffix is in the golden.
  report.competitorLandscape.competitors[0]!.citedQueries = CAPPED_QUERIES.slice(0, 7)
  // Past the client AI-source and GSC top-query lists' 5.
  report.aiSourceOrigin.topDomains = CAPPED_QUERIES.slice(0, 7).map((query, index) => ({
    domain: `${query.split(' ')[0]}-${index}.com`,
    count: 9 - index,
    isCompetitor: index % 3 === 0,
  }))
  if (report.gsc) {
    report.gsc.topQueries = CAPPED_QUERIES.slice(0, 7).map((query, index) => ({
      query,
      clicks: 700 - index * 50,
      impressions: 3000 - index * 100,
      ctr: 0.2,
      avgPosition: 1.5 + index,
      category: index === 0 ? 'brand' : 'industry',
    }))
  }
  // Past the client operator table's 5.
  if (report.serverActivity) {
    report.serverActivity.byOperator = CAPPED_QUERIES.slice(0, 7).map((query, index) => ({
      operator: `Operator ${query.split(' ')[0]}`,
      verifiedHits: 140 - index * 10,
      unverifiedHits: index,
      userFetchHits: 30 - index,
      referralArrivals: 8 - index,
      deltaPct: index === 0 ? 75 : null,
    }))
  }

  // A second `why` and a second `evidence` row on every action. Every other
  // fixture carries exactly one of each, so the renderers' caps on those lists
  // are no-ops and a dropped row is invisible. The action objects are shared
  // with `clientSummary.actionItems` and `agencyDiagnostics.priorities`, so
  // mutating them in place reaches every surface that lists them.
  for (const action of report.actionPlan) {
    action.why = [...action.why, 'Competitors publish a dedicated page and the client does not.']
    action.evidence = [...action.evidence, 'gemini cited rival.com on 3 of 4 answers']
  }

  // The client hero's POSITIVE trend, which no other fixture produces: every
  // golden that has a hero trend has a falling mention rate, so the branch the
  // renderers paint green is untested. The rate itself is unchanged, so the
  // tiles beside it still agree with `executiveSummary`.
  report.whatsChanged.mentionRate = { current: 40, prior: 33, deltaAbs: 7, deltaPct: 21.21, direction: 'up', window: 3 }

  // The share-of-voice band, which renders in NO other fixture. The HTML report
  // writes it as loose notes between sections and the SPA as a band of its own,
  // so without a fixture that produces one the goldens record nothing and a
  // one-surface rewrite of the copy passes. Both query classes, so the measured
  // figure and the not-measured reason line are each covered.
  report.mentionLandscape.nonBrand = {
    ...report.mentionLandscape.nonBrand!,
    shareOfVoice: {
      queryClass: 'non-brand',
      percent: 60,
      competitorCount: 2,
      projectMentions: 3,
      competitorMentions: 2,
      snapshotsWithAnswerText: 4,
      perCompetitor: [{ domain: 'rival.com', mentions: 2 }],
      basis: 'tracked',
      availability: 'measured',
      reason: null,
    },
  }
  report.mentionLandscape.branded = {
    ...report.mentionLandscape.branded!,
    shareOfVoice: {
      queryClass: 'branded',
      percent: null,
      competitorCount: 0,
      projectMentions: 2,
      competitorMentions: 0,
      snapshotsWithAnswerText: 2,
      perCompetitor: [],
      basis: 'tracked',
      availability: 'not-measured',
      reason: 'no-competitors',
    },
  }
  return report
}

/** Twelve distinct queries: two more than the largest cap either renderer applies. */
const CAPPED_QUERIES = [
  'best aeo platform', 'answer engine optimization', 'aeo tools', 'ai search visibility',
  'llm citation tracking', 'generative engine optimization', 'brand mention tracking',
  'ai answer monitoring', 'chatgpt seo', 'perplexity ranking', 'gemini citations', 'ai visibility audit',
]

import { describe, expect, test } from 'vitest'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'
import { formatLandingPageHtml, renderReportHtml } from '../src/report-renderer.js'

function emptyReport(): ProjectReportDto {
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
    mentionLandscape: { projectMentionCount: 0, totalAnswerSnapshots: 0, competitors: [] },
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
      gscClicksDelta: null,
      aiReferralsDelta: null,
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

function richReport(): ProjectReportDto {
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
        { provider: 'openai', treatment: 'request-param', description: 'Location sent as a structured `user_location` field on OpenAI’s web_search_preview tool.' },
      ],
      periodStart: '2026-04-01T00:00:00Z',
      periodEnd: '2026-04-30T00:00:00Z',
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
        { title: 'Citation rate at 65%', detail: 'Up from previous run.', tone: 'positive' },
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
        { provider: 'gemini', citedCount: 1, totalCount: 2, citationRate: 50 },
        { provider: 'openai', citedCount: 1, totalCount: 2, citationRate: 50 },
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
      projectMentionCount: 3,
      totalAnswerSnapshots: 4,
      competitors: [
        { domain: 'rival.com', mentionCount: 2, totalCount: 4, pressureLabel: 'Moderate', mentionedQueries: ['aeo platform'], sharePct: 33 },
        { domain: 'other.com', mentionCount: 1, totalCount: 4, pressureLabel: 'Low', mentionedQueries: ['answer engine'], sharePct: 17 },
      ],
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
        { channel: 'Organic Search', sessions: 8000, sharePct: 67 },
        { channel: 'Direct', sessions: 4000, sharePct: 33 },
      ],
    },
    socialReferrals: {
      totalSessions: 1500,
      organicSessions: 1000,
      paidSessions: 500,
      channels: [
        { channelGroup: 'Organic Social', sessions: 1000, sharePct: 67 },
        { channelGroup: 'Paid Social', sessions: 500, sharePct: 33 },
      ],
      topCampaigns: [
        { source: 'linkedin.com', medium: 'referral', sessions: 700 },
      ],
    },
    aiReferrals: {
      totalSessions: 200,
      totalUsers: 150,
      bySource: [
        { source: 'chatgpt.com', sessions: 150, users: 110, sharePct: 75 },
        { source: 'gemini.google.com', sessions: 50, users: 40, sharePct: 25 },
      ],
      trend: [
        { date: '2026-04-15', sessions: 100 },
        { date: '2026-04-16', sessions: 100 },
      ],
      topLandingPages: [
        { page: '/', sessions: 120, users: 90 },
      ],
    },
    serverActivity: {
      windowStart: '2026-04-25T00:00:00.000Z',
      windowEnd: '2026-05-02T00:00:00.000Z',
      hasData: true,
      verifiedCrawlerHits: { current: 234, prior: 117, deltaPct: 100 },
      unverifiedCrawlerHits: { current: 15, prior: 5, deltaPct: 200 },
      referralArrivals: { current: 12, prior: 6, deltaPct: 100 },
      byOperator: [
        { operator: 'OpenAI', verifiedHits: 140, unverifiedHits: 10, referralArrivals: 8, deltaPct: 75 },
        { operator: 'Anthropic', verifiedHits: 70, unverifiedHits: 0, referralArrivals: 3, deltaPct: 40 },
        { operator: 'Google AI', verifiedHits: 24, unverifiedHits: 5, referralArrivals: 1, deltaPct: null },
      ],
      topCrawledPaths: [
        { path: '/blog/foo', verifiedHits: 80, distinctOperators: 2 },
        { path: '/pricing', verifiedHits: 50, distinctOperators: 1 },
      ],
      referralProducts: [
        { product: 'ChatGPT', arrivals: 8, distinctLandingPaths: 3 },
        { product: 'Claude', arrivals: 3, distinctLandingPaths: 1 },
      ],
      dailyTrend: [
        { date: '2026-04-29', verifiedCrawlerHits: 30, referralArrivals: 2 },
        { date: '2026-04-30', verifiedCrawlerHits: 45, referralArrivals: 3 },
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
      { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 25, mentionedQueryCount: 1, providerRates: [{ provider: 'gemini', citationRate: 50 }] },
      { runId: 'r-2', date: '2026-04-15T00:00:00Z', citationRate: 65, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [{ provider: 'gemini', citationRate: 65 }] },
    ],
    whatsChanged: {
      enoughHistory: false,
      headline: 'Building baseline (2 of 4 checks completed). Trends appear after a few more checks.',
      citationRate: null,
      mentionRate: null,
      citedQueryCount: null,
      gscClicksDelta: null,
      aiReferralsDelta: null,
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
      headline: '3 of 5 tracked queries are cited by AI engines',
      overview: 'Rich Project is cited on 65% of tracked queries and mentioned on 40%. Citation coverage improved versus the prior comparable sweep.',
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

describe('renderReportHtml', () => {
  test('returns a string starting with <!DOCTYPE html>', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).toMatch(/^<!DOCTYPE html>/)
  })

  test('produces self-contained HTML — no external src or href dependencies', () => {
    const html = renderReportHtml(richReport())
    // No <script src="..."> tags pointing to external resources
    expect(/<script[^>]+\bsrc\s*=/i.test(html)).toBe(false)
    // No <link rel="stylesheet"> tags
    expect(/<link[^>]+rel\s*=\s*["']stylesheet["']/i.test(html)).toBe(false)
    // No remote-loading <link rel="preload" as="script">
    expect(/<link[^>]+rel\s*=\s*["']preload["']/i.test(html)).toBe(false)
  })

  test('contains an inline <style> block', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).toMatch(/<style[\s\S]*?<\/style>/)
  })

  test('footer renders date as YYYY-MM-DD and preserves the canonry link', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).toContain('<a href="https://canonry.ai">canonry</a> · 2026-05-01</footer>')
    expect(html).not.toContain('2026-05-01T12:00:00.000Z</footer>')
  })

  test('@media print block preserves the dark theme (no white-on-black inversion)', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).toContain('@media print')
    expect(html).toContain('print-color-adjust: exact')
    expect(html).toContain('break-inside: avoid')
    expect(html).not.toMatch(/@media print\s*\{[^}]*background:\s*white/)
    expect(html).not.toMatch(/@media print\s*\{[^}]*color:\s*black/)
  })

  test('embeds the report JSON in a <script type="application/json"> block', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('id="canonry-report-data"')
    expect(html).toContain('type="application/json"')
    // The project name should appear in the embedded JSON
    expect(html).toContain('"name":"rich"')
  })

  test('renders a section anchor for every report section', () => {
    const html = renderReportHtml(richReport())
    const expectedSections = [
      'executive-summary',
      'agency-action-plan',
      'agency-diagnostics',
      'citation-scorecard',
      'competitor-landscape',
      'ai-source-origin',
      'gsc',
      'ga',
      'social-referrals',
      'ai-referrals',
      'indexing-health',
      'citations-trend',
      'insights',
      'content-opportunities',
      'recommended-next-steps',
    ]
    for (const section of expectedSections) {
      expect(html).toContain(`id="${section}"`)
    }
  })

  test('content opportunities table surfaces the drivers list as a Why column', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('high competitor density')
    expect(html).toContain('no own page')
    // Drivers are rendered as a list, not a single comma-joined cell.
    const block = html.split('id="content-opportunities"')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('driver-list')
  })

  test('content gaps section renders when contentGaps has entries', () => {
    const report = richReport()
    report.contentGaps = [
      { query: 'gap one', competitorDomains: ['a.com', 'b.com', 'c.com'], competitorCount: 3, missRate: 1, lastSeenInRunId: 'run-1' },
      { query: 'gap two', competitorDomains: ['x.com'], competitorCount: 1, missRate: 0.5, lastSeenInRunId: 'run-1' },
    ]
    const html = renderReportHtml(report)
    expect(html).toContain('id="content-gaps"')
    expect(html).toContain('gap one')
    expect(html).toContain('a.com, b.com, c.com')
  })

  test('content gaps section is omitted when contentGaps is empty', () => {
    const report = richReport()
    report.contentGaps = []
    const html = renderReportHtml(report)
    expect(html).not.toContain('id="content-gaps"')
  })

  test('renders project display name in the document title', () => {
    const html = renderReportHtml(richReport())
    expect(html).toMatch(/<title>[^<]*Rich Project[^<]*<\/title>/)
  })

  test('renders date-only reporting ranges without timezone shifting the day', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('Apr 1, 2026')
    expect(html).toContain('Apr 30, 2026')
  })

  test('renders the GSC date range beside the click metric', () => {
    const html = renderReportHtml(richReport())
    const executive = html.split('id="executive-summary"')[1]?.split('id="agency-action-plan"')[0] ?? ''
    const gsc = html.split('id="gsc"')[1]?.split('</section>')[0] ?? ''
    expect(executive).toContain('5.0K imp · 20.0% CTR · Apr 1, 2026 → Apr 30, 2026')
    expect(gsc).toContain('Search demand signals to compare against AI visibility for Apr 1, 2026 → Apr 30, 2026.')
  })

  test('agency HTML includes the AI Visibility — Server-Side section with Section 10 eyebrow', () => {
    const html = renderReportHtml(richReport(), { audience: 'agency' })
    expect(html).toContain('id="server-activity"')
    expect(html).toContain('AI Visibility — Server-Side')
    expect(html).toContain('Section 10')
    // Headline numbers and explanatory copy that anchor analyst trust
    expect(html).toContain('Verified crawler hits (7d)')
    expect(html).toContain('Unverified crawler hits (7d)')
    expect(html).toContain('AI-referral sessions (7d)')
    expect(html).toContain('rDNS-confirmed')
    // Per-operator breakdown headings
    expect(html).toContain('Per AI operator')
    expect(html).toContain('Top crawled paths')
    expect(html).toContain('AI-referral sessions by product')
    // Specific row values from richReport()
    expect(html).toContain('OpenAI')
    expect(html).toContain('Anthropic')
    expect(html).toContain('/blog/foo')
  })

  test('client HTML includes the AI Visibility — Server-Side section between WhatsChanged and the action plan', () => {
    const html = renderReportHtml(richReport(), { audience: 'client' })
    // Per the report-parity rule, what the SPA shows the client (between
    // WhatsChanged and ActionPlan) must also be in the downloadable HTML.
    expect(html).toContain('id="server-activity"')
    expect(html).toContain('AI Visibility — Server-Side')
    // Plain-English client labels (NOT the analyst "Verified crawler hits" copy)
    expect(html).toContain('AI bot requests observed')
    expect(html).toContain('AI referral sessions')
    expect(html).toContain('reverse-DNS')
    // Section eyebrow in client view is the friendlier "AI engine attention" label
    expect(html).toContain('AI engine attention')
    // Per-engine breakdown rendered with operator names
    expect(html).toContain('OpenAI')
    // The agency-only labels MUST NOT appear in the client view
    expect(html).not.toContain('Verified crawler hits (7d)')
    expect(html).not.toContain('Top crawled paths')
    // Section 10 eyebrow is agency-only
    expect(html).not.toContain('Section 10')
  })

  test('client HTML hides the section entirely when no traffic source is connected', () => {
    const report = richReport()
    report.serverActivity = null
    const html = renderReportHtml(report, { audience: 'client' })
    expect(html).not.toContain('id="server-activity"')
    expect(html).not.toContain('AI Visibility — Server-Side')
  })

  test('agency HTML shows the connect prompt when no source is connected', () => {
    const report = richReport()
    report.serverActivity = null
    const html = renderReportHtml(report, { audience: 'agency' })
    expect(html).toContain('id="server-activity"')
    expect(html).toContain('Connect a server-side traffic source')
  })

  test('renumbered agency sections 11-16 retain their post-Server-Side ordering', () => {
    const html = renderReportHtml(richReport(), { audience: 'agency' })
    // Section 10 = AI Visibility — Server-Side (added by this PR)
    // Section 11 = Indexing Health (was Section 10)
    // Section 12 = Citations Over Time (was Section 11)
    // Section 13 = Insights (was Section 12)
    // Sections after that are not anchored on these eyebrows in the agency
    // assembly, but we assert 11–13 to lock in the renumbering invariant.
    expect(html).toContain('Section 11')
    expect(html).toContain('Indexing Health')
    expect(html).toContain('Section 12')
    expect(html).toContain('Citations Over Time')
    // The `serverActivity` block must come BEFORE Indexing Health in the
    // emitted HTML — this enforces section ordering at the rendered level.
    const saIdx = html.indexOf('id="server-activity"')
    const ihIdx = html.indexOf('id="indexing-health"')
    expect(saIdx).toBeGreaterThan(0)
    expect(ihIdx).toBeGreaterThan(0)
    expect(saIdx).toBeLessThan(ihIdx)
  })

  // Locks in the report-parity rule for the metric subtitle: the SPA's
  // `formatDeltaCopy` from contracts is the canonical text format; the
  // HTML wraps it in a tone span but emits the same human-readable copy.
  test('server-activity metric subtitle uses the shared formatDeltaCopy text', () => {
    const agencyHtml = renderReportHtml(richReport(), { audience: 'agency' })
    expect(agencyHtml).toContain('Up 100% vs prior 7 days (117 hits)')
    expect(agencyHtml).toContain('Up 200% vs prior 7 days (5 hits)')
    expect(agencyHtml).toContain('Up 100% vs prior 7 days (6 sessions)')
    // Tone class wraps the copy
    expect(agencyHtml).toMatch(/<span class="tone-positive">Up 100% vs prior 7 days/)

    const clientHtml = renderReportHtml(richReport(), { audience: 'client' })
    expect(clientHtml).toContain('234 verified · 15 unverified')
    expect(clientHtml).toContain('Up 104% vs prior 7 days (122 requests)')
    expect(clientHtml).toContain('Up 100% vs prior 7 days (6 sessions)')
  })

  test('client view of empty server-activity uses the friendly heading, not "Section 10"', () => {
    const report = richReport()
    report.serverActivity = {
      ...report.serverActivity!,
      hasData: false,
      verifiedCrawlerHits: { current: 0, prior: 0, deltaPct: null },
      unverifiedCrawlerHits: { current: 0, prior: 0, deltaPct: null },
      referralArrivals: { current: 0, prior: 0, deltaPct: null },
      byOperator: [],
      topCrawledPaths: [],
      referralProducts: [],
      dailyTrend: [],
      topReferralLandingPaths: [],
    }
    const html = renderReportHtml(report, { audience: 'client' })
    expect(html).toContain('id="server-activity"')
    expect(html).toContain('AI engine attention')
    expect(html).toContain('AI Visibility — Server-Side')
    // Section 10 is the agency-numbered eyebrow and must not leak to clients
    expect(html).not.toContain('Section 10')
  })

  test('handles empty data without throwing', () => {
    expect(() => renderReportHtml(emptyReport())).not.toThrow()
  })

  test('rich report includes competitor table rows and findings', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('rival.com')
    expect(html).toContain('Lost citation on aeo platform')
    expect(html).toContain('chatgpt.com')
  })

  test('defaults to agency mode with diagnostics and detailed evidence sections', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('AI Visibility Report')
    expect(html).toContain('id="agency-diagnostics"')
    expect(html).toContain('id="citation-scorecard"')
    expect(html).toContain('Diagnose zero-citation providers')
  })

  test('renders market scope without visible provider implementation details', () => {
    const html = renderReportHtml(richReport())
    const executive = html.split('id="executive-summary"')[1]?.split('id="agency-action-plan"')[0] ?? ''
    expect(executive).toContain('Market Scope')
    expect(executive).toContain('Current check')
    expect(executive).toContain('Not included')
    expect(executive).toContain('florida')
    expect(executive).not.toContain('Location handling')
    expect(executive).not.toContain('web_search_preview')
    expect(executive).not.toContain('How the location reached the model')
  })

  test('filters legacy location caveat diagnostics from the visible agency report', () => {
    const report = richReport()
    report.agencyDiagnostics.diagnostics.push({
      title: 'Location caveat',
      detail: 'This report is scoped to the latest run location.',
      severity: 'caution',
      evidence: ['Current location: michigan'],
    })
    const html = renderReportHtml(report)
    const diagnostics = html.split('id="agency-diagnostics"')[1]?.split('</section>')[0] ?? ''
    expect(diagnostics).not.toContain('Location caveat')
  })

  test('collapses market-modified duplicate content recommendations in saved report payloads', () => {
    const report = richReport()
    const baseAction: ProjectReportDto['actionPlan'][number] = {
      audience: 'both',
      priority: 20,
      horizon: 'medium-term',
      category: 'content',
      title: 'Create content for "polyurea roof coating"',
      action: 'Create / so it directly answers the tracked query.',
      why: ['4 GSC impressions'],
      evidence: ['Opportunity score 1 with medium confidence'],
      successMetric: 'A future sweep cites demo.example.com for "polyurea roof coating".',
      confidence: 'medium',
    }
    const marketAction: ProjectReportDto['actionPlan'][number] = {
      ...baseAction,
      priority: 21,
      title: 'Create content for "polyurea roof coating michigan"',
      action: 'Create a new page for "polyurea roof coating michigan".',
      why: ['no existing page'],
      evidence: ['Opportunity score 0 with low confidence'],
      successMetric: 'A future sweep cites demo.example.com for "polyurea roof coating michigan".',
      confidence: 'low',
    }
    report.actionPlan = [baseAction, marketAction]
    report.clientSummary.actionItems = [baseAction, marketAction]
    report.agencyDiagnostics.priorities = [baseAction, marketAction]
    report.contentOpportunities = [
      {
        targetRef: 'polyurea',
        query: 'polyurea roof coating',
        action: 'create',
        ourBestPage: null,
        winningCompetitor: null,
        score: 1,
        scoreBreakdown: { demand: 1, competitor: 0, absence: 1, gapSeverity: 1 },
        drivers: ['4 GSC impressions'],
        demandSource: 'gsc',
        actionConfidence: 'medium',
        existingAction: null,
      },
      {
        targetRef: 'polyurea-michigan',
        query: 'polyurea roof coating michigan',
        action: 'create',
        ourBestPage: null,
        winningCompetitor: null,
        score: 0,
        scoreBreakdown: { demand: 0, competitor: 0, absence: 1, gapSeverity: 1 },
        drivers: ['no existing page'],
        demandSource: 'gsc',
        actionConfidence: 'low',
        existingAction: null,
      },
    ]

    const html = renderReportHtml(report)
    const actions = html.split('id="agency-action-plan"')[1]?.split('</section>')[0] ?? ''
    const opportunities = html.split('id="content-opportunities"')[1]?.split('</section>')[0] ?? ''

    expect(actions).toContain('Create content for &quot;polyurea roof coating&quot;')
    expect(actions).not.toContain('polyurea roof coating michigan')
    expect(opportunities).toContain('polyurea roof coating')
    expect(opportunities).not.toContain('polyurea roof coating michigan')
  })

  test('action card badges show polished labels, not raw enum codes', () => {
    // The DTO carries lowercase, hyphenated codes (`'short-term'`, `'high'`,
    // `'search-demand'`, etc.) that exist for sorting/routing/tone — they
    // must not reach the user. Symptom we're guarding against: badges that
    // read "short-term" or "high confidence" instead of "Short term" /
    // "High confidence". Same class of bug as the rank-number leak.
    const report = richReport()
    report.actionPlan = [{
      audience: 'agency',
      priority: 50,
      horizon: 'short-term',
      category: 'search-demand',
      title: 'Audit GSC alignment',
      action: 'Review tracked queries against GSC demand.',
      why: ['mismatch hides opportunity'],
      evidence: [],
      successMetric: 'Tracked set matches GSC.',
      confidence: 'medium',
    }]
    report.agencyDiagnostics.priorities = report.actionPlan
    const cards = renderReportHtml(report).split('id="agency-action-plan"')[1]?.split('</section>')[0] ?? ''
    expect(cards).toContain('Short term')
    expect(cards).toContain('Search demand')
    expect(cards).toContain('Medium confidence')
    expect(cards).not.toMatch(/>short-term</)
    expect(cards).not.toMatch(/>search-demand</)
    expect(cards).not.toMatch(/>medium confidence</)
  })

  test('insights table severity badge shows "Critical" not "critical"', () => {
    const report = richReport()
    report.insights = [{
      id: 'i-x',
      type: 'regression',
      severity: 'critical',
      title: 'Lost citation',
      query: 'q',
      provider: 'gemini',
      recommendation: null,
      createdAt: '2026-04-30T00:00:00Z',
      instanceCount: 1,
    }]
    const block = renderReportHtml(report).split('id="insights"')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('>Critical<')
    expect(block).not.toMatch(/>critical</)
  })

  test('opportunity card surfaces score scale and title-cased action/confidence', () => {
    // The opportunity score is 0–100; rendered bare ("87"), users mistake it
    // for a percent, a rank, or some scoped quality grade. Always pair it
    // with "/100" or a tooltip so the scale is unambiguous. Action/confidence
    // chips stay polished too.
    const html = renderReportHtml(richReport())
    const opps = html.split('id="content-opportunities"')[1]?.split('</section>')[0] ?? ''
    expect(opps).toContain('/100')
    expect(opps).toContain('>Create<')
    expect(opps).toContain('>High<')
    expect(opps).not.toMatch(/>create</)
    expect(opps).not.toMatch(/>high</)
  })

  test('action rank is sequential 1..N, not the internal priority code', () => {
    // The DTO's `priority` is a stable internal sort key (10 = competitors,
    // 20-21 = content, 30 = indexing, 40 = provider, ...). Surfacing those
    // raw values to the client confused readers — they read "10" as a score.
    // The renderer should display the visible position in the impact-sorted
    // list (1, 2, 3, ...) while letting `priority` keep its sort role.
    const report = richReport()
    const cards = renderReportHtml(report).split('id="agency-action-plan"')[1]?.split('</section>')[0] ?? ''
    const ranks = [...cards.matchAll(/<div class="action-rank"[^>]*>(\d+)<\/div>/g)].map(m => m[1])
    expect(ranks).toEqual(['1', '2'])
    expect(ranks).not.toContain('10')
    expect(ranks).not.toContain('20')
  })

  test('client mode renders polished actions before concise evidence', () => {
    const html = renderReportHtml(richReport(), { audience: 'client' })
    expect(html).toContain('AI Visibility Report')
    expect(html).toContain('id="client-summary"')
    expect(html).toContain('id="client-action-plan"')
    expect(html).toContain('What to do next')
    expect(html).toContain('Publish a client-safe guide')
    expect(html).not.toContain('id="citation-scorecard"')

    const actionIndex = html.indexOf('id="client-action-plan"')
    const evidenceIndex = html.indexOf('id="client-evidence-summary"')
    expect(actionIndex).toBeGreaterThan(-1)
    expect(evidenceIndex).toBeGreaterThan(actionIndex)
  })

  test('client mode uses plain-English labels — no AEO/SEO jargon', () => {
    const html = renderReportHtml(richReport(), { audience: 'client' })
    // Strip the embedded JSON payload — it carries the canonical DTO with
    // analyst vocabulary, but is invisible to the reader.
    const visible = html.split('<script')[0]
    // Hero + tile labels
    expect(visible).toContain('>Overview<')
    expect(visible).toContain('AI mentions your name')
    expect(visible).toContain('AI links to your website')
    expect(visible).toContain('AI tools tested')
    expect(visible).toContain('How often each AI tool links to your website')
    // Mentions vs links explainer must exist
    expect(visible).toContain('Mentions and links are different')
    // Customer questions list must render the queries
    expect(visible).toContain('Customer questions we tested')
    expect(visible).toContain('aeo platform')
    // Action plan + evidence
    expect(visible).toContain('What to do next')
    expect(visible).toContain('What success looks like:')
    expect(visible).toContain('What we based this on')
    expect(visible).toContain('The signals behind this plan')
    // The old jargon labels must not appear in the rendered UI
    expect(visible).not.toContain('Citation coverage')
    expect(visible).not.toContain('Mention coverage')
    expect(visible).not.toContain('Providers checked')
    expect(visible).not.toContain('Win condition:')
    expect(visible).not.toContain('Why This Is The Plan')
    expect(visible).not.toContain('Sources AI engines trust')
  })

  test('client whats-changed uses plain-English tile labels', () => {
    const html = renderReportHtml(richReport(), { audience: 'client' })
    const visible = html.split('<script')[0]
    expect(visible).toContain('Since last check')
    // Apostrophe is HTML-escaped in the rendered title
    expect(visible).toContain('different since last check')
    // Engine column header should be the client label, not 'Engine'
    expect(visible).not.toContain('>Engine<')
    expect(visible).not.toContain('>Prior<')
  })

  test('agency mode keeps analyst vocabulary (no client labels leak)', () => {
    const html = renderReportHtml(richReport(), { audience: 'agency' })
    const visible = html.split('<script')[0]
    expect(visible).toContain('Citation rate')
    expect(visible).toContain('Mention rate')
    expect(visible).toContain('Win condition:')
    expect(visible).not.toContain('AI links to your website')
    expect(visible).not.toContain('What success looks like:')
    expect(visible).not.toContain('id="client-summary"')
  })

  test('citation matrix shows cited vs not-cited cells', () => {
    const html = renderReportHtml(richReport())
    // Section content should include queries from the matrix
    expect(html).toContain('aeo platform')
    expect(html).toContain('answer engine')
    // and provider names
    expect(html).toContain('gemini')
    expect(html).toContain('openai')
  })

  test('inline CSS allows long table cells to wrap on word boundaries', () => {
    // overflow-wrap: anywhere broke mid-word inside quoted query strings
    // (e.g. "polyurea roof coating" in the Insights & Alerts table). Switching
    // to break-word + hyphens: auto wraps at word boundaries first and only
    // splits long tokens when no boundary fits.
    const html = renderReportHtml(emptyReport())
    expect(html).toContain('overflow-wrap: break-word')
    expect(html).toContain('hyphens: auto')
    expect(html).not.toContain('overflow-wrap: anywhere')
  })

  test('renders landing page URLs with full URL accessible via title', () => {
    const report = richReport()
    report.ga!.topLandingPages = [
      {
        page: '/solar?fbclid=120242511631000253&h_ad_id=120242512056450253',
        sessions: 100, users: 80, organicSessions: 0,
      },
    ]
    const html = renderReportHtml(report)
    expect(html).toContain('class="page-cell"')
    expect(html).toContain('class="page-path"')
    expect(html).toContain('Facebook Ad')
    expect(html).toContain('title="/solar?fbclid=120242511631000253&amp;h_ad_id=120242512056450253"')
    // The raw query string should not appear as visible cell text
    expect(html).not.toMatch(/<span class="page-path">[^<]*fbclid/)
  })

  test('renders a Content Opportunities section anchor when the array is non-empty', () => {
    const html = renderReportHtml(richReport())
    expect(html).toContain('id="content-opportunities"')
    // Top opportunity's query and action chip should both appear
    expect(html).toContain('best aeo platform')
    expect(html).toContain('create')
  })

  test('omits the Content Opportunities section when the array is empty', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).not.toContain('id="content-opportunities"')
  })

  test('absolutizes path-only Our page links to the project canonical domain', () => {
    // richReport's second opportunity has ourBestPage.url = '/blog/answer-engine-optimization'
    // and the project canonical domain is rich.example.com.
    const html = renderReportHtml(richReport())
    const opps = html.split('id="content-opportunities"')[1]?.split('</section>')[0] ?? ''
    expect(opps).toContain('href="https://rich.example.com/blog/answer-engine-optimization"')
    // Display text stays as the path so reviewers still see the slug
    expect(opps).toContain('>/blog/answer-engine-optimization<')
  })

  test('renders the API-supplied recommendedNextSteps verbatim', () => {
    // The API merges insight-derived and opportunity-derived steps via
    // mapOpportunitiesToNextSteps and ships the merged list. The renderer
    // is a pure consumer — no business logic, no recompute. (Coverage for
    // the API-side merge lives in api-routes report-content.test.ts.)
    const html = renderReportHtml(richReport()) // has one explicit immediate step
    const stepsBlock = html.split('id="recommended-next-steps"')[1] ?? ''
    expect(stepsBlock).toContain('Resolve 1 critical regression')
    // Opportunity content was NOT in the API-supplied list, so it must not
    // appear in the steps block.
    expect(stepsBlock).not.toContain('Refresh the page targeting')
  })

  test('shows the empty state when the API supplies no recommendedNextSteps', () => {
    const report = richReport()
    report.recommendedNextSteps = []
    const html = renderReportHtml(report)
    const stepsBlock = html.split('id="recommended-next-steps"')[1] ?? ''
    expect(stepsBlock).toContain('No outstanding actions.')
  })

  test('renders the "Citation share" column header (renamed from "SOV") in competitor landscape', () => {
    const report = richReport()
    report.competitorLandscape.competitors[0]!.sharePct = 75
    report.competitorLandscape.competitors[1]!.sharePct = 25
    const html = renderReportHtml(report)
    const landscape = html.split('id="competitor-landscape"')[1]?.split('</section>')[0] ?? ''
    expect(landscape).toContain('Citation share')
    expect(landscape).not.toContain('>SOV<')
    expect(landscape).toContain('75%')
    expect(landscape).toContain('25%')
  })

  test('renders cited URLs from theirCitedPages as a disclosure', () => {
    const report = richReport()
    report.competitorLandscape.competitors[0]!.theirCitedPages = [
      { url: 'https://rival.com/page-x', citedFor: ['kw1', 'kw2'] },
    ]
    const html = renderReportHtml(report)
    const landscape = html.split('id="competitor-landscape"')[1]?.split('</section>')[0] ?? ''
    expect(landscape).toContain('https://rival.com/page-x')
    expect(landscape).toContain('kw1')
    expect(landscape).toContain('kw2')
  })

  test('omits the cited-pages disclosure when no grounding URLs were captured', () => {
    const report = richReport()
    for (const c of report.competitorLandscape.competitors) c.theirCitedPages = []
    const html = renderReportHtml(report)
    const landscape = html.split('id="competitor-landscape"')[1]?.split('</section>')[0] ?? ''
    expect(landscape).not.toContain('<details')
  })

  test('renders the Mentions per domain bar chart and Mentions column alongside Citations', () => {
    const html = renderReportHtml(richReport())
    const landscape = html.split('id="competitor-landscape"')[1]?.split('</section>')[0] ?? ''
    expect(landscape).toContain('Citations per domain')
    expect(landscape).toContain('Mentions per domain')
    expect(landscape).toContain('<th class="numeric">Mentions</th>')
    // rival.com has citationCount=3 / totalCount=4 (citations) and mentionCount=2 / totalCount=4 (mentions)
    expect(landscape).toContain('3 / 4')
    expect(landscape).toContain('2 / 4')
  })

  test('renders GSC × AEO crossover companion blocks when non-empty', () => {
    const report = richReport()
    report.gsc!.trackedButNoGsc = ['lonely-query']
    report.gsc!.gscButNotTracked = ['unknown-query']
    const html = renderReportHtml(report)
    const gscBlock = html.split('id="gsc"')[1]?.split('</section>')[0] ?? ''
    expect(gscBlock).toContain('lonely-query')
    expect(gscBlock).toContain('unknown-query')
  })

  test('omits GSC × AEO crossover blocks when both lists are empty', () => {
    const report = richReport()
    report.gsc!.trackedButNoGsc = []
    report.gsc!.gscButNotTracked = []
    const html = renderReportHtml(report)
    const gscBlock = html.split('id="gsc"')[1]?.split('</section>')[0] ?? ''
    expect(gscBlock).not.toContain('AEO queries without search demand')
    expect(gscBlock).not.toContain('Search queries you should track')
  })

  test('renders × N count chip from the API-supplied instanceCount', () => {
    const report = richReport()
    report.insights = [
      { id: 'i1', type: 'gain', severity: 'low', title: 'New citation for "kw"', query: 'kw', provider: 'gemini', recommendation: null, createdAt: '2026-01-03T00:00:00Z', instanceCount: 3 },
    ]
    const html = renderReportHtml(report)
    const block = html.split('id="insights"')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('× 3')
    const occurrences = (block.match(/New citation for &quot;kw&quot;/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  test('falls back to client-side grouping when instanceCount is missing (legacy fixture)', () => {
    const report = richReport()
    // Older payloads that predate the dedup may omit instanceCount. The
    // renderer must still collapse duplicates so existing reports stay
    // readable until the consumer upgrades.
    report.insights = [
      { id: 'i1', type: 'gain', severity: 'low', title: 'Legacy', query: 'kw', provider: 'gemini', recommendation: null, createdAt: '2026-01-01T00:00:00Z' } as ProjectReportDto['insights'][number],
      { id: 'i2', type: 'gain', severity: 'low', title: 'Legacy', query: 'kw', provider: 'gemini', recommendation: null, createdAt: '2026-01-02T00:00:00Z' } as ProjectReportDto['insights'][number],
    ]
    const html = renderReportHtml(report)
    const block = html.split('id="insights"')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('× 2')
    expect((block.match(/Legacy/g) ?? []).length).toBe(1)
  })

  test('hides the citations trend chart and shows a baseline note when fewer than 4 points exist', () => {
    const report = richReport()
    report.citationsTrend = [
      { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 25, mentionedQueryCount: 1, providerRates: [] },
      { runId: 'r-2', date: '2026-04-02T00:00:00Z', citationRate: 1, citedQueryCount: 0, totalQueryCount: 4, mentionRate: 0, mentionedQueryCount: 0, providerRates: [] },
    ]
    const html = renderReportHtml(report)
    const block = html.split('id="citations-trend"')[1]?.split('</section>')[0] ?? ''
    expect(block.toLowerCase()).toContain('building baseline')
    expect(block).not.toContain('<svg')
  })

  test('renders the citations trend chart when at least 4 points exist', () => {
    const report = richReport()
    report.citationsTrend = [
      { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, citedQueryCount: 2, totalQueryCount: 4, mentionRate: 25, mentionedQueryCount: 1, providerRates: [] },
      { runId: 'r-2', date: '2026-04-02T00:00:00Z', citationRate: 60, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [] },
      { runId: 'r-3', date: '2026-04-03T00:00:00Z', citationRate: 55, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 40, mentionedQueryCount: 2, providerRates: [] },
      { runId: 'r-4', date: '2026-04-04T00:00:00Z', citationRate: 65, citedQueryCount: 3, totalQueryCount: 5, mentionRate: 60, mentionedQueryCount: 3, providerRates: [] },
    ]
    const html = renderReportHtml(report)
    const block = html.split('id="citations-trend"')[1]?.split('</section>')[0] ?? ''
    expect(block).toContain('<svg')
    expect(block.toLowerCase()).not.toContain('building baseline')
  })
})

describe('formatLandingPageHtml', () => {
  test('returns just the path span when there is no query string', () => {
    expect(formatLandingPageHtml('/blog/foo')).toBe('<span class="page-path">/blog/foo</span>')
  })

  test('falls back to / when input is empty', () => {
    expect(formatLandingPageHtml('')).toBe('<span class="page-path">/</span>')
  })

  test('preserves GA placeholders like (not set)', () => {
    expect(formatLandingPageHtml('(not set)')).toBe('<span class="page-path">(not set)</span>')
  })

  test('escapes HTML in the path', () => {
    const html = formatLandingPageHtml('/<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('labels Facebook Ads via fbclid', () => {
    const html = formatLandingPageHtml('/solar?fbclid=abc&h_ad_id=123')
    expect(html).toContain('Facebook Ad · 2 params')
    expect(html).toContain('title="/solar?fbclid=abc&amp;h_ad_id=123"')
  })

  test('labels Google Ads via gclid', () => {
    expect(formatLandingPageHtml('/x?gclid=abc')).toContain('Google Ad · 1 param')
  })

  test('labels Search Ads via hsa_* params', () => {
    const url = '/roofing?adgroupid=1&hsa_acc=2&hsa_cam=3&hsa_grp=4&hsa_ad=5&hsa_kw=roof&hsa_mt=e&hsa_net=adwords&hsa_ver=3'
    const html = formatLandingPageHtml(url)
    expect(html).toContain('Search Ad · 9 params')
    expect(html).toContain('<span class="page-path">/roofing</span>')
  })

  test('labels Microsoft Ads via msclkid', () => {
    expect(formatLandingPageHtml('/x?msclkid=abc')).toContain('Microsoft Ad')
  })

  test('labels TikTok Ads via ttclid', () => {
    expect(formatLandingPageHtml('/x?ttclid=abc')).toContain('TikTok Ad')
  })

  test('labels LinkedIn Ads via li_fat_id', () => {
    expect(formatLandingPageHtml('/x?li_fat_id=abc')).toContain('LinkedIn Ad')
  })

  test('reports utm source / medium when no ad-click id', () => {
    const html = formatLandingPageHtml('/x?utm_source=newsletter&utm_medium=email&utm_campaign=may')
    expect(html).toContain('newsletter / email · 3 params')
  })

  test('falls back to "tracking params" count when no recognised tag', () => {
    const html = formatLandingPageHtml('/x?foo=1&bar=2')
    expect(html).toContain('2 tracking params')
  })

  test('singular noun for one tracking param', () => {
    const html = formatLandingPageHtml('/x?foo=1')
    expect(html).toContain('1 tracking param')
    expect(html).not.toContain('1 tracking params')
  })
})

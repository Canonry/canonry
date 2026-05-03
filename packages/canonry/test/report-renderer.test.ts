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
      periodStart: null,
      periodEnd: null,
    },
    executiveSummary: {
      citationRate: 0,
      trend: 'unknown',
      keywordCount: 0,
      competitorCount: 0,
      providerCount: 0,
      gsc: null,
      ga: null,
      findings: [],
    },
    citationScorecard: { keywords: [], providers: [], matrix: [], providerRates: [] },
    competitorLandscape: { projectCitationCount: 0, competitors: [] },
    aiSourceOrigin: { categories: [], topDomains: [] },
    gsc: null,
    ga: null,
    socialReferrals: null,
    aiReferrals: null,
    indexingHealth: null,
    citationsTrend: [],
    insights: [],
    recommendedNextSteps: [],
    contentOpportunities: [],
    contentGaps: [],
    groundingSources: [],
  }
}

function richReport(): ProjectReportDto {
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
      periodStart: '2026-04-01T00:00:00Z',
      periodEnd: '2026-04-30T00:00:00Z',
    },
    executiveSummary: {
      citationRate: 65,
      trend: 'up',
      keywordCount: 5,
      competitorCount: 3,
      providerCount: 2,
      gsc: { clicks: 1000, impressions: 5000, ctr: 0.2, avgPosition: 4.5 },
      ga: { sessions: 12000, users: 9000, periodStart: '2026-04-01', periodEnd: '2026-04-30' },
      findings: [
        { title: 'Citation rate at 65%', detail: 'Up from previous run.', tone: 'positive' },
        { title: '1 critical regression', detail: 'Lost citation', tone: 'negative' },
      ],
    },
    citationScorecard: {
      keywords: ['aeo platform', 'answer engine'],
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
        { domain: 'rival.com', citationCount: 3, totalCount: 4, pressureLabel: 'High', citedKeywords: ['aeo platform'], sharePct: 0, theirCitedPages: [] },
        { domain: 'other.com', citationCount: 1, totalCount: 4, pressureLabel: 'Low', citedKeywords: ['answer engine'], sharePct: 0, theirCitedPages: [] },
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
      { runId: 'r-1', date: '2026-04-01T00:00:00Z', citationRate: 50, providerRates: [{ provider: 'gemini', citationRate: 50 }] },
      { runId: 'r-2', date: '2026-04-15T00:00:00Z', citationRate: 65, providerRates: [{ provider: 'gemini', citationRate: 65 }] },
    ],
    insights: [
      {
        id: 'i-1',
        type: 'regression',
        severity: 'critical',
        title: 'Lost citation on aeo platform',
        keyword: 'aeo platform',
        provider: 'gemini',
        recommendation: 'review-content — /landing — rival outranking',
        createdAt: '2026-04-30T00:00:00Z',
      },
    ],
    recommendedNextSteps: [
      { horizon: 'immediate', title: 'Resolve 1 critical regression', rationale: 'Lost citation on aeo platform.' },
    ],
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
      'recommended-next-steps',
    ]
    for (const section of expectedSections) {
      expect(html).toContain(`id="${section}"`)
    }
  })

  test('renders project display name in the document title', () => {
    const html = renderReportHtml(richReport())
    expect(html).toMatch(/<title>[^<]*Rich Project[^<]*<\/title>/)
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

  test('citation matrix shows cited vs not-cited cells', () => {
    const html = renderReportHtml(richReport())
    // Section content should include keywords from the matrix
    expect(html).toContain('aeo platform')
    expect(html).toContain('answer engine')
    // and provider names
    expect(html).toContain('gemini')
    expect(html).toContain('openai')
  })

  test('inline CSS allows long table cells to wrap', () => {
    const html = renderReportHtml(emptyReport())
    expect(html).toContain('overflow-wrap: anywhere')
    expect(html).toContain('word-break: break-word')
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

  test('auto-fills Recommended Next Steps from contentOpportunities when no severe insights', () => {
    const report = richReport()
    report.recommendedNextSteps = [] // simulate empty pipeline-derived steps
    const html = renderReportHtml(report)
    // The opportunity's query should now appear inside the next-steps section
    const stepsBlock = html.split('id="recommended-next-steps"')[1] ?? ''
    expect(stepsBlock).toContain('best aeo platform')
    expect(stepsBlock).not.toContain('No outstanding actions.')
  })

  test('preserves explicit recommendedNextSteps over auto-fill', () => {
    const html = renderReportHtml(richReport()) // has one explicit immediate step
    const stepsBlock = html.split('id="recommended-next-steps"')[1] ?? ''
    expect(stepsBlock).toContain('Resolve 1 critical regression')
    // Auto-fill content (the opportunity query) should NOT appear inside the steps block
    expect(stepsBlock).not.toContain('Refresh the page targeting')
  })

  test('renders SOV % column in competitor landscape', () => {
    const report = richReport()
    report.competitorLandscape.competitors[0]!.sharePct = 75
    report.competitorLandscape.competitors[1]!.sharePct = 25
    const html = renderReportHtml(report)
    const landscape = html.split('id="competitor-landscape"')[1]?.split('</section>')[0] ?? ''
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

  test('renders GSC × AEO crossover companion blocks when non-empty', () => {
    const report = richReport()
    report.gsc!.trackedButNoGsc = ['lonely-keyword']
    report.gsc!.gscButNotTracked = ['unknown-query']
    const html = renderReportHtml(report)
    const gscBlock = html.split('id="gsc"')[1]?.split('</section>')[0] ?? ''
    expect(gscBlock).toContain('lonely-keyword')
    expect(gscBlock).toContain('unknown-query')
  })

  test('omits GSC × AEO crossover blocks when both lists are empty', () => {
    const report = richReport()
    report.gsc!.trackedButNoGsc = []
    report.gsc!.gscButNotTracked = []
    const html = renderReportHtml(report)
    const gscBlock = html.split('id="gsc"')[1]?.split('</section>')[0] ?? ''
    expect(gscBlock).not.toContain('AEO keywords without search demand')
    expect(gscBlock).not.toContain('Search queries you should track')
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

import { describe, expect, test } from 'vitest'
import type { ProjectReportDto } from '@ainyc/canonry-contracts'
import { renderReportHtml } from '../src/report-renderer.js'

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
        { domain: 'rival.com', citationCount: 3, totalCount: 4, pressureLabel: 'High', citedKeywords: ['aeo platform'] },
        { domain: 'other.com', citationCount: 1, totalCount: 4, pressureLabel: 'Low', citedKeywords: ['answer engine'] },
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
})

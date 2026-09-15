import { describe, expect, test } from 'vitest'
import type { ProjectReportDto, ReportAudience } from '../src/report.js'
import {
  REPORT_HEADER_COPY,
  REPORT_SECTION_COPY,
  ReportSectionIds,
  reportActionConfidenceBadge,
  reportActionHorizonBadge,
  reportAudienceActions,
  reportBarChartLabel,
  reportCitationsTrendBaseline,
  reportCitedUrlCount,
  reportClientCitedSubtitle,
  reportClientClicksNoun,
  reportClientConfidenceLabel,
  reportClientHeroSentence,
  reportClientHorizonLabel,
  reportClientIndexedPages,
  reportClientIndexingTone,
  reportClientMentionedSubtitle,
  reportClientNotIndexedTail,
  reportClientProvidersSubtitle,
  reportClientQueriesSubtitle,
  reportClientSearchCount,
  reportClientSourceCount,
  reportClientTrendCopy,
  reportCompactList,
  reportCompetitorMentionCopy,
  reportCrawlerTrustSummary,
  reportDeltaArrow,
  reportDirectionTone,
  reportExecutiveHeadline,
  reportGaIntro,
  reportGscDateRange,
  reportGscIntro,
  reportHeaderMarketLabel,
  reportHeaderPeriodLabel,
  reportIndexingIntro,
  reportIndexingLegendLabel,
  reportInstanceCountLabel,
  reportLineChartLabel,
  reportLocationDisplay,
  reportMarketScope,
  reportMentionScopeLabel,
  reportMissRateLabel,
  reportMovementChangeCopy,
  reportOpportunityActionLine,
  reportProviderDisplayName,
  reportProviderRateLabel,
  reportRateDeltaCopy,
  reportReferralRedirectNote,
  reportSectionIdSchema,
  reportSectionOrder,
  reportServerActivityAgencyOperatorHeaders,
  reportServerActivityAgencyTiles,
  reportServerActivityClientOperatorHeaders,
  reportServerActivityCrawledPathsNote,
  reportServerActivityHeading,
  reportPriorWindowLabel,
  reportServerActivityTrendTitle,
  reportServerActivityWindowLabel,
  reportShareBarShareLabel,
  reportSourceCategoryShareLabel,
  reportSourceOriginHeadline,
  reportTrendProviderRates,
  reportTruncatedList,
} from '../src/report-sections.js'
import { advancedReport, emptyReport, fullReport, richReport, simpleVisibility } from './fixtures/report-dto.js'

describe('reportSectionIdSchema', () => {
  test('ReportSectionIds is derived from the schema', () => {
    expect(Object.values(ReportSectionIds)).toEqual(reportSectionIdSchema.options)
    expect(ReportSectionIds['share-of-voice']).toBe('share-of-voice')
  })

  test('every section except share of voice carries copy', () => {
    const withCopy = reportSectionIdSchema.options.filter(id => id !== ReportSectionIds['share-of-voice'])
    expect(Object.keys(REPORT_SECTION_COPY).sort()).toEqual([...withCopy].sort())
  })
})

describe('reportSectionOrder', () => {
  const CLIENT = ['client-summary', 'share-of-voice', 'whats-changed', 'server-activity', 'client-action-plan', 'client-evidence-summary']
  const AGENCY = [
    'executive-summary', 'share-of-voice', 'whats-changed', 'agency-action-plan', 'agency-diagnostics', 'citation-scorecard',
    'competitor-landscape', 'ai-source-origin', 'gsc', 'ga', 'social-referrals', 'ai-referrals', 'server-activity',
    'indexing-health', 'citations-trend', 'insights', 'content-opportunities', 'content-gaps', 'recommended-next-steps',
  ]
  const without = (order: readonly string[], ...ids: string[]) => order.filter(id => !ids.includes(id))
  const shaped = (change: (report: ProjectReportDto) => void, build: () => ProjectReportDto = richReport) => {
    const report = build()
    change(report)
    return report
  }

  const cases: Array<[string, ReportAudience, ProjectReportDto, string[]]> = [
    ['client, legacy, source connected', 'client', richReport(), CLIENT],
    ['client, legacy, source connected with no data', 'client', shaped(r => { r.serverActivity = { ...r.serverActivity!, hasData: false } }), CLIENT],
    ['client, legacy, no source', 'client', shaped(r => { r.serverActivity = null }), without(CLIENT, 'server-activity')],
    ['client, empty report', 'client', emptyReport(), without(CLIENT, 'server-activity')],
    ['client, simple visibility', 'client', shaped(r => { r.visibility = simpleVisibility() }), without(CLIENT, 'whats-changed')],
    ['client, advanced visibility', 'client', advancedReport(), without(CLIENT, 'share-of-voice', 'whats-changed')],
    ['client, advanced visibility, no source', 'client', shaped(r => { r.serverActivity = null }, advancedReport), ['client-summary', 'client-action-plan', 'client-evidence-summary']],
    ['client, no opportunities or gaps', 'client', shaped(r => { r.contentOpportunities = []; r.contentGaps = [] }), CLIENT],
    ['agency, legacy, source connected', 'agency', richReport(), AGENCY],
    ['agency, legacy, source connected with no data', 'agency', shaped(r => { r.serverActivity = { ...r.serverActivity!, hasData: false } }), AGENCY],
    ['agency, legacy, no source keeps the connect prompt', 'agency', shaped(r => { r.serverActivity = null }), AGENCY],
    ['agency, empty report', 'agency', emptyReport(), without(AGENCY, 'content-opportunities', 'content-gaps')],
    ['agency, no opportunities', 'agency', shaped(r => { r.contentOpportunities = [] }), without(AGENCY, 'content-opportunities')],
    ['agency, no gaps', 'agency', shaped(r => { r.contentGaps = [] }), without(AGENCY, 'content-gaps')],
    ['agency, simple visibility', 'agency', shaped(r => { r.visibility = simpleVisibility() }), ['client-summary', ...without(AGENCY, 'executive-summary', 'whats-changed')]],
    ['agency, advanced visibility', 'agency', advancedReport(), [
      'client-summary', 'agency-action-plan', 'ai-source-origin', 'gsc', 'ga', 'social-referrals', 'ai-referrals',
      'server-activity', 'indexing-health', 'insights', 'content-opportunities', 'content-gaps', 'recommended-next-steps',
    ]],
    [
      'agency, opportunities that all collapse into the report market',
      'agency',
      shaped(r => {
        const [first] = r.contentOpportunities
        r.contentOpportunities = [{ ...first!, query: 'michigan' }, { ...first!, targetRef: 'rich:create:in-michigan', query: 'in michigan' }]
      }),
      without(AGENCY, 'content-opportunities'),
    ],
  ]

  test.each(cases)('%s', (_name, audience, report, expected) => {
    expect(reportSectionOrder(report, audience)).toEqual(expected)
  })
})

describe('shared report helpers', () => {
  test('reportProviderDisplayName names known engines and capitalizes the rest', () => {
    expect(['gemini', 'openai', 'claude', 'perplexity', 'local', 'cdp:chatgpt', 'mistral', ''].map(reportProviderDisplayName))
      .toEqual(['Gemini', 'ChatGPT', 'Claude', 'Perplexity', 'Local model', 'ChatGPT (browser)', 'Mistral', ''])
  })

  test('client horizon and confidence labels', () => {
    expect((['immediate', 'short-term', 'medium-term'] as const).map(reportClientHorizonLabel)).toEqual(['Do now', 'This month', 'Next quarter'])
    expect((['high', 'medium', 'low'] as const).map(reportClientConfidenceLabel)).toEqual(['Strong evidence', 'Some evidence', 'Worth trying'])
  })

  test('reportLocationDisplay joins whichever place parts exist', () => {
    expect(reportLocationDisplay(richReport().meta.location)).toBe('michigan (Detroit, Michigan, US)')
    expect(reportLocationDisplay({ label: 'florida', city: '', region: '', country: '', otherConfiguredLabels: [] })).toBe('florida')
    expect(reportLocationDisplay({ label: 'west', city: '', region: 'CA', country: 'US', otherConfiguredLabels: [] })).toBe('west (CA, US)')
    expect(reportLocationDisplay(null)).toBe('')
  })

  test('header market and period labels', () => {
    expect(REPORT_HEADER_COPY.eyebrow).toBe('AI Visibility Report')
    expect(reportHeaderMarketLabel(richReport().meta.location)).toBe('Market: michigan (Detroit, Michigan, US)')
    expect(reportHeaderMarketLabel(null)).toBe('No market set')
    expect(reportHeaderPeriodLabel(7)).toBe('Last 7 days')
  })

  test('list, count and chart label formats', () => {
    expect(reportCompactList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, +2 more')
    expect(reportCompactList(['a', 'b', 'c', 'd', 'e', 'f'], 5)).toBe('a, b, c, d, e, +1 more')
    expect(reportCompactList(['a', 'b'], 3)).toBe('a, b')
    expect(reportCompactList([], 3)).toBe('')
    expect(reportTruncatedList(['a', 'b', 'c', 'd', 'e', 'f'], 5)).toBe('a, b, c, d, e…')
    expect(reportTruncatedList(['a', 'b', 'c', 'd', 'e'], 5)).toBe('a, b, c, d, e')
    expect(reportInstanceCountLabel(2)).toBe('× 2')
    expect(reportBarChartLabel('Provider citation rate')).toBe('Provider citation rate bar chart')
    expect(reportLineChartLabel('Clicks over time')).toBe('Clicks over time line chart')
  })

  test('delta arrows, tones and change copy', () => {
    expect((['up', 'down', 'flat'] as const).map(reportDeltaArrow)).toEqual(['↑', '↓', '→'])
    expect((['up', 'down', 'flat'] as const).map(reportDirectionTone)).toEqual(['positive', 'negative', 'neutral'])
    expect(reportRateDeltaCopy({ current: 65, prior: 50, deltaAbs: 15, deltaPct: 30, direction: 'up' }, '%')).toBe('+15.0% vs 50%')
    expect(reportRateDeltaCopy({ current: 40, prior: 45, deltaAbs: -5, deltaPct: -11, direction: 'down' }, '%')).toBe('-5.0% vs 45%')
    expect(reportRateDeltaCopy({ current: 40, prior: 40, deltaAbs: 0, deltaPct: 0, direction: 'flat' }, '%')).toBe('0.0% vs 40%')
    // Counts route through the shared smart-% rule: a small base shows a rounded raw delta, a large one a percentage.
    expect(reportRateDeltaCopy({ current: 3.7, prior: 3.3, deltaAbs: 0.33333333333333304, deltaPct: 10, direction: 'flat', window: 3 }, 'count')).toBe('+0.3 vs 3.3')
    expect(reportRateDeltaCopy({ current: 40, prior: 30, deltaAbs: 10, deltaPct: 33, direction: 'up' }, 'count')).toBe('+33% vs prior')
    expect(reportMovementChangeCopy({ provider: 'gemini', prior: 50, current: 65, deltaAbs: 15, direction: 'up' })).toBe('+15.0% ↑')
    expect(reportMovementChangeCopy({ provider: 'openai', prior: 50, current: 46.5, deltaAbs: -3.5, direction: 'down' })).toBe('-3.5% ↓')
  })
})

describe('client summary copy', () => {
  test('hero sentence agrees with the query count and falls back before the first check', () => {
    expect(reportClientHeroSentence(5, 2)).toBe('When customers asked AI 5 queries about your industry, AI mentioned you in 2 of those queries.')
    expect(reportClientHeroSentence(1, 1)).toBe('When customers asked AI 1 query about your industry, AI mentioned you in 1 of them.')
    expect(reportClientHeroSentence(0, 0)).toBe(REPORT_SECTION_COPY['client-summary'].heroEmpty)
    expect(REPORT_SECTION_COPY['client-summary'].heroEmpty).toBe('No AI check has been run yet. Run a check to see how AI tools answer customer queries about your business.')
  })

  test('tile subtitles', () => {
    expect(reportClientMentionedSubtitle(2, 5)).toBe('Says your name in 2 of 5 queries')
    expect(reportClientMentionedSubtitle(1, 1)).toBe('Says your name in 1 of 1 query')
    expect(reportClientMentionedSubtitle(0, 0)).toBe('No data yet')
    expect(reportClientCitedSubtitle(3, 5)).toBe('Cites your site as a source in 3 of 5 queries')
    expect(reportClientCitedSubtitle(null, 0)).toBe('No data yet')
    expect(reportClientProvidersSubtitle(['gemini', 'openai'], 5)).toBe('Gemini, ChatGPT')
    expect(reportClientProvidersSubtitle([], 1)).toBe('1 query tested')
    expect(reportClientProvidersSubtitle([], 1500)).toBe('1.5K queries tested')
    expect(reportClientQueriesSubtitle(3)).toBe('These are the 3 queries we asked every AI tool. The numbers above measure how often you came up.')
    expect(reportClientQueriesSubtitle(1)).toBe('These are the 1 query we asked every AI tool. The numbers above measure how often you came up.')
  })

  test('trend copy names rolling averages and single checks differently', () => {
    expect(reportClientTrendCopy(null)).toBeNull()
    expect(reportClientTrendCopy({ current: 65, prior: 50, deltaAbs: 15, deltaPct: 30, direction: 'up', window: 3 }))
      .toEqual({ text: 'Up 15.0 points vs prior 3 checks (avg 50%)', tone: 'positive', arrow: '↑' })
    expect(reportClientTrendCopy({ current: 40, prior: 45, deltaAbs: -5, deltaPct: -11, direction: 'down' }))
      .toEqual({ text: 'Down 5.0 points since last check (was 45%)', tone: 'negative', arrow: '↓' })
    expect(reportClientTrendCopy({ current: 40, prior: 40, deltaAbs: 0, deltaPct: 0, direction: 'flat', window: 1 }))
      .toEqual({ text: 'Holding steady since last check (was 40%)', tone: 'neutral', arrow: '→' })
  })
})

describe('action plan copy', () => {
  test('audience actions: the client shortlist, agency priorities, or the audience-filtered plan, deduplicated', () => {
    const report = richReport()
    expect(reportAudienceActions(report, 'client').map(action => action.title)).toEqual(['Create content for "best aeo platform"'])
    expect(reportAudienceActions(report, 'agency').map(action => action.title)).toEqual(['Create content for "best aeo platform"', 'Diagnose zero-citation providers'])

    const clientOnly = { ...report.actionPlan[1]!, audience: 'client' as const, title: 'Client-only follow-up' }
    report.agencyDiagnostics.priorities = []
    report.actionPlan = [...report.actionPlan, clientOnly]
    expect(reportAudienceActions(report, 'agency').map(action => action.title)).toEqual(['Create content for "best aeo platform"', 'Diagnose zero-citation providers'])

    const base = { ...report.actionPlan[0]!, title: 'Create content for "polyurea roof coating"', successMetric: 'Cited for "polyurea roof coating".' }
    report.agencyDiagnostics.priorities = [base, { ...base, priority: 21, title: 'Create content for "polyurea roof coating michigan"' }]
    expect(reportAudienceActions(report, 'agency').map(action => action.title)).toEqual(['Create content for "polyurea roof coating"'])
  })

  test('horizon and confidence badges differ by audience', () => {
    expect(reportActionHorizonBadge('client', 'immediate')).toBe('Do now')
    expect(reportActionHorizonBadge('agency', 'short-term')).toBe('Short term')
    expect(reportActionConfidenceBadge('client', 'high')).toBe('Strong evidence')
    expect(reportActionConfidenceBadge('agency', 'medium')).toBe('Medium confidence')
  })

  test('each audience keeps its own empty state and rank tooltip', () => {
    expect(REPORT_SECTION_COPY['client-action-plan'].empty).toBe('No recommendations yet — run an AI check to populate this.')
    expect(REPORT_SECTION_COPY['agency-action-plan'].empty).toBe('No prioritized actions yet.')
    expect(REPORT_SECTION_COPY['client-action-plan'].rankTitle).toBe('Priority — 1 will move the needle fastest')
    expect(REPORT_SECTION_COPY['agency-action-plan'].rankTitle).toBe('Impact rank — 1 is the highest-leverage action')
  })
})

describe("what's changed copy", () => {
  test('client and agency headings and empty states', () => {
    const copy = REPORT_SECTION_COPY['whats-changed']
    expect([copy.client.eyebrow, copy.client.title, copy.client.empty]).toEqual(['Since last check', "What's different since last check", 'No comparison yet — trends will appear after a few more checks.'])
    expect([copy.agency.eyebrow, copy.agency.title, copy.agency.empty]).toEqual(['Section 2', "What's Changed", 'Trends will appear after a few more checks.'])
    expect(copy.client.insightHeaders).toEqual(['What changed', 'Customer query', 'AI tool'])
    expect(copy.agency.insightHeaders).toEqual(['Severity', 'Title', 'Query', 'Provider'])
  })
})

describe('client evidence copy', () => {
  test('counts, nouns and the indexing tone thresholds', () => {
    expect(reportClientSourceCount(4)).toBe('4×')
    expect(reportClientSourceCount(1200)).toBe('1.2K×')
    expect(reportClientIndexedPages(80, 100)).toBe('80 of 100 pages indexed')
    expect(reportClientNotIndexedTail(20)).toBe('pages are not indexed yet.')
    expect(reportClientNotIndexedTail(1)).toBe('page is not indexed yet.')
    expect([reportClientClicksNoun(1), reportClientClicksNoun(1000)]).toEqual(['click', 'clicks'])
    expect([reportClientSearchCount(3000), reportClientSearchCount(1)]).toEqual(['3.0K searches', '1 search'])
    expect([90, 89.9, 70, 69.9, 0].map(reportClientIndexingTone)).toEqual(['positive', 'caution', 'caution', 'negative', 'negative'])
  })
})

describe('report slice S1: agency overview copy', () => {
  test('executive headline for a populated report', () => {
    expect(reportExecutiveHeadline(richReport())).toEqual({
      trendLabel: '↑ Up',
      trendTone: 'positive',
      title: '3 of 5 tracked queries cite Rich Project',
      subtitle: '65% citation coverage and 40% mention coverage across 2 providers.',
      citedFragment: '3/5 queries cited',
      mentionedFragment: '2/5 queries mentioned',
      prioritizedActionCount: 2,
      providerCountLabel: '2 providers',
      competitorCountLabel: '3 competitors tracked',
      gscDelta: '5.0K imp · 20.0% CTR · Apr 1, 2026 → Apr 30, 2026',
      gaDelta: '9.0K users · Apr 1, 2026 → Apr 30, 2026',
    })
  })

  test('executive headline before any data', () => {
    expect(reportExecutiveHeadline(emptyReport())).toEqual({
      trendLabel: '—',
      trendTone: 'neutral',
      title: 'No AI citation data yet',
      subtitle: 'Run a check to populate the first citation and mention baseline.',
      citedFragment: 'no queries',
      mentionedFragment: 'no queries',
      prioritizedActionCount: 0,
      providerCountLabel: '0 providers',
      competitorCountLabel: '0 competitors tracked',
      gscDelta: null,
      gaDelta: null,
    })
  })

  test('executive headline singulars, falling trend, and the action-plan fallback', () => {
    const report = richReport()
    Object.assign(report.executiveSummary, { totalQueryCount: 1, citedQueryCount: 1, mentionedQueryCount: 0, providerCount: 1, competitorCount: 1, trend: 'down' })
    report.agencyDiagnostics.priorities = []
    report.executiveSummary.gsc = { ...report.executiveSummary.gsc!, periodStart: '', periodEnd: '' }
    report.gsc = { ...report.gsc!, periodStart: '', periodEnd: '', trend: [] }
    const headline = reportExecutiveHeadline(report)
    expect(headline).toMatchObject({
      trendLabel: '↓ Down',
      trendTone: 'negative',
      title: '1 of 1 tracked query cite Rich Project',
      subtitle: '65% citation coverage and 40% mention coverage across 1 provider.',
      citedFragment: '1/1 query cited',
      mentionedFragment: '0/1 query mentioned',
      prioritizedActionCount: 2,
      providerCountLabel: '1 provider',
      competitorCountLabel: '1 competitor tracked',
      gscDelta: '5.0K imp · 20.0% CTR',
    })
    report.executiveSummary.trend = 'flat'
    expect(reportExecutiveHeadline(report)).toMatchObject({ trendLabel: '→ Flat', trendTone: 'neutral' })
  })

  test('market scope for a scoped report with one other market', () => {
    expect(reportMarketScope(richReport())).toEqual({
      currentValue: 'michigan (Detroit, Michigan, US)',
      notIncludedValue: 'florida',
      notIncludedCopy: '1 configured market still needs a matching check before cross-market recommendations.',
      providerValue: '2',
      providerCopy: '2 providers received the market context.',
      weakProviders: null,
    })
  })

  test('market scope flags providers with weak location handling', () => {
    expect(reportMarketScope(fullReport())).toMatchObject({
      providerValue: '3',
      providerCopy: '1 provider need a closer location check.',
      weakProviders: 'cdp:chatgpt',
    })
  })

  test('market scope wording without a market, for a single market, and for long lists', () => {
    expect(reportMarketScope(emptyReport())).toBeNull()

    const national = emptyReport()
    national.meta.providerLocationHandling = [{ provider: 'gemini', treatment: 'prompt', description: '' }]
    expect(reportMarketScope(national)).toEqual({
      currentValue: 'No market set',
      notIncludedValue: 'None',
      notIncludedCopy: 'No geographic hint was attached to this check; read findings as default-market or national results.',
      providerValue: '1',
      providerCopy: '1 provider received the market context.',
      weakProviders: null,
    })

    const single = emptyReport()
    single.meta.location = { label: 'florida', city: '', region: '', country: '', otherConfiguredLabels: [] }
    expect(reportMarketScope(single)).toEqual({
      currentValue: 'florida',
      notIncludedValue: 'None',
      notIncludedCopy: 'Single-market report; findings can be read as the current market view.',
      providerValue: '—',
      providerCopy: 'No provider-level location metadata is available for this report.',
      weakProviders: null,
    })

    const wide = richReport()
    wide.meta.location!.otherConfiguredLabels = ['a', 'b', 'c', 'd', 'e']
    wide.meta.providerLocationHandling = ['p1', 'p2', 'p3', 'p4', 'p5'].map(provider => ({ provider, treatment: 'ignored' as const, description: '' }))
    expect(reportMarketScope(wide)).toMatchObject({
      notIncludedValue: 'a, b, c, d, +1 more',
      notIncludedCopy: '5 configured markets still need a matching check before cross-market recommendations.',
      providerCopy: '5 providers need a closer location check.',
      weakProviders: 'p1, p2, p3, p4, +1 more',
    })
  })
})

describe('report slice S2: competitive evidence copy', () => {
  test('provider rate label', () => {
    expect(reportProviderRateLabel({ citationRate: 50, citedCount: 1, totalCount: 2 })).toBe('50% (1/2)')
  })

  test('mention scope label, including a scope from an older server', () => {
    expect(reportMentionScopeLabel('non-brand')).toBe('non-brand queries')
    expect(reportMentionScopeLabel('pooled')).toBe('pooled queries · classification unavailable')
    expect(reportMentionScopeLabel('legacy' as ProjectReportDto['mentionLandscape']['scope'])).toBe('pooled queries · classification unavailable')
  })

  test('competitor mention copy for non-brand and pooled scopes', () => {
    expect(reportCompetitorMentionCopy(richReport().mentionLandscape)).toEqual({
      scopeLabel: 'non-brand queries',
      mentionsHeader: 'Mentions (non-brand queries)',
      mentionsTooltip: 'Mentions on non-brand queries. Branded queries are counted separately — the client is named on nearly all of them and a competitor cannot be, so pooling the two would rank the client on its own brand recall.',
      mentionsChartTitle: 'Mentions per domain · non-brand queries',
      mentionShareUnavailable: 'Mention share unavailable for non-brand queries: no tracked brand was named, so the denominator is 0.',
      brandedNote: "Branded queries contain the client's own name. The client is named on nearly all of them and a competitor structurally cannot be, so these are kept out of the competitive figure above. Read them as brand recall: 2 of 2 branded answers named the client.",
    })
    const pooled = { ...richReport().mentionLandscape, scope: 'pooled' as const }
    expect(reportCompetitorMentionCopy(pooled).mentionsTooltip).toBe('Mentions on pooled queries · classification unavailable. The project has no usable brand identity for a branded/non-brand split, so all tracked queries remain pooled and this is not a competitive category read.')
    const legacy = { ...richReport().mentionLandscape, branded: undefined } as unknown as ProjectReportDto['mentionLandscape']
    expect(reportCompetitorMentionCopy(legacy).brandedNote).toMatch(/Read them as brand recall: 0 of 0 branded answers named the client\.$/)
  })

  test('cited URL count and source origin headline', () => {
    expect([reportCitedUrlCount(1), reportCitedUrlCount(2)]).toEqual(['1 cited URL', '2 cited URLs'])
    expect(reportSourceOriginHeadline(fullReport().aiSourceOrigin.categories)).toEqual({ share: '20%', detail: 'of citations went to tracked competitors (2 of 10).' })
    expect(reportSourceOriginHeadline(richReport().aiSourceOrigin.categories)).toBeNull()
    expect(reportSourceCategoryShareLabel(20)).toBe('(20%)')
  })
})

describe('report slice S3: search and traffic copy', () => {
  test('GSC date range prefers the summary window, then the section window, then the trend', () => {
    expect(reportGscDateRange(richReport())).toBe('Apr 1, 2026 → Apr 30, 2026')
    const sectionWindow = richReport()
    sectionWindow.executiveSummary.gsc = null
    sectionWindow.gsc = { ...sectionWindow.gsc!, periodStart: '2026-03-01', periodEnd: '2026-03-31' }
    expect(reportGscDateRange(sectionWindow)).toBe('Mar 1, 2026 → Mar 31, 2026')
    const trendOnly = richReport()
    trendOnly.executiveSummary.gsc = null
    trendOnly.gsc = { ...trendOnly.gsc!, periodStart: '', periodEnd: '' }
    expect(reportGscDateRange(trendOnly)).toBe('Apr 1, 2026 → Apr 2, 2026')
    expect(reportGscDateRange(emptyReport())).toBe('')
  })

  test('GSC and GA intros', () => {
    expect(reportGscIntro(richReport())).toBe('Search demand signals to compare against AI visibility for Apr 1, 2026 → Apr 30, 2026.')
    expect(reportGscIntro(emptyReport())).toBe('Search demand signals to compare against AI visibility.')
    expect(reportGaIntro(richReport().ga!)).toBe('Site traffic from Apr 1, 2026 to Apr 30, 2026.')
  })

  test('share bar share label', () => {
    expect(reportShareBarShareLabel('clicks', 80)).toBe('clicks · 80%')
  })
})

describe('report slice S4: server-side, indexing and trend copy', () => {
  test('server activity heading per audience and data state', () => {
    expect(reportServerActivityHeading('client', true, 7)).toEqual({
      id: 'server-activity',
      eyebrow: 'AI engine attention',
      title: 'AI Visibility — Server-Side',
      intro: 'What AI engines actually do in your server logs over the last 7 days — the other half of citations.',
    })
    expect(reportServerActivityHeading('client', false, 30).intro).toBe('Live telemetry from your server logs.')
    const agencyIntro = 'What AI engines actually do in your server logs — direct evidence, complementary to citations (which measure what they say).'
    expect(reportServerActivityHeading('agency', true, 7)).toEqual({ id: 'server-activity', eyebrow: 'Section 10', title: 'AI Visibility — Server-Side', intro: agencyIntro })
    expect(reportServerActivityHeading('agency', false, 90).intro).toBe(agencyIntro)
  })

  test('server activity window labels, headers and notes', () => {
    expect(reportServerActivityWindowLabel(7)).toBe('7d')
    expect(reportPriorWindowLabel(7)).toBe('vs prior 7 days')
    expect(reportPriorWindowLabel(14)).toBe('vs prior 14 days')
    expect(reportServerActivityClientOperatorHeaders(7)).toEqual(['AI tool', 'Bot requests (7d)', 'User fetches (7d)', 'Referral sessions'])
    expect(reportServerActivityAgencyTiles(7)).toEqual({
      verified: 'Verified crawler hits (7d)',
      unverified: 'Unverified crawler hits (7d)',
      userFetches: 'AI user-fetch hits (7d)',
      referralSessions: 'AI-referral sessions (7d)',
    })
    expect(reportServerActivityAgencyOperatorHeaders(14)).toEqual(['Operator', 'Verified hits', 'Unverified', 'User fetches', 'Referral sessions', '14d delta'])
    expect(reportServerActivityTrendTitle(7)).toBe('Verified crawler hits over time (last 7 days)')
    expect(reportServerActivityCrawledPathsNote(7)).toBe('Pages AI bots fetched most often (verified only, last 7d).')
    expect(reportCrawlerTrustSummary(234, 15)).toBe('234 verified · 15 unverified')
    expect(reportCrawlerTrustSummary(1500, 0)).toBe('1.5K verified · 0 unverified')
    expect(reportReferralRedirectNote(120)).toBe('120 blocked by redirects')
    expect(reportReferralRedirectNote(0)).toBe('')
  })

  test('indexing intro names Google, and Bing otherwise', () => {
    expect(reportIndexingIntro('google')).toBe('Pages absent from Google are harder for AI engines to retrieve.')
    expect(reportIndexingIntro('bing')).toBe('Pages absent from Bing are harder for AI engines to retrieve.')
    expect(reportIndexingIntro(null)).toBe('Pages absent from Bing are harder for AI engines to retrieve.')
    expect(reportIndexingLegendLabel('Indexed', 80)).toBe('Indexed: 80')
  })

  test('citations trend baseline and per-engine rates', () => {
    expect(reportCitationsTrendBaseline(2)).toBe('Building baseline (2 of 4 checks completed). Trend will appear once more checks are recorded.')
    expect(reportTrendProviderRates([{ provider: 'gemini', citationRate: 65 }, { provider: 'openai', citationRate: 50 }])).toBe('gemini: 65% · openai: 50%')
    expect(reportTrendProviderRates([])).toBe('')
  })
})

describe('report slice S5: insights and content copy', () => {
  test('opportunity action line and miss rate', () => {
    expect(reportOpportunityActionLine({ action: 'create', actionConfidence: 'high' })).toBe('Create · High confidence')
    expect(reportOpportunityActionLine({ action: 'add-schema', actionConfidence: 'low' })).toBe('Add schema · Low confidence')
    expect([0.5, 1, 0, 0.125].map(reportMissRateLabel)).toEqual(['50%', '100%', '0%', '13%'])
  })
})

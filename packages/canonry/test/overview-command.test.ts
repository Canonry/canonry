import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectOverviewDto, ProjectOverviewWhatChangedDto } from '@canonry/canonry-contracts'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { sentimentFixtureSummary } from '../../contracts/test/fixtures/sentiment.js'
import { showOverview } from '../src/commands/overview.js'
import * as clientModule from '../src/client.js'
import { createCanonryMcpServerWithCatalog } from '../src/mcp/server.js'
import { invokeCliRead, prepareCliReadFixture } from './cli-read-fixture.js'
import { invokeCli } from './cli-test-utils.js'

function makeSentiment() {
  const { state, reason, provisional, coverage, score, selection } = sentimentFixtureSummary
  const common = { state, reason, provisional, coverage, score, runIds: ['run-fixture'] }
  return {
    configured: true,
    branded: { ...common, selection },
    nonBrand: { ...common, selection: { ...selection, queryClass: 'non-brand' as const } },
    overall: { ...common, queryClass: 'all' as const },
  }
}

function makeOverview(overrides: Partial<ProjectOverviewDto> = {}): ProjectOverviewDto {
  return {
    project: {
      id: 'p-1',
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'demo.example.com',
      ownedDomains: [],
      aliases: [],
      qualifiedAliases: [],
      providers: [],
      providerModels: {},
      providerDispatchModes: {},
      measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      locations: [],
      defaultLocation: null,
      autoExtractBacklinks: false,
      configSource: 'cli',
      configRevision: 1,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
    latestRun: { run: null, totalRuns: 0 },
    mentionCoverage: {
      selection: {
        mode: 'simple', queryClass: 'all', scope: { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
        provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: null,
        run: { id: 'sweep', explicit: false }, provenance: { kind: 'frozen-simple', definitionRevision: null },
        measurement: { state: 'measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-01T00:00:00Z' },
        availability: { state: 'available' },
      },
      populations: [
        { queryClass: 'non-brand', queryCount: 2, answerCount: 2, mentionCoverage: { numerator: 0, denominator: 2, rate: 0 }, citationCoverage: { numerator: 1, denominator: 2, rate: 0.5 } },
        { queryClass: 'branded', queryCount: 1, answerCount: 1, mentionCoverage: { numerator: 1, denominator: 1, rate: 1 }, citationCoverage: { numerator: 0, denominator: 1, rate: 0 } },
      ],
    },
    health: null,
    topInsights: [],
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0, citationNotMeasuredQueries: 0, mentionedQueries: 0, notMentionedQueries: 0, mentionRate: 0 },
    providers: [],
    transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
    scores: {
      // A ratio gauge's value arrives formatted by the API (formatPercent), a count gauge's as the count.
      mention: { label: 'Mention Coverage', value: '75.0%', delta: '6 of 8 queries mentioned', tone: 'positive', description: '', trend: [], progress: 75 },
      visibility: { label: 'Citation Coverage', value: '50.0%', delta: '4 of 8 queries cited', tone: 'caution', description: '', trend: [], progress: 50 },
      mentionShare: {
        label: 'Mention Share',
        value: '60.0%',
        delta: '6 of 10 brand mentions',
        tone: 'positive',
        description: '',
        trend: [],
        progress: 60,
        scope: 'non-brand',
        branded: { projectMentionSnapshots: 1, competitorMentionSnapshots: 1, combinedMentionSnapshots: 2, perCompetitor: [], ranking: [], snapshotsWithAnswerText: 2, snapshotsTotal: 2, score: 50 },
        breakdown: {
          projectMentionSnapshots: 6,
          competitorMentionSnapshots: 4,
          combinedMentionSnapshots: 10,
          perCompetitor: [
            { domain: 'rival-a.com', mentionSnapshots: 3, shareOfCompetitiveTotal: 75 },
            { domain: 'rival-b.com', mentionSnapshots: 1, shareOfCompetitiveTotal: 25 },
          ],
          ranking: [
            { kind: 'project', domain: null, mentionSnapshots: 6, share: 0.6 },
            { kind: 'competitor', domain: 'rival-a.com', mentionSnapshots: 3, share: 0.3 },
            { kind: 'competitor', domain: 'rival-b.com', mentionSnapshots: 1, share: 0.1 },
          ],
          snapshotsWithAnswerText: 8,
          snapshotsTotal: 10,
          score: 60,
        },
      },
      gapQueries: { label: 'Citation Gaps', value: '2', delta: '2 of 8 queries', tone: 'caution', description: '', trend: [] },
      mentionGaps: { label: 'Mention Gaps', value: '1', delta: '1 of 8 queries', tone: 'caution', description: '', trend: [] },
      indexCoverage: { label: 'Index Coverage', value: 'No data', delta: '', tone: 'neutral', description: '', trend: [] },
      competitorPressure: { label: 'Competitor Pressure', value: 'None', delta: '', tone: 'neutral', description: '', trend: [] },
      runStatus: { label: 'Run Status', value: 'Healthy', delta: '', tone: 'positive', description: '', trend: [] },
    },
    movementSummary: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
    citationMovement: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
    mentionMovement: { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false },
    movementComparison: {
      hasPreviousRun: false,
      comparable: false,
      querySetChanged: false,
      previousRunAt: null,
      currentQueryCount: 0,
      previousQueryCount: 0,
      comparableQueryCount: 0,
      addedQueryCount: 0,
      removedQueryCount: 0,
      addedQueries: [],
      removedQueries: [],
    },
    competitors: [],
    providerScores: [],
    attentionItems: [],
    runHistory: [],
    suggestedQueries: { rows: [], totalCandidates: 0, skippedAlreadyTracked: 0 },
    dateRangeLabel: 'All time',
    contextLabel: 'US / EN',
    ...overrides,
  }
}

async function captureOutput(overview: ProjectOverviewDto): Promise<string> {
  const result = await invokeCliRead(['overview', 'demo', '--location', 'Harbor', '--since', '2026-09-01T00:00:00Z'], overview, {
    pathname: '/prefix/api/v1/projects/demo/overview',
    query: { location: 'Harbor', since: '2026-09-01T00:00:00Z' },
  })
  expect(result.exitCode).toBeUndefined()
  expect(result.stderr).toBe('')
  return result.stdout
}

describe('canonry overview — human output', () => {
  let output = ''
  let cleanup = () => {}

  beforeEach(() => {
    output = ''
    cleanup = prepareCliReadFixture()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('prints the server branded score with its class and judged denominator, never the overall or non-brand value', async () => {
    const sentiment = makeSentiment()
    sentiment.branded.score = { ...sentiment.branded.score, favorableDisplay: '61.0%' }
    sentiment.nonBrand.score = { ...sentiment.nonBrand.score, favorableDisplay: '98.0%' }
    sentiment.overall.score = { ...sentiment.overall.score, favorableDisplay: '72.0%' }
    output = await captureOutput(makeOverview({ sentiment }))
    const lines = output.split('\n')
    // 3 favorable of 5 judged (favorable + mixed + unfavorable); the fixture is partial, so provisional.
    const at = lines.indexOf('  Sentiment: 61.0% favorable · branded queries')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe('    3 favorable / 5 judged · provisional')
    expect(output).not.toContain('98.0%')
    expect(output).not.toContain('72.0%')
    expect(output).not.toContain('Overall sentiment')
    expect(output).not.toContain('all query classes')
  })

  it('shows a measured zero branded favorable score and drops the provisional tag when complete', async () => {
    const sentiment = makeSentiment()
    sentiment.branded.score = { ...sentiment.branded.score, favorableRate: 0, favorableDisplay: '0%' }
    sentiment.branded.coverage = { ...sentiment.branded.coverage, judged: 5, counts: { ...sentiment.branded.coverage.counts, favorable: 0, mixed: 1, unfavorable: 4 } }
    sentiment.branded.provisional = false
    const lines = (await captureOutput(makeOverview({ sentiment }))).split('\n')
    const at = lines.indexOf('  Sentiment: 0% favorable · branded queries')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe('    0 favorable / 5 judged')
  })

  it('prints the branded line from a server that predates the overall headline', async () => {
    const { overall: _overall, ...olderSentiment } = makeSentiment()
    const lines = (await captureOutput(makeOverview({ sentiment: olderSentiment }))).split('\n')
    expect(lines).toContain(`  Sentiment: ${sentimentFixtureSummary.score.favorableDisplay} favorable · branded queries`)
    expect(lines).toContain('    3 favorable / 5 judged · provisional')
  })

  it.each(['disabled', 'missing', 'unjudged', 'unavailable'] as const)('omits a %s branded score without falling back to the overall or non-brand value', async condition => {
    const sentiment = makeSentiment()
    if (condition === 'disabled') sentiment.configured = false
    // Non-brand and overall stay measured in every case: the line must not borrow either.
    if (condition === 'unjudged') sentiment.branded.coverage = { ...sentiment.branded.coverage, judged: 0 }
    if (condition === 'unavailable') sentiment.branded.score = { ...sentiment.branded.score, favorableRate: null }
    output = await captureOutput(makeOverview(condition === 'missing' ? {} : { sentiment }))
    expect(output).not.toContain('Sentiment:')
    expect(output).not.toContain('favorable / ')
  })

  it.each(['simple', 'advanced'] as const)('preserves %s overall and class headlines and What changed through generated HTTP, CLI JSON and MCP transport', async mode => {
    const sentiment = makeSentiment()
    sentiment.branded.selection = { ...sentiment.branded.selection, mode, revision: mode === 'advanced' ? 4 : null }
    sentiment.nonBrand.selection = { ...sentiment.nonBrand.selection, mode, revision: mode === 'advanced' ? 4 : null }
    const overview = makeOverview({ sentiment, whatChanged: makeWhatChanged({ mode }) })
    overview.mentionCoverage!.selection = {
      ...overview.mentionCoverage!.selection,
      mode,
      revision: mode === 'advanced' ? 4 : null,
      provenance: mode === 'advanced' ? { kind: 'frozen-advanced', definitionRevision: 4 } : { kind: 'frozen-simple', definitionRevision: null },
    }
    const requests: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init))
      return Response.json(overview)
    }))
    const api = new clientModule.ApiClient('https://canonry.test/prefix', 'cnry_overview-read', { skipProbe: true })
    const selection = { location: 'Harbor', since: '2026-09-01T00:00:00Z' }
    expect(await api.getProjectOverview('demo', selection)).toEqual(overview)
    vi.spyOn(clientModule, 'createApiClient').mockReturnValue(api)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await showOverview('demo', { format: 'json', ...selection })
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(overview)

    const { server } = createCanonryMcpServerWithCatalog({ clientFactory: () => api, scope: 'read-only' })
    const mcp = new Client({ name: 'overview-sentiment-test', version: '1' }, { capabilities: {} })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await mcp.connect(clientTransport)
      const response = await mcp.callTool({ name: 'canonry_project_overview', arguments: { project: 'demo', ...selection } })
      expect(response.isError).not.toBe(true)
      expect(response.structuredContent).toEqual(overview)
    } finally {
      await mcp.close()
      await server.close()
    }
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      const url = new URL(request.url)
      expect(url.pathname).toBe('/prefix/api/v1/projects/demo/overview')
      expect(Object.fromEntries(url.searchParams)).toEqual(selection)
      expect(request.headers.get('authorization')).toBe('Bearer cnry_overview-read')
    }
  })

  it('renders non-brand mention coverage with its denominator and branded sibling, never the legacy pooled score', async () => {
    output = await captureOutput(makeOverview())
    expect(output).toContain('Mention · non-brand queries: 0% (0/2 answers)')
    expect(output).toContain('Mention · branded queries: 100% (1/1 answers)')
    expect(output).not.toContain('6 of 8 queries mentioned')
    expect(output).not.toContain('75.0%')
  })

  it('shows unavailable coverage from an older server without borrowing its pooled score', async () => {
    output = await captureOutput(makeOverview({ mentionCoverage: undefined }))
    expect(output).toContain('Mention · non-brand queries: Not measured')
    expect(output).not.toContain('75.0%')
  })

  it('breakdown shows project and competitor mention counts with combined-total %', async () => {
    output = await captureOutput(makeOverview())
    // Project: 6 of 10 combined = 60.0% (matches headline value 60)
    expect(output).toMatch(/you[^\n]*6 mentions \(60\.0% of combined\)/)
    // Top competitor: rival-a 3 of 10 = 30.0%
    expect(output).toMatch(/rival-a\.com[^\n]*3 mentions \(30\.0% of combined\)/)
    // Second competitor: rival-b 1 of 10 = 10.0%
    expect(output).toMatch(/rival-b\.com[^\n]*1 mentions \(10\.0% of combined\)/)
  })

  it('prints each share exactly as the server ranked it, never re-derived from the counts', async () => {
    const overview = makeOverview()
    // Deliberately not mentions / combined: the CLI must print the server's own
    // fraction through formatPercent, so a sliver keeps its <0.1% edge.
    overview.scores.mentionShare.breakdown.ranking = [
      { kind: 'competitor', domain: 'rival-a.com', mentionSnapshots: 3, share: 0.9996 },
      { kind: 'project', domain: null, mentionSnapshots: 6, share: 0.0004 },
      { kind: 'competitor', domain: 'rival-b.com', mentionSnapshots: 1, share: 0 },
    ]
    output = await captureOutput(overview)
    expect(output).toMatch(/you[^\n]*6 mentions \(<0\.1% of combined\)/)
    expect(output).toMatch(/rival-a\.com[^\n]*3 mentions \(>99\.9% of combined\)/)
    expect(output).toMatch(/rival-b\.com[^\n]*1 mentions \(0% of combined\)/)
  })

  it('lists a tracked competitor nobody named at 0%, as the dashboard table does', async () => {
    const overview = makeOverview()
    overview.scores.mentionShare.breakdown.ranking = [
      { kind: 'project', domain: null, mentionSnapshots: 6, share: 1 },
      { kind: 'competitor', domain: 'quiet.example', mentionSnapshots: 0, share: 0 },
    ]
    output = await captureOutput(overview)
    expect(output).toMatch(/you[^\n]*6 mentions \(100% of combined\)/)
    expect(output).toMatch(/quiet\.example[^\n]*0 mentions \(0% of combined\)/)
  })

  it('prints no breakdown for a server that predates the ranking', async () => {
    const overview = makeOverview()
    delete (overview.scores.mentionShare.breakdown as { ranking?: unknown }).ranking
    output = await captureOutput(overview)
    expect(output).toContain('Mention share')
    expect(output).not.toContain('of combined')
  })

  it('omits Mention Share breakdown when the server ranked no head-to-head', async () => {
    const overview = makeOverview()
    overview.scores.mentionShare = {
      ...overview.scores.mentionShare,
      value: 'Add competitors',
      tone: 'neutral',
      breakdown: {
        projectMentionSnapshots: 0,
        competitorMentionSnapshots: 0,
        combinedMentionSnapshots: 0,
        perCompetitor: [],
        ranking: [],
        snapshotsWithAnswerText: 0,
        snapshotsTotal: 0,
        score: null,
      },
    }
    output = await captureOutput(overview)
    expect(output).toContain('Mention share')
    expect(output).toContain('Add competitors')
    expect(output).not.toContain('mentions (')
  })

  it('caps Mention Share breakdown at top-3 competitors with a "+N more" line', async () => {
    const overview = makeOverview()
    overview.scores.mentionShare.breakdown.ranking = [
      { kind: 'competitor', domain: 'a.com', mentionSnapshots: 10, share: 10 / 36 },
      { kind: 'competitor', domain: 'b.com', mentionSnapshots: 9, share: 9 / 36 },
      { kind: 'competitor', domain: 'c.com', mentionSnapshots: 8, share: 8 / 36 },
      { kind: 'project', domain: null, mentionSnapshots: 6, share: 6 / 36 },
      { kind: 'competitor', domain: 'd.com', mentionSnapshots: 3, share: 3 / 36 },
    ]
    overview.scores.mentionShare.breakdown.combinedMentionSnapshots = 36
    overview.scores.mentionShare.breakdown.competitorMentionSnapshots = 30
    overview.scores.mentionShare.breakdown.projectMentionSnapshots = 6
    output = await captureOutput(overview)
    // The project's row always prints, whatever its rank.
    expect(output).toMatch(/you[^\n]*6 mentions \(16\.7% of combined\)/)
    expect(output).toMatch(/a\.com[^\n]*10 mentions \(27\.8% of combined\)/)
    expect(output).toContain('a.com')
    expect(output).toContain('b.com')
    expect(output).toContain('c.com')
    expect(output).not.toContain('d.com')
    expect(output).toContain('+ 1 more competitor')
  })

  it('renders the suggested-queries panel when GSC suggestions are available', async () => {
    const overview = makeOverview({
      suggestedQueries: {
        rows: [
          { query: 'best aeo tool', impressions: 1800, clicks: 30, avgPosition: 12, reason: '1.8K impressions · ranks #12' },
          { query: 'how to track ai citations', impressions: 400, clicks: 5, avgPosition: 22, reason: '400 impressions · ranks #22' },
        ],
        totalCandidates: 5,
        skippedAlreadyTracked: 8,
      },
    })
    output = await captureOutput(overview)
    expect(output).toContain('Suggested queries to track')
    expect(output).toContain('showing 2 of 5')
    expect(output).toContain('+ best aeo tool')
    expect(output).toContain('1.8K impressions · ranks #12')
    expect(output).toContain('canonry query add demo')
  })

  it('omits suggested-queries panel when no GSC suggestions exist', async () => {
    output = await captureOutput(makeOverview())
    expect(output).not.toContain('Suggested queries')
  })

  it('prints each gauge value as the API sent it, with no sign of its own', async () => {
    const overview = makeOverview()
    // Coverage formats the server's fraction; legacy pooled gauge values
    // cannot override either class, even when they look more favorable.
    overview.scores.mention = { ...overview.scores.mention, value: '99.9%', delta: 'pooled legacy value', progress: 99.9 }
    overview.mentionCoverage!.populations.find(population => population.queryClass === 'non-brand')!.mentionCoverage = { numerator: 2, denominator: 3, rate: 2 / 3 }
    const lines = (await captureOutput(overview)).split('\n')
    const scoreLine = (prefix: string, tone: string, value: string, delta: string) =>
      `  ${prefix} ${`[${tone}]`.padEnd(11)} ${value.padEnd(8)} ${delta}`
    expect(lines).toContain('  Mention · non-brand queries: 66.7% (2/3 answers)')
    expect(lines.join('\n')).not.toContain('99.9%')
    expect(lines).toContain(scoreLine('Cited · all queries', 'caution', '50.0%', '4 of 8 queries cited'))
    expect(lines).toContain(scoreLine('Mention share    ', 'positive', '60.0%', '6 of 10 brand mentions'))
    // A count gauge stays a count, and nothing gains a second sign.
    expect(lines).toContain(scoreLine('Gap queries      ', 'caution', '2', '2 of 8 queries'))
    expect(lines.join('\n')).not.toContain('%%')
  })

  it('keeps scoped mention coverage beside the other score signals', async () => {
    output = await captureOutput(makeOverview())
    expect(output).toContain('Mention · non-brand queries')
    expect(output).toContain('Mention · branded queries')
    expect(output).toContain('Cited · all queries')
    expect(output).toContain('Mention share')
    expect(output).toContain('Mention gaps')
    expect(output).toContain('Gap queries')
    expect(output).toContain('Index coverage')
    expect(output).toContain('Competitor press.')
    expect(output).toContain('Run status')
    expect(output).not.toMatch(/Share of [Vv]oice/)
  })

  it('renders cited and mentioned query-count lines from their own fields', async () => {
    const overview = makeOverview({
      queryCounts: { totalQueries: 8, citedQueries: 4, notCitedQueries: 4, citedRate: 0.5, citationNotMeasuredQueries: 0, mentionedQueries: 6, notMentionedQueries: 2, mentionRate: 0.75 },
    })
    output = await captureOutput(overview)
    // Two independent lines — the mentioned line (6/8) must not borrow the cited count (4/8).
    expect(output).toMatch(/Queries cited:\s+4\/8 \(50\.0%\)/)
    expect(output).toMatch(/Queries mentioned:\s+6\/8 \(75\.0%\)/)
    for (const mode of ['simple', 'advanced'] as const) {
      const sentiment = makeSentiment()
      sentiment.branded.selection = { ...sentiment.branded.selection, mode, revision: mode === 'advanced' ? 4 : null }
      sentiment.nonBrand.selection = { ...sentiment.nonBrand.selection, mode, revision: mode === 'advanced' ? 4 : null }
      const wireOverview = { ...overview, sentiment }
      for (const format of ['json', 'jsonl']) {
        const json = await invokeCliRead(['overview', 'demo', '--location', 'Harbor', '--since', '2026-09-01T00:00:00Z', '--format', format], wireOverview, {
          pathname: '/prefix/api/v1/projects/demo/overview', query: { location: 'Harbor', since: '2026-09-01T00:00:00Z' },
        })
        expect(json.exitCode).toBeUndefined()
        expect(json.stderr).toBe('')
        expect(JSON.parse(json.stdout)).toEqual(wireOverview)
        expect(JSON.parse(json.stdout).queryCounts).toEqual({ totalQueries: 8, citedQueries: 4, notCitedQueries: 4, citedRate: 0.5, citationNotMeasuredQueries: 0, mentionedQueries: 6, notMentionedQueries: 2, mentionRate: 0.75 })
      }
    }
  })

  /**
   * The overview mixes units: provider and health rates are 0..1 fractions,
   * while a model score and a run-history rate arrive as 0..100 percents.
   */
  it('prints each rate through formatPercent in the unit its field carries', async () => {
    const overview = makeOverview({
      providers: [{ provider: 'gemini', citedRate: 0.0004, cited: 1, total: 2500, citationNotMeasured: 0 }],
      providerScores: [{ provider: 'openai', model: 'gpt-5', score: 75, cited: 3, total: 4, citationNotMeasured: 0 }],
      health: {
        id: 'h-1', projectId: 'p-1', runId: 'r-2',
        overallCitedRate: 1, overallMentionRate: 1, totalPairs: 12, citedPairs: 12, citationNotMeasuredPairs: 0, mentionedPairs: 12,
        providerBreakdown: {}, createdAt: '2026-05-02T00:00:00.000Z', status: 'ready',
      },
      runHistory: [
        { runId: 'r-1', createdAt: '2026-05-01T00:00:00.000Z', citedCount: 1, totalCount: 2, citationNotMeasuredCount: 0, citationRate: 50, mentionedCount: 1, mentionRate: 50, status: 'completed' },
        { runId: 'r-2', createdAt: '2026-05-02T00:00:00.000Z', citedCount: 2, totalCount: 2, citationNotMeasuredCount: 0, citationRate: 100, mentionedCount: 2, mentionRate: 100, status: 'completed' },
      ],
    })
    const lines = (await captureOutput(overview)).split('\n')
    expect(lines).toContain('    gemini       1/2500 (<0.1%)')
    expect(lines).toContain(`    ${'openai/gpt-5'.padEnd(28)} 3/4 (75.0%)`)
    expect(lines).toContain('  Health: 100% cited (12/12 pairs)')
    expect(lines).toContain(`    2026-05-01  50.0% ${'█'.repeat(5)}`)
    expect(lines).toContain(`    2026-05-02   100% ${'█'.repeat(10)}`)
  })

  // Local (no web access) returns no sources: its answers leave every cited
  // figure and print "not measured", never 0%, beside a measured engine.
  it('prints citation figures over checked answers and not measured for an engine without sources', async () => {
    const overview = makeOverview({
      queryCounts: { totalQueries: 3, citedQueries: 1, notCitedQueries: 1, citedRate: 0.5, citationNotMeasuredQueries: 1, mentionedQueries: 2, notMentionedQueries: 1, mentionRate: 0.6667 },
      providers: [
        { provider: 'gemini', citedRate: 0.5, cited: 1, total: 2, citationNotMeasured: 0 },
        { provider: 'local', citedRate: null, cited: 0, total: 3, citationNotMeasured: 3 },
      ],
      providerScores: [{ provider: 'local', model: 'llama3', score: null, cited: 0, total: 3, citationNotMeasured: 3 }],
      health: {
        id: 'h-1', projectId: 'p-1', runId: 'r-2',
        overallCitedRate: 0.5, overallMentionRate: 0.4, totalPairs: 5, citedPairs: 1, citationNotMeasuredPairs: 3, mentionedPairs: 2,
        providerBreakdown: {}, createdAt: '2026-05-02T00:00:00.000Z', status: 'ready',
      },
      runHistory: [
        { runId: 'r-1', createdAt: '2026-05-01T00:00:00.000Z', citedCount: 0, totalCount: 2, citationNotMeasuredCount: 2, citationRate: null, mentionedCount: 1, mentionRate: 50, status: 'completed' },
      ],
    })
    const lines = (await captureOutput(overview)).split('\n')
    expect(lines).toContain('  Queries cited:     1/2 (50.0%), 1 not measured (no sources)')
    expect(lines).toContain('  Queries mentioned: 2/3 (66.7%)')
    expect(lines).toContain('    gemini       1/2 (50.0%)')
    expect(lines).toContain('    local        not measured (3 answers without sources)')
    expect(lines).toContain(`    ${'local/llama3'.padEnd(28)} not measured (3 answers without sources)`)
    expect(lines).toContain('  Health: 50.0% cited (1/2 pairs)')
    expect(lines).toContain('    2026-05-01 citations not measured (no answer carries sources)')
  })

  it('reads every answer as checked from a server that predates the not-measured counts', async () => {
    const current = makeOverview({
      queryCounts: { totalQueries: 3, citedQueries: 1, notCitedQueries: 2, citedRate: 0.3333, citationNotMeasuredQueries: 0, mentionedQueries: 2, notMentionedQueries: 1, mentionRate: 0.6667 },
      providers: [{ provider: 'gemini', citedRate: 0.5, cited: 1, total: 2, citationNotMeasured: 0 }],
      providerScores: [{ provider: 'gemini', model: 'gemini-2.5-flash', score: 50, cited: 1, total: 2, citationNotMeasured: 0 }],
      health: {
        id: 'h-1', projectId: 'p-1', runId: 'r-2',
        overallCitedRate: 0.2, overallMentionRate: 0.4, totalPairs: 5, citedPairs: 1, citationNotMeasuredPairs: 0, mentionedPairs: 2,
        providerBreakdown: {}, createdAt: '2026-05-02T00:00:00.000Z', status: 'ready',
      },
    })
    // An older server sends none of the not-measured counts: it counted every answer as checked.
    const { citationNotMeasuredQueries: _queries, ...queryCounts } = current.queryCounts
    const { citationNotMeasuredPairs: _pairs, ...health } = current.health!
    const older = {
      ...current, queryCounts, health,
      providers: current.providers.map(({ citationNotMeasured: _answers, ...provider }) => provider),
      providerScores: current.providerScores.map(({ citationNotMeasured: _answers, ...score }) => score),
    } as ProjectOverviewDto
    const lines = (await captureOutput(older)).split('\n')
    expect(lines).toContain('  Queries cited:     1/3 (33.3%)')
    expect(lines).toContain('    gemini       1/2 (50.0%)')
    expect(lines).toContain(`    ${'gemini/gemini-2.5-flash'.padEnd(28)} 1/2 (50.0%)`)
    expect(lines).toContain('  Health: 20.0% cited (1/5 pairs)')
    expect(lines.join('\n')).not.toContain('NaN')

    // `overview --all` prints the same base in its table.
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL((input instanceof Request ? input : new Request(input, init)).url)
      return Response.json(pathname === '/prefix/api/v1/projects' ? [older.project] : older)
    }))
    const all = await invokeCli(['overview', '--all'])
    expect(all.stdout.split('\n')).toContain(`  ${'Demo'.padEnd(20)}${'75.0%'.padEnd(10)}${'50.0%'.padEnd(13)}${'60.0% · non-brand queries'.padEnd(42)}${'1/3'.padEnd(10)}—`)
  })

  it('renders citation and mention movement separately with query-basket comparability', async () => {
    const overview = makeOverview({
      citationMovement: { gained: 1, lost: 0, tone: 'positive', hasPreviousRun: true },
      mentionMovement: { gained: 0, lost: 2, tone: 'negative', hasPreviousRun: true },
      movementComparison: {
        hasPreviousRun: true,
        comparable: false,
        querySetChanged: true,
        previousRunAt: '2026-05-01T00:00:00.000Z',
        currentQueryCount: 9,
        previousQueryCount: 8,
        comparableQueryCount: 8,
        addedQueryCount: 1,
        removedQueryCount: 0,
        addedQueries: ['new query'],
        removedQueries: [],
      },
    })
    output = await captureOutput(overview)
    expect(output).toContain('Query basket:       changed (+1 added, -0 removed); movement compares 8 shared')
    expect(output).toContain('Citation movement: +1 gained, -0 lost (positive)')
    expect(output).toContain('Mention movement:  +0 gained, -2 lost (negative)')
  })

  it('renders the unchanged-basket branch when the query set held steady', async () => {
    const overview = makeOverview({
      citationMovement: { gained: 0, lost: 1, tone: 'negative', hasPreviousRun: true },
      mentionMovement: { gained: 2, lost: 0, tone: 'positive', hasPreviousRun: true },
      movementComparison: {
        hasPreviousRun: true,
        comparable: true,
        querySetChanged: false,
        previousRunAt: '2026-05-01T00:00:00.000Z',
        currentQueryCount: 8,
        previousQueryCount: 8,
        comparableQueryCount: 8,
        addedQueryCount: 0,
        removedQueryCount: 0,
        addedQueries: [],
        removedQueries: [],
      },
    })
    output = await captureOutput(overview)
    expect(output).toContain('Query basket:       unchanged; 8 comparable')
    expect(output).toContain('Citation movement: +0 gained, -1 lost (negative)')
    expect(output).toContain('Mention movement:  +2 gained, -0 lost (positive)')
  })

  it('renders the first-sweep hint when there is no previous run', async () => {
    // The default makeOverview() has movementComparison.hasPreviousRun=false.
    output = await captureOutput(makeOverview())
    expect(output).toContain('Movement: first sweep; no comparison yet')
    expect(output).not.toContain('Query basket:')
  })

  it('lists the dashboard\'s What changed rows, then the queries behind each count with where they were lost', async () => {
    const lines = (await captureOutput(makeOverview({ whatChanged: makeWhatChanged() }))).split('\n')
    const at = lines.indexOf('  What changed:')
    expect(at).toBeGreaterThan(-1)
    expect(lines.slice(at, at + 10)).toEqual([
      '  What changed:',
      '    Demo lost mentions: 3 queries lost a mention in the latest check.',
      '    Demo lost citations: 1 query lost a citation in the latest check.',
      '    Demo has active runs: 1 run in progress.',
      '    Lost mentions:',
      '      - best polyurea roof coating (non-brand) — gemini, openai',
      '      - homes near harbor (non-brand) — openai · at Harbor · Properties: Harbor Homes · markets: Harbor metro',
      '      … 1 more not listed',
      '    Lost citations:',
      '      - demo reviews (branded) — openai · at florida',
    ])
  })

  it('says all clear when the latest check lost nothing, and why nothing was compared when it could not be', async () => {
    const clear = makeWhatChanged({ lostMentions: NOTHING_LOST, lostCitations: NOTHING_LOST, activeRuns: { count: 0, runIds: [] }, items: [] })
    expect((await captureOutput(makeOverview({ whatChanged: clear }))).split('\n'))
      .toContain('  What changed: No lost mentions or citations, and no runs in progress.')

    const modelChanged = makeWhatChanged({
      comparison: { state: 'unavailable', reason: 'model-changed' },
      lostMentions: NOTHING_LOST,
      lostCitations: NOTHING_LOST,
      items: [ACTIVE_ROW],
    })
    output = await captureOutput(makeOverview({ whatChanged: modelChanged }))
    const lines = output.split('\n')
    const at = lines.indexOf('  What changed: not compared: the previous sweep asked other engines or models.')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe('    Demo has active runs: 1 run in progress.')
    // Nothing was compared, so it must not read as all clear.
    expect(output).not.toContain('No lost mentions or citations')
  })

  it('prints no What changed section from a server that predates it', async () => {
    output = await captureOutput(makeOverview())
    expect(output).not.toContain('What changed')
  })
})

const NOTHING_LOST = { queryCount: 0, queries: [], truncated: false }
const ACTIVE_ROW = { id: 'attention_p-1_active', tone: 'neutral' as const, title: 'Demo has active runs', detail: '1 run in progress.', actionLabel: 'View runs', href: '/runs' }

function makeWhatChanged(overrides: Partial<ProjectOverviewWhatChangedDto> = {}): ProjectOverviewWhatChangedDto {
  return {
    mode: 'advanced',
    latestCheck: { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' },
    comparison: { state: 'available', previousRunIds: ['run_previous'] },
    lostMentions: {
      queryCount: 3,
      queries: [
        { queryId: 'q_best', query: 'best polyurea roof coating', queryClass: 'non-brand', providers: ['gemini', 'openai'], locations: [null], properties: [], markets: [] },
        { queryId: 'q-nearby', query: 'homes near harbor', queryClass: 'non-brand', providers: ['openai'], locations: ['Harbor'], properties: [{ key: 'harbor', label: 'Harbor Homes' }], markets: [{ key: 'harbor-metro', label: 'Harbor metro' }] },
      ],
      truncated: true,
    },
    lostCitations: {
      queryCount: 1,
      queries: [{ queryId: 'q_brand', query: 'demo reviews', queryClass: 'branded', providers: ['openai'], locations: ['florida'], properties: [], markets: [] }],
      truncated: false,
    },
    activeRuns: { count: 1, runIds: ['run_live'] },
    items: [
      { id: 'attention_p-1_lost_mentions', tone: 'negative', title: 'Demo lost mentions', detail: '3 queries lost a mention in the latest check.', actionLabel: 'Open project', href: '/projects/demo' },
      { id: 'attention_p-1_lost', tone: 'negative', title: 'Demo lost citations', detail: '1 query lost a citation in the latest check.', actionLabel: 'Open project', href: '/projects/demo' },
      ACTIVE_ROW,
    ],
    ...overrides,
  }
}

describe('canonry overview --all — What changed', () => {
  let cleanup = () => {}

  beforeEach(() => {
    cleanup = prepareCliReadFixture()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  /**
   * Serves the project list and each project's overview, as the server would.
   * A project named in `failing` answers its overview read with that status.
   */
  async function readAll(overviews: ProjectOverviewDto[], options: { failing?: Record<string, number>; format?: string } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/prefix/api/v1/projects') return Response.json(overviews.map(overview => overview.project))
      const overview = overviews.find(candidate => url.pathname === `/prefix/api/v1/projects/${candidate.project.name}/overview`)
      const status = overview && options.failing?.[overview.project.name]
      if (status) return Response.json({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'NOT_FOUND', message: 'Overview unavailable' } }, { status })
      return overview ? Response.json(overview) : Response.json({ error: { code: 'NOT_FOUND', message: url.pathname } }, { status: 404 })
    }))
    return invokeCli(['overview', '--all', ...(options.format ? ['--format', options.format] : [])])
  }

  async function captureAll(overviews: ProjectOverviewDto[]): Promise<string[]> {
    const result = await readAll(overviews)
    expect(result.stderr).toBe('')
    return result.stdout.split('\n')
  }

  function projectOverview(name: string, whatChanged: ProjectOverviewWhatChangedDto | undefined): ProjectOverviewDto {
    const base = makeOverview()
    return { ...base, project: { ...base.project, id: `id-${name}`, name, displayName: name }, ...(whatChanged ? { whatChanged } : {}) }
  }

  const quiet = () => makeWhatChanged({ lostMentions: NOTHING_LOST, lostCitations: NOTHING_LOST, activeRuns: { count: 0, runIds: [] }, items: [] })
  const tableRows = (stdout: string) => stdout.split('\n').filter(line => /^ {2}(?:alpha|beta) /.test(line))

  it('lists every project\'s rows under the table, in project order', async () => {
    const lines = await captureAll([projectOverview('alpha', makeWhatChanged()), projectOverview('beta', quiet())])
    const at = lines.indexOf('What changed:')
    expect(at).toBeGreaterThan(-1)
    expect(lines.slice(at + 1)).toEqual([
      '  alpha lost mentions: 3 queries lost a mention in the latest check.',
      '  alpha lost citations: 1 query lost a citation in the latest check.',
      '  alpha has active runs: 1 run in progress.',
      '',
    ])
  })

  // As on the dashboard, one project's failed read never hides the others, and
  // its changes are unknown, so the portfolio is never called clear. The exit
  // code still reports it: 2, because a server failure may clear on a retry.
  it('prints every readable project, names the one whose overview failed, then exits 2', async () => {
    const alpha = projectOverview('alpha', quiet())
    const [alphaAlone] = tableRows((await readAll([alpha])).stdout)

    const result = await readAll([alpha, projectOverview('beta', quiet())], { failing: { beta: 500 } })
    expect(tableRows(result.stdout)).toEqual([
      alphaAlone,
      `  ${'beta'.padEnd(20)}Couldn't be loaded: Overview unavailable`,
    ])
    const lines = result.stdout.split('\n')
    expect(lines.slice(lines.indexOf('What changed:') + 1)).toEqual([
      '  1 project couldn\'t be loaded: beta. Its lost mentions and citations are unknown.',
      '',
    ])
    expect(result.stderr).toBe('Error: 1 of 2 project overviews couldn\'t be loaded: beta')
    expect(result.exitCode).toBe(2)
  })

  it('keeps the unread project\'s place in JSON with its error, and exits 1 when no retry would help', async () => {
    const alpha = projectOverview('alpha', quiet())
    const beta = projectOverview('beta', quiet())
    const result = await readAll([alpha, beta], { failing: { beta: 404 }, format: 'json' })
    expect(JSON.parse(result.stdout)).toEqual([
      alpha,
      { project: beta.project, error: { code: 'NOT_FOUND', message: 'Overview unavailable' } },
    ])
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'OVERVIEW_INCOMPLETE',
        message: '1 of 2 project overviews couldn\'t be loaded: beta',
        details: { projects: ['beta'] },
      },
    })
    expect(result.exitCode).toBe(1)
  })

  it('names every project when no overview could be read', async () => {
    const result = await readAll([projectOverview('alpha', quiet()), projectOverview('beta', quiet())], { failing: { alpha: 503, beta: 500 } })
    const lines = result.stdout.split('\n')
    expect(lines.slice(lines.indexOf('What changed:') + 1)).toEqual([
      '  2 projects couldn\'t be loaded: alpha, beta. Their lost mentions and citations are unknown.',
      '',
    ])
    expect(result.exitCode).toBe(2)
  })

  it('prints the one fallback row the dashboard shows when no project has a row', async () => {
    const lines = await captureAll([projectOverview('alpha', quiet()), projectOverview('beta', { ...quiet(), latestCheck: null })])
    expect(lines[lines.indexOf('What changed:') + 1]).toBe('  All projects stable: No lost mentions or citations, and no runs in progress.')
  })

  it('prints no What changed section when no project\'s server reports it', async () => {
    const lines = await captureAll([projectOverview('alpha', undefined)])
    expect(lines).not.toContain('What changed:')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectOverviewDto } from '@ainyc/canonry-contracts'
import { renderHuman } from '../src/commands/overview.js'

function makeOverview(overrides: Partial<ProjectOverviewDto> = {}): ProjectOverviewDto {
  return {
    project: {
      id: 'p-1',
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'demo.example.com',
      ownedDomains: [],
      aliases: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      locations: [],
      defaultLocation: null,
      autoExtractBacklinks: false,
      configSource: 'manual',
      configRevision: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
    latestRun: { run: null, totalRuns: 0 },
    health: null,
    topInsights: [],
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0, mentionedQueries: 0, notMentionedQueries: 0, mentionRate: 0 },
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
        },
      },
      gapQueries: { label: 'Citation Gaps', value: '2', delta: '2 of 8 queries at risk', tone: 'caution', description: '', trend: [] },
      mentionGaps: { label: 'Mention Gaps', value: '1', delta: '1 of 8 queries at risk', tone: 'caution', description: '', trend: [] },
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

function captureOutput(fn: () => void): string {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

describe('canonry overview — human output', () => {
  let output = ''

  beforeEach(() => {
    output = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders Mention, Citation, and Mention Share scores in the hero order', () => {
    output = captureOutput(() => renderHuman(makeOverview()))
    // The dashboard hero shows Mention → Cited → Mention share. CLI must match.
    const mentionIdx = output.indexOf('Mention   ')
    const visibilityIdx = output.indexOf('Visibility ')
    const mentionShareIdx = output.indexOf('Mention share')
    expect(mentionIdx).toBeGreaterThan(-1)
    expect(visibilityIdx).toBeGreaterThan(mentionIdx)
    expect(mentionShareIdx).toBeGreaterThan(visibilityIdx)
    expect(output).toContain('6 of 8 queries mentioned')
    expect(output).toContain('6 of 10 brand mentions')
  })

  it('breakdown shows project and competitor mention counts with combined-total %', () => {
    output = captureOutput(() => renderHuman(makeOverview()))
    // Project: 6 of 10 combined = 60.0% (matches headline value 60)
    expect(output).toMatch(/you[^\n]*6 mentions \(60\.0% of combined\)/)
    // Top competitor: rival-a 3 of 10 = 30.0%
    expect(output).toMatch(/rival-a\.com[^\n]*3 mentions \(30\.0% of combined\)/)
    // Second competitor: rival-b 1 of 10 = 10.0%
    expect(output).toMatch(/rival-b\.com[^\n]*1 mentions \(10\.0% of combined\)/)
  })

  it('prints each share exactly as the server ranked it, never re-derived from the counts', () => {
    const overview = makeOverview()
    // Deliberately not mentions / combined: the CLI must print the server's own
    // fraction through formatPercent, so a sliver keeps its <0.1% edge.
    overview.scores.mentionShare.breakdown.ranking = [
      { kind: 'competitor', domain: 'rival-a.com', mentionSnapshots: 3, share: 0.9996 },
      { kind: 'project', domain: null, mentionSnapshots: 6, share: 0.0004 },
      { kind: 'competitor', domain: 'rival-b.com', mentionSnapshots: 1, share: 0 },
    ]
    output = captureOutput(() => renderHuman(overview))
    expect(output).toMatch(/you[^\n]*6 mentions \(<0\.1% of combined\)/)
    expect(output).toMatch(/rival-a\.com[^\n]*3 mentions \(>99\.9% of combined\)/)
    expect(output).toMatch(/rival-b\.com[^\n]*1 mentions \(0% of combined\)/)
  })

  it('lists a tracked competitor nobody named at 0%, as the dashboard table does', () => {
    const overview = makeOverview()
    overview.scores.mentionShare.breakdown.ranking = [
      { kind: 'project', domain: null, mentionSnapshots: 6, share: 1 },
      { kind: 'competitor', domain: 'quiet.example', mentionSnapshots: 0, share: 0 },
    ]
    output = captureOutput(() => renderHuman(overview))
    expect(output).toMatch(/you[^\n]*6 mentions \(100% of combined\)/)
    expect(output).toMatch(/quiet\.example[^\n]*0 mentions \(0% of combined\)/)
  })

  it('prints no breakdown for a server that predates the ranking', () => {
    const overview = makeOverview()
    delete (overview.scores.mentionShare.breakdown as { ranking?: unknown }).ranking
    output = captureOutput(() => renderHuman(overview))
    expect(output).toContain('Mention share')
    expect(output).not.toContain('of combined')
  })

  it('omits Mention Share breakdown when the server ranked no head-to-head', () => {
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
      },
    }
    output = captureOutput(() => renderHuman(overview))
    expect(output).toContain('Mention share')
    expect(output).toContain('Add competitors')
    expect(output).not.toContain('mentions (')
  })

  it('caps Mention Share breakdown at top-3 competitors with a "+N more" line', () => {
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
    output = captureOutput(() => renderHuman(overview))
    // The project's row always prints, whatever its rank.
    expect(output).toMatch(/you[^\n]*6 mentions \(16\.7% of combined\)/)
    expect(output).toMatch(/a\.com[^\n]*10 mentions \(27\.8% of combined\)/)
    expect(output).toContain('a.com')
    expect(output).toContain('b.com')
    expect(output).toContain('c.com')
    expect(output).not.toContain('d.com')
    expect(output).toContain('+ 1 more competitor')
  })

  it('renders the suggested-queries panel when GSC suggestions are available', () => {
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
    output = captureOutput(() => renderHuman(overview))
    expect(output).toContain('Suggested queries to track')
    expect(output).toContain('showing 2 of 5')
    expect(output).toContain('+ best aeo tool')
    expect(output).toContain('1.8K impressions · ranks #12')
    expect(output).toContain('canonry query add demo')
  })

  it('omits suggested-queries panel when no GSC suggestions exist', () => {
    output = captureOutput(() => renderHuman(makeOverview()))
    expect(output).not.toContain('Suggested queries')
  })

  it('prints each gauge value as the API sent it, with no sign of its own', () => {
    const overview = makeOverview()
    // 2 of 3 is 66.67% on the wire and "66.7%" in the gauge's value.
    overview.scores.mention = { ...overview.scores.mention, value: '66.7%', delta: '2 of 3 queries mentioned', progress: 66.67 }
    const lines = captureOutput(() => renderHuman(overview)).split('\n')
    const scoreLine = (prefix: string, tone: string, value: string, delta: string) =>
      `  ${prefix} ${`[${tone}]`.padEnd(11)} ${value.padEnd(8)} ${delta}`
    expect(lines).toContain(scoreLine('Mention          ', 'positive', '66.7%', '2 of 3 queries mentioned'))
    expect(lines).toContain(scoreLine('Visibility       ', 'caution', '50.0%', '4 of 8 queries cited'))
    expect(lines).toContain(scoreLine('Mention share    ', 'positive', '60.0%', '6 of 10 brand mentions'))
    // A count gauge stays a count, and nothing gains a second sign.
    expect(lines).toContain(scoreLine('Gap queries      ', 'caution', '2', '2 of 8 queries at risk'))
    expect(lines.join('\n')).not.toContain('%%')
  })

  it('shows all 8 scores (no SoV — that field is gone)', () => {
    output = captureOutput(() => renderHuman(makeOverview()))
    expect(output).toContain('Mention   ')
    expect(output).toContain('Visibility')
    expect(output).toContain('Mention share')
    expect(output).toContain('Mention gaps')
    expect(output).toContain('Gap queries')
    expect(output).toContain('Index coverage')
    expect(output).toContain('Competitor press.')
    expect(output).toContain('Run status')
    expect(output).not.toMatch(/Share of [Vv]oice/)
  })

  it('renders cited and mentioned query-count lines from their own fields', () => {
    const overview = makeOverview({
      queryCounts: { totalQueries: 8, citedQueries: 4, notCitedQueries: 4, citedRate: 0.5, mentionedQueries: 6, notMentionedQueries: 2, mentionRate: 0.75 },
    })
    output = captureOutput(() => renderHuman(overview))
    // Two independent lines — the mentioned line (6/8) must not borrow the cited count (4/8).
    expect(output).toMatch(/Queries cited:\s+4\/8 \(50\.0%\)/)
    expect(output).toMatch(/Queries mentioned:\s+6\/8 \(75\.0%\)/)
  })

  /**
   * The overview mixes units: provider and health rates are 0..1 fractions,
   * while a model score and a run-history rate arrive as 0..100 percents.
   */
  it('prints each rate through formatPercent in the unit its field carries', () => {
    const overview = makeOverview({
      providers: [{ provider: 'gemini', citedRate: 0.0004, cited: 1, total: 2500 }],
      providerScores: [{ provider: 'openai', model: 'gpt-5', score: 75, cited: 3, total: 4 }],
      health: {
        id: 'h-1', projectId: 'p-1', runId: 'r-2',
        overallCitedRate: 1, overallMentionRate: 1, totalPairs: 12, citedPairs: 12, mentionedPairs: 12,
        providerBreakdown: {}, createdAt: '2026-05-02T00:00:00.000Z', status: 'ready',
      },
      runHistory: [
        { runId: 'r-1', createdAt: '2026-05-01T00:00:00.000Z', citedCount: 1, totalCount: 2, citationRate: 50, mentionedCount: 1, mentionRate: 50, status: 'completed' },
        { runId: 'r-2', createdAt: '2026-05-02T00:00:00.000Z', citedCount: 2, totalCount: 2, citationRate: 100, mentionedCount: 2, mentionRate: 100, status: 'completed' },
      ],
    })
    const lines = captureOutput(() => renderHuman(overview)).split('\n')
    expect(lines).toContain('    gemini       1/2500 (<0.1%)')
    expect(lines).toContain(`    ${'openai/gpt-5'.padEnd(28)} 3/4 (75.0%)`)
    expect(lines).toContain('  Health: 100% cited (12/12 pairs)')
    expect(lines).toContain(`    2026-05-01  50.0% ${'█'.repeat(5)}`)
    expect(lines).toContain(`    2026-05-02   100% ${'█'.repeat(10)}`)
  })

  it('renders citation and mention movement separately with query-basket comparability', () => {
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
    output = captureOutput(() => renderHuman(overview))
    expect(output).toContain('Query basket:       changed (+1 added, -0 removed); movement compares 8 shared')
    expect(output).toContain('Citation movement: +1 gained, -0 lost (positive)')
    expect(output).toContain('Mention movement:  +0 gained, -2 lost (negative)')
  })

  it('renders the unchanged-basket branch when the query set held steady', () => {
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
    output = captureOutput(() => renderHuman(overview))
    expect(output).toContain('Query basket:       unchanged; 8 comparable')
    expect(output).toContain('Citation movement: +0 gained, -1 lost (negative)')
    expect(output).toContain('Mention movement:  +2 gained, -0 lost (positive)')
  })

  it('renders the first-sweep hint when there is no previous run', () => {
    // The default makeOverview() has movementComparison.hasPreviousRun=false.
    output = captureOutput(() => renderHuman(makeOverview()))
    expect(output).toContain('Movement: first sweep; no comparison yet')
    expect(output).not.toContain('Query basket:')
  })
})

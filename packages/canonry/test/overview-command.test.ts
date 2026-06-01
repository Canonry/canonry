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
      mention: { label: 'Mention Coverage', value: '75', delta: '6 of 8 queries mentioned', tone: 'positive', description: '', trend: [], progress: 75 },
      visibility: { label: 'Citation Coverage', value: '50', delta: '4 of 8 queries cited', tone: 'caution', description: '', trend: [], progress: 50 },
      mentionShare: {
        label: 'Mention Share',
        value: '60',
        delta: '6 of 10 brand mentions',
        tone: 'positive',
        description: '',
        trend: [],
        progress: 60,
        breakdown: {
          projectMentionSnapshots: 6,
          competitorMentionSnapshots: 4,
          perCompetitor: [
            { domain: 'rival-a.com', mentionSnapshots: 3, shareOfCompetitiveTotal: 75 },
            { domain: 'rival-b.com', mentionSnapshots: 1, shareOfCompetitiveTotal: 25 },
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

  it('omits Mention Share breakdown when no competitors are mentioned', () => {
    const overview = makeOverview()
    overview.scores.mentionShare = {
      ...overview.scores.mentionShare,
      value: 'Add competitors',
      tone: 'neutral',
      breakdown: {
        projectMentionSnapshots: 0,
        competitorMentionSnapshots: 0,
        perCompetitor: [],
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
    overview.scores.mentionShare.breakdown.perCompetitor = [
      { domain: 'a.com', mentionSnapshots: 10, shareOfCompetitiveTotal: 33 },
      { domain: 'b.com', mentionSnapshots: 9, shareOfCompetitiveTotal: 30 },
      { domain: 'c.com', mentionSnapshots: 8, shareOfCompetitiveTotal: 27 },
      { domain: 'd.com', mentionSnapshots: 3, shareOfCompetitiveTotal: 10 },
    ]
    overview.scores.mentionShare.breakdown.competitorMentionSnapshots = 30
    overview.scores.mentionShare.breakdown.projectMentionSnapshots = 6
    output = captureOutput(() => renderHuman(overview))
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
})

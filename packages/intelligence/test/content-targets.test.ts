import { describe, it, expect } from 'vitest'

import {
  buildContentTargetRows,
  buildContentSourceRows,
  buildContentGapRows,
  type CandidateQuery,
  type OrchestratorInput,
} from '../src/content-targets.js'

function emptyInput(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    projectId: 'proj_1',
    ownDomain: 'example.com',
    competitors: ['competitor-a.com', 'competitor-b.com', 'competitor-c.com'],
    candidateQueries: [],
    inventory: [],
    wpSchemaAudit: new Map(),
    gaTrafficByPage: new Map(),
    totalAiReferralSessions: 0,
    latestRunId: 'run_1',
    latestRunTimestamp: '2026-04-26T00:00:00.000Z',
    inProgressActions: new Map(),
    ...overrides,
  }
}

function emptyCandidate(overrides: Partial<CandidateQuery> = {}): CandidateQuery {
  return {
    query: 'unset',
    gscPage: null,
    gscPosition: null,
    gscImpressions: 0,
    gscClicks: 0,
    gscCtr: 0,
    ourCitedRate: 0,
    ourCitedInLatestRun: false,
    competitorDomains: [],
    competitorCitationCount: 0,
    recentMissRate: 0,
    ourGroundingUrls: [],
    competitorGroundingUrls: [],
    runsOfHistory: 0,
    ...overrides,
  }
}

function ownGrounding(uri: string, providers: string[] = ['gemini']): {
  uri: string
  title: string
  domain: string
  citationCount: number
  providers: string[]
} {
  return {
    uri,
    title: '',
    domain: 'example.com',
    citationCount: 1,
    providers,
  }
}

// ─── buildContentTargetRows ─────────────────────────────────────────────────

describe('buildContentTargetRows', () => {
  it('returns empty when no candidate queries', () => {
    expect(buildContentTargetRows(emptyInput())).toEqual([])
  })

  it('skips queries with no demand signal at all (no GSC, no competitor, not cited)', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'tracked but silent',
            // No GSC, no competitors, not cited — classifier would still
            // return 'create' for the no-page case but we have nothing
            // to base a recommendation on.
          }),
        ],
      }),
    )
    expect(rows).toEqual([])
  })

  it('produces a CREATE row for a query with no page and competitor evidence', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'best crm for saas',
            competitorDomains: ['competitor-a.com', 'competitor-b.com', 'competitor-c.com'],
            competitorCitationCount: 5,
            recentMissRate: 0.8,
            runsOfHistory: 5,
            competitorGroundingUrls: [
              {
                uri: 'https://competitor-a.com/guides/crm',
                title: 'CRM Guide',
                domain: 'competitor-a.com',
                citationCount: 3,
                providers: ['gemini'],
              },
            ],
          }),
        ],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('create')
    expect(rows[0].ourBestPage).toBeNull()
    expect(rows[0].winningCompetitor?.domain).toBe('competitor-a.com')
    expect(rows[0].demandSource).toBe('competitor-evidence')
    expect(rows[0].score).toBeGreaterThan(0)
  })

  it('produces a REFRESH row for a strong-SEO page that is not cited', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'email marketing software',
            gscPage: '/blog/email-marketing-comparison',
            gscPosition: 4,
            gscImpressions: 2400,
            gscClicks: 95,
            competitorDomains: ['competitor-a.com'],
            competitorCitationCount: 2,
            recentMissRate: 1.0,
            runsOfHistory: 5,
          }),
        ],
        wpSchemaAudit: new Map([['/blog/email-marketing-comparison', true]]),
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('refresh')
    expect(rows[0].ourBestPage?.url).toBe('/blog/email-marketing-comparison')
    expect(rows[0].demandSource).toBe('both')
  })

  it('produces an EXPAND row for a weak-SEO page (position 11–30)', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'what is mrr',
            gscPage: '/glossary/mrr',
            gscPosition: 22,
            gscImpressions: 800,
            competitorDomains: ['competitor-b.com'],
            competitorCitationCount: 1,
            recentMissRate: 0.9,
            runsOfHistory: 5,
          }),
        ],
        wpSchemaAudit: new Map([['/glossary/mrr', true]]),
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('expand')
  })

  it('produces an ADD-SCHEMA row for a cited page with no schema', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'saas billing guide',
            gscPage: '/blog/saas-billing',
            gscPosition: 6,
            gscImpressions: 1200,
            ourGroundingUrls: [ownGrounding('https://example.com/blog/saas-billing')],
            ourCitedRate: 0.6,
            ourCitedInLatestRun: true,
            runsOfHistory: 5,
          }),
        ],
        wpSchemaAudit: new Map([['/blog/saas-billing', false]]),
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('add-schema')
  })

  it('omits already-winning queries (cited + has schema)', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'q',
            gscPage: '/blog/q',
            gscPosition: 4,
            ourGroundingUrls: [ownGrounding('https://example.com/blog/q')],
            ourCitedInLatestRun: true,
          }),
        ],
        wpSchemaAudit: new Map([['/blog/q', true]]),
      }),
    )
    expect(rows).toHaveLength(0)
  })

  it('falls back to inventory match when GSC has no entry but a slug-matching page exists', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'best payment processor',
            competitorDomains: ['competitor-a.com'],
            competitorCitationCount: 2,
            recentMissRate: 1.0,
            runsOfHistory: 3,
          }),
        ],
        inventory: [{ url: '/blog/payment-processor-guide', sources: ['ga4'] }],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].ourBestPage?.url).toBe('/blog/payment-processor-guide')
    // Inventory match has no GSC ranking — gscAvgPosition is null so the
    // DTO doesn't masquerade as a #1 ranking on the way out.
    expect(rows[0].ourBestPage?.gscAvgPosition).toBeNull()
    // Classifier still treats it as effectively invisible → CREATE.
    expect(rows[0].action).toBe('create')
  })

  it('sorts rows by score descending', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'low-impact',
            competitorDomains: ['c.com'],
            competitorCitationCount: 1,
            recentMissRate: 0.5,
            runsOfHistory: 3,
          }),
          emptyCandidate({
            query: 'high-impact',
            gscImpressions: 5000,
            competitorDomains: ['a.com', 'b.com', 'c.com'],
            competitorCitationCount: 10,
            recentMissRate: 1.0,
            runsOfHistory: 5,
          }),
        ],
      }),
    )
    expect(rows[0].query).toBe('high-impact')
    expect(rows[1].query).toBe('low-impact')
    expect(rows[0].score).toBeGreaterThan(rows[1].score)
  })

  it('annotates rows with existingAction when in-progress actions exist', () => {
    const rows = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'best crm',
            competitorDomains: ['a.com'],
            competitorCitationCount: 1,
            recentMissRate: 1.0,
            runsOfHistory: 3,
          }),
        ],
      }),
    )
    const targetRef = rows[0].targetRef

    const rowsWithAction = buildContentTargetRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'best crm',
            competitorDomains: ['a.com'],
            competitorCitationCount: 1,
            recentMissRate: 1.0,
            runsOfHistory: 3,
          }),
        ],
        inProgressActions: new Map([
          [targetRef, { actionId: 'act_99', state: 'briefed', lastUpdated: '2026-04-26T00:00:00.000Z' }],
        ]),
      }),
    )
    expect(rowsWithAction[0].existingAction?.actionId).toBe('act_99')
    expect(rowsWithAction[0].existingAction?.state).toBe('briefed')
  })

  it('produces a stable targetRef for identical inputs', () => {
    const make = () => buildContentTargetRows(
      emptyInput({
        latestRunId: 'run_42',
        candidateQueries: [
          emptyCandidate({
            query: 'q',
            competitorDomains: ['a.com'],
            competitorCitationCount: 1,
            recentMissRate: 1.0,
            runsOfHistory: 3,
          }),
        ],
      }),
    )
    expect(make()[0].targetRef).toBe(make()[0].targetRef)
  })
})

// ─── buildContentSourceRows ─────────────────────────────────────────────────

describe('buildContentSourceRows', () => {
  it('returns one row per candidate query', () => {
    const rows = buildContentSourceRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({ query: 'q1' }),
          emptyCandidate({ query: 'q2' }),
        ],
      }),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.query)).toEqual(['q1', 'q2'])
  })

  it('includes our domain grounding URLs marked isOurDomain with citationCount + providers', () => {
    const rows = buildContentSourceRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'q',
            ourGroundingUrls: [
              {
                uri: 'https://example.com/blog/x',
                title: 'Our Post',
                domain: 'example.com',
                citationCount: 4,
                providers: ['gemini', 'openai'],
              },
            ],
          }),
        ],
      }),
    )
    expect(rows[0].groundingSources[0].isOurDomain).toBe(true)
    expect(rows[0].groundingSources[0].domain).toBe('example.com')
    expect(rows[0].groundingSources[0].citationCount).toBe(4)
    expect(rows[0].groundingSources[0].providers).toEqual(['gemini', 'openai'])
  })

  it('includes competitor grounding URLs marked isCompetitor', () => {
    const rows = buildContentSourceRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'q',
            competitorGroundingUrls: [
              {
                uri: 'https://competitor-a.com/guides',
                title: 'Guide',
                domain: 'competitor-a.com',
                citationCount: 3,
                providers: ['gemini', 'openai'],
              },
            ],
          }),
        ],
      }),
    )
    expect(rows[0].groundingSources[0].isCompetitor).toBe(true)
    expect(rows[0].groundingSources[0].providers).toEqual(['gemini', 'openai'])
  })
})

// ─── buildContentGapRows ────────────────────────────────────────────────────

describe('buildContentGapRows', () => {
  it('returns gap rows for queries where competitors cite but we do not', () => {
    const rows = buildContentGapRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'gap-1',
            competitorDomains: ['a.com', 'b.com'],
            recentMissRate: 0.9,
          }),
          emptyCandidate({
            query: 'gap-2',
            competitorDomains: ['a.com'],
            recentMissRate: 0.6,
          }),
        ],
      }),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].query).toBe('gap-1') // higher missRate
  })

  it('omits queries with no competitor evidence', () => {
    const rows = buildContentGapRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({ query: 'no-competitors', competitorDomains: [] }),
        ],
      }),
    )
    expect(rows).toHaveLength(0)
  })

  it('omits queries where we are already cited at 100% rate', () => {
    const rows = buildContentGapRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'we-win',
            competitorDomains: ['a.com'],
            ourCitedRate: 1.0,
          }),
        ],
      }),
    )
    expect(rows).toHaveLength(0)
  })

  it('clamps missRate into [0, 1]', () => {
    const rows = buildContentGapRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({
            query: 'q',
            competitorDomains: ['a.com'],
            recentMissRate: 1.5,
          }),
        ],
      }),
    )
    expect(rows[0].missRate).toBe(1)
  })

  it('sorts by missRate desc, then by competitorCount desc', () => {
    const rows = buildContentGapRows(
      emptyInput({
        candidateQueries: [
          emptyCandidate({ query: 'mid', competitorDomains: ['a', 'b', 'c'], recentMissRate: 0.5 }),
          emptyCandidate({ query: 'high', competitorDomains: ['a'], recentMissRate: 0.9 }),
          emptyCandidate({ query: 'tied', competitorDomains: ['a', 'b'], recentMissRate: 0.5 }),
        ],
      }),
    )
    expect(rows.map((r) => r.query)).toEqual(['high', 'mid', 'tied'])
  })
})

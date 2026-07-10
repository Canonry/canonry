import { describe, expect, it } from 'vitest'
import {
  computeVisibilityCompare,
  type ComputeVisibilityCompareInput,
  type VisibilityCompareSnapshotInput,
} from '../src/visibility-compare.js'

function snap(
  over: Partial<VisibilityCompareSnapshotInput> & { queryId: string; provider: string },
): VisibilityCompareSnapshotInput {
  return {
    queryText: null,
    model: 'gpt-5.4',
    citationState: 'not-cited',
    answerMentioned: false,
    answerText: 'a neutral answer with no brands',
    citedDomains: [],
    ...over,
  }
}

function period(month: string, runCount: number, snapshots: VisibilityCompareSnapshotInput[]) {
  return { month, since: `${month}-01T00:00:00.000Z`, until: `${month}-28T23:59:59.999Z`, runCount, snapshots }
}

function build(
  from: VisibilityCompareSnapshotInput[],
  to: VisibilityCompareSnapshotInput[],
  extra: Partial<ComputeVisibilityCompareInput> = {},
): ComputeVisibilityCompareInput {
  return {
    project: 'demo',
    queries: [
      { id: 'q1', query: 'query one' },
      { id: 'q2', query: 'query two' },
      { id: 'q3', query: 'query three' },
    ],
    from: period('2026-05', 7, from),
    to: period('2026-06', 2, to),
    competitors: [],
    ...extra,
  }
}

const metricOf = (dto: ReturnType<typeof computeVisibilityCompare>, key: string) =>
  dto.metrics.find((m) => m.key === key)!

describe('computeVisibilityCompare — basket', () => {
  it('compares only queries and providers present in BOTH periods, and reports exclusions', () => {
    const from = [
      snap({ queryId: 'q1', provider: 'openai' }),
      snap({ queryId: 'q2', provider: 'openai' }),
      snap({ queryId: 'q2', provider: 'claude' }),
    ]
    const to = [
      snap({ queryId: 'q2', provider: 'openai' }),
      snap({ queryId: 'q3', provider: 'openai' }),
      snap({ queryId: 'q2', provider: 'gemini' }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.basket.queryCount).toBe(1) // only q2 in both
    expect(dto.basket.excludedFromOnly).toBe(1) // q1
    expect(dto.basket.excludedToOnly).toBe(1) // q3
    expect(dto.basket.providers).toEqual(['openai']) // claude/gemini each only one side
    expect(dto.basket.excludedProviders).toEqual(['claude', 'gemini'])
    // Only the (q2, openai) snapshots survive into the counts: 1 per period.
    expect(metricOf(dto, 'mention-rate').from.denominator).toBe(1)
    expect(metricOf(dto, 'mention-rate').to.denominator).toBe(1)
  })

  it('compares only common query/provider pairs, not a provider’s different query coverage in each period', () => {
    // OpenAI has q1 only in May and q3 only in June. It also has q2 in both,
    // so a provider-set intersection alone would keep OpenAI and incorrectly
    // count its q1/q3 coverage churn as a 1/5 -> 0/5 decline. Claude keeps all
    // three queries present in both months, so every query is otherwise common.
    const from = [
      snap({ queryId: 'q1', provider: 'openai', answerMentioned: true }),
      snap({ queryId: 'q2', provider: 'openai', answerMentioned: false }),
      snap({ queryId: 'q1', provider: 'claude' }),
      snap({ queryId: 'q2', provider: 'claude' }),
      snap({ queryId: 'q3', provider: 'claude' }),
    ]
    const to = [
      snap({ queryId: 'q2', provider: 'openai', answerMentioned: false }),
      snap({ queryId: 'q3', provider: 'openai', answerMentioned: false }),
      snap({ queryId: 'q1', provider: 'claude' }),
      snap({ queryId: 'q2', provider: 'claude' }),
      snap({ queryId: 'q3', provider: 'claude' }),
    ]

    const dto = computeVisibilityCompare(build(from, to))
    const mentionRate = metricOf(dto, 'mention-rate')
    expect(dto.basket).toMatchObject({ queryCount: 3, providers: ['claude', 'openai'] })
    expect(mentionRate.from).toMatchObject({ numerator: 0, denominator: 4, point: 0 })
    expect(mentionRate.to).toMatchObject({ numerator: 0, denominator: 4, point: 0 })
    expect(mentionRate.verdict).toBe('within-noise')
    expect(dto.byProvider.find((row) => row.provider === 'openai')).toMatchObject({
      from: { checked: 1, mentioned: 0 },
      to: { checked: 1, mentioned: 0 },
    })
  })
})

describe('computeVisibilityCompare — K-invariance', () => {
  it('is invariant to sweep count: duplicating a period’s snapshots leaves every point unchanged', () => {
    const base = [
      snap({ queryId: 'q1', provider: 'openai', answerMentioned: true, citationState: 'cited' }),
      snap({ queryId: 'q1', provider: 'claude', answerMentioned: false }),
    ]
    // `to` is the SAME period run twice (2x the sweeps).
    const dto = computeVisibilityCompare(build(base, [...base, ...base]))
    for (const m of dto.metrics) {
      expect(m.to.point).toBe(m.from.point) // rates identical despite 2x the snapshots
    }
    expect(metricOf(dto, 'mention-rate').to.denominator).toBe(4) // counts doubled
    expect(metricOf(dto, 'mention-rate').from.denominator).toBe(2)
  })
})

describe('computeVisibilityCompare — provider-count robustness', () => {
  it('uses the per-snapshot rate, NOT an OR-over-providers per-query rate that inflates with provider count', () => {
    // 1 query, 4 providers, named by exactly one of them.
    const providers = ['openai', 'claude', 'gemini', 'perplexity']
    const mk = (mentioned: string) => providers.map((p) => snap({ queryId: 'q1', provider: p, answerMentioned: p === mentioned }))
    const dto = computeVisibilityCompare(build(mk('openai'), mk('claude')))
    // per-snapshot: 1 of 4 named = 0.25 (NOT 1.0 that "any provider named the query" would give)
    expect(metricOf(dto, 'mention-rate').from.point).toBe(0.25)
    // the per-QUERY count still reports 1 of 1 (the hero-compatible framing), kept separate
    expect(dto.queriesMentioned.from).toEqual({ count: 1, of: 1 })
  })
})

describe('computeVisibilityCompare — share of voice', () => {
  it('computes named SoV as project / (project + competitor) brand mentions, drift-robust flag set', () => {
    const competitors = [{ domain: 'rival.com', brandTokens: ['rival'] }]
    // 2 snapshots: project named + competitor "rival" present in prose.
    const s = () => snap({ queryId: 'q1', provider: 'openai', answerMentioned: true, answerText: 'we recommend Rival and demo' })
    const dto = computeVisibilityCompare(build([s(), s()], [s()], { competitors }))
    const sov = metricOf(dto, 'mention-share-of-voice')
    expect(sov.driftRobust).toBe(true)
    expect(sov.from).toMatchObject({ numerator: 2, denominator: 4, point: 0.5 }) // 2 proj / (2 proj + 2 comp)
    expect(dto.competitors.from).toEqual([{ domain: 'rival.com', mentions: 2 }])
  })

  it('computes cited SoV from citedDomains, matching a competitor stored as a raw mixed-case URL and a subdomain', () => {
    const competitors = [{ domain: 'https://Rival.com/', brandTokens: ['rival'] }]
    const from = [
      snap({ queryId: 'q1', provider: 'openai', citationState: 'cited', citedDomains: ['demo.com'] }), // project cited
      snap({ queryId: 'q1', provider: 'claude', citedDomains: ['rival.com'] }), // competitor cited (exact)
      snap({ queryId: 'q1', provider: 'gemini', citedDomains: ['blog.rival.com'] }), // competitor cited (subdomain)
    ]
    const to = [snap({ queryId: 'q1', provider: 'openai', citationState: 'cited', citedDomains: [] })]
    // keep providers in both so the basket doesn't drop them
    const toAll = [...to, snap({ queryId: 'q1', provider: 'claude' }), snap({ queryId: 'q1', provider: 'gemini' })]
    const dto = computeVisibilityCompare(build(from, toAll, { competitors }))
    const cs = metricOf(dto, 'cited-share-of-voice')
    // from: project cited = 1, competitor cited = 2 (exact + subdomain) -> 1 / (1+2)
    expect(cs.from).toMatchObject({ numerator: 1, denominator: 3, point: 0.3333 })
    expect(cs.driftRobust).toBe(true)
  })
})

describe('computeVisibilityCompare — no competitive frame', () => {
  it('degrades BOTH share-of-voice metrics to insufficient-data when no competitors are configured', () => {
    // With zero competitors the SoV denominator degenerates to the project's own
    // count, so cited-SoV would read a fabricated 100% ("you own the cited
    // conversation" with nobody to own it against). Both SoV metrics must
    // mirror buildMentionShare's refusal and report insufficient-data instead.
    const s = () =>
      snap({ queryId: 'q1', provider: 'openai', citationState: 'cited', answerMentioned: true, answerText: 'demo is great' })
    const dto = computeVisibilityCompare(build([s(), s()], [s()])) // competitors: [] (build default)
    for (const key of ['mention-share-of-voice', 'cited-share-of-voice'] as const) {
      const m = metricOf(dto, key)
      expect(m.verdict).toBe('insufficient-data')
      expect(m.from.point).toBeNull() // never a fabricated 100%
      expect(m.to.point).toBeNull()
    }
    // The absolute cited rate still reports the citations — the frame-free info lives there.
    expect(metricOf(dto, 'cited-rate').from.point).toBe(1)
  })
})

describe('computeVisibilityCompare — verdict', () => {
  const many = (queryId: string, provider: string, n: number, mentioned: number) =>
    Array.from({ length: n }, (_, i) => snap({ queryId, provider, answerMentioned: i < mentioned }))

  it('calls overlapping intervals within-noise', () => {
    // 2/100 vs 1/100 — wide overlapping Wilson intervals.
    const dto = computeVisibilityCompare(build(many('q1', 'openai', 100, 2), many('q1', 'openai', 100, 1)))
    expect(metricOf(dto, 'mention-rate').verdict).toBe('within-noise')
  })

  it('calls disjoint intervals moved', () => {
    // 0/100 vs 60/100 — non-overlapping.
    const dto = computeVisibilityCompare(build(many('q1', 'openai', 100, 0), many('q1', 'openai', 100, 60)))
    const m = metricOf(dto, 'mention-rate')
    expect(m.verdict).toBe('moved')
    expect(m.direction).toBe('up')
  })

  it('calls a period with no basket data insufficient-data', () => {
    const dto = computeVisibilityCompare(build([snap({ queryId: 'q1', provider: 'openai' })], []))
    for (const m of dto.metrics) expect(m.verdict).toBe('insufficient-data')
    expect(dto.basket.queryCount).toBe(0)
    expect(dto.continuity.status).toBe('insufficient-data')
  })
})

describe('computeVisibilityCompare — model continuity', () => {
  it('blocks directional metrics when every provider changed model between periods', () => {
    const from = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' })]
    const to = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.5' })]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.modelChanges).toEqual([{ provider: 'openai', fromModels: ['gpt-5.4'], toModels: ['gpt-5.5'] }])
    expect(dto.continuity).toEqual({
      status: 'model-discontinuous',
      comparedProviders: [],
      providers: [{ provider: 'openai', status: 'model-discontinuous', fromModels: ['gpt-5.4'], toModels: ['gpt-5.5'] }],
    })
    expect(dto.basket.providers).toEqual([])
    expect(dto.basket.excludedProviders).toContain('openai')
    for (const metric of dto.metrics) {
      expect(metric.verdict).toBe('model-discontinuous')
      expect(metric.direction).toBeNull()
    }
  })

  it('includes a provider whose model id is stable', () => {
    const from = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' })]
    const to = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' })]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.modelChanges).toEqual([])
    expect(dto.continuity).toEqual({
      status: 'comparable',
      comparedProviders: ['openai'],
      providers: [{ provider: 'openai', status: 'included', fromModels: ['gpt-5.4'], toModels: ['gpt-5.4'] }],
    })
  })

  it('blocks directional metrics when model ids are unknown on legacy rows', () => {
    const from = [snap({ queryId: 'q1', provider: 'openai', model: null })]
    const to = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.5' })]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.modelChanges).toEqual([])
    expect(dto.continuity).toEqual({
      status: 'model-unknown',
      comparedProviders: [],
      providers: [{ provider: 'openai', status: 'model-unknown', fromModels: [], toModels: ['gpt-5.5'] }],
    })
    for (const metric of dto.metrics) expect(metric.verdict).toBe('model-unknown')
  })

  it('blocks a provider that changes models mid-month, even when one model overlaps', () => {
    const from = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' })]
    const to = [
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.5' }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.continuity.providers).toEqual([
      { provider: 'openai', status: 'model-discontinuous', fromModels: ['gpt-5.4'], toModels: ['gpt-5.4', 'gpt-5.5'] },
    ])
    for (const metric of dto.metrics) expect(metric.verdict).toBe('model-discontinuous')
  })

  it('compares only stable providers while surfacing a discontinuous provider in analytics output', () => {
    const from = [
      snap({ queryId: 'q1', provider: 'claude', model: 'claude-4', answerMentioned: false }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4', answerMentioned: true }),
    ]
    const to = [
      snap({ queryId: 'q1', provider: 'claude', model: 'claude-4', answerMentioned: false }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.5', answerMentioned: false }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.continuity).toMatchObject({
      status: 'comparable',
      comparedProviders: ['claude'],
      providers: [
        { provider: 'claude', status: 'included' },
        { provider: 'openai', status: 'model-discontinuous' },
      ],
    })
    expect(dto.basket).toMatchObject({ providers: ['claude'] })
    expect(dto.basket.excludedProviders).toContain('openai')
    expect(metricOf(dto, 'mention-rate').from).toMatchObject({ numerator: 0, denominator: 1 })
    expect(metricOf(dto, 'mention-rate').to).toMatchObject({ numerator: 0, denominator: 1 })
  })

  it('excludes a provider whose only snapshots in one period sit on non-basket queries — no phantom rows, no spurious model change', () => {
    // openai is observed in BOTH periods pre-basket, but its `from` snapshots
    // are all on q1, which is not in the query basket (q1 is absent from `to`).
    // Deciding the provider basket pre-restriction would keep openai with 0-of-0
    // `from` counts and read ['gpt-5.4'] vs [] as a model change.
    const from = [
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' }),
      snap({ queryId: 'q2', provider: 'claude', model: 'claude-4' }),
    ]
    const to = [
      snap({ queryId: 'q2', provider: 'openai', model: 'gpt-5.4' }),
      snap({ queryId: 'q2', provider: 'claude', model: 'claude-4' }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.basket.providers).toEqual(['claude'])
    expect(dto.basket.excludedProviders).toContain('openai')
    expect(dto.modelChanges).toEqual([])
    expect(dto.byProvider.map((r) => r.provider)).toEqual(['claude'])
  })
})

describe('computeVisibilityCompare — low run count', () => {
  it('flags a period under the 5-sweep reliability floor', () => {
    const dto = computeVisibilityCompare(build([snap({ queryId: 'q1', provider: 'openai' })], [snap({ queryId: 'q1', provider: 'openai' })]))
    expect(dto.from.lowRunCount).toBe(false) // May: 7 sweeps
    expect(dto.to.lowRunCount).toBe(true) // June: 2 sweeps
  })
})

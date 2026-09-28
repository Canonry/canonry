import { describe, expect, it, vi } from 'vitest'
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
  it('uses current project identity for share while preserving historical named-rate counts', () => {
    const competitors = [{ domain: 'rival.com', brandTokens: ['rival'] }]
    const stale = snap({
      queryId: 'q1',
      provider: 'openai',
      answerMentioned: false,
      answerText: 'Demo and Rival are both options.',
    })
    const dto = computeVisibilityCompare(build([stale], [stale], { competitors, brandNames: ['demo'] }))

    expect(metricOf(dto, 'mention-share-of-voice').from).toMatchObject({
      numerator: 1,
      denominator: 2,
      point: 0.5,
    })
    expect(metricOf(dto, 'mention-rate').from).toMatchObject({ numerator: 0, denominator: 1, point: 0 })
  })

  it('computes named SoV as project / (project + competitor) brand mentions, drift-robust flag set', () => {
    const competitors = [{ domain: 'rival.com', brandTokens: ['rival'] }]
    // 2 snapshots: project named + competitor "rival" present in prose.
    const s = () => snap({ queryId: 'q1', provider: 'openai', answerMentioned: true, answerText: 'we recommend Rival and demo' })
    const dto = computeVisibilityCompare(build([s(), s()], [s()], { competitors, brandNames: ['demo'] }))
    const sov = metricOf(dto, 'mention-share-of-voice')
    expect(sov.driftRobust).toBe(true)
    expect(sov.queryClass).toBe('non-brand')
    expect(sov.from).toMatchObject({ numerator: 2, denominator: 4, point: 0.5 }) // 2 proj / (2 proj + 2 comp)
    expect(dto.competitors.from).toEqual([{ domain: 'rival.com', mentions: 2 }])
    expect(metricOf(dto, 'mention-rate').queryClass).toBe('all')
  })

  it('does not count a citation chip as a project or competitor mention in named SoV', () => {
    // Shape of an OpenAI web-search answer: both brands appear only in the
    // inline source chips, which are citations.
    const competitors = [{ domain: 'rival.com', brandTokens: ['rival'] }]
    const chips = 'Plans start at $20 a month. ([demo.com](https://demo.com/pricing?utm_source=chatgpt.com), [Rival](https://rival.com/pricing?utm_source=chatgpt.com))'
    const chipsOnly = () => snap({ queryId: 'q1', provider: 'openai', answerText: chips })
    const prose = () => snap({ queryId: 'q2', provider: 'openai', answerText: `Demo is the cheaper option. ${chips}` })
    const dto = computeVisibilityCompare(build([chipsOnly(), prose()], [chipsOnly(), prose()], { competitors, brandNames: ['demo'] }))

    expect(metricOf(dto, 'mention-share-of-voice').from).toMatchObject({ numerator: 1, denominator: 1, point: 1 })
    expect(dto.competitors.from).toEqual([])
  })

  it('labels named SoV pooled when no project identity can classify the basket', () => {
    const competitors = [{ domain: 'rival.com', brandTokens: ['rival'] }]
    const s = () => snap({ queryId: 'q1', provider: 'openai', answerText: 'Rival is one option.' })
    const dto = computeVisibilityCompare(build([s()], [s()], { competitors }))

    expect(metricOf(dto, 'mention-share-of-voice').queryClass).toBe('pooled')
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
    const dto = computeVisibilityCompare(build([s(), s()], [s()], { brandNames: ['demo'] }))
    for (const key of ['mention-share-of-voice', 'cited-share-of-voice'] as const) {
      const m = metricOf(dto, key)
      expect(m.verdict).toBe('insufficient-data')
      expect(m.from.point).toBeNull() // never a fabricated 100%
      expect(m.to.point).toBeNull()
      expect(m.from.availability).toBe('no-competitive-frame')
      expect(m.to.availability).toBe('no-competitive-frame')
      expect(m.from.numerator).toBe(2)
      expect(m.to.numerator).toBe(1)
      expect(m.from.denominator).toBe(0)
      expect(m.to.denominator).toBe(0)
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
    const dto = computeVisibilityCompare(build(
      [snap({ queryId: 'q1', provider: 'openai' })],
      [],
      { brandNames: ['demo'] },
    ))
    for (const m of dto.metrics) expect(m.verdict).toBe('insufficient-data')
    expect(metricOf(dto, 'mention-share-of-voice').queryClass).toBe('non-brand')
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

  it('blocks a provider whose period mixes a null-model snapshot with a known id (partial unknown evidence)', () => {
    // `from` has a legacy null-model row sitting BESIDE a gpt-5.4 row for the
    // same provider; `to` is a clean gpt-5.4. Counting only known ids would read
    // both sides as gpt-5.4 and mark the provider `included`, letting a
    // directional verdict ride on the null row's (unattributable) counts. The
    // null presence must force `model-unknown`.
    const from = [
      snap({ queryId: 'q1', provider: 'openai', model: null, answerMentioned: true }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4', answerMentioned: true }),
    ]
    const to = [snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4', answerMentioned: false })]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.continuity).toEqual({
      status: 'model-unknown',
      comparedProviders: [],
      providers: [{ provider: 'openai', status: 'model-unknown', fromModels: ['gpt-5.4'], toModels: ['gpt-5.4'] }],
    })
    // Known ids are equal, so it is NOT flagged as a model CHANGE — continuity is
    // the gate; modelChanges only tracks a changed configured id.
    expect(dto.modelChanges).toEqual([])
    expect(dto.basket.providers).toEqual([])
    for (const metric of dto.metrics) {
      expect(metric.verdict).toBe('model-unknown')
      expect(metric.direction).toBeNull()
    }
  })

  it('keeps a clean provider comparable while a null-mixed sibling is excluded as model-unknown', () => {
    // claude is a clean, stable gpt-analog; openai has a null row mixed with a
    // known id. The whole comparison must not be blocked — it proceeds over
    // claude, with openai surfaced (and excluded) as model-unknown.
    const from = [
      snap({ queryId: 'q1', provider: 'claude', model: 'claude-4' }),
      snap({ queryId: 'q1', provider: 'openai', model: null }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' }),
    ]
    const to = [
      snap({ queryId: 'q1', provider: 'claude', model: 'claude-4' }),
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.continuity).toMatchObject({
      status: 'comparable',
      comparedProviders: ['claude'],
      providers: [
        { provider: 'claude', status: 'included' },
        { provider: 'openai', status: 'model-unknown', fromModels: ['gpt-5.4'], toModels: ['gpt-5.4'] },
      ],
    })
    expect(dto.basket).toMatchObject({ providers: ['claude'] })
    expect(dto.basket.excludedProviders).toContain('openai')
    for (const metric of dto.metrics) expect(metric.verdict).not.toBe('model-unknown')
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

  it('reads model evidence only from pairs present in both months, so a one-month pair cannot flip a provider', () => {
    // OpenAI answered q1 on gpt-5.4 in May only; June has q1 from Gemini alone.
    // (q1, openai) is not a common pair, so its gpt-5.4 row says nothing about
    // the (q2, openai) comparison, which ran on gpt-5.5 in both months.
    const from = [
      snap({ queryId: 'q1', provider: 'openai', model: 'gpt-5.4' }),
      snap({ queryId: 'q2', provider: 'openai', model: 'gpt-5.5' }),
      snap({ queryId: 'q1', provider: 'gemini', model: 'gemini-2' }),
    ]
    const to = [
      snap({ queryId: 'q2', provider: 'openai', model: 'gpt-5.5' }),
      snap({ queryId: 'q1', provider: 'gemini', model: 'gemini-2' }),
    ]
    const dto = computeVisibilityCompare(build(from, to))
    expect(dto.continuity).toEqual({
      status: 'comparable',
      comparedProviders: ['gemini', 'openai'],
      providers: [
        { provider: 'gemini', status: 'included', fromModels: ['gemini-2'], toModels: ['gemini-2'] },
        { provider: 'openai', status: 'included', fromModels: ['gpt-5.5'], toModels: ['gpt-5.5'] },
      ],
    })
    expect(dto.modelChanges).toEqual([])
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

describe('computeVisibilityCompare — answer matching', () => {
  const picks = 'For teams, Demo Co and Rival are strong picks.'
  const pricing = 'Demo Co pricing starts at $10.'
  const row = (queryId: string | null, over: Partial<VisibilityCompareSnapshotInput> & { provider: string }) =>
    snap({ queryId: queryId as string, model: over.provider === 'claude' ? 'claude-a' : `${over.provider}-stable`, ...over })
  const input = (from: VisibilityCompareSnapshotInput[], to: VisibilityCompareSnapshotInput[]): ComputeVisibilityCompareInput => ({
    project: 'demo',
    queries: [
      { id: 'q-cat', query: 'best project tools' },
      { id: 'q-alt', query: 'project tools for teams' },
      { id: 'q-brand', query: 'Demo Co pricing' },
    ],
    brandNames: ['Demo Co', 'democo'],
    competitors: [
      { domain: 'rival.io', brandTokens: ['rival', 'rival.io'] },
      { domain: 'https://Other-Tool.com/', brandTokens: ['Other Tool', 'other-tool.com'] },
    ],
    from: { month: '2026-05', since: '2026-05-01T00:00:00.000Z', until: '2026-05-31T23:59:59.999Z', runCount: 7, snapshots: from },
    to: { month: '2026-06', since: '2026-06-01T00:00:00.000Z', until: '2026-06-30T23:59:59.999Z', runCount: 5, snapshots: to },
  })

  it('pins the whole response across brand variants, near-miss words, text-less rows and an excluded provider', () => {
    const from = [
      row('q-cat', { provider: 'openai', answerText: picks, answerMentioned: true, citationState: 'cited', citedDomains: ['democo.com', 'rival.io'] }),
      row('q-cat', { provider: 'gemini', answerText: 'Consider RIVAL.io or other-tool.com for this.', citedDomains: ['www.other-tool.com'] }),
      // Accent and hyphen are presentation variants of the alias; `Democracy` is not.
      row('q-alt', { provider: 'openai', answerText: 'Democracy tools are popular; démo-co is listed too.' }),
      row('q-alt', { provider: 'gemini', answerText: null, answerMentioned: true }),
      row('q-brand', { provider: 'openai', answerText: pricing, answerMentioned: true }),
      row('q-brand', { provider: 'gemini', answerText: '', answerMentioned: null }),
      row('q-cat', { provider: 'claude', answerText: 'Rival leads.' }),
      row('q-alt', { provider: 'claude', answerText: 'Nothing here.' }),
      row('q-cat', { provider: 'openai', answerText: 'Other Tool is fine; DemoCo too.', answerMentioned: true }),
      row('q-cat', { provider: 'gemini', answerText: picks, answerMentioned: true }),
      // Attributed by preserved text; `rivalry` is not the competitor `rival`.
      row(null, { queryText: 'project tools for teams', provider: 'openai', answerText: 'A rivalry is not a competitor mention.' }),
      row('q-brand', { provider: 'openai', answerText: pricing, answerMentioned: true }),
      row('q-cat', { provider: 'claude', answerText: 'Demo Co.' }),
      row('q-gone', { provider: 'openai', answerText: 'Rival and Demo Co.', answerMentioned: true }),
    ]
    const to = [
      row('q-cat', { provider: 'openai', answerText: 'Rival and Other Tool lead; Demo Co trails.', answerMentioned: true, citationState: 'cited', citedDomains: ['democo.com'] }),
      row('q-cat', { provider: 'gemini', answerText: 'Rival only.', citedDomains: ['rival.io'] }),
      row('q-alt', { provider: 'openai', answerText: 'DEMO CO is recommended for teams.', answerMentioned: true }),
      row('q-alt', { provider: 'gemini', answerText: 'No brands.' }),
      row('q-brand', { provider: 'openai', answerText: 'Demo Co pricing is flexible.', answerMentioned: true, citationState: 'cited', citedDomains: ['democo.com'] }),
      row('q-brand', { provider: 'gemini', answerText: 'Demo Co vs Rival pricing.', answerMentioned: true }),
      row('q-cat', { provider: 'claude', model: 'claude-b', answerText: 'Demo Co leads.' }),
      row('q-alt', { provider: 'claude', model: 'claude-b', answerText: 'Rival.' }),
    ]
    const dto = computeVisibilityCompare(input(from, to))

    // Non-brand May answers: the project is named in 4 (Demo Co, démo-co,
    // DemoCo, Demo Co), Rival in 3 and Other Tool in 2, so share is 4 / 9.
    // June: project 2, Rival 2, Other Tool 1, so 2 / 5. Claude changed model,
    // so it is excluded from every metric but still reported.
    expect(dto).toEqual({
      project: 'demo',
      from: { month: '2026-05', since: '2026-05-01T00:00:00.000Z', until: '2026-05-31T23:59:59.999Z', runCount: 7, lowRunCount: false },
      to: { month: '2026-06', since: '2026-06-01T00:00:00.000Z', until: '2026-06-30T23:59:59.999Z', runCount: 5, lowRunCount: false },
      basket: { queryCount: 3, excludedFromOnly: 0, excludedToOnly: 0, providers: ['gemini', 'openai'], excludedProviders: ['claude'] },
      metrics: [
        {
          key: 'mention-share-of-voice', label: 'Named share of voice', queryClass: 'non-brand', driftRobust: true,
          from: { availability: 'available', point: 0.4444, ciLow: 0.1888, ciHigh: 0.7334, numerator: 4, denominator: 9 },
          to: { availability: 'available', point: 0.4, ciLow: 0.1176, ciHigh: 0.7693, numerator: 2, denominator: 5 },
          rateRatio: 0.9, direction: 'down', verdict: 'within-noise',
        },
        {
          key: 'cited-share-of-voice', label: 'Cited share of voice', queryClass: 'all', driftRobust: true,
          from: { availability: 'available', point: 0.3333, ciLow: 0.0615, ciHigh: 0.7923, numerator: 1, denominator: 3 },
          to: { availability: 'available', point: 0.6667, ciLow: 0.2077, ciHigh: 0.9385, numerator: 2, denominator: 3 },
          rateRatio: 2, direction: 'up', verdict: 'within-noise',
        },
        {
          key: 'mention-rate', label: 'Named rate', queryClass: 'all', driftRobust: false,
          from: { availability: 'available', point: 0.6667, ciLow: 0.3542, ciHigh: 0.8794, numerator: 6, denominator: 9 },
          to: { availability: 'available', point: 0.6667, ciLow: 0.3, ciHigh: 0.9032, numerator: 4, denominator: 6 },
          rateRatio: 1, direction: 'flat', verdict: 'within-noise',
        },
        {
          key: 'cited-rate', label: 'Cited rate', queryClass: 'all', driftRobust: false,
          from: { availability: 'available', point: 0.1, ciLow: 0.0179, ciHigh: 0.4042, numerator: 1, denominator: 10 },
          to: { availability: 'available', point: 0.3333, ciLow: 0.0968, ciHigh: 0.7, numerator: 2, denominator: 6 },
          rateRatio: 3.33, direction: 'up', verdict: 'within-noise',
        },
      ],
      queriesMentioned: { from: { count: 3, of: 3 }, to: { count: 3, of: 3 } },
      byProvider: [
        { provider: 'gemini', from: { checked: 3, mentioned: 2, cited: 0 }, to: { checked: 3, mentioned: 1, cited: 0 } },
        { provider: 'openai', from: { checked: 6, mentioned: 4, cited: 1 }, to: { checked: 3, mentioned: 3, cited: 2 } },
      ],
      modelChanges: [{ provider: 'claude', fromModels: ['claude-a'], toModels: ['claude-b'] }],
      continuity: {
        status: 'comparable', comparedProviders: ['gemini', 'openai'],
        providers: [
          { provider: 'claude', status: 'model-discontinuous', fromModels: ['claude-a'], toModels: ['claude-b'] },
          { provider: 'gemini', status: 'included', fromModels: ['gemini-stable'], toModels: ['gemini-stable'] },
          { provider: 'openai', status: 'included', fromModels: ['openai-stable'], toModels: ['openai-stable'] },
        ],
      },
      competitors: {
        from: [{ domain: 'rival.io', mentions: 3 }, { domain: 'https://Other-Tool.com/', mentions: 2 }],
        to: [{ domain: 'rival.io', mentions: 2 }, { domain: 'https://Other-Tool.com/', mentions: 1 }],
      },
    })
  })

  it('walks each compared answer at most twice: once for the project, once for every competitor', () => {
    // Every answer names the project and both competitors, so each match needs
    // a full word walk. The pre-continuity basket feeds the model gate only,
    // so Claude's excluded answers are never matched.
    const answer = (n: number) => `Answer ${n}: Demo Co, Rival and Other Tool are reviewed here.`
    const month = (offset: number, model: string) => ['q-cat', 'q-alt'].flatMap((queryId, q) =>
      ['openai', 'gemini'].map((provider, p) => row(queryId, { provider, model: `${provider}-${model}`, answerText: answer(offset + q * 2 + p) })))
    const from = [...month(0, 'stable'), row('q-cat', { provider: 'claude', answerText: answer(8) })]
    const to = [...month(4, 'stable'), row('q-cat', { provider: 'claude', model: 'claude-b', answerText: answer(9) })]
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment')
    try {
      const dto = computeVisibilityCompare(input(from, to))
      // 4 project mentions against 4 Rival + 4 Other Tool mentions per month.
      expect(metricOf(dto, 'mention-share-of-voice').from).toMatchObject({ numerator: 4, denominator: 12 })
      const walked = segment.mock.calls.map(([text]) => String(text)).filter(text => text.startsWith('answer '))
      // 8 compared answers (2 queries x 2 engines x 2 months), 2 walks each.
      expect(walked.length).toBeLessThanOrEqual(16)
      expect(walked.some(text => text.startsWith('answer 8:') || text.startsWith('answer 9:'))).toBe(false)
    } finally {
      segment.mockRestore()
    }
  })
})

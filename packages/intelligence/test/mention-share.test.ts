import { describe, expect, it } from 'vitest'
import { buildMentionShare, type MentionShareSnapshot, type MentionShareCompetitor } from '../src/mention-share.js'

function snap(projectMentioned: boolean, answerText: string): MentionShareSnapshot {
  return { projectMentioned, answerText }
}

const rivalA: MentionShareCompetitor = { domain: 'rival-a.com', brandTokens: ['rival'] }
const rivalB: MentionShareCompetitor = { domain: 'rival-b.com', brandTokens: ['otherbrand'] }
const baseOpts = { competitors: [rivalA] }

describe('buildMentionShare', () => {
  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildMentionShare([], baseOpts)
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.breakdown.snapshotsTotal).toBe(0)
    expect(result.scope).toBe('pooled')
  })

  it('keeps an empty classifiable window scoped to non-brand', () => {
    const result = buildMentionShare([], { ...baseOpts, classificationAvailable: true })
    expect(result.value).toBe('No data')
    expect(result.scope).toBe('non-brand')
    expect(result.breakdown.snapshotsTotal).toBe(0)
  })

  it('returns "Add competitors" while preserving class scope and observed counts', () => {
    const result = buildMentionShare([
      { projectMentioned: true, answerText: 'You are great', queryClass: 'non-brand' },
      { projectMentioned: true, answerText: 'Your branded answer', queryClass: 'branded' },
    ], { competitors: [] })
    expect(result.value).toBe('Add competitors')
    expect(result.tone).toBe('neutral')
    expect(result.delta).toMatch(/No competitors configured/i)
    expect(result.scope).toBe('non-brand')
    expect(result.breakdown).toMatchObject({
      projectMentionSnapshots: 1,
      competitorMentionSnapshots: 0,
      snapshotsWithAnswerText: 1,
      snapshotsTotal: 1,
      score: null,
    })
    expect(result.branded).toMatchObject({
      projectMentionSnapshots: 1,
      competitorMentionSnapshots: 0,
      snapshotsWithAnswerText: 1,
      snapshotsTotal: 1,
      score: null,
    })
  })

  it('returns an unavailable state, not 0%, when no brand mentions are detected', () => {
    const result = buildMentionShare(
      [snap(false, 'Some unrelated answer with no brand mentions.')],
      baseOpts,
    )
    expect(result.value).toBe('No mentions')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
    expect(result.breakdown.score).toBeNull()
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
    expect(result.breakdown.competitorMentionSnapshots).toBe(0)
    expect(result.delta).toBe('No brand mentions in this run · pooled queries · classification unavailable')
  })

  it('100% when only project is mentioned, no competitors surface', () => {
    const result = buildMentionShare(
      [snap(true, 'Some answer.'), snap(true, 'Another.')],
      baseOpts,
    )
    expect(result.value).toBe('100%')
    expect(result.progress).toBe(100)
    expect(result.tone).toBe('positive')
  })

  it('50% when project and one competitor each mention in 1 of 2 snapshots', () => {
    const result = buildMentionShare(
      [
        snap(true, 'Your domain answer text here.'),
        snap(false, 'Some answer that mentions Rival in the text.'),
      ],
      baseOpts,
    )
    expect(result.value).toBe('50.0%')
    expect(result.progress).toBe(50)
    expect(result.tone).toBe('positive')
    expect(result.breakdown.projectMentionSnapshots).toBe(1)
    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
  })

  it('per-competitor breakdown ranks by mention count and computes share-of-competitive-total', () => {
    // 2 competitors: rival-a mentioned in 4 snapshots, rival-b in 2 → 4+2=6 competitive
    const snaps: MentionShareSnapshot[] = []
    for (let i = 0; i < 4; i++) snaps.push(snap(true, `Talking about Rival here #${i}`))
    for (let i = 0; i < 2; i++) snaps.push(snap(false, `Praising OtherBrand and similar #${i}`))
    const result = buildMentionShare(snaps, { competitors: [rivalA, rivalB] })
    expect(result.breakdown.perCompetitor).toEqual([
      { domain: 'rival-a.com', mentionSnapshots: 4, shareOfCompetitiveTotal: 66.67 },
      { domain: 'rival-b.com', mentionSnapshots: 2, shareOfCompetitiveTotal: 33.33 },
    ])
    expect(result.value).toBe('40.0%') // 4 project / (4 + 6) = 40
    expect(result.breakdown.score).toBe(40)
  })

  it('respects word-boundary matching: brand token "rival" does NOT match "Survival"', () => {
    const result = buildMentionShare(
      [snap(false, 'A story of survival and grit.')],
      baseOpts,
    )
    expect(result.breakdown.competitorMentionSnapshots).toBe(0)
  })

  it('counts a snapshot once regardless of how many times the brand appears', () => {
    const result = buildMentionShare(
      [snap(false, 'Rival here. Rival there. Rival everywhere. Rival forever.')],
      baseOpts,
    )
    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
  })

  it('skips empty / null answer text', () => {
    const snaps: MentionShareSnapshot[] = [
      { projectMentioned: true, answerText: null },
      { projectMentioned: false, answerText: '' },
      snap(true, 'Real answer.'),
    ]
    const result = buildMentionShare(snaps, baseOpts)
    expect(result.breakdown.snapshotsWithAnswerText).toBe(1)
    expect(result.breakdown.snapshotsTotal).toBe(3)
  })

  it('drops brand tokens shorter than 3 characters (too noisy)', () => {
    const result = buildMentionShare(
      [snap(false, 'The AI answer mentions ai a lot.')],
      { competitors: [{ domain: 'ai.com', brandTokens: ['ai'] }] },
    )
    expect(result.breakdown.competitorMentionSnapshots).toBe(0)
  })

  it('tone bands: ≥50 positive, 25-49 caution, <25 negative', () => {
    // 50% — positive
    expect(buildMentionShare(
      [snap(true, 'a'), snap(false, 'Rival')],
      baseOpts,
    ).tone).toBe('positive')

    // 33% — caution (1 project, 2 competitor)
    expect(buildMentionShare(
      [snap(true, 'a'), snap(false, 'Rival 1'), snap(false, 'Rival 2')],
      baseOpts,
    ).tone).toBe('caution')

    // ~17% (1/6) — negative
    const snaps: MentionShareSnapshot[] = [snap(true, 'a')]
    for (let i = 0; i < 5; i++) snaps.push(snap(false, `Rival ${i}`))
    expect(buildMentionShare(snaps, baseOpts).tone).toBe('negative')
  })

  it('tolerates spacing / hyphenation variants via brand-key match (demand-iq token matches "Demand IQ" prose)', () => {
    // Mirrors `extractAnswerMentions` brand-key normalization so the
    // competitor matcher and project matcher stay in lockstep.
    const competitor: MentionShareCompetitor = { domain: 'demand-iq.com', brandTokens: ['demand-iq'] }
    const variants = [
      'Demand IQ is a leading solar CRM.',           // space-separated
      'DemandIQ integrates with rooftop scanners.',   // concatenated
      'demand-iq.com is the URL to check out.',       // hyphenated, exact match
    ]
    for (const text of variants) {
      const result = buildMentionShare([snap(false, text)], { competitors: [competitor] })
      expect(result.breakdown.competitorMentionSnapshots).toBe(1)
    }
  })

  it('trusts projectMentioned as-is — does not re-scan answer text for project brand', () => {
    // Invariant: if the project-side extractor said "not mentioned" but the
    // answer prose contains the brand, we still trust the extractor. Project
    // matching is owned by `extractAnswerMentions`; this helper just consumes
    // the boolean so the two definitions cannot drift.
    const result = buildMentionShare(
      [snap(false, 'Acme Corp powers half the answer engines on the market.')],
      { competitors: [{ domain: 'rival.com', brandTokens: ['rival'] }] },
    )
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
  })

  it('emits negative tone when project never mentioned but competitor surfaces (5/0 split)', () => {
    // The "zero project" + "real competitor" path was previously absorbed
    // by the 0/0 neutral branch — verify the tone band actually fires.
    const snaps: MentionShareSnapshot[] = []
    for (let i = 0; i < 5; i++) snaps.push(snap(false, `Rival update ${i}`))
    const result = buildMentionShare(snaps, baseOpts)
    expect(result.value).toBe('0%')
    expect(result.breakdown.score).toBe(0)
    expect(result.tone).toBe('negative')
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
    expect(result.breakdown.competitorMentionSnapshots).toBe(5)
  })

  it('shareOfCompetitiveTotal rows sum to ≈100 (within ±0.02 for three-way splits)', () => {
    // Three competitors each mentioned in 1 snapshot → each gets 33.33%.
    // Two-decimal rounding gives 33.33 × 3 = 99.99.
    // Assert the residual stays within a tight band so an agent consumer
    // can rely on "approximately 100" without exact arithmetic.
    const competitors: MentionShareCompetitor[] = [
      { domain: 'one.com', brandTokens: ['oneco'] },
      { domain: 'two.com', brandTokens: ['twoco'] },
      { domain: 'three.com', brandTokens: ['threeco'] },
    ]
    const snaps: MentionShareSnapshot[] = [
      snap(false, 'OneCo announcement'),
      snap(false, 'TwoCo announcement'),
      snap(false, 'ThreeCo announcement'),
    ]
    const result = buildMentionShare(snaps, { competitors })
    expect(result.breakdown.perCompetitor.map(r => r.shareOfCompetitiveTotal)).toEqual([33.33, 33.33, 33.33])
    const total = result.breakdown.perCompetitor.reduce((sum, r) => sum + r.shareOfCompetitiveTotal, 0)
    expect(total).toBeCloseTo(99.99, 10)
    expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.02)
  })

  it('demand-iq replication: project gets crushed by competitors (5 vs 92 across 15 competitors)', () => {
    // Mirrors the empirical finding from the 2026-07 SoV rework analysis.
    const competitors: MentionShareCompetitor[] = [
      { domain: 'roofr.com', brandTokens: ['roofr'] },
      { domain: 'buildxact.com', brandTokens: ['buildxact'] },
    ]
    const snaps: MentionShareSnapshot[] = []
    for (let i = 0; i < 5; i++) snaps.push(snap(true, `Demand-iq answer ${i}`))
    for (let i = 0; i < 20; i++) snaps.push(snap(false, `Talking about Roofr software ${i}`))
    for (let i = 0; i < 13; i++) snaps.push(snap(false, `BuildXact integration story ${i}`))
    const result = buildMentionShare(snaps, { competitors })
    // 5 / 38 = 13.157…%: two decimals on the wire, one decimal in `value`.
    expect(result.breakdown.score).toBe(13.16)
    expect(result.progress).toBe(13.16)
    expect(result.value).toBe('13.2%')
    expect(result.tone).toBe('negative')
    expect(result.breakdown.perCompetitor[0]!.domain).toBe('roofr.com')
    expect(result.breakdown.perCompetitor[0]!.mentionSnapshots).toBe(20)
  })
})

describe('buildMentionShare — branded vs non-brand are never pooled', () => {
  // The shape of a real basket that exposed the bug, with the identities
  // replaced: 13 queries × 4 providers = 52 snapshots, 5 of the queries
  // branded. The project is named in EVERY branded answer and in ~none of the
  // category answers; competitors can only ever surface on the category ones.
  // `cee` is deliberately a 3-letter brand — see the alias-floor test below.
  const RIVALS: MentionShareCompetitor[] = [
    { domain: 'rival-one.example', brandTokens: ['rivalone'] },
    { domain: 'rival-two.example', brandTokens: ['rivaltwo'] },
    { domain: 'cee.example', brandTokens: ['cee'] },
    { domain: 'rival-four.example', brandTokens: ['rivalfour'] },
  ]

  function lopsidedBasket(): MentionShareSnapshot[] {
    const snaps: MentionShareSnapshot[] = []
    // 5 branded queries × 4 providers: project named in all 20, no competitor named.
    for (let i = 0; i < 20; i++) {
      snaps.push({ projectMentioned: true, answerText: `Acme Tanks makes ribbed tanks (${i}).`, queryClass: 'branded' })
    }
    // 8 category queries × 4 providers = 32. Project named in exactly one;
    // competitors named across the rest.
    snaps.push({ projectMentioned: true, answerText: 'Acme Tanks is one option here.', queryClass: 'non-brand' })
    for (let i = 0; i < 9; i++) {
      snaps.push({ projectMentioned: false, answerText: `RivalOne is the pick (${i}).`, queryClass: 'non-brand' })
    }
    for (let i = 0; i < 6; i++) {
      snaps.push({ projectMentioned: false, answerText: `RivalTwo leads here (${i}).`, queryClass: 'non-brand' })
    }
    for (let i = 0; i < 5; i++) {
      snaps.push({ projectMentioned: false, answerText: `Cee is the value pick (${i}).`, queryClass: 'non-brand' })
    }
    for (let i = 0; i < 4; i++) {
      snaps.push({ projectMentioned: false, answerText: `RivalFour is worth a look (${i}).`, queryClass: 'non-brand' })
    }
    // 8 snapshots that named nobody, filling out the 32-snapshot category half.
    for (let i = 0; i < 7; i++) {
      snaps.push({ projectMentioned: false, answerText: `Consider fit and fabric (${i}).`, queryClass: 'non-brand' })
    }
    return snaps
  }

  it('ranks the subject LAST on non-brand queries even though it is named in 100% of branded answers', () => {
    const result = buildMentionShare(lopsidedBasket(), { competitors: RIVALS })

    // The headline is the non-brand figure, and it is last place.
    expect(result.scope).toBe('non-brand')
    expect(result.breakdown.projectMentionSnapshots).toBe(1)
    expect(result.breakdown.competitorMentionSnapshots).toBe(24)
    expect(result.breakdown.score).toBe(4) // 1 / 25 = 4%
    expect(result.value).toBe('4.0%')
    expect(result.tone).toBe('negative')

    // THE INVARIANT: every tracked competitor outranks the subject.
    const ranked = [
      { domain: 'you', mentions: result.breakdown.projectMentionSnapshots },
      ...result.breakdown.perCompetitor.map(c => ({ domain: c.domain, mentions: c.mentionSnapshots })),
    ].sort((a, b) => b.mentions - a.mentions)
    expect(ranked.at(-1)!.domain).toBe('you')
    expect(ranked.map(r => r.domain)).toEqual(['rival-one.example', 'rival-two.example', 'cee.example', 'rival-four.example', 'you'])

    // Branded is reported, separately, and is not in the figure above.
    expect(result.branded.projectMentionSnapshots).toBe(20)
    expect(result.branded.competitorMentionSnapshots).toBe(0)
    expect(result.branded.score).toBe(100)
    expect(result.branded.snapshotsTotal).toBe(20)
  })

  it('the SAME basket pooled would have ranked the subject FIRST — which is why the split exists', () => {
    // Strip the classification and the identical snapshots invert the ranking.
    const pooled = buildMentionShare(
      lopsidedBasket().map(s => ({ projectMentioned: s.projectMentioned, answerText: s.answerText })),
      { competitors: RIVALS },
    )
    expect(pooled.scope).toBe('pooled')
    expect(pooled.breakdown.projectMentionSnapshots).toBe(21)
    expect(pooled.breakdown.competitorMentionSnapshots).toBe(24)
    expect(pooled.breakdown.score).toBe(46.67) // 21 / 45, two decimals, not 47
    expect(pooled.value).toBe('46.7%')
    expect(pooled.delta).toBe('21 of 45 brand mentions · pooled queries · classification unavailable')
    const topCompetitor = pooled.breakdown.perCompetitor[0]!
    expect(pooled.breakdown.projectMentionSnapshots).toBeGreaterThan(topCompetitor.mentionSnapshots)
  })

  it('the two classes are disjoint: snapshot counts partition, and no mention is counted twice', () => {
    const snaps = lopsidedBasket()
    const result = buildMentionShare(snaps, { competitors: RIVALS })
    expect(result.breakdown.snapshotsTotal + result.branded.snapshotsTotal).toBe(snaps.length)
    expect(result.breakdown.snapshotsTotal).toBe(32)
    expect(result.branded.snapshotsTotal).toBe(20)
    // Project mentions partition too: 1 non-brand + 20 branded = the 21 in the run.
    expect(result.breakdown.projectMentionSnapshots + result.branded.projectMentionSnapshots).toBe(21)
  })

  it('a partially-classified basket never folds the unclassified rows into the competitive figure', () => {
    const result = buildMentionShare(
      [
        { projectMentioned: false, answerText: 'Rival is the pick.', queryClass: 'non-brand' },
        { projectMentioned: true, answerText: 'Acme is great.', queryClass: 'branded' },
        // No class — must not silently join the non-brand denominator.
        { projectMentioned: true, answerText: 'Acme again.', queryClass: null },
      ],
      { competitors: [{ domain: 'rival-a.com', brandTokens: ['rival'] }] },
    )
    expect(result.scope).toBe('non-brand')
    expect(result.breakdown.snapshotsTotal).toBe(1)
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
    expect(result.breakdown.score).toBe(0)
  })

  it('an all-branded basket says so rather than reporting a 100% competitive score', () => {
    const result = buildMentionShare(
      [
        { projectMentioned: true, answerText: 'Acme is an activewear brand.', queryClass: 'branded' },
        { projectMentioned: true, answerText: 'Acme runs small.', queryClass: 'branded' },
      ],
      { competitors: [{ domain: 'rival-a.com', brandTokens: ['rival'] }] },
    )
    expect(result.value).toBe('No non-brand queries')
    expect(result.tone).toBe('neutral')
    expect(result.breakdown.score).toBeNull()
    expect(result.branded.score).toBe(100)
    expect(result.delta).toBe('2 branded snapshots only')
  })

  it('distinguishes non-brand queries with no answer text from having no non-brand queries', () => {
    const result = buildMentionShare(
      [
        { projectMentioned: false, answerText: null, queryClass: 'non-brand' },
        { projectMentioned: true, answerText: 'Acme is known by name.', queryClass: 'branded' },
      ],
      { competitors: [{ domain: 'rival-a.com', brandTokens: ['rival'] }] },
    )
    expect(result.value).toBe('No non-brand answers')
    expect(result.delta).toBe('1 branded answer only')
    expect(result.description).toContain('Non-brand queries are tracked')
    expect(result.breakdown.snapshotsTotal).toBe(1)
    expect(result.breakdown.snapshotsWithAnswerText).toBe(0)
  })

  it('the delta and description name the class, so a number is never read as the other one', () => {
    const result = buildMentionShare(lopsidedBasket(), { competitors: RIVALS })
    expect(result.delta).toBe('1 of 25 brand mentions · non-brand queries')
    expect(result.description).toContain('on non-brand queries')
    // 1 of 25 is 4 on the wire; the sentence prints it through the shared percent rule.
    expect(result.description).toMatch(/^4\.0% of brand mentions on non-brand queries are you\. Top competitor: /)
    expect(result.description).toContain('20 of 20 answers to queries that contain your name')
  })

  it('score is null (not 0) when a class had no brand mentions at all', () => {
    const result = buildMentionShare(
      [{ projectMentioned: false, answerText: 'Nobody named here.', queryClass: 'non-brand' }],
      { competitors: [{ domain: 'rival-a.com', brandTokens: ['rival'] }] },
    )
    expect(result.breakdown.score).toBeNull()
    expect(result.value).toBe('No mentions')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
  })

  it('a 3-character brand is matched — the alias floor is 3, and it is the same floor everywhere', () => {
    // Real 3-letter brands exist, and the floor used to differ between this
    // metric (>=3) and the stored competitor_overlap writer (>=4), so one
    // surface counted such a brand and the other silently dropped it.
    const cee = [{ domain: 'cee.example', brandTokens: ['cee'] }]
    const result = buildMentionShare(
      [{ projectMentioned: false, answerText: 'Cee is beloved by editors.', queryClass: 'non-brand' }],
      { competitors: cee },
    )
    expect(result.breakdown.competitorMentionSnapshots).toBe(1)
    // Word-boundary matching, not substring: "ceexample" is not Cee.
    const noMatch = buildMentionShare(
      [{ projectMentioned: false, answerText: 'Ceexample and skincare.', queryClass: 'non-brand' }],
      { competitors: cee },
    )
    expect(noMatch.breakdown.competitorMentionSnapshots).toBe(0)
  })
})

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
  })

  it('returns "Add competitors" tone:neutral when no competitors are configured', () => {
    const result = buildMentionShare([snap(true, 'You are great')], { competitors: [] })
    expect(result.value).toBe('Add competitors')
    expect(result.tone).toBe('neutral')
    expect(result.delta).toMatch(/No competitors configured/i)
  })

  it('returns 0 with neutral tone when no brand mentions detected', () => {
    const result = buildMentionShare(
      [snap(false, 'Some unrelated answer with no brand mentions.')],
      baseOpts,
    )
    expect(result.value).toBe('0')
    expect(result.tone).toBe('neutral')
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
    expect(result.breakdown.competitorMentionSnapshots).toBe(0)
  })

  it('100% when only project is mentioned, no competitors surface', () => {
    const result = buildMentionShare(
      [snap(true, 'Some answer.'), snap(true, 'Another.')],
      baseOpts,
    )
    expect(result.value).toBe('100')
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
    expect(result.value).toBe('50')
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
      { domain: 'rival-a.com', mentionSnapshots: 4, shareOfCompetitiveTotal: 66.7 },
      { domain: 'rival-b.com', mentionSnapshots: 2, shareOfCompetitiveTotal: 33.3 },
    ])
    expect(result.value).toBe('40') // 4 project / (4 + 6) = 40
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
    expect(result.value).toBe('0')
    expect(result.tone).toBe('negative')
    expect(result.breakdown.projectMentionSnapshots).toBe(0)
    expect(result.breakdown.competitorMentionSnapshots).toBe(5)
  })

  it('shareOfCompetitiveTotal rows sum to ≈100 (within ±0.2 for three-way splits)', () => {
    // Three competitors each mentioned in 1 snapshot → each gets ~33.3%.
    // Rounding gives 33.3 × 3 = 99.9 (or 100.1 depending on direction).
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
    const total = result.breakdown.perCompetitor.reduce((sum, r) => sum + r.shareOfCompetitiveTotal, 0)
    expect(total).toBeGreaterThanOrEqual(99.8)
    expect(total).toBeLessThanOrEqual(100.2)
  })

  it('demand-iq replication: project gets crushed by competitors (5 vs 92 across 15 competitors)', () => {
    // Mirrors the empirical finding from plans/sov-rework-analysis.md.
    const competitors: MentionShareCompetitor[] = [
      { domain: 'roofr.com', brandTokens: ['roofr'] },
      { domain: 'buildxact.com', brandTokens: ['buildxact'] },
    ]
    const snaps: MentionShareSnapshot[] = []
    for (let i = 0; i < 5; i++) snaps.push(snap(true, `Demand-iq answer ${i}`))
    for (let i = 0; i < 20; i++) snaps.push(snap(false, `Talking about Roofr software ${i}`))
    for (let i = 0; i < 13; i++) snaps.push(snap(false, `BuildXact integration story ${i}`))
    const result = buildMentionShare(snaps, { competitors })
    expect(result.value).toBe('13') // 5 / 38
    expect(result.tone).toBe('negative')
    expect(result.breakdown.perCompetitor[0]!.domain).toBe('roofr.com')
    expect(result.breakdown.perCompetitor[0]!.mentionSnapshots).toBe(20)
  })
})

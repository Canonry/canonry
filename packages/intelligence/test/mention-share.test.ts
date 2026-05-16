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

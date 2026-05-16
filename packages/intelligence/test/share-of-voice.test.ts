import { describe, expect, it } from 'vitest'
import {
  buildShareOfVoice,
  computeShareOfVoiceBreakdown,
  type ShareOfVoiceSnapshot,
} from '../src/share-of-voice.js'

function snap(citedDomains: string[] = []): ShareOfVoiceSnapshot {
  return { citedDomains }
}

const defaultOpts = { projectDomains: ['mine.com'], competitorDomains: [] }

describe('buildShareOfVoice', () => {
  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildShareOfVoice([], defaultOpts)
    expect(result.label).toBe('Share of Voice')
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
  })

  it('returns 0 with a neutral tone when no citations were produced', () => {
    const result = buildShareOfVoice([snap([])], defaultOpts)
    expect(result.value).toBe('0')
    expect(result.tone).toBe('neutral')
    expect(result.delta).toMatch(/no citations/i)
    // The description should clarify SoV is citation-only and that mention
    // can still be non-zero — important for operators looking at a 0% SoV.
    expect(result.description).toMatch(/Mention Coverage/i)
  })

  it('reports 100% when every citation slot is the project', () => {
    const result = buildShareOfVoice(
      [snap(['mine.com']), snap(['mine.com'])],
      defaultOpts,
    )
    expect(result.value).toBe('100')
    expect(result.delta).toBe('2 of 2 cited slots')
    expect(result.tone).toBe('positive')
  })

  it('dilutes when project shares the citation list with other sources', () => {
    const result = buildShareOfVoice(
      [snap(['mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com'])],
      defaultOpts,
    )
    expect(result.value).toBe('10')
    expect(result.delta).toBe('1 of 10 cited slots')
  })

  it('matches subdomains of the project canonical', () => {
    const result = buildShareOfVoice(
      [snap(['docs.mine.com', 'rival.com'])],
      defaultOpts,
    )
    expect(result.value).toBe('50')
  })

  it('classifies competitor subdomains correctly (the bug the audit caught)', () => {
    // Cited domain is a subdomain of a configured competitor; should classify
    // as competitor, not other. Pre-audit this was misclassified because SoV
    // checked against the pre-computed competitorOverlap (which only carries
    // the registered root domain, losing the subdomain match).
    const result = buildShareOfVoice(
      [snap(['mine.com', 'offers.roofle.com', 'wikipedia.org'])],
      { projectDomains: ['mine.com'], competitorDomains: ['roofle.com'] },
    )
    expect(result.value).toBe('33')
    expect(result.description).toMatch(/competitors hold 33%/i)
  })

  it('description tailors when no competitors are configured', () => {
    const result = buildShareOfVoice(
      [snap(['mine.com', 'wikipedia.org', 'other.com'])],
      { projectDomains: ['mine.com'], competitorDomains: [] },
    )
    expect(result.description).toMatch(/add tracked competitors/i)
    expect(result.description).not.toMatch(/competitors hold/i)
  })

  it('description tailors when competitors are configured but did not surface', () => {
    const result = buildShareOfVoice(
      [snap(['mine.com', 'wikipedia.org', 'other.com'])],
      { projectDomains: ['mine.com'], competitorDomains: ['roofle.com'] },
    )
    expect(result.description).toMatch(/no tracked competitors surfaced/i)
  })

  it('is distinct from citation coverage: 100% cited but only 10% SoV is possible', () => {
    const snaps: ShareOfVoiceSnapshot[] = []
    for (let i = 0; i < 5; i++) {
      snaps.push(snap(['mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com']))
    }
    const result = buildShareOfVoice(snaps, defaultOpts)
    expect(result.value).toBe('10')
  })

  it('uses positive tone at ≥30% SoV (dominant in competitive markets)', () => {
    // 3 of 10 slots = 30%. Should be positive — dominant share for a tracked
    // competitive niche. The legacy scoreTone (70% threshold) would have
    // called this "negative", which is wrong for SoV semantics.
    const result = buildShareOfVoice(
      [snap(['mine.com', 'mine-two.com', 'docs.mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com'])],
      { projectDomains: ['mine.com', 'mine-two.com'], competitorDomains: [] },
    )
    expect(result.value).toBe('30')
    expect(result.tone).toBe('positive')
  })

  it('uses caution tone in the 10-29% range', () => {
    // 2 of 10 = 20% — meaningful voice but not dominant
    const result = buildShareOfVoice(
      [snap(['mine.com', 'docs.mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com'])],
      defaultOpts,
    )
    expect(result.value).toBe('20')
    expect(result.tone).toBe('caution')
  })

  it('uses negative tone under 10% (minor source)', () => {
    const snaps: ShareOfVoiceSnapshot[] = []
    snaps.push(snap(['mine.com']))
    for (let i = 0; i < 99; i++) {
      snaps.push(snap([`rival-${i}.com`]))
    }
    const result = buildShareOfVoice(snaps, defaultOpts)
    expect(result.value).toBe('1')
    expect(result.tone).toBe('negative')
  })

  it('progress matches the score percentage', () => {
    const result = buildShareOfVoice(
      [snap(['mine.com', 'docs.mine.com', 'other.com', 'other-two.com'])],
      defaultOpts,
    )
    expect(result.progress).toBe(50)
  })
})

describe('computeShareOfVoiceBreakdown', () => {
  it('returns the raw slot counts so the UI can render a stacked bar', () => {
    const breakdown = computeShareOfVoiceBreakdown(
      [snap(['mine.com', 'rival.com', 'wikipedia.org', 'other.com', 'docs.mine.com'])],
      { projectDomains: ['mine.com'], competitorDomains: ['rival.com'] },
    )
    expect(breakdown).toEqual({
      projectSlots: 2,      // mine.com + docs.mine.com
      competitorSlots: 1,   // rival.com
      otherSlots: 2,        // wikipedia.org + other.com
      totalSlots: 5,
    })
  })

  it('subdomain-matches competitors too', () => {
    const breakdown = computeShareOfVoiceBreakdown(
      [snap(['offers.roofle.com', 'blog.roofle.com', 'mine.com', 'wikipedia.org'])],
      { projectDomains: ['mine.com'], competitorDomains: ['roofle.com'] },
    )
    expect(breakdown.competitorSlots).toBe(2)
    expect(breakdown.projectSlots).toBe(1)
    expect(breakdown.otherSlots).toBe(1)
  })

  it('returns zeros when no snapshots', () => {
    expect(computeShareOfVoiceBreakdown([], defaultOpts)).toEqual({
      projectSlots: 0, competitorSlots: 0, otherSlots: 0, totalSlots: 0,
    })
  })

  it('two snapshots citing the project from different providers contribute two project slots', () => {
    // Provider extractors dedupe within a snapshot, but cross-snapshot the
    // same domain genuinely counts twice — each provider citing you is a
    // distinct signal we want reflected in SoV.
    const breakdown = computeShareOfVoiceBreakdown(
      [
        snap(['mine.com', 'a.com']),
        snap(['mine.com', 'b.com']),
      ],
      defaultOpts,
    )
    expect(breakdown.projectSlots).toBe(2)
    expect(breakdown.totalSlots).toBe(4)
  })
})

import { describe, expect, it } from 'vitest'
import { buildShareOfVoice, type ShareOfVoiceSnapshot } from '../src/share-of-voice.js'

function snap(overrides: Partial<ShareOfVoiceSnapshot> = {}): ShareOfVoiceSnapshot {
  return {
    citedDomains: [],
    competitorOverlap: [],
    ...overrides,
  }
}

describe('buildShareOfVoice', () => {
  it('returns "No data" tone:neutral when there are no snapshots', () => {
    const result = buildShareOfVoice([], { projectDomains: ['mine.com'] })
    expect(result.label).toBe('Share of Voice')
    expect(result.value).toBe('No data')
    expect(result.tone).toBe('neutral')
    expect(result.progress).toBeUndefined()
  })

  it('returns 0 with a neutral tone when no citations were produced', () => {
    const result = buildShareOfVoice(
      [snap({ citedDomains: [], competitorOverlap: [] })],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('0')
    expect(result.tone).toBe('neutral')
    expect(result.delta).toMatch(/no citations/i)
  })

  it('reports 100% when every citation slot is the project', () => {
    const result = buildShareOfVoice(
      [
        snap({ citedDomains: ['mine.com'] }),
        snap({ citedDomains: ['mine.com'] }),
      ],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('100')
    expect(result.delta).toBe('2 of 2 cited slots')
    expect(result.tone).toBe('positive')
  })

  it('dilutes when project shares the citation list with other sources', () => {
    // One snapshot cites 10 sources, one of which is the project.
    const result = buildShareOfVoice(
      [snap({ citedDomains: ['mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com'] })],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('10')
    expect(result.delta).toBe('1 of 10 cited slots')
  })

  it('matches subdomains of the project canonical', () => {
    const result = buildShareOfVoice(
      [snap({ citedDomains: ['docs.mine.com', 'rival.com'] })],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('50')
  })

  it('classifies competitor and other slots in the description', () => {
    const result = buildShareOfVoice(
      [
        snap({ citedDomains: ['mine.com', 'rival.com', 'wikipedia.org', 'other.com'], competitorOverlap: ['rival.com'] }),
      ],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('25')
    // Competitor share = 25%; other = 50%
    expect(result.description).toMatch(/Competitors hold 25%/i)
    expect(result.description).toMatch(/50% goes to non-competitive/i)
  })

  it('is distinct from citation coverage: 100% cited but only 10% SoV is possible', () => {
    // Project is cited in every snapshot (citation coverage = 100%) but always
    // alongside 9 other sources (SoV = 10%).
    const snaps: ShareOfVoiceSnapshot[] = []
    for (let i = 0; i < 5; i++) {
      snaps.push(snap({
        citedDomains: ['mine.com', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com', 'g.com', 'h.com', 'i.com'],
      }))
    }
    const result = buildShareOfVoice(snaps, { projectDomains: ['mine.com'] })
    expect(result.value).toBe('10')
  })

  it('uses negative tone when SoV is very low (single-digit %)', () => {
    const snaps: ShareOfVoiceSnapshot[] = []
    // 1 project citation across 100 competitor citations
    snaps.push(snap({ citedDomains: ['mine.com'] }))
    for (let i = 0; i < 99; i++) {
      snaps.push(snap({ citedDomains: [`rival-${i}.com`] }))
    }
    const result = buildShareOfVoice(snaps, { projectDomains: ['mine.com'] })
    expect(result.value).toBe('1')
    expect(result.tone).toBe('negative')
  })

  it('uses positive tone when SoV is dominant (≥70%)', () => {
    const result = buildShareOfVoice(
      [
        snap({ citedDomains: ['mine.com', 'mine.com', 'mine.com', 'mine.com', 'mine.com', 'mine.com', 'mine.com', 'other.com'] }),
      ],
      { projectDomains: ['mine.com'] },
    )
    expect(result.value).toBe('88')
    expect(result.tone).toBe('positive')
  })

  it('progress matches the score percentage', () => {
    const result = buildShareOfVoice(
      [snap({ citedDomains: ['mine.com', 'mine.com', 'other.com', 'other.com'] })],
      { projectDomains: ['mine.com'] },
    )
    expect(result.progress).toBe(50)
  })
})

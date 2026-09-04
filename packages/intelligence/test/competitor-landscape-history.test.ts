import { describe, expect, it } from 'vitest'
import {
  buildCompetitorLandscapeHistory,
  type CompetitorLandscapeHistorySnapshot,
} from '../src/competitor-landscape-history.js'

function snapshot(
  overrides: Partial<CompetitorLandscapeHistorySnapshot> = {},
): CompetitorLandscapeHistorySnapshot {
  return {
    id: 'snapshot-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    answerText: null,
    projectMentioned: false,
    citedDomains: [],
    citedUrls: null,
    ...overrides,
  }
}

describe('buildCompetitorLandscapeHistory', () => {
  it('keeps answer-text mention share separate from source citations, while retaining source-only evidence', () => {
    const result = buildCompetitorLandscapeHistory({
      project: {
        domain: 'acme.example',
        label: 'Acme',
        domains: ['acme.example'],
      },
      pinned: [{ domain: 'pinned.example', label: 'Pinned' }],
      classifications: new Map([
        ['rival.example', 'direct-competitor'],
        ['news.example', 'editorial-media'],
      ]),
      snapshots: [
        snapshot({
          id: 'one',
          createdAt: '2026-08-01T00:00:00.000Z',
          answerText: 'Acme and Rival are both useful.',
          projectMentioned: true,
          citedDomains: ['rival.example', 'news.example'],
          citedUrls: ['https://rival.example/guide', 'https://news.example/review'],
        }),
        snapshot({
          id: 'two',
          createdAt: '2026-08-02T00:00:00.000Z',
          answerText: 'Pinned is another option.',
          projectMentioned: false,
          citedDomains: ['pinned.example'],
          citedUrls: ['https://pinned.example/'],
        }),
        // A historical source-only row must retain its citation but never be
        // invented into a negative or a mention denominator.
        snapshot({
          id: 'three',
          createdAt: '2026-08-03T00:00:00.000Z',
          answerText: null,
          projectMentioned: false,
          citedDomains: ['rival.example'],
          citedUrls: null,
        }),
      ],
    })

    expect(result.evidence).toMatchObject({
      answeredResults: 2,
      sourceResults: 3,
      missingAnswerTextResults: 1,
      mentionCredits: 3,
    })
    expect(result.project).toMatchObject({
      domain: 'acme.example',
      mentionCount: 1,
      shareOfVoice: 33.3,
      citationCount: 0,
    })
    expect(result.pinned).toEqual([
      expect.objectContaining({
        domain: 'pinned.example',
        pinned: true,
        mentionCount: 1,
        shareOfVoice: 33.3,
        citationCount: 1,
        sampleUrls: ['https://pinned.example/'],
      }),
    ])
    expect(result.observed).toEqual([
      expect.objectContaining({
        domain: 'rival.example',
        pinned: false,
        mentionCount: 1,
        shareOfVoice: 33.3,
        citationCount: 2,
        sampleUrls: ['https://rival.example/guide'],
      }),
    ])
    expect(result.otherSources).toEqual([
      expect.objectContaining({
        domain: 'news.example',
        surfaceClass: 'editorial-media',
        mentionCount: 0,
        shareOfVoice: null,
        citationCount: 1,
      }),
    ])
  })

  it('discovers direct competitors from stored cited URLs, keeps zero-observation pins, and credits every named brand once per answer', () => {
    const result = buildCompetitorLandscapeHistory({
      project: {
        domain: 'acme.example',
        label: 'Acme',
        domains: ['acme.example'],
      },
      pinned: [
        { domain: 'pinned.example', label: 'Pinned' },
        { domain: 'zero.example', label: 'Zero' },
      ],
      classifications: new Map([['rival.example', 'direct-competitor']]),
      snapshots: [
        snapshot({
          answerText: 'Acme, Pinned, and Rival are worth comparing. Rival is mentioned twice: Rival.',
          projectMentioned: true,
          citedUrls: ['https://blog.rival.example/compare'],
        }),
      ],
    })

    expect(result.evidence.mentionCredits).toBe(3)
    expect(result.pinned.map(row => [row.domain, row.mentionCount, row.shareOfVoice])).toEqual([
      ['pinned.example', 1, 33.3],
      ['zero.example', 0, 0],
    ])
    expect(result.observed).toEqual([
      expect.objectContaining({
        domain: 'rival.example',
        mentionCount: 1,
        citationCount: 1,
        shareOfVoice: 33.3,
      }),
    ])
  })

  it('matches an operator-supplied pinned label when it differs from the domain label', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [{ domain: 'rival-holdings.example', label: 'Rival Holdings' }],
      classifications: new Map(),
      snapshots: [snapshot({
        answerText: 'Rival Holdings is another option.',
        citedDomains: [],
        citedUrls: [],
      })],
    })

    expect(result.pinned[0]).toMatchObject({ mentionCount: 1, shareOfVoice: 100 })
  })

  it('includes classified and frozen direct competitors mentioned without citations, but hides zero-activity observed rows', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [],
      historicalDirect: [{
        domain: 'legacy-rival.example',
        label: 'Legacy Rival',
        aliases: ['Legacy'],
      }],
      classifications: new Map([
        ['classified-only.example', 'direct-competitor'],
        ['zero-activity.example', 'direct-competitor'],
      ]),
      snapshots: [snapshot({
        answerText: 'Classified Only and Legacy Rival are alternatives.',
        citedDomains: [],
        citedUrls: [],
      })],
    })

    expect(result.observed.map(row => row.domain)).toEqual([
      'classified-only.example',
      'legacy-rival.example',
    ])
    expect(result.observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'classified-only.example', mentionCount: 1, citationCount: 0 }),
      expect.objectContaining({ domain: 'legacy-rival.example', mentionCount: 1, citationCount: 0 }),
    ]))
    expect(result.observed.some(row => row.domain === 'zero-activity.example')).toBe(false)
  })
})

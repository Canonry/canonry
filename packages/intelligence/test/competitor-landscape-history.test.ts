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
  it('keeps owned-host boundaries before grouping sibling sources by registrable domain', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example', 'owned.platform.example'] },
      pinned: [{ domain: 'rival.platform.example', label: 'Rival' }],
      shareOfVoiceEligible: true,
      classifications: new Map(),
      snapshots: [snapshot({
        answerText: 'Rival is another option.',
        citedDomains: ['rival.platform.example'],
        citedUrls: ['https://rival.platform.example/product'],
      })],
    })

    expect(result.project).toMatchObject({ citationCount: 0, mentionCount: 0 })
    expect(result.pinned).toEqual([expect.objectContaining({
      domain: 'platform.example', citationCount: 1, mentionCount: 1, shareOfVoice: 100,
    })])
  })

  it('counts exact owned hosts and their descendants without claiming the parent or sibling hosts', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'shop.platform.example', label: 'Shop', domains: ['shop.platform.example'] },
      pinned: [],
      shareOfVoiceEligible: true,
      classifications: new Map(),
      snapshots: [
        snapshot({ id: 'owned', citedUrls: ['https://shop.platform.example/product', 'https://blog.shop.platform.example/post'] }),
        snapshot({ id: 'sibling', citedUrls: ['https://other.platform.example/review'] }),
        snapshot({ id: 'parent', citedUrls: ['https://platform.example/'] }),
      ],
    })

    expect(result.project).toMatchObject({ domain: 'shop.platform.example', citationCount: 1 })
    expect(result.project.sampleUrls).toEqual(['https://shop.platform.example/product', 'https://blog.shop.platform.example/post'])
    expect(result.otherSources).toEqual([expect.objectContaining({ domain: 'platform.example', citationCount: 2 })])
  })

  it('keeps answer-text mention share separate from source citations, while retaining source-only evidence', () => {
    const result = buildCompetitorLandscapeHistory({
      project: {
        domain: 'acme.example',
        label: 'Acme',
        domains: ['acme.example'],
      },
      pinned: [{ domain: 'pinned.example', label: 'Pinned' }],
      shareOfVoiceEligible: true,
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
      mentionCredits: 2,
    })
    expect(result.project).toMatchObject({
      domain: 'acme.example',
      mentionCount: 1,
      shareOfVoice: 50,
      citationCount: 0,
    })
    expect(result.pinned).toEqual([
      expect.objectContaining({
        domain: 'pinned.example',
        pinned: true,
        mentionCount: 1,
        shareOfVoice: 50,
        citationCount: 1,
        sampleUrls: ['https://pinned.example/'],
      }),
    ])
    expect(result.observed).toEqual([
      expect.objectContaining({
        domain: 'rival.example',
        pinned: false,
        mentionCount: 1,
        shareOfVoice: null,
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
      shareOfVoiceEligible: true,
      classifications: new Map([['rival.example', 'direct-competitor']]),
      snapshots: [
        snapshot({
          answerText: 'Acme, Pinned, and Rival are worth comparing. Rival is mentioned twice: Rival.',
          projectMentioned: true,
          citedUrls: ['https://blog.rival.example/compare'],
        }),
      ],
    })

    expect(result.evidence.mentionCredits).toBe(2)
    expect(result.pinned.map(row => [row.domain, row.mentionCount, row.shareOfVoice])).toEqual([
      ['pinned.example', 1, 50],
      ['zero.example', 0, 0],
    ])
    expect(result.observed).toEqual([
      expect.objectContaining({
        domain: 'rival.example',
        mentionCount: 1,
        citationCount: 1,
        shareOfVoice: null,
      }),
    ])
  })

  it('matches an operator-supplied pinned label when it differs from the domain label', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [{ domain: 'rival-holdings.example', label: 'Rival Holdings' }],
      shareOfVoiceEligible: true,
      classifications: new Map(),
      snapshots: [snapshot({
        answerText: 'Rival Holdings is another option.',
        citedDomains: [],
        citedUrls: [],
      })],
    })

    expect(result.pinned[0]).toMatchObject({ mentionCount: 1, shareOfVoice: 100 })
  })

  it('does not promote short generated labels into aliases when duplicate identities merge', () => {
    const generated = { domain: 'car.com', label: 'car', labelSource: 'domain' as const }
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [generated, { ...generated, domain: 'www.car.com' }],
      shareOfVoiceEligible: true,
      classifications: new Map(),
      snapshots: [
        snapshot({
          id: 'ordinary-word',
          answerText: 'Acme helps you rent a car.',
          projectMentioned: true,
          frozenCompetitors: [generated],
        }),
        snapshot({ id: 'written-domain', answerText: 'Compare car.com.', citedDomains: ['car.com'] }),
      ],
    })

    expect(result.pinned).toEqual([expect.objectContaining({
      domain: 'car.com', mentionCount: 1, citationCount: 1, shareOfVoice: 50,
    })])
    expect(result.evidence.mentionCredits).toBe(2)
  })

  it('applies the safe domain label threshold to automatically observed competitors', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [],
      shareOfVoiceEligible: true,
      classifications: new Map([['car.com', 'direct-competitor']]),
      snapshots: [snapshot({
        answerText: 'Acme helps you rent a car.',
        projectMentioned: true,
        citedDomains: ['car.com'],
      })],
    })

    expect(result.observed).toEqual([expect.objectContaining({
      domain: 'car.com', mentionCount: 0, citationCount: 1, shareOfVoice: null,
    })])
    expect(result.project.shareOfVoice).toBeNull()
    expect(result.reason).toBe('insufficient-observed')
  })

  it('preserves explicitly curated short labels and aliases across merged identities', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [
        { domain: 'ibm.com', label: 'ibm', labelSource: 'domain' },
        { domain: 'www.ibm.com', label: 'IBM' },
        { domain: 'car.com', label: 'car', labelSource: 'domain' },
      ],
      shareOfVoiceEligible: true,
      classifications: new Map(),
      snapshots: [snapshot({
        answerText: 'IBM and CAR are both options.',
        frozenCompetitors: [{ domain: 'car.com', label: 'car', labelSource: 'domain', aliases: ['CAR'] }],
      })],
    })

    expect(result.pinned).toEqual([
      expect.objectContaining({ domain: 'ibm.com', mentionCount: 1, shareOfVoice: 50 }),
      expect.objectContaining({ domain: 'car.com', mentionCount: 1, shareOfVoice: 50 }),
    ])
  })

  it('includes classified and frozen direct competitors mentioned without citations, but hides zero-activity observed rows', () => {
    const result = buildCompetitorLandscapeHistory({
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [],
      shareOfVoiceEligible: true,
      classifications: new Map([
        ['classified-only.example', 'direct-competitor'],
        ['zero-activity.example', 'direct-competitor'],
      ]),
      snapshots: [snapshot({
        answerText: 'Classified Only and Legacy Rival are alternatives.',
        citedDomains: [],
        citedUrls: [],
        frozenCompetitors: [{
          domain: 'legacy-rival.example',
          label: 'Legacy Rival',
          aliases: ['Legacy'],
        }],
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

  it('withholds share of voice when the selection pools query classes, keeping the counts', () => {
    const options = {
      project: { domain: 'acme.example', label: 'Acme', domains: ['acme.example'] },
      pinned: [{ domain: 'rival.example', label: 'Rival' }],
      classifications: new Map(),
      snapshots: [
        snapshot({ id: 's1', answerText: 'Acme is the pick.', projectMentioned: true }),
        snapshot({ id: 's2', answerText: 'Rival is the pick.' }),
      ],
    } as const

    const scoped = buildCompetitorLandscapeHistory({ ...options, shareOfVoiceEligible: true })
    expect(scoped.project).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })
    expect(scoped.pinned[0]).toMatchObject({ mentionCount: 1, shareOfVoice: 50 })

    const pooled = buildCompetitorLandscapeHistory({ ...options, shareOfVoiceEligible: false })
    expect(pooled.project).toMatchObject({ mentionCount: 1, shareOfVoice: null })
    expect(pooled.pinned[0]).toMatchObject({ mentionCount: 1, shareOfVoice: null })
    expect(pooled.evidence.mentionCredits).toBe(scoped.evidence.mentionCredits)
  })

})

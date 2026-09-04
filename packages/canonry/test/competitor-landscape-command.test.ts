import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompetitorLandscapeResponse } from '@ainyc/canonry-contracts'

const mockGetCompetitorLandscape = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getCompetitorLandscape: mockGetCompetitorLandscape }),
}))

function fixture(): CompetitorLandscapeResponse {
  const row = (domain: string, pinned: boolean) => ({
    domain,
    label: domain,
    surfaceClass: pinned ? 'direct-competitor' as const : 'editorial-media' as const,
    pinned,
    mentionCount: pinned ? 2 : 0,
    shareOfVoice: pinned ? 50 : null,
    citationCount: 2,
    answeredResults: 4,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    sampleUrls: [],
  })
  return {
    window: '30d',
    scope: { kind: 'all-markets' },
    project: { ...row('acme.example', false), surfaceClass: 'own', shareOfVoice: 50 },
    pinned: [row('rival.example', true)],
    observed: [],
    otherSources: [row('guide.example', false)],
    evidence: {
      answeredResults: 4,
      sourceResults: 4,
      missingAnswerTextResults: 0,
      mentionCredits: 4,
      incompleteSourceResults: 0,
      excludedProbeResults: 1,
      excludedNonCompletedResults: 2,
    },
    marketState: null,
    filters: {
      scope: 'all-markets',
      groupKey: null,
      provider: null,
      queryClass: 'all',
      location: null,
      runId: null,
    },
    truncated: false,
  }
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => logs.join('\n'))
}

const { showCompetitorLandscape } = await import('../src/commands/competitor.js')

describe('showCompetitorLandscape', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards explicit Advanced all-markets filters and prints the whole response for machine formats', async () => {
    const response = fixture()
    mockGetCompetitorLandscape.mockResolvedValue(response)

    const output = await captureLog(() => showCompetitorLandscape('acme', {
      window: '30d',
      scope: 'all-markets',
      provider: 'openai',
      queryClass: 'non-brand',
      format: 'jsonl',
    }))

    expect(mockGetCompetitorLandscape).toHaveBeenCalledWith('acme', {
      window: '30d',
      scope: 'all-markets',
      groupKey: undefined,
      provider: 'openai',
      queryClass: 'non-brand',
      location: undefined,
      runId: undefined,
    })
    expect(output.split('\n')).toHaveLength(1)
    expect(JSON.parse(output)).toEqual(response)
  })

  it('prints the project first, then pins before observed and source rows in human output', async () => {
    mockGetCompetitorLandscape.mockResolvedValue(fixture())
    const output = await captureLog(() => showCompetitorLandscape('acme', {}))

    expect(output.indexOf('Your brand')).toBeLessThan(output.indexOf('Pinned competitors'))
    expect(output).toContain('acme.example')
    expect(output.indexOf('Pinned competitors')).toBeLessThan(output.indexOf('Other cited sources'))
    expect(output).toContain('rival.example')
    expect(output).toContain('excluded: 1 probe, 2 non-completed')
  })
})

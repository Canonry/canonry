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
const { COMPETITOR_CLI_COMMANDS } = await import('../src/cli-commands/competitor.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')

function comparisonFixture(): CompetitorLandscapeResponse {
  const data = fixture()
  const group = {
    provider: 'openai', model: 'gpt-test', servedModels: { status: 'known' as const, model: 'gpt-test-2026-09' },
    snapshotCount: 4, project: data.project, pinned: data.pinned, observed: data.observed,
    otherSources: data.otherSources, evidence: data.evidence, truncated: false,
  }
  data.modelComparison = {
    basis: 'requested-model', totalGroups: 51, truncated: true,
    groups: [
      group,
      { ...group, provider: 'gemini', model: null, servedModels: { status: 'unknown' } },
      { ...group, model: 'gpt-other', servedModels: { status: 'mixed', models: ['gpt-a', 'gpt-b'], includesUnknown: true }, truncated: true },
    ],
  }
  return data
}

describe('showCompetitorLandscape', () => {
  it('prints the basis beside the ratio and explains an unmeasured comparison', async () => {
    const response = fixture()
    response.filters.queryClass = 'non-brand'
    Object.assign(response, { basis: 'tracked', availability: 'measured', reason: null })
    mockGetCompetitorLandscape.mockResolvedValue(response)
    let output = await captureLog(() => showCompetitorLandscape('acme', {}))
    expect(output).toContain('SOV 50.0% · tracked competitors · non-brand queries')
    Object.assign(response, { basis: null, availability: 'not-measured', reason: 'no-competitors', pinned: [] })
    response.project.shareOfVoice = null
    output = await captureLog(() => showCompetitorLandscape('acme', {}))
    expect(output).toContain('SOV Not measured · non-brand queries')
    expect(output).toContain('No competitors configured.')
    expect(output).not.toContain('100.0%')
  })

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
    expect(output).not.toContain('Model comparison')
  })

  it('prints model-group counts, requested and served identities, and comparison limits separately', async () => {
    mockGetCompetitorLandscape.mockResolvedValue(comparisonFixture())
    const output = await captureLog(() => showCompetitorLandscape('acme', { groupBy: 'model' }))

    expect(output).toContain('Model comparison · requested-model basis · 3 of 51 groups')
    expect(output).toContain('openai · requested model: gpt-test')
    expect(output).toContain('Served model evidence: gpt-test-2026-09')
    expect(output).toContain('gemini · requested model: Unknown (not recorded)')
    expect(output).toContain('Served model evidence: Unknown (not disclosed)')
    expect(output).toContain('Served model evidence: gpt-a, gpt-b, Unknown (not disclosed)')
    expect(output).toContain('Samples: 4 snapshot(s), 4 answer-text result(s), 4 source result(s).')
    expect(output).toContain('rival.example  mention 2 · citation 2 · SOV 50.0% · all queries · answers 4')
    expect(output).toContain('not form a matched-query or equal-weight comparison')
    expect(output).toContain('Additional groups are omitted')
    expect(output).toContain('Pinned competitors are complete')
  })

  it('discloses an exact requested-model filter without a model comparison', async () => {
    const response = fixture()
    response.filters.provider = 'openai'
    response.filters.model = 'gpt-test'
    mockGetCompetitorLandscape.mockResolvedValue(response)
    const output = await captureLog(() => showCompetitorLandscape('acme', { provider: 'openai', model: 'gpt-test' }))
    expect(output).toContain('Requested model filter: openai · gpt-test')
    expect(output).not.toContain('Model comparison')
  })

  it.each(['json', 'jsonl'])('keeps the full model comparison in %s output', async (format) => {
    const response = comparisonFixture()
    mockGetCompetitorLandscape.mockResolvedValue(response)
    const output = await captureLog(() => showCompetitorLandscape('acme', {
      groupBy: 'model', provider: 'openai', model: 'gpt-test', format,
    }))

    expect(mockGetCompetitorLandscape).toHaveBeenCalledWith('acme', expect.objectContaining({
      groupBy: 'model', provider: 'openai', model: 'gpt-test',
    }))
    expect(JSON.parse(output)).toEqual(response)
    if (format === 'jsonl') expect(output.split('\n')).toHaveLength(1)
  })
})

describe('competitor landscape CLI model filters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCompetitorLandscape.mockResolvedValue(fixture())
  })

  it.each([
    { flags: [], expected: {} },
    { flags: ['--group-key', 'north'], expected: { groupKey: 'north' } },
    { flags: ['--scope', 'all-markets'], expected: { scope: 'all-markets' } },
  ])('preserves portfolio scope with model comparison: $expected', async ({ flags, expected }) => {
    await captureLog(() => dispatchRegisteredCommand([
      'competitor', 'landscape', 'acme', ...flags, '--by-model', '--provider', 'openai', '--model', 'gpt-test',
      '--query-class', 'non-brand', '--location', 'nyc', '--window', '30d', '--run-id', 'run-1',
    ], 'json', COMPETITOR_CLI_COMMANDS).then(() => {}))

    expect(mockGetCompetitorLandscape).toHaveBeenCalledWith('acme', expect.objectContaining({
      ...expected, groupBy: 'model', provider: 'openai', model: 'gpt-test',
      queryClass: 'non-brand', location: 'nyc', window: '30d', runId: 'run-1',
    }))
  })

  it('supports an exact model filter without requesting model grouping', async () => {
    await captureLog(() => dispatchRegisteredCommand([
      'competitor', 'landscape', 'acme', '--provider', 'gemini', '--model', 'gemini-test',
    ], 'json', COMPETITOR_CLI_COMMANDS).then(() => {}))

    expect(mockGetCompetitorLandscape.mock.calls[0]?.[1]).toMatchObject({ provider: 'gemini', model: 'gemini-test' })
    expect(mockGetCompetitorLandscape.mock.calls[0]?.[1]).not.toHaveProperty('groupBy')
  })

  it('rejects a model filter without a provider before the request', async () => {
    await expect(dispatchRegisteredCommand([
      'competitor', 'landscape', 'acme', '--by-model', '--model', 'gpt-test',
    ], 'json', COMPETITOR_CLI_COMMANDS)).rejects.toThrow('--model requires --provider')
    expect(mockGetCompetitorLandscape).not.toHaveBeenCalled()
  })

  it('keeps the default command pooled', async () => {
    await captureLog(() => dispatchRegisteredCommand(['competitor', 'landscape', 'acme'], 'json', COMPETITOR_CLI_COMMANDS).then(() => {}))
    expect(mockGetCompetitorLandscape.mock.calls[0]?.[1]).not.toHaveProperty('groupBy')
    expect(mockGetCompetitorLandscape.mock.calls[0]?.[1]).not.toHaveProperty('model')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import { resolveSentimentInstallConfig } from '@ainyc/canonry-config'
import { inputFixture } from '../../integration-typesafe/test/fixtures.js'
import { createConfiguredSentimentClassifier } from '../src/sentiment-openrouter.js'
import { getSharedProviderExecutionGate, resetSharedProviderExecutionGates } from '../src/provider-execution-gate.js'

afterEach(() => { vi.unstubAllGlobals(); resetSharedProviderExecutionGates() })

function response(model: string = 'typesafe/jev-1.13-20260917') {
  return {
    model, usage: { input_tokens: 357, output_tokens: 38 },
    answers: {
      identity: { type: 'choice', choice: 'correct', probabilities: { correct: 1, wrong: 0, absent: 0, ambiguous: 0 }, confidence: 1 },
      judgment: { type: 'choice', choice: 'judged', probabilities: { judged: 1, factual: 0, ambiguous: 0 }, confidence: 1 },
      stance: { type: 'choice', choice: 'favorable', probabilities: { favorable: 1, mixed: 0, unfavorable: 0 }, confidence: 1 },
      conclusion: { type: 'choice', choice: 's1', probabilities: { absent: 0, s1: 1, s2: 0 }, confidence: 1 },
      complaint: { type: 'choice', choice: 's2', probabilities: { absent: 0, s1: 0, s2: 1 }, confidence: 1 },
    },
  }
}
function configured() {
  const input = inputFixture(); input.definition = createSentimentEvaluationDefinition('openrouter')
  const configuration = resolveSentimentInstallConfig({}, { enabled: true, provider: 'openrouter' }, { openrouter: 'synthetic-key' })
  return { input, configuration, classifier: createConfiguredSentimentClassifier(configuration) }
}

describe('OpenRouter Jev through pi', () => {
  it('sends the pinned decision contract and preserves literal served identity, usage and original evidence', async () => {
    const fetch = vi.fn(async () => Response.json(response()))
    vi.stubGlobal('fetch', fetch)
    const { input, classifier } = configured()
    expect(await classifier.classify(input)).toMatchObject({ kind: 'classified', outcome: 'favorable', returnedModel: 'typesafe/jev-1.13-20260917', usage: { kind: 'reported', inputTokens: 357, outputTokens: 38 }, conclusion: [input.sentences[0]], complaint: [input.sentences[1]] })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-key')
    const request = JSON.parse(String(init.body))
    expect(request.model).toBe('typesafe/jev-1.13')
    expect(request.state.answerSentences).toEqual({ s1: input.sentences[0].text, s2: input.sentences[1].text })
  })
  it.each(['typesafe/jev-1.14-20261001', 'typesafe/jev-1.13'])('rejects unpinned or undisclosed served identity %s', async model => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response(model))))
    const { input, classifier } = configured()
    expect(await classifier.classify(input)).toMatchObject({ kind: 'failed', returnedModel: model, error: { code: 'model-mismatch', retryable: false } })
  })
  it('keeps rate-limit attempts single-dispatch and supplies durable retry timing', async () => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'rate limit' } }, { status: 429, headers: { 'retry-after': '60' } }))
    vi.stubGlobal('fetch', fetch)
    const { input, classifier } = configured()
    expect(await classifier.classify(input)).toMatchObject({ kind: 'failed', error: { code: 'provider-rate-limit', retryable: true, retryAfterMs: 60_000 } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('removes canceled classifier work from the shared connection queue before a paid request', async () => {
    const fetch = vi.fn(async () => Response.json(response())); vi.stubGlobal('fetch', fetch)
    const gate = getSharedProviderExecutionGate('openrouter', 1, 60)
    let release!: () => void
    const occupied = gate.run(() => new Promise<void>(resolve => { release = resolve }))
    const { input, classifier } = configured()
    const controller = new AbortController()
    const queued = classifier.classify(input, { signal: controller.signal })
    controller.abort()
    expect(await queued).toMatchObject({ kind: 'failed', error: { code: 'canceled', retryable: false } })
    expect(fetch).not.toHaveBeenCalled()
    release(); await occupied
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['disabled', 'withdrawn', 'rotated'] as const)('rereads %s shared credentials after waiting for connection capacity', async change => {
    const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json(response())); vi.stubGlobal('fetch', fetch)
    const gate = getSharedProviderExecutionGate('openrouter', 1, 60)
    let release!: () => void
    const occupied = gate.run(() => new Promise<void>(resolve => { release = resolve }))
    const { input, configuration } = configured()
    let active = configuration
    const classifier = createConfiguredSentimentClassifier(configuration, undefined, () => active)
    const queued = classifier.classify(input)
    active = { ...active, ...(change === 'disabled' ? { enabled: false } : { apiKey: change === 'rotated' ? 'rotated-key' : undefined }) }
    release(); await occupied
    const result = await queued
    if (change === 'rotated') {
      expect(result.kind).toBe('classified')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer rotated-key')
    } else {
      expect(result).toMatchObject({ kind: 'failed', error: { code: change === 'disabled' ? 'install-disabled' : 'missing-credentials', retryable: true } })
      expect(fetch).not.toHaveBeenCalled()
    }
  })
  it.each([{}, { ...response(), usage: { input_tokens: 1 } }])('withholds incomplete provider successes without retrying', async body => {
    const fetch = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetch)
    const { input, classifier } = configured()
    expect(await classifier.classify(input)).toMatchObject({ kind: 'failed', error: { code: 'response-contract', retryable: false } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

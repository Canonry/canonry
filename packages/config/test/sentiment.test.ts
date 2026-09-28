import { describe, expect, it } from 'vitest'
import { resolveSentimentInstallConfig, sentimentInstallReadiness } from '../src/index.js'

describe('sentiment install configuration', () => {
  it('defaults off even when a key exists', () => {
    const config = resolveSentimentInstallConfig({ TYPESAFE_API_KEY: 'private-test-key' })
    expect(sentimentInstallReadiness(config)).toEqual({ enabled: false, ready: false, reason: 'install-disabled' })
    expect(JSON.stringify(sentimentInstallReadiness(config))).not.toContain('private-test-key')
  })
  it('resolves env over config and never silently changes the pinned model', () => {
    expect(resolveSentimentInstallConfig({ CANONRY_SENTIMENT_ENABLED: 'false' }, { enabled: true }).enabled).toBe(false)
    expect(resolveSentimentInstallConfig({ CANONRY_SENTIMENT_ENABLED: 'invalid' }, { enabled: true }).enabled).toBe(false)
    expect(sentimentInstallReadiness(resolveSentimentInstallConfig({}, { enabled: true, apiKey: 'key', model: 'jev-latest' })).reason).toBe('unsupported-model')
    expect(sentimentInstallReadiness(resolveSentimentInstallConfig({}, { enabled: true })).reason).toBe('missing-credentials')
    expect(sentimentInstallReadiness(resolveSentimentInstallConfig({ TYPESAFE_API_KEY: 'env-key' }, { enabled: true })).ready).toBe(true)
  })
  it('reports an invalid install file as its own reason, never as an operator disable', () => {
    expect(sentimentInstallReadiness({ ...resolveSentimentInstallConfig({}, { enabled: false }), invalid: true })).toEqual({ enabled: false, ready: false, reason: 'invalid-config' })
    // The marker wins even over values that would otherwise be ready.
    expect(sentimentInstallReadiness({ ...resolveSentimentInstallConfig({}, { enabled: true, apiKey: 'key' }), invalid: true })).toMatchObject({ ready: false, reason: 'invalid-config' })
  })
})

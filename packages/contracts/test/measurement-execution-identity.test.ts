import { describe, expect, it } from 'vitest'
import {
  buildMeasurementExecutionIdentity,
  canonicalMeasurementExecutionIdentityJson,
} from '../src/measurement-plan.js'

const CHECKSUM = 'a'.repeat(64)

describe('measurement execution identity and retired model ids', () => {
  it('records the model that answers now, not the retired id a config still names', () => {
    const identity = buildMeasurementExecutionIdentity(
      { providers: ['perplexity', 'openai'], models: { perplexity: 'sonar', openai: 'gpt-5.4' } },
      CHECKSUM,
    )
    expect(identity.models).toEqual({ openai: 'gpt-5.4', perplexity: 'fast' })
  })

  it('starts a new series when the engine behind a retired id changes', () => {
    // Stored Sonar-era runs were stamped with `sonar`. The same config now runs
    // the Agent API `fast` preset, so its canonical identity must differ.
    const stored = JSON.stringify({ models: { perplexity: 'sonar' }, providers: ['perplexity'], schemaVersion: 1 })
    const current = canonicalMeasurementExecutionIdentityJson({ providers: ['perplexity'], models: { perplexity: 'sonar' } })
    expect(current).toBe(JSON.stringify({ models: { perplexity: 'fast' }, providers: ['perplexity'], schemaVersion: 1 }))
    expect(current).not.toBe(stored)
  })

  it('treats a retired id and its replacement as one engine', () => {
    for (const [retired, replacement] of [['sonar', 'fast'], ['sonar-pro', 'low'], ['pro-search', 'low'], ['sonar-deep-research', 'medium']]) {
      expect(canonicalMeasurementExecutionIdentityJson({ providers: ['perplexity'], models: { perplexity: retired! } }))
        .toBe(canonicalMeasurementExecutionIdentityJson({ providers: ['perplexity'], models: { perplexity: replacement! } }))
    }
  })

  it('trims before resolving and leaves other providers untouched', () => {
    expect(canonicalMeasurementExecutionIdentityJson({ providers: ['perplexity', 'local'], models: { perplexity: ' sonar-pro ', local: 'sonar' } }))
      .toBe(JSON.stringify({ models: { local: 'sonar', perplexity: 'low' }, providers: ['local', 'perplexity'], schemaVersion: 1 }))
  })
})

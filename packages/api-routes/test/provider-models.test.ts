import { describe, expect, it } from 'vitest'
import { AppError } from '@ainyc/canonry-contracts'
import { pruneProviderModelsForProviders, validateProviderModels } from '../src/provider-models.js'

const adapters = [
  {
    name: 'gemini', displayName: 'Gemini', mode: 'api' as const,
    modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [],
    modelValidationPattern: /^gemini-/, modelValidationHint: 'use a Gemini model ID beginning with gemini-',
  },
  {
    name: 'cdp:chatgpt', displayName: 'ChatGPT (Browser)', mode: 'browser' as const,
    modelConfigurable: false, defaultModel: 'chatgpt-web', knownModels: [],
    modelValidationPattern: /./, modelValidationHint: 'detected from the browser',
  },
]

function validationMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return (error as AppError).message
  }
  throw new Error('Expected validation to fail')
}

describe('validateProviderModels', () => {
  it('trims accepted values and preserves an empty inherited map without descriptors', () => {
    expect(validateProviderModels({}, undefined)).toEqual({})
    expect(validateProviderModels({ gemini: ' gemini-2.5-pro ' }, adapters)).toEqual({ gemini: 'gemini-2.5-pro' })
  })

  it('fails closed when host metadata is unavailable', () => {
    expect(validationMessage(() => validateProviderModels({ gemini: 'gemini-2.5-pro' }, undefined)))
      .toContain('provider metadata')
  })

  it('rejects unknown, browser, and syntactically invalid provider overrides with the owning hint', () => {
    expect(validationMessage(() => validateProviderModels({ unknown: 'x' }, adapters))).toContain('unknown provider')
    expect(validationMessage(() => validateProviderModels({ 'cdp:chatgpt': 'x' }, adapters))).toContain('does not support')
    expect(validationMessage(() => validateProviderModels({ gemini: 'gpt-5' }, adapters)))
      .toContain('use a Gemini model ID')
  })
})

describe('pruneProviderModelsForProviders', () => {
  it('drops overrides for engines the project does not run and keeps the rest', () => {
    expect(pruneProviderModelsForProviders({ gemini: 'gemini-2.5-pro', openai: 'gpt-5' }, ['gemini']))
      .toEqual({ gemini: 'gemini-2.5-pro' })
  })

  it('keeps every override when the provider list is empty (= all configured engines)', () => {
    expect(pruneProviderModelsForProviders({ gemini: 'gemini-2.5-pro' }, []))
      .toEqual({ gemini: 'gemini-2.5-pro' })
  })

  it('passes through overrides that all name a selected engine, and an empty map', () => {
    expect(pruneProviderModelsForProviders({ gemini: 'gemini-2.5-pro' }, ['gemini', 'openai']))
      .toEqual({ gemini: 'gemini-2.5-pro' })
    expect(pruneProviderModelsForProviders({}, ['gemini'])).toEqual({})
  })

  it('does not mutate its input', () => {
    const models = { gemini: 'gemini-2.5-pro', openai: 'gpt-5' }
    pruneProviderModelsForProviders(models, ['gemini'])
    expect(models).toEqual({ gemini: 'gemini-2.5-pro', openai: 'gpt-5' })
  })

  it('is idempotent — pruning the pruned map is a no-op (apply stays convergent)', () => {
    const once = pruneProviderModelsForProviders({ gemini: 'gemini-2.5-pro', openai: 'gpt-5' }, ['gemini'])
    expect(pruneProviderModelsForProviders(once, ['gemini'])).toEqual(once)
  })
})

import { describe, expect, it } from 'vitest'
import { AppError } from '@ainyc/canonry-contracts'
import { validateProviderModels } from '../src/provider-models.js'

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

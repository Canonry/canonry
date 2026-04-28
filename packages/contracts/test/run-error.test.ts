import { describe, expect, it } from 'vitest'
import {
  buildRunErrorFromMessages,
  formatRunErrorOneLine,
  parseProviderErrorMessage,
  parseRunError,
  serializeRunError,
} from '../src/run.js'

describe('parseProviderErrorMessage', () => {
  it('strips the [provider-X] prefix and parses inner JSON', () => {
    const raw = '[provider-gemini] {"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}'
    const result = parseProviderErrorMessage(raw)
    expect(result.message).toBe('API key not valid')
    expect(result.raw).toEqual({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } })
  })

  it('falls back to top-level message when error.message is absent', () => {
    const raw = '[provider-claude] {"message":"rate limited"}'
    const result = parseProviderErrorMessage(raw)
    expect(result.message).toBe('rate limited')
    expect(result.raw).toEqual({ message: 'rate limited' })
  })

  it('keeps the stripped text as message when body is not JSON', () => {
    expect(parseProviderErrorMessage('[provider-openai] timeout after 30s')).toEqual({ message: 'timeout after 30s' })
  })

  it('passes plain messages through untouched', () => {
    expect(parseProviderErrorMessage('boom')).toEqual({ message: 'boom' })
  })
})

describe('buildRunErrorFromMessages', () => {
  it('structures a Map of provider → raw message into the new envelope', () => {
    const msgs = new Map<string, string>([
      ['gemini', '[provider-gemini] {"error":{"message":"API key not valid"}}'],
      ['openai', '[provider-openai] timeout'],
    ])
    expect(buildRunErrorFromMessages(msgs)).toEqual({
      providers: {
        gemini: { message: 'API key not valid', raw: { error: { message: 'API key not valid' } } },
        openai: { message: 'timeout' },
      },
    })
  })
})

describe('parseRunError back-compat', () => {
  it('returns null for null/empty', () => {
    expect(parseRunError(null)).toBeNull()
    expect(parseRunError('')).toBeNull()
    expect(parseRunError(undefined)).toBeNull()
  })

  it('passes through the new top-level-message shape', () => {
    const stored = JSON.stringify({ message: 'Cancelled by user' })
    expect(parseRunError(stored)).toEqual({ message: 'Cancelled by user' })
  })

  it('passes through the new providers shape', () => {
    const stored = serializeRunError({
      providers: { gemini: { message: 'API key not valid', raw: { error: { code: 400 } } } },
    })
    expect(parseRunError(stored)).toEqual({
      providers: { gemini: { message: 'API key not valid', raw: { error: { code: 400 } } } },
    })
  })

  it('upgrades the legacy double-stringified shape on read', () => {
    // Before this PR, runs.error was written as JSON.stringify(Object.fromEntries(providerErrors))
    // where providerErrors held strings like "[provider-gemini] {"error":{...}}".
    const legacy = JSON.stringify({
      gemini: '[provider-gemini] {"error":{"code":400,"message":"API key not valid"}}',
    })
    expect(parseRunError(legacy)).toEqual({
      providers: {
        gemini: { message: 'API key not valid', raw: { error: { code: 400, message: 'API key not valid' } } },
      },
    })
  })

  it('wraps a non-JSON pre-structured cancellation in {message}', () => {
    expect(parseRunError('Cancelled by user')).toEqual({ message: 'Cancelled by user' })
  })
})

describe('runErrorSchema', () => {
  it('round-trips through serialize/parse', () => {
    const err = { providers: { gemini: { message: 'boom', raw: { error: { code: 500 } } } } }
    const serialized = serializeRunError(err)
    expect(parseRunError(serialized)).toEqual(err)
  })
})

describe('formatRunErrorOneLine', () => {
  it('formats a single provider as "name: message"', () => {
    expect(formatRunErrorOneLine({ providers: { gemini: { message: 'API key not valid' } } }))
      .toBe('gemini: API key not valid')
  })

  it('joins multiple providers with bullet separators', () => {
    expect(formatRunErrorOneLine({
      providers: {
        gemini: { message: 'API key not valid' },
        openai: { message: 'timeout' },
      },
    })).toBe('gemini: API key not valid • openai: timeout')
  })

  it('uses message for top-level errors (cancellation, internal failures)', () => {
    expect(formatRunErrorOneLine({ message: 'Cancelled by user' })).toBe('Cancelled by user')
  })

  it('falls back to a default when neither providers nor message is present', () => {
    expect(formatRunErrorOneLine({})).toBe('Run failed.')
  })

  it('never returns "[object Object]"', () => {
    const err = { providers: { gemini: { message: 'boom', raw: { weird: { circular: 1 } } } } }
    expect(formatRunErrorOneLine(err)).not.toContain('[object Object]')
  })
})

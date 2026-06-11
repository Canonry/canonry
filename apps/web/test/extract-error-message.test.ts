import { describe, expect, test } from 'vitest'

import { extractErrorMessage, extractApiErrorInfo } from '../src/lib/extract-error-message.js'

describe('extractErrorMessage', () => {
  test('returns the message of a plain Error', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom')
  })

  test('returns the message of an Error subclass (e.g. ApiError)', () => {
    class HttpError extends Error {}
    expect(extractErrorMessage(new HttpError('not found'))).toBe('not found')
  })

  test('returns a string value unchanged', () => {
    expect(extractErrorMessage('plain string failure')).toBe('plain string failure')
  })

  test('unwraps the raw API envelope the generated SDK throws', () => {
    // throwOnError:true makes fetchQuery throw `{ error: { message } }` — not an
    // Error — which previously stringified to "[object Object]" in the UI.
    expect(extractErrorMessage({ error: { code: 'FORBIDDEN', message: 'GSC API not enabled' } })).toBe('GSC API not enabled')
  })

  test('unwraps a string-valued envelope error', () => {
    expect(extractErrorMessage({ error: 'plain forbidden' })).toBe('plain forbidden')
  })

  test('stringifies a non-error object with no recognizable shape', () => {
    expect(extractErrorMessage({ nope: true })).toBe('[object Object]')
  })

  test('stringifies null and undefined', () => {
    expect(extractErrorMessage(null)).toBe('null')
    expect(extractErrorMessage(undefined)).toBe('undefined')
  })
})

describe('extractApiErrorInfo', () => {
  test('reads code + details off an Error subclass (ApiError)', () => {
    class ApiError extends Error {
      code = 'FORBIDDEN'
      details = { reason: 'gsc-api-disabled', enableUrl: 'https://x' }
    }
    expect(extractApiErrorInfo(new ApiError('nope'))).toEqual({
      message: 'nope',
      code: 'FORBIDDEN',
      details: { reason: 'gsc-api-disabled', enableUrl: 'https://x' },
    })
  })

  test('reads code + details off the raw SDK envelope', () => {
    expect(
      extractApiErrorInfo({ error: { code: 'FORBIDDEN', message: 'disabled', details: { reason: 'gsc-api-disabled' } } }),
    ).toEqual({ message: 'disabled', code: 'FORBIDDEN', details: { reason: 'gsc-api-disabled' } })
  })

  test('plain Error yields message only (no code/details)', () => {
    expect(extractApiErrorInfo(new Error('boom'))).toEqual({ message: 'boom', code: undefined, details: undefined })
  })

  test('ignores non-object details', () => {
    class ApiError extends Error {
      code = 'FORBIDDEN'
      details = 'not-an-object'
    }
    expect(extractApiErrorInfo(new ApiError('nope')).details).toBeUndefined()
  })

  test('falls back to String() for unrecognized values', () => {
    expect(extractApiErrorInfo(42)).toEqual({ message: '42' })
  })
})

import { describe, expect, test } from 'vitest'

import { extractErrorMessage } from '../src/lib/extract-error-message.js'

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

  test('stringifies a non-error object', () => {
    expect(extractErrorMessage({ nope: true })).toBe('[object Object]')
  })

  test('stringifies null and undefined', () => {
    expect(extractErrorMessage(null)).toBe('null')
    expect(extractErrorMessage(undefined)).toBe('undefined')
  })
})

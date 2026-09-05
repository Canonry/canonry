import { describe, it, expect } from 'vitest'
import { AppError, describeError, notFound, queryTrackingPreviewStale, validationError } from '../src/errors.js'

describe('describeError', () => {
  it('returns the message of an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError(new TypeError('bad type'))).toBe('bad type')
  })

  it('returns the message of an AppError subclass', () => {
    expect(describeError(notFound('Project', 'acme'))).toBe("Project 'acme' not found")
    expect(describeError(validationError('"queries" must be non-empty'))).toBe(
      '"queries" must be non-empty',
    )
    expect(describeError(new AppError('INTERNAL_ERROR', 'oops', 500))).toBe('oops')
  })

  it('preserves an empty Error message rather than substituting a placeholder', () => {
    // The caller threw an Error with nothing in it; inventing text here would
    // claim detail the throw site never provided.
    expect(describeError(new Error(''))).toBe('')
  })

  it('returns a thrown string unchanged', () => {
    expect(describeError('plain failure')).toBe('plain failure')
    expect(describeError('')).toBe('')
  })

  it('reports null and undefined as "unknown error"', () => {
    expect(describeError(null)).toBe('unknown error')
    expect(describeError(undefined)).toBe('unknown error')
  })

  it('serializes a plain object instead of rendering "[object Object]"', () => {
    // The whole point of the helper: String({code:'E'}) is '[object Object]',
    // which is the useless log line this replaces.
    expect(describeError({ code: 'E_LIMIT', message: 'rate limited' })).toBe(
      '{"code":"E_LIMIT","message":"rate limited"}',
    )
    expect(describeError({})).toBe('{}')
  })

  it('serializes an array', () => {
    expect(describeError([1, 'two'])).toBe('[1,"two"]')
    expect(describeError([])).toBe('[]')
  })

  it('renders primitives the way String() did, so migrated call sites do not change', () => {
    expect(describeError(42)).toBe('42')
    expect(describeError(0)).toBe('0')
    expect(describeError(true)).toBe('true')
    expect(describeError(false)).toBe('false')
  })

  it('falls back to String() when JSON.stringify throws on a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(describeError(circular)).toBe('[object Object]')
  })

  it('falls back to String() when JSON.stringify throws on a BigInt', () => {
    expect(describeError(BigInt(7))).toBe('7')
  })

  it('falls back to String() when JSON.stringify returns undefined', () => {
    // Functions and symbols are not JSON-representable.
    expect(describeError(Symbol('token'))).toBe('Symbol(token)')
    expect(describeError(function named() {})).toContain('named')
  })

  it('reports "unknown error" when the value cannot be stringified at all', () => {
    // Circular AND null-prototype: JSON.stringify throws, then String() throws
    // too. The helper must still return, not propagate a second failure out of
    // the catch block that was handling the first one.
    const hostile = Object.create(null) as Record<string, unknown>
    hostile.self = hostile
    expect(describeError(hostile)).toBe('unknown error')
  })

  it('never throws, whatever it is handed', () => {
    const throwingToString = {
      toString() {
        throw new Error('nope')
      },
      toJSON() {
        throw new Error('also nope')
      },
    }
    expect(() => describeError(throwingToString)).not.toThrow()
    expect(describeError(throwingToString)).toBe('unknown error')
  })

  it('uses a custom toJSON when the value defines one', () => {
    expect(describeError({ toJSON: () => ({ reason: 'quota' }) })).toBe('{"reason":"quota"}')
  })

  it('serializes an AppError-shaped plain object thrown by a non-Error path', () => {
    expect(describeError({ error: { code: 'NOT_FOUND', message: 'gone' } })).toBe(
      '{"error":{"code":"NOT_FOUND","message":"gone"}}',
    )
  })
})

describe('query tracking errors', () => {
  it('exposes only workspace fingerprints on a stale preview', () => {
    const error = queryTrackingPreviewStale('qtw_expected', 'qtw_actual')
    expect(error).toMatchObject({
      code: 'QUERY_TRACKING_PREVIEW_STALE',
      statusCode: 409,
      details: { expectedWorkspaceVersion: 'qtw_expected', actualWorkspaceVersion: 'qtw_actual' },
    })
  })
})

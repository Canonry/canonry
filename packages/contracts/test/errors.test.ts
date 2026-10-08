import { describe, it, expect } from 'vitest'
import { AppError, describeError, describeFetchError, isFetchTransportError, notFound, queryTrackingPreviewStale, researchDailyLimitExceeded, validationError } from '../src/errors.js'

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

// Shapes Node's fetch (undici) rejects with: a `TypeError('fetch failed')`
// whose `cause` is the system or undici error that names the failure.
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

describe('describeFetchError', () => {
  it('names a refused connection, the host, and the dialed address (a DNS filter answering 0.0.0.0)', () => {
    const err = fetchFailed(Object.assign(new Error('connect ECONNREFUSED 0.0.0.0:443'), {
      errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address: '0.0.0.0', port: 443,
    }))
    const text = describeFetchError(err, 'https://api.example.com/v1/customers:search?key=query-secret')
    expect(text).toBe('fetch failed (ECONNREFUSED connecting to api.example.com at 0.0.0.0:443)')
    expect(text).not.toContain('query-secret')
    expect(text).not.toContain('/v1')
  })

  it('names a DNS miss with the hostname the resolver was asked for', () => {
    const err = fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), {
      errno: -3008, code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'api.example.com',
    }))
    expect(describeFetchError(err)).toBe('fetch failed (ENOTFOUND resolving api.example.com)')
  })

  it.each([
    ['an undici connect timeout', 'UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: api.example.com:443, timeout: 10000ms)', 'fetch failed (UND_ERR_CONNECT_TIMEOUT connecting to api.example.com)'],
    ['a TLS alert', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'SSL routines:ssl3_read_bytes:tlsv1 alert internal error', 'fetch failed (ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR calling api.example.com)'],
    ['a reset socket', 'ECONNRESET', 'read ECONNRESET', 'fetch failed (ECONNRESET calling api.example.com)'],
  ])('names %s by its code and the request host', (_label, code, message, expected) => {
    const err = fetchFailed(Object.assign(new Error(message), { code }))
    expect(describeFetchError(err, new URL('https://api.example.com/path'))).toBe(expected)
  })

  it('reads the first member of an AggregateError and brackets an IPv6 address', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:443'), {
      code: 'ECONNREFUSED', syscall: 'connect', address: '::1', port: 443,
    })
    const err = fetchFailed(new AggregateError([refused], 'all addresses failed'))
    expect(describeFetchError(err, 'https://api.example.com/')).toBe('fetch failed (ECONNREFUSED connecting to api.example.com at [::1]:443)')
  })

  it('copies no cause message text, only the code and host', () => {
    const err = fetchFailed(Object.assign(new Error('connect ECONNREFUSED for Bearer token-value'), { code: 'ECONNREFUSED' }))
    const text = describeFetchError(err, 'https://api.example.com/')
    expect(text).toBe('fetch failed (ECONNREFUSED connecting to api.example.com)')
    expect(text).not.toContain('token-value')
  })

  it('returns describeError unchanged when nothing carries a code', () => {
    expect(describeFetchError(new TypeError('fetch failed'), 'https://api.example.com/')).toBe('fetch failed')
    // AbortSignal.timeout rejects with a DOMException whose legacy `code` is a number.
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(describeFetchError(timeout, 'https://api.example.com/')).toBe('The operation was aborted due to timeout')
    expect(describeFetchError('plain failure')).toBe('plain failure')
  })

  it('omits the host clause when there is no hostname and no parseable URL', () => {
    const err = fetchFailed(Object.assign(new Error('x'), { code: 'ECONNRESET' }))
    expect(describeFetchError(err, 'not a url')).toBe('fetch failed (ECONNRESET)')
  })

  it('never throws on a hostile cause', () => {
    const hostile = new TypeError('fetch failed')
    Object.defineProperty(hostile, 'cause', { get() { throw new Error('nope') } })
    expect(describeFetchError(hostile, 'https://api.example.com/')).toBe('fetch failed')
  })
})

describe('isFetchTransportError', () => {
  it('recognizes a request that got no answer', () => {
    expect(isFetchTransportError(fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND' })))).toBe(true)
    expect(isFetchTransportError(new TypeError('fetch failed'))).toBe(true)
    expect(isFetchTransportError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true)
    expect(isFetchTransportError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true)
  })

  it('rejects an error built from a response, or thrown before any request', () => {
    class ProviderAuthError extends Error {}
    expect(isFetchTransportError(new ProviderAuthError('Token refresh failed (400): invalid_grant'))).toBe(false)
    expect(isFetchTransportError(new Error('invalid_grant'))).toBe(false)
    expect(isFetchTransportError(new TypeError('Failed to parse URL from not a url'))).toBe(false)
    expect(isFetchTransportError(Object.assign(new Error('unsupported key'), { code: 'ERR_OSSL_UNSUPPORTED' }))).toBe(false)
    expect(isFetchTransportError('fetch failed')).toBe(false)
    expect(isFetchTransportError(null)).toBe(false)
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
    expect(error.details).toEqual({ expectedWorkspaceVersion: 'qtw_expected', actualWorkspaceVersion: 'qtw_actual' })
  })
})

describe('research errors', () => {
  it('returns a typed daily-limit error with operator-readable details', () => {
    expect(researchDailyLimitExceeded('demo', 20, '2026-09-08')).toMatchObject({
      code: 'RESEARCH_DAILY_LIMIT_EXCEEDED',
      statusCode: 429,
      details: { projectName: 'demo', limit: 20, date: '2026-09-08' },
    })
  })
})

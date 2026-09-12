import { describe, expect, it } from 'vitest'
import { redactLogString, redactLogValue } from '../src/log-redaction.js'

describe('log redaction', () => {
  it.each([
    'Cookie: theme=dark; canonry_user_session=fixture-secret',
    'Set-Cookie: theme=dark;\r\n canonry_user_session=fixture-secret',
    'API key: fixture-secret',
    'https://gateway.invalid/v1?key=fixture-secret&safe=yes',
    JSON.stringify({ message: JSON.stringify({ apiKey: 'fixture-secret' }) }),
    JSON.stringify(JSON.stringify({ authorization: 'fixture-secret' })),
    String.raw`provider returned {\"password\":\"fixture-secret\"}`,
  ])('redacts secret-bearing diagnostic format: %s', message => {
    const output = redactLogString(message)
    expect(output).not.toContain('fixture-secret')
    expect(decodeURIComponent(output)).toContain('[REDACTED]')
    expect(redactLogString(output)).toBe(output)
  })

  it('preserves safe diagnostics and masks an entire quoted secret containing escaped quotes', () => {
    expect(redactLogString('request failed: HTTP 503')).toBe('request failed: HTTP 503')
    expect(redactLogString('https://gateway.invalid/v1?monkey=visible&safe=yes')).toContain('monkey=visible')
    expect(redactLogString(JSON.stringify({ password: 'start"fixture-secret' }))).not.toContain('fixture-secret')
  })

  it('redacts quoted and whitespace-containing secret assignments in free-text failures', () => {
    const message = `provider error: {"apiKey":"json-secret", 'password': 'two word secret', "access_token": "token-secret"}; password="another secret"`
    const output = redactLogString(message)
    expect(output).not.toMatch(/json-secret|two word secret|token-secret|another secret/)
    expect(output).toContain('provider error')
  })

  it('redacts nested secrets, credentials, URLs, and diagnostic strings', () => {
    const error = new Error('upstream rejected Bearer bearer-secret at https://user:password@example.test/a?api_key=query-secret&safe=yes')
    ;(error as Error & { token: string }).token = 'object-secret'
    const result = redactLogValue({ authorization: 'Basic raw-secret', nested: { error } })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toMatch(/bearer-secret|user:password|query-secret|object-secret|raw-secret/)
    expect(serialized).toContain('example.test')
    expect(serialized).toContain('safe=yes')
  })

  it('never throws for circular values, throwing getters, and malformed URLs', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'password', { enumerable: true, get() { throw new Error('getter') } })

    expect(() => redactLogValue({ circular, hostile })).not.toThrow()
    const malformed = redactLogString('failed https://user:pass@example.test/?token=partial%zz')
    expect(malformed).not.toContain('user:pass')
    expect(malformed).not.toContain('partial%zz')
  })
})

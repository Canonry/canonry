import { describe, expect, it } from 'vitest'
import { credentialRedactionValues, credentialTextProblem, credentialTextSchema, redactKnownSecrets } from '../src/index.js'

describe('credentialTextProblem', () => {
  it('accepts one token, and spaces only where they are allowed', () => {
    expect(credentialTextProblem('vcp_abc123', 'Vercel token')).toBeNull()
    expect(credentialTextProblem('  vcp_abc123\n', 'Vercel token')).toBeNull()
    expect(credentialTextProblem('abcd efgh ijkl', 'WordPress application password', { allowSpaces: true })).toBeNull()
  })

  it.each([
    { value: 'vcp_first_secret\nvcp_second_secret', problem: 'The Vercel token has 2 lines; it must be a single line. If it came from a file, write the file with > (replace), not >> (append).' },
    { value: 'vcp_first_secret\r\nvcp_second_secret\nthird', problem: 'The Vercel token has 3 lines; it must be a single line. If it came from a file, write the file with > (replace), not >> (append).' },
    { value: 'vcp_first_secret vcp_second_secret', problem: 'The Vercel token contains a space; paste only the token.' },
    { value: 'vcp_first_secret\tvcp_second_secret', problem: 'The Vercel token contains a control character.' },
    { value: '   \n  ', problem: 'The Vercel token is empty.' },
  ])('names the problem without the value: $problem', ({ value, problem }) => {
    expect(credentialTextProblem(value, 'Vercel token')).toBe(problem)
    expect(problem).not.toContain('secret')
  })

  it('still refuses a second line where spaces are allowed', () => {
    expect(credentialTextProblem('abcd efgh\nijkl mnop', 'WordPress application password', { allowSpaces: true }))
      .toMatch(/has 2 lines/)
  })
})

describe('credentialTextSchema', () => {
  const schema = credentialTextSchema('Vercel token')

  it('trims a valid value', () => {
    expect(schema.parse('  vcp_abc123\n')).toBe('vcp_abc123')
  })

  it('reports the problem in the issue message and keeps the value out of the issues', () => {
    const result = schema.safeParse('vcp_first_secret\nvcp_second_secret')
    expect(result.success).toBe(false)
    expect(result.error!.issues.map(issue => issue.message)).toEqual([
      'The Vercel token has 2 lines; it must be a single line. If it came from a file, write the file with > (replace), not >> (append).',
    ])
    expect(JSON.stringify(result.error!.issues)).not.toContain('secret')
  })

  it('refuses an empty value', () => {
    expect(schema.safeParse('  ').error!.issues[0]!.message).toBe('The Vercel token is empty.')
  })
})

describe('credentialRedactionValues', () => {
  it('covers the whole value and each line of it', () => {
    const token = 'vcp_first_secret\nvcp_second_secret'
    const message = `Headers.append: "Bearer ${token}" is invalid; retried with vcp_second_secret`
    expect(redactKnownSecrets(message, credentialRedactionValues(token)))
      .toBe('Headers.append: "Bearer [REDACTED]" is invalid; retried with [REDACTED]')
  })

  it('returns nothing for a missing value', () => {
    expect(credentialRedactionValues(undefined)).toEqual([])
    expect(credentialRedactionValues('')).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { escapeRegExp } from '../src/regexp.js'

const METACHARACTERS = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'] as const

describe('escapeRegExp', () => {
  it('backslash-escapes every RegExp metacharacter', () => {
    expect(escapeRegExp(METACHARACTERS.join(''))).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  })

  it.each(METACHARACTERS)('builds a pattern that matches %s only as itself', (character) => {
    const pattern = new RegExp(`^${escapeRegExp(character)}$`)
    expect(pattern.test(character)).toBe(true)
    expect(pattern.test('a')).toBe(false)
    expect(pattern.test('')).toBe(false)
  })

  it('returns an empty string for empty input', () => {
    expect(escapeRegExp('')).toBe('')
  })

  it('leaves ordinary characters untouched', () => {
    expect(escapeRegExp('abc-123_é /=')).toBe('abc-123_é /=')
  })

  it('blanks every occurrence of a secret that contains metacharacters, and nothing else', () => {
    const secret = 'a+b.c?(d)'
    const body = `token ${secret} rejected; retry with ${secret} or aab-c`
    expect(body.replace(new RegExp(escapeRegExp(secret), 'g'), '***')).toBe('token *** rejected; retry with *** or aab-c')
  })
})

import { describe, it, expect } from 'vitest'
import { escapeLikePattern } from '../src/sql-like.js'

describe('escapeLikePattern', () => {
  it('escapes the three LIKE metacharacters', () => {
    expect(escapeLikePattern('%')).toBe('\\%')
    expect(escapeLikePattern('_')).toBe('\\_')
    expect(escapeLikePattern('\\')).toBe('\\\\')
  })

  it('escapes every occurrence, not just the first', () => {
    expect(escapeLikePattern('100%_off%')).toBe('100\\%\\_off\\%')
  })

  it('escapes the backslash so a crafted escape sequence cannot be smuggled in', () => {
    // Raw `\%` (a backslash then percent) must become `\\\%` — the literal
    // backslash and the literal percent, each escaped — so neither the input
    // backslash acts as an escape char nor the percent as a wildcard.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })

  it('leaves ordinary characters untouched', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world')
    expect(escapeLikePattern('')).toBe('')
    expect(escapeLikePattern('café.com')).toBe('café.com')
  })

})

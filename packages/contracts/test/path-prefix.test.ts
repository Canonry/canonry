import { describe, expect, it } from 'vitest'
import { normalizePathPrefix } from '../src/url-normalize.js'
describe('normalized landing-page prefix', () => {
  it.each([[undefined, null], ['', null], ['/', '/'], ['pricing/', '/pricing'], ['/pricing/?utm_source=sample', '/pricing'], ['/pricing?plan=team', '/pricing?plan=team'], ['/offers%_x/', '/offers%_x']])('normalizes %s as %s', (input, expected) => {
    expect(normalizePathPrefix(input ?? undefined)).toBe(expected)
  })
})

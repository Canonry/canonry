import { describe, expect, it } from 'vitest'
import { compareText, sortedUnique } from '../src/text-order.js'

describe('compareText', () => {
  it('returns -1, 0 or 1', () => {
    expect(compareText('a', 'b')).toBe(-1)
    expect(compareText('b', 'a')).toBe(1)
    expect(compareText('a', 'a')).toBe(0)
    expect(compareText('', '')).toBe(0)
  })

  it('orders by UTF-16 code unit, so every uppercase ASCII letter sorts before every lowercase one', () => {
    expect(compareText('B', 'a')).toBe(-1)
    expect(['b', 'a', 'B', 'é', 'e', 'A'].sort(compareText)).toEqual(['A', 'B', 'a', 'b', 'e', 'é'])
  })

  it('sorts a prefix before the longer string', () => {
    expect(['abc', 'ab', 'a', ''].sort(compareText)).toEqual(['', 'a', 'ab', 'abc'])
  })

  it('compares code units, not code points, so an astral character sorts before a high BMP one', () => {
    // U+1F600 is the surrogate pair D83D DE00; U+FF5E is a single code unit above D83D.
    expect(compareText('\u{1F600}', '～')).toBe(-1)
  })
})

describe('sortedUnique', () => {
  it('returns an empty array for empty input', () => {
    expect(sortedUnique([])).toEqual([])
  })

  it('drops duplicates and sorts with compareText', () => {
    expect(sortedUnique(['b', 'a', 'b', 'B', 'a', ''])).toEqual(['', 'B', 'a', 'b'])
  })

  it('keeps values that differ only in case', () => {
    expect(sortedUnique(['Alpha', 'alpha', 'ALPHA'])).toEqual(['ALPHA', 'Alpha', 'alpha'])
  })

  it('returns a new array and leaves the input untouched', () => {
    const input = ['c', 'a', 'c']
    const result = sortedUnique(input)
    expect(result).toEqual(['a', 'c'])
    expect(input).toEqual(['c', 'a', 'c'])
    expect(result).not.toBe(input)
  })
})

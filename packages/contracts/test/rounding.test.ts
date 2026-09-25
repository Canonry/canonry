import { describe, expect, it } from 'vitest'
import { roundPreservingTotal } from '../src/rounding.js'

/** The sixteen core audit factor weights, in `@canonry/aeo-audit` definition order. They sum to 111. */
const CORE_WEIGHTS = [12, 10, 5, 8, 8, 8, 8, 5, 7, 7, 6, 6, 4, 6, 5, 6]

function sum(values: readonly number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(6))
}

describe('roundPreservingTotal', () => {
  it('splits 100 across the core audit weights into tenths that add up to exactly 100', () => {
    const exact = CORE_WEIGHTS.map((weight) => (weight / 111) * 100)
    // Rounding each share on its own is the bug this exists for: 99.9, not 100.
    expect(sum(exact.map((share) => Math.round(share * 10) / 10))).toBe(99.9)

    const shares = roundPreservingTotal(exact, 1)
    // The one leftover tenth goes to the largest remainder: 12/111 = 10.8108...
    expect(shares).toEqual([10.9, 9, 4.5, 7.2, 7.2, 7.2, 7.2, 4.5, 6.3, 6.3, 5.4, 5.4, 3.6, 5.4, 4.5, 5.4])
    expect(sum(shares)).toBe(100)
  })

  it('keeps every result within one unit of its value', () => {
    const exact = CORE_WEIGHTS.map((weight) => (weight / 111) * 100)
    roundPreservingTotal(exact, 1).forEach((share, index) => {
      expect(Math.abs(share - exact[index]!)).toBeLessThan(0.1)
    })
  })

  it('gives a tied remainder to the earlier value, so the caller order decides', () => {
    const third = 100 / 3
    expect(roundPreservingTotal([third, third, third], 1)).toEqual([33.4, 33.3, 33.3])
    expect(roundPreservingTotal([33.5, 33.5, 33], 0)).toEqual([34, 33, 33])
  })

  it('leaves values that are already exact at the precision untouched', () => {
    expect(roundPreservingTotal([25, 25, 50], 1)).toEqual([25, 25, 50])
    expect(roundPreservingTotal([10.9, 9, 80.1], 1)).toEqual([10.9, 9, 80.1])
  })

  it('preserves the rounded total when the values do not add up to a round number', () => {
    // 30.12 rounds to 30.1, so exactly one of the three gains the tenth.
    expect(roundPreservingTotal([10.04, 10.04, 10.04], 1)).toEqual([10.1, 10, 10])
  })

  it('removes the float error of the scaling before it decides a remainder', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary, which is still 3 tenths.
    expect(roundPreservingTotal([0.1 + 0.2, 0.7], 1)).toEqual([0.3, 0.7])
    // The mean of six stored 0.1 shares is 0.09999999999999999, still one tenth.
    expect(roundPreservingTotal([(0.1 + 0.1 + 0.1 + 0.1 + 0.1 + 0.1) / 6, 99.9], 1)).toEqual([0.1, 99.9])
    // 0.14 and 0.34 both leave a remainder of 0.4 tenths, but scaled they come to
    // 1.4000000000000001 and 3.4000000000000004. Compared raw, the float noise
    // would hand the one spare tenth to the later value; the tie is the earlier one's.
    expect(roundPreservingTotal([0.14, 0.34, 0.02], 1)).toEqual([0.2, 0.3, 0])
  })

  it('handles an empty list and an all-zero list', () => {
    expect(roundPreservingTotal([], 1)).toEqual([])
    expect(roundPreservingTotal([0, 0], 1)).toEqual([0, 0])
  })

  it('refuses a value it cannot round and a precision outside 0 to 6', () => {
    expect(() => roundPreservingTotal([1, Number.NaN], 1)).toThrow(RangeError)
    expect(() => roundPreservingTotal([Number.POSITIVE_INFINITY], 1)).toThrow(RangeError)
    expect(() => roundPreservingTotal([1], -1)).toThrow(RangeError)
    expect(() => roundPreservingTotal([1], 1.5)).toThrow(RangeError)
    expect(() => roundPreservingTotal([1], 7)).toThrow(RangeError)
  })
})

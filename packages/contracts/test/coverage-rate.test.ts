import { describe, expect, it } from 'vitest'
import { rateOverChecked, rateOverCheckedAnswers } from '../src/coverage-rate.js'

describe('rateOverChecked', () => {
  it('takes the rate over the checked answers and counts the rest beside it', () => {
    // Ten saved answers, one could not be checked: 3 of the 9 checked.
    expect(rateOverChecked(3, 10, 1, 'unchecked')).toEqual({ numerator: 3, denominator: 9, rate: 3 / 9, unchecked: 1 })
    expect(rateOverChecked(10, 12, 1, 'unattributed')).toEqual({ numerator: 10, denominator: 11, rate: 10 / 11, unattributed: 1 })
  })

  it('omits the count when nothing was left out, so absent is the one encoding of none', () => {
    const rate = rateOverChecked(2, 4, 0, 'unchecked')
    expect(rate).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(rate).not.toHaveProperty('unchecked')
    expect(rate).not.toHaveProperty('unattributed')
  })

  it('keeps the key order numerator, denominator, rate, then the count', () => {
    expect(JSON.stringify(rateOverChecked(1, 3, 1, 'unattributed')))
      .toBe('{"numerator":1,"denominator":2,"rate":0.5,"unattributed":1}')
  })

  it('reads the rounding edges exactly', () => {
    expect(rateOverChecked(0, 2, 1, 'unchecked')).toEqual({ numerator: 0, denominator: 1, rate: 0, unchecked: 1 })
    expect(rateOverChecked(1, 2, 1, 'unchecked')).toEqual({ numerator: 1, denominator: 1, rate: 1, unchecked: 1 })
  })

  it('returns null when nothing is left to check', () => {
    expect(rateOverChecked(0, 3, 3, 'unchecked')).toBeNull()
    expect(rateOverChecked(0, 0, 0, 'unattributed')).toBeNull()
  })

  it('refuses counts that cannot describe one population', () => {
    expect(() => rateOverChecked(-1, 3, 0, 'unchecked')).toThrow(RangeError)
    expect(() => rateOverChecked(1.5, 3, 0, 'unchecked')).toThrow(RangeError)
    expect(() => rateOverChecked(0, 3, 4, 'unchecked')).toThrow(RangeError)
    // A positive from a left-out answer is not on either side of the rate.
    expect(() => rateOverChecked(3, 3, 1, 'unchecked')).toThrow(RangeError)
  })
})

describe('rateOverCheckedAnswers', () => {
  it('leaves a citation rate\'s partly saved and source-less answers out, each under its own count', () => {
    // Ten saved answers: one partly saved, three from an engine with no sources.
    expect(rateOverCheckedAnswers(2, 10, { unchecked: 1, citationNotMeasured: 3 }))
      .toEqual({ numerator: 2, denominator: 6, rate: 2 / 6, unchecked: 1, citationNotMeasured: 3 })
    // A zero count is absent, as for one reason.
    expect(rateOverCheckedAnswers(1, 3, { unchecked: 0, citationNotMeasured: 1 }))
      .toEqual({ numerator: 1, denominator: 2, rate: 0.5, citationNotMeasured: 1 })
  })

  it('has no rate when every answer was left out, and refuses more left out than answered', () => {
    expect(rateOverCheckedAnswers(0, 2, { unchecked: 1, citationNotMeasured: 1 })).toBeNull()
    expect(() => rateOverCheckedAnswers(0, 2, { unchecked: 2, citationNotMeasured: 1 })).toThrow(RangeError)
    expect(() => rateOverCheckedAnswers(2, 3, { citationNotMeasured: 2 })).toThrow(RangeError)
  })
})

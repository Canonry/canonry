import { describe, expect, it } from 'vitest'
import { businessProfileReviewsCover, isNegativeReviewRating } from '../src/gbp.js'

describe('isNegativeReviewRating', () => {
  it('treats 1-3 stars as negative and no rating as not', () => {
    expect([null, 0, 1, 2, 3, 4, 5].map(isNegativeReviewRating)).toEqual([false, false, true, true, true, false, false])
  })
})

describe('businessProfileReviewsCover', () => {
  it('covers a location where v4 works, or failed transiently after working', () => {
    expect(businessProfileReviewsCover('ok', false)).toBe(true)
    expect(businessProfileReviewsCover('error', true)).toBe(true)
  })

  it('does not cover a gated location, a first-time failure, or one never checked', () => {
    expect(businessProfileReviewsCover('unavailable', true)).toBe(false)
    expect(businessProfileReviewsCover('error', false)).toBe(false)
    expect(businessProfileReviewsCover(null, true)).toBe(false)
  })
})

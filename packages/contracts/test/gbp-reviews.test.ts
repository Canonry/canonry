import { describe, expect, it } from 'vitest'
import { businessProfileReviewsCover, gbpNegativeReviewMaxStarsSchema, isNegativeReviewRating, resolveNegativeReviewMaxStars } from '../src/gbp.js'

describe('isNegativeReviewRating', () => {
  const ratings = [null, 0, 1, 2, 3, 4, 5]

  it('treats 1-3 stars as negative by default and no rating as not', () => {
    expect(ratings.map((r) => isNegativeReviewRating(r))).toEqual([false, false, true, true, true, false, false])
  })

  it("uses a project's own threshold", () => {
    expect(ratings.map((r) => isNegativeReviewRating(r, 1))).toEqual([false, false, true, false, false, false, false])
    expect(ratings.map((r) => isNegativeReviewRating(r, 4))).toEqual([false, false, true, true, true, true, false])
  })
})

describe('negative review threshold setting', () => {
  it('falls back to 3 stars when a project has not set one', () => {
    expect(resolveNegativeReviewMaxStars(null)).toBe(3)
    expect(resolveNegativeReviewMaxStars(undefined)).toBe(3)
    expect(resolveNegativeReviewMaxStars(2)).toBe(2)
  })

  it('accepts whole stars from 1 to 4', () => {
    expect([1, 2, 3, 4].every((v) => gbpNegativeReviewMaxStarsSchema.safeParse(v).success)).toBe(true)
    expect([0, 5, 2.5].some((v) => gbpNegativeReviewMaxStarsSchema.safeParse(v).success)).toBe(false)
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

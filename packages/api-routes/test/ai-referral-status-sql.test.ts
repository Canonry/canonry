import { describe, expect, it } from 'vitest'
import { QueryBuilder } from 'drizzle-orm/sqlite-core'
import { aiReferralEventsHourly } from '@canonry/canonry-db'
import { countableReferralCondition, referralLandedCondition } from '../src/ai-referral-status.js'

describe('generated SQL sanity', () => {
  it('landed condition binds the five redirect codes as params', () => {
    const qb = new QueryBuilder()
    const { sql, params } = qb.select().from(aiReferralEventsHourly).where(referralLandedCondition()).toSQL()
    expect(sql).toMatch(/"status" NOT IN \(\?, \?, \?, \?, \?\)/)
    expect(params).toEqual([301, 302, 303, 307, 308])
  })
  it('countable condition carries both halves', () => {
    const qb = new QueryBuilder()
    const { sql, params } = qb.select().from(aiReferralEventsHourly).where(countableReferralCondition()).toSQL()
    expect(sql).toMatch(/NOT IN \(\?, \?, \?, \?, \?\)/)
    expect((sql.match(/NOT LIKE/g) ?? []).length).toBe(19)
    expect(params.slice(-5)).toEqual([301, 302, 303, 307, 308])
  })
  it('the singleton fragment serializes identically on repeated use', () => {
    const one = new QueryBuilder().select().from(aiReferralEventsHourly).where(referralLandedCondition()).toSQL()
    const two = new QueryBuilder().select().from(aiReferralEventsHourly).where(referralLandedCondition()).toSQL()
    expect(two.sql).toBe(one.sql)
    expect(two.params).toEqual(one.params)
  })
})

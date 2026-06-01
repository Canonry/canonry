import { describe, it, expect } from 'vitest'
import { schedulableRunKindSchema, SchedulableRunKinds } from '../src/schedule.js'

describe('schedulableRunKindSchema', () => {
  it('accepts answer-visibility, traffic-sync, gbp-sync, data-refresh, and backlinks-sync', () => {
    expect(schedulableRunKindSchema.safeParse('answer-visibility').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('traffic-sync').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('gbp-sync').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('data-refresh').success).toBe(true)
    expect(schedulableRunKindSchema.safeParse('backlinks-sync').success).toBe(true)
  })

  it('rejects non-schedulable run kinds', () => {
    // gsc-sync is a real RunKind but is not user-schedulable.
    expect(schedulableRunKindSchema.safeParse('gsc-sync').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('inspect-sitemap').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('backlink-extract').success).toBe(false)
    expect(schedulableRunKindSchema.safeParse('nonsense').success).toBe(false)
  })

  it('exposes gbp-sync and backlinks-sync enum constants', () => {
    expect(SchedulableRunKinds['gbp-sync']).toBe('gbp-sync')
    expect(SchedulableRunKinds['backlinks-sync']).toBe('backlinks-sync')
  })
})

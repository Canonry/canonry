import { describe, expect, it } from 'vitest'

import {
  advancedProjectTagDetail,
  resolveAdvancedMeasurementMode,
} from '../src/components/project/advanced-measurement/model.js'

describe('advanced measurement mode', () => {
  it('keeps an untouched project on the existing overview', () => {
    expect(resolveAdvancedMeasurementMode({ activePlanSchemaVersion: null, hasDraft: false })).toEqual({
      surface: 'simple-overview',
      setupAction: 'set-up',
    })
  })

  it('keeps a draft-only project on the existing overview', () => {
    expect(resolveAdvancedMeasurementMode({ activePlanSchemaVersion: null, hasDraft: true })).toEqual({
      surface: 'simple-overview',
      setupAction: 'continue',
    })
  })

  it('routes a version-one plan to the advanced overview with a republish action', () => {
    expect(resolveAdvancedMeasurementMode({ activePlanSchemaVersion: 1, hasDraft: false })).toEqual({
      surface: 'advanced-overview-v1',
      setupAction: 'republish',
    })
  })

  it('routes a current plan to the advanced overview', () => {
    expect(resolveAdvancedMeasurementMode({ activePlanSchemaVersion: 2, hasDraft: false })).toEqual({
      surface: 'advanced-overview',
      setupAction: 'edit',
    })
  })

  it('keeps active results while sending an unpublished v2 draft back to setup', () => {
    expect(resolveAdvancedMeasurementMode({ activePlanSchemaVersion: 2, hasDraft: true })).toEqual({
      surface: 'advanced-overview',
      setupAction: 'continue',
    })
  })
})

describe('advanced project tag', () => {
  it('counts every property and only top-level markets', () => {
    expect(advancedProjectTagDetail({
      targets: [{}, {}, {}, {}],
      groups: [{}, {}, { parentGroupKey: 'east' }],
    })).toBe('4 locations · 2 markets')
  })

  it('uses singular nouns for one property and one market', () => {
    expect(advancedProjectTagDetail({ targets: [{}], groups: [{}] })).toBe('1 location · 1 market')
  })

  it('omits markets when the setup has none', () => {
    expect(advancedProjectTagDetail({ targets: [{}, {}], groups: [] })).toBe('2 locations')
  })
})

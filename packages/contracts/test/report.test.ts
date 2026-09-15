import { describe, expect, test } from 'vitest'
import { reportPressureTone, reportSeverityTone, reportSourceCategoryTone } from '../src/report.js'
import { sourceCategorySchema } from '../src/source-categories.js'

describe('reportPressureTone', () => {
  test('high pressure is negative, moderate caution, low positive, none neutral', () => {
    expect((['High', 'Moderate', 'Low', 'None'] as const).map(reportPressureTone)).toEqual(['negative', 'caution', 'positive', 'neutral'])
  })
})

describe('reportSeverityTone', () => {
  test('critical and high are negative, medium caution, low neutral', () => {
    expect((['critical', 'high', 'medium', 'low'] as const).map(reportSeverityTone)).toEqual(['negative', 'negative', 'caution', 'neutral'])
  })
})

describe('reportSourceCategoryTone', () => {
  test('competitor sources are negative, directories and forums caution, every other category neutral', () => {
    expect(Object.fromEntries(sourceCategorySchema.options.map(category => [category, reportSourceCategoryTone(category)]))).toEqual({
      competitor: 'negative',
      directory: 'caution',
      social: 'neutral',
      forum: 'caution',
      news: 'neutral',
      reference: 'neutral',
      blog: 'neutral',
      ecommerce: 'neutral',
      video: 'neutral',
      academic: 'neutral',
      other: 'neutral',
    })
  })

  test('a category the enum does not know is neutral', () => {
    expect(reportSourceCategoryTone('legacy-bucket')).toBe('neutral')
    expect(reportSourceCategoryTone('')).toBe('neutral')
  })
})

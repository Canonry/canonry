import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { RATIO_UNIT_META_KEY, fraction, percent, ratioUnitOf } from '../src/ratio-unit.js'

describe('ratio units', () => {
  test('a declared unit reads back from its schema', () => {
    expect(ratioUnitOf(fraction())).toBe('fraction')
    expect(ratioUnitOf(percent())).toBe('percent')
    expect(ratioUnitOf(z.number())).toBeUndefined()
    expect(ratioUnitOf(z.string())).toBeUndefined()
  })

  test('optional, nullable and default wrappers do not hide the unit', () => {
    expect(ratioUnitOf(fraction().nullable())).toBe('fraction')
    expect(ratioUnitOf(fraction().optional())).toBe('fraction')
    expect(ratioUnitOf(percent().nullable().optional())).toBe('percent')
    expect(ratioUnitOf(fraction().default(0))).toBe('fraction')
  })

  test('bounds set before the unit still validate', () => {
    const share = fraction(z.number().min(0).max(1))
    expect(ratioUnitOf(share)).toBe('fraction')
    expect(share.safeParse(0.5).success).toBe(true)
    expect(share.safeParse(1.5).success).toBe(false)
    const whole = percent(z.number().int().nonnegative())
    expect(whole.safeParse(2.5).success).toBe(false)
  })

  test('the unit reaches JSON Schema as an OpenAPI vendor extension', () => {
    const schema = z.object({ share: fraction(), sharePct: percent().nullable(), count: z.number() })
    const json = z.toJSONSchema(schema, { target: 'draft-7' }) as { properties: Record<string, unknown> }
    expect(json.properties.share).toMatchObject({ type: 'number', [RATIO_UNIT_META_KEY]: 'fraction' })
    expect(JSON.stringify(json.properties.sharePct)).toContain(`"${RATIO_UNIT_META_KEY}":"percent"`)
    expect(json.properties.count).not.toHaveProperty(RATIO_UNIT_META_KEY)
    expect(RATIO_UNIT_META_KEY.startsWith('x-')).toBe(true)
  })
})

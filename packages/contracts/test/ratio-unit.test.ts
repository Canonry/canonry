import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { formatPercent } from '../src/formatting.js'
import {
  RATIO_FIELD_NAME_PATTERN,
  RATIO_UNIT_META_KEY,
  RATIO_WIRE_DECIMALS,
  fraction,
  percent,
  percentOf,
  ratioUnitOf,
  roundRatio,
  undeclaredRatioFields,
} from '../src/ratio-unit.js'

type JsonSchema = Record<string, unknown>

function openApi(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as JsonSchema
}

function draft7(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchema
}

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

describe('ratio wire precision', () => {
  test('a fraction keeps four decimals and a percent two: the same hundredth of a point', () => {
    expect(RATIO_WIRE_DECIMALS).toEqual({ fraction: 4, percent: 2 })
    expect(roundRatio(2 / 3, 'fraction')).toBe(0.6667)
    expect(roundRatio((2 / 3) * 100, 'percent')).toBe(66.67)
    expect(roundRatio(0.00004, 'fraction')).toBe(0)
    expect(roundRatio(0.004, 'percent')).toBe(0)
  })

  test('rounds half up and never returns a negative zero', () => {
    expect(roundRatio(12.345, 'percent')).toBe(12.35)
    expect(roundRatio(-66.666, 'percent')).toBe(-66.67)
    expect(Object.is(roundRatio(-0.001, 'percent'), 0)).toBe(true)
  })

  test('a half is judged on the decimal value, not the float the scaling leaves', () => {
    // 1.005 * 100 is 100.49999999999999 in binary, which would round down.
    expect(roundRatio(1.005, 'percent')).toBe(1.01)
    expect(roundRatio(0.00125, 'fraction')).toBe(0.0013)
  })

  test('percentOf is part / whole as 0..100 at two decimals', () => {
    expect(percentOf(2, 3)).toBe(66.67)
    expect(percentOf(1, 3)).toBe(33.33)
    expect(percentOf(3, 3)).toBe(100)
    expect(percentOf(0, 3)).toBe(0)
    expect(percentOf(57, 200)).toBe(28.5)
  })

  test('the values a whole-percent rounding used to flatten survive', () => {
    // 1 of 250 is 0.4%, which a whole percent sent as 0 and showed as "0%".
    expect(percentOf(1, 250)).toBe(0.4)
    expect(formatPercent(percentOf(1, 250), 'percent')).toBe('0.4%')
    // 249 of 250 is 99.6%, which a whole percent sent as 100 and showed as "100%".
    expect(percentOf(249, 250)).toBe(99.6)
    expect(formatPercent(percentOf(249, 250), 'percent')).toBe('99.6%')
    // 2 of 3 is 66.7%, which a whole percent sent as 67 and showed as "67.0%".
    expect(formatPercent(percentOf(2, 3), 'percent')).toBe('66.7%')
    // Near the edges the display keeps its inexact markers: 1 of 3,000 is 0.03%
    // and 2,999 of 3,000 is 99.97%, never an exact-looking 0% or 100%.
    expect(percentOf(1, 3000)).toBe(0.03)
    expect(formatPercent(percentOf(1, 3000), 'percent')).toBe('<0.1%')
    expect(percentOf(2999, 3000)).toBe(99.97)
    expect(formatPercent(percentOf(2999, 3000), 'percent')).toBe('>99.9%')
  })

  test('an empty or invalid whole is not a measured 0%', () => {
    expect(percentOf(0, 0)).toBeNull()
    expect(percentOf(5, 0)).toBeNull()
    expect(percentOf(1, -4)).toBeNull()
    expect(percentOf(1, Number.NaN)).toBeNull()
  })
})

describe('ratio field names', () => {
  test('a name ending in a ratio word, or a bare ctr, reads as a ratio', () => {
    for (const name of ['citationRate', 'rate', 'mentionShare', 'share', 'templateRatio', 'percent', 'percentage',
      'sharePct', 'thresholdedPct', 'answerCoverage', 'dedupBandPairFraction', 'ctr', 'CTR']) {
      expect(RATIO_FIELD_NAME_PATTERN.test(name), name).toBe(true)
    }
  })

  test('a ratio word anywhere but the end, or ctr inside a longer name, does not', () => {
    for (const name of ['shareOfVoice', 'rateLimit', 'ratedAt', 'percentileRank', 'ctrTrend', 'avgCtrPosition', 'clicks', 'sharePctDisplay']) {
      expect(RATIO_FIELD_NAME_PATTERN.test(name), name).toBe(false)
    }
  })
})

describe('undeclared ratio fields', () => {
  test('a declared schema reports nothing, and a count beside it is never a ratio', () => {
    const schema = z.object({ citationRate: fraction(), sharePct: percent(), cited: z.number().int() })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual([])
    expect(undeclaredRatioFields(draft7(schema), 'Dto')).toEqual([])
  })

  test('nested objects are walked and each path names the field exactly', () => {
    const schema = z.object({
      totals: z.object({ ctr: z.number(), clicks: z.number() }),
      summary: z.object({ inner: z.object({ mentionRate: z.number(), citedRate: fraction() }) }),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.summary.inner.mentionRate', 'Dto.totals.ctr'])
  })

  test('array items are walked, including an array nested in an array', () => {
    const schema = z.object({
      rows: z.array(z.object({ ctr: z.number(), clicks: z.number() })),
      grid: z.array(z.array(z.object({ share: z.number() }))),
      declared: z.array(z.object({ ctr: fraction() })),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.grid[][].share', 'Dto.rows[].ctr'])
  })

  test('nullable and union numbers count in both targets, and a unit on the member declares them', () => {
    const schema = z.object({
      bare: z.object({ rate: z.number().nullable(), percent: z.union([z.number(), z.null()]).optional() }),
      declared: z.object({ rate: fraction().nullable(), percent: z.union([percent(), z.null()]).optional() }),
    })
    const expected = ['Dto.bare.percent', 'Dto.bare.rate']
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(expected)
    expect(undeclaredRatioFields(draft7(schema), 'Dto')).toEqual(expected)
  })

  test('a field repeated across union variants is reported once, in sorted order', () => {
    const schema = z.object({
      metric: z.union([
        z.object({ state: z.literal('available'), rate: z.number() }),
        z.object({ state: z.literal('estimated'), rate: z.number() }),
        z.object({ state: z.literal('unavailable'), rate: z.null() }),
      ]),
      alpha: z.object({ share: z.number() }),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.alpha.share', 'Dto.metric.rate'])
  })

  test('record values are walked and named with a star', () => {
    const schema = z.object({
      byProvider: z.record(z.string(), z.object({ citationRate: z.number(), mentionRate: fraction(), total: z.number() })),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.byProvider.*.citationRate'])
    expect(undeclaredRatioFields(draft7(schema), 'Dto')).toEqual(['Dto.byProvider.*.citationRate'])
  })

  test('an array or record of numbers under a ratio name declares its unit on the element', () => {
    const schema = z.object({
      deltaPct: z.record(z.string(), z.number().nullable()),
      sharePct: z.array(z.number()),
      rateByDay: z.record(z.string(), z.number()),
      declared: z.object({
        deltaPct: z.record(z.string(), percent().nullable()),
        sharePct: z.array(percent()),
      }),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.deltaPct', 'Dto.sharePct'])
  })

  test('a ratio-named object, string or boolean is not a number, but its own fields are checked', () => {
    const schema = z.object({
      mentionShare: z.object({ rate: z.number(), scope: z.string() }),
      coverage: z.object({ gsc: z.boolean() }),
      percentage: z.string(),
      ctr: z.object({ slope: z.number(), r2: z.number() }),
    })
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.mentionShare.rate'])
  })

  test('a name in the exclusions is exempt at every depth', () => {
    const schema = z.object({
      rateRatio: z.number().nullable(),
      metrics: z.array(z.object({ rateRatio: z.number(), point: z.number(), share: z.number() })),
    })
    const notARatio = { rateRatio: 'A multiplier (to / from), not a share.' }
    expect(undeclaredRatioFields(openApi(schema), 'Dto', notARatio)).toEqual(['Dto.metrics[].share'])
    expect(undeclaredRatioFields(openApi(schema), 'Dto')).toEqual(['Dto.metrics[].rateRatio', 'Dto.metrics[].share', 'Dto.rateRatio'])
  })

  test('only a known unit counts as a declaration', () => {
    const schema = {
      type: 'object',
      properties: {
        sharePct: { type: 'number', [RATIO_UNIT_META_KEY]: 'basis-points' },
        ctr: { type: 'number', [RATIO_UNIT_META_KEY]: 'fraction' },
        rate: { type: ['number', 'null'] },
        count: { type: 'integer' },
      },
    }
    expect(undeclaredRatioFields(schema, 'Dto')).toEqual(['Dto.rate', 'Dto.sharePct'])
  })

  test('shared definitions are walked, and a reference is judged by what it points at', () => {
    interface TreeNode { share: number; children?: TreeNode[] }
    const tree: z.ZodType<TreeNode> = z.lazy(() => z.object({ share: z.number(), children: z.array(tree).optional() }))
    const recursive = openApi(z.object({ root: tree }))
    expect(recursive.definitions).toBeDefined()
    expect(undeclaredRatioFields(recursive, 'Dto')).toEqual(['Dto#/definitions/__schema0.share'])

    const referenced = {
      type: 'object',
      properties: {
        declaredRate: { $ref: '#/$defs/fractionNumber' },
        bareRate: { $ref: '#/$defs/plainNumber' },
        remoteRate: { $ref: '#/components/schemas/Elsewhere' },
      },
      $defs: {
        fractionNumber: { type: 'number', [RATIO_UNIT_META_KEY]: 'fraction' },
        plainNumber: { type: 'number' },
      },
    }
    expect(undeclaredRatioFields(referenced, 'Dto')).toEqual(['Dto.bareRate'])
  })

  test('a reference cycle ends instead of recursing forever', () => {
    const schema = {
      type: 'object',
      properties: { loopRate: { $ref: '#/definitions/a' } },
      definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/a' } },
    }
    expect(undeclaredRatioFields(schema, 'Dto')).toEqual([])
  })
})

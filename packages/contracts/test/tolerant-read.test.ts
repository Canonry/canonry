import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { fraction, ratioUnitOf, RatioUnits } from '../src/ratio-unit.js'
import { tolerantReadSchema } from '../src/tolerant-read.js'

const counts = z.object({ favorable: z.number().int().nonnegative(), mixed: z.number().int().nonnegative() }).strict()
const row = z.object({ id: z.string().min(1), state: z.enum(['pending', 'complete']), rate: fraction(z.number().min(0).max(1)).nullable() }).strict()
const dto = z.object({
  kind: z.literal('summary'),
  version: z.union([z.literal(1), z.literal(2)]),
  experimental: z.literal(true),
  mode: z.enum(['auto', 'simple']).default('auto'),
  rows: z.array(row).max(3),
  nested: z.object({ label: z.string() }).strict().nullable(),
  optional: z.object({ note: z.string() }).strict().optional(),
  counts,
  byState: z.record(z.enum(['pending', 'complete']), z.number()),
  outcome: z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), a: z.string() }).strict(), z.object({ kind: z.literal('b') }).strict()]),
}).strict()
const valid = {
  kind: 'summary', version: 2, experimental: true, mode: 'simple', rows: [{ id: 'r', state: 'complete', rate: 0.5 }],
  nested: { label: 'x' }, optional: { note: 'n' }, counts: { favorable: 1, mixed: 2 }, byState: { pending: 1, complete: 2 }, outcome: { kind: 'a', a: 'text' },
}

describe('tolerantReadSchema', () => {
  test('drops keys a reader does not declare at every level instead of rejecting the response', () => {
    const newer = {
      ...valid, added: 'top', rows: [{ ...valid.rows[0], added: 'row' }], nested: { label: 'x', added: 'nested' },
      optional: { note: 'n', added: 'optional' }, outcome: { kind: 'a', a: 'text', added: 'member' },
    }
    // Control: the strict DTO rejects the newer response outright.
    expect(dto.safeParse(newer).success).toBe(false)
    expect(tolerantReadSchema(dto).parse(newer)).toEqual(valid)
  })

  test('reads a new enum or literal value as its primitive and keeps defaults', () => {
    const read = tolerantReadSchema(dto)
    const newer = { ...valid, kind: 'summary-v2', version: 3, mode: 'advanced', rows: [{ id: 'r', state: 'queued', rate: null }], outcome: { kind: 'c' }, byState: { queued: 4 } }
    expect(dto.safeParse(newer).success).toBe(false)
    expect(read.parse(newer)).toEqual(newer)
    const { mode: _mode, ...withoutMode } = valid
    expect(read.parse(withoutMode).mode).toBe('auto')
    // Widened, not dropped: a literal still has to be of its primitive type.
    expect(read.safeParse({ ...valid, experimental: 'yes' }).success).toBe(false)
    expect(read.safeParse({ ...valid, version: '2' }).success).toBe(false)
  })

  test('keeps the bounds and formats of the fields it knows', () => {
    const read = tolerantReadSchema(dto)
    for (const bad of [
      { ...valid, rows: [{ ...valid.rows[0], id: '' }] },
      { ...valid, rows: [{ ...valid.rows[0], rate: 1.5 }] },
      { ...valid, rows: [valid.rows[0], valid.rows[0], valid.rows[0], valid.rows[0]] },
      { ...valid, counts: { favorable: -1, mixed: 0 } },
      { ...valid, counts: { favorable: 1 } },
    ]) expect(read.safeParse(bad).success).toBe(false)
  })

  test('keeps a declared ratio unit and leaves the source schema strict', () => {
    const read = tolerantReadSchema(dto)
    const readRow = (read.shape.rows as z.ZodArray<z.ZodObject>).element
    expect(ratioUnitOf(readRow.shape.rate as z.ZodType)).toBe(RatioUnits.fraction)
    expect(JSON.stringify(z.toJSONSchema(read, { target: 'draft-7' }))).toContain('"x-unit":"fraction"')
    expect(dto.safeParse({ ...valid, added: true }).success).toBe(false)
  })

  test('keeps unknown keys on an open-keyed object and checks their values', () => {
    const read = tolerantReadSchema(dto, { openKeys: [[counts, z.number().int().nonnegative()]] })
    const newer = { ...valid, counts: { favorable: 1, mixed: 2, 'new-outcome': 3 } }
    expect(read.parse(newer).counts).toEqual({ favorable: 1, mixed: 2, 'new-outcome': 3 })
    expect(read.safeParse({ ...valid, counts: { favorable: 1, mixed: 2, 'new-outcome': -3 } }).success).toBe(false)
    // Without the option the same key is dropped, and the known counts no longer add up to the total.
    expect(tolerantReadSchema(dto).parse(newer).counts).toEqual({ favorable: 1, mixed: 2 })
  })

  test('advertises an output JSON Schema that accepts what it returns', () => {
    const read = tolerantReadSchema(dto, { openKeys: [[counts, z.number().int().nonnegative()]] })
    const json = z.toJSONSchema(read, { target: 'draft-7' }) as { properties: Record<string, { type?: string; additionalProperties?: unknown; properties?: Record<string, unknown> }> }
    expect(json.properties.mode!.type).toBe('string')
    expect(json.properties.counts!.additionalProperties).toMatchObject({ type: 'integer', minimum: 0 })
  })
})

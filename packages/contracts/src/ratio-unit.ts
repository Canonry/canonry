import { z } from 'zod'

/**
 * The unit a ratio number carries on the wire.
 *
 * - `fraction`: 0..1, so 0.0207 is 2.07%.
 * - `percent`: 0..100, so 2.07 is 2.07%.
 *
 * The same field name means different things on different endpoints
 * (`percentage` is a fraction in the source reads but 0..100 in the index
 * coverage reads; `citationRate` is a fraction in analytics but 0..100 in the
 * report), so a reader can never infer the unit from the name. Each ratio
 * field declares it on its schema instead, and `formatPercent` takes it.
 */
export const ratioUnitSchema = z.enum(['fraction', 'percent'])
export type RatioUnit = z.infer<typeof ratioUnitSchema>
export const RatioUnits = ratioUnitSchema.enum

/**
 * Schema metadata key for a ratio's unit. Zod copies metadata into JSON
 * Schema, so it reaches the OpenAPI document and MCP output schemas; the `x-`
 * prefix keeps it a valid OpenAPI vendor extension.
 */
export const RATIO_UNIT_META_KEY = 'x-unit'

/**
 * Declares a ratio's unit on a number schema. Apply it last on the number:
 * Zod metadata belongs to one schema instance, so a later `.min()` or `.int()`
 * returns a copy without it. Wrapping in `.optional()` or `.nullable()`
 * afterwards is fine.
 */
function withRatioUnit<T extends z.ZodNumber>(schema: T, unit: RatioUnit): T {
  return schema.meta({ [RATIO_UNIT_META_KEY]: unit })
}

/** A 0..1 share or rate. */
export function fraction<T extends z.ZodNumber = z.ZodNumber>(schema?: T): T {
  return withRatioUnit(schema ?? (z.number() as T), RatioUnits.fraction)
}

/** A 0..100 percent. */
export function percent<T extends z.ZodNumber = z.ZodNumber>(schema?: T): T {
  return withRatioUnit(schema ?? (z.number() as T), RatioUnits.percent)
}

const WRAPPER_TYPES = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'nonoptional', 'catch'])

/** The schema under `.optional()`, `.nullable()`, `.default()` and friends. */
export function unwrapRatioSchema(schema: z.ZodType): z.ZodType {
  let current = schema
  for (let depth = 0; depth < 16; depth++) {
    const def = current._zod.def as { type: string; innerType?: z.ZodType }
    if (!WRAPPER_TYPES.has(def.type) || !def.innerType) return current
    current = def.innerType
  }
  return current
}

/** The unit declared on a number schema (through its wrappers), if any. */
export function ratioUnitOf(schema: z.ZodType): RatioUnit | undefined {
  const unit = z.globalRegistry.get(unwrapRatioSchema(schema))?.[RATIO_UNIT_META_KEY]
  const parsed = ratioUnitSchema.safeParse(unit)
  return parsed.success ? parsed.data : undefined
}

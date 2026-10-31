import { z } from 'zod'

export const projectNameSchema = z.string().min(1).describe('Canonry project name.')
export const runIdSchema = z.string().min(1).describe('Canonry run ID.')
export const insightIdSchema = z.string().min(1).describe('Canonry insight ID.')
export const analyticsWindowSchema = z.enum(['7d', '30d', '90d', 'all']).describe('Analytics time window.')

export const emptyInputSchema = z.object({})

const mcpErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).strict(),
}).strict()

/** Advertise both wire outcomes: clients validate structured errors after tools/list too. */
export function mcpOutputSchema(success: z.ZodObject): z.ZodObject {
  const outcomes = z.union([success, mcpErrorEnvelopeSchema])
  // The MCP SDK requires a Zod object at the root. Keep the exact alternatives
  // in JSON Schema and use the same alternatives for runtime validation.
  return z.looseObject({}).superRefine((value, context) => {
    const parsed = outcomes.safeParse(value)
    if (!parsed.success) context.addIssue({ code: 'custom', message: 'Expected the declared success response or a Canonry error envelope.' })
  }).meta({ anyOf: [
    z.toJSONSchema(success, { target: 'draft-7' }),
    z.toJSONSchema(mcpErrorEnvelopeSchema, { target: 'draft-7' }),
  ] })
}

export const projectInputSchema = z.object({
  project: projectNameSchema,
})

export function toJsonSchema(schema: z.ZodTypeAny, name: string): unknown {
  return {
    ...z.toJSONSchema(schema, { target: 'draft-7' }),
    title: name,
  }
}

export function compactStringParams(values: Record<string, unknown>, keys: readonly string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {}
  for (const key of keys) {
    const value = values[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'string') {
      params[key] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      params[key] = String(value)
    }
  }
  return Object.keys(params).length ? params : undefined
}

export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

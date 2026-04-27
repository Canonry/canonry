import { z } from 'zod'

export const projectNameSchema = z.string().min(1).describe('Canonry project name.')
export const runIdSchema = z.string().min(1).describe('Canonry run ID.')
export const insightIdSchema = z.string().min(1).describe('Canonry insight ID.')
export const analyticsWindowSchema = z.enum(['7d', '30d', '90d', 'all']).describe('Analytics time window.')

export const emptyInputSchema = z.object({})

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
    params[key] = String(value)
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

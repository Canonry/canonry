import { z } from 'zod'
import { locationContextSchema } from './provider.js'

export const configSourceSchema = z.enum(['cli', 'api', 'config-file'])
export type ConfigSource = z.infer<typeof configSourceSchema>

export const projectDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  canonicalDomain: z.string(),
  ownedDomains: z.array(z.string()).default([]),
  country: z.string().length(2),
  language: z.string().min(2),
  tags: z.array(z.string()).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  locations: z.array(locationContextSchema).default([]),
  defaultLocation: z.string().nullable().optional(),
  configSource: configSourceSchema.default('cli'),
  configRevision: z.number().int().positive().default(1),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export type ProjectDto = z.infer<typeof projectDtoSchema>

/** Normalize a user-supplied project domain for matching and deduplication. */
export function normalizeProjectDomain(input: string): string {
  let domain = input.trim().toLowerCase()
  try {
    if (domain.includes('://')) {
      domain = new URL(domain).hostname.toLowerCase()
    }
  } catch {
    // ignore invalid URLs and use the raw input
  }
  return domain.replace(/^www\./, '')
}

/** Returns deduplicated list of all domains owned by the project. */
export function effectiveDomains(project: { canonicalDomain: string; ownedDomains?: string[] }): string[] {
  const all = [project.canonicalDomain, ...(project.ownedDomains ?? [])]
  const seen = new Set<string>()
  const result: string[] = []
  for (const d of all) {
    const trimmed = d.trim()
    if (!trimmed) continue
    const norm = normalizeProjectDomain(trimmed)
    if (seen.has(norm)) continue
    seen.add(norm)
    result.push(trimmed)
  }
  return result
}

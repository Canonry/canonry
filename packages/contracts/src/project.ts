import { z } from 'zod'
import { locationContextSchema, providerNameSchema, type LocationContext } from './provider.js'

export const configSourceSchema = z.enum(['cli', 'api', 'config-file'])
export type ConfigSource = z.infer<typeof configSourceSchema>

export function findDuplicateLocationLabels(locations: readonly Pick<LocationContext, 'label'>[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const location of locations) {
    if (seen.has(location.label)) {
      duplicates.add(location.label)
      continue
    }
    seen.add(location.label)
  }

  return [...duplicates]
}

export function hasLocationLabel(
  locations: readonly Pick<LocationContext, 'label'>[],
  label: string | null | undefined,
): boolean {
  if (!label) return true
  return locations.some(location => location.label === label)
}

export const projectUpsertRequestSchema = z.object({
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  ownedDomains: z.array(z.string().min(1)).optional(),
  country: z.string().length(2),
  language: z.string().min(2),
  tags: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  providers: z.array(providerNameSchema).optional(),
  locations: z.array(locationContextSchema).optional(),
  defaultLocation: z.string().nullable().optional(),
  configSource: configSourceSchema.optional(),
})

export type ProjectUpsertRequest = z.infer<typeof projectUpsertRequestSchema>

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

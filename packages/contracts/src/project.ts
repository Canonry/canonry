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
  autoExtractBacklinks: z.boolean().optional(),
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
  autoExtractBacklinks: z.boolean().default(false),
  configSource: configSourceSchema.default('cli'),
  configRevision: z.number().int().positive().default(1),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export type ProjectDto = z.infer<typeof projectDtoSchema>

export const keywordDtoSchema = z.object({
  id: z.string(),
  keyword: z.string(),
  createdAt: z.string(),
})

export type KeywordDto = z.infer<typeof keywordDtoSchema>

export const keywordBatchRequestSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1),
})

export type KeywordBatchRequest = z.infer<typeof keywordBatchRequestSchema>

export const keywordGenerateRequestSchema = z.object({
  provider: providerNameSchema,
  count: z.number().int().min(1).max(20).optional(),
})

export type KeywordGenerateRequest = z.infer<typeof keywordGenerateRequestSchema>

export const competitorDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  createdAt: z.string(),
})

export type CompetitorDto = z.infer<typeof competitorDtoSchema>

export const competitorBatchRequestSchema = z.object({
  competitors: z.array(z.string().trim().min(1)).min(1),
})

export type CompetitorBatchRequest = z.infer<typeof competitorBatchRequestSchema>

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

// Two-label public suffixes where the eTLD+1 needs three labels
// (e.g. example.co.uk → example.co.uk, not co.uk). Not exhaustive — a real
// PSL has thousands of entries — but covers the common ccTLDs Canonry users
// hit. Keep alphabetized.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'ac.uk',
  'co.id',
  'co.il',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.th',
  'co.uk',
  'co.za',
  'com.au',
  'com.br',
  'com.cn',
  'com.mx',
  'com.ph',
  'com.sg',
  'com.tr',
  'edu.au',
  'edu.sg',
  'gov.au',
  'gov.uk',
  'me.uk',
  'ne.jp',
  'net.au',
  'net.br',
  'net.cn',
  'net.in',
  'net.tr',
  'or.jp',
  'or.kr',
  'org.au',
  'org.br',
  'org.in',
  'org.nz',
  'org.tr',
  'org.uk',
  'org.za',
])

/**
 * Reduce a domain to its registrable form (eTLD+1).
 *
 * `offers.roofle.com` → `roofle.com`
 * `acme.com` → `acme.com`
 * `bbc.co.uk` → `bbc.co.uk`
 * `news.bbc.co.uk` → `bbc.co.uk`
 *
 * Strips subdomains so an arbitrary subdomain label (`offers`, `blog`, `app`)
 * cannot leak into brand-token matching against answer text. Returns `''` for
 * empty or single-label input. Idempotent.
 */
export function registrableDomain(input: string): string {
  const normalized = normalizeProjectDomain(input)
  if (!normalized) return ''
  const hostname = normalized.split('/')[0]?.split(':')[0] ?? ''
  if (!hostname) return ''
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) return ''
  if (labels.length === 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    return labels.length >= 3 ? labels.slice(-3).join('.') : ''
  }
  return labels.slice(-2).join('.')
}

/**
 * The leftmost label of the registrable domain — the "brand" segment used for
 * word-boundary matching against answer text. `offers.roofle.com` → `roofle`,
 * `acme.com` → `acme`, `bbc.co.uk` → `bbc`. Returns `''` if there is no
 * extractable brand label.
 */
export function brandLabelFromDomain(input: string): string {
  const reg = registrableDomain(input)
  if (!reg) return ''
  return reg.split('.')[0] ?? ''
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

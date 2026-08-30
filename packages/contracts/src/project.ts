import { z } from 'zod'
import { validationError } from './errors.js'
import { locationContextSchema, providerModelsSchema, providerNameSchema, type LocationContext } from './provider.js'
import { measurementConfigSchema, defaultMeasurementConfig } from './measurement.js'
import { brandLabelFromDomain, hostOf } from './url-normalize.js'
import { brandKeyFromText } from './brand-matching.js'
import { MIN_DOMAIN_BRAND_KEY_LENGTH } from './answer-visibility.js'

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

/**
 * Resolve the location set for a per-run operation (e.g. a discovery session)
 * against a project's configured locations.
 *
 * - `requestedLabels` omitted / empty → returns every configured project
 *   location (the "use all service areas" default). A project with no
 *   locations resolves to `[]`, leaving location-unaware callers unchanged.
 * - `requestedLabels` provided → returns the matching subset, in requested
 *   order, deduped. Matching is case-insensitive and whitespace-trimmed.
 * - An unknown label throws `validationError` so the caller surfaces a 400
 *   rather than silently dropping the override.
 */
/**
 * Order a location list so the project's default location (by label) leads.
 * Discovery probes measure from `locations[0]`, and sweeps measure from
 * `project.defaultLocation` — this keeps the two geo semantics identical.
 * Stable for the rest of the list; a missing/unknown default is a no-op.
 */
export function orderLocationsDefaultFirst(
  locations: readonly LocationContext[],
  defaultLabel: string | null | undefined,
): LocationContext[] {
  if (!defaultLabel) return [...locations]
  const index = locations.findIndex(l => l.label === defaultLabel)
  if (index <= 0) return [...locations]
  return [locations[index]!, ...locations.slice(0, index), ...locations.slice(index + 1)]
}

export function resolveLocations(
  projectLocations: readonly LocationContext[],
  requestedLabels: readonly string[] | undefined,
): LocationContext[] {
  const normalizedRequest = (requestedLabels ?? [])
    .map(label => label.trim())
    .filter(label => label.length > 0)
  if (normalizedRequest.length === 0) return [...projectLocations]

  const byLabel = new Map(projectLocations.map(loc => [loc.label.toLowerCase(), loc]))
  const resolved: LocationContext[] = []
  const seen = new Set<string>()
  for (const label of normalizedRequest) {
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    const match = byLabel.get(key)
    if (!match) {
      throw validationError(
        `Location "${label}" is not configured for this project. Add it to the project's locations or omit the locations override.`,
      )
    }
    seen.add(key)
    resolved.push(match)
  }
  return resolved
}

export const projectUpsertRequestSchema = z.object({
  displayName: z.string().min(1),
  canonicalDomain: z.string().min(1),
  ownedDomains: z.array(z.string().min(1)).optional(),
  aliases: z.array(z.string()).optional(),
  country: z.string().length(2),
  language: z.string().min(2),
  tags: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  providers: z.array(providerNameSchema).optional(),
  providerModels: providerModelsSchema.optional(),
  locations: z.array(locationContextSchema).optional(),
  defaultLocation: z.string().nullable().optional(),
  measurement: measurementConfigSchema.optional(),
  autoExtractBacklinks: z.boolean().optional(),
  configSource: configSourceSchema.optional(),
})

export type ProjectUpsertRequest = z.infer<typeof projectUpsertRequestSchema>

/**
 * Body for create-only project creation. `name` is intentionally separate from
 * the upsert path parameter: the API normalizes it before persistence and
 * refuses a collision instead of changing an existing project's configuration.
 */
export const projectCreateRequestSchema = projectUpsertRequestSchema.extend({
  name: z.string().trim().min(1).max(120),
})

export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>

/**
 * Canonical project route key for the domain-first launchpad.
 *
 * Names stay URL-safe and stable across casing, whitespace, punctuation, and
 * common accented presentation variants. An empty result is invalid and must
 * be rejected by the caller rather than silently inventing a fallback key.
 */
export function normalizeProjectName(input: string): string {
  return input
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const projectDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  canonicalDomain: z.string(),
  ownedDomains: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  country: z.string().length(2),
  language: z.string().min(2),
  tags: z.array(z.string()).default([]),
  labels: z.record(z.string(), z.string()).default({}),
  // Provider names this project sweeps against (subset of available providers).
  // The server emits this on every project response (see GET /projects/:name in
  // packages/api-routes/src/projects.ts) — the schema was historically missing
  // the field even though the wire shape always included it. Add it here so
  // ProjectDto consumers (web + CLI ApiClient) typecheck against the real
  // response surface.
  providers: z.array(z.string()).default([]),
  /** Per-project model overrides; an empty map inherits instance settings. */
  providerModels: providerModelsSchema.default({}),
  locations: z.array(locationContextSchema).default([]),
  defaultLocation: z.string().nullable().optional(),
  measurement: measurementConfigSchema.default(defaultMeasurementConfig),
  autoExtractBacklinks: z.boolean().default(false),
  configSource: configSourceSchema.default('cli'),
  configRevision: z.number().int().positive().default(1),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})

export type ProjectDto = z.infer<typeof projectDtoSchema>

export const queryDtoSchema = z.object({
  id: z.string(),
  query: z.string(),
  createdAt: z.string(),
})

export type QueryDto = z.infer<typeof queryDtoSchema>

/**
 * A guarded single-query replacement for projects that have not entered
 * measurement-plan authoring. `expectedQuery` deliberately remains raw: it is
 * a compare-and-swap guard, not operator input to normalize.
 */
export const queryReplaceRequestSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  expectedQuery: z.string().min(1).max(4000),
}).strict()

export type QueryReplaceRequest = z.infer<typeof queryReplaceRequestSchema>

/** @deprecated Legacy alias kept for the `/keywords` back-compat surface. New code should use {@link queryDtoSchema}. */
export const keywordDtoSchema = z.object({
  id: z.string(),
  keyword: z.string(),
  createdAt: z.string(),
})

/** @deprecated Legacy alias kept for the `/keywords` back-compat surface. New code should use {@link QueryDto}. */
export type KeywordDto = z.infer<typeof keywordDtoSchema>

export const queryBatchRequestSchema = z.object({
  queries: z.array(z.string().trim().min(1)).min(1),
})

export type QueryBatchRequest = z.infer<typeof queryBatchRequestSchema>

/** @deprecated Legacy alias kept for the `/keywords` back-compat surface. New code should use {@link queryBatchRequestSchema}. */
export const keywordBatchRequestSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1),
})

/** @deprecated Legacy alias kept for the `/keywords` back-compat surface. New code should use {@link QueryBatchRequest}. */
export type KeywordBatchRequest = z.infer<typeof keywordBatchRequestSchema>

export const queryGenerateRequestSchema = z.object({
  provider: providerNameSchema,
  count: z.number().int().min(1).max(20).optional(),
})

export type QueryGenerateRequest = z.infer<typeof queryGenerateRequestSchema>

/** @deprecated Legacy alias kept for the `/keywords/generate` back-compat surface. New code should use {@link queryGenerateRequestSchema}. */
export const keywordGenerateRequestSchema = queryGenerateRequestSchema
/** @deprecated Legacy alias kept for the `/keywords/generate` back-compat surface. New code should use {@link QueryGenerateRequest}. */
export type KeywordGenerateRequest = QueryGenerateRequest

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
  return hostOf(input) ?? input.trim().toLowerCase().replace(/^www\./, '')
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

/**
 * Canonical alias list for persistence. Trims each entry, drops empties,
 * case-insensitively dedupes, and silently filters any alias that equals the
 * displayName (case-insensitive) — that one is already covered by the primary
 * brand name. Single source of truth — every write surface must call this so
 * persisted state stays canonical.
 */
export function normalizeProjectAliases(
  displayName: string | null | undefined,
  aliases: readonly string[] | null | undefined,
): string[] {
  if (!aliases || aliases.length === 0) return []
  const displayKey = displayName?.trim().toLowerCase() ?? ''
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of aliases) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (key === displayKey) continue
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/**
 * Returns the brand-name identities used for mention detection: `displayName`
 * (when set), normalized aliases, then every owned domain's registrable
 * brand label. Domain labels use the same four-character key floor as
 * `extractAnswerMentions`; a shorter label contributes only its normalized
 * full domain, so `ai.com` is identity evidence while bare `AI` is not unless
 * the operator approved it as a display name or alias. Identity-equivalent
 * entries collapse with the same key used by `extractAnswerMentions`.
 */
export function effectiveBrandNames(project: {
  displayName?: string | null
  aliases?: string[] | null
  canonicalDomain?: string | null
  ownedDomains?: string[] | null
}): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string) => {
    const key = brandKeyFromText(name)
    if (!key || seen.has(key)) return
    seen.add(key)
    names.push(name)
  }
  const display = project.displayName?.trim() ?? ''
  if (display) add(display)
  for (const alias of normalizeProjectAliases(project.displayName, project.aliases)) {
    add(alias)
  }
  for (const domain of effectiveDomains({
    canonicalDomain: project.canonicalDomain ?? '',
    ownedDomains: project.ownedDomains ?? [],
  })) {
    const domainBrand = brandLabelFromDomain(domain)
    if (brandKeyFromText(domainBrand).length >= MIN_DOMAIN_BRAND_KEY_LENGTH) {
      add(domainBrand)
    } else {
      const exactDomain = normalizeProjectDomain(domain)
      if (exactDomain.includes('.')) add(exactDomain)
    }
  }
  return names
}

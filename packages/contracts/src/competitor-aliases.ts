import { z } from 'zod'
import { MIN_BRAND_ALIAS_KEY_LENGTH, MIN_DOMAIN_BRAND_KEY_LENGTH, usableBrandAliases } from './answer-visibility.js'
import { brandKeyFromText } from './brand-matching.js'
import { validationError } from './errors.js'
import { brandLabelFromDomain, hostOf } from './url-normalize.js'

/**
 * OPERATOR-CURATED COMPETITOR ALIASES.
 *
 * A competitor is stored as a registrable domain. Answers name it by brand, and
 * the brand is often not the domain label: a firm at `sealfoamworks.example`
 * is "FoamSeal" in prose, and a 3-letter brand at `qvx.example` never passes
 * the domain-label floor. Curated aliases close that gap. They are matched as
 * exact brand identities (complete adjacent words, never fuzzy) and take the
 * operator-approved alias floor (`MIN_BRAND_ALIAS_KEY_LENGTH`), not the
 * stricter floor a label DERIVED from a domain takes.
 *
 * Every write surface (REST, CLI, MCP, config-as-code apply) runs the same
 * rules through `planCompetitorAliases`, and every read-time matcher builds its
 * identity through `competitorNameAliases` / `competitorBrandAliases`, so the
 * same answer counts the same way on every surface.
 */

/** Most curated aliases one competitor may carry. */
export const COMPETITOR_ALIAS_LIMIT = 10
/** Longest curated alias, in characters after trimming. */
export const COMPETITOR_ALIAS_MAX_LENGTH = 80

/** A stored competitor as the matchers read it. */
export interface CompetitorIdentityInput {
  domain: string
  aliases?: readonly string[] | null
}

/**
 * The canonical stored list: trimmed, blanks dropped, duplicates removed
 * case-insensitively (the first spelling wins). Applies no rejection rules;
 * `planCompetitorAliases` does that.
 */
export function normalizeCompetitorAliases(aliases: readonly string[] | null | undefined): string[] {
  if (!aliases || aliases.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of aliases) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

/**
 * The names a competitor goes by in answer prose: its curated aliases (alias
 * floor) plus its domain label when that label passes the domain floor. Used by
 * matchers that check the written host separately.
 */
export function competitorNameAliases(competitor: CompetitorIdentityInput): string[] {
  const label = brandLabelFromDomain(competitor.domain)
  return usableBrandAliases([
    ...(brandKeyFromText(label).length >= MIN_DOMAIN_BRAND_KEY_LENGTH ? [label] : []),
    ...normalizeCompetitorAliases(competitor.aliases),
  ])
}

/**
 * Every brand token a competitor is matched by in answer prose: its names
 * (`competitorNameAliases`) plus the full written host. A short registrable
 * label is too noisy by itself (`AI`), but the written domain (`ai.com`) is
 * operator-approved identity.
 */
export function competitorBrandAliases(competitor: CompetitorIdentityInput): string[] {
  const host = hostOf(competitor.domain)
  return usableBrandAliases([
    ...competitorNameAliases(competitor),
    ...(host?.includes('.') ? [host] : []),
  ])
}

/** Brand keys a competitor's domain alone contributes (gated label, written host). */
function domainIdentityKeys(domain: string): string[] {
  const keys: string[] = []
  const labelKey = brandKeyFromText(brandLabelFromDomain(domain))
  if (labelKey.length >= MIN_DOMAIN_BRAND_KEY_LENGTH) keys.push(labelKey)
  const host = hostOf(domain)
  if (host?.includes('.')) {
    const hostKey = brandKeyFromText(host)
    if (hostKey) keys.push(hostKey)
  }
  return keys
}

export type CompetitorAliasRejectionReason =
  | 'too-long'
  | 'too-short'
  | 'project-brand'
  | 'other-competitor'

export interface CompetitorAliasRejection {
  domain: string
  alias: string
  reason: CompetitorAliasRejectionReason
  /** The other competitor that already answers to this name ('other-competitor'). */
  conflictsWith?: string
}

export interface CompetitorAliasPlanEntry {
  domain: string
  aliases: readonly string[]
  /**
   * True when this write states the list (a REST alias write, an add with
   * aliases, a config entry with `aliases`): any rejected alias fails the
   * write. False for a list carried over unchanged, where an alias that no
   * longer qualifies (the project now claims the name, a newly tracked
   * competitor's domain label is the name) is dropped instead.
   */
  explicit: boolean
}

export interface CompetitorAliasPlan {
  competitors: { domain: string; aliases: string[] }[]
  /** Aliases rejected from explicit lists. Non-empty means the write must fail. */
  rejected: CompetitorAliasRejection[]
  /** Explicit lists longer than `COMPETITOR_ALIAS_LIMIT` after normalizing. */
  overLimit: { domain: string; count: number }[]
  /** Aliases dropped from carried-over lists. */
  dropped: CompetitorAliasRejection[]
}

/**
 * Validate and normalize every competitor's alias list together, because an
 * alias is only safe relative to the others: a name the project itself goes by
 * would count the project as its own competitor, and a name another tracked
 * competitor already answers to would credit one answer to both.
 *
 * Rules per alias (after `normalizeCompetitorAliases`): at most
 * `COMPETITOR_ALIAS_MAX_LENGTH` characters; a brand key of at least
 * `MIN_BRAND_ALIAS_KEY_LENGTH` letters or digits; not a brand key of
 * `projectBrandNames` (pass `effectiveBrandNames(project)`); not a brand key
 * another competitor's domain or aliases contribute. An explicit list is
 * checked against every other list; a carried-over list only against other
 * carried-over lists, so a new write can never silently strip another
 * competitor's existing alias (the new write is rejected instead).
 */
export function planCompetitorAliases(
  entries: readonly CompetitorAliasPlanEntry[],
  projectBrandNames: readonly string[],
): CompetitorAliasPlan {
  const projectKeys = new Set(projectBrandNames.map(brandKeyFromText).filter(key => key.length > 0))
  const normalized = entries.map(entry => ({
    domain: entry.domain,
    explicit: entry.explicit,
    aliases: normalizeCompetitorAliases(entry.aliases),
    domainKeys: domainIdentityKeys(entry.domain),
  }))
  const rejected: CompetitorAliasRejection[] = []
  const dropped: CompetitorAliasRejection[] = []
  const overLimit: { domain: string; count: number }[] = []

  const conflictFor = (index: number, key: string, explicit: boolean): string | null => {
    for (let other = 0; other < normalized.length; other++) {
      if (other === index) continue
      const entry = normalized[other]!
      if (entry.domain === normalized[index]!.domain) continue
      if (entry.domainKeys.includes(key)) return entry.domain
      if (!explicit && entry.explicit) continue
      if (entry.aliases.some(alias => brandKeyFromText(alias) === key)) return entry.domain
    }
    return null
  }

  const competitors = normalized.map((entry, index) => {
    const kept: string[] = []
    for (const alias of entry.aliases) {
      const key = brandKeyFromText(alias)
      let rejection: CompetitorAliasRejection | null = null
      if (alias.length > COMPETITOR_ALIAS_MAX_LENGTH) {
        rejection = { domain: entry.domain, alias, reason: 'too-long' }
      } else if (key.length < MIN_BRAND_ALIAS_KEY_LENGTH) {
        rejection = { domain: entry.domain, alias, reason: 'too-short' }
      } else if (projectKeys.has(key)) {
        rejection = { domain: entry.domain, alias, reason: 'project-brand' }
      } else {
        const conflictsWith = conflictFor(index, key, entry.explicit)
        if (conflictsWith) rejection = { domain: entry.domain, alias, reason: 'other-competitor', conflictsWith }
      }
      if (rejection) (entry.explicit ? rejected : dropped).push(rejection)
      else kept.push(alias)
    }
    if (kept.length > COMPETITOR_ALIAS_LIMIT) {
      if (entry.explicit) overLimit.push({ domain: entry.domain, count: kept.length })
      return { domain: entry.domain, aliases: kept.slice(0, COMPETITOR_ALIAS_LIMIT) }
    }
    return { domain: entry.domain, aliases: kept }
  })

  return { competitors, rejected, overLimit, dropped }
}

function describeRejection(rejection: CompetitorAliasRejection): string {
  switch (rejection.reason) {
    case 'too-long':
      return `"${rejection.alias}" is longer than ${COMPETITOR_ALIAS_MAX_LENGTH} characters`
    case 'too-short':
      return `"${rejection.alias}" is too short: an alias needs at least ${MIN_BRAND_ALIAS_KEY_LENGTH} letters or digits`
    case 'project-brand':
      return `"${rejection.alias}" is one of the project's own brand names, so it would count the project as a competitor`
    case 'other-competitor':
      return `"${rejection.alias}" already identifies ${rejection.conflictsWith ?? 'another tracked competitor'}`
  }
}

/**
 * `planCompetitorAliases`, failing the write with one validation error that
 * names every rejected alias and every over-limit list. Returns the plan for a
 * write that passes (carried-over drops included, for the audit row).
 */
export function requireCompetitorAliasPlan(
  entries: readonly CompetitorAliasPlanEntry[],
  projectBrandNames: readonly string[],
): CompetitorAliasPlan {
  const plan = planCompetitorAliases(entries, projectBrandNames)
  if (plan.rejected.length === 0 && plan.overLimit.length === 0) return plan
  const problems = [
    ...plan.overLimit.map(item => `${item.domain} has ${item.count} aliases (at most ${COMPETITOR_ALIAS_LIMIT})`),
    ...plan.rejected.map(rejection => `${rejection.domain}: ${describeRejection(rejection)}`),
  ]
  throw validationError(`Invalid competitor aliases: ${problems.join('; ')}`, {
    rejectedAliases: plan.rejected,
    overLimit: plan.overLimit,
    limit: COMPETITOR_ALIAS_LIMIT,
    maxLength: COMPETITOR_ALIAS_MAX_LENGTH,
    minKeyLength: MIN_BRAND_ALIAS_KEY_LENGTH,
  })
}

const competitorAliasListSchema = z.array(z.string())
  .describe(`Operator-curated names this competitor goes by in answer text (at most ${COMPETITOR_ALIAS_LIMIT}, each ${COMPETITOR_ALIAS_MAX_LENGTH} characters or fewer, at least ${MIN_BRAND_ALIAS_KEY_LENGTH} letters or digits).`)

/** `PUT /projects/{name}/competitors/{domain}/aliases`: the exact list; `[]` clears. */
export const competitorAliasesRequestSchema = z.object({
  aliases: competitorAliasListSchema,
})

export type CompetitorAliasesRequest = z.infer<typeof competitorAliasesRequestSchema>

/** A competitor entry that states its aliases: on add, and in config-as-code. */
export const competitorWithAliasesSchema = z.object({
  domain: z.string().trim().min(1),
  aliases: competitorAliasListSchema.optional(),
})

export type CompetitorWithAliases = z.infer<typeof competitorWithAliasesSchema>

/**
 * A competitor entry in `POST /projects/{name}/competitors` and in a config
 * spec: a bare domain, or `{ domain, aliases }`. A bare domain (or an object
 * without `aliases`) states nothing about aliases, so stored ones are kept.
 */
export const competitorEntrySchema = z.union([z.string().trim().min(1), competitorWithAliasesSchema])

export type CompetitorEntry = z.infer<typeof competitorEntrySchema>

/** Split an entry into its domain and its stated aliases (`undefined` = no opinion). */
export function competitorEntryParts(entry: CompetitorEntry): { domain: string; aliases: string[] | undefined } {
  return typeof entry === 'string'
    ? { domain: entry, aliases: undefined }
    : { domain: entry.domain, aliases: entry.aliases }
}

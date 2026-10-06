import { z } from 'zod'
import { MIN_BRAND_ALIAS_KEY_LENGTH, MIN_DOMAIN_BRAND_KEY_LENGTH, usableBrandAliases } from './answer-visibility.js'
import { brandKeyFromText, textContainsBrandAlias } from './brand-matching.js'
import { validationError } from './errors.js'
import { brandLabelFromDomain, hostMatchesDomain, hostOf, normalizeCompetitorDomain } from './url-normalize.js'

/**
 * OPERATOR-CURATED COMPETITOR ALIASES.
 *
 * A competitor is stored as a registrable domain. Answers name it by brand, and
 * the brand is often not the domain label: a firm at `spoketuneworks.example`
 * is "TuneSpoke" in prose, and a 3-letter brand at `qvx.example` never passes
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

/**
 * One identity name prepared for the overlap checks: the name as written and
 * its brand key (letters and digits only, case, accents and punctuation
 * folded), which is what every reader compares.
 */
interface IdentityName {
  name: string
  key: string
}

function identityName(name: string): IdentityName {
  return { name, key: brandKeyFromText(name) }
}

/**
 * `inner` is found in some spelling of `outer`: its key sits inside `outer`'s
 * key (equal keys included). A key shorter than the alias floor (a project
 * named "AI") would sit inside nearly every name, so such a name only counts
 * when `outer` writes it as complete words.
 */
function foundIn(inner: IdentityName, outer: IdentityName): boolean {
  if (!inner.key) return false
  if (inner.key.length < MIN_BRAND_ALIAS_KEY_LENGTH) return textContainsBrandAlias(outer.name, inner.name)
  return outer.key.includes(inner.key)
}

/**
 * Two names overlap when either brand key contains the other.
 *
 * The readers match a key against complete adjacent words however an answer
 * splits them (`TuneSpoke`, `Tune Spoke` and `Tune-Spoke` are one name), so a
 * name whose key sits inside another name's key is found in some spelling of
 * that other name: "Tune" overlaps "Tune Spoke", "TuneSpoke" and the domain
 * label `tunespoke` alike. The stored spelling's word breaks prove nothing,
 * because an answer is free to break the words elsewhere. Containment is the
 * only rule that holds for every spelling, so it deliberately also rejects
 * joined-word lookalikes no answer would split ("Tune" and "Tuner",
 * "Acme" and `acmeology`); the operator picks a longer alias instead.
 */
function namesOverlap(a: IdentityName, b: IdentityName): boolean {
  return foundIn(a, b) || foundIn(b, a)
}

/**
 * The name in `names` that `alias` overlaps, preferring one with the same key
 * so a rejection names the exact match when there is one.
 */
function overlappingName(alias: IdentityName, names: readonly IdentityName[]): IdentityName | undefined {
  return names.find(name => name.key === alias.key) ?? names.find(name => namesOverlap(alias, name))
}

/** How an alias overlaps a different name, for a rejection message. */
function overlapRelation(alias: string, name: string): string {
  return foundIn(identityName(alias), identityName(name)) ? `is found inside "${name}"` : `contains "${name}"`
}

export type CompetitorAliasRejectionReason =
  | 'too-long'
  | 'too-short'
  | 'project-brand'
  | 'other-competitor'
  | 'claimed-by-alias'

export interface CompetitorAliasRejection {
  /**
   * The competitor the problem belongs to: the alias owner, or for
   * 'claimed-by-alias' the newly added competitor that cannot be added.
   */
  domain: string
  alias: string
  reason: CompetitorAliasRejectionReason
  /**
   * The other competitor involved: the one that already answers to this name
   * ('other-competitor'), or the one whose stored alias the new competitor's
   * domain would take over ('claimed-by-alias').
   */
  conflictsWith?: string
  /**
   * The other identity's name the alias overlaps, when it is a different name
   * whose brand key contains the alias's key or sits inside it ("Tune" and
   * "Tune Spoke" or "TuneSpoke"): another competitor's alias, domain label or
   * written host, the new competitor's domain name ('claimed-by-alias'), or a
   * project name or host ('project-brand'). Absent when the keys are equal.
   */
  conflictingName?: string
}

export interface CompetitorAliasPlanEntry {
  domain: string
  aliases: readonly string[]
  /**
   * True when this write states the list (a REST alias write, an add with
   * aliases, a config entry with `aliases`): any rejected alias fails the
   * write. False for a list carried over unchanged, where an alias that no
   * longer qualifies (the project now claims the name) is dropped instead.
   */
  explicit: boolean
  /**
   * True when this write starts tracking the domain. A new competitor whose
   * domain name overlaps a name another competitor carries as a stored alias
   * fails the write ('claimed-by-alias'): the operator removes or restates
   * that alias first, so an add never silently strips curated work.
   */
  added?: boolean
}

/**
 * The project identity a competitor alias must stay clear of. Build it with
 * `competitorAliasProjectIdentity(project)`.
 */
export interface CompetitorAliasProjectIdentity {
  /** `effectiveBrandNames(project)`. */
  brandNames: readonly string[]
  /** The project's own domains as hosts (canonical plus owned). */
  domains: readonly string[]
}

export interface CompetitorAliasPlan {
  competitors: { domain: string; aliases: string[] }[]
  /** Aliases rejected from explicit lists, and blocked adds. Non-empty means the write must fail. */
  rejected: CompetitorAliasRejection[]
  /** Explicit lists longer than `COMPETITOR_ALIAS_LIMIT` after normalizing. */
  overLimit: { domain: string; count: number }[]
  /** Aliases dropped from carried-over lists. */
  dropped: CompetitorAliasRejection[]
}

interface AliasConflict {
  domain: string
  /** The other competitor's name the alias overlaps. */
  name: IdentityName
  /** The name is the other competitor's domain identity, not one of its aliases. */
  viaDomain: boolean
  added: boolean
}

/** The overlapping name, recorded only when it is not the alias itself. */
function conflictingNameField(alias: IdentityName, other: IdentityName): { conflictingName?: string } {
  return other.key === alias.key ? {} : { conflictingName: other.name }
}

/**
 * Validate and normalize every competitor's alias list together, because an
 * alias is only safe relative to the others: a name the project itself goes by
 * would count the project as its own competitor, and a name another tracked
 * competitor already answers to would credit one answer to both.
 *
 * Two names overlap when either brand key contains the other (`namesOverlap`).
 * The readers match a key as complete adjacent words under any word split of
 * the answer, so containment is exactly "some spelling of the longer name also
 * names the shorter one": "Tune" overlaps "Tune Spoke", "TuneSpoke" and the
 * domain label `tunespoke`. It deliberately also rejects joined-word
 * lookalikes ("Tune" and "Tuner"); the operator picks a longer alias. A project
 * name shorter than the alias floor is checked as complete words instead.
 *
 * Rules per alias (after `normalizeCompetitorAliases`): at most
 * `COMPETITOR_ALIAS_MAX_LENGTH` characters; a brand key of at least
 * `MIN_BRAND_ALIAS_KEY_LENGTH` letters or digits; no overlap with any project
 * brand name (`effectiveBrandNames`, domain labels included) or project host,
 * so neither `Acme`, `Cycles`, `acmecycles.example`, `shop.acmecycles.example`
 * nor `Acme Cycles Outlet` can be a competitor alias of the project
 * "AcmeCycles" at `acmecycles.example`; no overlap with any identity name of
 * another competitor: its curated aliases, its domain label when that passes
 * the domain floor, and its written host (`competitorBrandAliases`). Rows that
 * normalize to the same registrable domain are one competitor. Two
 * competitors' domains are not compared with each other: that overlap
 * predates aliases and is not a curated-alias problem.
 *
 * What containment does not see: two names that only share a part ("Tune
 * Spoke" and "Spoke Works" are both found in the phrase "Tune Spoke Works"),
 * and an alias equal to a subdomain label of another competitor's host
 * (`tune.rides.example` names the alias "Tune" and `rides.example`). Both need
 * a phrase that joins the two names, so they are left to the operator.
 *
 * Outcomes: an explicit list is checked against every other competitor, and a
 * failing alias rejects the write. A new competitor whose domain name overlaps
 * a carried-over alias of another competitor rejects the write too
 * ('claimed-by-alias'), whatever else that alias overlaps and in whatever
 * order the entries come, so neither kind of write ever silently strips
 * another competitor's alias. A carried-over alias is dropped and reported
 * only when nothing in the write states it: the project's identity now claims
 * the name, or stored lists already overlap each other.
 */
export function planCompetitorAliases(
  entries: readonly CompetitorAliasPlanEntry[],
  project: CompetitorAliasProjectIdentity,
): CompetitorAliasPlan {
  const projectNames = [
    ...project.brandNames,
    ...project.domains.map(domain => hostOf(domain) ?? domain.trim().toLowerCase()),
  ].map(identityName).filter(name => name.key)
  // The first project name the alias overlaps. A host on the project's own
  // site (`www.` or any subdomain) contains the project host's key, so it is
  // covered too.
  const projectClaim = (alias: IdentityName): IdentityName | undefined => overlappingName(alias, projectNames)
  const normalized = entries.map((entry) => {
    const aliases = normalizeCompetitorAliases(entry.aliases)
    return {
      domain: entry.domain,
      competitorKey: normalizeCompetitorDomain(entry.domain),
      explicit: entry.explicit,
      added: entry.added === true,
      aliases,
      aliasNames: usableBrandAliases(aliases).map(identityName),
      domainNames: competitorBrandAliases({ domain: entry.domain }).map(identityName),
    }
  })
  const rejected: CompetitorAliasRejection[] = []
  const dropped: CompetitorAliasRejection[] = []
  const overLimit: { domain: string; count: number }[] = []

  /**
   * Every other competitor the alias overlaps (at most one conflict each,
   * its domain names before its aliases). A carried-over alias skips the
   * aliases of an explicit list: that list is checked from its own side.
   */
  const conflictsFor = (index: number, alias: IdentityName, explicit: boolean): AliasConflict[] => {
    const conflicts: AliasConflict[] = []
    for (let other = 0; other < normalized.length; other++) {
      if (other === index) continue
      const entry = normalized[other]!
      if (entry.competitorKey === normalized[index]!.competitorKey) continue
      const domainName = overlappingName(alias, entry.domainNames)
      if (domainName) {
        conflicts.push({ domain: entry.domain, name: domainName, viaDomain: true, added: entry.added })
        continue
      }
      if (!explicit && entry.explicit) continue
      const aliasName = overlappingName(alias, entry.aliasNames)
      if (aliasName) conflicts.push({ domain: entry.domain, name: aliasName, viaDomain: false, added: entry.added })
    }
    return conflicts
  }

  const competitors = normalized.map((entry, index) => {
    const kept: string[] = []
    for (const alias of entry.aliases) {
      const name = identityName(alias)
      let rejection: CompetitorAliasRejection | null = null
      if (alias.length > COMPETITOR_ALIAS_MAX_LENGTH) {
        rejection = { domain: entry.domain, alias, reason: 'too-long' }
      } else if (name.key.length < MIN_BRAND_ALIAS_KEY_LENGTH) {
        rejection = { domain: entry.domain, alias, reason: 'too-short' }
      } else {
        const claim = projectClaim(name)
        if (claim) {
          rejection = { domain: entry.domain, alias, reason: 'project-brand', ...conflictingNameField(name, claim) }
        } else {
          const conflicts = conflictsFor(index, name, entry.explicit)
          // A carried-over alias that a newly added domain overlaps blocks
          // that add, even when the alias also overlaps a stored list, so the
          // outcome never depends on which conflict is found first.
          const blockedAdds = entry.explicit ? [] : conflicts.filter(conflict => conflict.viaDomain && conflict.added)
          if (blockedAdds.length > 0) {
            for (const conflict of blockedAdds) {
              rejected.push({
                domain: conflict.domain,
                alias,
                reason: 'claimed-by-alias',
                conflictsWith: entry.domain,
                ...conflictingNameField(name, conflict.name),
              })
            }
            // The stored alias stays as it was; the write fails.
            kept.push(alias)
            continue
          }
          const conflict = conflicts.at(0)
          if (conflict) {
            rejection = {
              domain: entry.domain,
              alias,
              reason: 'other-competitor',
              conflictsWith: conflict.domain,
              ...conflictingNameField(name, conflict.name),
            }
          }
        }
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

/**
 * The project domain a competitor domain would take over, or null: the same
 * site, a subdomain of a project domain, or a parent of one (a competitor at
 * `pagehost.example` while the project owns `acme.pagehost.example`). Every
 * citation of the project would then count for the competitor too, so no
 * writer may start tracking such a domain.
 */
export function competitorDomainProjectClaim(domain: string, projectDomains: readonly string[]): string | null {
  return projectDomains.find(projectDomain => hostMatchesDomain(domain, projectDomain) || hostMatchesDomain(projectDomain, domain)) ?? null
}

/** One rejection in words, as the write's validation error states it. */
export function describeCompetitorAliasRejection(rejection: CompetitorAliasRejection): string {
  switch (rejection.reason) {
    case 'too-long':
      return `"${rejection.alias}" is longer than ${COMPETITOR_ALIAS_MAX_LENGTH} characters`
    case 'too-short':
      return `"${rejection.alias}" is too short: an alias needs at least ${MIN_BRAND_ALIAS_KEY_LENGTH} letters or digits`
    case 'project-brand':
      return rejection.conflictingName
        ? `"${rejection.alias}" ${overlapRelation(rejection.alias, rejection.conflictingName)}, one of the project's own names, so one answer would count both the project and ${rejection.domain}`
        : `"${rejection.alias}" is one of the project's own brand names, so it would count the project as a competitor`
    case 'other-competitor': {
      const other = rejection.conflictsWith ?? 'another tracked competitor'
      return rejection.conflictingName
        ? `"${rejection.alias}" ${overlapRelation(rejection.alias, rejection.conflictingName)}, a name of ${other}, so one answer would count both competitors`
        : `"${rejection.alias}" already identifies ${other}`
    }
    case 'claimed-by-alias': {
      const owner = rejection.conflictsWith ?? 'another tracked competitor'
      const overlap = rejection.conflictingName
        ? ` (it ${overlapRelation(rejection.alias, rejection.conflictingName)}, a name of ${rejection.domain}, so one answer would count both competitors)`
        : ''
      return `cannot be added while "${rejection.alias}" is a curated alias of ${owner}${overlap}; remove or restate that alias first`
    }
  }
}

/**
 * `planCompetitorAliases`, failing the write with one validation error that
 * names every rejected alias, every blocked add and every over-limit list. Returns the plan for a
 * write that passes (carried-over drops included, for the audit row).
 */
export function requireCompetitorAliasPlan(
  entries: readonly CompetitorAliasPlanEntry[],
  project: CompetitorAliasProjectIdentity,
): CompetitorAliasPlan {
  const plan = planCompetitorAliases(entries, project)
  if (plan.rejected.length === 0 && plan.overLimit.length === 0) return plan
  const problems = [
    ...plan.overLimit.map(item => `${item.domain} has ${item.count} aliases (at most ${COMPETITOR_ALIAS_LIMIT})`),
    ...plan.rejected.map(rejection => `${rejection.domain}: ${describeCompetitorAliasRejection(rejection)}`),
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

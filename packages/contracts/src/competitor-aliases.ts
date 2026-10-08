import { z } from 'zod'
import { MIN_BRAND_ALIAS_KEY_LENGTH, MIN_DOMAIN_BRAND_KEY_LENGTH, usableBrandAliases } from './answer-visibility.js'
import { brandKeyFromText, textContainsAnyBrandAlias, textContainsBrandAlias } from './brand-matching.js'
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
  /** Operator-curated aliases (`competitors.aliases`). */
  aliases?: readonly string[] | null
  /**
   * Names detected from the project's own stored answers
   * (`competitors.auto_aliases`, see `competitor-auto-aliases.ts`). Read by
   * name only; the evidence fields ride along unread.
   */
  autoAliases?: readonly { name: unknown }[] | null
  /** Names the operator blocked from auto-detection (`competitors.blocked_aliases`). */
  blockedAliases?: readonly string[] | null
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
 * Every alias a competitor answers to besides its domain: its curated aliases,
 * then its auto-detected names, minus any name the operator blocked (compared
 * by brand key). Curated spellings win a case-insensitive tie. This is the one
 * list every reader matches and every frozen identity records, so curated and
 * auto names count the same way on every surface.
 */
export function competitorIdentityAliases(competitor: CompetitorIdentityInput): string[] {
  const curated = normalizeCompetitorAliases(competitor.aliases)
  const auto = (competitor.autoAliases ?? [])
    .map(entry => entry.name)
    // Stored JSON: a malformed entry is skipped, never matched.
    .filter((name): name is string => typeof name === 'string')
  if (auto.length === 0) return curated
  const blocked = new Set(normalizeCompetitorAliases(competitor.blockedAliases).map(brandKeyFromText))
  return normalizeCompetitorAliases([
    ...curated,
    ...auto.filter(name => !blocked.has(brandKeyFromText(name))),
  ])
}

/**
 * The auto-detected names a competitor answers to: `competitorIdentityAliases`
 * minus its curated aliases. For display ("auto" next to curated names).
 */
export function competitorAutoAliasNames(competitor: CompetitorIdentityInput): string[] {
  const curated = new Set(normalizeCompetitorAliases(competitor.aliases).map(alias => alias.toLowerCase()))
  return competitorIdentityAliases(competitor).filter(name => !curated.has(name.toLowerCase()))
}

/**
 * The names a competitor goes by in answer prose: its aliases
 * (`competitorIdentityAliases`, alias floor) plus its domain label when that
 * label passes the domain floor. Used by matchers that check the written host
 * separately.
 */
export function competitorNameAliases(competitor: CompetitorIdentityInput): string[] {
  const label = brandLabelFromDomain(competitor.domain)
  return usableBrandAliases([
    ...(brandKeyFromText(label).length >= MIN_DOMAIN_BRAND_KEY_LENGTH ? [label] : []),
    ...competitorIdentityAliases(competitor),
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
  | 'market-competitor'
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
   * ('other-competitor', or 'market-competitor' for a competitor an Advanced
   * market pins), or the one whose stored alias the new competitor's domain
   * would take over ('claimed-by-alias').
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
  /**
   * Set when `conflictsWith` is a competitor an Advanced market pins: the
   * markets (group keys) that pin it. On 'market-competitor', and on
   * 'claimed-by-alias' when `alias` is one of the pin's names.
   */
  markets?: string[]
  /**
   * With `markets`, when only a superseded plan revision pins `conflictsWith`
   * there: that revision's number. The project's runs measured under it are
   * still scored with the pin, and no write can change a published revision.
   */
  supersededRevision?: number
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

/**
 * A competitor an Advanced market pins, as the alias rules see it. An Advanced
 * read counts the project's tracked competitors and the market's pins
 * together, so a curated alias must stay clear of every pin's names as it
 * does of every other tracked competitor's.
 */
export interface CompetitorAliasMarketPin {
  domain: string
  /** The pin's label and curated aliases. */
  names: readonly string[]
  /** The markets (group keys) that pin it. */
  markets: readonly string[]
  /**
   * Alias side only: the pin is read from this superseded plan revision, not
   * the active one or the draft. The runs measured under that revision are
   * still scored with it, so the alias rules hold against it all the same.
   */
  supersededRevision?: number
  /**
   * Pin side only (`marketPinAliasClaims`): the write gives a pin its markets
   * already had only new names. `names` then holds just those names, and the
   * pin's domain label and host, already pinned, are not checked again.
   */
  renamed?: boolean
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
  /** Set when the other competitor is an Advanced market pin: its `pinFields`. */
  pin?: PinFields
}

/** The rejection fields that name a market pin: its markets, and its superseded revision. */
interface PinFields {
  markets: string[]
  supersededRevision?: number
}

function pinFields(pin: Pick<CompetitorAliasMarketPin, 'markets' | 'supersededRevision'>): PinFields {
  return {
    markets: [...new Set(pin.markets)].sort(),
    ...(pin.supersededRevision !== undefined ? { supersededRevision: pin.supersededRevision } : {}),
  }
}

/**
 * What an Advanced read matches a market pin by: its label and curated
 * aliases, its domain label and its written host.
 */
function marketPinNames(pin: CompetitorAliasMarketPin): IdentityName[] {
  return usableBrandAliases([...pin.names, ...competitorBrandAliases({ domain: pin.domain })]).map(identityName)
}

/**
 * A pin's curated names: its label and aliases, less any that only restates
 * its own domain label or host (the label a pin by domain alone generates).
 * Two competitors' domains are never compared with each other, so only these
 * names can claim another competitor's domain.
 */
function pinCuratedNames(domain: string, names: readonly string[]): IdentityName[] {
  const domainKeys = new Set([brandLabelFromDomain(domain), hostOf(domain) ?? ''].map(brandKeyFromText).filter(Boolean))
  return usableBrandAliases(normalizeCompetitorAliases(names)).map(identityName).filter(name => !domainKeys.has(name.key))
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
 * the domain floor, and its written host (`competitorBrandAliases`); no
 * overlap with any name of a competitor an Advanced market pins (`marketPins`:
 * its label, curated aliases, domain label and host), because an Advanced read
 * counts tracked competitors and market pins together ('market-competitor').
 * Rows and pins that normalize to the same registrable domain are one
 * competitor. Two competitors' domains are not compared with each other: that
 * overlap predates aliases and is not a curated-alias problem. A pin read from
 * a superseded revision (`supersededRevision`) counts like any other: the runs
 * measured under that revision are still scored with it.
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
 * another competitor's alias. A new competitor whose domain name overlaps a
 * market pin's label or curated alias (not the pin's own domain name) rejects
 * the write the same way ('claimed-by-alias', `conflictsWith` the pin, with its
 * `markets`): no competitor write can change a pin. A carried-over alias is
 * dropped and reported only when nothing in the write states it: the project's
 * identity now claims the name, or stored lists (market pins included) already
 * overlap each other.
 */
export function planCompetitorAliases(
  entries: readonly CompetitorAliasPlanEntry[],
  project: CompetitorAliasProjectIdentity,
  marketPins: readonly CompetitorAliasMarketPin[] = [],
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
  const pins = marketPins.map(pin => ({
    domain: pin.domain,
    competitorKey: normalizeCompetitorDomain(pin.domain),
    fields: pinFields(pin),
    names: marketPinNames(pin),
    curatedNames: pinCuratedNames(pin.domain, pin.names),
  }))
  const rejected: CompetitorAliasRejection[] = []
  const dropped: CompetitorAliasRejection[] = []
  const overLimit: { domain: string; count: number }[] = []

  /**
   * Every other competitor the alias overlaps (at most one conflict each,
   * its domain names before its aliases), then every market pin of another
   * domain it overlaps. A carried-over alias skips the aliases of an explicit
   * list: that list is checked from its own side.
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
    for (const pin of pins) {
      if (pin.competitorKey === normalized[index]!.competitorKey) continue
      const pinName = overlappingName(alias, pin.names)
      if (pinName) conflicts.push({ domain: pin.domain, name: pinName, viaDomain: false, added: false, pin: pin.fields })
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
              reason: conflict.pin ? 'market-competitor' : 'other-competitor',
              conflictsWith: conflict.domain,
              ...conflictingNameField(name, conflict.name),
              ...(conflict.pin ? { ...conflict.pin, markets: [...conflict.pin.markets] } : {}),
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

  // A new competitor whose domain name a pin's curated name overlaps would
  // answer to that name too. The pin is not this write's to change, so the add
  // fails, once per pin name (a pin read from several revisions names it once).
  const pinClaims = new Set<string>()
  for (const pin of pins) {
    for (const entry of normalized) {
      if (!entry.added || entry.competitorKey === pin.competitorKey) continue
      for (const pinName of pin.curatedNames) {
        const domainName = overlappingName(pinName, entry.domainNames)
        if (!domainName) continue
        const claim = JSON.stringify([entry.competitorKey, pin.competitorKey, pinName.key])
        if (pinClaims.has(claim)) continue
        pinClaims.add(claim)
        rejected.push({
          domain: entry.domain,
          alias: pinName.name,
          reason: 'claimed-by-alias',
          conflictsWith: pin.domain,
          ...conflictingNameField(pinName, domainName),
          ...pin.fields,
          markets: [...pin.fields.markets],
        })
      }
    }
  }

  return { competitors, rejected, overLimit, dropped }
}

/**
 * The rule from the pin's side: every curated alias of a tracked competitor
 * that one of `pins` would also answer to (one brand key containing the
 * other, as `planCompetitorAliases` compares). Such a pin credits one answer
 * to both, so the pin write fails ('claimed-by-alias', `domain` the pin,
 * `conflictsWith` the alias owner) until the operator removes or restates
 * that alias, as a Simple add does. A pin whose label or curated alias
 * overlaps a tracked competitor's own domain name (its gated domain label or
 * written host) credits one answer to both as well, and fails as
 * 'other-competitor' (`alias` the pin's name, `conflictsWith` the tracked
 * competitor); the pin's own domain name is never compared with another
 * domain. A pin of the tracked competitor's own registrable domain is the
 * same competitor and is not checked. A `renamed` pin is checked by its new
 * names alone.
 */
export function marketPinAliasClaims(
  pins: readonly CompetitorAliasMarketPin[],
  tracked: readonly CompetitorIdentityInput[],
): CompetitorAliasRejection[] {
  const claims: CompetitorAliasRejection[] = []
  for (const pin of pins) {
    const pinKey = normalizeCompetitorDomain(pin.domain)
    const pinNames = pin.renamed ? usableBrandAliases(pin.names).map(identityName) : marketPinNames(pin)
    const curatedNames = pinCuratedNames(pin.domain, pin.names)
    for (const competitor of tracked) {
      if (normalizeCompetitorDomain(competitor.domain) === pinKey) continue
      // Pin names an alias claim already names, so one name is reported once.
      const claimedNames = new Set<string>()
      for (const alias of usableBrandAliases(normalizeCompetitorAliases(competitor.aliases))) {
        const name = identityName(alias)
        const overlap = overlappingName(name, pinNames)
        if (!overlap) continue
        claimedNames.add(overlap.key)
        claims.push({
          domain: pin.domain,
          alias,
          reason: 'claimed-by-alias',
          conflictsWith: competitor.domain,
          ...conflictingNameField(name, overlap),
        })
      }
      const domainNames = competitorBrandAliases({ domain: competitor.domain }).map(identityName)
      for (const name of curatedNames) {
        if (claimedNames.has(name.key)) continue
        const overlap = overlappingName(name, domainNames)
        if (!overlap) continue
        claims.push({
          domain: pin.domain,
          alias: name.name,
          reason: 'other-competitor',
          conflictsWith: competitor.domain,
          ...conflictingNameField(name, overlap),
        })
      }
    }
  }
  return claims
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
    case 'market-competitor': {
      const pinned = pinnedCompetitorText(rejection)
      return rejection.conflictingName
        ? `"${rejection.alias}" ${overlapRelation(rejection.alias, rejection.conflictingName)}, a name of ${pinned}, so one answer would count both competitors`
        : `"${rejection.alias}" already identifies ${pinned}, so one answer would count both competitors`
    }
    case 'claimed-by-alias':
      return rejection.markets ? claimedByPinText(rejection) : claimedByAliasText(rejection, 'cannot be added')
  }
}

/**
 * `boltline.example, which Advanced market "east" pins`, or for a superseded
 * revision `..., which Advanced market "east" pinned in revision 1, whose runs
 * still score with it`.
 */
function pinnedCompetitorText(rejection: CompetitorAliasRejection): string {
  const markets = rejection.markets ?? []
  const plural = markets.length > 1
  const named = markets.length === 0
    ? 'an Advanced market'
    : `Advanced market${plural ? 's' : ''} ${markets.map(market => `"${market}"`).join(', ')}`
  const pinnedBy = rejection.supersededRevision !== undefined
    ? `${named} pinned in revision ${rejection.supersededRevision}, whose runs still score with it`
    : `${named} ${plural ? 'pin' : 'pins'}`
  return `${rejection.conflictsWith ?? 'a competitor'}, which ${pinnedBy}`
}

/**
 * A 'claimed-by-alias' add a market pin's name blocks. An editable pin names
 * the way out; a superseded revision cannot change, so it says only why.
 */
function claimedByPinText(rejection: CompetitorAliasRejection): string {
  const overlap = rejection.conflictingName
    ? ` (it ${overlapRelation(rejection.alias, rejection.conflictingName)}, a name of ${rejection.domain})`
    : ''
  const remedy = rejection.supersededRevision === undefined ? '; remove that name from the market pin first' : ''
  return `cannot be added while "${rejection.alias}" is a name of ${pinnedCompetitorText(rejection)}${overlap}, so one answer would count both competitors${remedy}`
}

/** A 'claimed-by-alias' rejection in words: `blocked` while the alias stands. */
function claimedByAliasText(rejection: CompetitorAliasRejection, blocked: string): string {
  const owner = rejection.conflictsWith ?? 'another tracked competitor'
  const overlap = rejection.conflictingName
    ? ` (it ${overlapRelation(rejection.alias, rejection.conflictingName)}, a name of ${rejection.domain}, so one answer would count both competitors)`
    : ''
  return `${blocked} while "${rejection.alias}" is a curated alias of ${owner}${overlap}; remove or restate that alias first`
}

/**
 * One `marketPinAliasClaims` claim in words. A pin new to a market "cannot be
 * added"; a pin the write only gives a new name (`renamed`) "cannot be pinned
 * by that name".
 */
export function describeMarketPinAliasClaim(claim: CompetitorAliasRejection, renamed: boolean): string {
  const blocked = renamed ? 'cannot be pinned by that name' : 'cannot be added'
  if (claim.reason !== 'other-competitor') return claimedByAliasText(claim, blocked)
  const owner = claim.conflictsWith ? `the tracked competitor ${claim.conflictsWith}` : 'another tracked competitor'
  const overlap = claim.conflictingName
    ? `"${claim.alias}" ${overlapRelation(claim.alias, claim.conflictingName)}, a name of ${owner}`
    : `"${claim.alias}" already identifies ${owner}`
  return `${blocked}: ${overlap}, so one answer would count both competitors; pin it by another name`
}

/**
 * `planCompetitorAliases`, failing the write with one validation error that
 * names every rejected alias, every blocked add and every over-limit list. Returns the plan for a
 * write that passes (carried-over drops included, for the audit row).
 */
export function requireCompetitorAliasPlan(
  entries: readonly CompetitorAliasPlanEntry[],
  project: CompetitorAliasProjectIdentity,
  marketPins: readonly CompetitorAliasMarketPin[] = [],
): CompetitorAliasPlan {
  const plan = planCompetitorAliases(entries, project, marketPins)
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

export type CompetitorAutoAliasDropReason =
  | 'too-long'
  | 'too-short'
  | 'blocked'
  | 'already-matched'
  | 'subsumed'
  | 'project-brand'
  | 'other-competitor'
  | 'over-limit'

export interface CompetitorAutoAliasPlanEntry {
  domain: string
  /** The competitor's curated aliases as they will be stored. */
  aliases: readonly string[]
  /** Auto names stored now, in stored order. */
  autoAliases: readonly string[]
  /** Newly detected names, strongest evidence first: the cap keeps the first ones. */
  candidates?: readonly string[]
  /**
   * Names detection lists for an operator to verify as curated aliases. The
   * plan returns the ones no identity rule drops (`CompetitorAutoAliasPlan.review`).
   */
  review?: readonly string[]
  /** Names the operator blocked from auto-detection. */
  blockedAliases?: readonly string[] | null
}

export interface CompetitorAutoAliasDrop {
  domain: string
  alias: string
  reason: CompetitorAutoAliasDropReason
  /** True for a stored auto name that no longer qualifies; false for a new candidate. */
  stored: boolean
  /** The other competitor involved ('other-competitor'). */
  conflictsWith?: string
  /** The name the alias overlaps, when it is a different name. */
  conflictingName?: string
}

export interface CompetitorAutoAliasPlan {
  /**
   * Every entry's auto names after the plan: kept stored names first (a new
   * name a stored one is built on takes its place), then accepted candidates
   * in the order given.
   */
  competitors: { domain: string; autoAliases: string[] }[]
  dropped: CompetitorAutoAliasDrop[]
  /** Per entry, in entry order: its `review` names that pass the identity rules. */
  review: string[][]
  /** The `review` names an identity rule drops (`stored: false`). */
  reviewDropped: CompetitorAutoAliasDrop[]
}

/**
 * Plan every competitor's AUTO-DETECTED names together, after the curated
 * plan. Auto names follow the same identity rules as curated aliases
 * (`planCompetitorAliases`), but they never fail a write: a name that does not
 * qualify is dropped and reported. Precedence is fixed, so the outcome for
 * new names never depends on the order of the competitors:
 *
 * 1. Curated identity wins. An auto name is dropped when its brand key is
 *    shorter than the domain-label floor (`MIN_DOMAIN_BRAND_KEY_LENGTH`: a
 *    derived name, like a derived domain label, needs an operator's approval
 *    to count at 3 letters), when its brand key is blocked for that
 *    competitor, when the competitor's own identity already matches it as
 *    complete words (its domain label at the domain floor, a curated alias,
 *    a kept auto name it contains, or, for a NEW name only, a name of its own
 *    active or draft Advanced plan pin: 'already-matched'), when it overlaps
 *    a project name or host ('project-brand'), or when it overlaps another
 *    competitor's domain identity or curated alias, or any name of a market
 *    pin of another registrable domain (`marketPins`, the pins the curated
 *    rules take: its label, curated aliases, domain label and host;
 *    'other-competitor', `conflictsWith` the pin). The competitor's own pins
 *    are its plan identity: the plan label already names it in every
 *    Advanced read, so a new sub-brand that label covers ("Velo Hub
 *    Springfield" under the pin "Velo Hub") would only spend a slot of the
 *    cap. A STORED name stays: project-frame reads do not count pin names,
 *    so pinning a competitor in one market, even in a draft, never deletes
 *    a name it is learned by project-wide. A pin only a superseded revision
 *    holds names nothing in new answers and does not count. A blocked name
 *    is dropped before it can subsume anything, so blocking a short name
 *    frees the longer ones. An operator never has to remove an auto name to
 *    write a curated one, and adding a competitor never fails because
 *    another competitor carries an auto name its domain claims.
 * 2. A shorter name covers the longer ones built on it. One competitor's
 *    candidates are checked shortest brand key first, so a candidate that
 *    contains an accepted one is dropped ('subsumed') whatever order they
 *    are given in, and a stored name that contains an accepted candidate
 *    gives it its place ('subsumed', `stored: true`): "Velo Hub" replaces
 *    "Velo Hub Springfield".
 * 3. Stored auto names beat new candidates. A stored name that overlaps
 *    another competitor's earlier stored auto name is dropped (only possible
 *    after an identity change), and a new candidate that overlaps any other
 *    competitor's kept auto name is dropped.
 * 4. New candidates of two competitors that overlap each other are BOTH
 *    dropped: neither answer-derived claim is safe to count.
 *
 * At most `COMPETITOR_ALIAS_LIMIT` auto names per competitor: stored names
 * first, then accepted candidates in the order given (callers pass the
 * strongest evidence first, so evidence, not name length, fills the cap).
 *
 * `review` names (detection's suggestions for curated aliases) get the
 * rules of step 1 at the curated-alias floor (`MIN_BRAND_ALIAS_KEY_LENGTH`),
 * a new name's own-pin check included, and are dropped when they contain one
 * of the competitor's own planned auto names ('already-matched'). They skip
 * steps 2 to 4: no check against another competitor's stored or accepted
 * auto names. They never change the plan.
 */
export function planCompetitorAutoAliases(
  entries: readonly CompetitorAutoAliasPlanEntry[],
  project: CompetitorAliasProjectIdentity,
  /** The competitors the project's Advanced markets pin (`readMarketCompetitorPins` in api-routes). */
  marketPins: readonly CompetitorAliasMarketPin[] = [],
): CompetitorAutoAliasPlan {
  const projectNames = [
    ...project.brandNames,
    ...project.domains.map(domain => hostOf(domain) ?? domain.trim().toLowerCase()),
  ].map(identityName).filter(name => name.key)
  const pins = marketPins.map(pin => ({
    domain: pin.domain,
    competitorKey: normalizeCompetitorDomain(pin.domain),
    names: marketPinNames(pin),
    current: pin.supersededRevision === undefined,
    curatedNames: usableBrandAliases(pin.names),
  }))
  const prepared = entries.map((entry) => {
    const competitorKey = normalizeCompetitorDomain(entry.domain)
    return {
      domain: entry.domain,
      competitorKey,
      domainNames: competitorBrandAliases({ domain: entry.domain }).map(identityName),
      curatedNames: usableBrandAliases(normalizeCompetitorAliases(entry.aliases)).map(identityName),
      ownNames: competitorNameAliases({ domain: entry.domain, aliases: entry.aliases }),
      ownPinNames: pins.filter(pin => pin.current && pin.competitorKey === competitorKey).flatMap(pin => pin.curatedNames),
      blocked: new Set(normalizeCompetitorAliases(entry.blockedAliases).map(brandKeyFromText)),
      stored: normalizeCompetitorAliases(entry.autoAliases),
      candidates: normalizeCompetitorAliases(entry.candidates ?? []),
      review: normalizeCompetitorAliases(entry.review ?? []),
    }
  })
  const dropped: CompetitorAutoAliasDrop[] = []

  /**
   * Rules that need no other auto name: length, block, own identity, project,
   * other competitors' curated identity and market pins. `minKeyLength` is
   * the domain-label floor for an auto name, the curated floor for a review
   * name an operator would add as a curated alias.
   */
  const baseRejection = (index: number, alias: string, stored: boolean, minKeyLength = MIN_DOMAIN_BRAND_KEY_LENGTH): CompetitorAutoAliasDrop | null => {
    const entry = prepared[index]!
    const name = identityName(alias)
    const drop = (reason: CompetitorAutoAliasDropReason, extra: Partial<CompetitorAutoAliasDrop> = {}): CompetitorAutoAliasDrop =>
      ({ domain: entry.domain, alias, reason, stored, ...extra })
    if (alias.length > COMPETITOR_ALIAS_MAX_LENGTH) return drop('too-long')
    if (name.key.length < minKeyLength) return drop('too-short')
    if (entry.blocked.has(name.key)) return drop('blocked')
    if (textContainsAnyBrandAlias(alias, entry.ownNames)) return drop('already-matched')
    if (!stored && textContainsAnyBrandAlias(alias, entry.ownPinNames)) return drop('already-matched')
    const claim = overlappingName(name, projectNames)
    if (claim) return drop('project-brand', conflictingNameField(name, claim))
    for (let other = 0; other < prepared.length; other++) {
      const otherEntry = prepared[other]!
      if (other === index || otherEntry.competitorKey === entry.competitorKey) continue
      const overlap = overlappingName(name, otherEntry.domainNames) ?? overlappingName(name, otherEntry.curatedNames)
      if (overlap) return drop('other-competitor', { conflictsWith: otherEntry.domain, ...conflictingNameField(name, overlap) })
    }
    for (const pin of pins) {
      if (pin.competitorKey === entry.competitorKey) continue
      const overlap = overlappingName(name, pin.names)
      if (overlap) return drop('other-competitor', { conflictsWith: pin.domain, ...conflictingNameField(name, overlap) })
    }
    return null
  }

  /** The first auto name of another competitor in `names` that `alias` overlaps. */
  const otherAutoOverlap = (
    index: number,
    alias: IdentityName,
    names: readonly { index: number; name: IdentityName }[],
  ): { index: number; name: IdentityName } | undefined => names.find(entry =>
    entry.index !== index
    && prepared[entry.index]!.competitorKey !== prepared[index]!.competitorKey
    && namesOverlap(alias, entry.name))

  // Stored names first, in entry order (callers pass competitors sorted by
  // domain, so the competitor whose domain sorts first keeps an overlapping
  // stored name).
  const kept: { index: number; name: IdentityName }[] = []
  const keptByEntry = prepared.map(() => [] as string[])
  prepared.forEach((entry, index) => {
    for (const alias of entry.stored) {
      const name = identityName(alias)
      const rejection = baseRejection(index, alias, true)
      if (rejection) { dropped.push(rejection); continue }
      const conflict = otherAutoOverlap(index, name, kept)
      if (conflict) {
        dropped.push({
          domain: entry.domain,
          alias,
          reason: 'other-competitor',
          stored: true,
          conflictsWith: prepared[conflict.index]!.domain,
          ...conflictingNameField(name, conflict.name),
        })
        continue
      }
      kept.push({ index, name })
      keptByEntry[index]!.push(alias)
    }
  })

  // New candidates, in entry order: checked against every kept name, then
  // against each other. One competitor's are checked shortest brand key
  // first, so a passing short name subsumes the longer ones built on it
  // whatever order they come in; the sort is stable, and `order` keeps the
  // caller's (strongest-first) order for the cap and for the drops reported.
  const fresh: { index: number; name: IdentityName; order: number }[] = []
  prepared.forEach((entry, index) => {
    const storedKeys = new Set(keptByEntry[index]!.map(brandKeyFromText))
    const acceptedHere: string[] = []
    const drops: { order: number; drop: CompetitorAutoAliasDrop }[] = []
    const shortestFirst = entry.candidates
      .map((alias, order) => ({ alias, order, name: identityName(alias) }))
      .sort((left, right) => left.name.key.length - right.name.key.length)
    for (const { alias, order, name } of shortestFirst) {
      if (storedKeys.has(name.key)) continue
      const rejection = baseRejection(index, alias, false)
      if (rejection) { drops.push({ order, drop: rejection }); continue }
      if (textContainsAnyBrandAlias(alias, keptByEntry[index]!)) {
        drops.push({ order, drop: { domain: entry.domain, alias, reason: 'already-matched', stored: false } })
        continue
      }
      if (textContainsAnyBrandAlias(alias, acceptedHere)) {
        drops.push({ order, drop: { domain: entry.domain, alias, reason: 'subsumed', stored: false } })
        continue
      }
      const conflict = otherAutoOverlap(index, name, kept)
      if (conflict) {
        drops.push({
          order,
          drop: {
            domain: entry.domain,
            alias,
            reason: 'other-competitor',
            stored: false,
            conflictsWith: prepared[conflict.index]!.domain,
            ...conflictingNameField(name, conflict.name),
          },
        })
        continue
      }
      fresh.push({ index, name, order })
      acceptedHere.push(alias)
    }
    dropped.push(...drops.sort((left, right) => left.order - right.order).map(item => item.drop))
  })
  const accepted = fresh.filter((candidate) => {
    const conflict = otherAutoOverlap(candidate.index, candidate.name, fresh)
    if (!conflict) return true
    dropped.push({
      domain: prepared[candidate.index]!.domain,
      alias: candidate.name.name,
      reason: 'other-competitor',
      stored: false,
      conflictsWith: prepared[conflict.index]!.domain,
      ...conflictingNameField(candidate.name, conflict.name),
    })
    return false
  })

  const competitors = prepared.map((entry, index) => {
    const acceptedHere = accepted
      .filter(candidate => candidate.index === index)
      .sort((left, right) => left.order - right.order)
      .map(candidate => candidate.name.name)
    // A stored name an accepted candidate is built on adds nothing that
    // candidate does not match: the candidate takes its place, so it never
    // goes over the limit for it.
    const names: string[] = []
    const placed = new Set<string>()
    for (const alias of keptByEntry[index]!) {
      const covering = acceptedHere.find(candidate => textContainsAnyBrandAlias(alias, [candidate]))
      if (!covering) {
        names.push(alias)
        continue
      }
      dropped.push({ domain: entry.domain, alias, reason: 'subsumed', stored: true })
      if (!placed.has(covering)) names.push(covering)
      placed.add(covering)
    }
    names.push(...acceptedHere.filter(candidate => !placed.has(candidate)))
    for (const alias of names.slice(COMPETITOR_ALIAS_LIMIT)) {
      dropped.push({ domain: entry.domain, alias, reason: 'over-limit', stored: keptByEntry[index]!.includes(alias) })
    }
    return { domain: entry.domain, autoAliases: names.slice(0, COMPETITOR_ALIAS_LIMIT) }
  })

  const reviewDropped: CompetitorAutoAliasDrop[] = []
  const review = prepared.map((entry, index) => entry.review.filter((alias) => {
    const rejection = baseRejection(index, alias, false, MIN_BRAND_ALIAS_KEY_LENGTH)
      ?? (textContainsAnyBrandAlias(alias, competitors[index]!.autoAliases)
        ? { domain: entry.domain, alias, reason: 'already-matched' as const, stored: false }
        : null)
    if (rejection) reviewDropped.push(rejection)
    return rejection === null
  }))
  return { competitors, dropped, review, reviewDropped }
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

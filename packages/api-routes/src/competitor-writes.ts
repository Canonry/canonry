import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { competitors, type DatabaseClient } from '@ainyc/canonry-db'
import {
  competitorDomainProjectClaim,
  competitorEntryParts,
  competitorLabelFromDomain,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  planCompetitorAliases,
  requireCompetitorAliasPlan,
  validationError,
  type AppError,
  type CompetitorAliasPlanEntry,
  type CompetitorAliasProjectIdentity,
  type CompetitorAliasRejection,
  type CompetitorEntry,
} from '@ainyc/canonry-contracts'

/**
 * The one write path that adds competitors or changes their curated aliases.
 * REST (`PUT`/`POST /competitors`, the alias route), config-as-code apply,
 * discovery promote, and a project identity change all plan through
 * `planCompetitorSet`, so the same alias rules hold whichever surface wrote
 * last, and a domain-only write never wipes stored aliases. The two DELETE
 * routes remove rows directly (removing a competitor cannot break another
 * competitor's alias) and audit the aliases they discard.
 *
 * Every write stores the registrable form (`normalizeCompetitorDomain`), and
 * every lookup by domain compares stored rows in that form too, so a row an
 * older build stored unnormalized (a promoted subdomain) is still found by any
 * spelling. Two stored rows that normalize to one domain are duplicates of one
 * competitor: a write that must change one of them fails
 * (`duplicateCompetitorRowsError`) instead of picking one. No write starts
 * tracking the project's own site (`competitorDomainProjectClaim`).
 */

/** Normalize and dedupe a list of competitor domains, keeping first-seen order. */
export function normalizeCompetitorList(domains: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of domains) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const normalized = normalizeCompetitorDomain(trimmed)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/** One desired competitor. `aliases` undefined means "no opinion": keep stored. */
export interface CompetitorWrite {
  domain: string
  aliases?: readonly string[]
  /** `set` (default) replaces the stored list; `add` appends to it. */
  aliasMode?: 'set' | 'add'
}

/**
 * Normalize writes to registrable domains, first-seen order, duplicates merged
 * (their stated aliases concatenated, the first write's `aliasMode` kept).
 */
function mergeCompetitorWrites(writes: readonly CompetitorWrite[]): CompetitorWrite[] {
  const byDomain = new Map<string, CompetitorWrite>()
  for (const write of writes) {
    const trimmed = write.domain.trim()
    if (!trimmed) continue
    const domain = normalizeCompetitorDomain(trimmed)
    if (!domain) continue
    const existing = byDomain.get(domain)
    if (!existing) {
      byDomain.set(domain, { ...write, domain, ...(write.aliases !== undefined ? { aliases: [...write.aliases] } : {}) })
      continue
    }
    if (write.aliases !== undefined) {
      existing.aliases = [...(existing.aliases ?? []), ...write.aliases]
    }
  }
  return [...byDomain.values()]
}

/**
 * Normalize request or config entries into writes: registrable domains,
 * first-seen order, duplicates merged (their stated aliases concatenated).
 */
export function competitorWritesFromEntries(
  entries: readonly CompetitorEntry[],
  aliasMode: 'set' | 'add' = 'set',
): CompetitorWrite[] {
  return mergeCompetitorWrites(entries.map((entry) => {
    const parts = competitorEntryParts(entry)
    return { domain: parts.domain, aliasMode, ...(parts.aliases !== undefined ? { aliases: parts.aliases } : {}) }
  }))
}

export interface StoredCompetitor {
  id: string
  domain: string
  aliases: string[]
}

export interface CompetitorAliasChange {
  domain: string
  before: string[]
  after: string[]
}

export interface CompetitorSetPlan {
  /** Every competitor after the write, existing rows first in stored order. */
  final: { domain: string; aliases: string[] }[]
  added: string[]
  removed: StoredCompetitor[]
  /** Alias lists that change, including a new competitor added with aliases. */
  aliasChanges: CompetitorAliasChange[]
  /** Carried-over aliases dropped because they no longer qualify. */
  droppedAliases: CompetitorAliasRejection[]
}

/** Read a project's competitors in stored order. */
export function readStoredCompetitors(db: Pick<DatabaseClient, 'select'>, projectId: string): StoredCompetitor[] {
  return db.select({ id: competitors.id, domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors)
    .where(eq(competitors.projectId, projectId))
    .all()
}

/** Every stored row that is the competitor `domain` names, in any spelling. */
export function storedCompetitorMatches<T extends { domain: string }>(rows: readonly T[], domain: string): T[] {
  const key = normalizeCompetitorDomain(domain.trim())
  return rows.filter(row => normalizeCompetitorDomain(row.domain) === key)
}

/**
 * Two or more stored rows are one competitor (a subdomain an older build
 * stored next to its registrable form). A write cannot pick one, so the error
 * names every row and the way out every surface has: remove the competitor
 * (every row goes) and add it again, restating the curated aliases the rows
 * carry (`aliases`), which the removal discards.
 */
export function duplicateCompetitorRowsError(
  domain: string,
  rows: readonly { id: string; domain: string; aliases?: readonly string[] | null }[],
): AppError {
  const key = normalizeCompetitorDomain(domain.trim())
  const sorted = [...rows].sort((a, b) => a.domain.localeCompare(b.domain))
  const matches = sorted.map(row => ({ id: row.id, domain: row.domain }))
  const aliases = normalizeCompetitorAliases(sorted.flatMap(row => row.aliases ?? []))
  const addAgain = aliases.length > 0
    ? `then add it again with its curated aliases (canonry competitor add <project> ${key} ${aliases.map(alias => `--alias ${JSON.stringify(alias)}`).join(' ')})`
    : `then add it again (canonry competitor add <project> ${key})`
  return validationError(
    `Competitor ${key} is stored as ${matches.length} rows (${matches.map(row => row.domain).join(', ')}), so this write cannot pick one. `
    + `Remove the competitor, which removes every row (canonry competitor remove <project> ${key}), ${addAgain}`,
    { domain: key, matches, aliases },
  )
}

/**
 * New competitor domains that are the project's own site, a subdomain of it,
 * or a parent of an owned domain. Every citation of the project would count
 * for such a competitor, so no write starts tracking one.
 */
function ownSiteCompetitorError(claims: readonly { domain: string; projectDomain: string }[]): AppError {
  return validationError(
    `Cannot track the project's own site as a competitor: ${claims.map(claim => `${claim.domain} overlaps the project domain ${claim.projectDomain}`).join('; ')}, so every citation of the project would count for it`,
    { ownSiteCompetitors: claims },
  )
}

/**
 * The one stored row for the competitor `domain` names, in any spelling, or
 * null when it is not tracked. Throws `duplicateCompetitorRowsError` rather
 * than pick one of several.
 */
export function findStoredCompetitor<T extends { id: string; domain: string }>(rows: readonly T[], domain: string): T | null {
  const matches = storedCompetitorMatches(rows, domain)
  if (matches.length > 1) throw duplicateCompetitorRowsError(domain, matches)
  return matches[0] ?? null
}

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((alias, i) => alias === b[i])
}

export interface CompetitorSetPlanOptions {
  /** True makes `writes` the whole domain set; false merges them into it. */
  replace: boolean
  /** `competitorAliasProjectIdentity(project)` for the identity being written. */
  project: CompetitorAliasProjectIdentity
}

/**
 * Plan a write against the stored competitors. `replace` makes `writes` the
 * whole domain set (rows not named are removed); otherwise writes merge into
 * the stored set. Writes are normalized to registrable domains and match
 * stored rows in that form, so a row stored unnormalized is retained, not
 * duplicated. Retained rows keep their id, domain, provenance and aliases
 * unless a write states aliases. Throws a validation error when a stated alias
 * fails the shared rules (`requireCompetitorAliasPlan`), when a new domain's
 * name overlaps another competitor's stored alias, when a new domain is the
 * project's own site (`competitorDomainProjectClaim`), or when a write states
 * aliases for a competitor stored as several rows; a stored alias the
 * project's identity now claims is dropped and reported instead.
 */
export function planCompetitorSet(
  stored: readonly StoredCompetitor[],
  writes: readonly CompetitorWrite[],
  opts: CompetitorSetPlanOptions,
): CompetitorSetPlan {
  const writeByDomain = new Map(mergeCompetitorWrites(writes).map(write => [write.domain, write]))
  const storedByDomain = new Map(stored.map(row => [row.domain, row]))
  const storedKeys = new Set(stored.map(row => normalizeCompetitorDomain(row.domain)))
  for (const write of writeByDomain.values()) {
    if (write.aliases === undefined) continue
    const matches = storedCompetitorMatches(stored, write.domain)
    if (matches.length > 1) throw duplicateCompetitorRowsError(write.domain, matches)
  }
  const writeFor = (row: StoredCompetitor) => writeByDomain.get(normalizeCompetitorDomain(row.domain))
  const removed = opts.replace ? stored.filter(row => !writeFor(row)) : []
  const retained = stored.filter(row => !opts.replace || writeFor(row))
  const added = [...writeByDomain.keys()].filter(domain => !storedKeys.has(domain))
  const ownSite = added.flatMap((domain) => {
    const projectDomain = competitorDomainProjectClaim(domain, opts.project.domains)
    return projectDomain ? [{ domain, projectDomain }] : []
  })
  if (ownSite.length > 0) throw ownSiteCompetitorError(ownSite)

  const entryFor = (domain: string, write: CompetitorWrite | undefined, storedAliases: readonly string[], isNew: boolean): CompetitorAliasPlanEntry => {
    if (!write || write.aliases === undefined) return { domain, aliases: storedAliases, explicit: false, added: isNew }
    const aliases = write.aliasMode === 'add' ? [...storedAliases, ...write.aliases] : write.aliases
    return { domain, aliases, explicit: true, added: isNew }
  }
  const entries = [
    ...retained.map(row => entryFor(row.domain, writeFor(row), row.aliases, false)),
    ...added.map(domain => entryFor(domain, writeByDomain.get(domain), [], true)),
  ]
  const plan = requireCompetitorAliasPlan(entries, opts.project)

  const aliasChanges: CompetitorAliasChange[] = []
  for (const competitor of plan.competitors) {
    const before = storedByDomain.get(competitor.domain)?.aliases ?? []
    if (!sameAliases(before, competitor.aliases)) {
      aliasChanges.push({ domain: competitor.domain, before: [...before], after: competitor.aliases })
    }
  }
  return {
    final: plan.competitors,
    added,
    removed,
    aliasChanges,
    droppedAliases: plan.dropped,
  }
}

/**
 * Write a plan made against `stored` (read in the same transaction). New rows
 * take `provenance` (default `cli`, the value every REST and apply write has
 * always stored).
 */
export function applyCompetitorSetPlan(
  tx: Pick<DatabaseClient, 'insert' | 'update' | 'delete'>,
  projectId: string,
  stored: readonly StoredCompetitor[],
  plan: CompetitorSetPlan,
  now: string,
  provenance = 'cli',
): void {
  for (const row of plan.removed) {
    tx.delete(competitors).where(eq(competitors.id, row.id)).run()
  }
  const storedByDomain = new Map(stored.map(row => [row.domain, row]))
  const aliasesByDomain = new Map(plan.final.map(competitor => [competitor.domain, competitor.aliases]))
  for (const change of plan.aliasChanges) {
    const row = storedByDomain.get(change.domain)
    if (row) tx.update(competitors).set({ aliases: change.after }).where(eq(competitors.id, row.id)).run()
  }
  for (const domain of plan.added) {
    tx.insert(competitors).values({
      id: crypto.randomUUID(),
      projectId,
      domain,
      aliases: aliasesByDomain.get(domain) ?? [],
      provenance,
      createdAt: now,
    }).onConflictDoNothing({
      target: [competitors.projectId, competitors.domain],
    }).run()
  }
}

/**
 * The new domains a domain-only add of `domains` would be refused for, each
 * with its rejections: a domain whose name overlaps another competitor's
 * stored alias ('claimed-by-alias'). Discovery promote leaves those out and
 * reports them instead of failing every other promoted row.
 */
export function claimedCompetitorAdds(
  stored: readonly StoredCompetitor[],
  domains: readonly string[],
  project: CompetitorAliasProjectIdentity,
): Map<string, CompetitorAliasRejection[]> {
  const storedKeys = new Set(stored.map(row => normalizeCompetitorDomain(row.domain)))
  const added = normalizeCompetitorList(domains).filter(domain => !storedKeys.has(domain))
  const plan = planCompetitorAliases([
    ...stored.map(row => ({ domain: row.domain, aliases: row.aliases, explicit: false })),
    ...added.map(domain => ({ domain, aliases: [], explicit: false, added: true })),
  ], project)
  const claimed = new Map<string, CompetitorAliasRejection[]>()
  for (const rejection of plan.rejected) {
    claimed.set(rejection.domain, [...(claimed.get(rejection.domain) ?? []), rejection])
  }
  return claimed
}

/** Read, plan and write in one call, inside the caller's transaction. */
export function syncCompetitorSet(
  tx: Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>,
  projectId: string,
  writes: readonly CompetitorWrite[],
  opts: CompetitorSetPlanOptions & { now: string; provenance?: string },
): CompetitorSetPlan {
  const stored = readStoredCompetitors(tx, projectId)
  const plan = planCompetitorSet(stored, writes, opts)
  applyCompetitorSetPlan(tx, projectId, stored, plan, opts.now, opts.provenance)
  return plan
}

/**
 * The names a competitor set answers to, as a Simple run freezes them (domain
 * label plus curated aliases). Qualified own-brand aliases must not collide
 * with any of them.
 */
export function competitorNames(rows: readonly { domain: string; aliases?: readonly string[] | null }[]): string[] {
  return rows.flatMap(row => [competitorLabelFromDomain(row.domain), ...normalizeCompetitorAliases(row.aliases)])
}

/** Audit-diff fields for alias activity; empty when nothing alias-related happened. */
export function competitorAliasAuditFields(plan: Pick<CompetitorSetPlan, 'aliasChanges' | 'droppedAliases'>): Record<string, unknown> {
  return {
    ...(plan.aliasChanges.length ? { aliasChanges: plan.aliasChanges } : {}),
    ...(plan.droppedAliases.length ? { droppedCompetitorAliases: plan.droppedAliases } : {}),
  }
}

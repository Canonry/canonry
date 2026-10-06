import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { competitors, type DatabaseClient } from '@ainyc/canonry-db'
import {
  competitorEntryParts,
  competitorLabelFromDomain,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  requireCompetitorAliasPlan,
  type CompetitorAliasPlanEntry,
  type CompetitorAliasRejection,
  type CompetitorEntry,
} from '@ainyc/canonry-contracts'

/**
 * The one write path for the `competitors` table's domain set and curated
 * aliases. REST (`PUT`/`POST /competitors`, the alias route), config-as-code
 * apply, and a project identity change all plan through `planCompetitorSet`, so
 * the same alias rules hold whichever surface wrote last, and a domain-only
 * write never wipes stored aliases.
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
 * Normalize request or config entries into writes: registrable domains,
 * first-seen order, duplicates merged (their stated aliases concatenated).
 */
export function competitorWritesFromEntries(
  entries: readonly CompetitorEntry[],
  aliasMode: 'set' | 'add' = 'set',
): CompetitorWrite[] {
  const byDomain = new Map<string, CompetitorWrite>()
  for (const entry of entries) {
    const parts = competitorEntryParts(entry)
    const trimmed = parts.domain.trim()
    if (!trimmed) continue
    const domain = normalizeCompetitorDomain(trimmed)
    if (!domain) continue
    const existing = byDomain.get(domain)
    if (!existing) {
      byDomain.set(domain, { domain, aliasMode, ...(parts.aliases !== undefined ? { aliases: [...parts.aliases] } : {}) })
      continue
    }
    if (parts.aliases !== undefined) {
      existing.aliases = [...(existing.aliases ?? []), ...parts.aliases]
    }
  }
  return [...byDomain.values()]
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

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((alias, i) => alias === b[i])
}

/**
 * Plan a write against the stored competitors. `replace` makes `writes` the
 * whole domain set (rows not named are removed); otherwise writes merge into
 * the stored set. Retained rows keep their id, provenance and aliases unless a
 * write states aliases. Throws a validation error when a stated alias fails the
 * shared rules (`requireCompetitorAliasPlan`); an alias carried over unchanged
 * that no longer qualifies is dropped and reported instead.
 */
export function planCompetitorSet(
  stored: readonly StoredCompetitor[],
  writes: readonly CompetitorWrite[],
  opts: { replace: boolean; projectBrandNames: readonly string[] },
): CompetitorSetPlan {
  const writeByDomain = new Map(writes.map(write => [write.domain, write]))
  const storedByDomain = new Map(stored.map(row => [row.domain, row]))
  const removed = opts.replace ? stored.filter(row => !writeByDomain.has(row.domain)) : []
  const retained = stored.filter(row => !opts.replace || writeByDomain.has(row.domain))
  const added = writes.filter(write => !storedByDomain.has(write.domain)).map(write => write.domain)

  const entryFor = (domain: string, storedAliases: readonly string[]): CompetitorAliasPlanEntry => {
    const write = writeByDomain.get(domain)
    if (!write || write.aliases === undefined) return { domain, aliases: storedAliases, explicit: false }
    const aliases = write.aliasMode === 'add' ? [...storedAliases, ...write.aliases] : write.aliases
    return { domain, aliases, explicit: true }
  }
  const entries = [
    ...retained.map(row => entryFor(row.domain, row.aliases)),
    ...added.map(domain => entryFor(domain, [])),
  ]
  const plan = requireCompetitorAliasPlan(entries, opts.projectBrandNames)

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

/** Write a plan made against `stored` (read in the same transaction). */
export function applyCompetitorSetPlan(
  tx: Pick<DatabaseClient, 'insert' | 'update' | 'delete'>,
  projectId: string,
  stored: readonly StoredCompetitor[],
  plan: CompetitorSetPlan,
  now: string,
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
      provenance: 'cli',
      createdAt: now,
    }).onConflictDoNothing({
      target: [competitors.projectId, competitors.domain],
    }).run()
  }
}

/** Read, plan and write in one call, inside the caller's transaction. */
export function syncCompetitorSet(
  tx: Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>,
  projectId: string,
  writes: readonly CompetitorWrite[],
  opts: { replace: boolean; projectBrandNames: readonly string[]; now: string },
): CompetitorSetPlan {
  const stored = readStoredCompetitors(tx, projectId)
  const plan = planCompetitorSet(stored, writes, opts)
  applyCompetitorSetPlan(tx, projectId, stored, plan, opts.now)
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

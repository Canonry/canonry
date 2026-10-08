import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { marketCompetitorNames, projects, type DatabaseClient } from '@ainyc/canonry-db'
import {
  competitorAliasProjectIdentity,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  planCompetitorAutoAliases,
  type CompetitorAutoAlias,
  type CompetitorDto,
} from '@ainyc/canonry-contracts'
import { readStoredCompetitors, type StoredCompetitor } from './competitor-writes.js'
import { activePlanMarketPins, readMarketCompetitorPins } from './plan-competitors.js'

/**
 * NAMES LEARNED FOR A COMPETITOR ONLY AN ADVANCED MARKET MEASURES.
 *
 * An Advanced plan can pin a competitor in one market (a group) without the
 * project tracking it: no `competitors` row, and the pin scores only the
 * answers to that market's questions (`createRunCompetitorResolver`). Its
 * plan label and aliases are its curated names. Answer-derived detection
 * learns more names for it from that market's answers only, and they are
 * stored here (`market_competitor_names`), never as a project competitor, so
 * the competitor never starts counting in other markets.
 *
 * Published plan revisions are immutable, so the learned names are not
 * written into the plan. Every reader that scores a market answer against
 * live identity layers them onto the pin at read time
 * (`readMarketCompetitorNames`): the stored per-snapshot competitor fields
 * (sweeps and their recomputes) and the Advanced competitor landscape. A new
 * pin of the domain in a draft takes them like a tracked competitor's names.
 * The frozen measurement reports keep reading each revision's own names, as
 * they do for a tracked competitor's later names.
 *
 * Which competitors: every domain the ACTIVE revision pins that is not a
 * project competitor (compared by registrable domain). Names stored for a
 * domain the active revision no longer pins are kept: they still apply to the
 * runs whose own revision pins it (the resolver adds them only where a run's
 * revision pins the domain), so publishing a revision that drops a pin never
 * rewrites the history of the runs that measured it, and a new pin of the
 * domain takes them again.
 *
 * One identity for every competitor: every market pin the curated alias
 * rules take (`readMarketCompetitorPins`: the active revision, the pending
 * draft, whose pins the landscape counts too, and every superseded revision
 * whose answers are scored with it) claims its names against every learned
 * name of another domain, as curated aliases do, so a learned name never
 * overlaps a name a pin answers to. A pin write can therefore drop or release
 * a learned name; the pin writers compare the answer identity around the
 * write and ask for the stored-column recompute when it moved
 * (`src/market-pin-writes.ts`).
 */
export interface MarketCompetitor {
  /** `normalizeCompetitorDomain` (registrable) form. */
  domain: string
  /** Its plan labels and aliases (its curated names). */
  names: string[]
  /** The active revision's groups that pin it. */
  marketKeys: string[]
  /** Its stored names, or null before any were stored. */
  stored: typeof marketCompetitorNames.$inferSelect | null
}

type Reader = Pick<DatabaseClient, 'select'>
type StoredMarketNames = typeof marketCompetitorNames.$inferSelect


function readStoredMarketNames(db: Reader, projectId: string): StoredMarketNames[] {
  return db.select().from(marketCompetitorNames).where(eq(marketCompetitorNames.projectId, projectId)).all()
}

/**
 * The competitors the active plan pins that are not project competitors
 * (compared by registrable domain), ordered by domain, with their stored
 * names. `tracked` is the project's competitors and `stored` its stored
 * market names, when the caller already read them.
 */
export function readMarketCompetitors(
  db: Reader,
  projectId: string,
  tracked?: readonly StoredCompetitor[],
  stored?: readonly StoredMarketNames[],
): MarketCompetitor[] {
  const pins = activePlanMarketPins(db, projectId)
  if (pins.length === 0) return []
  const projectDomains = new Set((tracked ?? readStoredCompetitors(db, projectId)).map(row => normalizeCompetitorDomain(row.domain)))
  const marketOnly = pins.filter(pin => !projectDomains.has(pin.domain))
  if (marketOnly.length === 0) return []
  const storedByDomain = new Map((stored ?? readStoredMarketNames(db, projectId)).map(row => [row.domain, row]))
  return marketOnly.map(pin => ({ ...pin, stored: storedByDomain.get(pin.domain) ?? null }))
}

/**
 * Learned names every reader layers onto a market-only pin, by registrable
 * domain: its stored names minus blocked ones, after the shared identity
 * rules run again against the CURRENT curated identity
 * (`planCompetitorAutoAliases`: a project name, a project competitor's
 * curated alias or kept auto name, or a name of any market pin of another
 * domain, `readMarketCompetitorPins`, wins), so a curated or plan edit made
 * after detection never leaves two identities claiming one name.
 *
 * Covers every untracked domain with stored names, including one the active
 * revision no longer pins (its names apply only where a run's own revision
 * pins it). Such a domain has no current plan names and comes after the
 * pinned ones, so a pinned competitor keeps a stored name the two share.
 * Empty when the project has no stored market names (the plan is not read).
 */
export function readMarketCompetitorNames(db: Reader, projectId: string): Map<string, string[]> {
  const storedRows = readStoredMarketNames(db, projectId)
  if (!storedRows.some(row => row.autoAliases.length > 0)) return new Map()
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return new Map()
  const tracked = readStoredCompetitors(db, projectId)
  const market = readMarketCompetitors(db, projectId, tracked, storedRows)
  const trackedDomains = new Set(tracked.map(row => normalizeCompetitorDomain(row.domain)))
  const pinnedDomains = new Set(market.map(entry => entry.domain))
  const learned = [
    ...market.map(entry => ({ domain: entry.domain, names: entry.names, stored: entry.stored })),
    ...storedRows
      .filter(row => row.autoAliases.length > 0 && !trackedDomains.has(row.domain) && !pinnedDomains.has(row.domain))
      .sort((left, right) => left.domain.localeCompare(right.domain))
      .map(row => ({ domain: row.domain, names: [] as string[], stored: row })),
  ]
  if (learned.every(entry => !entry.stored || entry.stored.autoAliases.length === 0)) return new Map()
  const plan = planCompetitorAutoAliases([
    ...tracked.map(row => ({
      domain: row.domain,
      aliases: row.aliases,
      autoAliases: row.autoAliases.map(record => record.name),
      blockedAliases: row.blockedAliases,
    })),
    ...learned.map(entry => ({
      domain: entry.domain,
      aliases: entry.names,
      autoAliases: (entry.stored?.autoAliases ?? []).map(record => record.name),
      blockedAliases: entry.stored?.blockedAliases ?? [],
    })),
  ], competitorAliasProjectIdentity(project), readMarketCompetitorPins(db, projectId))
  const names = new Map<string, string[]>()
  learned.forEach((entry, index) => {
    const kept = plan.competitors[tracked.length + index]!.autoAliases
    if (kept.length > 0) names.set(entry.domain, kept)
  })
  return names
}

/** Store a market competitor's names (insert on first write). */
export function writeMarketCompetitorNames(
  tx: Pick<DatabaseClient, 'insert' | 'update'>,
  projectId: string,
  entry: MarketCompetitor,
  names: { autoAliases?: CompetitorAutoAlias[]; blockedAliases?: string[] },
  now: string,
): typeof marketCompetitorNames.$inferSelect {
  if (entry.stored) {
    const next = {
      ...entry.stored,
      ...(names.autoAliases ? { autoAliases: names.autoAliases } : {}),
      ...(names.blockedAliases ? { blockedAliases: names.blockedAliases } : {}),
      updatedAt: now,
    }
    tx.update(marketCompetitorNames)
      .set({ autoAliases: next.autoAliases, blockedAliases: next.blockedAliases, updatedAt: now })
      .where(eq(marketCompetitorNames.id, entry.stored.id))
      .run()
    return next
  }
  const row = {
    id: crypto.randomUUID(),
    projectId,
    domain: entry.domain,
    autoAliases: names.autoAliases ?? [],
    blockedAliases: names.blockedAliases ?? [],
    createdAt: now,
    updatedAt: now,
  }
  tx.insert(marketCompetitorNames).values(row).run()
  return row
}

/**
 * A market competitor as the competitor DTO the block routes return. Before
 * any names are stored for it, `id` is `market:<domain>` and `createdAt` is
 * `now`.
 */
export function marketCompetitorDto(
  entry: MarketCompetitor,
  stored: typeof marketCompetitorNames.$inferSelect | null,
  now: string,
): CompetitorDto {
  return {
    id: stored?.id ?? `market:${entry.domain}`,
    domain: entry.domain,
    aliases: normalizeCompetitorAliases(entry.names),
    autoAliases: stored?.autoAliases ?? [],
    blockedAliases: stored?.blockedAliases ?? [],
    marketKeys: entry.marketKeys,
    createdAt: stored?.createdAt ?? now,
  }
}

import { eq } from 'drizzle-orm'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  hostOf,
  parseStoredMeasurementPlanAnyVersion,
  registrableDomain,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, type DatabaseClient } from '@ainyc/canonry-db'

/** One competitor a plan revision names: its domain and the names it goes by. */
export interface PlanCompetitor {
  domain: string
  aliases: string[]
}

/** The domains and names a run's answers are scored against. */
export interface RunCompetitors {
  domains: string[]
  /** Domain -> operator-approved names for it (empty for list-only domains). */
  aliases: Map<string, string[]>
}

/**
 * One key per competitor. Plan domains are stored as typed, so `rival.com`,
 * `www.rival.com` and `https://rival.com/` must collapse to one entry or a
 * single citation would count as several competitors.
 */
function competitorKey(value: string): string {
  const host = hostOf(value) ?? value.trim().toLowerCase()
  return registrableDomain(host) ?? host
}

/**
 * Competitors a published plan revision names: v2 groups carry them with their
 * names, v1 groups as bare hosts. A plan run is measured against its own
 * revision, so these count when its answers are scored, alongside the
 * project's competitor list. Empty for no revision or an unreadable one.
 */
export function measurementPlanCompetitors(db: DatabaseClient, versionId: string | null | undefined): PlanCompetitor[] {
  if (!versionId) return []
  const row = db.select({ canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()
  if (!row) return []
  let raw: Array<{ domain: string; names: string[] }>
  try {
    const plan = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
    raw = plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION
      ? plan.groups.flatMap(group => group.competitors.map(competitor => ({ domain: competitor.domain, names: [competitor.label, ...competitor.aliases] })))
      : plan.groups.flatMap(group => (group.competitors ?? []).map(domain => ({ domain, names: [] })))
  } catch {
    return []
  }
  const merged = new Map<string, Set<string>>()
  for (const { domain, names } of raw) {
    const key = competitorKey(domain)
    if (!key) continue
    const set = merged.get(key) ?? new Set<string>()
    for (const name of names) if (name.trim()) set.add(name.trim())
    merged.set(key, set)
  }
  return [...merged].sort(([left], [right]) => left.localeCompare(right)).map(([domain, names]) => ({ domain, aliases: [...names] }))
}

export function measurementPlanCompetitorDomains(db: DatabaseClient, versionId: string | null | undefined): string[] {
  return measurementPlanCompetitors(db, versionId).map(competitor => competitor.domain)
}

/**
 * What a run's answers are scored against: the project's competitor list plus,
 * for a plan run, its revision's competitors and their names. Cached per
 * revision, since a backfill scores many runs of the same few revisions.
 */
export function createRunCompetitorResolver(db: DatabaseClient, projectCompetitorDomains: readonly string[]) {
  const byVersion = new Map<string, RunCompetitors>()
  const listOnly = (): RunCompetitors => ({ domains: [...new Set(projectCompetitorDomains)], aliases: new Map() })
  return (versionId: string | null | undefined): RunCompetitors => {
    if (!versionId) return listOnly()
    const cached = byVersion.get(versionId)
    if (cached) return cached
    const domains = new Map<string, string>()
    for (const domain of projectCompetitorDomains) domains.set(competitorKey(domain), domain)
    const aliases = new Map<string, string[]>()
    for (const competitor of measurementPlanCompetitors(db, versionId)) {
      const domain = domains.get(competitor.domain) ?? competitor.domain
      domains.set(competitor.domain, domain)
      if (competitor.aliases.length) aliases.set(domain, competitor.aliases)
    }
    const resolved = { domains: [...new Set(domains.values())], aliases }
    byVersion.set(versionId, resolved)
    return resolved
  }
}

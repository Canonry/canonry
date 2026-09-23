import { eq } from 'drizzle-orm'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  hostOf,
  parseStoredMeasurementPlanAnyVersion,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, type DatabaseClient } from '@ainyc/canonry-db'

/** One competitor a plan revision names: its host and the names it goes by. */
export interface PlanCompetitor {
  domain: string
  aliases: string[]
}

/** The domains and names one answer is scored against. */
export interface RunCompetitors {
  domains: string[]
  /** Domain -> operator-approved names for it (empty for list-only domains). */
  aliases: Map<string, string[]>
}

/**
 * One key per spelling of the same host. A plan stores domains as typed, so
 * `rival.com`, `www.rival.com` and `https://rival.com/` collapse to one entry.
 * Distinct hosts stay distinct: `offers.rival.com` is not `rival.com`, and a
 * single-label host is kept as it is rather than dropped.
 */
function competitorKey(value: string): string {
  const host = (hostOf(value) ?? value).trim().toLowerCase().replace(/\.$/, '')
  return host.startsWith('www.') ? host.slice(4) : host
}

interface PlanCompetitorScope {
  /** Every competitor the revision names. */
  all: PlanCompetitor[]
  /**
   * Execution node -> the competitors of the groups whose properties use it.
   * The same rule the measurement report applies, so a competitor pinned in
   * one market never scores an answer to another market's question.
   */
  byNode: Map<string, PlanCompetitor[]>
}

function merge(into: Map<string, Set<string>>, domain: string, names: readonly string[]): void {
  const key = competitorKey(domain)
  if (!key) return
  const set = into.get(key) ?? new Set<string>()
  for (const name of names) if (name.trim()) set.add(name.trim())
  into.set(key, set)
}

function toList(merged: Map<string, Set<string>>): PlanCompetitor[] {
  return [...merged].sort(([left], [right]) => left.localeCompare(right)).map(([domain, names]) => ({ domain, aliases: [...names] }))
}

function readScope(db: DatabaseClient, versionId: string): PlanCompetitorScope | null {
  const row = db.select({ canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()
  if (!row) return null
  let groups: Array<{ targetKeys: readonly string[]; competitors: Array<{ domain: string; names: string[] }> }>
  let edges: Array<{ executionNodeKey: string; targetKey: string }>
  try {
    const plan = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
    if (plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
      groups = plan.groups.map(group => ({
        targetKeys: group.targetKeys,
        competitors: group.competitors.map(competitor => ({ domain: competitor.domain, names: [competitor.label, ...competitor.aliases] })),
      }))
      edges = plan.usageEdges
    } else {
      groups = plan.groups.map(group => ({
        targetKeys: group.targetKeys,
        competitors: (group.competitors ?? []).map(domain => ({ domain, names: [] })),
      }))
      edges = plan.usageEdges.flatMap(edge => edge.kind === 'target' ? [edge] : [])
    }
  } catch {
    return null
  }

  const all = new Map<string, Set<string>>()
  const groupsByTarget = new Map<string, number[]>()
  groups.forEach((group, index) => {
    for (const competitor of group.competitors) merge(all, competitor.domain, competitor.names)
    for (const target of group.targetKeys) groupsByTarget.set(target, [...(groupsByTarget.get(target) ?? []), index])
  })
  const nodeGroups = new Map<string, Set<number>>()
  for (const edge of edges) {
    const set = nodeGroups.get(edge.executionNodeKey) ?? new Set<number>()
    for (const index of groupsByTarget.get(edge.targetKey) ?? []) set.add(index)
    nodeGroups.set(edge.executionNodeKey, set)
  }
  const byNode = new Map<string, PlanCompetitor[]>()
  for (const [node, indexes] of nodeGroups) {
    const merged = new Map<string, Set<string>>()
    for (const index of indexes) for (const competitor of groups[index]!.competitors) merge(merged, competitor.domain, competitor.names)
    byNode.set(node, toList(merged))
  }
  return { all: toList(all), byNode }
}

/**
 * Every competitor a published plan revision names: v2 groups carry them with
 * their names, v1 groups as bare hosts. Empty for no revision or an unreadable
 * one. Scoring an answer uses the per-question scope instead; see
 * `createRunCompetitorResolver`.
 */
export function measurementPlanCompetitors(db: DatabaseClient, versionId: string | null | undefined): PlanCompetitor[] {
  if (!versionId) return []
  return readScope(db, versionId)?.all ?? []
}

export function measurementPlanCompetitorDomains(db: DatabaseClient, versionId: string | null | undefined): string[] {
  return measurementPlanCompetitors(db, versionId).map(competitor => competitor.domain)
}

/**
 * What one answer is scored against: the project's competitor list plus, for a
 * plan run, the competitors of the groups whose properties use that answer's
 * question. The project list applies to every answer, as it always has; plan
 * pins stay inside their own markets. A planless run, or an answer with no
 * execution id, gets exactly the project list. The revision is read once per
 * resolver, since a backfill scores many answers of the same few revisions.
 */
export function createRunCompetitorResolver(db: DatabaseClient, projectCompetitorDomains: readonly string[]) {
  const scopes = new Map<string, PlanCompetitorScope | null>()
  const listOnly = (): RunCompetitors => ({ domains: [...new Set(projectCompetitorDomains)], aliases: new Map() })
  return (versionId: string | null | undefined, executionId: string | null | undefined): RunCompetitors => {
    if (!versionId || !executionId) return listOnly()
    if (!scopes.has(versionId)) scopes.set(versionId, readScope(db, versionId))
    const pinned = scopes.get(versionId)?.byNode.get(executionId) ?? []
    if (pinned.length === 0) return listOnly()
    // The project's own spelling wins when both name the same host.
    const byKey = new Map<string, string>()
    for (const domain of projectCompetitorDomains) if (!byKey.has(competitorKey(domain))) byKey.set(competitorKey(domain), domain)
    const aliases = new Map<string, string[]>()
    for (const competitor of pinned) {
      const domain = byKey.get(competitor.domain) ?? competitor.domain
      byKey.set(competitor.domain, domain)
      if (competitor.aliases.length) aliases.set(domain, competitor.aliases)
    }
    return { domains: [...new Set([...projectCompetitorDomains, ...byKey.values()])], aliases }
  }
}

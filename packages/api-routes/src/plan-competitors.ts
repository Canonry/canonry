import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunKinds,
  brandKeyFromText,
  hostMatchesDomain,
  hostOf,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  parseStoredMeasurementPlanAnyVersion,
  type CompetitorAliasMarketPin,
  type CompetitorIdentityInput,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { activePlanVersionRow, draftRow, parseStoredAuthoring } from './measurement-draft-repo.js'

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
 *
 * Project competitors carry their operator-curated aliases (`{ domain,
 * aliases }`; a bare string is a domain with none), so planless answers and
 * plan answers alike are scored against the curated names. A plan pin on a
 * project competitor's host, or under it (`shop.rival.example` for
 * `rival.example`), is that competitor, as the landscape merges them: its
 * names are added to the project competitor's and it is not listed apart, so
 * one answer never counts for both. Every citation of the pin's host still
 * counts, since it falls under the project competitor's host. A pin on a
 * parent or sibling host stays apart: a citation of `rival.example` is not one
 * of `offers.rival.example`.
 */
export function createRunCompetitorResolver(
  db: DatabaseClient,
  projectCompetitors: readonly (string | CompetitorIdentityInput)[],
) {
  const scopes = new Map<string, PlanCompetitorScope | null>()
  const project = projectCompetitors.map(entry => typeof entry === 'string'
    ? { domain: entry, aliases: [] as string[] }
    : { domain: entry.domain, aliases: normalizeCompetitorAliases(entry.aliases) })
  const projectDomains = [...new Set(project.map(entry => entry.domain))]
  const projectAliases = (): Map<string, string[]> => {
    const aliases = new Map<string, string[]>()
    for (const entry of project) {
      if (entry.aliases.length === 0) continue
      aliases.set(entry.domain, normalizeCompetitorAliases([...(aliases.get(entry.domain) ?? []), ...entry.aliases]))
    }
    return aliases
  }
  const listOnly = (): RunCompetitors => ({ domains: [...projectDomains], aliases: projectAliases() })
  // The most specific project competitor whose host the pin's host is, or is under.
  const coveringProjectDomain = (pinHost: string): string | undefined => projectDomains
    .filter(domain => hostMatchesDomain(pinHost, domain))
    .sort((left, right) => competitorKey(right).length - competitorKey(left).length)[0]
  return (versionId: string | null | undefined, executionId: string | null | undefined): RunCompetitors => {
    if (!versionId || !executionId) return listOnly()
    if (!scopes.has(versionId)) scopes.set(versionId, readScope(db, versionId))
    const pinned = scopes.get(versionId)?.byNode.get(executionId) ?? []
    if (pinned.length === 0) return listOnly()
    // The project's own spelling wins when both name the same host.
    const byKey = new Map<string, string>()
    for (const domain of projectDomains) if (!byKey.has(competitorKey(domain))) byKey.set(competitorKey(domain), domain)
    const aliases = projectAliases()
    for (const competitor of pinned) {
      const domain = byKey.get(competitor.domain) ?? coveringProjectDomain(competitor.domain) ?? competitor.domain
      byKey.set(competitor.domain, domain)
      if (competitor.aliases.length) {
        aliases.set(domain, normalizeCompetitorAliases([...(aliases.get(domain) ?? []), ...competitor.aliases]))
      }
    }
    return { domains: [...new Set([...projectDomains, ...byKey.values()])], aliases }
  }
}

/** A market as a pin reader sees it: its key and the competitors it pins. */
export interface MarketPinGroup {
  stableKey: string
  /** v2 and draft groups carry `{ domain, label, aliases }`; a v1 group bare hosts. */
  competitors?: ReadonlyArray<string | { domain: string; label: string; aliases: readonly string[] }>
}

/**
 * The competitors `groups` pin, one per registrable domain, with every
 * market's names for it and the markets that pin it, in first-seen order.
 */
export function marketPinsFromGroups(groups: readonly MarketPinGroup[]): CompetitorAliasMarketPin[] {
  const byDomain = new Map<string, { domain: string; names: string[]; markets: string[] }>()
  for (const group of groups) {
    for (const competitor of group.competitors ?? []) {
      const pin = typeof competitor === 'string' ? { domain: competitor, label: null, aliases: [] } : competitor
      const domain = normalizeCompetitorDomain(pin.domain.trim())
      if (!domain) continue
      const merged = byDomain.get(domain) ?? { domain, names: [], markets: [] }
      merged.names = normalizeCompetitorAliases([...merged.names, ...(pin.label ? [pin.label] : []), ...pin.aliases])
      if (!merged.markets.includes(group.stableKey)) merged.markets.push(group.stableKey)
      byDomain.set(domain, merged)
    }
  }
  return [...byDomain.values()]
}

/**
 * The pins `after` touches relative to `before`, one per domain: a pin new to
 * a market carries every name it has (`marketPinsFromGroups`); a pin a market
 * already had and now pins by a name it did not (same brand key) carries just
 * those names and `renamed: true`, unless another market adds it. An unchanged
 * pin is left out, so a check over the result never blocks a write for a pin
 * or a name it did not touch.
 */
export function changedMarketPins(before: readonly MarketPinGroup[], after: readonly MarketPinGroup[]): CompetitorAliasMarketPin[] {
  const previous = new Map<string, Map<string, Set<string>>>()
  for (const group of before) {
    const byDomain = previous.get(group.stableKey) ?? new Map<string, Set<string>>()
    for (const pin of marketPinsFromGroups([group])) {
      byDomain.set(pin.domain, new Set([...(byDomain.get(pin.domain) ?? []), ...pin.names.map(brandKeyFromText)]))
    }
    previous.set(group.stableKey, byDomain)
  }
  const changed = new Map<string, { domain: string; names: string[]; markets: string[]; added: boolean }>()
  for (const group of after) {
    for (const pin of marketPinsFromGroups([group])) {
      const known = previous.get(group.stableKey)?.get(pin.domain)
      const names = known ? pin.names.filter(name => !known.has(brandKeyFromText(name))) : pin.names
      if (known && names.length === 0) continue
      const merged = changed.get(pin.domain) ?? { domain: pin.domain, names: [], markets: [], added: false }
      merged.names = normalizeCompetitorAliases([...merged.names, ...names])
      if (!merged.markets.includes(group.stableKey)) merged.markets.push(group.stableKey)
      merged.added ||= !known
      changed.set(pin.domain, merged)
    }
  }
  return [...changed.values()].map(({ added, ...pin }) => (added ? pin : { ...pin, renamed: true }))
}

/** The markets a stored revision of any schema version pins, or none when it is unreadable. */
export function storedPlanPinGroups(canonicalJson: string): MarketPinGroup[] {
  try {
    return parseStoredMeasurementPlanAnyVersion(canonicalJson).groups
  } catch {
    return []
  }
}

/**
 * Every competitor the project's Advanced markets pin: the active revision's
 * groups (v2 with their names, v1 as bare hosts) and the pending draft's
 * groups, which an Advanced read already counts, then the pins of every
 * superseded revision an answer-visibility run of the project was measured
 * under (`supersededRevisionPins`). A curated alias of a tracked competitor
 * must stay clear of all of them. An unreadable revision or draft pins nothing
 * here rather than failing a competitor write.
 */
export function readMarketCompetitorPins(db: Parameters<typeof draftRow>[0], projectId: string): CompetitorAliasMarketPin[] {
  const groups: MarketPinGroup[] = []
  let activeVersionId: string | null = null
  try {
    const active = activePlanVersionRow(db, projectId)
    if (active) {
      activeVersionId = active.id
      groups.push(...storedPlanPinGroups(active.canonicalJson))
    }
  } catch {
    // A pointer to a missing revision: no pins to check against.
  }
  const draft = draftRow(db, projectId)
  if (draft) {
    try {
      groups.push(...parseStoredAuthoring(draft.authoringJson).groups)
    } catch {
      // Unreadable draft: no pins to check against.
    }
  }
  return [...marketPinsFromGroups(groups), ...supersededRevisionPins(db, projectId, activeVersionId)]
}

/**
 * The pins of every superseded revision an answer-visibility run of the
 * project was measured under, newest revision first, each marked with its
 * `supersededRevision`. The landscape and the stored competitor columns score
 * each run against its own frozen revision (`createRunCompetitorResolver`), so
 * those runs still count those pins after a later revision drops or renames
 * them. A revision no run was measured under scores nothing and is not read.
 */
function supersededRevisionPins(
  db: Parameters<typeof draftRow>[0],
  projectId: string,
  activeVersionId: string | null,
): CompetitorAliasMarketPin[] {
  const measured = db.select({ id: runs.measurementPlanVersionId })
    .from(runs)
    .where(and(
      eq(runs.projectId, projectId),
      eq(runs.kind, RunKinds['answer-visibility']),
      isNotNull(runs.measurementPlanVersionId),
    ))
  const versions = db.select({ revision: measurementPlanVersions.revision, canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlanVersions)
    .where(and(
      eq(measurementPlanVersions.projectId, projectId),
      inArray(measurementPlanVersions.id, measured),
      ...(activeVersionId ? [ne(measurementPlanVersions.id, activeVersionId)] : []),
    ))
    .orderBy(desc(measurementPlanVersions.revision))
    .all()
  return versions.flatMap(version => marketPinsFromGroups(storedPlanPinGroups(version.canonicalJson))
    .map(pin => ({ ...pin, supersededRevision: version.revision })))
}

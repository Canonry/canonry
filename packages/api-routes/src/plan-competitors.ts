import { and, desc, eq, exists, inArray, isNotNull, ne, or } from 'drizzle-orm'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunKinds,
  RunStatuses,
  brandKeyFromText,
  hostMatchesDomain,
  hostOf,
  competitorIdentityAliases,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  parseStoredMeasurementPlanAnyVersion,
  type CompetitorAliasMarketPin,
  type CompetitorIdentityInput,
} from '@ainyc/canonry-contracts'
import { measurementPlans, measurementPlanVersions, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { draftRow, parseStoredAuthoring } from './measurement-draft-repo.js'

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

/** One competitor a plan revision pins, by registrable domain, with every market (group) that pins it. */
export interface PlanMarketPin {
  /** `normalizeCompetitorDomain` (registrable) form. */
  domain: string
  /** Its plan labels and aliases across those groups. */
  names: string[]
  /** The group keys that pin it, sorted. */
  marketKeys: string[]
}

interface PlanCompetitorScope {
  /** Every competitor the revision names. */
  all: PlanCompetitor[]
  /** Every competitor the revision names, by registrable domain, with the groups that pin it. */
  pins: PlanMarketPin[]
  /** The revision's groups as a pin reader takes them (`readMarketCompetitorPins`). */
  pinGroups: MarketPinGroup[]
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

function readScope(db: Pick<DatabaseClient, 'select'>, versionId: string): PlanCompetitorScope | null {
  const row = db.select({ canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()
  if (!row) return null
  let groups: Array<{ key: string; targetKeys: readonly string[]; competitors: Array<{ domain: string; names: string[] }> }>
  let edges: Array<{ executionNodeKey: string; targetKey: string }>
  let pinGroups: MarketPinGroup[]
  try {
    const plan = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
    pinGroups = plan.groups
    if (plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
      groups = plan.groups.map(group => ({
        key: group.stableKey,
        targetKeys: group.targetKeys,
        competitors: group.competitors.map(competitor => ({ domain: competitor.domain, names: [competitor.label, ...competitor.aliases] })),
      }))
      edges = plan.usageEdges
    } else {
      groups = plan.groups.map(group => ({
        key: group.stableKey,
        targetKeys: group.targetKeys,
        competitors: (group.competitors ?? []).map(domain => ({ domain, names: [] })),
      }))
      edges = plan.usageEdges.flatMap(edge => edge.kind === 'target' ? [edge] : [])
    }
  } catch {
    return null
  }

  const all = new Map<string, Set<string>>()
  const pins = new Map<string, { names: Set<string>; marketKeys: Set<string> }>()
  const groupsByTarget = new Map<string, number[]>()
  groups.forEach((group, index) => {
    for (const competitor of group.competitors) {
      merge(all, competitor.domain, competitor.names)
      const domain = normalizeCompetitorDomain(competitor.domain)
      if (!domain) continue
      const pin = pins.get(domain) ?? { names: new Set<string>(), marketKeys: new Set<string>() }
      for (const name of competitor.names) if (name.trim()) pin.names.add(name.trim())
      pin.marketKeys.add(group.key)
      pins.set(domain, pin)
    }
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
  return {
    all: toList(all),
    pins: [...pins].sort(([left], [right]) => left.localeCompare(right)).map(([domain, pin]) => ({
      domain,
      names: normalizeCompetitorAliases([...pin.names]),
      marketKeys: [...pin.marketKeys].sort((left, right) => left.localeCompare(right)),
    })),
    pinGroups,
    byNode,
  }
}

/**
 * Parsed scopes by database and version id. A published revision never
 * changes, so a parse is good for as long as its database is open; bounded so
 * a long-lived server holds only the revisions it reads.
 */
const scopeCaches = new WeakMap<Pick<DatabaseClient, 'select'>, Map<string, PlanCompetitorScope | null>>()
const SCOPE_CACHE_LIMIT = 64

function cachedScope(db: Pick<DatabaseClient, 'select'>, versionId: string): PlanCompetitorScope | null {
  let cache = scopeCaches.get(db)
  if (!cache) scopeCaches.set(db, cache = new Map<string, PlanCompetitorScope | null>())
  if (cache.has(versionId)) return cache.get(versionId)!
  const scope = readScope(db, versionId)
  // A version id that reads nothing may be written later (a test, a
  // publish in flight): only a parsed revision is kept.
  if (scope) cache.set(versionId, scope)
  while (cache.size > SCOPE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return scope
}

/**
 * Every competitor the project's ACTIVE plan revision pins, by registrable
 * domain, with its plan names and the markets (group keys) that pin it.
 * Empty without an active plan.
 */
export function activePlanMarketPins(db: Pick<DatabaseClient, 'select'>, projectId: string): PlanMarketPin[] {
  const pointer = db.select({ activeVersionId: measurementPlans.activeVersionId })
    .from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  if (!pointer) return []
  return cachedScope(db, pointer.activeVersionId)?.pins ?? []
}

/**
 * The registrable domains one plan revision pins for one question
 * (`executionId`): the competitors of the groups whose properties use it, the
 * scope `createRunCompetitorResolver` scores the answer against. Empty for a
 * planless answer.
 */
export function createPlanPinLookup(db: Pick<DatabaseClient, 'select'>): (versionId: string | null | undefined, executionId: string | null | undefined) => string[] {
  return (versionId, executionId) => {
    if (!versionId || !executionId) return []
    const pinned = cachedScope(db, versionId)?.byNode.get(executionId) ?? []
    return [...new Set(pinned.map(competitor => normalizeCompetitorDomain(competitor.domain)).filter(Boolean))]
  }
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
 * Project competitors carry their curated and auto-detected aliases
 * (`{ domain, aliases, autoAliases, blockedAliases }`, merged by
 * `competitorIdentityAliases`; a bare string is a domain with none), so
 * planless answers and plan answers alike are scored against those names. A
 * plan pin on a project competitor's host, or under it (`shop.rival.example`
 * for `rival.example`), is that competitor, as the landscape merges them: its
 * names are added to the project competitor's and it is not listed apart, so
 * one answer never counts for both. Every citation of the pin's host still
 * counts, since it falls under the project competitor's host. A pin on a
 * parent or sibling host stays apart: a citation of `rival.example` is not one
 * of `offers.rival.example`. Only a project competitor stored as a subdomain
 * meets that case, and only an older discovery promote stored one (every write
 * now stores the registrable domain): such a row and the pin share a domain
 * label, so an answer naming it credits both in the stored overlap, while the
 * landscape, which merges by registrable domain, counts one row. Removing and
 * re-adding the competitor (restating its aliases) stores the registrable
 * domain and ends the split.
 */
export function createRunCompetitorResolver(
  db: DatabaseClient,
  projectCompetitors: readonly (string | CompetitorIdentityInput)[],
  /**
   * Names learned for competitors the active plan pins without tracking them
   * project-wide, by registrable domain (`readMarketCompetitorNames`). Added
   * to a pin only where a plan pins it, so they stay inside its markets.
   */
  marketNames: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  const scopes = new Map<string, PlanCompetitorScope | null>()
  const project = projectCompetitors.map(entry => typeof entry === 'string'
    ? { domain: entry, aliases: [] as string[] }
    : { domain: entry.domain, aliases: competitorIdentityAliases(entry) })
  const projectDomains = [...new Set(project.map(entry => entry.domain))]
  const projectRegistrable = new Set(projectDomains.map(domain => normalizeCompetitorDomain(domain)))
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
    if (!scopes.has(versionId)) scopes.set(versionId, cachedScope(db, versionId))
    const pinned = scopes.get(versionId)?.byNode.get(executionId) ?? []
    if (pinned.length === 0) return listOnly()
    // The project's own spelling wins when both name the same host.
    const byKey = new Map<string, string>()
    for (const domain of projectDomains) if (!byKey.has(competitorKey(domain))) byKey.set(competitorKey(domain), domain)
    const aliases = projectAliases()
    for (const competitor of pinned) {
      const domain = byKey.get(competitor.domain) ?? coveringProjectDomain(competitor.domain) ?? competitor.domain
      byKey.set(competitor.domain, domain)
      const registrable = normalizeCompetitorDomain(competitor.domain)
      const learned = projectRegistrable.has(registrable) ? [] : marketNames.get(registrable) ?? []
      if (competitor.aliases.length || learned.length) {
        aliases.set(domain, normalizeCompetitorAliases([...(aliases.get(domain) ?? []), ...competitor.aliases, ...learned]))
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
 * superseded revision whose answers are scored with them
 * (`supersededRevisionPins`). A curated alias of a tracked competitor
 * must stay clear of all of them. An unreadable revision or draft pins nothing
 * here rather than failing a competitor write.
 */
export function readMarketCompetitorPins(db: Parameters<typeof draftRow>[0], projectId: string): CompetitorAliasMarketPin[] {
  // Published revisions are parsed once (`cachedScope`): a recompute re-reads
  // the identity, and with it these pins, before every chunk it writes.
  const pointer = db.select({ activeVersionId: measurementPlans.activeVersionId })
    .from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  const activeVersionId = pointer?.activeVersionId ?? null
  const groups: MarketPinGroup[] = activeVersionId ? [...(cachedScope(db, activeVersionId)?.pinGroups ?? [])] : []
  groups.push(...draftPinGroups(db, projectId))
  return [...marketPinsFromGroups(groups), ...supersededRevisionPins(db, projectId, activeVersionId)]
}

/**
 * Parsed draft groups by database and project, reused while the stored
 * authoring JSON is the same text (a draft changes in place, so its id is no
 * key); bounded like the revision cache.
 */
const draftPinCaches = new WeakMap<Pick<DatabaseClient, 'select'>, Map<string, { json: string; groups: MarketPinGroup[] }>>()

/** The pending draft's groups, or none without a draft or for an unreadable one. */
function draftPinGroups(db: Pick<DatabaseClient, 'select'>, projectId: string): MarketPinGroup[] {
  const draft = draftRow(db, projectId)
  if (!draft) return []
  let cache = draftPinCaches.get(db)
  if (!cache) draftPinCaches.set(db, cache = new Map<string, { json: string; groups: MarketPinGroup[] }>())
  const cached = cache.get(projectId)
  if (cached?.json === draft.authoringJson) return cached.groups
  let groups: MarketPinGroup[]
  try {
    groups = parseStoredAuthoring(draft.authoringJson).groups
  } catch {
    // Unreadable draft: no pins to check against.
    groups = []
  }
  cache.delete(projectId)
  cache.set(projectId, { json: draft.authoringJson, groups })
  while (cache.size > SCOPE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return groups
}

/**
 * The pins of every superseded revision that scores answers, newest revision
 * first, each marked with its `supersededRevision`. The landscape and the
 * stored competitor columns score each run against its own frozen revision
 * (`createRunCompetitorResolver`), so those runs still count those pins after
 * a later revision drops or renames them. A revision scores answers when an
 * answer-visibility run measured under it stored at least one, or is still
 * queued or running (its answers will be scored with it). A revision no run
 * used, or whose runs all failed or were cancelled before storing an answer,
 * scores nothing and is not read, so it never blocks a write for good.
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
      or(
        inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
        exists(db.select({ id: querySnapshots.id }).from(querySnapshots).where(eq(querySnapshots.runId, runs.id))),
      ),
    ))
  const versions = db.select({ id: measurementPlanVersions.id, revision: measurementPlanVersions.revision })
    .from(measurementPlanVersions)
    .where(and(
      eq(measurementPlanVersions.projectId, projectId),
      inArray(measurementPlanVersions.id, measured),
      ...(activeVersionId ? [ne(measurementPlanVersions.id, activeVersionId)] : []),
    ))
    .orderBy(desc(measurementPlanVersions.revision))
    .all()
  return versions.flatMap(version => marketPinsFromGroups(cachedScope(db, version.id)?.pinGroups ?? [])
    .map(pin => ({ ...pin, supersededRevision: version.revision })))
}

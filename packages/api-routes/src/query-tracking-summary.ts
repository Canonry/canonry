/**
 * The numbers the query workspace prints, counted here so no client recounts
 * rows. Every count reads the tracked rows of the same response (their `focus`
 * and `queryClasses`) and the plan's frozen graph, each walked once.
 *
 * Branded and non-brand stay separate counts. A row holding both is `mixed`
 * and is counted under neither.
 */

import {
  QUERY_TRACKING_THIN_MARKET_FLOOR,
  compareText,
  expandQueryTemplate,
  measurementV2UsageEdgeKey,
  normalizeCompetitorDomain,
  normalizeIdentityText,
  queryTemplateBindings,
  queryTemplateVariableKind,
  type MeasurementPlanV2,
  type QueryClass,
  type QueryTrackingFocus,
  type QueryTrackingGroupCounts,
  type QueryTrackingLimits,
  type QueryTrackingMarketCounts,
  type QueryTrackingSummary,
  type QueryTrackingTargetCounts,
  type QueryTrackingTrackedRow,
  type QueryTrackingViews,
} from '@ainyc/canonry-contracts'

/** A tracked row as this server builds it: Subject and Type are always set. */
export type SummarizedRow = QueryTrackingTrackedRow & { focus: QueryTrackingFocus; queryClasses: QueryClass[] }

export interface PlanPlaceCounts {
  targets: ReadonlyMap<string, { marketKeys: string[]; counts: QueryTrackingTargetCounts }>
  markets: ReadonlyMap<string, { targetKeys: string[]; counts: QueryTrackingMarketCounts }>
  groups: ReadonlyMap<string, { counts: QueryTrackingGroupCounts }>
}

const CLASS_COUNT = { branded: 'branded', 'non-brand': 'nonBrand' } as const satisfies Record<QueryClass, string>

function addTo<T extends string>(map: Map<string, Set<T>>, key: string, value: T): void {
  const values = map.get(key)
  if (values) values.add(value)
  else map.set(key, new Set([value]))
}

function sorted(values: ReadonlySet<string> | undefined): string[] {
  return [...(values ?? [])].sort(compareText)
}

/** A row's Type: its distinct classes, sorted. */
export function distinctQueryClasses(classes: Iterable<QueryClass | null>): QueryClass[] {
  const distinct = new Set<QueryClass>()
  for (const queryClass of classes) {
    if (queryClass !== null) distinct.add(queryClass)
  }
  return [...distinct].sort(compareText)
}

type ClassCounts = QueryTrackingSummary['byClass']

function noClassCounts(): ClassCounts {
  return { branded: 0, nonBrand: 0, mixed: 0, unknown: 0 }
}

/** One query's distinct classes: a single class counts under it, both under `mixed`, none under `unknown`. */
function countClasses(counts: ClassCounts, classes: readonly QueryClass[]): void {
  if (classes.length === 0) counts.unknown += 1
  else if (classes.length === 1) counts[CLASS_COUNT[classes[0]!]] += 1
  else counts.mixed += 1
}

/**
 * `left` is the room under the limit and `over` the excess above it, neither
 * below zero. `exceeded` is the one limit rule, which a commit's refusal reads
 * too: a plan already over the limit may still shrink, but no change may grow
 * it past the limit.
 */
export function queryLimitCounts(current: number, next: number, max: number): QueryTrackingLimits {
  return {
    queries: {
      current,
      next,
      max,
      left: { current: Math.max(0, max - current), next: Math.max(0, max - next) },
      over: { current: Math.max(0, current - max), next: Math.max(0, next - max) },
      exceeded: next > max && next > current,
    },
  }
}

/**
 * `asked` counts the listed rows with a pairing, so it never disagrees with
 * them. For a plan the compiler published that is the plan's distinct assigned
 * queries (the limit's `current`). `workload` is the same map a preview diffs,
 * so `answersPerSweep` equals a no-op preview's `existingProviderCalls`.
 */
export function trackingSummary(
  tracked: readonly SummarizedRow[],
  plan: MeasurementPlanV2 | null,
  workload: ReadonlyMap<string, number>,
): QueryTrackingSummary {
  const byClass = noClassCounts()
  const byFocus = { market: 0, property: 0, company: 0, custom: 0 }
  let asked = 0
  for (const row of tracked) {
    const focus = row.focus
    if (focus.kind === 'not-asked') continue
    asked += 1
    byFocus[focus.kind] += 1
    countClasses(byClass, row.queryClasses)
  }

  // A published class is never null, so `unknown` stays zero for a plan.
  const assignments = { total: 0, branded: 0, nonBrand: 0, unknown: 0 }
  for (const assignment of plan?.assignments ?? []) {
    assignments.total += 1
    assignments[CLASS_COUNT[assignment.queryClass]] += 1
  }

  let answersPerSweep = 0
  for (const calls of workload.values()) answersPerSweep += calls

  const groups = plan?.groups ?? []
  const competitors = new Set<string>()
  for (const group of groups) {
    for (const competitor of group.competitors) competitors.add(normalizeCompetitorDomain(competitor.domain))
  }
  return {
    asked,
    notAsked: tracked.length - asked,
    byClass,
    byFocus,
    assignments,
    answersPerSweep,
    structure: {
      targets: plan?.targets.length ?? 0,
      markets: plan?.reportingScopes?.length ?? 0,
      groups: groups.length,
      topLevelGroups: groups.filter(group => group.parentGroupKey === undefined).length,
      competitors: competitors.size,
    },
  }
}

/**
 * Each location's, market's and group's own numbers. `answersPerSweep` adds
 * `expectedSnapshots` over the distinct executions a place has a usage edge
 * on: an execution two places share counts once in each, so places do not add
 * up to the project total.
 *
 * `queries` counts the tracked rows with a pairing at the place, and `byClass`
 * reads the Type of those pairings from every plan assignment there: a row's
 * `assignments[].queryClass` keeps one class per location, so it would miss a
 * query asked under both types at two search locations.
 */
export function planPlaceCounts(plan: MeasurementPlanV2, tracked: readonly SummarizedRow[]): PlanPlaceCounts {
  const groupsByTarget = new Map<string, Set<string>>()
  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) addTo(groupsByTarget, targetKey, group.stableKey)
  }

  const targetNodes = new Map<string, Set<string>>()
  const groupNodes = new Map<string, Set<string>>()
  for (const edge of plan.usageEdges) {
    addTo(targetNodes, edge.targetKey, edge.executionNodeKey)
    for (const groupKey of groupsByTarget.get(edge.targetKey) ?? []) addTo(groupNodes, groupKey, edge.executionNodeKey)
  }
  const marketNodes = new Map<string, Set<string>>()
  const marketTargets = new Map<string, Set<string>>()
  const targetMarkets = new Map<string, Set<string>>()
  const edgeMarkets = new Map<string, Set<string>>()
  for (const scope of plan.reportingScopes ?? []) {
    for (const edge of scope.usageEdges) {
      addTo(marketNodes, scope.stableKey, edge.executionNodeKey)
      addTo(marketTargets, scope.stableKey, edge.targetKey)
      addTo(targetMarkets, edge.targetKey, scope.stableKey)
      addTo(edgeMarkets, measurementV2UsageEdgeKey(edge), scope.stableKey)
    }
  }

  const calls = new Map(plan.executionNodes.map(node => [node.stableKey, node.expectedSnapshots]))
  const answers = (nodeKeys: ReadonlySet<string> | undefined): number => {
    let total = 0
    for (const nodeKey of nodeKeys ?? []) total += calls.get(nodeKey) ?? 0
    return total
  }

  const targets = new Map(plan.targets.map(target => [target.stableKey, {
    marketKeys: sorted(targetMarkets.get(target.stableKey)),
    counts: {
      queries: 0, byClass: noClassCounts(),
      propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: answers(targetNodes.get(target.stableKey)),
    },
  }]))
  const markets = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, {
    targetKeys: sorted(marketTargets.get(scope.stableKey)),
    counts: {
      queries: 0, byClass: noClassCounts(),
      marketQueries: 0, propertyQueries: 0, answersPerSweep: answers(marketNodes.get(scope.stableKey)),
    },
  }]))
  // A group's markets are the ones its locations are in, the same rule as a location's `marketKeys`.
  const marketsHolding = (targetKeys: readonly string[]): number => {
    const held = new Set<string>()
    for (const targetKey of targetKeys) {
      for (const marketKey of targetMarkets.get(targetKey) ?? []) held.add(marketKey)
    }
    return held.size
  }
  const groups = new Map(plan.groups.map(group => [group.stableKey, {
    counts: {
      queries: 0, byClass: noClassCounts(), marketQueries: 0, propertyQueries: 0, customQueries: 0,
      markets: marketsHolding(group.targetKeys), answersPerSweep: answers(groupNodes.get(group.stableKey)),
    },
  }]))

  const countQuery = (counts: { queries: number; byClass: ClassCounts } | undefined, classes: ReadonlySet<QueryClass>): void => {
    if (!counts) return
    counts.queries += 1
    countClasses(counts.byClass, [...classes])
  }
  // Same population as the tracked row: an assignment without its execution node is skipped.
  const pairings = new Map<string, MeasurementPlanV2['assignments']>()
  for (const assignment of plan.assignments) {
    if (!calls.has(assignment.executionNodeKey)) continue
    const paired = pairings.get(assignment.queryId)
    if (paired) paired.push(assignment)
    else pairings.set(assignment.queryId, [assignment])
  }

  for (const row of tracked) {
    const focus = row.focus
    switch (focus.kind) {
      case 'property': {
        const target = targets.get(focus.key)
        if (target) target.counts.propertyQueries += 1
        break
      }
      case 'market': {
        const market = markets.get(focus.key)
        if (market) market.counts.marketQueries += 1
        break
      }
      case 'custom':
        for (const assignment of row.assignments) {
          const target = targets.get(assignment.targetKey)
          if (target) target.counts.customQueries += 1
        }
        break
      case 'company':
      case 'not-asked':
        // A simple site's row and an unpaired row belong to no place.
        break
    }
    // The row's classes at each place it is paired with: a pairing counts for its
    // location, that location's groups, and the markets holding its exact edge.
    const atTargets = new Map<string, Set<QueryClass>>()
    const atMarkets = new Map<string, Set<QueryClass>>()
    const atGroups = new Map<string, Set<QueryClass>>()
    for (const pairing of pairings.get(row.queryId) ?? []) {
      addTo(atTargets, pairing.targetKey, pairing.queryClass)
      for (const groupKey of groupsByTarget.get(pairing.targetKey) ?? []) addTo(atGroups, groupKey, pairing.queryClass)
      for (const marketKey of edgeMarkets.get(measurementV2UsageEdgeKey(pairing)) ?? []) addTo(atMarkets, marketKey, pairing.queryClass)
    }
    for (const [targetKey, classes] of atTargets) countQuery(targets.get(targetKey)?.counts, classes)
    for (const [marketKey, classes] of atMarkets) countQuery(markets.get(marketKey)?.counts, classes)
    for (const [groupKey, classes] of atGroups) {
      const counts = groups.get(groupKey)?.counts
      if (!counts) continue
      countQuery(counts, classes)
      if (focus.kind === 'market') counts.marketQueries += 1
      else if (focus.kind === 'property') counts.propertyQueries += 1
      else if (focus.kind === 'custom') counts.customQueries += 1
    }
  }

  // A market query covers every location the market holds, and a location query sits in each of its markets.
  for (const market of markets.values()) {
    for (const targetKey of market.targetKeys) {
      const target = targets.get(targetKey)
      if (!target) continue
      target.counts.marketQueries += market.counts.marketQueries
      market.counts.propertyQueries += target.counts.propertyQueries
    }
  }
  return { targets, markets, groups }
}

/** A saved pattern as it stands now, by id. A row keeps the text it was expanded from. */
export type SavedPatterns = ReadonlyMap<string, { name: string; pattern: string; variables: readonly string[] }>

/**
 * Only a pattern whose one variable is the market makes a market's own query:
 * one per market, asked for its locations. Either market name counts
 * (`{market}` or `{submarket}`). A pattern with no variable makes one query for
 * every place, and one with a location name a query per location.
 */
function fillsMarket(variables: readonly string[]): boolean {
  return variables.length === 1 && queryTemplateVariableKind(variables[0]!) === 'market'
}

/**
 * The workspace's views, read off the place counts and the tracked rows in
 * one pass each. A market asks a pattern when a row whose Subject is the
 * market froze the pattern's record or has the text the pattern makes for the
 * market's label: a row added in setup or by hand froze no record, and adding
 * the pattern where its text is already asked keeps that row as it is.
 */
export function trackingViews(
  plan: MeasurementPlanV2,
  tracked: readonly SummarizedRow[],
  places: PlanPlaceCounts,
  savedPatterns: SavedPatterns,
): QueryTrackingViews {
  // A published plan lists its locations and markets in key order, so each list below is built sorted.
  const targetKeys: string[] = []
  for (const [targetKey, target] of places.targets) {
    if (target.counts.propertyQueries === 0) targetKeys.push(targetKey)
  }
  const thinMarketKeys: string[] = []
  // A market with no location takes no addition, so no pattern is missing from it.
  const openMarketKeys: string[] = []
  for (const [marketKey, market] of places.markets) {
    if (market.counts.marketQueries < QUERY_TRACKING_THIN_MARKET_FLOOR) thinMarketKeys.push(marketKey)
    if (market.targetKeys.length > 0) openMarketKeys.push(marketKey)
  }

  // Per pattern: every wording it has had (the saved one and those its rows froze),
  // the newest frozen one, and the markets with a row that froze it.
  const patterns = new Map<string, { wordings: Set<string>; version: string; frozen: string; marketKeys: Set<string> }>()
  for (const [templateId, saved] of savedPatterns) {
    if (fillsMarket(saved.variables)) patterns.set(templateId, { wordings: new Set([saved.pattern]), version: '', frozen: '', marketKeys: new Set() })
  }
  const marketTexts = new Map<string, Set<string>>()
  for (const row of tracked) {
    if (row.focus.kind !== 'market') continue
    addTo(marketTexts, row.focus.key, row.normalizedText)
    const template = row.provenance?.template
    if (template === undefined || !fillsMarket(Object.keys(template.bindings))) continue
    let pattern = patterns.get(template.templateId)
    if (!pattern) {
      // Saved with another variable since, so it no longer makes a market's own query.
      if (savedPatterns.has(template.templateId)) continue
      pattern = { wordings: new Set(), version: '', frozen: '', marketKeys: new Set() }
      patterns.set(template.templateId, pattern)
    }
    pattern.marketKeys.add(row.focus.key)
    pattern.wordings.add(template.template)
    // The version is the pattern's save time, so the greater one is the newer text.
    if (compareText(template.templateVersion, pattern.version) > 0) {
      pattern.version = template.templateVersion
      pattern.frozen = template.template
    }
  }

  const labels = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, scope.label]))
  const gaps: QueryTrackingViews['patternGaps']['patterns'] = []
  for (const [templateId, pattern] of patterns) {
    const usedMarketKeys: string[] = []
    const missingMarketKeys: string[] = []
    for (const marketKey of openMarketKeys) {
      const texts = marketTexts.get(marketKey)
      // Every market name is bound, so a wording reads the same under the name it was written with.
      const market = queryTemplateBindings('market', labels.get(marketKey)!)
      const asked = pattern.marketKeys.has(marketKey) || (texts !== undefined
        && [...pattern.wordings].some(wording => texts.has(normalizeIdentityText(expandQueryTemplate(wording, market)))))
      if (asked) usedMarketKeys.push(marketKey)
      else missingMarketKeys.push(marketKey)
    }
    if (usedMarketKeys.length === 0 || missingMarketKeys.length === 0) continue
    const saved = savedPatterns.get(templateId)
    gaps.push({ templateId, name: saved?.name ?? null, pattern: saved?.pattern ?? pattern.frozen, usedMarketKeys, missingMarketKeys })
  }
  gaps.sort((left, right) => compareText(left.templateId, right.templateId))

  return {
    noPropertyQueries: { count: targetKeys.length, targetKeys },
    thinMarkets: { count: thinMarketKeys.length, floor: QUERY_TRACKING_THIN_MARKET_FLOOR, marketKeys: thinMarketKeys },
    patternGaps: { count: gaps.length, compared: patterns.size, patterns: gaps },
  }
}

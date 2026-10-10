/**
 * The numbers the query workspace prints, counted here so no client recounts
 * rows. Every count reads the tracked rows of the same response (their `focus`
 * and `queryClasses`) and the plan's frozen graph, each walked once.
 *
 * Branded and non-brand stay separate counts. A row holding both is `mixed`
 * and is counted under neither.
 */

import {
  compareText,
  normalizeCompetitorDomain,
  type MeasurementPlanV2,
  type QueryClass,
  type QueryTrackingFocus,
  type QueryTrackingGroupCounts,
  type QueryTrackingLimits,
  type QueryTrackingMarketCounts,
  type QueryTrackingSummary,
  type QueryTrackingTargetCounts,
  type QueryTrackingTrackedRow,
} from '@ainyc/canonry-contracts'

/** A tracked row as this server builds it: Subject and Type are always set. */
export type SummarizedRow = QueryTrackingTrackedRow & { focus: QueryTrackingFocus; queryClasses: QueryClass[] }

export interface PlanPlaceCounts {
  targets: ReadonlyMap<string, { marketKeys: string[]; counts: QueryTrackingTargetCounts }>
  markets: ReadonlyMap<string, { targetKeys: string[]; counts: QueryTrackingMarketCounts }>
  groups: ReadonlyMap<string, { counts: QueryTrackingGroupCounts }>
}

const CLASS_COUNT = { branded: 'branded', 'non-brand': 'nonBrand' } as const satisfies Record<QueryClass, string>

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
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

/** `left` is the room under the limit, never below zero for a plan already over it. */
export function queryLimitCounts(current: number, next: number, max: number): QueryTrackingLimits {
  return {
    queries: {
      current,
      next,
      max,
      left: { current: Math.max(0, max - current), next: Math.max(0, max - next) },
    },
  }
}

/**
 * `asked` counts rows with a pairing, which is the plan's distinct assigned
 * queries (the limit's `current`). `workload` is the same map a preview diffs,
 * so `answersPerSweep` equals a no-op preview's `existingProviderCalls`.
 */
export function trackingSummary(
  tracked: readonly SummarizedRow[],
  plan: MeasurementPlanV2 | null,
  workload: ReadonlyMap<string, number>,
): QueryTrackingSummary {
  const byClass = { branded: 0, nonBrand: 0, mixed: 0, unknown: 0 }
  const byFocus = { market: 0, property: 0, company: 0, custom: 0 }
  let asked = 0
  for (const row of tracked) {
    const focus = row.focus
    if (focus.kind === 'not-asked') continue
    asked += 1
    byFocus[focus.kind] += 1
    const classes = row.queryClasses
    if (classes.length === 0) byClass.unknown += 1
    else if (classes.length === 1) byClass[CLASS_COUNT[classes[0]!]] += 1
    else byClass.mixed += 1
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
  const groupMarkets = new Map<string, number>()
  for (const scope of plan.reportingScopes ?? []) {
    if (scope.groupKey !== undefined) groupMarkets.set(scope.groupKey, (groupMarkets.get(scope.groupKey) ?? 0) + 1)
    for (const edge of scope.usageEdges) {
      addTo(marketNodes, scope.stableKey, edge.executionNodeKey)
      addTo(marketTargets, scope.stableKey, edge.targetKey)
      addTo(targetMarkets, edge.targetKey, scope.stableKey)
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
    counts: { propertyQueries: 0, marketQueries: 0, customQueries: 0, answersPerSweep: answers(targetNodes.get(target.stableKey)) },
  }]))
  const markets = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, {
    targetKeys: sorted(marketTargets.get(scope.stableKey)),
    counts: { marketQueries: 0, propertyQueries: 0, answersPerSweep: answers(marketNodes.get(scope.stableKey)) },
  }]))
  const groups = new Map(plan.groups.map(group => [group.stableKey, {
    counts: { queries: 0, markets: groupMarkets.get(group.stableKey) ?? 0, answersPerSweep: answers(groupNodes.get(group.stableKey)) },
  }]))

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
    const rowGroups = new Set<string>()
    for (const assignment of row.assignments) {
      for (const groupKey of groupsByTarget.get(assignment.targetKey) ?? []) rowGroups.add(groupKey)
    }
    for (const groupKey of rowGroups) {
      const group = groups.get(groupKey)
      if (group) group.counts.queries += 1
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

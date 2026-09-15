/**
 * Server-built measurement scope choices.
 *
 * Every read that offers a scope over a schema-v2 plan uses this one builder,
 * so each Group's and market's distinct Property count is computed once on the
 * server and never re-derived by a client.
 */

import type { MeasurementPlanV2, VisibilityReportScopeOption } from '@ainyc/canonry-contracts'

export interface PlanScopeOptionsSettings {
  /**
   * `true` adds each Group's and Property's explicit market links
   * (`marketKeys`), for reads that intersect a scope with a market. `false`
   * omits them, for reads with no market intersection, such as query tracking.
   * A market keeps its explicit Group parent either way.
   */
  marketLinks: boolean
}

/** Sorted distinct market links, or nothing when links are off or empty. */
function marketLinks(keys: readonly string[] | undefined, settings: PlanScopeOptionsSettings): { marketKeys?: string[] } {
  if (!settings.marketLinks) return {}
  const marketKeys = [...new Set(keys ?? [])].sort()
  return marketKeys.length === 0 ? {} : { marketKeys }
}

/**
 * Project, Group, market, and Property choices for one plan, in plan order.
 * `targetCount` counts distinct Properties: a market with several edges to one
 * Property counts that Property once.
 */
export function planScopeOptions(plan: MeasurementPlanV2, settings: PlanScopeOptionsSettings): VisibilityReportScopeOption[] {
  const groupKeysForTarget = new Map(plan.targets.map(target => [target.stableKey, [] as string[]]))
  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) groupKeysForTarget.get(targetKey)?.push(group.stableKey)
  }
  const marketKeysForGroup = new Map<string, string[]>()
  const marketKeysForTarget = new Map(plan.targets.map(target => [target.stableKey, [] as string[]]))
  for (const market of plan.reportingScopes ?? []) {
    if (market.groupKey !== undefined) {
      const keys = marketKeysForGroup.get(market.groupKey) ?? []
      keys.push(market.stableKey)
      marketKeysForGroup.set(market.groupKey, keys)
    }
    for (const edge of market.usageEdges) marketKeysForTarget.get(edge.targetKey)?.push(market.stableKey)
  }
  return [
    { id: 'project', label: 'Project', kind: 'project', targetCount: plan.targets.length },
    ...plan.groups.map(group => ({
      id: group.stableKey,
      label: group.label,
      kind: 'group' as const,
      targetCount: group.targetKeys.length,
      ...(group.parentGroupKey === undefined ? {} : { parentGroupIds: [group.parentGroupKey] }),
      ...marketLinks(marketKeysForGroup.get(group.stableKey), settings),
    })),
    ...(plan.reportingScopes ?? []).map(market => ({
      id: market.stableKey,
      label: market.label,
      kind: 'market' as const,
      targetCount: new Set(market.usageEdges.map(edge => edge.targetKey)).size,
      ...(market.groupKey === undefined ? {} : { parentGroupIds: [market.groupKey] }),
    })),
    ...plan.targets.map(target => ({
      id: target.stableKey,
      label: target.label,
      kind: 'property' as const,
      targetCount: 1,
      parentGroupIds: [...new Set(groupKeysForTarget.get(target.stableKey) ?? [])].sort(),
      ...marketLinks(marketKeysForTarget.get(target.stableKey), settings),
    })),
  ]
}

/** A Simple project's only scope: the project itself, measured as one identity. */
export function simpleScopeOptions(): VisibilityReportScopeOption[] {
  return [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }]
}

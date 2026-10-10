/**
 * A tracked question's Subject (wire name `focus`), derived from the plan's
 * structure when the workspace is read. Nothing stores it, so a published
 * revision's bytes, checksum and continuity never depend on this rule.
 *
 * Pairings are a question's (query, location) assignments. One rule decides:
 * - Location (`property`): exactly one location, and the question sits in every
 *   market that location belongs to (none counts).
 * - Market: the question sits in exactly one market and covers all of its
 *   locations, with no pairing outside it.
 * - Both hold only for a market of one location. Type breaks that tie alone:
 *   a question Branded at every assignment is the Location, otherwise the Market.
 * - Not asked: no pairings. Custom: anything else.
 */

import type { MeasurementPlanV2, QueryTrackingFocus } from '@ainyc/canonry-contracts'

function pairingKey(queryId: string, targetKey: string): string {
  return `${queryId}\u0000${targetKey}`
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key)
  if (values) values.add(value)
  else map.set(key, new Set([value]))
}

/** Build the plan's lookups once; the returned function answers per query. */
export function planQueryFocus(plan: MeasurementPlanV2): (queryId: string) => QueryTrackingFocus {
  const pairingMarkets = new Map<string, Set<string>>()
  const locationMarkets = new Map<string, Set<string>>()
  const marketLocations = new Map<string, Set<string>>()
  for (const scope of plan.reportingScopes ?? []) {
    for (const edge of scope.usageEdges) {
      addTo(pairingMarkets, pairingKey(edge.queryId, edge.targetKey), scope.stableKey)
      addTo(locationMarkets, edge.targetKey, scope.stableKey)
      addTo(marketLocations, scope.stableKey, edge.targetKey)
    }
  }

  // Same population as the tracked row: an assignment without its execution node is skipped.
  const nodeKeys = new Set(plan.executionNodes.map(node => node.stableKey))
  const pairings = new Map<string, Map<string, boolean>>()
  for (const assignment of plan.assignments) {
    if (!nodeKeys.has(assignment.executionNodeKey)) continue
    const locations = pairings.get(assignment.queryId) ?? new Map<string, boolean>()
    const branded = assignment.queryClass === 'branded'
    locations.set(assignment.targetKey, (locations.get(assignment.targetKey) ?? true) && branded)
    pairings.set(assignment.queryId, locations)
  }

  return queryId => {
    const locations = pairings.get(queryId)
    if (!locations || locations.size === 0) return { kind: 'not-asked' }
    const marketsOf = (targetKey: string) => pairingMarkets.get(pairingKey(queryId, targetKey)) ?? new Set<string>()
    const markets = new Set([...locations.keys()].flatMap(targetKey => [...marketsOf(targetKey)]))

    let location: string | null = null
    if (locations.size === 1) {
      const [targetKey] = locations.keys()
      const home = locationMarkets.get(targetKey!) ?? new Set<string>()
      if ([...home].every(marketKey => markets.has(marketKey))) location = targetKey!
    }

    let market: string | null = null
    if (markets.size === 1) {
      const [marketKey] = markets
      const members = marketLocations.get(marketKey!)!
      if (locations.size === members.size && [...locations.keys()].every(targetKey => marketsOf(targetKey).has(marketKey!))) {
        market = marketKey!
      }
    }

    if (location !== null && market !== null) {
      return locations.get(location) ? { kind: 'property', key: location } : { kind: 'market', key: market }
    }
    if (location !== null) return { kind: 'property', key: location }
    if (market !== null) return { kind: 'market', key: market }
    return { kind: 'custom' }
  }
}

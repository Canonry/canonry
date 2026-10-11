import { normalizeCompetitorDomain } from '@ainyc/canonry-contracts'
import type { MeasurementPlanResponse, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-api-client'

import { matcherLabel } from '../advanced-measurement/v2-overview-adapter.js'

/** The workspace read's lists: every count shown is one of their fields, or the length of one of their lists. */
export type StructureWorkspace = Pick<QueryTrackingWorkspaceResponse, 'targets' | 'markets' | 'groups'>

type PlanV2 = Extract<NonNullable<MeasurementPlanResponse['active']>['plan'], { schemaVersion: 2 }>
/** What the published plan adds to the workspace read: each location's names and site pages, each group's competitors. */
export type StructurePlan = Pick<PlanV2, 'targets' | 'groups'>

/** A table row: `key` is its stable key and `search` the text the search box matches. */
export interface StructureRow {
  key: string
  search: string
}

// A value the server left out, or that the other read does not hold, is `undefined` and prints nothing. It is never worked out here.
export interface StructureLocation extends StructureRow {
  label: string
  /** Names of the markets that hold it. */
  markets: string[] | undefined
  sitePages: string[] | undefined
  names: number | undefined
  locationQueries: number | undefined
  marketQueries: number | undefined
}

export interface StructureMarket extends StructureRow {
  label: string
  /** Names of the locations it holds. */
  members: string[] | undefined
  group: string | undefined
  locations: number | undefined
  marketQueries: number | undefined
}

export interface StructureGroup extends StructureRow {
  label: string
  parent: string | undefined
  locations: number
  markets: number | undefined
  competitors: number | undefined
}

export interface StructureCompetitor extends StructureRow {
  domain: string
  /** Names of the groups that list it. */
  groups: string[]
}

export interface ProjectStructure {
  locations: StructureLocation[]
  markets: StructureMarket[]
  groups: StructureGroup[]
  competitors: StructureCompetitor[]
}

const searchText = (...parts: (string | readonly string[] | undefined)[]) => parts.flat().filter(Boolean).join(' ')

/**
 * The four Settings tables, joined from the workspace read and the published
 * plan by stable key. Nothing is counted here beyond the length of a list one
 * of the reads returned, so a table cannot disagree with the server. Rows keep
 * the order the server listed them in. A competitor is one row for each domain,
 * in the form the server counts them by.
 */
export function projectStructure(workspace: StructureWorkspace, plan: StructurePlan | null): ProjectStructure {
  const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
  const marketLabels = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
  const groupLabels = new Map(workspace.groups.map(group => [group.stableKey, group.label]))
  const planTargets = new Map(plan?.targets.map(target => [target.stableKey, target]))
  const planGroups = new Map(plan?.groups.map(group => [group.stableKey, group]))
  const labels = (keys: readonly string[] | undefined, known: ReadonlyMap<string, string>) => keys?.flatMap(key => known.get(key) ?? [])

  const locations = workspace.targets.map((target): StructureLocation => {
    const markets = labels(target.marketKeys, marketLabels)
    const planned = planTargets.get(target.stableKey)
    return {
      key: target.stableKey,
      label: target.label,
      markets,
      sitePages: planned?.urlMatchers.map(matcherLabel),
      names: planned?.aliases.length,
      locationQueries: target.counts?.propertyQueries,
      marketQueries: target.counts?.marketQueries,
      search: searchText(target.label, markets),
    }
  })

  const markets = workspace.markets.map((market): StructureMarket => {
    const members = labels(market.targetKeys, targetLabels)
    const group = market.groupKey === undefined ? undefined : groupLabels.get(market.groupKey)
    return {
      key: market.stableKey,
      label: market.label,
      members,
      group,
      locations: market.targetKeys?.length,
      marketQueries: market.counts?.marketQueries,
      search: searchText(market.label, members, group),
    }
  })

  const groups = workspace.groups.map((group): StructureGroup => {
    const parent = group.parentGroupKey === undefined ? undefined : groupLabels.get(group.parentGroupKey)
    const competitors = planGroups.get(group.stableKey)?.competitors
    return {
      key: group.stableKey,
      label: group.label,
      parent,
      locations: group.targetKeys.length,
      markets: group.counts?.markets,
      competitors: competitors?.length,
      // A group is found by a competitor it names, as the Competitors tab prints it.
      search: searchText(group.label, parent, competitors?.map(competitor => normalizeCompetitorDomain(competitor.domain))),
    }
  })

  const byDomain = new Map<string, string[]>()
  for (const group of plan?.groups ?? []) {
    for (const competitor of group.competitors) {
      const domain = normalizeCompetitorDomain(competitor.domain)
      const listedIn = byDomain.get(domain)
      if (!listedIn) byDomain.set(domain, [group.label])
      else if (!listedIn.includes(group.label)) listedIn.push(group.label)
    }
  }
  const competitors = [...byDomain].map(([domain, listedIn]): StructureCompetitor => ({ key: domain, domain, groups: listedIn, search: searchText(domain, listedIn) }))

  return { locations, markets, groups, competitors }
}

export interface StructureSort {
  key: string
  direction: 'asc' | 'desc'
}

/** A second click on the sorted column flips it. A column of numbers starts at its largest, a column of names at A. */
export function nextStructureSort(current: StructureSort | undefined, key: string, numeric: boolean): StructureSort {
  if (current?.key !== key) return { key, direction: numeric ? 'desc' : 'asc' }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** Rows in the order of one column's values. A row with no value comes last either way. Unsorted, the rows stay as listed. */
export function sortStructureRows<T>(rows: readonly T[], value: ((row: T) => string | number | undefined) | undefined, direction: StructureSort['direction'] | undefined): readonly T[] {
  if (!value || !direction) return rows
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const a = value(left)
    const b = value(right)
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
    return (typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b))) * sign
  })
}

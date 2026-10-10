import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import type { QueriesSectionProps } from '../DiscoverySection.js'

export function assignmentMatchesSelection(
  assignment: QueryTrackingTrackedRow['assignments'][number],
  selection: NonNullable<QueriesSectionProps['selection']>,
): boolean {
  if (selection.queryClass !== 'all' && (assignment.queryClass ?? 'unknown') !== selection.queryClass) return false
  if (selection.measurementScope === 'project' || !selection.measurementScopeKey) return true
  if (selection.measurementScope === 'property') return assignment.targetKey === selection.measurementScopeKey
  if (selection.measurementScope === 'group') return assignment.groupKeys.includes(selection.measurementScopeKey)
  return assignment.marketKeys.includes(selection.measurementScopeKey)
}

export function filterTrackedRows(
  rows: readonly QueryTrackingTrackedRow[],
  selection: NonNullable<QueriesSectionProps['selection']>,
  mode: QueryTrackingWorkspaceResponse['mode'],
): QueryTrackingTrackedRow[] {
  // Simple workspaces do not store per-row class assignments. The shared
  // report URL can retain its class filter, but it cannot classify this list.
  if (mode === 'simple') return [...rows]
  return rows.filter(row => {
    // Legacy project-wide records have no assignment to inspect. They remain
    // reachable through Unclassified, rather than silently becoming non-brand.
    if (row.assignments.length === 0) {
      return selection.measurementScope === 'project' && (selection.queryClass === 'all' || selection.queryClass === 'unknown')
    }
    return row.assignments.some(assignment => assignmentMatchesSelection(assignment, selection))
  })
}

export function provenanceLabel(row: QueryTrackingTrackedRow): string {
  switch (row.provenance?.source) {
    case 'manual': return 'Manual'
    case 'template': return 'Template'
    case 'research': return 'Saved research'
    case 'discovery': return 'Discovery'
    default: return 'Legacy'
  }
}

export function assignmentScopeLabel(
  row: QueryTrackingTrackedRow,
  workspace: QueryTrackingWorkspaceResponse,
  selection?: NonNullable<QueriesSectionProps['selection']>,
): string {
  const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
  const groupLabels = new Map(workspace.groups.map(group => [group.stableKey, group.label]))
  const marketLabels = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
  const allTargetKeys = new Set(row.assignments.map(assignment => assignment.targetKey))
  if (allTargetKeys.size === 0) return 'Whole site'
  const relevantAssignments = selection
    ? row.assignments.filter(assignment => assignmentMatchesSelection(assignment, selection))
    : row.assignments
  const relevantTargetKeys = new Set(relevantAssignments.map(assignment => assignment.targetKey))

  if (selection?.measurementScope === 'group') {
    const inGroup = relevantTargetKeys.size
    const shared = Math.max(0, allTargetKeys.size - inGroup)
    return [
      `${inGroup} ${inGroup === 1 ? 'property' : 'properties'} in this group`,
      ...(shared ? [`Shared with ${shared} other ${shared === 1 ? 'property' : 'properties'}`] : []),
    ].join(' · ')
  }

  const groupKeys = new Set<string>()
  const marketKeys = new Set<string>()
  for (const assignment of relevantAssignments) {
    assignment.groupKeys.forEach(key => groupKeys.add(key))
    assignment.marketKeys.forEach(key => marketKeys.add(key))
  }
  const propertyScope = selection?.measurementScope === 'property' && allTargetKeys.has(selection.measurementScopeKey ?? '')
  const parts = propertyScope
    ? allTargetKeys.size === 1 ? ['This property only'] : ['This property', `Shared with ${allTargetKeys.size - 1} other ${allTargetKeys.size === 2 ? 'property' : 'properties'}`]
    : relevantTargetKeys.size === 1 ? [targetLabels.get([...relevantTargetKeys][0]!) ?? [...relevantTargetKeys][0]!] : [`${relevantTargetKeys.size} properties`]
  const group = groupKeys.size === 1 ? groupLabels.get([...groupKeys][0]!) ?? [...groupKeys][0]! : null
  const market = marketKeys.size === 1 ? marketLabels.get([...marketKeys][0]!) ?? [...marketKeys][0]! : null
  if (group && market && group === market) parts.push(`${group} (group and market)`)
  else {
    if (group) parts.push(`Group: ${group}`)
    else if (groupKeys.size > 1) parts.push(`${groupKeys.size} groups`)
    if (market) parts.push(`Market: ${market}`)
    else if (marketKeys.size > 1) parts.push(`${marketKeys.size} markets`)
  }
  return parts.join(' · ')
}

export function assignmentRelationships(
  row: QueryTrackingTrackedRow,
  workspace: QueryTrackingWorkspaceResponse,
  selection: NonNullable<QueriesSectionProps['selection']>,
): string[] {
  const targetLabels = new Map(workspace.targets.map(target => [target.stableKey, target.label]))
  const groupLabels = new Map(workspace.groups.map(group => [group.stableKey, group.label]))
  const marketLabels = new Map(workspace.markets.map(market => [market.stableKey, market.label]))
  const relevantAssignments = row.assignments.filter(assignment => assignmentMatchesSelection(assignment, selection))
  const relationships = relevantAssignments.map(assignment => {
    const target = targetLabels.get(assignment.targetKey) ?? assignment.targetKey ?? 'Whole site'
    const groups = selection.measurementScope === 'group' && selection.measurementScopeKey
      ? assignment.groupKeys.filter(key => key === selection.measurementScopeKey).map(key => groupLabels.get(key) ?? key)
      : assignment.groupKeys.map(key => groupLabels.get(key) ?? key)
    const markets = selection.measurementScope === 'market' && selection.measurementScopeKey
      ? assignment.marketKeys.filter(key => key === selection.measurementScopeKey).map(key => marketLabels.get(key) ?? key)
      : assignment.marketKeys.map(key => marketLabels.get(key) ?? key)
    return [
      target,
      groups.length ? `Groups: ${groups.join(', ')}` : null,
      markets.length ? `Markets: ${markets.join(', ')}` : null,
    ].filter((part): part is string => part !== null).join(' · ')
  })
  return [...new Set(relationships)].length ? [...new Set(relationships)] : ['Whole site']
}

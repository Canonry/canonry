import type { QueryTrackingTrackedRow, QueryTrackingWorkspaceResponse } from '@ainyc/canonry-contracts'

import { ToneBadge } from '../../shared/ToneBadge.js'
import type { QueriesSectionProps } from '../DiscoverySection.js'
import { assignmentRelationships, assignmentScopeLabel } from './tracked-rows.js'

export function AssignmentScopeDisclosure({
  row,
  workspace,
  selection,
}: {
  row: QueryTrackingTrackedRow
  workspace: QueryTrackingWorkspaceResponse
  selection: NonNullable<QueriesSectionProps['selection']>
}) {
  const relationships = assignmentRelationships(row, workspace, selection)
  return (
    <details className="group min-w-48">
      <summary className="cursor-pointer rounded px-1 py-1 text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">
        {assignmentScopeLabel(row, workspace, selection)}
      </summary>
      <div className="mt-2 rounded border border-default bg-surface p-2 text-xs leading-5 text-secondary">
        <p className="font-medium text-strong">Assigned relationships</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {relationships.map(relationship => <li key={relationship}>{relationship}</li>)}
        </ul>
      </div>
    </details>
  )
}

export function AssignmentClassBadge({ row }: { row: QueryTrackingTrackedRow }) {
  const classes = [...new Set(row.assignments.map(assignment => assignment.queryClass ?? 'unknown'))]
  const value = classes.join(', ')
  return <ToneBadge tone={classes.includes('unknown') ? 'caution' : 'neutral'}>{value || 'Unknown'}</ToneBadge>
}

export function MeasurementStateBadge({ row, outsidePlan = false }: { row: QueryTrackingTrackedRow; outsidePlan?: boolean }) {
  if (outsidePlan) return <ToneBadge tone="neutral">Not in current plan</ToneBadge>
  return row.state === 'tracked'
    ? <ToneBadge tone="positive">Measured</ToneBadge>
    : <ToneBadge tone="caution">Awaiting sweep</ToneBadge>
}

import type { QueryTrackingPreviewResponse, QueryTrackingTrackedRow } from '@ainyc/canonry-contracts'

export const TYPE_FOLLOWS_SUBJECT = 'A market query is Non-brand and a location query is Branded. A hand-picked query takes either.'
export type TrackingChangeLabel = 'Added' | 'Stopped' | 'Removed' | 'Reworded' | 'Already tracked' | 'Subject changed' | 'Type changed' | 'Changed'
type Preview = QueryTrackingPreviewResponse

/** Presentation of the server's exact diff. Unaltered reuse is never counted as a write. */
export function trackingReviewRows(preview: Preview, current: readonly QueryTrackingTrackedRow[] = []) {
  const before = new Map(current.map(row => [row.queryId, row]))
  const after = new Map(preview.tracked.map(row => [row.queryId, row]))
  const reworded = new Set(preview.changes?.flatMap(change => change.rewordedFrom ?? []))
  return (['added', 'reused', 'removed'] as const).flatMap(kind => preview.diff[kind].map(row => {
    const detail = preview.changes?.find(change => change.change === kind && change.queryId === row.queryId)
    const previous = before.get(row.queryId)
    const next = after.get(row.queryId)
    let label: TrackingChangeLabel
    if (detail?.rewordedFrom) label = 'Reworded'
    else if (kind === 'removed') label = after.has(row.queryId) ? 'Stopped' : 'Removed'
    else if (kind === 'added') label = 'Added'
    else if (preview.diff.noOp || detail?.altered === false) label = 'Already tracked'
    else if (detail && detail.before.targetKeys.length === 0 && detail.after.targetKeys.length > 0) label = 'Added'
    else if (previous?.focus && next?.focus && JSON.stringify(previous.focus) !== JSON.stringify(next.focus)) label = 'Subject changed'
    else if (previous && next && JSON.stringify(previous.queryClasses) !== JSON.stringify(next.queryClasses)) label = 'Type changed'
    else label = 'Changed'
    return { kind, row, detail, label, wasNotAsked: kind === 'reused' && label === 'Added', counted: !preview.diff.noOp && label !== 'Already tracked' && !(kind === 'removed' && reworded.has(row.queryId)) }
  }))
}

export function trackingChangeSummary(rows: ReturnType<typeof trackingReviewRows>, includeUnchanged = false): string {
  const counts = new Map<TrackingChangeLabel, number>()
  for (const row of rows) if (row.counted || (includeUnchanged && row.label === 'Already tracked')) counts.set(row.label, (counts.get(row.label) ?? 0) + 1)
  return [...counts].map(([label, total]) => `${total.toLocaleString('en-US')} ${label.toLowerCase()}`).join(' · ')
}

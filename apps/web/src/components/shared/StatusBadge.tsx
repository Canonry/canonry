import type { RunListItemVm } from '../../view-models.js'
import { toneFromRunStatus } from '../../lib/tone-helpers.js'
import { toTitleCase } from '../../lib/format-helpers.js'
import { ToneBadge } from './ToneBadge.js'

export function StatusBadge({ status }: { status: RunListItemVm['status'] }) {
  return <ToneBadge tone={toneFromRunStatus(status)}>{toTitleCase(status)}</ToneBadge>
}

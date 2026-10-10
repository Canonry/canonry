import type { ReactNode } from 'react'
import { Ban } from 'lucide-react'

import { useAccount } from '../../../../contexts/account-context.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import type { TrackedRowAction } from './tracked-types.js'

/** What can be done to many rows at once. Track and Remove are for rows that are not asked. */
export type TrackedBulkAction = Extract<TrackedRowAction, 'change-type' | 'stop' | 'track' | 'remove'>

const ACTION_LABEL: Record<TrackedBulkAction, string> = {
  'change-type': 'Change type',
  stop: 'Stop tracking',
  track: 'Track',
  remove: 'Remove query',
}
/** Stop tracking and Remove query take something away, so they read in the negative tone. */
const TAKES_AWAY: ReadonlySet<TrackedBulkAction> = new Set(['stop', 'remove'])
// The bar is the elevated shade a ghost button hovers to, so its buttons hover one step lighter.
const BUTTON = 'text-[13px] hover:bg-mono-800 pointer-coarse:min-h-11 max-md:min-h-11'

/**
 * The bar for the selected rows. It rides the bottom of the window, centred
 * on the page column, at every width, and comes to rest under the table at
 * the end of the page, so it never covers the last row. It clears the Aero bar,
 * which holds the bottom edge. It sticks rather than being fixed: a fixed box
 * inside a size container is placed against that container, not the window.
 *
 * It shows only the actions it is given: the caller passes those that apply
 * to every selected row, and `note` says why when there are none. One change
 * holds at most `maxRows` queries; over that the actions are off and the bar
 * says so. A view-only account is offered no action.
 */
export function TrackedBulkBar({ selectedCount, maxRows, actions, onAction, note, selectAllCount, onSelectAll, onClear }: {
  selectedCount: number
  maxRows: number
  actions: readonly TrackedBulkAction[]
  onAction: (action: TrackedBulkAction) => void
  note?: ReactNode
  /** How many rows the filters list. With `onSelectAll`, offers to select them all until they are. */
  selectAllCount?: number
  onSelectAll?: () => void
  onClear: () => void
}) {
  const { canWrite } = useAccount()
  const whole = (value: number) => value.toLocaleString('en-US')
  const overMax = selectedCount > maxRows
  return (
    <div role="region" aria-label="Selected queries" className="sticky bottom-20 z-30 mx-auto mt-3 flex w-fit max-w-full flex-wrap items-center justify-center gap-x-1 gap-y-1 rounded-lg border border-strong bg-bg-elevated px-2 py-1.5 shadow-lg">
      <p role="status" className="px-2 text-[13px] font-medium tabular-nums text-heading">{whole(selectedCount)} selected</p>
      {canWrite ? actions.map(action => (
        <Button key={action} type="button" variant="ghost" size="sm" disabled={overMax} className={`${BUTTON}${TAKES_AWAY.has(action) ? ' text-negative hover:text-negative-200' : ' text-strong'}`} onClick={() => onAction(action)}>
          {ACTION_LABEL[action]}
        </Button>
      )) : null}
      {overMax ? <span className="px-2"><StatusNote icon={Ban} tone="negative" label={`Max ${whole(maxRows)} rows`} detail={`One change holds at most ${whole(maxRows)} queries. Clear some rows to continue.`} /></span> : note ? <span className="px-2">{note}</span> : null}
      <span aria-hidden="true" className="mx-1 h-5 w-px bg-mono-700 max-md:hidden" />
      {onSelectAll && selectAllCount !== undefined && selectAllCount > selectedCount ? (
        <Button type="button" variant="ghost" size="sm" className={BUTTON} onClick={onSelectAll}>Select all {whole(selectAllCount)}</Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" className={BUTTON} onClick={onClear}>Clear</Button>
    </div>
  )
}

import { useEffect, useRef, type ReactNode } from 'react'
import { Check, Circle, CircleAlert, Contrast } from 'lucide-react'
import { SetupTrackStates, type SetupTrackState } from '@canonry/canonry-contracts'

import { ToneBadge } from '../shared/ToneBadge.js'

type Tone = 'neutral' | 'positive' | 'caution' | 'negative'

/**
 * One name and tone per track state. The state is the latest non-probe run's
 * status as the server reports it, plus "not started"; setup adds no states of
 * its own, so "Optional" and "Skipped" never appear.
 */
const TRACK_BADGES: Readonly<Record<SetupTrackState, { label: string; tone: Tone }>> = {
  [SetupTrackStates.not_started]: { label: 'Not started', tone: 'neutral' },
  [SetupTrackStates.queued]: { label: 'Queued', tone: 'neutral' },
  [SetupTrackStates.running]: { label: 'Running', tone: 'neutral' },
  [SetupTrackStates.completed]: { label: 'Complete', tone: 'positive' },
  [SetupTrackStates.partial]: { label: 'Partial results', tone: 'caution' },
  [SetupTrackStates.failed]: { label: 'Failed', tone: 'negative' },
  [SetupTrackStates.cancelled]: { label: 'Cancelled', tone: 'neutral' },
}

export function SetupTrackBadge({ state }: { state: SetupTrackState }) {
  const badge = TRACK_BADGES[state]
  return <ToneBadge tone={badge.tone} className="shrink-0">{badge.label}</ToneBadge>
}

/** Done, in progress, needs attention, or not started. The badge carries the state in words. */
export type SetupRowMark = 'done' | 'active' | 'attention' | 'idle'

export function setupRowMark(state: SetupTrackState): SetupRowMark {
  switch (state) {
    case SetupTrackStates.completed:
    case SetupTrackStates.partial:
      return 'done'
    case SetupTrackStates.queued:
    case SetupTrackStates.running:
      return 'active'
    case SetupTrackStates.failed:
      return 'attention'
    case SetupTrackStates.not_started:
    case SetupTrackStates.cancelled:
      return 'idle'
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

function RowGlyph({ mark }: { mark: SetupRowMark }) {
  switch (mark) {
    case 'done':
      return <Check className="size-[18px] text-positive" strokeWidth={2.5} />
    case 'active':
      return <Contrast className="size-[18px] text-heading" />
    case 'attention':
      return <CircleAlert className="size-[18px] text-negative" />
    case 'idle':
      return <Circle className="size-[18px] text-secondary" />
    default: {
      const exhaustive: never = mark
      return exhaustive
    }
  }
}

/**
 * The setup tracker: every part of a project's setup as one list, in a fixed
 * order, so the same row is always in the same place. One material; rows are
 * divided, never nested cards.
 */
export function SetupTrackerList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="material-base mt-6" aria-label={label}>
      <ol className="m-0 list-none p-0">{children}</ol>
    </section>
  )
}

/**
 * One row. `trailing` holds the state badge (or the Website row's Edit link);
 * `children` holds what the row shows below its summary (progress, a result, a
 * form); `action` holds the row's one action, right-aligned, full width on a
 * phone.
 */
export function SetupTrackerRow({
  id,
  title,
  mark,
  summary,
  trailing,
  action,
  children,
  childrenManageFocus = false,
}: {
  id?: string
  title: string
  mark: SetupRowMark
  summary?: ReactNode
  trailing?: ReactNode
  action?: ReactNode
  children?: ReactNode
  /** The children move focus themselves (the AI Visibility panel), so the row leaves it alone. */
  childrenManageFocus?: boolean
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  /** The element in this row that last had focus, while focus is in the row. */
  const lastFocused = useRef<Element | null>(null)
  useEffect(() => {
    // The control that had focus is gone from the page: a started job replaced
    // its button with progress, or the panel inside the row closed. Focus fell
    // to the page body, so keep it in the row: on the row's action when it has
    // one, else on its title. (Focus passing between two fields is briefly on
    // the body too, but the field it left is still on the page.)
    const last = lastFocused.current
    if (childrenManageFocus || !last || last.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    // An action marked data-focus-skip (stopping a job) is never where focus lands unasked.
    const target = actionsRef.current?.querySelector<HTMLElement>('button:not([disabled]):not([data-focus-skip]), a[href]:not([data-focus-skip])') ?? titleRef.current
    target?.focus()
  })
  return (
    <li
      id={id}
      className="scroll-mt-24 border-t border-default px-4 py-4 first:border-t-0 sm:px-5"
      onFocus={(event) => { lastFocused.current = event.target }}
      onBlur={(event) => {
        // A control removed while focused sends no blur, so it stays recorded.
        if (!event.currentTarget.contains(event.relatedTarget)) lastFocused.current = null
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <RowGlyph mark={mark} />
          </span>
          <div className="min-w-0">
            <h2 ref={titleRef} tabIndex={-1} className="rounded-sm text-heading-16 text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg">{title}</h2>
            {summary ? <div className="mt-1 max-w-prose text-copy-14 text-secondary">{summary}</div> : null}
          </div>
        </div>
        {trailing}
      </div>
      {children ? <div className="mt-4 sm:pl-8">{children}</div> : null}
      {action ? <div ref={actionsRef} className="mt-4 flex flex-wrap items-center justify-end gap-2 max-sm:[&>*]:w-full">{action}</div> : null}
    </li>
  )
}

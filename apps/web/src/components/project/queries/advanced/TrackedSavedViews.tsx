import { useId } from 'react'
import type { QueryTrackingViews, QueryTrackingWeakMarkets } from '@ainyc/canonry-contracts'

import { InfoTooltip } from '../../../shared/InfoTooltip.js'

/** The views that list places or patterns in place of the queries. Each is a value of the URL's `trackedView`, named as the read names its field. */
export const TRACKED_PLACE_VIEWS = ['no-property-queries', 'thin-markets', 'pattern-gaps', 'weak-markets'] as const
export type TrackedPlaceView = (typeof TRACKED_PLACE_VIEWS)[number]
/** The two that set a filter of the query list and keep it on screen. */
export type TrackedFilterView = 'not-asked' | 'hand-picked'
export type TrackedSavedView = TrackedPlaceView | TrackedFilterView

export const TRACKED_VIEW_LABEL: Record<TrackedSavedView, string> = {
  'no-property-queries': 'Locations without queries',
  'thin-markets': 'Thin markets',
  'pattern-gaps': 'Pattern gaps',
  'weak-markets': 'Weakest markets',
  'not-asked': 'Not asked',
  'hand-picked': 'Hand-picked',
}

const whole = (value: number) => value.toLocaleString('en-US')

/** The URL's value as a view. One that names none reads as no view. */
export function trackedPlaceView(value: string | undefined): TrackedPlaceView | undefined {
  return TRACKED_PLACE_VIEWS.find(view => view === value)
}

/** What a view lists, as the open view's name says it. `floor` is the server's own: a market with fewer market queries is thin. */
export function trackedViewHelp(view: TrackedPlaceView, floor: number): string {
  switch (view) {
    case 'no-property-queries': return 'Locations with no location query of their own.'
    case 'thin-markets': return `Markets with fewer than ${whole(floor)} market queries.`
    case 'pattern-gaps': return 'Saved patterns missing from some markets.'
    case 'weak-markets': return 'Markets no answer mentioned on the last sweep. Non-brand market queries only.'
  }
}

/** The same, after the view's name in the one help beside "Views". */
function shortHelp(view: TrackedPlaceView, floor: number): string {
  switch (view) {
    case 'no-property-queries': return 'no location query of their own.'
    case 'thin-markets': return `fewer than ${whole(floor)} market queries.`
    case 'pattern-gaps': return 'saved patterns missing from some markets.'
    case 'weak-markets': return 'no mention on the last sweep, non-brand market queries only.'
  }
}

const VIEW = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] transition focus-visible:border-mono-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 pointer-coarse:h-11 max-md:h-11'
const VIEW_OFF = 'border-default bg-surface/50 text-strong hover:border-strong hover:text-heading'
const VIEW_ON = 'border-mono-400 bg-surface font-medium text-heading'

/**
 * The saved views of the Tracked page: one row of rectangular buttons under
 * the number strip, each with the server's own count. Presentation only: the
 * caller holds which views are on and what choosing one does. Every count is
 * a field of a read, never a count of rows, and a view with none still opens.
 * What each view lists is one help beside "Views", so it can be read before a
 * view is opened and on a screen with no hover. The label stays put on a
 * narrow screen and the buttons scroll beside it. Weakest markets reads the
 * last sweep's non-brand results, so it names that type to a screen reader.
 * It keeps its place while those results load, so the row does not move when
 * they land, and it is not drawn where there is no sweep to read.
 */
export function TrackedSavedViews({ views, weakMarkets, notAsked, handPicked, active, onSelect }: {
  views: QueryTrackingViews
  /** The results read's field, or `pending` while that read is in flight. Left out with no sweep to read, and the view with it. */
  weakMarkets?: Pick<QueryTrackingWeakMarkets, 'count'> | 'pending'
  /** `summary.notAsked` and `summary.byFocus.custom`. A view whose number did not come shows none. */
  notAsked?: number
  handPicked?: number
  /** The views that are on: the open place view, or each filter view whose filter is set. */
  active: readonly TrackedSavedView[]
  onSelect: (view: TrackedSavedView) => void
}) {
  const labelId = useId()
  const { floor } = views.thinMarkets
  const items: { view: TrackedSavedView; count: number | 'pending' | undefined; note?: string }[] = [
    { view: 'no-property-queries', count: views.noPropertyQueries.count },
    { view: 'thin-markets', count: views.thinMarkets.count },
    { view: 'pattern-gaps', count: views.patternGaps.count },
    ...(weakMarkets ? [{ view: 'weak-markets' as const, count: weakMarkets === 'pending' ? weakMarkets : weakMarkets.count, note: 'non-brand queries' }] : []),
    { view: 'not-asked', count: notAsked },
    { view: 'hand-picked', count: handPicked },
  ]
  const help = [
    ...TRACKED_PLACE_VIEWS.filter(view => view !== 'weak-markets' || weakMarkets).map(view => `${TRACKED_VIEW_LABEL[view]}: ${shortHelp(view, floor)}`),
    'Not asked and Hand-picked filter the queries.',
  ].join(' ')

  return (
    <div className="flex items-start gap-2 border-b border-default py-2">
      {/* The help is beside the label, never inside it, so the group is named "Views" alone. As tall as a button, so it stays on the first line where they wrap. */}
      <div className="flex h-8 shrink-0 items-center pointer-coarse:h-11 max-md:h-11">
        <span id={labelId} className="text-[13px] leading-5 text-secondary">Views</span>
        <InfoTooltip text={help} placement="bottom" />
      </div>
      {/* One line that scrolls inside itself where the row is too narrow. The padding is room for a focus ring. */}
      <div role="group" aria-labelledby={labelId} className="-my-0.5 flex min-w-0 items-center gap-2 overflow-x-auto px-0.5 py-0.5 md:flex-wrap">
        {items.map(({ view, count, note }) => {
          const on = active.includes(view)
          return (
            // Named in full, since the gap before the number is only drawn: "Thin markets, 11". The type a number is of travels in the name, for a reader who hears only this button.
            <button key={view} type="button" aria-pressed={on} aria-label={[TRACKED_VIEW_LABEL[view], note, typeof count === 'number' ? whole(count) : undefined].filter(Boolean).join(', ')} className={`${VIEW} ${on ? VIEW_ON : VIEW_OFF}`} onClick={() => onSelect(view)}>
              {TRACKED_VIEW_LABEL[view]}
              {count === 'pending' ? <span aria-hidden="true" className="skeleton-text w-3" />
                : count !== undefined ? <span className="font-normal tabular-nums text-secondary">{whole(count)}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { QueryTrackingViews, QueryTrackingWeakMarkets } from '@canonry/canonry-contracts'

import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { Button } from '../../../ui/button.js'

/** The views that list places or patterns in place of the queries. Each is a value of the URL's `trackedView`. */
export const TRACKED_PLACE_VIEWS = ['no-location-queries', 'thin-markets', 'pattern-gaps', 'weak-markets'] as const
export type TrackedPlaceView = (typeof TRACKED_PLACE_VIEWS)[number]
/** The two that set a filter of the query list and keep it on screen. */
export type TrackedFilterView = 'not-asked' | 'hand-picked'
export type TrackedSavedView = TrackedPlaceView | TrackedFilterView

export const TRACKED_VIEW_LABEL: Record<TrackedSavedView, string> = {
  'no-location-queries': 'Location gaps',
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
    case 'no-location-queries': return 'Locations with no location query of their own.'
    case 'thin-markets': return `Markets with fewer than ${whole(floor)} market queries.`
    case 'pattern-gaps': return 'Saved patterns missing from some markets.'
    case 'weak-markets': return 'Markets with no mention on the last sweep. Non-brand market queries only.'
  }
}

/** The same in a few words, after the view's name in the one help beside "Views". */
function shortHelp(view: TrackedPlaceView, floor: number): string {
  switch (view) {
    case 'no-location-queries': return 'no location query.'
    case 'thin-markets': return `under ${whole(floor)} market queries.`
    case 'pattern-gaps': return 'patterns some markets lack.'
    case 'weak-markets': return 'no non-brand mention, last sweep.'
  }
}

/** Saved place views and quick filters, disclosed only when choosing one. The caller owns every selection and count. */
export function TrackedSavedViews({ views, weakMarkets, notAsked, handPicked, active, onSelect }: {
  views: QueryTrackingViews
  /** The results read's field, `pending` while that read is in flight, or `failed` when it did not load. Left out with no sweep to read, and the view with it. */
  weakMarkets?: Pick<QueryTrackingWeakMarkets, 'count'> | 'pending' | 'failed'
  /** `summary.notAsked` and `summary.byFocus.custom`. A view whose number did not come shows none. */
  notAsked?: number
  handPicked?: number
  /** The views that are on: the open place view, or each filter view whose filter is set. */
  active: readonly TrackedSavedView[]
  onSelect: (view: TrackedSavedView) => void
}) {
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const { floor } = views.thinMarkets
  const items: { view: TrackedSavedView; count: number | 'pending' | undefined; note?: string }[] = [
    { view: 'no-location-queries', count: views.noPropertyQueries.count },
    { view: 'thin-markets', count: views.thinMarkets.count },
    { view: 'pattern-gaps', count: views.patternGaps.count },
    ...(weakMarkets ? [{ view: 'weak-markets' as const, count: weakMarkets === 'pending' ? weakMarkets : weakMarkets === 'failed' ? undefined : weakMarkets.count, note: 'non-brand queries' }] : []),
    { view: 'not-asked', count: notAsked },
    { view: 'hand-picked', count: handPicked },
  ]
  const help = [
    ...TRACKED_PLACE_VIEWS.filter(view => view !== 'weak-markets' || weakMarkets).map(view => `${TRACKED_VIEW_LABEL[view]}: ${shortHelp(view, floor)}`),
    'Not asked, Hand-picked: filter the list.',
  ].join(' ')

  const activeLabels = items.filter(item => active.includes(item.view)).map(item => TRACKED_VIEW_LABEL[item.view])
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <div ref={container} className="relative inline-block min-w-0 max-w-full shrink-0" onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation()
        close()
      }
    }}>
      <Button ref={trigger} type="button" variant="outline" size="sm" className="h-8 max-w-full text-[13px] pointer-coarse:h-11 max-md:h-11" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        <span className="truncate">{activeLabels.length > 0 ? `Views · ${activeLabels.join(', ')}` : 'Views'}</span>
        <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </Button>
      <div id={panelId} hidden={!open} className="absolute right-0 top-full z-20 mt-2 max-h-[70vh] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-default bg-bg p-2 shadow-lg">
        <div className="mb-1 flex items-center text-[13px] text-secondary">
          Choose a view
          <InfoTooltip text={help} placement="bottom" align="start" />
        </div>
        <div role="group" aria-label="Views" className="grid gap-1">
          {items.map(({ view, count, note }) => {
            const pressed = active.includes(view)
            return <Button key={view} type="button" variant={pressed ? 'secondary' : 'ghost'} size="sm" aria-pressed={pressed} aria-label={[TRACKED_VIEW_LABEL[view], note, typeof count === 'number' ? whole(count) : undefined].filter(Boolean).join(', ')} className="min-w-0 justify-between gap-2 text-[13px] pointer-coarse:min-h-11 max-md:min-h-11" onClick={() => {
              onSelect(view)
              close()
            }}>
              <span className="truncate">{TRACKED_VIEW_LABEL[view]}</span>
              {count === 'pending' ? <span aria-hidden="true" className="skeleton-text w-3" />
                : count !== undefined ? <span className="tabular-nums text-secondary">{whole(count)}</span> : null}
            </Button>
          })}
        </div>
      </div>
    </div>
  )
}

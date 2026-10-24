import { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Eye } from 'lucide-react'

import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { DataTableSearch } from '../../../shared/DataTableControls.js'
import { Button } from '../../../ui/button.js'
import { activeFilterCount, clearedTrackedFilters, DEFAULT_TRACKED_FILTERS, resultForSignal, resultOptionsFor, TRACKED_FILTER_OPTIONS, type TrackedFilterOption } from './tracked-filters.js'
import type { TrackedFilters, TrackedSignal } from './tracked-types.js'

type ListFilter = 'subject' | 'type' | 'status' | 'source' | 'result' | 'engine' | 'change'

const FILTER_LABELS: readonly [ListFilter, string][] = [
  ['subject', 'Subject'],
  ['type', 'Type'],
  ['status', 'Status'],
  ['source', 'Source'],
  ['result', 'Result'],
  ['engine', 'On'],
  ['change', 'Change'],
]

// Keep the same labelled controls behind one disclosure on every screen size.
const PANEL = 'grid basis-full grid-cols-2 gap-2 md:flex md:flex-wrap'
const CONTROL = 'relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-surface/50 pl-2.5 pr-2 text-[13px] text-secondary transition hover:border-strong has-[:focus-visible]:border-mono-500 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-mono-500 pointer-coarse:h-11 max-md:h-11'
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'

/**
 * One choice as one control with its label inside: "Subject Any", "Group
 * Market". The words and the chevron are drawn; a native select lies over
 * them, unseen, so the control still opens, takes keys and reads its name and
 * value as a select does. Beside a mouse the control is as wide as its widest
 * choice, so choosing never moves the row: every choice is set under the
 * current one, unseen and as generated text, which leaves nothing in the page
 * to read or to find. In the phone panel the grid sets the width.
 */
function LabelledSelect<T extends string>({ label, value, options, active, wide = false, onChange }: {
  label: string
  value: T
  options: readonly TrackedFilterOption<T>[]
  /** Off its default, so its border says it narrows the list. */
  active: boolean
  /** Takes a row of the phone panel to itself. */
  wide?: boolean
  onChange: (value: T) => void
}) {
  return (
    <span className={`${CONTROL} ${active ? 'border-strong' : 'border-default'}${wide ? ' max-md:col-span-2' : ''}`}>
      <span aria-hidden="true" className="whitespace-nowrap">{label}</span>
      <span aria-hidden="true" className="grid min-w-0 font-medium text-heading">
        {options.map(option => <span key={option.value} data-choice={option.label} className="invisible col-start-1 row-start-1 h-0 whitespace-nowrap before:content-[attr(data-choice)] max-md:hidden" />)}
        <span className="col-start-1 row-start-1 truncate">{options.find(option => option.value === value)?.label}</span>
      </span>
      <ChevronDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted" />
      <select
        aria-label={label}
        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
        value={value}
        onChange={event => onChange(event.target.value as T)}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </span>
  )
}

/**
 * The Mentioned | Cited switch: the signal every list reads. Two pressed
 * buttons in one group, so each says its state. The strip and an opened row
 * keep both signals whichever is on.
 */
function SignalSwitch({ value, onChange }: { value: TrackedSignal; onChange: (signal: TrackedSignal) => void }) {
  return (
    <div role="group" aria-label="Signal" className="inline-flex h-8 shrink-0 items-stretch rounded-md border border-default bg-surface/50 p-0.5 pointer-coarse:h-11 max-md:h-11">
      {TRACKED_FILTER_OPTIONS.signal.map(option => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            className={`rounded px-2.5 text-[13px] leading-none transition ${on ? 'bg-surface-hover font-medium text-heading' : 'text-secondary hover:text-strong'} ${FOCUS}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** One way to list the page, as the Group control offers it. */
export type TrackedGroupingChoice = TrackedFilterOption<'market' | 'group' | 'none'>
/** One order, as the Sort control offers it. */
export type TrackedOrderChoice = TrackedFilterOption<string>

/**
 * Search, the Mentioned | Cited switch, Group, Sort, the filters, how many
 * queries they list and the legend of the chips. Presentation only: the
 * caller owns the search text, the filters (the URL), the grouping, the order
 * and every count, which are lengths of lists it holds or server fields. The
 * filters list rows and never sum anything; they wait in a closed disclosure
 * at every width, with their active count on its button, and Result offers
 * the switch's own results. A grouped list (markets) has no rows to filter,
 * so it has no filters. Clear filters sits with the count, in reach at every
 * width without opening the panel, and where it never moves a control. On a
 * phone the switch has a line of its own.
 */
export function TrackedToolbar({
  search, onSearchChange, filters, onFiltersChange, shown, total, legend, views, engines = [], groupings, grouping = 'none', onGroupingChange,
  orders, order, onOrderChange, searchLabel = 'Search queries', count: countOverride, notAsked, onShowNotAsked,
}: {
  search: string
  onSearchChange: (value: string) => void
  filters: TrackedFilters
  onFiltersChange: (filters: TrackedFilters) => void
  /** Queries listed after the search and the filters. Left out while they load. */
  shown?: number
  /**
   * Every tracked query, asked and not asked: the one number a narrowed list
   * is counted against ("92 of 970 queries"). A clean view lists the asked
   * queries only and is not narrowed, so it prints `shown` alone.
   */
  total?: number
  /** What the marks mean, such as `ChangeLegend`, and any note that belongs beside it. */
  legend?: ReactNode
  /** The computed reports, beside the filter disclosure. */
  views?: ReactNode
  /** The engines a Result or a Change can be read on. */
  engines?: readonly string[]
  /** The ways the page can list. Left out, or one alone, and there is no Group control. */
  groupings?: readonly TrackedGroupingChoice[]
  grouping?: 'market' | 'group' | 'none'
  onGroupingChange?: (grouping: 'market' | 'group' | 'none') => void
  /** The orders the list offers. Left out and there is no Sort control. */
  orders?: readonly TrackedOrderChoice[]
  order?: string
  onOrderChange?: (order: string) => void
  searchLabel?: string
  /** The count line in place of the queries' own, for a list of markets. */
  count?: ReactNode
  /** Queries the default Status leaves out. With a number above zero, the count line offers to show them. */
  notAsked?: number
  onShowNotAsked?: () => void
}) {
  const [open, setOpen] = useState(false)
  const filtersButton = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const grouped = grouping !== 'none'
  const active = grouped ? 0 : activeFilterCount(filters)
  const narrowed = active > 0 || search.trim().length > 0
  const whole = (value: number) => value.toLocaleString('en-US')
  // Clearing removes its own button, so return focus to the stable disclosure.
  const clearFilters = () => {
    onFiltersChange(clearedTrackedFilters(filters))
    filtersButton.current?.focus()
  }
  // Escape in the open panel, or on its button, closes it and leaves focus on the button.
  const closeOnEscape = (event: { key: string }) => {
    if (event.key !== 'Escape' || !open) return
    setOpen(false)
    filtersButton.current?.focus()
  }
  // The switch carries a chosen Result over to its own signal, so a list narrowed to "Not mentioned" reads "Not cited".
  const changeSignal = (signal: TrackedSignal) => onFiltersChange({ ...filters, signal, result: resultForSignal(filters.result, signal) })
  const optionsOf = (filter: ListFilter): readonly TrackedFilterOption<string>[] => {
    if (filter === 'result') return resultOptionsFor(filters.signal)
    if (filter === 'engine') return [{ value: 'any', label: 'Any engine' }, ...engines.map(engine => ({ value: engine, label: providerDisplayName(engine) }))]
    return TRACKED_FILTER_OPTIONS[filter]
  }
  const count = countOverride ?? (shown === undefined ? null
    : !narrowed || total === undefined || total === shown ? <><span className="font-medium text-strong">{whole(shown)}</span> {shown === 1 ? 'query' : 'queries'}</>
    : <><span className="font-medium text-strong">{whole(shown)}</span> of {whole(total)} queries</>)
  const showNotAsked = !grouped && notAsked !== undefined && notAsked > 0 && filters.status === 'asked' && onShowNotAsked

  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <div className="flex min-w-0 grow basis-full flex-wrap items-center gap-2">
          {/* On a phone the switch leads, on a line of its own. */}
          <div className="max-md:order-first max-md:basis-full"><SignalSwitch value={filters.signal} onChange={changeSignal} /></div>
          {/* Where the row cannot hold the search and every control, the search takes the first line and the controls the next, together. */}
          <DataTableSearch size="sm" value={search} onChange={onSearchChange} label={searchLabel} placeholder={searchLabel} className="min-w-0 flex-1 basis-40 md:order-first md:@max-[50rem]:basis-full" />
          {groupings && groupings.length > 1 && onGroupingChange ? <LabelledSelect label="Group" value={grouping} options={groupings} active={false} onChange={onGroupingChange} /> : null}
          {orders && order !== undefined && onOrderChange ? <LabelledSelect label="Sort" value={order} options={orders} active={false} onChange={onOrderChange} /> : null}
          {grouped ? null : (
            <Button ref={filtersButton} type="button" variant="outline" size="sm" className="shrink-0 text-[13px] pointer-coarse:min-h-11 max-md:min-h-11" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)} onKeyDown={closeOnEscape}>
              {active === 0 ? 'Filters' : `Filters · ${active}`}
            </Button>
          )}
          {views}
        </div>
        {grouped ? null : (
          <div id={panelId} role="group" aria-label="Filters" hidden={!open} className={PANEL} onKeyDown={closeOnEscape}>
            {FILTER_LABELS.filter(([filter]) => filter !== 'engine' || engines.length > 1).map(([filter, label]) => (
              <LabelledSelect
                key={filter}
                label={label}
                value={filters[filter]}
                options={optionsOf(filter)}
                active={filters[filter] !== DEFAULT_TRACKED_FILTERS[filter]}
                // Status holds the longest choice, so it takes a row of the phone panel to itself.
                wide={filter === 'status'}
                onChange={value => onFiltersChange({ ...filters, [filter]: value })}
              />
            ))}
          </div>
        )}
        {count || legend || active > 0 ? (
          <div className="flex basis-full flex-wrap items-center gap-x-4 gap-y-1">
            {count || active > 0 ? (
              <div className="flex flex-wrap items-center gap-x-1">
                {count ? <p role="status" className="whitespace-nowrap text-[13px] leading-5 tabular-nums text-secondary">{count}</p> : null}
                {showNotAsked ? (
                  <Button type="button" variant="ghost" size="sm" className="-my-1.5 gap-1 px-2 text-[13px] text-link pointer-coarse:my-0 pointer-coarse:min-h-11 max-md:my-0 max-md:min-h-11" onClick={onShowNotAsked}>
                    <Eye aria-hidden="true" className="size-3.5" />
                    Show {whole(notAsked)} not asked
                  </Button>
                ) : null}
                {/* Set into the count's line with a mouse, so the first filter chosen does not move the table. */}
                {active > 0 ? <Button type="button" variant="ghost" size="sm" className="-my-1.5 px-2 text-[13px] pointer-coarse:my-0 pointer-coarse:min-h-11 max-md:my-0 max-md:min-h-11" onClick={clearFilters}>Clear filters</Button> : null}
              </div>
            ) : null}
            {/* After the count and Clear filters: its width changes with the Result and engine, so it must not push them along. */}
            {!grouped && filters.result !== 'any' ? (
              <p aria-live="polite" aria-atomic="true" className="text-[13px] leading-5 text-secondary max-md:basis-full">
                Result: <span className="font-medium text-strong">{TRACKED_FILTER_OPTIONS.result.find(option => option.value === filters.result)?.label}</span>
                {' · '}{filters.engine === 'any' ? 'Any engine' : providerDisplayName(filters.engine)}
              </p>
            ) : null}
            {legend ? <div className="min-w-0 md:ml-auto">{legend}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

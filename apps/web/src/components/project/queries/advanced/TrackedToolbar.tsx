import { useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import { DataTableSearch } from '../../../shared/DataTableControls.js'
import { Button } from '../../../ui/button.js'
import { activeFilterCount, DEFAULT_TRACKED_FILTERS, TRACKED_FILTER_OPTIONS } from './tracked-filters.js'
import type { TrackedFilters } from './tracked-types.js'

const FILTER_LABELS: readonly [keyof TrackedFilters, string][] = [
  ['subject', 'Subject'],
  ['type', 'Type'],
  ['status', 'Status'],
  ['source', 'Source'],
  ['result', 'Result'],
]

// The selects are one row beside the search with a mouse from md up. Below md, or where a finger is the
// pointer, the same selects are the panel under the Filters button, at 44px: two columns on a phone, one row
// on a wider touch screen.
const PANEL_OPEN = 'contents basis-full grid-cols-2 gap-2 pointer-coarse:grid max-md:grid md:grid-cols-[repeat(5,auto)] md:justify-start'
const PANEL_CLOSED = 'contents pointer-coarse:hidden max-md:hidden'
const CONTROL = 'relative inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-surface/50 pl-2.5 pr-2 text-[13px] text-secondary transition hover:border-strong has-[:focus-visible]:border-mono-500 has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-mono-500 pointer-coarse:h-11 max-md:h-11'

/**
 * One filter as one control with its label inside: "Subject Any". The words
 * and the chevron are drawn; a native select lies over them, unseen, so the
 * control still opens, takes keys and reads its name and value as a select
 * does. Beside a mouse the control is as wide as its widest choice, so
 * choosing never moves the row: every choice is set under the current one,
 * unseen and as generated text, which leaves nothing in the page to read or
 * to find. In the phone panel the grid sets the width.
 */
function FilterSelect<K extends keyof TrackedFilters>({ filter, label, value, onChange }: {
  filter: K
  label: string
  value: TrackedFilters[K]
  onChange: (value: TrackedFilters[K]) => void
}) {
  const options = TRACKED_FILTER_OPTIONS[filter]
  const active = value !== DEFAULT_TRACKED_FILTERS[filter]
  return (
    // Status holds the longest choice, so it takes a row of the phone panel to itself.
    <span className={`${CONTROL} ${active ? 'border-strong' : 'border-default'}${filter === 'status' ? ' max-md:col-span-2' : ''}`}>
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
        onChange={event => onChange(event.target.value as TrackedFilters[K])}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </span>
  )
}

/**
 * Search, the five filters, how many queries they list and the legend of the
 * chips. Presentation only: the caller owns the search text, the filters (the
 * URL) and both counts, which are lengths of lists it holds. The filters list
 * rows and never sum anything. The controls are one row and the count and
 * the legend the row under it: five filters leave no room for both beside
 * them in the page column. Clear filters sits with the count, in reach at
 * every width without opening the panel, and where it never moves a control.
 */
export function TrackedToolbar({ search, onSearchChange, filters, onFiltersChange, shown, total, legend }: {
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
  /** What the chips mean, such as `SignalLegend`, and any note that belongs beside it. */
  legend?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const filtersButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const active = activeFilterCount(filters)
  const narrowed = active > 0 || search.trim().length > 0
  const whole = (value: number) => value.toLocaleString('en-US')
  // Clear filters goes with the last filter, so focus moves on: to the Filters button where the selects sit behind it, else to the first select.
  const clearFilters = () => {
    onFiltersChange(DEFAULT_TRACKED_FILTERS)
    filtersButton.current?.focus()
    if (document.activeElement !== filtersButton.current) panel.current?.querySelector('select')?.focus()
  }
  // Escape in the open panel, or on its button, closes it and leaves focus on the button.
  const closeOnEscape = (event: { key: string }) => {
    if (event.key !== 'Escape' || !open) return
    setOpen(false)
    filtersButton.current?.focus()
  }
  const count = shown === undefined ? null
    : !narrowed || total === undefined || total === shown ? `${whole(shown)} ${shown === 1 ? 'query' : 'queries'}`
    : `${whole(shown)} of ${whole(total)} queries`

  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-2 py-3">
        {/* The search shares a row with the selects where the toolbar holds them all at their widest, 66rem or more, and takes a row of its own in less. The width decides, never the choices. */}
        <div className="flex min-w-[9.5rem] grow basis-full gap-2 @[66rem]:basis-0">
          <DataTableSearch size="sm" value={search} onChange={onSearchChange} label="Search queries" placeholder="Search queries" className="min-w-0 flex-1" />
          <Button ref={filtersButton} type="button" variant="outline" className="hidden min-h-11 pointer-coarse:inline-flex max-md:inline-flex" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)} onKeyDown={closeOnEscape}>
            {active === 0 ? 'Filters' : `Filters · ${active}`}
          </Button>
        </div>
        <div ref={panel} id={panelId} role="group" aria-label="Filters" className={open ? PANEL_OPEN : PANEL_CLOSED} onKeyDown={closeOnEscape}>
          {FILTER_LABELS.map(([filter, label]) => (
            <FilterSelect key={filter} filter={filter} label={label} value={filters[filter]} onChange={value => onFiltersChange({ ...filters, [filter]: value })} />
          ))}
        </div>
        {count || legend || active > 0 ? (
          <div className="flex basis-full flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {count || active > 0 ? (
              <div className="flex items-center gap-x-1">
                {count ? <p role="status" className="whitespace-nowrap text-[13px] leading-5 tabular-nums text-secondary">{count}</p> : null}
                {/* Set into the count's line with a mouse, so the first filter chosen does not move the table. */}
                {active > 0 ? <Button type="button" variant="ghost" size="sm" className="-my-1.5 px-2 text-[13px] pointer-coarse:my-0 pointer-coarse:min-h-11 max-md:my-0 max-md:min-h-11" onClick={clearFilters}>Clear filters</Button> : null}
              </div>
            ) : null}
            {legend ? <div className="min-w-0 md:ml-auto">{legend}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

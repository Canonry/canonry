import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { trackUiSearchInput } from '../../lib/ui-telemetry.js'

export const DEFAULT_TABLE_PAGE_SIZE = 25

function queryTokens(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

export function urlSearchText(value: string): string {
  let decoded = value
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    // Keep malformed URLs searchable by their raw value.
  }

  let parameters = ''
  const queryStart = value.indexOf('?')
  if (queryStart >= 0) {
    const params = new URLSearchParams(value.slice(queryStart + 1))
    params.forEach((parameterValue, key) => {
      parameters += ` ${key} ${parameterValue}`
    })
  }

  return `${value} ${decoded}${parameters}`
}

export function truncateMiddleText(value: string, headLength = 36, tailLength = 18): string {
  const characters = [...value]
  if (characters.length <= headLength + tailLength + 1) return value
  return `${characters.slice(0, headLength).join('')}…${characters.slice(-tailLength).join('')}`
}

export function MiddleTruncatedText({
  value,
  headLength,
  tailLength,
  className,
  title,
}: {
  value: string
  headLength?: number
  tailLength?: number
  className?: string
  title?: string
}) {
  const displayValue = truncateMiddleText(value, headLength, tailLength)

  return (
    <span className={className} title={title ?? value}>
      {displayValue === value ? value : (
        <>
          <span className="sr-only">{value}</span>
          <span aria-hidden="true">{displayValue}</span>
        </>
      )}
    </span>
  )
}

export function useClientTable<T>({
  rows,
  getSearchText,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
}: {
  rows: readonly T[]
  getSearchText?: (row: T) => string
  pageSize?: number
}) {
  const [query, setQueryValue] = useState('')
  const [pageValue, setPageValue] = useState(1)
  const tokens = useMemo(() => queryTokens(query), [query])

  const filteredRows = useMemo(() => {
    if (tokens.length === 0 || !getSearchText) return rows
    return rows.filter((row) => {
      const searchableText = getSearchText(row).toLocaleLowerCase()
      return tokens.every((token) => searchableText.includes(token))
    })
  }, [getSearchText, rows, tokens])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const page = Math.min(Math.max(1, pageValue), totalPages)
  const pageStart = (page - 1) * pageSize
  const pageRows = useMemo(
    () => filteredRows.slice(pageStart, pageStart + pageSize),
    [filteredRows, pageSize, pageStart],
  )

  const setQuery = useCallback((value: string) => {
    setQueryValue(value)
    setPageValue(1)
  }, [])

  const setPage = useCallback((value: number) => {
    setPageValue(Math.max(1, value))
  }, [])

  return {
    query,
    setQuery,
    page,
    setPage,
    rows: pageRows,
    filteredRows,
    totalRows: filteredRows.length,
    totalPages,
    pageSize,
    rangeStart: filteredRows.length === 0 ? 0 : pageStart + 1,
    rangeEnd: pageStart + pageRows.length,
    hasQuery: query.trim().length > 0,
  }
}

// `sm` is the 32px height of a toolbar's filters; where a finger is the pointer it is a 44px target.
const SEARCH_SIZE = {
  default: 'h-9',
  sm: 'h-8 pointer-coarse:h-11 max-md:h-11',
} as const

export function DataTableSearch({
  value,
  onChange,
  label,
  placeholder = 'Filter rows',
  className,
  size = 'default',
}: {
  value: string
  onChange: (value: string) => void
  label: string
  placeholder?: string
  className?: string
  size?: keyof typeof SEARCH_SIZE
}) {
  return (
    <div className={`relative ${className ?? ''}`}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => {
          trackUiSearchInput(event.target.value)
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') trackUiSearchInput(event.currentTarget.value, true)
        }}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`${SEARCH_SIZE[size]} w-full rounded-md border border-default bg-surface/50 pl-9 pr-9 text-sm text-strong placeholder:text-muted outline-none transition focus:border-mono-500 focus:ring-1 focus:ring-mono-500 [&::-webkit-search-cancel-button]:appearance-none`}
      />
      {value.trim().length > 0 ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLocaleLowerCase()}`}
          className="absolute right-2 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:bg-surface-hover hover:text-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-500"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

// With the Rows select the row is a set of controls, each a 44px target where a finger is the pointer.
const PAGE_CONTROL_TOUCH = ' pointer-coarse:min-h-11 max-md:min-h-11'

export function DataTablePagination({
  page,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  visibleRows,
  totalRows,
  hasNextPage,
  onPageChange,
  itemLabel = 'rows',
  className,
  disabled = false,
  pageSizeOptions,
  onPageSizeChange,
}: {
  page: number
  pageSize?: number
  visibleRows: number
  totalRows?: number
  hasNextPage?: boolean
  onPageChange: (page: number) => void
  itemLabel?: string
  className?: string
  disabled?: boolean
  /** With `onPageSizeChange`, adds a "Rows" select of these page sizes. */
  pageSizeOptions?: readonly number[]
  onPageSizeChange?: (pageSize: number) => void
}) {
  if (visibleRows === 0) return null

  const rangeStart = (page - 1) * pageSize + 1
  const rangeEnd = rangeStart + visibleRows - 1
  const totalPages = totalRows === undefined ? undefined : Math.max(1, Math.ceil(totalRows / pageSize))
  const canGoNext = hasNextPage ?? (totalPages !== undefined && page < totalPages)
  const showPageControls = page > 1 || canGoNext
  const pageSizeControl = pageSizeOptions !== undefined && onPageSizeChange !== undefined

  return (
    <div className={`mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-secondary ${className ?? ''}`}>
      <p className="tabular-nums">
        {rangeStart.toLocaleString('en-US')} to {rangeEnd.toLocaleString('en-US')}
        {totalRows === undefined
          ? `${canGoNext ? '+' : ''} ${itemLabel}`
          : ` of ${totalRows.toLocaleString('en-US')} ${itemLabel}`}
      </p>
      {pageSizeControl ? (
        <label className="ml-auto flex items-center gap-2">
          Rows
          {/* Drawn as the page buttons are: their height, and a chevron in place of the browser's arrow. */}
          <span className="relative inline-flex">
            <select
              value={pageSize}
              onChange={event => onPageSizeChange(Number(event.target.value))}
              disabled={disabled}
              className={`appearance-none rounded-md border border-base bg-bg py-1.5 pl-2.5 pr-7 tabular-nums text-strong transition hover:border-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 disabled:cursor-not-allowed disabled:opacity-40${PAGE_CONTROL_TOUCH}`}
            >
              {/* A size that is not one of the choices still shows as the current one. */}
              {[...new Set([...pageSizeOptions, pageSize])].sort((a, b) => a - b).map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          </span>
        </label>
      ) : null}
      {showPageControls ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={disabled || page <= 1}
            className={`inline-flex items-center gap-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-strong transition hover:border-strong hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-base disabled:hover:text-strong${pageSizeControl ? PAGE_CONTROL_TOUCH : ''}`}
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
            Previous
          </button>
          <span className="tabular-nums">
            {totalPages === undefined ? `Page ${page}` : `Page ${page} of ${totalPages}`}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={disabled || !canGoNext}
            className={`inline-flex items-center gap-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-strong transition hover:border-strong hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-base disabled:hover:text-strong${pageSizeControl ? PAGE_CONTROL_TOUCH : ''}`}
          >
            Next
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

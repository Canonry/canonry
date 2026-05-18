import { TrafficEventKinds, type TrafficEventEntry } from '@ainyc/canonry-contracts'

export type EventGranularity = 'hour' | 'day'

/**
 * Status-class filter values. `'all'` is the no-op default. The numbered
 * values match an HTTP status's hundreds digit so the filter check is a
 * cheap `Math.floor(status / 100)` comparison instead of a range lookup.
 */
export type StatusClassFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx'

export const STATUS_CLASS_OPTIONS: ReadonlyArray<{ value: StatusClassFilter; label: string }> = [
  { value: 'all', label: 'All status' },
  { value: '2xx', label: '2xx success' },
  { value: '3xx', label: '3xx redirect' },
  { value: '4xx', label: '4xx client error' },
  { value: '5xx', label: '5xx server error' },
]

export interface TrafficEventFilters {
  selectedBucket: string | null
  identity: string
  operator: string
  pathQuery: string
  statusClass: StatusClassFilter
}

/**
 * `'5xx'` → `5`. Returns null when the filter is `'all'` so callers can
 * skip the check entirely.
 */
function statusClassDigit(filter: StatusClassFilter): number | null {
  if (filter === 'all') return null
  return Number.parseInt(filter[0]!, 10)
}

export function identityOf(event: TrafficEventEntry): string {
  return event.kind === TrafficEventKinds.crawler ? event.botId : event.product
}

export function pathOf(event: TrafficEventEntry): string {
  return event.kind === TrafficEventKinds.crawler ? event.pathNormalized : event.landingPathNormalized
}

export function bucketKeyFor(tsHour: string, granularity: EventGranularity): string {
  if (granularity === 'hour') return tsHour
  const d = new Date(tsHour)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function filterTrafficEvents(
  events: readonly TrafficEventEntry[],
  filters: TrafficEventFilters,
  granularity: EventGranularity,
): TrafficEventEntry[] {
  const needle = filters.pathQuery.trim().toLowerCase()
  const statusDigit = statusClassDigit(filters.statusClass)
  return events.filter((event) => {
    if (filters.selectedBucket && bucketKeyFor(event.tsHour, granularity) !== filters.selectedBucket) return false
    if (filters.identity && identityOf(event) !== filters.identity) return false
    if (filters.operator && event.operator !== filters.operator) return false
    if (needle && !pathOf(event).toLowerCase().includes(needle)) return false
    if (statusDigit !== null && Math.floor(event.status / 100) !== statusDigit) return false
    return true
  })
}

// Recharts 3.x BarChart onClick passes `MouseHandlerDataParam` (activeTooltipIndex /
// activeLabel), not the v2 shape with `activePayload`. Look up the bucket from chartData
// using the index instead.
//
// The runtime value of `activeTooltipIndex` is always a string (e.g. `"5"`) — recharts
// internals wrap numeric indices via `String()` (see `combineActiveTooltipIndex.js` and
// `selectors.js`) even though the TS type advertises `number | TooltipIndex | undefined`.
// Accept both shapes so the function works against the real recharts output, not just
// the type.
export function bucketForChartClick(
  state: unknown,
  chartData: readonly { bucket: string }[],
): string | null {
  if (!state || typeof state !== 'object') return null
  const raw = (state as { activeTooltipIndex?: unknown }).activeTooltipIndex
  let idx: number
  if (typeof raw === 'number') {
    idx = raw
  } else if (typeof raw === 'string' && raw !== '') {
    idx = Number(raw)
  } else {
    return null
  }
  if (!Number.isInteger(idx)) return null
  if (idx < 0 || idx >= chartData.length) return null
  return chartData[idx]?.bucket ?? null
}

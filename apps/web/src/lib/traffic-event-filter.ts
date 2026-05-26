import { TrafficEventKinds, VerificationStatuses, type TrafficEventEntry, type VerificationStatus } from '@ainyc/canonry-contracts'

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

/**
 * Verification-class filter for crawler / AI-user-fetch claims. `'all'` is the
 * no-op default. The three concrete values mirror `VerificationStatuses` —
 * `verified` (source IP in the operator's published range), `claimed_unverified`
 * (UA-only match), and `unknown_ai_like` (behavioral heuristic, reserved). Picking
 * a concrete value excludes `ai-referral` events, which have no verification
 * concept (they're session referrers, not bot fetches).
 */
export type VerificationFilter = 'all' | VerificationStatus

export const VERIFICATION_OPTIONS: ReadonlyArray<{ value: VerificationFilter; label: string }> = [
  { value: 'all', label: 'All claims' },
  { value: VerificationStatuses.verified, label: 'Verified' },
  { value: VerificationStatuses.claimed_unverified, label: 'Claimed unverified' },
  { value: VerificationStatuses.unknown_ai_like, label: 'Unknown AI-like' },
]

export interface TrafficEventFilters {
  selectedBucket: string | null
  identity: string
  operator: string
  pathQuery: string
  statusClass: StatusClassFilter
  verification: VerificationFilter
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
  switch (event.kind) {
    case TrafficEventKinds.crawler:
    case TrafficEventKinds['ai-user-fetch']:
      return event.botId
    case TrafficEventKinds['ai-referral']:
      return event.product
  }
}

export function pathOf(event: TrafficEventEntry): string {
  switch (event.kind) {
    case TrafficEventKinds.crawler:
    case TrafficEventKinds['ai-user-fetch']:
      return event.pathNormalized
    case TrafficEventKinds['ai-referral']:
      return event.landingPathNormalized
  }
}

/**
 * Returns the event's verification status, or `null` for ai-referral events
 * (which lack the concept). A `null` return means "not subject to the
 * verification filter" — picking a concrete verification class will exclude
 * these events.
 */
export function verificationOf(event: TrafficEventEntry): string | null {
  switch (event.kind) {
    case TrafficEventKinds.crawler:
    case TrafficEventKinds['ai-user-fetch']:
      return event.verificationStatus
    case TrafficEventKinds['ai-referral']:
      return null
  }
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
    if (filters.verification !== 'all' && verificationOf(event) !== filters.verification) return false
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

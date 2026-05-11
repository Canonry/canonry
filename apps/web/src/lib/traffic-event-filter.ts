import { TrafficEventKinds, type TrafficEventEntry } from '@ainyc/canonry-contracts'

export type EventGranularity = 'hour' | 'day'

export interface TrafficEventFilters {
  selectedBucket: string | null
  identity: string
  operator: string
  pathQuery: string
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
  return events.filter((event) => {
    if (filters.selectedBucket && bucketKeyFor(event.tsHour, granularity) !== filters.selectedBucket) return false
    if (filters.identity && identityOf(event) !== filters.identity) return false
    if (filters.operator && event.operator !== filters.operator) return false
    if (needle && !pathOf(event).toLowerCase().includes(needle)) return false
    return true
  })
}

import { and, eq, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { calendarDateRange, groupIsoDateRanges, shiftIsoCalendarDate } from '@canonry/canonry-contracts'
import { gaSyncCoverage } from '@canonry/canonry-db'
import type { GA4DateRange } from '@canonry/canonry-integration-google-analytics'

type Database = FastifyInstance['db']
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type Component = 'traffic' | 'daily' | 'ai' | 'social' | 'acquisition' | 'leads'

export interface GaSyncCoveragePlan {
  projectId: string
  propertyId: string
  component: Component
  definition: string
  requested: GA4DateRange
  ranges: GA4DateRange[]
  refreshStart: string
}

/** Reuse mature successful days; always revisit two weeks and reconcile older data monthly. */
export function planGaSyncCoverage(
  db: Database,
  input: Omit<GaSyncCoveragePlan, 'ranges' | 'refreshStart' | 'definition'> & { definition?: string },
  now: string,
): GaSyncCoveragePlan {
  const definition = input.definition ?? 'v1'
  const refreshStart = shiftIsoCalendarDate(input.requested.endDate, -13)
  const reconcileAfter = new Date(Date.parse(now) - 30 * 86_400_000).toISOString()
  const covered = new Set(db.select().from(gaSyncCoverage).where(and(
    eq(gaSyncCoverage.projectId, input.projectId),
    eq(gaSyncCoverage.propertyId, input.propertyId),
    eq(gaSyncCoverage.component, input.component),
    eq(gaSyncCoverage.definition, definition),
  )).all().filter(row => row.settled && row.syncedAt > reconcileAfter).map(row => row.date))
  const missing = calendarDateRange(input.requested.startDate, input.requested.endDate)
    .filter(date => date >= refreshStart || !covered.has(date))
  return {
    ...input, definition, refreshStart,
    ranges: groupIsoDateRanges(missing).map(range => ({ startDate: range.start, endDate: range.end })),
  }
}

/** Save only beside committed rows. Empty successful ranges also prove coverage. */
export function saveGaSyncCoverage(tx: Transaction, plan: GaSyncCoveragePlan, ranges: GA4DateRange[], syncedAt: string, syncRunId: string): void {
  for (const range of ranges) {
    for (const date of calendarDateRange(range.startDate, range.endDate)) {
      const values = {
        projectId: plan.projectId, propertyId: plan.propertyId, component: plan.component,
        definition: plan.definition, date, settled: date < plan.refreshStart, syncedAt, syncRunId,
      }
      tx.insert(gaSyncCoverage).values(values).onConflictDoUpdate({
        target: [gaSyncCoverage.projectId, gaSyncCoverage.component, gaSyncCoverage.date],
        set: values,
      }).run()
    }
  }
  // Coverage is bounded even though stored reporting history can be retained longer.
  tx.delete(gaSyncCoverage).where(and(
    eq(gaSyncCoverage.projectId, plan.projectId),
    lt(gaSyncCoverage.date, shiftIsoCalendarDate(plan.requested.endDate, -362)),
  )).run()
}

/** Freeze calendar bounds before I/O, including when a sync crosses midnight. */
export async function fetchGaSyncRanges<T>(plan: GaSyncCoveragePlan, fetchRange: (range: GA4DateRange) => Promise<T>): Promise<Array<{ range: GA4DateRange; report: T }>> {
  const results: Array<{ range: GA4DateRange; report: T }> = []
  for (const range of plan.ranges) {
    results.push({ range, report: await fetchRange(range) })
  }
  return results
}

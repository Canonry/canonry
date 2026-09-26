import { eq } from 'drizzle-orm'
import { calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, formatIsoDateInTimeZone, reportMonthsForDoctor, groupIsoDateRanges } from '@ainyc/canonry-contracts'
import { gaDailyTotals, gaTrafficSummaries, gscDailyTotals, gscDataWatermarks, projects } from '@ainyc/canonry-db'
import type { CheckDefinition, DoctorContext } from '../types.js'

type DateRange = { start: string; end: string }

function dateSpan(dates: readonly string[]): DateRange | null {
  const sorted = [...dates].sort()
  return sorted.length === 0 ? null : { start: sorted[0]!, end: sorted.at(-1)! }
}

/**
 * The dates the most recent sync provably asked the source for. Each sync
 * replaces its whole requested range, so a date inside it with no stored row
 * came back empty: zero activity, not a gap. Dates outside it stay unknown;
 * no store records the ranges of earlier syncs.
 */
function latestSyncRange(ctx: DoctorContext, source: 'ga' | 'gsc'): DateRange | null {
  const projectId = ctx.project!.id
  if (source === 'ga') {
    const rows = ctx.db.select({ date: gaDailyTotals.date, syncedAt: gaDailyTotals.syncedAt }).from(gaDailyTotals).where(eq(gaDailyTotals.projectId, projectId)).all()
    const latest = rows.reduce<string | null>((max, row) => max === null || row.syncedAt > max ? row.syncedAt : max, null)
    // The summary and the daily totals are one fetch over one window, written
    // with one timestamp; a summary at least as new as the rows names that window.
    const summary = ctx.db.select({ start: gaTrafficSummaries.periodStart, end: gaTrafficSummaries.periodEnd, syncedAt: gaTrafficSummaries.syncedAt })
      .from(gaTrafficSummaries).where(eq(gaTrafficSummaries.projectId, projectId)).get()
    if (summary && (latest === null || summary.syncedAt >= latest)) return { start: summary.start, end: summary.end }
    return dateSpan(rows.filter(row => row.syncedAt === latest).map(row => row.date))
  }
  const rows = ctx.db.select({ date: gscDailyTotals.date, createdAt: gscDailyTotals.createdAt }).from(gscDailyTotals).where(eq(gscDailyTotals.projectId, projectId)).all()
  const latest = rows.reduce<string | null>((max, row) => max === null || row.createdAt > max ? row.createdAt : max, null)
  const span = dateSpan(rows.filter(row => row.createdAt === latest).map(row => row.date))
  if (!span) return null
  // The watermark shares the sync's timestamp; only then does its requested
  // ceiling describe the same sync as these rows.
  const watermark = ctx.db.select({ through: gscDataWatermarks.syncedThroughDate, updatedAt: gscDataWatermarks.updatedAt })
    .from(gscDataWatermarks).where(eq(gscDataWatermarks.projectId, projectId)).get()
  return watermark?.through && watermark.updatedAt === latest && watermark.through > span.end ? { start: span.start, end: watermark.through } : span
}

function dailyCoverage(ctx: DoctorContext, month: string, source: 'ga' | 'gsc') {
  const project = ctx.project!
  const connection = source === 'ga'
    ? ctx.ga4CredentialStore?.getConnection(project.name) ?? ctx.googleConnectionStore?.getConnection(project.canonicalDomain, 'ga4')
    : ctx.googleConnectionStore?.getConnection(project.canonicalDomain, 'gsc')
  const stored = source === 'ga'
    ? ctx.db.select({ date: gaDailyTotals.date, count: gaDailyTotals.sessions }).from(gaDailyTotals).where(eq(gaDailyTotals.projectId, project.id)).all()
    : ctx.db.select({ date: gscDailyTotals.date, count: gscDailyTotals.impressions }).from(gscDailyTotals).where(eq(gscDailyTotals.projectId, project.id)).all()
  if (!connection && stored.length === 0) return null
  const bounds = calendarMonthBounds(month)
  const start = bounds.since.slice(0, 10)
  const end = bounds.until.slice(0, 10)
  const timeZone = source === 'gsc' ? 'America/Los_Angeles' : 'UTC'
  const today = formatIsoDateInTimeZone(new Date().toISOString(), timeZone)
  // GA property timezone is not persisted; a conservative three-date lag avoids grading unfinished daily reports.
  const matureThrough = new Date(Date.parse(today) - 3 * 86_400_000).toISOString().slice(0, 10)
  const created = ctx.db.select({ date: projects.createdAt }).from(projects).where(eq(projects.id, project.id)).get()!.date.slice(0, 10)
  const connectedAt = connection?.createdAt?.slice(0, 10) ?? created
  // Imported historic rows can predate connection/project creation. Preserve that observed history.
  const onboardingDate = [connectedAt, ...stored.map(row => row.date)].sort()[0]!
  const byDate = new Map(stored.map(row => [row.date, row.count]))
  const coverage = latestSyncRange(ctx, source)
  const absent: string[] = []
  let observedDays = 0
  let observedZeroDays = 0
  let queriedEmptyDays = 0
  let pendingDays = 0
  let beforeConnectionDays = 0
  for (let dateMs = Date.parse(start); dateMs <= Date.parse(end); dateMs += 86_400_000) {
    const date = new Date(dateMs).toISOString().slice(0, 10)
    if (date > matureThrough) { pendingDays++; continue }
    if (date < onboardingDate) { beforeConnectionDays++; continue }
    const count = byDate.get(date)
    if (count !== undefined) { observedDays++; if (count === 0) observedZeroDays++ }
    else if (coverage && date >= coverage.start && date <= coverage.end) queriedEmptyDays++
    else absent.push(date)
  }
  return {
    source, start, end, matureThrough, timeZone, timeZoneBasis: source === 'ga' ? 'fallback' : 'provider', onboardingDate,
    observedDays, observedZeroDays,
    // Queried by the latest sync and returned no row: the source reports no activity for them.
    latestSyncRange: coverage, queriedEmptyDays,
    unknownDays: absent.length, unknownRanges: groupIsoDateRanges(absent),
    // Only the latest sync's range is on record, so an absent date outside it may never have been queried.
    confirmedMissingDays: 0, pendingDays, beforeConnectionDays,
  }
}

export const reportDailyDataCheck: CheckDefinition = {
  id: 'report.daily-data', category: CheckCategories.integrations, scope: CheckScopes.project,
  notificationPolicy: CheckNotificationPolicies.silent, title: 'Monthly report daily data coverage',
  run(ctx) {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.daily-data.no-project', summary: 'Project context required.' }
    const months = reportMonthsForDoctor(ctx.reportMonth).map(month => ({ month, sources: (['ga', 'gsc'] as const).flatMap(source => { const coverage = dailyCoverage(ctx, month, source); return coverage ? [coverage] : [] }) }))
    const sources = months.flatMap(month => month.sources)
    if (!sources.length) return { status: CheckStatuses.skipped, code: 'report.daily-data.not-connected', summary: 'No connected or stored GA4/Search Console evidence.', details: { months } }
    const unknown = sources.reduce((sum, source) => sum + source.unknownDays, 0)
    const mature = sources.some(source => source.observedDays + source.queriedEmptyDays + source.unknownDays > 0)
    const gaUnknown = sources.some(source => source.source === 'ga' && source.unknownDays > 0)
    const oldest = months[0]!.month
    const days = Math.max(1, Math.ceil((Date.now() - Date.parse(calendarMonthBounds(oldest).since)) / 86_400_000))
    const commands = [...new Set(sources.filter(source => source.unknownDays > 0).map(source => source.source === 'ga' ? `canonry ga sync ${ctx.project!.name} --days ${Math.min(90, days)}` : `canonry google sync ${ctx.project!.name} --days ${Math.min(480, days)}`))]
    return {
      status: unknown ? CheckStatuses.warn : mature ? CheckStatuses.ok : CheckStatuses.skipped,
      code: unknown ? 'report.daily-data.unknown' : mature ? 'report.daily-data.observed' : 'report.daily-data.pending',
      summary: unknown ? `${unknown} source-days have unknown coverage: no row, and outside the latest sync's range. Absent rows can mean zero activity or unsynced data.` : mature ? 'Every mature date has an observed daily total or was queried by the latest sync and returned no activity.' : 'No mature dates since connection; reporting latency is excluded.',
      remediation: unknown ? `Review coverage and backfill: ${commands.map(command => `\`${command}\``).join('; ')}. A sync whose window covers these dates records them as queried, so dates it returns no row for then count as zero activity.${gaUnknown && days > 90 ? ' GA4 sync supports at most 90 days; older unknown dates need an external export.' : ''}` : null,
      details: { months },
    }
  },
}

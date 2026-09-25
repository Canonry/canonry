import { eq } from 'drizzle-orm'
import { calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, formatIsoDateInTimeZone, reportMonthsForDoctor, groupIsoDateRanges } from '@ainyc/canonry-contracts'
import { gaDailyTotals, gscDailyTotals, projects } from '@ainyc/canonry-db'
import type { CheckDefinition, DoctorContext } from '../types.js'

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
  const absent: string[] = []
  let observedDays = 0
  let observedZeroDays = 0
  let pendingDays = 0
  let beforeConnectionDays = 0
  for (let dateMs = Date.parse(start); dateMs <= Date.parse(end); dateMs += 86_400_000) {
    const date = new Date(dateMs).toISOString().slice(0, 10)
    if (date > matureThrough) { pendingDays++; continue }
    if (date < onboardingDate) { beforeConnectionDays++; continue }
    const count = byDate.get(date)
    if (count === undefined) absent.push(date)
    else { observedDays++; if (count === 0) observedZeroDays++ }
  }
  return {
    source, start, end, matureThrough, timeZone, timeZoneBasis: source === 'ga' ? 'fallback' : 'provider', onboardingDate,
    observedDays, observedZeroDays, unknownDays: absent.length, unknownRanges: groupIsoDateRanges(absent),
    // No durable per-day sync coverage ledger exists. Neither a latest watermark nor a successful run proves an interior date was queried.
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
    const mature = sources.some(source => source.observedDays + source.unknownDays > 0)
    const oldest = months[0]!.month
    const days = Math.max(1, Math.ceil((Date.now() - Date.parse(calendarMonthBounds(oldest).since)) / 86_400_000))
    const commands = [...new Set(sources.filter(source => source.unknownDays > 0).map(source => source.source === 'ga' ? `canonry ga sync ${ctx.project!.name} --days ${Math.min(90, days)}` : `canonry google sync ${ctx.project!.name} --days ${Math.min(480, days)}`))]
    return {
      status: unknown ? CheckStatuses.warn : mature ? CheckStatuses.ok : CheckStatuses.skipped,
      code: unknown ? 'report.daily-data.unknown' : mature ? 'report.daily-data.observed' : 'report.daily-data.pending',
      summary: unknown ? `${unknown} source-days have unknown coverage. Absent rows can mean zero activity or unsynced data.` : mature ? 'Every mature date has an observed daily total, including recorded zeros.' : 'No mature dates since connection; reporting latency is excluded.',
      remediation: unknown ? `Review coverage and backfill: ${commands.map(command => `\`${command}\``).join('; ')}. A successful empty response still does not prove historical collection coverage.${days > 90 ? ' GA4 sync supports at most 90 days; older unknown dates need an external export.' : ''}` : null,
      details: { months },
    }
  },
}

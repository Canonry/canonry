import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import {
  CheckCategories,
  CheckScopes,
  CheckStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  SchedulableRunKinds,
  SeoRunStatuses,
  calendarRecurrenceSchema,
  formatIsoDateInTimeZone,
  formatRunErrorOneLine,
  parseRunError,
  truncateUtf16,
} from '@canonry/canonry-contracts'
import { runs, schedules, seoJobs, seoTasks } from '@canonry/canonry-db'
import { firstSentence } from '../../notifications/health-copy.js'
import { nextRunFromSchedule, type ScheduleTiming } from '../../schedule-utils.js'
import type { CheckDefinition, CheckOutput, DoctorContext, ProjectInfo } from '../types.js'

/**
 * Are scheduled SEO refreshes still working?
 *
 * A `seo-sync` firing records one run per saved profile. An admitted refresh
 * runs later and ends completed, partial or failed; a profile the firing could
 * not admit (policy limit, stale scope, no source) is stored as a failed run
 * with the reason. Nothing reports either outcome, and a schedule that stops
 * firing leaves no run at all, so a paid monthly refresh could lapse unseen.
 *
 * Two findings, both `warn` (stale SEO data is not an emergency):
 *  - the latest firing did not fully complete, with each run's reason. A
 *    completed refresh started after it, such as a manual retry, clears this.
 *  - no refresh completed within two days of the first firing due after the
 *    last completed refresh (or after the schedule was created).
 * A project without an enabled `seo-sync` schedule is skipped: manual
 * refreshes have no cadence to miss.
 */
const GRACE_DAYS = 2
const DAY_MS = 24 * 60 * 60 * 1000
/**
 * A firing writes its runs in one synchronous pass, moments apart, and cron
 * fires at most once a minute, so runs a minute before the newest one belong
 * to an earlier firing.
 */
const FIRING_SPAN_MS = 60_000
const REASON_LIMIT = 300

type ScheduleRow = typeof schedules.$inferSelect

interface RefreshRun {
  id: string
  status: string
  error: string | null
  createdAt: string
}

function skipped(code: string, summary: string): CheckOutput {
  return { status: CheckStatuses.skipped, code, summary, remediation: null }
}

function seoSyncRuns(projectId: string) {
  return and(eq(runs.projectId, projectId), eq(runs.kind, RunKinds['seo-sync']))
}

/** The schedule's timing as the scheduler reads it; null when a stored recurrence is corrupt. */
function scheduleTiming(schedule: ScheduleRow): ScheduleTiming | null {
  if (!schedule.recurrence) return { cronExpr: schedule.cronExpr, timezone: schedule.timezone, recurrence: null }
  const recurrence = calendarRecurrenceSchema.safeParse(schedule.recurrence).data
  return recurrence ? { cronExpr: schedule.cronExpr, timezone: schedule.timezone, recurrence } : null
}

/**
 * Every run of this schedule's newest firing, oldest first. Runs from before
 * the schedule was created belong to a schedule that was removed.
 */
function latestFiring(ctx: DoctorContext, projectId: string, schedule: ScheduleRow): RefreshRun[] {
  const scheduled = and(seoSyncRuns(projectId), eq(runs.trigger, RunTriggers.scheduled), gt(runs.createdAt, schedule.createdAt))
  const newest = ctx.db.select({ createdAt: runs.createdAt }).from(runs).where(scheduled).orderBy(desc(runs.createdAt)).limit(1).get()
  if (!newest) return []
  const newestMs = Date.parse(newest.createdAt)
  const after = Number.isFinite(newestMs) ? new Date(newestMs - FIRING_SPAN_MS).toISOString() : newest.createdAt
  return ctx.db
    .select({ id: runs.id, status: runs.status, error: runs.error, createdAt: runs.createdAt })
    .from(runs)
    .where(and(scheduled, gt(runs.createdAt, after)))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .all()
}

/** The newest completed refresh of any trigger: a manual refresh keeps the data current too. */
function lastCompleted(ctx: DoctorContext, projectId: string): { id: string; at: string } | null {
  const at = sql<string>`coalesce(${runs.finishedAt}, ${runs.createdAt})`
  return ctx.db
    .select({ id: runs.id, at })
    .from(runs)
    .where(and(seoSyncRuns(projectId), eq(runs.status, RunStatuses.completed)))
    .orderBy(desc(at))
    .limit(1)
    .get() ?? null
}

function isIncomplete(run: RefreshRun): boolean {
  return run.status === RunStatuses.failed || run.status === RunStatuses.partial
}

/**
 * Why a refresh did not fully complete. One that never started stores the
 * reason on its run; one that ran keeps it on its requests. A partial result
 * stores no text, so it is named from the outcome.
 */
function refreshReason(ctx: DoctorContext, run: RefreshRun): string {
  const stored = parseRunError(run.error)
  if (stored) return formatRunErrorOneLine(stored)
  const tasks = ctx.db
    .select({ status: seoTasks.status, error: seoTasks.error })
    .from(seoTasks)
    .innerJoin(seoJobs, eq(seoTasks.jobId, seoJobs.id))
    .where(eq(seoJobs.runId, run.id))
    .all()
  const errors = [...new Set(tasks.flatMap(task => (task.error ? [task.error] : [])))]
  if (errors.length > 0) return errors.join(' ')
  if (tasks.some(task => task.status === SeoRunStatuses.partial)) return 'Some SEO results could not be collected.'
  if (tasks.some(task => task.status === SeoRunStatuses.cancelled)) return 'Part of the refresh was cancelled.'
  return 'No reason was recorded.'
}

function gradeSeoRefresh(ctx: DoctorContext, project: ProjectInfo): CheckOutput {
  const schedule = ctx.db
    .select()
    .from(schedules)
    .where(and(eq(schedules.projectId, project.id), eq(schedules.kind, SchedulableRunKinds['seo-sync'])))
    .get()
  if (!schedule) return skipped('seo.data.not-scheduled', 'No SEO refresh schedule is set for this project.')
  if (!schedule.enabled) return skipped('seo.data.not-scheduled', 'The SEO refresh schedule is disabled.')

  const name = project.name
  // Dates read in the schedule's own timezone, the one its firing times were set in.
  const day = (iso: string) => formatIsoDateInTimeZone(iso, schedule.timezone)
  const now = Date.now()
  const timing = scheduleTiming(schedule)
  const last = lastCompleted(ctx, project.id)
  // A new schedule gets a full first cycle, counted from its creation.
  const reference = last && Date.parse(last.at) > Date.parse(schedule.createdAt) ? last.at : schedule.createdAt
  const dueAt = timing ? nextRunFromSchedule(timing, new Date(reference)) : null
  const deadlineAt = dueAt ? new Date(Date.parse(dueAt) + GRACE_DAYS * DAY_MS).toISOString() : null
  const firing = latestFiring(ctx, project.id, schedule)
  const details: Record<string, unknown> = {
    scheduleId: schedule.id,
    cronExpr: schedule.cronExpr || null,
    recurrence: schedule.recurrence ?? null,
    timezone: schedule.timezone,
    graceDays: GRACE_DAYS,
    lastCompletedAt: last?.at ?? null,
    lastCompletedRunId: last?.id ?? null,
    dueAt,
    deadlineAt,
    latestScheduledRuns: firing.map(run => ({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      reason: isIncomplete(run) ? refreshReason(ctx, run) : null,
    })),
  }

  // The scheduler cannot register a timing it cannot read, so it never fires.
  if (!timing || !dueAt || !deadlineAt) {
    return {
      status: CheckStatuses.warn,
      code: 'seo.data.schedule-invalid',
      summary: 'The SEO refresh schedule has no time it can run, so no scheduled SEO refresh will start.',
      remediation: `Set a schedule that can run, for example \`canonry schedule set ${name} --kind seo-sync --cron '0 7 2 * *' --timezone UTC\`.`,
      details,
      alert: {
        label: 'SEO schedule invalid',
        line: 'The SEO refresh schedule has no time it can run, so SEO data never refreshes.',
        next: `Set it again with canonry schedule set ${name} --kind seo-sync.`,
      },
    }
  }

  const nextAt = nextRunFromSchedule(timing, new Date(now))
  const incomplete = firing.filter(isIncomplete)
  const newestFired = firing[firing.length - 1]
  const retried = newestFired && incomplete.length > 0
    ? ctx.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(seoSyncRuns(project.id), eq(runs.status, RunStatuses.completed), gt(runs.createdAt, newestFired.createdAt)))
      .limit(1)
      .get()
    : undefined
  if (newestFired && incomplete.length > 0 && !retried) {
    const failed = incomplete.some(run => run.status === RunStatuses.failed)
    const firedOn = day(newestFired.createdAt)
    const reasons = [...new Set(incomplete.map(run => refreshReason(ctx, run)))].join(' ')
    const reason = reasons.length > REASON_LIMIT ? `${truncateUtf16(reasons, REASON_LIMIT)}...` : reasons
    const outcome = firing.length === 1
      ? `The scheduled SEO refresh on ${firedOn} ${failed ? 'failed' : 'only partly completed'}`
      : `${incomplete.length} of ${firing.length} profile refreshes in the scheduled SEO refresh on ${firedOn} did not fully complete`
    // A refresh that never started stores a full sentence naming the profile
    // and the cause, which says it better than any wrapper would.
    const line = firing.length > 1 ? `${outcome}.` : incomplete[0]!.error ? reason : `${outcome}: ${reason}`
    const next = nextAt ? ` on ${day(nextAt)}` : ''
    return {
      status: CheckStatuses.warn,
      code: failed ? 'seo.data.refresh-failed' : 'seo.data.refresh-partial',
      summary: `${outcome}. Reason: ${reason} ${last ? `The last completed SEO refresh was on ${day(last.at)}.` : 'No SEO refresh has completed yet.'}`,
      remediation: `Fix what the reason names, then refresh now with \`canonry seo refresh-intent ${name} <profile-id>\` and \`canonry seo sync\`, or wait for the next scheduled refresh${next}. A completed refresh clears this warning.`,
      details,
      alert: {
        label: failed ? 'SEO refresh failed' : 'SEO refresh incomplete',
        line: firstSentence(line) ?? line,
        next: `Fix the cause, then refresh by hand or wait for the next scheduled refresh${next}.`,
      },
    }
  }

  if (now >= Date.parse(deadlineAt)) {
    // Scheduled firings skip while a refresh is queued or running, so one
    // that never finishes stops the schedule.
    const active = ctx.db
      .select({ id: runs.id, createdAt: runs.createdAt })
      .from(runs)
      .where(and(seoSyncRuns(project.id), inArray(runs.status, [RunStatuses.queued, RunStatuses.running])))
      .orderBy(asc(runs.createdAt))
      .limit(1)
      .get()
    const since = last ? `No SEO refresh has completed since ${day(last.at)}.` : 'No SEO refresh has completed since the schedule was set up.'
    const missed = last
      ? `The scheduled refresh due ${day(dueAt)} did not complete within ${GRACE_DAYS} days.`
      : `Its first refresh, due ${day(dueAt)}, did not complete within ${GRACE_DAYS} days.`
    return {
      status: CheckStatuses.warn,
      code: 'seo.data.overdue',
      summary: `${since} ${missed}${active ? ` A refresh started ${day(active.createdAt)} has not finished, and scheduled refreshes wait for it.` : ''}`,
      remediation: active
        ? `Check that refresh with \`canonry seo run show ${name} ${active.id}\`, and cancel it with \`canonry seo run cancel ${name} ${active.id}\` if it is stuck.`
        : `Check that the server was running on ${day(dueAt)} and what \`canonry runs ${name} --kind seo-sync\` shows for that day. To refresh now, run \`canonry seo refresh-intent ${name} <profile-id>\`, then \`canonry seo sync\`.`,
      details: { ...details, activeRunId: active?.id ?? null },
      alert: {
        label: 'SEO refresh overdue',
        line: since,
        next: active ? 'Check the refresh that has not finished, and cancel it if it is stuck.' : `Check that the server was up on ${day(dueAt)}, then refresh by hand.`,
      },
    }
  }

  const pending = Date.parse(dueAt) <= now
  if (!last) {
    return {
      status: CheckStatuses.ok,
      code: 'seo.data.awaiting-first-refresh',
      summary: pending
        ? `No SEO refresh has completed yet. The first scheduled refresh, due ${day(dueAt)}, has until ${day(deadlineAt)} to complete.`
        : `No SEO refresh has completed yet. The first scheduled refresh is due ${day(dueAt)}.`,
      remediation: null,
      details,
    }
  }
  return {
    status: CheckStatuses.ok,
    code: 'seo.data.fresh',
    summary: `The last SEO refresh completed on ${day(last.at)}. ${pending
      ? `The scheduled refresh due ${day(dueAt)} has until ${day(deadlineAt)} to complete.`
      : `The next scheduled refresh is due ${day(dueAt)}.`}`,
    remediation: null,
    details,
  }
}

const seoRecentRefreshCheck: CheckDefinition = {
  id: 'seo.data.recent-refresh',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'SEO data still refreshing',
  run: (ctx) => {
    if (!ctx.project) return skipped('seo.data.no-project', 'Project context required.')
    return gradeSeoRefresh(ctx, ctx.project)
  },
}

export const SEO_REFRESH_CHECKS: readonly CheckDefinition[] = [seoRecentRefreshCheck]

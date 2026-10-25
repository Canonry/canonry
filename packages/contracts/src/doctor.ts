import { z } from 'zod'
import { calendarMonthBounds } from './visibility-stats.js'
import { shiftIsoCalendarDate } from './formatting.js'

export const checkStatusSchema = z.enum(['ok', 'warn', 'fail', 'skipped'])
export type CheckStatus = z.infer<typeof checkStatusSchema>
export const CheckStatuses = checkStatusSchema.enum

export const checkScopeSchema = z.enum(['global', 'project'])
export type CheckScope = z.infer<typeof checkScopeSchema>
export const CheckScopes = checkScopeSchema.enum

export const checkCategorySchema = z.enum([
  'auth',
  'config',
  'providers',
  'integrations',
  'database',
  'schedules',
  /** Discoverability checks for agent integrations (skills installed, MCP setup). */
  'agent',
])
export type CheckCategory = z.infer<typeof checkCategorySchema>
export const CheckCategories = checkCategorySchema.enum

/**
 * Suffix of the code the runner gives a check that threw (`<id>.runtime-error`).
 * Such a result is graded `fail`, and it tested nothing: it is not evidence
 * that the thing it checks is broken, or that it is fixed.
 */
export const CHECK_RUNTIME_ERROR_SUFFIX = '.runtime-error'

export const checkNotificationPolicySchema = z.enum(['health', 'silent'])
export const CheckNotificationPolicies = checkNotificationPolicySchema.enum
export type CheckNotificationPolicy = z.infer<typeof checkNotificationPolicySchema>
export const reportMonthSchema = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')

/** Keep the previous closed month visible through the scheduled report build on day 3 (UTC). */
export function reportMonthsForDoctor(reportMonth?: string, now: Date = new Date()): string[] {
  if (reportMonth !== undefined) return [reportMonthSchema.parse(reportMonth)]
  const current = now.toISOString().slice(0, 7)
  if (now.getUTCDate() > 3) return [current]
  const previous = new Date(Date.parse(calendarMonthBounds(current).since) - 1).toISOString().slice(0, 7)
  return [previous, current]
}

/**
 * The report months whose readiness decides a report check's status. Through
 * day 3 the default window also shows the new month, which has had no time to
 * collect evidence yet; only the closed month the report is built from is
 * graded then. A single month, explicit or default, is always graded.
 */
export function gradedReportMonths(months: readonly string[], now: Date = new Date()): Set<string> {
  const current = now.toISOString().slice(0, 7)
  return new Set(months.length > 1 ? months.filter(month => month !== current) : months)
}

/**
 * Plain words for an alert about one check result, written by the check that
 * knows the facts: a few-word name for the problem, what happened in one line,
 * and the next step (null when there is nothing to do yet). Alerts show these
 * instead of the summary and remediation, which stay the full explanation.
 */
export const healthAlertCopySchema = z.object({
  label: z.string().describe('The problem in a few words, e.g. "Can\'t reach Google".'),
  line: z.string().describe('What happened, in one plain sentence.'),
  next: z.string().nullable().describe('What to do, in one plain sentence; null when nothing needs doing yet.'),
})
export type HealthAlertCopy = z.infer<typeof healthAlertCopySchema>

export const checkResultSchema = z.object({
  id: z.string(),
  category: checkCategorySchema,
  scope: checkScopeSchema,
  title: z.string(),
  status: checkStatusSchema,
  notificationPolicy: checkNotificationPolicySchema.optional().describe('Health checks page by default. Silent checks (report advisories and standing advisories) remain visible but never affect health alert state.'),
  code: z.string().describe('Stable machine-readable code (e.g. "google.token.refresh-failed"). Use this for filtering and remediation logic.'),
  urgent: z.boolean().optional().describe('True when this result is a problem a person has to act on now (the website is down, daily data stopped arriving, a sync keeps failing). Urgent results are what the health.urgent notification event reports. A result set aside under its failing cause (status "skipped", code "<id>.superseded") keeps the flag: the problem is still open.'),
  summary: z.string(),
  remediation: z.string().nullable().optional().describe('Operator-facing next step. Null when status is "ok" or no specific remediation applies.'),
  details: z.record(z.string(), z.unknown()).optional().describe('Structured context — principal email, redirect URI, missing scopes, etc. Stable per check id.'),
  alert: healthAlertCopySchema.optional().describe('Plain words a health alert shows for this result. Absent when the check has none; alerts then fall back to the summary.'),
  durationMs: z.number().int().nonnegative().describe('How long the check took to execute.'),
})
export type CheckResultDto = z.infer<typeof checkResultSchema>

export const doctorReportSchema = z.object({
  scope: checkScopeSchema,
  project: z.string().nullable().describe('Project name when scope is "project", null otherwise.'),
  reportMonths: z.array(reportMonthSchema).optional().describe('Calendar months evaluated by project report readiness checks.'),
  generatedAt: z.string().describe('ISO-8601 timestamp when this doctor run started.'),
  durationMs: z.number().int().nonnegative(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  checks: z.array(checkResultSchema),
})
export type DoctorReportDto = z.infer<typeof doctorReportSchema>

export function summarizeCheckResults(results: CheckResultDto[]): DoctorReportDto['summary'] {
  const summary = { total: results.length, ok: 0, warn: 0, fail: 0, skipped: 0 }
  for (const result of results) {
    switch (result.status) {
      case CheckStatuses.ok: summary.ok += 1; break
      case CheckStatuses.warn: summary.warn += 1; break
      case CheckStatuses.fail: summary.fail += 1; break
      case CheckStatuses.skipped: summary.skipped += 1; break
    }
  }
  return summary
}

/** Adjacent unknown dates are displayed as ranges; missing rows never become measured zeros. */
export function groupIsoDateRanges(dates: readonly string[]) {
  const ranges: Array<{ start: string; end: string }> = []
  for (const date of [...new Set(dates)].sort()) {
    const previous = ranges.at(-1)
    if (previous && shiftIsoCalendarDate(previous.end, 1) === date) previous.end = date
    else ranges.push({ start: date, end: date })
  }
  return ranges
}

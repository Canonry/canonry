import { z } from 'zod'
import { calendarMonthBounds } from './visibility-stats.js'

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

export const checkResultSchema = z.object({
  id: z.string(),
  category: checkCategorySchema,
  scope: checkScopeSchema,
  title: z.string(),
  status: checkStatusSchema,
  notificationPolicy: checkNotificationPolicySchema.optional().describe('Health checks page by default. Silent report advisories remain visible but never affect health alert state.'),
  code: z.string().describe('Stable machine-readable code (e.g. "google.token.refresh-failed"). Use this for filtering and remediation logic.'),
  summary: z.string(),
  remediation: z.string().nullable().optional().describe('Operator-facing next step. Null when status is "ok" or no specific remediation applies.'),
  details: z.record(z.string(), z.unknown()).optional().describe('Structured context — principal email, redirect URI, missing scopes, etc. Stable per check id.'),
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
    if (previous && Date.parse(date) - Date.parse(previous.end) === 86_400_000) previous.end = date
    else ranges.push({ start: date, end: date })
  }
  return ranges
}

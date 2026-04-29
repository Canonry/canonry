import { z } from 'zod'

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
])
export type CheckCategory = z.infer<typeof checkCategorySchema>
export const CheckCategories = checkCategorySchema.enum

export const checkResultSchema = z.object({
  id: z.string(),
  category: checkCategorySchema,
  scope: checkScopeSchema,
  title: z.string(),
  status: checkStatusSchema,
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

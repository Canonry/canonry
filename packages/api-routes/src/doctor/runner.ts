import {
  CheckScopes,
  CheckStatuses,
  summarizeCheckResults,
  type CheckResultDto,
  type DoctorReportDto,
} from '@ainyc/canonry-contracts'
import type { CheckDefinition, DoctorContext, RunChecksOptions } from './types.js'

export function matchesCheckId(checkId: string, filters: string[]): boolean {
  if (filters.length === 0) return true
  for (const filter of filters) {
    if (filter === checkId) return true
    if (filter.endsWith('*')) {
      const prefix = filter.slice(0, -1)
      if (checkId.startsWith(prefix)) return true
    }
  }
  return false
}

export async function runChecks(
  ctx: DoctorContext,
  checks: readonly CheckDefinition[],
  options: RunChecksOptions = {},
): Promise<DoctorReportDto> {
  const startedAt = new Date()
  const filters = options.checkIds ?? []
  const targetScope = ctx.project ? CheckScopes.project : CheckScopes.global
  const projectName = ctx.project?.name ?? null

  const selected = checks.filter(check => {
    if (check.scope !== targetScope) return false
    return matchesCheckId(check.id, filters)
  })

  const results: CheckResultDto[] = []
  for (const definition of selected) {
    const checkStarted = Date.now()
    let output
    try {
      output = await definition.run(ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      output = {
        status: CheckStatuses.fail,
        code: `${definition.id}.runtime-error`,
        summary: `Check threw an unexpected error: ${message}`,
        remediation: null,
        details: { error: message },
      }
    }
    results.push({
      id: definition.id,
      category: definition.category,
      scope: definition.scope,
      title: definition.title,
      status: output.status,
      code: output.code,
      summary: output.summary,
      remediation: output.remediation ?? null,
      details: output.details,
      durationMs: Date.now() - checkStarted,
    })
  }

  return {
    scope: targetScope,
    project: projectName,
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    summary: summarizeCheckResults(results),
    checks: results,
  }
}

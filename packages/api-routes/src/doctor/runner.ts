import {
  CheckNotificationPolicies,
  CheckScopes,
  CheckStatuses,
  summarizeCheckResults,
  reportMonthsForDoctor,
  type CheckResultDto,
  type DoctorReportDto,
  describeError,
} from '@ainyc/canonry-contracts'
import { UNREACHABLE_CODE_SUFFIX, type CheckDefinition, type DoctorContext, type RunChecksOptions } from './types.js'

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
    // An opt-in check is skipped by a default (unfiltered) run and included
    // only when a filter names it, exactly or by wildcard.
    if (check.optIn && filters.length === 0) return false
    return matchesCheckId(check.id, filters)
  })

  const results: CheckResultDto[] = []
  for (const definition of selected) {
    const checkStarted = Date.now()
    let output
    try {
      output = await definition.run(ctx)
    } catch (err) {
      const message = describeError(err)
      output = {
        // An advisory that cannot run is still only an advisory: it must not
        // fail the doctor (and its exit code) the way a broken health check does.
        status: definition.notificationPolicy === CheckNotificationPolicies.silent ? CheckStatuses.warn : CheckStatuses.fail,
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
      ...(definition.notificationPolicy ? { notificationPolicy: definition.notificationPolicy } : {}),
      code: output.code,
      summary: output.summary,
      remediation: output.remediation ?? null,
      details: output.details,
      durationMs: Date.now() - checkStarted,
    })
  }

  const failedCauses = new Set(results.filter((result, index) => namesCause(selected[index]!, result)).map(result => result.id))
  const graded = results.map((result, index) => supersede(selected[index]!, result, failedCauses))

  return {
    scope: targetScope,
    project: projectName,
    ...(ctx.project ? { reportMonths: reportMonthsForDoctor(ctx.reportMonth, startedAt) } : {}),
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    summary: summarizeCheckResults(graded),
    checks: graded,
  }
}

/** A check that threw is broken itself: it neither names a cause nor is a symptom of one. */
function threw(definition: CheckDefinition, result: CheckResultDto): boolean {
  return result.code === `${definition.id}.runtime-error`
}

/**
 * Whether a failing check found something wrong with what it checks, and so
 * can name a symptom's cause. One that threw, or that could not reach its
 * provider, tested nothing: when DNS blocks Google, the auth check's token
 * refresh fails too, and the sync's stored error is what names the cause.
 */
function namesCause(definition: CheckDefinition, result: CheckResultDto): boolean {
  return result.status === CheckStatuses.fail
    && !threw(definition, result)
    && !result.code.endsWith(UNREACHABLE_CODE_SUFFIX)
}

/**
 * A symptom stands aside while a check naming its cause fails (see
 * `CheckDefinition.supersededBy`). The health alert headlines the worst
 * failing check, ranked by category before id, so an expired grant that fails
 * both the auth check and every sync would otherwise be headlined by the sync
 * failure. The original code, status and details stay in `details`.
 */
function supersede(definition: CheckDefinition, result: CheckResultDto, failedCauses: ReadonlySet<string>): CheckResultDto {
  if (result.status !== CheckStatuses.fail && result.status !== CheckStatuses.warn) return result
  if (threw(definition, result)) return result
  const causes = (definition.supersededBy ?? []).filter(id => failedCauses.has(id))
  if (causes.length === 0) return result
  return {
    ...result,
    status: CheckStatuses.skipped,
    code: `${definition.id}.superseded`,
    summary: `Superseded by failing ${causes.join(', ')}, which names the cause. ${result.summary}`,
    remediation: null,
    details: { ...result.details, supersededBy: causes, supersededStatus: result.status, supersededCode: result.code },
  }
}

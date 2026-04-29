import type { CheckResultDto, DoctorReportDto } from '@ainyc/canonry-contracts'
import { CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, EXIT_USER_ERROR } from '../cli-error.js'

interface DoctorOptions {
  project?: string
  checks?: string[]
  format?: string
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  const client = createApiClient()
  const report = await client.runDoctor({
    project: opts.project,
    checkIds: opts.checks,
  })

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHumanReport(report)
  }

  if (report.summary.fail > 0) {
    throw new CliError({
      code: 'DOCTOR_CHECKS_FAILED',
      message: `${report.summary.fail} check${report.summary.fail === 1 ? '' : 's'} failed`,
      exitCode: EXIT_USER_ERROR,
      details: {
        scope: report.scope,
        project: report.project,
        failed: report.checks.filter(c => c.status === CheckStatuses.fail).map(c => c.id),
      },
    })
  }
}

function statusBadge(status: CheckResultDto['status']): string {
  switch (status) {
    case CheckStatuses.ok: return '[ok]   '
    case CheckStatuses.warn: return '[warn] '
    case CheckStatuses.fail: return '[fail] '
    case CheckStatuses.skipped: return '[skip] '
  }
}

function printHumanReport(report: DoctorReportDto): void {
  const header = report.scope === CheckScopes.project && report.project
    ? `canonry doctor — project "${report.project}"`
    : 'canonry doctor — global'
  console.log(`\n${header}`)
  console.log(`(${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail, ${report.summary.skipped} skipped — ${report.durationMs}ms)\n`)

  if (report.checks.length === 0) {
    console.log('No checks matched the requested filter.')
    return
  }

  const grouped = new Map<string, CheckResultDto[]>()
  for (const check of report.checks) {
    const bucket = grouped.get(check.category) ?? []
    bucket.push(check)
    grouped.set(check.category, bucket)
  }

  for (const [category, checks] of grouped) {
    console.log(`${category.toUpperCase()}`)
    for (const check of checks) {
      console.log(`  ${statusBadge(check.status)}${check.id} — ${check.summary}`)
      if (check.remediation) {
        console.log(`         → ${check.remediation}`)
      }
    }
    console.log()
  }
}

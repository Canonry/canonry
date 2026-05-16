import type { CheckResultDto, DoctorReportDto } from '@ainyc/canonry-contracts'
import { CheckScopes, CheckStatuses } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { CliError, EXIT_USER_ERROR } from '../cli-error.js'

interface DoctorOptions {
  project?: string
  /** When true, fan out doctor across every configured project in parallel
   *  AND run the global checks once. Replaces an N+1 loop of `canonry doctor
   *  --project X` invocations for portfolio-level health audits. */
  all?: boolean
  checks?: string[]
  format?: string
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  if (opts.all) {
    await runDoctorAll(opts)
    return
  }

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

/**
 * `canonry doctor --all` — single-call portfolio health audit.
 *
 * Runs the global checks once + the project-scoped checks for every
 * configured project, in parallel. JSON output is a stable object keyed
 * by `'__global__'` + each project name so an agent can index into it
 * directly. Human output is a compact per-project summary line followed
 * by the union of failed-check IDs — operators get the operational
 * picture without scrolling through every passing check across N projects.
 */
async function runDoctorAll(opts: DoctorOptions): Promise<void> {
  const client = createApiClient()
  const projects = await client.listProjects()

  // Global checks ride alongside the per-project fan-out so a single
  // --all invocation covers everything `canonry doctor` could surface.
  const [globalReport, ...projectReports] = await Promise.all([
    client.runDoctor({ checkIds: opts.checks }),
    ...projects.map(p => client.runDoctor({ project: p.name, checkIds: opts.checks })),
  ])

  const byKey: Record<string, DoctorReportDto> = { __global__: globalReport! }
  projects.forEach((p, i) => { byKey[p.name] = projectReports[i]! })

  if (opts.format === 'json') {
    console.log(JSON.stringify(byKey, null, 2))
  } else {
    printAllHumanReport(byKey, projects.map(p => p.name))
  }

  const totalFail =
    globalReport!.summary.fail
    + projectReports.reduce((s, r) => s + r.summary.fail, 0)

  if (totalFail > 0) {
    const failedByScope: Record<string, string[]> = {}
    if (globalReport!.summary.fail > 0) {
      failedByScope.__global__ = globalReport!.checks
        .filter(c => c.status === CheckStatuses.fail).map(c => c.id)
    }
    projects.forEach((p, i) => {
      const failed = projectReports[i]!.checks
        .filter(c => c.status === CheckStatuses.fail).map(c => c.id)
      if (failed.length > 0) failedByScope[p.name] = failed
    })
    throw new CliError({
      code: 'DOCTOR_CHECKS_FAILED',
      message: `${totalFail} check${totalFail === 1 ? '' : 's'} failed across ${Object.keys(failedByScope).length} scope${Object.keys(failedByScope).length === 1 ? '' : 's'}`,
      exitCode: EXIT_USER_ERROR,
      details: { failed: failedByScope },
    })
  }
}

function printAllHumanReport(byKey: Record<string, DoctorReportDto>, projectNames: string[]): void {
  const scopes = ['__global__', ...projectNames]
  console.log(`\ncanonry doctor — all scopes (${scopes.length})\n`)
  for (const key of scopes) {
    const report = byKey[key]!
    const label = key === '__global__' ? 'global' : `project "${key}"`
    const s = report.summary
    const tag = s.fail > 0 ? '[FAIL]' : s.warn > 0 ? '[WARN]' : '[OK]  '
    console.log(`  ${tag} ${label.padEnd(28)} ${s.ok} ok, ${s.warn} warn, ${s.fail} fail, ${s.skipped} skipped`)
    if (s.fail > 0) {
      const failedIds = report.checks
        .filter(c => c.status === CheckStatuses.fail)
        .map(c => `${c.id} — ${c.summary}`)
      for (const line of failedIds) {
        console.log(`           ✗ ${line}`)
      }
    }
  }
  console.log()
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

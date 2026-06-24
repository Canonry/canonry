import fs from 'node:fs'
import path from 'node:path'
import { createApiClient } from '../client.js'
import { renderReportHtml } from '@ainyc/canonry-api-routes'
import { isMachineFormat, type CliFormat } from '../cli-error.js'
import type { ReportAudience, ReportPeriodDays } from '@ainyc/canonry-contracts'

export interface RunReportCommandOptions {
  format?: CliFormat
  /** Render audience for HTML output. JSON always prints the full canonical DTO. */
  audience?: ReportAudience
  /** Report window in days (7/14/30/90). Omitted → server default (30). */
  period?: ReportPeriodDays
  /** Override the output path. Default: `<cwd>/canonry-report-<project>-<audience>-<YYYY-MM-DD>.html`. */
  output?: string
}

function defaultOutputPath(project: string, audience: ReportAudience): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.resolve(process.cwd(), `canonry-report-${project}-${audience}-${date}.html`)
}

export async function runReportCommand(
  project: string,
  opts: RunReportCommandOptions = {},
): Promise<void> {
  const client = createApiClient()
  const report = await client.getReport(project, opts.period !== undefined ? { period: opts.period } : undefined)
  const audience = opts.audience ?? 'agency'

  if (isMachineFormat(opts.format)) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const html = renderReportHtml(report, { audience })
  const targetPath = opts.output ? path.resolve(opts.output) : defaultOutputPath(project, audience)

  const dir = path.dirname(targetPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(targetPath, html, 'utf-8')
  console.log(`Report written to ${targetPath}`)
}

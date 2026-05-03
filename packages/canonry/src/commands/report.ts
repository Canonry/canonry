import fs from 'node:fs'
import path from 'node:path'
import { createApiClient } from '../client.js'
import { renderReportHtml } from '../report-renderer.js'
import type { CliFormat } from '../cli-error.js'

export interface RunReportCommandOptions {
  format?: CliFormat
  /** Override the output path. Default: `<cwd>/canonry-report-<project>-<YYYY-MM-DD>.html`. */
  output?: string
}

function defaultOutputPath(project: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.resolve(process.cwd(), `canonry-report-${project}-${date}.html`)
}

export async function runReportCommand(
  project: string,
  opts: RunReportCommandOptions = {},
): Promise<void> {
  const client = createApiClient()
  const report = await client.getReport(project)

  if (opts.format === 'json') {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const html = renderReportHtml(report)
  const targetPath = opts.output ? path.resolve(opts.output) : defaultOutputPath(project)

  const dir = path.dirname(targetPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(targetPath, html, 'utf-8')
  console.log(`Report written to ${targetPath}`)
}

import fs from 'node:fs'
import path from 'node:path'
import type { ResultsExportFormat } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

export interface ExportResultsOptions {
  format: ResultsExportFormat
  since?: string
  until?: string
  includeProbes?: boolean
  /** File path, or `-` for stdout. Defaults to the server-suggested filename in the current directory. */
  output?: string
}

/** Download historical answer-engine observations without conflating them with project config export. */
export async function exportResults(project: string, opts: ExportResultsOptions): Promise<void> {
  const { output, ...request } = opts
  const artifact = await createApiClient().downloadResultsExport(project, request)
  if (output === '-') {
    process.stdout.write(artifact.content)
    return
  }

  const target = output
    ? path.resolve(output)
    : path.resolve(process.cwd(), path.basename(artifact.filename))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, artifact.content, 'utf8')
  console.log(`Results export written to ${target}`)
}

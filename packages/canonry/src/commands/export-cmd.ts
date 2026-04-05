import { stringify } from 'yaml'
import { createApiClient, type ExportDto } from '../client.js'

export async function exportProject(
  project: string,
  opts: { includeResults?: boolean; format?: string },
): Promise<void> {
  const client = createApiClient()

  const data: ExportDto = await client.getExport(project)

  if (opts.includeResults) {
    // Fetch latest run data and include as annotation
    try {
      const runs = await client.listRuns(project) as Array<{ id: string }>
      if (runs.length > 0) {
        const latestRun = await client.getRun(runs[runs.length - 1]!.id)
        data.results = latestRun
      }
    } catch {
      // Results not available, skip
    }
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(stringify(data))
}

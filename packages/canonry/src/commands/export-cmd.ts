import { stringify } from 'yaml'
import { createApiClient, type ExportDto } from '../client.js'

export async function exportProject(
  project: string,
  opts: { includeResults?: boolean; format?: string },
): Promise<void> {
  const client = createApiClient()

  const data: ExportDto = await client.getExport(project)

  if (opts.includeResults) {
    // Fetch latest run data and include as annotation.
    try {
      const latest = await client.getLatestRun(project)
      if (latest.run) {
        data.results = latest.run
      }
    } catch {
      // Fall back to older servers that do not yet expose /runs/latest.
      try {
        const runs = await client.listRuns(project)
        if (runs.length > 0) {
          const latestRun = runs.reduce((current, candidate) =>
            candidate.createdAt > current.createdAt ? candidate : current,
          )
          data.results = await client.getRun(latestRun.id)
        }
      } catch {
        // Results not available, skip
      }
    }
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(stringify(data))
}

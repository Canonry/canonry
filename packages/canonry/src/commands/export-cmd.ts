import { stringify } from 'yaml'
import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

export async function exportProject(
  project: string,
  opts: { includeResults?: boolean; format?: string },
): Promise<void> {
  const config = loadConfig()
  const client = new ApiClient(config.apiUrl, config.apiKey)

  const data = await client.getExport(project) as {
    apiVersion: string
    kind: string
    metadata: { name: string; labels: Record<string, string> }
    spec: {
      displayName: string
      canonicalDomain: string
      country: string
      language: string
      keywords: string[]
      competitors: string[]
    }
  }

  if (opts.includeResults) {
    // Fetch latest run data and include as annotation
    try {
      const runs = await client.listRuns(project) as Array<{ id: string }>
      if (runs.length > 0) {
        const latestRun = await client.getRun(runs[runs.length - 1]!.id)
        ;(data as Record<string, unknown>).results = latestRun
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

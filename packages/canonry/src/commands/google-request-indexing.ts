import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

interface RequestIndexingOptions {
  allUnindexed?: boolean
  wait?: boolean
  format?: string
}

interface RequestIndexingResult {
  url: string
  notifiedAt: string
  type: string
}

export async function googleRequestIndexing(
  project: string,
  url: string | undefined,
  options: RequestIndexingOptions,
): Promise<void> {
  const client = getClient()

  if (options.allUnindexed) {
    const results = await client.gscRequestIndexingAll(project) as RequestIndexingResult[]
    if (options.format === 'json') {
      console.log(JSON.stringify(results, null, 2))
      return
    }
    for (const r of results) {
      console.log(`Indexing requested: ${r.url}`)
      console.log(`  Notified at: ${r.notifiedAt}`)
      console.log(`  Type: ${r.type}`)
    }
    return
  }

  if (!url) {
    console.error('Error: URL or --all-unindexed is required')
    process.exit(1)
  }

  const result = await client.gscRequestIndexing(project, url, { wait: options.wait }) as RequestIndexingResult

  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Indexing requested: ${result.url}`)
  console.log(`  Notified at: ${result.notifiedAt}`)
  console.log(`  Type: ${result.type}`)
}

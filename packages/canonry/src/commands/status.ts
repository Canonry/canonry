import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function showStatus(project: string): Promise<void> {
  const client = getClient()
  const projectData = await client.getProject(project) as {
    id: string
    name: string
    displayName: string
    canonicalDomain: string
    country: string
    language: string
  }

  console.log(`Status: ${projectData.displayName} (${projectData.name})\n`)
  console.log(`  Domain:   ${projectData.canonicalDomain}`)
  console.log(`  Country:  ${projectData.country}`)
  console.log(`  Language: ${projectData.language}`)

  // Try to get latest run info
  try {
    const runs = await client.listRuns(project) as Array<{
      id: string
      status: string
      kind: string
      createdAt: string
      finishedAt: string | null
    }>

    if (runs.length > 0) {
      const latest = runs[runs.length - 1]!
      console.log(`\n  Latest run:`)
      console.log(`    ID:       ${latest.id}`)
      console.log(`    Status:   ${latest.status}`)
      console.log(`    Created:  ${latest.createdAt}`)
      if (latest.finishedAt) {
        console.log(`    Finished: ${latest.finishedAt}`)
      }
      console.log(`\n  Total runs: ${runs.length}`)
    } else {
      console.log('\n  No runs yet. Use "canonry run" to trigger one.')
    }
  } catch {
    // Runs endpoint may not be available
    console.log('\n  Run info unavailable.')
  }
}

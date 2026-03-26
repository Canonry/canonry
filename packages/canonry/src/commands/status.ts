import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

export async function showStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const projectData = await client.getProject(project) as {
    id: string
    name: string
    displayName: string
    canonicalDomain: string
    country: string
    language: string
  }

  let runs: Array<{ id: string; status: string; kind: string; createdAt: string; finishedAt: string | null }> = []
  try {
    runs = await client.listRuns(project) as typeof runs
  } catch {
    // Runs endpoint may not be available
  }

  if (format === 'json') {
    console.log(JSON.stringify({ project: projectData, runs }, null, 2))
    return
  }

  console.log(`Status: ${projectData.displayName} (${projectData.name})\n`)
  console.log(`  Domain:   ${projectData.canonicalDomain}`)
  console.log(`  Country:  ${projectData.country}`)
  console.log(`  Language: ${projectData.language}`)

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
}

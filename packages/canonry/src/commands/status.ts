import type { ProjectDto, RunDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'

function getClient() {
  return createApiClient()
}

export async function showStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const projectData: ProjectDto = await client.getProject(project)

  let runs: RunDto[] = []
  try {
    runs = await client.listRuns(project)
  } catch {
    // Runs endpoint may not be available (e.g. older server)
  }

  if (format === 'json') {
    console.log(JSON.stringify({ project: projectData, runs }, null, 2))
    return
  }

  console.log(`Status: ${projectData.displayName ?? projectData.name} (${projectData.name})\n`)
  console.log(`  Domain:   ${projectData.canonicalDomain}`)
  console.log(`  Country:  ${projectData.country}`)
  console.log(`  Language: ${projectData.language}`)

  if (runs.length > 0) {
    // Derive the latest run from timestamps instead of relying on API ordering.
    const latest = runs.reduce((current, candidate) =>
      candidate.createdAt > current.createdAt ? candidate : current,
    )
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

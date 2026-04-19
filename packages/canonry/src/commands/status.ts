import type { ProjectDto, RunDto } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isEndpointMissing } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function showStatus(project: string, format?: string): Promise<void> {
  const client = getClient()
  const projectData: ProjectDto = await client.getProject(project)
  const latest = await getLatestRunSummary(client, project)

  if (format === 'json') {
    let runs: RunDto[] = []
    try {
      runs = await client.listRuns(project)
    } catch {
      // Runs endpoint may not be available (e.g. older server)
    }
    console.log(JSON.stringify({
      project: projectData,
      runs,
      latestRun: latest.run,
      totalRuns: latest.totalRuns,
    }, null, 2))
    return
  }

  console.log(`Status: ${projectData.displayName ?? projectData.name} (${projectData.name})\n`)
  console.log(`  Domain:   ${projectData.canonicalDomain}`)
  console.log(`  Country:  ${projectData.country}`)
  console.log(`  Language: ${projectData.language}`)

  if (latest.run) {
    console.log(`\n  Latest run:`)
    console.log(`    ID:       ${latest.run.id}`)
    console.log(`    Status:   ${latest.run.status}`)
    console.log(`    Created:  ${latest.run.createdAt}`)
    if (latest.run.finishedAt) {
      console.log(`    Finished: ${latest.run.finishedAt}`)
    }
    console.log(`\n  Total runs: ${latest.totalRuns}`)
  } else {
    console.log('\n  No runs yet. Use "canonry run" to trigger one.')
  }
}

async function getLatestRunSummary(
  client: ReturnType<typeof getClient>,
  project: string,
): Promise<{ totalRuns: number; run: RunDto | null }> {
  try {
    return await client.getLatestRun(project)
  } catch (err) {
    if (!isEndpointMissing(err)) throw err
    // Older server predating /runs/latest — fall back to list + client-side reduce.
    const runs = await client.listRuns(project)
    if (runs.length === 0) {
      return { totalRuns: 0, run: null }
    }
    const latestRun = runs.reduce((current, candidate) =>
      candidate.createdAt > current.createdAt ? candidate : current,
    )
    return {
      totalRuns: runs.length,
      run: latestRun,
    }
  }
}

import type { InstanceStatusDto, LatestProjectRunDto, ProjectDto, RunDto } from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isEndpointMissing, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import { runAdmissionLines } from './run.js'

function getClient() {
  return createApiClient()
}

export async function showStatus(project: string | undefined, format?: string, options: { all?: boolean; problems?: boolean } = {}): Promise<void> {
  const client = getClient()
  if (options.all) {
    const status = await client.getStatus({ problems: options.problems })
    if (format === 'jsonl') {
      emitJsonl(status.projects.flatMap(item => item.integrations.length > 0
        ? item.integrations.map(row => ({ project: item.project, health: item.health, ...row }))
        : [{ project: item.project, state: item.state, health: item.health }]))
      return
    }
    if (isMachineFormat(format)) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    for (const item of status.projects) {
      console.log(`Status: ${item.displayName} (${item.project})`)
      console.log(`  State: ${item.state}`)
      if (item.health) console.log(`  Health: ${item.health.status} ${item.health.summary}`)
      for (const row of item.integrations) {
        console.log(`  ${row.label}: ${row.state} (last success: ${row.lastSuccessAt ?? 'never'}; streak: ${row.consecutiveFailures}; data through: ${row.dataThrough ?? 'unknown'}; data age: ${row.dataAgeDays === null ? 'unknown' : `${row.dataAgeDays} days`}; latest error: ${row.latestError ?? 'none'})`)
      }
      console.log('')
    }
    return
  }
  if (!project) throw new Error('A project is required unless --all is used.')
  const projectData: ProjectDto = await client.getProject(project)
  const latest = await getLatestRunSummary(client, project)
  let storedStatus: InstanceStatusDto | null = null
  try {
    storedStatus = await client.getStatus({ project, problems: options.problems })
  } catch (error) {
    if (!isEndpointMissing(error)) throw error
  }

  if (isMachineFormat(format)) {
    let runs: RunDto[] = []
    try {
      runs = await client.listRuns(project)
    } catch {
      // Runs endpoint may not be available (e.g. older server)
    }
    const result = {
      project: projectData,
      runs,
      latestRun: latest.run,
      totalRuns: latest.totalRuns,
      // Absent from a server that predates it.
      ...(latest.admission ? { admission: latest.admission } : {}),
      ...(latest.manualAdmission ? { manualAdmission: latest.manualAdmission } : {}),
      ...(storedStatus?.projects[0] ? { integrations: storedStatus.projects[0].integrations, health: storedStatus.projects[0].health } : {}),
    }
    if (format === 'jsonl') emitJsonl([result])
    else console.log(JSON.stringify(result, null, 2))
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
    // A project name is free text up to 120 characters, so a suggestion the
    // operator is meant to paste has to survive a space in one.
    const projectArg = /^[\w.-]+$/.test(project)
      ? project
      : `'${project.replaceAll("'", `'\\''`)}'`
    console.log(`\n  No runs yet. Capture Page Health with "canonry technical-aeo run ${projectArg}", or run an AI Visibility sweep after adding a provider.`)
  }

  const admission = runAdmissionLines(project, latest.admission, latest.manualAdmission)
  if (admission.length > 0) console.log(`\n${admission.map(line => `  ${line}`).join('\n')}`)
  const projectStatus = storedStatus?.projects[0]
  if (projectStatus) {
    console.log(`\n  Health: ${projectStatus.health?.status ?? 'unknown'}`)
    for (const row of projectStatus.integrations) console.log(`  ${row.label}: ${row.state}`)
  }
}

async function getLatestRunSummary(
  client: ReturnType<typeof getClient>,
  project: string,
): Promise<LatestProjectRunDto> {
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

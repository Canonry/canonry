import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function triggerRun(project: string, opts?: { provider?: string }): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts?.provider) {
    body.providers = [opts.provider]
  }
  const run = await client.triggerRun(project, body) as {
    id: string
    status: string
    kind: string
  }
  console.log(`Run created: ${run.id}`)
  console.log(`  Kind:   ${run.kind}`)
  console.log(`  Status: ${run.status}`)
  if (opts?.provider) {
    console.log(`  Provider: ${opts.provider}`)
  }
}

export async function listRuns(project: string): Promise<void> {
  const client = getClient()
  const runs = await client.listRuns(project) as Array<{
    id: string
    status: string
    kind: string
    trigger: string
    startedAt: string | null
    finishedAt: string | null
    createdAt: string
  }>

  if (runs.length === 0) {
    console.log(`No runs found for "${project}".`)
    return
  }

  console.log(`Runs for "${project}" (${runs.length}):\n`)
  console.log('  ID                                    STATUS      KIND                TRIGGER    CREATED')
  console.log('  ────────────────────────────────────  ──────────  ──────────────────  ─────────  ───────────────────────')

  for (const run of runs) {
    console.log(
      `  ${run.id}  ${run.status.padEnd(10)}  ${run.kind.padEnd(18)}  ${run.trigger.padEnd(9)}  ${run.createdAt}`,
    )
  }
}

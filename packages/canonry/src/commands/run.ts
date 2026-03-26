import { ApiClient, createApiClient } from '../client.js'
import { resolveProviderInput } from '@ainyc/canonry-contracts'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])

export async function triggerRun(project: string, opts?: { provider?: string; wait?: boolean; format?: string; location?: string; allLocations?: boolean; noLocation?: boolean }): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts?.provider) {
    // Support comma-separated providers and 'cdp' shorthand expansion
    const providerInputs = opts.provider.split(',').map(s => s.trim()).filter(Boolean)
    const resolved = providerInputs.flatMap(p => resolveProviderInput(p))
    body.providers = resolved.length > 0 ? resolved : providerInputs
  }
  if (opts?.location) {
    body.location = opts.location
  }
  if (opts?.allLocations) {
    body.allLocations = true
  }
  if (opts?.noLocation) {
    body.noLocation = true
  }
  const response = await client.triggerRun(project, body)

  // allLocations returns HTTP 207 with an array of per-location run objects
  if (Array.isArray(response)) {
    const locationRuns = response as Array<{ id: string; status: string; kind: string; location?: string; error?: string }>
    if (opts?.format === 'json') {
      if (opts?.wait) {
        const settled = await Promise.all(
          locationRuns.map(async (r) => {
            if (!r.id || r.status === 'conflict') return r
            const final = await pollRun(client, r.id)
            return { ...r, ...(final as object) }
          }),
        )
        console.log(JSON.stringify(settled, null, 2))
      } else {
        console.log(JSON.stringify(locationRuns, null, 2))
      }
      return
    }

    console.log(`Triggered ${locationRuns.length} location sweep(s) — ${locationRuns.length}× API calls:\n`)
    console.log('  LOCATION         RUN ID                                STATUS')
    console.log('  ───────────────  ────────────────────────────────────  ──────────')
    for (const r of locationRuns) {
      const loc = (r.location ?? '(unknown)').padEnd(15)
      const id = (r.id ?? '(conflict)').padEnd(36)
      console.log(`  ${loc}  ${id}  ${r.status}`)
    }

    if (opts?.wait) {
      const pending = locationRuns.filter(r => r.id && r.status !== 'conflict')
      if (pending.length > 0) {
        process.stderr.write(`Waiting for ${pending.length} run(s)`)
        await Promise.all(
          pending.map(async (r) => {
            const final = await pollRun(client, r.id)
            r.status = (final as { status: string }).status
          }),
        )
        process.stderr.write('\n')
        console.log('\nFinal statuses:')
        for (const r of locationRuns) {
          const loc = (r.location ?? '(unknown)').padEnd(15)
          console.log(`  ${loc}  ${r.status}`)
        }
      }
    }
    return
  }

  const run = response as { id: string; status: string; kind: string }

  if (opts?.wait) {
    process.stderr.write(`Run ${run.id} started`)
    const result = await pollRun(client, run.id)
    if (opts?.format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      process.stderr.write('\n')
      printRunDetail(result as Record<string, unknown>)
    }
    return
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  console.log(`Run created: ${run.id}`)
  console.log(`  Kind:   ${run.kind}`)
  console.log(`  Status: ${run.status}`)
  if (opts?.provider) {
    console.log(`  Provider: ${opts.provider}`)
  }
}

export async function triggerRunAll(opts?: { provider?: string; wait?: boolean; format?: string }): Promise<void> {
  const client = getClient()
  const projects = await client.listProjects() as Array<{ name: string }>

  if (projects.length === 0) {
    if (opts?.format === 'json') {
      console.log('[]')
    } else {
      console.log('No projects found.')
    }
    return
  }

  const body: Record<string, unknown> = {}
  if (opts?.provider) {
    const providerInputs = opts.provider.split(',').map(s => s.trim()).filter(Boolean)
    const resolved = providerInputs.flatMap(p => resolveProviderInput(p))
    body.providers = resolved.length > 0 ? resolved : providerInputs
  }

  const results: Array<{ project: string; runId: string; status: string; error?: string }> = []

  for (const p of projects) {
    try {
      const run = await client.triggerRun(p.name, body) as { id: string; status: string }
      results.push({ project: p.name, runId: run.id, status: run.status })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ project: p.name, runId: '', status: 'error', error: msg })
    }
  }

  if (opts?.wait) {
    const pending = results.filter(r => r.runId && !TERMINAL_STATUSES.has(r.status))
    if (pending.length > 0) {
      process.stderr.write(`Waiting for ${pending.length} run(s)`)
      await Promise.all(pending.map(async (r) => {
        const final = await pollRun(client, r.runId)
        r.status = (final as { status: string }).status
      }))
      process.stderr.write('\n')
    }
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  console.log(`Triggered ${results.length} run(s):\n`)
  console.log('  PROJECT                          RUN ID                                STATUS')
  console.log('  ───────────────────────────────  ────────────────────────────────────  ──────────')
  for (const r of results) {
    const proj = r.project.padEnd(31)
    const id = (r.runId || '(failed)').padEnd(36)
    console.log(`  ${proj}  ${id}  ${r.status}`)
  }
}

export async function cancelRun(project: string, runId?: string, format?: string): Promise<void> {
  const client = getClient()

  // If no run ID given, find the active run for the project
  let targetId = runId
  if (!targetId) {
    const runs = await client.listRuns(project) as Array<{ id: string; status: string }>
    const active = runs.find(r => r.status === 'queued' || r.status === 'running')
    if (!active) {
      throw new CliError({
        code: 'NO_ACTIVE_RUN',
        message: `No active run found for project "${project}"`,
        displayMessage:
          `Error: canonry run cancel "${project}" — no active run found (status must be queued or running).\n` +
          `Check run status : canonry status ${project}\n` +
          `To cancel by ID  : canonry run cancel ${project} <run-id>`,
        details: {
          project,
          allowedStatuses: ['queued', 'running'],
          suggestedCommands: [
            `canonry status ${project}`,
            `canonry run cancel ${project} <run-id>`,
          ],
        },
      })
    }
    targetId = active.id
  }

  const result = await client.cancelRun(targetId) as { id: string; status: string }

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Run ${result.id} cancelled.`)
}

export async function showRun(id: string, format?: string): Promise<void> {
  const client = getClient()
  const run = await client.getRun(id) as Record<string, unknown>

  if (format === 'json') {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  printRunDetail(run)
}

export async function listRuns(project: string, opts?: { format?: string; limit?: number }): Promise<void> {
  const client = getClient()
  const runs = await client.listRuns(project, opts?.limit) as Array<{
    id: string
    status: string
    kind: string
    trigger: string
    startedAt: string | null
    finishedAt: string | null
    createdAt: string
  }>

  if (opts?.format === 'json') {
    console.log(JSON.stringify(runs, null, 2))
    return
  }

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

const POLL_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

async function pollRun(client: ApiClient, runId: string): Promise<object> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    await new Promise(r => setTimeout(r, 2000))
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for run ${runId} after ${POLL_TIMEOUT_MS / 1000}s`)
    }
    const run = await client.getRun(runId) as { status: string }
    process.stderr.write('.')
    if (TERMINAL_STATUSES.has(run.status)) {
      return run as object
    }
  }
}

function printRunDetail(run: Record<string, unknown>): void {
  console.log(`Run: ${run.id}`)
  console.log(`  Status:   ${run.status}`)
  console.log(`  Kind:     ${run.kind}`)
  if (run.trigger) console.log(`  Trigger:  ${run.trigger}`)
  if (run.startedAt) console.log(`  Started:  ${run.startedAt}`)
  if (run.finishedAt) console.log(`  Finished: ${run.finishedAt}`)
  if (run.createdAt) console.log(`  Created:  ${run.createdAt}`)
  if (run.error) console.log(`  Error:    ${run.error}`)
  const snapshots = run.snapshots as Array<Record<string, unknown>> | undefined
  if (snapshots && snapshots.length > 0) {
    console.log(`\n  Snapshots: ${snapshots.length}`)
    for (const s of snapshots) {
      const state = s.citationState === 'cited' ? '  cited    ' : '  not-cited'
      const modelLabel = s.model ? ` (${s.model})` : ''
      console.log(`    ${state}  ${s.provider}${modelLabel}  ${s.keyword}`)
    }
  }
}

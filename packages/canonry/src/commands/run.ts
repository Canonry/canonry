import { type ApiClient, createApiClient } from '../client.js'
import { CitationStates, resolveProviderInput, type RunDetailDto } from '@ainyc/canonry-contracts'
import { CliError, isMachineFormat } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'

function getClient() {
  return createApiClient()
}

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled'])

export async function triggerRun(project: string, opts?: { provider?: string; queries?: string[]; wait?: boolean; format?: string; location?: string; allLocations?: boolean; noLocation?: boolean; probe?: boolean }): Promise<void> {
  const client = getClient()
  const body: Record<string, unknown> = {}
  if (opts?.provider) {
    // Support comma-separated providers and 'cdp' shorthand expansion
    const providerInputs = opts.provider.split(',').map(s => s.trim()).filter(Boolean)
    const resolved = providerInputs.flatMap(p => resolveProviderInput(p))
    body.providers = resolved.length > 0 ? resolved : providerInputs
  }
  if (opts?.queries?.length) {
    body.queries = opts.queries
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
  if (opts?.probe) {
    body.trigger = 'probe'
  }
  const response = await client.triggerRun(project, body)

  // allLocations returns HTTP 207 with an array of per-location run objects
  if (Array.isArray(response)) {
    const locationRuns = response as Array<{ id: string; status: string; kind: string; location?: string; error?: string }>
    if (isMachineFormat(opts?.format)) {
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
      const pending = locationRuns.filter(r => r.id && r.status !== 'conflict' && !TERMINAL_STATUSES.has(r.status))
      if (pending.length > 0) {
        process.stderr.write(`Waiting for ${pending.length} run(s)`)
        await Promise.all(
          pending.map(async (r) => {
            const final = await pollRun(client, r.id)
            r.status = final.status
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

  if (opts?.wait && run.id && !TERMINAL_STATUSES.has(run.status)) {
    process.stderr.write(`Run ${run.id} started`)
    const result = await pollRun(client, run.id)
    if (isMachineFormat(opts?.format)) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      process.stderr.write('\n')
      printRunDetail(result)
    }
    return
  }

  if (opts?.wait && (TERMINAL_STATUSES.has(run.status) || !run.id)) {
    // If it's already finished or failed to start, don't poll
    const result = run.id ? await client.getRun(run.id) : run as unknown as RunDetailDto
    if (isMachineFormat(opts?.format)) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      printRunDetail(result)
    }
    return
  }

  if (isMachineFormat(opts?.format)) {
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

export async function triggerRunAll(opts?: { provider?: string; wait?: boolean; format?: string; allLocations?: boolean; noLocation?: boolean }): Promise<void> {
  const client = getClient()
  // Use full ProjectDto (not Array<{name}>) so we can check each
  // project's `locations` per-iteration. `listProjects()` already returns
  // the full DTO including `locations` and `defaultLocation`.
  const projects = await client.listProjects()

  if (projects.length === 0) {
    if (isMachineFormat(opts?.format)) {
      console.log('[]')
    } else {
      console.log('No projects found.')
    }
    return
  }

  const baseBody: Record<string, unknown> = {}
  if (opts?.provider) {
    const providerInputs = opts.provider.split(',').map(s => s.trim()).filter(Boolean)
    const resolved = providerInputs.flatMap(p => resolveProviderInput(p))
    baseBody.providers = resolved.length > 0 ? resolved : providerInputs
  }
  if (opts?.allLocations) {
    baseBody.allLocations = true
  }
  if (opts?.noLocation) {
    baseBody.noLocation = true
  }

  // `location: string | null` distinguishes the multi-location fan-out
  // rows (one per configured location) from locationless / single-
  // location runs. JSON output gains this field; the table output adds
  // a corresponding LOCATION column. Both are additive — existing JSON
  // consumers that ignore unknown fields keep working.
  const results: Array<{ project: string; runId: string; status: string; location: string | null; error?: string }> = []

  for (const p of projects) {
    // Per-project body: drop `allLocations` when the project has no
    // locations configured. The API correctly 400s `allLocations: true`
    // on a 0-location project (the flag requests fan-out across a
    // dimension that doesn't exist), but applying that strictly in a
    // multi-project `--all` loop means one mis-configured project takes
    // down the rest of the sweep. We drop the flag locally — the
    // remaining body falls through to a single locationless run, same
    // as `cnry run <project>` would do on the same project — and let
    // the loud 400 surface only when a user explicitly aimed
    // `--all-locations` at a single 0-location project.
    const body: Record<string, unknown> = { ...baseBody }
    if (body.allLocations && p.locations.length === 0) {
      delete body.allLocations
    }

    try {
      // Response shape varies by code path:
      //   - `allLocations: true` + locations present → 207 + RunDto[] (one per location)
      //   - everything else → 201 + RunDto (single run)
      // Normalize to an array so we record one results row per dispatched
      // run. Without this, multi-location projects had their entire fan-out
      // collapsed into `{ runId: undefined, status: undefined }` and
      // displayed as `(failed)` even when every per-location run was queued.
      const response = await client.triggerRun(p.name, body)
      const dispatched = Array.isArray(response) ? response : [response]
      for (const r of dispatched) {
        results.push({
          project: p.name,
          runId: r.id,
          status: r.status,
          location: r.location ?? null,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ project: p.name, runId: '', status: 'error', location: null, error: msg })
    }
  }

  if (opts?.wait) {
    const pending = results.filter(r => r.runId && !TERMINAL_STATUSES.has(r.status))
    if (pending.length > 0) {
      process.stderr.write(`Waiting for ${pending.length} run(s)`)
      await Promise.all(pending.map(async (r) => {
        const final = await pollRun(client, r.runId)
        r.status = final.status
      }))
      process.stderr.write('\n')
    }
  }

  if (isMachineFormat(opts?.format)) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  // Show a LOCATION column only when at least one row has a location set
  // — keeps the older single-location-everywhere display clean and adds
  // the column the moment any per-location fan-out happens in the sweep.
  const showLocationColumn = results.some(r => r.location !== null)
  const projectCount = new Set(results.map(r => r.project)).size
  console.log(`Triggered ${results.length} run(s) across ${projectCount} project(s):\n`)
  if (showLocationColumn) {
    console.log('  PROJECT                          LOCATION         RUN ID                                STATUS')
    console.log('  ───────────────────────────────  ───────────────  ────────────────────────────────────  ──────────')
    for (const r of results) {
      const proj = r.project.padEnd(31)
      const loc = (r.location ?? '—').padEnd(15)
      const id = (r.runId || '(failed)').padEnd(36)
      console.log(`  ${proj}  ${loc}  ${id}  ${r.status}`)
    }
  } else {
    console.log('  PROJECT                          RUN ID                                STATUS')
    console.log('  ───────────────────────────────  ────────────────────────────────────  ──────────')
    for (const r of results) {
      const proj = r.project.padEnd(31)
      const id = (r.runId || '(failed)').padEnd(36)
      console.log(`  ${proj}  ${id}  ${r.status}`)
    }
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

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Run ${result.id} cancelled.`)
}

export async function showRun(id: string, format?: string): Promise<void> {
  const client = getClient()
  const run = await client.getRun(id)

  if (isMachineFormat(format)) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  printRunDetail(run)
}

export async function listRuns(project: string, opts?: { format?: string; limit?: number; kind?: string }): Promise<void> {
  const client = getClient()
  const runs = await client.listRuns(project, opts?.limit, opts?.kind) as Array<{
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
  } else if (opts?.format === 'jsonl') {
    // Prepend `project` (the line loses it when lifted out of the per-project
    // envelope); spread the run last so its own fields win. Probe runs stay in.
    emitJsonl(runs.map(run => ({ project, ...run })))
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

async function pollRun(client: ApiClient, runId: string): Promise<RunDetailDto> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    await new Promise(r => setTimeout(r, 2000))
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for run ${runId} after ${POLL_TIMEOUT_MS / 1000}s`)
    }
    const run = await client.getRun(runId)
    process.stderr.write('.')
    if (TERMINAL_STATUSES.has(run.status)) {
      return run
    }
  }
}

export function printRunDetail(run: RunDetailDto): void {
  console.log(`Run: ${run.id}`)
  console.log(`  Status:   ${run.status}`)
  console.log(`  Kind:     ${run.kind}`)
  if (run.trigger) console.log(`  Trigger:  ${run.trigger}`)
  if (run.startedAt) console.log(`  Started:  ${run.startedAt}`)
  if (run.finishedAt) console.log(`  Finished: ${run.finishedAt}`)
  if (run.createdAt) console.log(`  Created:  ${run.createdAt}`)
  if (run.error) {
    if (run.error.message) console.log(`  Error:    ${run.error.message}`)
    if (run.error.providers) {
      for (const [provider, detail] of Object.entries(run.error.providers)) {
        console.log(`  Error (${provider}): ${detail.message}`)
      }
    }
  }
  if (run.snapshots && run.snapshots.length > 0) {
    console.log(`\n  Snapshots: ${run.snapshots.length}  (cell = [citation][mention];  C=cited c=not, M=mentioned m=not, –=no data)`)
    for (const s of run.snapshots) {
      const citationGlyph = s.citationState === CitationStates.cited ? 'C' : 'c'
      const mentionGlyph = typeof s.answerMentioned === 'boolean'
        ? (s.answerMentioned ? 'M' : 'm')
        : '–'
      const modelLabel = s.model ? ` (${s.model})` : ''
      console.log(`    [${citationGlyph}${mentionGlyph}]  ${s.provider}${modelLabel}  ${s.query}`)
    }
  }
}

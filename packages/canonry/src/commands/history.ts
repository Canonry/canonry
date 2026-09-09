import { createApiClient } from '../client.js'
import { CliError } from '../cli-error.js'
import { emitJsonl } from '../cli-output.js'
import type { AuditLogEntry } from '@ainyc/canonry-contracts'
import { resultsClearRequestSchema, describeError } from '@ainyc/canonry-contracts'

function getClient() {
  return createApiClient()
}

interface HistoryOptions {
  limit?: number
  since?: string
  action?: string
  actor?: string
  entityType?: string
}

function originLabel(entry: AuditLogEntry): string {
  const userAgent = entry.userAgent?.toLowerCase() ?? ''
  if (userAgent.includes('canonry-mcp')) return 'mcp'
  if (userAgent.includes('canonry-cli')) return 'cli'
  if (userAgent.includes('mozilla/')) return 'dashboard'
  return entry.actor
}

export async function showHistory(project: string | undefined, format?: string, opts: HistoryOptions = {}): Promise<void> {
  const client = getClient()

  try {
    const entries = project
      ? await client.getHistory(project, opts)
      : await client.getGlobalHistory(opts)

    if (format === 'json') {
      console.log(JSON.stringify(entries, null, 2))
      return
    }

    if (format === 'jsonl') {
      // One self-contained audit entry per line. Each line carries `project`
      // (the arg the handler received) so a line lifted out of the stream still
      // says which project it describes; the entry's own fields win (spread last).
      emitJsonl(entries.map(entry => ({ project: project ?? null, ...entry })))
      return
    }

    if (entries.length === 0) {
      console.log(project ? `No audit history for "${project}".` : 'No instance audit history.')
      return
    }

    console.log(`${project ? `Audit history for "${project}"` : 'Instance audit history'} (${entries.length}):\n`)
    console.log('  TIMESTAMP                ACTION              ENTITY TYPE  ORIGIN')
    console.log('  ───────────────────────  ──────────────────  ───────────  ─────────')

    for (const entry of entries) {
      console.log(
        `  ${entry.createdAt.padEnd(23)}  ${entry.action.padEnd(18)}  ${entry.entityType.padEnd(11)}  ${originLabel(entry)}`,
      )
      if (entry.actorSession) console.log(`    session: ${entry.actorSession}`)
      if (entry.diff != null) console.log(`    diff: ${JSON.stringify(entry.diff)}`)
    }
  } catch (err: unknown) {
    const message = describeError(err)
    throw new CliError({
      code: 'HISTORY_FETCH_FAILED',
      message: project ? `Failed to fetch history for project "${project}"` : 'Failed to fetch instance history',
      displayMessage: `Failed to fetch history: ${message}`,
      details: {
        project: project ?? null,
        cause: message,
      },
    })
  }
}

export async function clearResults(project: string, opts: { runIds: string[]; researchRunIds: string[]; confirm: boolean; format?: string }): Promise<void> {
  const request = resultsClearRequestSchema.safeParse({ runIds: opts.runIds, researchRunIds: opts.researchRunIds, confirm: opts.confirm })
  if (!request.success) throw new CliError({ code: 'INVALID_ARGUMENT', message: request.error.issues.map(issue => issue.message).join(' '), exitCode: 1 })
  const result = await getClient().clearResults(project, request.data)
  if (opts.format === 'jsonl') emitJsonl([result])
  else if (opts.format === 'json') console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.dryRun ? 'Would clear' : 'Cleared'} ${result.runIds.length} visibility runs and ${result.researchRunIds.length} research batches.`)
    console.log(`${result.querySnapshots} saved visibility answers; ${result.researchQueries} research queries.`)
    if (result.dryRun) console.log('Back up the evidence, then repeat with --confirm to delete these exact runs.')
  }
}

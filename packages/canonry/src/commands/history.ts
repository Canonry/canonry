import { createApiClient, type AuditLogEntry } from '../client.js'
import { CliError } from '../cli-error.js'

function getClient() {
  return createApiClient()
}

export async function showHistory(project: string, format?: string): Promise<void> {
  const client = getClient()

  try {
    const entries = await client.getHistory(project)

    if (format === 'json') {
      console.log(JSON.stringify(entries, null, 2))
      return
    }

    if (entries.length === 0) {
      console.log(`No audit history for "${project}".`)
      return
    }

    console.log(`Audit history for "${project}" (${entries.length}):\n`)
    console.log('  TIMESTAMP                ACTION              ENTITY TYPE  ACTOR')
    console.log('  ───────────────────────  ──────────────────  ───────────  ─────')

    for (const entry of entries) {
      console.log(
        `  ${entry.createdAt.padEnd(23)}  ${entry.action.padEnd(18)}  ${entry.entityType.padEnd(11)}  ${entry.actor}`,
      )
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliError({
      code: 'HISTORY_FETCH_FAILED',
      message: `Failed to fetch history for project "${project}"`,
      displayMessage: `Failed to fetch history: ${message}`,
      details: {
        project,
        cause: message,
      },
    })
  }
}

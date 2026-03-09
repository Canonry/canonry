import { loadConfig } from '../config.js'
import { ApiClient } from '../client.js'

function getClient(): ApiClient {
  const config = loadConfig()
  return new ApiClient(config.apiUrl, config.apiKey)
}

export async function showHistory(project: string): Promise<void> {
  const client = getClient()

  try {
    const entries = await client.getHistory(project) as Array<{
      id: string
      actor: string
      action: string
      entityType: string
      entityId: string | null
      createdAt: string
    }>

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
    console.error(`Failed to fetch history: ${message}`)
    process.exit(1)
  }
}

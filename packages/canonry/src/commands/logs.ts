import { logQuerySchema } from '@ainyc/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat, usageError, type CliFormat } from '../cli-error.js'

export async function showOperationalLogs(query: unknown, format: CliFormat): Promise<void> {
  const parsed = logQuerySchema.safeParse(query)
  if (!parsed.success) throw usageError('Invalid logs filters', { details: { issues: parsed.error.issues } })
  const result = await createApiClient().listOperationalLogs(parsed.data)
  // This is a paginated envelope, so jsonl deliberately preserves the complete
  // document just like other object-returning commands (including its cursor).
  if (isMachineFormat(format)) { console.log(JSON.stringify(result, null, 2)); return }
  console.log(`Runtime logs (${result.retention}; ${result.entries.length} entries; ${result.dropped} evicted; ${result.captureErrors ?? 0} capture errors). Separate from audit history.`)
  for (const entry of result.entries) console.log(`${entry.ts} ${entry.level} [${entry.module}] ${entry.action}${entry.message ? ` ${entry.message}` : ''} ${JSON.stringify(entry.context)}`)
  if (result.nextCursor) console.log(`Next cursor: ${result.nextCursor}`)
}

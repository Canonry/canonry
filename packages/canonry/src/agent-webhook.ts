import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { notifications, parseJsonColumn, type DatabaseClient } from '@ainyc/canonry-db'

/** Events the agent webhook subscribes to. Shared between server auto-attach, CLI attach, and setup bulk-attach. */
export const AGENT_WEBHOOK_EVENTS = ['run.completed', 'insight.critical', 'insight.high', 'citation.gained'] as const

export function buildAgentWebhookUrl(gatewayPort: number): string {
  return `http://localhost:${gatewayPort}/hooks/canonry`
}

export type AttachAgentWebhookResult = 'attached' | 'already-attached'

/**
 * Attach the agent webhook to a project directly via the DB (no HTTP hop).
 *
 * Idempotent — checks for an existing notification row whose config URL
 * matches the agent webhook URL before inserting. Used by:
 *   - server.ts `onProjectUpserted` callback (auto-attach on create/update)
 *   - `canonry agent setup` bulk-attach over existing projects when the
 *     server isn't running
 */
export function attachAgentWebhookDirect(
  db: DatabaseClient,
  projectId: string,
  gatewayPort: number,
): AttachAgentWebhookResult {
  const agentUrl = buildAgentWebhookUrl(gatewayPort)

  const existing = db.select().from(notifications).where(eq(notifications.projectId, projectId)).all()
  const hasAgent = existing.some(n => {
    const cfg = parseJsonColumn<{ source?: string }>(n.config, {})
    return cfg.source === 'agent'
  })
  if (hasAgent) return 'already-attached'

  const now = new Date().toISOString()
  db.insert(notifications).values({
    id: crypto.randomUUID(),
    projectId,
    channel: 'webhook',
    config: JSON.stringify({
      url: agentUrl,
      events: [...AGENT_WEBHOOK_EVENTS],
      source: 'agent',
    }),
    enabled: 1,
    webhookSecret: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }).run()

  return 'attached'
}

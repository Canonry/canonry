import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { agentScannerClients, type DatabaseClient } from '@canonry/canonry-db'
import { findScannerBursts, SCANNER_BURST_WINDOW_MS, type ScannerProbeWindow } from '@canonry/canonry-integration-traffic'

type BurstDb = Pick<DatabaseClient, 'select' | 'insert' | 'delete'>
/** Stored windows outlive their burst, so a late batch from the same days still matches. */
const RETENTION_MS = 2 * 86_400_000 + SCANNER_BURST_WINDOW_MS
const KEY_CHUNK = 500

export interface ScannerBurstInput {
  projectId: string
  sourceId: string
  events: readonly NormalizedTrafficRequest[]
  /** The install secret that keys journeys. Without it, bursts are found within the batch only. */
  secret: string | undefined
}

export interface ScannerBurstPlan {
  /** Agent requests in this batch to count as likely fake. */
  eventIds: ReadonlySet<string>
  /** Probe windows to store, by keyed client hash. Empty without the secret. */
  windows: ReadonlyMap<string, ScannerProbeWindow>
}

function loadWindows(db: BurstDb, input: ScannerBurstInput, clients: readonly string[]): Map<string, ScannerProbeWindow> {
  const known = new Map<string, ScannerProbeWindow>()
  for (let i = 0; i < clients.length; i += KEY_CHUNK) {
    const rows = db.select().from(agentScannerClients).where(and(
      eq(agentScannerClients.projectId, input.projectId),
      eq(agentScannerClients.sourceId, input.sourceId),
      inArray(agentScannerClients.clientKey, clients.slice(i, i + KEY_CHUNK)),
    )).all()
    for (const row of rows) known.set(row.clientKey, { firstProbeAt: Date.parse(row.firstProbeAt), lastProbeAt: Date.parse(row.lastProbeAt) })
  }
  return known
}

/**
 * Agent requests in this batch from a client that asked for scanner paths
 * within the burst window, in this batch or a stored earlier one. A client is
 * a keyed hash of its IP, so no address is stored.
 */
export function planScannerBursts(db: BurstDb, input: ScannerBurstInput): ScannerBurstPlan {
  const { secret } = input
  const clientKey = (remoteIp: string): string | null => {
    if (isIP(remoteIp) === 0) return null
    if (!secret) return remoteIp
    return crypto.createHmac('sha256', secret)
      .update(JSON.stringify(['agent-scanner-client-v1', input.projectId, input.sourceId, remoteIp]))
      .digest('hex')
  }
  const bursts = findScannerBursts(input.events, {
    clientKey,
    known: secret ? clients => loadWindows(db, input, clients) : undefined,
  })
  // Without the secret the keys are raw addresses, which are never stored.
  return { eventIds: bursts.eventIds, windows: secret ? bursts.windows : new Map() }
}

/** Store the batch's probe windows and drop expired ones, in the batch's transaction. */
export function saveScannerBursts(db: BurstDb, input: { projectId: string, sourceId: string, windows: ReadonlyMap<string, ScannerProbeWindow>, now: string }): void {
  for (const [clientKey, window] of input.windows) {
    const firstProbeAt = new Date(window.firstProbeAt).toISOString()
    const lastProbeAt = new Date(window.lastProbeAt).toISOString()
    db.insert(agentScannerClients)
      .values({ projectId: input.projectId, sourceId: input.sourceId, clientKey, firstProbeAt, lastProbeAt, updatedAt: input.now })
      .onConflictDoUpdate({
        target: [agentScannerClients.projectId, agentScannerClients.sourceId, agentScannerClients.clientKey],
        set: { firstProbeAt, lastProbeAt, updatedAt: input.now },
        // Keep the latest burst: an older batch (a backfill) never replaces it.
        setWhere: sql`${lastProbeAt} >= ${agentScannerClients.lastProbeAt}`,
      })
      .run()
  }
  const cutoff = new Date(Date.parse(input.now) - RETENTION_MS).toISOString()
  db.delete(agentScannerClients)
    .where(and(eq(agentScannerClients.sourceId, input.sourceId), lt(agentScannerClients.lastProbeAt, cutoff)))
    .run()
}

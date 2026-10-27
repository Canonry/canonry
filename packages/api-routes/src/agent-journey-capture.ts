import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { and, eq, lt, sql } from 'drizzle-orm'
import { AGENT_JOURNEY_DAILY_EVENT_LIMIT, AGENT_JOURNEY_RETENTION_DAYS, AgentJourneyCorrelationBases, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { agentJourneyCaptureDays, agentJourneyEvents, type DatabaseClient } from '@canonry/canonry-db'
import { extractAgentJourneyRequests } from '@canonry/canonry-integration-traffic'

type CaptureDb = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>
interface CaptureInput {
  projectId: string
  sourceId: string
  events: readonly NormalizedTrafficRequest[]
  secret: string | undefined
  now: string
}
interface CaptureResult { eventsStored: number }
const RETENTION_MS = AGENT_JOURNEY_RETENTION_DAYS * 86_400_000

function persistAgentJourneyBatch(db: CaptureDb, input: CaptureInput): CaptureResult {
  if (!input.secret || input.events.length === 0) return { eventsStored: 0 }
  const cutoff = Date.parse(input.now) - RETENTION_MS
  let eventsStored = 0
  for (const request of extractAgentJourneyRequests(input.events)) {
    if (Date.parse(request.ts) < cutoff) continue
    // Provider IDs can contain full URLs, including secrets omitted from path.
    const sourceEventId = crypto.createHmac('sha256', input.secret)
      .update(JSON.stringify(['agent-journey-source-event-v1', input.projectId, input.sourceId, request.sourceEventId]))
      .digest('hex')
    const eventWhere = and(eq(agentJourneyEvents.projectId, input.projectId), eq(agentJourneyEvents.sourceId, input.sourceId), eq(agentJourneyEvents.sourceEventId, sourceEventId))
    if (db.select({ id: agentJourneyEvents.id }).from(agentJourneyEvents).where(eventWhere).get()) continue
    const day = request.ts.slice(0, 10)
    const dayWhere = and(eq(agentJourneyCaptureDays.projectId, input.projectId), eq(agentJourneyCaptureDays.sourceId, input.sourceId), eq(agentJourneyCaptureDays.day, day))
    db.insert(agentJourneyCaptureDays).values({ projectId: input.projectId, sourceId: input.sourceId, day }).onConflictDoNothing().run()
    const reserved = db.update(agentJourneyCaptureDays)
      .set({ storedEvents: sql`${agentJourneyCaptureDays.storedEvents} + 1` })
      .where(and(dayWhere, lt(agentJourneyCaptureDays.storedEvents, AGENT_JOURNEY_DAILY_EVENT_LIMIT)))
      .returning({ storedEvents: agentJourneyCaptureDays.storedEvents }).all()
    if (reserved.length === 0) {
      db.update(agentJourneyCaptureDays).set({ capped: true }).where(dayWhere).run()
      continue
    }
    const hasIp = request.remoteIp !== null && isIP(request.remoteIp) !== 0
    const correlationBasis = hasIp ? AgentJourneyCorrelationBases['ip-ua'] : AgentJourneyCorrelationBases.unlinked
    // IP+UA is a correlation hint, never proof of one agent task. A source
    // without IP gets an event-specific key, not a shared user-agent cohort.
    const correlationKey = crypto.createHmac('sha256', input.secret)
      .update(JSON.stringify(['agent-journey-v1', input.projectId, input.sourceId, request.agentId, correlationBasis,
        hasIp ? [request.remoteIp, request.userAgent] : request.sourceEventId]))
      .digest('hex')
    const inserted = db.insert(agentJourneyEvents).values({
      id: crypto.randomUUID(), projectId: input.projectId, sourceId: input.sourceId,
      sourceEventId, ts: request.ts, correlationKey, correlationBasis,
      agentId: request.agentId, operator: request.operator, product: request.product,
      verificationStatus: request.verificationStatus, verificationManifest: request.verificationManifest,
      host: request.host, path: request.path, method: request.method, status: request.status,
      latencyMs: request.latencyMs, createdAt: input.now,
    }).onConflictDoNothing().run()
    if (inserted.changes === 1) eventsStored += 1
    else db.update(agentJourneyCaptureDays).set({ storedEvents: sql`${agentJourneyCaptureDays.storedEvents} - 1` }).where(dayWhere).run()
  }
  return { eventsStored }
}

/** Capture failure rolls back its savepoint while traffic receipts and rollups proceed. */
export function recordAgentJourneyBatch(
  tx: { transaction: <T>(run: (db: CaptureDb) => T) => T },
  input: CaptureInput,
  handlers: { onError: (error: unknown) => void; outerActive: () => boolean },
): CaptureResult {
  if (!input.secret || input.events.length === 0) return { eventsStored: 0 }
  try {
    return tx.transaction(db => persistAgentJourneyBatch(db, input))
  } catch (error) {
    if (!handlers.outerActive()) throw error
    handlers.onError(error)
    return { eventsStored: 0 }
  }
}

/** The traffic startup/daily sweep enforces the agent event retention rule. */
export function enforceAgentJourneyRetention(db: Pick<DatabaseClient, 'delete'>, referenceAt: string): void {
  const cutoff = new Date(Date.parse(referenceAt) - RETENTION_MS).toISOString()
  db.delete(agentJourneyEvents).where(lt(agentJourneyEvents.ts, cutoff)).run()
  db.delete(agentJourneyCaptureDays).where(lt(agentJourneyCaptureDays.day, cutoff.slice(0, 10))).run()
}

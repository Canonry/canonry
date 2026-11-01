import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { unrecognizedAgentEventsHourly, unrecognizedAgentNotifyState } from '@canonry/canonry-db'
import type { UnrecognizedAgentWebhookPayload } from '@canonry/canonry-contracts'
import { describeError } from '@canonry/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('UnrecognizedAgentAlerts')

/** Only names first seen this recently alert, so old traffic is never replayed. */
export const UNRECOGNIZED_AGENT_ALERT_WINDOW_MS = 7 * 86_400_000
/** One stray request is not news; a name alerts once it has this many hits. */
export const UNRECOGNIZED_AGENT_ALERT_MIN_HITS = 3
export const UNRECOGNIZED_AGENT_ALERT_INTERVAL_MS = 15 * 60_000

export const UnrecognizedAgentNotifyStates = {
  sent: 'sent',
  skipped: 'skipped',
  stale: 'stale',
  baseline: 'baseline',
} as const
export type UnrecognizedAgentNotifyState = (typeof UnrecognizedAgentNotifyStates)[keyof typeof UnrecognizedAgentNotifyStates]

type Agent = UnrecognizedAgentWebhookPayload['agents'][number]

/** Projects with an unrecognized agent stored inside the alert window. */
export function projectsWithRecentUnrecognizedAgents(db: DatabaseClient, now: number): string[] {
  const since = new Date(now - UNRECOGNIZED_AGENT_ALERT_WINDOW_MS).toISOString()
  return db.selectDistinct({ projectId: unrecognizedAgentEventsHourly.projectId })
    .from(unrecognizedAgentEventsHourly)
    .where(gte(unrecognizedAgentEventsHourly.tsHour, since))
    .all()
    .map(row => row.projectId)
}

/**
 * Names in a project with no alert decision yet. `due` are new and busy
 * enough to alert. `stale` were first seen before the window, and `baseline`
 * in the project's first 7 days of recorded traffic, when every bot already
 * crawling the site shows up at once; both are recorded without alerting.
 * Quieter new names wait for more hits.
 */
export function undecidedUnrecognizedAgents(db: DatabaseClient, projectId: string, now: number): { due: Agent[], stale: string[], baseline: string[] } {
  const decided = new Set(db.select({ agentName: unrecognizedAgentNotifyState.agentName })
    .from(unrecognizedAgentNotifyState)
    .where(eq(unrecognizedAgentNotifyState.projectId, projectId))
    .all()
    .map(row => row.agentName))
  const totals = db.select({
    name: unrecognizedAgentEventsHourly.agentName,
    hits: sql<number>`SUM(${unrecognizedAgentEventsHourly.hits})`,
    firstSeenAt: sql<string>`MIN(${unrecognizedAgentEventsHourly.tsHour})`,
    lastSeenAt: sql<string>`MAX(${unrecognizedAgentEventsHourly.tsHour})`,
  })
    .from(unrecognizedAgentEventsHourly)
    .where(eq(unrecognizedAgentEventsHourly.projectId, projectId))
    .groupBy(unrecognizedAgentEventsHourly.agentName)
    .all()

  const windowStart = new Date(now - UNRECOGNIZED_AGENT_ALERT_WINDOW_MS).toISOString()
  const recordingStart = totals.reduce<string | null>((earliest, total) => (earliest === null || total.firstSeenAt < earliest ? total.firstSeenAt : earliest), null)
  const baselineEnd = recordingStart === null ? null : new Date(Date.parse(recordingStart) + UNRECOGNIZED_AGENT_ALERT_WINDOW_MS).toISOString()
  const due: Agent[] = []
  const stale: string[] = []
  const baseline: string[] = []
  for (const total of totals) {
    if (decided.has(total.name)) continue
    if (total.firstSeenAt < windowStart) {
      stale.push(total.name)
      continue
    }
    if (baselineEnd !== null && total.firstSeenAt < baselineEnd) {
      baseline.push(total.name)
      continue
    }
    if (Number(total.hits) < UNRECOGNIZED_AGENT_ALERT_MIN_HITS) continue
    const latest = db.select({ sampledUserAgent: unrecognizedAgentEventsHourly.sampledUserAgent, sampledPath: unrecognizedAgentEventsHourly.sampledPath })
      .from(unrecognizedAgentEventsHourly)
      .where(and(eq(unrecognizedAgentEventsHourly.projectId, projectId), eq(unrecognizedAgentEventsHourly.agentName, total.name)))
      .orderBy(desc(unrecognizedAgentEventsHourly.tsHour))
      .limit(1)
      .get()
    due.push({
      name: total.name,
      hits: Number(total.hits),
      firstSeenAt: total.firstSeenAt,
      lastSeenAt: total.lastSeenAt,
      sampleUserAgent: latest?.sampledUserAgent ?? null,
      samplePath: latest?.sampledPath ?? null,
    })
  }
  due.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name))
  return { due, stale, baseline }
}

export function recordUnrecognizedAgentDecisions(db: DatabaseClient, projectId: string, names: readonly string[], state: UnrecognizedAgentNotifyState, now: number): void {
  const recordedAt = new Date(now).toISOString()
  for (const agentName of names) {
    db.insert(unrecognizedAgentNotifyState)
      .values({ projectId, agentName, state, recordedAt })
      .onConflictDoNothing()
      .run()
  }
}

/** Run `dispatch` every `intervalMs`; passes never overlap. */
export function startUnrecognizedAgentAlertLoop(dispatch: () => Promise<number>, intervalMs = UNRECOGNIZED_AGENT_ALERT_INTERVAL_MS): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void dispatch()
      .catch((err: unknown) => { log.warn('unrecognized-agent-alerts.dispatch-failed', { error: describeError(err) }) })
      .finally(() => { running = false })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

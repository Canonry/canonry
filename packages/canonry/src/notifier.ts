import { eq, desc, and, inArray, or } from 'drizzle-orm'
import { deliverWebhook, redactNotificationUrl, resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { auditLog, groupRunsByCreatedAt, notifications, parseJsonColumn, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import type { NotificationEvent, WebhookPayload, InsightWebhookPayload } from '@ainyc/canonry-contracts'
import type { AnalysisResult } from '@ainyc/canonry-intelligence'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'

const log = createLogger('Notifier')

export class Notifier {
  private db: DatabaseClient
  private serverUrl: string

  constructor(db: DatabaseClient, serverUrl: string) {
    this.db = db
    this.serverUrl = serverUrl
  }

  /** Called after a run completes (success, partial, or failed). */
  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    log.info('run.completed', { runId, projectId })

    // Get project notifications
    const notifs = this.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .filter(n => n.enabled === 1)

    if (notifs.length === 0) {
      log.info('notifications.none-enabled', { projectId })
      return
    }

    log.info('notifications.found', { projectId, count: notifs.length })

    // Get the completed run
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) {
      log.error('run.not-found', { runId, msg: 'skipping notification dispatch' })
      return
    }

    // Get the project
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      log.error('project.not-found', { projectId, msg: 'skipping notification dispatch' })
      return
    }

    // Compute transitions by comparing to previous run
    const transitions = this.computeTransitions(runId, projectId)

    // Determine which events occurred
    const events: NotificationEvent[] = []
    log.info('run.status', { runId: run.id, status: run.status, projectId })

    if (run.status === 'completed' || run.status === 'partial') {
      events.push('run.completed')
    }
    if (run.status === 'failed') {
      events.push('run.failed')
    }

    const lostTransitions = transitions.filter(t => t.to === 'not-cited' && t.from === 'cited')
    const gainedTransitions = transitions.filter(t => t.to === 'cited' && t.from === 'not-cited')

    if (lostTransitions.length > 0) events.push('citation.lost')
    if (gainedTransitions.length > 0) events.push('citation.gained')

    // Send webhooks for each notification config
    for (const notif of notifs) {
      const config = parseJsonColumn<{ url: string; events: string[] }>(notif.config, { url: '', events: [] })
      if (!config.url) continue
      const subscribedEvents = config.events as NotificationEvent[]

      // Filter to events this notification cares about
      const matchingEvents = events.filter(e => subscribedEvents.includes(e))
      log.info('notification.match', { notificationId: notif.id, subscribedEvents, matchedEvents: matchingEvents })
      if (matchingEvents.length === 0) continue

      // Send one webhook per matching event
      for (const event of matchingEvents) {
        const relevantTransitions = event === 'citation.lost' ? lostTransitions
          : event === 'citation.gained' ? gainedTransitions
          : transitions

        const payload: WebhookPayload = {
          source: 'canonry',
          event,
          project: { name: project.name, canonicalDomain: project.canonicalDomain },
          run: { id: run.id, status: run.status, finishedAt: run.finishedAt },
          transitions: relevantTransitions,
          dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
        }

        await this.sendWebhook(config.url, payload, notif.id, projectId, notif.webhookSecret ?? null)
      }
    }
  }

  /** Dispatch insight webhooks for critical/high severity insights after a run. */
  async dispatchInsightWebhooks(runId: string, projectId: string, result: AnalysisResult): Promise<void> {
    type InsightEvent = 'insight.critical' | 'insight.high'
    const insightEvents: InsightEvent[] = []
    const criticalInsights = result.insights.filter(i => i.severity === 'critical')
    const highInsights = result.insights.filter(i => i.severity === 'high')
    if (criticalInsights.length > 0) insightEvents.push('insight.critical')
    if (highInsights.length > 0) insightEvents.push('insight.high')
    if (insightEvents.length === 0) return

    const notifs = this.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .filter(n => n.enabled === 1)

    if (notifs.length === 0) return

    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return

    for (const notif of notifs) {
      const config = parseJsonColumn<{ url: string; events: string[] }>(notif.config, { url: '', events: [] })
      if (!config.url) continue
      const subscribedEvents = config.events as NotificationEvent[]
      const matchingEvents = insightEvents.filter(e => (subscribedEvents as string[]).includes(e))
      if (matchingEvents.length === 0) continue

      for (const event of matchingEvents) {
        const relevantInsights = event === 'insight.critical' ? criticalInsights : highInsights
        const payload: InsightWebhookPayload = {
          source: 'canonry',
          event,
          project: { name: project.name, canonicalDomain: project.canonicalDomain },
          run: { id: run.id, status: run.status, finishedAt: run.finishedAt },
          insights: relevantInsights.map(i => ({
            id: i.id,
            type: i.type,
            severity: i.severity,
            title: i.title,
            query: i.query,
            provider: i.provider,
          })),
          dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
        }
        await this.sendWebhook(config.url, payload, notif.id, projectId, notif.webhookSecret ?? null)
      }
    }
  }

  private computeTransitions(runId: string, projectId: string): Array<{
    query: string; from: string; to: string; provider: string; location: string | null
  }> {
    // Multi-location `--all-locations` sweeps fan out into N runs sharing the
    // same `createdAt`. Two corrections vs the pre-#480 logic:
    //
    //   1. The "previous" run must come from a strictly earlier fan-out group,
    //      not from a sibling location's current run (the pre-#480 code did
    //      exactly that, firing spurious citation.lost/gained webhooks every
    //      multi-location sweep).
    //   2. The fanned-out runs complete one-at-a-time, and each completion
    //      triggers this code path. We need exactly one webhook per group.
    //      Strategy: only the LAST run to finish (the one whose completion
    //      leaves zero siblings in `queued`/`running` state) fires the diff.
    //      Earlier completions see at least one still-pending sibling and
    //      return []. Race window where two siblings complete in the same
    //      sub-millisecond is theoretically possible — SQLite serializes
    //      writes so the second completion's "is anyone still pending?" query
    //      sees the first as already-completed; the first sees the second
    //      still pending. Sequential progression keeps it single-fire.
    //
    // The transition key is `(queryId, provider, location)` so a regression
    // in florida doesn't get masked by an unchanged michigan reading. The
    // webhook payload carries an optional `location` field on each transition
    // for the same reason.
    const thisRun = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!thisRun) return []

    // Sibling runs at the same `createdAt` (any status). If any are still
    // queued/running, this isn't the last-to-finish — wait for them.
    const groupSiblings = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.createdAt, thisRun.createdAt)))
      .all()
    const stillPending = groupSiblings.some(r => r.status === 'queued' || r.status === 'running')
    if (stillPending) return []

    // Walk backward to find the previous distinct-createdAt group containing
    // at least one completed/partial run. RECENT_FETCH_LIMIT bounds the
    // backward walk; scaling it by project location count handles projects
    // with N>2 configured locations where a 8-row limit could be exhausted
    // by two fan-out groups alone.
    const projectLocations = this.db
      .select({ locations: projects.locations })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    const locationCount = Math.max(
      1,
      parseJsonColumn<unknown[]>(projectLocations?.locations ?? null, []).length,
    )
    const RECENT_FETCH_LIMIT = Math.max(8, locationCount * 4)
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(RECENT_FETCH_LIMIT)
      .all()

    const groups = groupRunsByCreatedAt(recentRuns)
    const currentGroupIdx = groups.findIndex(g => g[0]?.createdAt === thisRun.createdAt)
    if (currentGroupIdx < 0) return []  // unexpected, but defensive
    const currentGroup = groups[currentGroupIdx] ?? []
    const previousGroup = groups[currentGroupIdx + 1] ?? []

    if (currentGroup.length === 0 || previousGroup.length === 0) return []

    const currentRunIds = currentGroup.map(r => r.id)
    const previousRunIds = previousGroup.map(r => r.id)

    const currentSnapshots = this.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        provider: querySnapshots.provider,
        location: querySnapshots.location,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, currentRunIds))
      .all()

    const previousSnapshots = this.db
      .select({
        queryId: querySnapshots.queryId,
        provider: querySnapshots.provider,
        location: querySnapshots.location,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, previousRunIds))
      .all()

    // Key by (queryId, provider, location) so a florida regression is not
    // masked by an unchanged michigan reading (or vice versa) when both
    // locations are present in the current+previous groups.
    const prevMap = new Map<string, string>()
    for (const s of previousSnapshots) {
      prevMap.set(`${s.queryId}:${s.provider}:${s.location ?? ''}`, s.citationState)
    }

    const transitions: Array<{ query: string; from: string; to: string; provider: string; location: string | null }> = []
    for (const s of currentSnapshots) {
      const key = `${s.queryId}:${s.provider}:${s.location ?? ''}`
      const prevState = prevMap.get(key)
      if (prevState && prevState !== s.citationState) {
        transitions.push({
          query: s.query ?? s.queryId,
          from: prevState,
          to: s.citationState,
          provider: s.provider,
          location: s.location,
        })
      }
    }

    return transitions
  }

  private async sendWebhook(url: string, payload: WebhookPayload | InsightWebhookPayload, notificationId: string, projectId: string, webhookSecret: string | null): Promise<void> {
    const targetLabel = redactNotificationUrl(url).urlDisplay
    const targetCheck = await resolveWebhookTarget(url)
    if (!targetCheck.ok) {
      log.error('webhook.ssrf-blocked', { url: targetLabel, reason: targetCheck.message })
      this.logDelivery(projectId, notificationId, payload.event, 'failed', `SSRF: ${targetCheck.message}`)
      return
    }

    log.info('webhook.send', { event: payload.event, url: targetLabel })

    const maxRetries = 3
    const delays = [1000, 4000, 16000]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await deliverWebhook(targetCheck.target, payload, webhookSecret)

        if (response.status >= 200 && response.status < 300) {
          log.info('webhook.delivered', { event: payload.event, url: targetLabel, httpStatus: response.status })
          this.logDelivery(projectId, notificationId, payload.event, 'sent', null)
          return
        }

        const errorDetail = response.error ?? `HTTP ${response.status}`
        log.warn('webhook.attempt-failed', { event: payload.event, url: targetLabel, attempt: attempt + 1, maxRetries, httpStatus: response.status, error: errorDetail })
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
        }
      } catch (err: unknown) {
        const errorDetail = err instanceof Error ? err.message : String(err)
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
          log.error('webhook.exhausted', { event: payload.event, url: targetLabel, maxRetries, error: errorDetail })
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]!))
      }
    }
  }

  private logDelivery(projectId: string, notificationId: string, event: string, status: string, error: string | null): void {
    this.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      projectId,
      actor: 'scheduler',
      action: `notification.${status}`,
      entityType: 'notification',
      entityId: notificationId,
      diff: JSON.stringify({ event, error }),
      createdAt: new Date().toISOString(),
    }).run()
  }
}

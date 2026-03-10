import { eq, desc, and, or } from 'drizzle-orm'
import { deliverWebhook, resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { notifications, runs, querySnapshots, keywords, projects, auditLog } from '@ainyc/canonry-db'
import type { NotificationEvent, WebhookPayload } from '@ainyc/canonry-contracts'
import crypto from 'node:crypto'

export class Notifier {
  private db: DatabaseClient
  private serverUrl: string

  constructor(db: DatabaseClient, serverUrl: string) {
    this.db = db
    this.serverUrl = serverUrl
  }

  /** Called after a run completes (success, partial, or failed). */
  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    console.log(`[Notifier] onRunCompleted: runId=${runId} projectId=${projectId}`)

    // Get project notifications
    const notifs = this.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .filter(n => n.enabled === 1)

    if (notifs.length === 0) {
      console.log(`[Notifier] No enabled notifications for project ${projectId} — skipping`)
      return
    }

    console.log(`[Notifier] Found ${notifs.length} enabled notification(s) for project ${projectId}`)

    // Get the completed run
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) {
      console.error(`[Notifier] Run ${runId} not found — skipping notification dispatch`)
      return
    }

    // Get the project
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      console.error(`[Notifier] Project ${projectId} not found — skipping notification dispatch`)
      return
    }

    // Compute transitions by comparing to previous run
    const transitions = this.computeTransitions(runId, projectId)

    // Determine which events occurred
    const events: NotificationEvent[] = []
    console.log(`[Notifier] Run status: ${run.status}`)

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
      const config = JSON.parse(notif.config) as { url: string; events: string[] }
      const subscribedEvents = config.events as NotificationEvent[]

      // Filter to events this notification cares about
      const matchingEvents = events.filter(e => subscribedEvents.includes(e))
      console.log(`[Notifier] Notification ${notif.id}: subscribed=${JSON.stringify(subscribedEvents)} matched=${JSON.stringify(matchingEvents)}`)
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

  private computeTransitions(runId: string, projectId: string): Array<{
    keyword: string; from: string; to: string; provider: string
  }> {
    // Get the two most recent completed/partial runs for this project.
    // Status filter is pushed into SQL (not applied in JS) so that a concurrent
    // run completing after this one does not displace it from position [0].
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          or(eq(runs.status, 'completed'), eq(runs.status, 'partial')),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(2)
      .all()

    if (recentRuns.length < 2) return []

    const currentRunId = recentRuns[0]!.id
    const previousRunId = recentRuns[1]!.id

    // Only compute for the run that just finished
    if (currentRunId !== runId) return []

    const currentSnapshots = this.db
      .select({
        keywordId: querySnapshots.keywordId,
        keyword: keywords.keyword,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .leftJoin(keywords, eq(querySnapshots.keywordId, keywords.id))
      .where(eq(querySnapshots.runId, currentRunId))
      .all()

    const previousSnapshots = this.db
      .select({
        keywordId: querySnapshots.keywordId,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
      })
      .from(querySnapshots)
      .where(eq(querySnapshots.runId, previousRunId))
      .all()

    // Build lookup: key = `${keywordId}:${provider}`
    const prevMap = new Map<string, string>()
    for (const s of previousSnapshots) {
      prevMap.set(`${s.keywordId}:${s.provider}`, s.citationState)
    }

    const transitions: Array<{ keyword: string; from: string; to: string; provider: string }> = []

    for (const s of currentSnapshots) {
      const key = `${s.keywordId}:${s.provider}`
      const prevState = prevMap.get(key)
      if (prevState && prevState !== s.citationState) {
        transitions.push({
          keyword: s.keyword ?? s.keywordId,
          from: prevState,
          to: s.citationState,
          provider: s.provider,
        })
      }
    }

    return transitions
  }

  private async sendWebhook(url: string, payload: WebhookPayload, notificationId: string, projectId: string, webhookSecret: string | null): Promise<void> {
    const targetCheck = await resolveWebhookTarget(url)
    if (!targetCheck.ok) {
      console.error(`[Notifier] Webhook URL blocked by SSRF check: ${url}`)
      this.logDelivery(projectId, notificationId, payload.event, 'failed', `SSRF: ${targetCheck.message}`)
      return
    }

    console.log(`[Notifier] Sending webhook event="${payload.event}" to ${url}`)

    const maxRetries = 3
    const delays = [1000, 4000, 16000]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await deliverWebhook(targetCheck.target, payload, webhookSecret)

        if (response.status >= 200 && response.status < 300) {
          console.log(`[Notifier] Webhook delivered: event="${payload.event}" status=${response.status}`)
          this.logDelivery(projectId, notificationId, payload.event, 'sent', null)
          return
        }

        const errorDetail = response.error ?? `HTTP ${response.status}`
        console.warn(`[Notifier] Webhook attempt ${attempt + 1}/${maxRetries} failed: ${errorDetail}`)
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
        }
      } catch (err: unknown) {
        const errorDetail = err instanceof Error ? err.message : String(err)
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
          console.error(`[Notifier] Failed to deliver webhook after ${maxRetries} attempts: ${errorDetail}`)
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

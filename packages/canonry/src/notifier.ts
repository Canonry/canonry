import { eq, desc } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { notifications, runs, querySnapshots, keywords, projects, auditLog } from '@ainyc/aeo-platform-db'
import type { NotificationEvent, WebhookPayload } from '@ainyc/aeo-platform-contracts'
import crypto from 'node:crypto'

export class Notifier {
  private db: DatabaseClient
  private serverUrl: string

  constructor(db: DatabaseClient, serverUrl: string) {
    this.db = db
    this.serverUrl = serverUrl
  }

  /** Called after a run completes (success or partial). */
  async onRunCompleted(runId: string, projectId: string): Promise<void> {
    // Get project notifications
    const notifs = this.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .filter(n => n.enabled === 1)

    if (notifs.length === 0) return

    // Get the completed run
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return

    // Get the project
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return

    // Compute transitions by comparing to previous run
    const transitions = this.computeTransitions(runId, projectId)

    // Determine which events occurred
    const events: NotificationEvent[] = []

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
      if (matchingEvents.length === 0) continue

      // Send one webhook per matching event
      for (const event of matchingEvents) {
        const relevantTransitions = event === 'citation.lost' ? lostTransitions
          : event === 'citation.gained' ? gainedTransitions
          : transitions

        const payload: WebhookPayload = {
          event,
          project: { name: project.name, canonicalDomain: project.canonicalDomain },
          run: { id: run.id, status: run.status, finishedAt: run.finishedAt },
          transitions: relevantTransitions,
          dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
        }

        await this.sendWebhook(config.url, payload, notif.id, projectId)
      }
    }
  }

  private computeTransitions(runId: string, projectId: string): Array<{
    keyword: string; from: string; to: string; provider: string
  }> {
    // Get the two most recent completed/partial runs for this project
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .orderBy(desc(runs.createdAt))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .slice(0, 2)

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

  private async sendWebhook(url: string, payload: WebhookPayload, notificationId: string, projectId: string): Promise<void> {
    const maxRetries = 3
    const delays = [1000, 4000, 16000]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Canonry/0.1.0' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        })

        if (response.ok) {
          this.logDelivery(projectId, notificationId, payload.event, 'sent', null)
          return
        }

        const errorDetail = `HTTP ${response.status}`
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

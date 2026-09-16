import { eq, desc, and, inArray, or } from 'drizzle-orm'
import { deliverWebhook, measurementRunCompleteness, redactNotificationUrl, resolveDestination, resolveWebhookTarget, toAlertView } from '@ainyc/canonry-api-routes'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { auditLog, doctorHealthState, siteLivenessState, groupRunsByCreatedAt, insightNotifyState, notifications, projects, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import type { NotificationEvent, WebhookPayload, InsightWebhookPayload, HealthWebhookPayload } from '@ainyc/canonry-contracts'
import type { AnalysisResult, Insight } from '@ainyc/canonry-intelligence'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'
import { describeError } from '@ainyc/canonry-contracts'

const log = createLogger('Notifier')

/**
 * How far a magnitude must move before the same finding is news again.
 *
 * A GBP keyword drop drifting 79% -> 80% is the same story. A drop deepening
 * 30% -> 60% is not. Twenty points is a judgement, not a measurement, and it is
 * here rather than inline so it can be argued with.
 */
const MATERIAL_MAGNITUDE_DELTA = 20

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0
}

/**
 * The finding's wording with its magnitude neutralised, so a percentage that
 * drifts is not mistaken for a new finding while a window that advances is.
 * Only a number immediately followed by `%` is neutralised: dates, counts and
 * identifiers in the title stay, and they are what make an advanced window read
 * as different.
 */
function insightFingerprint(insight: Insight): string {
  return insight.title.replace(/\b\d+(?:\.\d+)?%/g, 'N%')
}

/** The leading percentage in a title, when it has one. */
function insightMagnitude(insight: Insight): number | null {
  const match = /\b(\d+(?:\.\d+)?)%/.exec(insight.title)
  return match?.[1] === undefined ? null : Math.round(Number(match[1]))
}

/** Stable across runs: same project, type, subject and wording is the same news. */
function insightNotifyKey(projectId: string, insight: Insight): string {
  return `${projectId}:${insight.type}:${insight.query}:${insightFingerprint(insight)}`
}

/** Failed liveness passes in a row before a site-down page. */
export const SITE_LIVENESS_FAILURES_TO_PAGE = 2
/**
 * A second failure only counts when it is this long after the one before it.
 * A boot catch-up pass and the cron tick seconds later are one observation of
 * one moment, not two passes spread over an interval.
 */
export const SITE_LIVENESS_MIN_PASS_GAP_MS = 4 * 60_000
/**
 * A failure older than this starts the count again. A failure stored before a
 * week-long shutdown plus one failed pass at boot is not a confirmed outage.
 */
export const SITE_LIVENESS_MAX_PASS_GAP_MS = 45 * 60_000

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
      .filter(n => n.enabled)

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
      const config = notif.config
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

  /**
   * Record the outcome of a scheduled health pass and notify on transitions.
   *
   * Edge-triggered on `(status, code)`. A pass that finds the same problem as
   * last time is stored but not re-sent: an operator who receives the same
   * warning every day stops reading the channel, which is how a real
   * degradation goes unnoticed. A pass whose worst code CHANGES does notify,
   * even at the same severity, because a different cause is different news.
   *
   * Returns the event emitted, or null when nothing changed — the return value
   * is what tests assert against, so "stayed quiet" is observable rather than
   * inferred from the absence of a webhook.
   */
  async onHealthChecked(
    projectId: string,
    report: {
      checks: Array<{ id: string; status: string; code: string; summary: string; remediation?: string | null; category?: string }>
      checkedAt: string
    },
  ): Promise<'health.degraded' | 'health.recovered' | null> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      log.error('project.not-found', { projectId, msg: 'skipping health notification' })
      return null
    }

    // `skipped` is not a health signal — a check that could not run tells us
    // nothing about the instrument and must never look like a clean bill.
    const rank = (status: string): number => (status === 'fail' ? 2 : status === 'warn' ? 1 : 0)

    // Among equally severe checks, lead with the one that says the measurement
    // is broken rather than the one offering advice about the site. Sorting by
    // id put `content.*` ahead of `traffic.*` purely alphabetically, so a
    // source silently discarding traffic was headlined as a content-coverage
    // note. Everything still travels in `failing`; this only picks the headline.
    const categoryRank = (category: string | undefined): number => {
      switch (category) {
        case 'database': return 6
        case 'integrations': return 5
        case 'providers': return 4
        case 'auth': return 3
        case 'schedules': return 2
        case 'config': return 1
        default: return 0
      }
    }
    const graded = report.checks.filter(c => c.status === 'fail' || c.status === 'warn' || c.status === 'ok')
    const failing = graded
      .filter(c => c.status !== 'ok')
      .sort((a, b) =>
        rank(b.status) - rank(a.status)
        || categoryRank(b.category) - categoryRank(a.category)
        || a.id.localeCompare(b.id))
    const worst = failing.at(0) ?? null

    // No gradeable check ran at all. Reporting `ok` here would be the exact
    // failure this channel exists to catch: a green signal produced by an
    // instrument that measured nothing. Absence of a signal is not health.
    const noSignal = graded.length === 0
    const status: 'ok' | 'warn' | 'fail' = noSignal
      ? 'warn'
      : worst
        ? (worst.status as 'warn' | 'fail')
        : 'ok'
    const code = noSignal ? 'health.no-signal' : (worst?.code ?? 'health.ok')
    const summary = noSignal
      ? `No health check produced a result (${report.checks.length} skipped) — health is unknown, not confirmed.`
      : (worst?.summary ?? `All ${graded.length} health check(s) passing.`)

    const previous = this.db.select().from(doctorHealthState)
      .where(eq(doctorHealthState.projectId, projectId)).get()
    const previousStatus = (previous?.status ?? null) as 'ok' | 'warn' | 'fail' | null

    // `failing` is already sorted deterministically above, so this is stable
    // across passes and only moves when the SET of breaches moves.
    const failingSignature = failing.map(c => `${c.status}:${c.code}`).join(',')

    // Transition rules: a first observation only speaks up if it is already
    // bad, so installing this does not announce healthy projects.
    let event: 'health.degraded' | 'health.recovered' | null = null
    if (previous === undefined) {
      if (status !== 'ok') event = 'health.degraded'
    } else if (status === 'ok' && previousStatus !== 'ok') {
      event = 'health.recovered'
    } else if (status !== 'ok' && (previousStatus === 'ok' || previous.code !== code)) {
      event = 'health.degraded'
    } else if (
      status !== 'ok'
      && previous.failingSignature !== null
      && previous.failingSignature !== failingSignature
    ) {
      // A second breach opening under an existing one leaves the headline code
      // untouched, so keying only on that code graded the new outage, listed it
      // in `failing`, and then dropped it at the trigger. The ranking decides
      // which breach leads; it must not decide whether anyone is told at all.
      // Guarded on a non-NULL previous signature: a row predating this column
      // knows nothing about the old set, and treating unknown as changed would
      // page every already-degraded project on the first pass after deploy.
      event = 'health.degraded'
    }

    const now = report.checkedAt
    // Write the observation first so a delivery failure cannot lose it, but
    // leave `notifiedAt` alone until something is actually sent — it previously
    // recorded "decided to notify", which read as delivered even when zero
    // webhooks matched.
    const observation = { projectId, status, code, summary, checkedAt: now, failingSignature }
    if (previous === undefined) {
      this.db.insert(doctorHealthState).values({ ...observation, notifiedAt: null }).run()
    } else {
      this.db.update(doctorHealthState).set(observation).where(eq(doctorHealthState.projectId, projectId)).run()
    }

    if (!event) {
      log.info('health.unchanged', { projectId, status, code })
      return null
    }

    const notifs = this.db.select().from(notifications)
      .where(eq(notifications.projectId, projectId)).all().filter(n => n.enabled)

    const payload: HealthWebhookPayload = {
      source: 'canonry',
      event,
      project: { name: project.name, canonicalDomain: project.canonicalDomain },
      health: {
        status,
        code,
        summary,
        remediation: worst?.remediation ?? null,
        checkedAt: now,
        previousStatus,
        failing: failing.map(c => ({ id: c.id, status: c.status, code: c.code, summary: c.summary })),
      },
      dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
    }

    // Health events reach every enabled webhook, whether or not the subscription
    // lists them. They report that the measurement itself is untrustworthy, so
    // requiring opt-in guarantees the one alarm that matters is the one nobody
    // subscribed to — which is exactly what happened: the events shipped, no
    // existing subscription named them, and degradation was computed and then
    // dropped at delivery. They are edge-triggered and therefore rare, and
    // `canonry apply` rewriting a project's event list can no longer silence
    // them.
    let delivered = 0
    for (const notif of notifs) {
      const config = notif.config as { url: string; events?: string[] }
      if (!config.url) continue
      if (await this.sendWebhook(config.url, payload as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) delivered += 1
    }
    if (delivered > 0) {
      this.db.update(doctorHealthState).set({ notifiedAt: now })
        .where(eq(doctorHealthState.projectId, projectId)).run()
    }
    log.info('health.notified', { projectId, event, status, code, subscribers: notifs.length, delivered })
    return event
  }

  /**
   * Record a website liveness probe and notify on a confirmed change.
   *
   * Separate from onHealthChecked: that state grades the whole 6h doctor pass,
   * and this pass sees one check. Sharing its row would let "site is up" clear
   * an unrelated GA outage and send a false recovery.
   *
   * Two failed passes in a row before paging. The probe already retries once
   * inside a pass, so an alert means four failed requests spread over at least
   * one schedule interval, not a blip or a host restart. A recovery is sent only
   * for an outage that was paged, so a blip that never alerted stays silent in
   * both directions.
   */
  async onSiteLivenessChecked(
    projectId: string,
    result: {
      check: { id: string; status: string; code: string; summary: string; remediation?: string | null }
      checkedAt: string
    },
  ): Promise<'health.degraded' | 'health.recovered' | null> {
    const { check, checkedAt } = result
    // Skipped (no domain, a refused address) is not a liveness signal.
    if (check.status !== 'ok' && check.status !== 'fail') return null
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) {
      log.error('project.not-found', { projectId, msg: 'skipping site liveness notification' })
      return null
    }

    const previous = this.db.select().from(siteLivenessState)
      .where(eq(siteLivenessState.projectId, projectId)).get()
    const sincePrevious = previous ? Date.parse(checkedAt) - Date.parse(previous.checkedAt) : Number.NaN
    // A repeat too close to the previous pass, or after a long gap, restarts the
    // count rather than confirming an outage.
    const countsAsRepeat = Number.isFinite(sincePrevious)
      && sincePrevious >= SITE_LIVENESS_MIN_PASS_GAP_MS
      && sincePrevious <= SITE_LIVENESS_MAX_PASS_GAP_MS
    const failures = check.status === 'fail'
      ? (countsAsRepeat ? (previous?.consecutiveFailures ?? 0) + 1 : 1)
      : 0
    const outagePaged = previous?.status === 'fail' && Boolean(previous.notifiedAt)

    let event: 'health.degraded' | 'health.recovered' | null = null
    if (check.status === 'fail' && failures >= SITE_LIVENESS_FAILURES_TO_PAGE && !outagePaged) event = 'health.degraded'
    if (check.status === 'ok' && outagePaged) event = 'health.recovered'

    const observation = {
      projectId,
      status: check.status,
      code: check.code,
      summary: check.summary,
      consecutiveFailures: failures,
      checkedAt,
      notifiedAt: check.status === 'ok' ? null : (previous?.notifiedAt ?? null),
    }
    if (previous === undefined) {
      this.db.insert(siteLivenessState).values(observation).run()
    } else {
      this.db.update(siteLivenessState).set(observation).where(eq(siteLivenessState.projectId, projectId)).run()
    }

    // No log on a quiet pass: every project, every few minutes, would evict a
    // night of real diagnostics from the operational log buffer.
    if (!event) return null

    const notifs = this.db.select().from(notifications)
      .where(eq(notifications.projectId, projectId)).all().filter(n => n.enabled)
    const payload: HealthWebhookPayload = {
      source: 'canonry',
      event,
      project: { name: project.name, canonicalDomain: project.canonicalDomain },
      health: {
        status: check.status as 'ok' | 'fail',
        code: check.code,
        summary: check.summary,
        remediation: check.remediation ?? null,
        checkedAt,
        // The counter resets on every ok, so a page always follows a site that was
        // answering. Echoing the row the first failed pass wrote would report
        // "fail -> fail" and show the operator no transition at all.
        previousStatus: event === 'health.degraded' ? 'ok' : 'fail',
        failing: event === 'health.degraded'
          ? [{ id: check.id, status: check.status, code: check.code, summary: check.summary }]
          : [],
      },
      dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
    }

    // Same rule as onHealthChecked: health events reach every enabled webhook.
    let delivered = 0
    for (const notif of notifs) {
      const config = notif.config as { url: string; events?: string[] }
      if (!config.url) continue
      if (await this.sendWebhook(config.url, payload as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) delivered += 1
    }
    if (event === 'health.degraded' && delivered > 0) {
      this.db.update(siteLivenessState).set({ notifiedAt: checkedAt })
        .where(eq(siteLivenessState.projectId, projectId)).run()
    }
    log.info('site-liveness.notified', { projectId, event, code: check.code, subscribers: notifs.length, delivered })
    return event
  }

  /**
   * Has this finding already been said?
   *
   * The identity of a finding is its type, its subject and its wording with the
   * magnitude neutralised. So the same drop reported at 79% and at 80% over the
   * same window is one piece of news, while the same drop over an ADVANCED
   * window is a new one.
   *
   * Re-notifies on three things and nothing else:
   *   - never sent before
   *   - severity got worse (medium -> high -> critical)
   *   - magnitude moved by more than MATERIAL_MAGNITUDE_DELTA points
   *
   * Deliberately NOT time-based. A daily repeat is exactly the behaviour this
   * exists to stop, and "re-alert after N days" is that behaviour with a delay.
   */
  private isNewInsightNews(projectId: string, insight: Insight): boolean {
    const key = insightNotifyKey(projectId, insight)
    const previous = this.db.select().from(insightNotifyState)
      .where(eq(insightNotifyState.key, key)).get()
    if (!previous) return true
    if (severityRank(insight.severity) > severityRank(previous.severity)) return true
    const magnitude = insightMagnitude(insight)
    if (magnitude !== null && previous.magnitude !== null && previous.magnitude !== undefined) {
      if (Math.abs(magnitude - previous.magnitude) > MATERIAL_MAGNITUDE_DELTA) return true
    }
    return false
  }

  /** Record a delivered insight so it stops being news. */
  private rememberInsightNotified(projectId: string, insight: Insight): void {
    const key = insightNotifyKey(projectId, insight)
    const row = {
      key,
      projectId,
      type: insight.type,
      subject: insight.query,
      fingerprint: insightFingerprint(insight),
      severity: insight.severity,
      magnitude: insightMagnitude(insight),
      notifiedAt: new Date().toISOString(),
    }
    const existing = this.db.select().from(insightNotifyState)
      .where(eq(insightNotifyState.key, key)).get()
    if (existing) {
      this.db.update(insightNotifyState).set(row).where(eq(insightNotifyState.key, key)).run()
    } else {
      this.db.insert(insightNotifyState).values(row).run()
    }
  }

  /** Dispatch insight webhooks for critical/high severity insights after a run. */
  async dispatchInsightWebhooks(runId: string, projectId: string, result: AnalysisResult): Promise<void> {
    type InsightEvent = 'insight.critical' | 'insight.high'
    const insightEvents: InsightEvent[] = []
    // ONLY WHAT HAS NOT ALREADY BEEN SAID. Health is edge-triggered and citations
    // are transition-based; insight dispatch used to have no memory at all, so a
    // finding that persists alerted on every run. See {@link isNewInsightNews}.
    const unsent = result.insights.filter(i => this.isNewInsightNews(projectId, i))
    const criticalInsights = unsent.filter(i => i.severity === 'critical')
    const highInsights = unsent.filter(i => i.severity === 'high')
    if (criticalInsights.length > 0) insightEvents.push('insight.critical')
    if (highInsights.length > 0) insightEvents.push('insight.high')
    if (insightEvents.length === 0) return

    const notifs = this.db
      .select()
      .from(notifications)
      .where(eq(notifications.projectId, projectId))
      .all()
      .filter(n => n.enabled)

    if (notifs.length === 0) return

    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return

    for (const notif of notifs) {
      const config = notif.config
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
        // Recorded only after a send, for the reason the health path already
        // documents: marking "decided to notify" reads as delivered even when
        // nothing actually went out.
        for (const insight of relevantInsights) this.rememberInsightNotified(projectId, insight)
      }
    }
  }

  private computeTransitions(runId: string, projectId: string): Array<{
    query: string; from: string; to: string; provider: string; location: string | null
  }> {
    // Multi-location `--all-locations` sweeps fan out into N runs sharing the
    // same `createdAt`. Each run-completion event independently triggers this
    // code path; we need exactly one webhook per group regardless of async
    // dispatch ordering or how many notifier events fire near-simultaneously.
    //
    // Two corrections vs pre-#480 logic:
    //
    //   1. The "previous" run must come from a strictly earlier fan-out group,
    //      not from a sibling location's current run (the pre-#480 code did
    //      exactly that, firing spurious citation.lost/gained webhooks on
    //      every multi-location sweep).
    //   2. Dedup gate uses two stateless conditions, both recomputed on each
    //      call so concurrent async notifier events arrive at the same answer:
    //        (a) "All siblings finished" — at least one sibling still in
    //            queued/running blocks the diff; subsequent completions retry.
    //        (b) "I am the winner" — the completed/partial sibling with the
    //            greatest `finishedAt` (tiebreak: greatest id). Only the
    //            winner proceeds to fire. The winner is determined by stable
    //            DB columns, not by async event ordering, so two parallel
    //            notifier invocations compute the same winner — only one
    //            actually fires the webhook.
    //
    // The transition key is `(queryId, provider, location)` so a regression
    // in florida doesn't get masked by an unchanged michigan reading. The
    // webhook payload carries an optional `location` field on each transition
    // for the same reason.
    //
    // Limitation: cross-process deployments (multiple canonry servers behind
    // a load balancer) would each compute "I'm the winner" — exactly-once
    // becomes exactly-once-per-process. The current canonry deployment model
    // is single-server (one PM2 process); if that changes, the gate should
    // promote to a DB-backed marker table.
    const thisRun = this.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!thisRun) return []

    // A plan run that fell short of its manifest measured only part of the
    // set. Diffing it against a complete previous run would report a citation
    // as lost when the truth is that the question was never asked this time —
    // a wrong number, dressed as an alert.
    const completeness = measurementRunCompleteness(this.db, runId)
    if (completeness.planned && !completeness.complete) {
      log.info('transitions.skipped-incomplete', {
        runId,
        executed: completeness.executed,
        expected: completeness.expected,
      })
      return []
    }

    // Siblings at the same (project, kind, createdAt). The `kind` filter
    // avoids cross-kind interference — a queued traffic-sync that happened
    // to land at the same millisecond as this answer-visibility run must
    // not block this webhook.
    const groupSiblings = this.db
      .select()
      .from(runs)
      .where(and(
        eq(runs.projectId, projectId),
        eq(runs.kind, thisRun.kind),
        eq(runs.createdAt, thisRun.createdAt),
      ))
      .all()

    // Gate (a): wait for the rest of the fan-out to finish.
    const stillPending = groupSiblings.some(r => r.status === 'queued' || r.status === 'running')
    if (stillPending) return []

    // Gate (b): determine the winner among completed/partial siblings.
    // `finishedAt` is written atomically with `status` in the job runner's
    // UPDATE, so it's stable when we observe status=completed or partial.
    // Tiebreak on id DESC matches the /runs/latest convention from PR #479.
    const completedPartialSiblings = groupSiblings.filter(
      r => r.status === 'completed' || r.status === 'partial',
    )
    if (completedPartialSiblings.length === 0) return []
    const winner = completedPartialSiblings.reduce((best, candidate) => {
      const candFinish = candidate.finishedAt ?? ''
      const bestFinish = best.finishedAt ?? ''
      if (candFinish > bestFinish) return candidate
      if (candFinish < bestFinish) return best
      return candidate.id > best.id ? candidate : best
    })
    if (winner.id !== runId) return []

    // Walk backward to find the previous distinct-createdAt group containing
    // at least one completed/partial run. RECENT_FETCH_LIMIT bounds the
    // backward walk; scaling it by project location count handles projects
    // with N>2 configured locations where an 8-row limit could be exhausted
    // by two fan-out groups alone.
    const projectLocations = this.db
      .select({ locations: projects.locations })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()
    const locationCount = Math.max(
      1,
      (projectLocations?.locations ?? []).length,
    )
    const RECENT_FETCH_LIMIT = Math.max(8, locationCount * 4)
    const recentRuns = this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, thisRun.kind),
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
    //
    // Orphan snapshots (queryId NULL, post-v58: tracked query was deleted)
    // are skipped — they all collide under a null key and a transition on
    // a no-longer-tracked query isn't useful to notify on.
    const prevMap = new Map<string, string>()
    for (const s of previousSnapshots) {
      if (s.queryId == null) continue
      prevMap.set(`${s.queryId}:${s.provider}:${s.location ?? ''}`, s.citationState)
    }

    const transitions: Array<{ query: string; from: string; to: string; provider: string; location: string | null }> = []
    for (const s of currentSnapshots) {
      if (s.queryId == null) continue
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

  /** True only when the destination accepted the payload. Callers that record "already said" must not count an attempt. */
  private async sendWebhook(url: string, payload: WebhookPayload | InsightWebhookPayload, notificationId: string, projectId: string, webhookSecret: string | null): Promise<boolean> {
    // A chat webhook IS a webhook whose body has to look a particular way, so
    // the destination is resolved from the URL rather than declared on the
    // stored notification. Discord and Slack both reject arbitrary JSON;
    // everything else about the send is identical.
    const destination = resolveDestination(url)
    const body = destination.render ? destination.render(toAlertView(payload as never)) : payload
    const signingSecret = destination.signed ? webhookSecret : null
    const targetLabel = redactNotificationUrl(url).urlDisplay
    const targetCheck = await resolveWebhookTarget(url)
    if (!targetCheck.ok) {
      log.error('webhook.ssrf-blocked', { url: targetLabel, reason: targetCheck.message })
      this.logDelivery(projectId, notificationId, payload.event, 'failed', `SSRF: ${targetCheck.message}`)
      return false
    }

    log.info('webhook.send', { event: payload.event, url: targetLabel })

    const maxRetries = 3
    const delays = [1000, 4000, 16000]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await deliverWebhook(targetCheck.target, body as never, signingSecret)

        if (response.status >= 200 && response.status < 300) {
          log.info('webhook.delivered', { event: payload.event, url: targetLabel, httpStatus: response.status })
          this.logDelivery(projectId, notificationId, payload.event, 'sent', null)
          return true
        }

        const errorDetail = response.error ?? `HTTP ${response.status}`
        log.warn('webhook.attempt-failed', { event: payload.event, url: targetLabel, attempt: attempt + 1, maxRetries, httpStatus: response.status, error: errorDetail })
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
        }
      } catch (err: unknown) {
        const errorDetail = describeError(err)
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
          log.error('webhook.exhausted', { event: payload.event, url: targetLabel, maxRetries, error: errorDetail })
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]!))
      }
    }
    return false
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

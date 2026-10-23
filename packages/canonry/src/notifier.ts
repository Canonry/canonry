import { deliverReviewEvent, reviewEventId } from './review-webhook-delivery.js'
import { eq, desc, and, inArray, or, isNull } from 'drizzle-orm'
import { deliverWebhook, measurementRunCompleteness, notProbeRun, redactNotificationUrl, resolveDestination, resolveWebhookTarget, toAlertView, webhookOutcomeTarget, webhookResponseReason, webhookTargetRefusalReason } from '@canonry/canonry-api-routes'
import type { DatabaseClient } from '@canonry/canonry-db'
import { auditLog, doctorHealthState, siteLivenessState, gbpLocations, gbpReviewRatings, gbpReviews, groupRunsByCreatedAt, insightNotifyState, notifications, projects, queries, querySnapshots, readNegativeReviewMaxStars, runs } from '@canonry/canonry-db'
import type { GbpReviewAlertState, NotificationEvent, WebhookPayload, InsightWebhookPayload, HealthWebhookPayload, RatingWebhookPayload, ReviewAlertLocation, ReviewWebhookPayload } from '@canonry/canonry-contracts'
import { businessProfileReviewsCover, isNegativeReviewRating, resolveNegativeReviewMaxStars } from '@canonry/canonry-contracts'
import type { RunCompletionOrigin } from '@canonry/canonry-contracts'
import type { AnalysisResult, Insight } from '@canonry/canonry-intelligence'
import crypto from 'node:crypto'
import { createLogger } from './logger.js'
import { isWithinAlertWindow } from './gbp-reviews.js'
import { CHECK_RUNTIME_ERROR_SUFFIX, CheckNotificationPolicies, CheckStatuses, compareText, describeError, notificationEventSchema, statusClassOf, type CheckNotificationPolicy, type OutcomeReasonCode, type StatusClass } from '@canonry/canonry-contracts'
import { createOutcomeSampler, outcomeFailure, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

const log = createLogger('Notifier')

/**
 * Deliveries fan out per event and destination, so their outcomes are sampled:
 * a burst of 20, then one a minute, with failures on their own key so a
 * stream of successes never starves them.
 */
const sampleDelivery = createOutcomeSampler({ burst: 20, refillMs: 60_000, now: () => Date.now() })

/** `feature.completed` `webhooks`/`deliver`: one per delivery, after its last attempt. */
function trackWebhookDelivery(input: {
  url: string
  event: string
  attempts: number
  durationBucket: ReturnType<ReturnType<typeof startOutcomeTimer>>
  statusClass: StatusClass
  failure?: { reasonCode: OutcomeReasonCode; errorName?: string }
}): void {
  const sample = sampleDelivery(input.failure ? 'failed' : 'succeeded')
  if (!sample.send) return
  const eventType = notificationEventSchema.safeParse(input.event)
  trackFeatureCompleted({
    feature: 'webhooks',
    operation: 'deliver',
    status: input.failure ? 'failed' : 'succeeded',
    surface: 'system',
    target: webhookOutcomeTarget(input.url),
    ...(eventType.success ? { eventType: eventType.data } : {}),
    statusClass: input.statusClass,
    counts: { attempts: input.attempts },
    durationBucket: input.durationBucket,
    ...input.failure,
    ...(sample.droppedBefore ? { droppedBefore: sample.droppedBefore } : {}),
  })
}

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

/** `fail` outranks `warn`; any other status is not a breach. */
function healthRank(status: string): number {
  return status === 'fail' ? 2 : status === 'warn' ? 1 : 0
}

/**
 * A pass where no check could be graded. It has no failing check to name, so
 * this code stands in for one wherever the failing set is compared.
 */
const HEALTH_NO_SIGNAL_CODE = 'health.no-signal'

/**
 * One failing check as the alert logic compares it. `id` is null only on an
 * entry read from `failing_signature`, which stores no check ids.
 */
interface Breach { id: string | null; code: string; rank: number }

const breachStatus = (breach: Breach): string => (breach.rank === 2 ? 'fail' : 'warn')

/** Stored `status:code:id` entries, or the `status:code` pairs of `failing_signature`. */
function parseBreaches(stored: string): Breach[] {
  const breaches: Breach[] = []
  for (const entry of stored.split(',')) {
    const [status, code, id] = entry.split(':')
    if (status && code) breaches.push({ id: id ?? null, code, rank: healthRank(status) })
  }
  return breaches
}

/** The `status:code:id` form `failing_checks` and `notified_signature` store. */
function formatBreaches(breaches: Iterable<Breach>): string {
  return [...breaches].map(b => `${breachStatus(b)}:${b.code}:${b.id}`).join(',')
}

/**
 * A failing set indexed for comparison: by check id, or by code when the
 * earlier pass stored no ids. Two checks reporting one code keep the worse.
 */
function indexBreaches(breaches: Iterable<Breach>, by: 'id' | 'code'): Map<string, Breach> {
  const index = new Map<string, Breach>()
  for (const breach of breaches) {
    const key = by === 'code' ? breach.code : breach.id
    if (key === null) continue
    const known = index.get(key)
    if (!known || breach.rank > known.rank) index.set(key, breach)
  }
  return index
}

/** New or worse than a baseline: not failing in it, more severe, or as severe with a different code. */
function isNews(now: Breach, was: Breach | undefined): boolean {
  return was === undefined || now.rank > was.rank || (now.rank === was.rank && now.code !== was.code)
}

const breachCodes = (breaches: Iterable<Breach>): string[] => [...new Set([...breaches].map(b => b.code))]

type GeneralHealthEvent = 'health.degraded' | 'health.recovered'
type UrgentHealthEvent = 'health.urgent' | 'health.urgent-resolved'

const URGENT_HEALTH_EVENTS: ReadonlySet<string> = new Set<UrgentHealthEvent>(['health.urgent', 'health.urgent-resolved'])

type HealthNotification = typeof notifications.$inferSelect
type UrgentReceipts = NonNullable<typeof doctorHealthState.$inferSelect.urgentReceipts>

/** Equal delivery histories retain the existing any-accepted fanout policy. */
function urgentReceiptGroups(subscribers: HealthNotification[], receipts: UrgentReceipts | null | undefined) {
  const groups = new Map<string | null, { notified: string | null; subscribers: HealthNotification[] }>()
  for (const subscriber of subscribers) {
    const { url } = subscriber.config
    const receipt = receipts?.[subscriber.id]
    const notified = receipt?.url === url ? receipt.notified : null
    const group = groups.get(notified)
    if (group) group.subscribers.push(subscriber)
    else groups.set(notified, { notified, subscribers: [subscriber] })
  }
  return [...groups.values()]
}

function recordUrgentReceipts(receipts: UrgentReceipts, subscribers: HealthNotification[], notified: string | null): void {
  for (const subscriber of subscribers) receipts[subscriber.id] = { url: subscriber.config.url, notified }
}

function doctorUrgentSummary(receipts: UrgentReceipts): string | null {
  const breaches = Object.values(receipts).flatMap(receipt => receipt.notified ? parseBreaches(receipt.notified) : [])
  const summary = formatUrgentBreaches(indexBreaches(breaches, 'id').values())
  return summary || null
}

function formatUrgentBreaches(breaches: Iterable<Breach>): string {
  return formatBreaches([...breaches].sort((a, b) => b.rank - a.rank
    || compareText(a.id ?? a.code, b.id ?? b.code) || compareText(a.code, b.code)))
}

function siteUrgentSummary(receipts: UrgentReceipts): string | null {
  return Object.values(receipts).find(receipt => receipt.notified !== null)?.notified ?? null
}

/** One urgent problem as an alert reports it, worst first. */
interface UrgentItem extends Breach {
  id: string
  status: 'warn' | 'fail'
  summary: string
  remediation: string | null
}

/** Stands in for a check code on `health.urgent-resolved`, which names no failing check. */
const HEALTH_URGENT_RESOLVED_CODE = 'health.urgent.resolved'

/**
 * Whether one webhook receives one health event.
 *
 * `health.degraded` and `health.recovered` reach every enabled webhook whether
 * or not it lists them (see onHealthChecked for why). The exception is a
 * webhook that lists an urgent event: it was set up to carry only what needs a
 * person, so it receives the health events it lists and no others. Without the
 * exception such a webhook would also get every routine warning, and the
 * channel it posts to would stop meaning "act now". An urgent event goes only
 * to the webhooks that list it.
 */
export function receivesHealthEvent(
  listed: readonly string[] | undefined,
  event: GeneralHealthEvent | UrgentHealthEvent,
): boolean {
  const events = listed ?? []
  if (URGENT_HEALTH_EVENTS.has(event)) return events.includes(event)
  return events.includes(event) || !events.some(e => URGENT_HEALTH_EVENTS.has(e))
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

type AnyWebhookPayload = WebhookPayload | InsightWebhookPayload | ReviewWebhookPayload | RatingWebhookPayload

export class Notifier {
  private db: DatabaseClient
  private serverUrl: string
  /**
   * The server's `allowLoopbackWebhooks`, so delivery admits exactly the
   * destinations that creating and testing a webhook admitted.
   */
  private allowLoopbackWebhooks: boolean
  /** Projects with a review dispatch in progress; see {@link dispatchReviewAlerts}. */
  private reviewDispatchInFlight = new Set<string>()

  constructor(db: DatabaseClient, serverUrl: string, opts: { allowLoopbackWebhooks?: boolean } = {}) {
    this.db = db
    this.serverUrl = serverUrl
    this.allowLoopbackWebhooks = opts.allowLoopbackWebhooks === true
  }

  /** Called after a run completes (success, partial, or failed). */
  async onRunCompleted(runId: string, projectId: string, opts?: { origin?: RunCompletionOrigin }): Promise<void> {
    log.info('run.completed', { runId, projectId, origin: opts?.origin ?? 'sweep' })

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

    // A fill completes a run whose `run.completed` already went out when the
    // sweep ended partial. Its citation transitions are new (they are held
    // back while a run is incomplete); a second `run.completed` is not.
    if ((run.status === 'completed' || run.status === 'partial') && opts?.origin !== 'fill') {
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
   * Record the outcome of a scheduled health pass and notify when it is news.
   *
   * `health.degraded` is sent when something is new or worse: the first pass
   * is already bad, a healthy project stops being healthy, the worst status
   * rises, or a check starts failing, gets more severe, or reports a different
   * problem at the same severity. A pass that finds the same problems is
   * stored but not re-sent: an operator who receives the same warning every
   * day stops reading the channel, which is how a real degradation goes
   * unnoticed.
   *
   * A pass that only CLEARS checks, or only eases one from fail to warn, is
   * not news either while something is still failing. It used to send a
   * second "degraded" alert that re-listed every standing item, so one
   * transient blip produced two alerts and neither said what had changed. It
   * is stored and logged as `health.improved`; the next alert lists what
   * cleared since the last one delivered. `health.recovered` is sent when
   * every check passes again.
   *
   * Checks are compared by id, not by code: a check changes its code when its
   * severity changes, so by code an easing check reads as one entry cleared
   * and another gained. A degraded alert no webhook accepted is sent again on
   * the next pass, because a quiet clearing pass would otherwise never
   * surface it.
   *
   * Urgent problems are tracked beside all of this, not inside it. A check
   * marks its own output `urgent`; when one starts, `health.urgent` goes to
   * the webhooks that list it, and `health.urgent-resolved` when the ones it
   * reported have cleared and none is known to be open. They keep their own
   * record of what a subscriber was told (`urgent_notified`) because they go
   * to different webhooks than the alert above and are accepted
   * independently: a refused urgent alert is owed again whether or not the
   * general one was delivered. The record exists only while a webhook
   * subscribes to urgent events.
   *
   * Returns the general event emitted, or null when none was sent. The return
   * value is what tests assert against, so "stayed quiet" is observable rather
   * than inferred from the absence of a webhook.
   */
  async onHealthChecked(
    projectId: string,
    report: {
      checks: Array<{ id: string; status: string; code: string; summary: string; remediation?: string | null; category?: string; notificationPolicy?: CheckNotificationPolicy; urgent?: boolean; details?: Record<string, unknown> }>
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
    const rank = healthRank

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
    const healthChecks = report.checks.filter(c => c.notificationPolicy !== CheckNotificationPolicies.silent)
    // A report-only pass says nothing about operational recovery. Preserve its state.
    if (healthChecks.length === 0 && report.checks.length > 0) return null
    const graded = healthChecks.filter(c => c.status === 'fail' || c.status === 'warn' || c.status === 'ok')
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
    const code = noSignal ? HEALTH_NO_SIGNAL_CODE : (worst?.code ?? 'health.ok')
    const summary = noSignal
      ? `No health check produced a result (${healthChecks.length} skipped) — health is unknown, not confirmed.`
      : (worst?.summary ?? `All ${graded.length} health check(s) passing.`)

    const previous = this.db.select().from(doctorHealthState)
      .where(eq(doctorHealthState.projectId, projectId)).get()
    const previousStatus = (previous?.status ?? null) as 'ok' | 'warn' | 'fail' | null

    // `failing` is already sorted deterministically above, so this is stable
    // across passes and only moves when the SET of breaches moves.
    const failingSignature = failing.map(c => `${c.status}:${c.code}`).join(',')

    // This pass's failing checks, worst first.
    const failingNow: Breach[] = failing.map(c => ({ id: c.id, code: c.code, rank: rank(c.status) }))
    if (noSignal) failingNow.push({ id: HEALTH_NO_SIGNAL_CODE, code, rank: rank(status) })

    // `failing_checks` carries the check ids of the pass before. It is trusted
    // only while it still spells the signature and headline stored beside it:
    // a release from before that column (a rollback runs one against the same
    // database) keeps those current and leaves the ids behind. Such a row is
    // compared by code for one pass, the rule before ids were stored.
    const storedChecks = previous?.failingChecks == null ? null : parseBreaches(previous.failingChecks)
    const idsKnown = previous === undefined || (
      storedChecks !== null
      && storedChecks.filter(b => b.id !== HEALTH_NO_SIGNAL_CODE).map(b => `${breachStatus(b)}:${b.code}`).join(',') === previous.failingSignature
      && (previousStatus === 'ok' || storedChecks.some(b => b.code === previous.code))
    )
    const by = idsKnown ? 'id' : 'code'

    // What the pass before found. A healthy or absent row had nothing failing.
    // A degraded row from before the signature column is `null`: its set is
    // unknown, and unknown is not the same as empty.
    let failingBefore: Breach[] | null
    if (previous === undefined || previousStatus === 'ok') {
      failingBefore = []
    } else if (idsKnown) {
      failingBefore = storedChecks
    } else if (previous.failingSignature === null) {
      failingBefore = null
    } else {
      // The headline is always part of the set; only a no-signal pass has a
      // headline the signature does not carry.
      failingBefore = [...parseBreaches(previous.failingSignature), { id: null, code: previous.code, rank: rank(previous.status) }]
    }
    const current = indexBreaches(failingNow, by)
    const before = failingBefore && indexBreaches(failingBefore, by)
    // What the operator has been told is failing: the set of the last alert a
    // webhook accepted. A row an older release has written since is past it
    // (that release sends its own alerts and records none of them here), so
    // such a row is compared against the previous pass alone.
    const notified = idsKnown && previous?.notifiedSignature != null
      ? indexBreaches(parseBreaches(previous.notifiedSignature), by)
      : null

    // A refused alert owes its triggering checks, even when an earlier alert
    // already reported the same code before that check cleared and returned.
    // The delivered set is only the clearance baseline, not a delivery receipt
    // for a later episode. Drop an owed check if it cleared, eased or was set
    // aside under its cause; an older writer invalidates the pending ids too.
    const currentById = indexBreaches(failingNow, 'id')
    const pending = idsKnown && previous?.pendingSignature != null
      ? parseBreaches(previous.pendingSignature).flatMap(was => {
          const now = was.id === null ? undefined : currentById.get(was.id)
          return now && now.rank >= was.rank ? [now] : []
        })
      : []
    const newBreaches = before === null
      ? null
      : [...current].filter(([key, now]) => isNews(now, before.get(key))).map(([, now]) => now)
    const newsIds = new Set([...(newBreaches ?? []), ...pending].map(b => b.id))
    const added = newBreaches === null ? null : breachCodes(failingNow.filter(b => newsIds.has(b.id)))

    // A check that left the failing set is cleared, unless the runner only set
    // it aside under its failing cause: that symptom is hidden, not fixed.
    const hidden = new Set<string>()
    for (const c of healthChecks) {
      if (c.status !== CheckStatuses.skipped || typeof c.details?.supersededCode !== 'string') continue
      hidden.add(c.id)
      hidden.add(c.details.supersededCode)
    }
    const goneFrom = (earlier: ReadonlyMap<string, Breach>): string[] => breachCodes(
      [...earlier]
        .filter(([key]) => !current.has(key) && !hidden.has(key))
        .map(([, was]) => was)
        .sort((a, b) => b.rank - a.rank || a.code.localeCompare(b.code)),
    )
    const clearedThisPass = before === null ? [] : goneFrom(before)
    const easedThisPass = before === null
      ? []
      : breachCodes([...current].filter(([key, now]) => now.rank < (before.get(key)?.rank ?? 0)).map(([, now]) => now))

    // Transition rules: a first observation only speaks up if it is already
    // bad, so installing this does not announce healthy projects.
    let event: 'health.degraded' | 'health.recovered' | null = null
    if (previous === undefined) {
      if (status !== 'ok') event = 'health.degraded'
    } else if (status === 'ok') {
      if (previousStatus !== 'ok') event = 'health.recovered'
    } else if (previousStatus === 'ok' || rank(status) > rank(previous.status)) {
      event = 'health.degraded'
    } else if (added === null) {
      // A row predating the signature column knows only its headline, so it
      // keeps the rule that column replaced for one pass: a new headline
      // notifies, anything beneath it does not. Treating unknown as changed
      // would page every already-degraded project on the first pass after
      // deploy.
      if (previous.code !== code) event = 'health.degraded'
    } else if (added.length > 0) {
      // A second breach opening under an existing one leaves the headline code
      // untouched, so the trigger reads the whole set: the ranking decides
      // which breach leads, never whether anyone is told. It reads only what
      // the set GAINED. A set that merely lost entries, a check that eased
      // from fail to warn, and a headline that changed because the old one
      // cleared are all the same standing problems, and re-sending them is
      // noise.
      event = 'health.degraded'
    }

    // What an alert reports as cleared: everything the operator was last told
    // is failing, or that was failing on the pass before, and is not failing
    // now. Reading only the pass before would drop a check that cleared on a
    // quiet pass in between, which no alert ever mentioned. A pass that
    // graded nothing cleared nothing, so it reports none.
    const cleared = before === null || noSignal ? null : goneFrom(new Map([...before, ...(notified ?? [])]))

    // Urgent problems, worst first: the failing checks whose output is marked
    // urgent, and any urgent symptom the runner set aside under its failing
    // cause. The second kind is the common one (a revoked grant fails the auth
    // check and supersedes every sync that depends on it), and the cause is
    // what explains it, so the alert quotes the cause under the symptom's code.
    const urgentItems: UrgentItem[] = []
    for (const c of failing) {
      if (c.urgent !== true) continue
      urgentItems.push({ id: c.id, code: c.code, rank: rank(c.status), status: c.status as 'warn' | 'fail', summary: c.summary, remediation: c.remediation ?? null })
    }
    for (const c of healthChecks) {
      const supersededCode = c.details?.supersededCode
      if (c.status !== CheckStatuses.skipped || c.urgent !== true || typeof supersededCode !== 'string') continue
      const causeIds = Array.isArray(c.details?.supersededBy) ? c.details.supersededBy as unknown[] : []
      const cause = failing.find(f => causeIds.includes(f.id))
      const status = c.details?.supersededStatus === 'warn' ? 'warn' : 'fail'
      urgentItems.push({ id: c.id, code: supersededCode, rank: rank(status), status, summary: cause?.summary ?? c.summary, remediation: cause?.remediation ?? null })
    }
    urgentItems.sort((a, b) => b.rank - a.rank)
    const urgentById = new Map(urgentItems.map(item => [item.id, item]))

    const generalEvent = event
    const urgentRecord = previous?.urgentNotified ?? null
    const enabled = generalEvent || urgentItems.length > 0 || urgentRecord
      ? this.db.select().from(notifications)
          .where(eq(notifications.projectId, projectId)).all().filter(n => n.enabled)
      : []
    const listedEvents = (notif: (typeof enabled)[number]) => (notif.config as { events?: string[] }).events
    const hasUrl = (notif: (typeof enabled)[number]) => Boolean((notif.config as { url?: string }).url)
    const urgentSubscribers = enabled.filter(n => hasUrl(n) && (listedEvents(n) ?? []).some(e => URGENT_HEALTH_EVENTS.has(e)))

    const conclusive = new Set(graded.filter(c => !c.code.endsWith(CHECK_RUNTIME_ERROR_SUFFIX)).map(c => c.id))
    // Keep histories by recipient. An unrecorded id or changed URL has heard
    // nothing, even when another webhook accepted the project's last alert.
    // Legacy aggregate records carry no identity and cannot establish a receipt.
    const urgentReceipts: UrgentReceipts = {}
    const recordedReceipts = previous?.urgentReceipts
    const validReceipts = recordedReceipts && doctorUrgentSummary(recordedReceipts) === urgentRecord ? recordedReceipts : null
    const urgentGroups = urgentReceiptGroups(urgentSubscribers, validReceipts).map(group => {
      const urgentTold = group.notified
        ? parseBreaches(group.notified).filter((b): b is Breach & { id: string } => b.id !== null)
        : []
      // Skipped, omitted and errored checks reached no verdict. Unknown checks
      // do not hold later resolutions back when an integration is disconnected.
      const urgentCleared = urgentTold.filter(b => conclusive.has(b.id) && !urgentById.has(b.id))
      const urgentUnknown = urgentTold.filter(b => !conclusive.has(b.id) && !urgentById.has(b.id))
      const urgentOpen = urgentTold.filter(b => urgentById.has(b.id) || hidden.has(b.id))
      const toldIds = new Set(urgentTold.map(b => b.id))
      const urgentNew = urgentItems.filter(item => !toldIds.has(item.id))
      const urgentEvent: UrgentHealthEvent | null = urgentNew.length > 0
        ? 'health.urgent'
        : urgentCleared.length > 0 && urgentOpen.length === 0 ? 'health.urgent-resolved' : null
      const urgentNotifs = urgentEvent ? group.subscribers.filter(n => receivesHealthEvent(listedEvents(n), urgentEvent)) : []
      const urgentSettled: Breach[] = urgentEvent === 'health.urgent-resolved' ? [] : [...urgentUnknown, ...urgentItems]
      // Persist debt before delivery; refusal retains the same decision. An
      // unlisted event settles immediately, and quiet passes drop cleared checks.
      const urgentBefore = urgentEvent === null
        ? [...urgentUnknown, ...urgentItems.filter(item => toldIds.has(item.id))]
        : urgentNotifs.length > 0 ? urgentTold : urgentSettled
      recordUrgentReceipts(urgentReceipts, group.subscribers, formatUrgentBreaches(urgentBefore) || null)
      return { ...group, urgentTold, urgentCleared, urgentNew, urgentEvent, urgentNotifs, urgentSettled }
    })

    const notifs = generalEvent ? enabled.filter(n => receivesHealthEvent(listedEvents(n), generalEvent)) : []
    const willAttempt = notifs.some(n => Boolean((n.config as { url?: string }).url))
    // Save what this attempt owes before delivering, so a restart during the
    // send cannot erase the alert. Legacy rows with an unknown earlier set owe
    // only the changed/worse headline, never unrelated standing checks.
    const triggerIds = new Set([
      ...(newBreaches ?? failingNow.filter(b => noSignal || b.id === worst?.id)),
      ...pending,
    ].map(b => b.id))
    const pendingNow = event === 'health.degraded' && willAttempt
      ? failingNow.filter(b => triggerIds.has(b.id))
      : null

    const now = report.checkedAt
    // Write the observation first so a delivery failure cannot lose it, but
    // leave `notifiedAt` alone until something is actually sent — it previously
    // recorded "decided to notify", which read as delivered even when zero
    // webhooks matched. Every pass is stored, quiet or not, so the next one
    // compares against the latest state.
    const observation = {
      projectId, status, code, summary, checkedAt: now, failingSignature,
      failingChecks: formatBreaches(failingNow),
      pendingSignature: pendingNow === null ? null : formatBreaches(pendingNow),
      urgentNotified: doctorUrgentSummary(urgentReceipts),
      urgentReceipts,
      // A delivered set an older release has written past is no longer what
      // the operator was last told.
      ...(idsKnown ? {} : { notifiedSignature: null }),
    }
    if (previous === undefined) {
      this.db.insert(doctorHealthState).values({ ...observation, notifiedAt: null }).run()
    } else {
      this.db.update(doctorHealthState).set(observation).where(eq(doctorHealthState.projectId, projectId)).run()
    }

    for (const group of urgentGroups) {
      const { urgentEvent, urgentTold, urgentNew, urgentCleared, urgentNotifs, urgentSettled } = group
      if (!urgentEvent) continue
      const toldRank = urgentTold.reduce((worstRank, b) => Math.max(worstRank, b.rank), 0)
      const previousUrgent = toldRank === 0 ? 'ok' : toldRank === 2 ? 'fail' : 'warn'
      const lead = urgentNew[0]
      // One resolved problem reads best as what its check says now ("GA4 data
      // is current through ..."). A check that only eased back to a warning
      // is no longer urgent, not fixed, and says so.
      const onlyCleared = urgentCleared.length === 1 ? graded.find(c => c.id === urgentCleared[0]!.id) : undefined
      const resolvedSummary = onlyCleared
        ? (onlyCleared.status === 'ok' ? onlyCleared.summary : `No longer urgent. ${onlyCleared.summary}`)
        : `${urgentCleared.length} urgent problems are resolved.`
      const urgentHealth: HealthWebhookPayload['health'] = urgentEvent === 'health.urgent' && lead
        ? {
            status: lead.status,
            code: lead.code,
            summary: lead.summary,
            remediation: lead.remediation,
            checkedAt: now,
            previousStatus: previousUrgent,
            failing: urgentItems.map(item => ({ id: item.id, status: item.status, code: item.code, summary: item.summary })),
            added: breachCodes(urgentNew),
            ...(urgentCleared.length > 0 ? { cleared: breachCodes(urgentCleared) } : {}),
          }
        : {
            status: 'ok',
            code: HEALTH_URGENT_RESOLVED_CODE,
            summary: resolvedSummary,
            remediation: null,
            checkedAt: now,
            previousStatus: previousUrgent,
            failing: [],
            cleared: breachCodes(urgentCleared),
          }
      const urgentPayload: HealthWebhookPayload = {
        source: 'canonry',
        event: urgentEvent,
        project: { name: project.name, canonicalDomain: project.canonicalDomain },
        health: urgentHealth,
        dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
      }
      let accepted = 0
      for (const notif of urgentNotifs) {
        const config = notif.config as { url: string }
        if (await this.sendWebhook(config.url, urgentPayload as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) accepted += 1
      }
      if (accepted > 0) {
        recordUrgentReceipts(urgentReceipts, group.subscribers, formatUrgentBreaches(urgentSettled) || null)
        this.db.update(doctorHealthState)
          .set({ urgentNotified: doctorUrgentSummary(urgentReceipts), urgentReceipts })
          .where(eq(doctorHealthState.projectId, projectId)).run()
      }
      if (urgentNotifs.length > 0) {
        log.info('health.urgent-notified', {
          projectId, event: urgentEvent,
          codes: urgentEvent === 'health.urgent' ? breachCodes(urgentNew) : breachCodes(urgentCleared),
          subscribers: urgentNotifs.length, delivered: accepted,
        })
      }
    }

    if (!event) {
      if (clearedThisPass.length > 0 || easedThisPass.length > 0) {
        log.info('health.improved', { projectId, status, code, cleared: clearedThisPass, eased: easedThisPass })
      } else {
        log.info('health.unchanged', { projectId, status, code })
      }
      return null
    }

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
        ...(added ? { added } : {}),
        ...(cleared ? { cleared } : {}),
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
    // them. The one exception is a webhook scoped to urgent events, which
    // `notifs` already leaves out (see receivesHealthEvent).
    let delivered = 0
    for (const notif of notifs) {
      const config = notif.config as { url: string; events?: string[] }
      if (!config.url) continue
      if (await this.sendWebhook(config.url, payload as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) delivered += 1
    }
    if (delivered > 0) {
      this.db.update(doctorHealthState)
        .set({ notifiedAt: now, notifiedSignature: formatBreaches(failingNow), pendingSignature: null })
        .where(eq(doctorHealthState.projectId, projectId)).run()
    }
    log.info('health.notified', {
      projectId, event, status, code,
      ...(added ? { added } : {}),
      ...(cleared ? { cleared } : {}),
      subscribers: notifs.length, delivered,
    })
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

    let event: GeneralHealthEvent | null = null
    if (check.status === 'fail' && failures >= SITE_LIVENESS_FAILURES_TO_PAGE && !outagePaged) event = 'health.degraded'
    if (check.status === 'ok' && outagePaged) event = 'health.recovered'

    // Webhooks scoped to urgent events keep their own record of the outage
    // (`urgent_notified_at`). They are a different audience from the other
    // webhooks and accept or refuse independently: sharing `notified_at` meant
    // an urgent webhook that refused the page was never retried once any other
    // webhook accepted it. The record survives the ok pass, so a refused
    // "back up" is owed as well, and it exists only while such a webhook does.
    const confirmed = check.status === 'fail' && failures >= SITE_LIVENESS_FAILURES_TO_PAGE
    const urgentRecord = previous?.urgentNotifiedAt ?? null
    // Webhooks are read only when there is something to decide, so a quiet
    // pass stays one row write.
    const enabled = event !== null || confirmed || urgentRecord !== null
      ? this.db.select().from(notifications)
          .where(eq(notifications.projectId, projectId)).all().filter(n => n.enabled)
      : []
    const listedEvents = (notif: (typeof enabled)[number]) => (notif.config as { events?: string[] }).events
    const hasUrl = (notif: (typeof enabled)[number]) => Boolean((notif.config as { url?: string }).url)
    const scoped = enabled.filter(n => hasUrl(n) && (listedEvents(n) ?? []).some(e => URGENT_HEALTH_EVENTS.has(e)))
    const urgentReceipts: UrgentReceipts = {}
    const recordedReceipts = previous?.urgentReceipts
    const validReceipts = recordedReceipts && siteUrgentSummary(recordedReceipts) === urgentRecord ? recordedReceipts : null
    const urgentGroups = urgentReceiptGroups(scoped, validReceipts).map(group => {
      const urgentEvent: UrgentHealthEvent | null = confirmed && group.notified === null
        ? 'health.urgent'
        : check.status === 'ok' && group.notified !== null ? 'health.urgent-resolved' : null
      const recipients = urgentEvent ? group.subscribers.filter(n => receivesHealthEvent(listedEvents(n), urgentEvent)) : []
      const generalName: GeneralHealthEvent = urgentEvent === 'health.urgent-resolved' ? 'health.recovered' : 'health.degraded'
      // Deduplicate only against a general event this pass actually sends.
      const generalRecipients = recipients.filter(n => event === generalName && receivesHealthEvent(listedEvents(n), generalName))
      const generalIds = new Set(generalRecipients.map(n => n.id))
      const urgentNotifs = recipients.filter(n => !generalIds.has(n.id))
      const settled = urgentEvent === 'health.urgent' ? checkedAt : null
      // A chosen general delivery still owes an acknowledgement. It can fail,
      // and the next pass then retries under the urgent name.
      const before = urgentEvent && recipients.length === 0 ? settled : group.notified
      recordUrgentReceipts(urgentReceipts, group.subscribers, before)
      return { ...group, urgentEvent, urgentNotifs, generalIds, settled }
    })

    const observation = {
      projectId,
      status: check.status,
      code: check.code,
      summary: check.summary,
      consecutiveFailures: failures,
      checkedAt,
      notifiedAt: check.status === 'ok' ? null : (previous?.notifiedAt ?? null),
      urgentNotifiedAt: siteUrgentSummary(urgentReceipts),
      urgentReceipts,
    }
    if (previous === undefined) {
      this.db.insert(siteLivenessState).values(observation).run()
    } else {
      this.db.update(siteLivenessState).set(observation).where(eq(siteLivenessState.projectId, projectId)).run()
    }

    // No log on a quiet pass: every project, every few minutes, would evict a
    // night of real diagnostics from the operational log buffer.
    if (!event && urgentGroups.every(group => group.urgentEvent === null)) return null

    const payloadFor = (name: GeneralHealthEvent | UrgentHealthEvent): HealthWebhookPayload => {
      const outage = name === 'health.degraded' || name === 'health.urgent'
      return {
        source: 'canonry',
        event: name,
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
          previousStatus: outage ? 'ok' : 'fail',
          failing: outage
            ? [{ id: check.id, status: check.status, code: check.code, summary: check.summary }]
            : [],
        },
        dashboardUrl: `${this.serverUrl}/projects/${project.name}`,
      }
    }

    const generalAccepted = new Set<string>()
    if (event) {
      // Same rule as onHealthChecked: health events reach every enabled
      // webhook, except one scoped to urgent events that does not list this one.
      const notifs = enabled.filter(n => hasUrl(n) && receivesHealthEvent(listedEvents(n), event))
      let delivered = 0
      for (const notif of notifs) {
        const config = notif.config as { url: string }
        if (await this.sendWebhook(config.url, payloadFor(event) as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) {
          delivered += 1
          generalAccepted.add(notif.id)
        }
      }
      if (event === 'health.degraded' && delivered > 0) {
        this.db.update(siteLivenessState).set({ notifiedAt: checkedAt })
          .where(eq(siteLivenessState.projectId, projectId)).run()
      }
      log.info('site-liveness.notified', { projectId, event, code: check.code, subscribers: notifs.length, delivered })
    }

    for (const group of urgentGroups) {
      const { urgentEvent, urgentNotifs, generalIds } = group
      if (!urgentEvent) continue
      let accepted = [...generalIds].filter(id => generalAccepted.has(id)).length
      for (const notif of urgentNotifs) {
        const config = notif.config as { url: string }
        if (await this.sendWebhook(config.url, payloadFor(urgentEvent) as unknown as WebhookPayload, notif.id, projectId, notif.webhookSecret ?? null)) accepted += 1
      }
      if (accepted > 0) {
        recordUrgentReceipts(urgentReceipts, group.subscribers, group.settled)
        this.db.update(siteLivenessState)
          .set({ urgentNotifiedAt: siteUrgentSummary(urgentReceipts), urgentReceipts })
          .where(eq(siteLivenessState.projectId, projectId)).run()
      }
      if (urgentNotifs.length > 0 || generalIds.size > 0) {
        log.info('site-liveness.urgent-notified', { projectId, event: urgentEvent, code: check.code, subscribers: urgentNotifs.length + generalIds.size, delivered: accepted })
      }
    }
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
        if (await this.sendWebhook(config.url, payload, notif.id, projectId, notif.webhookSecret ?? null)) {
          for (const insight of relevantInsights) this.rememberInsightNotified(projectId, insight)
        }
      }
    }
  }

  /**
   * Send what a GBP sync queued: negative reviews (`review.negative`) and
   * public rating drops (`review.rating-dropped`).
   *
   * The queue is the `alert_state` the sync writes, so nothing here decides
   * what is news. This only decides whether a queued alert can still be sent:
   *   - a Places signal for a location that Business Profile reviews now cover
   *     (see `businessProfileReviewsCover`) is `suppressed`, so gaining v4
   *     access never alerts twice;
   *   - an alert older than the alert window is `stale`, so a webhook that was
   *     down for weeks does not replay a month of reviews once it is fixed;
   *   - with no enabled webhook subscribed, it is `skipped` rather than held,
   *     so subscribing later starts from new reviews instead of a backlog;
   *   - a review above the project's threshold is `none`, so lowering the
   *     threshold also stops reviews queued before the change.
   * Raising the threshold does not reach back: reviews already recorded as
   * `none` stay that way, and only new or edited ones use the new value.
   * A row becomes `sent` only after a destination accepted it, and stays
   * `pending` when every delivery failed, so the next sync retries it.
   */
  async dispatchReviewAlerts(projectId: string): Promise<{ reviews: number; ratingDrops: number; delivered: number }> {
    const nothing = { reviews: 0, ratingDrops: 0, delivered: 0 }
    // Two syncs finishing together would both read the same pending rows
    // before either marks them sent. The later one skips; anything it queued
    // stays pending for the next dispatch.
    if (this.reviewDispatchInFlight.has(projectId)) return nothing
    this.reviewDispatchInFlight.add(projectId)
    try {
      return await this.dispatchQueuedReviewAlerts(projectId)
    } finally {
      this.reviewDispatchInFlight.delete(projectId)
    }
  }

  private async dispatchQueuedReviewAlerts(projectId: string): Promise<{ reviews: number; ratingDrops: number; delivered: number }> {
    const pendingReviews = this.db.select().from(gbpReviews)
      .where(and(eq(gbpReviews.projectId, projectId), eq(gbpReviews.alertState, 'pending')))
      .all()
    const pendingRatings = this.db.select().from(gbpReviewRatings)
      .where(and(eq(gbpReviewRatings.projectId, projectId), eq(gbpReviewRatings.alertState, 'pending')))
      .all()
    if (pendingReviews.length === 0 && pendingRatings.length === 0) return { reviews: 0, ratingDrops: 0, delivered: 0 }

    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) return { reviews: 0, ratingDrops: 0, delivered: 0 }

    const now = new Date()
    const nowIso = now.toISOString()
    const negativeMaxStars = resolveNegativeReviewMaxStars(readNegativeReviewMaxStars(this.db, projectId))
    const locations = new Map(
      this.db.select({
        locationName: gbpLocations.locationName,
        displayName: gbpLocations.displayName,
        mapsUri: gbpLocations.mapsUri,
        reviewsAccess: gbpLocations.reviewsAccess,
      }).from(gbpLocations).where(eq(gbpLocations.projectId, projectId)).all()
        .map((loc) => [loc.locationName, loc]),
    )
    const v4HasWorked = new Set(
      this.db.select({ locationName: gbpReviewRatings.locationName }).from(gbpReviewRatings)
        .where(and(eq(gbpReviewRatings.projectId, projectId), eq(gbpReviewRatings.origin, 'gbp')))
        .all()
        .map((row) => row.locationName),
    )
    const coveredByBusinessProfile = (locationName: string): boolean =>
      businessProfileReviewsCover(locations.get(locationName)?.reviewsAccess ?? null, v4HasWorked.has(locationName))
    const locationRef = (locationName: string): ReviewAlertLocation => {
      const loc = locations.get(locationName)
      return { name: locationName, displayName: loc?.displayName ?? locationName, mapsUri: loc?.mapsUri ?? null }
    }
    const setReviewState = (ids: string[], alertState: GbpReviewAlertState): void => {
      if (ids.length === 0) return
      this.db.update(gbpReviews).set({ alertState, alertStateAt: nowIso }).where(inArray(gbpReviews.id, ids)).run()
    }
    const setRatingState = (ids: string[], alertState: GbpReviewAlertState): void => {
      if (ids.length === 0) return
      this.db.update(gbpReviewRatings).set({ alertState, alertStateAt: nowIso }).where(inArray(gbpReviewRatings.id, ids)).run()
    }

    const reviewsToSend: typeof pendingReviews = []
    for (const row of pendingReviews) {
      if (row.origin === 'places' && coveredByBusinessProfile(row.locationName)) setReviewState([row.id], 'suppressed')
      else if (!isWithinAlertWindow(row.updateTime, now)) setReviewState([row.id], 'stale')
      else if (!isNegativeReviewRating(row.starRating, negativeMaxStars)) setReviewState([row.id], 'none')
      else reviewsToSend.push(row)
    }
    const ratingsToSend: typeof pendingRatings = []
    for (const row of pendingRatings) {
      if (coveredByBusinessProfile(row.locationName)) setRatingState([row.id], 'suppressed')
      else if (!isWithinAlertWindow(row.firstObservedAt, now)) setRatingState([row.id], 'stale')
      else if (row.rating === null || row.previousRating === null) setRatingState([row.id], 'none')
      else ratingsToSend.push(row)
    }

    const enabled = this.db.select().from(notifications)
      .where(eq(notifications.projectId, projectId)).all()
      .filter((n) => n.enabled && n.config.url)
    const subscribedTo = (event: NotificationEvent) =>
      enabled.filter((n) => ((n.config.events ?? []) as string[]).includes(event))
    const projectRef = { name: project.name, canonicalDomain: project.canonicalDomain }
    const dashboardUrl = `${this.serverUrl}/projects/${project.name}`

    let delivered = 0
    const sendAll = async (event: NotificationEvent, payload: ReviewWebhookPayload | RatingWebhookPayload): Promise<number> => {
      let accepted = 0
      for (const notif of subscribedTo(event)) {
        if (await this.sendWebhook(notif.config.url, payload, notif.id, projectId, notif.webhookSecret ?? null)) accepted += 1
      }
      return accepted
    }

    if (reviewsToSend.length > 0) {
      const ids = reviewsToSend.map((r) => r.id)
      if (subscribedTo('review.negative').length === 0) {
        setReviewState(ids, 'skipped')
      } else {
        reviewsToSend.sort((a, b) => a.updateTime.localeCompare(b.updateTime))
        // One immutable material revision per event. Delivery receipts are per
        // destination, so one successful receiver cannot erase another's debt.
        for (const review of reviewsToSend) {
          const payload: ReviewWebhookPayload = {
            source: 'canonry',
            event: 'review.negative',
            eventId: reviewEventId(projectId, review),
            project: projectRef,
            reviews: [{
              location: locationRef(review.locationName), origin: review.origin,
              reviewName: review.reviewName, starRating: review.starRating!,
              comment: review.comment, reviewerName: review.reviewerName,
              createTime: review.createTime, updateTime: review.updateTime,
              replied: review.origin === 'places' ? null : review.replyComment !== null,
              reviewUri: review.reviewUri,
            }],
            dashboardUrl,
          }
          let all = true
          for (const notification of subscribedTo('review.negative')) {
            const sent = await deliverReviewEvent({
              db: this.db, projectId, notificationId: notification.id, payload,
              allowLoopback: this.allowLoopbackWebhooks,
              onDelivered: () => { delivered += 1 },
            })
            if (!sent) all = false
          }
          // Never mark a newer material edit sent because an older request finished.
          if (all) {
            this.db.update(gbpReviews).set({ alertState: 'sent', alertStateAt: nowIso })
              .where(and(
                eq(gbpReviews.id, review.id),
                eq(gbpReviews.alertState, 'pending'),
                eq(gbpReviews.updateTime, review.updateTime),
                review.alertStateAt === null ? isNull(gbpReviews.alertStateAt) : eq(gbpReviews.alertStateAt, review.alertStateAt),
                review.comment === null ? isNull(gbpReviews.comment) : eq(gbpReviews.comment, review.comment),
                review.starRating === null ? isNull(gbpReviews.starRating) : eq(gbpReviews.starRating, review.starRating),
              )).run()
          }
        }
      }
    }

    if (ratingsToSend.length > 0) {
      const ids = ratingsToSend.map((r) => r.id)
      if (subscribedTo('review.rating-dropped').length === 0) {
        setRatingState(ids, 'skipped')
      } else {
        const payload: RatingWebhookPayload = {
          source: 'canonry',
          event: 'review.rating-dropped',
          project: projectRef,
          ratings: ratingsToSend.map((r) => ({
            location: locationRef(r.locationName),
            origin: r.origin,
            previousRating: r.previousRating!,
            rating: r.rating!,
            previousReviewCount: r.previousReviewCount,
            reviewCount: r.reviewCount,
            observedAt: r.firstObservedAt,
          })),
          dashboardUrl,
        }
        const accepted = await sendAll('review.rating-dropped', payload)
        if (accepted > 0) setRatingState(ids, 'sent')
        delivered += accepted
      }
    }

    log.info('reviews.dispatched', {
      projectId,
      reviews: reviewsToSend.length,
      ratingDrops: ratingsToSend.length,
      delivered,
    })
    return { reviews: reviewsToSend.length, ratingDrops: ratingsToSend.length, delivered }
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
        notProbeRun(),
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
          notProbeRun(),
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
  private async sendWebhook(url: string, payload: AnyWebhookPayload, notificationId: string, projectId: string, webhookSecret: string | null): Promise<boolean> {
    const elapsed = startOutcomeTimer()
    // A chat webhook IS a webhook whose body has to look a particular way, so
    // the destination is resolved from the URL rather than declared on the
    // stored notification. Discord and Slack both reject arbitrary JSON;
    // everything else about the send is identical.
    const destination = resolveDestination(url)
    const body = destination.render ? destination.render(toAlertView(payload as never)) : payload
    const signingSecret = destination.signed ? webhookSecret : null
    const targetLabel = redactNotificationUrl(url).urlDisplay
    const targetCheck = await resolveWebhookTarget(url, { allowLoopback: this.allowLoopbackWebhooks })
    if (!targetCheck.ok) {
      log.error('webhook.ssrf-blocked', { url: targetLabel, reason: targetCheck.message })
      this.logDelivery(projectId, notificationId, payload.event, 'failed', `SSRF: ${targetCheck.message}`)
      const reasonCode = webhookTargetRefusalReason(targetCheck)
      trackWebhookDelivery({
        url, event: payload.event, attempts: 0, durationBucket: elapsed(),
        statusClass: reasonCode === 'NETWORK' ? 'network' : 'blocked', failure: { reasonCode },
      })
      return false
    }

    log.info('webhook.send', { event: payload.event, url: targetLabel })

    const maxRetries = 3
    const delays = [1000, 4000, 16000]
    // The last attempt's answer, for the delivery outcome.
    let lastStatusClass: StatusClass = 'network'
    let lastFailure: { reasonCode: OutcomeReasonCode; errorName?: string } = { reasonCode: 'UNKNOWN' }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await deliverWebhook(targetCheck.target, body as never, signingSecret)

        if (response.status >= 200 && response.status < 300) {
          log.info('webhook.delivered', { event: payload.event, url: targetLabel, httpStatus: response.status })
          this.logDelivery(projectId, notificationId, payload.event, 'sent', null)
          trackWebhookDelivery({ url, event: payload.event, attempts: attempt + 1, durationBucket: elapsed(), statusClass: '2xx' })
          return true
        }

        const errorDetail = response.error ?? `HTTP ${response.status}`
        log.warn('webhook.attempt-failed', { event: payload.event, url: targetLabel, attempt: attempt + 1, maxRetries, httpStatus: response.status, error: errorDetail })
        lastStatusClass = response.status === 0 && response.timedOut ? 'timeout' : statusClassOf(response.status)
        lastFailure = { reasonCode: webhookResponseReason(response) ?? 'UNKNOWN' }
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
        }
      } catch (err: unknown) {
        const errorDetail = describeError(err)
        lastStatusClass = 'network'
        lastFailure = outcomeFailure(err)
        if (attempt === maxRetries - 1) {
          this.logDelivery(projectId, notificationId, payload.event, 'failed', errorDetail)
          log.error('webhook.exhausted', { event: payload.event, url: targetLabel, maxRetries, error: errorDetail })
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]!))
      }
    }
    trackWebhookDelivery({
      url, event: payload.event, attempts: maxRetries, durationBucket: elapsed(),
      statusClass: lastStatusClass, failure: lastFailure,
    })
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

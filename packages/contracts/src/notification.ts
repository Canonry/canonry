import { z } from 'zod'
import type { GbpReviewOrigin } from './gbp.js'
import type { QueryClass } from './query-class.js'

export const REDACTED_NOTIFICATION_URL_PROTOCOL = 'redacted:'

export function buildRedactedNotificationUrl(host: string, id: string): string {
  return `${REDACTED_NOTIFICATION_URL_PROTOCOL}//${host}/${id}`
}

export function isRedactedNotificationUrl(url: string): boolean {
  if (url.startsWith(`${REDACTED_NOTIFICATION_URL_PROTOCOL}//`)) return true
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.pathname === '/redacted'
      && parsed.search === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}

export const notificationEventSchema = z.enum([
  /**
   * The project's domain dropped out of, or appeared in, an answer's source
   * links since the previous sweep. An answer from an engine that returns no
   * sources (`not-measured`) never moves in or out of either state.
   */
  'citation.lost',
  'citation.gained',
  /**
   * The project's brand or domain dropped out of, or appeared in, an answer's
   * prose since the previous sweep. Independent of the citation events: an
   * answer can gain a mention while losing its citation. An answer whose
   * mention was never checked (no stored answer text and no stored verdict)
   * never moves in or out of either state.
   */
  'mention.lost',
  'mention.gained',
  'run.completed',
  'run.failed',
  'insight.critical',
  'insight.high',
  /**
   * Instrument health, as opposed to findings. Every other event above reports
   * what the measurement SAW; these two report whether the measurement is
   * trustworthy at all. They exist because a degraded pipeline keeps emitting
   * `run.completed` — a success signal — while producing wrong numbers.
   *
   * Edge-triggered: `health.degraded` is emitted when a check starts failing
   * or gets worse, and `health.recovered` when every check passes again. A
   * scheduled pass that finds the same problems, or fewer, sends nothing, so
   * a persistent warning does not train the operator to ignore the channel.
   */
  'health.degraded',
  'health.recovered',
  /**
   * The few health problems a person has to act on now: the website is down,
   * daily data has stopped arriving, or a sync keeps failing. A check marks
   * its own output `urgent`; most warnings are not.
   *
   * `health.urgent` is sent when an urgent problem starts, and
   * `health.urgent-resolved` when the problems it reported have cleared and
   * none is known to be open. The scheduled health pass and the website check
   * report separately, so a data problem and a site outage each get their own
   * resolved message. Every urgent problem is also part of `health.degraded`,
   * so these two add no news of their own. They exist so one webhook can
   * carry only what needs a person: a webhook that lists either of them
   * receives the health events it lists and no others, while every other
   * webhook keeps receiving `health.degraded` and `health.recovered` whether
   * it lists them or not.
   */
  'health.urgent',
  'health.urgent-resolved',
  /**
   * Google Business Profile reviews. `review.negative` is sent once for each
   * new or edited review at or below the project's `negativeReviewMaxStars`
   * (1-3 stars by default). `review.rating-dropped` is sent when
   * a location's public Google rating falls, a fallback signal for locations
   * without Business Profile reviews access. A location's first sync records a
   * baseline and sends neither, so connecting never replays old reviews.
   */
  'review.negative',
  'review.rating-dropped',
  /**
   * A self-identified bot or agent that no classifier rule recognizes showed up
   * in the project's server-side traffic: first seen in the last 7 days, with at
   * least 3 hits. Sent once per name, grouped per pass. Names first seen before
   * that window or in the project's first 7 days of recorded traffic never
   * alert, and nothing is held for a webhook added later.
   */
  'traffic.agent.discovered',
  /**
   * A site audit found a critical Site Health problem nobody was told about
   * yet: a critical page defect (no H1, several H1s, no title, a page naming
   * another property) on a page where it was not reported before. Sent only to
   * webhooks that list it, and only when something is new, so a problem that
   * stays unfixed is reported once. A partial scan can add problems but never
   * forgets one; only a complete scan that no longer finds a problem clears
   * it, so the problem is reported again if it comes back.
   */
  'site-health.issue.new',
  /**
   * Sentiment found an answer newly unfavorable about the brand (or, on a
   * custom portfolio, a Property): rated `unfavorable` now, where the same
   * query, engine, location and subject had a known verdict that was not
   * unfavorable in the previous rated sweep of its class. Sent once per sweep,
   * after that sweep's automatic sentiment work settles, so an answer that
   * stays unfavorable is reported once. Sweeps are reported in order: one
   * waits until every earlier sweep's sentiment has settled, and a sweep
   * that settles while sentiment is off waits until it is back on. Both query classes are covered and
   * each answer names its class. A sweep judged by another evaluator
   * definition, or an answer whose engine or evaluator model changed, is no
   * like-for-like change and sends nothing; so do backfills, and the sweeps
   * that settled before a project's first pass.
   */
  'sentiment.unfavorable',
])
export type NotificationEvent = z.infer<typeof notificationEventSchema>

/**
 * One line per event, shown wherever a webhook's events are chosen (`canonry
 * notify events`, the dashboard's webhook form). Keyed by every event, so a new
 * event cannot ship without one.
 */
export const NOTIFICATION_EVENT_DESCRIPTIONS: Readonly<Record<NotificationEvent, string>> = {
  'citation.lost': "A query's answer stopped citing the project's domain in its sources",
  'citation.gained': "A query's answer started citing the project's domain in its sources",
  'mention.lost': "A query's answer stopped mentioning the project's brand or domain in its text",
  'mention.gained': "A query's answer started mentioning the project's brand or domain in its text",
  'run.completed': 'An AEO sweep completed successfully',
  'run.failed': 'An AEO sweep failed',
  'insight.critical': 'A critical-severity insight was generated',
  'insight.high': 'A high-severity insight was generated',
  'health.degraded': 'A scheduled health check found the measurement degraded, daily data stopped arriving, or the website stopped answering (sent when a check starts failing or gets worse, not every pass)',
  'health.recovered': 'A degraded health check is passing again, or a website that was paged as down answers again',
  'health.urgent': 'An urgent problem started: the website is down, GA4 or Search Console data is stale, or a sync keeps failing. A webhook that lists this receives only the health events it lists, so it is not sent routine warnings',
  'health.urgent-resolved': 'The urgent problems that were reported have cleared (the website check and the scheduled health pass each send their own)',
  'review.negative': "A new or edited Google review at or below the project's negative-review threshold, 3 stars by default (Business Profile reviews, or the public listing when Google has not enabled review access)",
  'review.rating-dropped': "A location's public Google rating fell (sent for locations without Business Profile review access)",
  'traffic.agent.discovered': 'A bot or agent no Canonry rule recognizes showed up in server-side traffic (first seen in the last 7 days, at least 3 hits, after the first week of recorded traffic), once per name',
  'sentiment.unfavorable': "Sentiment rated an answer about the brand (or a Property) unfavorable where the previous rated sweep's matching answer was not; an answer that stays unfavorable is reported once",
  'site-health.issue.new': 'An Agent Readiness audit scan found a critical page problem (no H1, several H1s, no title, a page naming another property) on pages where it was not reported before; a problem that stays unfixed is reported once',
}

export const notificationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  channel: z.literal('webhook'),
  url: z.string().url(),
  urlDisplay: z.string(),
  urlHost: z.string(),
  events: z.array(notificationEventSchema),
  enabled: z.boolean().default(true),
  /** Opaque tag identifying the creator (e.g. `"agent"` for Aero webhooks). */
  source: z.string().optional(),
  webhookSecret: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type NotificationDto = z.infer<typeof notificationDtoSchema>

export const notificationCreateRequestSchema = z.object({
  channel: z.literal('webhook'),
  url: z.string().url(),
  events: z.array(notificationEventSchema).min(1),
  source: z.string().optional(),
})

export type NotificationCreateRequest = z.infer<typeof notificationCreateRequestSchema>

/**
 * Change an existing webhook in place: its events and whether it sends.
 * `events` replaces the whole list; `addEvents` / `removeEvents` change it
 * relative to what is stored (applied on the server, so two callers never
 * overwrite each other) and cannot be combined with `events`. The URL is not
 * editable here; a different destination is a new webhook with a new signing
 * secret. Name at least one field.
 */
export const notificationUpdateRequestSchema = z.object({
  events: z.array(notificationEventSchema).min(1).optional(),
  addEvents: z.array(notificationEventSchema).min(1).optional(),
  removeEvents: z.array(notificationEventSchema).min(1).optional(),
  enabled: z.boolean().optional(),
}).strict()

export type NotificationUpdateRequest = z.infer<typeof notificationUpdateRequestSchema>

export interface InsightWebhookPayload {
  source: 'canonry'
  event: 'insight.critical' | 'insight.high'
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  insights: Array<{
    id: string
    type: string
    severity: string
    title: string
    query: string
    provider: string
  }>
  dashboardUrl: string
}

/**
 * Health events carry no `run`: they report on the measurement apparatus, not
 * on a sweep. Deliberately a separate payload rather than a run payload with a
 * null run, because a subscriber that keys off `run.id` should fail loudly on
 * a health event instead of silently treating it as a finding about the site.
 */
export interface HealthWebhookPayload {
  source: 'canonry'
  /**
   * On the two urgent events `health` describes the urgent problems only:
   * `failing` and `added` list urgent checks, and `cleared` lists the urgent
   * checks that are no longer a problem.
   */
  event: 'health.degraded' | 'health.recovered' | 'health.urgent' | 'health.urgent-resolved'
  project: { name: string; canonicalDomain: string }
  health: {
    /** Worst check status observed on this pass. */
    status: 'ok' | 'warn' | 'fail'
    /** Stable code of the worst check, e.g. "traffic.sync-lag.discarding". */
    code: string
    summary: string
    remediation: string | null
    checkedAt: string
    /** What the status was before this pass, so the transition is explicit. */
    previousStatus: 'ok' | 'warn' | 'fail' | null
    /**
     * Every non-ok check on this pass, worst first, each with its own next step
     * so whichever one an alert leads with keeps it. `alert` is the check's
     * plain wording, when it has one.
     */
    failing: Array<{ id: string; status: string; code: string; summary: string; remediation?: string | null; alert?: { label: string; line: string; next: string | null } }>
    /**
     * Codes of the checks that are new or worse, worst first: a check that
     * started failing, got more severe, or reports a different problem at the
     * same severity, on this pass or since the last alert a webhook accepted.
     * They are what a `health.degraded` alert is about; every other entry in
     * `failing` is one the operator has already been told about. Absent on
     * website liveness alerts, and when the earlier failing set is unknown.
     */
    added?: string[]
    /**
     * Codes of the checks that were failing when the last alert was
     * delivered, or on the pass before this one, and are not failing now. A
     * pass that only clears checks sends no alert, so the next alert reports
     * what cleared since. A check that still fails under another code, or
     * that was set aside under its failing cause, has not cleared. Absent on
     * website liveness alerts, when the earlier set is unknown, and on a pass
     * where no check could be graded.
     */
    cleared?: string[]
  }
  dashboardUrl: string
}

/**
 * How a `health.urgent-resolved` summary starts when its one problem only
 * eased (still a warning, no longer urgent) rather than cleared, so an alert
 * never calls it fixed.
 */
export const HEALTH_NO_LONGER_URGENT = 'No longer urgent.'

export interface WebhookPayload {
  source: 'canonry'
  event: NotificationEvent
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  /**
   * Answers whose signal changed since the previous sweep, one per query,
   * engine and location. On `mention.lost` / `mention.gained`, `from` and `to`
   * are `mentioned` / `not-mentioned`. On every other event they are citation
   * states (`cited` / `not-cited`): `run.completed` and `run.failed` carry the
   * citation changes, as they always have.
   *
   * On a custom portfolio (an active schema v2 measurement plan) each
   * transition is one Property's answer, read from the frozen plan as the
   * overview's What changed reads it, and carries `property` and `markets`. A
   * sweep that cannot be compared with the one before it (a different plan
   * definition, engines or models, either sweep partial, or a spot check,
   * which the report never compares with a whole-plan sweep) sends no
   * transitions there.
   */
  transitions: Array<{
    query: string
    from: string
    to: string
    provider: string
    /**
     * Location label this transition was observed at. Optional for backward
     * compatibility with subscribers built before multi-location fan-out was
     * supported; the field is populated for all transitions produced by
     * canonry post-#480 when the underlying snapshot carries a location.
     */
    location?: string | null
    /**
     * `branded` or `non-brand`: a branded query names the project, so its
     * answers say little about the category. Null when the query has no
     * single class (an unclassifiable query, or assignments that disagree).
     */
    queryClass?: QueryClass | null
    /** Custom portfolios only: the Property whose mention or citation changed. */
    property?: { key: string; label: string }
    /** Custom portfolios only: the frozen reporting markets of that Property's assignments of this query. */
    markets?: Array<{ key: string; label: string }>
  }>
  dashboardUrl: string
}

/** New bots and agents in a project's server-side traffic that no classifier rule recognizes. */
export interface UnrecognizedAgentWebhookPayload {
  source: 'canonry'
  event: 'traffic.agent.discovered'
  project: { name: string; canonicalDomain: string }
  agents: Array<{
    /** The name the agent gives in its user agent, lowercased. */
    name: string
    hits: number
    firstSeenAt: string
    lastSeenAt: string
    sampleUserAgent: string | null
    samplePath: string | null
  }>
  dashboardUrl: string
}

/** One critical Site Health problem in a `site-health.issue.new` payload. */
export interface SiteHealthIssueAlert {
  /** The audit engine's critical defect id, e.g. `multiple-h1` or `names-another-entity`. */
  code: string
  /** Short label, e.g. "Multiple H1 tags". */
  title: string
  severity: 'critical'
  /** Pages this scan found with the problem. */
  affectedPages: number
  /** Of those, the pages where it was not reported before. */
  newPages: number
  /** Up to five of the new pages, sorted. */
  examples: string[]
}

/**
 * New critical problems from a site audit. Carries the audit's `run` like the
 * run events, and only the problems that are new, most new pages first.
 */
export interface SiteHealthIssueWebhookPayload {
  source: 'canonry'
  event: 'site-health.issue.new'
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  /** Whether the scan reached every page it found. A partial scan can miss pages. */
  scanComplete: boolean
  issues: SiteHealthIssueAlert[]
  dashboardUrl: string
}

/** One answer sentiment newly rates unfavorable, in a `sentiment.unfavorable` payload. */
export interface SentimentUnfavorableAnswer {
  query: string
  queryId: string
  /** Sentiment is a branded figure: a non-brand answer names the brand to recommend it, so read its verdict as an exception. */
  queryClass: 'branded' | 'non-brand'
  provider: string
  location: string | null
  /** Custom portfolios only: the Property the verdict is about. On a Simple project the subject is the project's brand. */
  property?: { key: string; label: string }
  /** Custom portfolios only: the frozen reporting markets of that Property's assignments of this query. */
  markets?: Array<{ key: string; label: string }>
  /** The sweep the answer was compared with: the previous rated sweep of its class. */
  previousRunId: string
  /** The verdict on the matching answer there, e.g. `favorable`, `mixed` or `factual`. */
  previousOutcome: string
  /** The sentences the evaluator based the verdict on, quoted from the answer. */
  conclusion: string[]
  /** The complaint the evaluator found in the answer, quoted, when it found one. */
  complaint: string[] | null
}

/**
 * Answers a sweep's sentiment newly rates unfavorable. Carries the sweep's
 * `run` like the run events; the verdicts arrive after it completes.
 */
export interface SentimentWebhookPayload {
  source: 'canonry'
  event: 'sentiment.unfavorable'
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
  /** Ordered by query, engine, location and Property. */
  answers: SentimentUnfavorableAnswer[]
  dashboardUrl: string
}

/** A location as named in a review webhook. */
export interface ReviewAlertLocation {
  /** Business Profile resource name, "locations/{n}". */
  name: string
  displayName: string
  /** Public Google Maps link for the location, when Google provides one. */
  mapsUri: string | null
}

/**
 * Review events carry no `run`: they report on the business listing, not on a
 * sweep, for the same reason health payloads omit it.
 */
export interface ReviewWebhookPayload {
  source: 'canonry'
  event: 'review.negative'
  /** Stable material-review revision identity, shared across destination retries. */
  eventId?: string
  project: { name: string; canonicalDomain: string }
  /** Oldest first, so a receiver that posts one message per review keeps the order they arrived in. */
  reviews: Array<{
    location: ReviewAlertLocation
    /** `gbp`: Business Profile reviews (every review). `places`: the public listing (at most five, by relevance). */
    origin: GbpReviewOrigin
    /** Provider resource name, stable per origin. */
    reviewName: string
    /** At or below the project's negative-review threshold (3 by default). */
    starRating: number
    comment: string | null
    reviewerName: string | null
    createTime: string | null
    /** Last edit by the reviewer (Places: when it was posted). */
    updateTime: string
    /** Whether the owner has replied. Null for Places, which does not expose replies. */
    replied: boolean | null
    /** Link to the review on Google Maps, when the origin provides one. */
    reviewUri: string | null
  }>
  dashboardUrl: string
}

/**
 * One review event's delivery to one destination. `uncertain` is a chat send
 * that reached the network with no answer (never resent, since chat webhooks
 * cannot deduplicate); `failed` is a destination that refused it or a send out
 * of retries. Both wait for a person: the `gbp.reviews.delivery` doctor check
 * lists them.
 */
export const ReviewDeliveryStates = Object.freeze({
  Pending: 'pending',
  Attempting: 'attempting',
  Sent: 'sent',
  Uncertain: 'uncertain',
  Failed: 'failed',
  Canceled: 'canceled',
} as const)
export type ReviewDeliveryState = (typeof ReviewDeliveryStates)[keyof typeof ReviewDeliveryStates]

export interface RatingWebhookPayload {
  source: 'canonry'
  event: 'review.rating-dropped'
  project: { name: string; canonicalDomain: string }
  ratings: Array<{
    location: ReviewAlertLocation
    origin: GbpReviewOrigin
    previousRating: number
    rating: number
    previousReviewCount: number | null
    reviewCount: number | null
    observedAt: string
  }>
  dashboardUrl: string
}

/** Only provider-owned Google review/profile links are suitable for review alerts. */
export function googleBusinessReviewUrl(value: string | null): string | null {
  try {
    if (!value) return null
    const url = new URL(value)
    const providerPath = (['www.google.com', 'google.com'].includes(url.hostname) && url.pathname.startsWith('/maps'))
      || url.hostname === 'maps.google.com'
      || (url.hostname === 'local.google.com' && url.pathname === '/place')
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && providerPath ? url.href : null
  } catch { return null }
}

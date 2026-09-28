import { z } from 'zod'
import type { GbpReviewOrigin } from './gbp.js'

export const notificationEventSchema = z.enum([
  'citation.lost',
  'citation.gained',
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
   * Edge-triggered: emitted when the worst check status changes, never on every
   * scheduled pass, so a persistent warning does not train the operator to
   * ignore the channel.
   */
  'health.degraded',
  'health.recovered',
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
])
export type NotificationEvent = z.infer<typeof notificationEventSchema>

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
  event: 'health.degraded' | 'health.recovered'
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
    /** Every non-ok check on this pass, worst first. */
    failing: Array<{ id: string; status: string; code: string; summary: string }>
  }
  dashboardUrl: string
}

export interface WebhookPayload {
  source: 'canonry'
  event: NotificationEvent
  project: { name: string; canonicalDomain: string }
  run: { id: string; status: string; finishedAt: string | null }
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
  }>
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

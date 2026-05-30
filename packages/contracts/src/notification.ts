import { z } from 'zod'

export const notificationEventSchema = z.enum([
  'citation.lost',
  'citation.gained',
  'run.completed',
  'run.failed',
  'insight.critical',
  'insight.high',
  // Cloud event types (Track 3). Additive — opt-in by webhook subscribers.
  // These ride the same `notifications` table as the existing events but use
  // the `CloudWebhookPayload` envelope (source: 'canonry-cloud') when emitted.
  // Most are emitted by the tenant runtime (`baseline.completed`,
  // `connection.created`, `connection.revoked`, eventually `digest.generated`).
  // The two action events are emitted by the cloud control plane, not the
  // tenant — but the enum value lives here so the control plane can sign and
  // dispatch them with the same convention.
  'baseline.completed',
  'digest.generated',
  'action.created',
  'action.completed',
  'connection.created',
  'connection.revoked',
])
export type NotificationEvent = z.infer<typeof notificationEventSchema>

/**
 * Subset of `NotificationEvent` covering the six new cloud event types
 * introduced in Track 3. Used to type the `CloudWebhookPayload.event` field
 * narrowly so the legacy + cloud envelopes can be discriminated at the type
 * level.
 */
export const cloudNotificationEventSchema = z.enum([
  'baseline.completed',
  'digest.generated',
  'action.created',
  'action.completed',
  'connection.created',
  'connection.revoked',
])
export type CloudNotificationEvent = z.infer<typeof cloudNotificationEventSchema>

export const notificationDtoSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
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

/**
 * Cloud webhook payload — additive Track 3 envelope used for the six new
 * cloud event types. Lives alongside the legacy `WebhookPayload` so existing
 * subscribers receive the same shape they always have. The control plane is
 * the primary consumer; OSS deployments will only see these envelopes if
 * something registers a webhook subscriber for the new events.
 *
 * Differences from `WebhookPayload`:
 *   - `source: 'canonry-cloud'` (vs `'canonry'`) so consumers can route
 *     dispatch by envelope.
 *   - Carries an `event_id` (UUID) used as the idempotency key on the control
 *     plane's `event_idempotency` table. Legacy runs key off `run.id`; the
 *     new envelope is run-agnostic, so we need a stable per-event id.
 *   - `payload` is event-specific and intentionally typed as
 *     `Record<string, unknown>` so each event can ship its own shape without
 *     a discriminated-union blow-up. Per-event payloads are documented in
 *     the spec §12 table.
 */
export const cloudWebhookPayloadSchema = z.object({
  source: z.literal('canonry-cloud'),
  event: cloudNotificationEventSchema,
  event_id: z.string().uuid(),
  project: z.object({
    name: z.string(),
    canonicalDomain: z.string(),
  }),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: z.string(),
})
export type CloudWebhookPayload = z.infer<typeof cloudWebhookPayloadSchema>

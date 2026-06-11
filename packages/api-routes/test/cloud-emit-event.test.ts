import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, migrate, notifications } from '@ainyc/canonry-db'
import { cloudWebhookPayloadSchema } from '@ainyc/canonry-contracts'

/**
 * Cloud OUTBOUND bridge — `emitCloudEvent` / `emitConnectionEvent`.
 *
 * This is the OSS → canonry-cloud seam: when a tenant runtime fires a
 * connection / baseline event, it POSTs a signed `CloudWebhookPayload` to
 * every enabled subscriber. The two invariants that let OSS and the control
 * plane be developed independently:
 *
 *   1. GATING — with no matching subscriber row, the dispatcher is inert.
 *      A standalone OSS install (no cloud bootstrap → no `projectId IS NULL`
 *      subscriber) emits nothing. The cloud bridge can't fire by accident.
 *   2. CONTRACT — when a subscriber DOES match, the delivered body is exactly
 *      the `CloudWebhookPayload` envelope (source/event/event_id/project/
 *      payload/occurred_at) and nothing more (notably: no `project.id` leak).
 *
 * `resolveWebhookTarget` + `deliverWebhook` are mocked so no real network /
 * DNS happens — we assert on what the dispatcher *would* deliver.
 */

const mocks = vi.hoisted(() => ({
  resolveWebhookTarget: vi.fn(),
  deliverWebhook: vi.fn(),
}))

vi.mock('../src/webhooks.js', () => ({
  resolveWebhookTarget: mocks.resolveWebhookTarget,
  deliverWebhook: mocks.deliverWebhook,
}))

const { emitCloudEvent, emitConnectionEvent } = await import('../src/cloud/emit-connection-event.js')

type Db = ReturnType<typeof createClient>

const PROJECT = { id: 'proj-1', name: 'acme', canonicalDomain: 'https://acme.com' }
const FIXED_EVENT_ID = '00000000-0000-4000-8000-000000000001'
const FIXED_OCCURRED_AT = '2026-01-15T12:00:00.000Z'

function seedSubscriber(
  db: Db,
  opts: {
    url: string
    events: string[]
    enabled?: boolean
    projectId?: string | null
    webhookSecret?: string | null
  },
) {
  const now = new Date().toISOString()
  db.insert(notifications)
    .values({
      id: crypto.randomUUID(),
      projectId: opts.projectId ?? null,
      channel: 'webhook',
      config: { url: opts.url, events: opts.events },
      webhookSecret: opts.webhookSecret ?? 'whsec_test',
      enabled: opts.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

describe('cloud outbound event dispatcher', () => {
  let db: Db
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cloud-emit-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    mocks.resolveWebhookTarget.mockReset()
    mocks.deliverWebhook.mockReset()
    // Default: target resolves cleanly, delivery succeeds.
    mocks.resolveWebhookTarget.mockResolvedValue({ ok: true, target: { url: new URL('https://cp.example.com/cloud/events') } })
    mocks.deliverWebhook.mockResolvedValue({ status: 200, error: null })
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  // ── GATING ──────────────────────────────────────────────────────────────

  it('is inert when no subscribers exist (standalone OSS)', async () => {
    await emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} })
    expect(mocks.resolveWebhookTarget).not.toHaveBeenCalled()
    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
  })

  it('does not deliver to a subscriber not subscribed to the event', async () => {
    seedSubscriber(db, { url: 'https://cp.example.com/cloud/events', events: ['digest.generated'] })
    await emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} })
    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
  })

  it('does not deliver to a disabled subscriber', async () => {
    seedSubscriber(db, { url: 'https://cp.example.com/cloud/events', events: ['baseline.completed'], enabled: false })
    await emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} })
    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
  })

  // ── CONTRACT ────────────────────────────────────────────────────────────

  it('delivers exactly the CloudWebhookPayload envelope to a matching subscriber', async () => {
    seedSubscriber(db, {
      url: 'https://cp.example.com/cloud/events',
      events: ['baseline.completed'],
      webhookSecret: 'whsec_abc',
    })

    await emitCloudEvent(db, {
      event: 'baseline.completed',
      project: PROJECT,
      payload: { runId: 'run-9', cited: 3 },
      eventId: FIXED_EVENT_ID,
      occurredAt: FIXED_OCCURRED_AT,
    })

    expect(mocks.deliverWebhook).toHaveBeenCalledTimes(1)
    const [, payload, secret] = mocks.deliverWebhook.mock.calls[0]!

    // The body must satisfy the published contract schema verbatim.
    expect(() => cloudWebhookPayloadSchema.parse(payload)).not.toThrow()
    expect(payload).toEqual({
      source: 'canonry-cloud',
      event: 'baseline.completed',
      event_id: FIXED_EVENT_ID,
      project: { name: 'acme', canonicalDomain: 'https://acme.com' },
      payload: { runId: 'run-9', cited: 3 },
      occurred_at: FIXED_OCCURRED_AT,
    })
    // The internal project id must NOT leak into the envelope.
    expect((payload as { project: Record<string, unknown> }).project).not.toHaveProperty('id')
    // The subscriber's signing secret is threaded through to delivery.
    expect(secret).toBe('whsec_abc')
  })

  it('emitConnectionEvent constrains the payload to the connection shape', async () => {
    seedSubscriber(db, { url: 'https://cp.example.com/cloud/events', events: ['connection.created'] })

    await emitConnectionEvent(db, {
      event: 'connection.created',
      project: PROJECT,
      payload: {
        connectionType: 'gsc',
        propertyRef: 'sc-domain:acme.com',
        scopes: ['webmasters.readonly'],
      },
      eventId: FIXED_EVENT_ID,
      occurredAt: FIXED_OCCURRED_AT,
    })

    expect(mocks.deliverWebhook).toHaveBeenCalledTimes(1)
    const [, payload] = mocks.deliverWebhook.mock.calls[0]!
    expect(() => cloudWebhookPayloadSchema.parse(payload)).not.toThrow()
    expect(payload).toMatchObject({
      source: 'canonry-cloud',
      event: 'connection.created',
      payload: { connectionType: 'gsc', propertyRef: 'sc-domain:acme.com', scopes: ['webmasters.readonly'] },
    })
  })

  it('fans out to every matching subscriber', async () => {
    seedSubscriber(db, { url: 'https://a.example.com/hook', events: ['baseline.completed'] })
    seedSubscriber(db, { url: 'https://b.example.com/hook', events: ['baseline.completed'] })
    await emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} })
    expect(mocks.deliverWebhook).toHaveBeenCalledTimes(2)
  })

  // ── BEST-EFFORT (failures must not block the caller's write path) ─────────

  it('skips a subscriber whose target fails to resolve (SSRF / DNS) without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seedSubscriber(db, { url: 'https://blocked.internal/hook', events: ['baseline.completed'] })
    mocks.resolveWebhookTarget.mockResolvedValueOnce({ ok: false, message: 'private address' })

    await expect(
      emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} }),
    ).resolves.toBeUndefined()
    expect(mocks.deliverWebhook).not.toHaveBeenCalled()
  })

  it('swallows a delivery error so the caller is never blocked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    seedSubscriber(db, { url: 'https://cp.example.com/cloud/events', events: ['baseline.completed'] })
    mocks.deliverWebhook.mockRejectedValueOnce(new Error('socket hang up'))

    await expect(
      emitCloudEvent(db, { event: 'baseline.completed', project: PROJECT, payload: {} }),
    ).resolves.toBeUndefined()
  })
})

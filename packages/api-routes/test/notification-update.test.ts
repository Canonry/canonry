import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { auditLog, createClient, migrate, notifications } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

const HOOK_URL = 'https://8.8.8.8/hook'

describe('PATCH /projects/:name/notifications/:id', () => {
  let app: FastifyInstance
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-notification-update-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    app = Fastify()
    app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
    for (const name of ['acme', 'other']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${name}`,
        payload: { displayName: name, canonicalDomain: `${name}.example`, country: 'US', language: 'en' },
      })
      expect(res.statusCode).toBe(201)
    }
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** A webhook made the way the older Discord ones were: citation events only. */
  async function createCitationOnlyHook(project = 'acme'): Promise<{ id: string; webhookSecret: string }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project}/notifications`,
      payload: { channel: 'webhook', url: HOOK_URL, events: ['run.failed', 'citation.gained', 'citation.lost'] },
    })
    expect(res.statusCode).toBe(201)
    return res.json() as { id: string; webhookSecret: string }
  }

  function stored(id: string) {
    return db.select().from(notifications).where(eq(notifications.id, id)).get()!
  }

  function updateAudits(id: string) {
    return db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'notification.updated')))
      .all()
  }

  function patch(id: string, payload: unknown, project = 'acme') {
    return app.inject({ method: 'PATCH', url: `/api/v1/projects/${project}/notifications/${id}`, payload: payload as object })
  }

  it('adds mention events to a citation-only webhook, keeping its URL and signing secret', async () => {
    const hook = await createCitationOnlyHook()
    const before = stored(hook.id)

    const res = await patch(hook.id, { addEvents: ['mention.lost', 'mention.gained', 'citation.lost'] })

    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.events).toEqual(['run.failed', 'citation.gained', 'citation.lost', 'mention.lost', 'mention.gained'])
    expect(body.enabled).toBe(true)
    // The response is the redacted DTO: never the raw URL or the secret.
    expect(JSON.stringify(body)).not.toContain(HOOK_URL)
    expect(body).not.toHaveProperty('webhookSecret')

    const after = stored(hook.id)
    expect(after.config).toEqual({ url: HOOK_URL, events: ['run.failed', 'citation.gained', 'citation.lost', 'mention.lost', 'mention.gained'] })
    expect(after.webhookSecret).toBe(hook.webhookSecret)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.updatedAt >= before.updatedAt).toBe(true)

    const audits = updateAudits(hook.id)
    expect(audits).toHaveLength(1)
    expect(JSON.parse(audits[0]!.diff!)).toEqual({
      events: {
        from: ['run.failed', 'citation.gained', 'citation.lost'],
        to: ['run.failed', 'citation.gained', 'citation.lost', 'mention.lost', 'mention.gained'],
      },
    })
  })

  it('applies removeEvents after addEvents, and replaces the list with events (first of each kept)', async () => {
    const hook = await createCitationOnlyHook()

    const removed = await patch(hook.id, { addEvents: ['mention.lost'], removeEvents: ['run.failed', 'mention.lost'] })
    expect(removed.statusCode).toBe(200)
    expect(stored(hook.id).config.events).toEqual(['citation.gained', 'citation.lost'])

    const replaced = await patch(hook.id, { events: ['mention.gained', 'run.completed', 'mention.gained'] })
    expect(replaced.statusCode).toBe(200)
    expect(stored(hook.id).config.events).toEqual(['mention.gained', 'run.completed'])
  })

  it('turns a webhook off and on without touching its events', async () => {
    const hook = await createCitationOnlyHook()

    const off = await patch(hook.id, { enabled: false })
    expect(off.statusCode).toBe(200)
    expect(stored(hook.id).enabled).toBe(false)
    expect(stored(hook.id).config.events).toEqual(['run.failed', 'citation.gained', 'citation.lost'])
    expect(JSON.parse(updateAudits(hook.id)[0]!.diff!)).toEqual({ enabled: { from: true, to: false } })

    const on = await patch(hook.id, { enabled: true })
    expect(on.statusCode).toBe(200)
    expect(stored(hook.id).enabled).toBe(true)
  })

  it('writes nothing when the update changes nothing', async () => {
    const hook = await createCitationOnlyHook()
    const before = stored(hook.id)

    const res = await patch(hook.id, { addEvents: ['citation.lost'], enabled: true })

    expect(res.statusCode).toBe(200)
    expect(stored(hook.id).updatedAt).toBe(before.updatedAt)
    expect(updateAudits(hook.id)).toEqual([])
  })

  it.each([
    ['an empty body', {}, 'Name at least one field'],
    ['events with addEvents', { events: ['run.failed'], addEvents: ['mention.lost'] }, '"events" replaces the whole list'],
    ['an unknown event', { addEvents: ['mention.lost', 'mention.changed'] }, 'Invalid event(s): mention.changed'],
    ['an unknown field', { url: 'https://8.8.4.4/other' }, 'Invalid notification update'],
    ['an empty events list', { events: [] }, 'Invalid notification update'],
    ['removing every event', { removeEvents: ['run.failed', 'citation.gained', 'citation.lost'] }, 'at least one event'],
  ])('rejects %s with 400 and leaves the webhook unchanged', async (_label, payload, message) => {
    const hook = await createCitationOnlyHook()
    const before = stored(hook.id)

    const res = await patch(hook.id, payload)

    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect((res.json() as { error: { message: string } }).error.message).toContain(message)
    expect(stored(hook.id)).toEqual(before)
  })

  it('answers 404 for a missing webhook or one that belongs to another project', async () => {
    const otherHook = await createCitationOnlyHook('other')

    const missing = await patch('no-such-hook', { enabled: false })
    const crossProject = await patch(otherHook.id, { enabled: false })

    expect(missing.statusCode).toBe(404)
    expect(crossProject.statusCode).toBe(404)
    expect(stored(otherHook.id).enabled).toBe(true)
  })
})

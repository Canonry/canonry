import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, test } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, createClient, migrate, notifications, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-notifications-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, allowLoopbackWebhooks: true })
  return { app, db, tmpDir }
}

function config(name: string, notificationsValue: Array<Record<string, unknown>>) {
  return {
    apiVersion: 'canonry/v1',
    kind: 'Project',
    metadata: { name },
    spec: {
      displayName: 'Notification test',
      canonicalDomain: 'notification-test.example',
      country: 'US',
      language: 'en',
      notifications: notificationsValue,
    },
  }
}

test('apply keeps a keyed redacted notification and its stored state', async () => {
  const { app, db, tmpDir } = buildApp()
  await app.ready()

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/notification-round-trip',
      payload: {
        displayName: 'Notification test',
        canonicalDomain: 'notification-test.example',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const project = db.select().from(projects).where(eq(projects.name, 'notification-round-trip')).get()!
    const createdAt = '2026-10-11T10:00:00.000Z'
    const updatedAt = '2026-10-11T10:01:00.000Z'
    db.insert(notifications).values({
      id: 'notification-keep-1',
      projectId: project.id,
      channel: 'webhook',
      config: { url: 'https://hooks.example.com/secret/path', events: ['run.completed'], source: '' },
      webhookSecret: 'stored-webhook-secret',
      enabled: false,
      createdAt,
      updatedAt,
    }).run()
    const auditBefore = db.select().from(auditLog).where(and(
      eq(auditLog.projectId, project.id),
      eq(auditLog.action, 'notifications.replaced'),
    )).all().length

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('notification-round-trip', [{
        id: 'notification-keep-1',
        channel: 'webhook',
        url: 'redacted://hooks.example.com/notification-keep-1',
        events: ['run.failed'],
      }]),
    })

    expect(applied.statusCode).toBe(200)
    const stored = db.select().from(notifications).where(eq(notifications.id, 'notification-keep-1')).get()!
    expect(stored).toMatchObject({
      id: 'notification-keep-1',
      projectId: project.id,
      webhookSecret: 'stored-webhook-secret',
      enabled: false,
      createdAt,
    })
    expect(stored.config).toEqual({
      url: 'https://hooks.example.com/secret/path',
      events: ['run.failed'],
      source: '',
    })
    expect(db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()).toHaveLength(1)

    const auditRows = db.select().from(auditLog).where(and(
      eq(auditLog.projectId, project.id),
      eq(auditLog.action, 'notifications.replaced'),
    )).all()
    expect(auditRows).toHaveLength(auditBefore + 1)
    expect(JSON.stringify(auditRows.at(-1)?.diff)).not.toContain('secret/path')
    expect(JSON.stringify(auditRows.at(-1)?.diff)).not.toContain('hooks.example.com/secret')
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply keeps a stored notification when an unknown id carries its stored URL', async () => {
  const { app, db, tmpDir } = buildApp()
  await app.ready()

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/apply-url-fallback',
      payload: {
        displayName: 'URL fallback',
        canonicalDomain: 'url-fallback.example',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const project = db.select().from(projects).where(eq(projects.name, 'apply-url-fallback')).get()!
    const createdAt = '2026-10-11T10:00:00.000Z'
    db.insert(notifications).values({
      id: 'stored-url-fallback',
      projectId: project.id,
      channel: 'webhook',
      config: { url: 'https://localhost/same', events: ['run.completed'], source: '' },
      webhookSecret: 'keep-this-secret',
      enabled: false,
      createdAt,
      updatedAt: createdAt,
    }).run()

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('apply-url-fallback', [{
        id: 'request-id-does-not-exist',
        channel: 'webhook',
        url: 'https://localhost/same',
        events: ['run.failed'],
      }]),
    })

    expect(applied.statusCode).toBe(200)
    const stored = db.select().from(notifications).where(eq(notifications.projectId, project.id)).get()!
    expect(stored.id).toBe('stored-url-fallback')
    expect(stored.webhookSecret).toBe('keep-this-secret')
    expect(stored.enabled).toBe(false)
    expect(stored.createdAt).toBe(createdAt)
    expect(stored.config).toEqual({ url: 'https://localhost/same', events: ['run.failed'], source: '' })
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply audit records generated IDs for inserted notifications', async () => {
  const { app, db, tmpDir } = buildApp()
  await app.ready()

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/apply-audit-id',
      payload: {
        displayName: 'Audit ID',
        canonicalDomain: 'audit-id.example',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const project = db.select().from(projects).where(eq(projects.name, 'apply-audit-id')).get()!

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('apply-audit-id', [{
        channel: 'webhook',
        url: 'https://localhost/audit-id',
        events: ['run.completed'],
      }]),
    })

    expect(applied.statusCode).toBe(200)
    const stored = db.select().from(notifications).where(eq(notifications.projectId, project.id)).get()!
    const audit = db.select().from(auditLog).where(and(
      eq(auditLog.projectId, project.id),
      eq(auditLog.action, 'notifications.replaced'),
    )).get()!
    const parsedDiff = typeof audit.diff === 'string' ? JSON.parse(audit.diff) as { notifications: { added: string[] } } : audit.diff as { notifications: { added: string[] } }
    const added = parsedDiff.notifications.added
    expect(added).toEqual([stored.id])
    expect(added).not.toContain('new')
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply rejects an unmatched redacted notification before any write', async () => {
  const { app, db, tmpDir } = buildApp()
  await app.ready()

  try {
    const created = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/apply-unmatched',
      payload: {
        displayName: 'Unmatched',
        canonicalDomain: 'unmatched.example',
        country: 'US',
        language: 'en',
      },
    })
    expect(created.statusCode).toBe(201)
    const project = db.select().from(projects).where(eq(projects.name, 'apply-unmatched')).get()!
    const beforeAudit = db.select().from(auditLog).where(eq(auditLog.projectId, project.id)).all().length

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('apply-unmatched', [{
        id: crypto.randomUUID(),
        channel: 'webhook',
        url: 'redacted://hooks.example.com/does-not-exist',
        events: ['run.completed'],
      }]),
    })

    expect(applied.statusCode).toBe(400)
    expect(applied.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(applied.body).toContain('spec.notifications.0.url')
    expect(db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()).toEqual([])
    expect(db.select().from(auditLog).where(eq(auditLog.projectId, project.id)).all()).toHaveLength(beforeAudit)
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

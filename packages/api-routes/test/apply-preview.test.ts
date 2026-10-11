import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { auditLog, competitors, createClient, migrate, notifications, projects, queries, querySnapshots, runs, schedules } from '@ainyc/canonry-db'
import { SchedulableRunKinds } from '@ainyc/canonry-contracts'
import { expect, test } from 'vitest'
import { apiRoutes } from '../src/index.js'

const config = (name: string, overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'canonry/v1',
  kind: 'Project',
  metadata: { name },
  spec: {
    displayName: 'Preview project',
    canonicalDomain: 'preview.example',
    country: 'US',
    language: 'en',
    ...overrides,
  },
})

test('apply preview returns redacted per-resource changes and rolls back all writes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-preview-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const callbacks = { projectCreated: 0, schedule: 0, upserted: 0, aliases: 0, competitorAliases: 0, autoAliasRescan: 0, google: 0 }
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    allowLoopbackWebhooks: true,
    onProjectCreated: () => { callbacks.projectCreated++ },
    onScheduleUpdated: () => { callbacks.schedule++ },
    onProjectUpserted: () => { callbacks.upserted++ },
    onAliasesChanged: () => { callbacks.aliases++ },
    onCompetitorAliasesChanged: () => { callbacks.competitorAliases++ },
    onCompetitorAutoAliasRescan: () => { callbacks.autoAliasRescan++ },
    onGoogleConnectionPropertyUpdated: () => { callbacks.google++ },
  })
  await app.ready()

  try {
    const initial = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('preview-project', {
        queries: ['first query'],
        competitors: ['old.example'],
        schedule: { preset: 'daily', timezone: 'UTC' },
        notifications: [{ id: 'preview-notification', channel: 'webhook', url: 'http://127.0.0.1/hook', events: ['run.completed'] }],
      }),
    })
    expect(initial.statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'preview-project')).get()!
    const query = db.select().from(queries).where(eq(queries.projectId, project.id)).get()!
    const runId = 'preview-run'
    db.insert(runs).values({ id: runId, projectId: project.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: new Date().toISOString() }).run()
    db.insert(querySnapshots).values({ id: 'preview-snapshot', runId, queryId: query.id, queryText: query.query, provider: 'gemini', citationState: 'not-cited', answerText: 'fixture', createdAt: new Date().toISOString() }).run()
    const notificationId = db.select().from(notifications).where(eq(notifications.projectId, project.id)).get()!.id
    const before = {
      project: db.select().from(projects).where(eq(projects.id, project.id)).get(),
      queries: db.select().from(queries).where(eq(queries.projectId, project.id)).all(),
      competitors: db.select().from(competitors).where(eq(competitors.projectId, project.id)).all(),
      schedules: db.select().from(schedules).where(and(eq(schedules.projectId, project.id), eq(schedules.kind, SchedulableRunKinds['answer-visibility']))).all(),
      notifications: db.select().from(notifications).where(eq(notifications.projectId, project.id)).all(),
      audits: db.select().from(auditLog).where(eq(auditLog.projectId, project.id)).all(),
    }
    const callbackBefore = { ...callbacks }

    const changedConfig = config('preview-project', {
      displayName: 'Preview project changed',
      aliases: ['Preview Alias'],
      queries: ['second query'],
      competitors: ['new.example'],
      schedule: { preset: 'weekly', timezone: 'UTC' },
      notifications: [{ id: notificationId, channel: 'webhook', url: `redacted://127.0.0.1/${notificationId}`, events: ['run.failed'] }],
      google: { gsc: { propertyUrl: 'https://search.example/property' } },
    })
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/apply/preview',
      payload: changedConfig,
    })

    expect(preview.statusCode).toBe(200)
    const body = preview.json()
    expect(body).toMatchObject({
      project: { id: project.id, name: 'preview-project' },
      action: 'update',
      changed: true,
      queries: { managed: true, added: ['second query'], removed: ['first query'], snapshotsDetached: 1 },
      competitors: { managed: true, added: ['new.example'], removed: ['old.example'] },
      schedule: { managed: true, action: 'update' },
      notifications: { managed: true, kept: [{ id: notificationId, urlHost: '127.0.0.1', eventsBefore: ['run.completed'], eventsAfter: ['run.failed'] }] },
      effects: ['mention-backfill', 'competitor-auto-alias-rescan', 'schedule-reload', 'gsc-property-update'],
    })
    expect(JSON.stringify(body)).not.toContain('http://127.0.0.1/hook')
    expect(callbacks).toEqual(callbackBefore)
    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()).toEqual(before.project)
    expect(db.select().from(queries).where(eq(queries.projectId, project.id)).all()).toEqual(before.queries)
    expect(db.select().from(querySnapshots).where(eq(querySnapshots.id, 'preview-snapshot')).get()?.queryId).toBe(query.id)
    expect(db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()).toEqual(before.competitors)
    expect(db.select().from(schedules).where(and(eq(schedules.projectId, project.id), eq(schedules.kind, SchedulableRunKinds['answer-visibility']))).all()).toEqual(before.schedules)
    expect(db.select().from(notifications).where(eq(notifications.projectId, project.id)).all()).toEqual(before.notifications)
    expect(db.select().from(auditLog).where(eq(auditLog.projectId, project.id)).all()).toEqual(before.audits)

    const applied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: changedConfig })
    expect(applied.statusCode).toBe(200)
    const exported = await app.inject({ method: 'GET', url: '/api/v1/projects/preview-project/export' })
    expect(exported.statusCode).toBe(200)
    const exportedPreview = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', payload: exported.json() })
    expect(exportedPreview.statusCode).toBe(200)
    expect(exportedPreview.json()).toMatchObject({ action: 'none', changed: false })
    expect(exportedPreview.body).not.toContain('http://127.0.0.1/hook')
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('previewing the current applied document reports no changes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-preview-current-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, allowLoopbackWebhooks: true })
  await app.ready()

  try {
    const document = config('current-preview', {
      queries: ['unchanged query'],
      notifications: [{ id: 'same-notification', channel: 'webhook', url: 'http://127.0.0.1/hook', events: ['run.completed'] }],
    })
    expect((await app.inject({ method: 'POST', url: '/api/v1/apply', payload: document })).statusCode).toBe(200)
    const preview = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', payload: document })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ action: 'none', changed: false, fields: {}, queries: { added: [], removed: [] }, competitors: { added: [], removed: [], aliasChanges: [], droppedAliases: [] }, schedule: { action: 'none' }, notifications: { added: [], removed: [], kept: [], secretsRotated: 0 } })
    expect(preview.body).not.toContain('http://127.0.0.1/hook')
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('preview reports omitted resource removals and measurement defaults without writing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-preview-omitted-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const callbacks = { projectUpserted: 0, schedule: 0 }
  const app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    allowLoopbackWebhooks: true,
    onProjectUpserted: () => { callbacks.projectUpserted++ },
    onScheduleUpdated: () => { callbacks.schedule++ },
  })
  await app.ready()

  try {
    const initial = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: config('omitted-preview', {
        queries: ['kept query'],
        competitors: [{ domain: 'stored.example', aliases: ['Stored Brand'] }],
        measurement: {
          marketingHosts: ['offers.example'],
          brandTerms: ['Stored Brand'],
          leadEventNames: ['book_demo'],
        },
        schedule: { preset: 'daily', timezone: 'UTC' },
      }),
    })
    expect(initial.statusCode).toBe(200)
    const projectBefore = db.select().from(projects).where(eq(projects.name, 'omitted-preview')).get()!
    const before = {
      project: db.select().from(projects).where(eq(projects.id, projectBefore.id)).get(),
      competitors: db.select().from(competitors).where(eq(competitors.projectId, projectBefore.id)).all(),
      schedules: db.select().from(schedules).where(and(eq(schedules.projectId, projectBefore.id), eq(schedules.kind, SchedulableRunKinds['answer-visibility']))).all(),
      audits: db.select().from(auditLog).where(eq(auditLog.projectId, projectBefore.id)).all(),
    }
    const callbackBefore = { ...callbacks }

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/apply/preview',
      payload: config('omitted-preview'),
    })

    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      action: 'update',
      changed: true,
      queries: { managed: false, added: [], removed: [] },
      competitors: { removed: ['stored.example'] },
      schedule: { action: 'delete' },
      fields: {
        'measurement.marketingHosts': { before: ['offers.example'], after: [] },
        'measurement.brandTerms': { before: ['Stored Brand'], after: [] },
        'measurement.leadEventNames': { before: ['book_demo'], after: ['generate_lead'] },
      },
    })
    expect(callbacks).toEqual(callbackBefore)
    expect(db.select().from(projects).where(eq(projects.id, projectBefore.id)).get()).toEqual(before.project)
    expect(db.select().from(competitors).where(eq(competitors.projectId, projectBefore.id)).all()).toEqual(before.competitors)
    expect(db.select().from(schedules).where(and(eq(schedules.projectId, projectBefore.id), eq(schedules.kind, SchedulableRunKinds['answer-visibility']))).all()).toEqual(before.schedules)
    expect(db.select().from(auditLog).where(eq(auditLog.projectId, projectBefore.id)).all()).toEqual(before.audits)
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('preview and apply share the active planless sweep refusal', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-apply-preview-active-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()

  try {
    const initial = config('active-preview', { queries: ['kept query'] })
    expect((await app.inject({ method: 'POST', url: '/api/v1/apply', payload: initial })).statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'active-preview')).get()!
    db.insert(runs).values({ id: 'active-preview-run', projectId: project.id, kind: 'answer-visibility', status: 'running', trigger: 'manual', createdAt: new Date().toISOString() }).run()
    const changed = config('active-preview', { queries: ['changed query'] })
    const preview = await app.inject({ method: 'POST', url: '/api/v1/apply/preview', payload: changed })
    const applied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: changed })
    expect(preview.statusCode).toBe(applied.statusCode)
    expect(preview.json().error.code).toBe(applied.json().error.code)
  } finally {
    await app.close()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

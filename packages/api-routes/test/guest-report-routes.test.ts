import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, guestReports, migrate, projects } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

const RAW_KEY = 'cnry_guest_route_test'

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function insertProject(db: ReturnType<typeof createClient>, id = crypto.randomUUID()) {
  db.insert(projects).values({
    id,
    name: `guest-${id.slice(0, 8)}`,
    displayName: 'Expired Guest',
    canonicalDomain: 'expired.example',
    country: 'US',
    language: 'en',
    configSource: 'guest',
    configRevision: 1,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  }).run()
  return id
}

function insertGuestReport(
  db: ReturnType<typeof createClient>,
  projectId: string,
  opts: { id?: string; expiresAt?: string; claimedAt?: string | null } = {},
) {
  const id = opts.id ?? `gr_${crypto.randomBytes(6).toString('hex')}`
  db.insert(guestReports).values({
    id,
    domain: 'expired.example',
    projectId,
    status: 'completed',
    createdAt: '2026-05-01T00:00:00.000Z',
    expiresAt: opts.expiresAt ?? '2026-05-01T00:00:00.000Z',
    claimedAt: opts.claimedAt ?? null,
  }).run()
  return id
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-guest-report-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: 'key_guest_route_test',
    name: 'default',
    keyHash: hashKey(RAW_KEY),
    keyPrefix: RAW_KEY.slice(0, 12),
    scopes: ['*'],
    createdAt: '2026-05-01T00:00:00.000Z',
  }).run()

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: false })
  return { app, db, tmpDir }
}

describe('guest report routes', () => {
  let app: FastifyInstance
  let db: ReturnType<typeof createClient>
  let tmpDir: string

  beforeEach(async () => {
    delete process.env.CANONRY_ENABLE_GUEST_REPORTS
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.CANONRY_ENABLE_GUEST_REPORTS
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('keeps the anonymous create route disabled unless explicitly enabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/guest/report',
      payload: { domain: 'example.com' },
    })

    expect(res.statusCode).toBe(404)
    expect(db.select().from(projects).all()).toHaveLength(0)
    expect(db.select().from(guestReports).all()).toHaveLength(0)
  })

  it('does not return expired unclaimed reports', async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.env.CANONRY_ENABLE_GUEST_REPORTS = '1'
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    const projectId = insertProject(db)
    const reportId = insertGuestReport(db, projectId, { expiresAt: '2026-05-01T00:00:00.000Z' })

    const res = await app.inject({ method: 'GET', url: `/api/v1/guest/report/${reportId}` })

    expect(res.statusCode).toBe(404)
    expect(db.select().from(guestReports).where(eq(guestReports.id, reportId)).get()).toBeUndefined()
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
  })

  it('does not allow claiming an expired unclaimed report', async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.env.CANONRY_ENABLE_GUEST_REPORTS = '1'
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    const projectId = insertProject(db)
    const reportId = insertGuestReport(db, projectId, { expiresAt: '2026-05-01T00:00:00.000Z' })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/guest/report/${reportId}/claim`,
      headers: { authorization: `Bearer ${RAW_KEY}` },
    })

    expect(res.statusCode).toBe(404)
    expect(db.select().from(guestReports).where(eq(guestReports.id, reportId)).get()).toBeUndefined()
    expect(db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined()
  })

  it('still returns claimed reports after their original expiry', async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    process.env.CANONRY_ENABLE_GUEST_REPORTS = '1'
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()

    const projectId = insertProject(db)
    const reportId = insertGuestReport(db, projectId, {
      expiresAt: '2026-05-01T00:00:00.000Z',
      claimedAt: '2026-05-01T00:05:00.000Z',
    })

    const res = await app.inject({ method: 'GET', url: `/api/v1/guest/report/${reportId}` })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: reportId, projectId, claimedAt: '2026-05-01T00:05:00.000Z' })
  })
})

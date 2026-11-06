import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, type DatabaseClient } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'

// `startedOn` is the day work on a project began: AI visit charts mark it and
// fit their visit trends from it. The dashboard and CLI resend the whole
// project, and a re-apply may never mention the field, so an omitted value
// keeps the stored one on PUT, PATCH and apply; null clears it.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-started-on-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const base = { displayName: 'Harborline', canonicalDomain: 'harborline.example', country: 'US', language: 'en' }

const put = (name: string, extras: Record<string, unknown> = {}) =>
  app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: { ...base, ...extras } })
const patch = (name: string, body: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/projects/${name}`, payload: body })
const apply = (name: string, specExtras: Record<string, unknown> = {}) => app.inject({
  method: 'POST',
  url: '/api/v1/apply',
  payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name }, spec: { ...base, ...specExtras } },
})
const stored = (name: string) =>
  db.select({ startedOn: projects.startedOn }).from(projects).where(eq(projects.name, name)).get()?.startedOn

describe('project startedOn writes', () => {
  it('PUT sets it, keeps it when omitted, and clears it with null', async () => {
    expect((await put('harbor', { startedOn: '2026-06-01' })).json().startedOn).toBe('2026-06-01')
    const resent = await put('harbor')
    expect(resent.statusCode).toBe(200)
    expect(resent.json().startedOn).toBe('2026-06-01')
    expect((await put('harbor', { startedOn: null })).json().startedOn).toBeNull()
    expect(stored('harbor')).toBeNull()
  })

  it('PATCH sets and clears it without touching other fields', async () => {
    await put('harbor')
    const set = await patch('harbor', { startedOn: '2026-06-01' })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ startedOn: '2026-06-01', displayName: 'Harborline' })
    expect((await patch('harbor', { displayName: 'Harborline Hotel' })).json().startedOn).toBe('2026-06-01')
    expect((await patch('harbor', { startedOn: null })).json().startedOn).toBeNull()
  })

  it('refuses a value that is not a calendar date', async () => {
    await put('harbor')
    for (const startedOn of ['2026-06', '2026-02-30', 'June 1']) {
      const res = await patch('harbor', { startedOn })
      expect(res.statusCode, startedOn).toBe(400)
    }
    expect(stored('harbor')).toBeNull()
  })

  it('apply sets it, keeps it when the spec omits it, and export writes it back', async () => {
    expect((await apply('harbor', { startedOn: '2026-06-01' })).statusCode).toBe(200)
    expect(stored('harbor')).toBe('2026-06-01')
    expect((await apply('harbor')).statusCode).toBe(200)
    expect(stored('harbor')).toBe('2026-06-01')
    const exported = await app.inject({ method: 'GET', url: '/api/v1/projects/harbor/export' })
    expect(exported.statusCode).toBe(200)
    expect(exported.json().spec.startedOn).toBe('2026-06-01')
  })
})

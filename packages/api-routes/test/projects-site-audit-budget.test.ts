import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// `siteAuditMaxPages` is the Site Health page budget a scan uses when it sets
// none; null means the full site. The dashboard and CLI resend the whole
// project on every save, and a re-apply may never mention the field, so an
// omitted value must keep the stored one on PUT and apply. technical-aeo.test.ts
// covers the scan that reads it.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-site-audit-budget-'))
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

const base = {
  displayName: 'Harborline',
  canonicalDomain: 'harborline.example',
  country: 'US',
  language: 'en',
}

function create(name: string, extras: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/api/v1/projects', payload: { ...base, name, ...extras } })
}

function put(name: string, extras: Record<string, unknown> = {}) {
  return app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: { ...base, ...extras } })
}

function apply(name: string, specExtras: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/apply',
    payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name }, spec: { ...base, ...specExtras } },
  })
}

function stored(name: string): number | null | undefined {
  return db.select({ siteAuditMaxPages: projects.siteAuditMaxPages }).from(projects).where(eq(projects.name, name)).get()?.siteAuditMaxPages
}

describe('project siteAuditMaxPages writes', () => {
  it('POST stores the budget, and null when it is omitted or null', async () => {
    const budgeted = await create('budgeted', { siteAuditMaxPages: 2_500 })
    expect(budgeted.statusCode).toBe(201)
    expect(budgeted.json().siteAuditMaxPages).toBe(2_500)
    expect(stored('budgeted')).toBe(2_500)

    const omitted = await create('omitted')
    expect(omitted.statusCode).toBe(201)
    expect(omitted.json().siteAuditMaxPages).toBeNull()
    expect(stored('omitted')).toBeNull()

    const explicitNull = await create('explicit-null', { siteAuditMaxPages: null })
    expect(explicitNull.statusCode).toBe(201)
    expect(stored('explicit-null')).toBeNull()
  })

  it('PUT sets a budget, keeps it when omitted, resets it with null, and replaces it with a number', async () => {
    const created = await put('acme')
    expect(created.statusCode).toBe(201)
    expect(created.json().siteAuditMaxPages).toBeNull()

    const set = await put('acme', { siteAuditMaxPages: 2_500 })
    expect(set.statusCode).toBe(200)
    expect(set.json().siteAuditMaxPages).toBe(2_500)
    expect(stored('acme')).toBe(2_500)

    // A save that edits something else and never sends the field.
    const kept = await put('acme', { country: 'GB' })
    expect(kept.statusCode).toBe(200)
    expect(kept.json().siteAuditMaxPages).toBe(2_500)
    expect(stored('acme')).toBe(2_500)

    const reset = await put('acme', { siteAuditMaxPages: null })
    expect(reset.json().siteAuditMaxPages).toBeNull()
    expect(stored('acme')).toBeNull()

    await put('acme', { siteAuditMaxPages: 50_000 })
    expect(stored('acme')).toBe(50_000)
    await put('acme', { siteAuditMaxPages: 1 })
    expect(stored('acme')).toBe(1)
  })

  it('rejects a budget outside 1 to 50,000 whole pages on every write, and writes nothing', async () => {
    await put('acme', { siteAuditMaxPages: 2_500 })
    for (const value of [0, 50_001, 1.5]) {
      const updated = await put('acme', { siteAuditMaxPages: value })
      expect(updated.statusCode, `PUT ${value}`).toBe(400)
      expect(updated.json().error.code, `PUT ${value}`).toBe('VALIDATION_ERROR')

      const created = await create('rejected', { siteAuditMaxPages: value })
      expect(created.statusCode, `POST ${value}`).toBe(400)

      const applied = await apply('acme', { siteAuditMaxPages: value })
      expect(applied.statusCode, `apply ${value}`).toBe(400)
    }
    expect(stored('acme')).toBe(2_500)
    expect(stored('rejected')).toBeUndefined()
  })

  it('every project read carries the budget, including the overview composite', async () => {
    await put('acme', { siteAuditMaxPages: 2_500 })
    await put('other')

    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/acme' })).json().siteAuditMaxPages).toBe(2_500)
    const list = (await app.inject({ method: 'GET', url: '/api/v1/projects' })).json() as Array<{ name: string; siteAuditMaxPages: number | null }>
    expect(Object.fromEntries(list.map(project => [project.name, project.siteAuditMaxPages]))).toEqual({ acme: 2_500, other: null })
    const overview = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/overview' })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().project.siteAuditMaxPages).toBe(2_500)
  })

  it('export emits the budget only when one is saved, and re-applies unchanged', async () => {
    await put('acme', { siteAuditMaxPages: 2_500 })
    await put('other')

    const withBudget = (await app.inject({ method: 'GET', url: '/api/v1/projects/acme/export' })).json()
    expect(withBudget.spec.siteAuditMaxPages).toBe(2_500)
    const withoutBudget = (await app.inject({ method: 'GET', url: '/api/v1/projects/other/export' })).json()
    expect(withoutBudget.spec).not.toHaveProperty('siteAuditMaxPages')

    // Reset first, so the re-apply can only restore 2,500 from the exported spec itself.
    await put('acme', { siteAuditMaxPages: null })
    expect(stored('acme')).toBeNull()
    const reapplied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: withBudget })
    expect(reapplied.statusCode).toBe(200)
    expect(stored('acme')).toBe(2_500)
  })
})

describe('POST /apply siteAuditMaxPages', () => {
  it('a new project takes the spec value, or null when the spec leaves it out', async () => {
    const budgeted = await apply('budgeted', { siteAuditMaxPages: 2_500 })
    expect(budgeted.statusCode).toBe(200)
    expect(budgeted.json().siteAuditMaxPages).toBe(2_500)
    expect(stored('budgeted')).toBe(2_500)

    const plain = await apply('plain')
    expect(plain.statusCode).toBe(200)
    expect(plain.json().siteAuditMaxPages).toBeNull()
    expect(stored('plain')).toBeNull()
  })

  it('on an existing project, absent keeps the stored budget, null resets it and a number sets it', async () => {
    // Saved outside the config file, as the dashboard does.
    await put('acme', { siteAuditMaxPages: 2_500 })

    const kept = await apply('acme')
    expect(kept.statusCode).toBe(200)
    expect(kept.json().siteAuditMaxPages).toBe(2_500)
    expect(stored('acme')).toBe(2_500)

    const set = await apply('acme', { siteAuditMaxPages: 800 })
    expect(set.json().siteAuditMaxPages).toBe(800)
    expect(stored('acme')).toBe(800)

    const reset = await apply('acme', { siteAuditMaxPages: null })
    expect(reset.json().siteAuditMaxPages).toBeNull()
    expect(stored('acme')).toBeNull()

    // Absent after a reset stays the full site rather than reviving a value.
    await apply('acme')
    expect(stored('acme')).toBeNull()
  })
})

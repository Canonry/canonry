import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, competitors, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// `qualifiedAliases` is a sentiment-only project setting: the subset of aliases
// the evaluator is told are the brand's own names. It never feeds mention
// detection, so a change to it alone must not start the mention backfill.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let aliasChanges: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-qualified-aliases-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  aliasChanges = []
  app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, onAliasesChanged: (_id, name) => aliasChanges.push(name) })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const base = {
  displayName: 'Harborline Labs',
  canonicalDomain: 'harborline.example',
  country: 'US',
  language: 'en',
}
const ALIASES = ['HBLNYC', 'HBL NYC', 'HBL', 'HarborlineLabs', 'Tidewater']

function put(name: string, patch: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: { ...base, ...patch } })
}

function row(name: string) {
  return db.select().from(projects).where(eq(projects.name, name)).get()!
}

// Inserts the row directly, bypassing the competitor routes that prune the list.
function addCompetitor(projectId: string, domain: string) {
  db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, createdAt: new Date().toISOString() }).run()
}

async function exportThenApply(name: string) {
  const exported = (await app.inject({ method: 'GET', url: `/api/v1/projects/${name}/export` })).json()
  const applied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: exported })
  return { exported, applied }
}

describe('project qualifiedAliases writes', () => {
  it('POST stores a valid list and rejects an invalid one with every reason', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { ...base, name: 'created', aliases: ALIASES, qualifiedAliases: ['hbl nyc', 'HBLNYC'] },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().qualifiedAliases).toEqual(['HBL NYC', 'HBLNYC'])
    expect(row('created').qualifiedAliases).toEqual(['HBL NYC', 'HBLNYC'])

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { ...base, name: 'rejected', aliases: ALIASES, qualifiedAliases: ['Former Name', 'HarborlineLabs', 'HBL', 'HBLNYC'] },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        rejectedQualifiedAliases: [
          { name: 'Former Name', reason: 'not-an-alias' },
          { name: 'HarborlineLabs', reason: 'display-name' },
          { name: 'HBL', reason: 'too-short' },
        ],
      },
    })
    expect(db.select().from(projects).where(eq(projects.name, 'rejected')).get()).toBeUndefined()
  })

  it('POST without the field stores an empty list', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { ...base, name: 'plain', aliases: ALIASES } })
    expect(created.statusCode).toBe(201)
    expect(created.json().qualifiedAliases).toEqual([])
  })

  it('PUT rejects every reason, including a collision with a live competitor, and writes nothing', async () => {
    expect((await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC'] })).statusCode).toBe(201)
    const before = row('acme')
    addCompetitor(before.id, 'tidewater.example')

    const res = await put('acme', { aliases: ALIASES, qualifiedAliases: ['Tidewater', 'Nope', 'HarborlineLabs', 'HBL'] })
    expect(res.statusCode).toBe(400)
    // The CLI's human format prints only the message, so it names every entry and reason.
    expect(res.json().error.message).toBe(
      'Rejected qualifiedAliases: Tidewater (competitor-collision), Nope (not-an-alias), HarborlineLabs (display-name), HBL (too-short)',
    )
    expect(res.json().error.details.rejectedQualifiedAliases).toEqual([
      { name: 'Tidewater', reason: 'competitor-collision' },
      { name: 'Nope', reason: 'not-an-alias' },
      { name: 'HarborlineLabs', reason: 'display-name' },
      { name: 'HBL', reason: 'too-short' },
    ])
    const after = row('acme')
    expect(after.qualifiedAliases).toEqual(['HBLNYC'])
    expect(after.configRevision).toBe(before.configRevision)
  })

  it('PUT with the field omitted keeps the stored list, intersected with the new aliases', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'HBL NYC'] })
    const kept = await put('acme', { aliases: ALIASES, country: 'CA' })
    expect(kept.statusCode).toBe(200)
    expect(kept.json().qualifiedAliases).toEqual(['HBL NYC', 'HBLNYC'])

    // Removing an alias drops its qualification without a 400.
    const narrowed = await put('acme', { aliases: ['HBLNYC', 'HBL'] })
    expect(narrowed.statusCode).toBe(200)
    expect(narrowed.json().qualifiedAliases).toEqual(['HBLNYC'])
    expect(row('acme').qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('PUT with the field omitted drops a name the new display name now spells', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'Tidewater'] })
    const renamed = await put('acme', { displayName: 'HBL NYC', aliases: ALIASES })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().aliases).toContain('HBLNYC')
    expect(renamed.json().qualifiedAliases).toEqual(['Tidewater'])
  })

  it('PUT with the field omitted drops a name a live competitor now claims', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'Tidewater'] })
    addCompetitor(row('acme').id, 'tidewater.example')
    const kept = await put('acme', { aliases: ALIASES })
    expect(kept.statusCode).toBe(200)
    expect(kept.json().qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('PUT with [] clears the list, and a qualified-only change bumps the revision without the alias backfill', async () => {
    await put('acme', { aliases: ALIASES })
    expect(aliasChanges).toEqual([])
    const start = row('acme').configRevision

    const set = await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC'] })
    expect(set.statusCode).toBe(200)
    expect(set.json()).toMatchObject({ qualifiedAliases: ['HBLNYC'], configRevision: start + 1 })

    const cleared = await put('acme', { aliases: ALIASES, qualifiedAliases: [] })
    expect(cleared.json()).toMatchObject({ qualifiedAliases: [], configRevision: start + 2 })
    expect(aliasChanges).toEqual([])

    // An alias change still fires, and drops a qualification it removes.
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC'] })
    const renamed = await put('acme', { aliases: ['HBL NYC'] })
    expect(renamed.json().qualifiedAliases).toEqual([])
    expect(aliasChanges).toEqual(['acme'])
  })

  it('every project read carries the field, including the overview composite', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC'] })
    await put('other', { aliases: ALIASES })

    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/acme' })).json().qualifiedAliases).toEqual(['HBLNYC'])
    const list = (await app.inject({ method: 'GET', url: '/api/v1/projects' })).json() as Array<{ name: string; qualifiedAliases: string[] }>
    expect(Object.fromEntries(list.map(project => [project.name, project.qualifiedAliases]))).toEqual({ acme: ['HBLNYC'], other: [] })
    const overview = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/overview' })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().project.qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('export emits the field only when the list is non-empty', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'HBL NYC'] })
    await put('other', { aliases: ALIASES })

    const withList = (await app.inject({ method: 'GET', url: '/api/v1/projects/acme/export' })).json()
    expect(withList.spec.qualifiedAliases).toEqual(['HBL NYC', 'HBLNYC'])
    const withoutList = (await app.inject({ method: 'GET', url: '/api/v1/projects/other/export' })).json()
    expect(withoutList.spec).not.toHaveProperty('qualifiedAliases')
  })

  it('an export re-applies with the list unchanged', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC'] })
    const { exported, applied } = await exportThenApply('acme')
    expect(exported.spec.qualifiedAliases).toEqual(['HBLNYC'])
    expect(applied.statusCode).toBe(200)
    expect(applied.json().qualifiedAliases).toEqual(['HBLNYC'])
    expect(row('acme').qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('export leaves out a name a competitor row claims, so it still re-applies', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'Tidewater'] })
    addCompetitor(row('acme').id, 'tidewater.example')
    const { exported, applied } = await exportThenApply('acme')
    expect(exported.spec.qualifiedAliases).toEqual(['HBLNYC'])
    expect(applied.statusCode).toBe(200)
    expect(row('acme').qualifiedAliases).toEqual(['HBLNYC'])
  })
})

describe('competitor writes keep the stored qualifiedAliases valid', () => {
  function competitorAudit(action: string) {
    const entry = db.select().from(auditLog).all().find(a => a.action === action)!
    return JSON.parse(entry.diff!) as Record<string, unknown>
  }

  it('POST /competitors drops a qualified alias the new competitor claims, and the export still re-applies', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'Tidewater'] })
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/competitors', payload: { competitors: ['https://www.tidewater.example'] } })
    expect(added.statusCode).toBe(200)
    expect(row('acme').qualifiedAliases).toEqual(['HBLNYC'])
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/acme' })).json().qualifiedAliases).toEqual(['HBLNYC'])
    expect(competitorAudit('competitors.appended')).toEqual({ added: ['tidewater.example'], droppedQualifiedAliases: ['Tidewater'] })

    const { applied } = await exportThenApply('acme')
    expect(applied.statusCode).toBe(200)
    expect(applied.json().qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('PUT /competitors drops a claimed name and leaves an unrelated list untouched', async () => {
    await put('acme', { aliases: ALIASES, qualifiedAliases: ['HBLNYC', 'Tidewater'] })
    const before = row('acme')
    await app.inject({ method: 'PUT', url: '/api/v1/projects/acme/competitors', payload: { competitors: ['rival.example'] } })
    expect(row('acme').qualifiedAliases).toEqual(['HBLNYC', 'Tidewater'])
    expect(row('acme').updatedAt).toBe(before.updatedAt)
    expect(competitorAudit('competitors.replaced')).toEqual({ competitors: ['rival.example'] })

    await app.inject({ method: 'PUT', url: '/api/v1/projects/acme/competitors', payload: { competitors: ['hblnyc.example'] } })
    expect(row('acme').qualifiedAliases).toEqual(['Tidewater'])
  })
})

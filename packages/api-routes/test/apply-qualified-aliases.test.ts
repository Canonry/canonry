import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { competitors, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// `spec.qualifiedAliases` follows the `queries` rule: present replaces the
// list, absent keeps the stored one (minus names that no longer qualify).

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let aliasChanges: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-qualified-aliases-'))
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

const ALIASES = ['HBLNYC', 'HBL NYC', 'HBL', 'HarborlineLabs', 'Tidewater']

function apply(spec: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/apply',
    payload: {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'harborline' },
      spec: {
        displayName: 'Harborline Labs',
        canonicalDomain: 'harborline.example',
        country: 'US',
        language: 'en',
        aliases: ALIASES,
        ...spec,
      },
    },
  })
}

function stored() {
  return db.select().from(projects).where(eq(projects.name, 'harborline')).get()
}

describe('POST /apply qualifiedAliases', () => {
  it('an explicit list replaces the stored one and the response carries it', async () => {
    const created = await apply({ qualifiedAliases: ['hblnyc'] })
    expect(created.statusCode).toBe(200)
    expect(created.json().qualifiedAliases).toEqual(['HBLNYC'])

    const replaced = await apply({ qualifiedAliases: ['HBL NYC'] })
    expect(replaced.json().qualifiedAliases).toEqual(['HBL NYC'])
    expect(stored()!.qualifiedAliases).toEqual(['HBL NYC'])

    const cleared = await apply({ qualifiedAliases: [] })
    expect(cleared.json().qualifiedAliases).toEqual([])
    expect(aliasChanges).toEqual([])
  })

  it('an omitted list keeps the stored one, minus names no longer among aliases', async () => {
    await apply({ qualifiedAliases: ['HBLNYC', 'HBL NYC'] })
    const kept = await apply()
    expect(kept.json().qualifiedAliases).toEqual(['HBL NYC', 'HBLNYC'])

    const narrowed = await apply({ aliases: ['HBL NYC'] })
    expect(narrowed.statusCode).toBe(200)
    expect(narrowed.json().qualifiedAliases).toEqual(['HBL NYC'])
    expect(aliasChanges).toEqual(['harborline'])
  })

  it('a new project applied without the field starts empty', async () => {
    const created = await apply()
    expect(created.json().qualifiedAliases).toEqual([])
  })

  it('an invalid list is a 400 that writes nothing', async () => {
    await apply({ qualifiedAliases: ['HBLNYC'] })
    const before = stored()!

    const res = await apply({ qualifiedAliases: ['Nope', 'HarborlineLabs', 'HBL'], queries: ['changed basket'] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toBe('Rejected qualifiedAliases: Nope (not-an-alias), HarborlineLabs (display-name), HBL (too-short)')
    expect(res.json().error.details.rejectedQualifiedAliases).toEqual([
      { name: 'Nope', reason: 'not-an-alias' },
      { name: 'HarborlineLabs', reason: 'display-name' },
      { name: 'HBL', reason: 'too-short' },
    ])
    const after = stored()!
    expect(after.qualifiedAliases).toEqual(['HBLNYC'])
    expect(after.configRevision).toBe(before.configRevision)
  })

  it('checks collisions against the competitors in the spec, which apply is about to write', async () => {
    const collides = await apply({ competitors: ['https://www.tidewater.example'], qualifiedAliases: ['Tidewater'] })
    expect(collides.statusCode).toBe(400)
    expect(collides.json().error.details.rejectedQualifiedAliases).toEqual([{ name: 'Tidewater', reason: 'competitor-collision' }])
    expect(stored()).toBeUndefined()

    // A live competitor the spec drops no longer blocks the name.
    expect((await apply({ competitors: ['tidewater.example'] })).statusCode).toBe(200)
    const project = stored()!
    expect(db.select().from(competitors).where(eq(competitors.projectId, project.id)).all().map(row => row.domain)).toEqual(['tidewater.example'])
    const allowed = await apply({ competitors: [], qualifiedAliases: ['Tidewater'] })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().qualifiedAliases).toEqual(['Tidewater'])
  })

  it('an omitted list drops a name a competitor in the spec now claims, so the export re-applies', async () => {
    expect((await apply({ aliases: ['HBLNYC', 'Tidewater'], qualifiedAliases: ['HBLNYC', 'Tidewater'] })).statusCode).toBe(200)
    const withCompetitor = await apply({ aliases: ['HBLNYC', 'Tidewater'], competitors: ['tidewater.example'] })
    expect(withCompetitor.statusCode).toBe(200)
    expect(withCompetitor.json().qualifiedAliases).toEqual(['HBLNYC'])
    expect(stored()!.qualifiedAliases).toEqual(['HBLNYC'])

    const exported = (await app.inject({ method: 'GET', url: '/api/v1/projects/harborline/export' })).json()
    expect(exported.spec).toMatchObject({ competitors: ['tidewater.example'], qualifiedAliases: ['HBLNYC'] })
    const reapplied = await app.inject({ method: 'POST', url: '/api/v1/apply', payload: exported })
    expect(reapplied.statusCode).toBe(200)
    expect(reapplied.json().qualifiedAliases).toEqual(['HBLNYC'])
  })

  it('rejects out-of-bounds entries at the schema', async () => {
    const res = await apply({ qualifiedAliases: ['x'.repeat(201)] })
    expect(res.statusCode).toBe(400)
    expect(stored()).toBeUndefined()
  })

  it('skips a blank entry instead of rejecting it, unlike PUT, whose schema trims', async () => {
    // Pinned on purpose: `spec.aliases` has the same lenient shape, and resolve
    // trims and skips blanks, so a stray empty YAML item never fails an apply.
    const res = await apply({ qualifiedAliases: ['  ', ' HBLNYC '] })
    expect(res.statusCode).toBe(200)
    expect(res.json().qualifiedAliases).toEqual(['HBLNYC'])
  })
})

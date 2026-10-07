import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { formatPercent, percentOf } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'

// Operator-curated competitor aliases: one stored list per competitor, written
// through REST and config-as-code under one set of rules, and read by every
// competitor mention matcher.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let competitorAliasHooks: string[]
let projectAliasHooks: string[]

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-competitor-aliases-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  competitorAliasHooks = []
  projectAliasHooks = []
  app = Fastify()
  app.register(apiRoutes, {
    db,
    skipAuth: true,
    onCompetitorAliasesChanged: (_id, name) => competitorAliasHooks.push(name),
    onAliasesChanged: (_id, name) => projectAliasHooks.push(name),
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const PROJECT = {
  displayName: 'Rotorwise',
  canonicalDomain: 'rotorwise.example',
  aliases: ['Rotorwise Pros'],
  country: 'US',
  language: 'en',
}

async function createProject(name = 'rotorwise') {
  const res = await app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: PROJECT })
  expect(res.statusCode).toBe(201)
  return db.select().from(projects).where(eq(projects.name, name)).get()!
}

function setAliases(domain: string, aliases: unknown, project = 'rotorwise') {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${project}/competitors/${encodeURIComponent(domain)}/aliases`,
    payload: { aliases },
  })
}

function storedAliases(projectId: string): Record<string, string[]> {
  return Object.fromEntries(db.select({ domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors).where(eq(competitors.projectId, projectId)).all()
    .map(row => [row.domain, row.aliases]))
}

function audits(projectId: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, action))).all()
}

describe('PUT /projects/:name/competitors/:domain/aliases', () => {
  it('sets, normalizes, returns and lists aliases, and audits each change once', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'qvx.example'] } })

    const res = await setAliases('spoketuneworks.example', ['  TuneSpoke ', 'tunespoke', 'Tune Spoke'])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Tune Spoke'] })

    const listed = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/competitors' })).json()
    expect(Object.fromEntries(listed.map((c: { domain: string; aliases: string[] }) => [c.domain, c.aliases]))).toEqual({
      'spoketuneworks.example': ['TuneSpoke', 'Tune Spoke'],
      'qvx.example': [],
    })

    const rows = audits(project.id, 'competitors.aliases-updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityType).toBe('competitor')
    expect(JSON.parse(rows[0]!.diff!)).toEqual({ domain: 'spoketuneworks.example', before: [], after: ['TuneSpoke', 'Tune Spoke'] })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
  })

  it('is idempotent: re-sending the same list writes no audit row and fires no hook', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example'] } })
    expect((await setAliases('qvx.example', ['QVX'])).statusCode).toBe(200)
    const again = await setAliases('qvx.example', ['qvx'])
    expect(again.statusCode).toBe(200)
    // A casing-only resend is normalized against itself, so the stored spelling is replaced.
    expect(again.json().aliases).toEqual(['qvx'])
    const third = await setAliases('qvx.example', ['qvx'])
    expect(third.json().aliases).toEqual(['qvx'])
    expect(audits(project.id, 'competitors.aliases-updated')).toHaveLength(2)
    expect(competitorAliasHooks).toEqual(['rotorwise', 'rotorwise'])
  })

  it('clears with an empty list and resolves any spelling of the domain', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example'] } })
    await setAliases('https://www.qvx.example/shop', ['QVX'])
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'] })
    const cleared = await setAliases('shop.qvx.example', [])
    expect(cleared.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [] })
  })

  it('returns 404 for an untracked competitor and 400 for a malformed body', async () => {
    await createProject()
    const missing = await setAliases('nobody.example', ['Nobody'])
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('NOT_FOUND')
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example'] } })
    const malformed = await setAliases('qvx.example', 'QVX')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a too-short alias, a project brand name and another competitor\'s name, writing nothing', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['ravenwood.example', 'ravenwoodbikeinc.example'] } })

    const short = await setAliases('ravenwoodbikeinc.example', ['PB'])
    expect(short.statusCode).toBe(400)
    expect(short.json().error.details.rejectedAliases).toEqual([{ domain: 'ravenwoodbikeinc.example', alias: 'PB', reason: 'too-short' }])

    const own = await setAliases('ravenwoodbikeinc.example', ['Rotorwise Pros', 'Ravenwood Cycling'])
    expect(own.statusCode).toBe(400)
    expect(own.json().error.message).toContain('"Rotorwise Pros" is one of the project\'s own brand names')

    const other = await setAliases('ravenwoodbikeinc.example', ['Ravenwood'])
    expect(other.statusCode).toBe(400)
    expect(other.json().error.details.rejectedAliases).toEqual([
      { domain: 'ravenwoodbikeinc.example', alias: 'Ravenwood', reason: 'other-competitor', conflictsWith: 'ravenwood.example' },
    ])

    const tooMany = await setAliases('ravenwoodbikeinc.example', Array.from({ length: 11 }, (_, i) => `Bike Inc Crew ${String.fromCharCode(65 + i)}`))
    expect(tooMany.statusCode).toBe(400)
    expect(tooMany.json().error.details.overLimit).toEqual([{ domain: 'ravenwoodbikeinc.example', count: 11 }])

    expect(storedAliases(project.id)).toEqual({ 'ravenwood.example': [], 'ravenwoodbikeinc.example': [] })
    expect(audits(project.id, 'competitors.aliases-updated')).toHaveLength(0)
    expect(competitorAliasHooks).toEqual([])
  })
})

describe('competitor add and replace keep aliases', () => {
  it('POST accepts { domain, aliases } entries and adds aliases to a tracked domain', async () => {
    const project = await createProject()
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/competitors',
      payload: { competitors: [{ domain: 'www.spoketuneworks.example', aliases: ['TuneSpoke'] }, 'qvx.example'] },
    })
    expect(added.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke'], 'qvx.example': [] })
    expect(JSON.parse(audits(project.id, 'competitors.appended')[0]!.diff!)).toEqual({
      added: ['spoketuneworks.example', 'qvx.example'],
      aliasChanges: [{ domain: 'spoketuneworks.example', before: [], after: ['TuneSpoke'] }],
    })

    // Already tracked: aliases are added; a bare domain changes nothing.
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/competitors',
      payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['Tune Spoke Crew'] }, 'qvx.example'] },
    })
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke', 'Tune Spoke Crew'], 'qvx.example': [] })

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/rotorwise/competitors',
      payload: { competitors: [{ domain: 'ravenwood.example', aliases: ['Rotorwise'] }] },
    })
    expect(rejected.statusCode).toBe(400)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke', 'Tune Spoke Crew'], 'qvx.example': [] })
  })

  it('PUT replace keeps the row and aliases of a domain that stays', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'qvx.example', aliases: ['QVX'] }, 'ravenwood.example'] } })
    const before = db.select().from(competitors).where(eq(competitors.domain, 'qvx.example')).get()!

    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example', 'spoketuneworks.example'] } })
    expect(replaced.statusCode).toBe(200)
    expect(Object.fromEntries(replaced.json().map((c: { domain: string; aliases: string[] }) => [c.domain, c.aliases]))).toEqual({
      'qvx.example': ['QVX'],
      'spoketuneworks.example': [],
    })
    expect(db.select().from(competitors).where(eq(competitors.domain, 'qvx.example')).get()!.id).toBe(before.id)
    expect(JSON.parse(audits(project.id, 'competitors.replaced')[0]!.diff!)).toEqual({ competitors: ['qvx.example', 'spoketuneworks.example'] })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
  })
})

describe('a new domain never takes over a stored alias', () => {
  const blockedMessage = 'Invalid competitor aliases: tunespoke.example: cannot be added while "TuneSpoke" is a curated alias of spoketuneworks.example; remove or restate that alias first'

  it('rejects a domain-only POST and PUT replace, writing nothing', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }] } })
    competitorAliasHooks.length = 0

    const posted = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(posted.statusCode).toBe(400)
    expect(posted.json().error.message).toBe(blockedMessage)
    expect(posted.json().error.details.rejectedAliases).toEqual([
      { domain: 'tunespoke.example', alias: 'TuneSpoke', reason: 'claimed-by-alias', conflictsWith: 'spoketuneworks.example' },
    ])

    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'tunespoke.example'] } })
    expect(replaced.statusCode).toBe(400)
    expect(replaced.json().error.message).toBe(blockedMessage)

    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke'] })
    expect(audits(project.id, 'competitors.appended')).toHaveLength(1)
    expect(audits(project.id, 'competitors.replaced')).toHaveLength(0)
    expect(competitorAliasHooks).toEqual([])

    // Replacing the alias owner away frees the name.
    const swapped = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(swapped.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'tunespoke.example': [] })
  })

  it('rejects a bare-domain apply, and accepts one that restates the owner\'s aliases', async () => {
    const apply = (competitorsSpec: unknown[]) => app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: { apiVersion: 'canonry/v1', kind: 'Project', metadata: { name: 'rotorwise' }, spec: { ...PROJECT, competitors: competitorsSpec } },
    })
    expect((await apply([{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Spoke Tune Pros'] }])).statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!

    const blocked = await apply(['spoketuneworks.example', 'tunespoke.example'])
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error.message).toBe(blockedMessage)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke', 'Spoke Tune Pros'] })

    const restated = await apply([{ domain: 'spoketuneworks.example', aliases: ['Spoke Tune Pros'] }, 'tunespoke.example'])
    expect(restated.statusCode, restated.body).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['Spoke Tune Pros'], 'tunespoke.example': [] })
  })
})

describe('an alias never overlaps another competitor\'s name', () => {
  // The readers match a brand key as complete adjacent words under any word
  // split of the answer, so "Tune" on one competitor and "Tune Spoke" (or
  // "TuneSpoke", or a domain label `tunespoke`) on another would both count
  // an answer naming only "Tune Spoke". Whichever is written second fails.
  it('rejects either order through the alias route, and a domain found inside a stored alias, writing nothing', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'qvx.example', aliases: ['Tune'] }, 'wheelwright.example'] } })
    competitorAliasHooks.length = 0

    const longer = await setAliases('wheelwright.example', ['Tune Spoke'])
    expect(longer.statusCode).toBe(400)
    expect(longer.json().error.code).toBe('VALIDATION_ERROR')
    expect(longer.json().error.message).toBe(
      'Invalid competitor aliases: wheelwright.example: "Tune Spoke" contains "Tune", a name of qvx.example, so one answer would count both competitors',
    )
    expect(longer.json().error.details.rejectedAliases).toEqual([
      { domain: 'wheelwright.example', alias: 'Tune Spoke', reason: 'other-competitor', conflictsWith: 'qvx.example', conflictingName: 'Tune' },
    ])

    // The other order: "Tune Spoke" stored first, then "Tune".
    expect((await setAliases('qvx.example', [])).statusCode).toBe(200)
    expect((await setAliases('wheelwright.example', ['Tune Spoke'])).statusCode).toBe(200)
    const shorter = await setAliases('qvx.example', ['Tune'])
    expect(shorter.statusCode).toBe(400)
    expect(shorter.json().error.message).toBe(
      'Invalid competitor aliases: qvx.example: "Tune" is found inside "Tune Spoke", a name of wheelwright.example, so one answer would count both competitors',
    )

    // A new domain whose label `tune` is a word of the stored alias.
    const added = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example', 'wheelwright.example', 'tune.example'] } })
    expect(added.statusCode).toBe(400)
    expect(added.json().error.details.rejectedAliases).toEqual([
      { domain: 'tune.example', alias: 'Tune Spoke', reason: 'claimed-by-alias', conflictsWith: 'wheelwright.example', conflictingName: 'tune' },
    ])

    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [], 'wheelwright.example': ['Tune Spoke'] })
    expect(audits(project.id, 'competitors.aliases-updated')).toHaveLength(2)
    expect(audits(project.id, 'competitors.replaced')).toHaveLength(0)
  })

  // Reported: alias "TuneSpoke" on one competitor and "Tune" on another were
  // both accepted (200), and "Tune Spoke is the shop..." then counted both.
  it('rejects "Tune" next to the one-word alias "TuneSpoke", in either order', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['wheelwright.example', 'qvx.example'] } })

    expect((await setAliases('wheelwright.example', ['TuneSpoke'])).statusCode).toBe(200)
    const shorter = await setAliases('qvx.example', ['Tune'])
    expect(shorter.statusCode).toBe(400)
    expect(shorter.json().error.details.rejectedAliases).toEqual([
      { domain: 'qvx.example', alias: 'Tune', reason: 'other-competitor', conflictsWith: 'wheelwright.example', conflictingName: 'TuneSpoke' },
    ])

    expect((await setAliases('wheelwright.example', [])).statusCode).toBe(200)
    expect((await setAliases('qvx.example', ['Tune'])).statusCode).toBe(200)
    const longer = await setAliases('wheelwright.example', ['TuneSpoke'])
    expect(longer.statusCode).toBe(400)
    expect(longer.json().error.message).toBe(
      'Invalid competitor aliases: wheelwright.example: "TuneSpoke" contains "Tune", a name of qvx.example, so one answer would count both competitors',
    )
    expect(storedAliases(project.id)).toEqual({ 'wheelwright.example': [], 'qvx.example': ['Tune'] })
  })

  // Reported: with tunespoke.example tracked, alias "Tune" was accepted, and
  // "Tune Spoke" counted both.
  it('rejects "Tune" next to a domain whose label contains it, and that domain next to "Tune"', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example', 'qvx.example'] } })

    const alias = await setAliases('qvx.example', ['Tune'])
    expect(alias.statusCode).toBe(400)
    expect(alias.json().error.details.rejectedAliases).toEqual([
      { domain: 'qvx.example', alias: 'Tune', reason: 'other-competitor', conflictsWith: 'tunespoke.example', conflictingName: 'tunespoke' },
    ])

    // The add path: with "Tune" stored, neither label containing it can be added.
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tunespoke.example'] } })
    expect(removed.statusCode).toBe(200)
    expect((await setAliases('qvx.example', ['Tune'])).statusCode).toBe(200)
    for (const [domain, label] of [['tunespoke.example', 'tunespoke'], ['spoketuneworks.example', 'spoketuneworks']] as const) {
      const add = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [domain] } })
      expect(add.statusCode).toBe(400)
      expect(add.json().error.details.rejectedAliases).toEqual([
        { domain, alias: 'Tune', reason: 'claimed-by-alias', conflictsWith: 'qvx.example', conflictingName: label },
      ])
    }
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['Tune'] })
  })

  it('blocks an add that overlaps aliases an older build stored overlapping, without stripping them', async () => {
    const project = await createProject()
    // Stored lists that already overlap each other (written before this rule).
    for (const [domain, aliases] of [['wheelwright.example', ['Tune Spoke']], ['qvx.example', ['Tune']]] as const) {
      db.insert(competitors).values({ id: crypto.randomUUID(), projectId: project.id, domain, aliases: [...aliases], provenance: 'cli', createdAt: '2026-10-01T00:00:00.000Z' }).run()
    }
    const add = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['tune.example'] } })
    expect(add.statusCode).toBe(400)
    expect(add.json().error.details.rejectedAliases).toEqual([
      { domain: 'tune.example', alias: 'Tune', reason: 'claimed-by-alias', conflictsWith: 'qvx.example' },
      { domain: 'tune.example', alias: 'Tune Spoke', reason: 'claimed-by-alias', conflictsWith: 'wheelwright.example', conflictingName: 'tune' },
    ])
    expect(storedAliases(project.id)).toEqual({ 'wheelwright.example': ['Tune Spoke'], 'qvx.example': ['Tune'] })
  })
})

describe('the project\'s own site is never a competitor', () => {
  it('refuses to add the project\'s domain, a subdomain of it, or a parent of an owned domain, on every writer', async () => {
    const project = await createProject()
    expect((await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise', payload: { ...PROJECT, ownedDomains: ['rotorwise.pagehost.example'] } })).statusCode).toBe(200)

    for (const domain of ['rotorwise.example', 'shop.rotorwise.example', 'pagehost.example']) {
      const add = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example', domain] } })
      expect(add.statusCode, domain).toBe(400)
      expect(add.json().error.code).toBe('VALIDATION_ERROR')
    }
    const replace = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['blog.rotorwise.example'] } })
    expect(replace.statusCode).toBe(400)
    expect(replace.json().error.message).toBe(
      'Cannot track the project\'s own site as a competitor: rotorwise.example overlaps the project domain rotorwise.example, so every citation of the project would count for it',
    )
    expect(replace.json().error.details).toEqual({ ownSiteCompetitors: [{ domain: 'rotorwise.example', projectDomain: 'rotorwise.example' }] })

    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/apply',
      payload: {
        apiVersion: 'canonry/v1',
        kind: 'Project',
        metadata: { name: 'rotorwise' },
        spec: { ...PROJECT, ownedDomains: ['rotorwise.pagehost.example'], competitors: ['pagehost.example'] },
      },
    })
    expect(apply.statusCode).toBe(400)
    expect(apply.json().error.details).toEqual({ ownSiteCompetitors: [{ domain: 'pagehost.example', projectDomain: 'rotorwise.pagehost.example' }] })
    expect(storedAliases(project.id)).toEqual({})
  })
})

describe('competitor rows stored unnormalized by an older build', () => {
  function insertCompetitor(projectId: string, domain: string, aliases: string[] = []) {
    const id = crypto.randomUUID()
    db.insert(competitors).values({ id, projectId, domain, aliases, provenance: 'discovery:legacy', createdAt: '2026-10-01T00:00:00.000Z' }).run()
    return id
  }

  it('resolves a subdomain row by any spelling for alias writes, adds, replace and delete', async () => {
    const project = await createProject()
    const legacyId = insertCompetitor(project.id, 'offers.spoketuneworks.example')

    const byRegistrable = await setAliases('spoketuneworks.example', ['TuneSpoke'])
    expect(byRegistrable.statusCode, byRegistrable.body).toBe(200)
    expect(byRegistrable.json()).toMatchObject({ id: legacyId, domain: 'offers.spoketuneworks.example', aliases: ['TuneSpoke'] })
    const byHost = await setAliases('offers.spoketuneworks.example', ['TuneSpoke', 'Spoke Tune Pros'])
    expect(byHost.statusCode, byHost.body).toBe(200)

    // An add of the registrable form appends to the legacy row instead of
    // inserting a second row for the same competitor.
    const appended = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['Tune Spoke Crew'] }] } })
    expect(appended.statusCode, appended.body).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'offers.spoketuneworks.example': ['TuneSpoke', 'Spoke Tune Pros', 'Tune Spoke Crew'] })

    // A replace that names it keeps the row, its id and its aliases.
    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'qvx.example'] } })
    expect(replaced.statusCode, replaced.body).toBe(200)
    expect(db.select().from(competitors).where(eq(competitors.id, legacyId)).get()!.aliases).toEqual(['TuneSpoke', 'Spoke Tune Pros', 'Tune Spoke Crew'])
    expect(storedAliases(project.id)).toEqual({ 'offers.spoketuneworks.example': ['TuneSpoke', 'Spoke Tune Pros', 'Tune Spoke Crew'], 'qvx.example': [] })

    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example'] } })
    expect(deleted.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [] })
    expect(JSON.parse(audits(project.id, 'competitors.deleted')[0]!.diff!)).toEqual({
      deleted: ['offers.spoketuneworks.example'],
      deletedAliases: { 'offers.spoketuneworks.example': ['TuneSpoke', 'Spoke Tune Pros', 'Tune Spoke Crew'] },
    })
  })

  it('refuses an alias write to a competitor stored as two rows, and removes both on delete', async () => {
    const project = await createProject()
    insertCompetitor(project.id, 'spoketuneworks.example', ['TuneSpoke'])
    const legacyId = insertCompetitor(project.id, 'offers.spoketuneworks.example')
    const ambiguous = 'Competitor spoketuneworks.example is stored as 2 rows (offers.spoketuneworks.example, spoketuneworks.example), so this write cannot pick one. '
      + 'Remove the competitor, which removes every row (canonry competitor remove <project> spoketuneworks.example), '
      + 'then add it again with its curated aliases (canonry competitor add <project> spoketuneworks.example --alias "TuneSpoke")'

    const alias = await setAliases('spoketuneworks.example', ['Tune Spoke'])
    expect(alias.statusCode).toBe(400)
    expect(alias.json().error.code).toBe('VALIDATION_ERROR')
    expect(alias.json().error.message).toBe(ambiguous)
    expect(alias.json().error.details).toEqual({
      domain: 'spoketuneworks.example',
      matches: [
        { id: legacyId, domain: 'offers.spoketuneworks.example' },
        { id: expect.any(String), domain: 'spoketuneworks.example' },
      ],
      aliases: ['TuneSpoke'],
    })
    const appended = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'offers.spoketuneworks.example', aliases: ['Tune Spoke'] }] } })
    expect(appended.statusCode).toBe(400)
    expect(appended.json().error.message).toBe(ambiguous)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke'], 'offers.spoketuneworks.example': [] })

    // Writes that change neither row still work: an unrelated add, and a
    // domain-only add of the duplicated competitor (nothing to choose).
    const unrelated = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example', 'spoketuneworks.example'] } })
    expect(unrelated.statusCode, unrelated.body).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['TuneSpoke'], 'offers.spoketuneworks.example': [], 'qvx.example': [] })

    // Removing the competitor removes every row that is it.
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example'] } })
    expect(deleted.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [] })
    const diff = JSON.parse(audits(project.id, 'competitors.deleted')[0]!.diff!) as { deleted: string[]; deletedAliases: unknown }
    expect([...diff.deleted].sort()).toEqual(['offers.spoketuneworks.example', 'spoketuneworks.example'])
    expect(diff.deletedAliases).toEqual({ 'spoketuneworks.example': ['TuneSpoke'] })
  })
})

describe('alias route audits every alias change it makes', () => {
  it('audits and backfills when stored lists disagreed and another competitor\'s alias is dropped', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }] } })
    // A row written outside the shared writer (an older build, a direct DB
    // edit): its domain identifies the other competitor's alias.
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId: project.id, domain: 'tunespoke.example', provenance: 'cli', createdAt: '2026-10-01T00:00:00.000Z' }).run()
    competitorAliasHooks.length = 0

    // An idempotent write on tunespoke.example still repairs spoketuneworks.example.
    const res = await setAliases('tunespoke.example', [])
    expect(res.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': [], 'tunespoke.example': [] })
    const rows = audits(project.id, 'competitors.aliases-updated')
    expect(JSON.parse(rows.at(-1)!.diff!)).toEqual({
      domain: 'tunespoke.example',
      before: [],
      after: [],
      aliasChanges: [{ domain: 'spoketuneworks.example', before: ['TuneSpoke'], after: [] }],
      droppedCompetitorAliases: [
        { domain: 'spoketuneworks.example', alias: 'TuneSpoke', reason: 'other-competitor', conflictsWith: 'tunespoke.example' },
      ],
    })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
  })

  it('rejects an alias found inside the project\'s names or hosts', async () => {
    await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['qvx.example'] } })
    const res = await setAliases('qvx.example', ['Pros', 'rotorwise.example', 'www.rotorwise.example', 'QVX'])
    expect(res.statusCode).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([
      { domain: 'qvx.example', alias: 'Pros', reason: 'project-brand', conflictingName: 'Rotorwise Pros' },
      { domain: 'qvx.example', alias: 'rotorwise.example', reason: 'project-brand' },
      { domain: 'qvx.example', alias: 'www.rotorwise.example', reason: 'project-brand', conflictingName: 'Rotorwise' },
    ])
  })
})

describe('competitor deletes', () => {
  it('records the discarded curated aliases on the audit row', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke'] }, 'ravenwood.example', { domain: 'qvx.example', aliases: ['QVX'] }] } })

    const batch = await app.inject({ method: 'DELETE', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'ravenwood.example'] } })
    expect(batch.statusCode).toBe(200)
    const qvx = db.select().from(competitors).where(eq(competitors.domain, 'qvx.example')).get()!
    const byId = await app.inject({ method: 'DELETE', url: `/api/v1/projects/rotorwise/competitors/${qvx.id}` })
    expect(byId.statusCode).toBe(204)

    const diffs = audits(project.id, 'competitors.deleted').map(row => JSON.parse(row.diff!) as { deleted: string[] })
    expect(diffs.map(diff => ({ ...diff, deleted: [...diff.deleted].sort() }))).toEqual([
      { deleted: ['ravenwood.example', 'spoketuneworks.example'], deletedAliases: { 'spoketuneworks.example': ['TuneSpoke'] } },
      { deleted: ['qvx.example'], deletedAliases: { 'qvx.example': ['QVX'] } },
    ])
  })
})

describe('config-as-code competitor aliases', () => {
  function spec(competitorsSpec: unknown[], extra: Record<string, unknown> = {}) {
    return {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'rotorwise' },
      spec: { ...PROJECT, competitors: competitorsSpec, ...extra },
    }
  }
  const apply = (body: unknown) => app.inject({ method: 'POST', url: '/api/v1/apply', payload: body })

  it('sets aliases from object entries, preserves them for string entries, clears with []', async () => {
    expect((await apply(spec([{ domain: 'qvx.example', aliases: ['QVX'] }, 'spoketuneworks.example']))).statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'spoketuneworks.example': [] })
    // New project: nothing historical to backfill.
    expect(competitorAliasHooks).toEqual([])

    // A REST alias write, then a domains-only apply: the string entry has no opinion.
    await setAliases('spoketuneworks.example', ['TuneSpoke'])
    competitorAliasHooks.length = 0
    expect((await apply(spec(['qvx.example', 'spoketuneworks.example']))).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'spoketuneworks.example': ['TuneSpoke'] })
    expect(competitorAliasHooks).toEqual([])

    // An object entry is exact; [] clears.
    expect((await apply(spec([{ domain: 'qvx.example', aliases: [] }, { domain: 'spoketuneworks.example', aliases: ['Tune Spoke'] }]))).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [], 'spoketuneworks.example': ['Tune Spoke'] })
    expect(competitorAliasHooks).toEqual(['rotorwise'])
    const replacedDiff = JSON.parse(audits(project.id, 'competitors.replaced').at(-1)!.diff!)
    expect(replacedDiff).toEqual({
      competitors: ['qvx.example', 'spoketuneworks.example'],
      aliasChanges: [
        { domain: 'qvx.example', before: ['QVX'], after: [] },
        { domain: 'spoketuneworks.example', before: ['TuneSpoke'], after: ['Tune Spoke'] },
      ],
    })
  })

  it('is idempotent and round-trips through export', async () => {
    await apply(spec([{ domain: 'qvx.example', aliases: ['QVX'] }, 'ravenwood.example']))
    competitorAliasHooks.length = 0
    const exported = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/export' })).json()
    expect(exported.spec.competitors).toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }, 'ravenwood.example'])

    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    const ids = db.select({ id: competitors.id }).from(competitors).where(eq(competitors.projectId, project.id)).all()
    expect((await apply(exported)).statusCode).toBe(200)
    expect((await apply(exported)).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'ravenwood.example': [] })
    expect(db.select({ id: competitors.id }).from(competitors).where(eq(competitors.projectId, project.id)).all()).toEqual(ids)
    expect(competitorAliasHooks).toEqual([])
  })

  it('rejects an invalid stated alias before writing anything', async () => {
    await apply(spec(['qvx.example']))
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    const res = await apply(spec([{ domain: 'qvx.example', aliases: ['Rotorwise'] }, 'ravenwood.example']))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([{ domain: 'qvx.example', alias: 'Rotorwise', reason: 'project-brand' }])
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [] })
  })

  it('drops a preserved alias the spec\'s project identity now claims', async () => {
    await apply(spec([{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Spoke Tune Pros'] }]))
    const project = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!
    const res = await apply(spec(['spoketuneworks.example'], { aliases: ['Rotorwise Pros', 'TuneSpoke'] }))
    expect(res.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['Spoke Tune Pros'] })
    const diff = JSON.parse(audits(project.id, 'competitors.replaced').at(-1)!.diff!)
    expect(diff.droppedCompetitorAliases).toEqual([{ domain: 'spoketuneworks.example', alias: 'TuneSpoke', reason: 'project-brand' }])
  })
})

describe('project identity changes', () => {
  it('drops a competitor alias the project now claims, so the qualified alias is accepted', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['TuneSpoke', 'Spoke Tune Pros'] }] } })

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/rotorwise',
      payload: { ...PROJECT, aliases: ['Rotorwise Pros', 'Tune Spoke'], qualifiedAliases: ['Tune Spoke'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().qualifiedAliases).toEqual(['Tune Spoke'])
    expect(storedAliases(project.id)).toEqual({ 'spoketuneworks.example': ['Spoke Tune Pros'] })
    const updated = audits(project.id, 'project.updated').at(-1)!
    expect(JSON.parse(updated.diff!)).toEqual({
      droppedCompetitorAliases: [{ domain: 'spoketuneworks.example', alias: 'TuneSpoke', reason: 'project-brand' }],
    })
    expect(projectAliasHooks).toEqual(['rotorwise'])
  })

  it('counts a competitor alias as a competitor name for qualified aliases', async () => {
    await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: [{ domain: 'spoketuneworks.example', aliases: ['Coastline Crew'] }] } })
    // The competitor alias stays (the project does not claim it), and the
    // qualified-alias check treats it as a competitor name.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/rotorwise',
      payload: { ...PROJECT, aliases: ['Rotorwise Pros'], qualifiedAliases: ['Rotorwise Pros'] },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('read-time matchers use stored aliases', () => {
  function seedSweep(projectId: string, opts: { runAt?: string; idPrefix?: string; queryId?: string } = {}) {
    const runAt = opts.runAt ?? '2026-10-01T01:00:00.000Z'
    const queryId = opts.queryId ?? crypto.randomUUID()
    const runId = crypto.randomUUID()
    if (!opts.queryId) db.insert(queries).values({ id: queryId, projectId, query: 'best bike repair shop', createdAt: '2026-09-01T00:00:00.000Z' }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: runAt, finishedAt: runAt }).run()
    const answers = [
      'Rotorwise is a solid pick for tune-ups.',
      'Rotorwise and TuneSpoke both quote quickly.',
      'TuneSpoke is the usual recommendation.',
      'Ravenwood Cycling handles fleet bikes.',
      'QVX does wheel builds.',
    ]
    const providers = ['openai', 'gemini', 'claude', 'perplexity', 'local']
    answers.forEach((answerText, i) => {
      db.insert(querySnapshots).values({
        id: `${opts.idPrefix ?? 'snap'}-${i}`,
        runId,
        queryId,
        queryText: 'best bike repair shop',
        provider: providers[i]!,
        citationState: 'not-cited',
        answerMentioned: answerText.startsWith('Rotorwise'),
        answerText,
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        createdAt: runAt,
      }).run()
    })
    return { runId, queryId }
  }

  it('reinterprets stored answers on every read surface once aliases are set', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'ravenwoodbikeinc.example', 'qvx.example'] } })
    const { runId } = seedSweep(project.id)

    // Domains only: no answer names a domain label, so no competitor is mentioned.
    const before = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/overview' })).json()
    expect(before.scores.mentionShare.breakdown).toMatchObject({ projectMentionSnapshots: 2, competitorMentionSnapshots: 0 })
    expect(before.scores.mentionShare.breakdown.score).toBe(100)

    await setAliases('spoketuneworks.example', ['TuneSpoke'])
    await setAliases('ravenwoodbikeinc.example', ['Ravenwood Cycling'])
    await setAliases('qvx.example', ['QVX'])

    const overview = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/overview' })).json()
    const breakdown = overview.scores.mentionShare.breakdown
    expect(breakdown).toMatchObject({ projectMentionSnapshots: 2, competitorMentionSnapshots: 4, combinedMentionSnapshots: 6 })
    expect(breakdown.score).toBe(percentOf(2, 6))
    expect(formatPercent(breakdown.score, 'percent')).toBe('33.3%')
    expect(Object.fromEntries(overview.competitors.map((c: { domain: string; aliases?: string[] }) => [c.domain, c.aliases]))).toEqual({
      'spoketuneworks.example': ['TuneSpoke'],
      'ravenwoodbikeinc.example': ['Ravenwood Cycling'],
      'qvx.example': ['QVX'],
    })

    const detail = (await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })).json()
    const mentioned = Object.fromEntries(detail.snapshots.map((s: { id: string; mentionedCompetitorDomains: string[] }) => [s.id, s.mentionedCompetitorDomains]))
    expect(mentioned).toEqual({
      'snap-0': [],
      'snap-1': ['spoketuneworks.example'],
      'snap-2': ['spoketuneworks.example'],
      'snap-3': ['ravenwoodbikeinc.example'],
      'snap-4': ['qvx.example'],
    })
    // The names that matched, for highlighting without re-deriving identity.
    expect(Object.fromEntries(detail.snapshots.map((s: { id: string; mentionedCompetitorTerms: string[] }) => [s.id, s.mentionedCompetitorTerms]))).toEqual({
      'snap-0': [],
      'snap-1': ['TuneSpoke'],
      'snap-2': ['TuneSpoke'],
      'snap-3': ['Ravenwood Cycling'],
      'snap-4': ['QVX'],
    })

    const gaps = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/gaps' })).json()
    const entry = [...gaps.mentionedQueries, ...gaps.mentionGap, ...gaps.notMentioned][0]
    expect([...entry.competitorsMentioned].sort()).toEqual(['qvx.example', 'ravenwoodbikeinc.example', 'spoketuneworks.example'])

    const landscape = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/competitors?queryClass=non-brand' })).json()
    const mentionsByDomain = Object.fromEntries(landscape.pinned
      .map((row: { domain: string; mentionCount: number }) => [row.domain, row.mentionCount]))
    expect(mentionsByDomain).toEqual({ 'spoketuneworks.example': 2, 'ravenwoodbikeinc.example': 1, 'qvx.example': 1 })
  })
})

describe('every mention-share reader counts curated aliases', () => {
  // Two monthly sweeps of the same five answers. Non-brand basket, so every
  // number below is the non-brand mention share: project answers (2 per sweep)
  // over project plus competitor answers (2 + 4 per sweep with aliases set).
  async function seedTwoMonths() {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example', 'ravenwoodbikeinc.example', 'qvx.example'] } })
    const september = seedSweepTwoMonth(project.id, '2026-09-10T01:00:00.000Z', 'sep')
    seedSweepTwoMonth(project.id, '2026-10-01T01:00:00.000Z', 'oct', september.queryId)
    return project
  }

  function seedSweepTwoMonth(projectId: string, runAt: string, idPrefix: string, queryId?: string) {
    const runId = crypto.randomUUID()
    const id = queryId ?? crypto.randomUUID()
    if (!queryId) db.insert(queries).values({ id, projectId, query: 'best bike repair shop', createdAt: '2026-09-01T00:00:00.000Z' }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: runAt, finishedAt: runAt }).run()
    ;[
      ['openai', 'Rotorwise is a solid pick for tune-ups.'],
      ['gemini', 'Rotorwise and TuneSpoke both quote quickly.'],
      ['claude', 'TuneSpoke is the usual recommendation.'],
      ['perplexity', 'Ravenwood Cycling handles fleet bikes.'],
      ['local', 'QVX does wheel builds.'],
    ].forEach(([provider, answerText], i) => {
      db.insert(querySnapshots).values({
        id: `${idPrefix}-${i}`,
        runId,
        queryId: id,
        queryText: 'best bike repair shop',
        provider: provider!,
        // A known, unchanged model per provider keeps both months comparable.
        model: `${provider}-model`,
        citationState: 'not-cited',
        answerMentioned: answerText!.startsWith('Rotorwise'),
        answerText: answerText!,
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        createdAt: runAt,
      }).run()
    })
    return { queryId: id }
  }

  async function setAll() {
    expect((await setAliases('spoketuneworks.example', ['TuneSpoke'])).statusCode).toBe(200)
    expect((await setAliases('ravenwoodbikeinc.example', ['Ravenwood Cycling'])).statusCode).toBe(200)
    expect((await setAliases('qvx.example', ['QVX'])).statusCode).toBe(200)
  }

  it('analytics metrics: every trend bucket re-reads stored answers with the aliases', async () => {
    await seedTwoMonths()
    const before = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/metrics?window=all' })).json()
    expect(before.mentionShareScope).toBe('non-brand')
    expect(before.buckets.map((b: { mentionShare: unknown }) => b.mentionShare)).toEqual([
      { scope: 'non-brand', rate: 1, projectMentionSnapshots: 2, competitorMentionSnapshots: 0 },
      { scope: 'non-brand', rate: 1, projectMentionSnapshots: 2, competitorMentionSnapshots: 0 },
    ])

    await setAll()
    const after = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/metrics?window=all' })).json()
    // 2 / (2 + 4) per sweep.
    expect(after.buckets.map((b: { mentionShare: unknown }) => b.mentionShare)).toEqual([
      { scope: 'non-brand', rate: 0.33333333, projectMentionSnapshots: 2, competitorMentionSnapshots: 4 },
      { scope: 'non-brand', rate: 0.33333333, projectMentionSnapshots: 2, competitorMentionSnapshots: 4 },
    ])
    expect(formatPercent(after.buckets[1].mentionShare.rate, 'fraction')).toBe('33.3%')
  })

  it('visibility-stats --share-of-voice pools both sweeps with the aliases', async () => {
    await seedTwoMonths()
    const before = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/visibility-stats?shareOfVoice=1' })).json()
    expect(before.shareOfVoice).toMatchObject({ queryClass: 'non-brand', projectMentions: 4, competitorMentions: 0, percent: 100 })

    await setAll()
    const after = (await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/visibility-stats?shareOfVoice=1' })).json()
    expect(after.shareOfVoice).toMatchObject({
      basis: 'tracked',
      availability: 'measured',
      queryClass: 'non-brand',
      projectMentions: 4,
      competitorMentions: 8,
      competitorCount: 3,
      snapshotsWithAnswerText: 10,
      percent: percentOf(4, 12),
    })
    expect(after.shareOfVoice.percent).toBe(33.333333)
    expect(Object.fromEntries(after.shareOfVoice.perCompetitor.map((row: { domain: string; mentions: number }) => [row.domain, row.mentions]))).toEqual({
      'spoketuneworks.example': 4,
      'ravenwoodbikeinc.example': 2,
      'qvx.example': 2,
    })
  })

  it('visibility-compare reads the aliases in both months', async () => {
    await seedTwoMonths()
    const read = async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/visibility-compare?from=2026-09&to=2026-10' })
      expect(res.statusCode, res.body).toBe(200)
      return res.json().metrics.find((metric: { key: string }) => metric.key === 'mention-share-of-voice')
    }
    const before = await read()
    expect(before).toMatchObject({ queryClass: 'non-brand', from: { numerator: 2, denominator: 2, point: 1 }, to: { numerator: 2, denominator: 2, point: 1 } })

    await setAll()
    const after = await read()
    expect(after).toMatchObject({
      queryClass: 'non-brand',
      from: { availability: 'available', numerator: 2, denominator: 6 },
      to: { availability: 'available', numerator: 2, denominator: 6 },
    })
    // The comparison's wire precision is four decimals.
    expect(after.from.point).toBe(0.3333)
    expect(after.to.point).toBe(0.3333)
  })
})

describe('project-scoped keys', () => {
  it('refuses an apply to another project before planning its competitors, so no rejection names them', async () => {
    const authed = Fastify()
    authed.register(apiRoutes, { db, skipAuth: false })
    await authed.ready()
    try {
      const fullKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
      const scopedKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
      const insertKey = (raw: string, projectId: string | null) => db.insert(apiKeys).values({
        id: crypto.randomUUID(),
        name: projectId ? 'scoped' : 'full',
        keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
        keyPrefix: raw.slice(0, 9),
        scopes: ['*'],
        projectId,
        createdAt: new Date().toISOString(),
      }).run()
      insertKey(fullKey, null)
      const full = { authorization: `Bearer ${fullKey}` }
      for (const name of ['own-project', 'sibling']) {
        const created = await authed.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, headers: full, payload: { ...PROJECT, canonicalDomain: `${name}.example` } })
        expect(created.statusCode).toBe(201)
      }
      await authed.inject({ method: 'POST', url: '/api/v1/projects/sibling/competitors', headers: full, payload: { competitors: [{ domain: 'hidden-rival.example', aliases: ['Hidden Rival'] }] } })
      const own = db.select().from(projects).where(eq(projects.name, 'own-project')).get()!
      insertKey(scopedKey, own.id)

      const res = await authed.inject({
        method: 'POST',
        url: '/api/v1/apply',
        headers: { authorization: `Bearer ${scopedKey}` },
        payload: {
          apiVersion: 'canonry/v1',
          kind: 'Project',
          metadata: { name: 'sibling' },
          spec: { ...PROJECT, canonicalDomain: 'sibling.example', competitors: ['hidden-rival.example', { domain: 'qvx.example', aliases: ['Hidden Rival'] }] },
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.body).not.toContain('hidden-rival.example')
    } finally {
      await authed.close()
    }
  })
})

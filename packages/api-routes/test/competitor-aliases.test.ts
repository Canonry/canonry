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
  displayName: 'Roofwise',
  canonicalDomain: 'roofwise.example',
  aliases: ['Roofwise Pros'],
  country: 'US',
  language: 'en',
}

async function createProject(name = 'roofwise') {
  const res = await app.inject({ method: 'PUT', url: `/api/v1/projects/${name}`, payload: PROJECT })
  expect(res.statusCode).toBe(201)
  return db.select().from(projects).where(eq(projects.name, name)).get()!
}

function setAliases(domain: string, aliases: unknown, project = 'roofwise') {
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
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['sealfoamworks.example', 'qvx.example'] } })

    const res = await setAliases('sealfoamworks.example', ['  FoamSeal ', 'foamseal', 'Foam Seal'])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ domain: 'sealfoamworks.example', aliases: ['FoamSeal', 'Foam Seal'] })

    const listed = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/competitors' })).json()
    expect(Object.fromEntries(listed.map((c: { domain: string; aliases: string[] }) => [c.domain, c.aliases]))).toEqual({
      'sealfoamworks.example': ['FoamSeal', 'Foam Seal'],
      'qvx.example': [],
    })

    const rows = audits(project.id, 'competitors.aliases-updated')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityType).toBe('competitor')
    expect(JSON.parse(rows[0]!.diff!)).toEqual({ domain: 'sealfoamworks.example', before: [], after: ['FoamSeal', 'Foam Seal'] })
    expect(competitorAliasHooks).toEqual(['roofwise'])
  })

  it('is idempotent: re-sending the same list writes no audit row and fires no hook', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['qvx.example'] } })
    expect((await setAliases('qvx.example', ['QVX'])).statusCode).toBe(200)
    const again = await setAliases('qvx.example', ['qvx'])
    expect(again.statusCode).toBe(200)
    // A casing-only resend is normalized against itself, so the stored spelling is replaced.
    expect(again.json().aliases).toEqual(['qvx'])
    const third = await setAliases('qvx.example', ['qvx'])
    expect(third.json().aliases).toEqual(['qvx'])
    expect(audits(project.id, 'competitors.aliases-updated')).toHaveLength(2)
    expect(competitorAliasHooks).toEqual(['roofwise', 'roofwise'])
  })

  it('clears with an empty list and resolves any spelling of the domain', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['qvx.example'] } })
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
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['qvx.example'] } })
    const malformed = await setAliases('qvx.example', 'QVX')
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects a too-short alias, a project brand name and another competitor\'s name, writing nothing', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['ridgecrest.example', 'ridgecrestbuildinc.example'] } })

    const short = await setAliases('ridgecrestbuildinc.example', ['PB'])
    expect(short.statusCode).toBe(400)
    expect(short.json().error.details.rejectedAliases).toEqual([{ domain: 'ridgecrestbuildinc.example', alias: 'PB', reason: 'too-short' }])

    const own = await setAliases('ridgecrestbuildinc.example', ['Roofwise Pros', 'Ridgecrest Roofing'])
    expect(own.statusCode).toBe(400)
    expect(own.json().error.message).toContain('"Roofwise Pros" is one of the project\'s own brand names')

    const other = await setAliases('ridgecrestbuildinc.example', ['Ridgecrest'])
    expect(other.statusCode).toBe(400)
    expect(other.json().error.details.rejectedAliases).toEqual([
      { domain: 'ridgecrestbuildinc.example', alias: 'Ridgecrest', reason: 'other-competitor', conflictsWith: 'ridgecrest.example' },
    ])

    const tooMany = await setAliases('ridgecrestbuildinc.example', Array.from({ length: 11 }, (_, i) => `Ridgecrest Crew ${String.fromCharCode(65 + i)}`))
    expect(tooMany.statusCode).toBe(400)
    expect(tooMany.json().error.details.overLimit).toEqual([{ domain: 'ridgecrestbuildinc.example', count: 11 }])

    expect(storedAliases(project.id)).toEqual({ 'ridgecrest.example': [], 'ridgecrestbuildinc.example': [] })
    expect(audits(project.id, 'competitors.aliases-updated')).toHaveLength(0)
    expect(competitorAliasHooks).toEqual([])
  })
})

describe('competitor add and replace keep aliases', () => {
  it('POST accepts { domain, aliases } entries and adds aliases to a tracked domain', async () => {
    const project = await createProject()
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/roofwise/competitors',
      payload: { competitors: [{ domain: 'www.sealfoamworks.example', aliases: ['FoamSeal'] }, 'qvx.example'] },
    })
    expect(added.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'sealfoamworks.example': ['FoamSeal'], 'qvx.example': [] })
    expect(JSON.parse(audits(project.id, 'competitors.appended')[0]!.diff!)).toEqual({
      added: ['sealfoamworks.example', 'qvx.example'],
      aliasChanges: [{ domain: 'sealfoamworks.example', before: [], after: ['FoamSeal'] }],
    })

    // Already tracked: aliases are added; a bare domain changes nothing.
    await app.inject({
      method: 'POST',
      url: '/api/v1/projects/roofwise/competitors',
      payload: { competitors: [{ domain: 'sealfoamworks.example', aliases: ['Foam Seal Crew'] }, 'qvx.example'] },
    })
    expect(storedAliases(project.id)).toEqual({ 'sealfoamworks.example': ['FoamSeal', 'Foam Seal Crew'], 'qvx.example': [] })

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/roofwise/competitors',
      payload: { competitors: [{ domain: 'ridgecrest.example', aliases: ['Roofwise'] }] },
    })
    expect(rejected.statusCode).toBe(400)
    expect(storedAliases(project.id)).toEqual({ 'sealfoamworks.example': ['FoamSeal', 'Foam Seal Crew'], 'qvx.example': [] })
  })

  it('PUT replace keeps the row and aliases of a domain that stays', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: [{ domain: 'qvx.example', aliases: ['QVX'] }, 'ridgecrest.example'] } })
    const before = db.select().from(competitors).where(eq(competitors.domain, 'qvx.example')).get()!

    const replaced = await app.inject({ method: 'PUT', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['qvx.example', 'sealfoamworks.example'] } })
    expect(replaced.statusCode).toBe(200)
    expect(Object.fromEntries(replaced.json().map((c: { domain: string; aliases: string[] }) => [c.domain, c.aliases]))).toEqual({
      'qvx.example': ['QVX'],
      'sealfoamworks.example': [],
    })
    expect(db.select().from(competitors).where(eq(competitors.domain, 'qvx.example')).get()!.id).toBe(before.id)
    expect(JSON.parse(audits(project.id, 'competitors.replaced')[0]!.diff!)).toEqual({ competitors: ['qvx.example', 'sealfoamworks.example'] })
    expect(competitorAliasHooks).toEqual(['roofwise'])
  })
})

describe('config-as-code competitor aliases', () => {
  function spec(competitorsSpec: unknown[], extra: Record<string, unknown> = {}) {
    return {
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'roofwise' },
      spec: { ...PROJECT, competitors: competitorsSpec, ...extra },
    }
  }
  const apply = (body: unknown) => app.inject({ method: 'POST', url: '/api/v1/apply', payload: body })

  it('sets aliases from object entries, preserves them for string entries, clears with []', async () => {
    expect((await apply(spec([{ domain: 'qvx.example', aliases: ['QVX'] }, 'sealfoamworks.example']))).statusCode).toBe(200)
    const project = db.select().from(projects).where(eq(projects.name, 'roofwise')).get()!
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'sealfoamworks.example': [] })
    // New project: nothing historical to backfill.
    expect(competitorAliasHooks).toEqual([])

    // A REST alias write, then a domains-only apply: the string entry has no opinion.
    await setAliases('sealfoamworks.example', ['FoamSeal'])
    competitorAliasHooks.length = 0
    expect((await apply(spec(['qvx.example', 'sealfoamworks.example']))).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'sealfoamworks.example': ['FoamSeal'] })
    expect(competitorAliasHooks).toEqual([])

    // An object entry is exact; [] clears.
    expect((await apply(spec([{ domain: 'qvx.example', aliases: [] }, { domain: 'sealfoamworks.example', aliases: ['Foam Seal'] }]))).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [], 'sealfoamworks.example': ['Foam Seal'] })
    expect(competitorAliasHooks).toEqual(['roofwise'])
    const replacedDiff = JSON.parse(audits(project.id, 'competitors.replaced').at(-1)!.diff!)
    expect(replacedDiff).toEqual({
      competitors: ['qvx.example', 'sealfoamworks.example'],
      aliasChanges: [
        { domain: 'qvx.example', before: ['QVX'], after: [] },
        { domain: 'sealfoamworks.example', before: ['FoamSeal'], after: ['Foam Seal'] },
      ],
    })
  })

  it('is idempotent and round-trips through export', async () => {
    await apply(spec([{ domain: 'qvx.example', aliases: ['QVX'] }, 'ridgecrest.example']))
    competitorAliasHooks.length = 0
    const exported = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/export' })).json()
    expect(exported.spec.competitors).toEqual([{ domain: 'qvx.example', aliases: ['QVX'] }, 'ridgecrest.example'])

    const project = db.select().from(projects).where(eq(projects.name, 'roofwise')).get()!
    const ids = db.select({ id: competitors.id }).from(competitors).where(eq(competitors.projectId, project.id)).all()
    expect((await apply(exported)).statusCode).toBe(200)
    expect((await apply(exported)).statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': ['QVX'], 'ridgecrest.example': [] })
    expect(db.select({ id: competitors.id }).from(competitors).where(eq(competitors.projectId, project.id)).all()).toEqual(ids)
    expect(competitorAliasHooks).toEqual([])
  })

  it('rejects an invalid stated alias before writing anything', async () => {
    await apply(spec(['qvx.example']))
    const project = db.select().from(projects).where(eq(projects.name, 'roofwise')).get()!
    const res = await apply(spec([{ domain: 'qvx.example', aliases: ['Roofwise'] }, 'ridgecrest.example']))
    expect(res.statusCode).toBe(400)
    expect(res.json().error.details.rejectedAliases).toEqual([{ domain: 'qvx.example', alias: 'Roofwise', reason: 'project-brand' }])
    expect(storedAliases(project.id)).toEqual({ 'qvx.example': [] })
  })

  it('drops a preserved alias the spec\'s project identity now claims', async () => {
    await apply(spec([{ domain: 'sealfoamworks.example', aliases: ['FoamSeal', 'Seal Foam Pros'] }]))
    const project = db.select().from(projects).where(eq(projects.name, 'roofwise')).get()!
    const res = await apply(spec(['sealfoamworks.example'], { aliases: ['Roofwise Pros', 'FoamSeal'] }))
    expect(res.statusCode).toBe(200)
    expect(storedAliases(project.id)).toEqual({ 'sealfoamworks.example': ['Seal Foam Pros'] })
    const diff = JSON.parse(audits(project.id, 'competitors.replaced').at(-1)!.diff!)
    expect(diff.droppedCompetitorAliases).toEqual([{ domain: 'sealfoamworks.example', alias: 'FoamSeal', reason: 'project-brand' }])
  })
})

describe('project identity changes', () => {
  it('drops a competitor alias the project now claims, so the qualified alias is accepted', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: [{ domain: 'sealfoamworks.example', aliases: ['FoamSeal', 'Seal Foam Pros'] }] } })

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/roofwise',
      payload: { ...PROJECT, aliases: ['Roofwise Pros', 'Foam Seal'], qualifiedAliases: ['Foam Seal'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().qualifiedAliases).toEqual(['Foam Seal'])
    expect(storedAliases(project.id)).toEqual({ 'sealfoamworks.example': ['Seal Foam Pros'] })
    const updated = audits(project.id, 'project.updated').at(-1)!
    expect(JSON.parse(updated.diff!)).toEqual({
      droppedCompetitorAliases: [{ domain: 'sealfoamworks.example', alias: 'FoamSeal', reason: 'project-brand' }],
    })
    expect(projectAliasHooks).toEqual(['roofwise'])
  })

  it('counts a competitor alias as a competitor name for qualified aliases', async () => {
    await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: [{ domain: 'sealfoamworks.example', aliases: ['Coastline Crew'] }] } })
    // The competitor alias stays (the project does not claim it), and the
    // qualified-alias check treats it as a competitor name.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/roofwise',
      payload: { ...PROJECT, aliases: ['Roofwise Pros'], qualifiedAliases: ['Roofwise Pros'] },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('read-time matchers use stored aliases', () => {
  function seedSweep(projectId: string) {
    const queryId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    db.insert(queries).values({ id: queryId, projectId, query: 'best roof coating contractor', createdAt: '2026-10-01T00:00:00.000Z' }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: '2026-10-01T01:00:00.000Z', finishedAt: '2026-10-01T01:05:00.000Z' }).run()
    const answers = [
      'Roofwise is a solid pick for coatings.',
      'Roofwise and FoamSeal both quote quickly.',
      'FoamSeal is the usual recommendation.',
      'Ridgecrest Roofing handles commercial work.',
      'QVX does silicone coatings.',
    ]
    const providers = ['openai', 'gemini', 'claude', 'perplexity', 'local']
    answers.forEach((answerText, i) => {
      db.insert(querySnapshots).values({
        id: `snap-${i}`,
        runId,
        queryId,
        provider: providers[i]!,
        citationState: 'not-cited',
        answerMentioned: answerText.startsWith('Roofwise'),
        answerText,
        citedDomains: [],
        competitorOverlap: [],
        recommendedCompetitors: [],
        createdAt: '2026-10-01T01:01:00.000Z',
      }).run()
    })
    return { runId }
  }

  it('reinterprets stored answers on every read surface once aliases are set', async () => {
    const project = await createProject()
    await app.inject({ method: 'POST', url: '/api/v1/projects/roofwise/competitors', payload: { competitors: ['sealfoamworks.example', 'ridgecrestbuildinc.example', 'qvx.example'] } })
    const { runId } = seedSweep(project.id)

    // Domains only: no answer names a domain label, so no competitor is mentioned.
    const before = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/overview' })).json()
    expect(before.scores.mentionShare.breakdown).toMatchObject({ projectMentionSnapshots: 2, competitorMentionSnapshots: 0 })
    expect(before.scores.mentionShare.breakdown.score).toBe(100)

    await setAliases('sealfoamworks.example', ['FoamSeal'])
    await setAliases('ridgecrestbuildinc.example', ['Ridgecrest Roofing'])
    await setAliases('qvx.example', ['QVX'])

    const overview = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/overview' })).json()
    const breakdown = overview.scores.mentionShare.breakdown
    expect(breakdown).toMatchObject({ projectMentionSnapshots: 2, competitorMentionSnapshots: 4, combinedMentionSnapshots: 6 })
    expect(breakdown.score).toBe(percentOf(2, 6))
    expect(formatPercent(breakdown.score, 'percent')).toBe('33.3%')
    expect(Object.fromEntries(overview.competitors.map((c: { domain: string; aliases?: string[] }) => [c.domain, c.aliases]))).toEqual({
      'sealfoamworks.example': ['FoamSeal'],
      'ridgecrestbuildinc.example': ['Ridgecrest Roofing'],
      'qvx.example': ['QVX'],
    })

    const detail = (await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })).json()
    const mentioned = Object.fromEntries(detail.snapshots.map((s: { id: string; mentionedCompetitorDomains: string[] }) => [s.id, s.mentionedCompetitorDomains]))
    expect(mentioned).toEqual({
      'snap-0': [],
      'snap-1': ['sealfoamworks.example'],
      'snap-2': ['sealfoamworks.example'],
      'snap-3': ['ridgecrestbuildinc.example'],
      'snap-4': ['qvx.example'],
    })

    const gaps = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/analytics/gaps' })).json()
    const entry = [...gaps.mentionedQueries, ...gaps.mentionGap, ...gaps.notMentioned][0]
    expect([...entry.competitorsMentioned].sort()).toEqual(['qvx.example', 'ridgecrestbuildinc.example', 'sealfoamworks.example'])

    const landscape = (await app.inject({ method: 'GET', url: '/api/v1/projects/roofwise/analytics/competitors?queryClass=non-brand' })).json()
    const mentionsByDomain = Object.fromEntries(landscape.pinned
      .map((row: { domain: string; mentionCount: number }) => [row.domain, row.mentionCount]))
    expect(mentionsByDomain).toEqual({ 'sealfoamworks.example': 2, 'ridgecrestbuildinc.example': 1, 'qvx.example': 1 })
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

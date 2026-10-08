import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, competitors, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

// `competitorAutoAliases` decides what answer-derived competitor alias
// detection does after a sweep or a competitor write: `off`, `preview` (the
// default: log only) or `apply`. Every write path keeps the stored mode when
// the field is omitted, the same rule as the other saved project settings.
//
// `competitorIdentityChangedAt` tells a reader of the landscape, the
// month-over-month comparison and the analytics metrics when the competitor
// names those numbers are read with last changed, so a period quoted before
// it is known to be restated.

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-auto-alias-mode-'))
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
  displayName: 'Rotorwise',
  canonicalDomain: 'rotorwise.example',
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

function storedMode(name: string): string | undefined {
  return db.select({ mode: projects.competitorAutoAliases }).from(projects).where(eq(projects.name, name)).get()?.mode
}

describe('project competitorAutoAliases mode', () => {
  it('starts every new project in preview, on every create path', async () => {
    expect((await create('posted')).json().competitorAutoAliases).toBe('preview')
    expect((await put('upserted')).json().competitorAutoAliases).toBe('preview')
    expect((await apply('applied')).statusCode).toBe(200)
    expect(storedMode('posted')).toBe('preview')
    expect(storedMode('upserted')).toBe('preview')
    expect(storedMode('applied')).toBe('preview')

    expect((await create('opted-in', { competitorAutoAliases: 'apply' })).json().competitorAutoAliases).toBe('apply')
    expect(storedMode('opted-in')).toBe('apply')
  })

  it('PUT sets the mode, keeps it when omitted, audits the change and rejects an unknown mode', async () => {
    expect((await put('rotorwise')).statusCode).toBe(201)

    const set = await put('rotorwise', { competitorAutoAliases: 'apply' })
    expect(set.statusCode).toBe(200)
    expect(set.json().competitorAutoAliases).toBe('apply')

    // The dashboard and the CLI resend the project without the field.
    const echoed = await put('rotorwise', { displayName: 'Rotorwise Bikes' })
    expect(echoed.statusCode).toBe(200)
    expect(echoed.json().competitorAutoAliases).toBe('apply')
    expect(storedMode('rotorwise')).toBe('apply')

    const off = await put('rotorwise', { competitorAutoAliases: 'off' })
    expect(off.json().competitorAutoAliases).toBe('off')

    const rejected = await put('rotorwise', { competitorAutoAliases: 'sometimes' })
    expect(rejected.statusCode).toBe(400)
    expect(storedMode('rotorwise')).toBe('off')

    const diffs = db.select({ diff: auditLog.diff }).from(auditLog)
      .where(eq(auditLog.action, 'project.updated'))
      .all()
      .map(row => (row.diff ? JSON.parse(row.diff) : null))
      .filter(diff => diff?.competitorAutoAliases)
      .map(diff => diff.competitorAutoAliases)
    expect(diffs).toEqual([
      { before: 'preview', after: 'apply' },
      { before: 'apply', after: 'off' },
    ])

    const shown = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise' })
    expect(shown.json().competitorAutoAliases).toBe('off')
    // The overview's project carries the mode too: absent means a server
    // that predates the setting.
    const overview = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/overview' })
    expect(overview.statusCode, overview.body).toBe(200)
    expect(overview.json().project.competitorAutoAliases).toBe('off')
  })

  it('apply sets the mode, keeps it when the spec omits it, and export round-trips a non-default mode', async () => {
    expect((await apply('rotorwise', { competitorAutoAliases: 'apply' })).statusCode).toBe(200)
    expect(storedMode('rotorwise')).toBe('apply')

    expect((await apply('rotorwise')).statusCode).toBe(200)
    expect(storedMode('rotorwise')).toBe('apply')

    const exported = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/export' })
    expect(exported.statusCode).toBe(200)
    expect(exported.json().spec.competitorAutoAliases).toBe('apply')

    expect((await apply('rotorwise', { competitorAutoAliases: 'preview' })).statusCode).toBe(200)
    expect(storedMode('rotorwise')).toBe('preview')
    const applied = db.select({ diff: auditLog.diff }).from(auditLog)
      .where(eq(auditLog.action, 'project.applied'))
      .orderBy(desc(auditLog.createdAt))
      .all()
      .map(row => (row.diff ? JSON.parse(row.diff).competitorAutoAliases : undefined))
      .filter(Boolean)
    expect(applied).toEqual([{ before: 'apply', after: 'preview' }])

    // The default stays out of the export, so a preview project's export is unchanged.
    const defaultExport = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/export' })
    expect('competitorAutoAliases' in defaultExport.json().spec).toBe(false)
  })
})

describe('competitorIdentityChangedAt', () => {
  async function readers(): Promise<Array<string | null>> {
    const landscape = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/competitors' })
    expect(landscape.statusCode, landscape.body).toBe(200)
    const compare = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/visibility-compare?from=2026-08&to=2026-09' })
    expect(compare.statusCode, compare.body).toBe(200)
    const metrics = await app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/analytics/metrics' })
    expect(metrics.statusCode, metrics.body).toBe(200)
    return [landscape.json().competitorIdentityChangedAt, compare.json().competitorIdentityChangedAt, metrics.json().competitorIdentityChangedAt]
  }

  function latestAudit(action: string): string {
    return db.select({ at: auditLog.createdAt }).from(auditLog)
      .where(eq(auditLog.action, action))
      .orderBy(desc(auditLog.createdAt))
      .get()!.at
  }

  it('is null until a competitor name changes, then the time of the newest names change', async () => {
    expect((await put('rotorwise')).statusCode).toBe(201)
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)
    // Adding a competitor changes the set, not any competitor's names.
    expect(await readers()).toEqual([null, null, null])

    const curated = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases',
      payload: { aliases: ['TuneSpoke'] },
    })
    expect(curated.statusCode, curated.body).toBe(200)
    const curatedAt = latestAudit('competitors.aliases-updated')
    expect(await readers()).toEqual([curatedAt, curatedAt, curatedAt])

    // Blocking a name that was never applied changes no stored name.
    const blockedOnly = await app.inject({
      method: 'POST', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases/block',
      payload: { aliases: ['Spoke Crew'] },
    })
    expect(blockedOnly.statusCode, blockedOnly.body).toBe(200)
    const unblocked = await app.inject({
      method: 'POST', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases/unblock',
      payload: { aliases: ['Spoke Crew'] },
    })
    expect(unblocked.statusCode, unblocked.body).toBe(200)
    expect(await readers()).toEqual([curatedAt, curatedAt, curatedAt])

    // Blocking a stored auto name removes it: a names change.
    db.update(competitors).set({
      autoAliases: [{
        name: 'Spoke Works Co', directPairs: 3, cooccurrences: 0, namingAnswers: 3, precision: 1, runs: 2,
        firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-15T00:00:00.000Z', addedAt: '2026-09-15T00:00:00.000Z',
      }],
    }).where(eq(competitors.domain, 'spoketuneworks.example')).run()
    const blocked = await app.inject({
      method: 'POST', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases/block',
      payload: { aliases: ['Spoke Works Co'] },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    const blockedAt = db.select({ at: auditLog.createdAt, diff: auditLog.diff }).from(auditLog)
      .where(eq(auditLog.action, 'competitors.aliases-blocked'))
      .all()
      .find(row => JSON.parse(row.diff!).removedAutoAliases)!.at
    expect(await readers()).toEqual([blockedAt, blockedAt, blockedAt])

    // A project identity that claims a competitor's curated alias drops it.
    const claimed = await put('rotorwise', { aliases: ['TuneSpoke'] })
    expect(claimed.statusCode, claimed.body).toBe(200)
    const projectId = db.select({ id: projects.id }).from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    const droppedAt = db.select({ at: auditLog.createdAt }).from(auditLog)
      .where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, 'project.updated')))
      .orderBy(desc(auditLog.createdAt))
      .get()!.at
    expect(await readers()).toEqual([droppedAt, droppedAt, droppedAt])

    // A mode change or an unrelated project edit is not a names change.
    expect((await put('rotorwise', { aliases: ['TuneSpoke'], competitorAutoAliases: 'apply' })).statusCode).toBe(200)
    expect(await readers()).toEqual([droppedAt, droppedAt, droppedAt])
  })

  it('reads an answer-derived names change and ignores another project\'s changes', async () => {
    expect((await put('rotorwise')).statusCode).toBe(201)
    expect((await put('other')).statusCode).toBe(201)
    const ids = Object.fromEntries(db.select({ id: projects.id, name: projects.name }).from(projects).all().map(row => [row.name, row.id]))
    db.insert(auditLog).values([
      {
        id: 'auto-1', projectId: ids.rotorwise!, actor: 'system', action: 'competitors.auto-aliases-updated', entityType: 'competitor',
        diff: JSON.stringify({ changes: [{ domain: 'spoketuneworks.example', added: ['TuneSpoke'], removed: [] }] }), createdAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: 'auto-2', projectId: ids.other!, actor: 'system', action: 'competitors.auto-aliases-updated', entityType: 'competitor',
        diff: JSON.stringify({ changes: [] }), createdAt: '2026-09-25T00:00:00.000Z',
      },
      // A market pin write that dropped an auto name carries the shared field.
      {
        id: 'pin-1', projectId: ids.rotorwise!, actor: 'api', action: 'measurement-draft.pin-competitor', entityType: 'measurement-draft',
        diff: JSON.stringify({ groupKey: 'west', autoAliasChanges: [{ domain: 'spoketuneworks.example', before: ['TuneSpoke'], after: [] }] }), createdAt: '2026-09-22T00:00:00.000Z',
      },
      // Not JSON: never a names change, and never an error.
      { id: 'raw-1', projectId: ids.rotorwise!, actor: 'api', action: 'project.updated', entityType: 'project', diff: 'not json', createdAt: '2026-09-28T00:00:00.000Z' },
    ]).run()
    expect(await readers()).toEqual(['2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z'])
  })
})

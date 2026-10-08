import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'

// The server's unattended competitor auto-alias passes (after a sweep, a
// competitor add, an unblock, a pin write) follow the project's
// `competitorAutoAliases` mode: `off` runs none, `preview` (the default)
// stores nothing, `apply` stores the names. An explicit apply-now stores in
// every mode. The recompute a names change triggers is marked on the project
// (`answer_fields_recompute`) until it finishes, and boot resumes a marked one.

function claudeEnvelope(): string {
  return JSON.stringify({
    model: 'claude-test',
    groundingSources: [{ uri: 'https://spoketuneworks.example/services', title: 'Services' }],
    searchQueries: ['bike tune-ups'],
    apiResponse: {
      content: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'bike tune-ups' } },
        { type: 'web_search_tool_result', content: [] },
        { type: 'text', text: 'Options:\n- **TuneSpoke** - ' },
        { type: 'text', text: 'Mobile tune-ups on the east side.', citations: [{ type: 'web_search_result_location', url: 'https://spoketuneworks.example/services', title: 'Services', cited_text: 'c', encrypted_index: 'e' }] },
      ],
    },
  })
}

const PAIRED_TEXT = 'Options:\n- **TuneSpoke** - Mobile tune-ups on the east side.'
const OTHER_TEXT = 'Check your tire pressure before every ride.'

/** Three sweeps, each pairing "TuneSpoke" with its site once, plus two answers naming no competitor. */
function seedAnswers(db: DatabaseClient, projectId: string): void {
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: 'best bike tune-up', createdAt: '2026-09-01T00:00:00.000Z' }).run()
  for (const day of ['01', '08', '15']) {
    const runId = crypto.randomUUID()
    const at = `2026-09-${day}T00:00:00.000Z`
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, queryId, provider: 'claude', citationState: 'not-cited', answerMentioned: false,
      answerText: PAIRED_TEXT, citedDomains: ['spoketuneworks.example'], competitorOverlap: [], recommendedCompetitors: [],
      rawResponse: claudeEnvelope(), createdAt: at,
    }).run()
    for (let other = 0; other < 2; other++) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider: 'claude', citationState: 'not-cited', answerMentioned: false,
        answerText: OTHER_TEXT, citedDomains: ['ridersguide.example'], competitorOverlap: [], recommendedCompetitors: [],
        rawResponse: null, createdAt: at,
      }).run()
    }
  }
}

interface Booted {
  db: DatabaseClient
  app: Awaited<ReturnType<typeof createServer>>
  auth: { authorization: string }
  close: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A fresh install, or a server started over the database `seed` prepares first (a restart). */
async function boot(seed?: (db: DatabaseClient) => void): Promise<Booted> {
  const tmpDir = path.join(os.tmpdir(), `canonry-auto-alias-mode-${crypto.randomUUID()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const origConfigDir = process.env.CANONRY_CONFIG_DIR
  const origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
  process.env.CANONRY_CONFIG_DIR = tmpDir
  process.env.CANONRY_TELEMETRY_DISABLED = '1'
  const dbPath = path.join(tmpDir, 'data.db')
  const db = createClient(dbPath)
  migrate(db)
  seed?.(db)
  const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
    keyPrefix: apiKeyPlain.slice(0, 8),
    createdAt: new Date().toISOString(),
  }).run()
  const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
  fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')
  const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
  await app.ready()
  let closed = false
  // Closing waits for every queued detection and recompute pass.
  const close = async () => {
    if (closed) return
    closed = true
    await app.close()
  }
  cleanups.push(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  return { db, app, auth: { authorization: `Bearer ${apiKeyPlain}` }, close }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the deferred pass')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function createProject(booted: Booted, extras: Record<string, unknown> = {}): Promise<string> {
  const created = await booted.app.inject({
    method: 'PUT', url: '/api/v1/projects/rotorwise', headers: booted.auth,
    payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', ...extras },
  })
  expect(created.statusCode, created.body).toBe(201)
  return booted.db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
}

const storedNames = (db: DatabaseClient, projectId: string) =>
  db.select().from(competitors).where(eq(competitors.projectId, projectId)).all().flatMap(row => row.autoAliases.map(record => record.name))
const autoAudits = (db: DatabaseClient, projectId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, 'competitors.auto-aliases-updated'))).all()

describe('competitor auto-alias mode on the server', () => {
  it('preview (the default) stores nothing after a competitor add, while the dry run still shows the evidence', async () => {
    const booted = await boot()
    const projectId = await createProject(booted)
    seedAnswers(booted.db, projectId)

    const added = await booted.app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: booted.auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)

    const dryRun = await booted.app.inject({ method: 'GET', url: '/api/v1/projects/rotorwise/competitor-auto-aliases', headers: booted.auth })
    expect(dryRun.statusCode, dryRun.body).toBe(200)
    expect(dryRun.json()).toMatchObject({ applied: false, competitors: [{ domain: 'spoketuneworks.example', added: ['TuneSpoke'] }] })

    await booted.close()
    expect(storedNames(booted.db, projectId)).toEqual([])
    expect(autoAudits(booted.db, projectId)).toEqual([])
    expect(booted.db.select().from(querySnapshots).all().every(row => row.recommendedCompetitors.length === 0)).toBe(true)
  })

  it('off runs no pass, and an explicit apply-now still stores the names', async () => {
    const booted = await boot()
    const projectId = await createProject(booted, { competitorAutoAliases: 'off' })
    seedAnswers(booted.db, projectId)

    const added = await booted.app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: booted.auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(storedNames(booted.db, projectId)).toEqual([])

    const applied = await booted.app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitor-auto-aliases', headers: booted.auth })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json()).toMatchObject({ applied: true, changed: true })
    expect(storedNames(booted.db, projectId)).toEqual(['TuneSpoke'])
    expect(booted.db.select({ mode: projects.competitorAutoAliases }).from(projects).where(eq(projects.id, projectId)).get())
      .toEqual({ mode: 'off' })
  })

  it('apply stores the names an unattended pass detects, once the project opts in', async () => {
    const booted = await boot()
    const projectId = await createProject(booted)
    seedAnswers(booted.db, projectId)
    const optedIn = await booted.app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise', headers: booted.auth,
      payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', competitorAutoAliases: 'apply' },
    })
    expect(optedIn.statusCode, optedIn.body).toBe(200)

    const added = await booted.app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: booted.auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)
    await waitFor(() => storedNames(booted.db, projectId).length > 0)
    expect(storedNames(booted.db, projectId)).toEqual(['TuneSpoke'])
    expect(autoAudits(booted.db, projectId)).toHaveLength(1)
  })
})

describe('owed answer-field recompute', () => {
  const owed = (db: DatabaseClient, projectId: string) =>
    db.select({ owed: projects.answerFieldsRecompute }).from(projects).where(eq(projects.id, projectId)).get()!.owed
  const overlaps = (db: DatabaseClient) =>
    db.select().from(querySnapshots).all().filter(row => row.answerText === PAIRED_TEXT).map(row => row.competitorOverlap)

  it('marks the project when a names change asks for a recompute, and clears it once the recompute finishes', async () => {
    const booted = await boot()
    const projectId = await createProject(booted)
    seedAnswers(booted.db, projectId)
    // Stored fields from before the competitor existed.
    booted.db.insert(competitors).values({ id: 'spoke', projectId, domain: 'spoketuneworks.example', provenance: 'cli', createdAt: '2026-09-01T00:00:00.000Z' }).run()

    const edited = await booted.app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', headers: booted.auth,
      payload: { aliases: ['TuneSpoke'] },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    // The recompute runs on a later tick; the mark is written first.
    expect(owed(booted.db, projectId)).toBe('competitors')

    await waitFor(() => owed(booted.db, projectId) === null)
    expect(overlaps(booted.db)).toEqual([['spoketuneworks.example'], ['spoketuneworks.example'], ['spoketuneworks.example']])
  })

  it('resumes a recompute a restart cut short', async () => {
    let projectId = ''
    const booted = await boot((db) => {
      projectId = crypto.randomUUID()
      const now = '2026-09-01T00:00:00.000Z'
      db.insert(projects).values({
        id: projectId, name: 'rotorwise', displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example',
        country: 'US', language: 'en', createdAt: now, updatedAt: now,
        // The names changed and the process died before the recompute finished.
        answerFieldsRecompute: 'competitors',
      }).run()
      db.insert(competitors).values({ id: 'spoke', projectId, domain: 'spoketuneworks.example', provenance: 'cli', aliases: ['TuneSpoke'], createdAt: now }).run()
      seedAnswers(db, projectId)
    })

    await waitFor(() => owed(booted.db, projectId) === null)
    expect(overlaps(booted.db)).toEqual([['spoketuneworks.example'], ['spoketuneworks.example'], ['spoketuneworks.example']])
  })

  it('keeps the wider scope when a project alias change and a competitor names change are both owed', async () => {
    let projectId = ''
    const booted = await boot((db) => {
      projectId = crypto.randomUUID()
      const now = '2026-09-01T00:00:00.000Z'
      db.insert(projects).values({
        id: projectId, name: 'rotorwise', displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example',
        aliases: ['TuneSpoke'], country: 'US', language: 'en', createdAt: now, updatedAt: now,
        answerFieldsRecompute: 'full',
      }).run()
      seedAnswers(db, projectId)
    })

    // The project's own alias now matches the stored answers: only a full pass rescores `answer_mentioned`.
    await waitFor(() => owed(booted.db, projectId) === null)
    expect(booted.db.select().from(querySnapshots).all()
      .filter(row => row.answerText === PAIRED_TEXT)
      .map(row => row.answerMentioned)).toEqual([true, true, true])
  })
})

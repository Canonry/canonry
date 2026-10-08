import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { apiKeys, auditLog, competitors, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { createCompetitorAutoAliasRunner } from '../src/competitor-auto-alias-runner.js'
import { extractStoredAnswerAnchors } from '../src/stored-answer-anchors.js'
import { createServer } from '../src/server.js'

// Answer-derived competitor aliases off the run-completion path: the runner the
// server uses for an apply-now request and, for a project in `apply` mode,
// after every sweep and competitor add, over fictional stored answers in the
// Gemini and Claude response shapes.

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC'

function geminiEnvelope(): string {
  const segment = '* **TuneSpoke:** mobile tune-ups on the east side'
  return JSON.stringify({
    model: 'gemini-test',
    groundingSources: [{ uri: REDIRECT, title: 'spoketuneworks.example' }],
    searchQueries: ['bike tune-ups'],
    apiResponse: {
      candidates: [{
        content: { parts: [{ text: `Options:\n${segment}\n` }] },
        groundingMetadata: {
          webSearchQueries: ['bike tune-ups'],
          groundingChunks: [{ web: { uri: REDIRECT, title: 'spoketuneworks.example' } }],
          groundingSupports: [{ segment: { startIndex: 9, endIndex: 9 + segment.length, text: segment }, groundingChunkIndices: [0] }],
        },
      }],
    },
  })
}

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

const OTHER_TEXT = 'Check your tire pressure before every ride.'

/**
 * Three sweeps, each storing one answer that pairs "TuneSpoke" with its site
 * and two answers that name and cite no tracked competitor (the contrast a
 * lift needs).
 */
function seedAnswers(db: DatabaseClient, projectId: string, provider: 'gemini' | 'claude'): void {
  const queryId = crypto.randomUUID()
  db.insert(queries).values({ id: queryId, projectId, query: 'best bike tune-up', createdAt: '2026-09-01T00:00:00.000Z' }).run()
  const text = provider === 'gemini'
    ? 'Options:\n* **TuneSpoke:** mobile tune-ups on the east side\n'
    : 'Options:\n- **TuneSpoke** - Mobile tune-ups on the east side.'
  for (const day of ['01', '08', '15']) {
    const runId = crypto.randomUUID()
    const at = `2026-09-${day}T00:00:00.000Z`
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'scheduled', createdAt: at, finishedAt: at }).run()
    db.insert(querySnapshots).values({
      id: crypto.randomUUID(), runId, queryId, provider, citationState: 'not-cited', answerMentioned: false,
      answerText: text, citedDomains: ['spoketuneworks.example'], competitorOverlap: [], recommendedCompetitors: [],
      rawResponse: provider === 'gemini' ? geminiEnvelope() : claudeEnvelope(), createdAt: at,
    }).run()
    for (let other = 0; other < 2; other++) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider, citationState: 'not-cited', answerMentioned: false,
        answerText: OTHER_TEXT, citedDomains: ['ridersguide.example'], competitorOverlap: [], recommendedCompetitors: [],
        rawResponse: null, createdAt: at,
      }).run()
    }
  }
}

describe('createCompetitorAutoAliasRunner', () => {
  function seededDb() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-auto-alias-runner-'))
    const db = createClient(path.join(tmpDir, 'test.db'))
    onTestFinished(() => {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
    migrate(db)
    const projectId = crypto.randomUUID()
    const now = '2026-09-01T00:00:00.000Z'
    db.insert(projects).values({ id: projectId, name: 'rotorwise', displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    db.insert(competitors).values({ id: 'spoke', projectId, domain: 'spoketuneworks.example', provenance: 'cli', createdAt: now }).run()
    seedAnswers(db, projectId, 'gemini')
    return { db, projectId }
  }

  const autoNames = (db: DatabaseClient) =>
    db.select({ autoAliases: competitors.autoAliases }).from(competitors).where(eq(competitors.id, 'spoke')).get()!.autoAliases.map(record => record.name)
  const auditRows = (db: DatabaseClient, projectId: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, 'competitors.auto-aliases-updated'))).all()

  it('applies answer-derived names once, audits them as the system, and is idempotent', async () => {
    const { db, projectId } = seededDb()
    const changed: string[] = []
    const runner = createCompetitorAutoAliasRunner({ db, readAnchors: extractStoredAnswerAnchors, onNamesChanged: (id, name) => { changed.push(`${id}:${name}`) } })

    // A sweep and its fill completing together coalesce into one more pass.
    runner.schedule(projectId, 'run:a')
    runner.schedule(projectId, 'run:b')
    runner.schedule(projectId, 'run:c')
    await runner.settled()

    expect(autoNames(db)).toEqual(['TuneSpoke'])
    expect(changed).toEqual([`${projectId}:rotorwise`])
    const audits = auditRows(db, projectId)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBe('system')
    expect(JSON.parse(audits[0]!.diff!)).toMatchObject({
      changes: [{ domain: 'spoketuneworks.example', added: ['TuneSpoke'], removed: [] }],
      scan: { runs: 3, snapshots: 9 },
    })

    runner.schedule(projectId, 'run:d')
    await runner.settled()
    expect(changed).toHaveLength(1)
    expect(auditRows(db, projectId)).toHaveLength(1)
  })

  it('counts only answer-text pairings without a provider reader, and isolates a failing pass', async () => {
    const { db, projectId } = seededDb()
    const quiet = createCompetitorAutoAliasRunner({ db, onNamesChanged: () => { throw new Error('unreachable') } })
    quiet.schedule(projectId, 'run:a')
    await quiet.settled()
    // The Gemini answers pair the name only through grounding supports.
    expect(autoNames(db)).toEqual([])

    const failing = createCompetitorAutoAliasRunner({ db, readAnchors: () => { throw new Error('unreadable row') }, onNamesChanged: () => {} })
    failing.schedule(projectId, 'run:b')
    await expect(failing.settled()).resolves.toBeUndefined()
    expect(autoNames(db)).toEqual([])
    // An apply-now request through the same queue gets the failure back.
    await expect(failing.request(projectId, 'api')).rejects.toThrow('unreadable row')
  })

  it('serves an apply-now request from a pass that starts after it, never beside a scheduled one', async () => {
    const { db, projectId } = seededDb()
    const changed: string[] = []
    const runner = createCompetitorAutoAliasRunner({ db, readAnchors: extractStoredAnswerAnchors, onNamesChanged: (_id, name) => { changed.push(name) } })
    runner.schedule(projectId, 'run:a')
    const applied = await runner.request(projectId, 'api')
    // The scheduled pass applied the name; the request's own pass found it stored.
    expect(applied).toMatchObject({ namesChanged: false })
    expect(applied!.detection.competitors[0]!.candidates[0]).toMatchObject({ name: 'TuneSpoke', status: 'kept' })
    expect(autoNames(db)).toEqual(['TuneSpoke'])
    expect(changed).toEqual(['rotorwise'])
    expect(auditRows(db, projectId)).toHaveLength(1)
  })
})

describe('server wiring', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let auth: { authorization: string }
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-auto-alias-server-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'
    const dbPath = path.join(tmpDir, 'data.db')
    db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()
    auth = { authorization: `Bearer ${apiKeyPlain}` }
    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')
    app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the deferred detection')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('scans stored history when a competitor is added, then recomputes the stored competitor fields', async () => {
    // Unattended passes store names only for a project opted into `apply`.
    const created = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
      payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', competitorAutoAliases: 'apply' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    seedAnswers(db, projectId, 'claude')

    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)

    const stored = () => db.select().from(competitors).where(eq(competitors.projectId, projectId)).get()!
    await waitFor(() => stored().autoAliases.length > 0)
    expect(stored().autoAliases.map(record => record.name)).toEqual(['TuneSpoke'])

    // The recompute the names change triggers credits the stored answers.
    const snapshots = () => db.select().from(querySnapshots).all().filter(row => row.answerText !== OTHER_TEXT)
    await waitFor(() => snapshots().every(row => row.recommendedCompetitors.length > 0))
    expect(snapshots().map(row => row.recommendedCompetitors)).toEqual([['TuneSpoke'], ['TuneSpoke'], ['TuneSpoke']])
  })

  it('applies now through the server\'s own queue and refreshes the stored competitor fields', async () => {
    const created = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
      payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    db.insert(competitors).values({ id: 'spoke', projectId, domain: 'spoketuneworks.example', provenance: 'cli', createdAt: '2026-09-01T00:00:00.000Z' }).run()
    seedAnswers(db, projectId, 'gemini')

    const applied = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitor-auto-aliases', headers: auth })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json()).toMatchObject({ applied: true, changed: true, scan: { providerCitations: true } })
    const snapshots = () => db.select().from(querySnapshots).all().filter(row => row.answerText !== OTHER_TEXT)
    await waitFor(() => snapshots().every(row => row.recommendedCompetitors.length > 0))
    expect(snapshots().map(row => row.recommendedCompetitors)).toEqual([['TuneSpoke'], ['TuneSpoke'], ['TuneSpoke']])
  })
})

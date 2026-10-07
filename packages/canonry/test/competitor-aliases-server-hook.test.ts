import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'

// The local server's `onCompetitorAliasesChanged` wiring, end to end: an alias
// write through the API refreshes the stored per-snapshot competitor columns
// after commit and never rewrites the project's own `answer_mentioned`.

describe('competitor alias backfill hook', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let auth: { authorization: string }
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-competitor-alias-hook-${crypto.randomUUID()}`)
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
      if (Date.now() > deadline) throw new Error('timed out waiting for the deferred backfill')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('refreshes competitor_overlap and recommended_competitors from stored answers after an alias PUT', async () => {
    const created = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
      payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)

    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    const queryId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const at = '2026-10-01T01:00:00.000Z'
    db.insert(queries).values({ id: queryId, projectId, query: 'best bike repair shop', createdAt: at }).run()
    db.insert(runs).values({ id: runId, projectId, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt: at, finishedAt: at }).run()
    db.insert(querySnapshots).values({
      id: 'hook-snapshot',
      runId,
      queryId,
      provider: 'openai',
      citationState: 'not-cited',
      // Deliberately disagrees with the text: only a project-identity backfill
      // may recompute it, and an alias change is not one.
      answerMentioned: true,
      answerText: 'Top picks for bike repair:\n- **TuneSpoke**: fast quotes and a long warranty.\n- **Gearloft**: strong reviews.',
      citedDomains: [],
      competitorOverlap: [],
      recommendedCompetitors: [],
      createdAt: at,
    }).run()

    const res = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', headers: auth,
      payload: { aliases: ['TuneSpoke'] },
    })
    expect(res.statusCode, res.body).toBe(200)

    const read = () => db.select().from(querySnapshots).where(eq(querySnapshots.id, 'hook-snapshot')).get()!
    await waitFor(() => read().competitorOverlap.length > 0)
    expect(read()).toMatchObject({
      competitorOverlap: ['spoketuneworks.example'],
      recommendedCompetitors: ['TuneSpoke'],
      answerMentioned: true,
    })
  })
})

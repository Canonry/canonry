import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'

// A competitor's names change while a sweep is still recording answers,
// through the real server and its hooks. The edit's refresh rewrites the
// answers already stored, and the sweep keeps scoring the rest with the
// identity it read when it started. After its last answer the sweep compares
// that identity with the current one and rescores its run
// (`reconcileRunAnswerFields`), even though detection found no new name.

const ANSWER = 'Top picks for bike repair:\n- **TuneSpoke**: fast quotes and a long warranty.\n- **Gearloft**: strong reviews.'

/** An OpenAI-compatible endpoint for the local provider; answers to `held` wait for `release`. */
function fakeChatEndpoint(held: string) {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const reply = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: `cmpl-${crypto.randomUUID()}`,
          object: 'chat.completion',
          created: 0,
          model: 'llama3',
          choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      }
      if (body.includes(held)) void released.then(reply)
      else reply()
    })
  })
  return { server, release }
}

describe('a sweep that outlives a competitor names change', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>
  let endpoint: ReturnType<typeof fakeChatEndpoint>
  let auth: { authorization: string }
  let origConfigDir: string | undefined
  let origTelemetryDisabled: string | undefined

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-run-identity-repair-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    origTelemetryDisabled = process.env.CANONRY_TELEMETRY_DISABLED
    process.env.CANONRY_CONFIG_DIR = tmpDir
    process.env.CANONRY_TELEMETRY_DISABLED = '1'

    endpoint = fakeChatEndpoint('second bike repair question')
    await new Promise<void>(resolve => endpoint.server.listen(0, '127.0.0.1', resolve))
    const port = (endpoint.server.address() as AddressInfo).port

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
    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {
        local: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'llama3',
          quota: { maxConcurrency: 2, maxRequestsPerMinute: 600, maxRequestsPerDay: 1000 },
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), JSON.stringify(config), 'utf-8')
    app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.ready()
  })

  afterEach(async () => {
    endpoint.release()
    await app.close()
    await new Promise<void>(resolve => endpoint.server.close(() => resolve()))
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    if (origTelemetryDisabled === undefined) delete process.env.CANONRY_TELEMETRY_DISABLED
    else process.env.CANONRY_TELEMETRY_DISABLED = origTelemetryDisabled
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 8_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }

  it('rescores the run\'s answers when the identity changed during it', async () => {
    const created = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise', headers: auth,
      payload: { displayName: 'Rotorwise', canonicalDomain: 'rotorwise.example', country: 'US', language: 'en', providers: ['local'] },
    })
    expect(created.statusCode, created.body).toBe(201)
    const projectId = db.select().from(projects).where(eq(projects.name, 'rotorwise')).get()!.id
    const added = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/competitors', headers: auth, payload: { competitors: ['spoketuneworks.example'] } })
    expect(added.statusCode, added.body).toBe(200)
    for (const query of ['first bike repair question', 'second bike repair question']) {
      db.insert(queries).values({ id: crypto.randomUUID(), projectId, query, createdAt: '2026-10-01T00:00:00.000Z' }).run()
    }

    const triggered = await app.inject({ method: 'POST', url: '/api/v1/projects/rotorwise/runs', headers: auth, payload: {} })
    expect(triggered.statusCode, triggered.body).toBe(201)
    const runId = (triggered.json() as { id: string }).id
    const answers = () => db.select().from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()

    // The first answer is stored, scored without the name the edit adds.
    await waitFor(() => answers().length === 1, 'the first answer')
    expect(answers()[0]!.recommendedCompetitors).toEqual([])

    // The edit's own refresh rewrites the stored answer.
    const edited = await app.inject({
      method: 'PUT', url: '/api/v1/projects/rotorwise/competitors/spoketuneworks.example/aliases', headers: auth,
      payload: { aliases: ['TuneSpoke'] },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    await waitFor(() => answers()[0]!.recommendedCompetitors.length > 0, 'the alias refresh')

    // The second answer arrives after the edit, scored with the identity the
    // sweep read when it started.
    endpoint.release()
    await waitFor(() => db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()!.status === 'completed', 'the run to complete')

    await waitFor(() => answers().length === 2 && answers().every(row => row.recommendedCompetitors.length > 0), 'the completed run to be recomputed')
    expect(answers().map(row => [row.competitorOverlap, row.recommendedCompetitors])).toEqual([
      [['spoketuneworks.example'], ['TuneSpoke']],
      [['spoketuneworks.example'], ['TuneSpoke']],
    ])
  })
})

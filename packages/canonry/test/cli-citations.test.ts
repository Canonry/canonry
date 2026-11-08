import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  createClient,
  migrate,
  apiKeys,
  projects,
  queries,
  competitors,
  runs,
  querySnapshots,
} from '@canonry/canonry-db'

import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { showCitationVisibility } from '../src/commands/citations.js'

function seedProject(db: ReturnType<typeof createClient>): { projectId: string; runId: string } {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'example',
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: ['gemini', 'claude'],
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(competitors).values({
    id: crypto.randomUUID(),
    projectId,
    domain: 'rival.com',
    createdAt: now,
  }).run()

  const qA = crypto.randomUUID()
  const qB = crypto.randomUUID()
  db.insert(queries).values({ id: qA, projectId, query: 'query A', createdAt: now }).run()
  db.insert(queries).values({ id: qB, projectId, query: 'query B', createdAt: now }).run()

  const runId = crypto.randomUUID()
  db.insert(runs).values({
    id: runId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qA, provider: 'gemini',
    citationState: 'cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qA, provider: 'claude',
    citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qB, provider: 'gemini',
    citationState: 'not-cited', citedDomains: ['rival.com'], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qB, provider: 'claude',
    citationState: 'not-cited', citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
  }).run()

  return { projectId, runId }
}

describe('citation visibility CLI + parity', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let close: () => Promise<void>
  let client: ApiClient
  let db: ReturnType<typeof createClient>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-citations-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: hashed,
      keyPrefix: apiKeyPlain.slice(0, 8),
      createdAt: new Date().toISOString(),
    }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: { gemini: { apiKey: 'test-key' } },
    }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({
      config: config as Parameters<typeof createServer>[0]['config'],
      db,
      logger: false,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)

    seedProject(db)
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) {
      delete process.env.CANONRY_CONFIG_DIR
    } else {
      process.env.CANONRY_CONFIG_DIR = origConfigDir
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function captureStdout(fn: () => Promise<void>): Promise<string> {
    const logs: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    return fn().finally(() => {
      console.log = orig
    }).then(() => logs.join('\n'))
  }

  it('--format json outputs the response as parseable JSON', async () => {
    const out = await captureStdout(() => showCitationVisibility('example', { format: 'json' }))
    const parsed = JSON.parse(out)
    expect(parsed.status).toBe('ready')
    expect(parsed.summary.providersConfigured).toBe(2)
    expect(parsed.byQuery).toHaveLength(2)
    expect(parsed.competitorGaps).toHaveLength(1)
  })

  it('human output includes both headlines, cross-tab buckets, and the per-query table', async () => {
    const out = await captureStdout(() => showCitationVisibility('example', {}))
    expect(out).toContain('AEO visibility (citations + mentions)')
    expect(out).toContain('Cited in sources:')
    expect(out).toContain('Mentioned in answers:')
    expect(out).toContain('cited + mentioned:')
    expect(out).toContain('cited only:')
    expect(out).toContain('mentioned only:')
    expect(out).toContain('invisible:')
    expect(out).toContain('query A')
    expect(out).toContain('query B')
    expect(out).toContain('Per-query coverage')
    expect(out).toContain('Competitor gaps')
    expect(out).toContain('rival.com')
  })

  it('prints an engine without sources as not measured and keeps it out of the cited base', async () => {
    // Local answers query A (naming the project) and is the only engine on query C.
    const project = db.select().from(projects).get()!
    db.update(projects).set({ providers: ['gemini', 'claude', 'local'] }).run()
    const runId = db.select().from(runs).get()!.id
    const queryA = db.select().from(queries).all().find(row => row.query === 'query A')!
    const queryC = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(queries).values({ id: queryC, projectId: project.id, query: 'query C', createdAt: now }).run()
    for (const queryId of [queryA.id, queryC]) {
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider: 'local', citationState: 'not-measured', retrievalStatus: 'not-applicable',
        answerMentioned: true, citedDomains: [], competitorOverlap: [], recommendedCompetitors: [], createdAt: now,
      }).run()
    }

    const out = await captureStdout(() => showCitationVisibility('example', {}))
    // Gemini cites query A; Local's citations were never measured.
    expect(out).toContain('Cited in sources:     1/2 engines (1 not measured: no sources)')
    expect(out).toContain('Mentioned in answers: 1/3 engines')
    expect(out).toContain('citation not measured (no sources): 1')
    expect(out).toContain('·=not measured')
    const row = (query: string) => out.split('\n').find(line => line.startsWith(query))!
    // Columns: claude, gemini, local, then Cite and Ment.
    expect(row('query A').split(/\s{2,}/).slice(1)).toEqual(['cm', 'Cm', '·M', '1/2', '1/3'])
    expect(row('query C').split(/\s{2,}/).slice(1)).toEqual(['–', '–', '·M', '·', '1/1'])
  })

  it('CLI --format json matches the API response byte-for-byte', async () => {
    const apiResponse = await client.getCitationVisibility('example')
    const cliOut = await captureStdout(() => showCitationVisibility('example', { format: 'json' }))
    expect(JSON.parse(cliOut)).toEqual(apiResponse)
  })
})

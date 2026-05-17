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
} from '@ainyc/canonry-db'

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
    citationState: 'cited', citedDomains: '[]', competitorOverlap: '[]', recommendedCompetitors: '[]', createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qA, provider: 'claude',
    citationState: 'not-cited', citedDomains: '[]', competitorOverlap: '[]', recommendedCompetitors: '[]', createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qB, provider: 'gemini',
    citationState: 'not-cited', citedDomains: JSON.stringify(['rival.com']), competitorOverlap: '[]', recommendedCompetitors: '[]', createdAt: now,
  }).run()
  db.insert(querySnapshots).values({
    id: crypto.randomUUID(), runId, queryId: qB, provider: 'claude',
    citationState: 'not-cited', citedDomains: '[]', competitorOverlap: '[]', recommendedCompetitors: '[]', createdAt: now,
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

  it('CLI --format json matches the API response byte-for-byte', async () => {
    const apiResponse = await client.getCitationVisibility('example')
    const cliOut = await captureStdout(() => showCitationVisibility('example', { format: 'json' }))
    expect(JSON.parse(cliOut)).toEqual(apiResponse)
  })
})

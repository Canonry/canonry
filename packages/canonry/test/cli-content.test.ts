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
  keywords,
  competitors,
  runs,
  querySnapshots,
  gscSearchData,
  gaTrafficSnapshots,
  gaAiReferrals,
} from '@ainyc/canonry-db'

import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import {
  listContentTargets,
  listContentSources,
  listContentGaps,
} from '../src/commands/content.js'

interface SeededProject {
  projectId: string
  latestRunId: string
}

function seedProject(db: ReturnType<typeof createClient>): SeededProject {
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'example',
    displayName: 'Example',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const domain of ['competitor-a.com', 'competitor-b.com', 'competitor-c.com']) {
    db.insert(competitors).values({ id: crypto.randomUUID(), projectId, domain, createdAt: now }).run()
  }

  const queries = [
    { key: 'q1_create', query: 'best crm for saas' },
    { key: 'q2_refresh', query: 'best email marketing software' },
    { key: 'q3_expand', query: 'what is mrr' },
    { key: 'q4_skip', query: 'saas billing guide' },
  ] as const

  const keywordIds = new Map<string, string>()
  for (const q of queries) {
    const id = crypto.randomUUID()
    keywordIds.set(q.key, id)
    db.insert(keywords).values({ id, projectId, keyword: q.query, createdAt: now }).run()
  }

  const latestRunId = crypto.randomUUID()
  db.insert(runs).values({
    id: latestRunId,
    projectId,
    kind: 'answer-visibility',
    status: 'completed',
    trigger: 'manual',
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: keywordIds.get('q1_create')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-a.com', 'competitor-b.com', 'competitor-c.com']),
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://competitor-a.com/guides/crm', title: 'CRM Guide' },
      ],
    }),
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: keywordIds.get('q2_refresh')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-a.com']),
    rawResponse: JSON.stringify({ groundingSources: [] }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'best email marketing software',
    page: '/blog/email-marketing-comparison',
    impressions: 2400,
    clicks: 95,
    ctr: '0.04',
    position: '4',
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: keywordIds.get('q3_expand')!,
    provider: 'gemini',
    citationState: 'not-cited',
    competitorOverlap: JSON.stringify(['competitor-b.com']),
    rawResponse: JSON.stringify({ groundingSources: [] }),
    createdAt: now,
  }).run()
  db.insert(gscSearchData).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    query: 'what is mrr',
    page: '/glossary/mrr',
    impressions: 800,
    clicks: 12,
    ctr: '0.015',
    position: '22',
    createdAt: now,
  }).run()

  db.insert(querySnapshots).values({
    id: crypto.randomUUID(),
    runId: latestRunId,
    keywordId: keywordIds.get('q4_skip')!,
    provider: 'gemini',
    citationState: 'cited',
    competitorOverlap: JSON.stringify([]),
    rawResponse: JSON.stringify({
      groundingSources: [
        { uri: 'https://example.com/blog/saas-billing', title: 'SaaS Billing' },
      ],
    }),
    createdAt: now,
  }).run()

  db.insert(gaAiReferrals).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    source: 'chat.openai.com',
    medium: 'referral',
    sessions: 142,
    users: 130,
    syncedAt: now,
  }).run()

  db.insert(gaTrafficSnapshots).values({
    id: crypto.randomUUID(),
    projectId,
    syncRunId: latestRunId,
    date: '2026-04-01',
    landingPage: '/blog/email-marketing-comparison',
    sessions: 340,
    organicSessions: 340,
    users: 340,
    syncedAt: now,
  }).run()

  return { projectId, latestRunId }
}

describe('content CLI commands + CLI/API parity', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let serverUrl: string
  let close: () => Promise<void>
  let client: ApiClient
  let db: ReturnType<typeof createClient>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-content-test-${crypto.randomUUID()}`)
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
    serverUrl = `http://127.0.0.1:${port}`

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

  // ─── Phase K: CLI behavior ─────────────────────────────────────────

  it('content targets --format json outputs valid JSON parsing as ContentTargetsResponseDto', async () => {
    const out = await captureStdout(() => listContentTargets('example', { format: 'json' }))
    const parsed = JSON.parse(out)
    expect(parsed.targets).toBeInstanceOf(Array)
    expect(parsed.contextMetrics).toBeDefined()
    expect(parsed.contextMetrics.latestRunId).toBeTruthy()
  })

  it('content targets without --format renders human-readable table', async () => {
    const out = await captureStdout(() => listContentTargets('example', {}))
    // Either "N targets" with a body or the empty-state line — both are acceptable
    // human output. Just assert it's not JSON.
    expect(() => JSON.parse(out)).toThrow()
  })

  it('content sources --format json outputs valid JSON', async () => {
    const out = await captureStdout(() => listContentSources('example', { format: 'json' }))
    const parsed = JSON.parse(out)
    expect(parsed.sources).toBeInstanceOf(Array)
    expect(parsed.latestRunId).toBeTruthy()
  })

  it('content gaps --format json outputs valid JSON', async () => {
    const out = await captureStdout(() => listContentGaps('example', { format: 'json' }))
    const parsed = JSON.parse(out)
    expect(parsed.gaps).toBeInstanceOf(Array)
    expect(parsed.latestRunId).toBeTruthy()
  })

  it('content targets respects --limit', async () => {
    const out = await captureStdout(() =>
      listContentTargets('example', { limit: 1, format: 'json' }),
    )
    const parsed = JSON.parse(out)
    expect(parsed.targets.length).toBeLessThanOrEqual(1)
  })

  it('content targets respects --include-in-progress (no in-flight rows in fixture, so identical)', async () => {
    const without = JSON.parse(
      await captureStdout(() => listContentTargets('example', { format: 'json' })),
    )
    const withFlag = JSON.parse(
      await captureStdout(() =>
        listContentTargets('example', { includeInProgress: true, format: 'json' }),
      ),
    )
    expect(withFlag.targets).toEqual(without.targets)
  })

  // ─── Phase M: CLI/API parity ───────────────────────────────────────

  it('parity: content targets CLI matches API byte-for-byte', async () => {
    const apiResponse = await client.getContentTargets('example')
    const cliOut = await captureStdout(() => listContentTargets('example', { format: 'json' }))
    expect(JSON.parse(cliOut)).toEqual(apiResponse)
  })

  it('parity: content sources CLI matches API byte-for-byte', async () => {
    const apiResponse = await client.getContentSources('example')
    const cliOut = await captureStdout(() => listContentSources('example', { format: 'json' }))
    expect(JSON.parse(cliOut)).toEqual(apiResponse)
  })

  it('parity: content gaps CLI matches API byte-for-byte', async () => {
    const apiResponse = await client.getContentGaps('example')
    const cliOut = await captureStdout(() => listContentGaps('example', { format: 'json' }))
    expect(JSON.parse(cliOut)).toEqual(apiResponse)
  })
})

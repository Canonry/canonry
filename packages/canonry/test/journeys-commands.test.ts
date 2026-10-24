import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, trafficSources, projects, journeyVisitors, journeyVisits, journeyEvents } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const KEY = '0123456789abcdef0123456789abcdef'

describe('journeys CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-cli-journeys-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir
    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'), keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()
    const config = { apiUrl: 'http://localhost:0', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const serverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)
    await client.putProject('test-proj', { displayName: 'Test Project', canonicalDomain: 'example.com', country: 'US', language: 'en' })

    const project = db.select().from(projects).all()[0]!
    const at = '2026-10-18T10:00:00.000Z'
    db.insert(trafficSources).values({ id: 'logs', projectId: project.id, sourceType: 'vercel', displayName: 'Logs', status: 'connected', createdAt: at, updatedAt: at }).run()
    db.insert(journeyVisitors).values({ projectId: project.id, visitorKey: KEY, keyBasis: 'ua', userAgent: MAC, firstAiAt: at, firstAiEngine: 'ChatGPT', lastAiAt: at, lastSeenAt: '2026-10-20T09:01:00.000Z', createdAt: at, updatedAt: at }).run()
    db.insert(journeyVisits).values([
      { id: 'v1', projectId: project.id, visitorKey: KEY, sourceId: 'logs', startedAt: at, endedAt: '2026-10-18T10:02:00.000Z', entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false, landingPath: '/', requestCount: 2, pageCount: 2, createdAt: at, updatedAt: at },
      { id: 'v2', projectId: project.id, visitorKey: KEY, sourceId: 'logs', startedAt: '2026-10-20T09:00:00.000Z', endedAt: '2026-10-20T09:01:00.000Z', entryClass: 'search', entryName: 'Google', entryHost: 'google.com', paid: false, landingPath: '/book', requestCount: 1, pageCount: 0, createdAt: at, updatedAt: at },
    ]).run()
    db.insert(journeyEvents).values([
      { id: 'e1', projectId: project.id, visitId: 'v1', sourceId: 'logs', sourceEventId: 's1', ts: at, method: 'GET', path: '/', status: 200, kind: 'page', createdAt: at },
      { id: 'e2', projectId: project.id, visitId: 'v1', sourceId: 'logs', sourceEventId: 's2', ts: '2026-10-18T10:02:00.000Z', method: 'GET', path: '/rooms', status: 200, kind: 'page', createdAt: at },
      { id: 'e3', projectId: project.id, visitId: 'v2', sourceId: 'logs', sourceEventId: 's3', ts: '2026-10-20T09:01:00.000Z', method: 'POST', path: '/api/contact', status: 200, kind: 'data', createdAt: at },
    ]).run()
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const window = ['--since', '2026-10-01', '--until', '2026-10-24']

  it('summary JSON matches the API and text shows return rate and the user-agent caveat', async () => {
    const expected = await client.journeysSummary('test-proj', { since: '2026-10-01', until: '2026-10-24' })
    const json = await invokeCli(['journeys', 'summary', 'test-proj', ...window, '--format', 'json'])
    expect(json.exitCode, json.stderr).toBeUndefined()
    expect(parseJsonOutput(json.stdout)).toEqual(expected)
    expect(expected).toMatchObject({ aiVisitors: 1, returningVisitors: 1, returnedVia: { search: 1 } })
    const text = await invokeCli(['journeys', 'summary', 'test-proj', ...window])
    expect(text.stdout).toContain('Came back later: 1 (100%)')
    expect(text.stdout).toContain('Later visits by entry: search 1')
    expect(text.stdout).toContain('user agent only')
  })

  it('list prints the short device label and streams JSONL', async () => {
    const text = await invokeCli(['journeys', 'list', 'test-proj', ...window])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toContain('Mac · Chrome 155')
    expect(text.stdout).toContain('back via search')
    expect(text.stdout).not.toContain('AppleWebKit')
    let streamed = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { streamed += String(chunk); return true })
    try {
      const jsonl = await invokeCli(['journeys', 'list', 'test-proj', ...window, '--returned', 'true', '--format', 'jsonl'])
      expect(jsonl.exitCode, jsonl.stderr).toBeUndefined()
    } finally { write.mockRestore() }
    const rows = streamed.trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ project: 'test-proj', visitorKey: KEY, userAgent: MAC, visits: [{ entryClass: 'ai' }, { entryClass: 'search' }] })
  })

  it('show prints each visit with its requests', async () => {
    const text = await invokeCli(['journeys', 'show', 'test-proj', KEY])
    expect(text.exitCode, text.stderr).toBeUndefined()
    expect(text.stdout).toContain(`User agent: ${MAC}`)
    expect(text.stdout).toContain('ai ChatGPT  lands /')
    expect(text.stdout).toContain('search Google  lands /book')
    expect(text.stdout).toContain('[data] /api/contact')
  })

  it.each([
    [['journeys', 'list', 'test-proj', '--returned', 'maybe']],
    [['journeys', 'list', 'test-proj', '--limit', '201']],
    [['journeys', 'summary', 'test-proj', '--since', 'yesterday']],
    [['journeys', 'show', 'test-proj']],
  ])('rejects %j as a user error', async args => {
    const result = await invokeCli([...args, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect((parseJsonOutput(result.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR')
  })

  it('an unknown visitor key is not found', async () => {
    const result = await invokeCli(['journeys', 'show', 'test-proj', 'f'.repeat(32), '--format', 'json'])
    expect(result.exitCode).not.toBe(0)
    expect((parseJsonOutput(result.stderr) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })
})

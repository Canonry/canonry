import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { apiKeys, createClient, migrate, projects, queries, querySnapshots, runs } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('canonry citations urls', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origStoredOnly: string | undefined
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    origStoredOnly = process.env.CANONRY_STORED_ONLY
    delete process.env.CANONRY_STORED_ONLY
    tmpDir = path.join(os.tmpdir(), `canonry-cli-citation-urls-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')
    db = createClient(dbPath)
    migrate(db)
    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({
      id: crypto.randomUUID(), name: 'test', keyHash: crypto.createHash('sha256').update(apiKeyPlain).digest('hex'),
      keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString(),
    }).run()
    const config = { apiUrl: 'http://localhost:0', publicUrl: 'https://canonry.test', database: dbPath, apiKey: apiKeyPlain, providers: {} }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], configPath, db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()
    await new ApiClient(config.apiUrl, apiKeyPlain).putProject('test-proj', { displayName: 'Acme Tank', canonicalDomain: 'acme.example', country: 'US', language: 'en' })

    const project = db.select().from(projects).all()[0]!
    const queryId = crypto.randomUUID()
    db.insert(queries).values({ id: queryId, projectId: project.id, query: 'are acme tanks see through', createdAt: '2026-10-01T00:00:00.000Z' }).run()
    const seedRun = (createdAt: string, citedUrls: string[]) => {
      const runId = crypto.randomUUID()
      db.insert(runs).values({ id: runId, projectId: project.id, kind: 'answer-visibility', status: 'completed', trigger: 'manual', createdAt, finishedAt: createdAt }).run()
      db.insert(querySnapshots).values({
        id: crypto.randomUUID(), runId, queryId, provider: 'gemini', citationState: 'not-cited', retrievalStatus: 'retrieved',
        citedDomains: [], citedUrls, captureStatus: 'complete', answerMentioned: true, answerText: 'Acme Tank is opaque.', createdAt,
      }).run()
    }
    seedRun('2026-10-01T00:00:00.000Z', ['https://www.reddit.com/r/womensfashion/comments/old1/a/'])
    seedRun('2026-11-01T00:00:00.000Z', [
      'https://www.reddit.com/r/womensfashion/comments/old1/a/',
      'https://www.reddit.com/r/deinfluencing/comments/new1/b/?utm_source=openai',
      'https://news.example/review',
    ])
  })

  afterEach(async () => {
    await close()
    if (origStoredOnly === undefined) delete process.env.CANONRY_STORED_ONLY
    else process.env.CANONRY_STORED_ONLY = origStoredOnly
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists cited threads and keeps only new ones with --new-in-latest', async () => {
    const all = await invokeCli(['citations', 'urls', 'test-proj', '--category', 'forum', '--format', 'json'])
    expect(all.exitCode).toBeUndefined()
    const body = parseJsonOutput(all.stdout) as { urls: Array<{ url: string; answers: number; newInLatest: boolean }> }
    expect(body.urls.map((url) => [url.url, url.answers, url.newInLatest])).toEqual([
      ['https://reddit.com/r/womensfashion/comments/old1', 2, false],
      ['https://reddit.com/r/deinfluencing/comments/new1', 1, true],
    ])

    // jsonl writes through process.stdout.write, not console.log.
    let written = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk)
      return true
    })
    try {
      await invokeCli(['citations', 'urls', 'test-proj', '--category', 'forum', '--new-in-latest', '--format', 'jsonl'])
    } finally {
      spy.mockRestore()
    }
    const lines = written.split('\n').filter((line) => line.startsWith('{"project"')).map((line) => JSON.parse(line) as { project: string; url: string })
    expect(lines).toEqual([expect.objectContaining({ project: 'test-proj', url: 'https://reddit.com/r/deinfluencing/comments/new1' })])

    const text = await invokeCli(['citations', 'urls', 'test-proj', '--domain', 'reddit.com', '--limit', '1'])
    expect(text.stdout).toMatch(/https:\/\/reddit\.com\/r\/womensfashion\/comments\/old1/)
    expect(text.stdout).toMatch(/Showing 1 of 2 pages\. Next page: --cursor \S+/)
  })

  it('refuses an unknown category', async () => {
    const result = await invokeCli(['citations', 'urls', 'test-proj', '--category', 'forums'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/category/)
  })
})

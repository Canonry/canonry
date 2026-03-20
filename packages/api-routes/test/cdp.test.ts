import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-routes-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })
  return { app, db, tmpDir }
}

// ─── GET /api/v1/cdp/status ──────────────────────────────────────────────────

describe('GET /api/v1/cdp/status', () => {
  it('returns 501 when getCdpStatus callback is not provided', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/cdp/status' })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'CDP not configured',
      },
    })
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns connected status and targets when callback is provided', async () => {
    const { app, tmpDir } = buildApp({
      getCdpStatus: async () => ({
        connected: true,
        endpoint: 'ws://localhost:9222',
        browserVersion: 'Chrome/120.0',
        targets: [
          { name: 'chatgpt', alive: true, lastUsed: '2026-03-17T10:00:00Z' },
        ],
      }),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/cdp/status' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.connected).toBe(true)
    expect(body.endpoint).toBe('ws://localhost:9222')
    expect(body.browserVersion).toBe('Chrome/120.0')
    expect(body.targets).toHaveLength(1)
    expect(body.targets[0].name).toBe('chatgpt')
    expect(body.targets[0].alive).toBe(true)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns disconnected status', async () => {
    const { app, tmpDir } = buildApp({
      getCdpStatus: async () => ({
        connected: false,
        endpoint: 'ws://localhost:9222',
        targets: [],
      }),
    })
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/v1/cdp/status' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.connected).toBe(false)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ─── POST /api/v1/cdp/screenshot ─────────────────────────────────────────────

describe('POST /api/v1/cdp/screenshot', () => {
  it('returns 501 when onCdpScreenshot callback is not provided', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cdp/screenshot',
      payload: { query: 'test query' },
    })
    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'CDP not configured',
      },
    })
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when query is missing', async () => {
    const { app, tmpDir } = buildApp({ onCdpScreenshot: vi.fn() })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cdp/screenshot',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'query is required',
      },
    })
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when query is not a string', async () => {
    const { app, tmpDir } = buildApp({ onCdpScreenshot: vi.fn() })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cdp/screenshot',
      payload: { query: 42 },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('invokes the callback with query and targets and returns results', async () => {
    const mockResults = [
      {
        target: 'chatgpt',
        screenshotPath: '/tmp/screenshot.png',
        answerText: 'Answer for: best coffee NYC',
        citations: [{ uri: 'https://example.com', title: 'Example' }],
      },
    ]
    const onCdpScreenshot = vi.fn().mockResolvedValue(mockResults)
    const { app, tmpDir } = buildApp({ onCdpScreenshot })
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cdp/screenshot',
      payload: { query: 'best coffee NYC', targets: ['chatgpt'] },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.results).toHaveLength(1)
    expect(body.results[0].target).toBe('chatgpt')
    expect(body.results[0].answerText).toBe('Answer for: best coffee NYC')
    expect(body.results[0].citations).toHaveLength(1)
    expect(onCdpScreenshot).toHaveBeenCalledWith('best coffee NYC', ['chatgpt'])
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes undefined targets when not provided', async () => {
    const onCdpScreenshot = vi.fn().mockResolvedValue([])
    const { app, tmpDir } = buildApp({ onCdpScreenshot })
    await app.ready()

    await app.inject({
      method: 'POST',
      url: '/api/v1/cdp/screenshot',
      payload: { query: 'test' },
    })
    expect(onCdpScreenshot).toHaveBeenCalledWith('test', undefined)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ─── GET /api/v1/screenshots/:snapshotId ─────────────────────────────────────

describe('GET /api/v1/screenshots/:snapshotId', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof import('@ainyc/canonry-db').createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 for an unknown snapshot ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/screenshots/nonexistent-snapshot-id',
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 for a path-traversal attempt in the URL', async () => {
    // Path traversal via URL — Fastify may 400 on unusual chars or 404; never 200
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/screenshots/../../etc/passwd',
    })
    expect(res.statusCode).not.toBe(200)
  })

  it('serves a PNG file when the snapshot exists and the file is on disk', async () => {
    const screenshotDir = path.join(os.homedir(), '.canonry', 'screenshots')
    const testScreenshotName = `test-${Date.now()}.png`
    fs.mkdirSync(screenshotDir, { recursive: true })
    // Minimal 1×1 PNG
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
      '0000000a49444154789c6260000000000200e221bc33000000000049454e44ae426082',
      'hex',
    )
    const screenshotPath = path.join(screenshotDir, testScreenshotName)
    fs.writeFileSync(screenshotPath, pngBytes)

    const { querySnapshots, runs, projects, keywords } = await import('@ainyc/canonry-db')
    const projectId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()
    const snapshotId = crypto.randomUUID()

    db.insert(projects).values({
      id: projectId,
      name: `ss-test-${Date.now()}`,
      displayName: 'SS Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId,
      keyword: 'test keyword',
      createdAt: new Date().toISOString(),
    }).run()

    db.insert(runs).values({
      id: runId,
      projectId,
      kind: 'visibility',
      status: 'completed',
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    }).run()

    db.insert(querySnapshots).values({
      id: snapshotId,
      runId,
      keywordId,
      provider: 'cdp:chatgpt',
      citationState: 'cited',
      citedDomains: '[]',
      competitorOverlap: '[]',
      screenshotPath: testScreenshotName,
      createdAt: new Date().toISOString(),
    }).run()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/screenshots/${snapshotId}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)

    fs.rmSync(screenshotPath, { force: true })
  })
})

// ─── GET /api/v1/projects/:name/runs/:runId/browser-diff ──────────────────────

describe('GET /api/v1/projects/:name/runs/:runId/browser-diff', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof import('@ainyc/canonry-db').createClient>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 for an unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/nonexistent-project/runs/some-run/browser-diff',
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 404 when the run does not belong to the project', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/diff-test',
      payload: {
        displayName: 'Diff Test',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/diff-test/runs/nonexistent-run-id/browser-diff',
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns a summary and per-keyword comparison for a run with api + browser snapshots', async () => {
    const { querySnapshots, runs, keywords } = await import('@ainyc/canonry-db')

    // Create project via API so it lands in the shared DB
    const createRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/diff-test2',
      payload: {
        displayName: 'Diff Test 2',
        canonicalDomain: 'example.com',
        country: 'US',
        language: 'en',
      },
    })
    expect(createRes.statusCode).toBe(201)
    const project = JSON.parse(createRes.payload) as { id: string }

    // Insert run + keyword + snapshots directly into the same DB
    const runId = crypto.randomUUID()
    const keywordId = crypto.randomUUID()

    db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: 'visibility',
      status: 'completed',
      trigger: 'manual',
      createdAt: new Date().toISOString(),
    }).run()

    db.insert(keywords).values({
      id: keywordId,
      projectId: project.id,
      keyword: 'best coffee',
      createdAt: new Date().toISOString(),
    }).run()

    db.insert(querySnapshots).values([
      {
        id: crypto.randomUUID(),
        runId,
        keywordId,
        provider: 'openai',
        citationState: 'cited',
        citedDomains: JSON.stringify(['example.com']),
        competitorOverlap: '[]',
        createdAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        runId,
        keywordId,
        provider: 'cdp:chatgpt',
        citationState: 'cited',
        citedDomains: JSON.stringify(['example.com']),
        competitorOverlap: '[]',
        createdAt: new Date().toISOString(),
      },
    ]).run()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/diff-test2/runs/${runId}/browser-diff`,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.summary).toBeDefined()
    expect(body.summary.total).toBeGreaterThanOrEqual(1)
    expect(body.keywords).toBeInstanceOf(Array)
    expect(body.keywords[0].agreement).toBe('agree-cited')
  })
})

// ─── PUT /api/v1/settings/cdp ────────────────────────────────────────────────

describe('PUT /api/v1/settings/cdp', () => {
  it('returns 501 when onCdpConfigure is not provided', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: 'localhost', port: 9222 },
    })
    expect(res.statusCode).toBe(501)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when host is missing', async () => {
    const { app, tmpDir } = buildApp({ onCdpConfigure: vi.fn() })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { port: 9222 },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls the callback and returns the endpoint when host is provided', async () => {
    const onCdpConfigure = vi.fn().mockResolvedValue(undefined)
    const { app, tmpDir } = buildApp({ onCdpConfigure })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: 'localhost', port: 9333 },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.endpoint).toBe('ws://localhost:9333')
    expect(onCdpConfigure).toHaveBeenCalledWith('localhost', 9333)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses port 9222 as default when port is omitted', async () => {
    const onCdpConfigure = vi.fn().mockResolvedValue(undefined)
    const { app, tmpDir } = buildApp({ onCdpConfigure })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: 'localhost' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.endpoint).toBe('ws://localhost:9222')
    expect(onCdpConfigure).toHaveBeenCalledWith('localhost', 9222)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when host is not an allowed loopback address', async () => {
    const onCdpConfigure = vi.fn().mockResolvedValue(undefined)
    const { app, tmpDir } = buildApp({ onCdpConfigure })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: '192.168.1.1', port: 9222 },
    })
    expect(res.statusCode).toBe(400)
    expect(onCdpConfigure).not.toHaveBeenCalled()
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('accepts 127.0.0.1 as a valid host', async () => {
    const onCdpConfigure = vi.fn().mockResolvedValue(undefined)
    const { app, tmpDir } = buildApp({ onCdpConfigure })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: '127.0.0.1', port: 9222 },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 400 when port is out of range', async () => {
    const onCdpConfigure = vi.fn().mockResolvedValue(undefined)
    const { app, tmpDir } = buildApp({ onCdpConfigure })
    await app.ready()
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/cdp',
      payload: { host: 'localhost', port: 99999 },
    })
    expect(res.statusCode).toBe(400)
    expect(onCdpConfigure).not.toHaveBeenCalled()
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

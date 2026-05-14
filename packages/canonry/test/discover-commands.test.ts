import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  apiKeys,
  competitors,
  createClient,
  discoveryProbes,
  discoverySessions,
  migrate,
  projects,
  queries,
} from '@ainyc/canonry-db'
import type { DiscoveryPromoteResult } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { resolveIcpAngles } from '../src/commands/discover.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('discover promote CLI command', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let projectId: string
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-cli-discover-${crypto.randomUUID()}`)
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
      providers: {},
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
    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')
    close = () => app.close()

    const client = new ApiClient(config.apiUrl, apiKeyPlain)
    await client.putProject('demand-iq', {
      displayName: 'Demand IQ',
      canonicalDomain: 'demand-iq.com',
      country: 'US',
      language: 'en',
    })
    projectId = db.select().from(projects).get()!.id
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSession(opts: {
    status?: string
    probes?: Array<{ query: string; bucket: string }>
    competitorMap?: Array<{ domain: string; hits: number }>
  }): string {
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: opts.status ?? 'completed',
      competitorMap: JSON.stringify(opts.competitorMap ?? []),
      createdAt: now,
    }).run()
    for (const p of opts.probes ?? []) {
      db.insert(discoveryProbes).values({
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: p.query,
        bucket: p.bucket,
        citationState: p.bucket === 'cited' ? 'cited' : 'not-cited',
        citedDomains: '[]',
        createdAt: now,
      }).run()
    }
    return sessionId
  }

  it('promotes cited + aspirational by default and reports counts', async () => {
    const sessionId = seedSession({
      probes: [
        { query: 'best solar quoting tool', bucket: 'cited' },
        { query: 'solar crm for installers', bucket: 'aspirational' },
        { query: 'aurora alternatives', bucket: 'wasted-surface' },
      ],
      competitorMap: [
        { domain: 'helioscope.com', hits: 2 },
        { domain: 'oneoff.example', hits: 1 },
      ],
    })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId])
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toMatch(/Queries:\s+2 added/)
    expect(result.stdout).toMatch(/Competitors:\s+1 added/)

    const queryRows = db.select().from(queries).all()
    expect(queryRows.map(r => r.query).sort()).toEqual([
      'best solar quoting tool',
      'solar crm for installers',
    ])
    expect(new Set(queryRows.map(r => r.provenance))).toEqual(new Set([`discovery:${sessionId}`]))
    expect(db.select().from(competitors).all().map(c => c.domain)).toEqual(['helioscope.com'])
  })

  it('scopes promotion to --bucket (comma-separated) and skips other buckets', async () => {
    const sessionId = seedSession({
      probes: [
        { query: 'cited q', bucket: 'cited' },
        { query: 'aspirational q', bucket: 'aspirational' },
        { query: 'wasted q', bucket: 'wasted-surface' },
      ],
    })

    const result = await invokeCli([
      'discover', 'promote', 'demand-iq', sessionId,
      '--bucket', 'cited,aspirational', '--no-competitors',
    ])
    expect(result.exitCode).toBeUndefined()
    expect(db.select().from(queries).all().map(r => r.query).sort()).toEqual([
      'aspirational q',
      'cited q',
    ])
  })

  it('--no-competitors leaves competitor domains untracked', async () => {
    const sessionId = seedSession({
      probes: [{ query: 'q', bucket: 'cited' }],
      competitorMap: [{ domain: 'helioscope.com', hits: 1 }],
    })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId, '--no-competitors'])
    expect(result.exitCode).toBeUndefined()
    expect(db.select().from(competitors).all()).toHaveLength(0)
    expect(db.select().from(queries).all()).toHaveLength(1)
  })

  it('--format json emits the DiscoveryPromoteResult contract', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q1', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId, '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const json = parseJsonOutput(result.stdout) as DiscoveryPromoteResult
    expect(json.sessionId).toBe(sessionId)
    expect(json.promoted.queries).toEqual(['q1'])
    expect(json.promoted.competitors).toEqual([])
    expect(json.skipped).toEqual({ queries: [], competitors: [] })
  })

  it('rejects an invalid --bucket value before touching the API', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId, '--bucket', 'bogus'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/invalid --bucket value/i)
    // The bad flag short-circuits — nothing is promoted.
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('rejects an empty --bucket value before touching the API', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId, '--bucket', ','])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/--bucket must include at least one value/i)
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('exits non-zero when the session is not completed', async () => {
    const sessionId = seedSession({
      status: 'probing',
      probes: [{ query: 'q', bucket: 'cited' }],
    })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId])
    expect(result.exitCode).toBe(1)
    expect(db.select().from(queries).all()).toHaveLength(0)
  })
})

describe('discover multi-angle ICP', () => {
  it('returns [undefined] when neither icp nor icpAngles are set (fallback to project ICP)', () => {
    expect(resolveIcpAngles({})).toEqual([undefined])
  })

  it('returns [icp] when only icp is set', () => {
    expect(resolveIcpAngles({ icp: 'single ICP' })).toEqual(['single ICP'])
  })

  it('returns icpAngles when set (takes priority over icp)', () => {
    expect(resolveIcpAngles({ icp: 'ignored', icpAngles: ['angle a', 'angle b'] })).toEqual([
      'angle a',
      'angle b',
    ])
  })

  it('returns icpAngles even when icp is empty', () => {
    expect(resolveIcpAngles({ icpAngles: ['only angle'] })).toEqual(['only angle'])
  })

  it('returns icpAngles as-is when provided as a single-item array', () => {
    expect(resolveIcpAngles({ icpAngles: ['solo'] })).toEqual(['solo'])
  })
})

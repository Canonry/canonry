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
import type { DiscoveryCompetitorType, DiscoveryPromoteResult } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import type { DiscoveryRunStartResponse } from '../src/client.js'
import { resolveIcpAngles, summarizeAngles } from '../src/commands/discover.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('discover CLI commands', () => {
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
      locations: [
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
        { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' },
      ],
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
    competitorMap?: Array<{ domain: string; hits: number; competitorType?: DiscoveryCompetitorType }>
  }): string {
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    // Default a seeded competitor to the promotable `direct-competitor` type so
    // tests not exercising the type filter keep their original intent.
    const competitorMap = (opts.competitorMap ?? []).map(entry => ({
      domain: entry.domain,
      hits: entry.hits,
      competitorType: entry.competitorType ?? ('direct-competitor' as DiscoveryCompetitorType),
    }))
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: opts.status ?? 'completed',
      competitorMap: JSON.stringify(competitorMap),
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

  it('promotes only direct-competitor domains by default, skipping other classified types', async () => {
    const sessionId = seedSession({
      probes: [{ query: 'q', bucket: 'cited' }],
      competitorMap: [
        { domain: 'rival.com', hits: 3, competitorType: 'direct-competitor' },
        { domain: 'timeout.com', hits: 2, competitorType: 'editorial-media' },
        { domain: 'expedia.com', hits: 4, competitorType: 'ota-aggregator' },
      ],
    })

    const result = await invokeCli(['discover', 'promote', 'demand-iq', sessionId])
    expect(result.exitCode).toBeUndefined()
    expect(db.select().from(competitors).all().map(c => c.domain)).toEqual(['rival.com'])
  })

  it('--competitor-types widens the promote to the listed classified types', async () => {
    const sessionId = seedSession({
      probes: [{ query: 'q', bucket: 'cited' }],
      competitorMap: [
        { domain: 'rival.com', hits: 3, competitorType: 'direct-competitor' },
        { domain: 'timeout.com', hits: 2, competitorType: 'editorial-media' },
        { domain: 'expedia.com', hits: 4, competitorType: 'ota-aggregator' },
      ],
    })

    const result = await invokeCli([
      'discover', 'promote', 'demand-iq', sessionId,
      '--competitor-types', 'direct-competitor,editorial-media',
    ])
    expect(result.exitCode).toBeUndefined()
    expect(db.select().from(competitors).all().map(c => c.domain).sort()).toEqual([
      'rival.com',
      'timeout.com',
    ])
  })

  it('rejects an invalid --competitor-types value before touching the API', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q', bucket: 'cited' }] })

    const result = await invokeCli([
      'discover', 'promote', 'demand-iq', sessionId, '--competitor-types', 'frenemy',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/invalid --competitor-types value/i)
    // The bad flag short-circuits — nothing is promoted.
    expect(db.select().from(competitors).all()).toHaveLength(0)
    expect(db.select().from(queries).all()).toHaveLength(0)
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

  it('discover run --icp-angle starts one session per angle and emits a JSON array', async () => {
    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp-angle', 'angle one',
      '--icp-angle', 'angle two',
      '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()

    const json = parseJsonOutput(result.stdout) as DiscoveryRunStartResponse[]
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(2)
    expect(new Set(json.map(r => r.sessionId)).size).toBe(2)

    // Each angle is threaded into its own session body, not collapsed to one ICP.
    const sessions = db.select().from(discoverySessions).all()
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.icpDescription).sort()).toEqual(['angle one', 'angle two'])
  })

  it('discover run with a single --icp emits a bare object (legacy shape preserved)', async () => {
    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp', 'just one icp',
      '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()

    const json = parseJsonOutput(result.stdout) as DiscoveryRunStartResponse
    expect(Array.isArray(json)).toBe(false)
    expect(typeof json.sessionId).toBe('string')

    const sessions = db.select().from(discoverySessions).all()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.icpDescription).toBe('just one icp')
  })

  it('discover run accepts a comma-separated --locations override matching project locations', async () => {
    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp', 'spray foam installers',
      '--locations', 'michigan,florida',
      '--format', 'json',
    ])
    // The flag is wired CLI → client → API → resolveLocations; valid labels
    // resolve cleanly and the session is created.
    expect(result.exitCode).toBeUndefined()
    const json = parseJsonOutput(result.stdout) as DiscoveryRunStartResponse
    expect(typeof json.sessionId).toBe('string')
    expect(db.select().from(discoverySessions).all()).toHaveLength(1)
  })

  it('discover run exits non-zero when --locations names a label not configured on the project', async () => {
    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp', 'spray foam installers',
      '--locations', 'california',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/not configured/i)
    // The 400 short-circuits before any session row is written.
    expect(db.select().from(discoverySessions).all()).toHaveLength(0)
  })

  it('discover run --format json carries consolidated=true when an in-flight session is reused (issue #498)', async () => {
    // Seed a session that looks in-flight — the route should latch on rather
    // than starting a second seed/probe sweep.
    const existingSessionId = crypto.randomUUID()
    const existingRunId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: existingSessionId,
      projectId,
      runId: existingRunId,
      status: 'probing',
      icpDescription: 'in-flight icp',
      competitorMap: '[]',
      createdAt: new Date().toISOString(),
    }).run()

    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp', 'in-flight icp',
      '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()

    const json = parseJsonOutput(result.stdout) as DiscoveryRunStartResponse
    expect(json.consolidated).toBe(true)
    expect(json.sessionId).toBe(existingSessionId)
    expect(json.runId).toBe(existingRunId)

    // No new session row was created — the bug the issue calls out is the
    // explosion of micro-sessions, so the contract here is "exactly one row".
    expect(db.select().from(discoverySessions).all()).toHaveLength(1)
  })

  it('discover run prints a "Reusing in-flight session" line when the response is consolidated', async () => {
    const existingSessionId = crypto.randomUUID()
    const existingRunId = crypto.randomUUID()
    db.insert(discoverySessions).values({
      id: existingSessionId,
      projectId,
      runId: existingRunId,
      status: 'probing',
      icpDescription: 'in-flight icp',
      competitorMap: '[]',
      createdAt: new Date().toISOString(),
    }).run()

    const result = await invokeCli([
      'discover', 'run', 'demand-iq',
      '--icp', 'in-flight icp',
    ])
    expect(result.exitCode).toBeUndefined()
    // The operator sees clearly that no fresh sweep started — "Discovery run
    // started" would mislead them into thinking they paid for another seed.
    expect(result.stdout).toContain('Reusing in-flight discovery session')
    expect(result.stdout).toContain(existingSessionId)
    expect(result.stdout).not.toContain('Discovery run started')
  })
})

describe('resolveIcpAngles', () => {
  it('falls back to [undefined] when neither icp nor icpAngles are set', () => {
    expect(resolveIcpAngles({})).toEqual({ angles: [undefined], multiAngle: false })
  })

  it('returns the bare icp as a single non-multi angle', () => {
    expect(resolveIcpAngles({ icp: 'single ICP' })).toEqual({ angles: ['single ICP'], multiAngle: false })
  })

  it('trims a bare icp and treats a whitespace-only icp as absent', () => {
    expect(resolveIcpAngles({ icp: '  spaced ICP  ' })).toEqual({ angles: ['spaced ICP'], multiAngle: false })
    expect(resolveIcpAngles({ icp: '   ' })).toEqual({ angles: [undefined], multiAngle: false })
  })

  it('uses icpAngles over icp and flags multiAngle', () => {
    expect(resolveIcpAngles({ icp: 'ignored', icpAngles: ['angle a', 'angle b'] })).toEqual({
      angles: ['angle a', 'angle b'],
      multiAngle: true,
    })
  })

  it('keeps multiAngle true even for a single icp-angle', () => {
    expect(resolveIcpAngles({ icpAngles: ['solo'] })).toEqual({ angles: ['solo'], multiAngle: true })
  })

  it('trims and drops empty / whitespace-only angles', () => {
    expect(resolveIcpAngles({ icpAngles: ['  kept  ', '', '   ', 'also kept'] })).toEqual({
      angles: ['kept', 'also kept'],
      multiAngle: true,
    })
  })

  it('falls back to icp when every icp-angle is blank', () => {
    expect(resolveIcpAngles({ icp: 'fallback', icpAngles: ['', '  '] })).toEqual({
      angles: ['fallback'],
      multiAngle: false,
    })
  })

  it('falls back to [undefined] when icp-angles are all blank and no icp is given', () => {
    expect(resolveIcpAngles({ icpAngles: ['', '   '] })).toEqual({ angles: [undefined], multiAngle: false })
  })
})

describe('summarizeAngles', () => {
  it('sums each bucket across sessions and counts angles', () => {
    const summary = summarizeAngles([
      { probeCount: 40, citedCount: 3, wastedCount: 5, aspirationalCount: 8 },
      { probeCount: 38, citedCount: 1, wastedCount: 9, aspirationalCount: 4 },
      { probeCount: 40, citedCount: 2, wastedCount: 0, aspirationalCount: 11 },
    ])
    expect(summary).toEqual({
      angleCount: 3,
      totalProbes: 118,
      totalCited: 6,
      totalWasted: 14,
      totalAspirational: 23,
    })
  })

  it('treats null / missing counts as zero', () => {
    const summary = summarizeAngles([
      { probeCount: 10, citedCount: null, wastedCount: 1, aspirationalCount: 2 },
      { citedCount: 4, wastedCount: null, aspirationalCount: null },
    ])
    expect(summary).toEqual({
      angleCount: 2,
      totalProbes: 10,
      totalCited: 4,
      totalWasted: 1,
      totalAspirational: 2,
    })
  })

  it('returns all-zero totals for an empty session list', () => {
    expect(summarizeAngles([])).toEqual({
      angleCount: 0,
      totalProbes: 0,
      totalCited: 0,
      totalWasted: 0,
      totalAspirational: 0,
    })
  })

  it('passes a single session through unchanged', () => {
    expect(
      summarizeAngles([{ probeCount: 40, citedCount: 7, wastedCount: 3, aspirationalCount: 12 }]),
    ).toEqual({
      angleCount: 1,
      totalProbes: 40,
      totalCited: 7,
      totalWasted: 3,
      totalAspirational: 12,
    })
  })
})

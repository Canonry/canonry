import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
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
import type { DiscoveryCompetitorType, DiscoveryHarvestDto, DiscoveryPromoteResult, DiscoverySessionDetailDto } from '@ainyc/canonry-contracts'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import type { DiscoveryRunStartResponse } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'
import { prepareCliReadFixture } from './cli-read-fixture.js'

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
    await client.putProject('acme-iq', {
      displayName: 'Acme IQ',
      canonicalDomain: 'acme-iq.example.com',
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
    probes?: Array<{ query: string; bucket: string; citationState?: string; answerMentioned?: boolean | null }>
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
      competitorMap,
      createdAt: now,
    }).run()
    for (const p of opts.probes ?? []) {
      db.insert(discoveryProbes).values({
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: p.query,
        bucket: p.bucket,
        citationState: p.citationState ?? (p.bucket === 'cited' ? 'cited' : 'not-cited'),
        citedDomains: [],
        ...(p.answerMentioned === undefined ? {} : { answerMentioned: p.answerMentioned }),
        createdAt: now,
      }).run()
    }
    return sessionId
  }

  function assertOnlyUnconfiguredHostDiagnostics(stderr: string, sessions: Array<{ id: string; runId: string | null }>): void {
    // The in-process Host has no provider: these background callbacks are separate from CLI admission.
    const allowedDiagnostics = [
      {
        level: 'error', module: 'DiscoveryRun', action: 'discovery.failed',
        msg: 'Gemini provider is not configured. Add a Gemini API key (or Vertex project) before running discovery.',
        error: 'Gemini provider is not configured. Add a Gemini API key (or Vertex project) before running discovery.',
      },
      {
        level: 'error', module: 'RunCoordinator', action: 'aero.failed',
        msg: 'No agent LLM provider configured. Add an API key for one of: claude, openai, gemini, zai in ~/.canonry/config.yaml, or export ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ZAI_API_KEY.',
        error: 'No agent LLM provider configured. Add an API key for one of: claude, openai, gemini, zai in ~/.canonry/config.yaml, or export ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ZAI_API_KEY.',
      },
    ]
    for (const line of stderr.split('\n').filter(Boolean)) {
      const diagnostic = JSON.parse(line)
      expect(allowedDiagnostics).toContainEqual({
        level: diagnostic.level, module: diagnostic.module, action: diagnostic.action,
        msg: diagnostic.msg, error: diagnostic.error,
      })
      expect(sessions.map(session => session.runId)).toContain(diagnostic.runId)
      if (diagnostic.module === 'DiscoveryRun') {
        expect(sessions.map(session => ({ runId: session.runId, sessionId: session.id }))).toContainEqual({
          runId: diagnostic.runId, sessionId: diagnostic.sessionId,
        })
      }
    }
  }

  it('discover show renders both signals as a [citation][mention] cell with a legend', async () => {
    const sessionId = seedSession({
      probes: [
        // cited AND mentioned, cited-not-mentioned, mentioned-not-cited, and a
        // legacy probe with no mention data (must render the no-data glyph).
        { query: 'both q', bucket: 'cited', citationState: 'cited', answerMentioned: true },
        { query: 'cited only q', bucket: 'cited', citationState: 'cited', answerMentioned: false },
        { query: 'mention only q', bucket: 'aspirational', citationState: 'not-cited', answerMentioned: true },
        { query: 'legacy q', bucket: 'aspirational', citationState: 'not-cited', answerMentioned: undefined },
      ],
    })

    const result = await invokeCli(['discover', 'show', 'acme-iq', sessionId])
    expect(result.exitCode).toBeUndefined()
    // legend present so the reader knows which glyph is which
    expect(result.stdout).toContain('[citation][mention]')
    const line = (q: string) => result.stdout.split('\n').find((l) => l.includes(q))!
    expect(line('both q')).toContain('[CM]')
    expect(line('cited only q')).toContain('[Cm]')
    expect(line('mention only q')).toContain('[cM]')
    // legacy (unknown) mention renders the no-data glyph, never 'm'
    expect(line('legacy q')).toContain('[c–]')
  })

  it('discover harvest extracts the Gemini grounding fan-out, gates it, and emits json', async () => {
    // End-to-end through the real server wiring: server.ts hands each stored
    // probe's Gemini-shaped raw_response to the real extractSearchQueriesFromRaw.
    const sessionId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(discoverySessions).values({
      id: sessionId,
      projectId,
      status: 'completed',
      seedProvider: 'gemini',
      competitorMap: [],
      createdAt: now,
    }).run()
    const geminiRaw = (webSearchQueries: string[]) =>
      JSON.stringify({ candidates: [{ groundingMetadata: { webSearchQueries } }] })
    db.insert(discoveryProbes).values([
      {
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: 'p1',
        bucket: 'aspirational',
        citationState: 'not-cited',
        citedDomains: [],
        rawResponse: geminiRaw(['best solar installer michigan', 'acme solar phone number']),
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        sessionId,
        projectId,
        query: 'p2',
        bucket: 'aspirational',
        citationState: 'not-cited',
        citedDomains: [],
        rawResponse: geminiRaw(['best solar installer michigan', 'solar battery storage cost']),
        createdAt: now,
      },
    ]).run()

    const result = await invokeCli([
      'discover', 'harvest', 'acme-iq', sessionId, '--no-anchor', '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()
    const harvest = parseJsonOutput(result.stdout) as DiscoveryHarvestDto
    expect(harvest.provider).toBe('gemini')
    // Recurring across both probes ranks first; the navigational lookup is dropped.
    expect(harvest.candidates).toEqual([
      { query: 'best solar installer michigan', probeHits: 2 },
      { query: 'solar battery storage cost', probeHits: 1 },
    ])
    expect(harvest.stats.rejected.navigational).toBe(1)
  })

  it('promotes cited + aspirational by default and reports counts', async () => {
    const sessionId = seedSession({
      probes: [
        { query: 'best solar quoting tool', bucket: 'cited' },
        { query: 'solar crm for installers', bucket: 'aspirational' },
        { query: 'sunplanner alternatives', bucket: 'wasted-surface' },
      ],
      competitorMap: [
        { domain: 'raydesign.test', hits: 2 },
        { domain: 'oneoff.example', hits: 1 },
      ],
    })

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId])
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toMatch(/Queries:\s+2 added/)
    expect(result.stdout).toMatch(/Competitors:\s+1 added/)

    const queryRows = db.select().from(queries).all()
    expect(queryRows.map(r => r.query).sort()).toEqual([
      'best solar quoting tool',
      'solar crm for installers',
    ])
    expect(new Set(queryRows.map(r => r.provenance))).toEqual(new Set([`discovery:${sessionId}`]))
    expect(db.select().from(competitors).all().map(c => c.domain)).toEqual(['raydesign.test'])
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
      'discover', 'promote', 'acme-iq', sessionId,
      '--bucket', 'cited,wasted-surface', '--no-competitors',
    ])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/Queries:\s+2 added, 0 already tracked/)
    expect(db.select().from(queries).all().map(r => r.query).sort()).toEqual(['cited q', 'wasted q'])
  })

  it('--no-competitors leaves competitor domains untracked', async () => {
    const sessionId = seedSession({
      probes: [{ query: 'q', bucket: 'cited' }],
      competitorMap: [{ domain: 'raydesign.test', hits: 3 }],
    })
    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId, '--no-competitors'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(db.select().from(competitors).all()).toHaveLength(0)
    expect(db.select().from(queries).all().map(r => r.query)).toEqual(['q'])
    const allowed = await invokeCli(['discover', 'promote', 'acme-iq', sessionId])
    expect(allowed.exitCode).toBeUndefined()
    expect(db.select().from(competitors).all().map(r => r.domain)).toEqual(['raydesign.test'])
    expect(db.select().from(queries).all().map(r => r.query)).toEqual(['q'])
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

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId])
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
      'discover', 'promote', 'acme-iq', sessionId,
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
      'discover', 'promote', 'acme-iq', sessionId, '--competitor-types', 'frenemy',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/invalid --competitor-types value/i)
    // The bad flag short-circuits — nothing is promoted.
    expect(db.select().from(competitors).all()).toHaveLength(0)
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('--format json emits the DiscoveryPromoteResult contract', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q1', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId, '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const json = parseJsonOutput(result.stdout) as DiscoveryPromoteResult
    expect(json.sessionId).toBe(sessionId)
    expect(json.promoted.queries).toEqual(['q1'])
    expect(json.promoted.competitors).toEqual([])
    expect(json.skipped).toEqual({ queries: [], competitors: [] })
  })

  it('rejects an invalid --bucket value before touching the API', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId, '--bucket', 'bogus'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/invalid --bucket value/i)
    // The bad flag short-circuits — nothing is promoted.
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('rejects an empty --bucket value before touching the API', async () => {
    const sessionId = seedSession({ probes: [{ query: 'q', bucket: 'cited' }] })

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId, '--bucket', ','])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/--bucket must include at least one value/i)
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('exits non-zero when the session is not completed', async () => {
    const sessionId = seedSession({
      status: 'probing',
      probes: [{ query: 'q', bucket: 'cited' }],
    })

    const result = await invokeCli(['discover', 'promote', 'acme-iq', sessionId])
    expect(result.exitCode).toBe(1)
    expect(db.select().from(queries).all()).toHaveLength(0)
  })

  it('discover run --icp-angle starts one session per angle and emits a JSON array', async () => {
    const result = await invokeCli([
      'discover', 'run', 'acme-iq', '--icp-angle', 'angle one', '--icp-angle', 'angle two', '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()
    const sessions = db.select().from(discoverySessions).all()
    assertOnlyUnconfiguredHostDiagnostics(result.stderr, sessions)
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.icpDescription).sort()).toEqual(['angle one', 'angle two'])
    const one = sessions.find(s => s.icpDescription === 'angle one')!
    const two = sessions.find(s => s.icpDescription === 'angle two')!
    expect(JSON.parse(result.stdout)).toEqual([
      { sessionId: one.id, runId: one.runId, status: 'running', consolidated: false },
      { sessionId: two.id, runId: two.runId, status: 'running', consolidated: false },
    ])
  })

  it('discover run with a single --icp emits a bare object (legacy shape preserved)', async () => {
    const result = await invokeCli([
      'discover', 'run', 'acme-iq', '--icp', 'just one icp', '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()
    const sessions = db.select().from(discoverySessions).all()
    assertOnlyUnconfiguredHostDiagnostics(result.stderr, sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.icpDescription).toBe('just one icp')
    expect(JSON.parse(result.stdout)).toEqual({
      sessionId: sessions[0]!.id, runId: sessions[0]!.runId, status: 'running', consolidated: false,
    })
  })

  it('discover run accepts a comma-separated --locations override matching project locations', async () => {
    const result = await invokeCli([
      'discover', 'run', 'acme-iq', '--icp', 'spray foam installers',
      '--locations', ' florida , ', '--format', 'json',
    ])
    expect(result.exitCode).toBeUndefined()
    const sessions = db.select().from(discoverySessions).all()
    assertOnlyUnconfiguredHostDiagnostics(result.stderr, sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.locations).toEqual([
      { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' },
    ])
    expect(JSON.parse(result.stdout)).toEqual({
      sessionId: sessions[0]!.id, runId: sessions[0]!.runId, status: 'running', consolidated: false,
    })
  })

  it('discover run exits non-zero when --locations names a label not configured on the project', async () => {
    const result = await invokeCli([
      'discover', 'run', 'acme-iq',
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
      // Mirrors what the route writes since migration 91: resolved locations
      // are persisted and part of the consolidation identity.
      locations: [
        { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' },
        { label: 'florida', city: 'Miami', region: 'Florida', country: 'US' },
      ],
      competitorMap: [],
      createdAt: new Date().toISOString(),
    }).run()

    const result = await invokeCli([
      'discover', 'run', 'acme-iq',
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
    const human = await invokeCli(['discover', 'run', 'acme-iq', '--icp', 'in-flight icp'])
    expect(human.exitCode).toBeUndefined()
    expect(human.stderr).toBe('')
    expect(human.stdout.split('\n')).toEqual([
      '[in-flight icp]',
      `Reusing in-flight discovery session: ${existingSessionId}`,
      `  Run:     ${existingRunId}`,
      '  Status:  running',
      `  Tail:    canonry discover show acme-iq ${existingSessionId}`,
    ])
    expect(db.select().from(discoverySessions).all()).toHaveLength(1)
  })


})

type NativeDiscoveryRequest = {
  method: string
  pathname: string
  query: Record<string, string>
  authorization: string | null
  body: unknown
}

function supplyDiscoveryHttp(sessions: readonly DiscoverySessionDetailDto[] = []) {
  const requests: NativeDiscoveryRequest[] = []
  let starts = 0
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://canonry.test')
    requests.push({
      method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization'),
      body: request.method === 'POST' ? await request.clone().json() : null,
    })
    if (request.method === 'POST' && url.pathname === '/prefix/api/v1/projects/acme-iq/discover/run') {
      starts += 1
      return Response.json({ sessionId: 'session-' + starts, runId: 'run-' + starts, status: 'running', consolidated: false }, { status: 201 })
    }
    const session = sessions.find(s => url.pathname === '/prefix/api/v1/projects/acme-iq/discover/sessions/' + s.id)
    if (request.method === 'GET' && session) return Response.json(session)
    throw new Error('Unexpected discovery request: ' + request.method + ' ' + url.pathname)
  }))
  return requests
}

function expectedDiscoveryPosts(bodies: readonly object[]) {
  return bodies.map(body => ({
    method: 'POST', pathname: '/prefix/api/v1/projects/acme-iq/discover/run', query: {},
    authorization: 'Bearer cnry_native-read', body,
  }))
}

describe('registered discovery argv and waited output', () => {
  let cleanup: () => void
  beforeEach(() => { cleanup = prepareCliReadFixture() })
  afterEach(() => { vi.useRealTimers(); cleanup() })

  it.each([
    { name: 'stored default', args: [], bodies: [{}], array: false },
    { name: 'bare ICP', args: ['--icp', 'single ICP'], bodies: [{ icpDescription: 'single ICP' }], array: false },
    { name: 'trimmed ICP', args: ['--icp', '  spaced ICP  '], bodies: [{ icpDescription: 'spaced ICP' }], array: false },
    { name: 'blank ICP', args: ['--icp', '   '], bodies: [{}], array: false },
    { name: 'angle precedence', args: ['--icp', 'ignored', '--icp-angle', 'angle a', '--icp-angle', 'angle b'], bodies: [{ icpDescription: 'angle a' }, { icpDescription: 'angle b' }], array: true },
    { name: 'one repeated angle', args: ['--icp-angle', 'solo'], bodies: [{ icpDescription: 'solo' }], array: true },
    { name: 'trimmed nonblank angles', args: ['--icp-angle', '  kept  ', '--icp-angle', '', '--icp-angle', '   ', '--icp-angle', 'also kept'], bodies: [{ icpDescription: 'kept' }, { icpDescription: 'also kept' }], array: true },
    { name: 'blank angles with ICP fallback', args: ['--icp', 'fallback', '--icp-angle', '', '--icp-angle', '  '], bodies: [{ icpDescription: 'fallback' }], array: false },
    { name: 'blank angles with stored fallback', args: ['--icp-angle', '', '--icp-angle', '   '], bodies: [{}], array: false },
  ])('registered discover argv preserves $name bodies and JSON envelope', async (row) => {
    const requests = supplyDiscoveryHttp()
    const result = await invokeCli(['discover', 'run', 'acme-iq', ...row.args, '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(requests).toEqual(expectedDiscoveryPosts(row.bodies))
    const starts = row.bodies.map((_, i) => ({ sessionId: 'session-' + (i + 1), runId: 'run-' + (i + 1), status: 'running', consolidated: false }))
    expect(JSON.parse(result.stdout)).toEqual(row.array ? starts : starts[0])
  })

  it.each([
    {
      name: 'three completed angles', angles: ['angle a', 'angle b', 'angle c'],
      counts: [
        { probeCount: 40, citedCount: 3, wastedCount: 5, aspirationalCount: 8 },
        { probeCount: 38, citedCount: 1, wastedCount: 9, aspirationalCount: 4 },
        { probeCount: 40, citedCount: 2, wastedCount: 0, aspirationalCount: 11 },
      ],
      summary: '  Probes: 118  Cited: 6  Wasted: 14  Aspirational: 23',
      detailCounts: [
        ['  Probes:        40', '  Buckets:       cited=3  wasted-surface=5  aspirational=8'],
        ['  Probes:        38', '  Buckets:       cited=1  wasted-surface=9  aspirational=4'],
        ['  Probes:        40', '  Buckets:       cited=2  wasted-surface=0  aspirational=11'],
      ],
    },
    {
      name: 'nullable and absent counts', angles: ['angle a', 'angle b'],
      counts: [
        { probeCount: 10, citedCount: null, wastedCount: 1, aspirationalCount: 2 },
        { citedCount: 4, wastedCount: null, aspirationalCount: null },
      ],
      summary: '  Probes: 10  Cited: 4  Wasted: 1  Aspirational: 2',
      detailCounts: [
        ['  Probes:        10', '  Buckets:       cited=0  wasted-surface=1  aspirational=2'],
        ['  Buckets:       cited=4  wasted-surface=0  aspirational=0'],
      ],
    },
  ])('registered discover wait preserves $name summary, identities and machine output', async (row) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const sessions: DiscoverySessionDetailDto[] = row.counts.map((counts, i) => ({
      id: 'session-' + (i + 1), projectId: 'p-native', status: 'completed',
      createdAt: '2026-10-05T12:00:00.000Z', competitorMap: [], probes: [], ...counts,
    }))
    const args = row.angles.flatMap(angle => ['--icp-angle', angle])
    const bodies = row.angles.map(icpDescription => ({ icpDescription }))
    async function waited(format: string | undefined) {
      const requests = supplyDiscoveryHttp(sessions)
      const pending = invokeCli(['discover', 'run', 'acme-iq', ...args, '--wait', ...(format ? ['--format', format] : [])])
      try {
        await vi.waitFor(() => expect(requests.filter(r => r.method === 'POST')).toHaveLength(row.angles.length))
        await vi.advanceTimersByTimeAsync(3500)
        const result = await pending
        expect(result.exitCode).toBeUndefined()
        expect(requests).toEqual([
          ...expectedDiscoveryPosts(bodies),
          ...sessions.map(session => ({
            method: 'GET', pathname: '/prefix/api/v1/projects/acme-iq/discover/sessions/' + session.id,
            query: {}, authorization: 'Bearer cnry_native-read', body: null,
          })),
        ])
        expect(result.stderr).toBe('Waiting for ' + row.angles.length + ' discovery sessions...\n')
        return result
      } finally {
        await vi.runAllTimersAsync()
        await pending
      }
    }
    const human = await waited(undefined)
    const lines = human.stdout.split('\n')
    expect(lines).toEqual([
      ...row.angles.flatMap((angle, i) => [
        '## ICP angle: ' + angle, '', 'Discovery session: ' + sessions[i]!.id,
        '  Status:        completed', ...row.detailCounts[i]!,
        '  Created:       2026-10-05T12:00:00.000Z', '',
      ]),
      '── Summary across ' + row.angles.length + ' angle(s) ──', row.summary,
      '', '  Promote each session:',
      ...sessions.map(session => '    canonry discover promote acme-iq ' + session.id),
    ])
    const machine = await waited('json')
    expect(JSON.parse(machine.stdout)).toEqual(sessions)
    const requests = supplyDiscoveryHttp()
    const started = await invokeCli(['discover', 'run', 'acme-iq', ...args, '--format', 'json'])
    expect(started.exitCode).toBeUndefined()
    expect(started.stderr).toBe('')
    expect(requests).toEqual(expectedDiscoveryPosts(bodies))
    expect(JSON.parse(started.stdout)).toEqual(sessions.map((session, i) => ({ sessionId: session.id, runId: 'run-' + (i + 1), status: 'running', consolidated: false })))
  })
})

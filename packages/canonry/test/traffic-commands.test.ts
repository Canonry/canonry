import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { parse } from 'yaml'
import { agentJourneyDetailResponseSchema, agentJourneysResponseSchema } from '@canonry/canonry-contracts'
import { createClient, migrate, apiKeys, runs, trafficSources, rawEventSamples, projects, agentJourneyEvents, aiUserFetchLikelyFakeHourly } from '@canonry/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { createCanonryMcpServer } from '../src/mcp/server.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('traffic CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let origStoredOnly: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>
  let serverUrl: string

  beforeEach(async () => {
    origStoredOnly = process.env.CANONRY_STORED_ONLY
    delete process.env.CANONRY_STORED_ONLY
    tmpDir = path.join(os.tmpdir(), `canonry-cli-traffic-${crypto.randomUUID()}`)
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
      publicUrl: 'https://canonry.test',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: {},
    }
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({
      config: config as Parameters<typeof createServer>[0]['config'],
      configPath,
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

    await client.putProject('test-proj', {
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
  })

  afterEach(async () => {
    await close()
    vi.restoreAllMocks()
    if (origStoredOnly === undefined) delete process.env.CANONRY_STORED_ONLY
    else process.env.CANONRY_STORED_ONLY = origStoredOnly
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function seedAgentRequests(mode: 'simple' | 'advanced'): Promise<string> {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T00:00:00.000Z'))
    const project = db.select().from(projects).all()[0]!
    const at = '2026-10-20T12:00:00.000Z'
    db.insert(trafficSources).values({ id: 'agent-source', projectId: project.id, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: at, updatedAt: at }).run()
    const common = {
      projectId: project.id, sourceId: 'agent-source', correlationKey: 'private-correlation-key', correlationBasis: 'ip-ua',
      agentId: 'chatgpt-user', operator: 'OpenAI', product: 'ChatGPT', verificationStatus: 'claimed_unverified',
      trust: 'unknown', trustReasons: ['ip-outside-old-list'], host: 'example.com', latencyMs: 12, createdAt: at,
    } as const
    // Counted beside the sequences, never listed.
    db.insert(aiUserFetchLikelyFakeHourly).values({ projectId: project.id, sourceId: 'agent-source', tsHour: at, botId: 'chatgpt-user', operator: 'OpenAI', reason: 'scanner-path', hits: 4, createdAt: at, updatedAt: at }).run()
    db.insert(agentJourneyEvents).values([
      { ...common, id: 'agent-event-1', sourceEventId: 'raw-1', ts: at, method: 'GET', path: '/rooms', status: 200 },
      { ...common, id: 'agent-event-2', sourceEventId: 'raw-2', ts: '2026-10-20T12:01:00.000Z', method: 'GET', path: '/api/availability', status: 200 },
      { ...common, id: 'agent-event-3', sourceEventId: 'raw-3', ts: '2026-10-20T12:02:00.000Z', method: 'POST', path: '/api/booking', status: 409 },
    ]).run()
    if (mode === 'advanced') {
      await client.publishMeasurementPlan('test-proj', {
        expectedActiveRevision: null,
        plan: {
          schemaVersion: 1,
          targets: [{
            stableKey: 'booking', label: 'Booking', aliases: ['Booking'],
            urls: [
              { kind: 'exact', url: 'https://example.com/rooms', pathCase: 'sensitive' },
              { kind: 'prefix', host: 'example.com', pathPrefix: '/api', pathCase: 'sensitive' },
            ],
          }],
        },
      })
      // A dropped Property selector must change the response, not pass because
      // the fixture happens to contain only matching requests.
      db.insert(agentJourneyEvents).values({ ...common, id: 'agent-other-property', sourceEventId: 'raw-other', ts: '2026-10-20T12:03:00.000Z', method: 'GET', path: '/unrelated', status: 200 }).run()
    }
    return project.id
  }

  it.each(['simple', 'advanced'] as const)('preserves %s agent request evidence and uncertainty through CLI JSON, JSONL and paged text', async mode => {
    await seedAgentRequests(mode)
    const targetKey = mode === 'advanced' ? 'booking' : undefined
    const query = { since: '2026-10-20', until: '2026-10-20', sourceId: 'agent-source', agentId: 'chatgpt-user', trust: 'unknown' as const, targetKey }
    const args = ['--since', query.since, '--until', query.until, '--source', query.sourceId, '--agent', query.agentId, '--trust', query.trust]
    if (targetKey) args.push('--target-key', targetKey)
    const expected = await client.trafficAgentJourneys('test-proj', query)
    const listing = await invokeCli(['--stored-only', 'traffic', 'agent-journeys', 'test-proj', ...args, '--format', 'json'])
    expect(listing.exitCode, listing.stderr).toBeUndefined()
    expect(parseJsonOutput(listing.stdout)).toEqual(expected)
    expect(expected.scope).toMatchObject({ mode, targetKey: targetKey ?? null, planRevision: mode === 'advanced' ? 1 : null, attribution: mode === 'advanced' ? 'current-plan-url' : 'project' })
    expect(expected.journeys).toHaveLength(1)
    expect(expected.journeys[0]).toMatchObject({ requestCount: 3, errorCount: 1, correlation: 'inferred', trustLevels: ['unknown'] })
    // Hourly likely fake totals have no page path, so a Property selection has no count.
    expect(expected.coverage.likelyFakeRequests).toBe(targetKey ? null : 4)
    const id = expected.journeys[0]!.id
    const detail = await client.trafficAgentJourney('test-proj', id, { ...query, limit: 1, offset: 1 })
    const detailArgs = ['traffic', 'agent-journey', 'test-proj', id, ...args, '--limit', '1', '--offset', '1']
    const json = await invokeCli([...detailArgs, '--format', 'json'])
    expect(parseJsonOutput(json.stdout)).toEqual(detail)
    expect(detail.events.map(event => event.path)).toEqual(['/api/availability'])
    expect(json.stdout).not.toContain('private-correlation-key')
    const text = await invokeCli(detailArgs)
    expect(text.stdout).toContain('Inferred sequence from IP and user agent')
    expect(text.stdout).toContain('unknown (ip-outside-old-list)')
    expect(text.stdout).toContain('trust unknown')
    expect(text.stdout).toContain(targetKey
      ? 'Likely fake requests: not counted per Property (hourly totals carry no page path).'
      : 'Likely fake requests in this window (counted, not listed): 4')
    expect(text.stdout).toContain('GET  200  example.com/api/availability')
    expect(text.stdout).toContain('More: --offset 2')
    expect(text.stdout).toContain('do not establish task success')
    expect(text.stdout).not.toContain('POST  409')
    if (targetKey) {
      expect(text.stdout).toContain('Property: booking; attribution current-plan-url, revision 1')
      expect(text.stdout).toContain('Property booking (matched)')
    }
    let streamed = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { streamed += String(chunk); return true })
    try {
      const jsonl = await invokeCli([...detailArgs, '--format', 'jsonl'])
      expect(jsonl.exitCode, jsonl.stderr).toBeUndefined()
    } finally { write.mockRestore() }
    const { events, ...context } = detail
    expect(streamed.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ ...context, event: events[0] }])
    streamed = ''
    const listWrite = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { streamed += String(chunk); return true })
    try {
      const jsonl = await invokeCli(['traffic', 'agent-journeys', 'test-proj', ...args, '--format', 'jsonl'])
      expect(jsonl.exitCode, jsonl.stderr).toBeUndefined()
    } finally { listWrite.mockRestore() }
    const { journeys, ...listContext } = expected
    expect(streamed.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ ...listContext, journey: journeys[0] }])
  })

  it.each(['simple', 'advanced'] as const)('reads %s agent journeys through stored-only MCP and preserves the API project boundary', async mode => {
    const projectId = await seedAgentRequests(mode)
    await client.putProject('other-project', { displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en' })
    const key = `cnry_${crypto.randomBytes(16).toString('hex')}`
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'agent-journey-reader', projectId, scopes: ['read'], keyHash: crypto.createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 8), createdAt: new Date().toISOString() }).run()
    const scoped = new ApiClient(serverUrl, key, { skipProbe: true })
    const server = createCanonryMcpServer({ scope: 'stored-only', tiers: ['core', 'traffic'], clientFactory: () => scoped })
    const mcp = new Client({ name: 'agent-journey-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await mcp.connect(clientTransport)
    try {
      const targetKey = mode === 'advanced' ? 'booking' : undefined
      const query = { since: '2026-10-20', until: '2026-10-20', sourceId: 'agent-source', agentId: 'chatgpt-user', trust: 'unknown' as const, targetKey }
      const result = await mcp.callTool({ name: 'canonry_traffic_agent_journeys', arguments: { project: 'test-proj', ...query } })
      expect(result.isError).not.toBe(true)
      const listing = agentJourneysResponseSchema.parse(result.structuredContent)
      expect(listing).toEqual(await scoped.trafficAgentJourneys('test-proj', query))
      expect(listing.scope).toMatchObject({ mode, targetKey: targetKey ?? null, planRevision: mode === 'advanced' ? 1 : null, attribution: mode === 'advanced' ? 'current-plan-url' : 'project' })
      const journeyId = listing.journeys[0]!.id
      const detail = await mcp.callTool({ name: 'canonry_traffic_agent_journey', arguments: { project: 'test-proj', journeyId, ...query, limit: 1, offset: 2 } })
      expect(detail.isError).not.toBe(true)
      expect(agentJourneyDetailResponseSchema.parse(detail.structuredContent)).toEqual(await scoped.trafficAgentJourney('test-proj', journeyId, { ...query, limit: 1, offset: 2 }))
      const forbidden = await mcp.callTool({ name: 'canonry_traffic_agent_journeys', arguments: { project: 'other-project', ...query } })
      expect(forbidden.isError).toBe(true)
      expect(forbidden.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } })
    } finally { await mcp.close(); await server.close() }
  })

  it.each([
    [['agent-journeys', 'test-proj', '--trust', 'probably']],
    [['agent-journeys', 'test-proj', '--trust', 'likely_fake']],
    [['agent-journeys', 'test-proj', '--limit', '201']],
    [['agent-journey', 'test-proj']],
  ])('rejects invalid agent journey arguments %j', async args => {
    const result = await invokeCli(['traffic', ...args, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(parseJsonOutput(result.stderr)).toMatchObject({ error: { code: 'CLI_USAGE_ERROR' } })
  })

  it('reads sample JSON and JSONL from the stored API with exact timestamps and no private hash', async () => {
    const project = db.select().from(projects).all()[0]!
    const at = '2026-10-10T12:00:00.123Z'
    db.insert(trafficSources).values({ id: 'samples-source', projectId: project.id, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: at, updatedAt: at }).run()
    db.insert(rawEventSamples).values({ id: 'sample', projectId: project.id, sourceId: 'samples-source', ts: at, eventType: 'ai_referral', ipHash: 'never-public', pathNormalized: '/blog/post', status: 200, refererHost: 'chatgpt.com', userAgent: 'Synthetic Browser', classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: { operator: 'OpenAI', product: 'ChatGPT', sourceDomain: 'chatgpt.com', evidenceType: 'referer', trafficClass: 'organic' } }, createdAt: at }).run()
    const selection = { kind: 'ai-referral' as const, sourceId: 'samples-source', since: '2026-10-10T00:00:00Z', until: '2026-10-11T00:00:00Z', path: '/blog', limit: 1, offset: 0 }
    const expected = await client.trafficListSamples('test-proj', selection)
    const args = ['traffic', 'samples', 'test-proj', '--kind', selection.kind, '--source', selection.sourceId, '--since', selection.since, '--until', selection.until, '--path', selection.path, '--limit', '1', '--offset', '0']
    const json = await invokeCli([...args, '--format', 'json'])
    expect(json.exitCode, json.stderr).toBeUndefined()
    expect(parseJsonOutput(json.stdout)).toEqual(expected)
    expect(json.stdout).not.toMatch(/ipHash|ip_hash|never-public/)
    expect(expected.samples).toHaveLength(1)
    expect(expected.samples[0]!.ts).toBe(at)
    let streamed = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { streamed += String(chunk); return true })
    try {
      const jsonl = await invokeCli([...args, '--format', 'jsonl'])
      expect(jsonl.exitCode, jsonl.stderr).toBeUndefined()
    } finally { write.mockRestore() }
    expect(streamed.trim().split('\n').map(line => JSON.parse(line))).toEqual(expected.samples.map(sample => ({ project: 'test-proj', windowStart: expected.windowStart, windowEnd: expected.windowEnd, ...sample })))
    const text = await invokeCli(args)
    expect(text.stdout).toContain('Sampled tail, not visits')
    expect(text.stdout).toContain('traffic events')
    expect(text.stdout).toContain('last-24h sample count')
  })

  it('shows the trust verdict of agent samples in text output and JSON', async () => {
    const project = db.select().from(projects).all()[0]!
    const at = '2026-10-10T12:00:00.000Z'
    db.insert(trafficSources).values({ id: 'agent-samples', projectId: project.id, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: at, updatedAt: at }).run()
    const agent = { botId: 'openai-chatgpt-user', operator: 'OpenAI', product: 'ChatGPT-User', verificationStatus: 'claimed_unverified', verificationManifest: null, matchedUserAgent: 'ChatGPT-User' }
    db.insert(rawEventSamples).values([
      { id: 'fake', projectId: project.id, sourceId: 'agent-samples', ts: at, eventType: 'ai_user_fetch', pathNormalized: '/.env', status: 404, userAgent: 'ChatGPT-User', classifierDetailsJson: { crawler: null, aiReferral: null, aiUserFetch: { ...agent, trust: 'likely_fake', trustReasons: ['scanner-path', 'no-ip', 'documented-user-agent'] } }, createdAt: at },
      // Stored before trust existed: no verdict to show.
      { id: 'legacy', projectId: project.id, sourceId: 'agent-samples', ts: '2026-10-10T11:00:00.000Z', eventType: 'ai_user_fetch', pathNormalized: '/pricing', status: 200, userAgent: 'ChatGPT-User', classifierDetailsJson: { crawler: null, aiReferral: null, aiUserFetch: agent }, createdAt: at },
    ]).run()
    const args = ['traffic', 'samples', 'test-proj', '--kind', 'ai-user-fetch', '--source', 'agent-samples', '--since', '2026-10-10T00:00:00Z', '--until', '2026-10-11T00:00:00Z']
    const json = parseJsonOutput((await invokeCli([...args, '--format', 'json'])).stdout) as { samples: Array<{ id: string; classifier: { aiUserFetch: { trust: string | null } | null } }> }
    expect(json.samples.map(sample => [sample.id, sample.classifier.aiUserFetch?.trust ?? null])).toEqual([['fake', 'likely_fake'], ['legacy', null]])
    const text = (await invokeCli(args)).stdout
    expect(text).toContain('/.env  -  ChatGPT-User (likely_fake)  ChatGPT-User')
    expect(text).toContain('/pricing  -  ChatGPT-User  ChatGPT-User')
  })

  it.each([['--kind', 'visitor'], ['--limit', '501'], ['--since-minutes', '0'], ['--since', 'invalid']])('rejects invalid samples option %s %s as a user error', async (flag, value) => {
    const result = await invokeCli(['traffic', 'samples', 'test-proj', flag, value, '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE_ERROR')
  })

  it('rejects traffic connect cloud-run without --gcp-project', async () => {
    const result = await invokeCli([
      'traffic',
      'connect',
      'cloud-run',
      'test-proj',
      '--service-account-key',
      '/tmp/does-not-exist.json',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--gcp-project/)
  })

  it('rejects traffic connect cloud-run without --service-account-key', async () => {
    const result = await invokeCli([
      'traffic',
      'connect',
      'cloud-run',
      'test-proj',
      '--gcp-project',
      'openclaw-nyc',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--service-account-key/)
  })

  it('reports a clear error when the key file cannot be read', async () => {
    const result = await invokeCli([
      'traffic',
      'connect',
      'cloud-run',
      'test-proj',
      '--gcp-project',
      'openclaw-nyc',
      '--service-account-key',
      '/tmp/this-file-really-does-not-exist-xyzzy.json',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/failed to read --service-account-key/i)
  })

  it('connects Cloudflare and writes secret-free Worker artifacts', async () => {
    const outputDirectory = path.join(tmpDir, 'cloudflare-worker')
    const result = await invokeCli([
      'traffic',
      'connect',
      'cloudflare',
      'test-proj',
      '--zone-id',
      'zone_abc',
      '--account-id',
      'account_xyz',
      '--output-dir',
      outputDirectory,
      '--format',
      'json',
    ])

    expect(result.exitCode, result.stderr).toBeUndefined()
    const summary = parseJsonOutput(result.stdout) as {
      sourceId: string
      deliveryMode: string
      outputDirectory: string
      files: { workerScript: string; wranglerConfig: string }
      deployment: string
    }
    expect(summary.deliveryMode).toBe('direct-push')
    expect(summary.outputDirectory).toBe(outputDirectory)
    expect(summary.deployment).toBe('not-requested')
    expect(summary.files.workerScript).toBe(path.join(outputDirectory, 'worker.js'))
    expect(summary.files.wranglerConfig).toBe(path.join(outputDirectory, 'wrangler.toml'))

    const configOnDisk = parse(fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8')) as {
      cloudflareTraffic?: {
        connections?: Array<{
          sourceId: string
          deliveryMode: string
          bearerToken: string
          hmacSecret: string
        }>
      }
    }
    const credential = configOnDisk.cloudflareTraffic?.connections?.[0]
    expect(credential?.sourceId).toBe(summary.sourceId)
    expect(credential?.deliveryMode).toBe('direct-push')

    const workerScript = fs.readFileSync(summary.files.workerScript, 'utf-8')
    const wranglerToml = fs.readFileSync(summary.files.wranglerConfig, 'utf-8')
    for (const output of [result.stdout, workerScript, wranglerToml]) {
      expect(output).not.toContain(credential!.bearerToken)
      expect(output).not.toContain(credential!.hmacSecret)
    }
    expect(workerScript).toContain('CANONRY_BEARER_TOKEN')
    expect(workerScript).toContain('CANONRY_HMAC_SECRET')
    expect(wranglerToml).toContain('CANONRY_DELIVERY_MODE')
    expect(wranglerToml).toContain('CANONRY_BEARER_TOKEN')

    const row = db.select().from(trafficSources).all()[0]
    expect(row?.sourceType).toBe('cloudflare')
    expect(row?.configJson).toMatchObject({ deliveryMode: 'direct-push' })
  })

  it('connects a page-view Cloudflare Worker end to end and rejects contradictory flags', async () => {
    const conflicting = await invokeCli(['traffic', 'connect', 'cloudflare', 'test-proj', '--forward-page-views', '--no-forward-page-views', '--format', 'json'])
    expect(conflicting.exitCode).toBe(1)
    expect((parseJsonOutput(conflicting.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR')
    expect(db.select().from(trafficSources).all()).toHaveLength(0)

    const outputDirectory = path.join(tmpDir, 'page-view-worker')
    const result = await invokeCli(['traffic', 'connect', 'cloudflare', 'test-proj', '--forward-page-views', '--output-dir', outputDirectory, '--format', 'json'])
    expect(result.exitCode, result.stderr).toBeUndefined()
    const summary = parseJsonOutput(result.stdout) as { forwardPageViews: boolean; workerVersion: string; files: { workerScript: string } }
    expect(summary.forwardPageViews).toBe(true)
    expect(summary.workerVersion).toMatch(/\+page-views$/)
    expect(fs.readFileSync(summary.files.workerScript, 'utf-8')).toContain('function isPageView')
    expect(db.select().from(trafficSources).all()[0]?.configJson).toMatchObject({ forwardPageViews: true })
  })

  it('requires a zone id and explicit route acknowledgement before Cloudflare deploy', async () => {
    const withoutZone = await invokeCli([
      'traffic', 'connect', 'cloudflare', 'test-proj', '--deploy', '--confirm-route',
    ])
    expect(withoutZone.exitCode).not.toBe(0)
    expect(withoutZone.stderr).toMatch(/--zone-id/)

    const withoutConfirmation = await invokeCli([
      'traffic', 'connect', 'cloudflare', 'test-proj', '--deploy', '--zone-id', 'zone_abc',
    ])
    expect(withoutConfirmation.exitCode).not.toBe(0)
    expect(withoutConfirmation.stderr).toMatch(/--confirm-route/)
    expect(db.select().from(trafficSources).all()).toHaveLength(0)
  })

  it('connects via service-account key file and persists creds + source row', async () => {
    const keyPath = path.join(tmpDir, 'sa-key.json')
    fs.writeFileSync(
      keyPath,
      JSON.stringify({
        client_email: 'sa@openclaw-nyc.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
      }),
      'utf-8',
    )

    const result = await invokeCli([
      'traffic',
      'connect',
      'cloud-run',
      'test-proj',
      '--gcp-project',
      'openclaw-nyc',
      '--service',
      'openclaw-nyc',
      '--location',
      'us-east1',
      '--service-account-key',
      keyPath,
      '--format',
      'json',
    ])

    expect(result.exitCode).toBeUndefined()
    const dto = parseJsonOutput(result.stdout) as { id: string; status: string; config: Record<string, unknown> }
    expect(dto.id).toBeTruthy()
    expect(dto.status).toBe('connected')
    expect(dto.config.gcpProjectId).toBe('openclaw-nyc')
    expect(dto.config.serviceName).toBe('openclaw-nyc')

    const rows = db.select().from(trafficSources).all()
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('connected')

    // Credentials persisted to ~/.canonry/config.yaml (CANONRY_CONFIG_DIR points at tmpDir)
    const yaml = parse(fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8')) as {
      cloudRun?: { connections?: Array<{ projectName: string; clientEmail: string }> }
    }
    expect(yaml.cloudRun?.connections?.[0]?.projectName).toBe('test-proj')
    expect(yaml.cloudRun?.connections?.[0]?.clientEmail).toBe('sa@openclaw-nyc.iam.gserviceaccount.com')
  })

  it('rejects traffic connect wordpress without --url', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'wordpress', 'test-proj',
      '--username', 'bot',
      '--app-password', 'pw',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--url/)
  })

  it('rejects traffic connect wordpress without --username', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'wordpress', 'test-proj',
      '--url', 'https://example.com',
      '--app-password', 'pw',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--username/)
  })

  it('rejects traffic connect wordpress without --app-password or --app-password-file', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'wordpress', 'test-proj',
      '--url', 'https://example.com',
      '--username', 'bot',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--app-password/)
  })

  it('rejects traffic connect wordpress when both --app-password and --app-password-file are passed', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'wordpress', 'test-proj',
      '--url', 'https://example.com',
      '--username', 'bot',
      '--app-password', 'pw',
      '--app-password-file', '/tmp/pw.txt',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not both/i)
  })

  it('reports a clear error when --app-password-file cannot be read', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'wordpress', 'test-proj',
      '--url', 'https://example.com',
      '--username', 'bot',
      '--app-password-file', '/tmp/this-file-really-does-not-exist-wpxyzzy.txt',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/failed to read --app-password-file/i)
  })

  it('rejects traffic connect vercel without --project-id', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--team-id', 'team_xyz',
      '--token', 'vcp_test',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--project-id/)
  })

  it('rejects traffic connect vercel without --team-id', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--project-id', 'prj_abc',
      '--token', 'vcp_test',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--team-id/)
  })

  it('rejects traffic connect vercel without --token or --token-file', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--project-id', 'prj_abc',
      '--team-id', 'team_xyz',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--token/)
  })

  it('rejects traffic connect vercel when both --token and --token-file are passed', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--project-id', 'prj_abc',
      '--team-id', 'team_xyz',
      '--token', 'vcp_test',
      '--token-file', '/tmp/token.txt',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not both/i)
  })

  it('reports a clear error when --token-file cannot be read', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--project-id', 'prj_abc',
      '--team-id', 'team_xyz',
      '--token-file', '/tmp/this-file-really-does-not-exist-vercelxyzzy.txt',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/failed to read --token-file/i)
  })

  it('rejects traffic connect vercel with an invalid --environment', async () => {
    const result = await invokeCli([
      'traffic', 'connect', 'vercel', 'test-proj',
      '--project-id', 'prj_abc',
      '--team-id', 'team_xyz',
      '--token', 'vcp_test',
      '--environment', 'staging',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--environment must be/i)
  })

  it('rejects traffic sync without --source', async () => {
    const result = await invokeCli(['traffic', 'sync', 'test-proj'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--source/)
  })

  it('reports 404 for an unknown traffic source on sync', async () => {
    const result = await invokeCli([
      'traffic',
      'sync',
      'test-proj',
      '--source',
      'no-such-source-id',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not found/i)
  })

  it('errors on bare `traffic` invocation', async () => {
    const result = await invokeCli(['traffic'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/unknown traffic subcommand/i)
  })

  it('rejects traffic reset without --source', async () => {
    const result = await invokeCli(['traffic', 'reset', 'test-proj', '--advance-to-now'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--source/)
  })

  it('rejects traffic reset without --advance-to-now', async () => {
    const result = await invokeCli(['traffic', 'reset', 'test-proj', '--source', 'some-id'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--advance-to-now/i)
  })

  it('reports 404 for an unknown traffic source on reset', async () => {
    const result = await invokeCli([
      'traffic',
      'reset',
      'test-proj',
      '--source',
      'no-such-source-id',
      '--advance-to-now',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/not found/i)
  })

  it('lists no sources when none are connected (`traffic sources --format json`)', async () => {
    const result = await invokeCli(['traffic', 'sources', 'test-proj', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const body = parseJsonOutput(result.stdout) as { sources: unknown[] }
    expect(Array.isArray(body.sources)).toBe(true)
    expect(body.sources.length).toBe(0)
  })

  it('lists the source after connect (`traffic sources --format json`)', async () => {
    const keyPath = path.join(tmpDir, 'sa-key.json')
    fs.writeFileSync(keyPath, JSON.stringify({
      client_email: 'sa@openclaw-nyc.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    }), 'utf-8')
    await invokeCli([
      'traffic', 'connect', 'cloud-run', 'test-proj',
      '--gcp-project', 'openclaw-nyc',
      '--service-account-key', keyPath,
    ])

    const result = await invokeCli(['traffic', 'sources', 'test-proj', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const body = parseJsonOutput(result.stdout) as {
      sources: Array<{ sourceType: string; status: string }>
    }
    expect(body.sources.length).toBe(1)
    expect(body.sources[0].sourceType).toBe('cloud-run')
    expect(body.sources[0].status).toBe('connected')
  })

  it('returns empty events with totals=0 when no events have been ingested (`traffic events`)', async () => {
    const result = await invokeCli(['traffic', 'events', 'test-proj', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const body = parseJsonOutput(result.stdout) as {
      windowStart: string
      windowEnd: string
      totals: { crawlerHits: number; aiReferralHits: number }
      series: { granularity: string; points: unknown[] }
      eventRows: { total: number; returned: number; truncated: boolean }
      events: unknown[]
    }
    expect(body.windowStart).toBeTruthy()
    expect(body.windowEnd).toBeTruthy()
    expect(body.totals.crawlerHits).toBe(0)
    expect(body.totals.aiReferralHits).toBe(0)
    expect(body.series.granularity).toBe('hour')
    expect(body.series.points.length).toBeGreaterThan(0)
    expect(body.eventRows).toEqual({ total: 0, returned: 0, truncated: false })
    expect(body.events.length).toBe(0)
  })

  it('rejects an invalid --kind value', async () => {
    const result = await invokeCli([
      'traffic', 'events', 'test-proj', '--kind', 'bogus',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--kind must be/i)
  })

  it('rejects an invalid --granularity value', async () => {
    const result = await invokeCli([
      'traffic', 'events', 'test-proj', '--granularity', 'week',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--granularity must be/i)
  })

  it('rejects a non-numeric --since-minutes without crashing', async () => {
    const result = await invokeCli([
      'traffic', 'events', 'test-proj', '--since-minutes', 'abc',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--since-minutes/)
    expect(result.stderr).not.toMatch(/Invalid time value/)
  })

  it('rejects a non-numeric --limit', async () => {
    const result = await invokeCli([
      'traffic', 'events', 'test-proj', '--limit', 'abc',
    ])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/--limit/)
  })

  it.each(['json', 'jsonl'])('reads the source-free traffic analytics envelope through the live API in %s', async format => {
    const result = await invokeCli(['traffic', 'analytics', 'test-proj', '--period', '7', '--format', format])
    expect(result.exitCode, result.stderr).toBeUndefined()
    expect(parseJsonOutput(result.stdout)).toEqual({ activity: null })
  })

  it('rejects the retired dedicated report command', async () => {
    const result = await invokeCli(['report', 'test-proj', '--format', 'json'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('unknown command: report')
  })

  it('reports no sources for `traffic status` when none are connected', async () => {
    const result = await invokeCli(['traffic', 'status', 'test-proj', '--format', 'json'])
    expect(result.exitCode).toBeUndefined()
    const body = parseJsonOutput(result.stdout) as { sources: unknown[] }
    expect(body.sources.length).toBe(0)
  })

  it('shows why the latest Queue sync stopped in `traffic status`', async () => {
    const project = db.select().from(projects).all().find(row => row.name === 'test-proj')!
    const sourceId = crypto.randomUUID()
    const now = new Date().toISOString()
    db.insert(trafficSources).values({
      id: sourceId, projectId: project.id, sourceType: 'cloudflare', displayName: 'Queue', status: 'connected',
      configJson: { deliveryMode: 'queue-pull' }, queueBacklogCount: 4200, queueBacklogObservedAt: now,
      createdAt: now, updatedAt: now,
    }).run()
    const syncSummary = {
      type: 'cloudflare-queue' as const, stopReason: 'empty-pulls' as const, pulls: 7, emptyPulls: 2, messagesPulled: 500,
      messagesAcknowledged: 500, poisonMessages: 0, skippedUnleasedMessages: 0, acceptedEvents: 480, duplicateEvents: 20,
      backlogAtFirstPull: 4800, backlogAtLastPull: 4200, elapsedMs: 9_000,
    }
    db.insert(runs).values({
      id: crypto.randomUUID(), projectId: project.id, kind: 'traffic-sync', status: 'completed', trigger: 'scheduled',
      sourceId, startedAt: now, finishedAt: now, createdAt: now, syncSummary,
    }).run()

    const text = await invokeCli(['traffic', 'status', 'test-proj'])
    expect(text.stdout).toContain('Queue drain:   no more messages to pull (the rest is leased or not yet visible); 7 pull(s), 500 message(s), 20 redelivered, 9s')
    const json = parseJsonOutput((await invokeCli(['traffic', 'status', 'test-proj', '--format', 'json'])).stdout) as { sources: Array<{ latestRun: { syncSummary?: unknown } }> }
    expect(json.sources[0]!.latestRun.syncSummary).toEqual(syncSummary)
  })
})

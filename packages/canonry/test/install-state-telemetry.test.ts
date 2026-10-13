import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installStatePropertiesSchema, type LocationContext, type SnapshotUsage } from '@ainyc/canonry-contracts'
import {
  adsConnections,
  auditLog,
  backlinkSummaries,
  bingConnections,
  competitors,
  createClient,
  discoverySessions,
  googleAdsConnections,
  googleConnections,
  llmUsageEvents,
  migrate,
  notifications,
  projects,
  queries,
  querySnapshots,
  researchRuns,
  runs,
  schedules,
  trafficSources,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { getAgentProvider } from '../src/agent/providers.js'
import type { CanonryConfig } from '../src/config.js'
import { startInstallStateTelemetry } from '../src/install-state-telemetry.js'

// Once a day the server reports what the install has set up and what it did
// in the last 24 hours, read from its own database and config.

const telemetry = vi.hoisted(() => ({ trackEvent: vi.fn(), isTelemetryEnabled: vi.fn(() => true) }))
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent: telemetry.trackEvent,
  isTelemetryEnabled: telemetry.isTelemetryEnabled,
}))

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BOOT = Date.parse('2026-10-09T12:00:00.000Z')
/** When the first report reads the database: five minutes after boot. */
const FIRST_REPORT = BOOT + 5 * MINUTE
const inWindow = new Date(FIRST_REPORT - 2 * HOUR).toISOString()
const beforeWindow = new Date(FIRST_REPORT - 25 * HOUR).toISOString()

const installStates = () => telemetry.trackEvent.mock.calls.filter(([event]) => event === 'install.state').map(([, props]) => props as Record<string, unknown>)

function tempDb(): DatabaseClient {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-install-state-'))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  return db
}

const id = () => crypto.randomUUID()
const NORTH: LocationContext = { label: 'north', city: 'North City', region: 'NC', country: 'US' }
const SOUTH: LocationContext = { label: 'south', city: 'South City', region: 'SC', country: 'US' }

function answerUsage(costMicros: number | null): SnapshotUsage {
  return {
    inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200, searchCount: 1,
    pricingTier: 'standard', estimatedCostMicros: costMicros, priceSource: costMicros === null ? null : 'default',
  }
}

/** Two projects with a little of everything, plus rows on both sides of the 24-hour window. */
function seedInstall(db: DatabaseClient): void {
  const at = inWindow
  const alpha = id()
  const beta = id()
  db.insert(projects).values([
    { id: alpha, name: 'alpha', displayName: 'Alpha', canonicalDomain: 'alpha.example', country: 'US', language: 'en', locations: [NORTH, SOUTH], createdAt: at, updatedAt: at },
    { id: beta, name: 'beta', displayName: 'Beta', canonicalDomain: 'beta.example', country: 'US', language: 'en', locations: [NORTH], createdAt: at, updatedAt: at },
  ]).run()
  db.insert(queries).values(['a1', 'a2', 'a3'].map(query => ({ id: id(), projectId: alpha, query, createdAt: at }))
    .concat(['b1', 'b2'].map(query => ({ id: id(), projectId: beta, query, createdAt: at })))).run()
  db.insert(competitors).values([
    { id: id(), projectId: alpha, domain: 'rival-one.example', createdAt: at },
    { id: id(), projectId: alpha, domain: 'rival-two.example', createdAt: at },
  ]).run()
  db.insert(schedules).values([
    { id: id(), projectId: alpha, kind: 'answer-visibility', cronExpr: '0 6 * * *', enabled: true, createdAt: at, updatedAt: at },
    { id: id(), projectId: beta, kind: 'traffic-sync', cronExpr: '0 * * * *', enabled: false, createdAt: at, updatedAt: at },
  ]).run()
  db.insert(notifications).values([
    { id: id(), projectId: alpha, channel: 'webhook', config: { url: 'https://hooks.example/a', events: ['run.completed'] }, enabled: true, createdAt: at, updatedAt: at },
    { id: id(), projectId: alpha, channel: 'webhook', config: { url: 'https://agent.example/a', events: ['run.completed'], source: 'agent' } as never, enabled: true, createdAt: at, updatedAt: at },
    { id: id(), projectId: beta, channel: 'webhook', config: { url: 'https://hooks.example/b', events: ['run.completed'] }, enabled: false, createdAt: at, updatedAt: at },
  ]).run()
  db.insert(trafficSources).values([
    { id: id(), projectId: alpha, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: at, updatedAt: at },
    { id: id(), projectId: alpha, sourceType: 'vercel', displayName: 'Old site', status: 'archived', archivedAt: at, createdAt: at, updatedAt: at },
    { id: id(), projectId: beta, sourceType: 'cloud-run', displayName: 'API', status: 'connected', createdAt: at, updatedAt: at },
    { id: id(), projectId: beta, sourceType: 'wordpress', displayName: 'Blog', status: 'error', createdAt: at, updatedAt: at },
  ]).run()
  db.insert(googleConnections).values([
    { id: id(), domain: 'alpha.example', connectionType: 'gsc', createdAt: at, updatedAt: at },
    { id: id(), domain: 'alpha.example', connectionType: 'ga4', createdAt: at, updatedAt: at },
  ]).run()
  // A database that has not been through the boot-time credential move still has the legacy key column.
  db.run(sql`INSERT INTO ga_connections (id, project_id, property_id, client_email, private_key, created_at, updated_at) VALUES (${id()}, ${beta}, '123', 'svc@example.iam', 'legacy', ${at}, ${at})`)
  db.insert(bingConnections).values({ id: id(), domain: 'alpha.example', createdAt: at, updatedAt: at }).run()
  const summary = { targetDomain: 'alpha.example', totalLinkingDomains: 10, totalHosts: 20, top10HostsShare: '0.5', queriedAt: at, createdAt: at }
  db.insert(backlinkSummaries).values([
    { id: id(), projectId: alpha, source: 'commoncrawl', release: 'CC-2026-08', ...summary },
    { id: id(), projectId: alpha, source: 'commoncrawl', release: 'CC-2026-09', ...summary },
    { id: id(), projectId: beta, source: 'bing-webmaster', release: 'bing', ...summary },
  ]).run()
  db.insert(adsConnections).values({ id: id(), projectId: alpha, adAccountId: 'act_1', createdAt: at, updatedAt: at }).run()
  db.insert(googleAdsConnections).values([
    { id: id(), projectId: alpha, selectedCustomerId: '111', createdAt: at, updatedAt: at },
    { id: id(), projectId: beta, createdAt: at, updatedAt: at },
  ]).run()

  // Sweeps and audits: two sweeps and an audit in the window; a probe and an older sweep are not counted.
  const sweep = id()
  db.insert(runs).values([
    { id: sweep, projectId: alpha, kind: 'answer-visibility', trigger: 'manual', status: 'completed', createdAt: at },
    { id: id(), projectId: alpha, kind: 'answer-visibility', trigger: 'scheduled', status: 'completed', createdAt: at },
    { id: id(), projectId: alpha, kind: 'answer-visibility', trigger: 'probe', status: 'completed', createdAt: at },
    { id: id(), projectId: beta, kind: 'answer-visibility', trigger: 'scheduled', status: 'completed', createdAt: beforeWindow },
    { id: id(), projectId: alpha, kind: 'site-audit', trigger: 'manual', status: 'completed', createdAt: at },
  ]).run()
  const snapshot = (provider: string, usage: SnapshotUsage | null, createdAt = at) => ({ id: id(), runId: sweep, provider, citationState: 'cited', usage, dispatchMode: 'sync' as const, createdAt })
  db.insert(querySnapshots).values([
    snapshot('gemini', answerUsage(1_800)),
    snapshot('gemini', answerUsage(1_800)),
    // No price for this model, so the window's cost is unknown.
    snapshot('openai', answerUsage(null)),
    // A browser answer is a call with no token usage.
    snapshot('cdp:chatgpt', null),
    snapshot('gemini', answerUsage(1_800), beforeWindow),
  ]).run()
  db.insert(researchRuns).values([
    { id: id(), projectId: alpha, status: 'completed', provider: 'openai', resolvedModel: 'gpt-5', totalQueries: 5, completedQueries: 4, failedQueries: 1, createdAt: at },
    { id: id(), projectId: beta, status: 'completed', provider: 'gemini', resolvedModel: 'gemini-flash', totalQueries: 3, completedQueries: 3, createdAt: beforeWindow },
  ]).run()
  db.insert(discoverySessions).values([
    { id: id(), projectId: alpha, status: 'completed', seedProviders: ['gemini', 'openai'], seedCountRaw: 40, probeCount: 10, createdAt: at },
    // Failed before seeding: no provider was called.
    { id: id(), projectId: beta, status: 'failed', createdAt: at },
  ]).run()
  const llm = (feature: string, inputTokens: number, outputTokens: number, costMillicents: number, createdAt = at) => ({
    id: id(), projectId: alpha, feature, provider: 'anthropic', model: 'claude-test', inputTokens, outputTokens, costMillicents, createdAt,
  })
  db.insert(llmUsageEvents).values([
    llm('aero.turn', 1_000, 100, 450),
    llm('aero.turn', 2_000, 200, 900),
    llm('aero.turn', 5_000, 500, 2_000, beforeWindow),
    llm('sentiment', 7_000, 700, 3_000),
  ]).run()
  const audit = (action: string, createdAt = at) => ({ id: id(), projectId: alpha, actor: 'scheduler', action, entityType: 'notification', createdAt })
  db.insert(auditLog).values([
    audit('notification.sent'),
    audit('notification.sent'),
    audit('notification.failed'),
    audit('notification.sent', beforeWindow),
  ]).run()
}

beforeEach(() => {
  telemetry.trackEvent.mockReset()
  telemetry.isTelemetryEnabled.mockReset().mockReturnValue(true)
  vi.useFakeTimers()
  vi.setSystemTime(BOOT)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('install.state contents', () => {
  it('reports setup counts, connected integrations and 24-hour usage from the database and config', () => {
    const db = tempDb()
    seedInstall(db)
    const claudeModel = getAgentProvider('claude').defaultModel
    const config = {
      apiKey: 'test',
      database: ':memory:',
      providers: { gemini: { apiKey: 'g' }, openai: { apiKey: 'o' } },
      cdp: { host: '127.0.0.1' },
      agent: { provider: 'claude', model: claudeModel },
    } as unknown as CanonryConfig
    const stop = startInstallStateTelemetry({ db, config, agentEnabled: true, isBacklinksInstalled: () => false })
    onTestFinished(stop)

    vi.advanceTimersByTime(5 * MINUTE)

    const [state] = installStates()
    expect(state).toEqual({
      providers: ['gemini', 'openai', 'cdp:chatgpt'],
      integrations: ['gsc', 'ga4', 'bing', 'google_ads', 'openai_ads', 'traffic_cloudflare', 'traffic_cloud_run', 'wordpress', 'backlinks', 'webhook', 'agent_webhook', 'cdp'],
      counts: {
        projects: 2,
        queries: 5,
        competitors: 2,
        locations: 3,
        schedules: 1,
        webhooks: 1,
        agentWebhooks: 1,
        trafficSources: 3,
        googleConnections: 3,
        bingConnections: 1,
        backlinkSources: 2,
        adsAccounts: 2,
      },
      usage24h: {
        sweeps: 2,
        audits: 1,
        // 4 sweep answers + 4 research answers + 2 discovery seeds + 10 discovery probes.
        providerCalls: 20,
        inputTokens: 3_000,
        outputTokens: 600,
        aeroModelCalls: 2,
        aeroInputTokens: 3_000,
        aeroOutputTokens: 300,
        aeroCostMicros: 13_500,
        webhookDeliveries: 2,
      },
      providerCalls24h: { gemini: 13, openai: 6, 'cdp:chatgpt': 1 },
      agentProvider: 'claude',
      agentModel: claudeModel,
      uptimeBucket: '5m_to_30m',
      installSource: expect.stringMatching(/^(npm|homebrew|docker|source)$/),
    })
    expect(installStatePropertiesSchema.parse(state)).toEqual(state)
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(1_400)
  })

  it('sends known zeros for an idle install, and never a model id outside the catalog', () => {
    const db = tempDb()
    const config = {
      apiKey: 'test',
      database: ':memory:',
      agent: { provider: 'openai', model: 'ft:gpt-4o:acme-corp:private' },
      wordpress: { connections: [{ projectName: 'alpha', url: 'https://blog.example', username: 'u', appPassword: 'p', defaultEnv: 'live', createdAt: '', updatedAt: '' }] },
    } as unknown as CanonryConfig
    const stop = startInstallStateTelemetry({ db, config, agentEnabled: true, isBacklinksInstalled: () => true })
    onTestFinished(stop)

    vi.advanceTimersByTime(5 * MINUTE)

    expect(installStates()).toEqual([{
      providers: [],
      integrations: ['wordpress', 'backlinks'],
      counts: {
        projects: 0, queries: 0, competitors: 0, locations: 0, schedules: 0, webhooks: 0, agentWebhooks: 0,
        trafficSources: 0, googleConnections: 0, bingConnections: 0, backlinkSources: 0, adsAccounts: 0,
      },
      usage24h: {
        sweeps: 0, audits: 0, providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0,
        aeroModelCalls: 0, aeroInputTokens: 0, aeroOutputTokens: 0, aeroCostMicros: 0, webhookDeliveries: 0,
      },
      agentProvider: 'openai',
      uptimeBucket: '5m_to_30m',
      installSource: expect.stringMatching(/^(npm|homebrew|docker|source)$/),
    }])
  })

  it('reads the 24-hour window through indexes, never by walking a whole table', () => {
    const db = tempDb()
    seedInstall(db)
    const prepare = vi.spyOn(db.$client, 'prepare')
    const stop = startInstallStateTelemetry({ db, config: { apiKey: 'test', database: ':memory:' } as unknown as CanonryConfig, agentEnabled: false, isBacklinksInstalled: () => false })
    onTestFinished(stop)

    vi.advanceTimersByTime(5 * MINUTE)
    expect(installStates()).toHaveLength(1)
    const statements = [...new Set(prepare.mock.calls.map(([query]) => query))]
    prepare.mockRestore()

    const planOf = (table: string): string => {
      const reads = statements.filter(query => query.startsWith('select') && query.includes(`from "${table}"`) && query.includes('created_at'))
      expect(reads.length).toBeGreaterThan(0)
      return reads.map(query => db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all(...Array.from({ length: query.split('?').length - 1 }, () => null))
        .map(row => (row as { detail: string }).detail).join(' | ')).join(' || ')
    }
    // Grouping on the bare provider column would walk its index over every stored answer.
    const searches = (table: string, index: string) => new RegExp(`SEARCH ${table} USING (COVERING )?INDEX ${index} `)
    expect(planOf('query_snapshots')).toMatch(searches('query_snapshots', 'idx_snapshots_created_at'))
    expect(planOf('runs')).toMatch(searches('runs', 'idx_runs_project_kind_created'))
    expect(planOf('research_runs')).toMatch(searches('research_runs', 'idx_research_runs_project_created'))
    expect(planOf('discovery_sessions')).toMatch(searches('discovery_sessions', 'idx_discovery_sessions_project_created'))
    expect(planOf('llm_usage_events')).toMatch(searches('llm_usage_events', 'idx_llm_usage_feature_created'))
    expect(planOf('audit_log')).toMatch(searches('audit_log', 'idx_audit_log_created'))
  })

  it('leaves the Aero settings out when Aero is disabled', () => {
    const config = { apiKey: 'test', database: ':memory:', agent: { provider: 'claude' } } as unknown as CanonryConfig
    const stop = startInstallStateTelemetry({ db: tempDb(), config, agentEnabled: false, isBacklinksInstalled: () => false })
    onTestFinished(stop)

    vi.advanceTimersByTime(5 * MINUTE)

    const [state] = installStates()
    expect(state).not.toHaveProperty('agentProvider')
    expect(state).not.toHaveProperty('agentModel')
  })
})

describe('install.state schedule', () => {
  const config = { apiKey: 'test', database: ':memory:' } as unknown as CanonryConfig

  it('reports a few minutes after start, then once a day, until stopped', () => {
    const stop = startInstallStateTelemetry({ db: tempDb(), config, agentEnabled: false, isBacklinksInstalled: () => false })
    vi.advanceTimersByTime(5 * MINUTE - 1)
    expect(installStates()).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(installStates().map(state => state.uptimeBucket)).toEqual(['5m_to_30m'])
    vi.advanceTimersByTime(24 * HOUR - 1)
    expect(installStates()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(installStates().map(state => state.uptimeBucket)).toEqual(['5m_to_30m', '30m_or_more'])

    stop()
    vi.advanceTimersByTime(48 * HOUR)
    expect(installStates()).toHaveLength(2)
  })

  it('sends nothing while telemetry is off, and keeps the daily schedule', () => {
    telemetry.isTelemetryEnabled.mockReturnValue(false)
    const stop = startInstallStateTelemetry({ db: tempDb(), config, agentEnabled: false, isBacklinksInstalled: () => false })
    onTestFinished(stop)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(telemetry.isTelemetryEnabled).toHaveBeenCalledTimes(1)
    expect(installStates()).toHaveLength(0)

    telemetry.isTelemetryEnabled.mockReturnValue(true)
    vi.advanceTimersByTime(24 * HOUR)
    expect(installStates()).toHaveLength(1)
  })

  it('keeps reporting after a read fails', () => {
    const db = tempDb()
    let fail = true
    const backlinks = vi.fn(() => {
      if (fail) throw new Error('disk unavailable')
      return false
    })
    const stop = startInstallStateTelemetry({ db, config, agentEnabled: false, isBacklinksInstalled: backlinks })
    onTestFinished(stop)
    vi.advanceTimersByTime(5 * MINUTE)
    expect(installStates()).toHaveLength(0)

    fail = false
    vi.advanceTimersByTime(24 * HOUR)
    expect(installStates()).toHaveLength(1)
  })

  it('never holds the process open', () => {
    vi.useRealTimers()
    const timers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length
    const before = timers()
    const stop = startInstallStateTelemetry({ db: tempDb(), config, agentEnabled: false, isBacklinksInstalled: () => false })
    try {
      expect(timers()).toBe(before)
    } finally {
      stop()
    }
  })
})

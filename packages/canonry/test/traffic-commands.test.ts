import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parse } from 'yaml'
import { createClient, migrate, apiKeys, trafficSources } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'
import { invokeCli, parseJsonOutput } from './cli-test-utils.js'

describe('traffic CLI commands', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let db: ReturnType<typeof createClient>
  let close: () => Promise<void>

  beforeEach(async () => {
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

    await client.putProject('test-proj', {
      displayName: 'Test Project',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
  })

  afterEach(async () => {
    await close()
    if (origConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = origConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
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
})

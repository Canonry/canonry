import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = []
  const errors: string[] = []
  const origLog = console.log
  const origError = console.error
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  console.error = (...args: unknown[]) => errors.push(args.join(' '))
  return fn().finally(() => {
    console.log = origLog
    console.error = origError
  }).then(() => ({ stdout: logs.join('\n'), stderr: errors.join('\n') }))
}

describe('analytics command', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-analytics-test-${crypto.randomUUID()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    origConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = tmpDir

    const dbPath = path.join(tmpDir, 'data.db')
    const configPath = path.join(tmpDir, 'config.yaml')

    const db = createClient(dbPath)
    migrate(db)

    const apiKeyPlain = `cnry_${crypto.randomBytes(16).toString('hex')}`
    const hashed = crypto.createHash('sha256').update(apiKeyPlain).digest('hex')
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'test', keyHash: hashed, keyPrefix: apiKeyPlain.slice(0, 8), createdAt: new Date().toISOString() }).run()

    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    config.apiUrl = `http://127.0.0.1:${port}`
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(config.apiUrl, apiKeyPlain)

    await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
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

  it('prints metrics section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
    expect(stdout).toMatch(/Citation Rate Trends/)
    expect(stdout).toMatch(/Overall:/)
  })

  it('prints latest model evidence and ordered attribution events', async () => {
    const metricsSpy = vi.spyOn(ApiClient.prototype, 'getAnalyticsMetrics').mockResolvedValue({
      window: '30d',
      buckets: [],
      overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
      byProvider: {},
      trend: 'stable',
      mentionTrend: 'stable',
      queryChanges: [],
      modelAttribution: {
        claude: {
          latestObservation: {
            observedAt: '2026-07-14T12:00:00.000Z',
            state: { status: 'known', model: 'claude-sonnet-5' },
          },
          events: [{
            observedAt: '2026-07-10T12:00:00.000Z',
            bucketStartDate: '2026-07-10T00:00:00.000Z',
            from: { status: 'known', model: 'claude-opus-5' },
            to: { status: 'known', model: 'claude-sonnet-5' },
          }],
        },
      },
    })
    try {
      const { showAnalytics } = await import('../src/commands/analytics.js')
      const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'metrics' }))
      expect(stdout).toContain('Model Evidence:')
      expect(stdout).toContain('claude: latest known claude-sonnet-5 at 2026-07-14T12:00:00.000Z')
      expect(stdout).toContain('2026-07-10T12:00:00.000Z  known claude-opus-5 → known claude-sonnet-5')
    } finally {
      metricsSpy.mockRestore()
    }
  })

  it('prints gap analysis section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'gaps' }))
    expect(stdout).toMatch(/Brand Gap Analysis/)
    expect(stdout).toMatch(/Cited:/)
    expect(stdout).toMatch(/Gap:/)
    expect(stdout).toMatch(/Uncited:/)
  })

  it('prints source breakdown section for empty project', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', { feature: 'sources' }))
    expect(stdout).toMatch(/Source Origin Breakdown/)
  })

  it('prints all sections when no feature is specified', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const { stdout } = await captureOutput(() => showAnalytics('test-proj', {}))
    expect(stdout).toMatch(/Citation Rate Trends/)
    expect(stdout).toMatch(/Brand Gap Analysis/)
    expect(stdout).toMatch(/Source Origin Breakdown/)
  })

  it('outputs valid JSON when --format json is set', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { format: 'json' })
    } finally {
      console.log = origLog
    }
    const output = logs.join('\n')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty('metrics')
    expect(parsed).toHaveProperty('gaps')
    expect(parsed).toHaveProperty('sources')
  })

  it('outputs only the requested feature when --feature is set with --format json', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json' })
    } finally {
      console.log = origLog
    }
    const parsed = JSON.parse(logs.join('\n'))
    expect(parsed).toHaveProperty('metrics')
    expect(parsed).not.toHaveProperty('gaps')
    expect(parsed).not.toHaveProperty('sources')
  })

  it('metrics JSON passes through the per-bucket provider contract (byProvider + buckets)', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json' })
    } finally {
      console.log = origLog
    }
    const metrics = JSON.parse(logs.join('\n')).metrics as { byProvider: unknown; buckets: unknown[] }
    // The CLI emits the full BrandMetricsDto, so the per-bucket provider
    // breakdown the dashboard chart consumes is reachable via `--format json`
    // (parity). Per-bucket content is asserted in api-routes analytics.test.ts.
    expect(typeof metrics.byProvider).toBe('object')
    expect(Array.isArray(metrics.buckets)).toBe(true)
  })

  it('passes window param to metrics endpoint', async () => {
    const { showAnalytics } = await import('../src/commands/analytics.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showAnalytics('test-proj', { feature: 'metrics', format: 'json', window: '7d' })
    } finally {
      console.log = origLog
    }
    const parsed = JSON.parse(logs.join('\n'))
    expect((parsed.metrics as { window: string }).window).toBe('7d')
  })
})

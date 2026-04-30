import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, apiKeys, gaTrafficSnapshots } from '@ainyc/canonry-db'
import { createServer } from '../src/server.js'
import { ApiClient } from '../src/client.js'

describe('canonry ga attribution --format json', () => {
  let tmpDir: string
  let origConfigDir: string | undefined
  let client: ApiClient
  let close: () => Promise<void>
  let db: ReturnType<typeof createClient>

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `canonry-ga-attr-${crypto.randomUUID()}`)
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

    const now = new Date().toISOString()
    const config = {
      apiUrl: 'http://localhost:0',
      database: dbPath,
      apiKey: apiKeyPlain,
      providers: { gemini: { apiKey: 'test-key' } },
      ga4: {
        connections: [
          {
            projectName: 'test-proj',
            propertyId: '999888',
            clientEmail: 'sa@test.iam.gserviceaccount.com',
            privateKey: 'fake-key',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    }

    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    const app = await createServer({ config: config as Parameters<typeof createServer>[0]['config'], db, logger: false })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const serverUrl = `http://127.0.0.1:${port}`

    config.apiUrl = serverUrl
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8')

    close = () => app.close()
    client = new ApiClient(serverUrl, apiKeyPlain)
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

  it('exposes direct as a named channel in trend JSON', async () => {
    const project = await client.putProject('test-proj', {
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })

    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    const daysAgo = (n: number): string => {
      const d = new Date()
      d.setDate(d.getDate() - n)
      return d.toISOString().slice(0, 10)
    }

    // gaTrafficSummaries row so totalSessions/share calculations work
    const { gaTrafficSummaries } = await import('@ainyc/canonry-db')
    db.insert(gaTrafficSummaries).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      periodStart: daysAgo(30),
      periodEnd: today,
      totalSessions: 100,
      totalOrganicSessions: 20,
      totalUsers: 80,
      syncedAt: now,
    }).run()

    // Per-page snapshots: 50 direct sessions in current 7d, 25 in prev 7d
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      date: daysAgo(3),
      landingPage: '/__attr-cli-current',
      sessions: 60,
      organicSessions: 0,
      directSessions: 50,
      users: 50,
      syncedAt: now,
    }).run()
    db.insert(gaTrafficSnapshots).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      date: daysAgo(10),
      landingPage: '/__attr-cli-prev',
      sessions: 30,
      organicSessions: 0,
      directSessions: 25,
      users: 25,
      syncedAt: now,
    }).run()

    // AI referrals: sessionSource lens (5) + firstUserSource lens (12) for the
    // same source/medium → dedup MAX = 12, bySession = 5.
    const { gaAiReferrals } = await import('@ainyc/canonry-db')
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      date: daysAgo(3),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'session',
      landingPage: '/pricing?utm_source=chatgpt.com',
      landingPageNormalized: '/pricing',
      sessions: 5,
      users: 4,
      syncedAt: now,
    }).run()
    db.insert(gaAiReferrals).values({
      id: crypto.randomUUID(),
      projectId: project.id,
      date: daysAgo(3),
      source: 'chatgpt.com',
      medium: 'referral',
      sourceDimension: 'first_user',
      landingPage: '/pricing?utm_source=chatgpt.com',
      landingPageNormalized: '/pricing',
      sessions: 12,
      users: 10,
      syncedAt: now,
    }).run()

    const { gaAttribution } = await import('../src/commands/ga.js')
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await gaAttribution('test-proj', { trend: true, format: 'json' })
    } finally {
      console.log = origLog
    }

    const parsed = JSON.parse(logs.join('\n')) as Record<string, unknown> & {
      directSessions: number
      directSharePct: number
      aiSessions: number
      aiSessionsBySession: number
      aiSharePct: number
      aiSharePctBySession: number
      aiReferralLandingPages: Array<{ landingPage: string; source: string; sessions: number }>
      trend: { direct: { sessions7d: number; sessionsPrev7d: number; trend7dPct: number | null } }
    }
    expect(parsed.directSessions).toBeGreaterThanOrEqual(75)
    expect(parsed.directSharePct).toBeGreaterThan(0)
    // Cross-cutting dedup includes firstUserSource → 12; bySession is the disjoint 5.
    expect(parsed.aiSessions).toBe(12)
    expect(parsed.aiSessionsBySession).toBe(5)
    expect(parsed.aiSharePctBySession).toBeLessThan(parsed.aiSharePct)
    expect(parsed.aiReferralLandingPages).toEqual(expect.arrayContaining([
      expect.objectContaining({ landingPage: '/pricing', source: 'chatgpt.com', sessions: 12 }),
    ]))
    expect(parsed.trend.direct).toBeDefined()
    expect(parsed.trend.direct.sessions7d).toBe(50)
    expect(parsed.trend.direct.sessionsPrev7d).toBe(25)
    expect(parsed.trend.direct.trend7dPct).toBe(100)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  aiUserFetchEventsHourly,
  aiUserFetchLikelyFakeHourly,
  aiUserFetchVerificationManifestsHourly,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  createClient,
  migrate,
  projects,
  rawEventSamples,
  trafficSources,
} from '@canonry/canonry-db'
import { and, eq } from 'drizzle-orm'
import { trafficSampleClassifierSchema } from '@canonry/canonry-contracts'
import { backfillTrafficClassificationCommand } from '../src/commands/backfill.js'
import { invokeCli } from './cli-test-utils.js'

const SEARCHBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)'
const AMZN_SEARCHBOT = 'Mozilla/5.0 (compatible; Amzn-SearchBot/0.1; +https://developer.amazon.com/amazonbot)'

describe('backfill traffic-classification', () => {
  let tmpDir: string
  let configDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>
  let originalConfigDir: string | undefined
  let projectId: string
  let sourceId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-traffic-'))
    configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    originalConfigDir = process.env.CANONRY_CONFIG_DIR
    process.env.CANONRY_CONFIG_DIR = configDir
    fs.writeFileSync(
      path.join(configDir, 'config.yaml'),
      JSON.stringify({
        apiUrl: 'http://localhost:4100',
        database: dbPath,
        apiKey: 'cnry_test_key',
        providers: {},
      }),
      'utf-8',
    )

    const now = new Date().toISOString()
    projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId,
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'demo.example',
      country: 'US',
      language: 'en',
      providers: [],
      locations: [],
      createdAt: now,
      updatedAt: now,
    }).run()

    sourceId = crypto.randomUUID()
    db.insert(trafficSources).values({
      id: sourceId,
      projectId,
      sourceType: 'cloud-run',
      status: 'connected',
      displayName: 'demo source',
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  afterEach(() => {
    db.$client.close()
    if (originalConfigDir === undefined) delete process.env.CANONRY_CONFIG_DIR
    else process.env.CANONRY_CONFIG_DIR = originalConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSample(eventType: 'unknown' | 'crawler', userAgent: string, ts: string): string {
    const id = crypto.randomUUID()
    db.insert(rawEventSamples).values({
      id,
      projectId,
      sourceId,
      ts,
      eventType,
      userAgent,
      pathNormalized: '/',
      status: 200,
      createdAt: ts,
    }).run()
    return id
  }

  it('reclassifies unknown samples that match the current rule set', async () => {
    const claudeId = seedSample('unknown',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0)',
      '2026-05-18T10:00:00.000Z',
    )
    const mistralId = seedSample('unknown',
      'Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)',
      '2026-05-18T10:30:00.000Z',
    )
    const browserId = seedSample('unknown',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      '2026-05-18T11:00:00.000Z',
    )

    await backfillTrafficClassificationCommand({ project: 'demo' })

    const claudeAfter = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, claudeId)).get()
    const mistralAfter = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, mistralId)).get()
    const browserAfter = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, browserId)).get()

    expect(claudeAfter?.eventType).toBe('crawler')
    expect(mistralAfter?.eventType).toBe('crawler')
    expect(browserAfter?.eventType).toBe('unknown')

    const claudeBucket = db.select().from(crawlerEventsHourly)
      .where(and(
        eq(crawlerEventsHourly.botId, 'claude-searchbot'),
        eq(crawlerEventsHourly.tsHour, '2026-05-18T10:00:00.000Z'),
      ))
      .get()
    expect(claudeBucket?.hits).toBe(1)

    const mistralBucket = db.select().from(crawlerEventsHourly)
      .where(and(
        eq(crawlerEventsHourly.botId, 'mistral-bot'),
        eq(crawlerEventsHourly.tsHour, '2026-05-18T10:00:00.000Z'),
      ))
      .get()
    expect(mistralBucket?.hits).toBe(1)

    expect(claudeBucket?.verificationStatus).toBe('claimed_unverified')
    expect(mistralBucket?.verificationStatus).toBe('claimed_unverified')
    expect(db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
  })

  it('does not fabricate user-fetch manifest provenance without a stored source IP', async () => {
    seedSample('unknown',
      'Mozilla/5.0 (compatible; Claude-User/1.0)',
      '2026-05-18T11:30:00.000Z',
    )

    await backfillTrafficClassificationCommand({ project: 'demo' })

    const bucket = db.select().from(aiUserFetchEventsHourly)
      .where(eq(aiUserFetchEventsHourly.botId, 'claude-user'))
      .get()
    expect(bucket).toMatchObject({
      verificationStatus: 'claimed_unverified',
      hits: 1,
    })
    expect(db.select().from(aiUserFetchVerificationManifestsHourly).all()).toHaveLength(0)
  })

  it('replays likely fake agent claims into their own count, never into AI user fetch hits', async () => {
    const chatgpt = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'
    const realId = seedSample('unknown', chatgpt, '2026-05-18T12:05:00.000Z')
    const oddId = seedSample('unknown', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)', '2026-05-18T12:10:00.000Z')

    await backfillTrafficClassificationCommand({ project: 'demo' })

    expect(db.select({ id: rawEventSamples.id, eventType: rawEventSamples.eventType }).from(rawEventSamples).all()
      .filter(row => row.id === realId || row.id === oddId).map(row => row.eventType)).toEqual(['ai_user_fetch', 'ai_user_fetch'])
    expect(db.select({ hits: aiUserFetchEventsHourly.hits }).from(aiUserFetchEventsHourly).where(eq(aiUserFetchEventsHourly.botId, 'openai-chatgpt-user')).all()).toEqual([{ hits: 1 }])
    expect(db.select({ tsHour: aiUserFetchLikelyFakeHourly.tsHour, reason: aiUserFetchLikelyFakeHourly.reason, hits: aiUserFetchLikelyFakeHourly.hits }).from(aiUserFetchLikelyFakeHourly).all())
      .toEqual([{ tsHour: '2026-05-18T12:00:00.000Z', reason: 'unusual-user-agent', hits: 1 }])
  })

  it('stores reclassified samples with the type and classifier details sample reads use', async () => {
    const userFetchId = seedSample('unknown', 'Mozilla/5.0 (compatible; Claude-User/1.0)', '2026-05-18T15:00:00.000Z')
    const crawlerId = seedSample('unknown', 'Mozilla/5.0 GPTBot/1.2', '2026-05-18T15:10:00.000Z')

    await backfillTrafficClassificationCommand({ project: 'demo' })

    const userFetch = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, userFetchId)).get()
    // The stored value, not the wire kind 'ai-user-fetch' that sample reads never match.
    expect(userFetch?.eventType).toBe('ai_user_fetch')
    expect(trafficSampleClassifierSchema.parse(userFetch?.classifierDetailsJson)).toMatchObject({
      crawler: null,
      aiUserFetch: { botId: 'claude-user', operator: 'Anthropic', verificationStatus: 'claimed_unverified', verificationManifest: null },
      aiReferral: null,
    })

    const crawler = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, crawlerId)).get()
    expect(crawler?.eventType).toBe('crawler')
    expect(trafficSampleClassifierSchema.parse(crawler?.classifierDetailsJson)).toMatchObject({
      crawler: { botId: 'openai-gptbot', operator: 'OpenAI', purpose: 'training', verificationManifest: null },
      aiUserFetch: null,
      aiReferral: null,
    })
  })

  it('is idempotent — second run finds no work to do', async () => {
    seedSample('unknown',
      'Mozilla/5.0 (compatible; DeepSeekBot/1.0; +https://www.deepseek.com/bot)',
      '2026-05-18T12:00:00.000Z',
    )

    await backfillTrafficClassificationCommand({ project: 'demo' })
    await backfillTrafficClassificationCommand({ project: 'demo' })

    const bucket = db.select().from(crawlerEventsHourly)
      .where(eq(crawlerEventsHourly.botId, 'deepseek'))
      .get()
    expect(bucket?.hits).toBe(1)
  })

  it('dry-run reports counts without touching the DB', async () => {
    seedSample('unknown',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      '2026-05-18T13:00:00.000Z',
    )
    // An hour an older version filed under ClaudeBot.
    const now = new Date().toISOString()
    db.insert(crawlerEventsHourly).values({
      projectId, sourceId, tsHour: '2026-05-18T13:00:00.000Z', botId: 'anthropic-claudebot', operator: 'Anthropic',
      verificationStatus: 'claimed_unverified', pathNormalized: '/docs', status: 200, hits: 4,
      sampledUserAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
      createdAt: now, updatedAt: now,
    }).run()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })

    try {
      await backfillTrafficClassificationCommand({ project: 'demo', dryRun: true, format: 'json' })
    } finally {
      spy.mockRestore()
    }

    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      dryRun: true,
      examined: 1,
      reclassified: 1,
      unknownBefore: 1,
      unknownAfter: 0,
      crawlers: { examined: 1, moved: 1, movedHits: 4, unverifiedHits: 0, samplesRelabeled: 0, byBot: { 'claude-searchbot': 4 } },
    })
    const sampleAfter = db.select().from(rawEventSamples).get()
    expect(sampleAfter?.eventType).toBe('unknown')
    expect(db.select({ botId: crawlerEventsHourly.botId, hits: crawlerEventsHourly.hits }).from(crawlerEventsHourly).all())
      .toEqual([{ botId: 'anthropic-claudebot', hits: 4 }])
    expect(db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
  })

  /** Hours an older version filed under ClaudeBot and Amazonbot, the latter verified against Amazonbot's own list. */
  function seedMisfiledCrawlerHours(): void {
    const now = new Date().toISOString()
    const hour = { projectId, sourceId, tsHour: '2026-05-18T13:00:00.000Z', pathNormalized: '/docs', status: 200, createdAt: now, updatedAt: now }
    db.insert(crawlerEventsHourly).values({ ...hour, botId: 'anthropic-claudebot', operator: 'Anthropic', verificationStatus: 'claimed_unverified', hits: 4, sampledUserAgent: SEARCHBOT }).run()
    db.insert(crawlerEventsHourly).values({ ...hour, botId: 'amazonbot', operator: 'Amazon', verificationStatus: 'verified', hits: 6, sampledUserAgent: AMZN_SEARCHBOT }).run()
  }

  async function runText(dryRun: boolean): Promise<{ stdout: string, stderr: string }> {
    const logs: string[] = []
    const writes: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    try {
      await backfillTrafficClassificationCommand({ project: 'demo', dryRun })
    } finally {
      log.mockRestore()
      stderr.mockRestore()
    }
    return { stdout: logs.join('\n'), stderr: writes.join('') }
  }

  it('previews in text where every hour would go, verification lost included, and writes nothing', async () => {
    seedSample('unknown', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', '2026-05-18T13:00:00.000Z')
    seedMisfiledCrawlerHours()

    const { stdout, stderr } = await runText(true)

    expect(stderr).toBe('Re-classifying stored traffic under today\'s rules for "demo" [DRY RUN — no writes]...\n')
    const lines = stdout.split('\n')
    expect(lines).toContain('Traffic classification preview complete.')
    expect(lines).toContain('  Would re-classify:        1')
    expect(lines).toContain('  Unknown after:       0')
    expect(lines).toContain('  Crawler rows:        2 examined; 2 moved to the crawler their user agent names today (10 hits), 0 to AI user fetch (0 hits), 0 back to unrecognized agents (0 hits), 0 of Canonry\'s own tools removed (0 hits)')
    expect(lines).toContain('                       Hits moved to: amzn-searchbot 6, claude-searchbot 4')
    expect(lines).toContain('                       6 verified hits no longer verified; 0 samples relabeled (0 now unknown), 0 removed')
    expect(lines.slice(lines.indexOf('  By bot:'), lines.indexOf('  By bot:') + 4)).toEqual([
      '  By bot:',
      '        6  amzn-searchbot',
      '        4  claude-searchbot',
      '        1  bingbot',
    ])
    expect(lines).toContain('No DB writes performed. Re-run without --dry-run to apply.')
    expect(db.select({ botId: crawlerEventsHourly.botId, verificationStatus: crawlerEventsHourly.verificationStatus, hits: crawlerEventsHourly.hits }).from(crawlerEventsHourly).all()
      .sort((a, b) => a.botId.localeCompare(b.botId))).toEqual([
      { botId: 'amazonbot', verificationStatus: 'verified', hits: 6 },
      { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', hits: 4 },
    ])
  })

  it('reports in text the moves it made, verification lost included', async () => {
    seedMisfiledCrawlerHours()

    const { stdout, stderr } = await runText(false)

    expect(stderr).toBe('Re-classifying stored traffic under today\'s rules for "demo"...\n')
    const lines = stdout.split('\n')
    expect(lines).toContain('Traffic classification recovery complete.')
    expect(lines).toContain('  Crawler rows:        2 examined; 2 moved to the crawler their user agent names today (10 hits), 0 to AI user fetch (0 hits), 0 back to unrecognized agents (0 hits), 0 of Canonry\'s own tools removed (0 hits)')
    expect(lines).toContain('                       6 verified hits no longer verified; 0 samples relabeled (0 now unknown), 0 removed')
    expect(lines).not.toContain('No DB writes performed. Re-run without --dry-run to apply.')
    expect(db.select({ botId: crawlerEventsHourly.botId, verificationStatus: crawlerEventsHourly.verificationStatus, hits: crawlerEventsHourly.hits }).from(crawlerEventsHourly).all()
      .sort((a, b) => a.botId.localeCompare(b.botId))).toEqual([
      { botId: 'amzn-searchbot', verificationStatus: 'claimed_unverified', hits: 6 },
      { botId: 'claude-searchbot', verificationStatus: 'claimed_unverified', hits: 4 },
    ])
  })

  it('lists the bots that received crawler hours with the reclassified ones in JSON', async () => {
    seedSample('unknown', 'Mozilla/5.0 GPTBot/1.2', '2026-05-18T14:10:00.000Z')
    seedMisfiledCrawlerHours()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })

    try {
      await backfillTrafficClassificationCommand({ project: 'demo', dryRun: true, format: 'json' })
    } finally {
      spy.mockRestore()
    }

    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      byBot: { 'openai-gptbot': 1, 'claude-searchbot': 4, 'amzn-searchbot': 6 },
      crawlers: { moved: 2, movedHits: 10, unverifiedHits: 6, heldVerified: 0, byBot: { 'claude-searchbot': 4, 'amzn-searchbot': 6 } },
    })
  })

  it.each([
    { format: 'json', stderr: (text: string) => expect(JSON.parse(text)).toEqual({ error: { code: 'NOT_FOUND', message: 'Project "typo" not found', details: { project: 'typo' } } }) },
    { format: 'text', stderr: (text: string) => expect(text).toContain('Error: no project named "typo".') },
  ])('fails an unknown --project as a user error ($format)', async ({ format, stderr }) => {
    const result = await invokeCli(['backfill', 'traffic-classification', '--project', 'typo', '--format', format])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    stderr(result.stderr)
  })

  it('aggregates multiple matches into the same hour bucket', async () => {
    seedSample('unknown', 'Mozilla/5.0 GPTBot/1.2',  '2026-05-18T14:10:00.000Z')
    seedSample('unknown', 'Mozilla/5.0 GPTBot/1.2',  '2026-05-18T14:40:00.000Z')

    await backfillTrafficClassificationCommand({ project: 'demo' })

    const bucket = db.select().from(crawlerEventsHourly)
      .where(eq(crawlerEventsHourly.botId, 'openai-gptbot'))
      .get()
    expect(bucket?.hits).toBe(2)
    expect(db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
  })
})

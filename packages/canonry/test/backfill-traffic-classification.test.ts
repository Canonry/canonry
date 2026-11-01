import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  aiUserFetchEventsHourly,
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
        eq(crawlerEventsHourly.botId, 'anthropic-claudebot'),
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

    await backfillTrafficClassificationCommand({ project: 'demo', dryRun: true })

    const sampleAfter = db.select().from(rawEventSamples).get()
    expect(sampleAfter?.eventType).toBe('unknown')
    const buckets = db.select().from(crawlerEventsHourly).all()
    expect(buckets).toHaveLength(0)
    expect(db.select().from(crawlerVerificationManifestsHourly).all()).toHaveLength(0)
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

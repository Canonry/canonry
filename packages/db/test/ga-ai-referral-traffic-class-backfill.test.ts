import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { test, expect, onTestFinished } from 'vitest'
import {
  backfillGaAiReferralTrafficClass,
  createClient,
  gaAiReferrals,
  migrate,
  projects,
} from '../src/index.js'

/**
 * v95 added `ga_ai_referrals.traffic_class` with `DEFAULT 'organic'` and never
 * classified the rows that already existed, so paid ChatGPT-ads traffic was
 * silently reported as organic. v96 re-derives the class from the columns
 * already on each row. These tests assert the exact reclassification, not just
 * that "something changed".
 */

type Db = ReturnType<typeof createClient>

function createTempDb(): Db {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ai-traffic-class-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProject(db: Db): string {
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id,
    name: 'ai-traffic-class',
    displayName: 'AI Traffic Class',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    providers: [],
    locations: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }).run()
  return id
}

/** Insert a referral exactly as v95's `DEFAULT 'organic'` would have left it. */
function seedDefaultedReferral(db: Db, projectId: string, over: {
  source: string
  medium: string
  channelGroup: string
  landingPage: string
}): string {
  const id = crypto.randomUUID()
  db.insert(gaAiReferrals).values({
    id,
    projectId,
    date: '2026-06-15',
    trafficClass: 'organic',
    sourceDimension: 'session',
    sessions: 10,
    users: 9,
    syncedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  }).run()
  return id
}

function classOf(db: Db, id: string): string | undefined {
  return db
    .select({ trafficClass: gaAiReferrals.trafficClass })
    .from(gaAiReferrals)
    .where(eq(gaAiReferrals.id, id))
    .all()[0]?.trafficClass
}

function seedThreeRows(db: Db) {
  const projectId = seedProject(db)
  // The production case: paid ChatGPT ads, which GA4 tags cpc / Paid Other.
  const paidByChannel = seedDefaultedReferral(db, projectId, {
    source: 'chatgpt', medium: 'cpc', channelGroup: 'Paid Other', landingPage: '/pricing',
  })
  // A genuinely organic AI referral. Must stay organic.
  const organic = seedDefaultedReferral(db, projectId, {
    source: 'chatgpt.com', medium: 'referral', channelGroup: 'Referral', landingPage: '/guide',
  })
  // Paid only via a UTM param on the landing page. A SQL-only backfill would
  // miss this, which is why the migration calls the shared TS classifier.
  const paidByLandingPage = seedDefaultedReferral(db, projectId, {
    source: 'chatgpt.com', medium: 'referral', channelGroup: 'Referral', landingPage: '/x?utm_medium=cpc',
  })
  return { paidByChannel, organic, paidByLandingPage }
}

test('backfill reclassifies rows the v95 default stamped organic, and leaves real organic rows alone', () => {
  const db = createTempDb()
  const { paidByChannel, organic, paidByLandingPage } = seedThreeRows(db)

  // Precondition: this is the bug. Paid ads sitting in the table as "organic".
  expect(classOf(db, paidByChannel)).toBe('organic')

  const updated = backfillGaAiReferralTrafficClass(db)

  // Exactly the two paid rows flip; the organic row is not rewritten.
  expect(updated).toBe(2)
  expect(classOf(db, paidByChannel)).toBe('paid')
  expect(classOf(db, paidByLandingPage)).toBe('paid')
  expect(classOf(db, organic)).toBe('organic')
})

test('backfill is idempotent: a replay writes nothing and changes nothing', () => {
  const db = createTempDb()
  const { paidByChannel, organic, paidByLandingPage } = seedThreeRows(db)

  expect(backfillGaAiReferralTrafficClass(db)).toBe(2)
  // The classifier is pure, so re-deriving already-correct rows is a no-op.
  expect(backfillGaAiReferralTrafficClass(db)).toBe(0)

  expect(classOf(db, paidByChannel)).toBe('paid')
  expect(classOf(db, paidByLandingPage)).toBe('paid')
  expect(classOf(db, organic)).toBe('organic')
})

test('backfill is a no-op on a freshly migrated (empty) database', () => {
  const db = createTempDb()
  expect(backfillGaAiReferralTrafficClass(db)).toBe(0)
})

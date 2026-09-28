import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import {
  createClient, migrate, MIGRATION_VERSIONS, projects, runs, querySnapshots,
  SentimentRepository, SentimentIdempotencyConflict, recordSentimentCompletion,
  sentimentDefinitions, sentimentSettings, sentimentCompletionReceipts, sentimentJobs,
  sentimentWorkItems, sentimentJobItems, sentimentResults, sentimentAttempts, llmUsageEvents,
} from '../src/index.js'

const NOW = '2026-09-28T12:00:00.000Z'
const LATER = '2026-09-28T12:01:00.000Z'

function fixture(upgrade = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-sentiment-'))
  const db = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => { db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  migrate(db, upgrade ? MIGRATION_VERSIONS.filter(v => v.version < 162) : MIGRATION_VERSIONS)
  db.insert(projects).values({ id: 'p', name: 'project', displayName: 'Project', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(runs).values({ id: 'r', projectId: 'p', status: 'completed', createdAt: NOW }).run()
  db.insert(querySnapshots).values({ id: 's', runId: 'r', provider: 'openai', citationState: 'cited', answerText: 'A is excellent. B is poor.', createdAt: NOW }).run()
  if (upgrade) migrate(db)
  const repo = new SentimentRepository(db)
  repo.putDefinition({ id: 'd', contentHash: 'hash-d', requestedModel: 'jev-1.13.0', definition: { themes: [{ id: 'quality' }], preprocessingVersion: '1' }, createdAt: NOW })
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: { preset: 'default' }, now: NOW })
  const work = { runId: 'r', snapshotId: 's', sourceTextHash: 'text-hash', subjectHash: 'subject-a', input: { text: 'A is excellent. B is poor.', subject: { name: 'A', aliases: ['A Apartments'] } }, edges: [{ market: 'new-york' }] }
  const admission = { projectId: 'p', action: 'backfill', origin: 'backfill', enablementEpoch: 1, evaluationDefinitionId: 'd', idempotencyKey: 'key', payloadHash: 'payload', actor: 'admin', selection: { runIds: ['r'] }, work: [work], now: NOW }
  return { db, repo, work, admission, dir }
}

test('fresh and upgraded storage preserves definitions through repeated migration', () => {
  for (const upgrade of [false, true]) {
    const { db, repo } = fixture(upgrade)
    migrate(db)
    expect(db.select().from(sentimentDefinitions).all()).toHaveLength(1)
    expect(repo.getSettings('p')).toMatchObject({ enabled: true, enablementEpoch: 1, completionBoundary: 0, evaluationDefinitionId: 'd' })
  }
})

test('definition content is immutable and idempotent', () => {
  const { db, repo } = fixture()
  const definition = db.select().from(sentimentDefinitions).get()!
  expect(repo.putDefinition(definition)).toEqual(definition)
  expect(() => repo.putDefinition({ ...definition, definition: { changed: true } })).toThrow(/immutable/i)
  expect(() => db.update(sentimentDefinitions).set({ contentHash: 'changed' }).run()).toThrow(/immutable/i)
})

test('admission deduplicates key+canonical payload and conflicts before changing work', () => {
  const { db, repo, admission } = fixture()
  const first = repo.admitJob(admission)
  expect(repo.admitJob(admission).id).toBe(first.id)
  expect(repo.lookupJob('p', 'backfill', 'key', 'payload')?.id).toBe(first.id)
  expect(() => repo.admitJob({ ...admission, payloadHash: 'other' })).toThrow(SentimentIdempotencyConflict)
  expect(db.select().from(sentimentJobs).all()).toHaveLength(1)
  expect(db.select().from(sentimentWorkItems).all()).toHaveLength(1)
})

test('assessment identity separates subject, text and evaluator while jobs share one lease', () => {
  const { db, repo, admission, work } = fixture()
  repo.admitJob(admission)
  repo.admitJob({ ...admission, idempotencyKey: 'key2' })
  repo.admitJob({ ...admission, idempotencyKey: 'key3', work: [{ ...work, subjectHash: 'subject-b' }, { ...work, sourceTextHash: 'text-v2' }] })
  repo.putDefinition({ id: 'd2', contentHash: 'hash-d2', requestedModel: 'jev-1.13.0', definition: { themes: ['new-theme'] }, createdAt: NOW })
  repo.admitJob({ ...admission, idempotencyKey: 'key4', evaluationDefinitionId: 'd2' })
  expect(db.select().from(sentimentWorkItems).all()).toHaveLength(4)
  expect(db.select().from(sentimentJobItems).all()).toHaveLength(5)
  const claimed = repo.claim({ owner: 'worker-1', now: NOW, leaseMs: 30_000 })!
  expect(claimed.leaseOwner).toBe('worker-1')
  expect(repo.claim({ owner: 'worker-2', now: NOW, leaseMs: 30_000 })?.id).not.toBe(claimed.id)
})

test('concurrent database connections cannot claim one assessment twice and expired leases recover', () => {
  const { repo, admission, dir } = fixture()
  repo.admitJob(admission)
  const secondDb = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => secondDb.$client.close())
  const second = new SentimentRepository(secondDb)
  const first = repo.claim({ owner: 'first', now: NOW, leaseMs: 30_000 })!
  expect(second.claim({ owner: 'second', now: NOW, leaseMs: 30_000 })).toBeUndefined()
  expect(second.claim({ owner: 'second', now: LATER, leaseMs: 30_000 })?.id).toBe(first.id)
  expect(repo.completeWork({ workItemId: first.id, owner: 'first', outcome: 'favorable', result: {}, returnedModel: 'jev-1.13.0', now: LATER })).toBe(false)
})

test('results are unique, preserve opposite subject judgments and are reused without dispatch', () => {
  const { db, repo, admission, work } = fixture()
  repo.admitJob({ ...admission, work: [work, { ...work, subjectHash: 'subject-b' }] })
  for (const outcome of ['favorable', 'unfavorable']) {
    const claimed = repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })!
    expect(repo.completeWork({ workItemId: claimed.id, owner: 'worker', outcome, result: { outcome }, returnedModel: 'jev-1.13.0', now: NOW })).toBe(true)
    expect(repo.completeWork({ workItemId: claimed.id, owner: 'worker', outcome, result: { outcome }, returnedModel: 'jev-1.13.0', now: NOW })).toBe(false)
  }
  repo.admitJob({ ...admission, idempotencyKey: 'second-job' })
  expect(repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })).toBeUndefined()
  expect(db.select().from(sentimentResults).all().map(r => r.outcome).sort()).toEqual(['favorable', 'unfavorable'])
})

test('retries persist timing; actual attempts preserve reported and unknown usage separately', () => {
  const { db, repo, admission } = fixture()
  repo.admitJob(admission)
  const claimed = repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })!
  const attempt = repo.startAttempt({ workItemId: claimed.id, owner: 'worker', requestedModel: 'jev-1.13.0', now: NOW })!
  repo.finishAttempt({ attemptId: attempt.id, now: NOW, returnedModel: null, usageStatus: 'unknown', safeFailure: 'timeout-after-transmission' })
  repo.failWork({ workItemId: claimed.id, owner: 'worker', now: NOW, errorCode: 'timeout', retryAt: LATER })
  expect(repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })).toBeUndefined()
  repo.claim({ owner: 'worker', now: LATER, leaseMs: 30_000 })
  const attempt2 = repo.startAttempt({ workItemId: claimed.id, owner: 'worker', requestedModel: 'jev-1.13.0', now: LATER })!
  repo.finishAttempt({ attemptId: attempt2.id, now: LATER, returnedModel: 'jev-1.13.0', usageStatus: 'reported', usage: { inputTokens: 1000, outputTokens: 50, costMillicents: 4 } })
  repo.finishAttempt({ attemptId: attempt2.id, now: LATER, returnedModel: 'jev-1.13.0', usageStatus: 'reported', usage: { inputTokens: 1000, outputTokens: 50, costMillicents: 4 } })
  expect(db.select().from(sentimentAttempts).all().map(a => a.usageStatus)).toEqual(['unknown', 'reported'])
  expect(db.select().from(llmUsageEvents).all()).toHaveLength(1)
  expect(db.select().from(llmUsageEvents).get()).toMatchObject({ provider: 'typesafe', inputTokens: 1000, outputTokens: 50, metadata: { sentimentAttemptId: attempt2.id, usageStatus: 'reported' } })
})

test('disable cancels selected work; reenabling cannot resume it; explicit backfill preserves old cancellations', () => {
  const { db, repo, admission } = fixture()
  const original = repo.admitJob(admission)
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  expect(repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })).toBeUndefined()
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  expect(repo.claim({ owner: 'worker', now: LATER, leaseMs: 30_000 })).toBeUndefined()
  repo.admitJob({ ...admission, idempotencyKey: 'explicit', enablementEpoch: 2, allowReplayCanceled: true, now: LATER })
  expect(repo.claim({ owner: 'worker', now: LATER, leaseMs: 30_000 })).toBeDefined()
  expect(db.select().from(sentimentJobItems).where(eq(sentimentJobItems.jobId, original.id)).get()).toMatchObject({ canceledAt: NOW, cancellationReason: 'project-disabled', enablementEpoch: 1 })
})

test('an already transmitted response records usage and result after disable without uncanceling work', () => {
  const { db, repo, admission } = fixture()
  repo.admitJob(admission)
  const claimed = repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })!
  const attempt = repo.startAttempt({ workItemId: claimed.id, owner: 'worker', requestedModel: 'jev-1.13.0', now: NOW })!
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  repo.finishAttempt({ attemptId: attempt.id, now: LATER, returnedModel: 'jev-1.13.0', usageStatus: 'reported', usage: { inputTokens: 100, outputTokens: 0, costMillicents: 1 } })
  expect(repo.completeWork({ workItemId: claimed.id, owner: 'worker', outcome: 'favorable', result: { outcome: 'favorable' }, returnedModel: 'jev-1.13.0', now: LATER })).toBe(true)
  expect(db.select().from(sentimentWorkItems).get()?.status).toBe('canceled')
  expect(db.select().from(sentimentResults).all()).toHaveLength(1)
})

test('completion receipts order old partial fills after enablement and share source transaction rollback', () => {
  const { db, repo } = fixture()
  expect(repo.getSettings('p')?.completionBoundary).toBe(0)
  const receipt = db.transaction(tx => recordSentimentCompletion(tx, { projectId: 'p', runId: 'r', completionKey: 'fill:1', completedAt: LATER, fillOrigin: 'fill-1' }))!
  expect(receipt.sequence).toBeGreaterThan(0)
  expect(recordSentimentCompletion(db, { projectId: 'p', runId: 'r', completionKey: 'fill:1', completedAt: LATER, fillOrigin: 'fill-1' })?.sequence).toBe(receipt.sequence)
  expect(() => db.transaction(tx => {
    recordSentimentCompletion(tx, { projectId: 'p', runId: 'r', completionKey: 'fill:2', completedAt: LATER })
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(db.select().from(sentimentCompletionReceipts).all()).toHaveLength(1)
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  expect(repo.getSettings('p')?.completionBoundary).toBe(receipt.sequence)
  db.update(runs).set({ trigger: 'probe' }).where(eq(runs.id, 'r')).run()
  expect(recordSentimentCompletion(db, { projectId: 'p', runId: 'r', completionKey: 'probe', completedAt: LATER })).toBeUndefined()
})

test('snapshot/run/project isolation is enforced and deleting source removes stored evidence', () => {
  const { db, repo, admission, work } = fixture()
  db.insert(projects).values({ id: 'other', name: 'other', displayName: 'Other', canonicalDomain: 'other.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(runs).values({ id: 'other-run', projectId: 'other', status: 'completed', createdAt: NOW }).run()
  db.insert(querySnapshots).values({ id: 'other-snapshot', runId: 'other-run', provider: 'openai', citationState: 'cited', createdAt: NOW }).run()
  expect(() => repo.admitJob({ ...admission, work: [{ ...work, snapshotId: 'other-snapshot' }] })).toThrow(/FOREIGN KEY/i)
  expect(db.select().from(sentimentJobs).all()).toHaveLength(0)
  repo.admitJob(admission)
  const claimed = repo.claim({ owner: 'worker', now: NOW, leaseMs: 30_000 })!
  repo.completeWork({ workItemId: claimed.id, owner: 'worker', outcome: 'favorable', result: { quote: 'A is excellent.' }, returnedModel: 'jev-1.13.0', now: NOW })
  db.delete(querySnapshots).where(eq(querySnapshots.id, 's')).run()
  expect(db.select().from(sentimentResults).all()).toHaveLength(0)
  expect(db.select().from(sentimentWorkItems).all()).toHaveLength(0)
  db.delete(projects).where(eq(projects.id, 'p')).run()
  expect(db.select().from(sentimentJobs).all()).toHaveLength(0)
  expect(db.select().from(sentimentSettings).all()).toHaveLength(0)
})

test('frozen subject input remains unchanged after current project configuration changes', () => {
  const { db, repo, admission, work } = fixture()
  repo.admitJob(admission)
  db.update(projects).set({ displayName: 'Renamed', aliases: ['Different'] }).where(eq(projects.id, 'p')).run()
  expect(db.select().from(sentimentWorkItems).where(and(eq(sentimentWorkItems.projectId, 'p'), eq(sentimentWorkItems.snapshotId, 's'))).get()?.input).toEqual(work.input)
  expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
})

test('explicit backfill after reenable retains the transmitted request lease and old cancellation', () => {
  const { db, repo, admission } = fixture()
  const original = repo.admitJob(admission)
  const claimed = repo.claim({ owner: 'original-attempt', now: NOW, leaseMs: 120_000 })!
  repo.startAttempt({ workItemId: claimed.id, owner: 'original-attempt', requestedModel: 'jev-1.13.0', now: NOW })
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  const replay = repo.admitJob({ ...admission, idempotencyKey: 'explicit-retry', enablementEpoch: 2, now: LATER, allowReplayCanceled: true })
  expect(repo.claim({ owner: 'second-attempt', now: LATER, leaseMs: 30_000 })).toBeUndefined()
  expect(repo.completeWork({ workItemId: claimed.id, owner: 'original-attempt', outcome: 'favorable', result: { outcome: 'favorable' }, returnedModel: 'jev-1.13.0', now: LATER })).toBe(true)
  expect(repo.getJob('p', replay.id)?.state).toBe('complete')
  expect(repo.getJob('p', original.id)?.state).toBe('canceled')
  expect(db.select().from(sentimentJobItems).where(eq(sentimentJobItems.jobId, original.id)).get()?.canceledAt).toBe(NOW)
})

test('request, token and concurrency reservations are atomic across projects', () => {
  const { db, repo, admission, work } = fixture()
  db.insert(projects).values({ id: 'q', name: 'second', displayName: 'Second', canonicalDomain: 'second.example', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
  db.insert(runs).values({ id: 'r2', projectId: 'q', status: 'completed', createdAt: NOW }).run()
  db.insert(querySnapshots).values({ id: 's2', runId: 'r2', provider: 'openai', citationState: 'cited', createdAt: NOW }).run()
  repo.configure({ projectId: 'q', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  repo.admitJob(admission)
  repo.admitJob({ ...admission, projectId: 'q', work: [{ ...work, runId: 'r2', snapshotId: 's2' }] })
  const first = repo.claim({ owner: 'first', projectId: 'p', now: NOW, leaseMs: 120_000, maxConcurrent: 1 })!
  expect(repo.claim({ owner: 'second', projectId: 'q', now: NOW, leaseMs: 120_000, maxConcurrent: 1 })).toBeUndefined()
  const second = repo.claim({ owner: 'second', projectId: 'q', now: NOW, leaseMs: 120_000, maxConcurrent: 2 })!
  expect(repo.startAttempt({ workItemId: first.id, owner: 'first', now: NOW, requestedModel: 'jev-1.13.0', estimatedInputTokens: 800, maxRequestsPerMinute: 1, maxInputTokensPerMinute: 1000 })).toBeDefined()
  expect(repo.startAttempt({ workItemId: second.id, owner: 'second', now: NOW, requestedModel: 'jev-1.13.0', estimatedInputTokens: 100, maxRequestsPerMinute: 1 })).toBeUndefined()
  expect(repo.startAttempt({ workItemId: second.id, owner: 'second', now: NOW, requestedModel: 'jev-1.13.0', estimatedInputTokens: 300, maxInputTokensPerMinute: 1000 })).toBeUndefined()
  expect(repo.startAttempt({ workItemId: second.id, owner: 'second', now: LATER, requestedModel: 'jev-1.13.0', estimatedInputTokens: 300, maxRequestsPerMinute: 1, maxInputTokensPerMinute: 1000 })).toBeDefined()
})

test('source deletion cannot rewind enablement completion sequence', () => {
  const { db, repo } = fixture()
  const receipt = recordSentimentCompletion(db, { projectId: 'p', runId: 'r', completionKey: 'original', completedAt: NOW })!
  db.delete(runs).where(eq(runs.id, 'r')).run()
  expect(db.select().from(sentimentCompletionReceipts).all()).toHaveLength(0)
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  expect(repo.getSettings('p')?.completionBoundary).toBe(receipt.sequence)
  db.insert(runs).values({ id: 'new-run', projectId: 'p', status: 'completed', createdAt: LATER }).run()
  const next = recordSentimentCompletion(db, { projectId: 'p', runId: 'new-run', completionKey: 'new', completedAt: LATER })!
  expect(next.sequence).toBeGreaterThan(receipt.sequence)
})

test('disabled but transmitted requests still consume install concurrency until lease expiry', () => {
  const { repo, admission, work } = fixture()
  repo.admitJob(admission)
  const first = repo.claim({ owner: 'outbound', now: NOW, leaseMs: 120_000 })!
  repo.startAttempt({ workItemId: first.id, owner: 'outbound', now: NOW, requestedModel: 'jev-1.13.0' })
  repo.configure({ projectId: 'p', enabled: false, evaluationDefinitionId: 'd', configuration: {}, now: NOW })
  repo.configure({ projectId: 'p', enabled: true, evaluationDefinitionId: 'd', configuration: {}, now: LATER })
  repo.admitJob({ ...admission, idempotencyKey: 'different-subject', enablementEpoch: 2, work: [{ ...work, subjectHash: 'different' }], now: LATER })
  expect(repo.claim({ owner: 'new', now: LATER, leaseMs: 30_000, maxConcurrent: 1 })).toBeUndefined()
  repo.completeWork({ workItemId: first.id, owner: 'outbound', outcome: 'favorable', result: {}, returnedModel: 'jev-1.13.0', now: LATER })
  expect(repo.claim({ owner: 'new', now: LATER, leaseMs: 30_000, maxConcurrent: 1 })).toBeDefined()
})

test('observed install disable survives restart and resume excludes its completion interval', () => {
  const { db, repo, admission, dir } = fixture()
  repo.admitJob(admission)
  expect(repo.suspendInstall(NOW)).toBe(1)
  expect(repo.suspendInstall(NOW)).toBe(0)
  expect(repo.getSettings('p')).toMatchObject({ enabled: true, installSuspended: true, enablementEpoch: 1 })
  const during = recordSentimentCompletion(db, { projectId: 'p', runId: 'r', completionKey: 'during-disabled', completedAt: LATER })!
  const reopenedDb = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => reopenedDb.$client.close())
  const reopened = new SentimentRepository(reopenedDb)
  expect(reopened.claim({ owner: 'restarted', now: LATER, leaseMs: 30_000 })).toBeUndefined()
  expect(() => reopened.admitJob({ ...admission, idempotencyKey: 'new' })).toThrow(/disabled/i)
  expect(reopened.resumeInstall(LATER)).toBe(1)
  expect(reopened.resumeInstall(LATER)).toBe(0)
  expect(reopened.getSettings('p')).toMatchObject({ enabled: true, installSuspended: false, enablementEpoch: 2, completionBoundary: during.sequence })
  expect(reopened.claim({ owner: 'restarted', now: LATER, leaseMs: 30_000 })).toBeUndefined()
  expect(db.select().from(sentimentJobs).get()).toMatchObject({ state: 'canceled', cancellationReason: 'install-disabled' })
})

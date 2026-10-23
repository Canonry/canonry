import { expect, onTestFinished, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoAdapterOutcomes, SeoCapabilities, SeoRunStatuses, emptySeoResults, type SeoAdapterResult, type SeoProfileInput } from '@canonry/canonry-contracts'
import { createClient, migrate, projects, runs, SeoRepository, seoBudgets, seoJobs, seoProfiles, seoTasks, type SeoAdmission } from '../src/index.js'

function setup() {
  const db = createClient(':memory:'); migrate(db)
  onTestFinished(() => db.$client.close())
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  const profile: SeoProfileInput = { name: 'SEO', connectionId: 'primary', capabilities: [SeoCapabilities['keyword-metrics']], targets: [], keywords: ['solar'], locationCode: 2840, languageCode: 'en', limit: 100, scope: { kind: 'project' } }
  db.insert(seoProfiles).values({ projectId: 'project', id: 'profile', revision: 1, input: profile, createdAt: now, updatedAt: now }).run()
  const admission: SeoAdmission = {
    id: 'run', projectId: 'project', profileId: 'profile', profileRevision: 1, profile, scopeSnapshot: {}, requestHash: 'intent', idempotencyKey: 'first', principalId: 'owner', accountKey: 'account', now,
    buckets: [{ scope: 'account-day:account', period: now.slice(0, 10), limit: 1000 }, { scope: 'account-month:account', period: now.slice(0, 7), limit: 1000 }, { scope: 'project-month:project', period: now.slice(0, 7), limit: 1000 }],
    tasks: [{ id: 'task', reservedMicros: 100, catalogRevision: 'prices', request: { capability: SeoCapabilities['keyword-metrics'], target: null, keywords: ['solar'], locationCode: 2840, languageCode: 'en', limit: 100, tag: 'task' } }],
  }
  const repo = new SeoRepository(db)
  const policy = { accountKey: 'account', maxRunCostMicros: 1000, accountDailyLimitMicros: 1000, accountMonthlyLimitMicros: 1000, projectMonthlyLimitMicros: 1000 }
  return { db, repo, admission, policy }
}

const receipt = (costMicros: number): SeoAdapterResult => ({ outcome: SeoAdapterOutcomes.completed, tasks: [{ remoteTaskId: 'upstream', statusCode: 20000, costMicros }], results: emptySeoResults(), error: null, fetchedAt: '2026-10-22T12:00:00.000Z' })

test('an accepted intent reserves once across keys, including after public history deletion', () => {
  const { db, repo, admission } = setup()
  expect(repo.admit(admission)).toBe('run')
  const replay = { ...admission, id: 'second', idempotencyKey: 'second', tasks: [{ ...admission.tasks[0]!, id: 'second-task' }] }
  expect(repo.admit(replay)).toBe('run')
  expect(db.select().from(seoJobs).all()).toHaveLength(1)
  expect(db.select().from(seoTasks).all()).toHaveLength(1)
  expect(db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[100, 0], [100, 0], [100, 0]])
  db.delete(runs).where(eq(runs.id, 'run')).run()
  expect(repo.admit({ ...replay, idempotencyKey: 'third' })).toBe('run')
  expect(() => repo.admit({ ...replay, principalId: 'other' })).toThrow('different principal')
  expect(db.select().from(seoJobs).all()).toHaveLength(1)
})

test('verified failed reconciliation overrides collected success without charging twice', () => {
  const { db, repo, admission, policy } = setup()
  repo.admit(admission)
  const task = repo.claim('run', policy)!
  repo.settle(task.id, receipt(150), task.leaseOwner!)
  const input = { actualCostMicros: 150, remoteTaskId: 'upstream', outcome: SeoAdapterOutcomes.failed, note: 'Provider verified the task failed' }
  repo.reconcile(task.id, input)
  repo.reconcile(task.id, input)
  expect(db.select().from(seoTasks).get()).toMatchObject({ status: SeoRunStatuses.failed, actualMicros: 150, reconciliation: input, error: 'The upstream task was reconciled as failed.' })
  expect(db.select().from(seoJobs).get()?.status).toBe(SeoRunStatuses.failed)
  expect(db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 150], [0, 150], [0, 150]])
})

test('a recovered task accepts its original late receipt but cannot overwrite operator settlement', () => {
  const { db, repo, admission, policy } = setup()
  repo.admit(admission)
  const task = repo.claim('run', policy)!
  db.update(seoTasks).set({ leaseUntil: '2000-01-01T00:00:00.000Z' }).where(eq(seoTasks.id, task.id)).run()
  repo.recover()
  const rejected = repo.settle(task.id, receipt(70), 'different-owner')
  const accepted = repo.settle(task.id, receipt(70), task.leaseOwner!)
  const duplicate = repo.settle(task.id, receipt(70), task.leaseOwner!)
  expect(db.select().from(seoTasks).get()).toMatchObject({ status: SeoRunStatuses.completed, actualMicros: 70, receipts: receipt(70).tasks })
  expect([rejected, accepted, duplicate]).toEqual([false, true, false])
  expect(db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 70], [0, 70], [0, 70]])

  const second = { ...admission, id: 'second', requestHash: 'intent-2', idempotencyKey: 'second', tasks: [{ ...admission.tasks[0]!, id: 'second-task' }] }
  repo.admit(second)
  const next = repo.claim('second', policy)!
  db.update(seoTasks).set({ leaseUntil: '2000-01-01T00:00:00.000Z' }).where(eq(seoTasks.id, next.id)).run()
  repo.recover()
  repo.reconcile(next.id, { actualCostMicros: 40, remoteTaskId: 'upstream-2', outcome: SeoAdapterOutcomes.failed, note: 'Verified by operator' })
  expect(repo.settle(next.id, receipt(80), next.leaseOwner!)).toBe(false)
  expect(db.select().from(seoTasks).where(eq(seoTasks.id, next.id)).get()).toMatchObject({ status: SeoRunStatuses.failed, actualMicros: 40 })
  expect(db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])).toEqual([[0, 110], [0, 110], [0, 110]])
})

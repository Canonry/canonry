import { expect, onTestFinished, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { SeoAdapterOutcomes, SeoCapabilities, SeoRunStatuses, emptySeoResults, type SeoAdapterResult, type SeoProfileInput } from '@canonry/canonry-contracts'
import { createClient, currentSeoTaskCondition, currentSeoTasks, migrate, projects, runs, SeoRepository, seoBudgets, seoJobs, seoProfiles, seoTasks, type SeoAdmission } from '../src/index.js'

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
/** What the adapter returns when Google itself answered a search with an error. */
const searchEngineError = (costMicros: number): SeoAdapterResult => ({ outcome: SeoAdapterOutcomes.failed, retryable: true, tasks: [{ remoteTaskId: 'upstream', statusCode: 40101, costMicros }], results: emptySeoResults(), error: 'Some SEO provider results could not be collected.', fetchedAt: '2026-10-22T12:00:00.000Z' })
/** A market-rankings refresh of the given searches, 100 microUSD each. */
function searches(admission: SeoAdmission, ...texts: string[]): SeoAdmission {
  return { ...admission, tasks: texts.map((text, index) => ({
    id: `search-${index + 1}`, reservedMicros: 100, catalogRevision: 'prices',
    request: { capability: SeoCapabilities['market-rankings'], target: { kind: 'domain', value: 'example.com', includeSubdomains: true }, keywords: [text], locationCode: 2840, languageCode: 'en', limit: 100, tag: `search-${index + 1}`, search: { device: 'mobile', depth: 10, locationLabel: 'United States', markets: [] } },
  })) }
}
const holds = (db: ReturnType<typeof setup>['db']) => db.select().from(seoBudgets).all().map(row => [row.reservedMicros, row.spentMicros])
/** The attempts that count, by the code rule and by the SQL rule, which must agree. */
function counted(db: ReturnType<typeof setup>['db']) {
  const byCode = currentSeoTasks(db.select().from(seoTasks).all()).map(task => task.id).sort()
  const bySql = db.select({ id: seoTasks.id }).from(seoTasks).where(currentSeoTaskCondition()).all().map(task => task.id).sort()
  expect(bySql).toEqual(byCode)
  return byCode
}

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

test('a search-engine error earns one retry, run after every first attempt and never retried itself', () => {
  const { db, repo, admission, policy } = setup()
  repo.admit(searches(admission, 'solar installer', 'home battery'))
  const first = repo.claim('run', policy)!
  expect(first.id).toBe('search-1')
  repo.settle(first.id, searchEngineError(0), first.leaseOwner!, policy)
  const retry = db.select().from(seoTasks).where(eq(seoTasks.retryOf, 'search-1')).get()!
  // Same search, its own tag and hold; the refresh keeps running.
  expect(retry).toMatchObject({ status: SeoRunStatuses.queued, reservedMicros: 100, request: { keywords: ['solar installer'], tag: retry.id } })
  expect(db.select().from(seoJobs).get()?.status).toBe(SeoRunStatuses.running)
  expect(holds(db)).toEqual([[200, 0], [200, 0], [200, 0]])

  // The other first attempt still goes before the retry.
  const second = repo.claim('run', policy)!
  expect(second.id).toBe('search-2')
  repo.settle(second.id, receipt(40), second.leaseOwner!, policy)
  const again = repo.claim('run', policy)!
  expect(again.id).toBe(retry.id)
  repo.settle(again.id, searchEngineError(30), again.leaseOwner!, policy)

  expect(db.select().from(seoTasks).all()).toHaveLength(3)
  expect(counted(db)).toEqual([retry.id, 'search-2'].sort())
  expect(repo.claim('run', policy)).toBeNull()
  // The retry's outcome decides: one search ranked, one failed twice.
  expect(db.select().from(seoJobs).get()?.status).toBe(SeoRunStatuses.partial)
  expect(holds(db)).toEqual([[0, 70], [0, 70], [0, 70]])
})

test('a successful retry completes the refresh, and a retry that would pass a limit is never queued', () => {
  const { db, repo, admission, policy } = setup()
  repo.admit(searches(admission, 'solar installer'))
  const first = repo.claim('run', policy)!
  repo.settle(first.id, searchEngineError(0), first.leaseOwner!, policy)
  const retry = repo.claim('run', policy)!
  repo.settle(retry.id, receipt(60), retry.leaseOwner!, policy)
  expect(db.select().from(seoJobs).get()?.status).toBe(SeoRunStatuses.completed)

  const tight = { ...policy, accountDailyLimitMicros: 150 }
  const next = { ...searches(admission, 'home battery'), id: 'next', requestHash: 'intent-2', idempotencyKey: 'next' }
  next.tasks = next.tasks.map(task => ({ ...task, id: 'next-search' }))
  repo.admit(next)
  const failed = repo.claim('next', policy)!
  // 60 spent today plus another 100 would pass the 150 daily limit.
  repo.settle(failed.id, searchEngineError(0), failed.leaseOwner!, tight)
  expect(db.select().from(seoTasks).where(eq(seoTasks.retryOf, 'next-search')).get()).toBeUndefined()
  expect(db.select().from(seoJobs).where(eq(seoJobs.id, 'next')).get()?.status).toBe(SeoRunStatuses.failed)
})

test('cancelling a refresh releases a queued retry\'s hold and the first attempt\'s failure stands', () => {
  const { db, repo, admission, policy } = setup()
  repo.admit(searches(admission, 'solar installer'))
  const first = repo.claim('run', policy)!
  repo.settle(first.id, searchEngineError(25), first.leaseOwner!, policy)
  expect(holds(db)).toEqual([[100, 25], [100, 25], [100, 25]])
  repo.cancel('run')
  expect(db.select({ id: seoTasks.id, status: seoTasks.status }).from(seoTasks).all()).toEqual([
    { id: 'search-1', status: SeoRunStatuses.failed },
    { id: expect.any(String), status: SeoRunStatuses.cancelled },
  ])
  expect(holds(db)).toEqual([[0, 25], [0, 25], [0, 25]])
  // A retry that never ran replaces nothing: the first attempt's failure is what counts.
  expect(counted(db)).toEqual(['search-1'])
  // Without a policy (no runtime limits in hand) nothing is retried.
  const next = { ...searches(admission, 'home battery'), id: 'next', requestHash: 'intent-2', idempotencyKey: 'next' }
  next.tasks = next.tasks.map(task => ({ ...task, id: 'next-search' }))
  repo.admit(next)
  const failed = repo.claim('next', policy)!
  repo.settle(failed.id, searchEngineError(0), failed.leaseOwner!)
  expect(db.select().from(seoTasks).where(eq(seoTasks.retryOf, 'next-search')).get()).toBeUndefined()
})

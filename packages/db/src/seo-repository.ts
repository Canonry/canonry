import crypto from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { RunKinds, RunStatuses, RunTriggers, SeoAdapterOutcomes, SeoRunStatuses, validationError, type RunTrigger, type SeoAdapterResult, type SeoProfileInput, emptySeoResults } from '@canonry/canonry-contracts'
import type { DatabaseClient } from './client.js'
import { measurementPlans, runs } from './schema.js'
import { seoBudgets, seoJobs, seoProfiles, seoTasks, type SeoBudgetBucket } from './seo-schema.js'

export { emptySeoResults } from '@canonry/canonry-contracts'
export type SeoJobRow = typeof seoJobs.$inferSelect
export type SeoTaskRow = typeof seoTasks.$inferSelect
export interface SeoDispatchPolicy {
  accountKey: string
  maxRunCostMicros: number
  accountDailyLimitMicros: number
  accountMonthlyLimitMicros: number
  projectMonthlyLimitMicros: number
}
/** The limits a retry is held to: the dispatch policy without the account it already belongs to. */
export type SeoRetryPolicy = Omit<SeoDispatchPolicy, 'accountKey'>
type SeoTransaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

/**
 * A refresh's tasks as they stand. A retry replaces the first attempt it repeats, so each search
 * counts once; a retry that never ran (cancelled) leaves the first attempt standing.
 * `currentSeoTaskCondition` is the same rule for SQL aggregates: change both together.
 */
export function currentSeoTasks<T extends Pick<SeoTaskRow, 'id' | 'status' | 'retryOf'>>(tasks: readonly T[]): T[] {
  const replaced = new Set(tasks.flatMap(task => (task.retryOf && task.status !== SeoRunStatuses.cancelled ? [task.retryOf] : [])))
  return tasks.filter(task => (task.retryOf ? task.status !== SeoRunStatuses.cancelled : !replaced.has(task.id)))
}

/** `currentSeoTasks` as a condition on `seo_tasks`, for reads that count tasks in SQL. */
export function currentSeoTaskCondition() {
  return sql`(${seoTasks.retryOf} IS NULL OR ${seoTasks.status} <> ${SeoRunStatuses.cancelled}) AND NOT EXISTS (SELECT 1 FROM seo_tasks AS retry WHERE retry.retry_of = ${seoTasks.id} AND retry.status <> ${SeoRunStatuses.cancelled})`
}

/** The policy limit of each budget bucket a job reserves against. */
function bucketLimits(job: SeoJobRow, policy: SeoRetryPolicy): Map<string, number> {
  return new Map([
    [`account-day:${job.accountKey}`, policy.accountDailyLimitMicros],
    [`account-month:${job.accountKey}`, policy.accountMonthlyLimitMicros],
    [`project-month:${job.projectKey}`, policy.projectMonthlyLimitMicros],
  ])
}

export interface SeoAdmission {
  id: string; projectId: string; profileId: string; profileRevision: number; profile: SeoProfileInput
  scopeSnapshot: Record<string, unknown>; requestHash: string; idempotencyKey: string; principalId: string
  accountKey: string; buckets: SeoBudgetBucket[]; tasks: Array<Pick<SeoTaskRow, 'id' | 'request' | 'reservedMicros' | 'catalogRevision'>>
  now: string
  /** Who started the refresh: a person or key (manual, the default) or a schedule. */
  trigger?: RunTrigger
}

/** Durable admission and settlement; all amounts are private integer microUSD. */
export class SeoRepository {
  constructor(private readonly db: DatabaseClient) {}

  admit(input: SeoAdmission, audit?: (tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]) => void): string {
    return this.db.transaction(tx => {
      const existing = tx.select().from(seoJobs).where(and(eq(seoJobs.projectKey, input.projectId), eq(seoJobs.idempotencyKey, input.idempotencyKey))).get()
      if (existing) {
        if (existing.requestHash !== input.requestHash || existing.principalId !== input.principalId) throw validationError('This idempotency key belongs to a different SEO refresh.')
        return existing.id
      }
      const acceptedIntent = tx.select().from(seoJobs).where(and(eq(seoJobs.projectKey, input.projectId), eq(seoJobs.requestHash, input.requestHash))).get()
      if (acceptedIntent) {
        if (acceptedIntent.principalId !== input.principalId) throw validationError('This SEO refresh intent belongs to a different principal.')
        return acceptedIntent.id
      }
      const profile = tx.select().from(seoProfiles).where(and(eq(seoProfiles.projectId, input.projectId), eq(seoProfiles.id, input.profileId))).get()
      if (!profile || profile.revision !== input.profileRevision) throw validationError('The SEO profile changed. Create a new refresh intent.')
      const activePlan = tx.select().from(measurementPlans).where(eq(measurementPlans.projectId, input.projectId)).get()
      if ((activePlan?.activeVersionId ?? null) !== (input.scopeSnapshot.planVersionId ?? null)) throw validationError('The measurement plan changed. Create a new refresh intent.')
      if (tx.select({ id: seoJobs.id }).from(seoJobs).where(and(eq(seoJobs.accountKey, input.accountKey), eq(seoJobs.status, SeoRunStatuses['reconciliation-required']))).get()) throw validationError('SEO refresh is unavailable while a previous request needs reconciliation.')
      const total = input.tasks.reduce((sum, task) => sum + task.reservedMicros, 0)
      if (!Number.isSafeInteger(total) || total <= 0) throw validationError('SEO refresh is unavailable under the current policy.')
      for (const bucket of input.buckets) {
        tx.insert(seoBudgets).values({ scope: bucket.scope, period: bucket.period }).onConflictDoNothing().run()
        // Prior-period unresolved reservations count against today's capacity too.
        const claim = tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} + ${total}` }).where(and(
          eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period),
          sql`${seoBudgets.spentMicros} + (SELECT COALESCE(SUM(reserved_micros),0) FROM seo_budgets b WHERE b.scope = ${bucket.scope}) + ${total} <= ${bucket.limit}`,
        )).run()
        if (!claim.changes) throw validationError('SEO refresh is unavailable under the current policy.')
      }
      tx.insert(runs).values({ id: input.id, projectId: input.projectId, kind: RunKinds['seo-sync'], status: RunStatuses.queued, trigger: input.trigger ?? RunTriggers.manual, createdAt: input.now }).run()
      tx.insert(seoJobs).values({ id: input.id, projectId: input.projectId, projectKey: input.projectId, runId: input.id, profileId: input.profileId, profileRevision: input.profileRevision, profile: input.profile, scopeSnapshot: input.scopeSnapshot, requestHash: input.requestHash, idempotencyKey: input.idempotencyKey, principalId: input.principalId, connectionId: input.profile.connectionId, accountKey: input.accountKey, buckets: input.buckets, status: SeoRunStatuses.queued, createdAt: input.now }).run()
      for (const task of input.tasks) tx.insert(seoTasks).values({ ...task, jobId: input.id, status: SeoRunStatuses.queued, results: emptySeoResults() }).run()
      audit?.(tx)
      return input.id
    }, { behavior: 'immediate' })
  }

  claim(jobId: string, policy: SeoDispatchPolicy): SeoTaskRow | null {
    return this.db.transaction(tx => {
      const job = tx.select().from(seoJobs).where(eq(seoJobs.id, jobId)).get()
      if (!job || !job.projectId || !job.runId || job.cancelRequested) return null
      if (policy.accountKey !== job.accountKey) { this.cancel(jobId); return null }
      if (tx.select({ id: seoTasks.id }).from(seoTasks).innerJoin(seoJobs, eq(seoTasks.jobId, seoJobs.id)).where(and(eq(seoJobs.accountKey, job.accountKey), inArray(seoTasks.status, [SeoRunStatuses.running, SeoRunStatuses['reconciliation-required']]))).get()) return null
      const allTasks = tx.select().from(seoTasks).where(eq(seoTasks.jobId, jobId)).orderBy(asc(seoTasks.id)).all()
      // Every first attempt goes before any retry, so retries run at the end of the refresh.
      const task = allTasks.find(row => row.status === SeoRunStatuses.queued && !row.retryOf) ?? allTasks.find(row => row.status === SeoRunStatuses.queued)
      if (!task) return null
      const now = new Date().toISOString()
      const outstanding = allTasks.filter(row => row.status === SeoRunStatuses.queued).reduce((sum, row) => sum + row.reservedMicros, 0)
      const limits = bucketLimits(job, policy)
      const buckets = job.buckets.map(bucket => ({ ...bucket, limit: limits.get(bucket.scope) ?? 0, period: now.slice(0, bucket.scope.startsWith('account-day:') ? 10 : 7) }))
      const runMaximum = allTasks.reduce((sum, row) => sum + (row.actualMicros ?? row.reservedMicros), 0)
      const allowed = runMaximum <= policy.maxRunCostMicros && buckets.every(bucket => {
        const current = tx.select().from(seoBudgets).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).get()
        const held = tx.select({ total: sql<number>`coalesce(sum(${seoBudgets.reservedMicros}),0)` }).from(seoBudgets).where(eq(seoBudgets.scope, bucket.scope)).get()!.total
        return (current?.spentMicros ?? 0) + held <= bucket.limit
      })
      if (!allowed) { this.cancel(jobId); return null }
      for (const [index, bucket] of buckets.entries()) {
        const old = job.buckets[index]!
        if (old.period === bucket.period) continue
        tx.insert(seoBudgets).values({ scope: bucket.scope, period: bucket.period }).onConflictDoNothing().run()
        // Moving a hold does not add capacity: include every outstanding period.
        tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} + ${outstanding}` }).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).run()
        tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} - ${outstanding}` }).where(and(eq(seoBudgets.scope, old.scope), eq(seoBudgets.period, old.period))).run()
      }
      tx.update(seoJobs).set({ buckets }).where(eq(seoJobs.id, jobId)).run()
      const leaseOwner = crypto.randomUUID()
      const leaseUntil = new Date(Date.now() + 120_000).toISOString()
      tx.update(seoTasks).set({ status: SeoRunStatuses.running, startedAt: now, leaseOwner, leaseUntil }).where(eq(seoTasks.id, task.id)).run()
      tx.update(seoJobs).set({ status: SeoRunStatuses.running, startedAt: job.startedAt ?? now }).where(eq(seoJobs.id, jobId)).run()
      tx.update(runs).set({ status: RunStatuses.running, startedAt: job.startedAt ?? now }).where(eq(runs.id, job.runId)).run()
      return { ...task, status: SeoRunStatuses.running, startedAt: now, leaseOwner, leaseUntil }
    }, { behavior: 'immediate' })
  }

  renew(taskId: string, owner: string): void {
    this.db.update(seoTasks).set({ leaseUntil: new Date(Date.now() + 120_000).toISOString() }).where(and(eq(seoTasks.id, taskId), eq(seoTasks.leaseOwner, owner), eq(seoTasks.status, SeoRunStatuses.running))).run()
  }

  /**
   * Store a task's outcome. With `retryPolicy`, a search the adapter marks `retryable` gets one
   * more attempt, queued in the same transaction (see `queueRetry`).
   */
  settle(taskId: string, result: SeoAdapterResult, owner: string, retryPolicy?: SeoRetryPolicy): boolean {
    return this.db.transaction(tx => {
      const task = tx.select().from(seoTasks).where(eq(seoTasks.id, taskId)).get()
      if (!task || task.leaseOwner !== owner || task.reconciliation || (task.status !== SeoRunStatuses.running && task.status !== SeoRunStatuses['reconciliation-required'])) return false
      const job = tx.select().from(seoJobs).where(eq(seoJobs.id, task.jobId)).get()!
      const costs = result.tasks.map(receipt => receipt.costMicros)
      const actual = costs.length > 0 && costs.every(cost => cost !== null && Number.isSafeInteger(cost) && cost >= 0) ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null
      const known = actual !== null && Number.isSafeInteger(actual) && result.outcome !== SeoAdapterOutcomes.unknown
      const status = known && actual <= task.reservedMicros ? result.outcome === SeoAdapterOutcomes.completed ? SeoRunStatuses.completed : result.outcome === SeoAdapterOutcomes.partial ? SeoRunStatuses.partial : SeoRunStatuses.failed : SeoRunStatuses['reconciliation-required']
      if (known) for (const bucket of job.buckets) tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} - ${task.reservedMicros}`, spentMicros: sql`${seoBudgets.spentMicros} + ${actual}` }).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).run()
      const error = status === SeoRunStatuses['reconciliation-required'] ? 'The upstream outcome needs operator reconciliation. This request will not be retried.' : status === SeoRunStatuses.failed ? 'The SEO provider could not complete this task.' : null
      tx.update(seoTasks).set({ status, collectionOutcome: result.outcome, actualMicros: known ? actual : null, receipts: result.tasks, results: result.results, error, leaseOwner: null, leaseUntil: null, finishedAt: new Date().toISOString() }).where(eq(seoTasks.id, taskId)).run()
      if (status === SeoRunStatuses.failed && result.retryable === true && retryPolicy) this.queueRetry(tx, task, job, retryPolicy)
      this.finish(job.id)
      return true
    }, { behavior: 'immediate' })
  }

  /**
   * Queue the one retry a search gets after a search-engine error. It reserves the first attempt's
   * amount again, inside the same limits, and claims take it after every first attempt, so it runs
   * at the end of the refresh. A retry is never retried, a cancelled refresh gets none, and one that
   * would pass a limit is not queued, leaving the search failed.
   */
  private queueRetry(tx: SeoTransaction, task: SeoTaskRow, job: SeoJobRow, policy: SeoRetryPolicy): void {
    if (job.cancelRequested || task.retryOf || tx.select({ id: seoTasks.id }).from(seoTasks).where(eq(seoTasks.retryOf, task.id)).get()) return
    const amount = task.reservedMicros
    // The run's ceiling counts every paid attempt, this task's settled cost included.
    const runCost = tx.select({ actualMicros: seoTasks.actualMicros, reservedMicros: seoTasks.reservedMicros }).from(seoTasks).where(eq(seoTasks.jobId, job.id)).all()
      .reduce((sum, row) => sum + (row.actualMicros ?? row.reservedMicros), 0)
    if (runCost + amount > policy.maxRunCostMicros) return
    const limits = bucketLimits(job, policy)
    const fits = job.buckets.every(bucket => {
      const current = tx.select({ spentMicros: seoBudgets.spentMicros }).from(seoBudgets).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).get()
      const held = tx.select({ total: sql<number>`coalesce(sum(${seoBudgets.reservedMicros}),0)` }).from(seoBudgets).where(eq(seoBudgets.scope, bucket.scope)).get()!.total
      return (current?.spentMicros ?? 0) + held + amount <= (limits.get(bucket.scope) ?? 0)
    })
    if (!fits) return
    for (const bucket of job.buckets) {
      tx.insert(seoBudgets).values({ scope: bucket.scope, period: bucket.period }).onConflictDoNothing().run()
      tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} + ${amount}` }).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).run()
    }
    const id = crypto.randomUUID()
    tx.insert(seoTasks).values({ id, jobId: job.id, request: { ...task.request, tag: id }, status: SeoRunStatuses.queued, reservedMicros: amount, catalogRevision: task.catalogRevision, results: emptySeoResults(), retryOf: task.id }).run()
  }

  cancel(jobId: string): boolean {
    return this.db.transaction(tx => {
      const job = tx.select().from(seoJobs).where(eq(seoJobs.id, jobId)).get()
      if (!job || (job.status !== SeoRunStatuses.queued && job.status !== SeoRunStatuses.running && job.status !== SeoRunStatuses['reconciliation-required'])) return false
      tx.update(seoJobs).set({ cancelRequested: true }).where(eq(seoJobs.id, jobId)).run()
      for (const task of tx.select().from(seoTasks).where(and(eq(seoTasks.jobId, jobId), eq(seoTasks.status, SeoRunStatuses.queued))).all()) {
        for (const bucket of job.buckets) tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} - ${task.reservedMicros}` }).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).run()
        tx.update(seoTasks).set({ status: SeoRunStatuses.cancelled, actualMicros: 0, finishedAt: new Date().toISOString() }).where(eq(seoTasks.id, task.id)).run()
      }
      // In-flight calls settle normally; cancellation never pretends they were free.
      this.finish(jobId)
      return !job.cancelRequested
    }, { behavior: 'immediate' })
  }

  reconcile(taskId: string, input: { actualCostMicros: number; remoteTaskId: string; outcome: 'completed' | 'failed'; note: string }): void {
    this.db.transaction(tx => {
      const task = tx.select().from(seoTasks).where(eq(seoTasks.id, taskId)).get()
      if (!task) throw validationError('SEO task does not exist.')
      if (task.reconciliation) {
        if (JSON.stringify(task.reconciliation) !== JSON.stringify(input)) throw validationError('This SEO task already has a different reconciliation receipt.')
        return
      }
      if (task.status !== SeoRunStatuses['reconciliation-required']) throw validationError('This SEO task does not need reconciliation.')
      if (task.actualMicros !== null && task.actualMicros !== input.actualCostMicros) throw validationError('Reconciliation must preserve the cost already reported by the provider.')
      const knownRemote = task.receipts.find(receipt => receipt.remoteTaskId)?.remoteTaskId
      if (knownRemote && knownRemote !== input.remoteTaskId) throw validationError('Reconciliation must identify the recorded upstream task.')
      const job = tx.select().from(seoJobs).where(eq(seoJobs.id, task.jobId)).get()!
      if (task.actualMicros === null) for (const bucket of job.buckets) tx.update(seoBudgets).set({ reservedMicros: sql`${seoBudgets.reservedMicros} - ${task.reservedMicros}`, spentMicros: sql`${seoBudgets.spentMicros} + ${input.actualCostMicros}` }).where(and(eq(seoBudgets.scope, bucket.scope), eq(seoBudgets.period, bucket.period))).run()
      const status = input.outcome === SeoAdapterOutcomes.failed ? SeoRunStatuses.failed : task.collectionOutcome === SeoAdapterOutcomes.completed ? SeoRunStatuses.completed : task.collectionOutcome === SeoAdapterOutcomes.partial ? SeoRunStatuses.partial : SeoRunStatuses.failed
      const error = input.outcome === SeoAdapterOutcomes.failed ? 'The upstream task was reconciled as failed.' : status === SeoRunStatuses.failed ? 'Upstream billing was reconciled, but results were not collected.' : null
      tx.update(seoTasks).set({ status, actualMicros: input.actualCostMicros, reconciliation: input, error }).where(eq(seoTasks.id, taskId)).run()
      this.finish(job.id)
    }, { behavior: 'immediate' })
  }

  recover(): void {
    this.db.transaction(tx => {
      const stale = tx.select().from(seoTasks).where(and(eq(seoTasks.status, SeoRunStatuses.running), sql`(${seoTasks.leaseUntil} IS NULL OR ${seoTasks.leaseUntil} <= ${new Date().toISOString()})`)).all()
      for (const task of stale) {
        tx.update(seoTasks).set({ status: SeoRunStatuses['reconciliation-required'], error: 'Server restarted during the upstream request; it will not be resubmitted.', finishedAt: new Date().toISOString() }).where(eq(seoTasks.id, task.id)).run()
        this.cancel(task.jobId)
      }
      for (const job of tx.select().from(seoJobs).where(and(inArray(seoJobs.status, [SeoRunStatuses.queued, SeoRunStatuses.running]), sql`(${seoJobs.projectId} IS NULL OR ${seoJobs.runId} IS NULL)`)).all()) this.cancel(job.id)
    }, { behavior: 'immediate' })
  }

  private finish(jobId: string): void {
    const job = this.db.select().from(seoJobs).where(eq(seoJobs.id, jobId)).get()!
    // A queued retry keeps the refresh running; its outcome, not the first attempt's, decides the status.
    const tasks = currentSeoTasks(this.db.select().from(seoTasks).where(eq(seoTasks.jobId, jobId)).all())
    const pending = tasks.some(task => task.status === SeoRunStatuses.queued || task.status === SeoRunStatuses.running)
    const unknown = tasks.some(task => task.status === SeoRunStatuses['reconciliation-required'])
    const completed = tasks.some(task => task.status === SeoRunStatuses.completed || task.status === SeoRunStatuses.partial)
    const status = unknown ? SeoRunStatuses['reconciliation-required'] : pending ? SeoRunStatuses.running : tasks.every(task => task.status === SeoRunStatuses.completed) ? SeoRunStatuses.completed : completed ? SeoRunStatuses.partial : job.cancelRequested ? SeoRunStatuses.cancelled : SeoRunStatuses.failed
    const error = unknown ? 'An upstream request needs operator reconciliation.' : null
    const finishedAt = pending ? null : job.finishedAt ?? new Date().toISOString()
    this.db.update(seoJobs).set({ status, finishedAt, error }).where(eq(seoJobs.id, jobId)).run()
    if (job.runId) this.db.update(runs).set({ status: pending ? RunStatuses.running : status === SeoRunStatuses['reconciliation-required'] ? completed ? RunStatuses.partial : RunStatuses.failed : status, finishedAt, error }).where(eq(runs.id, job.runId)).run()
  }
}

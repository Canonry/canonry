import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import type { DatabaseClient } from './client.js'
import {
  auditLog, llmUsageEvents, runs, sentimentAttempts, sentimentCompletionReceipts, sentimentDefinitions, sentimentDispatchState,
  sentimentJobItems, sentimentJobs, sentimentResults, sentimentSettings, sentimentWorkItems,
} from './schema.js'

type SentimentDb = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'all'>
export type SentimentWorkAdmission = Pick<typeof sentimentWorkItems.$inferInsert,
  'runId' | 'snapshotId' | 'sourceTextHash' | 'subjectHash' | 'input' | 'edges'>
export interface SentimentJobAdmission {
  projectId: string
  action: string
  origin: string
  enablementEpoch: number
  evaluationDefinitionId: string
  idempotencyKey: string
  payloadHash: string
  selection: unknown
  actor: string
  work: SentimentWorkAdmission[]
  now: string
  allowReplayCanceled?: boolean
}

/** Provider refusals that pause dispatch for the whole install rather than spend an assessment's retry budget. */
export type SentimentDispatchBlock = 'provider-rate-limit' | 'provider-authorization'
/** open: full concurrency; probe: one request to test whether the provider accepts again; closed: none. */
export type SentimentDispatchGate = 'open' | 'probe' | 'closed'
const DISPATCH_STATE_ID = 'install'

export class SentimentIdempotencyConflict extends Error {
  constructor() { super('Sentiment idempotency key already has a different payload'); this.name = 'SentimentIdempotencyConflict' }
}

/** Call within the same transaction that transitions the source run to complete. */
export function recordSentimentCompletion(db: SentimentDb, input: {
  projectId: string; runId: string; completionKey: string; completedAt: string; fillOrigin?: string | null
}) {
  const run = db.select().from(runs).where(and(eq(runs.id, input.runId), eq(runs.projectId, input.projectId))).get()
  if (!run || run.kind !== RunKinds['answer-visibility'] || run.trigger === RunTriggers.probe || run.status !== RunStatuses.completed) return undefined
  const identity = and(eq(sentimentCompletionReceipts.projectId, input.projectId),
    eq(sentimentCompletionReceipts.runId, input.runId), eq(sentimentCompletionReceipts.completionKey, input.completionKey))
  const prior = db.select().from(sentimentCompletionReceipts).where(identity).get()
  if (prior) return prior
  db.insert(sentimentCompletionReceipts).values({ ...input, kind: run.kind, trigger: run.trigger })
    .onConflictDoNothing().run()
  return db.select().from(sentimentCompletionReceipts).where(identity).get()
}

function lookupJob(db: SentimentDb, projectId: string, action: string, key: string, payloadHash: string) {
  const row = db.select().from(sentimentJobs).where(and(
    eq(sentimentJobs.projectId, projectId), eq(sentimentJobs.action, action), eq(sentimentJobs.idempotencyKey, key),
  )).get()
  if (row && row.payloadHash !== payloadHash) throw new SentimentIdempotencyConflict()
  return row
}

type JobBucket = 'pending' | 'running' | 'completed' | 'failed' | 'canceled'
const JOB_BUCKET_KEYS = {
  pending: 'pendingItems', running: 'runningItems', completed: 'completedItems', failed: 'failedItems', canceled: 'canceledItems',
} as const satisfies Record<JobBucket, keyof typeof sentimentJobs.$inferSelect>

function jobBucket(status: string): JobBucket {
  switch (status) {
    case 'pending': case 'waiting-to-retry': return 'pending'
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'canceled': return 'canceled'
    default: throw new Error(`Unknown sentiment work status: ${status}`)
  }
}

const jobItemTotal = sql`(${sentimentJobs.pendingItems} + ${sentimentJobs.runningItems} + ${sentimentJobs.completedItems} + ${sentimentJobs.failedItems} + ${sentimentJobs.canceledItems})`
/** Precedence over the member counts: all complete, any running, any queued, all canceled, all failed, otherwise partial. */
const jobStateFromCounts = sql<string>`CASE
  WHEN ${sentimentJobs.completedItems} = ${jobItemTotal} THEN 'complete'
  WHEN ${sentimentJobs.runningItems} > 0 THEN 'running'
  WHEN ${sentimentJobs.pendingItems} > 0 THEN 'pending'
  WHEN ${sentimentJobs.canceledItems} = ${jobItemTotal} THEN 'canceled'
  WHEN ${sentimentJobs.failedItems} = ${jobItemTotal} THEN 'failed'
  ELSE 'partial' END`

/** Canceled jobs keep their state; a canceled selection never resumes implicitly. */
function settleJobs(db: SentimentDb, jobIds: string[], now: string) {
  if (!jobIds.length) return
  db.update(sentimentJobs).set({ state: jobStateFromCounts, updatedAt: now })
    .where(and(inArray(sentimentJobs.id, jobIds), sql`${sentimentJobs.state} <> 'canceled'`)).run()
}

/**
 * Move one assessment between count buckets in every job whose membership still
 * follows it. The cost is the number of jobs sharing the assessment, never the
 * size of those jobs.
 */
function shiftJobs(db: SentimentDb, workItemId: string, from: string, to: string, now: string) {
  const jobIds = db.select({ id: sentimentJobItems.jobId }).from(sentimentJobItems)
    .where(and(eq(sentimentJobItems.workItemId, workItemId), isNull(sentimentJobItems.canceledAt))).all().map(row => row.id)
  if (!jobIds.length) return
  const source = JOB_BUCKET_KEYS[jobBucket(from)], target = JOB_BUCKET_KEYS[jobBucket(to)]
  if (source !== target) {
    const shift: SQLiteUpdateSetSource<typeof sentimentJobs> = {
      [source]: sql`${sentimentJobs[source]} - 1`, [target]: sql`${sentimentJobs[target]} + 1`,
    }
    db.update(sentimentJobs).set(shift).where(inArray(sentimentJobs.id, jobIds)).run()
  }
  settleJobs(db, jobIds, now)
}

/** Full recount, used once per admission and per cancellation; transitions use shiftJobs. */
function recountJobs(db: SentimentDb, jobIds: string[], now: string) {
  if (!jobIds.length) return
  const bucket = sql<string>`CASE WHEN ${sentimentJobItems.canceledAt} IS NOT NULL THEN 'canceled' ELSE ${sentimentWorkItems.status} END`
  const rows = db.select({ jobId: sentimentJobItems.jobId, bucket, count: sql<number>`count(*)` })
    .from(sentimentJobItems).innerJoin(sentimentWorkItems, eq(sentimentWorkItems.id, sentimentJobItems.workItemId))
    .where(inArray(sentimentJobItems.jobId, jobIds)).groupBy(sentimentJobItems.jobId, bucket).all()
  const counts = new Map(jobIds.map(id => [id, { pendingItems: 0, runningItems: 0, completedItems: 0, failedItems: 0, canceledItems: 0 }]))
  for (const row of rows) counts.get(row.jobId)![JOB_BUCKET_KEYS[jobBucket(row.bucket)]] += row.count
  for (const [id, values] of counts) db.update(sentimentJobs).set(values).where(eq(sentimentJobs.id, id)).run()
  settleJobs(db, jobIds, now)
}

function cancelProject(db: SentimentDb, projectId: string, now: string, reason: string) {
  const active = and(eq(sentimentWorkItems.projectId, projectId),
    inArray(sentimentWorkItems.status, ['pending', 'running', 'waiting-to-retry']))
  const activeWork = db.select({ id: sentimentWorkItems.id }).from(sentimentWorkItems).where(active)
  const affected = db.select({ id: sentimentJobItems.jobId }).from(sentimentJobItems).where(and(
    eq(sentimentJobItems.projectId, projectId), inArray(sentimentJobItems.workItemId, activeWork), isNull(sentimentJobItems.canceledAt),
  )).groupBy(sentimentJobItems.jobId).all().map(row => row.id)
  db.update(sentimentJobItems).set({ canceledAt: now, cancellationReason: reason }).where(and(
    eq(sentimentJobItems.projectId, projectId), inArray(sentimentJobItems.workItemId, activeWork), isNull(sentimentJobItems.canceledAt),
  )).run()
  // Retain ownership of transmitted requests so their eventual response can be recorded.
  db.update(sentimentWorkItems).set({ status: 'canceled', cancellationReason: reason, nextAttemptAt: null, updatedAt: now })
    .where(active).run()
  db.update(sentimentJobs).set({ state: 'canceled', cancellationReason: reason, updatedAt: now }).where(and(
    eq(sentimentJobs.projectId, projectId), inArray(sentimentJobs.state, ['pending', 'running', 'partial']),
  )).run()
  recountJobs(db, affected, now)
}

/** Synchronous transactional storage; no provider or other asynchronous I/O belongs in these methods. */
export class SentimentRepository {
  constructor(private readonly db: DatabaseClient) {}

  putDefinition(input: typeof sentimentDefinitions.$inferInsert) {
    return this.db.transaction(tx => {
      const existing = tx.select().from(sentimentDefinitions).where(or(
        eq(sentimentDefinitions.id, input.id), eq(sentimentDefinitions.contentHash, input.contentHash),
      )).get()
      if (existing) {
        if (existing.id !== input.id || existing.contentHash !== input.contentHash || existing.requestedModel !== input.requestedModel
          || !isDeepStrictEqual(existing.definition, input.definition)) throw new Error('Sentiment evaluation definitions are immutable')
        return existing
      }
      return tx.insert(sentimentDefinitions).values(input).returning().get()
    }, { behavior: 'immediate' })
  }

  getSettings(projectId: string) {
    return this.db.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, projectId)).get()
  }

  configure(input: { projectId: string; enabled: boolean; evaluationDefinitionId: string; configuration: unknown; now: string; actor?: string; forceNewEpoch?: boolean }) {
    return this.db.transaction(tx => {
      const prior = tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, input.projectId)).get()
      const enabling = input.enabled && (!prior?.enabled || input.forceNewEpoch === true)
      // sqlite_sequence retains its high-water mark across source deletion; MAX(receipts) does not.
      const boundary = tx.all<{ seq: number }>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'sentiment_completion_receipts'`)[0]?.seq ?? 0
      const value = {
        projectId: input.projectId, enabled: input.enabled, installSuspended: prior?.installSuspended ?? false, evaluationDefinitionId: input.evaluationDefinitionId,
        configuration: input.configuration, enablementEpoch: (prior?.enablementEpoch ?? 0) + (enabling ? 1 : 0),
        completionBoundary: enabling ? boundary : prior?.completionBoundary ?? 0, updatedAt: input.now,
      }
      tx.insert(sentimentSettings).values(value).onConflictDoUpdate({ target: sentimentSettings.projectId, set: value }).run()
      if (!input.enabled) cancelProject(tx, input.projectId, input.now, 'project-disabled')
      else if (input.forceNewEpoch && prior) cancelProject(tx, input.projectId, input.now, 'evaluator-upgraded')
      tx.insert(auditLog).values({ id: randomUUID(), projectId: input.projectId, actor: input.actor ?? 'system',
        action: 'sentiment.settings-configured', entityType: 'sentiment-settings', entityId: input.projectId,
        diff: JSON.stringify({ enabled: value.enabled, enablementEpoch: value.enablementEpoch, evaluationDefinitionId: value.evaluationDefinitionId }), createdAt: input.now,
      }).run()
      return tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, input.projectId)).get()!
    }, { behavior: 'immediate' })
  }

  cancelProject(projectId: string, now: string, reason = 'project-disabled') {
    this.db.transaction(tx => cancelProject(tx, projectId, now, reason), { behavior: 'immediate' })
  }

  /** Persist the observed install switch without changing the operator's project setting. */
  suspendInstall(now: string) {
    return this.db.transaction(tx => {
      const settings = tx.select().from(sentimentSettings).where(eq(sentimentSettings.installSuspended, false)).all()
      for (const setting of settings) {
        cancelProject(tx, setting.projectId, now, 'install-disabled')
        tx.update(sentimentSettings).set({ installSuspended: true, updatedAt: now })
          .where(eq(sentimentSettings.projectId, setting.projectId)).run()
      }
      return settings.length
    }, { behavior: 'immediate' })
  }

  /** Never admit completions from the interval during which the install was disabled. */
  resumeInstall(now: string) {
    return this.db.transaction(tx => {
      const boundary = tx.all<{ seq: number }>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'sentiment_completion_receipts'`)[0]?.seq ?? 0
      const settings = tx.select().from(sentimentSettings).where(eq(sentimentSettings.installSuspended, true)).all()
      for (const setting of settings) {
        tx.update(sentimentSettings).set({ installSuspended: false, completionBoundary: boundary,
          enablementEpoch: setting.enablementEpoch + (setting.enabled ? 1 : 0), updatedAt: now,
        }).where(eq(sentimentSettings.projectId, setting.projectId)).run()
      }
      return settings.length
    }, { behavior: 'immediate' })
  }

  lookupJob(projectId: string, action: string, key: string, payloadHash: string) {
    return lookupJob(this.db, projectId, action, key, payloadHash)
  }

  getJob(projectId: string, id: string) {
    return this.db.select().from(sentimentJobs).where(and(eq(sentimentJobs.projectId, projectId), eq(sentimentJobs.id, id))).get()
  }

  admitJob(input: SentimentJobAdmission) {
    return this.db.transaction(tx => {
      const prior = lookupJob(tx, input.projectId, input.action, input.idempotencyKey, input.payloadHash)
      if (prior) return prior
      const settings = tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, input.projectId)).get()
      if (!settings?.enabled || settings.installSuspended || settings.enablementEpoch !== input.enablementEpoch) throw new Error('Sentiment project disabled or enablement epoch changed')
      const id = randomUUID()
      // Automatic admissions of new sweeps dispatch ahead of backfills of history.
      const dispatchPriority = input.origin === 'automatic' ? 0 : 1
      tx.insert(sentimentJobs).values({
        id, projectId: input.projectId, action: input.action, origin: input.origin, enablementEpoch: input.enablementEpoch,
        evaluationDefinitionId: input.evaluationDefinitionId, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash,
        selection: input.selection, actor: input.actor, state: input.work.length ? 'pending' : 'complete', createdAt: input.now, updatedAt: input.now,
      }).run()
      for (const item of input.work) {
        tx.insert(sentimentWorkItems).values({
          ...item, id: randomUUID(), projectId: input.projectId, evaluationDefinitionId: input.evaluationDefinitionId,
          enablementEpoch: input.enablementEpoch, dispatchPriority, createdAt: input.now, updatedAt: input.now,
        }).onConflictDoNothing({ target: [sentimentWorkItems.projectId, sentimentWorkItems.snapshotId, sentimentWorkItems.sourceTextHash, sentimentWorkItems.subjectHash, sentimentWorkItems.evaluationDefinitionId] }).run()
        let work = tx.select().from(sentimentWorkItems).where(and(
          eq(sentimentWorkItems.projectId, input.projectId), eq(sentimentWorkItems.snapshotId, item.snapshotId),
          eq(sentimentWorkItems.sourceTextHash, item.sourceTextHash), eq(sentimentWorkItems.subjectHash, item.subjectHash),
          eq(sentimentWorkItems.evaluationDefinitionId, input.evaluationDefinitionId),
        )).get()!
        const result = tx.select().from(sentimentResults).where(eq(sentimentResults.workItemId, work.id)).get()
        if (result || (input.allowReplayCanceled && ['canceled', 'failed'].includes(work.status))) {
          const stillLeased = !result && work.leaseOwner !== null && work.leaseExpiresAt !== null && work.leaseExpiresAt > input.now
          const previousStatus = work.status
          work = tx.update(sentimentWorkItems).set({
            status: result ? 'completed' : stillLeased ? 'running' : 'pending', enablementEpoch: input.enablementEpoch,
            leaseOwner: stillLeased ? work.leaseOwner : null, leaseExpiresAt: stillLeased ? work.leaseExpiresAt : null,
            attemptBudgetStart: result || stillLeased ? work.attemptBudgetStart : work.attemptCount,
            nextAttemptAt: null, errorCode: null, cancellationReason: null, updatedAt: input.now,
          }).where(eq(sentimentWorkItems.id, work.id)).returning().get()!
          // Earlier jobs that still follow this assessment see the replayed state.
          shiftJobs(tx, work.id, previousStatus, work.status, input.now)
        }
        if (work.dispatchPriority > dispatchPriority) {
          work = tx.update(sentimentWorkItems).set({ dispatchPriority }).where(eq(sentimentWorkItems.id, work.id)).returning().get()!
        }
        tx.insert(sentimentJobItems).values({
          projectId: input.projectId, jobId: id, workItemId: work.id, enablementEpoch: input.enablementEpoch,
          canceledAt: work.status === 'canceled' ? input.now : null,
          cancellationReason: work.status === 'canceled' ? work.cancellationReason : null,
        }).onConflictDoNothing().run()
      }
      recountJobs(tx, [id], input.now)
      tx.insert(auditLog).values({ id: randomUUID(), projectId: input.projectId, actor: input.actor,
        action: 'sentiment.job-admitted', entityType: 'sentiment-job', entityId: id,
        diff: JSON.stringify({ origin: input.origin, evaluationDefinitionId: input.evaluationDefinitionId, enablementEpoch: input.enablementEpoch }), createdAt: input.now,
      }).run()
      return tx.select().from(sentimentJobs).where(eq(sentimentJobs.id, id)).get()!
    }, { behavior: 'immediate' })
  }

  claim(input: { owner: string; now: string; leaseMs: number; projectId?: string; maxConcurrent?: number }) {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) throw new Error('Sentiment lease must be positive')
    return this.db.transaction(tx => {
      if (input.maxConcurrent !== undefined) {
        const running = tx.select({ count: sql<number>`count(*)` }).from(sentimentWorkItems).where(and(
          isNotNull(sentimentWorkItems.leaseOwner), gt(sentimentWorkItems.leaseExpiresAt, input.now),
        )).get()!.count
        if (running >= input.maxConcurrent) return undefined
      }
      const row = tx.select({ work: sentimentWorkItems }).from(sentimentWorkItems)
        .innerJoin(sentimentSettings, eq(sentimentSettings.projectId, sentimentWorkItems.projectId))
        .where(and(
          eq(sentimentSettings.enabled, true), eq(sentimentSettings.installSuspended, false), eq(sentimentSettings.enablementEpoch, sentimentWorkItems.enablementEpoch),
          input.projectId ? eq(sentimentWorkItems.projectId, input.projectId) : undefined,
          or(and(eq(sentimentWorkItems.status, 'pending'), or(isNull(sentimentWorkItems.leaseExpiresAt), lte(sentimentWorkItems.leaseExpiresAt, input.now))),
            and(eq(sentimentWorkItems.status, 'waiting-to-retry'), lte(sentimentWorkItems.nextAttemptAt, input.now)),
            and(eq(sentimentWorkItems.status, 'running'), lte(sentimentWorkItems.leaseExpiresAt, input.now))),
        // Automatic work first; within a tier the project claimed least recently goes next.
        )).orderBy(asc(sentimentWorkItems.dispatchPriority), asc(sentimentSettings.dispatchTurn), asc(sentimentWorkItems.createdAt), asc(sentimentWorkItems.id)).get()?.work
      if (!row) return undefined
      const claimed = tx.update(sentimentWorkItems).set({
        status: 'running', leaseOwner: input.owner, leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        nextAttemptAt: null, updatedAt: input.now,
      }).where(eq(sentimentWorkItems.id, row.id)).returning().get()
      const lastTurn = tx.select({ turn: sql<number>`coalesce(max(${sentimentSettings.dispatchTurn}), 0)` }).from(sentimentSettings).get()!.turn
      tx.update(sentimentSettings).set({ dispatchTurn: lastTurn + 1 }).where(eq(sentimentSettings.projectId, row.projectId)).run()
      shiftJobs(tx, row.id, row.status, 'running', input.now)
      return claimed
    }, { behavior: 'immediate' })
  }

  startAttempt(input: {
    workItemId: string; owner: string; requestedModel: string; now: string; estimatedInputTokens?: number
    maxRequestsPerMinute?: number; maxInputTokensPerMinute?: number; maxAttempts?: number
  }) {
    return this.db.transaction(tx => {
      const work = tx.select().from(sentimentWorkItems).where(and(
        eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner),
        eq(sentimentWorkItems.status, 'running'), gt(sentimentWorkItems.leaseExpiresAt, input.now),
      )).get()
      if (!work) return undefined
      const settings = tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, work.projectId)).get()
      if (!settings?.enabled || settings.installSuspended || settings.enablementEpoch !== work.enablementEpoch) return undefined
      if (input.maxAttempts !== undefined && work.attemptCount - work.attemptBudgetStart >= input.maxAttempts) return undefined
      const estimate = input.estimatedInputTokens ?? 0
      if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error('Invalid sentiment token estimate')
      const since = new Date(Date.parse(input.now) - 60_000).toISOString()
      const used = tx.select({ requests: sql<number>`count(*)`, tokens: sql<number>`coalesce(sum(${sentimentAttempts.estimatedInputTokens}), 0)` })
        .from(sentimentAttempts).where(gt(sentimentAttempts.dispatchedAt, since)).get()!
      if (input.maxRequestsPerMinute !== undefined && used.requests >= input.maxRequestsPerMinute) return undefined
      if (input.maxInputTokensPerMinute !== undefined && used.tokens + estimate > input.maxInputTokensPerMinute) return undefined
      const attemptNumber = work.attemptCount + 1
      tx.update(sentimentWorkItems).set({ attemptCount: attemptNumber, updatedAt: input.now }).where(eq(sentimentWorkItems.id, work.id)).run()
      return tx.insert(sentimentAttempts).values({
        id: randomUUID(), projectId: work.projectId, workItemId: work.id, attemptNumber,
        requestedModel: input.requestedModel, dispatchedAt: input.now, estimatedInputTokens: estimate,
      }).returning().get()
    }, { behavior: 'immediate' })
  }

  finishAttempt(input: {
    attemptId: string; now: string; returnedModel: string | null; usageStatus: 'reported' | 'estimated' | 'unknown'
    usage?: { inputTokens: number; outputTokens: number; costMillicents?: number }; safeFailure?: string | null
  }) {
    return this.db.transaction(tx => {
      const attempt = tx.select().from(sentimentAttempts).where(eq(sentimentAttempts.id, input.attemptId)).get()
      if (!attempt || attempt.completedAt) return false
      tx.update(sentimentAttempts).set({ completedAt: input.now, returnedModel: input.returnedModel,
        usageStatus: input.usageStatus, usage: input.usage ?? null, safeFailure: input.safeFailure ?? null,
      }).where(eq(sentimentAttempts.id, input.attemptId)).run()
      // Unknown billing remains explicit on the attempt receipt; it is never logged as zero-cost reported usage.
      if (input.usage && input.usageStatus === 'reported') {
        const work = tx.select().from(sentimentWorkItems).where(eq(sentimentWorkItems.id, attempt.workItemId)).get()!
        tx.insert(llmUsageEvents).values({
          id: `sentiment:${attempt.id}`, projectId: attempt.projectId, runId: work.runId, feature: 'sentiment', provider: 'typesafe',
          model: input.returnedModel ?? attempt.requestedModel, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens,
          totalTokens: input.usage.inputTokens + input.usage.outputTokens, costMillicents: input.usage.costMillicents ?? 0,
          metadata: { sentimentAttemptId: attempt.id, usageStatus: 'reported' }, createdAt: input.now,
        }).onConflictDoNothing().run()
      }
      return true
    }, { behavior: 'immediate' })
  }

  completeWork(input: { workItemId: string; owner: string; outcome: string; result: unknown; returnedModel: string | null; now: string }) {
    return this.db.transaction(tx => {
      const work = tx.select().from(sentimentWorkItems).where(and(
        eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner),
        inArray(sentimentWorkItems.status, ['running', 'canceled']),
      )).get()
      if (!work) return false
      tx.insert(sentimentResults).values({ workItemId: work.id, projectId: work.projectId, outcome: input.outcome,
        result: input.result, returnedModel: input.returnedModel, completedAt: input.now,
      }).onConflictDoNothing().run()
      const status = work.status === 'canceled' ? 'canceled' : 'completed'
      tx.update(sentimentWorkItems).set({ status,
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: input.now,
      }).where(eq(sentimentWorkItems.id, work.id)).run()
      shiftJobs(tx, work.id, work.status, status, input.now)
      return true
    }, { behavior: 'immediate' })
  }

  failWork(input: { workItemId: string; owner: string; now: string; errorCode: string; retryAt?: string }) {
    return this.db.transaction(tx => {
      const changed = tx.update(sentimentWorkItems).set({ status: input.retryAt ? 'waiting-to-retry' : 'failed',
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: input.retryAt ?? null, errorCode: input.errorCode, updatedAt: input.now,
      }).where(and(eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner), eq(sentimentWorkItems.status, 'running'))).returning().all()
      if (changed.length > 0) shiftJobs(tx, changed[0].id, 'running', changed[0].status, input.now)
      return changed.length > 0
    }, { behavior: 'immediate' })
  }

  /** Mark every receipt through `sequence` as reconciled for this enablement epoch. */
  markReconciled(projectId: string, enablementEpoch: number, sequence: number) {
    return this.db.update(sentimentSettings).set({ reconciledSequence: sequence }).where(and(
      eq(sentimentSettings.projectId, projectId), eq(sentimentSettings.enablementEpoch, enablementEpoch),
      lt(sentimentSettings.reconciledSequence, sequence),
    )).run().changes > 0
  }

  dispatchState() {
    return this.db.select().from(sentimentDispatchState).where(eq(sentimentDispatchState.id, DISPATCH_STATE_ID)).get()
  }

  /**
   * How much this tick may dispatch. An authorization pause lifts at once when the
   * configured credential no longer matches the one the provider refused, and the
   * assessments waiting on the refused credential become claimable immediately.
   */
  dispatchGate(input: { now: string; credentialFingerprint: string }): SentimentDispatchGate {
    const state = this.dispatchState()
    if (!state?.blockedReason || !state.blockedAt) return 'open'
    const blockedAt = state.blockedAt
    if (state.blockedReason === 'provider-authorization' && state.credentialFingerprint !== input.credentialFingerprint) {
      this.db.transaction(tx => {
        const lifted = tx.update(sentimentDispatchState).set({ blockedReason: null, blockedAt: null, nextDispatchAt: null, rateLimitStreak: 0, credentialFingerprint: null, updatedAt: input.now })
          .where(and(eq(sentimentDispatchState.id, DISPATCH_STATE_ID), eq(sentimentDispatchState.blockedAt, blockedAt))).run().changes
        if (lifted) tx.update(sentimentWorkItems).set({ nextAttemptAt: input.now, updatedAt: input.now }).where(and(
          eq(sentimentWorkItems.status, 'waiting-to-retry'), eq(sentimentWorkItems.errorCode, 'provider-authorization'), gt(sentimentWorkItems.nextAttemptAt, input.now),
        )).run()
      }, { behavior: 'immediate' })
      return 'open'
    }
    return state.nextDispatchAt && state.nextDispatchAt > input.now ? 'closed' : 'probe'
  }

  /**
   * Requeue a refused attempt outside the retry budget and pause dispatch for the
   * whole install. A refusal of a request sent before the current pause began
   * extends that pause without growing the rate-limit streak.
   */
  recordProviderRefusal(input: {
    workItemId: string; owner: string; now: string; dispatchedAt: string; reason: SentimentDispatchBlock
    /** Pause length for the streak this refusal leaves, which is at least 1. */
    delayMs: (streak: number) => number
    credentialFingerprint: string
  }) {
    return this.db.transaction(tx => {
      const prior = tx.select().from(sentimentDispatchState).where(eq(sentimentDispatchState.id, DISPATCH_STATE_ID)).get()
      const fresh = !prior?.blockedAt || input.dispatchedAt > prior.blockedAt
      const priorStreak = prior?.rateLimitStreak ?? 0
      const streak = input.reason === 'provider-rate-limit' && fresh ? priorStreak + 1 : Math.max(priorStreak, 1)
      const candidate = new Date(Date.parse(input.now) + input.delayMs(streak)).toISOString()
      const nextDispatchAt = prior?.nextDispatchAt && prior.nextDispatchAt > candidate ? prior.nextDispatchAt : candidate
      // An authorization pause outranks a rate limit: it lifts only on a new credential or a probe.
      const blockedReason = prior?.blockedReason === 'provider-authorization' && input.reason === 'provider-rate-limit' ? prior.blockedReason : input.reason
      const value = {
        blockedReason, blockedAt: fresh ? input.now : prior!.blockedAt, nextDispatchAt,
        rateLimitStreak: input.reason === 'provider-rate-limit' ? streak : priorStreak,
        credentialFingerprint: input.reason === 'provider-authorization' ? input.credentialFingerprint : prior?.credentialFingerprint ?? null,
        updatedAt: input.now,
      }
      tx.insert(sentimentDispatchState).values({ id: DISPATCH_STATE_ID, ...value })
        .onConflictDoUpdate({ target: sentimentDispatchState.id, set: value }).run()
      const changed = tx.update(sentimentWorkItems).set({ status: 'waiting-to-retry',
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: nextDispatchAt, errorCode: input.reason,
        attemptBudgetStart: sql`${sentimentWorkItems.attemptBudgetStart} + 1`, updatedAt: input.now,
      }).where(and(eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner), eq(sentimentWorkItems.status, 'running'))).returning().all()
      if (changed.length > 0) shiftJobs(tx, changed[0].id, 'running', changed[0].status, input.now)
      return { nextDispatchAt, requeued: changed.length > 0 }
    }, { behavior: 'immediate' })
  }

  /** A provider decision on a request sent after the pause began lifts the pause. */
  releaseDispatchPause(input: { now: string; dispatchedAt: string }) {
    const state = this.dispatchState()
    if (!state?.blockedReason || !state.blockedAt || input.dispatchedAt <= state.blockedAt) return false
    return this.db.update(sentimentDispatchState).set({ blockedReason: null, blockedAt: null, nextDispatchAt: null, rateLimitStreak: 0, credentialFingerprint: null, updatedAt: input.now })
      .where(and(eq(sentimentDispatchState.id, DISPATCH_STATE_ID), eq(sentimentDispatchState.blockedAt, state.blockedAt))).run().changes > 0
  }
}

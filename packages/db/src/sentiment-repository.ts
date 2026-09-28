import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import type { DatabaseClient } from './client.js'
import {
  llmUsageEvents, runs, sentimentAttempts, sentimentCompletionReceipts, sentimentDefinitions,
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

function cancelProject(db: SentimentDb, projectId: string, now: string, reason: string) {
  const active = and(eq(sentimentWorkItems.projectId, projectId),
    inArray(sentimentWorkItems.status, ['pending', 'running', 'waiting-to-retry']))
  const activeWork = db.select({ id: sentimentWorkItems.id }).from(sentimentWorkItems).where(active)
  db.update(sentimentJobItems).set({ canceledAt: now, cancellationReason: reason }).where(and(
    eq(sentimentJobItems.projectId, projectId), inArray(sentimentJobItems.workItemId, activeWork), isNull(sentimentJobItems.canceledAt),
  )).run()
  // Retain ownership of transmitted requests so their eventual response can be recorded.
  db.update(sentimentWorkItems).set({ status: 'canceled', cancellationReason: reason, nextAttemptAt: null, updatedAt: now })
    .where(active).run()
  db.update(sentimentJobs).set({ state: 'canceled', cancellationReason: reason, updatedAt: now }).where(and(
    eq(sentimentJobs.projectId, projectId), inArray(sentimentJobs.state, ['pending', 'running', 'partial']),
  )).run()
}

/** Recompute the projection from durable selection rows; canceled selections never resume implicitly. */
function refreshJobs(db: SentimentDb, workItemId: string, now: string) {
  const jobs = db.select({ id: sentimentJobItems.jobId }).from(sentimentJobItems)
    .where(eq(sentimentJobItems.workItemId, workItemId)).all()
  for (const { id } of jobs) {
    refreshJob(db, id, now)
  }
}

function refreshJob(db: SentimentDb, id: string, now: string) {
  const items = db.select({ status: sentimentWorkItems.status, canceledAt: sentimentJobItems.canceledAt })
    .from(sentimentJobItems).innerJoin(sentimentWorkItems, eq(sentimentWorkItems.id, sentimentJobItems.workItemId))
    .where(eq(sentimentJobItems.jobId, id)).all()
  const statuses = items.map(item => item.canceledAt ? 'canceled' : item.status)
  const state = statuses.every(status => status === 'completed') ? 'complete'
    : statuses.some(status => status === 'running') ? 'running'
    : statuses.some(status => status === 'pending' || status === 'waiting-to-retry') ? 'pending'
    : statuses.every(status => status === 'canceled') ? 'canceled'
    : statuses.every(status => status === 'failed') ? 'failed' : 'partial'
  db.update(sentimentJobs).set({ state, updatedAt: now }).where(and(eq(sentimentJobs.id, id), sql`${sentimentJobs.state} <> 'canceled'`)).run()
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

  configure(input: { projectId: string; enabled: boolean; evaluationDefinitionId: string; configuration: unknown; now: string }) {
    return this.db.transaction(tx => {
      const prior = tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, input.projectId)).get()
      const enabling = input.enabled && !prior?.enabled
      // sqlite_sequence retains its high-water mark across source deletion; MAX(receipts) does not.
      const boundary = tx.all<{ seq: number }>(sql`SELECT seq FROM sqlite_sequence WHERE name = 'sentiment_completion_receipts'`)[0]?.seq ?? 0
      const value = {
        projectId: input.projectId, enabled: input.enabled, installSuspended: prior?.installSuspended ?? false, evaluationDefinitionId: input.evaluationDefinitionId,
        configuration: input.configuration, enablementEpoch: (prior?.enablementEpoch ?? 0) + (enabling ? 1 : 0),
        completionBoundary: enabling ? boundary : prior?.completionBoundary ?? 0, updatedAt: input.now,
      }
      tx.insert(sentimentSettings).values(value).onConflictDoUpdate({ target: sentimentSettings.projectId, set: value }).run()
      if (!input.enabled) cancelProject(tx, input.projectId, input.now, 'project-disabled')
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
      tx.insert(sentimentJobs).values({
        id, projectId: input.projectId, action: input.action, origin: input.origin, enablementEpoch: input.enablementEpoch,
        evaluationDefinitionId: input.evaluationDefinitionId, idempotencyKey: input.idempotencyKey, payloadHash: input.payloadHash,
        selection: input.selection, actor: input.actor, state: input.work.length ? 'pending' : 'complete', createdAt: input.now, updatedAt: input.now,
      }).run()
      for (const item of input.work) {
        tx.insert(sentimentWorkItems).values({
          ...item, id: randomUUID(), projectId: input.projectId, evaluationDefinitionId: input.evaluationDefinitionId,
          enablementEpoch: input.enablementEpoch, createdAt: input.now, updatedAt: input.now,
        }).onConflictDoNothing({ target: [sentimentWorkItems.projectId, sentimentWorkItems.snapshotId, sentimentWorkItems.sourceTextHash, sentimentWorkItems.subjectHash, sentimentWorkItems.evaluationDefinitionId] }).run()
        let work = tx.select().from(sentimentWorkItems).where(and(
          eq(sentimentWorkItems.projectId, input.projectId), eq(sentimentWorkItems.snapshotId, item.snapshotId),
          eq(sentimentWorkItems.sourceTextHash, item.sourceTextHash), eq(sentimentWorkItems.subjectHash, item.subjectHash),
          eq(sentimentWorkItems.evaluationDefinitionId, input.evaluationDefinitionId),
        )).get()!
        const result = tx.select().from(sentimentResults).where(eq(sentimentResults.workItemId, work.id)).get()
        if (result || (input.allowReplayCanceled && ['canceled', 'failed'].includes(work.status))) {
          const stillLeased = !result && work.leaseOwner !== null && work.leaseExpiresAt !== null && work.leaseExpiresAt > input.now
          work = tx.update(sentimentWorkItems).set({
            status: result ? 'completed' : stillLeased ? 'running' : 'pending', enablementEpoch: input.enablementEpoch,
            leaseOwner: stillLeased ? work.leaseOwner : null, leaseExpiresAt: stillLeased ? work.leaseExpiresAt : null,
            nextAttemptAt: null, errorCode: null, cancellationReason: null, updatedAt: input.now,
          }).where(eq(sentimentWorkItems.id, work.id)).returning().get()!
        }
        tx.insert(sentimentJobItems).values({
          projectId: input.projectId, jobId: id, workItemId: work.id, enablementEpoch: input.enablementEpoch,
          canceledAt: work.status === 'canceled' ? input.now : null,
          cancellationReason: work.status === 'canceled' ? work.cancellationReason : null,
        }).onConflictDoNothing().run()
      }
      refreshJob(tx, id, input.now)
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
        )).orderBy(asc(sentimentWorkItems.createdAt), asc(sentimentWorkItems.id)).get()?.work
      if (!row) return undefined
      const claimed = tx.update(sentimentWorkItems).set({
        status: 'running', leaseOwner: input.owner, leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
        nextAttemptAt: null, updatedAt: input.now,
      }).where(eq(sentimentWorkItems.id, row.id)).returning().get()
      refreshJobs(tx, row.id, input.now)
      return claimed
    }, { behavior: 'immediate' })
  }

  startAttempt(input: {
    workItemId: string; owner: string; requestedModel: string; now: string; estimatedInputTokens?: number
    maxRequestsPerMinute?: number; maxInputTokensPerMinute?: number
  }) {
    return this.db.transaction(tx => {
      const work = tx.select().from(sentimentWorkItems).where(and(
        eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner),
        eq(sentimentWorkItems.status, 'running'), gt(sentimentWorkItems.leaseExpiresAt, input.now),
      )).get()
      if (!work) return undefined
      const settings = tx.select().from(sentimentSettings).where(eq(sentimentSettings.projectId, work.projectId)).get()
      if (!settings?.enabled || settings.installSuspended || settings.enablementEpoch !== work.enablementEpoch) return undefined
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
      tx.update(sentimentWorkItems).set({ status: work.status === 'canceled' ? 'canceled' : 'completed',
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: input.now,
      }).where(eq(sentimentWorkItems.id, work.id)).run()
      refreshJobs(tx, work.id, input.now)
      return true
    }, { behavior: 'immediate' })
  }

  failWork(input: { workItemId: string; owner: string; now: string; errorCode: string; retryAt?: string }) {
    return this.db.transaction(tx => {
      const changed = tx.update(sentimentWorkItems).set({ status: input.retryAt ? 'waiting-to-retry' : 'failed',
        leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: input.retryAt ?? null, errorCode: input.errorCode, updatedAt: input.now,
      }).where(and(eq(sentimentWorkItems.id, input.workItemId), eq(sentimentWorkItems.leaseOwner, input.owner), eq(sentimentWorkItems.status, 'running'))).returning().all()
      if (changed.length > 0) refreshJobs(tx, changed[0].id, input.now)
      return changed.length > 0
    }, { behavior: 'immediate' })
  }
}

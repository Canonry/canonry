import crypto from 'node:crypto'
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { parseJsonColumn, querySnapshots, runFills, runs, usageCounters, type DatabaseClient } from '@ainyc/canonry-db'
import {
  RUN_FILL_MAX_AGE_MS,
  RunFillRefusalCodes,
  RunKinds,
  RunTriggers,
  type RunCompletenessDto,
  type RunFillDto,
  type RunFillRefusalCode,
  type RunFillStatus,
  type RunStatus,
} from '@ainyc/canonry-contracts'
import { writeAuditLog } from './helpers.js'
import { activePlanVersionRow } from './measurement-draft-repo.js'
import { runVersionServesActiveVersion } from './measurement-report-adapter.js'
import { measurementRunSlotState, type MeasurementRunSlot, type MeasurementRunSlotState } from './measurement-run-completeness.js'

/**
 * Admission for completing a partial plan run in place.
 *
 * A fill records only the expected slots a partial run never answered, under
 * that run's own id. Every rule here exists so that the answers it adds are
 * the same instrument as the ones already in the run: the same revision, the
 * same frozen models, close enough in time to describe the same moment, and
 * not overtaken by a newer sweep that the dashboard already reads instead.
 */

type RunRow = typeof runs.$inferSelect
type RunFillRow = typeof runFills.$inferSelect

const ACTIVE_STATUSES = ['queued', 'running'] as const

export interface RunFillInput {
  /** Fill only these providers. Omitted fills every provider with gaps. */
  providers?: readonly string[]
  /** Providers this instance can serve. Omitted when the host has no registry to ask. */
  runnableProviders?: readonly string[] | null
  /** Provider → requests allowed per UTC day. Omitted skips the quota check. */
  dailyLimits?: Readonly<Record<string, number>> | null
  now?: Date
}

export type RunFillEvaluation =
  | { kind: 'already-complete'; slots: MeasurementRunSlotState }
  | { kind: 'run-in-progress'; activeRunId: string; slots: MeasurementRunSlotState }
  | { kind: 'refused'; code: RunFillRefusalCode; message: string; slots: MeasurementRunSlotState }
  | { kind: 'fillable'; slots: MeasurementRunSlotState; providers: string[]; missing: MeasurementRunSlot[] }

function normalizeProvider(value: string): string {
  return value.trim().toLocaleLowerCase('en')
}

export function formatRunFill(row: RunFillRow): RunFillDto {
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    status: row.status as RunFillStatus,
    providers: parseJsonColumn<string[]>(row.providers, []),
    expected: row.expected,
    filled: row.filled,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

/**
 * A newer full sweep of the same project. Every reader treats the newest sweep
 * as current, so answers added to an older one after it would land behind the
 * run the operator is actually looking at. A newer run that failed without
 * writing anything does not count: it measured nothing.
 */
export function newerFullSweep(db: DatabaseClient, run: Pick<RunRow, 'id' | 'projectId' | 'createdAt'>): { id: string } | undefined {
  return db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.projectId, run.projectId),
    eq(runs.kind, RunKinds['answer-visibility']),
    ne(runs.id, run.id),
    ne(runs.trigger, RunTriggers.probe),
    isNull(runs.measurementScope),
    isNull(runs.queries),
    gt(runs.createdAt, run.createdAt),
    or(
      inArray(runs.status, ['queued', 'running', 'completed', 'partial']),
      sql`EXISTS (SELECT 1 FROM ${querySnapshots} WHERE ${querySnapshots.runId} = ${runs.id})`,
    ),
  )).orderBy(desc(runs.createdAt)).get()
}

/** Every rule, in the order an operator would want to hear about them. */
export function evaluateRunFill(db: DatabaseClient, run: RunRow, input: RunFillInput = {}): RunFillEvaluation {
  const slots = measurementRunSlotState(db, run.id)
  const refuse = (code: RunFillRefusalCode, message: string): RunFillEvaluation => ({ kind: 'refused', code, message, slots })

  if (run.kind !== RunKinds['answer-visibility']) {
    return refuse(RunFillRefusalCodes.not_answer_visibility, `Only answer-visibility runs can be filled; run ${run.id} is a ${run.kind} run.`)
  }
  if (run.status === 'queued' || run.status === 'running') {
    return { kind: 'run-in-progress', activeRunId: run.id, slots }
  }
  if (!run.measurementPlanVersionId || !run.measurementManifest || !slots.planned) {
    return refuse(RunFillRefusalCodes.not_plan_run,
      'Only a run of a published measurement plan has a frozen manifest to fill against; this run measured the live query set.')
  }
  if (run.trigger === RunTriggers.probe || run.measurementScope !== null || run.queries !== null) {
    return refuse(RunFillRefusalCodes.scoped_or_probe,
      'This run is a spot check that measured a slice on purpose. Only a full sweep can be filled.')
  }
  if (!slots.readable || slots.hasUnboundSnapshot) {
    return refuse(RunFillRefusalCodes.manifest_unreadable,
      'This run cannot be reconciled to its manifest (an unreadable manifest, or an answer with no execution id), so no fill could ever complete it.')
  }
  if (run.status === 'completed') return { kind: 'already-complete', slots }
  if (run.status !== 'partial') {
    return refuse(RunFillRefusalCodes.status_not_partial,
      `Run ${run.id} is ${run.status}. Only a partial run can be filled; run a new sweep instead.`)
  }

  const active = activePlanVersionRow(db, run.projectId)
  if (!active || !runVersionServesActiveVersion(db, run.projectId, active.id, run.measurementPlanVersionId)) {
    return refuse(RunFillRefusalCodes.plan_revision_changed,
      'The measurement plan was republished since this run, so answers added now would mix two revisions in one run.')
  }

  const now = (input.now ?? new Date()).getTime()
  const startedAt = Date.parse(run.startedAt ?? run.createdAt)
  if (Number.isFinite(startedAt) && now - startedAt > RUN_FILL_MAX_AGE_MS) {
    return refuse(RunFillRefusalCodes.too_old,
      `Run ${run.id} started more than 24 hours ago. Answers captured now would not describe the same moment; run a new sweep instead.`)
  }

  const newer = newerFullSweep(db, run)
  if (newer) {
    return refuse(RunFillRefusalCodes.superseded,
      `A newer sweep (${newer.id}) exists and is what every report reads; fill that one instead if it is partial.`)
  }

  const missingByProvider = new Map<string, MeasurementRunSlot[]>()
  for (const slot of slots.missing) {
    missingByProvider.set(slot.provider, [...(missingByProvider.get(slot.provider) ?? []), slot])
  }
  const planProviders = new Set(slots.expected.map(slot => slot.provider))

  let providers: string[]
  if (input.providers?.length) {
    providers = [...new Set(input.providers.map(normalizeProvider))].sort()
    const unknown = providers.filter(provider => !planProviders.has(provider))
    if (unknown.length) {
      return refuse(RunFillRefusalCodes.provider_not_in_plan,
        `This run measured ${[...planProviders].sort().join(', ')}; it did not measure ${unknown.join(', ')}.`)
    }
    const complete = providers.filter(provider => !missingByProvider.has(provider))
    if (complete.length) {
      return refuse(RunFillRefusalCodes.provider_nothing_missing,
        `${complete.join(', ')} already answered every question in this run.`)
    }
  } else {
    providers = [...missingByProvider.keys()].sort()
  }

  const missing = providers.flatMap(provider => missingByProvider.get(provider) ?? [])
  const unfrozen = missing.filter(slot => !slot.requestedModel)
  if (unfrozen.length) {
    return refuse(RunFillRefusalCodes.model_not_frozen,
      `${unfrozen.length} missing answer(s) have no model frozen in the run's manifest, so filling them would use today's model instead of the one the run measured with.`)
  }

  if (input.runnableProviders) {
    const runnable = new Set(input.runnableProviders.map(normalizeProvider))
    const absent = providers.filter(provider => !runnable.has(provider))
    if (absent.length) {
      return refuse(RunFillRefusalCodes.provider_not_configured,
        `${absent.join(', ')} is not configured on this instance, so its missing answers cannot run.`)
    }
  }

  if (input.dailyLimits) {
    // The executor would reserve these at dispatch and fail the fill; saying
    // so here keeps a 202 from promising work that cannot start.
    const period = new Date(now).toISOString().slice(0, 10)
    for (const provider of providers) {
      const limit = input.dailyLimits[provider]
      if (limit === undefined) continue
      const needed = missingByProvider.get(provider)?.length ?? 0
      const used = db.select({ count: usageCounters.count }).from(usageCounters).where(and(
        eq(usageCounters.scope, `${run.projectId}:${provider}`),
        eq(usageCounters.period, period),
        eq(usageCounters.metric, 'queries'),
      )).get()?.count ?? 0
      if (used + needed > limit) {
        return refuse(RunFillRefusalCodes.quota_insufficient,
          `${provider} has used ${used} of its ${limit} requests today (UTC) and this fill needs ${needed}. `
          + `Fill after 00:00 UTC, or raise it with: canonry settings provider ${provider} --max-per-day <n>.`)
      }
    }
  }

  return { kind: 'fillable', slots, providers, missing }
}

function latestFillFor(db: DatabaseClient, runId: string): RunFillRow | undefined {
  return db.select().from(runFills).where(eq(runFills.runId, runId))
    .orderBy(desc(runFills.createdAt), desc(runFills.id)).get()
}

function activeFillFor(db: DatabaseClient, projectId: string): RunFillRow | undefined {
  return db.select().from(runFills)
    .where(and(eq(runFills.projectId, projectId), inArray(runFills.status, [...ACTIVE_STATUSES]))).get()
}

function activeSweepFor(db: DatabaseClient, projectId: string): { id: string } | undefined {
  return db.select({ id: runs.id }).from(runs).where(and(
    eq(runs.projectId, projectId),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [...ACTIVE_STATUSES]),
  )).get()
}

export function readRunCompleteness(db: DatabaseClient, run: RunRow, input: RunFillInput = {}): RunCompletenessDto {
  const evaluation = evaluateRunFill(db, run, input)
  const { slots } = evaluation
  const missingByProvider: Record<string, number> = {}
  for (const slot of slots.missing) missingByProvider[slot.provider] = (missingByProvider[slot.provider] ?? 0) + 1
  const latest = latestFillFor(db, run.id)
  const blocked = activeFillFor(db, run.projectId) !== undefined || activeSweepFor(db, run.projectId) !== undefined
  return {
    runId: run.id,
    status: run.status as RunStatus,
    planned: slots.planned,
    readable: slots.readable,
    expected: slots.expected.length,
    executed: slots.executed,
    missing: slots.missing.length,
    missingByProvider,
    fillable: evaluation.kind === 'fillable' && !blocked,
    refusal: evaluation.kind === 'refused' ? { code: evaluation.code, message: evaluation.message } : null,
    latestFill: latest ? formatRunFill(latest) : null,
  }
}

export type QueueRunFillResult =
  | { kind: 'queued'; fill: RunFillDto }
  | { kind: 'already-complete' }
  | { kind: 'refused'; code: RunFillRefusalCode; message: string }
  | { kind: 'run-in-progress'; activeRunId: string }
  | { kind: 'fill-in-progress'; fillId: string }

/**
 * Admit a fill in one transaction, so two concurrent requests cannot both pass
 * the in-progress checks. Fills never hold the sweep lock: a sweep is never
 * skipped because of one. A fill yields instead, by refusing to start once a
 * newer sweep exists and by stopping when one appears.
 */
export function queueRunFill(db: DatabaseClient, runId: string, input: RunFillInput = {}): QueueRunFillResult {
  return db.transaction((tx) => {
    const txDb = tx as unknown as DatabaseClient
    const run = txDb.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) throw new Error(`Run ${runId} not found`)

    const evaluation = evaluateRunFill(txDb, run, input)
    if (evaluation.kind === 'already-complete') return { kind: 'already-complete' } as const
    if (evaluation.kind === 'refused') return { kind: 'refused', code: evaluation.code, message: evaluation.message } as const
    if (evaluation.kind === 'run-in-progress') return { kind: 'run-in-progress', activeRunId: evaluation.activeRunId } as const

    const activeFill = activeFillFor(txDb, run.projectId)
    if (activeFill) return { kind: 'fill-in-progress', fillId: activeFill.id } as const
    const activeSweep = activeSweepFor(txDb, run.projectId)
    if (activeSweep) return { kind: 'run-in-progress', activeRunId: activeSweep.id } as const

    const now = (input.now ?? new Date()).toISOString()
    const id = crypto.randomUUID()
    txDb.insert(runFills).values({
      id,
      projectId: run.projectId,
      runId: run.id,
      status: 'queued',
      providers: JSON.stringify(evaluation.providers),
      expected: evaluation.missing.length,
      filled: 0,
      createdAt: now,
    }).run()
    writeAuditLog(txDb, {
      projectId: run.projectId,
      actor: 'api',
      action: 'run.fill.created',
      entityType: 'run',
      entityId: run.id,
      diff: { fillId: id, providers: evaluation.providers, missing: evaluation.missing.length },
    })
    const fill = txDb.select().from(runFills).where(eq(runFills.id, id)).get()!
    return { kind: 'queued', fill: formatRunFill(fill) } as const
  })
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { parseJsonColumn, providerBatches, providerBatchRequests, runFills, runs, queries, competitors, projects, querySnapshots, siteCrawlAttempts, usageCounters } from '@ainyc/canonry-db'
import type { PricingTier, ProviderBatchRequestOutcome, ProviderBatchResultLine, ProviderBatchStatus, ProviderBatchSubmitResult, ProviderDispatchMode, ProviderErrorCode, ProviderName, LocationContext, MeasurementRunManifestV1, RawQueryResult, RunCompletionOrigin, RunFillStatus, RunProviderErrorDto, RunStatus, TrackedQueryRequest } from '@ainyc/canonry-contracts'
import { PricingTiers, ProviderBatchRequestOutcomes, ProviderBatchStatuses, ProviderBatchSubmitError, ProviderDispatchModes, RUN_FILL_PROVIDER_BREAKER, buildSnapshotUsage, formatRunErrorOneLine, parseRunError, resolveProviderModel } from '@ainyc/canonry-contracts'
import { CITED_URL_CAPTURE_VERSION, ONBOARDING_FLOW_VERSION, RunKinds, RunStatuses, RunTriggers, brandLabelFromDomain, bucketOnboardingCount, buildSimpleMeasurementDefinition, classifyProviderErrorMessages, buildRunErrorFromMessages, determineAnswerMentioned, effectiveBrandNames, effectiveDomains, isBrowserProvider, normalizeMeasurementExecutionQueryText, parseMeasurementRunManifestV1, providerSupportsLocationContext, serializeRunError, describeError } from '@ainyc/canonry-contracts'
import { captureSimpleMeasurementDefinition, createRunCompetitorResolver, measurementRunSlotState, measurementSlotKey, newerFullSweep, type RunCompetitors } from '@ainyc/canonry-api-routes'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { trackEvent } from './telemetry.js'
import { buildRunCompletedProps, buildSiteAuditCompletedProps, hashDomain, type RunPhaseTimings } from './run-telemetry.js'
import { createLogger } from './logger.js'
import { ProviderExecutionGate, getSharedProviderExecutionGate } from './provider-execution-gate.js'
import { getCurrentUsageDay, releaseDailyQueryQuota, reserveDailyQueryQuota } from './usage-quota.js'
import { adapterSupportsBatch } from './provider-batch-config.js'
import {
  computeCompetitorOverlap,
  determineCitationState,
  extractRecommendedCompetitors,
} from './citation-utils.js'
import { captureCitedUrls, type CitedUrlCapture } from './cited-url-capture.js'

const log = createLogger('JobRunner')

class RunCancelledError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was cancelled`)
    this.name = 'RunCancelledError'
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const cap = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const next = async (): Promise<void> => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      await worker(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: cap }, next))
}

const PROVIDER_FANOUT_DEFAULT = 8

/**
 * One expected slot of a run's frozen manifest, ready to dispatch: one
 * question, in one context, on one provider.
 *
 * `queryId` is best-effort: the slot names a question by text, and the tracked
 * row that text came from may have been deleted since the plan was published.
 * A missing row leaves the snapshot's `query_id` null — `query_text` and the
 * execution id keep the row self-describing either way.
 */
interface PlanExecutionUnit {
  executionId: string
  queryText: string
  context: LocationContext | null
  queryId: string | null
  /** The model frozen onto this slot at queue time, when the project pinned one. */
  requestedModel: string | undefined
}

/**
 * The identity a run's answers are scored against. Every path that records
 * into a run builds it through `runRecordingContext`, so an answer recorded
 * after the sweep (by a fill) is matched exactly like one the sweep recorded.
 */
interface RunRecordingContext {
  runId: string
  allDomains: string[]
  /**
   * The competitors one answer is scored against: the project list plus the
   * plan pins of the groups whose properties use that question.
   */
  competitorsFor: (executionId: string) => RunCompetitors
  allBrandNames: string[]
}

/** What `recordSlot` needs: the run's identity and where a recorded answer is reported. */
interface SlotRecordingContext extends RunRecordingContext {
  onInserted: () => void
  /** Present only when completing a partial run in place. */
  fill?: {
    onOutcome: (provider: ProviderName, ok: boolean) => void
  }
}

/** What `executePlanSlot` needs from the run it is recording into. */
interface PlanSlotContext extends SlotRecordingContext {
  executionGates: ReadonlyMap<ProviderName, ProviderExecutionGate>
  providerDispatchCounts: Map<ProviderName, number>
  providerErrors: Map<ProviderName, string>
  fill?: {
    shouldSkip: (provider: ProviderName, executionId: string) => boolean
    onOutcome: (provider: ProviderName, ok: boolean) => void
  }
}

/** How the answer being recorded was obtained, stored on its row. */
interface SlotDispatch {
  /**
   * Insert with ON CONFLICT DO NOTHING. A path that can be handed an answer
   * for a slot that is already written records nothing rather than failing.
   * A sweep leaves it off, so a slot written behind its back surfaces as that
   * provider's error instead of being skipped silently.
   */
  idempotent: boolean
  mode: ProviderDispatchMode
  /** The `provider_batches` row that produced the answer; null for a sync call. */
  providerBatchId: string | null
  /** The price tier the answer was billed at, for its cost estimate. */
  pricingTier: PricingTier
}

const SYNC_SLOT_DISPATCH: SlotDispatch = {
  idempotent: false,
  mode: ProviderDispatchModes.sync,
  providerBatchId: null,
  pricingTier: PricingTiers.standard,
}

/**
 * The dispatch columns of a planless answer. Additive only: a planless run is
 * always a sync call at the standard price, and nothing else in its insert
 * changes.
 */
function planlessDispatchColumns(registeredProvider: RegisteredProvider, raw: RawQueryResult) {
  return {
    dispatchMode: ProviderDispatchModes.sync,
    stopReason: raw.stopReason ?? null,
    usage: buildSnapshotUsage(raw.usage, {
      provider: registeredProvider.adapter.name,
      model: raw.model,
      tier: PricingTiers.standard,
      overrides: registeredProvider.config.pricing,
    }),
  }
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Batch statuses that still hold a run open: a submit in flight, or a batch
 * the poller owns. A run finalizes only once none of its batches is in one.
 */
const RUN_HOLDING_BATCH_STATUSES: ProviderBatchStatus[] = [
  ProviderBatchStatuses.submitting,
  ProviderBatchStatuses.submitted,
  ProviderBatchStatuses.ended,
]

/** Lines the provider returned no answer for. Per every provider's docs they are not billed. */
const UNBILLED_OUTCOMES: readonly ProviderBatchRequestOutcome[] = [
  ProviderBatchRequestOutcomes.errored,
  ProviderBatchRequestOutcomes.expired,
  ProviderBatchRequestOutcomes.canceled,
]

/** Lines whose slot stayed missing: unanswered, or answered unreadably (billed). */
const UNRECORDED_OUTCOMES: readonly ProviderBatchRequestOutcome[] = [
  ...UNBILLED_OUTCOMES,
  ProviderBatchRequestOutcomes.parse_failed,
]

function unansweredOutcome(type: Exclude<ProviderBatchResultLine['type'], 'succeeded'>): ProviderBatchRequestOutcome {
  switch (type) {
    case 'errored': return ProviderBatchRequestOutcomes.errored
    case 'expired': return ProviderBatchRequestOutcomes.expired
    case 'canceled': return ProviderBatchRequestOutcomes.canceled
  }
}

/** One slot on its way into a batch: the exact request the sync call would send. */
interface BatchLine {
  unit: PlanExecutionUnit
  /** The id the slot froze, which its snapshot records; the batch asks for the id it resolves to. */
  requestedModel: string
  /** The `custom_id` on the wire, and the `provider_batch_requests` row id. */
  customId: string
  request: TrackedQueryRequest
  /** Serialized size of the line as the provider receives it. */
  bytes: number
}

/** `{"requests":[` and `]}`: what one submission adds around its lines. */
const BATCH_ENVELOPE_BYTES = 15

/**
 * Split one model's lines into submissions no larger than the request and
 * byte limits. A line too large for any submission cannot be batched at all;
 * it is returned apart so its slot can be answered sync.
 */
function chunkBatchLines(lines: readonly BatchLine[], maxRequests: number, maxBytes: number): { chunks: BatchLine[][]; oversized: BatchLine[] } {
  const chunks: BatchLine[][] = []
  const oversized: BatchLine[] = []
  let current: BatchLine[] = []
  let currentBytes = BATCH_ENVELOPE_BYTES
  for (const line of lines) {
    if (BATCH_ENVELOPE_BYTES + line.bytes > maxBytes) {
      oversized.push(line)
      continue
    }
    // Lines after the first are joined by a comma.
    const added = line.bytes + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && (current.length >= maxRequests || currentBytes + added > maxBytes)) {
      chunks.push(current)
      current = []
      currentBytes = BATCH_ENVELOPE_BYTES
    }
    currentBytes += line.bytes + (current.length > 0 ? 1 : 0)
    current.push(line)
  }
  if (current.length > 0) chunks.push(current)
  return { chunks, oversized }
}

/** What batch submission needs from the sweep that is submitting. */
interface BatchSubmissionContext {
  runId: string
  projectId: string
  recording: RunRecordingContext
  /** The sweep's own reservations; a batch row records the part it carries. */
  reservations: ReadonlyMap<ProviderName, { scope: string; period: string; reserved: number }>
  providerDispatchCounts: Map<ProviderName, number>
  /** Every `provider_batches` row this sweep wrote, so a failure can cancel them. */
  batchRowIds: string[]
}

/** What one ingest did. `skipped` means the batch was not waiting to be ingested. */
export type ProviderBatchIngestResult =
  | { kind: 'ingested'; recorded: number; notRecorded: number; released: number }
  | { kind: 'cancelled' }
  | { kind: 'skipped' }

type FinalRunStatus = Extract<RunStatus, 'completed' | 'partial' | 'failed'>

/**
 * A run's terminal status and stored error from what it recorded and what
 * went wrong. Shared by both finalizers, so a batch run and a sync run that
 * end the same way are stored the same way.
 */
function runOutcome(inserted: number, providerErrors: ReadonlyMap<ProviderName, string>, planShortfall: number): { status: FinalRunStatus; error: string | null } {
  const someFailed = providerErrors.size > 0 || planShortfall > 0
  const allFailed = inserted === 0 && someFailed
  return {
    status: allFailed ? RunStatuses.failed : someFailed ? RunStatuses.partial : RunStatuses.completed,
    error: someFailed ? serializeRunError(buildRunErrorFromMessages(providerErrors)) : null,
  }
}

/**
 * Build the identity one run's answers are scored against from rows already
 * read. The sweep calls it with its own reads; a path that joins the run later
 * goes through `JobRunner.buildRunRecordingContext`, which reads them the same
 * way.
 */
function runRecordingContext(
  db: DatabaseClient,
  input: {
    runId: string
    measurementPlanVersionId: string | null
    project: Pick<typeof projects.$inferSelect, 'canonicalDomain' | 'ownedDomains' | 'displayName' | 'aliases'>
    competitorDomains: readonly string[]
  },
): RunRecordingContext {
  const resolveCompetitors = createRunCompetitorResolver(db, input.competitorDomains)
  return {
    runId: input.runId,
    allDomains: effectiveDomains({ canonicalDomain: input.project.canonicalDomain, ownedDomains: input.project.ownedDomains }),
    competitorsFor: executionId => resolveCompetitors(input.measurementPlanVersionId, executionId),
    allBrandNames: effectiveBrandNames({ displayName: input.project.displayName, aliases: input.project.aliases }),
  }
}

interface PlanExecution {
  manifest: MeasurementRunManifestV1
  /** Slots grouped by the provider the manifest expects to answer them. */
  unitsByProvider: Map<string, PlanExecutionUnit[]>
  /** Distinct execution nodes, for telemetry and quota. */
  nodeCount: number
  maxUnitsPerProvider: number
}

interface RunState {
  kind: string
  status: string
  finishedAt: string | null
  error: string | null
  trigger: string
  queries: string[] | null
  measurementPlanVersionId: string | null
  measurementManifest: Record<string, unknown> | null
  /** Frozen at queue time: the providers this run sends to a batch API. */
  providerDispatchModes: Record<string, 'batch'> | null
  /** Non-null once the sweep handed the run to the batch poller. */
  pendingProviderErrors: Record<string, string> | null
}

/**
 * Read the run's own frozen manifest — never today's active plan. A run that
 * was queued against revision 4 measures revision 4 even if 5 was published
 * while it sat in the queue, and it measures exactly the provider slots the
 * manifest lists, so "executed vs expected" compares like with like.
 */
function resolvePlanExecution(
  run: RunState,
  projectQueries: readonly typeof queries.$inferSelect[],
): PlanExecution | null {
  if (!run.measurementPlanVersionId || !run.measurementManifest) return null
  const manifest = parseMeasurementRunManifestV1(run.measurementManifest)
  const queryIdByText = new Map<string, string>()
  for (const row of projectQueries) {
    const key = normalizeMeasurementExecutionQueryText(row.query)
    if (!queryIdByText.has(key)) queryIdByText.set(key, row.id)
  }
  const unitsByProvider = new Map<string, PlanExecutionUnit[]>()
  const nodes = new Set<string>()
  for (const slot of manifest.expectedSlots) {
    nodes.add(slot.executionId)
    const units = unitsByProvider.get(slot.provider) ?? []
    units.push({
      executionId: slot.executionId,
      queryText: slot.queryText,
      context: slot.context,
      queryId: queryIdByText.get(normalizeMeasurementExecutionQueryText(slot.queryText)) ?? null,
      requestedModel: slot.requestedModel,
    })
    unitsByProvider.set(slot.provider, units)
  }
  return {
    manifest,
    unitsByProvider,
    nodeCount: nodes.size,
    maxUnitsPerProvider: Math.max(0, ...[...unitsByProvider.values()].map(units => units.length)),
  }
}

function resolveProviderFanout(): number {
  const raw = process.env.CANONRY_PROVIDER_FANOUT
  if (!raw) return PROVIDER_FANOUT_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PROVIDER_FANOUT_DEFAULT
}

type RunExecutionContext = {
  providerCount: number
  providers: ProviderName[]
  queryCount: number
  location?: string
  /** Trigger source from the `runs` row — passed through to telemetry so
   *  scheduled vs manual vs config-apply runs can be cohorted. */
  trigger?: string
  /** Project canonical domain — hashed for telemetry; never stored raw. */
  canonicalDomain?: string
}

/** Daily provider capacity one execution reserved up front, and what it sent against it. */
interface RunQuotaReservations {
  dispatched: ReadonlyMap<ProviderName, number>
  reservations: Map<ProviderName, { scope: string; period: string; reserved: number }>
}

/** What `finalizeRun` needs: the values the execution that measured the run computed. */
export interface RunFinalization {
  runId: string
  projectId: string
  /** The run's kind, which decides whether it can be the project's activation. */
  kind: string
  /** Snapshots this execution recorded. */
  inserted: number
  providerErrors: ReadonlyMap<ProviderName, string>
  /** Expected plan slots left without an answer; 0 for a planless run. */
  planShortfall: number
  executionContext: RunExecutionContext
  startTime: number
  phases: RunPhaseTimings | undefined
  /** The caller's own reservation, released whether or not this call wins. */
  quota?: RunQuotaReservations
}

/**
 * Stable categorization for run failures, used for telemetry only.
 *
 * `abort` reasons mean the run never reached any provider work — so the
 * "failure" is a config/setup problem, not a downstream audit failure.
 * Those are emitted as `run.aborted` so they don't pollute the
 * `run.completed status=failed` rate, which should reflect real audit
 * failures (provider crashes, network errors, etc.).
 */
type RunAbortReason =
  | 'no_provider'
  | 'project_not_found'
  | 'quota_exceeded'
  | 'run_not_found'
  | 'run_not_executable'

function classifyRunAbortReason(message: string): RunAbortReason | undefined {
  if (/^No providers configured\b/.test(message)) return 'no_provider'
  if (/^Project [^ ]+ not found$/.test(message)) return 'project_not_found'
  if (/^Daily quota exceeded\b/.test(message)) return 'quota_exceeded'
  if (/^Run [^ ]+ not found$/.test(message)) return 'run_not_found'
  if (/^Run [^ ]+ is not executable\b/.test(message)) return 'run_not_executable'
  return undefined
}

/**
 * Coarse error category for runtime provider failures, used for telemetry
 * only. Best-effort regex match — not load-bearing for any control flow,
 * just a histogram bucket so dashboards can answer "why are real audit
 * failures happening?" without reading raw error strings.
 */
function classifyProviderErrors(
  errors: ReadonlyMap<ProviderName, string>,
): ProviderErrorCode {
  // Shared with the query-generation route so the two never drift on what a
  // rate limit or an auth failure looks like.
  return classifyProviderErrorMessages(errors.values())
}

export class JobRunner {
  /**
   * Invoked exactly when `activation.completed` is emitted: the project's
   * first non-empty, non-probe answer-visibility result. The serve process
   * uses it to thank the operator once; it is a UX hook, not telemetry, so it
   * fires (and is given) independently of whether telemetry is enabled.
   */
  private readonly onFirstActivation?: () => void
  private db: DatabaseClient
  private registry: ProviderRegistry
  onRunCompleted?: (runId: string, projectId: string, opts?: { origin?: RunCompletionOrigin }) => Promise<void>
  /**
   * Runs an `executeRun` call is working on in this process, counted so a
   * stray second dispatch cannot clear the first one's claim. While a run is
   * in here the sweep still owns its outcome: the batch poller does not
   * finalize it, and `cancelRunBatches` leaves reporting its cancellation to
   * the sweep. The database marker (`pending_provider_errors`) covers the same
   * handoff across a restart.
   */
  private readonly executing = new Map<string, number>()

  constructor(
    db: DatabaseClient,
    registry: ProviderRegistry,
    opts?: { onFirstActivation?: () => void },
  ) {
    this.onFirstActivation = opts?.onFirstActivation
    this.db = db
    this.registry = registry
  }




  /** Claim a run for one `executeRun` call. The returned release is idempotent. */
  private enterExecution(runId: string): () => void {
    this.executing.set(runId, (this.executing.get(runId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.executing.get(runId) ?? 1) - 1
      if (remaining > 0) this.executing.set(runId, remaining)
      else this.executing.delete(runId)
    }
  }

  private isExecuting(runId: string): boolean {
    return this.executing.has(runId)
  }

  private hasProviderBatches(runId: string): boolean {
    return this.db.select({ id: providerBatches.id }).from(providerBatches)
      .where(eq(providerBatches.runId, runId)).limit(1).get() !== undefined
  }

  recoverStaleRuns(): void {
    // A fill the process died under never finalized. Fail the attempt only:
    // its parent stays `partial` and keeps every answer the fill recorded, so
    // a later fill picks up exactly the slots that are still missing.
    const staleFills = this.db
      .update(runFills)
      .set({ status: 'failed', finishedAt: new Date().toISOString(), error: 'Server restarted while the fill was in progress' })
      .where(inArray(runFills.status, ['queued', 'running']))
      .run()
    if (staleFills.changes > 0) log.warn('fill.recovered-stale', { count: staleFills.changes })

    // A batch caught between its row and the provider's answer may or may
    // not exist at the provider. It is never resubmitted (that could pay for
    // the same answers twice), so its slots stay missing.
    const unknownBatches = this.db
      .update(providerBatches)
      .set({
        status: ProviderBatchStatuses.unknown,
        error: 'Server restarted while the batch was being submitted; it may or may not exist at the provider, so it was not resubmitted.',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(providerBatches.status, ProviderBatchStatuses.submitting))
      .run()
    if (unknownBatches.changes > 0) log.warn('batch.recovered-submitting', { count: unknownBatches.changes })

    const stale = this.db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        kind: runs.kind,
        status: runs.status,
        trigger: runs.trigger,
        startedAt: runs.startedAt,
      })
      .from(runs)
      .where(inArray(runs.status, ['running', 'queued']))
      .all()

    if (stale.length === 0) return

    const now = new Date().toISOString()
    for (const run of stale) {
      // A run that reached a provider batch is not lost with the process: its
      // batches live at the provider, and the poller resumes them.
      if (run.status === RunStatuses.running && this.recoverBatchRun(run.id)) continue
      const recovered = this.db.transaction((tx) => {
        // The status predicate is the recovery claim. Do not overwrite a
        // terminal transition made after this boot-time scan.
        const claim = tx
          .update(runs)
          .set({ status: 'failed', finishedAt: now, error: 'Server restarted while run was in progress' })
          .where(and(eq(runs.id, run.id), eq(runs.status, run.status)))
          .run()
        if (claim.changes === 0) return false

        if (run.kind === RunKinds['site-audit']) {
          // The crawl cannot resume from event receipts: they only make
          // writes idempotent within one attempt. Close the claimed attempt
          // with the parent so a reboot never leaves a zombie graph writer.
          tx
            .update(siteCrawlAttempts)
            .set({ state: 'failed', finishedAt: now, updatedAt: now, error: 'Server restarted while run was in progress' })
            .where(and(
              eq(siteCrawlAttempts.projectId, run.projectId),
              eq(siteCrawlAttempts.runId, run.id),
              inArray(siteCrawlAttempts.state, ['queued', 'running']),
            ))
            .run()
        }
        return true
      })
      if (!recovered) continue
      log.warn('run.recovered-stale', { runId: run.id, previousStatus: run.status })
      if (run.kind === RunKinds['site-audit']) this.trackRecoveredSiteAudit(run)
    }
  }

  /**
   * Boot recovery for a running run that wrote provider batches. Returns
   * false for a run that has none, which recovery fails as before.
   *
   * The run stays `running` and is handed to the poller: every slot its sweep
   * should have answered sync but did not (the sweep died with the process)
   * gets the restart as its reason, and the handoff marker is set. The poller
   * finalizes it once no batch holds it; a run whose batches all settled
   * finalizes on the poller's first pass, when the post-run pipeline is wired
   * (it is not yet, this early in boot).
   */
  private recoverBatchRun(runId: string): boolean {
    const batches = this.db.select({ id: providerBatches.id, status: providerBatches.status })
      .from(providerBatches).where(eq(providerBatches.runId, runId)).all()
    if (batches.length === 0) return false

    // Slots a batch owns, answered or not, are the batch's to explain. A
    // refused batch fell back to sync, so its slots are the sweep's again.
    const owning = batches.filter(batch => batch.status !== ProviderBatchStatuses.failed).map(batch => batch.id)
    const owned = new Set(owning.length === 0 ? [] : this.db
      .select({ executionId: providerBatchRequests.executionId, provider: providerBatches.provider })
      .from(providerBatchRequests)
      .innerJoin(providerBatches, eq(providerBatchRequests.batchId, providerBatches.id))
      .where(inArray(providerBatchRequests.batchId, owning))
      .all()
      .map(row => measurementSlotKey(row.executionId, row.provider)))
    const run = this.db.select({ pendingProviderErrors: runs.pendingProviderErrors }).from(runs).where(eq(runs.id, runId)).get()
    const pending = { ...(run?.pendingProviderErrors ?? {}) }
    for (const slot of measurementRunSlotState(this.db, runId).missing) {
      if (owned.has(measurementSlotKey(slot.executionId, slot.provider))) continue
      pending[slot.provider] ??= 'Server restarted while run was in progress'
    }
    this.db.update(runs)
      .set({ pendingProviderErrors: pending })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running)))
      .run()
    log.warn('run.recovered-batch-pending', {
      runId,
      outstanding: batches.filter(batch => RUN_HOLDING_BATCH_STATUSES.includes(batch.status)).length,
      pendingErrors: Object.keys(pending).length,
    })
    return true
  }

  /**
   * A crawl the process died under never reaches `executeSiteAudit`'s terminal
   * telemetry, so without this every interrupted audit vanishes from the data.
   * Emitted after the recovery transaction commits. `durationMs` runs from the
   * crawl's start to this recovery, so it includes the downtime and is an upper
   * bound; a run that was still queued has no start and reports 0.
   *
   * The source is set explicitly: recovery runs during server construction,
   * before `canonry serve` switches the process source to `cli-server`.
   */
  private trackRecoveredSiteAudit(run: { id: string; projectId: string; trigger: string | null; startedAt: string | null }): void {
    try {
      const startedAt = run.startedAt ? Date.parse(run.startedAt) : Number.NaN
      const project = this.db
        .select({ canonicalDomain: projects.canonicalDomain })
        .from(projects)
        .where(eq(projects.id, run.projectId))
        .get()
      trackEvent(
        'site_audit.completed',
        buildSiteAuditCompletedProps({
          status: 'failed',
          startTime: Number.isFinite(startedAt) ? startedAt : Date.now(),
          trigger: run.trigger,
          canonicalDomain: project?.canonicalDomain ?? null,
        }),
        { errorCode: 'SERVER_RESTARTED', source: 'cli-server' },
      )
    } catch (err: unknown) {
      log.warn('telemetry.recovered-site-audit-failed', { runId: run.id, error: describeError(err) })
    }
  }

  async executeRun(runId: string, projectId: string, providerOverride?: ProviderName[], locationOverride?: LocationContext | null): Promise<void> {
    const now = new Date().toISOString()
    const startTime = Date.now()
    let providerCallStart: number | undefined
    let providerCallEnd: number | undefined
    let runLocation: LocationContext | undefined
    let activeProviders: RegisteredProvider[] = []
    let projectQueries: typeof queries.$inferSelect[] = []
    let planExecution: PlanExecution | null = null
    let runTrigger: string | undefined
    let canonicalDomain: string | undefined
    const providerDispatchCounts = new Map<ProviderName, number>()
    const providerReservations = new Map<ProviderName, { scope: string; period: string; reserved: number }>()
    // The provider batches this sweep writes, so a failure or a cancellation
    // can stop them rather than leave them billing into a run that is over.
    const batchRowIds: string[] = []
    const releaseExecution = this.enterExecution(runId)

    try {
      const existingRun = this.getRunState(runId)
      if (!existingRun) {
        throw new Error(`Run ${runId} not found`)
      }
      runTrigger = existingRun.trigger ?? undefined
      // A running run that already reached a provider batch is past (or in)
      // its sweep. Running it again would resubmit batches already paid for.
      if (
        existingRun.status === RunStatuses.running
        && (existingRun.pendingProviderErrors !== null || this.hasProviderBatches(runId))
      ) {
        log.warn('run.already-dispatched', { runId })
        return
      }
      if (existingRun.status === 'cancelled') {
        this.handleCancelledRun(runId, projectId, startTime, {
          providerCount: 0,
          providers: [],
          queryCount: 0,
          ...(runTrigger ? { trigger: runTrigger } : {}),
        })
        return
      }
      if (existingRun.status !== 'queued' && existingRun.status !== 'running') {
        throw new Error(`Run ${runId} is not executable from status '${existingRun.status}'`)
      }

      if (existingRun.status === 'queued') {
        this.db
          .update(runs)
          .set({ status: 'running', startedAt: now })
          .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
          .run()
      }
      this.throwIfRunCancelled(runId)

      // Fetch project
      const project = this.db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()

      if (!project) {
        throw new Error(`Project ${projectId} not found`)
      }
      canonicalDomain = project.canonicalDomain

      // Resolve location: explicit override > project default > none
      // locationOverride === null means explicitly no location (--no-location)
      // locationOverride === undefined means use project default
      if (locationOverride === null) {
        runLocation = undefined
      } else if (locationOverride) {
        runLocation = locationOverride
      } else {
        const projectLocations = project.locations
        if (project.defaultLocation && projectLocations.length > 0) {
          runLocation = projectLocations.find(l => l.label === project.defaultLocation)
        }
      }

      // Fetch queries for the project (scope to existingRun.queries if set)
      const scopedQueryNames = existingRun.queries
      projectQueries = scopedQueryNames
        ? this.db
            .select()
            .from(queries)
            .where(and(eq(queries.projectId, projectId), inArray(queries.query, scopedQueryNames)))
            .all()
        : this.db
            .select()
            .from(queries)
            .where(eq(queries.projectId, projectId))
            .all()

      // A run that pinned a measurement plan carries its own execution graph.
      // A run that did not gets the legacy query-by-query path below, untouched.
      planExecution = resolvePlanExecution(existingRun, projectQueries)

      // Resolve which providers to use. A manifest-pinned run measures exactly
      // the providers frozen onto its manifest at queue time — reading
      // `project.providers` here would let a provider added or removed after
      // queueing (but before this run got to the front of the queue) silently
      // change what an already-queued run measures, defeating the point of
      // freezing a manifest at all. Only a planless run honours the per-run
      // override / live project config, exactly as before.
      if (planExecution) {
        const plan = planExecution
        const manifestProviders = [...plan.unitsByProvider.keys()] as ProviderName[]
        activeProviders = manifestProviders
          .map(name => this.registry.get(name))
          .filter((entry): entry is RegisteredProvider => entry !== undefined)
      } else {
        const projectProviders = providerOverride ?? (project.providers as ProviderName[])
        activeProviders = this.registry.getForProject(projectProviders).map((entry) => {
          const override = project.providerModels[entry.adapter.name]
          // An override stored before its model was retired resolves to the id
          // that answers now, matching what the registry holds for config.yaml.
          const model = override === undefined ? undefined : resolveProviderModel(entry.adapter.name, override)
          // Clone the registration instead of mutating the shared registry: two
          // projects can run different models through the same provider process.
          return model === undefined
            ? entry
            : { ...entry, config: { ...entry.config, model } }
        })
      }

      if (activeProviders.length === 0) {
        throw new Error('No providers configured. Add at least one provider API key.')
      }

      log.info('run.dispatch', { runId, providerCount: activeProviders.length, providers: activeProviders.map(p => p.adapter.name) })

      // Fetch competitors for the project
      const projectCompetitors = this.db
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, projectId))
        .all()

      const competitorDomains = projectCompetitors.map(c => c.domain)
      // A plan answer is also scored against the competitors its revision pins
      // on the groups that use its question, so a project whose competitor
      // list was never filled in still measures them, market by market. The
      // planless path below keeps using exactly the project list.
      const recording = runRecordingContext(this.db, {
        runId,
        measurementPlanVersionId: existingRun.measurementPlanVersionId,
        project,
        competitorDomains,
      })
      const { allDomains, allBrandNames } = recording
      const executionContext: RunExecutionContext = {
        providerCount: activeProviders.length,
        providers: activeProviders.map(provider => provider.adapter.name),
        queryCount: planExecution?.nodeCount ?? projectQueries.length,
        ...(runLocation ? { location: runLocation.label } : {}),
        ...(runTrigger ? { trigger: runTrigger } : {}),
        ...(canonicalDomain ? { canonicalDomain } : {}),
      }

      // Enforce daily quota per provider — each provider receives one request per query.
      // Track and check usage per (projectId, providerName) so that a provider that has
      // never been used isn't blocked by another provider's past usage.
      const queriesPerProvider = planExecution?.maxUnitsPerProvider ?? projectQueries.length
      const todayPeriod = getCurrentUsageDay()

      for (const p of activeProviders) {
        const providerScope = `${projectId}:${p.adapter.name}`
        const limit = p.config.quotaPolicy.maxRequestsPerDay
        const quota = reserveDailyQueryQuota(this.db, { scope: providerScope, period: todayPeriod, count: queriesPerProvider, limit })
        if (!quota.reserved) {
          throw new Error(
            `Daily quota exceeded for ${p.adapter.name}: ${quota.used} queries used today, ` +
            `limit is ${limit}. This run needs ${queriesPerProvider} more.`,
          )
        }
        providerReservations.set(p.adapter.name, { scope: providerScope, period: todayPeriod, reserved: queriesPerProvider })
      }

      // One gate per provider NAME, shared process-wide (see
      // `getSharedProviderExecutionGate`) — not one per run. Two runs for two
      // different projects can be in flight at once, and if both name the
      // same provider they share the same upstream API key and the same
      // real-world rate limit. A gate built fresh per run would give each run
      // its own independent budget against that key, silently multiplying
      // the configured limit by the number of concurrent runs.
      const executionGates = new Map<ProviderName, ProviderExecutionGate>()
      for (const provider of activeProviders) {
        executionGates.set(
          provider.adapter.name,
          getSharedProviderExecutionGate(
            provider.adapter.name,
            provider.config.quotaPolicy.maxConcurrency,
            provider.config.quotaPolicy.maxRequestsPerMinute,
          ),
        )
      }

      // Track per-provider errors for partial completion
      const providerErrors = new Map<ProviderName, string>()
      let totalSnapshotsInserted = 0

      // Split providers: API providers fan out in parallel, browser providers run sequentially
      const apiProviders = activeProviders.filter(p => !isBrowserProvider(p.adapter.name))
      const browserProviders = activeProviders.filter(p => isBrowserProvider(p.adapter.name))

      const processQueryForProvider = async (
        registeredProvider: RegisteredProvider,
        q: typeof queries.$inferSelect,
      ): Promise<void> => {
        const { adapter, config } = registeredProvider
        const providerName = adapter.name
        const gate = executionGates.get(providerName)
        if (!gate) {
          throw new Error(`Missing execution gate for provider ${providerName}`)
        }

        try {
          await gate.run(async () => {
            this.throwIfRunCancelled(runId)
            providerDispatchCounts.set(providerName, (providerDispatchCounts.get(providerName) ?? 0) + 1)

            const raw = await adapter.executeTrackedQuery(
              {
                query: q.query,
                canonicalDomains: allDomains,
                competitorDomains,
                location: runLocation,
              },
              config,
            )

            this.throwIfRunCancelled(runId)

            const providerResult = adapter.normalizeResult(raw)
            const rawGroundingSources = providerResult.groundingSources
            const normalized = {
              ...providerResult,
              groundingSources: Array.isArray(rawGroundingSources) ? rawGroundingSources : [],
            }
            let citedUrlCapture: CitedUrlCapture
            try {
              citedUrlCapture = await captureCitedUrls(providerName, rawGroundingSources)
            } catch (err: unknown) {
              citedUrlCapture = {
                citedUrls: [],
                captureStatus: 'failed',
                sourceCount: normalized.groundingSources.length,
                resolvedCount: 0,
                captureVersion: CITED_URL_CAPTURE_VERSION,
              }
              log.warn('query.cited-url-capture-failed', {
                runId,
                provider: providerName,
                query: q.query,
                error: describeError(err),
              })
            }
            this.throwIfRunCancelled(runId)

            log.info('query.result', { runId, provider: providerName, query: q.query, citedDomains: normalized.citedDomains, groundingSources: normalized.groundingSources.map(s => s.uri), matchDomains: allDomains })
            const citationState = determineCitationState(normalized, allDomains)
            const answerMentioned = determineAnswerMentioned(
              normalized.answerText,
              allBrandNames,
              allDomains,
            )
            const overlap = computeCompetitorOverlap(normalized, competitorDomains)
            const extractedCompetitors = extractRecommendedCompetitors(
              normalized.answerText,
              allDomains,
              normalized.citedDomains,
              competitorDomains,
              allBrandNames,
            )

            // Move screenshot to canonical location if present
            let screenshotRelPath: string | null = null
            if (raw.screenshotPath && fs.existsSync(raw.screenshotPath)) {
              const snapshotId = crypto.randomUUID()
              const screenshotDir = path.join(os.homedir(), '.canonry', 'screenshots', runId)
              if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true })
              const destPath = path.join(screenshotDir, `${snapshotId}.png`)
              fs.renameSync(raw.screenshotPath, destPath)
              screenshotRelPath = `${runId}/${snapshotId}.png`

              this.db.insert(querySnapshots).values({
                id: snapshotId,
                runId,
                queryId: q.id,
                queryText: q.query,
                provider: providerName,
                model: raw.model,
                servedModel: raw.servedModel ?? null,
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: normalized.citedDomains,
                citedUrls: citedUrlCapture.citedUrls,
                captureStatus: citedUrlCapture.captureStatus,
                sourceCount: citedUrlCapture.sourceCount,
                resolvedCount: citedUrlCapture.resolvedCount,
                captureVersion: citedUrlCapture.captureVersion,
                // Retrieval is the adapter's own observation, never inferred
                // from citation counts. Both branches record it so no snapshot
                // can be written unmarked.
                retrievalStatus: normalized.retrievalStatus,
                retrievalContract: raw.retrievalContract,
                competitorOverlap: overlap,
                recommendedCompetitors: extractedCompetitors,
                location: runLocation?.label ?? null,
                screenshotPath: screenshotRelPath,
                rawResponse: JSON.stringify({
                  model: raw.model,
                  servedModel: raw.servedModel ?? null,
                  groundingSources: normalized.groundingSources,
                  searchQueries: normalized.searchQueries,
                  apiResponse: raw.rawResponse,
                }),
                ...planlessDispatchColumns(registeredProvider, raw),
                createdAt: new Date().toISOString(),
              }).run()
            } else {
              this.db.insert(querySnapshots).values({
                id: crypto.randomUUID(),
                runId,
                queryId: q.id,
                queryText: q.query,
                provider: providerName,
                model: raw.model,
                servedModel: raw.servedModel ?? null,
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: normalized.citedDomains,
                citedUrls: citedUrlCapture.citedUrls,
                captureStatus: citedUrlCapture.captureStatus,
                sourceCount: citedUrlCapture.sourceCount,
                resolvedCount: citedUrlCapture.resolvedCount,
                captureVersion: citedUrlCapture.captureVersion,
                // Retrieval is the adapter's own observation, never inferred
                // from citation counts. Both branches record it so no snapshot
                // can be written unmarked.
                retrievalStatus: normalized.retrievalStatus,
                retrievalContract: raw.retrievalContract,
                competitorOverlap: overlap,
                recommendedCompetitors: extractedCompetitors,
                location: runLocation?.label ?? null,
                rawResponse: JSON.stringify({
                  model: raw.model,
                  servedModel: raw.servedModel ?? null,
                  groundingSources: normalized.groundingSources,
                  searchQueries: normalized.searchQueries,
                  apiResponse: raw.rawResponse,
                }),
                ...planlessDispatchColumns(registeredProvider, raw),
                createdAt: new Date().toISOString(),
              }).run()
            }

            totalSnapshotsInserted++
            log.info('query.citation', { runId, provider: providerName, query: q.query, citationState, answerMentioned })
          })
        } catch (err: unknown) {
          if (err instanceof RunCancelledError) {
            throw err
          }

          const msg = describeError(err)
          const stack = err instanceof Error ? err.stack : undefined
          log.error('query.failed', { runId, provider: providerName, query: q.query, error: msg, stack })
          if (!providerErrors.has(providerName)) {
            providerErrors.set(providerName, msg)
          }
        }
      }

      const slotContext: PlanSlotContext = {
        ...recording,
        executionGates,
        providerDispatchCounts,
        providerErrors,
        onInserted: () => { totalSnapshotsInserted++ },
      }
      const processNodeForProvider = (registeredProvider: RegisteredProvider, unit: PlanExecutionUnit): Promise<void> =>
        this.executePlanSlot(slotContext, registeredProvider, unit)

      // A simple run resolves its inputs at dispatch, unlike a plan-aware run
      // whose manifest is already immutable. Persist this exact resolved
      // input set after quota succeeds but before even one adapter can start.
      // This is deliberately sidecar-only: it neither alters plan execution
      // nor makes stored capture data an input to the legacy execution path.
      if (
        existingRun.kind === RunKinds['answer-visibility']
        && existingRun.trigger !== RunTriggers.probe
        && existingRun.measurementPlanVersionId === null
      ) {
        const definition = buildSimpleMeasurementDefinition({
          capturedAt: new Date().toISOString(),
          identity: {
            displayName: project.displayName,
            aliases: project.aliases,
            canonicalDomain: project.canonicalDomain,
            ownedDomains: project.ownedDomains,
          },
          country: project.country,
          language: project.language,
          location: runLocation ?? null,
          engines: activeProviders.map(({ adapter, config }) => ({
            provider: adapter.name,
            requestedModel: config.model ?? null,
          })),
          // The legacy competitors table has domains only. Freeze the exact
          // identity we actually dispatched with so later reporting never
          // borrows renamed or newly added competitors from live project state.
          competitors: projectCompetitors.map(competitor => {
            const label = brandLabelFromDomain(competitor.domain) || competitor.domain
            return { domain: competitor.domain, label, aliases: [label] }
          }),
          queries: projectQueries.map(query => ({
            queryId: query.id,
            queryText: query.query,
            provenance: query.provenance ?? null,
          })),
        })
        captureSimpleMeasurementDefinition(this.db, { projectId, runId, definition })
      }

      providerCallStart = Date.now()
      if (planExecution) {
        // The manifest decides who runs what. A provider it does not list is
        // not part of this run's expectation, and a provider it lists but the
        // registry cannot serve simply leaves its slots unexecuted — visible
        // as executed below expected rather than silently swapped for another.
        const plan = planExecution
        const providerKey = (provider: RegisteredProvider): string => provider.adapter.name.trim().toLocaleLowerCase('en')
        const unitsFor = (provider: RegisteredProvider): PlanExecutionUnit[] =>
          plan.unitsByProvider.get(providerKey(provider)) ?? []
        // The mode was frozen when the run was queued and is never re-read
        // from config here. An adapter that lost its batch API since (a
        // downgrade) can only answer sync.
        const frozenModes = existingRun.providerDispatchModes ?? {}
        const batchProviders = new Set<ProviderName>()
        for (const provider of apiProviders) {
          if (frozenModes[providerKey(provider)] !== ProviderDispatchModes.batch) continue
          if (adapterSupportsBatch(provider.adapter)) batchProviders.add(provider.adapter.name)
          else log.warn('run.batch-unsupported', { runId, providerName: provider.adapter.name })
        }
        log.info('run.plan-dispatch', {
          runId,
          expectedSlots: plan.manifest.expectedSlots.length,
          executionNodes: plan.nodeCount,
          providers: [...plan.unitsByProvider.keys()],
          batchProviders: [...batchProviders],
        })
        const submission: BatchSubmissionContext = {
          runId,
          projectId,
          recording,
          reservations: providerReservations,
          providerDispatchCounts,
          batchRowIds,
        }
        await runWithConcurrency(apiProviders, resolveProviderFanout(), async (registeredProvider) => {
          // A batch provider hands its slots to the provider's batch API. Only
          // the slots a batch cannot carry come back to be answered here, and
          // they run concurrently with every sync provider, exactly as today.
          const units = batchProviders.has(registeredProvider.adapter.name)
            ? await this.submitPlanBatches(submission, registeredProvider, unitsFor(registeredProvider))
            : unitsFor(registeredProvider)
          await Promise.all(units.map(async (unit) => {
            await processNodeForProvider(registeredProvider, unit)
          }))
        })
        for (const registeredProvider of browserProviders) {
          for (const unit of unitsFor(registeredProvider)) {
            await processNodeForProvider(registeredProvider, unit)
          }
        }
      } else {
        await runWithConcurrency(apiProviders, resolveProviderFanout(), async (registeredProvider) => {
          await Promise.all(projectQueries.map(async (q) => {
            await processQueryForProvider(registeredProvider, q)
          }))
        })

        // Browser providers still run query-by-query to preserve tab reuse semantics.
        for (const registeredProvider of browserProviders) {
          for (const q of projectQueries) {
            await processQueryForProvider(registeredProvider, q)
          }
        }
      }
      providerCallEnd = Date.now()

      this.throwIfRunCancelled(runId)

      // An expected slot that never ran is not a success. A provider the
      // manifest lists but the registry could not serve dispatches nothing and
      // raises no error, so without this a run could report "completed" having
      // measured half of what it promised.
      if (planExecution) {
        for (const [provider, units] of planExecution.unitsByProvider) {
          const providerName = provider as ProviderName
          const dispatched = providerDispatchCounts.get(providerName) ?? 0
          if (dispatched >= units.length || providerErrors.has(providerName)) continue
          providerErrors.set(
            providerName,
            `${units.length - dispatched} expected measurement(s) did not run: no ${provider} provider was available to this worker.`,
          )
        }
      }
      const planShortfall = planExecution
        ? Math.max(0, planExecution.manifest.expectedSlots.length - totalSnapshotsInserted)
        : 0

      // A run with a provider batch completes from what the database holds
      // once every batch is settled, never from this sweep's own count: a
      // batch answer is recorded by ingest, possibly before this line runs.
      if (batchRowIds.length > 0) {
        this.handOffBatchRun({
          runId,
          projectId,
          providerErrors,
          quota: { dispatched: providerDispatchCounts, reservations: providerReservations },
          releaseExecution,
        })
        return
      }

      const finalized = this.finalizeRun({
        runId,
        projectId,
        kind: existingRun.kind,
        inserted: totalSnapshotsInserted,
        providerErrors,
        planShortfall,
        executionContext,
        startTime,
        phases: buildPhases({ startTime, providerCallStart, providerCallEnd }),
        quota: { dispatched: providerDispatchCounts, reservations: providerReservations },
      })
      // A cancel that lands after the check above leaves the run cancelled
      // rather than overwritten, and this execution reports it as the
      // cancellation it is.
      if (!finalized && this.isRunCancelled(runId)) throw new RunCancelledError(runId)
    } catch (err: unknown) {
      const executionContext: RunExecutionContext = {
        providerCount: activeProviders.length,
        providers: activeProviders.map(provider => provider.adapter.name),
        queryCount: planExecution?.nodeCount ?? projectQueries.length,
        ...(runLocation ? { location: runLocation.label } : {}),
        ...(runTrigger ? { trigger: runTrigger } : {}),
        ...(canonicalDomain ? { canonicalDomain } : {}),
      }

      if (err instanceof RunCancelledError || this.isRunCancelled(runId)) {
        this.flushProviderUsage(providerDispatchCounts, providerReservations)
        const cancelled = this.markBatchesCancelled(batchRowIds, 'Cancelled with its run.')
        this.handleCancelledRun(runId, projectId, startTime, executionContext)
        await this.cancelAtProvider(cancelled)
        return
      }

      // Mark run as failed. Only a run this executor was actually running: a
      // stray dispatch of a finished run (partial, completed) throws before it
      // does any work, and must not overwrite that run's real outcome.
      const errorMessage = describeError(err)
      this.db
        .update(runs)
        .set({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: errorMessage,
        })
        .where(and(eq(runs.id, runId), inArray(runs.status, ['queued', 'running'])))
        .run()

      this.flushProviderUsage(providerDispatchCounts, providerReservations)
      // A failed run must not be left with a batch still working for it:
      // cancelled here so nothing ingests into it, and stopped at the provider
      // (best effort) once the failure is reported.
      const abandoned = this.markBatchesCancelled(batchRowIds, `Cancelled because the run failed: ${errorMessage}`)

      // Distinguish config-validation aborts (no providers configured, project
      // missing, quota exceeded) from real runtime failures. The former never
      // reach any provider work, so reporting them as `run.completed` with
      // status=failed conflates "user has no providers" with "audit failed."
      // Emit `run.aborted` with a reason instead — the run is still marked
      // failed in the DB above so the user sees it, but the telemetry stream
      // stays clean for monitoring real audit failures.
      const abortReason = classifyRunAbortReason(errorMessage)
      const phases = buildPhases({ startTime, providerCallStart, providerCallEnd })
      if (abortReason) {
        const domainHash = hashDomain(executionContext.canonicalDomain ?? null)
        trackEvent('run.aborted', {
          reason: abortReason,
          providerCount: executionContext.providerCount,
          providers: executionContext.providers,
          queryCount: executionContext.queryCount,
          durationMs: Date.now() - startTime,
          ...(executionContext.trigger ? { trigger: executionContext.trigger } : {}),
          ...(domainHash ? { domainHash } : {}),
          ...(phases ? { phases } : {}),
          ...(executionContext.location ? { location: executionContext.location } : {}),
        })
      } else {
        trackEvent(
          'run.completed',
          buildRunCompletedProps({
            status: 'failed',
            providerCount: executionContext.providerCount,
            providers: executionContext.providers,
            queryCount: executionContext.queryCount,
            startTime,
            trigger: executionContext.trigger,
            canonicalDomain: executionContext.canonicalDomain,
            phases,
            location: executionContext.location,
          }),
          { errorCode: 'UNKNOWN' },
        )
      }

      // Notify on failure too
      if (this.onRunCompleted) {
        this.onRunCompleted(runId, projectId).catch((notifErr: unknown) => {
          log.error('notification.callback-failed', { runId, error: describeError(notifErr) })
        })
      }
      await this.cancelAtProvider(abandoned)
    } finally {
      releaseExecution()
    }
  }

  /**
   * Move a running run to its terminal status, exactly once.
   *
   * The status write is a compare-and-set on `running`. Only the call that
   * wins it emits `run.completed` (and `activation.completed`), counts the
   * run, and hands it to the post-run pipeline. A run that is no longer
   * running (cancelled, or finished by another attempt) keeps its row as it
   * is and nothing is reported for it here, so a late or repeated attempt is
   * harmless.
   *
   * Quota sits outside that exclusivity on purpose. A reservation belongs to
   * the execution that made it: each `executeRun` and each fill keeps its own
   * map, and no path ever shares one. `flushProviderUsage` empties the map it
   * releases, so the same reservation can never be released twice; and a
   * losing attempt must still give back its own unsent capacity, because no
   * other path knows it exists and it would stay counted for the rest of the
   * day. A reservation that outlives the execution that made it, and so could
   * be seen by two finalizers, does not belong in `quota`: release it from
   * wherever it is stored, under a guard of its own.
   *
   * Returns whether this call finalized the run.
   */
  finalizeRun(input: RunFinalization): boolean {
    const { runId, providerErrors } = input
    const outcome = runOutcome(input.inserted, providerErrors, input.planShortfall)
    const won = this.db
      .update(runs)
      .set({
        status: outcome.status,
        finishedAt: new Date().toISOString(),
        ...(outcome.error !== null ? { error: outcome.error } : {}),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running)))
      .run()
      .changes === 1

    if (input.quota) this.flushProviderUsage(input.quota.dispatched, input.quota.reservations)

    if (!won) {
      const current = this.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()
      log.info('run.finalize-skipped', { runId, status: current?.status ?? null })
      return false
    }

    this.reportFinalizedRun(input, outcome.status)
    return true
  }

  /**
   * Everything that happens once, and only for the call that moved the run to
   * its terminal status: telemetry, activation, the run counter and the
   * post-run pipeline.
   */
  private reportFinalizedRun(input: Omit<RunFinalization, 'planShortfall' | 'quota'>, finalStatus: FinalRunStatus): void {
    const { runId, projectId, providerErrors, executionContext } = input
    // Track run completion telemetry. When providers actually ran but some
    // failed, emit an `errorCode` so dashboards can break down real failures
    // by category (auth, rate-limit, network, parse, …) instead of lumping
    // them all into "failed."
    const failureCode = providerErrors.size > 0
      ? classifyProviderErrors(providerErrors)
      : undefined
    trackEvent(
      'run.completed',
      buildRunCompletedProps({
        status: finalStatus,
        providerCount: executionContext.providerCount,
        providers: executionContext.providers,
        queryCount: executionContext.queryCount,
        startTime: input.startTime,
        trigger: executionContext.trigger,
        canonicalDomain: executionContext.canonicalDomain,
        phases: input.phases,
        location: executionContext.location,
      }),
      failureCode ? { errorCode: failureCode } : undefined,
    )

    // Activation is a non-empty first answer-visibility result, not merely a
    // run row reaching "completed". This excludes probes, zero-query runs,
    // and later routine sweeps so the funnel has one durable success event.
    if (
      input.kind === RunKinds['answer-visibility']
      && executionContext.trigger !== RunTriggers.probe
      && input.inserted > 0
      && !this.hasPriorActivation(projectId, runId)
    ) {
      trackEvent('activation.completed', {
        flowVersion: ONBOARDING_FLOW_VERSION,
        kind: 'answer_visibility',
        status: finalStatus,
        providerCountBucket: bucketOnboardingCount(executionContext.providerCount),
        queryCountBucket: bucketOnboardingCount(executionContext.queryCount),
        snapshotCountBucket: bucketOnboardingCount(input.inserted),
      })
      try {
        this.onFirstActivation?.()
      } catch {
        // A celebration must never fail a run.
      }
    }

    this.incrementUsage(projectId, 'runs', 1)

    // Notify after run completion
    if (this.onRunCompleted) {
      this.onRunCompleted(runId, projectId).catch((err: unknown) => {
        log.error('notification.callback-failed', { runId, error: describeError(err) })
      })
    }
  }

  /**
   * Hand a run whose provider batches are still out to the batch poller.
   *
   * The sync providers' errors are persisted first: they are the marker that
   * the sweep is done (non-null, `{}` when there were none), and they must
   * survive a restart because only the finalizer, later, folds them into the
   * run's error. Then only this sweep's own reservation is settled: what went
   * into a batch stays reserved on the batch row until ingest knows what the
   * provider billed. The run stays `running` and nothing is reported here.
   *
   * If every batch already settled (the provider was quick, or every submit
   * failed), the run finalizes now, from the database.
   */
  private handOffBatchRun(input: {
    runId: string
    projectId: string
    providerErrors: ReadonlyMap<ProviderName, string>
    quota: RunQuotaReservations
    releaseExecution: () => void
  }): void {
    const { runId, projectId } = input
    const handedOff = this.db.update(runs)
      .set({ pendingProviderErrors: Object.fromEntries(input.providerErrors) })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running)))
      .run()
      .changes === 1
    this.flushProviderUsage(input.quota.dispatched, input.quota.reservations)
    if (!handedOff) {
      // A cancel landed during the sweep: report it as the cancellation it is.
      if (this.isRunCancelled(runId)) throw new RunCancelledError(runId)
      log.warn('run.handoff-skipped', { runId })
      return
    }
    // From here the poller owns the outcome, so the sweep lets go of the run
    // before asking whether it can already finalize.
    input.releaseExecution()
    log.info('run.batch-handoff', { runId, syncErrors: input.providerErrors.size })
    this.finalizeBatchRun(runId, projectId)
  }

  /**
   * Finalize a run that dispatched provider batches, from the database.
   *
   * Only once the sweep handed it off (`pending_provider_errors` is non-null),
   * no batch of it is submitting, submitted or ended, and no `executeRun` in
   * this process still holds it. Its status comes from the slots recorded
   * against its manifest, the sync errors the sweep persisted, and what the
   * batches left unanswered; the marker is cleared by the same compare-and-set
   * that moves it off `running`, so only one caller ever reports it.
   *
   * Returns whether this call finalized the run.
   */
  finalizeBatchRun(runId: string, projectId: string): boolean {
    if (this.isExecuting(runId)) return false
    const finishedAt = new Date().toISOString()
    const decided = this.db.transaction((tx) => {
      const txDb = tx as unknown as DatabaseClient
      const run = txDb.select({ kind: runs.kind, status: runs.status, pendingProviderErrors: runs.pendingProviderErrors })
        .from(runs).where(and(eq(runs.id, runId), eq(runs.projectId, projectId))).get()
      if (!run || run.status !== RunStatuses.running || run.pendingProviderErrors === null) return null
      const holding = txDb.select({ id: providerBatches.id }).from(providerBatches)
        .where(and(eq(providerBatches.runId, runId), inArray(providerBatches.status, RUN_HOLDING_BATCH_STATUSES)))
        .limit(1).get()
      if (holding) return null

      const state = measurementRunSlotState(txDb, runId)
      const inserted = txDb.select({ value: count() }).from(querySnapshots).where(eq(querySnapshots.runId, runId)).get()?.value ?? 0
      const providerErrors = this.batchRunProviderErrors(txDb, runId, run.pendingProviderErrors, state.missing)
      // An unreadable manifest cannot vouch for a single slot.
      const shortfall = state.missing.length + (state.readable ? 0 : 1)
      const outcome = runOutcome(inserted, providerErrors, shortfall)
      const won = txDb.update(runs)
        .set({
          status: outcome.status,
          finishedAt,
          pendingProviderErrors: null,
          ...(outcome.error !== null ? { error: outcome.error } : {}),
        })
        .where(and(eq(runs.id, runId), eq(runs.status, RunStatuses.running), isNotNull(runs.pendingProviderErrors)))
        .run()
        .changes === 1
      return won ? { kind: run.kind, inserted, providerErrors, status: outcome.status } : null
    })
    if (!decided) return false

    const telemetry = this.batchRunTelemetry(runId, projectId)
    log.info('run.batch-finalized', { runId, status: decided.status, inserted: decided.inserted })
    this.reportFinalizedRun({
      runId,
      projectId,
      kind: decided.kind,
      inserted: decided.inserted,
      providerErrors: decided.providerErrors,
      executionContext: telemetry.executionContext,
      startTime: telemetry.startTime,
      // The sweep's phase split does not survive the wait (or a restart);
      // `durationMs` spans from the run's start to this finalization.
      phases: undefined,
    }, decided.status)
    return true
  }

  /**
   * Every provider that left a slot of a batch run unanswered, with one reason
   * each: what the sweep persisted first (sync errors, including a sync
   * fallback's), then what each batch left behind, then a plain count for a
   * gap nothing else explains, so no missing slot goes unnamed.
   */
  private batchRunProviderErrors(
    db: DatabaseClient,
    runId: string,
    pending: Record<string, string>,
    missing: ReadonlyArray<{ provider: string }>,
  ): Map<ProviderName, string> {
    const errors = new Map<ProviderName, string>(Object.entries(pending))
    const add = (provider: string, message: string): void => {
      if (!errors.has(provider)) errors.set(provider, message)
    }
    const batches = db.select().from(providerBatches).where(eq(providerBatches.runId, runId))
      .orderBy(asc(providerBatches.createdAt), asc(providerBatches.id)).all()
    for (const batch of batches) {
      switch (batch.status) {
        case ProviderBatchStatuses.unknown:
        case ProviderBatchStatuses.cancelled:
          if (batch.error) add(batch.provider, batch.error)
          break
        case ProviderBatchStatuses.ingested: {
          const unrecorded = db.select({ outcome: providerBatchRequests.outcome, error: providerBatchRequests.error })
            .from(providerBatchRequests)
            .where(and(eq(providerBatchRequests.batchId, batch.id), inArray(providerBatchRequests.outcome, [...UNRECORDED_OUTCOMES])))
            .orderBy(asc(providerBatchRequests.executionId))
            .all()
          const first = unrecorded[0]
          if (first) {
            add(batch.provider, `${unrecorded.length} of ${batch.requestCount} batch answer(s) were not recorded. First: ${first.error ?? first.outcome}`)
          }
          break
        }
        // A refused batch fell back to sync, whose errors are already pending;
        // the other statuses never reach a finalizer.
        case ProviderBatchStatuses.failed:
        case ProviderBatchStatuses.submitting:
        case ProviderBatchStatuses.submitted:
        case ProviderBatchStatuses.ended:
          break
      }
    }
    const gaps = new Map<string, number>()
    for (const slot of missing) gaps.set(slot.provider, (gaps.get(slot.provider) ?? 0) + 1)
    for (const [provider, gap] of gaps) add(provider, `${gap} expected measurement(s) have not run.`)
    return errors
  }

  /**
   * The telemetry context of a run finalized away from its sweep, rebuilt from
   * the rows the sweep read: the manifest's providers this instance serves,
   * its execution nodes, and the run's own start.
   */
  private batchRunTelemetry(runId: string, projectId: string): { executionContext: RunExecutionContext; startTime: number } {
    const run = this.db.select({
      trigger: runs.trigger,
      location: runs.location,
      startedAt: runs.startedAt,
      createdAt: runs.createdAt,
      manifest: runs.measurementManifest,
    }).from(runs).where(eq(runs.id, runId)).get()
    const project = this.db.select({ canonicalDomain: projects.canonicalDomain }).from(projects).where(eq(projects.id, projectId)).get()
    const providers = new Set<string>()
    const nodes = new Set<string>()
    try {
      for (const slot of run?.manifest ? parseMeasurementRunManifestV1(run.manifest).expectedSlots : []) {
        if (this.registry.get(slot.provider)) providers.add(slot.provider)
        nodes.add(slot.executionId)
      }
    } catch {
      // Telemetry only: an unreadable manifest reports no providers.
    }
    const started = Date.parse(run?.startedAt ?? run?.createdAt ?? '')
    return {
      startTime: Number.isFinite(started) ? started : Date.now(),
      executionContext: {
        providerCount: providers.size,
        providers: [...providers],
        queryCount: nodes.size,
        ...(run?.location ? { location: run.location } : {}),
        ...(run?.trigger ? { trigger: run.trigger } : {}),
        ...(project?.canonicalDomain ? { canonicalDomain: project.canonicalDomain } : {}),
      },
    }
  }

  /**
   * Submit one batch provider's slots of a plan sweep. Returns the slots that
   * must be answered sync instead: those a batch cannot carry, and those of a
   * batch the provider definitely refused.
   *
   * Slots are grouped by the model they are sent as, the frozen id resolved
   * through the provider's retired-id aliases (a batch line carries its own
   * model, but a batch row records one), and each group is split to the
   * provider's hard limits and the operator's `maxRequestsPerBatch`.
   */
  private async submitPlanBatches(
    ctx: BatchSubmissionContext,
    registered: RegisteredProvider,
    units: readonly PlanExecutionUnit[],
  ): Promise<PlanExecutionUnit[]> {
    const { adapter, config } = registered
    const capability = adapter.batch
    if (!capability || !adapter.buildTrackedQueryRequest) return [...units]
    const providerName = adapter.name
    const syncUnits: PlanExecutionUnit[] = []
    const linesByModel = new Map<string, BatchLine[]>()
    for (const unit of units) {
      // Eligibility froze a model onto every slot; a slot without one could
      // never be filled with the same model, so it is answered now instead.
      const requestedModel = unit.requestedModel
      if (!requestedModel) {
        syncUnits.push(unit)
        continue
      }
      // Asked for as the sync call asks: a retired id frozen on an immutable
      // revision is sent as the id that answers now.
      const model = resolveProviderModel(providerName, requestedModel)
      let request: TrackedQueryRequest
      try {
        request = adapter.buildTrackedQueryRequest({
          query: unit.queryText,
          canonicalDomains: ctx.recording.allDomains,
          competitorDomains: ctx.recording.competitorsFor(unit.executionId).domains,
          location: unit.context ?? undefined,
        }, { ...config, model })
      } catch (err: unknown) {
        // The sync call builds the same request, so it reports this failure
        // as the provider's error for the slot.
        log.warn('batch.build-failed', { runId: ctx.runId, providerName, executionId: unit.executionId, error: describeError(err) })
        syncUnits.push(unit)
        continue
      }
      const customId = crypto.randomUUID().replace(/-/g, '')
      const lines = linesByModel.get(model) ?? []
      lines.push({ unit, requestedModel, customId, request, bytes: Buffer.byteLength(JSON.stringify({ custom_id: customId, params: request.body })) })
      linesByModel.set(model, lines)
    }

    const maxRequests = Math.min(capability.maxRequestsPerBatch, config.batch?.maxRequestsPerBatch ?? Number.POSITIVE_INFINITY)
    for (const [model, lines] of linesByModel) {
      const { chunks, oversized } = chunkBatchLines(lines, maxRequests, capability.maxBytesPerBatch)
      if (oversized.length > 0) {
        log.warn('batch.line-too-large', { runId: ctx.runId, providerName, model, count: oversized.length, maxBytes: capability.maxBytesPerBatch })
        syncUnits.push(...oversized.map(line => line.unit))
      }
      for (const chunk of chunks) {
        syncUnits.push(...await this.submitProviderBatch(ctx, registered, model, chunk))
      }
    }
    return syncUnits
  }

  /**
   * Submit one batch, at most once.
   *
   * The row and its ledger are written `submitting` in one transaction BEFORE
   * the call, so a crash in between leaves a batch whose outcome is unknown
   * rather than one nobody knows about. A definite refusal hands the slots
   * back to be answered sync (nothing was created); any other failure may have
   * created the batch, so the row becomes `unknown` and is never resubmitted.
   */
  private async submitProviderBatch(
    ctx: BatchSubmissionContext,
    registered: RegisteredProvider,
    model: string,
    lines: readonly BatchLine[],
  ): Promise<PlanExecutionUnit[]> {
    this.throwIfRunCancelled(ctx.runId)
    const { adapter, config } = registered
    const capability = adapter.batch
    const providerName = adapter.name
    const reservation = ctx.reservations.get(providerName)
    if (!capability || !reservation) throw new Error(`Provider ${providerName} cannot submit a batch for run ${ctx.runId}`)
    const deadlineMs = (config.batch?.deadlineHours ?? capability.defaultDeadlineHours) * HOUR_MS
    const created = new Date()
    const rowId = crypto.randomUUID()
    this.db.transaction((tx) => {
      tx.insert(providerBatches).values({
        id: rowId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        provider: providerName,
        model,
        status: ProviderBatchStatuses.submitting,
        requestCount: lines.length,
        quotaScope: reservation.scope,
        quotaPeriod: reservation.period,
        quotaReserved: lines.length,
        // Provisional: the deadline runs from acceptance and is rewritten then.
        deadlineAt: new Date(created.getTime() + deadlineMs).toISOString(),
        createdAt: created.toISOString(),
        updatedAt: created.toISOString(),
      }).run()
      tx.insert(providerBatchRequests).values(lines.map(line => ({
        id: line.customId,
        batchId: rowId,
        executionId: line.unit.executionId,
        queryId: line.unit.queryId,
        queryText: line.unit.queryText,
        requestedModel: line.requestedModel,
        requestedContext: line.unit.context,
      }))).run()
    })
    ctx.batchRowIds.push(rowId)

    let result: ProviderBatchSubmitResult
    try {
      result = await capability.submit(lines.map(line => ({ customId: line.customId, request: line.request })), { ...config, model })
    } catch (err: unknown) {
      const message = describeError(err)
      const at = new Date().toISOString()
      if (err instanceof ProviderBatchSubmitError && err.definite) {
        // Nothing was created, so the reservation goes back to the sweep,
        // which spends it answering the same slots sync.
        this.db.update(providerBatches)
          .set({ status: ProviderBatchStatuses.failed, error: message, quotaReleased: lines.length, updatedAt: at })
          .where(and(eq(providerBatches.id, rowId), eq(providerBatches.status, ProviderBatchStatuses.submitting)))
          .run()
        log.warn('batch.submit-refused', { runId: ctx.runId, providerName, batchId: rowId, requests: lines.length, error: message })
        return lines.map(line => line.unit)
      }
      // The provider may have created (and will bill) it: its lines count as
      // sent, and its slots stay missing rather than risk paying twice.
      this.db.update(providerBatches)
        .set({
          status: ProviderBatchStatuses.unknown,
          error: `The provider batch of ${lines.length} answer(s) may or may not have been created, so it was not resubmitted and its answers were not recorded: ${message}`,
          updatedAt: at,
        })
        .where(and(eq(providerBatches.id, rowId), eq(providerBatches.status, ProviderBatchStatuses.submitting)))
        .run()
      this.countDispatched(ctx.providerDispatchCounts, providerName, lines.length)
      log.error('batch.submit-unknown', { runId: ctx.runId, providerName, batchId: rowId, requests: lines.length, error: message })
      return []
    }

    const submitted = new Date()
    this.countDispatched(ctx.providerDispatchCounts, providerName, lines.length)
    const accepted = this.db.update(providerBatches)
      .set({
        status: ProviderBatchStatuses.submitted,
        providerBatchId: result.providerBatchId,
        submittedAt: submitted.toISOString(),
        deadlineAt: new Date(submitted.getTime() + deadlineMs).toISOString(),
        updatedAt: submitted.toISOString(),
      })
      .where(and(eq(providerBatches.id, rowId), eq(providerBatches.status, ProviderBatchStatuses.submitting)))
      .run()
      .changes === 1
    if (!accepted) {
      // The run was cancelled or failed while the submit was in flight, and
      // the row was cancelled with it. Keep the provider's id for the record
      // and stop the batch it just created.
      this.db.update(providerBatches)
        .set({ providerBatchId: result.providerBatchId, updatedAt: submitted.toISOString() })
        .where(eq(providerBatches.id, rowId))
        .run()
      await this.cancelAtProvider([{ id: rowId, provider: providerName, providerBatchId: result.providerBatchId }])
      return []
    }
    log.info('batch.submitted', { runId: ctx.runId, providerName, batchId: rowId, providerBatchId: result.providerBatchId, model, requests: lines.length })
    return []
  }

  private countDispatched(counts: Map<ProviderName, number>, providerName: ProviderName, sent: number): void {
    counts.set(providerName, (counts.get(providerName) ?? 0) + sent)
  }

  /**
   * Cancel batches whose run no longer wants them: mark them `cancelled` at
   * once (so nothing ingests them), then ask the provider to stop, best
   * effort. What the provider had already processed may still be billed, so
   * their reservation is kept. Returns how many were cancelled.
   */
  async abandonProviderBatches(batchIds: readonly string[], reason: string): Promise<number> {
    const marked = this.markBatchesCancelled(batchIds, reason)
    await this.cancelAtProvider(marked)
    return marked.length
  }

  private markBatchesCancelled(batchIds: readonly string[], reason: string): Array<{ id: string; provider: string; providerBatchId: string | null }> {
    if (batchIds.length === 0) return []
    const now = new Date().toISOString()
    const rows = this.db.select().from(providerBatches)
      .where(and(inArray(providerBatches.id, [...batchIds]), inArray(providerBatches.status, RUN_HOLDING_BATCH_STATUSES)))
      .all()
    const marked: Array<{ id: string; provider: string; providerBatchId: string | null }> = []
    for (const row of rows) {
      const changed = this.db.update(providerBatches)
        .set({ status: ProviderBatchStatuses.cancelled, error: reason, cancelRequestedAt: row.cancelRequestedAt ?? now, updatedAt: now })
        .where(and(eq(providerBatches.id, row.id), eq(providerBatches.status, row.status)))
        .run()
        .changes === 1
      if (changed) marked.push({ id: row.id, provider: row.provider, providerBatchId: row.providerBatchId })
    }
    return marked
  }

  private async cancelAtProvider(rows: ReadonlyArray<{ id: string; provider: string; providerBatchId: string | null }>): Promise<void> {
    for (const row of rows) {
      // A batch still being submitted has no provider id yet; its submit
      // cancels it on return.
      if (!row.providerBatchId) continue
      const registered = this.registry.get(row.provider)
      if (!registered?.adapter.batch) {
        log.warn('batch.cancel-unavailable', { batchId: row.id, providerName: row.provider })
        continue
      }
      try {
        await registered.adapter.batch.cancel(row.providerBatchId, registered.config)
        log.info('batch.cancelled', { batchId: row.id, providerName: row.provider, providerBatchId: row.providerBatchId })
      } catch (err: unknown) {
        log.warn('batch.cancel-failed', { batchId: row.id, providerName: row.provider, error: describeError(err) })
      }
    }
  }

  /**
   * `POST /runs/:id/cancel` for a run with provider batches: stop them at the
   * provider and never ingest them. If the sweep already handed the run off,
   * nothing else will report the cancellation, so it is reported here, once
   * (clearing the handoff marker is the claim). A sweep still running reports
   * its own.
   */
  async cancelRunBatches(runId: string, projectId: string): Promise<void> {
    const sweepReports = this.isExecuting(runId)
    const ids = this.db.select({ id: providerBatches.id }).from(providerBatches)
      .where(and(eq(providerBatches.runId, runId), eq(providerBatches.projectId, projectId)))
      .all()
      .map(row => row.id)
    const marked = this.markBatchesCancelled(ids, 'Cancelled with its run.')
    if (!sweepReports) {
      const claimed = this.db.update(runs)
        .set({ pendingProviderErrors: null })
        .where(and(
          eq(runs.id, runId),
          eq(runs.projectId, projectId),
          eq(runs.status, RunStatuses.cancelled),
          isNotNull(runs.pendingProviderErrors),
        ))
        .run()
        .changes === 1
      if (claimed) {
        const telemetry = this.batchRunTelemetry(runId, projectId)
        this.handleCancelledRun(runId, projectId, telemetry.startTime, telemetry.executionContext)
      }
    }
    await this.cancelAtProvider(marked)
  }

  /**
   * Read an ended batch's results into its run: every line mapped by
   * `custom_id` to its slot, parsed by the adapter's own parser and recorded
   * through `recordSlot`, exactly like a sync answer but at the batch tier.
   *
   * Idempotent across crashes. Each line's outcome is written as soon as it is
   * handled and a handled line is skipped on the next pass; the insert does
   * nothing on a slot that is already answered; the reservation of unbilled
   * lines is released under `quota_released`, in the same transaction that
   * marks the batch `ingested`. Answers are scored against the project's
   * identity as it is now, as a fill's are.
   */
  async ingestProviderBatch(batchId: string): Promise<ProviderBatchIngestResult> {
    const batch = this.db.select().from(providerBatches).where(eq(providerBatches.id, batchId)).get()
    if (batch?.status !== ProviderBatchStatuses.ended) return { kind: 'skipped' }
    const runStatus = this.db.select({ status: runs.status }).from(runs).where(eq(runs.id, batch.runId)).get()?.status
    if (runStatus !== RunStatuses.running) {
      this.markBatchesCancelled([batch.id], 'Cancelled because its run is no longer running.')
      return { kind: 'cancelled' }
    }
    const registered = this.registry.get(batch.provider)
    const capability = registered?.adapter.batch
    if (!registered || !capability || !registered.adapter.parseTrackedQueryResponse || !batch.providerBatchId) {
      throw new Error(`No ${batch.provider} batch API is configured to read batch ${batch.id}`)
    }

    const requests = new Map(this.db.select().from(providerBatchRequests)
      .where(eq(providerBatchRequests.batchId, batch.id)).all()
      .map(row => [row.id, row]))
    const ctx: SlotRecordingContext = { ...this.buildRunRecordingContext(batch.runId, batch.projectId), onInserted: () => {} }
    try {
      for await (const line of capability.results(batch.providerBatchId, registered.config)) {
        const request = requests.get(line.customId)
        if (!request) {
          log.warn('batch.unknown-line', { batchId: batch.id, providerName: batch.provider, customId: line.customId })
          continue
        }
        // Handled by an earlier pass that was interrupted.
        if (request.outcome !== null) continue
        // Cancelled with its run while the lines were streaming: record nothing more.
        if (this.db.select({ status: providerBatches.status }).from(providerBatches).where(eq(providerBatches.id, batch.id)).get()?.status !== ProviderBatchStatuses.ended) {
          return { kind: 'cancelled' }
        }
        const settled = await this.ingestBatchLine(ctx, registered, batch, request, line)
        this.db.update(providerBatchRequests)
          .set({ outcome: settled.outcome, error: settled.error })
          .where(and(eq(providerBatchRequests.id, request.id), isNull(providerBatchRequests.outcome)))
          .run()
        requests.set(request.id, { ...request, outcome: settled.outcome })
      }
    } catch (err: unknown) {
      if (!(err instanceof RunCancelledError)) throw err
      this.markBatchesCancelled([batch.id], 'Cancelled because its run is no longer running.')
      return { kind: 'cancelled' }
    }
    return this.completeBatchIngest(batch)
  }

  private async ingestBatchLine(
    ctx: SlotRecordingContext,
    registered: RegisteredProvider,
    batch: typeof providerBatches.$inferSelect,
    request: typeof providerBatchRequests.$inferSelect,
    line: ProviderBatchResultLine,
  ): Promise<{ outcome: ProviderBatchRequestOutcome; error: string | null }> {
    if (line.type !== 'succeeded') return { outcome: unansweredOutcome(line.type), error: line.error }
    const { adapter } = registered
    if (!adapter.parseTrackedQueryResponse) throw new Error(`Provider ${adapter.name} cannot read a batch answer`)
    let raw: RawQueryResult
    try {
      raw = adapter.parseTrackedQueryResponse(line.body, resolveProviderModel(adapter.name, request.requestedModel))
    } catch (err: unknown) {
      // Where the sync call would have thrown on the same body (Claude: a
      // failed web search). The answer was billed but cannot be read.
      const error = describeError(err)
      log.warn('batch.parse-failed', { runId: batch.runId, batchId: batch.id, providerName: batch.provider, executionId: request.executionId, error })
      return { outcome: ProviderBatchRequestOutcomes.parse_failed, error }
    }
    const unit: PlanExecutionUnit = {
      executionId: request.executionId,
      queryText: request.queryText,
      context: request.requestedContext,
      queryId: request.queryId,
      requestedModel: request.requestedModel,
    }
    const written = await this.recordSlot(ctx, registered, unit, raw, {
      idempotent: true,
      mode: ProviderDispatchModes.batch,
      providerBatchId: batch.id,
      pricingTier: PricingTiers.batch,
    })
    if (written) return { outcome: ProviderBatchRequestOutcomes.recorded, error: null }
    // The slot already has an answer: this batch's own, from a pass that died
    // before writing the outcome, or another writer's.
    const existing = this.db.select({ providerBatchId: querySnapshots.providerBatchId }).from(querySnapshots)
      .where(and(
        eq(querySnapshots.runId, batch.runId),
        eq(querySnapshots.measurementExecutionId, request.executionId),
        eq(querySnapshots.provider, registered.adapter.name),
      ))
      .get()
    return existing?.providerBatchId === batch.id
      ? { outcome: ProviderBatchRequestOutcomes.recorded, error: null }
      : { outcome: ProviderBatchRequestOutcomes.duplicate, error: null }
  }

  /** Close an ingest: counts, the unbilled lines' quota, and `ingested`, in one transaction. */
  private completeBatchIngest(batch: typeof providerBatches.$inferSelect): ProviderBatchIngestResult {
    const at = new Date().toISOString()
    return this.db.transaction((tx) => {
      const txDb = tx as unknown as DatabaseClient
      const current = txDb.select({ status: providerBatches.status, quotaReleased: providerBatches.quotaReleased })
        .from(providerBatches).where(eq(providerBatches.id, batch.id)).get()
      // Cancelled while its lines were being read: it keeps what was recorded
      // and nothing else changes.
      if (current?.status !== ProviderBatchStatuses.ended) return { kind: 'skipped' } as const
      // The stream is complete, so a request with no line was never answered.
      txDb.update(providerBatchRequests)
        .set({ outcome: ProviderBatchRequestOutcomes.errored, error: 'The provider returned no result for this request.' })
        .where(and(eq(providerBatchRequests.batchId, batch.id), isNull(providerBatchRequests.outcome)))
        .run()
      const outcomes = txDb.select({ outcome: providerBatchRequests.outcome }).from(providerBatchRequests)
        .where(eq(providerBatchRequests.batchId, batch.id)).all()
        .map(row => row.outcome)
      const recorded = outcomes.filter(outcome => outcome === ProviderBatchRequestOutcomes.recorded).length
      const unbilled = outcomes.filter(outcome => outcome !== null && UNBILLED_OUTCOMES.includes(outcome)).length
      const notRecorded = outcomes.filter(outcome => outcome !== null && UNRECORDED_OUTCOMES.includes(outcome)).length
      // Never more than the row reserved, and never what an earlier pass
      // already gave back.
      const released = Math.max(0, Math.min(unbilled, batch.quotaReserved) - current.quotaReleased)
      releaseDailyQueryQuota(txDb, { scope: batch.quotaScope, period: batch.quotaPeriod, count: released })
      txDb.update(providerBatches)
        .set({
          status: ProviderBatchStatuses.ingested,
          ingestedCount: outcomes.length,
          recordedCount: recorded,
          quotaReleased: current.quotaReleased + released,
          ingestedAt: at,
          updatedAt: at,
        })
        .where(and(eq(providerBatches.id, batch.id), eq(providerBatches.status, ProviderBatchStatuses.ended)))
        .run()
      log.info('batch.ingested', { runId: batch.runId, batchId: batch.id, providerName: batch.provider, recorded, notRecorded, released })
      return { kind: 'ingested', recorded, notRecorded, released } as const
    })
  }

  /**
   * Complete a partial plan run in place: record only the expected slots it
   * never answered, under the same run id, then finalize the run once.
   *
   * The parent run is never written from an error path and only ever leaves
   * `partial` through the completion compare-and-set, so a failed or
   * interrupted fill leaves the run as the sweep left it, plus any answers the
   * fill did record. Its timestamps, manifest and identity are never touched:
   * it stays the same sweep, with the same place in every history.
   */
  async executeRunFill(fillId: string): Promise<void> {
    const claim = this.db
      .update(runFills)
      .set({ status: 'running', startedAt: new Date().toISOString() })
      .where(and(eq(runFills.id, fillId), eq(runFills.status, 'queued')))
      .run()
    if (claim.changes !== 1) {
      log.warn('fill.not-claimed', { fillId })
      return
    }
    try {
      await this.runClaimedFill(fillId)
    } catch (err: unknown) {
      // Only the database can throw this far out (every provider error is
      // caught per slot). Never leave the attempt `running`: that would block
      // every later fill for the project until a restart.
      const error = describeError(err)
      log.error('fill.aborted', { fillId, error })
      this.db.update(runFills)
        .set({ status: 'failed', finishedAt: new Date().toISOString(), error })
        .where(and(eq(runFills.id, fillId), eq(runFills.status, 'running')))
        .run()
    }
  }

  private async runClaimedFill(fillId: string): Promise<void> {
    const fill = this.db.select().from(runFills).where(eq(runFills.id, fillId)).get()
    if (!fill) return
    const { runId, projectId } = fill
    const requested = new Set(parseJsonColumn<string[]>(fill.providers, []).map(provider => provider.trim().toLocaleLowerCase('en')))
    const providerDispatchCounts = new Map<ProviderName, number>()
    const providerReservations = new Map<ProviderName, { scope: string; period: string; reserved: number }>()
    const providerErrors = new Map<ProviderName, string>()
    let filled = 0
    let fatal: string | null = null
    let superseded = false

    try {
      const run = this.getRunState(runId)
      if (!run) throw new Error(`Run ${runId} not found`)
      if (run.status !== 'partial') throw new Error(`Run ${runId} is ${run.status}; only a partial run can be filled`)
      const runCreatedAt = this.db.select({ createdAt: runs.createdAt }).from(runs).where(eq(runs.id, runId)).get()!.createdAt
      // The same identity the sweep matched against, read the same way.
      const recording = this.buildRunRecordingContext(runId, projectId)
      const projectQueries = this.db.select().from(queries).where(eq(queries.projectId, projectId)).all()
      const plan = resolvePlanExecution(run, projectQueries)
      if (!plan) throw new Error(`Run ${runId} did not measure a published plan`)

      // What is missing is decided now, not at admission: an earlier fill or a
      // racing writer may have recorded slots in between.
      const recorded = new Set(
        this.db.select({ executionId: querySnapshots.measurementExecutionId, provider: querySnapshots.provider })
          .from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
          .flatMap(row => row.executionId ? [measurementSlotKey(row.executionId, row.provider)] : []),
      )
      const unitsByProvider = new Map<ProviderName, PlanExecutionUnit[]>()
      for (const [provider, units] of plan.unitsByProvider) {
        if (requested.size > 0 && !requested.has(provider)) continue
        const missing = units.filter(unit => !recorded.has(measurementSlotKey(unit.executionId, provider)))
        if (missing.length > 0) unitsByProvider.set(provider, missing)
      }

      const activeProviders: RegisteredProvider[] = []
      for (const provider of unitsByProvider.keys()) {
        const registered = this.registry.get(provider)
        if (registered) activeProviders.push(registered)
        else providerErrors.set(provider, `No ${provider} provider is configured on this instance, so its missing answers did not run.`)
      }

      // Reserve what this fill will dispatch, never the run's whole manifest.
      const todayPeriod = getCurrentUsageDay()
      const dispatchable: RegisteredProvider[] = []
      for (const registered of activeProviders) {
        const name = registered.adapter.name
        const count = unitsByProvider.get(name)?.length ?? 0
        const scope = `${projectId}:${name}`
        const limit = registered.config.quotaPolicy.maxRequestsPerDay
        const quota = reserveDailyQueryQuota(this.db, { scope, period: todayPeriod, count, limit })
        if (!quota.reserved) {
          providerErrors.set(name, `Daily quota exceeded for ${name}: ${quota.used} queries used today, limit is ${limit}. This fill needs ${count} more.`)
          continue
        }
        providerReservations.set(name, { scope, period: todayPeriod, reserved: count })
        dispatchable.push(registered)
      }

      const executionGates = new Map<ProviderName, ProviderExecutionGate>()
      for (const registered of dispatchable) {
        executionGates.set(
          registered.adapter.name,
          getSharedProviderExecutionGate(
            registered.adapter.name,
            registered.config.quotaPolicy.maxConcurrency,
            registered.config.quotaPolicy.maxRequestsPerMinute,
          ),
        )
      }

      const consecutiveFailures = new Map<ProviderName, number>()
      const stopped = new Set<ProviderName>()
      const newerSweepExists = (): boolean => {
        if (!superseded && newerFullSweep(this.db, { id: runId, projectId, createdAt: runCreatedAt })) {
          superseded = true
          log.warn('fill.superseded', { fillId, runId })
        }
        return superseded
      }
      let removed = false
      const attemptRemoved = (): boolean => {
        if (!removed && this.db.select({ status: runFills.status }).from(runFills).where(eq(runFills.id, fillId)).get()?.status !== 'running') {
          removed = true
          log.warn('fill.attempt-removed', { fillId, runId })
        }
        return removed
      }
      const slotRecorded = (provider: ProviderName, executionId: string): boolean => this.db
        .select({ id: querySnapshots.id })
        .from(querySnapshots)
        .where(and(
          eq(querySnapshots.runId, runId),
          eq(querySnapshots.measurementExecutionId, executionId),
          eq(querySnapshots.provider, provider),
        ))
        .get() !== undefined

      const ctx: PlanSlotContext = {
        ...recording,
        executionGates,
        providerDispatchCounts,
        providerErrors,
        onInserted: () => { filled++ },
        fill: {
          shouldSkip: (provider, executionId) =>
            stopped.has(provider) || attemptRemoved() || newerSweepExists() || slotRecorded(provider, executionId),
          onOutcome: (provider, ok) => {
            if (ok) {
              consecutiveFailures.set(provider, 0)
              return
            }
            const failures = (consecutiveFailures.get(provider) ?? 0) + 1
            consecutiveFailures.set(provider, failures)
            if (failures >= RUN_FILL_PROVIDER_BREAKER && !stopped.has(provider)) {
              stopped.add(provider)
              log.warn('fill.provider-stopped', { fillId, runId, provider, failures })
            }
          },
        },
      }

      log.info('fill.dispatch', {
        fillId,
        runId,
        missing: Object.fromEntries([...unitsByProvider].map(([provider, units]) => [provider, units.length])),
      })
      const unitsFor = (registered: RegisteredProvider): PlanExecutionUnit[] => unitsByProvider.get(registered.adapter.name) ?? []
      const apiProviders = dispatchable.filter(p => !isBrowserProvider(p.adapter.name))
      const browserProviders = dispatchable.filter(p => isBrowserProvider(p.adapter.name))
      // Pulled, not queued up front: at most the provider's concurrency sits in
      // its gate at once, so a stop (breaker, newer sweep, removed attempt)
      // takes effect on the very next slot instead of after every queued one
      // has cycled through the rate limiter.
      await runWithConcurrency(apiProviders, resolveProviderFanout(), async (registered) => {
        await runWithConcurrency(
          unitsFor(registered),
          Math.max(1, registered.config.quotaPolicy.maxConcurrency),
          unit => this.executePlanSlot(ctx, registered, unit),
        )
      })
      for (const registered of browserProviders) {
        for (const unit of unitsFor(registered)) await this.executePlanSlot(ctx, registered, unit)
      }
    } catch (err: unknown) {
      fatal = describeError(err)
      log.error('fill.failed', { fillId, runId, error: fatal })
    } finally {
      this.flushProviderUsage(providerDispatchCounts, providerReservations)
    }

    const outcome = this.finalizeRunFill({ fillId, runId, filled, fatal, providerErrors, superseded })
    log.info('fill.finished', { fillId, runId, filled, ...outcome })
    // The run is whole now, so the parts of the post-run pipeline that were
    // held back while it was partial run for the first time: insights, the
    // citation gained/lost transitions and Aero. Its `run.completed` already
    // went out with the partial status, so the `fill` origin keeps the
    // notifier from sending a second one. A newer sweep owns "latest", so a
    // completion it overtook stays quiet.
    if (outcome.justCompleted && !outcome.superseded && this.onRunCompleted) {
      this.onRunCompleted(runId, projectId, { origin: 'fill' }).catch((err: unknown) => {
        log.error('notification.callback-failed', { runId, error: describeError(err) })
      })
    }
  }

  /** Record the fill's outcome and, if the run is now whole, complete it exactly once. */
  private finalizeRunFill(input: {
    fillId: string
    runId: string
    filled: number
    fatal: string | null
    providerErrors: ReadonlyMap<ProviderName, string>
    superseded: boolean
  }): { justCompleted: boolean; superseded: boolean } {
    const finishedAt = new Date().toISOString()
    return this.db.transaction((tx) => {
      const txDb = tx as unknown as DatabaseClient
      // Checked again here, not only before each dispatch: a sweep queued
      // while the last slot was in flight still owns "latest".
      const parent = txDb.select({ projectId: runs.projectId, createdAt: runs.createdAt, error: runs.error })
        .from(runs).where(eq(runs.id, input.runId)).get()
      const superseded = input.superseded
        || (parent !== undefined && newerFullSweep(txDb, { id: input.runId, projectId: parent.projectId, createdAt: parent.createdAt }) !== undefined)
      const state = measurementRunSlotState(txDb, input.runId)
      const complete = state.planned && state.readable && state.missing.length === 0 && !state.hasUnboundSnapshot
      let justCompleted = false
      if (complete) {
        justCompleted = txDb.update(runs)
          .set({ status: 'completed', error: null })
          .where(and(eq(runs.id, input.runId), eq(runs.status, 'partial')))
          .run().changes === 1
      } else if (state.readable && !input.fatal) {
        // The run's error names only providers that still have gaps. A
        // provider this fill tried carries its new reason; any other keeps
        // its original entry untouched, raw detail included.
        const previous = parseRunError(parent?.error)?.providers ?? {}
        const fresh = buildRunErrorFromMessages(input.providerErrors).providers ?? {}
        const remaining = new Map<string, number>()
        for (const slot of state.missing) remaining.set(slot.provider, (remaining.get(slot.provider) ?? 0) + 1)
        const providers: Record<string, RunProviderErrorDto> = {}
        for (const [provider, count] of remaining) {
          providers[provider] = fresh[provider] ?? previous[provider] ?? { message: `${count} expected measurement(s) have not run.` }
        }
        txDb.update(runs)
          .set({ error: serializeRunError({ providers }) })
          .where(and(eq(runs.id, input.runId), eq(runs.status, 'partial')))
          .run()
      }

      const status: RunFillStatus = complete ? 'completed' : input.filled > 0 ? 'partial' : 'failed'
      const reason = input.fatal
        ?? (superseded ? 'Stopped because a newer sweep started; no answers were added behind it.' : null)
        ?? (input.providerErrors.size > 0 ? formatRunErrorOneLine(buildRunErrorFromMessages(input.providerErrors)) : null)
      txDb.update(runFills)
        .set({ status, filled: input.filled, error: complete ? null : reason, finishedAt })
        .where(eq(runFills.id, input.fillId))
        .run()
      return { justCompleted, superseded }
    })
  }

  /**
   * The plan-aware unit of work: one execution node, one provider.
   *
   * Deliberately a separate worker from the legacy query-by-query path rather
   * than a generalization of it. The legacy path is the behaviour every
   * planless project already depends on; leaving its body alone is what
   * makes "planless is byte-identical" a fact rather than a hope.
   *
   * Gate, call, then `recordSlot`. A method rather than a closure inside
   * `executeRun` so a sweep and a fill record a slot through the same code: a
   * filled answer is indistinguishable from one the sweep recorded itself,
   * which is what lets it count.
   */
  private async executePlanSlot(
    ctx: PlanSlotContext,
    registeredProvider: RegisteredProvider,
    unit: PlanExecutionUnit,
  ): Promise<void> {
    const { adapter, config: providerConfig } = registeredProvider
    const providerName = adapter.name
    const { domains: competitorDomains } = ctx.competitorsFor(unit.executionId)
    const gate = ctx.executionGates.get(providerName)
    if (!gate) {
      throw new Error(`Missing execution gate for provider ${providerName}`)
    }
    // The manifest froze which model answers this slot. Honouring today's
    // project setting instead would change what a stored row means without
    // anything recording that it moved. A retired id frozen on an immutable
    // revision is sent as the id that answers now, as a batch line is.
    const config = unit.requestedModel
      ? { ...providerConfig, model: resolveProviderModel(providerName, unit.requestedModel) }
      : providerConfig

    // A fill checks before joining the provider's queue: a slot it skips must
    // not take a rate-limit token that this fill, or another run sharing the
    // gate, is waiting on.
    if (ctx.fill?.shouldSkip(providerName, unit.executionId)) return
    try {
      await gate.run(async () => {
        this.throwIfRunCancelled(ctx.runId)
        // A fill checks again once its turn comes, before paying for the call:
        // another writer may have recorded the slot, its breaker may have
        // stopped this provider, or a newer sweep may have started meanwhile.
        if (ctx.fill?.shouldSkip(providerName, unit.executionId)) return
        ctx.providerDispatchCounts.set(providerName, (ctx.providerDispatchCounts.get(providerName) ?? 0) + 1)

        const raw = await adapter.executeTrackedQuery(
          {
            query: unit.queryText,
            canonicalDomains: ctx.allDomains,
            competitorDomains,
            location: unit.context ?? undefined,
          },
          config,
        )

        // Recorded inside the gate: resolving cited URLs is part of the slot's
        // turn, so the provider's concurrency bounds it too.
        await this.recordSlot(ctx, registeredProvider, unit, raw, SYNC_SLOT_DISPATCH)
      })
    } catch (err: unknown) {
      if (err instanceof RunCancelledError) {
        throw err
      }

      const msg = describeError(err)
      const stack = err instanceof Error ? err.stack : undefined
      log.error('query.failed', { runId: ctx.runId, provider: providerName, query: unit.queryText, executionId: unit.executionId, error: msg, stack })
      if (!ctx.providerErrors.has(providerName)) {
        ctx.providerErrors.set(providerName, msg)
      }
      ctx.fill?.onOutcome(providerName, false)
    }
  }

  /**
   * Record one provider answer into its plan slot: everything after the call.
   *
   * The single writer of plan answers, whatever produced the answer, so a row
   * means the same thing on every path. Throws `RunCancelledError` when the
   * run was cancelled before the row is written, and lets any other failure
   * propagate for the caller to charge to the provider. Resolves to whether
   * this call wrote the row: an idempotent insert that finds the slot taken
   * writes nothing and resolves false.
   */
  private async recordSlot(
    ctx: SlotRecordingContext,
    registeredProvider: RegisteredProvider,
    unit: PlanExecutionUnit,
    raw: RawQueryResult,
    dispatch: SlotDispatch,
  ): Promise<boolean> {
    const { adapter } = registeredProvider
    const providerName = adapter.name
    const { domains: competitorDomains, aliases: competitorAliases } = ctx.competitorsFor(unit.executionId)
    const requestedContext = unit.context
    // Only a provider that actually forwards the location may say the
    // answer was measured from there. Everything else stores null, which
    // reads as "no claim" rather than as the place we asked for.
    const supportedContext = requestedContext && providerSupportsLocationContext(adapter)
      ? { status: 'applied' as const, resolved: requestedContext }
      : null

    this.throwIfRunCancelled(ctx.runId)

    const providerResult = adapter.normalizeResult(raw)
    const rawGroundingSources = providerResult.groundingSources
    const normalized = {
      ...providerResult,
      groundingSources: Array.isArray(rawGroundingSources) ? rawGroundingSources : [],
    }
    let citedUrlCapture: CitedUrlCapture
    try {
      citedUrlCapture = await captureCitedUrls(providerName, rawGroundingSources)
    } catch (err: unknown) {
      citedUrlCapture = {
        citedUrls: [],
        captureStatus: 'failed',
        sourceCount: normalized.groundingSources.length,
        resolvedCount: 0,
        captureVersion: CITED_URL_CAPTURE_VERSION,
      }
      log.warn('query.cited-url-capture-failed', {
        runId: ctx.runId,
        provider: providerName,
        query: unit.queryText,
        error: describeError(err),
      })
    }
    this.throwIfRunCancelled(ctx.runId)

    const citationState = determineCitationState(normalized, ctx.allDomains)
    const answerMentioned = determineAnswerMentioned(
      normalized.answerText,
      ctx.allBrandNames,
      ctx.allDomains,
    )
    const overlap = computeCompetitorOverlap(normalized, competitorDomains, competitorAliases)
    const extractedCompetitors = extractRecommendedCompetitors(
      normalized.answerText,
      ctx.allDomains,
      normalized.citedDomains,
      competitorDomains,
      ctx.allBrandNames,
      competitorAliases,
    )

    const snapshotId = crypto.randomUUID()
    let screenshotRelPath: string | null = null
    if (raw.screenshotPath && fs.existsSync(raw.screenshotPath)) {
      const screenshotDir = path.join(os.homedir(), '.canonry', 'screenshots', ctx.runId)
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true })
      const destPath = path.join(screenshotDir, `${snapshotId}.png`)
      fs.renameSync(raw.screenshotPath, destPath)
      screenshotRelPath = `${ctx.runId}/${snapshotId}.png`
    }

    const insert = this.db.insert(querySnapshots).values({
      id: snapshotId,
      runId: ctx.runId,
      queryId: unit.queryId,
      queryText: unit.queryText,
      provider: providerName,
      // `model` is what was REQUESTED and `served_model` is what
      // answered. The manifest froze the request, so it is the
      // authority here: an adapter that reports its own default rather
      // than what it was handed would otherwise overwrite the identity
      // the revision recorded, and nothing would show that it moved.
      model: unit.requestedModel ?? raw.model,
      servedModel: raw.servedModel ?? null,
      citationState,
      answerMentioned,
      answerText: normalized.answerText,
      citedDomains: normalized.citedDomains,
      citedUrls: citedUrlCapture.citedUrls,
      captureStatus: citedUrlCapture.captureStatus,
      sourceCount: citedUrlCapture.sourceCount,
      resolvedCount: citedUrlCapture.resolvedCount,
      captureVersion: citedUrlCapture.captureVersion,
      retrievalStatus: normalized.retrievalStatus,
      retrievalContract: raw.retrievalContract,
      competitorOverlap: overlap,
      recommendedCompetitors: extractedCompetitors,
      // Only claim the geography the provider actually honoured. A
      // requested-but-unsupported context stores `location: null` —
      // "no claim" — rather than the label we asked for, mirroring
      // `supportedContext` itself: this field is never non-null when
      // that one is null.
      location: supportedContext ? requestedContext?.label ?? null : null,
      measurementExecutionId: unit.executionId,
      requestedContext,
      supportedContext,
      screenshotPath: screenshotRelPath,
      rawResponse: JSON.stringify({
        model: raw.model,
        servedModel: raw.servedModel ?? null,
        groundingSources: normalized.groundingSources,
        searchQueries: normalized.searchQueries,
        apiResponse: raw.rawResponse,
      }),
      dispatchMode: dispatch.mode,
      providerBatchId: dispatch.providerBatchId,
      stopReason: raw.stopReason ?? null,
      // Priced by the engine that answered: the id `model` stores, resolved
      // when a revision froze one the provider has since retired.
      usage: buildSnapshotUsage(raw.usage, {
        provider: providerName,
        model: resolveProviderModel(providerName, unit.requestedModel ?? raw.model),
        tier: dispatch.pricingTier,
        overrides: registeredProvider.config.pricing,
      }),
      createdAt: new Date().toISOString(),
    })
    // A fill never overwrites or duplicates a recorded slot: the slot index
    // decides, and a lost race records nothing rather than failing.
    const written = ctx.fill || dispatch.idempotent ? insert.onConflictDoNothing().run() : insert.run()
    if (written.changes > 0) ctx.onInserted()
    ctx.fill?.onOutcome(providerName, true)
    log.info('query.citation', {
      runId: ctx.runId,
      provider: providerName,
      query: unit.queryText,
      executionId: unit.executionId,
      location: requestedContext?.label ?? null,
      citationState,
      answerMentioned,
    })
    return written.changes > 0
  }

  /**
   * Rebuild a run's recording identity from the database, for a path that
   * records into a run after the sweep that started it. It reads the rows the
   * sweep read, the same way, so it matches what the sweep matched unless the
   * project's identity or competitor list changed in between.
   */
  private buildRunRecordingContext(runId: string, projectId: string): RunRecordingContext {
    const run = this.db
      .select({ measurementPlanVersionId: runs.measurementPlanVersionId })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)))
      .get()
    if (!run) throw new Error(`Run ${runId} not found`)
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error(`Project ${projectId} not found`)
    const projectCompetitors = this.db.select().from(competitors).where(eq(competitors.projectId, projectId)).all()
    return runRecordingContext(this.db, {
      runId,
      measurementPlanVersionId: run.measurementPlanVersionId,
      project,
      competitorDomains: projectCompetitors.map(c => c.domain),
    })
  }

  private incrementUsage(scope: string, metric: string, count: number): void {
    const now = new Date().toISOString()
    const period = now.slice(0, 10)

    this.db.insert(usageCounters).values({
      id: crypto.randomUUID(),
      scope,
      period,
      metric,
      count,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
      set: { count: sql`${usageCounters.count} + ${count}`, updatedAt: now },
    }).run()
  }

  private flushProviderUsage(
    providerDispatchCounts: ReadonlyMap<ProviderName, number>,
    providerReservations: Map<ProviderName, { scope: string; period: string; reserved: number }>,
  ): void {
    for (const [providerName, reservation] of providerReservations.entries()) {
      const dispatched = providerDispatchCounts.get(providerName) ?? 0
      releaseDailyQueryQuota(this.db, { scope: reservation.scope, period: reservation.period, count: Math.max(0, reservation.reserved - dispatched) })
    }
    providerReservations.clear()
  }

  private hasPriorActivation(projectId: string, currentRunId: string): boolean {
    return this.db
      .select({ id: querySnapshots.id })
      .from(querySnapshots)
      .innerJoin(runs, eq(querySnapshots.runId, runs.id))
      .where(and(
        eq(runs.projectId, projectId),
        eq(runs.kind, 'answer-visibility'),
        inArray(runs.status, ['completed', 'partial']),
        ne(runs.trigger, 'probe'),
        ne(runs.id, currentRunId),
      ))
      .limit(1)
      .get() !== undefined
  }

  private getRunState(runId: string): RunState | undefined {
    return this.db
      .select({
        kind: runs.kind,
        status: runs.status,
        finishedAt: runs.finishedAt,
        error: runs.error,
        trigger: runs.trigger,
        queries: runs.queries,
        measurementPlanVersionId: runs.measurementPlanVersionId,
        measurementManifest: runs.measurementManifest,
        providerDispatchModes: runs.providerDispatchModes,
        pendingProviderErrors: runs.pendingProviderErrors,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()
  }

  private isRunCancelled(runId: string): boolean {
    // Status only. This runs before and after every provider call, and
    // `getRunState` now also reads the run's measurement manifest — decoding
    // that JSON a few times per query to answer a yes/no question would be
    // pure waste.
    return this.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()?.status === 'cancelled'
  }

  private throwIfRunCancelled(runId: string): void {
    if (this.isRunCancelled(runId)) {
      throw new RunCancelledError(runId)
    }
  }

  private handleCancelledRun(
    runId: string,
    projectId: string,
    startTime: number,
    context: RunExecutionContext,
  ): void {
    const currentRun = this.getRunState(runId)
    if (currentRun && !currentRun.finishedAt) {
      this.db
        .update(runs)
        .set({
          finishedAt: new Date().toISOString(),
          error: currentRun.error ?? 'Cancelled by user',
        })
        .where(eq(runs.id, runId))
        .run()
    }

    trackEvent(
      'run.completed',
      buildRunCompletedProps({
        status: 'cancelled',
        providerCount: context.providerCount,
        providers: context.providers,
        queryCount: context.queryCount,
        startTime,
        trigger: context.trigger,
        canonicalDomain: context.canonicalDomain,
        location: context.location,
      }),
      { errorCode: 'RUN_CANCELLED' },
    )

    if (this.onRunCompleted) {
      this.onRunCompleted(runId, projectId).catch((err: unknown) => {
        log.error('notification.callback-failed', { runId, error: describeError(err) })
      })
    }
  }
}


function buildPhases(input: {
  startTime: number
  providerCallStart: number | undefined
  providerCallEnd: number | undefined
}): RunPhaseTimings | undefined {
  const total_ms = Date.now() - input.startTime
  // Pre-provider failures (missing project, no providers, quota) never reach
  // the provider-call section, so report only total_ms in that case rather
  // than emit zeros that would skew percentile dashboards.
  if (input.providerCallStart === undefined) {
    return { setup_ms: total_ms, provider_call_ms: 0, total_ms }
  }
  const setup_ms = input.providerCallStart - input.startTime
  const provider_call_ms = (input.providerCallEnd ?? Date.now()) - input.providerCallStart
  return { setup_ms, provider_call_ms, total_ms }
}

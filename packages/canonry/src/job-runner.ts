import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { parseJsonColumn, runFills, runs, queries, competitors, projects, querySnapshots, siteCrawlAttempts, usageCounters } from '@ainyc/canonry-db'
import type { ProviderErrorCode, ProviderName, LocationContext, MeasurementRunManifestV1, RunCompletionOrigin, RunFillStatus, RunProviderErrorDto } from '@ainyc/canonry-contracts'
import { RUN_FILL_PROVIDER_BREAKER, formatRunErrorOneLine, parseRunError } from '@ainyc/canonry-contracts'
import { CITED_URL_CAPTURE_VERSION, ONBOARDING_FLOW_VERSION, RunKinds, RunTriggers, brandLabelFromDomain, bucketOnboardingCount, buildSimpleMeasurementDefinition, classifyProviderErrorMessages, buildRunErrorFromMessages, determineAnswerMentioned, effectiveBrandNames, effectiveDomains, isBrowserProvider, normalizeMeasurementExecutionQueryText, parseMeasurementRunManifestV1, providerSupportsLocationContext, serializeRunError, describeError } from '@ainyc/canonry-contracts'
import { captureSimpleMeasurementDefinition, createRunCompetitorResolver, measurementRunSlotState, measurementSlotKey, newerFullSweep, type RunCompetitors } from '@ainyc/canonry-api-routes'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { trackEvent } from './telemetry.js'
import { buildRunCompletedProps, buildSiteAuditCompletedProps, hashDomain, type RunPhaseTimings } from './run-telemetry.js'
import { createLogger } from './logger.js'
import { ProviderExecutionGate, getSharedProviderExecutionGate } from './provider-execution-gate.js'
import { getCurrentUsageDay, releaseDailyQueryQuota, reserveDailyQueryQuota } from './usage-quota.js'
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

/** What `executePlanSlot` needs from the run it is recording into. */
interface PlanSlotContext {
  runId: string
  allDomains: string[]
  /**
   * The competitors one answer is scored against: the project list plus the
   * plan pins of the groups whose properties use that question.
   */
  competitorsFor: (executionId: string) => RunCompetitors
  allBrandNames: string[]
  executionGates: ReadonlyMap<ProviderName, ProviderExecutionGate>
  providerDispatchCounts: Map<ProviderName, number>
  providerErrors: Map<ProviderName, string>
  onInserted: () => void
  /** Present only when completing a partial run in place. */
  fill?: {
    shouldSkip: (provider: ProviderName, executionId: string) => boolean
    onOutcome: (provider: ProviderName, ok: boolean) => void
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

  constructor(
    db: DatabaseClient,
    registry: ProviderRegistry,
    opts?: { onFirstActivation?: () => void },
  ) {
    this.onFirstActivation = opts?.onFirstActivation
    this.db = db
    this.registry = registry
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

    try {
      const existingRun = this.getRunState(runId)
      if (!existingRun) {
        throw new Error(`Run ${runId} not found`)
      }
      runTrigger = existingRun.trigger ?? undefined
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
          const model = project.providerModels[entry.adapter.name]
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
      const resolveCompetitors = createRunCompetitorResolver(this.db, competitorDomains)
      const competitorsFor = (executionId: string): RunCompetitors =>
        resolveCompetitors(existingRun.measurementPlanVersionId, executionId)
      const allDomains = effectiveDomains({
        canonicalDomain: project.canonicalDomain,
        ownedDomains: project.ownedDomains,
      })
      const allBrandNames = effectiveBrandNames({
        displayName: project.displayName,
        aliases: project.aliases,
      })
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
        runId,
        allDomains,
        competitorsFor,
        allBrandNames,
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
        const unitsFor = (provider: RegisteredProvider): PlanExecutionUnit[] =>
          plan.unitsByProvider.get(provider.adapter.name.trim().toLocaleLowerCase('en')) ?? []
        log.info('run.plan-dispatch', {
          runId,
          expectedSlots: plan.manifest.expectedSlots.length,
          executionNodes: plan.nodeCount,
          providers: [...plan.unitsByProvider.keys()],
        })
        await runWithConcurrency(apiProviders, resolveProviderFanout(), async (registeredProvider) => {
          await Promise.all(unitsFor(registeredProvider).map(async (unit) => {
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

      // Determine final run status
      const allFailed = totalSnapshotsInserted === 0 && (providerErrors.size > 0 || planShortfall > 0)
      const someFailed = providerErrors.size > 0 || planShortfall > 0

      if (allFailed) {
        const errorDetail = serializeRunError(buildRunErrorFromMessages(providerErrors))
        this.db
          .update(runs)
          .set({ status: 'failed', finishedAt: new Date().toISOString(), error: errorDetail })
          .where(eq(runs.id, runId))
          .run()
      } else if (someFailed) {
        const errorDetail = serializeRunError(buildRunErrorFromMessages(providerErrors))
        this.db
          .update(runs)
          .set({ status: 'partial', finishedAt: new Date().toISOString(), error: errorDetail })
          .where(eq(runs.id, runId))
          .run()
      } else {
        this.db
          .update(runs)
          .set({ status: 'completed', finishedAt: new Date().toISOString() })
          .where(eq(runs.id, runId))
          .run()
      }

      this.flushProviderUsage(providerDispatchCounts, providerReservations)

      // Track run completion telemetry. When providers actually ran but some
      // failed, emit an `errorCode` so dashboards can break down real failures
      // by category (auth, rate-limit, network, parse, …) instead of lumping
      // them all into "failed."
      const finalStatus = allFailed ? 'failed' : someFailed ? 'partial' : 'completed'
      const failureCode = providerErrors.size > 0
        ? classifyProviderErrors(providerErrors)
        : undefined
      const phases = buildPhases({ startTime, providerCallStart, providerCallEnd })
      trackEvent(
        'run.completed',
        buildRunCompletedProps({
          status: finalStatus,
          providerCount: executionContext.providerCount,
          providers: executionContext.providers,
          queryCount: executionContext.queryCount,
          startTime,
          trigger: executionContext.trigger,
          canonicalDomain: executionContext.canonicalDomain,
          phases,
          location: executionContext.location,
        }),
        failureCode ? { errorCode: failureCode } : undefined,
      )

      // Activation is a non-empty first answer-visibility result, not merely a
      // run row reaching "completed". This excludes probes, zero-query runs,
      // and later routine sweeps so the funnel has one durable success event.
      if (
        existingRun.kind === 'answer-visibility'
        && runTrigger !== 'probe'
        && totalSnapshotsInserted > 0
        && !this.hasPriorActivation(projectId, runId)
      ) {
        trackEvent('activation.completed', {
          flowVersion: ONBOARDING_FLOW_VERSION,
          kind: 'answer_visibility',
          status: finalStatus,
          providerCountBucket: bucketOnboardingCount(executionContext.providerCount),
          queryCountBucket: bucketOnboardingCount(executionContext.queryCount),
          snapshotCountBucket: bucketOnboardingCount(totalSnapshotsInserted),
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
        this.handleCancelledRun(runId, projectId, startTime, executionContext)
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
    }
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
      const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) throw new Error(`Project ${projectId} not found`)
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

      // The same identity the sweep matched against, read the same way.
      const projectCompetitors = this.db.select().from(competitors).where(eq(competitors.projectId, projectId)).all()
      const resolveCompetitors = createRunCompetitorResolver(this.db, projectCompetitors.map(c => c.domain))
      const competitorsFor = (executionId: string): RunCompetitors =>
        resolveCompetitors(run.measurementPlanVersionId, executionId)
      const allDomains = effectiveDomains({ canonicalDomain: project.canonicalDomain, ownedDomains: project.ownedDomains })
      const allBrandNames = effectiveBrandNames({ displayName: project.displayName, aliases: project.aliases })

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
        runId,
        allDomains,
        competitorsFor,
        allBrandNames,
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
   * A method rather than a closure inside `executeRun` so a sweep and a fill
   * record a slot through the same code: a filled answer is indistinguishable
   * from one the sweep recorded itself, which is what lets it count.
   */
  private async executePlanSlot(
    ctx: PlanSlotContext,
    registeredProvider: RegisteredProvider,
    unit: PlanExecutionUnit,
  ): Promise<void> {
    const { adapter, config: providerConfig } = registeredProvider
    const providerName = adapter.name
    const { domains: competitorDomains, aliases: competitorAliases } = ctx.competitorsFor(unit.executionId)
    const gate = ctx.executionGates.get(providerName)
    if (!gate) {
      throw new Error(`Missing execution gate for provider ${providerName}`)
    }
    // The manifest froze which model answers this slot. Honouring today's
    // project setting instead would change what a stored row means without
    // anything recording that it moved.
    const config = unit.requestedModel ? { ...providerConfig, model: unit.requestedModel } : providerConfig
    const requestedContext = unit.context
    // Only a provider that actually forwards the location may say the
    // answer was measured from there. Everything else stores null, which
    // reads as "no claim" rather than as the place we asked for.
    const supportedContext = requestedContext && providerSupportsLocationContext(adapter)
      ? { status: 'applied' as const, resolved: requestedContext }
      : null

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
            location: requestedContext ?? undefined,
          },
          config,
        )

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
          createdAt: new Date().toISOString(),
        })
        // A fill never overwrites or duplicates a recorded slot: the slot index
        // decides, and a lost race records nothing rather than failing.
        const written = ctx.fill ? insert.onConflictDoNothing().run() : insert.run()
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

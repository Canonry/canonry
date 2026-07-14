import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, queries, competitors, projects, querySnapshots, usageCounters } from '@ainyc/canonry-db'
import type { ProviderName, LocationContext } from '@ainyc/canonry-contracts'
import { buildRunErrorFromMessages, determineAnswerMentioned, effectiveBrandNames, effectiveDomains, isBrowserProvider, serializeRunError } from '@ainyc/canonry-contracts'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { trackEvent } from './telemetry.js'
import { buildRunCompletedProps, hashDomain, type RunPhaseTimings } from './run-telemetry.js'
import { createLogger } from './logger.js'
import {
  computeCompetitorOverlap,
  determineCitationState,
  extractRecommendedCompetitors,
} from './citation-utils.js'

const log = createLogger('JobRunner')

class RunCancelledError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} was cancelled`)
    this.name = 'RunCancelledError'
  }
}

class ProviderExecutionGate {
  private readonly window: number[] = []
  private readonly waiters: Array<() => void> = []
  private rateLimitChain = Promise.resolve()
  private inFlight = 0

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxPerMinute: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      await this.waitForRateLimit()
      return await task()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < Math.max(1, this.maxConcurrency)) {
      this.inFlight++
      return
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
    this.inFlight++
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    const next = this.waiters.shift()
    next?.()
  }

  private async waitForRateLimit(): Promise<void> {
    let releaseChain: (() => void) | undefined
    const previousChain = this.rateLimitChain
    this.rateLimitChain = new Promise<void>((resolve) => {
      releaseChain = resolve
    })

    await previousChain
    try {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.window.length > 0 && this.window[0]! < windowStart) {
        this.window.shift()
      }

      if (this.window.length >= this.maxPerMinute) {
        const oldestInWindow = this.window[0]!
        const waitMs = oldestInWindow + 60_000 - now + 50
        await new Promise(resolve => setTimeout(resolve, waitMs))
        const nowAfterWait = Date.now()
        const newWindowStart = nowAfterWait - 60_000
        while (this.window.length > 0 && this.window[0]! < newWindowStart) {
          this.window.shift()
        }
      }

      this.window.push(Date.now())
    } finally {
      releaseChain?.()
    }
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
type ProviderErrorCode =
  | 'PROVIDER_AUTH'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'UNKNOWN'

function classifyProviderErrors(
  errors: ReadonlyMap<ProviderName, string>,
): ProviderErrorCode {
  // If every provider failed with the same category, report it. Otherwise
  // report the most-severe-looking one with a documented priority order.
  const codes = new Set<ProviderErrorCode>()
  for (const message of errors.values()) {
    codes.add(classifyOneProviderError(message))
  }
  const priority: ProviderErrorCode[] = [
    'PROVIDER_AUTH',
    'RATE_LIMITED',
    'TIMEOUT',
    'NETWORK',
    'PARSE_ERROR',
    'UNKNOWN',
  ]
  for (const code of priority) {
    if (codes.has(code)) return code
  }
  return 'UNKNOWN'
}

function classifyOneProviderError(message: string): ProviderErrorCode {
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|missing[_ -]?api[_ -]?key|authentication/i.test(message)) {
    return 'PROVIDER_AUTH'
  }
  if (/\b429\b|rate[_ -]?limit|too many requests|quota[_ -]?exceeded/i.test(message)) {
    return 'RATE_LIMITED'
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'TIMEOUT'
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(message)) {
    return 'NETWORK'
  }
  if (/parse|unexpected token|invalid json|malformed|JSON\.parse/i.test(message)) {
    return 'PARSE_ERROR'
  }
  return 'UNKNOWN'
}

export class JobRunner {
  private db: DatabaseClient
  private registry: ProviderRegistry
  onRunCompleted?: (runId: string, projectId: string) => Promise<void>

  constructor(db: DatabaseClient, registry: ProviderRegistry) {
    this.db = db
    this.registry = registry
  }

  recoverStaleRuns(): void {
    const stale = this.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, ['running', 'queued']))
      .all()

    if (stale.length === 0) return

    const now = new Date().toISOString()
    for (const run of stale) {
      this.db
        .update(runs)
        .set({ status: 'failed', finishedAt: now, error: 'Server restarted while run was in progress' })
        .where(eq(runs.id, run.id))
        .run()
      log.warn('run.recovered-stale', { runId: run.id, previousStatus: run.status })
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
    let runTrigger: string | undefined
    let canonicalDomain: string | undefined
    const providerDispatchCounts = new Map<ProviderName, number>()

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

      // Resolve which providers to use — honour per-run override, then project config
      const projectProviders = providerOverride ?? (project.providers as ProviderName[])
      activeProviders = this.registry.getForProject(projectProviders).map((entry) => {
        const model = project.providerModels[entry.adapter.name]
        // Clone the registration instead of mutating the shared registry: two
        // projects can run different models through the same provider process.
        return model === undefined
          ? entry
          : { ...entry, config: { ...entry.config, model } }
      })

      if (activeProviders.length === 0) {
        throw new Error('No providers configured. Add at least one provider API key.')
      }

      log.info('run.dispatch', { runId, providerCount: activeProviders.length, providers: activeProviders.map(p => p.adapter.name) })

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

      // Fetch competitors for the project
      const projectCompetitors = this.db
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, projectId))
        .all()

      const competitorDomains = projectCompetitors.map(c => c.domain)
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
        queryCount: projectQueries.length,
        ...(runLocation ? { location: runLocation.label } : {}),
        ...(runTrigger ? { trigger: runTrigger } : {}),
        ...(canonicalDomain ? { canonicalDomain } : {}),
      }

      // Enforce daily quota per provider — each provider receives one request per query.
      // Track and check usage per (projectId, providerName) so that a provider that has
      // never been used isn't blocked by another provider's past usage.
      const queriesPerProvider = projectQueries.length
      const todayPeriod = getCurrentUsageDay()

      for (const p of activeProviders) {
        const providerScope = `${projectId}:${p.adapter.name}`
        const providerUsage = this.db
          .select()
          .from(usageCounters)
          .where(eq(usageCounters.scope, providerScope))
          .all()
          .filter(r => r.period === todayPeriod && r.metric === 'queries')
          .reduce((sum, r) => sum + r.count, 0)
        const limit = p.config.quotaPolicy.maxRequestsPerDay
        if (providerUsage + queriesPerProvider > limit) {
          throw new Error(
            `Daily quota exceeded for ${p.adapter.name}: ${providerUsage} queries used today, ` +
            `limit is ${limit}. This run needs ${queriesPerProvider} more.`,
          )
        }
      }

      const executionGates = new Map<ProviderName, ProviderExecutionGate>()
      for (const provider of activeProviders) {
        executionGates.set(
          provider.adapter.name,
          new ProviderExecutionGate(
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

            const normalized = adapter.normalizeResult(raw)

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
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: normalized.citedDomains,
                competitorOverlap: overlap,
                recommendedCompetitors: extractedCompetitors,
                location: runLocation?.label ?? null,
                screenshotPath: screenshotRelPath,
                rawResponse: JSON.stringify({
                  model: raw.model,
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
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: normalized.citedDomains,
                competitorOverlap: overlap,
                recommendedCompetitors: extractedCompetitors,
                location: runLocation?.label ?? null,
                rawResponse: JSON.stringify({
                  model: raw.model,
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

          const msg = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          log.error('query.failed', { runId, provider: providerName, query: q.query, error: msg, stack })
          if (!providerErrors.has(providerName)) {
            providerErrors.set(providerName, msg)
          }
        }
      }

      providerCallStart = Date.now()
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
      providerCallEnd = Date.now()

      this.throwIfRunCancelled(runId)

      // Determine final run status
      const allFailed = totalSnapshotsInserted === 0 && providerErrors.size > 0
      const someFailed = providerErrors.size > 0

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

      this.flushProviderUsage(projectId, providerDispatchCounts)

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

      this.incrementUsage(projectId, 'runs', 1)

      // Notify after run completion
      if (this.onRunCompleted) {
        this.onRunCompleted(runId, projectId).catch((err: unknown) => {
          log.error('notification.callback-failed', { runId, error: err instanceof Error ? err.message : String(err) })
        })
      }
    } catch (err: unknown) {
      const executionContext: RunExecutionContext = {
        providerCount: activeProviders.length,
        providers: activeProviders.map(provider => provider.adapter.name),
        queryCount: projectQueries.length,
        ...(runLocation ? { location: runLocation.label } : {}),
        ...(runTrigger ? { trigger: runTrigger } : {}),
        ...(canonicalDomain ? { canonicalDomain } : {}),
      }

      if (err instanceof RunCancelledError || this.isRunCancelled(runId)) {
        this.flushProviderUsage(projectId, providerDispatchCounts)
        this.handleCancelledRun(runId, projectId, startTime, executionContext)
        return
      }

      // Mark run as failed
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.db
        .update(runs)
        .set({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: errorMessage,
        })
        .where(eq(runs.id, runId))
        .run()

      this.flushProviderUsage(projectId, providerDispatchCounts)

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
          log.error('notification.callback-failed', { runId, error: notifErr instanceof Error ? notifErr.message : String(notifErr) })
        })
      }
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

  private flushProviderUsage(projectId: string, providerDispatchCounts: ReadonlyMap<ProviderName, number>): void {
    for (const [providerName, count] of providerDispatchCounts.entries()) {
      if (count <= 0) continue
      this.incrementUsage(`${projectId}:${providerName}`, 'queries', count)
    }
  }

  private getRunState(runId: string): { status: string; finishedAt: string | null; error: string | null; trigger: string; queries: string[] | null } | undefined {
    return this.db
      .select({
        status: runs.status,
        finishedAt: runs.finishedAt,
        error: runs.error,
        trigger: runs.trigger,
        queries: runs.queries,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .get()
  }

  private isRunCancelled(runId: string): boolean {
    return this.getRunState(runId)?.status === 'cancelled'
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
        log.error('notification.callback-failed', { runId, error: err instanceof Error ? err.message : String(err) })
      })
    }
  }
}

function getCurrentUsageDay(): string {
  return new Date().toISOString().slice(0, 10)
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

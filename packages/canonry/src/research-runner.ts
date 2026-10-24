import { and, eq, inArray, sql } from 'drizzle-orm'
import { competitorIdentityColumns } from '@canonry/canonry-api-routes'
import { competitors, projects, researchRunQueries, researchRuns, type DatabaseClient } from '@canonry/canonry-db'
import {
  classifyProviderOutcomeError,
  competitorIdentityAliases,
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  extractRecommendedCompetitors,
  isBrowserProvider,
  mapWithConcurrency,
  OutcomeReasonCodes,
  OutcomeStatuses,
  OutcomeSurfaces,
  OutcomeTriggers,
  PROVIDER_NAMES,
  adapterConnectionName,
  IncompleteAnswerError,
  isCitationMeasurable,
  isEligibleFor,
  providerConnectionName,
  ProviderWorkflows,
  ResearchQueryStatuses,
  ResearchRunStatuses,
  describeError,
  type FeatureCompletedProperties,
  type OutcomeReasonCode,
  type OutcomeTrigger,
} from '@canonry/canonry-contracts'
import { computeCitedCompetitorDomains, determineCitationState } from './citation-utils.js'
import type { ProviderRegistry } from './provider-registry.js'
import { getSharedProviderExecutionGate } from './provider-execution-gate.js'
import { getCurrentUsageDay, releaseDailyQueryQuota, reserveDailyQueryQuota } from './usage-quota.js'
import { currentOutcomeOrigin, outcomeFailure, startOutcomeTimer, trackFeatureCompleted } from './outcome-telemetry.js'

const unfinishedResearchQueryStatuses = [ResearchQueryStatuses.queued, ResearchQueryStatuses.running] as const

/**
 * A run with any query waiting on an upstream job is not finished; otherwise
 * it is completed, partial or failed by its counts. A waiting query counts as
 * neither completed nor failed.
 */
function finalResearchRunStatus(completed: number, failed: number, waiting: number) {
  if (waiting > 0) return ResearchRunStatuses['waiting-upstream']
  if (failed === 0) return ResearchRunStatuses.completed
  return completed > 0 ? ResearchRunStatuses.partial : ResearchRunStatuses.failed
}

/**
 * Execute a saved ad-hoc research batch. Deliberately does not depend on JobRunner or RunCoordinator.
 * `trigger` is what dispatched it: a request, or startup recovery of a batch a restart left queued.
 */
export async function executeResearchRun(
  db: DatabaseClient,
  registry: ProviderRegistry,
  runId: string,
  projectId: string,
  options: { trigger?: OutcomeTrigger } = {},
): Promise<void> {
  const run = db.select().from(researchRuns).where(and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId))).get()
  if (!run || run.status !== ResearchRunStatuses.queued) return
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return
  const provider = registry.get(run.provider)
  const now = new Date().toISOString()
  const claim = db.update(researchRuns)
    .set({ status: ResearchRunStatuses.running, startedAt: now })
    .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, ResearchRunStatuses.queued)))
    .run()
  if (claim.changes !== 1) return

  const elapsed = startOutcomeTimer()
  const requested = currentOutcomeOrigin()
  let reserved = 0
  let dispatched = 0
  let reservation: { scope: string; period: string } | undefined
  let fatalError: string | undefined
  let fatalReason: { reasonCode: OutcomeReasonCode; errorName?: string } | undefined
  let queryFailure: unknown
  const workerPersistenceErrors: string[] = []
  try {
    if (!provider || isBrowserProvider(run.provider)) {
      fatalReason = { reasonCode: OutcomeReasonCodes.NOT_CONNECTED }
      throw new Error('Configured API provider is unavailable.')
    }
    if (!isEligibleFor(provider.adapter, ProviderWorkflows.research, 'explicit')) {
      fatalReason = { reasonCode: OutcomeReasonCodes.NOT_CONNECTED }
      throw new Error(`${provider.adapter.displayName} does not run research queries.`)
    }
    const period = getCurrentUsageDay()
    const scope = `${projectId}:${adapterConnectionName(provider.adapter)}`
    const quota = reserveDailyQueryQuota(db, {
      scope, period, count: run.totalQueries, limit: provider.config.quotaPolicy.maxRequestsPerDay,
    })
    if (!quota.reserved) {
      fatalReason = { reasonCode: OutcomeReasonCodes.QUOTA_EXCEEDED }
      throw new Error(`Daily quota exceeded for ${run.provider}: ${quota.used} queries used today, limit is ${provider.config.quotaPolicy.maxRequestsPerDay}. This batch needs ${run.totalQueries} more.`)
    }
    reserved = run.totalQueries
    reservation = { scope, period }
    const rows = db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, runId)).orderBy(researchRunQueries.position).all()
    const competitorRows = db.select(competitorIdentityColumns).from(competitors).where(eq(competitors.projectId, projectId)).orderBy(competitors.domain).all()
    const competitorDomains = competitorRows.map(row => row.domain)
    // Curated and auto-detected names identify a competitor in the answer the
    // same way a sweep does.
    const competitorAliases = new Map(competitorRows
      .map(row => [row.domain, competitorIdentityAliases(row)] as const)
      .filter(([, aliases]) => aliases.length > 0))
    const domains = effectiveDomains(project)
    const brands = effectiveBrandNames(project)
    const config = { ...provider.config, model: run.resolvedModel }
    // Shared process-wide, one gate per provider name — see NEW-3 in
    // `provider-execution-gate.ts`. A research batch can run concurrently
    // with an answer-visibility sweep or another research batch against the
    // same provider; a gate built fresh here would give this batch its own
    // independent budget against the same upstream key.
    const gate = getSharedProviderExecutionGate(adapterConnectionName(provider.adapter), provider.config.quotaPolicy.maxConcurrency, provider.config.quotaPolicy.maxRequestsPerMinute)

    // The worker absorbs every per-query error. That prevents mapWithConcurrency
    // from fail-fast escaping before the parent can be finalized.
    await mapWithConcurrency(rows, Math.max(1, provider.config.quotaPolicy.maxConcurrency), async (row) => {
      try {
        const startedAt = new Date().toISOString()
        db.update(researchRunQueries).set({ status: ResearchQueryStatuses.running, startedAt })
          .where(and(eq(researchRunQueries.id, row.id), eq(researchRunQueries.status, ResearchQueryStatuses.queued))).run()
        const raw = await gate.run(async () => {
          dispatched++
          return provider.adapter.executeTrackedQuery({ query: row.queryText, canonicalDomains: domains, competitorDomains, ...(run.location ? { location: run.location } : {}) }, config)
        })
        const normalized = provider.adapter.normalizeResult(raw)
        const namedCompetitors = extractRecommendedCompetitors(
          normalized.answerText,
          domains,
          normalized.citedDomains,
          competitorDomains,
          brands,
          competitorAliases,
        )
        const citedCompetitorDomains = computeCitedCompetitorDomains(normalized.citedDomains, competitorDomains)
        const completed = db.update(researchRunQueries).set({
          status: ResearchQueryStatuses.completed, servedModel: raw.servedModel ?? null,
          answerText: normalized.answerText, groundingSources: normalized.groundingSources,
          citedDomains: normalized.citedDomains, searchQueries: normalized.searchQueries, retrievedSources: normalized.retrievedSources ?? null,
          namedCompetitors, citedCompetitorDomains,
          answerMentioned: determineAnswerMentioned(normalized.answerText, brands, domains),
          // Sources the answer is not tied to cannot say whether a domain was cited.
          citationState: isCitationMeasurable(normalized) ? determineCitationState(normalized, domains) : null,
          rawResponse: raw.rawResponse as Record<string, unknown>,
          answerEvidence: raw.evidence ?? null,
          finishedAt: new Date().toISOString(),
        }).where(and(eq(researchRunQueries.id, row.id), eq(researchRunQueries.status, ResearchQueryStatuses.running))).run()
        if (completed.changes === 1) incrementResearchProgress(db, runId, 'completedQueries')
      } catch (error) {
        // A query waiting on an upstream job has not failed.
        if (!(error instanceof IncompleteAnswerError && error.resumable)) queryFailure ??= error
        // A DB write can fail independently of the provider call. Never let
        // that make mapWithConcurrency fail-fast; after every worker settles,
        // the finally block terminalizes anything left unfinished.
        try {
          markResearchQueryFailed(db, runId, row.id, error)
        } catch (persistenceError) {
          workerPersistenceErrors.push(describeError(persistenceError))
        }
      }
    })
    if (workerPersistenceErrors.length > 0) {
      fatalError = `Failed to persist one or more research query results: ${workerPersistenceErrors[0]}`
      fatalReason = { reasonCode: OutcomeReasonCodes.INTERNAL }
    }
  } catch (error) {
    fatalError = describeError(error)
    fatalReason ??= outcomeFailure(error)
  } finally {
    // A failure before or between worker writes must still leave this batch in a
    // terminal state. Mark only unfinished children so completed evidence stays intact.
    if (fatalError) markUnfinishedResearchQueriesFailed(db, runId, fatalError)
    const final = finalizeResearchRun(db, runId, fatalError)
    if (reservation && reserved > dispatched) {
      releaseDailyQueryQuota(db, { ...reservation, count: reserved - dispatched })
    }
    const telemetryProvider = providerConnectionName(run.provider)
    trackFeatureCompleted({
      feature: 'research',
      operation: 'run',
      status: researchOutcomeStatus(final.status),
      // Batches re-dispatched at boot are the server's own; any other batch reports who asked.
      ...(options.trigger
        ? { trigger: options.trigger, ...(options.trigger === OutcomeTriggers.startup ? { surface: OutcomeSurfaces.system } : {}) }
        : requested ?? { trigger: OutcomeTriggers.manual }),
      ...((PROVIDER_NAMES as readonly string[]).includes(telemetryProvider) ? { provider: telemetryProvider as FeatureCompletedProperties['provider'] } : {}),
      ...(final.status === ResearchRunStatuses.completed ? {} : fatalReason ?? classifyProviderOutcomeError(queryFailure)),
      durationBucket: elapsed(),
      counts: { queries: final.total, snapshots: final.completed, failures: final.failed },
    })
  }
}

function researchOutcomeStatus(status: ReturnType<typeof finalResearchRunStatus>): FeatureCompletedProperties['status'] {
  switch (status) {
    case ResearchRunStatuses.completed:
      return OutcomeStatuses.succeeded
    // Everything this dispatch could finish is in; the rest waits on upstream jobs.
    case ResearchRunStatuses.partial:
    case ResearchRunStatuses['waiting-upstream']:
      return OutcomeStatuses.partial
    case ResearchRunStatuses.failed:
      return OutcomeStatuses.failed
  }
}

function incrementResearchProgress(db: DatabaseClient, runId: string, column: 'completedQueries' | 'failedQueries'): void {
  db.update(researchRuns).set({ [column]: sql`${researchRuns[column]} + 1` })
    .where(eq(researchRuns.id, runId)).run()
}

/**
 * A query that did not return a complete answer. An incomplete upstream
 * answer (partial, failed, pending) keeps its evidence and any partial text
 * for inspection; its metrics stay null, so it never counts as a measured
 * answer.
 *
 * A pending job the adapter can follow later (`resumable`) waits upstream: the
 * query is `waiting-upstream` with its job id, counts as neither completed nor
 * failed, has no finish time, and a job executor resumes it from that id
 * without submitting it again. Any other pending handle cannot be followed,
 * so the query fails and the id stays in its evidence.
 */
function markResearchQueryFailed(db: DatabaseClient, runId: string, queryId: string, error: unknown): void {
  const message = describeError(error)
  const unfinished = and(eq(researchRunQueries.id, queryId), inArray(researchRunQueries.status, unfinishedResearchQueryStatuses))
  if (error instanceof IncompleteAnswerError && error.resumable) {
    db.update(researchRunQueries).set({
      status: ResearchQueryStatuses['waiting-upstream'],
      upstreamJobId: error.evidence.completion.upstreamJobId,
      answerEvidence: error.evidence,
      searchQueries: error.evidence.searchQueries,
      error: null,
    }).where(unfinished).run()
    return
  }
  const incomplete = error instanceof IncompleteAnswerError
    ? { answerEvidence: error.evidence, answerText: error.answerText, rawResponse: error.rawResponse, searchQueries: error.evidence.searchQueries }
    : {}
  const failed = db.update(researchRunQueries).set({ status: ResearchQueryStatuses.failed, error: message, ...incomplete, finishedAt: new Date().toISOString() })
    .where(unfinished).run()
  if (failed.changes === 1) incrementResearchProgress(db, runId, 'failedQueries')
}

function markUnfinishedResearchQueriesFailed(db: DatabaseClient, runId: string, error: string): void {
  db.update(researchRunQueries).set({ status: ResearchQueryStatuses.failed, error, finishedAt: new Date().toISOString() })
    .where(and(eq(researchRunQueries.researchRunId, runId), inArray(researchRunQueries.status, unfinishedResearchQueryStatuses))).run()
}

function finalizeResearchRun(db: DatabaseClient, runId: string, fatalError?: string) {
  const rows = db.select({ status: researchRunQueries.status }).from(researchRunQueries)
    .where(eq(researchRunQueries.researchRunId, runId)).all()
  const completed = rows.filter(row => row.status === ResearchQueryStatuses.completed).length
  const failed = rows.filter(row => row.status === ResearchQueryStatuses.failed).length
  const waiting = rows.filter(row => row.status === ResearchQueryStatuses['waiting-upstream']).length
  const status = finalResearchRunStatus(completed, failed, waiting)
  db.update(researchRuns).set({
    status, completedQueries: completed, failedQueries: failed,
    error: fatalError ?? (failed === rows.length ? 'Every research query failed.' : null),
    // A run waiting on upstream jobs has not finished.
    finishedAt: waiting > 0 ? null : new Date().toISOString(),
  }).where(eq(researchRuns.id, runId)).run()
  return { status, total: rows.length, completed, failed }
}

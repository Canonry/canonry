import { and, eq, inArray, sql } from 'drizzle-orm'
import { competitors, projects, researchRunQueries, researchRuns, type DatabaseClient } from '@ainyc/canonry-db'
import {
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  isBrowserProvider,
  mapWithConcurrency,
  ResearchQueryStatuses,
  ResearchRunStatuses,
} from '@ainyc/canonry-contracts'
import { determineCitationState } from './citation-utils.js'
import type { ProviderRegistry } from './provider-registry.js'
import { ProviderExecutionGate } from './provider-execution-gate.js'
import { getCurrentUsageDay, releaseDailyQueryQuota, reserveDailyQueryQuota } from './usage-quota.js'

const unfinishedResearchQueryStatuses = [ResearchQueryStatuses.queued, ResearchQueryStatuses.running] as const

function finalResearchRunStatus(completed: number, failed: number) {
  if (failed === 0) return ResearchRunStatuses.completed
  return completed > 0 ? ResearchRunStatuses.partial : ResearchRunStatuses.failed
}

/** Execute a saved ad-hoc research batch. Deliberately does not depend on JobRunner or RunCoordinator. */
export async function executeResearchRun(db: DatabaseClient, registry: ProviderRegistry, runId: string, projectId: string): Promise<void> {
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

  let reserved = 0
  let dispatched = 0
  let reservation: { scope: string; period: string } | undefined
  let fatalError: string | undefined
  const workerPersistenceErrors: string[] = []
  try {
    if (!provider || isBrowserProvider(run.provider)) {
      throw new Error('Configured API provider is unavailable.')
    }
    const period = getCurrentUsageDay()
    const scope = `${projectId}:${run.provider}`
    const quota = reserveDailyQueryQuota(db, {
      scope, period, count: run.totalQueries, limit: provider.config.quotaPolicy.maxRequestsPerDay,
    })
    if (!quota.reserved) {
      throw new Error(`Daily quota exceeded for ${run.provider}: ${quota.used} queries used today, limit is ${provider.config.quotaPolicy.maxRequestsPerDay}. This batch needs ${run.totalQueries} more.`)
    }
    reserved = run.totalQueries
    reservation = { scope, period }
    const rows = db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, runId)).orderBy(researchRunQueries.position).all()
    const competitorDomains = db.select({ domain: competitors.domain }).from(competitors).where(eq(competitors.projectId, projectId)).all().map(row => row.domain)
    const domains = effectiveDomains(project)
    const brands = effectiveBrandNames(project)
    const config = { ...provider.config, model: run.resolvedModel }
    const gate = new ProviderExecutionGate(provider.config.quotaPolicy.maxConcurrency, provider.config.quotaPolicy.maxRequestsPerMinute)

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
        const completed = db.update(researchRunQueries).set({
          status: ResearchQueryStatuses.completed, servedModel: raw.servedModel ?? null,
          answerText: normalized.answerText, groundingSources: normalized.groundingSources,
          citedDomains: normalized.citedDomains, searchQueries: normalized.searchQueries,
          answerMentioned: determineAnswerMentioned(normalized.answerText, brands, domains),
          citationState: determineCitationState(normalized, domains), rawResponse: raw.rawResponse as Record<string, unknown>,
          finishedAt: new Date().toISOString(),
        }).where(and(eq(researchRunQueries.id, row.id), eq(researchRunQueries.status, ResearchQueryStatuses.running))).run()
        if (completed.changes === 1) incrementResearchProgress(db, runId, 'completedQueries')
      } catch (error) {
        // A DB write can fail independently of the provider call. Never let
        // that make mapWithConcurrency fail-fast; after every worker settles,
        // the finally block terminalizes anything left unfinished.
        try {
          markResearchQueryFailed(db, runId, row.id, error)
        } catch (persistenceError) {
          workerPersistenceErrors.push(persistenceError instanceof Error ? persistenceError.message : String(persistenceError))
        }
      }
    })
    if (workerPersistenceErrors.length > 0) {
      fatalError = `Failed to persist one or more research query results: ${workerPersistenceErrors[0]}`
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error)
  } finally {
    // A failure before or between worker writes must still leave this batch in a
    // terminal state. Mark only unfinished children so completed evidence stays intact.
    if (fatalError) markUnfinishedResearchQueriesFailed(db, runId, fatalError)
    finalizeResearchRun(db, runId, fatalError)
    if (reservation && reserved > dispatched) {
      releaseDailyQueryQuota(db, { ...reservation, count: reserved - dispatched })
    }
  }
}

function incrementResearchProgress(db: DatabaseClient, runId: string, column: 'completedQueries' | 'failedQueries'): void {
  db.update(researchRuns).set({ [column]: sql`${researchRuns[column]} + 1` })
    .where(eq(researchRuns.id, runId)).run()
}

function markResearchQueryFailed(db: DatabaseClient, runId: string, queryId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const failed = db.update(researchRunQueries).set({ status: ResearchQueryStatuses.failed, error: message, finishedAt: new Date().toISOString() })
    .where(and(eq(researchRunQueries.id, queryId), inArray(researchRunQueries.status, unfinishedResearchQueryStatuses))).run()
  if (failed.changes === 1) incrementResearchProgress(db, runId, 'failedQueries')
}

function markUnfinishedResearchQueriesFailed(db: DatabaseClient, runId: string, error: string): void {
  db.update(researchRunQueries).set({ status: ResearchQueryStatuses.failed, error, finishedAt: new Date().toISOString() })
    .where(and(eq(researchRunQueries.researchRunId, runId), inArray(researchRunQueries.status, unfinishedResearchQueryStatuses))).run()
}

function finalizeResearchRun(db: DatabaseClient, runId: string, fatalError?: string): void {
  const rows = db.select({ status: researchRunQueries.status }).from(researchRunQueries)
    .where(eq(researchRunQueries.researchRunId, runId)).all()
  const completed = rows.filter(row => row.status === ResearchQueryStatuses.completed).length
  const failed = rows.filter(row => row.status === ResearchQueryStatuses.failed).length
  db.update(researchRuns).set({
    status: finalResearchRunStatus(completed, failed), completedQueries: completed, failedQueries: failed,
    error: fatalError ?? (failed === rows.length ? 'Every research query failed.' : null),
    finishedAt: new Date().toISOString(),
  }).where(eq(researchRuns.id, runId)).run()
}

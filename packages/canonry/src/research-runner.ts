import { and, eq, sql } from 'drizzle-orm'
import { competitors, projects, researchRunQueries, researchRuns, usageCounters, type DatabaseClient } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveBrandNames, effectiveDomains, isBrowserProvider, mapWithConcurrency } from '@ainyc/canonry-contracts'
import { determineCitationState } from './citation-utils.js'
import type { ProviderRegistry } from './provider-registry.js'
import { ProviderExecutionGate } from './provider-execution-gate.js'

/** Execute a saved ad-hoc research batch. Deliberately does not depend on JobRunner or RunCoordinator. */
export async function executeResearchRun(db: DatabaseClient, registry: ProviderRegistry, runId: string, projectId: string): Promise<void> {
  const run = db.select().from(researchRuns).where(and(eq(researchRuns.id, runId), eq(researchRuns.projectId, projectId))).get()
  if (!run || run.status !== 'queued') return
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return
  const provider = registry.get(run.provider)
  const now = new Date().toISOString()
  // Compare-and-set claims the batch before any external call. A duplicate
  // callback (or two workers racing) must not spend the same batch twice.
  const claim = db.update(researchRuns)
    .set({ status: 'running', startedAt: now })
    .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, 'queued')))
    .run()
  if (claim.changes !== 1) return
  if (!provider || isBrowserProvider(run.provider)) {
    db.update(researchRunQueries).set({ status: 'failed', error: 'Configured API provider is unavailable.', startedAt: now, finishedAt: now }).where(eq(researchRunQueries.researchRunId, runId)).run()
    db.update(researchRuns).set({ status: 'failed', error: 'Configured API provider is unavailable.', startedAt: now, finishedAt: now, failedQueries: run.totalQueries }).where(eq(researchRuns.id, runId)).run()
    return
  }
  const period = new Date().toISOString().slice(0, 10)
  const scope = `${projectId}:${run.provider}`
  const quota = db.transaction((tx) => {
    const used = tx.select().from(usageCounters).where(eq(usageCounters.scope, scope)).all()
      .filter(row => row.period === period && row.metric === 'queries')
      .reduce((total, row) => total + row.count, 0)
    if (used + run.totalQueries > provider.config.quotaPolicy.maxRequestsPerDay) return { used, reserved: false }
    tx.insert(usageCounters).values({
      id: `${runId}:quota`, scope, period, metric: 'queries', count: run.totalQueries, updatedAt: now,
    }).onConflictDoUpdate({
      target: [usageCounters.scope, usageCounters.period, usageCounters.metric],
      set: { count: sql`${usageCounters.count} + ${run.totalQueries}`, updatedAt: now },
    }).run()
    return { used, reserved: true }
  })
  if (!quota.reserved) {
    const error = `Daily quota exceeded for ${run.provider}: ${quota.used} queries used today, limit is ${provider.config.quotaPolicy.maxRequestsPerDay}. This batch needs ${run.totalQueries} more.`
    db.update(researchRunQueries).set({ status: 'failed', error, startedAt: now, finishedAt: now }).where(eq(researchRunQueries.researchRunId, runId)).run()
    db.update(researchRuns).set({ status: 'failed', error, startedAt: now, finishedAt: now, failedQueries: run.totalQueries }).where(eq(researchRuns.id, runId)).run()
    return
  }
  const rows = db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, runId)).orderBy(researchRunQueries.position).all()
  const competitorDomains = db.select({ domain: competitors.domain }).from(competitors).where(eq(competitors.projectId, projectId)).all().map(row => row.domain)
  const domains = effectiveDomains(project)
  const brands = effectiveBrandNames(project)
  const config = { ...provider.config, model: run.resolvedModel }
  const gate = new ProviderExecutionGate(provider.config.quotaPolicy.maxConcurrency, provider.config.quotaPolicy.maxRequestsPerMinute)
  await mapWithConcurrency(rows, Math.max(1, provider.config.quotaPolicy.maxConcurrency), async (row) => {
    const startedAt = new Date().toISOString()
    db.update(researchRunQueries).set({ status: 'running', startedAt }).where(eq(researchRunQueries.id, row.id)).run()
    try {
      const raw = await gate.run(() => provider.adapter.executeTrackedQuery({ query: row.queryText, canonicalDomains: domains, competitorDomains, ...(run.location ? { location: run.location } : {}) }, config))
      const normalized = provider.adapter.normalizeResult(raw)
      db.update(researchRunQueries).set({ status: 'completed', servedModel: raw.servedModel ?? null, answerText: normalized.answerText, groundingSources: normalized.groundingSources, citedDomains: normalized.citedDomains, searchQueries: normalized.searchQueries, answerMentioned: determineAnswerMentioned(normalized.answerText, brands, domains), citationState: determineCitationState(normalized, domains), rawResponse: raw.rawResponse as Record<string, unknown>, finishedAt: new Date().toISOString() }).where(eq(researchRunQueries.id, row.id)).run()
    } catch (error) {
      db.update(researchRunQueries).set({ status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() }).where(eq(researchRunQueries.id, row.id)).run()
    }
  })
  const complete = db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, runId)).all()
  const completed = complete.filter(row => row.status === 'completed').length
  const failed = complete.filter(row => row.status === 'failed').length
  db.update(researchRuns).set({ status: failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed', completedQueries: completed, failedQueries: failed, error: failed === complete.length ? 'Every research query failed.' : null, finishedAt: new Date().toISOString() }).where(eq(researchRuns.id, runId)).run()
}

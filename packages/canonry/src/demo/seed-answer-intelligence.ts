import { and, asc, eq } from 'drizzle-orm'
import { healthSnapshots, insights, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { RunKinds } from '@ainyc/canonry-contracts'
import { HISTORY_WINDOW_RUNS, IntelligenceService } from '../intelligence-service.js'
import type { DemoSeedProject } from './types.js'

/**
 * Stores the health snapshot and insights each sweep would have produced,
 * using the production analysis over the stored answers. Rows get ids and
 * times from their sweep, so a restart stores the same records.
 */
export function seedDemoAnswerIntelligence(db: DatabaseClient, project: DemoSeedProject): void {
  const service = new IntelligenceService(db)
  const sweeps = db.select().from(runs)
    .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility'])))
    .orderBy(asc(runs.createdAt))
    .all()
  for (const [index, sweep] of sweeps.entries()) {
    const previous = index > 0 ? sweeps[index - 1]! : null
    // The same window of sweeps, current included, that production analysis loads.
    const history = sweeps.slice(Math.max(0, index - (HISTORY_WINDOW_RUNS - 1)), index + 1)
    const result = service.analyzeRunWithPrevious(sweep, previous, history, { dryRun: true })
    if (!result) continue
    db.transaction(tx => {
      tx.insert(healthSnapshots).values({
        id: `${sweep.id}-health`, projectId: project.id, runId: sweep.id,
        overallCitedRate: String(result.health.overallCitedRate), overallMentionRate: String(result.health.overallMentionRate),
        totalPairs: result.health.totalPairs, citedPairs: result.health.citedPairs, mentionedPairs: result.health.mentionedPairs,
        providerBreakdown: result.health.providerBreakdown, createdAt: sweep.createdAt,
      }).run()
      // The first sweep has no baseline, so like production it stores health only.
      const found = previous ? result.insights : []
      for (const [position, insight] of found.entries()) {
        tx.insert(insights).values({
          id: `${sweep.id}-insight-${position + 1}`, projectId: project.id, runId: sweep.id,
          type: insight.type, severity: insight.severity, title: insight.title, query: insight.query, provider: insight.provider,
          recommendation: insight.recommendation ?? null, cause: insight.cause ?? null, dismissed: false, createdAt: sweep.createdAt,
        }).run()
      }
    })
  }
}

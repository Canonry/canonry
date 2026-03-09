import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { runs, keywords, competitors, projects, querySnapshots, usageCounters } from '@ainyc/aeo-platform-db'
import { executeTrackedQuery, normalizeResult } from '@ainyc/aeo-platform-provider-gemini'

export class JobRunner {
  private db: DatabaseClient
  private geminiApiKey: string

  constructor(db: DatabaseClient, geminiApiKey: string) {
    this.db = db
    this.geminiApiKey = geminiApiKey
  }

  async executeRun(runId: string, projectId: string): Promise<void> {
    const now = new Date().toISOString()

    try {
      // Mark run as running
      this.db
        .update(runs)
        .set({ status: 'running', startedAt: now })
        .where(eq(runs.id, runId))
        .run()

      // Fetch project
      const project = this.db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()

      if (!project) {
        throw new Error(`Project ${projectId} not found`)
      }

      // Fetch keywords for the project
      const projectKeywords = this.db
        .select()
        .from(keywords)
        .where(eq(keywords.projectId, projectId))
        .all()

      // Fetch competitors for the project
      const projectCompetitors = this.db
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, projectId))
        .all()

      const competitorDomains = projectCompetitors.map(c => c.domain)

      // Process each keyword
      for (const kw of projectKeywords) {
        const raw = await executeTrackedQuery({
          keyword: kw.keyword,
          canonicalDomains: [project.canonicalDomain],
          competitorDomains,
        })

        const normalized = normalizeResult(raw)

        // Determine citation state
        const citationState = normalized.citedDomains.some(
          d => d === project.canonicalDomain || d.endsWith(`.${project.canonicalDomain}`),
        )
          ? 'cited'
          : 'not-cited'

        // Compute competitor overlap
        const overlap = normalized.citedDomains.filter(d =>
          competitorDomains.some(cd => d === cd || d.endsWith(`.${cd}`)),
        )

        // Insert query snapshot
        this.db.insert(querySnapshots).values({
          id: crypto.randomUUID(),
          runId,
          keywordId: kw.id,
          provider: 'gemini',
          citationState,
          answerText: normalized.answerText,
          citedDomains: JSON.stringify(normalized.citedDomains),
          competitorOverlap: JSON.stringify(overlap),
          rawResponse: JSON.stringify(raw.rawResponse),
          createdAt: new Date().toISOString(),
        }).run()
      }

      // Mark run as completed
      this.db
        .update(runs)
        .set({ status: 'completed', finishedAt: new Date().toISOString() })
        .where(eq(runs.id, runId))
        .run()

      // Increment usage counters
      this.incrementUsage(projectId, 'queries', projectKeywords.length)
      this.incrementUsage(projectId, 'runs', 1)
    } catch (err: unknown) {
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
    }
  }

  private incrementUsage(scope: string, metric: string, count: number): void {
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const id = crypto.randomUUID()

    // Try to find existing counter
    const existing = this.db
      .select()
      .from(usageCounters)
      .where(eq(usageCounters.scope, scope))
      .all()
      .find(r => r.period === period && r.metric === metric)

    if (existing) {
      this.db
        .update(usageCounters)
        .set({ count: existing.count + count, updatedAt: now.toISOString() })
        .where(eq(usageCounters.id, existing.id))
        .run()
    } else {
      this.db.insert(usageCounters).values({
        id,
        scope,
        period,
        metric,
        count,
        updatedAt: now.toISOString(),
      }).run()
    }
  }
}

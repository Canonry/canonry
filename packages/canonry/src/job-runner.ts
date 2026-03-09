import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/aeo-platform-db'
import { runs, keywords, competitors, projects, querySnapshots, usageCounters } from '@ainyc/aeo-platform-db'
import { executeTrackedQuery, normalizeResult, type GeminiConfig } from '@ainyc/aeo-platform-provider-gemini'

export class JobRunner {
  private db: DatabaseClient
  private geminiConfig: GeminiConfig

  constructor(
    db: DatabaseClient,
    geminiApiKey: string,
    geminiModel?: string,
    quotaPolicy?: { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number },
  ) {
    this.db = db
    this.geminiConfig = {
      apiKey: geminiApiKey,
      model: geminiModel,
      quotaPolicy: quotaPolicy ?? {
        maxConcurrency: 2,
        maxRequestsPerMinute: 10,
        maxRequestsPerDay: 1000,
      },
    }
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

      // Enforce daily quota before dispatching any requests
      const quota = this.geminiConfig.quotaPolicy
      const todayPeriod = (() => {
        const d = new Date()
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      })()
      const todayUsage = this.db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.scope, projectId))
        .all()
        .filter(r => r.period === todayPeriod && r.metric === 'queries')
        .reduce((sum, r) => sum + r.count, 0)

      if (todayUsage + projectKeywords.length > quota.maxRequestsPerDay) {
        throw new Error(
          `Daily quota exceeded: ${todayUsage} queries used today, limit is ${quota.maxRequestsPerDay}. ` +
          `This run needs ${projectKeywords.length} more.`,
        )
      }

      // Rate-limit: track request timestamps to stay within maxRequestsPerMinute
      const minuteWindow: number[] = []

      // Process each keyword
      for (const kw of projectKeywords) {
        // Enforce per-minute rate limit before each request
        const now = Date.now()
        const windowStart = now - 60_000
        while (minuteWindow.length > 0 && minuteWindow[0]! < windowStart) {
          minuteWindow.shift()
        }
        if (minuteWindow.length >= quota.maxRequestsPerMinute) {
          const oldestInWindow = minuteWindow[0]!
          const waitMs = oldestInWindow + 60_000 - now + 50
          await new Promise(resolve => setTimeout(resolve, waitMs))
          const nowAfterWait = Date.now()
          const newWindowStart = nowAfterWait - 60_000
          while (minuteWindow.length > 0 && minuteWindow[0]! < newWindowStart) {
            minuteWindow.shift()
          }
        }
        minuteWindow.push(Date.now())

        const raw = await executeTrackedQuery({
          keyword: kw.keyword,
          canonicalDomains: [project.canonicalDomain],
          competitorDomains,
          config: this.geminiConfig,
        })

        const normalized = normalizeResult(raw)

        // Determine citation state
        const citationState = normalized.citedDomains.some(
          d => d === project.canonicalDomain || d.endsWith(`.${project.canonicalDomain}`),
        )
          ? 'cited'
          : 'not-cited'

        // Compute competitor overlap from grounding sources AND answer text
        const overlapSet = new Set<string>()

        // Check grounding source domains
        for (const d of normalized.citedDomains) {
          for (const cd of competitorDomains) {
            if (d === cd || d.endsWith(`.${cd}`)) {
              overlapSet.add(cd)
            }
          }
        }

        // Check answer text for competitor domain mentions
        if (normalized.answerText) {
          const lowerAnswer = normalized.answerText.toLowerCase()
          for (const cd of competitorDomains) {
            // Check for domain mention (e.g. "example.com")
            if (lowerAnswer.includes(cd.toLowerCase())) {
              overlapSet.add(cd)
            }
            // Check for whole-word brand name (domain without TLD, e.g. "example" from "example.com")
            const brand = cd.split('.')[0]
            if (brand.length >= 4 && new RegExp(`\\b${brand}\\b`, 'i').test(lowerAnswer)) {
              overlapSet.add(cd)
            }
          }
        }

        const overlap = [...overlapSet]

        // Insert query snapshot — rawResponse includes grounding sources
        // and search queries for analyst review in the UI
        this.db.insert(querySnapshots).values({
          id: crypto.randomUUID(),
          runId,
          keywordId: kw.id,
          provider: 'gemini',
          citationState,
          answerText: normalized.answerText,
          citedDomains: JSON.stringify(normalized.citedDomains),
          competitorOverlap: JSON.stringify(overlap),
          rawResponse: JSON.stringify({
            model: raw.model,
            groundingSources: normalized.groundingSources,
            searchQueries: normalized.searchQueries,
            apiResponse: raw.rawResponse,
          }),
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

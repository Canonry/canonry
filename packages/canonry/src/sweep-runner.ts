/**
 * SweepRunner — executes indexing sweeps for a project.
 *
 * For each keyword × domain (client + competitors), fires a
 * `site:<domain> <keyword>` query via the configured web_search provider
 * and stores the results in the indexing_sweep_results table.
 */

import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { indexingSweeps, indexingSweepResults, keywords, competitors, projects } from '@ainyc/canonry-db'
import { createWebSearchAdapter } from '@ainyc/canonry-provider-web-search'
import type { WebSearchBackend } from '@ainyc/canonry-contracts'

export interface WebSearchProviderSettings {
  apiKey: string
  backend?: WebSearchBackend
  cx?: string
}

export class SweepRunner {
  private db: DatabaseClient
  private getWebSearchSettings: () => WebSearchProviderSettings | null

  onSweepCompleted?: (sweepId: string, projectId: string) => Promise<void>

  constructor(
    db: DatabaseClient,
    getWebSearchSettings: () => WebSearchProviderSettings | null,
  ) {
    this.db = db
    this.getWebSearchSettings = getWebSearchSettings
  }

  async executeSweep(sweepId: string, projectId: string, keywordFilter?: string): Promise<void> {
    const now = new Date().toISOString()

    try {
      // Mark sweep as running
      this.db
        .update(indexingSweeps)
        .set({ status: 'running', startedAt: now })
        .where(eq(indexingSweeps.id, sweepId))
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

      // Load web search settings
      const settings = this.getWebSearchSettings()
      if (!settings?.apiKey) {
        throw new Error(
          'web_search provider not configured. ' +
          'Set WEB_SEARCH_API_KEY env var or run: canonry settings provider web-search --api-key <key>',
        )
      }

      const adapter = createWebSearchAdapter(settings.apiKey, settings.backend ?? 'serper', settings.cx)

      // Load keywords
      let kws = this.db.select().from(keywords).where(eq(keywords.projectId, projectId)).all()
      if (keywordFilter) {
        kws = kws.filter(k => k.keyword === keywordFilter)
      }

      if (kws.length === 0) {
        throw new Error('No keywords found for project')
      }

      // Load competitors
      const comps = this.db
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, projectId))
        .all()

      const clientDomain = project.canonicalDomain

      // Process each keyword × domain pair
      for (const kw of kws) {
        const domains: Array<{ domain: string; role: 'client' | 'competitor' }> = [
          { domain: clientDomain, role: 'client' },
          ...comps.map(c => ({ domain: c.domain, role: 'competitor' as const })),
        ]

        for (const { domain, role } of domains) {
          try {
            const result = await adapter.siteQuery(domain, kw.keyword)
            const createdAt = new Date().toISOString()

            this.db
              .insert(indexingSweepResults)
              .values({
                id: crypto.randomUUID(),
                sweepId,
                keywordId: kw.id,
                domain,
                domainRole: role,
                indexedPageCount: result.indexedPageCount,
                topPages: JSON.stringify(result.topPages),
                createdAt,
              })
              .onConflictDoUpdate({
                target: [
                  indexingSweepResults.sweepId,
                  indexingSweepResults.keywordId,
                  indexingSweepResults.domain,
                ],
                set: {
                  indexedPageCount: result.indexedPageCount,
                  topPages: JSON.stringify(result.topPages),
                },
              })
              .run()
          } catch (err) {
            // Log but don't abort the sweep — partial results are useful
            console.error(
              `[SweepRunner] Failed site:${domain} "${kw.keyword}":`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }

      // Mark completed
      const finishedAt = new Date().toISOString()
      this.db
        .update(indexingSweeps)
        .set({ status: 'completed', finishedAt })
        .where(eq(indexingSweeps.id, sweepId))
        .run()

      if (this.onSweepCompleted) {
        await this.onSweepCompleted(sweepId, projectId)
      }
    } catch (err) {
      const finishedAt = new Date().toISOString()
      const message = err instanceof Error ? err.message : String(err)
      this.db
        .update(indexingSweeps)
        .set({ status: 'failed', finishedAt, error: message })
        .where(eq(indexingSweeps.id, sweepId))
        .run()
      console.error(`[SweepRunner] Sweep ${sweepId} failed:`, message)
    }
  }
}

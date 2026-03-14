import crypto from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, keywords, competitors, projects, querySnapshots, usageCounters } from '@ainyc/canonry-db'
import type { ProviderName, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import { effectiveDomains, normalizeProjectDomain } from '@ainyc/canonry-contracts'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { trackEvent } from './telemetry.js'

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
      console.log(`[JobRunner] Recovered stale run ${run.id} (was ${run.status})`)
    }
  }

  async executeRun(runId: string, projectId: string, providerOverride?: ProviderName[]): Promise<void> {
    const now = new Date().toISOString()
    const startTime = Date.now()

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

      // Resolve which providers to use — honour per-run override, then project config
      const projectProviders = providerOverride ?? (JSON.parse(project.providers || '[]') as ProviderName[])
      const activeProviders = this.registry.getForProject(projectProviders)

      if (activeProviders.length === 0) {
        throw new Error('No providers configured. Add at least one provider API key.')
      }

      console.log(`[JobRunner] Run ${runId}: dispatching to ${activeProviders.length} providers: ${activeProviders.map(p => p.adapter.name).join(', ')}`)

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

      // Enforce daily quota per provider — each provider receives one query per keyword.
      // Track and check usage per (projectId, providerName) so that a provider that has
      // never been used isn't blocked by another provider's past usage.
      const queriesPerProvider = projectKeywords.length
      const todayPeriod = getCurrentPeriod()

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

      // Per-provider rate limiting: separate sliding windows
      const minuteWindows = new Map<ProviderName, number[]>()
      for (const p of activeProviders) {
        minuteWindows.set(p.adapter.name, [])
      }

      // Track per-provider errors for partial completion
      const providerErrors = new Map<ProviderName, string>()
      let totalSnapshotsInserted = 0

      // Process each keyword across all providers
      for (const kw of projectKeywords) {
        // Fan out across providers for this keyword
        const providerPromises = activeProviders.map(async (registeredProvider) => {
          const { adapter, config } = registeredProvider
          const providerName = adapter.name

          try {
            // Enforce per-minute rate limit
            await this.waitForRateLimit(
              minuteWindows.get(providerName)!,
              config.quotaPolicy.maxRequestsPerMinute,
            )

            const allDomains = effectiveDomains({
              canonicalDomain: project.canonicalDomain,
              ownedDomains: JSON.parse(project.ownedDomains || '[]') as string[],
            })

            const raw = await adapter.executeTrackedQuery(
              {
                keyword: kw.keyword,
                canonicalDomains: allDomains,
                competitorDomains,
              },
              config,
            )

            const normalized = adapter.normalizeResult(raw)

            console.log(`[JobRunner] ${providerName}: "${kw.keyword}" citedDomains=${JSON.stringify(normalized.citedDomains)}, groundingSources=${JSON.stringify(normalized.groundingSources.map(s => s.uri))}, domains=${JSON.stringify(allDomains)}`)
            const citationState = determineCitationState(normalized, allDomains)
            const overlap = computeCompetitorOverlap(normalized, competitorDomains)

            this.db.insert(querySnapshots).values({
              id: crypto.randomUUID(),
              runId,
              keywordId: kw.id,
              provider: providerName,
              model: raw.model,
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

            totalSnapshotsInserted++
            console.log(`[JobRunner] ${providerName}: keyword "${kw.keyword}" → ${citationState}`)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[JobRunner] ${providerName}: keyword "${kw.keyword}" FAILED: ${msg}`)
            providerErrors.set(providerName, msg)
          }
        })

        await Promise.all(providerPromises)
      }

      // Determine final run status
      const allFailed = totalSnapshotsInserted === 0 && providerErrors.size > 0
      const someFailed = providerErrors.size > 0

      if (allFailed) {
        const errorDetail = JSON.stringify(Object.fromEntries(providerErrors))
        this.db
          .update(runs)
          .set({ status: 'failed', finishedAt: new Date().toISOString(), error: errorDetail })
          .where(eq(runs.id, runId))
          .run()
      } else if (someFailed) {
        const errorDetail = JSON.stringify(Object.fromEntries(providerErrors))
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

      // Track run completion telemetry
      const finalStatus = allFailed ? 'failed' : someFailed ? 'partial' : 'completed'
      trackEvent('run.completed', {
        status: finalStatus,
        providerCount: activeProviders.length,
        providers: activeProviders.map(p => p.adapter.name),
        keywordCount: projectKeywords.length,
        durationMs: Date.now() - startTime,
      })

      // Increment per-provider usage counters to keep quota checks accurate
      for (const p of activeProviders) {
        this.incrementUsage(`${projectId}:${p.adapter.name}`, 'queries', queriesPerProvider)
      }
      this.incrementUsage(projectId, 'runs', 1)

      // Notify after run completion
      if (this.onRunCompleted) {
        this.onRunCompleted(runId, projectId).catch((err: unknown) => {
          console.error('[JobRunner] Notification callback failed:', err)
        })
      }
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

      // Track fatal run failures (missing project, quota exceeded, no providers, etc.)
      trackEvent('run.completed', {
        status: 'failed',
        providerCount: 0,
        providers: [],
        keywordCount: 0,
        durationMs: Date.now() - startTime,
      })

      // Notify on failure too
      if (this.onRunCompleted) {
        this.onRunCompleted(runId, projectId).catch((notifErr: unknown) => {
          console.error('[JobRunner] Notification callback failed:', notifErr)
        })
      }
    }
  }

  private async waitForRateLimit(window: number[], maxPerMinute: number): Promise<void> {
    const now = Date.now()
    const windowStart = now - 60_000
    while (window.length > 0 && window[0]! < windowStart) {
      window.shift()
    }
    if (window.length >= maxPerMinute) {
      const oldestInWindow = window[0]!
      const waitMs = oldestInWindow + 60_000 - now + 50
      await new Promise(resolve => setTimeout(resolve, waitMs))
      const nowAfterWait = Date.now()
      const newWindowStart = nowAfterWait - 60_000
      while (window.length > 0 && window[0]! < newWindowStart) {
        window.shift()
      }
    }
    window.push(Date.now())
  }

  private incrementUsage(scope: string, metric: string, count: number): void {
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    const id = crypto.randomUUID()

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

function getCurrentPeriod(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function domainMatches(domain: string, canonicalDomain: string): boolean {
  const normalized = normalizeProjectDomain(canonicalDomain)
  const d = normalizeProjectDomain(domain)
  return d === normalized || d.endsWith(`.${normalized}`)
}

function determineCitationState(
  normalized: NormalizedQueryResult,
  domains: string[],
): 'cited' | 'not-cited' {
  for (const canonicalDomain of domains) {
    const bareDomain = normalizeProjectDomain(canonicalDomain)

    // Check extracted cited domains
    if (normalized.citedDomains.some(d => domainMatches(d, bareDomain))) {
      return 'cited'
    }

    // Also check grounding source URIs and titles directly
    const lowerDomain = bareDomain.toLowerCase()
    for (const source of normalized.groundingSources) {
      try {
        // Only use substring fallback for domains that look like real FQDNs (contain a dot).
        // Short or generic owned-domain entries (e.g. "ai", "app") would otherwise match
        // the vast majority of URLs, producing false-positive citations.
        const uri = source.uri.toLowerCase()
        if (lowerDomain.includes('.') && uri.includes(lowerDomain)) {
          return 'cited'
        }
      } catch {
        // ignore
      }
      // Gemini proxy URLs use base64 encoding, so the domain won't appear in the URI.
      // The title field often contains the bare domain (e.g. "ainyc.ai").
      if (source.title) {
        const titleLower = source.title.toLowerCase().replace(/^www\./, '')
        if (titleLower === lowerDomain || titleLower.endsWith(`.${lowerDomain}`)) {
          return 'cited'
        }
      }
    }
  }

  return 'not-cited'
}

function computeCompetitorOverlap(
  normalized: NormalizedQueryResult,
  competitorDomains: string[],
): string[] {
  const overlapSet = new Set<string>()

  // Check extracted cited domains
  for (const d of normalized.citedDomains) {
    for (const cd of competitorDomains) {
      if (domainMatches(d, cd)) {
        overlapSet.add(cd)
      }
    }
  }

  // Check grounding source URIs (handles proxy URLs)
  for (const source of normalized.groundingSources) {
    const uri = source.uri.toLowerCase()
    for (const cd of competitorDomains) {
      if (uri.includes(cd.toLowerCase())) {
        overlapSet.add(cd)
      }
    }
  }

  // Check answer text for competitor domain mentions
  if (normalized.answerText) {
    const lowerAnswer = normalized.answerText.toLowerCase()
    for (const cd of competitorDomains) {
      if (lowerAnswer.includes(cd.toLowerCase())) {
        overlapSet.add(cd)
      }
      const brand = cd.split('.')[0]
      if (brand && brand.length >= 4 && new RegExp(`\\b${brand}\\b`, 'i').test(lowerAnswer)) {
        overlapSet.add(cd)
      }
    }
  }

  return [...overlapSet]
}

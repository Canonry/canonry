import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { runs, keywords, competitors, projects, querySnapshots, usageCounters, parseJsonColumn } from '@ainyc/canonry-db'
import type { ProviderName, NormalizedQueryResult, LocationContext } from '@ainyc/canonry-contracts'
import { brandKeyFromText, determineAnswerMentioned, effectiveDomains, normalizeProjectDomain, isBrowserProvider } from '@ainyc/canonry-contracts'
import type { ProviderRegistry, RegisteredProvider } from './provider-registry.js'
import { trackEvent } from './telemetry.js'
import { createLogger } from './logger.js'

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

type RunExecutionContext = {
  providerCount: number
  providers: ProviderName[]
  keywordCount: number
  location?: string
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
    let runLocation: LocationContext | undefined
    let activeProviders: RegisteredProvider[] = []
    let projectKeywords: typeof keywords.$inferSelect[] = []
    const providerDispatchCounts = new Map<ProviderName, number>()

    try {
      const existingRun = this.getRunState(runId)
      if (!existingRun) {
        throw new Error(`Run ${runId} not found`)
      }
      if (existingRun.status === 'cancelled') {
        this.handleCancelledRun(runId, projectId, startTime, {
          providerCount: 0,
          providers: [],
          keywordCount: 0,
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

      // Resolve location: explicit override > project default > none
      // locationOverride === null means explicitly no location (--no-location)
      // locationOverride === undefined means use project default
      if (locationOverride === null) {
        runLocation = undefined
      } else if (locationOverride) {
        runLocation = locationOverride
      } else {
        const projectLocations = parseJsonColumn<LocationContext[]>(project.locations, [])
        if (project.defaultLocation && projectLocations.length > 0) {
          runLocation = projectLocations.find(l => l.label === project.defaultLocation)
        }
      }

      // Resolve which providers to use — honour per-run override, then project config
      const projectProviders = providerOverride ?? parseJsonColumn<ProviderName[]>(project.providers, [])
      activeProviders = this.registry.getForProject(projectProviders)

      if (activeProviders.length === 0) {
        throw new Error('No providers configured. Add at least one provider API key.')
      }

      log.info('run.dispatch', { runId, providerCount: activeProviders.length, providers: activeProviders.map(p => p.adapter.name) })

      // Fetch keywords for the project
      projectKeywords = this.db
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
      const allDomains = effectiveDomains({
        canonicalDomain: project.canonicalDomain,
        ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
      })
      const executionContext: RunExecutionContext = {
        providerCount: activeProviders.length,
        providers: activeProviders.map(provider => provider.adapter.name),
        keywordCount: projectKeywords.length,
        ...(runLocation ? { location: runLocation.label } : {}),
      }

      // Enforce daily quota per provider — each provider receives one query per keyword.
      // Track and check usage per (projectId, providerName) so that a provider that has
      // never been used isn't blocked by another provider's past usage.
      const queriesPerProvider = projectKeywords.length
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

      const processKeywordForProvider = async (
        registeredProvider: RegisteredProvider,
        kw: typeof keywords.$inferSelect,
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
                keyword: kw.keyword,
                canonicalDomains: allDomains,
                competitorDomains,
                location: runLocation,
              },
              config,
            )

            this.throwIfRunCancelled(runId)

            const normalized = adapter.normalizeResult(raw)

            log.info('query.result', { runId, provider: providerName, keyword: kw.keyword, citedDomains: normalized.citedDomains, groundingSources: normalized.groundingSources.map(s => s.uri), matchDomains: allDomains })
            const citationState = determineCitationState(normalized, allDomains)
            const answerMentioned = determineAnswerMentioned(
              normalized.answerText,
              project.displayName,
              allDomains,
            )
            const overlap = computeCompetitorOverlap(normalized, competitorDomains)
            const extractedCompetitors = extractRecommendedCompetitors(
              normalized.answerText,
              allDomains,
              normalized.citedDomains,
              overlap,
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
                keywordId: kw.id,
                provider: providerName,
                model: raw.model,
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: JSON.stringify(normalized.citedDomains),
                competitorOverlap: JSON.stringify(overlap),
                recommendedCompetitors: JSON.stringify(extractedCompetitors),
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
                keywordId: kw.id,
                provider: providerName,
                model: raw.model,
                citationState,
                answerMentioned,
                answerText: normalized.answerText,
                citedDomains: JSON.stringify(normalized.citedDomains),
                competitorOverlap: JSON.stringify(overlap),
                recommendedCompetitors: JSON.stringify(extractedCompetitors),
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
            log.info('query.citation', { runId, provider: providerName, keyword: kw.keyword, citationState, answerMentioned })
          })
        } catch (err: unknown) {
          if (err instanceof RunCancelledError) {
            throw err
          }

          const msg = err instanceof Error ? err.message : String(err)
          const stack = err instanceof Error ? err.stack : undefined
          log.error('query.failed', { runId, provider: providerName, keyword: kw.keyword, error: msg, stack })
          if (!providerErrors.has(providerName)) {
            providerErrors.set(providerName, msg)
          }
        }
      }

      await Promise.all(apiProviders.map(async (registeredProvider) => {
        await Promise.all(projectKeywords.map(async (kw) => {
          await processKeywordForProvider(registeredProvider, kw)
        }))
      }))

      // Browser providers still run keyword-by-keyword to preserve tab reuse semantics.
      for (const registeredProvider of browserProviders) {
        for (const kw of projectKeywords) {
          await processKeywordForProvider(registeredProvider, kw)
        }
      }

      this.throwIfRunCancelled(runId)

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

      this.flushProviderUsage(projectId, providerDispatchCounts)

      // Track run completion telemetry
      const finalStatus = allFailed ? 'failed' : someFailed ? 'partial' : 'completed'
      trackEvent('run.completed', {
        status: finalStatus,
        providerCount: executionContext.providerCount,
        providers: executionContext.providers,
        keywordCount: executionContext.keywordCount,
        durationMs: Date.now() - startTime,
        ...(executionContext.location ? { location: executionContext.location } : {}),
      })

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
        keywordCount: projectKeywords.length,
        ...(runLocation ? { location: runLocation.label } : {}),
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

      // Track fatal run failures (missing project, quota exceeded, no providers, etc.)
      trackEvent('run.completed', {
        status: 'failed',
        providerCount: executionContext.providerCount,
        providers: executionContext.providers,
        keywordCount: executionContext.keywordCount,
        durationMs: Date.now() - startTime,
        ...(executionContext.location ? { location: executionContext.location } : {}),
      })

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

  private getRunState(runId: string): { status: string; finishedAt: string | null; error: string | null } | undefined {
    return this.db
      .select({
        status: runs.status,
        finishedAt: runs.finishedAt,
        error: runs.error,
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

    trackEvent('run.completed', {
      status: 'cancelled',
      providerCount: context.providerCount,
      providers: context.providers,
      keywordCount: context.keywordCount,
      durationMs: Date.now() - startTime,
      ...(context.location ? { location: context.location } : {}),
    })

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

/**
 * Extract brand names from the answer, but only when they line up with
 * domains we already know were cited or matched as competitors.
 */
export function extractRecommendedCompetitors(
  answerText: string | null | undefined,
  ownDomains: string[],
  citedDomains: string[],
  competitorDomains: string[],
): string[] {
  if (!answerText || answerText.length < 20) return []

  const ownBrandKeys = new Set(
    ownDomains.flatMap(domain => collectBrandKeysFromDomain(domain)),
  )
  const knownCompetitorKeys = new Set(
    [...citedDomains, ...competitorDomains]
      .flatMap(domain => collectBrandKeysFromDomain(domain))
      .filter(key => !ownBrandKeys.has(key)),
  )

  if (knownCompetitorKeys.size === 0) return []

  const candidatePatterns = [
    /^\s*(?:[-*]|\d+\.)\s+(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?\s*[:\u2014\u2013–-]/gm,
    /\*\*([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)\*\*/g,
    /^#{1,4}\s+(?:\d+\.\s+)?(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?$/gm,
    /\[([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)\]\(https?:\/\/[^\s)]+\)/g,
  ]
  const genericKeys = new Set([
    'additional',
    'best',
    'benefits',
    'bottomline',
    'comparison',
    'conclusion',
    'directorylisting',
    'example',
    'expertise',
    'features',
    'finalthoughts',
    'howitworks',
    'important',
    'keybenefits',
    'keyfeatures',
    'major',
    'note',
    'notable',
    'option',
    'other',
    'overview',
    'pricing',
    'pros',
    'reviews',
    'step',
    'summary',
    'top',
    'verdict',
    'whattolookfor',
    'whyitmatters',
    'whyitstandsout',
    'whywechoseit',
  ])

  const seen = new Map<string, string>()
  for (const pattern of candidatePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(answerText)) !== null) {
      const candidate = cleanCandidateName(match[1] ?? '')
      const candidateKey = brandKeyFromText(candidate)
      if (!candidateKey) continue
      if (genericKeys.has(candidateKey)) continue
      if (candidate.split(/\s+/).length > 6) continue
      if (matchesBrandKey(candidateKey, ownBrandKeys)) continue
      if (!matchesBrandKey(candidateKey, knownCompetitorKeys)) continue
      if (!seen.has(candidateKey)) seen.set(candidateKey, candidate)
    }
  }

  return [...seen.values()].slice(0, 10)
}

function cleanCandidateName(candidate: string): string {
  return candidate
    .replace(/^[\s"'`]+|[\s"'`.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}


function collectBrandKeysFromDomain(domain: string): string[] {
  const hostname = normalizeProjectDomain(domain).split('/')[0] ?? ''
  const labels = hostname.split('.').filter(Boolean)
  const keys = new Set<string>()

  const hostnameKey = hostname.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (hostnameKey.length >= 4) keys.add(hostnameKey)

  for (const label of labels) {
    const key = label.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (key.length >= 4) keys.add(key)
  }

  return [...keys]
}

function matchesBrandKey(candidateKey: string, brandKeys: Set<string>): boolean {
  for (const brandKey of brandKeys) {
    if (candidateKey === brandKey) return true
    if (candidateKey.startsWith(brandKey) || candidateKey.endsWith(brandKey)) return true
    if (brandKey.startsWith(candidateKey) || brandKey.endsWith(candidateKey)) return true
  }
  return false
}

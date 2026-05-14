import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  competitors,
  insights,
  parseJsonColumn,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  effectiveDomains,
  RunStatuses,
} from '@ainyc/canonry-contracts'
import { embedQueries } from '@ainyc/canonry-provider-gemini'
import {
  executeDiscovery,
  markSessionFailed,
  type DiscoveryDeps,
  type DiscoveryProjectContext,
  type DiscoveryProbeResult,
  type DiscoverySeedResult,
  type ExecuteDiscoveryResult,
} from '@ainyc/canonry-api-routes'
import type { ProviderRegistry } from './provider-registry.js'
import { createLogger } from './logger.js'

const log = createLogger('DiscoveryRun')

const DEFAULT_SEED_COUNT = 30

export interface ExecuteDiscoveryRunOptions {
  db: DatabaseClient
  registry: ProviderRegistry
  runId: string
  sessionId: string
  projectId: string
  icpDescription: string
  dedupThreshold?: number
  maxProbes?: number
  /** Override for tests / future multi-provider amplification. Defaults to Gemini-only. */
  deps?: DiscoveryDeps
}

/**
 * Runs the full discovery pipeline for a single session and marks the
 * associated `runs` row terminal. Always returns rather than throws — the
 * route fired this in the background, so the only safe response to a failure
 * is to record it in `discovery_sessions.error` + `runs.error` and move on.
 *
 * After the orchestrator returns, this handler also writes a single
 * `discovery.basket-divergence` insight summarizing the bucket counts. PR 5
 * will hoist the insight write into the shared `persistInsight()` helper —
 * for PR 1 it's inlined here per the handoff doc's "no shared helper yet" call.
 */
export async function executeDiscoveryRun(opts: ExecuteDiscoveryRunOptions): Promise<void> {
  const startedAt = new Date().toISOString()
  opts.db
    .update(runs)
    .set({ status: RunStatuses.running, startedAt })
    .where(eq(runs.id, opts.runId))
    .run()

  try {
    const projectRow = opts.db.select().from(projects).where(eq(projects.id, opts.projectId)).get()
    if (!projectRow) throw new Error(`Project ${opts.projectId} not found`)

    const projectCompetitors = opts.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, opts.projectId))
      .all()
      .map(r => r.domain.toLowerCase())

    const canonicalDomains = effectiveDomains({
      canonicalDomain: projectRow.canonicalDomain,
      ownedDomains: parseJsonColumn<string[]>(projectRow.ownedDomains, []),
    })

    const project: DiscoveryProjectContext = {
      id: projectRow.id,
      name: projectRow.name,
      canonicalDomains,
      competitorDomains: projectCompetitors,
    }

    const deps = opts.deps ?? buildDefaultDeps(opts.registry)

    const result = await executeDiscovery({
      db: opts.db,
      runId: opts.runId,
      sessionId: opts.sessionId,
      project,
      icpDescription: opts.icpDescription,
      dedupThreshold: opts.dedupThreshold,
      maxProbes: opts.maxProbes,
      deps,
    })

    writeDiscoveryInsight(opts.db, {
      projectId: opts.projectId,
      runId: opts.runId,
      sessionId: opts.sessionId,
      seedProvider: result.seedProvider,
      result,
    })

    opts.db
      .update(runs)
      .set({ status: RunStatuses.completed, finishedAt: new Date().toISOString() })
      .where(eq(runs.id, opts.runId))
      .run()

    log.info('discovery.completed', {
      runId: opts.runId,
      sessionId: opts.sessionId,
      buckets: result.buckets,
      competitorCount: result.competitorMap.length,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error('discovery.failed', { runId: opts.runId, sessionId: opts.sessionId, error: errorMsg })

    markSessionFailed(opts.db, opts.sessionId, errorMsg)
    opts.db
      .update(runs)
      .set({
        status: RunStatuses.failed,
        finishedAt: new Date().toISOString(),
        error: errorMsg,
      })
      .where(eq(runs.id, opts.runId))
      .run()
  }
}

/**
 * Default deps — Gemini-only. v2 multi-provider amplification will wrap
 * multiple deps in a composite and surface a label like `"gemini+chatgpt"`
 * in the `DiscoverySeedResult.provider` field.
 */
function buildDefaultDeps(registry: ProviderRegistry): DiscoveryDeps {
  const gemini = registry.get('gemini')
  if (!gemini) {
    throw new Error('Gemini provider is not configured. Add a Gemini API key (or Vertex project) before running discovery.')
  }
  const cfg = gemini.config
  if (!cfg.apiKey && !cfg.vertexProject) {
    throw new Error('Gemini provider is missing both apiKey and vertexProject — cannot run discovery.')
  }

  const adapter = gemini.adapter

  return {
    async seed(input): Promise<DiscoverySeedResult> {
      const prompt = buildSeedPrompt(input)
      const raw = await adapter.executeTrackedQuery(
        {
          query: prompt,
          canonicalDomains: input.project.canonicalDomains,
          competitorDomains: input.project.competitorDomains,
        },
        cfg,
      )
      const normalized = adapter.normalizeResult(raw)
      const fromAnswer = parseQueryLines(normalized.answerText, DEFAULT_SEED_COUNT * 2)
      // Gemini's grounding metadata also exposes the actual web search queries
      // it ran — those are *real* user-intent strings that show live demand,
      // so they make excellent seed candidates alongside the model's response.
      const fromGrounding = normalized.searchQueries ?? []
      return {
        candidates: [...fromAnswer, ...fromGrounding],
        provider: 'gemini',
      }
    },
    async embed(queries: string[]): Promise<number[][]> {
      if (cfg.apiKey) {
        return embedQueries(queries, { apiKey: cfg.apiKey })
      }
      // Vertex-mode embeddings need a Vertex-aware client; this is outside
      // PR 1's scope. Throw early with a clear remediation so we don't
      // silently fall through to a half-broken pipeline.
      throw new Error('Discovery currently requires a Gemini API key. Vertex-mode embeddings are not yet implemented.')
    },
    async probe(input): Promise<DiscoveryProbeResult> {
      const raw = await adapter.executeTrackedQuery(
        {
          query: input.query,
          canonicalDomains: input.project.canonicalDomains,
          competitorDomains: input.project.competitorDomains,
        },
        cfg,
      )
      const normalized = adapter.normalizeResult(raw)
      const canonical = new Set(input.project.canonicalDomains.map(d => d.toLowerCase()))
      const isCited = normalized.citedDomains.some(d => canonical.has(d.toLowerCase()))
      return {
        citationState: isCited ? 'cited' : 'not-cited',
        citedDomains: normalized.citedDomains,
        rawResponse: raw.rawResponse as Record<string, unknown>,
      }
    },
  }
}

function buildSeedPrompt(input: { project: DiscoveryProjectContext; icpDescription: string }): string {
  return [
    'You are an AEO (Answer Engine Optimization) analyst expanding a tracked-query basket for a customer.',
    '',
    `Customer: ${input.project.name} (domains: ${input.project.canonicalDomains.join(', ')})`,
    `ICP: ${input.icpDescription}`,
    '',
    'Brainstorm a wide set of queries a member of this ICP would type into an AI answer engine (Gemini, ChatGPT, Perplexity) when they are about to make a decision in this space. Aim for 30+ candidates covering:',
    ' - Comparison queries ("best X for Y")',
    ' - Specific feature / capability queries',
    ' - Pricing / vendor-shortlist queries',
    ' - Workflow / how-to queries',
    ' - Adjacent jobs-to-be-done queries',
    '',
    'Return ONE query per line. Plain text only — no numbering, bullets, quotes, or commentary.',
  ].join('\n')
}

function parseQueryLines(text: string, max: number): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue
    line = line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').replace(/^["']|["']$/g, '').trim()
    if (!line) continue
    if (/^(here are|sure|certainly|of course|i['']ve|these are|below are)/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

function writeDiscoveryInsight(
  db: DatabaseClient,
  input: {
    projectId: string
    runId: string
    sessionId: string
    seedProvider: string
    result: ExecuteDiscoveryResult
  },
): void {
  const { buckets, competitorMap } = input.result
  const totalProbes = buckets.cited + buckets.aspirational + buckets['wasted-surface']
  if (totalProbes === 0) return

  const wastedRatio = buckets['wasted-surface'] / totalProbes
  const citedRatio = buckets.cited / totalProbes
  // High severity if competitors are cited far more than the project, or if
  // the project is missing from 70%+ of the discovered basket. Medium
  // otherwise — the insight always fires so the operator has something to
  // hand to Aero in PR 1, but only the "you've got real divergence" case
  // calls them off the desk.
  const severity = wastedRatio >= 0.4 || (buckets['wasted-surface'] > buckets.cited && wastedRatio >= 0.2)
    ? 'high'
    : citedRatio >= 0.6
      ? 'low'
      : 'medium'

  const topCompetitors = competitorMap.slice(0, 5)
  const title = buildDiscoveryInsightTitle({
    cited: buckets.cited,
    wasted: buckets['wasted-surface'],
    aspirational: buckets.aspirational,
    totalProbes,
  })

  db.insert(insights).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    runId: input.runId,
    type: 'discovery.basket-divergence',
    severity,
    title,
    // query/provider fields don't fit the visibility-snapshot model for a
    // session-level insight. Use the session marker so the
    // (query, provider) index stays distinct across sessions; PR 5 will
    // formalize a session-scoped insight subtype.
    query: `discovery:${input.sessionId}`,
    provider: input.seedProvider,
    recommendation: JSON.stringify({
      action: 'review-discovered-basket',
      summary: `Run \`canonry discover show ${input.sessionId} --format json\` to inspect the per-query breakdown, then \`canonry discover promote <project> ${input.sessionId}\` to merge the basket into the project.`,
      bucketCounts: buckets,
      topCompetitors,
    }),
    cause: JSON.stringify({
      sessionId: input.sessionId,
      totalProbes,
      seedProvider: input.seedProvider,
    }),
    dismissed: false,
    createdAt: new Date().toISOString(),
  }).run()
}

function buildDiscoveryInsightTitle(input: {
  cited: number
  wasted: number
  aspirational: number
  totalProbes: number
}): string {
  const parts: string[] = []
  parts.push(`Discovery probed ${input.totalProbes} representative queries`)
  if (input.wasted > 0) parts.push(`${input.wasted} where competitors are cited but you are not`)
  if (input.cited > 0) parts.push(`${input.cited} where you are cited`)
  if (input.aspirational > 0) parts.push(`${input.aspirational} aspirational greenfield queries`)
  return parts.join(' • ')
}

/** Re-export so the canonry-side has one place to import the orchestrator hook. */
export type { DiscoveryDeps, DiscoveryProjectContext, DiscoverySeedResult, DiscoveryProbeResult }

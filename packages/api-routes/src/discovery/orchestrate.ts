import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { discoveryProbes, discoverySessions } from '@ainyc/canonry-db'
import {
  CitationStates,
  DiscoveryBuckets,
  DiscoveryCompetitorTypes,
  DiscoverySessionStatuses,
  clusterByCosine,
  pickClusterRepresentative,
  type CitationState,
  type DiscoveryBucket,
  type DiscoveryCompetitorMapEntry,
  type DiscoveryCompetitorType,
  type LocationContext,
} from '@ainyc/canonry-contracts'

const DEFAULT_DEDUP_THRESHOLD = 0.85
const DEFAULT_MAX_PROBES = 100

/**
 * Per-session probe budget ceiling that the orchestrator will not exceed
 * regardless of the requested value. Mirrors `DISCOVERY_MAX_PROBES_CAP` in
 * contracts (kept here so a writer that imports the orchestrator alone still
 * gets the cap without round-tripping the request schema).
 */
const ABSOLUTE_MAX_PROBES = 500

export interface DiscoveryProjectContext {
  id: string
  name: string
  canonicalDomains: string[]
  competitorDomains: string[]
}

export interface DiscoverySeedResult {
  candidates: string[]
  /** Provider that generated the seed (recorded on `discovery_sessions.seedProvider`). */
  provider: string
}

export interface DiscoveryProbeResult {
  citationState: CitationState
  citedDomains: string[]
  rawResponse: Record<string, unknown>
}

/**
 * Maps each input domain to a `DiscoveryCompetitorType`. A domain the
 * classifier omits is treated as `unknown` by the orchestrator, so an
 * implementation may return a partial map.
 */
export type DiscoveryDomainClassification = Record<string, DiscoveryCompetitorType>

/**
 * Injection seam — canonry's side wires the real Gemini calls behind these.
 * Keeping the orchestrator pure of provider clients makes it easy to test
 * end-to-end without spinning up the network.
 */
export interface DiscoveryDeps {
  seed: (input: {
    project: DiscoveryProjectContext
    icpDescription: string
    /**
     * Resolved service-area locations for this session — empty when the
     * project has no locations configured (or when a deployment does not
     * resolve them). A location-aware seed implementation geographically
     * constrains the generated queries to these areas.
     */
    locations: LocationContext[]
  }) => Promise<DiscoverySeedResult>

  embed: (queries: string[]) => Promise<number[][]>

  probe: (input: {
    project: DiscoveryProjectContext
    query: string
  }) => Promise<DiscoveryProbeResult>

  /**
   * Classify every recurring cited domain into a `DiscoveryCompetitorType` in
   * a single call. Runs once per session after probing; `domains` is the
   * deduped non-canonical cited-domain set. Best-effort — the orchestrator
   * catches a thrown error and falls back to `unknown` for every domain, so a
   * classification outage degrades the competitor map rather than failing the
   * session.
   */
  classifyDomains: (input: {
    project: DiscoveryProjectContext
    icpDescription: string
    domains: string[]
  }) => Promise<DiscoveryDomainClassification>
}

export interface ExecuteDiscoveryOptions {
  db: DatabaseClient
  runId: string
  sessionId: string
  project: DiscoveryProjectContext
  icpDescription: string
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Resolved service-area locations for this session, forwarded to
   * `deps.seed` so seed generation can geo-constrain its queries. Omitted /
   * empty leaves seeding location-unaware (the pre-location behaviour).
   */
  locations?: LocationContext[]
  deps: DiscoveryDeps
}

export interface ExecuteDiscoveryResult {
  buckets: {
    cited: number
    aspirational: number
    'wasted-surface': number
  }
  competitorMap: DiscoveryCompetitorMapEntry[]
  seedCountRaw: number
  seedCount: number
  /** Echoed from the seed dep — recorded on `discovery_sessions.seedProvider`. */
  seedProvider: string
}

/**
 * Classify one probe into a bucket given the cited domains and the project
 * context. Exported so callers / tests can reproduce the classification
 * without spinning up the full orchestrator.
 *
 *  - `cited`           — one of the project's canonical/owned domains is cited
 *  - `wasted-surface`  — a configured competitor is cited but the project is not
 *  - `aspirational`    — neither the project nor a tracked competitor was cited
 *
 * Probes whose Gemini call returned no grounding at all (`citationState !=
 * 'cited'` AND no cited domains) still classify as `aspirational` — they
 * represent latent demand the project could go after even when nobody in
 * the tracked competitive set is ranking yet.
 */
export function classifyProbeBucket(input: {
  citationState: CitationState
  citedDomains: string[]
  project: DiscoveryProjectContext
}): DiscoveryBucket {
  const cited = new Set(input.citedDomains.map(d => d.toLowerCase()))
  const canonicalHit = input.project.canonicalDomains.some(d => cited.has(d.toLowerCase()))
  if (canonicalHit) return DiscoveryBuckets.cited

  const competitorHit = input.project.competitorDomains.some(d => cited.has(d.toLowerCase()))
  if (competitorHit) return DiscoveryBuckets['wasted-surface']

  return DiscoveryBuckets.aspirational
}

/**
 * Aggregate competitor domain hit counts across a set of probes. Each domain
 * counts at most once per probe (a single answer that lists the same domain
 * twice still counts as one hit for that probe). The project's canonical
 * domains are excluded.
 *
 * `classification` attaches a `competitorType` to each entry — a domain absent
 * from the map (or the whole argument omitted) falls back to `unknown`. The
 * orchestrator calls this once without classification to derive the domain
 * list, then again with the classification result.
 */
export function buildCompetitorMap(
  probes: Array<{ citedDomains: string[] }>,
  project: DiscoveryProjectContext,
  classification: DiscoveryDomainClassification = {},
): DiscoveryCompetitorMapEntry[] {
  const canonical = new Set(project.canonicalDomains.map(d => d.toLowerCase()))
  const counts = new Map<string, number>()
  for (const probe of probes) {
    const seenInProbe = new Set<string>()
    for (const raw of probe.citedDomains) {
      const domain = raw.toLowerCase()
      if (canonical.has(domain)) continue
      if (seenInProbe.has(domain)) continue
      seenInProbe.add(domain)
      counts.set(domain, (counts.get(domain) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([domain, hits]) => ({
      domain,
      hits,
      competitorType: classification[domain] ?? DiscoveryCompetitorTypes.unknown,
    }))
    .sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain))
}

/**
 * Best-effort wrapper around `deps.classifyDomains`. Skips the call entirely
 * when there are no domains, and swallows a thrown error into an empty map so
 * a classification outage degrades the competitor map (every domain stays
 * `unknown`) rather than failing the whole discovery session.
 */
async function classifyCompetitorDomains(
  deps: DiscoveryDeps,
  project: DiscoveryProjectContext,
  icpDescription: string,
  domains: string[],
): Promise<DiscoveryDomainClassification> {
  if (domains.length === 0) return {}
  try {
    return await deps.classifyDomains({ project, icpDescription, domains })
  } catch {
    return {}
  }
}

/**
 * Pick the canonicals (cluster representatives) from a list of seed candidates
 * by embedding and clustering at the configured threshold. Exported for tests
 * that want to validate the dedup behaviour without running the full pipeline.
 */
export async function pickCanonicals(
  candidates: string[],
  deps: { embed: DiscoveryDeps['embed'] },
  dedupThreshold: number,
): Promise<string[]> {
  if (candidates.length === 0) return []
  if (candidates.length === 1) return candidates
  const vectors = await deps.embed(candidates)
  const clusters = clusterByCosine(candidates, vectors, dedupThreshold)
  return clusters.map(pickClusterRepresentative)
}

/**
 * Run the full discovery pipeline against an existing `discovery_sessions`
 * row. The caller is responsible for creating the session row and the
 * matching `runs` row beforehand and for marking the run completed/failed
 * after this returns.
 *
 * Pipeline phases:
 *   1. `seeding`   — `deps.seed()` returns raw candidate queries
 *   2. `probing`   — embed + cluster + pick representative, then `deps.probe()`
 *                    each canonical, classify into a bucket, persist a row
 *   3. classify    — one `deps.classifyDomains()` call types every recurring
 *                    cited domain (best-effort; failures fall back to `unknown`)
 *   4. `completed` — write final counts + classified competitor_map to the session
 */
export async function executeDiscovery(opts: ExecuteDiscoveryOptions): Promise<ExecuteDiscoveryResult> {
  const dedupThreshold = opts.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD
  const requestedMax = opts.maxProbes ?? DEFAULT_MAX_PROBES
  const maxProbes = Math.min(Math.max(1, requestedMax), ABSOLUTE_MAX_PROBES)
  const startedAt = new Date().toISOString()

  opts.db
    .update(discoverySessions)
    .set({
      status: DiscoverySessionStatuses.seeding,
      dedupThreshold,
      startedAt,
    })
    .where(eq(discoverySessions.id, opts.sessionId))
    .run()

  const seedResult = await opts.deps.seed({
    project: opts.project,
    icpDescription: opts.icpDescription,
    locations: opts.locations ?? [],
  })

  const rawCandidates = dedupeStrings(seedResult.candidates)
  const seedCountRaw = rawCandidates.length

  const canonicals = await pickCanonicals(
    rawCandidates,
    { embed: opts.deps.embed },
    dedupThreshold,
  )

  const probedCanonicals = canonicals.slice(0, maxProbes)
  const seedCount = probedCanonicals.length

  opts.db
    .update(discoverySessions)
    .set({
      status: DiscoverySessionStatuses.probing,
      seedProvider: seedResult.provider,
      seedCountRaw,
      seedCount,
    })
    .where(eq(discoverySessions.id, opts.sessionId))
    .run()

  const probeRows: Array<{ citedDomains: string[]; bucket: DiscoveryBucket }> = []
  const buckets = { cited: 0, aspirational: 0, 'wasted-surface': 0 }

  for (const query of probedCanonicals) {
    const probe = await opts.deps.probe({ project: opts.project, query })
    const bucket = classifyProbeBucket({
      citationState: probe.citationState,
      citedDomains: probe.citedDomains,
      project: opts.project,
    })
    probeRows.push({ citedDomains: probe.citedDomains, bucket })
    buckets[bucket]++

    opts.db.insert(discoveryProbes).values({
      id: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.project.id,
      query,
      bucket,
      citationState: probe.citationState,
      citedDomains: probe.citedDomains,
      rawResponse: JSON.stringify(probe.rawResponse),
      createdAt: new Date().toISOString(),
    }).run()
  }

  // First pass derives the deduped non-canonical domain list; the
  // classification call types those domains; the second pass attaches the
  // result. Both passes are pure and O(probes) — cheap enough to run twice.
  const domains = buildCompetitorMap(probeRows, opts.project).map(entry => entry.domain)
  const classification = await classifyCompetitorDomains(
    opts.deps,
    opts.project,
    opts.icpDescription,
    domains,
  )
  const competitorMap = buildCompetitorMap(probeRows, opts.project, classification)

  opts.db
    .update(discoverySessions)
    .set({
      status: DiscoverySessionStatuses.completed,
      probeCount: probedCanonicals.length,
      citedCount: buckets.cited,
      aspirationalCount: buckets.aspirational,
      wastedCount: buckets['wasted-surface'],
      competitorMap,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(discoverySessions.id, opts.sessionId))
    .run()

  return {
    buckets,
    competitorMap,
    seedCountRaw,
    seedCount,
    seedProvider: seedResult.provider,
  }
}

/**
 * Mark a session as failed and record the error message. Used by the
 * canonry-side handler when the deps throw before the orchestrator reaches
 * its own status transitions.
 */
export function markSessionFailed(db: DatabaseClient, sessionId: string, error: string): void {
  db
    .update(discoverySessions)
    .set({
      status: DiscoverySessionStatuses.failed,
      error,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(discoverySessions.id, sessionId))
    .run()
}

function dedupeStrings(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

// Re-export to match how callers commonly want to reference the orchestrator's
// citation state vocabulary without pulling from a second module.
export { CitationStates }

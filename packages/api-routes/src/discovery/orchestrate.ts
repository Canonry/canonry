import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { discoveryProbes, discoverySessions, domainClassifications } from '@ainyc/canonry-db'
import { normalizeDomain } from '../content-data.js'
import {
  CitationStates,
  computeDedupSimilarityStats,
  type DedupSimilarityStats,
  DISCOVERY_DEFAULT_DEDUP_THRESHOLD,
  DISCOVERY_DEFAULT_PROBE_CONCURRENCY,
  DISCOVERY_PROBE_CONCURRENCY_CAP,
  DiscoveryBuckets,
  DiscoveryCompetitorTypes,
  DiscoverySessionStatuses,
  clusterByCosine,
  filterBrandedSeedCandidates,
  mapWithConcurrency,
  pickClusterRepresentative,
  seedCollapseWarning,
  type CitationState,
  type DiscoveryBucket,
  type DiscoveryCompetitorMapEntry,
  type DiscoveryCompetitorType,
  type LocationContext,
} from '@ainyc/canonry-contracts'

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
  /** Brand names (display name + aliases) used for answer-text mention matching,
   *  built via effectiveBrandNames. Distinct from canonicalDomains (the domain
   *  signal); both feed determineAnswerMentioned. Optional: a probe dep that does
   *  not compute mentions can omit it (the real Gemini dep always supplies it). */
  brandNames?: string[]
  canonicalDomains: string[]
  competitorDomains: string[]
}

export interface DiscoverySeedResult {
  candidates: string[]
  /** Provider label that generated the seed (recorded on
   *  `discovery_sessions.seedProvider`; a composite reads "gemini+openai"). */
  provider: string
  /** Raw candidate count contributed per provider (diagnostics). */
  providerCounts?: Record<string, number>
  /**
   * Diagnostics: how many of `candidates` came from the model's answer text.
   * Recorded on `discovery_sessions.seed_from_answer_count`. Optional — a seed
   * dep that does not track the split leaves the column null.
   */
  fromAnswerCount?: number
  /**
   * Diagnostics: how many of `candidates` came from the grounding fan-out (the
   * search queries the engine actually issued). Recorded on
   * `discovery_sessions.seed_from_grounding_count`. Optional, same as above.
   */
  fromGroundingCount?: number
}

export interface DiscoveryProbeResult {
  citationState: CitationState
  citedDomains: string[]
  /** Answer-text mention signal: whether the answer prose named the project
   *  (brand or domain). Computed by the probe dep from the answer text via the
   *  shared determineAnswerMentioned helper. Independent of citationState; the
   *  dep always has the answer text at probe time, so this is a real boolean. */
  answerMentioned: boolean
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
     * Who evaluates or buys the offering, separate from what is sold. When
     * present, a buyer-aware seed implementation anchors every generated query
     * on this buyer.
     */
    buyerDescription?: string
    /** Seed provider set (canonical order). Omitted/empty = Gemini-only. */
    seedProviders?: readonly string[]
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
    /**
     * Probe geo context: the session's FIRST resolved service area, rendered by
     * the provider exactly like a sweep location ("searching from City, Region,
     * Country"). Absent for location-free projects/sessions. Multi-location
     * probe fan-out is deliberate future work; one geo context per session
     * keeps probe cost flat.
     */
    location?: LocationContext
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
  /** Optional buyer definition forwarded verbatim to `deps.seed`. */
  buyerDescription?: string
  /** Seed provider set (canonical order), forwarded to `deps.seed`. */
  seedProviders?: string[]
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Bounded worker-pool width for the probe phase. Defaults to
   * `DISCOVERY_DEFAULT_PROBE_CONCURRENCY` (1 — strictly serial, the historical
   * behaviour); clamped to `DISCOVERY_PROBE_CONCURRENCY_CAP`. Regardless of the
   * value, probe rows are persisted in canonical order after the phase
   * completes, so concurrency changes wall-clock time only — never row order,
   * bucket counts, or failure semantics (the first probe error still fails the
   * session).
   */
  probeConcurrency?: number
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
  return (await pickCanonicalsWithStats(candidates, deps, dedupThreshold)).canonicals
}

/**
 * `pickCanonicals` plus the calibration diagnostics the threshold decision
 * needs (per-cluster cohesion, ambiguous-band pair fraction). One embed call
 * either way; the orchestrator persists the stats on the session.
 */
export async function pickCanonicalsWithStats(
  candidates: string[],
  deps: { embed: DiscoveryDeps['embed'] },
  dedupThreshold: number,
): Promise<{ canonicals: string[]; stats: DedupSimilarityStats }> {
  const emptyStats: DedupSimilarityStats = { perClusterMinSimilarity: [], bandPairFraction: null, pairsTotal: 0 }
  if (candidates.length === 0) return { canonicals: [], stats: emptyStats }
  if (candidates.length === 1) return { canonicals: candidates, stats: emptyStats }
  const vectors = await deps.embed(candidates)
  // Cluster INDICES so the similarity stats can address vectors per cluster;
  // representatives are picked from the mapped strings exactly as before.
  const indexClusters = clusterByCosine(candidates.map((_, i) => i), vectors, dedupThreshold)
  const canonicals = indexClusters.map((cluster) => pickClusterRepresentative(cluster.map((i) => candidates[i]!)))
  return { canonicals, stats: computeDedupSimilarityStats(vectors, indexClusters) }
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
  const dedupThreshold = opts.dedupThreshold ?? DISCOVERY_DEFAULT_DEDUP_THRESHOLD
  const requestedMax = opts.maxProbes ?? DEFAULT_MAX_PROBES
  const maxProbes = Math.min(Math.max(1, requestedMax), ABSOLUTE_MAX_PROBES)
  const probeConcurrency = Math.min(
    Math.max(1, Math.floor(opts.probeConcurrency ?? DISCOVERY_DEFAULT_PROBE_CONCURRENCY)),
    DISCOVERY_PROBE_CONCURRENCY_CAP,
  )
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
    buyerDescription: opts.buyerDescription,
    seedProviders: opts.seedProviders,
    locations: opts.locations ?? [],
  })

  // Seed hygiene: drop branded self-queries BEFORE seedCountRaw is recorded.
  // Ordering is load-bearing — live sessions carried 37-60% brand share, and
  // counting the branded mass in the denominator would deflate the retention
  // ratio and false-trip collapse guards downstream. The drop count is
  // persisted as a diagnostic; the prompt-side no-brand rule makes the drop
  // small, this filter is the deterministic backstop.
  const { kept: unbrandedCandidates, droppedBranded } = filterBrandedSeedCandidates({
    candidates: seedResult.candidates,
    brandNames: opts.project.brandNames ?? [],
    canonicalDomains: opts.project.canonicalDomains,
  })

  const rawCandidates = dedupeStrings(unbrandedCandidates)
  const seedCountRaw = rawCandidates.length

  const { canonicals, stats: dedupStats } = await pickCanonicalsWithStats(
    rawCandidates,
    { embed: opts.deps.embed },
    dedupThreshold,
  )

  // Degenerate-collapse guard, measured BEFORE the probe-budget slice so a
  // deliberately small maxProbes never reads as a clustering failure. The
  // session still runs to completion; the warning tells the operator its
  // coverage is suspect.
  const warning = seedCollapseWarning({
    seedCountRaw,
    canonicalCount: canonicals.length,
    dedupThreshold,
  })

  const probedCanonicals = canonicals.slice(0, maxProbes)
  const seedCount = probedCanonicals.length

  opts.db
    .update(discoverySessions)
    .set({
      status: DiscoverySessionStatuses.probing,
      seedProvider: seedResult.provider,
      seedCountRaw,
      seedCount,
      // Seed-source diagnostics (answer text vs. grounding fan-out). Null when
      // the seed dep does not report the split. Not consumed by any gate.
      seedFromAnswerCount: seedResult.fromAnswerCount ?? null,
      seedFromGroundingCount: seedResult.fromGroundingCount ?? null,
      seedBrandFilteredCount: droppedBranded.length,
      // Full seed provenance + dedup calibration diagnostics: the raw
      // candidate list (as the seed dep returned it, pre-filter) makes every
      // live session a replayable fixture; the similarity stats are the data
      // the 0.95-threshold decision was missing. No gate reads any of these.
      seedRawCandidates: seedResult.candidates,
      seedProviders: opts.seedProviders ?? null,
      seedProviderCounts: seedResult.providerCounts ?? null,
      dedupClusterMinSims: dedupStats.perClusterMinSimilarity,
      dedupBandPairFraction: dedupStats.bandPairFraction,
      dedupPairsTotal: dedupStats.pairsTotal,
      warning,
    })
    .where(eq(discoverySessions.id, opts.sessionId))
    .run()

  // Probe phase — a bounded worker pool (width `probeConcurrency`, default 1 =
  // the historical serial loop). Results land in an array indexed by canonical
  // position, so completion order never leaks into output order. The first
  // probe rejection fails the whole session exactly as the serial loop did:
  // remaining workers stop claiming queries, in-flight probes settle, and the
  // error propagates to the caller (which marks the session failed). Nothing
  // is persisted for a failed probe phase.
  // Geo: probes measure from the buyer's location, not from nowhere. The
  // session's first resolved service area is the probe context (sweeps use the
  // same provider mechanism); location-free sessions probe exactly as before.
  const probeLocation = opts.locations?.[0]
  const probeResults = await mapWithConcurrency(
    probedCanonicals,
    probeConcurrency,
    query => opts.deps.probe({ project: opts.project, query, location: probeLocation }),
  )

  const probeRows: Array<{ citedDomains: string[]; bucket: DiscoveryBucket }> = []
  const buckets = { cited: 0, aspirational: 0, 'wasted-surface': 0 }

  // `created_at` is stamped monotonically in canonical order (base + index ms)
  // so a created_at-ordered read reproduces the display order even when the
  // pool finished probes out of order. Bucket counters are order-independent.
  const insertBaseMs = Date.now()
  const rowsToInsert = probeResults.map((probe, index) => {
    const bucket = classifyProbeBucket({
      citationState: probe.citationState,
      citedDomains: probe.citedDomains,
      project: opts.project,
    })
    probeRows.push({ citedDomains: probe.citedDomains, bucket })
    buckets[bucket]++
    return {
      id: crypto.randomUUID(),
      sessionId: opts.sessionId,
      projectId: opts.project.id,
      query: probedCanonicals[index]!,
      bucket,
      citationState: probe.citationState,
      answerMentioned: probe.answerMentioned,
      citedDomains: probe.citedDomains,
      rawResponse: JSON.stringify(probe.rawResponse),
      createdAt: new Date(insertBaseMs + index).toISOString(),
    }
  })

  // One transaction, rows inserted in canonical order — insertion (rowid)
  // order and created_at order agree, keeping unordered `.all()` reads stable.
  if (rowsToInsert.length > 0) {
    opts.db.transaction((tx) => {
      for (const values of rowsToInsert) {
        tx.insert(discoveryProbes).values(values).run()
      }
    })
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

  // Mirror the classified competitor map into the durable, per-domain
  // `domain_classifications` table so the content winnabilityClass gate can read a
  // domain's class without re-running discovery. Upsert keyed (projectId,
  // domain); last write wins. Normalized with the same helper the content data
  // layer uses for cited grounding domains so write-key == read-key.
  upsertDomainClassifications(opts.db, opts.project.id, opts.sessionId, competitorMap)

  return {
    buckets,
    competitorMap,
    seedCountRaw,
    seedCount,
    seedProvider: seedResult.provider,
  }
}

/**
 * Upsert a session's classified competitor map into the durable
 * `domain_classifications` table, one row per `(projectId, domain)`. Each
 * domain is normalized so the key matches the content data layer's cited
 * grounding domains. Last write wins; an `unknown` re-classification can
 * overwrite a prior type — acceptable since the latest discovery is the most
 * current view. Best-effort and additive, consistent with the surrounding
 * non-transactional probe loop.
 */
export function upsertDomainClassifications(
  db: Pick<DatabaseClient, 'insert'>,
  projectId: string,
  sessionId: string,
  competitorMap: DiscoveryCompetitorMapEntry[],
): void {
  if (competitorMap.length === 0) return
  const now = new Date().toISOString()
  for (const entry of competitorMap) {
    const domain = normalizeDomain(entry.domain)
    if (!domain) continue
    db.insert(domainClassifications)
      .values({
        id: crypto.randomUUID(),
        projectId,
        domain,
        competitorType: entry.competitorType,
        hits: entry.hits,
        sessionId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [domainClassifications.projectId, domainClassifications.domain],
        set: {
          competitorType: entry.competitorType,
          hits: entry.hits,
          sessionId,
          updatedAt: now,
        },
      })
      .run()
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

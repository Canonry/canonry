import crypto from 'node:crypto'
import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  discoveryProbes,
  discoverySessions,
  queries,
  runs,
} from '@ainyc/canonry-db'
import {
  DEFAULT_DISCOVERY_PROMOTE_BUCKETS,
  DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES,
  DISCOVERY_PROMOTE_COMPETITOR_CAP,
  DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS,
  DiscoveryBuckets,
  DiscoveryCompetitorTypes,
  DiscoveryPromoteCompetitorSkipReasons,
  DiscoverySessionStatuses,
  RunKinds,
  RunStatuses,
  RunTriggers,
  aggregateHarvestedQueries,
  applyHarvestSemanticNovelty,
  buildHarvestAnchorTerms,
  citationStateSchema,
  competitorAliasProjectIdentity,
  competitorDomainProjectClaim,
  describeCompetitorAliasRejection,
  discoveryBucketSchema,
  discoveryPromoteRequestSchema,
  discoveryRunRequestSchema,
  effectiveDomains,
  gateHarvestedSearchQueries,
  hostOf,
  normalizeCompetitorDomain,
  notFound,
  orderLocationsDefaultFirst,
  resolveLocations,
  validationError,
  type DiscoveryBucket,
  type DiscoveryCompetitorMapEntry,
  type CompetitorAliasMarketPin,
  type CompetitorAliasProjectIdentity,
  type DiscoveryCompetitorType,
  type DiscoveryHarvestDto,
  type DiscoveryProbeDto,
  type DiscoveryPromoteCompetitor,
  type DiscoveryPromotePreview,
  type DiscoveryPromoteResult,
  type DiscoveryPromoteSkippedCompetitor,
  type DiscoverySessionDetailDto,
  type DiscoverySessionDto,
  type DiscoverySessionStatus,
  type LocationContext,
} from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from '../helpers.js'
import { pruneQualifiedAliasesForCompetitors } from '../projects.js'
import {
  claimedCompetitorAdds,
  competitorAliasAuditFields,
  readStoredCompetitors,
  syncCompetitorSet,
  type StoredCompetitor,
} from '../competitor-writes.js'
import { readMarketCompetitorPins } from '../plan-competitors.js'

/**
 * Fired after a `discovery_sessions` row + matching `runs` row are inserted
 * but BEFORE the response is sent. Canonry-side handler runs the orchestrator
 * in the background, writes the bucket-divergence insight, and triggers the
 * run-coordinator. Cloud deployments may leave this unset, in which case the
 * POST endpoint returns `MISSING_DEPENDENCY` rather than silently dropping
 * the request on the floor.
 */
export type OnDiscoveryRunRequested = (input: {
  runId: string
  sessionId: string
  projectId: string
  icpDescription: string
  /** Optional buyer definition, forwarded to the seed prompt. */
  buyerDescription?: string
  /** Seed provider set (canonical order; null/omitted = Gemini-only). */
  seedProviders?: string[]
  dedupThreshold?: number
  maxProbes?: number
  /**
   * Requested probe worker-pool width. Omitted = the orchestrator default
   * (1, strictly serial); the orchestrator clamps to
   * `DISCOVERY_PROBE_CONCURRENCY_CAP`.
   */
  probeConcurrency?: number
  /**
   * Resolved service-area locations for this session — every project
   * location, or the subset named by the request's `locations` override.
   * Empty when the project has no locations configured. Forwarded to the
   * seed generator so discovered queries stay inside the service area.
   */
  locations: LocationContext[]
}) => void

/**
 * Provider-agnostic seam for reading the issued *search queries* (fan-out) back
 * out of a stored probe `raw_response`. Discovery persists the full provider
 * payload on each `discovery_probes` row, but extracting the issued queries from
 * it is provider-shaped (Gemini `groundingMetadata.webSearchQueries`, OpenAI
 * `web_search_call.action.queries`, Claude `server_tool_use` input). The
 * canonry-side wires this to the matching provider adapter's extractor so this
 * route stays free of any provider import. When unset (e.g. a deployment that
 * never wired it), the harvest endpoint returns an empty candidate set rather
 * than failing — there is simply nothing to read back. Issue #713.
 */
export type HarvestSearchQueries = (input: {
  /** The session's seed provider (discovery is Gemini-only today). */
  provider: string
  rawResponse: Record<string, unknown>
}) => string[]

/**
 * Embed a batch of query strings into vectors for the harvest's semantic
 * novelty pass. The canonry side wires this to the Gemini embedder (the same
 * model the discovery seed pipeline uses); a deployment without an embedder may
 * leave it unset, in which case harvest novelty falls back to exact-match only.
 * Rejecting (e.g. no API key) is treated the same as unset — the route degrades
 * gracefully rather than failing the read.
 */
export type EmbedQueries = (queries: string[]) => Promise<number[][]>

export interface DiscoveryRoutesOptions {
  onDiscoveryRunRequested?: OnDiscoveryRunRequested
  harvestSearchQueries?: HarvestSearchQueries
  embedQueries?: EmbedQueries
  /** See `CompetitorRoutesOptions.onCompetitorAliasesChanged`; fired when a promote changes stored aliases. */
  onCompetitorAliasesChanged?: (projectId: string, projectName: string) => void
}

/**
 * Upper bound on the age of an in-flight discovery session that the route
 * will consolidate onto. Rows in `queued`/`seeding`/`probing` older than
 * this are presumed abandoned — the canonry-side handler was killed
 * (process restart, OOM, SIGKILL) before its catch block in `discovery-run`
 * could call `markSessionFailed`, leaving the row stuck. Without this guard
 * every subsequent `discover run` for the same (project, ICP) would
 * consolidate onto the zombie and never produce results. 2 hours is well
 * above the orchestrator's realistic max runtime (~90 min for 500 probes at
 * ~10s/probe + seed + classify), so a slow-but-still-running orchestrator
 * is never falsely abandoned. The stale row itself is left untouched so an
 * operator can inspect it via `canonry discover list`.
 */
const MAX_INFLIGHT_DISCOVERY_AGE_MS = 2 * 60 * 60 * 1000

export async function discoveryRoutes(app: FastifyInstance, opts: DiscoveryRoutesOptions) {
  // POST /projects/:name/discover/run — kick off a discovery session
  app.post<{
    Params: { name: string }
    Body: { icpDescription?: string; buyerDescription?: string; seedProviders?: string[]; dedupThreshold?: number; maxProbes?: number; probeConcurrency?: number; locations?: string[] }
  }>('/projects/:name/discover/run', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = discoveryRunRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid discovery run request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    // Resolve ICP: explicit body > stored on project. If neither is present,
    // surface a validation error early — the orchestrator can't seed without
    // an ICP description.
    const icpDescription = parsed.data.icpDescription?.trim() || (project.icpDescription ?? '').trim()
    if (!icpDescription) {
      throw validationError(
        'icpDescription is required. Pass it in the request body or store it on the project (spec.icpDescription).',
      )
    }

    // An explicit ['gemini'] is the same semantics as the omitted default, so
    // normalize it to null: both identities consolidate together and legacy
    // rows (null) match either form.
    const requestedSeedProviders = parsed.data.seedProviders ?? null
    const seedProviders =
      requestedSeedProviders && !(requestedSeedProviders.length === 1 && requestedSeedProviders[0] === 'gemini')
        ? requestedSeedProviders
        : null

    // Resolve the session's service areas: every project location, or the
    // subset named by `locations`. An unknown label throws validationError.
    // The project's defaultLocation leads the list so probes (locations[0])
    // measure from the same geo a sweep would, not from config order.
    const locations = orderLocationsDefaultFirst(
      resolveLocations(project.locations, parsed.data.locations),
      project.defaultLocation,
    )

    if (!opts.onDiscoveryRunRequested) {
      throw validationError('Discovery is not available on this deployment.', {
        reason: 'no-discovery-handler',
      })
    }

    const now = new Date().toISOString()

    // The lookup + insert run inside one transaction so two concurrent
    // discover-run requests for the same ICP can't both miss the dedup check
    // and start parallel sessions. SQLite serializes writers via the WAL —
    // the second request blocks on the lock, then observes the first
    // request's row and returns its IDs. Issue #498.
    const ageFloorIso = new Date(Date.now() - MAX_INFLIGHT_DISCOVERY_AGE_MS).toISOString()
    const decision = app.db.transaction((tx) => {
      // `gte(createdAt, ageFloorIso)` keeps zombie rows from being reused.
      // `orderBy desc` makes the choice deterministic when both a stale row
      // and a fresh row exist for the same (project, ICP) — we always
      // consolidate onto the newest match.
      const existing = tx
        .select({ id: discoverySessions.id, runId: discoverySessions.runId })
        .from(discoverySessions)
        .where(and(
          eq(discoverySessions.projectId, project.id),
          eq(discoverySessions.icpDescription, icpDescription),
          // Buyer is part of session identity: it changes the seed prompt's
          // semantics, so a request with a different (or no) buyer must start
          // its own session, never adopt another buyer's probes.
          parsed.data.buyerDescription == null
            ? isNull(discoverySessions.buyerDescription)
            : eq(discoverySessions.buyerDescription, parsed.data.buyerDescription),
          // Locations are identity too: a different service-area subset seeds
          // and probes a different geo, so it must never reuse another geo's
          // session. resolveLocations is deterministic (project-config order),
          // so equal subsets always serialize identically. Legacy in-flight
          // rows (pre-91) carry NULL: on a NO-location project that geo is
          // unambiguous (always []), so NULL matches; on a project WITH
          // locations a NULL row's subset is unknowable, so it conservatively
          // never reuses — a one-time, bounded (2h window) non-reuse after
          // upgrade, never a wrong reuse.
          locations.length === 0
            ? or(isNull(discoverySessions.locations), eq(discoverySessions.locations, locations))
            : eq(discoverySessions.locations, locations),
          // Seed provider set is identity: a different phrasing distribution
          // must never reuse another set's session. Null (= Gemini-only
          // default, including explicit ['gemini']) matches legacy rows.
          seedProviders == null
            ? isNull(discoverySessions.seedProviders)
            : eq(discoverySessions.seedProviders, seedProviders),
          inArray(discoverySessions.status, [
            DiscoverySessionStatuses.queued,
            DiscoverySessionStatuses.seeding,
            DiscoverySessionStatuses.probing,
          ]),
          gte(discoverySessions.createdAt, ageFloorIso),
        ))
        .orderBy(desc(discoverySessions.createdAt))
        .get()

      // An in-flight session without a runId would be a legacy row from before
      // the route always wrote one — treat it as not-reusable so the caller
      // gets a real, kickoffable session.
      if (existing && existing.runId) {
        return { reused: true as const, sessionId: existing.id, runId: existing.runId }
      }

      const sessionId = crypto.randomUUID()
      const runId = crypto.randomUUID()

      tx.insert(discoverySessions).values({
        id: sessionId,
        projectId: project.id,
        runId,
        status: DiscoverySessionStatuses.queued,
        icpDescription,
        buyerDescription: parsed.data.buyerDescription ?? null,
        seedProviders,
        locations,
        dedupThreshold: parsed.data.dedupThreshold,
        competitorMap: [],
        createdAt: now,
      }).run()

      tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['aeo-discover-probe'],
        status: RunStatuses.queued,
        trigger: RunTriggers.manual,
        createdAt: now,
      }).run()

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'discovery.created',
        entityType: 'discovery_session',
        entityId: sessionId,
      })

      return { reused: false as const, sessionId, runId }
    })

    if (decision.reused) {
      // Nothing was inserted; do not fire the orchestrator callback again.
      // The caller's `dedupThreshold` / `maxProbes` / `probeConcurrency` are
      // intentionally dropped — the in-flight session was already started with
      // its own config and changing it mid-flight would silently corrupt the run.
      // `buyerDescription` is NOT dropped: it is part of the consolidation
      // identity above, so a reused session always has the caller's buyer.
      return reply.status(200).send({
        runId: decision.runId,
        sessionId: decision.sessionId,
        status: 'running',
        consolidated: true,
      })
    }

    opts.onDiscoveryRunRequested({
      runId: decision.runId,
      sessionId: decision.sessionId,
      projectId: project.id,
      icpDescription,
      buyerDescription: parsed.data.buyerDescription,
      seedProviders: seedProviders ?? undefined,
      dedupThreshold: parsed.data.dedupThreshold,
      maxProbes: parsed.data.maxProbes,
      probeConcurrency: parsed.data.probeConcurrency,
      locations,
    })

    return reply.status(201).send({
      runId: decision.runId,
      sessionId: decision.sessionId,
      status: 'running',
      consolidated: false,
    })
  })

  // GET /projects/:name/discover/sessions — list sessions for a project
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/projects/:name/discover/sessions',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const parsedLimit = parseInt(request.query.limit ?? '', 10)
      const limit = Number.isNaN(parsedLimit) || parsedLimit <= 0 ? 50 : parsedLimit

      const rows = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.projectId, project.id))
        .orderBy(desc(discoverySessions.createdAt))
        .limit(limit)
        .all()

      return reply.send(rows.map(serializeSession))
    },
  )

  // GET /projects/:name/discover/sessions/:id — single session with probes
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/discover/sessions/:id',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const session = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.id, request.params.id))
        .get()
      if (!session || session.projectId !== project.id) {
        throw notFound('Discovery session', request.params.id)
      }

      const probeRows = app.db
        .select()
        .from(discoveryProbes)
        .where(eq(discoveryProbes.sessionId, session.id))
        .all()

      const detail: DiscoverySessionDetailDto = {
        ...serializeSession(session),
        probes: probeRows.map(serializeProbe),
      }
      return reply.send(detail)
    },
  )

  // GET /projects/:name/discover/sessions/:id/harvest — read the issued search
  // queries (Gemini's grounding fan-out) back out of the session's stored probe
  // payloads, gate them for buyer-intent + novelty, and return the survivors as
  // candidate seeds for the operator/agent to review. Read-only and derived: it
  // never probes, tracks, or promotes anything — the harvest is a third signal
  // (issued retrieval queries), distinct from mention and citation. Issue #713.
  app.get<{
    Params: { name: string; id: string }
    Querystring: { minProbeHits?: string; anchor?: string }
  }>(
    '/projects/:name/discover/sessions/:id/harvest',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const session = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.id, request.params.id))
        .get()
      if (!session || session.projectId !== project.id) {
        throw notFound('Discovery session', request.params.id)
      }

      // minProbeHits: recurrence floor (default 1). anchor: apply the subject
      // anchor (default true; pass anchor=false to disable for new-subject
      // discovery on a well-scoped project).
      const parsedFloor = parseInt(request.query.minProbeHits ?? '', 10)
      const minProbeHits = Number.isNaN(parsedFloor) || parsedFloor < 1 ? 1 : parsedFloor
      const applyAnchor = request.query.anchor !== 'false'
      const provider = session.seedProvider ?? 'gemini'

      const probeRows = app.db
        .select()
        .from(discoveryProbes)
        .where(eq(discoveryProbes.sessionId, session.id))
        .all()

      const extract = opts.harvestSearchQueries
      const probesWithQueries = probeRows.map((row) => {
        if (!extract || !row.rawResponse) return { searchQueries: [] as string[] }
        try {
          const raw = JSON.parse(row.rawResponse) as Record<string, unknown>
          return { searchQueries: extract({ provider, rawResponse: raw }) }
        } catch {
          // A malformed/legacy payload contributes no candidates rather than
          // failing the whole harvest.
          return { searchQueries: [] as string[] }
        }
      })

      const trackedQueries = app.db
        .select({ query: queries.query })
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
        .map(r => r.query)

      // Anchor on the labels of every domain the project owns in addition to
      // ICP + tracked queries: a thin/new project has few tracked terms and a
      // terse ICP — exactly where the fan-out's off-subject acronym collisions
      // peak — so the always-present domain labels keep the anchor engaged where
      // it is needed most. Owned domains (not just the canonical one) matter: an
      // abstract canonical brand with a descriptive owned domain still yields
      // real subject terms, which is what keeps the anchor from over-dropping
      // on-subject candidates (issue #713).
      const anchorTerms = buildHarvestAnchorTerms(
        [session.icpDescription ?? '', ...trackedQueries],
        effectiveDomains(project),
      )

      const aggregated = aggregateHarvestedQueries(probesWithQueries)
      let result = gateHarvestedSearchQueries({
        candidates: aggregated,
        trackedQueries,
        anchorTerms,
        minProbeHits,
        applyAnchor,
      })

      // Semantic novelty: drop candidates that are paraphrases/synonyms of a
      // tracked query (lexical exact-match can't see those). One batch embed of
      // the survivors + tracked queries, then a cosine comparison reusing the
      // discovery pipeline's calibrated threshold. Best-effort — if embeddings
      // are unwired or unavailable (no key), novelty degrades to exact-match.
      let semanticNoveltyApplied = false
      if (opts.embedQueries && result.admitted.length > 0 && trackedQueries.length > 0) {
        try {
          const candidateTexts = result.admitted.map(c => c.query)
          const vectors = await opts.embedQueries([...candidateTexts, ...trackedQueries])
          if (vectors.length === candidateTexts.length + trackedQueries.length) {
            result = applyHarvestSemanticNovelty({
              result,
              candidateVectors: vectors.slice(0, candidateTexts.length),
              trackedVectors: vectors.slice(candidateTexts.length),
            })
            semanticNoveltyApplied = true
          }
        } catch {
          // Embeddings unavailable — keep the lexical result, novelty falls back
          // to exact-match only. semanticNoveltyApplied stays false.
        }
      }

      const harvest: DiscoveryHarvestDto = {
        sessionId: session.id,
        projectId: project.id,
        provider,
        status: session.status as DiscoverySessionStatus,
        minProbeHits,
        anchorApplied: result.anchorApplied,
        semanticNoveltyApplied,
        candidates: result.admitted,
        stats: result.stats,
      }
      return reply.send(harvest)
    },
  )

  // GET /projects/:name/discover/sessions/:id/promote — show the promotion
  // payload the POST would persist. Read-only, so the operator can preview
  // the bucketed basket before running `canonry discover promote`.
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/discover/sessions/:id/promote',
    async (request, reply) => {
      const project = resolveProject(app.db, request.params.name)
      const session = app.db
        .select()
        .from(discoverySessions)
        .where(eq(discoverySessions.id, request.params.id))
        .get()
      if (!session || session.projectId !== project.id) {
        throw notFound('Discovery session', request.params.id)
      }
      const probeRows = app.db
        .select()
        .from(discoveryProbes)
        .where(eq(discoveryProbes.sessionId, session.id))
        .all()
      const cited = new Set<string>()
      const aspirational = new Set<string>()
      const wasted = new Set<string>()
      for (const probe of probeRows) {
        const bucket = probe.bucket
        if (!bucket) continue
        if (bucket === DiscoveryBuckets.cited) cited.add(probe.query)
        else if (bucket === DiscoveryBuckets.aspirational) aspirational.add(probe.query)
        else if (bucket === DiscoveryBuckets['wasted-surface']) wasted.add(probe.query)
      }

      // Preview surfaces every recurring candidate regardless of type: each
      // entry carries its `competitorType` (a default-promoted type wins when
      // any of its hosts has one) so the operator can see what promote adopts
      // by default (direct-competitor) vs. what needs an explicit
      // `--competitor-types` override. The same plan as the POST, so the
      // skipped entries and their reasons match what a promote leaves out.
      const promotion = planCompetitorPromotion({
        competitorMap: parseCompetitorMap(session.competitorMap),
        probes: probeRows,
        tracked: readStoredCompetitors(app.db, project.id),
        project: competitorAliasProjectIdentity(project),
        marketPins: readMarketCompetitorPins(app.db, project.id),
      })

      const preview: DiscoveryPromotePreview = {
        sessionId: session.id,
        projectId: project.id,
        queriesByBucket: {
          cited: Array.from(cited).sort(),
          aspirational: Array.from(aspirational).sort(),
          'wasted-surface': Array.from(wasted).sort(),
        },
        suggestedCompetitors: promotion.promote,
        skippedCompetitors: promotion.skipped,
        status: session.status as DiscoverySessionStatus,
      }
      return reply.send(preview)
    },
  )

  // POST /projects/:name/discover/sessions/:id/promote — adopt a completed
  // session's bucketed queries (and, by default, recurring discovered
  // competitor domains) into the project's tracked basket. Add-only and idempotent:
  // queries/domains already tracked land in `skipped`, never inserted twice,
  // so re-running a promote is safe.
  app.post<{
    Params: { name: string; id: string }
    Body: { buckets?: string[]; includeCompetitors?: boolean; competitorTypes?: string[] }
  }>('/projects/:name/discover/sessions/:id/promote', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const session = app.db
      .select()
      .from(discoverySessions)
      .where(eq(discoverySessions.id, request.params.id))
      .get()
    if (!session || session.projectId !== project.id) {
      throw notFound('Discovery session', request.params.id)
    }

    const parsed = discoveryPromoteRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError('Invalid discovery promote request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    // Status gate — bucket assignments are not final until the session
    // completes, so promoting a queued/seeding/probing/failed session would
    // adopt a half-built (or empty) basket.
    if (session.status !== DiscoverySessionStatuses.completed) {
      throw validationError(
        `Discovery session is "${session.status}" — only completed sessions can be promoted.`,
        { status: session.status },
      )
    }

    const buckets: readonly DiscoveryBucket[] = parsed.data.buckets ?? DEFAULT_DISCOVERY_PROMOTE_BUCKETS
    const bucketSet = new Set<DiscoveryBucket>(buckets)
    const includeCompetitors = parsed.data.includeCompetitors ?? true
    // Default to direct-competitor only — aggregators, editorial media, and
    // `other` are noise for a tracked-competitor watchlist, and legacy
    // `unknown` entries are excluded until the caller opts them in explicitly.
    const competitorTypes: readonly DiscoveryCompetitorType[] =
      parsed.data.competitorTypes ?? DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES

    // Candidate queries: probes whose bucket is in the requested set.
    const probeRows = app.db
      .select()
      .from(discoveryProbes)
      .where(eq(discoveryProbes.sessionId, session.id))
      .all()
    const candidateQueries = new Set<string>()
    for (const probe of probeRows) {
      if (!probe.bucket) continue
      const bucket = discoveryBucketSchema.safeParse(probe.bucket)
      if (bucket.success && bucketSet.has(bucket.data)) candidateQueries.add(probe.query)
    }

    // Promotion is add-only and idempotent. Dedupe case-insensitively against
    // the existing basket so re-running a promote — or promoting a query that
    // only differs in casing from a tracked one — never creates near-dupes.
    const existingQueries = new Set(
      app.db
        .select({ query: queries.query })
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
        .map(r => r.query.toLowerCase()),
    )
    const promotedQueries: string[] = []
    const skippedQueries: string[] = []
    for (const query of Array.from(candidateQueries).sort()) {
      if (existingQueries.has(query.toLowerCase())) {
        skippedQueries.push(query)
      } else {
        promotedQueries.push(query)
        existingQueries.add(query.toLowerCase())
      }
    }

    // Mirror the GET preview's recurrence + cap policy, narrowed to the
    // requested competitor types; already-tracked domains, the project's own
    // site, ambiguous shared hosts and domains another competitor's alias
    // claims are returned as skipped with a reason instead of being inserted.
    const competitorPromotion: CompetitorPromotion = includeCompetitors
      ? planCompetitorPromotion({
          competitorMap: parseCompetitorMap(session.competitorMap),
          probes: probeRows,
          tracked: readStoredCompetitors(app.db, project.id),
          project: competitorAliasProjectIdentity(project),
          marketPins: readMarketCompetitorPins(app.db, project.id),
          competitorTypes,
        })
      : { promote: [], skipped: [] }
    const promotedCompetitors = competitorPromotion.promote.map(entry => entry.domain)
    const skippedCompetitors = competitorPromotion.skipped.map(entry => entry.domain)
    const heldCompetitors = competitorPromotion.skipped
      .filter(entry => entry.reason !== DiscoveryPromoteCompetitorSkipReasons['already-tracked'])
      .map(entry => ({ domain: entry.domain, reason: entry.reason }))

    const provenance = `discovery:${session.id}`
    const now = new Date().toISOString()

    let competitorAliasesChanged = false
    if (promotedQueries.length > 0 || promotedCompetitors.length > 0) {
      competitorAliasesChanged = app.db.transaction((tx) => {
        for (const query of promotedQueries) {
          tx.insert(queries).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            query,
            provenance,
            createdAt: now,
          }).run()
        }
        // The shared competitor writer, under the same rules as a REST add.
        // Domains another competitor's alias claims were left out above, so
        // this write only fails if the stored competitors changed meanwhile.
        const competitorPlan = promotedCompetitors.length
          ? syncCompetitorSet(tx, project.id, promotedCompetitors.map(domain => ({ domain })), {
              replace: false,
              project: competitorAliasProjectIdentity(project),
              now,
              provenance,
            })
          : null
        const droppedQualifiedAliases = promotedCompetitors.length
          ? pruneQualifiedAliasesForCompetitors(tx, project.id, now)
          : []
        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'discovery.promoted',
          entityType: 'discovery_session',
          entityId: session.id,
          diff: {
            queries: promotedQueries,
            competitors: promotedCompetitors,
            ...(heldCompetitors.length ? { skippedCompetitors: heldCompetitors } : {}),
            ...(competitorPlan ? competitorAliasAuditFields(competitorPlan) : {}),
            ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
          },
        })
        return (competitorPlan?.aliasChanges.length ?? 0) > 0
      })
    }
    if (competitorAliasesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)

    const result: DiscoveryPromoteResult = {
      sessionId: session.id,
      projectId: project.id,
      promoted: { queries: promotedQueries, competitors: promotedCompetitors },
      skipped: { queries: skippedQueries, competitors: skippedCompetitors },
      competitorDetails: { promoted: competitorPromotion.promote, skipped: competitorPromotion.skipped },
    }
    return reply.send(result)
  })
}

function serializeSession(row: typeof discoverySessions.$inferSelect): DiscoverySessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as DiscoverySessionStatus,
    icpDescription: row.icpDescription ?? null,
    seedProvider: row.seedProvider ?? null,
    seedCountRaw: row.seedCountRaw ?? null,
    seedCount: row.seedCount ?? null,
    seedFromAnswerCount: row.seedFromAnswerCount ?? null,
    seedFromGroundingCount: row.seedFromGroundingCount ?? null,
    seedBrandFilteredCount: row.seedBrandFilteredCount ?? null,
    buyerDescription: row.buyerDescription ?? null,
    locations: row.locations ?? null,
    seedRawCandidates: row.seedRawCandidates ?? null,
    seedProviders: row.seedProviders ?? null,
    seedProviderCounts: row.seedProviderCounts ?? null,
    canonicalCount: row.canonicalCount ?? null,
    dedupClusterMinSims: row.dedupClusterMinSims ?? null,
    dedupBandPairFraction: row.dedupBandPairFraction ?? null,
    dedupPairsTotal: row.dedupPairsTotal ?? null,
    dedupThreshold: row.dedupThreshold ?? null,
    probeCount: row.probeCount ?? null,
    citedCount: row.citedCount ?? null,
    aspirationalCount: row.aspirationalCount ?? null,
    wastedCount: row.wastedCount ?? null,
    competitorMap: parseCompetitorMap(row.competitorMap),
    warning: row.warning ?? null,
    error: row.error ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
  }
}

function serializeProbe(row: typeof discoveryProbes.$inferSelect): DiscoveryProbeDto {
  const bucketParsed = row.bucket ? discoveryBucketSchema.safeParse(row.bucket) : null
  const stateParsed = citationStateSchema.safeParse(row.citationState)
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId,
    query: row.query,
    bucket: bucketParsed?.success ? bucketParsed.data : null,
    citationState: stateParsed.success ? stateParsed.data : 'not-cited',
    citedDomains: row.citedDomains,
    // Boolean-mode column already reads back as boolean | null; a legacy row
    // written before the column is null (unknown), never coerced to false.
    answerMentioned: row.answerMentioned ?? null,
    createdAt: row.createdAt,
  }
}

/**
 * Normalize a `discovery_sessions.competitor_map` value. Drizzle JSON-mode
 * deserializes the column for us, but a competitor map persisted before
 * classification existed has entries without `competitorType` — normalize
 * those to `unknown` here so every consumer sees a well-formed
 * `DiscoveryCompetitorMapEntry`.
 */
function parseCompetitorMap(
  raw: ReadonlyArray<Partial<DiscoveryCompetitorMapEntry> & { domain: string; hits: number }>,
): DiscoveryCompetitorMapEntry[] {
  return raw.map(entry => ({
    domain: entry.domain,
    hits: entry.hits,
    competitorType: entry.competitorType ?? DiscoveryCompetitorTypes.unknown,
  }))
}

interface CompetitorPromotion {
  promote: DiscoveryPromoteCompetitor[]
  skipped: DiscoveryPromoteSkippedCompetitor[]
}

/**
 * The session's cited hosts grouped into competitors: one group per
 * registrable domain (`normalizeCompetitorDomain`, the form every competitor
 * write stores). A group's `hits` counts each probe citing any of its hosts
 * once; a session whose probe rows do not list them (a hand-built fixture)
 * falls back to the busiest host's count, which never counts a probe twice.
 * Its `competitorType` is its lead host's: a host whose type is in `preferred`
 * first, then the most hits, so the preview names the type the default
 * promote matches.
 */
function groupCompetitorMap(
  competitorMap: readonly DiscoveryCompetitorMapEntry[],
  probes: readonly { citedDomains: readonly string[] }[],
  preferred: ReadonlySet<DiscoveryCompetitorType>,
): DiscoveryPromoteCompetitor[] {
  const sourcesByDomain = new Map<string, DiscoveryCompetitorMapEntry[]>()
  const domainByHost = new Map<string, string>()
  for (const entry of competitorMap) {
    const domain = normalizeCompetitorDomain(entry.domain.trim())
    if (!domain) continue
    sourcesByDomain.set(domain, [...(sourcesByDomain.get(domain) ?? []), entry])
    domainByHost.set(entry.domain.toLowerCase(), domain)
  }
  const probeHits = new Map<string, number>()
  for (const probe of probes) {
    const domains = new Set(probe.citedDomains.flatMap((host) => {
      const domain = domainByHost.get(host.toLowerCase())
      return domain ? [domain] : []
    }))
    for (const domain of domains) probeHits.set(domain, (probeHits.get(domain) ?? 0) + 1)
  }
  return [...sourcesByDomain.entries()].map(([domain, entries]) => {
    const sources = [...entries].sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain))
    const lead = sources.find(source => preferred.has(source.competitorType)) ?? sources[0]!
    const busiest = sources[0]!.hits
    return {
      domain,
      hits: sources.length === 1 ? busiest : Math.max(busiest, probeHits.get(domain) ?? 0),
      competitorType: lead.competitorType,
      sources,
    }
  })
}

/**
 * The competitors a promote adds and the eligible ones it leaves out, with
 * the reason. Eligible means recurring (`DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS`
 * probes cite it) and, when `competitorTypes` is given, any of its hosts
 * classified as one of them. Cited hosts are grouped into the registrable
 * domain every competitor write stores before the threshold and the cap
 * apply, so `offers.rival.example` promotes as `rival.example` and later
 * reaches every by-domain route. An eligible competitor is skipped when:
 *
 * - it is already tracked under any spelling (`already-tracked`);
 * - it is the project's own site, a subdomain of it or a parent of an owned
 *   domain (`project-domain`), since it would count every project citation;
 * - it was cited as two or more different subdomains (`shared-host`), which
 *   may be different sites on one blog or site-builder host, so they are
 *   never merged silently;
 * - its domain name overlaps another competitor's curated alias, or the
 *   label or a curated alias of a competitor an Advanced market pins
 *   (`claimed-by-alias`), the rule a REST add enforces with a 400.
 *
 * The cap (`DISCOVERY_PROMOTE_COMPETITOR_CAP`) counts promoted competitors
 * only, highest hits first.
 */
function planCompetitorPromotion(input: {
  competitorMap: readonly DiscoveryCompetitorMapEntry[]
  probes: readonly { citedDomains: readonly string[] }[]
  tracked: readonly StoredCompetitor[]
  project: CompetitorAliasProjectIdentity
  /** `readMarketCompetitorPins` for the project. */
  marketPins: readonly CompetitorAliasMarketPin[]
  competitorTypes?: readonly DiscoveryCompetitorType[]
}): CompetitorPromotion {
  const typeFilter = input.competitorTypes ? new Set(input.competitorTypes) : null
  const preferred = new Set<DiscoveryCompetitorType>(input.competitorTypes ?? DEFAULT_DISCOVERY_PROMOTE_COMPETITOR_TYPES)
  const eligible = groupCompetitorMap(input.competitorMap, input.probes, preferred)
    .filter(group => group.hits >= DISCOVERY_PROMOTE_COMPETITOR_MIN_HITS)
    .filter(group => !typeFilter || group.sources.some(source => typeFilter.has(source.competitorType)))
    .sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain))

  const tracked = new Set(input.tracked.map(row => normalizeCompetitorDomain(row.domain)))
  const skipped: DiscoveryPromoteSkippedCompetitor[] = []
  const candidates: DiscoveryPromoteCompetitor[] = []
  for (const group of eligible) {
    const projectDomain = competitorDomainProjectClaim(group.domain, input.project.domains)
    const subdomains = [...new Set(group.sources.map(source => hostOf(source.domain) ?? source.domain))]
      .filter(host => host !== group.domain)
    if (projectDomain) {
      skipped.push({
        ...group,
        reason: DiscoveryPromoteCompetitorSkipReasons['project-domain'],
        message: `${group.domain} overlaps the project domain ${projectDomain}, so every citation of the project would count for it`,
      })
    } else if (tracked.has(group.domain)) {
      skipped.push({ ...group, reason: DiscoveryPromoteCompetitorSkipReasons['already-tracked'], message: `${group.domain} is already tracked` })
    } else if (subdomains.length > 1) {
      skipped.push({
        ...group,
        reason: DiscoveryPromoteCompetitorSkipReasons['shared-host'],
        message: `${group.domain} was cited as ${subdomains.length} different subdomains (${subdomains.join(', ')}), which may be different sites on one shared host, so it is not merged into one competitor; if they are one competitor, add it with canonry competitor add <project> ${group.domain}`,
      })
    } else {
      candidates.push(group)
    }
  }

  const claimed = claimedCompetitorAdds(input.tracked, candidates.map(group => group.domain), input.project, input.marketPins)
  const promote: DiscoveryPromoteCompetitor[] = []
  for (const group of candidates) {
    const rejections = claimed.get(group.domain)
    if (rejections) {
      skipped.push({
        ...group,
        reason: DiscoveryPromoteCompetitorSkipReasons['claimed-by-alias'],
        message: rejections.map(rejection => `${group.domain} ${describeCompetitorAliasRejection(rejection)}`).join('; '),
      })
    } else if (promote.length < DISCOVERY_PROMOTE_COMPETITOR_CAP) {
      promote.push(group)
    }
  }
  return { promote, skipped }
}

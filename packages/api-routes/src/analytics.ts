import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { filterTrackedSnapshots, groupRunsByCreatedAt, pickGroupRepresentative, querySnapshots, runs, queries, competitors, domainClassifications, parseJsonColumn } from '@ainyc/canonry-db'
import {
  AI_PROVIDER_INFRA_DOMAINS, brandLabelFromDomain, categorizeSource, categoryLabel, CitationStates,
  classifySurfaceFromCategory, surfaceClassFromCompetitorType, surfaceClassLabel,
  effectiveDomains, evaluateModelPointerExposure, normalizeProjectDomain, parseWindow, RunKinds, RunStatuses,
  windowCutoff, validationError,
} from '@ainyc/canonry-contracts'
import type {
  BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto,
  TimeBucket, TrendDirection, GapQuery, GapCategory,
  SourceCategory, SourceCategoryCount, ProviderMetric, QueryChangeEvent,
  RankedSourceList, SourceRankEntry, SurfaceClass, SurfaceClassCount, ModelEvidenceState,
  ModelExposureWindow, ModelPointerChangeDisclosure, ModelServiceMismatch,
} from '@ainyc/canonry-contracts'
import { buildMentionShare } from '@ainyc/canonry-intelligence'
import { notProbeRun, resolveProject, resolveSnapshotAnswerMentioned } from './helpers.js'
import { buildModelAttribution, buildServedModelAttribution } from './analytics-model-attribution.js'
import {
  classifyModelEvidence, classifyServedModelEvidence, modelEvidenceMismatched, type ModelEvidenceValue,
} from './model-evidence.js'

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /projects/:name/analytics/metrics — citation rate trends
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/metrics', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    const projectRuns = app.db
      .select()
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        notProbeRun(),
        cutoff ? gte(runs.createdAt, cutoff) : undefined,
      ))
      .orderBy(desc(runs.createdAt))
      .all()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    if (projectRuns.length === 0) {
      return reply.send({
        window,
        buckets: [],
        overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
        byProvider: {},
        trend: 'stable',
        mentionTrend: 'stable',
        queryChanges: [],
        modelAttribution: {},
        servedModelAttribution: {},
        modelServiceMismatch: {},
        modelPointerChanges: {},
      } satisfies BrandMetricsDto)
    }

    const runIds = projectRuns.map(r => r.id)
    // Orphan snapshots (queryId NULL post-v58 — see schema.ts) can't be
    // grouped by query; drop them at load so downstream `byQuery` keys stay
    // valid `string`s.
    const rawSnapshots = filterTrackedSnapshots(app.db
      .select({
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        servedModel: querySnapshots.servedModel,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, runIds))
      .all())

    // Resolve answerMentioned for each snapshot (handles null/legacy data)
    const runCreatedAt = new Map(projectRuns.map(run => [run.id, run.createdAt]))
    const allSnapshots = rawSnapshots.map(s => ({
      ...s,
      runCreatedAt: runCreatedAt.get(s.runId)!,
      resolvedMentioned: resolveSnapshotAnswerMentioned(s, project),
    }))

    // Fetch query creation dates for normalization
    const projectQueries = app.db
      .select({ id: queries.id, createdAt: queries.createdAt })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const queryCreatedAt = new Map(projectQueries.map(q => [q.id, q.createdAt]))
    const mentionShareCompetitors = app.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, project.id))
      .all()
      .map(c => ({
        domain: c.domain,
        brandTokens: [brandLabelFromDomain(c.domain)].filter(t => t.length >= 3),
      }))

    // Overall metrics
    const overall = computeProviderMetric(allSnapshots)

    // Per-provider metrics
    const byProvider: Record<string, ProviderMetric> = {}
    const providers = new Set(allSnapshots.map(s => s.provider))
    for (const p of providers) {
      byProvider[p] = computeProviderMetric(allSnapshots.filter(s => s.provider === p))
    }

    // Time buckets — size based on actual data span, not the selected window
    const earliest = new Date(projectRuns[0]!.createdAt)
    const latest = new Date(projectRuns[projectRuns.length - 1]!.createdAt)
    const spanDays = Math.max(1, Math.ceil((latest.getTime() - earliest.getTime()) / 86_400_000))
    const bucketSize = bucketSizeForSpan(spanDays)
    const buckets = computeBuckets(allSnapshots, projectRuns, bucketSize, queryCreatedAt, mentionShareCompetitors)

    // Model observations are evidence, not configuration. To avoid a false
    // "first seen" transition at the start of a bounded window, anchor each
    // in-window provider to its latest pre-cutoff logical sweep. Provider
    // absence remains absent evidence rather than a fabricated unknown state,
    // and an anchor-derived transition is reported with the anchor's own
    // observation time so a consumer dates it to the range between the two
    // sweeps instead of claiming it happened inside the window.
    const anchors: Record<string, ModelEvidenceState> = {}
    const anchorObservedAt: Record<string, string> = {}
    const anchorUnavailable = new Set<string>()
    // The served series anchors independently: a pre-window sweep can observe a
    // provider while carrying no served id at all (it predates capture), and
    // that is an absent observation, not an anchor.
    const servedAnchors: Record<string, ModelEvidenceState> = {}
    const servedAnchorObservedAt: Record<string, string> = {}
    const servedAnchorUnavailable = new Set<string>()
    const windowProviders = new Set(allSnapshots.map(snapshot => snapshot.provider))
    if (cutoff && windowProviders.size > 0) {
      // Narrow to this project's runs FIRST (`idx_runs_project`), then read
      // snapshots by run id (`idx_snapshots_run`). Selecting snapshots by
      // provider instead makes SQLite scan the whole `idx_snapshots_provider_model`
      // partition — every project, all history — plus a temp b-tree sort, which
      // blocks the synchronous driver for hundreds of ms per provider. This
      // shape is index-driven by construction, so it does not depend on the
      // planner having ANALYZE statistics.
      const anchorRunPredicate = and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        notProbeRun(),
        lt(runs.createdAt, cutoff),
      )
      // Walk pre-window logical sweeps newest-first and stop as soon as every
      // in-window provider is anchored — normally the first sweep. The bound is
      // a sweep count, not a calendar span, so it scales with the project's own
      // cadence instead of silently dropping a real change on a slow-sweeping
      // project. Reading every pre-cutoff run's snapshots up front would be
      // read amplification: only the newest sweep observing a provider matters.
      const anchorSweepTimes = app.db
        .selectDistinct({ createdAt: runs.createdAt })
        .from(runs)
        .where(anchorRunPredicate)
        .orderBy(desc(runs.createdAt))
        // One past the bound: the extra row only answers "is there more history
        // beyond the bound?", so a project with exactly the bound's worth of
        // sweeps is reported as conclusive rather than as maybe-truncated.
        .limit(ANCHOR_SWEEP_SCAN_LIMIT + 1)
        .all()
        .map(row => row.createdAt)
      const anchorScanTruncated = anchorSweepTimes.length > ANCHOR_SWEEP_SCAN_LIMIT
      if (anchorScanTruncated) anchorSweepTimes.length = ANCHOR_SWEEP_SCAN_LIMIT

      if (anchorSweepTimes.length > 0) {
        const anchorRuns = app.db
          .select({ id: runs.id, createdAt: runs.createdAt })
          .from(runs)
          .where(and(anchorRunPredicate, gte(runs.createdAt, anchorSweepTimes[anchorSweepTimes.length - 1]!)))
          .all()
        // Same-timestamp `--all-locations` runs collapse into one logical sweep.
        const runIdsBySweep = new Map<string, string[]>()
        for (const run of anchorRuns) {
          const ids = runIdsBySweep.get(run.createdAt) ?? []
          ids.push(run.id)
          runIdsBySweep.set(run.createdAt, ids)
        }

        const pending = new Set(windowProviders)
        const servedPending = new Set(windowProviders)
        // The served anchor rides the sweeps the configured search already
        // visits — it never extends the scan. Widening the walk until every
        // provider has a SERVED anchor would make each request read all
        // `ANCHOR_SWEEP_SCAN_LIMIT` sweeps for the whole rollout period, since
        // pre-capture sweeps can never satisfy it. A served anchor the visited
        // sweeps did not supply is reported as unavailable, not invented.
        let visitedSweeps = 0
        for (const observedAt of anchorSweepTimes) {
          if (pending.size === 0) break
          visitedSweeps += 1
          const runIds = runIdsBySweep.get(observedAt)
          if (!runIds || runIds.length === 0) continue

          const modelsByProvider = new Map<string, ModelEvidenceValue[]>()
          const servedByProvider = new Map<string, string[]>()
          for (const snapshot of filterTrackedSnapshots(app.db
            .select({
              queryId: querySnapshots.queryId,
              provider: querySnapshots.provider,
              model: querySnapshots.model,
              servedModel: querySnapshots.servedModel,
            })
            .from(querySnapshots)
            .where(inArray(querySnapshots.runId, runIds))
            .all())) {
            if (pending.has(snapshot.provider)) {
              const models = modelsByProvider.get(snapshot.provider) ?? []
              models.push(snapshot.model)
              modelsByProvider.set(snapshot.provider, models)
            }
            const servedModel = snapshot.servedModel?.trim()
            if (servedModel && servedPending.has(snapshot.provider)) {
              const servedModels = servedByProvider.get(snapshot.provider) ?? []
              servedModels.push(servedModel)
              servedByProvider.set(snapshot.provider, servedModels)
            }
          }

          for (const [provider, models] of modelsByProvider) {
            anchors[provider] = classifyModelEvidence(models)
            anchorObservedAt[provider] = observedAt
            pending.delete(provider)
          }
          for (const [provider, servedModels] of servedByProvider) {
            servedAnchors[provider] = classifyServedModelEvidence(servedModels)
            servedAnchorObservedAt[provider] = observedAt
            servedPending.delete(provider)
          }
        }

        // Only a bound we actually hit is inconclusive. Exhausting a project's
        // shorter history means the provider truly has no pre-window evidence.
        if (anchorScanTruncated) {
          for (const provider of pending) anchorUnavailable.add(provider)
        }
        // Served history is inconclusive whenever pre-window sweeps remained
        // unread — either the scan bound cut them off, or the configured search
        // stopped early and never looked at them.
        if (anchorScanTruncated || visitedSweeps < anchorSweepTimes.length) {
          for (const provider of servedPending) servedAnchorUnavailable.add(provider)
        }
      }
    }
    const modelAttribution = buildModelAttribution({
      observations: allSnapshots.map(snapshot => ({
        runId: snapshot.runId,
        runCreatedAt: snapshot.runCreatedAt,
        provider: snapshot.provider,
        model: snapshot.model,
      })),
      anchors,
      anchorObservedAt,
      anchorUnavailable,
      bucketStartFor: observedAt => bucketStartDateFor(observedAt, earliest, bucketSize),
    })

    // The served series is built from the SAME sweeps but only from snapshots
    // that carry a served id. Dropping the rest before grouping is what makes
    // the two series independent: a window entirely predating capture produces
    // `{}` here and leaves `modelAttribution` byte-identical to what it was
    // before served capture existed.
    const servedModelAttribution = buildServedModelAttribution({
      observations: allSnapshots.flatMap(snapshot => {
        const servedModel = snapshot.servedModel?.trim()
        if (!servedModel) return []
        return [{
          runId: snapshot.runId,
          runCreatedAt: snapshot.runCreatedAt,
          provider: snapshot.provider,
          model: servedModel,
        }]
      }),
      anchors: servedAnchors,
      anchorObservedAt: servedAnchorObservedAt,
      anchorUnavailable: servedAnchorUnavailable,
      bucketStartFor: observedAt => bucketStartDateFor(observedAt, earliest, bucketSize),
    })

    // Where both series have a known latest state and they name different
    // top-level models, the provider substituted something else for what the
    // project configured. A dated snapshot of the configured model is
    // agreement and never lands here.
    const modelServiceMismatch: Record<string, ModelServiceMismatch> = {}
    for (const [provider, served] of Object.entries(servedModelAttribution)) {
      const configured = modelAttribution[provider]?.latestObservation
      if (!configured) continue
      if (!modelEvidenceMismatched(configured.state, served.latestObservation.state)) continue
      modelServiceMismatch[provider] = {
        observedAt: served.latestObservation.observedAt,
        configured: configured.state,
        served: served.latestObservation.state,
      }
    }

    // Some model ids are not models: the provider re-points them at whatever it
    // is currently serving, and the response echoes the same id back on both
    // sides of the swap. No amount of served-model capture can see that, so the
    // only honest move is to check the sweeps that produced these numbers
    // against a dated record of known changes and disclose the overlap.
    //
    // The period is per-provider and comes from the DATA, not the requested
    // window: it is the span of sweeps that actually contributed, which is the
    // same period `byProvider` is computed over, so the caveat and the number it
    // sits under always describe the same stretch of time.
    //
    // Within that period each model id gets its OWN first/last-seen span, taken
    // from the sweeps that observed it. Crossing "every id seen in the period"
    // with "the period" would caveat a project for a change to an id it had
    // already stopped running, and stay silent for the mirror case — a project
    // is only affected by a change that happened while it was on that id.
    const modelPointerChanges: Record<string, ModelPointerChangeDisclosure> = {}
    interface PointerScope { exposures: Map<string, ModelExposureWindow>; start: string; end: string }
    const pointerScopeByProvider = new Map<string, PointerScope>()
    for (const snapshot of allSnapshots) {
      const scope = pointerScopeByProvider.get(snapshot.provider)
        ?? { exposures: new Map<string, ModelExposureWindow>(), start: snapshot.runCreatedAt, end: snapshot.runCreatedAt }
      if (snapshot.runCreatedAt < scope.start) scope.start = snapshot.runCreatedAt
      if (snapshot.runCreatedAt > scope.end) scope.end = snapshot.runCreatedAt
      // Configured AND served: a project can configure a fixed id while the
      // provider serves a moving one, and either side being a moving id exposes
      // the number. Each is timestamped by the sweep that observed it.
      for (const modelId of [snapshot.model?.trim(), snapshot.servedModel?.trim()]) {
        if (!modelId) continue
        const key = modelId.toLowerCase()
        const seen = scope.exposures.get(key)
        if (!seen) {
          scope.exposures.set(key, { modelId, firstSeen: snapshot.runCreatedAt, lastSeen: snapshot.runCreatedAt })
          continue
        }
        if (snapshot.runCreatedAt < seen.firstSeen) seen.firstSeen = snapshot.runCreatedAt
        if (snapshot.runCreatedAt > seen.lastSeen) seen.lastSeen = snapshot.runCreatedAt
      }
      pointerScopeByProvider.set(snapshot.provider, scope)
    }
    for (const [provider, scope] of pointerScopeByProvider) {
      const exposure = evaluateModelPointerExposure({
        exposures: scope.exposures.values(),
        periodStart: scope.start,
        periodEnd: scope.end,
      })
      // A provider on fixed model ids is omitted. The other two states are both
      // carried: "we know of no change" is a different answer from "you are not
      // exposed", and collapsing them is what would let a stale list read as
      // safety on a surface.
      if (exposure.status === 'not-exposed') continue
      modelPointerChanges[provider] = exposure
    }

    // Trends
    const trend = computeTrend(buckets, 'citationRate')
    const mentionTrend = computeTrend(buckets, 'mentionRate')

    // Query change annotations
    const queryChanges = computeQueryChanges(projectQueries, cutoff)

    return reply.send({ window, buckets, overall, byProvider, trend, mentionTrend, queryChanges, modelAttribution, servedModelAttribution, modelServiceMismatch, modelPointerChanges } satisfies BrandMetricsDto)
  })

  // GET /projects/:name/analytics/gaps — brand gap analysis
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/gaps', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    // Find the latest completed-or-partial fan-out group. Multi-location
    // `--all-locations` sweeps share `createdAt`; the group is the unit and
    // classification reads snapshots across all locations in it. The single
    // `runId` returned in the response is the deterministic representative
    // (id DESC tiebreak) so callers get a stable id. See #480.
    // Only `answer-visibility` runs carry query snapshots — a newer sync run
    // (traffic/gsc/ga/gbp/backlinks/site-audit) would otherwise become "latest"
    // and classify an empty snapshot set.
    const completedRuns = app.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
    const latestGroup = groupRunsByCreatedAt(completedRuns)[0] ?? []
    const latestGroupRunIds = latestGroup.map(r => r.id)
    const latestRun = pickGroupRepresentative(latestGroup)

    if (!latestRun) {
      return reply.send({ cited: [], gap: [], uncited: [], mentionedQueries: [], mentionGap: [], notMentioned: [], runId: '', window } satisfies GapAnalysisDto)
    }

    // All sweep runs in window (for consistency signal)
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(runs.createdAt)
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    const windowRunIds = windowRuns.map(r => r.id)
    // Map runId → createdAt so we can key consistency sets by time-point
    // instead of by raw runId. Under `--all-locations` fan-out, a single
    // time-point has N runs (one per location); keying by runId would
    // double-count the same time-point N times for multi-location projects.
    // See #480.
    const runIdToCreatedAt = new Map(windowRuns.map(r => [r.id, r.createdAt]))

    // Consistency: for each query, count how many *time-points* cited/mentioned it
    const consistencyMap = new Map<string, { citedRuns: Set<string>; totalRuns: Set<string>; mentionedRuns: Set<string> }>()
    if (windowRunIds.length > 0) {
      const allWindowSnaps = filterTrackedSnapshots(app.db
        .select({
          queryId: querySnapshots.queryId,
          runId: querySnapshots.runId,
          citationState: querySnapshots.citationState,
          answerMentioned: querySnapshots.answerMentioned,
          answerText: querySnapshots.answerText,
        })
        .from(querySnapshots)
        .where(inArray(querySnapshots.runId, windowRunIds))
        .all())

      for (const s of allWindowSnaps) {
        const timePoint = runIdToCreatedAt.get(s.runId) ?? s.runId
        let entry = consistencyMap.get(s.queryId)
        if (!entry) {
          entry = { citedRuns: new Set(), totalRuns: new Set(), mentionedRuns: new Set() }
          consistencyMap.set(s.queryId, entry)
        }
        // A query is "cited at a time-point" if ANY snapshot in any of the
        // fanned-out runs at that timestamp is cited. Same for mentions.
        entry.totalRuns.add(timePoint)
        if (s.citationState === CitationStates.cited) entry.citedRuns.add(timePoint)
        if (resolveSnapshotAnswerMentioned(s, project)) entry.mentionedRuns.add(timePoint)
      }
    }

    // Latest-run snapshots (determines classification). Skip orphans
    // (queryId NULL) since byQuery keys must stay non-null.
    const rawSnapshots = filterTrackedSnapshots(app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        provider: querySnapshots.provider,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        competitorOverlap: querySnapshots.competitorOverlap,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, latestGroupRunIds))
      .all())

    // Resolve answer mentions
    const snapshots = rawSnapshots.map(s => ({
      ...s,
      resolvedMentioned: resolveSnapshotAnswerMentioned(s, project),
    }))

    // Group by query
    const byQuery = new Map<string, typeof snapshots>()
    for (const s of snapshots) {
      const key = s.queryId
      const arr = byQuery.get(key)
      if (arr) arr.push(s)
      else byQuery.set(key, [s])
    }

    const cited: GapQuery[] = []
    const gap: GapQuery[] = []
    const uncited: GapQuery[] = []
    const mentionedQueries: GapQuery[] = []
    const mentionGap: GapQuery[] = []
    const notMentioned: GapQuery[] = []

    for (const [queryId, qSnapshots] of byQuery) {
      const query = qSnapshots[0]?.query ?? ''
      const citedProviders = qSnapshots
        .filter(s => s.citationState === CitationStates.cited)
        .map(s => s.provider)
      const mentionedProviders = qSnapshots
        .filter(s => s.resolvedMentioned)
        .map(s => s.provider)
      const competitorsCiting = new Set<string>()
      for (const s of qSnapshots) {
        const overlap = s.competitorOverlap
        for (const c of overlap) competitorsCiting.add(c)
      }

      const cons = consistencyMap.get(queryId)
      const consistency = {
        citedRuns: cons?.citedRuns.size ?? 0,
        totalRuns: cons?.totalRuns.size ?? 0,
        mentionedRuns: cons?.mentionedRuns.size ?? 0,
      }

      // Citation-based classification (existing)
      let category: GapCategory
      if (citedProviders.length > 0) {
        category = 'cited'
      } else if (competitorsCiting.size > 0) {
        category = 'gap'
      } else {
        category = 'uncited'
      }

      const citationEntry: GapQuery = {
        query, queryId, category,
        providers: citedProviders,
        competitorsCiting: [...competitorsCiting],
        consistency,
      }

      if (category === 'cited') cited.push(citationEntry)
      else if (category === 'gap') gap.push(citationEntry)
      else uncited.push(citationEntry)

      // Answer-mention classification (new)
      let mentionCategory: GapCategory
      if (mentionedProviders.length > 0) {
        mentionCategory = 'cited'
      } else if (competitorsCiting.size > 0) {
        mentionCategory = 'gap'
      } else {
        mentionCategory = 'uncited'
      }

      const mentionEntry: GapQuery = {
        query, queryId, category: mentionCategory,
        providers: mentionedProviders,
        competitorsCiting: [...competitorsCiting],
        consistency,
      }

      if (mentionCategory === 'cited') mentionedQueries.push(mentionEntry)
      else if (mentionCategory === 'gap') mentionGap.push(mentionEntry)
      else notMentioned.push(mentionEntry)
    }

    // Sort: gap by most competitors, cited/uncited alphabetically
    gap.sort((a, b) => b.competitorsCiting.length - a.competitorsCiting.length)
    cited.sort((a, b) => a.query.localeCompare(b.query))
    uncited.sort((a, b) => a.query.localeCompare(b.query))
    mentionGap.sort((a, b) => b.competitorsCiting.length - a.competitorsCiting.length)
    mentionedQueries.sort((a, b) => a.query.localeCompare(b.query))
    notMentioned.sort((a, b) => a.query.localeCompare(b.query))

    return reply.send({ cited, gap, uncited, mentionedQueries, mentionGap, notMentioned, runId: latestRun.id, window } satisfies GapAnalysisDto)
  })

  // GET /projects/:name/analytics/sources — source origin breakdown.
  // `?limit=N` caps the ranked / per-provider lists to the top N domains
  // (with an explicit long-tail rollup); omitted = the full ranked list.
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; limit?: string }
  }>('/projects/:name/analytics/sources', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const window = parseWindow(request.query.window)
    const cutoff = windowCutoff(window)

    let limit: number | null = null
    if (request.query.limit !== undefined) {
      const n = Number(request.query.limit)
      if (!Number.isInteger(n) || n <= 0) throw validationError('"limit" must be a positive integer')
      limit = n
    }

    // Deterministic classification context — own/competitor membership is read
    // from already-stored project data, so the per-domain surface class costs
    // no LLM calls (see #675 / surface-class.ts).
    const classifyCtx = {
      projectDomains: effectiveDomains(project),
      competitorDomains: app.db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
        .map(r => r.domain),
    }

    // Stored LLM classifications from discovery (`domain_classifications`, #677)
    // enrich recall for domains the generic allow-list would dump into `other`
    // (niche OTAs, regional media). Keyed by normalized domain; own/competitor
    // still win over a stored row (see classifySurfaceFromCategory precedence).
    // No new LLM calls — this reads what discovery already persisted.
    const storedSurfaceClasses = new Map<string, SurfaceClass>()
    for (const row of app.db
      .select({ domain: domainClassifications.domain, competitorType: domainClassifications.competitorType })
      .from(domainClassifications)
      .where(eq(domainClassifications.projectId, project.id))
      .all()) {
      const mapped = surfaceClassFromCompetitorType(row.competitorType)
      if (mapped) storedSurfaceClasses.set(normalizeProjectDomain(row.domain), mapped)
    }

    // All sweep runs in window
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => !cutoff || r.createdAt >= cutoff)

    if (windowRuns.length === 0) {
      return reply.send({
        overall: [], byQuery: {},
        ranked: buildRankedList(new Map(), limit),
        byProvider: {},
        runId: '', window, limit,
      } satisfies SourceBreakdownDto)
    }

    // Pick the deterministic representative of the latest fan-out group as
    // the single `runId` for the response. windowRunIds still includes every
    // run in the window — per-query consistency aggregation operates on the
    // full window so multi-location and single-location callers see the same
    // shape. See #480.
    const latestGroup = groupRunsByCreatedAt(windowRuns)[0] ?? []
    const latestRunId = pickGroupRepresentative(latestGroup)?.id ?? windowRuns[0]!.id
    const windowRunIds = windowRuns.map(r => r.id)

    const snapshots = app.db
      .select({
        queryId: querySnapshots.queryId,
        query: queries.query,
        provider: querySnapshots.provider,
        rawResponse: querySnapshots.rawResponse,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, windowRunIds))
      .all()

    // Aggregate sources overall and per-query (legacy category breakdown), plus
    // a flat per-domain aggregation overall and per provider (the #675 ranked /
    // classified / per-provider surface). Probes are already excluded because
    // windowRunIds derives from the notProbeRun()-filtered run query above.
    const overallCounts = new Map<SourceCategory, Map<string, number>>()
    const byQuery: Record<string, SourceCategoryCount[]> = {}
    const overallDomains = new Map<string, DomainAgg>()
    const providerDomains = new Map<string, Map<string, DomainAgg>>()

    for (const snap of snapshots) {
      const sources = parseGroundingSources(snap.rawResponse)
      const qCounts = new Map<SourceCategory, Map<string, number>>()

      for (const source of sources) {
        const { category, label, domain } = categorizeSource(source.uri)
        const surfaceClass = classifySurfaceFromCategory(
          domain, category, classifyCtx, storedSurfaceClasses.get(normalizeProjectDomain(domain)),
        )

        // Overall (legacy category breakdown)
        if (!overallCounts.has(category)) overallCounts.set(category, new Map())
        const oDomains = overallCounts.get(category)!
        oDomains.set(domain, (oDomains.get(domain) ?? 0) + 1)

        // Per-query (legacy category breakdown)
        if (!qCounts.has(category)) qCounts.set(category, new Map())
        const qDomains = qCounts.get(category)!
        qDomains.set(domain, (qDomains.get(domain) ?? 0) + 1)

        // Flat ranked + classified — overall and per provider
        bumpDomain(overallDomains, domain, category, label, surfaceClass)
        let pm = providerDomains.get(snap.provider)
        if (!pm) { pm = new Map(); providerDomains.set(snap.provider, pm) }
        bumpDomain(pm, domain, category, label, surfaceClass)
      }

      if (sources.length > 0 && snap.query) {
        byQuery[snap.query] = buildCategoryCounts(qCounts)
      }
    }

    const overall = buildCategoryCounts(overallCounts)
    const ranked = buildRankedList(overallDomains, limit)
    const byProvider: Record<string, RankedSourceList> = {}
    for (const [provider, domains] of providerDomains) {
      byProvider[provider] = buildRankedList(domains, limit)
    }

    return reply.send({ overall, byQuery, ranked, byProvider, runId: latestRunId, window, limit } satisfies SourceBreakdownDto)
  })
}

interface DomainAgg {
  domain: string
  count: number
  category: SourceCategory
  label: string
  surfaceClass: SurfaceClass
}

// --- Helpers ---

/**
 * How many pre-window logical sweeps the model-evidence anchor search may walk
 * before giving up on a provider. This bounds reads, not semantics: the search
 * stops at the first sweep observing each provider, so the common case is one
 * sweep. A calendar cap here would be wrong — it would silently delete a real
 * model change from a project that sweeps weekly or paused for a month, which
 * is worst on the shortest windows. A sweep count scales with the project's own
 * cadence, and any provider the bound cuts off is reported via
 * `anchorUnavailable` rather than being dropped without a trace.
 */
const ANCHOR_SWEEP_SCAN_LIMIT = 60

function isProviderInfraDomain(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase()
    for (const blocked of AI_PROVIDER_INFRA_DOMAINS) {
      if (host === blocked || host.endsWith(`.${blocked}`)) return true
    }
  } catch {
    // malformed URI — skip
  }
  return false
}

function parseGroundingSources(rawResponse: string | null): Array<{ uri: string; title: string }> {
  const parsed = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const sources = parsed.groundingSources as Array<{ uri?: string; title?: string }> | undefined
  if (!Array.isArray(sources)) return []
  return sources.filter(
    (s): s is { uri: string; title: string } =>
      typeof s.uri === 'string' && !isProviderInfraDomain(s.uri),
  )
}

function bucketSizeForSpan(spanDays: number): number {
  // Pick a bucket size based on how many days of data actually exist
  if (spanDays <= 14) return 1   // daily
  if (spanDays <= 60) return 7   // weekly
  if (spanDays <= 180) return 14 // bi-weekly
  return 30                       // monthly
}

interface SnapshotLike {
  queryId: string
  provider: string
  model: string | null
  citationState: string
  resolvedMentioned: boolean
  answerText: string | null
  /** Canonical observation time: the parent run's logical sweep timestamp. */
  runCreatedAt: string
}

interface MentionShareCompetitorInput {
  domain: string
  brandTokens: string[]
}

function computeProviderMetric(snapshots: SnapshotLike[]): ProviderMetric {
  const total = snapshots.length
  const cited = snapshots.filter(s => s.citationState === CitationStates.cited).length
  const mentionedCount = snapshots.filter(s => s.resolvedMentioned).length
  return {
    citationRate: total > 0 ? Math.round((cited / total) * 10000) / 10000 : 0,
    cited,
    total,
    mentionRate: total > 0 ? Math.round((mentionedCount / total) * 10000) / 10000 : 0,
    mentionedCount,
  }
}

function computeBuckets(
  snapshots: SnapshotLike[],
  projectRuns: Array<{ createdAt: string }>,
  bucketDays: number,
  queryCreatedAt?: Map<string, string>,
  mentionShareCompetitors: MentionShareCompetitorInput[] = [],
): TimeBucket[] {
  if (projectRuns.length === 0) return []

  const earliest = new Date(projectRuns[0]!.createdAt)
  const latest = new Date(projectRuns[projectRuns.length - 1]!.createdAt)
  const buckets: TimeBucket[] = []

  // Run `createdAt` is the canonical sweep time. Align its bucket boundaries
  // to UTC midnight (not the server's local midnight) so a near-midnight run
  // never shifts across DST transitions. Snapshot persistence time is not an
  // observation time and must not drive analytics membership.
  let start = new Date(earliest)
  start.setUTCHours(0, 0, 0, 0)

  while (start <= latest) {
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + bucketDays)

    const startISO = start.toISOString()
    const endISO = end.toISOString()
    const inBucket = snapshots.filter(s => s.runCreatedAt >= startISO && s.runCreatedAt < endISO)

    // Only emit buckets that contain actual sweep data
    if (inBucket.length > 0) {
      // Normalize: only include queries that existed before this bucket started
      let usable = inBucket
      if (queryCreatedAt) {
        const eligible = inBucket.filter(s => {
          const qCreated = queryCreatedAt.get(s.queryId)
          return qCreated !== undefined && qCreated < startISO
        })
        // Fallback: if ALL queries are new (e.g. first bucket), use full set
        if (eligible.length > 0) usable = eligible
      }

      const metric = computeProviderMetric(usable)
      const queryCount = new Set(usable.map(s => s.queryId)).size
      // Per-provider breakdown over the SAME normalized `usable` set, so the
      // dashboard can plot a line per provider over time. Reusing
      // computeProviderMetric inherits the 4dp rounding and probe exclusion,
      // so a provider line can never drift from the bucket overall.
      const byProvider: Record<string, ProviderMetric> = {}
      const modelEvidenceByProvider: TimeBucket['modelEvidenceByProvider'] = {}
      for (const provider of new Set(usable.map(s => s.provider))) {
        const providerSnapshots = usable.filter(s => s.provider === provider)
        byProvider[provider] = computeProviderMetric(providerSnapshots)
        modelEvidenceByProvider[provider] = classifyModelEvidence(providerSnapshots.map(s => s.model))
      }
      // The REAL observation times inside this bucket. The boundaries above are
      // an internal grouping key anchored to the window's earliest run — a
      // sweep can sit many days into its bucket, so the boundary is not a date
      // any reader should ever be shown. These two are, and they are emitted
      // as stored: pure UTC, no timezone applied. Localizing (if wanted) is the
      // viewer's job, on the frontend.
      const observedAt = usable.map(s => s.runCreatedAt).sort()
      buckets.push({
        startDate: startISO,
        endDate: endISO,
        dataStartDate: observedAt[0]!,
        dataEndDate: observedAt[observedAt.length - 1]!,
        sweepCount: new Set(observedAt).size,
        citationRate: metric.citationRate,
        cited: metric.cited,
        total: metric.total,
        queryCount,
        mentionRate: metric.mentionRate,
        mentionedCount: metric.mentionedCount,
        mentionShare: computeMentionShareBucketMetric(usable, mentionShareCompetitors),
        byProvider,
        modelEvidenceByProvider,
      })
    }

    start = end
  }

  return buckets
}

/** Return the emitted trend bucket key containing an in-window sweep. */
function bucketStartDateFor(observedAt: string, earliest: Date, bucketDays: number): string {
  const firstBucketStart = new Date(earliest)
  firstBucketStart.setUTCHours(0, 0, 0, 0)
  const observationDay = new Date(observedAt)
  observationDay.setUTCHours(0, 0, 0, 0)
  const bucketMilliseconds = bucketDays * 86_400_000
  const offset = Math.max(0, Math.floor((observationDay.getTime() - firstBucketStart.getTime()) / bucketMilliseconds))
  return new Date(firstBucketStart.getTime() + offset * bucketMilliseconds).toISOString()
}

function computeMentionShareBucketMetric(
  snapshots: SnapshotLike[],
  mentionShareCompetitors: MentionShareCompetitorInput[],
): TimeBucket['mentionShare'] {
  if (mentionShareCompetitors.length === 0) {
    return { rate: null, projectMentionSnapshots: 0, competitorMentionSnapshots: 0 }
  }

  const result = buildMentionShare(
    snapshots.map(s => ({
      projectMentioned: s.resolvedMentioned,
      answerText: s.answerText,
    })),
    { competitors: mentionShareCompetitors },
  )
  const projectMentionSnapshots = result.breakdown.projectMentionSnapshots
  const competitorMentionSnapshots = result.breakdown.competitorMentionSnapshots
  const denominator = projectMentionSnapshots + competitorMentionSnapshots
  return {
    rate: denominator > 0 ? round4(projectMentionSnapshots / denominator) : null,
    projectMentionSnapshots,
    competitorMentionSnapshots,
  }
}

function computeQueryChanges(
  projectQueries: Array<{ id: string; createdAt: string }>,
  cutoff: string | null,
): QueryChangeEvent[] {
  // Group queries by creation day (YYYY-MM-DD)
  const byDay = new Map<string, number>()
  for (const q of projectQueries) {
    if (cutoff && q.createdAt < cutoff) continue
    const day = q.createdAt.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }

  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  // First day is the baseline set, not a "change"
  if (days.length <= 1) return []

  return days.slice(1).map(([date, count]) => ({
    date: new Date(date + 'T00:00:00.000Z').toISOString(),
    delta: count,
    label: `+${count} kp`,
  }))
}

/**
 * Pooled rate across buckets: total numerator over total denominator.
 *
 * NOT the mean of the per-bucket rates. A rate is not additive across the
 * buckets that produced it, so averaging them unweighted lets a bucket holding
 * 2 snapshots move the verdict as much as one holding 200 — a single sparse
 * sweep could flip `improving`/`declining` on its own. Pooling the raw counts
 * weights each bucket by the evidence it actually carries.
 *
 * Reads `cited` / `mentionedCount` rather than re-deriving from the rate, so
 * the already-rounded per-bucket rate never compounds into the comparison.
 */
export function pooledRate(buckets: TimeBucket[], rateKey: 'citationRate' | 'mentionRate'): number {
  const countKey = rateKey === 'citationRate' ? 'cited' : 'mentionedCount'
  let numerator = 0
  let denominator = 0
  for (const bucket of buckets) {
    numerator += bucket[countKey]
    denominator += bucket.total
  }
  return denominator > 0 ? numerator / denominator : 0
}

export function computeTrend(buckets: TimeBucket[], rateKey: 'citationRate' | 'mentionRate'): TrendDirection {
  const nonEmpty = buckets.filter(b => b.total > 0)
  if (nonEmpty.length < 2) return 'stable'

  const mid = Math.floor(nonEmpty.length / 2)
  const firstHalf = nonEmpty.slice(0, mid)
  const secondHalf = nonEmpty.slice(mid)

  const avgFirst = pooledRate(firstHalf, rateKey)
  const avgSecond = pooledRate(secondHalf, rateKey)

  const diff = avgSecond - avgFirst
  // Threshold: 5 percentage points
  if (diff > 0.05) return 'improving'
  if (diff < -0.05) return 'declining'
  return 'stable'
}

function round4(ratio: number): number {
  return Math.round(ratio * 10000) / 10000
}

function bumpDomain(
  map: Map<string, DomainAgg>,
  domain: string,
  category: SourceCategory,
  label: string,
  surfaceClass: SurfaceClass,
): void {
  const existing = map.get(domain)
  if (existing) existing.count += 1
  else map.set(domain, { domain, count: 1, category, label, surfaceClass })
}

/**
 * Flatten a per-domain aggregation into a ranked, classified list with an
 * explicit long-tail rollup. Sorted desc by count, ties broken by domain asc
 * for determinism. The surface-class roll-up always spans the FULL scope, so a
 * `limit` truncates `entries` but never hides totals:
 *   entries.length + truncatedDomainCount === domainTotal
 *   sum(entries.count) + truncatedCitedSlots === totalCitedSlots
 *   sum(bySurfaceClass.count) === totalCitedSlots
 */
function buildRankedList(domains: Map<string, DomainAgg>, limit: number | null): RankedSourceList {
  const all = [...domains.values()]
  const totalCitedSlots = all.reduce((sum, d) => sum + d.count, 0)
  const domainTotal = all.length

  all.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  const shownEntries = limit != null && limit < all.length ? all.slice(0, limit) : all

  const entries: SourceRankEntry[] = shownEntries.map(d => ({
    domain: d.domain,
    count: d.count,
    percentage: totalCitedSlots > 0 ? round4(d.count / totalCitedSlots) : 0,
    category: d.category,
    label: d.label,
    surfaceClass: d.surfaceClass,
  }))

  const shownSlots = shownEntries.reduce((sum, d) => sum + d.count, 0)

  // Surface-class roll-up over the FULL scope (every domain, not just shown).
  const classAgg = new Map<SurfaceClass, { count: number; domainCount: number }>()
  for (const d of all) {
    const entry = classAgg.get(d.surfaceClass) ?? { count: 0, domainCount: 0 }
    entry.count += d.count
    entry.domainCount += 1
    classAgg.set(d.surfaceClass, entry)
  }
  const bySurfaceClass: SurfaceClassCount[] = [...classAgg.entries()]
    .map(([surfaceClass, v]) => ({
      surfaceClass,
      label: surfaceClassLabel(surfaceClass),
      count: v.count,
      percentage: totalCitedSlots > 0 ? round4(v.count / totalCitedSlots) : 0,
      domainCount: v.domainCount,
    }))
    .sort((a, b) => b.count - a.count || a.surfaceClass.localeCompare(b.surfaceClass))

  return {
    totalCitedSlots,
    domainTotal,
    entries,
    truncatedDomainCount: domainTotal - shownEntries.length,
    truncatedCitedSlots: totalCitedSlots - shownSlots,
    bySurfaceClass,
  }
}

function buildCategoryCounts(counts: Map<SourceCategory, Map<string, number>>): SourceCategoryCount[] {
  let grandTotal = 0
  for (const domains of counts.values()) {
    for (const count of domains.values()) grandTotal += count
  }

  const result: SourceCategoryCount[] = []
  for (const [category, domains] of counts) {
    let categoryTotal = 0
    const domainEntries: Array<{ domain: string; count: number }> = []
    for (const [domain, count] of domains) {
      categoryTotal += count
      domainEntries.push({ domain, count })
    }
    domainEntries.sort((a, b) => b.count - a.count)

    result.push({
      category,
      label: categoryLabel(category),
      count: categoryTotal,
      percentage: grandTotal > 0 ? Math.round((categoryTotal / grandTotal) * 10000) / 10000 : 0,
      topDomains: domainEntries.slice(0, 5),
    })
  }

  result.sort((a, b) => b.count - a.count)
  return result
}

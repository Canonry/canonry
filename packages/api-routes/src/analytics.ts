import { and, desc, eq, gte, inArray, lt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { filterTrackedSnapshots, groupRunsByCreatedAt, pickGroupRepresentative, querySnapshots, runs, queries, queryBasketVersions, competitors, domainClassifications, type DatabaseClient } from '@ainyc/canonry-db'
import {
  AI_PROVIDER_INFRA_DOMAINS, categorizeSource, categoryLabel, CitationStates,
  classifySurfaceFromCategory, surfaceClassFromCompetitorType, surfaceClassLabel,
  effectiveDomains, evaluateModelPointerExposure, normalizeProjectDomain, parseWindow, RunKinds, RunStatuses,
  RunTriggers, windowCutoff, validationError, notFound, compileBrandAliases, hostMatchesAnyDomain, hostMatchesDomain,
  hostOf, matcherMatchesText, normalizeQueryText, sourceBreakdownQuerySchema, LATEST_RUN_ID, SOURCE_BREAKDOWN_COUNT_UNITS,
} from '@ainyc/canonry-contracts'
import type {
  BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto,
  TimeBucket, TrendDirection, GapQuery, GapCategory,
  SourceCategory, SourceCategoryCount, ProviderMetric, QueryChangeEvent, QueryClass,
  RankedSourceList, SourceRankEntry, SurfaceClass, SurfaceClassCount, ModelEvidenceState,
  ModelExposureWindow, ModelPointerChangeDisclosure, ModelServiceMismatch, ExecutionIdentityChangeEvent,
  WindowChange, WindowRateChange,
} from '@ainyc/canonry-contracts'
import { buildMentionShare, type MentionShareCompetitor } from '@ainyc/canonry-intelligence'
import { mentionShareCompetitorsFromDomains, projectQueryClassifier } from './mention-share-inputs.js'
import { latestSweepRuns, planQueryClassesByRun, pooledRunIds } from './competitor-landscape.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { notProbeRun, resolveProject, resolveSnapshotAnswerMentioned } from './helpers.js'
import { buildModelAttribution, buildServedModelAttribution } from './analytics-model-attribution.js'
import {
  classifyModelEvidence, classifyServedModelEvidence, modelEvidenceMismatched, type ModelEvidenceValue,
} from './model-evidence.js'
import { measurementRunCompleteness } from './measurement-run-completeness.js'

// A plan run that did not fill every slot its manifest promised has not
// measured the plan. Folding its rows into a rate or a "latest sweep"
// classification anyway would state a conclusion about questions nobody
// answered — the same partial-denominator error run-coordinator and the
// notifier already refuse to make. Planless runs (no manifest) are unaffected.
function measuredWhole(db: DatabaseClient, run: { id: string }): boolean {
  const completeness = measurementRunCompleteness(db, run.id)
  return !completeness.planned || completeness.complete
}

export async function analyticsRoutes(app: FastifyInstance) {
  // GET /projects/:name/analytics/metrics — citation rate trends
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/analytics/metrics', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const classifyQuery = projectQueryClassifier(project)
    const mentionShareScope = classifyQuery ? 'non-brand' as const : 'pooled' as const

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
      .filter(r => measuredWhole(app.db, r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    if (projectRuns.length === 0) {
      return reply.send({
        window,
        mentionShareScope,
        buckets: [],
        overall: { citationRate: 0, cited: 0, total: 0, mentionRate: 0, mentionedCount: 0 },
        byProvider: {},
        trend: 'stable',
        mentionTrend: 'stable',
        windowChange: { citationRate: null, mentionRate: null, mentionShare: null },
        queryChanges: [],
        basketChanges: [],
        executionIdentityChanges: [],
        referenceBasketRevision: null,
        modelAttribution: {},
        servedModelAttribution: {},
        modelServiceMismatch: {},
        modelPointerChanges: {},
      } satisfies BrandMetricsDto)
    }

    const runIds = projectRuns.map(r => r.id)

    // Fetch query creation dates for the pre-basket fallback, and text so a
    // snapshot whose `query_id` was nulled by a delete still resolves an identity.
    const projectQueries = app.db
      .select({ id: queries.id, query: queries.query, createdAt: queries.createdAt })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const queryCreatedAt = new Map(projectQueries.map(q => [q.id, q.createdAt]))
    const queryTextById = new Map(projectQueries.map(q => [q.id, q.query]))

    // Recorded query-set versions. The reference basket is the current one:
    // the set the project is measuring now, which is what the trend line has to
    // hold constant to be a trend at all.
    const basketRevisions = app.db
      .select()
      .from(queryBasketVersions)
      .where(eq(queryBasketVersions.projectId, project.id))
      .orderBy(queryBasketVersions.revision)
      .all()
      .map(row => ({
        revision: row.revision,
        createdAt: row.createdAt,
        members: JSON.parse(row.membersJson) as string[],
      }))
    const latestBasket = basketRevisions.at(-1) ?? null
    const referenceBasket = latestBasket ? new Set(latestBasket.members) : undefined

    const loadedSnapshots = app.db
      .select({
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        queryText: querySnapshots.queryText,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        servedModel: querySnapshots.servedModel,
        citationState: querySnapshots.citationState,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
      })
      .from(querySnapshots)
      .where(inArray(querySnapshots.runId, runIds))
      .all()
    // Deleting a query nulls `query_id` on its historical snapshots (post-v58,
    // see schema.ts), and this route used to drop those rows outright — so
    // removing a query erased its past from the chart even after the same
    // question was re-added. With a recorded basket the snapshot's own
    // `query_text` is enough identity to rejoin: if the text is a member of the
    // set being measured NOW, its history belongs on the trend, whatever
    // happened to the row id in between. Orphans whose text is not in the
    // basket stay out — that query was deliberately dropped from measurement.
    //
    // Without a basket there is no membership to test against, so orphans are
    // dropped exactly as before; the deploy changes nothing until a revision is
    // recorded.
    const rawSnapshots = referenceBasket
      ? loadedSnapshots.filter(s =>
          s.queryId !== null ||
          (s.queryText !== null && referenceBasket.has(normalizeQueryText(s.queryText))),
        )
      : filterTrackedSnapshots(loadedSnapshots)

    // Resolve answerMentioned for each snapshot (handles null/legacy data)
    const runCreatedAt = new Map(projectRuns.map(run => [run.id, run.createdAt]))
    const runBasketRevision = new Map(projectRuns.map(run => [run.id, run.queryBasketRevision ?? null]))
    const allSnapshots = rawSnapshots.map(s => ({
      ...s,
      runCreatedAt: runCreatedAt.get(s.runId)!,
      resolvedMentioned: resolveSnapshotAnswerMentioned(s, project),
      queryClass: classifyQuery
        ? classifyQuery((s.queryId ? queryTextById.get(s.queryId) : undefined) ?? s.queryText ?? null)
        : null,
      // Falls back to the id if no text resolves, so two distinct queries can
      // never collapse into one member on an empty key. (An orphan only gets
      // this far when its text matched the basket, so its key is never empty.)
      basketKey:
        normalizeQueryText(s.queryText ?? (s.queryId ? queryTextById.get(s.queryId) ?? '' : '')) ||
        s.queryId || '',
      runBasketRevision: runBasketRevision.get(s.runId) ?? null,
    }))
    const mentionShareCompetitors = mentionShareCompetitorsFromDomains(
      app.db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
        .map(c => c.domain),
    )

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
    const buckets = computeBuckets(
      allSnapshots,
      projectRuns,
      bucketSize,
      queryCreatedAt,
      mentionShareCompetitors,
      referenceBasket,
      classifyQuery !== null,
    )

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
    const windowChange = computeWindowChange(buckets)

    // Query change annotations
    const queryChanges = computeQueryChanges(projectQueries, cutoff)
    // A real change event, diffed between consecutive recorded revisions rather
    // than inferred from row timestamps. Revision 1 is not a change — it is the
    // first observation of a set that already existed — so the diff starts at 2.
    const basketChanges = basketRevisions
      .slice(1)
      .map((rev, i) => {
        const previous = new Set(basketRevisions[i]!.members)
        const current = new Set(rev.members)
        return {
          revision: rev.revision,
          at: rev.createdAt,
          added: rev.members.filter(m => !previous.has(m)),
          removed: basketRevisions[i]!.members.filter(m => !current.has(m)),
        }
      })
      // A null cutoff is the all-time window, where every recorded change is in scope.
      .filter(change => !cutoff || change.at >= cutoff)

    // Execution-identity change annotations: the read half of the boundary
    // an engine/model swap promises. `projectRuns` is already ordered oldest
    // first (see the `.sort()` above), so walking it once and comparing each
    // plan-aware run's checksum to the last one seen finds every point the
    // identity actually moved. The first identity observed is not a change —
    // same rule as basket revision 1 — so the comparison starts on the
    // second one. Planless runs carry no identity and are skipped rather
    // than treated as a break: they say nothing about what measured them.
    const executionIdentityChanges: ExecutionIdentityChangeEvent[] = []
    let previousExecutionChecksum: string | null = null
    for (const run of projectRuns) {
      const identity = run.measurementExecutionIdentity
      if (!identity) continue
      if (previousExecutionChecksum !== null && identity.checksum !== previousExecutionChecksum) {
        executionIdentityChanges.push({ at: run.createdAt, identity })
      }
      previousExecutionChecksum = identity.checksum
    }

    return reply.send({ window, mentionShareScope, buckets, overall, byProvider, trend, mentionTrend, windowChange, queryChanges, basketChanges, executionIdentityChanges, referenceBasketRevision: latestBasket?.revision ?? null, modelAttribution, servedModelAttribution, modelServiceMismatch, modelPointerChanges } satisfies BrandMetricsDto)
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
      .filter(r => measuredWhole(app.db, r))
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
      .filter(r => measuredWhole(app.db, r))
      .filter(r => !cutoff || r.createdAt >= cutoff)

    const windowRunIds = windowRuns.map(r => r.id)
    // Tracked competitors, resolved once, plus one compiled alias matcher each:
    // the alias set is fixed and the answer corpus is not.
    const competitorDomains = app.db
      .select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, project.id))
      .all()
      .map(c => c.domain)
    const competitorMatchers = new Map(
      mentionShareCompetitorsFromDomains(competitorDomains)
        .map(c => [c.domain, compileBrandAliases([...c.brandTokens])]),
    )
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
        citedDomains: querySnapshots.citedDomains,
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
      // TWO SETS, computed from two different signals, because the two lanes
      // below are named for two different signals. `competitor_overlap` is read
      // for neither: that column unions cited domains, grounding sources AND
      // answer-text brand matches, so it is not either one.
      const competitorsCiting = new Set<string>()
      const competitorsMentioned = new Set<string>()
      for (const s of qSnapshots) {
        for (const domain of s.citedDomains) {
          const match = competitorDomains.find(c => hostMatchesDomain(domain, c))
          if (match) competitorsCiting.add(match)
        }
        if (!s.answerText) continue
        for (const competitor of competitorDomains) {
          const matcher = competitorMatchers.get(competitor)
          if (matcher && matcherMatchesText(matcher, s.answerText)) competitorsMentioned.add(competitor)
        }
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
        competitorsMentioned: [...competitorsMentioned],
        consistency,
      }

      if (category === 'cited') cited.push(citationEntry)
      else if (category === 'gap') gap.push(citationEntry)
      else uncited.push(citationEntry)

      // Answer-mention classification. A MENTION gap is "a competitor's brand
      // was named in the prose and yours was not" — it must not be decided by
      // who got cited, which is a different thing an engine can do independently.
      let mentionCategory: GapCategory
      if (mentionedProviders.length > 0) {
        mentionCategory = 'cited'
      } else if (competitorsMentioned.size > 0) {
        mentionCategory = 'gap'
      } else {
        mentionCategory = 'uncited'
      }

      const mentionEntry: GapQuery = {
        query, queryId, category: mentionCategory,
        providers: mentionedProviders,
        competitorsCiting: [...competitorsCiting],
        competitorsMentioned: [...competitorsMentioned],
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
    mentionGap.sort((a, b) => b.competitorsMentioned.length - a.competitorsMentioned.length)
    mentionedQueries.sort((a, b) => a.query.localeCompare(b.query))
    notMentioned.sort((a, b) => a.query.localeCompare(b.query))

    return reply.send({ cited, gap, uncited, mentionedQueries, mentionGap, notMentioned, runId: latestRun.id, window } satisfies GapAnalysisDto)
  })

  // GET /projects/:name/analytics/sources — source origin breakdown.
  // `?limit=N` caps the ranked / per-provider lists to the top N domains
  // (with an explicit long-tail rollup); omitted = the full ranked list.
  // `?runId=` reads one run (`latest` = the latest sweep), `?queryClass=` one
  // query class, and `?includeByQuery=false` drops the large per-query breakdown.
  app.get<{
    Params: { name: string }
    Querystring: { window?: string; limit?: string; runId?: string; queryClass?: string; includeByQuery?: string }
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

    const parsedFilters = sourceBreakdownQuerySchema.safeParse({
      runId: request.query.runId,
      queryClass: request.query.queryClass,
      includeByQuery: request.query.includeByQuery,
    })
    if (!parsedFilters.success) {
      throw validationError('Invalid source breakdown query', { issues: parsedFilters.error.issues })
    }
    // `latest` resolves to the sweep the measurement reads display, so a
    // class-scoped read can name the current sweep without knowing its id.
    const latestRequested = parsedFilters.data.runId === LATEST_RUN_ID
    const latestRuns = latestRequested ? latestSweepRuns(app.db, project.id) : null
    const requestedRunId = latestRequested ? null : parsedFilters.data.runId ?? null
    const queryClass = parsedFilters.data.queryClass ?? 'all'
    const includeByQuery = parsedFilters.data.includeByQuery !== 'false' && parsedFilters.data.includeByQuery !== '0'

    // A class split on a v2 project reads each run's frozen assignment classes,
    // exactly as the competitor landscape does, so both tools count the same
    // non-brand answers. Everything else classifies the query text.
    const splitByClass = queryClass !== 'all'
    const planClassified = splitByClass && activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
    const classifyQueryText = splitByClass && !planClassified ? projectQueryClassifier(project) : null
    if (splitByClass && !planClassified && !classifyQueryText) {
      throw validationError(
        `Query class "${queryClass}" needs a brand name or alias on this project. Add one, or omit queryClass for a pooled source list.`,
      )
    }
    const filters = {
      runId: parsedFilters.data.runId ?? null,
      queryClass,
      queryClassBasis: !splitByClass ? null : planClassified ? 'measurement-plan' as const : 'query-text' as const,
      includeByQuery,
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

    if (requestedRunId) {
      // An unknown id and an excluded run both used to read as "no sources".
      // Say which one it is instead.
      const requested = app.db
        .select()
        .from(runs)
        .where(and(
          eq(runs.id, requestedRunId),
          eq(runs.projectId, project.id),
          eq(runs.kind, RunKinds['answer-visibility']),
        ))
        .get()
      if (!requested) throw notFound('Answer-visibility run', requestedRunId)
      if (requested.trigger === RunTriggers.probe) {
        throw validationError(`Run "${requestedRunId}" is a probe run; probes never enter source analytics.`)
      }
      if (requested.status !== RunStatuses.completed && requested.status !== RunStatuses.partial) {
        throw validationError(`Run "${requestedRunId}" is ${requested.status}; only completed or partial runs have source analytics.`)
      }
      if (!measuredWhole(app.db, requested)) {
        throw validationError(`Run "${requestedRunId}" did not fill every slot its measurement plan promised, so it is excluded from source analytics.`)
      }
      if (cutoff && requested.createdAt < cutoff) {
        throw validationError(`Run "${requestedRunId}" is older than the ${window} window. Omit window, or widen it, to read this run.`)
      }
    }
    const latestOutsideWindow = latestRuns?.find(run => cutoff && run.createdAt < cutoff)
    if (latestOutsideWindow) {
      throw validationError(
        `The latest sweep (run "${latestOutsideWindow.id}") is older than the ${window} window. Omit window, or widen it, to read it.`,
      )
    }

    // All sweep runs in window (or the one requested run)
    const windowRuns = app.db
      .select()
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        notProbeRun(),
        latestRuns ? inArray(runs.id, latestRuns.map(run => run.id)) : requestedRunId ? eq(runs.id, requestedRunId) : undefined,
      ))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .all()
      .filter(r => r.status === 'completed' || r.status === 'partial')
      .filter(r => measuredWhole(app.db, r))
      .filter(r => !cutoff || r.createdAt >= cutoff)

    if (windowRuns.length === 0) {
      return reply.send({
        ranked: buildRankedList(new Map(), limit, 0, 0),
        byProvider: {},
        providersWithoutSources: [],
        answerTotal: 0,
        runCount: 0,
        pooledAcrossRuns: false,
        unclassifiedAnswers: 0,
        filters,
        runId: '',
        runIds: [],
        countUnits: SOURCE_BREAKDOWN_COUNT_UNITS,
        window, limit,
        overall: [],
        ...(includeByQuery ? { byQuery: {} } : {}),
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

    // The stored source list, not `rawResponse.groundingSources`: every Gemini
    // grounding link is a vertexaisearch redirect that the infra filter drops,
    // so reading the raw links silently removed Gemini from every count. The
    // run writer resolves those redirects into `citedDomains` / `citedUrls`.
    const loadedSnapshots = app.db
      .select({
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        queryText: querySnapshots.queryText,
        query: queries.query,
        provider: querySnapshots.provider,
        citedDomains: querySnapshots.citedDomains,
        citedUrls: querySnapshots.citedUrls,
        measurementExecutionId: querySnapshots.measurementExecutionId,
      })
      .from(querySnapshots)
      .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
      .where(inArray(querySnapshots.runId, windowRunIds))
      .all()

    let unclassifiedAnswers = 0
    let snapshots = loadedSnapshots
    if (splitByClass) {
      const planClasses = planClassified ? planQueryClassesByRun(app.db, project.id, windowRuns) : null
      snapshots = loadedSnapshots.filter(snap => {
        let classes: ReadonlySet<string> | undefined
        if (planClasses) {
          classes = snap.measurementExecutionId
            ? planClasses.get(snap.runId)?.get(snap.measurementExecutionId)
            : undefined
        } else {
          const text = snap.query ?? snap.queryText
          classes = text?.trim() ? new Set([classifyQueryText!(text)]) : undefined
        }
        if (!classes || classes.size === 0) {
          unclassifiedAnswers += 1
          return false
        }
        return classes.has(queryClass)
      })
    }

    // Aggregate sources overall and per-query (legacy category breakdown), plus
    // a flat per-domain aggregation overall and per provider (the #675 ranked /
    // classified / per-provider surface). Probes are already excluded because
    // windowRunIds derives from the probe-filtered run list above. Every count
    // is one credit per (answer, domain): an answer listing three pages of one
    // site cites that site once.
    const overallCounts = new Map<SourceCategory, Map<string, number>>()
    const queryCounts = new Map<string, Map<SourceCategory, Map<string, number>>>()
    const overallDomains = new Map<string, DomainAgg>()
    const providerDomains = new Map<string, Map<string, DomainAgg>>()
    const answersByProvider = new Map<string, { total: number; withSources: number }>()
    let answersWithSources = 0

    for (const snap of snapshots) {
      const domains = sourceDomainsOf(snap)
      const providerAnswers = answersByProvider.get(snap.provider) ?? { total: 0, withSources: 0 }
      providerAnswers.total += 1
      if (domains.length > 0) {
        providerAnswers.withSources += 1
        answersWithSources += 1
      }
      answersByProvider.set(snap.provider, providerAnswers)

      const queryKey = includeByQuery && domains.length > 0 ? snap.query : null
      let qCounts: Map<SourceCategory, Map<string, number>> | undefined
      if (queryKey) {
        qCounts = queryCounts.get(queryKey)
        if (!qCounts) { qCounts = new Map(); queryCounts.set(queryKey, qCounts) }
      }

      for (const host of domains) {
        const { category, label, domain } = categorizeSource(host)
        const surfaceClass = classifySurfaceFromCategory(
          domain, category, classifyCtx, storedSurfaceClasses.get(normalizeProjectDomain(domain)),
        )

        // Overall (legacy category breakdown)
        bumpCategory(overallCounts, category, domain)
        // Per-query (legacy category breakdown), summed over every answer to
        // the query rather than whichever answer happened to be read last.
        if (qCounts) bumpCategory(qCounts, category, domain)

        // Flat ranked + classified — overall and per provider
        bumpDomain(overallDomains, domain, category, label, surfaceClass)
        let pm = providerDomains.get(snap.provider)
        if (!pm) { pm = new Map(); providerDomains.set(snap.provider, pm) }
        bumpDomain(pm, domain, category, label, surfaceClass)
      }
    }

    const ranked = buildRankedList(overallDomains, limit, snapshots.length, answersWithSources)
    const byProvider: Record<string, RankedSourceList> = {}
    for (const [provider, domains] of providerDomains) {
      const answers = answersByProvider.get(provider)!
      byProvider[provider] = buildRankedList(domains, limit, answers.total, answers.withSources)
    }
    const providersWithoutSources = [...answersByProvider]
      .filter(([, answers]) => answers.withSources === 0)
      .map(([provider]) => provider)
      .sort()

    let byQuery: Record<string, SourceCategoryCount[]> | undefined
    if (includeByQuery) {
      byQuery = {}
      for (const [query, counts] of queryCounts) byQuery[query] = buildCategoryCounts(counts)
    }

    // Key order is deliberate: the ranked list leads, the large legacy
    // breakdowns trail, so a reader that only sees the start still gets it.
    return reply.send({
      ranked,
      byProvider,
      providersWithoutSources,
      answerTotal: snapshots.length,
      runCount: windowRuns.length,
      pooledAcrossRuns: windowRuns.length > 1,
      unclassifiedAnswers,
      filters,
      // Compatibility field: the requested run, else the newest sweep's
      // representative. A pooled read is scoped by `runIds`, never by this.
      runId: requestedRunId ?? latestRunId,
      runIds: pooledRunIds(windowRuns),
      countUnits: SOURCE_BREAKDOWN_COUNT_UNITS,
      window,
      limit,
      overall: buildCategoryCounts(overallCounts),
      ...(byQuery ? { byQuery } : {}),
    } satisfies SourceBreakdownDto)
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
  return hostMatchesAnyDomain(uri, AI_PROVIDER_INFRA_DOMAINS)
}

/**
 * The distinct hosts one answer cites, from its stored source list: the
 * resolved `citedDomains` plus the hosts of any captured `citedUrls`. Provider
 * infrastructure (redirect proxies, the engines' own sites) never counts.
 */
function sourceDomainsOf(snapshot: { citedDomains: readonly string[] | null; citedUrls: readonly string[] | null }): string[] {
  const hosts = new Set<string>()
  for (const value of [...(snapshot.citedDomains ?? []), ...(snapshot.citedUrls ?? [])]) {
    if (typeof value !== 'string') continue
    const host = hostOf(value)
    if (!host || isProviderInfraDomain(host)) continue
    hosts.add(host)
  }
  return [...hosts]
}

function bumpCategory(counts: Map<SourceCategory, Map<string, number>>, category: SourceCategory, domain: string): void {
  let domains = counts.get(category)
  if (!domains) { domains = new Map(); counts.set(category, domains) }
  domains.set(domain, (domains.get(domain) ?? 0) + 1)
}

function bucketSizeForSpan(spanDays: number): number {
  // Pick a bucket size based on how many days of data actually exist
  if (spanDays <= 14) return 1   // daily
  if (spanDays <= 60) return 7   // weekly
  if (spanDays <= 180) return 14 // bi-weekly
  return 30                       // monthly
}

interface SnapshotLike {
  /** Null on a rejoined orphan: the query row is gone, `basketKey` carries identity. */
  queryId: string | null
  provider: string
  model: string | null
  citationState: string
  resolvedMentioned: boolean
  answerText: string | null
  /** Canonical observation time: the parent run's logical sweep timestamp. */
  runCreatedAt: string
  /**
   * Normalized query text — the identity basket membership is tested against.
   * Text rather than `queryId` on purpose: deleting a query nulls the snapshot's
   * `query_id`, and re-adding it mints a new one, so an id comparison loses the
   * history of exactly the queries most likely to move.
   */
  basketKey: string
  /** Query-set version the parent run measured, null when the run was never stamped. */
  runBasketRevision: number | null
  /**
   * Branded / non-brand, or null when the project has no usable brand alias to
   * classify by. The mention-share trend headlines the non-brand class only —
   * a branded query names the project, so pooling it into the same denominator
   * turns a trend in category placement into a trend in how many branded
   * queries happen to be in the basket.
   */
  queryClass: QueryClass | null
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
  mentionShareCompetitors: MentionShareCompetitor[] = [],
  /**
   * Normalized membership of the project's CURRENT query basket. When present it
   * replaces the `createdAt < bucketStart` heuristic outright: comparability is a
   * recorded fact rather than a date proxy that mistook a rename for a new query.
   *
   * Note this restates history — a query removed today leaves the comparable line
   * in every past bucket too. That is deliberate. The alternative (each bucket
   * judged against its own revision) keeps old points frozen but makes any two
   * points incomparable across a basket change, which is the failure the chart
   * already had. Holding one set of identities across the series is what makes it
   * a trend, and `basketChanges` keeps the restatement visible rather than silent.
   */
  referenceBasket?: Set<string>,
  classificationAvailable = false,
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
      // Hold the query set still, so consecutive points are a comparison rather
      // than two different measurements plotted next to each other.
      let usable = inBucket
      if (referenceBasket) {
        const eligible = inBucket.filter(s => referenceBasket.has(s.basketKey))
        if (eligible.length > 0) usable = eligible
      } else if (queryCreatedAt) {
        // No recorded basket (project has not run since versioning shipped).
        // Fall back to the date heuristic so existing charts keep their shape
        // instead of silently widening the moment this deploys.
        const eligible = inBucket.filter(s => {
          const qCreated = s.queryId ? queryCreatedAt.get(s.queryId) : undefined
          return qCreated !== undefined && qCreated < startISO
        })
        if (eligible.length > 0) usable = eligible
      }

      const metric = computeProviderMetric(usable)
      const queryCount = new Set(usable.map(s => s.basketKey)).size
      // One revision or none. A bucket spanning a basket change has no single
      // set to name, and picking either end would assert something untrue.
      const revisions = new Set(inBucket.map(s => s.runBasketRevision))
      const basketRevision = revisions.size === 1 ? [...revisions][0]! : null
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
        mentionShare: computeMentionShareBucketMetric(usable, mentionShareCompetitors, classificationAvailable),
        byProvider,
        modelEvidenceByProvider,
        basketRevision,
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
  mentionShareCompetitors: readonly MentionShareCompetitor[],
  classificationAvailable: boolean,
): TimeBucket['mentionShare'] {
  // Non-brand only — `buildMentionShare` scopes `breakdown` to the competitive
  // class, so the trend line tracks category placement rather than how many
  // branded queries the basket happened to contain in each bucket.
  const result = buildMentionShare(
    snapshots.map(s => ({
      projectMentioned: s.resolvedMentioned,
      answerText: s.answerText,
      queryClass: s.queryClass,
    })),
    { competitors: mentionShareCompetitors, classificationAvailable },
  )
  const projectMentionSnapshots = result.breakdown.projectMentionSnapshots
  const competitorMentionSnapshots = result.breakdown.competitorMentionSnapshots
  const denominator = projectMentionSnapshots + competitorMentionSnapshots
  return {
    scope: result.scope,
    // A project-only denominator is recognition evidence, not competitive
    // share. Preserve the count but leave the rate undefined without a frame.
    rate: mentionShareCompetitors.length > 0 && denominator > 0
      ? round4(projectMentionSnapshots / denominator)
      : null,
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

function windowRateChange(rates: readonly number[]): WindowRateChange | null {
  const first = rates[0]
  const latest = rates.at(-1)
  if (rates.length < 2 || first === undefined || latest === undefined) return null
  return { first, latest, delta: round4(latest - first) }
}

/**
 * Each overall series' change across the window: the latest bucket's rate
 * minus the first bucket's, the change the dashboard's trend head prints.
 * Citation and mention read every bucket that measured a snapshot; mention
 * share reads only the buckets whose share is defined, which are the points
 * its line plots. The rates are already four-decimal, so rounding the
 * difference to four decimals removes float error and nothing else.
 */
export function computeWindowChange(buckets: readonly TimeBucket[]): WindowChange {
  const measured = buckets.filter(b => b.total > 0)
  return {
    citationRate: windowRateChange(measured.map(b => b.citationRate)),
    mentionRate: windowRateChange(measured.map(b => b.mentionRate)),
    mentionShare: windowRateChange(buckets.flatMap(b => b.mentionShare.rate === null ? [] : [b.mentionShare.rate])),
  }
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
 * `answerTotal` counts every answer in the scope, including answers that cite
 * nothing, so `answerShare` reads as "share of answers citing this domain".
 */
function buildRankedList(
  domains: Map<string, DomainAgg>,
  limit: number | null,
  answerTotal: number,
  answersWithSources: number,
): RankedSourceList {
  const all = [...domains.values()]
  const totalCitedSlots = all.reduce((sum, d) => sum + d.count, 0)
  const domainTotal = all.length

  all.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
  const shownEntries = limit != null && limit < all.length ? all.slice(0, limit) : all

  const entries: SourceRankEntry[] = shownEntries.map(d => ({
    domain: d.domain,
    count: d.count,
    percentage: totalCitedSlots > 0 ? round4(d.count / totalCitedSlots) : 0,
    answerShare: answerTotal > 0 ? round4(d.count / answerTotal) : 0,
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
    answerTotal,
    answersWithSources,
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

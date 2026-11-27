import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  projects,
  queries,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  siteAuditSnapshots,
  siteCrawlAttempts,
  siteCrawlRunRequests,
} from '@canonry/canonry-db'
import {
  AiVisibilitySetupBlockers,
  ProjectSetupNextActions,
  QueryClasses,
  RunKinds,
  RunPreviewBlockedReasons,
  RunStatuses,
  SetupTrackStates,
  formatRunErrorOneLine,
  parseRunError,
  runStatusSchema,
  simpleMeasurementDefinitionSchema,
  siteAuditPageBudgetSchema,
  sortedUnique,
  type AgentReadinessSetupTrack,
  type AiVisibilitySetupBlocker,
  type AiVisibilitySetupTrack,
  type ProjectSetupDto,
  type ProjectSetupNextAction,
  type ProviderRouteFamily,
  type RunKind,
  type RunPreviewBlockedReason,
  type RunPreviewDto,
  type RunProviderFailure,
  type RunStatus,
  type SetupTrackState,
} from '@canonry/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'
import { providerRouteFamilies } from './provider-models.js'
import { readQueryClasses } from './query-class-read.js'
import { readRunAnswerSignals, summarizeRunQueryCounts } from './run-query-counts.js'
import { previewManualRun, resolveRunnableProviderSelection } from './run-queue.js'
import type { ProviderAdapterInfo } from './settings.js'
import { siteAuditRunPhase } from './technical-aeo.js'
import { simpleSweeps } from './visibility-report.js'

export interface ProjectSetupRoutesOptions {
  /** Providers this host can run; the AI Visibility track's readiness is the run preview's. */
  getRunnableProviderNames?: () => readonly string[]
  /** Provider → the model this host has it pointed at. */
  getEffectiveProviderModels?: () => Readonly<Record<string, string>>
  /** Adapter descriptions, for the route families of routed providers. */
  providerAdapters?: ProviderAdapterInfo[]
}

type ProjectRow = typeof projects.$inferSelect
type RunRow = typeof runs.$inferSelect

interface CheckReadiness {
  runnableProviders?: readonly string[]
  routeFamilies: readonly ProviderRouteFamily[]
  providerModels?: Readonly<Record<string, string>>
}

export async function projectSetupRoutes(app: FastifyInstance, opts: ProjectSetupRoutesOptions) {
  const routeFamilies = providerRouteFamilies(opts.providerAdapters)

  // GET /projects/:name/setup — the first-run setup tracker from stored state
  // only: no provider call, crawl or write. Probe runs never count.
  app.get<{ Params: { name: string } }>('/projects/:name/setup', async (request): Promise<ProjectSetupDto> => {
    const project = resolveProject(app.db, request.params.name)
    return readProjectSetup(app.db, project, {
      runnableProviders: opts.getRunnableProviderNames?.(),
      routeFamilies,
      providerModels: opts.getEffectiveProviderModels?.(),
    })
  })
}

function readProjectSetup(db: DatabaseClient, project: ProjectRow, readiness: CheckReadiness): ProjectSetupDto {
  const agentReadiness = agentReadinessTrack(db, project.id, latestRun(db, project.id, RunKinds['site-audit']))
  // The run preview's own readiness, Simple and Advanced, so the tracker can
  // never claim a check can start that the launch would refuse.
  const preview = previewManualRun(db, { projectId: project.id, ...readiness })
  // Whether any engine this project would ask can run, decided as run preflight
  // decides it. The preview cannot say on its own: with no queries it lists no engines.
  const engineReady = resolveRunnableProviderSelection({
    projectProviders: project.providers,
    runnableProviders: readiness.runnableProviders,
    routeFamilies: readiness.routeFamilies,
  }).runnableProviders.length > 0
  const firstScan = firstResultRun(db, project.id, RunKinds['site-audit'])
  const firstCheck = firstResultRun(db, project.id, RunKinds['answer-visibility'])
  const latestCheck = latestRun(db, project.id, RunKinds['answer-visibility'])
  const aiVisibility = aiVisibilityTrack(
    db,
    project,
    latestCheck ? checkRunsOf(db, latestCheck) : [],
    preview,
    engineReady,
    // The baseline is named as the track names a check: its newest run.
    firstCheck ? checkRunsOf(db, firstCheck)[0]!.id : null,
  )
  return {
    project: {
      name: project.name,
      displayName: project.displayName.trim() ? project.displayName : null,
      canonicalDomain: project.canonicalDomain,
    },
    // Setup is done once each track produced a result; a later scheduled scan or
    // check that is still running does not undo it.
    complete: firstScan !== undefined && firstCheck !== undefined,
    firstResultAt: [firstScan?.finishedAt, firstCheck?.finishedAt].filter((at): at is string => !!at).sort()[0] ?? null,
    nextAction: nextActionOf(agentReadiness.state, aiVisibility.state, aiVisibility.blockedBy),
    tracks: { agentReadiness, aiVisibility },
  }
}

/** The project's latest run of one kind, never a probe. */
function latestRun(db: DatabaseClient, projectId: string, kind: RunKind): RunRow | undefined {
  return db.select().from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, kind), notProbeRun()))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1)
    .get()
}

function runStatusOf(run: RunRow): RunStatus {
  return runStatusSchema.parse(run.status)
}

function isActive(state: SetupTrackState): boolean {
  return state === SetupTrackStates.queued || state === SetupTrackStates.running
}

function hasResult(state: SetupTrackState): boolean {
  return state === SetupTrackStates.completed || state === SetupTrackStates.partial
}

/**
 * A failed check's stored errors (a JSON `RunErrorDto`, or plain text on older
 * rows) as the one line `run show` prints, each distinct line once for a sweep;
 * null when its runs stored none.
 */
function checkErrorText(failedRuns: readonly RunRow[]): string | null {
  const lines = failedRuns.flatMap(run => {
    const parsed = parseRunError(run.error)
    return parsed ? [formatRunErrorOneLine(parsed)] : []
  })
  return lines.length > 0 ? [...new Set(lines)].join(' • ') : null
}

/**
 * A failed check's stored errors, engine by engine: each engine's failure kind,
 * message, and whether the check skipped it, once per engine for a sweep (from
 * its newest run that names it). Null when no error names an engine (a
 * top-level message, plain text on older rows, or none at all).
 */
function failedEnginesOf(failedRuns: readonly RunRow[]): AiVisibilitySetupTrack['failedEngines'] {
  const engines = new Map<string, NonNullable<AiVisibilitySetupTrack['failedEngines']>[number]>()
  for (const run of failedRuns) {
    for (const [provider, detail] of Object.entries(parseRunError(run.error)?.providers ?? {})) {
      if (!engines.has(provider)) engines.set(provider, { provider, code: detail.code ?? null, message: detail.message, skipped: detail.skipped === true })
    }
  }
  if (engines.size === 0) return null
  return [...engines.values()].sort((a, b) => a.provider.localeCompare(b.provider))
}

function agentReadinessTrack(db: DatabaseClient, projectId: string, run: RunRow | undefined): AgentReadinessSetupTrack {
  if (!run) {
    return { state: SetupTrackStates.not_started, runId: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null }
  }
  const state = runStatusOf(run)
  const active = isActive(state)
  // The same attempt the scan's own progress read reports.
  const attempt = active || state === RunStatuses.failed
    ? db.select().from(siteCrawlAttempts)
      .where(and(eq(siteCrawlAttempts.projectId, projectId), eq(siteCrawlAttempts.runId, run.id)))
      .orderBy(desc(siteCrawlAttempts.attemptNumber), desc(siteCrawlAttempts.updatedAt))
      .limit(1)
      .get()
    : undefined
  return {
    state,
    runId: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    progress: active
      ? {
        phase: siteAuditRunPhase(state, attempt, 'pending'),
        pagesFound: attempt ? attempt.pagesDiscovered : null,
        pagesChecked: attempt?.pagesFetched ?? 0,
        pageLimit: scanPageBudget(db, projectId, run.id),
        linksFound: attempt ? attempt.edgesDiscovered : null,
        pagesFailed: attempt ? attempt.pagesErrored : null,
      }
      : null,
    result: hasResult(state) ? scanResult(db, projectId, run.id) : null,
    // A scan stores its reason as plain text (its crawl attempt keeps the same one).
    error: state === RunStatuses.failed ? run.error ?? attempt?.error ?? null : null,
  }
}

/** The page budget a scan was started with, frozen with its request; null when it recorded none. */
function scanPageBudget(db: DatabaseClient, projectId: string, runId: string): number | null {
  const request = db.select({ options: siteCrawlRunRequests.effectiveOptions }).from(siteCrawlRunRequests)
    .where(and(eq(siteCrawlRunRequests.projectId, projectId), eq(siteCrawlRunRequests.runId, runId)))
    .get()
  const budget = siteAuditPageBudgetSchema.safeParse(request?.options.maxPages)
  return budget.success ? budget.data : null
}

/** The scorecard the score read reports for this exact scan. */
function scanResult(db: DatabaseClient, projectId: string, runId: string): NonNullable<AgentReadinessSetupTrack['result']> {
  const scorecard = db.select({ score: siteAuditSnapshots.aggregateScore, pagesAudited: siteAuditSnapshots.pagesAudited })
    .from(siteAuditSnapshots)
    .where(and(eq(siteAuditSnapshots.projectId, projectId), eq(siteAuditSnapshots.runId, runId)))
    .orderBy(desc(siteAuditSnapshots.createdAt))
    .limit(1)
    .get()
  // A scan that scored no page (a partial crawl stores no scorecard) has no
  // score, never a score of zero.
  if (!scorecard || scorecard.pagesAudited === 0) return { score: null, pagesScored: 0 }
  return { score: scorecard.score, pagesScored: scorecard.pagesAudited }
}

/**
 * The AI Visibility track from the latest check's runs, newest first: one run,
 * or a sweep over every location (one run per location), read as one check.
 */
function aiVisibilityTrack(
  db: DatabaseClient,
  project: ProjectRow,
  checkRuns: readonly RunRow[],
  preview: RunPreviewDto,
  engineReady: boolean,
  baselineRunId: string | null,
): AiVisibilitySetupTrack {
  const statuses = checkRuns.map(runStatusOf)
  const state: SetupTrackState = checkRuns.length > 0 ? checkStateOf(statuses) : SetupTrackStates.not_started
  const active = isActive(state)
  const nextCheckEngines = preview.engines.filter(engine => engine.requestCount > 0).map(engine => engine.provider)
  const rosters = checkRuns
    .filter((_, index) => isActive(statuses[index]!))
    .map(run => activeCheckEngines(db, run))
    .filter((roster): roster is string[] => roster !== null)
  const failedRuns = checkRuns.filter((_, index) => statuses[index] === RunStatuses.failed)
  return {
    state,
    runId: checkRuns[0]?.id ?? null,
    runIds: checkRuns.map(run => run.id),
    startedAt: checkRuns.map(run => run.startedAt).filter((at): at is string => !!at).sort()[0] ?? null,
    finishedAt: active ? null : checkRuns.map(run => run.finishedAt).filter((at): at is string => !!at).sort().at(-1) ?? null,
    baselineRunId,
    mode: preview.mode,
    blockedBy: active ? null : setupBlockerOf(preview.blockedReason, engineReady),
    engines: active && rosters.length > 0 ? sortedUnique(rosters.flat()) : nextCheckEngines,
    queries: trackedQueryCounts(db, project),
    progress: active ? checkProgress(db, checkRuns) : null,
    // As the run detail reports them while the check is active.
    providerFailures: active ? checkProviderFailures(checkRuns) : null,
    result: hasResult(state)
      ? checkResult(db, project, checkRuns.filter((_, index) => hasResult(statuses[index]!)))
      : null,
    error: state === SetupTrackStates.failed ? checkErrorText(failedRuns) : null,
    failedEngines: state === SetupTrackStates.failed ? failedEnginesOf(failedRuns) : null,
  }
}

/**
 * The runs of the check `run` belongs to, newest first: the sibling runs of a
 * sweep over every location (they share `createdAt`, one per location, grouped
 * as the visibility report groups them), otherwise the run alone.
 */
function checkRunsOf(db: DatabaseClient, run: RunRow): RunRow[] {
  const siblings = db.select().from(runs)
    .where(and(eq(runs.projectId, run.projectId), eq(runs.kind, run.kind), eq(runs.createdAt, run.createdAt), notProbeRun()))
    .orderBy(desc(runs.id))
    .all()
  return simpleSweeps(siblings).find(sweep => sweep.some(member => member.id === run.id)) ?? [run]
}

/** A check's state from its runs: active while any run is, then by what its runs saved. */
function checkStateOf(statuses: readonly RunStatus[]): SetupTrackState {
  if (statuses.includes(RunStatuses.running)) return SetupTrackStates.running
  if (statuses.includes(RunStatuses.queued)) return SetupTrackStates.queued
  const results = statuses.filter(status => status === RunStatuses.completed || status === RunStatuses.partial).length
  if (results === statuses.length) {
    return statuses.every(status => status === RunStatuses.completed) ? SetupTrackStates.completed : SetupTrackStates.partial
  }
  // Some locations saved results and others did not: the check saved part of its work.
  if (results > 0) return SetupTrackStates.partial
  return statuses.every(status => status === RunStatuses.cancelled) ? SetupTrackStates.cancelled : SetupTrackStates.failed
}

/** Answers a check saved so far against the answers its runs set out to collect, known once every run recorded them. */
function checkProgress(db: DatabaseClient, checkRuns: readonly RunRow[]): NonNullable<AiVisibilitySetupTrack['progress']> {
  const planned = checkRuns.map(run => run.plannedAnswers)
  return {
    answersSaved: db.select({ value: count() }).from(querySnapshots)
      .where(inArray(querySnapshots.runId, checkRuns.map(run => run.id)))
      .get()?.value ?? 0,
    answersPlanned: planned.every((value): value is number => value !== null)
      ? planned.reduce((sum, value) => sum + value, 0)
      : null,
  }
}

/** Each engine failing in a check's runs: its first reason, its failed queries summed, stopped if any run stopped it. */
function checkProviderFailures(checkRuns: readonly RunRow[]): AiVisibilitySetupTrack['providerFailures'] {
  const merged: Record<string, RunProviderFailure> = {}
  for (const run of checkRuns) {
    for (const [provider, failure] of Object.entries(run.providerFailures ?? {})) {
      const earlier = merged[provider]
      merged[provider] = earlier
        ? { message: earlier.message, failedQueries: earlier.failedQueries + failure.failedQueries, stopped: earlier.stopped || failure.stopped }
        : failure
    }
  }
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * What blocks the next check, in the order an operator fixes it: publish the
 * plan, connect an engine, then add queries. The preview reports missing
 * queries before a missing engine, which would ask someone with no engine for
 * queries first and leave the key they need for later.
 */
function setupBlockerOf(reason: RunPreviewBlockedReason | null, engineReady: boolean): AiVisibilitySetupBlocker | null {
  if (reason === RunPreviewBlockedReasons['no-queries'] && !engineReady) return AiVisibilitySetupBlockers.no_engine
  switch (reason) {
    case RunPreviewBlockedReasons['unpublished-plan']:
      return AiVisibilitySetupBlockers.plan_unpublished
    case RunPreviewBlockedReasons['no-queries']:
      return AiVisibilitySetupBlockers.no_queries
    case RunPreviewBlockedReasons['no-provider']:
      return AiVisibilitySetupBlockers.no_engine
    case RunPreviewBlockedReasons['providers-failing']:
      return AiVisibilitySetupBlockers.engines_failing
    // Another check is active (a probe, which the track's own state leaves
    // out): there is nothing to fix before the next one.
    case RunPreviewBlockedReasons['run-in-progress']:
    case null:
      return null
  }
}

/**
 * The engines a queued or running check calls: its frozen roster (a published
 * plan's engines, or a Simple check's captured engines) less the engines it
 * skips. Null when it froze none yet: a Simple check captures its engines when
 * it starts.
 */
function activeCheckEngines(db: DatabaseClient, run: RunRow): string[] | null {
  const roster = run.measurementExecutionIdentity?.providers ?? simpleCheckEngines(db, run)
  if (!roster) return null
  const skipped = run.skippedProviders ?? {}
  return sortedUnique(roster.filter(provider => !Object.hasOwn(skipped, provider)))
}

function simpleCheckEngines(db: DatabaseClient, run: RunRow): string[] | null {
  const row = db.select({ definition: simpleMeasurementDefinitions.definition }).from(simpleMeasurementDefinitions)
    .where(and(eq(simpleMeasurementDefinitions.projectId, run.projectId), eq(simpleMeasurementDefinitions.runId, run.id)))
    .get()
  const definition = simpleMeasurementDefinitionSchema.safeParse(row?.definition)
  return definition.success ? definition.data.engines.map(engine => engine.provider) : null
}

/** The tracked queries by the class the query list reports. */
function trackedQueryCounts(db: DatabaseClient, project: ProjectRow): AiVisibilitySetupTrack['queries'] {
  const tracked = db.select({ id: queries.id, query: queries.query }).from(queries)
    .where(eq(queries.projectId, project.id))
    .all()
  const classes = readQueryClasses(db, project, tracked)
  const counts = { total: tracked.length, nonBrand: 0, branded: 0, unclassified: 0 }
  for (const query of tracked) {
    switch (classes.get(query.id) ?? null) {
      case QueryClasses['non-brand']:
        counts.nonBrand++
        break
      case QueryClasses.branded:
        counts.branded++
        break
      case null:
        counts.unclassified++
        break
    }
  }
  return counts
}

/**
 * What a finished check saved, with its query counts as the run detail reports
 * them; a sweep counts every run that saved results, each query once.
 */
function checkResult(db: DatabaseClient, project: ProjectRow, resultRuns: readonly RunRow[]): NonNullable<AiVisibilitySetupTrack['result']> {
  const answers = resultRuns.flatMap(run => readRunAnswerSignals(db, run.id, project))
  return {
    answers: answers.length,
    engines: new Set(answers.map(answer => answer.provider)).size,
    ...summarizeRunQueryCounts(db, project, answers),
  }
}

/**
 * One track's first result: its completed or partial non-probe run that
 * finished first (a run with no finish time sorts by its creation). It decides
 * `complete`, dates `firstResultAt` and names the baseline, so "first" means
 * one thing. Undefined while the track has none.
 */
function firstResultRun(db: DatabaseClient, projectId: string, kind: RunKind): RunRow | undefined {
  return db.select().from(runs)
    .where(and(
      eq(runs.projectId, projectId),
      eq(runs.kind, kind),
      inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
      notProbeRun(),
    ))
    .orderBy(asc(sql`coalesce(${runs.finishedAt}, ${runs.createdAt})`), asc(runs.id))
    .limit(1)
    .get()
}

/**
 * The step the server suggests next, in row order: the Agent Readiness audit
 * scan, then the AI Visibility check, then waiting on work in progress.
 */
function nextActionOf(
  agentReadiness: SetupTrackState,
  aiVisibility: SetupTrackState,
  blockedBy: AiVisibilitySetupBlocker | null,
): ProjectSetupNextAction {
  if (agentReadiness === SetupTrackStates.not_started || agentReadiness === SetupTrackStates.cancelled) {
    return ProjectSetupNextActions.run_agent_readiness
  }
  if (agentReadiness === SetupTrackStates.failed) return ProjectSetupNextActions.retry_agent_readiness
  if (aiVisibility === SetupTrackStates.not_started || aiVisibility === SetupTrackStates.cancelled) {
    return firstCheckAction(blockedBy)
  }
  if (aiVisibility === SetupTrackStates.failed) return ProjectSetupNextActions.repair_ai_visibility
  if (isActive(agentReadiness) || isActive(aiVisibility)) return ProjectSetupNextActions.wait
  return ProjectSetupNextActions.open_project
}

function firstCheckAction(blockedBy: AiVisibilitySetupBlocker | null): ProjectSetupNextAction {
  switch (blockedBy) {
    case AiVisibilitySetupBlockers.no_engine:
      return ProjectSetupNextActions.connect_engine
    case AiVisibilitySetupBlockers.no_queries:
      return ProjectSetupNextActions.add_queries
    case AiVisibilitySetupBlockers.plan_unpublished:
      return ProjectSetupNextActions.publish_plan
    case AiVisibilitySetupBlockers.engines_failing:
      return ProjectSetupNextActions.repair_ai_visibility
    case null:
      return ProjectSetupNextActions.run_ai_visibility
  }
}

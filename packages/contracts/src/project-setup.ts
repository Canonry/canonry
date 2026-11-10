import { z } from 'zod'
import { observedQueryCountsSchema, runPreviewDtoSchema, runProviderFailureSchema, runQueryCountsByClassSchema, runStatusSchema } from './run.js'
import { siteAuditRunPhaseSchema } from './technical-aeo.js'

/**
 * Where one setup track stands: the status of the project's latest non-probe
 * run of that kind, or `not_started` when it has none. There are no
 * setup-only states: a track the operator passed over is still `not_started`.
 */
export const setupTrackStateSchema = z.enum(['not_started', ...runStatusSchema.options])
export type SetupTrackState = z.infer<typeof setupTrackStateSchema>
export const SetupTrackStates = setupTrackStateSchema.enum

/**
 * Why a new AI Visibility check cannot start right now, from the same
 * readiness the run preview reports: no engine it would call can run, nothing
 * is tracked, an edited Advanced Measurement draft is not published, or every
 * engine it would call keeps failing on its account.
 */
export const aiVisibilitySetupBlockerSchema = z.enum(['no_engine', 'no_queries', 'plan_unpublished', 'engines_failing'])
export type AiVisibilitySetupBlocker = z.infer<typeof aiVisibilitySetupBlockerSchema>
export const AiVisibilitySetupBlockers = aiVisibilitySetupBlockerSchema.enum

/**
 * The step the server suggests next. Agent Readiness comes first: run or retry
 * its audit scan. Then AI Visibility: clear its blocker (connect an engine, add
 * queries, publish the plan, repair failing engines), run the first check, or
 * repair a failed one. `wait` while either track is queued or running, then
 * `open_project` once both have finished.
 */
export const projectSetupNextActionSchema = z.enum([
  'run_agent_readiness',
  'retry_agent_readiness',
  'connect_engine',
  'add_queries',
  'publish_plan',
  'run_ai_visibility',
  'repair_ai_visibility',
  'wait',
  'open_project',
])
export type ProjectSetupNextAction = z.infer<typeof projectSetupNextActionSchema>
export const ProjectSetupNextActions = projectSetupNextActionSchema.enum

const countSchema = z.number().int().nonnegative()

/** The Agent Readiness audit scan track: the latest non-probe `site-audit` run. */
export const agentReadinessSetupTrackSchema = z.object({
  state: setupTrackStateSchema,
  runId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /**
   * Stored progress of the scan while it is queued or running, null otherwise.
   * Raw counters from its latest crawl attempt, never a percentage: the
   * counters are null until an attempt exists, and `pageLimit` is the page
   * budget the scan was started with (null when it recorded none).
   */
  progress: z.object({
    phase: siteAuditRunPhaseSchema,
    pagesFound: countSchema.nullable(),
    pagesChecked: countSchema,
    pageLimit: z.number().int().positive().nullable(),
    linksFound: countSchema.nullable(),
    pagesFailed: countSchema.nullable(),
  }).strict().nullable(),
  /**
   * The scan's own scorecard once it completed or stopped partway (partial),
   * null otherwise. `score` is the 0-100 Agent Readiness score the score read
   * reports for this run, null when the scan scored no page.
   */
  result: z.object({
    score: z.number().nullable(),
    pagesScored: countSchema,
  }).strict().nullable(),
  /** Why the scan failed, null in every other state. */
  error: z.string().nullable(),
}).strict()
export type AgentReadinessSetupTrack = z.infer<typeof agentReadinessSetupTrackSchema>

/** The AI Visibility check track: the latest non-probe `answer-visibility` run. */
export const aiVisibilitySetupTrackSchema = z.object({
  state: setupTrackStateSchema,
  runId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /**
   * How the project measures: `simple` asks its tracked queries, `advanced`
   * measures its published Advanced Measurement plan, or an edited draft that
   * must be published first. Omitted by older servers.
   */
  mode: runPreviewDtoSchema.shape.mode.optional(),
  /**
   * Why a new check cannot start right now, the first an operator must fix:
   * an unpublished plan, then no engine, then no queries. Null when a check can
   * start, and while one is queued or running.
   */
  blockedBy: aiVisibilitySetupBlockerSchema.nullable(),
  /**
   * Engines (provider names, sorted). While a check is queued or running: the
   * engines it calls, its frozen roster less the engines it skips (a Simple
   * check freezes its roster when it starts, so a queued one reports the
   * engines a new check would call). Otherwise: the engines a new check would
   * call. Empty when it would call none.
   */
  engines: z.array(z.string()),
  /**
   * The tracked queries by the class the query list reports (text-classified,
   * or stored on an active Advanced plan's assignments). `unclassified` has no
   * single class. The two classes never share a denominator.
   */
  queries: z.object({
    total: countSchema,
    nonBrand: countSchema,
    branded: countSchema,
    unclassified: countSchema,
  }).strict(),
  /**
   * While the check is queued or running: answers saved so far, and the answers
   * it set out to collect, recorded when it started (null until then, and on
   * checks from before it was recorded). Null otherwise.
   */
  progress: z.object({
    answersSaved: countSchema,
    answersPlanned: countSchema.nullable(),
  }).strict().nullable(),
  /** While the check is queued or running: each engine failing so far, as the run detail reports it. Null otherwise. */
  providerFailures: z.record(z.string(), runProviderFailureSchema).nullable(),
  /**
   * Once the check completed or stopped partway (partial): the answers it saved,
   * the distinct engines that answered, and its observed query counts exactly as
   * the run detail reports them. `queryCountsByClass` keeps non-brand and branded
   * apart; it is null when no observed query has a class (no usable brand name),
   * and both are null when an answer lacks query identity. Null in every other state.
   */
  result: z.object({
    answers: countSchema,
    engines: countSchema,
    queryCounts: observedQueryCountsSchema.nullable(),
    queryCountsByClass: runQueryCountsByClassSchema.nullable(),
  }).strict().nullable(),
  /** Why the check failed, null in every other state. */
  error: z.string().nullable(),
}).strict()
export type AiVisibilitySetupTrack = z.infer<typeof aiVisibilitySetupTrackSchema>

/**
 * One project's first-run setup, read from stored state only: the Agent
 * Readiness audit scan and the AI Visibility check (neither gates the other),
 * and the step the server suggests next. No provider calls, crawls or writes.
 */
export const projectSetupDtoSchema = z.object({
  project: z.object({
    name: z.string(),
    displayName: z.string().nullable(),
    canonicalDomain: z.string(),
  }).strict(),
  /** Each track has produced a result (a completed or partial non-probe run) at least once. A newer run in progress does not undo it. */
  complete: z.boolean(),
  /** `finishedAt` of the earliest completed or partial non-probe audit scan or AI Visibility check; null before any. */
  firstResultAt: z.string().nullable(),
  nextAction: projectSetupNextActionSchema,
  tracks: z.object({
    agentReadiness: agentReadinessSetupTrackSchema,
    aiVisibility: aiVisibilitySetupTrackSchema,
  }).strict(),
}).strict()
export type ProjectSetupDto = z.infer<typeof projectSetupDtoSchema>

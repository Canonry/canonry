import {
  AiVisibilitySetupBlockers,
  ProjectSetupNextActions,
  SITE_AUDIT_ONBOARDING_PAGE_LIMIT,
  SetupTrackStates,
  defaultProviderDisplayName,
  providerConnectionName,
  providerFailureRemedy,
  shellQuote,
  siteAuditRunPhaseSchema,
  type AgentReadinessSetupTrack,
  type AiVisibilitySetupBlocker,
  type AiVisibilitySetupTrack,
  type ObservedQueryCounts,
  type ProjectSetupDto,
  type SetupTrackState,
} from '@canonry/canonry-contracts'
import { createApiClient } from '../client.js'
import { isMachineFormat } from '../cli-error.js'

const TRACK_STATE_LABELS: Readonly<Record<SetupTrackState, string>> = {
  [SetupTrackStates.not_started]: 'Not started',
  [SetupTrackStates.queued]: 'Queued',
  [SetupTrackStates.running]: 'Running',
  [SetupTrackStates.completed]: 'Complete',
  [SetupTrackStates.partial]: 'Partial results',
  [SetupTrackStates.failed]: 'Failed',
  [SetupTrackStates.cancelled]: 'Cancelled',
}

const TRACK_NAME_WIDTH = 'Agent Readiness'.length + 3

/** `canonry project setup <project>`: the setup tracker the dashboard shows, from one server read. */
export async function showProjectSetup(name: string, format?: string): Promise<void> {
  const setup = await createApiClient().getProjectSetup(name)
  if (isMachineFormat(format)) {
    console.log(JSON.stringify(setup, null, 2))
    return
  }
  for (const line of projectSetupLines(setup)) console.log(line)
}

function projectSetupLines(setup: ProjectSetupDto): string[] {
  const { agentReadiness, aiVisibility } = setup.tracks
  const brand = setup.project.displayName ?? setup.project.name
  const rows: Array<{ name: string; state: SetupTrackState; lines: string[] }> = [
    { name: 'Agent Readiness', state: agentReadiness.state, lines: agentReadinessLines(agentReadiness) },
    { name: 'AI Visibility', state: aiVisibility.state, lines: aiVisibilityLines(aiVisibility) },
  ]
  const badgeWidth = Math.max(...rows.map(row => TRACK_STATE_LABELS[row.state].length)) + 3
  const continuation = ' '.repeat(2 + TRACK_NAME_WIDTH + badgeWidth)
  return [
    `${brand} (${setup.project.canonicalDomain})${setup.complete ? ' · setup complete' : ''}`,
    ...rows.flatMap(row => row.lines.map((line, index) => index === 0
      ? `  ${row.name.padEnd(TRACK_NAME_WIDTH)}${TRACK_STATE_LABELS[row.state].padEnd(badgeWidth)}${line}`
      : `${continuation}${line}`)),
    `Next: ${nextStep(setup)}`,
  ]
}

function agentReadinessLines(track: AgentReadinessSetupTrack): string[] {
  switch (track.state) {
    case SetupTrackStates.not_started:
      return [`Reads up to ${SITE_AUDIT_ONBOARDING_PAGE_LIMIT} public pages. No AI engine needed.`]
    case SetupTrackStates.queued:
      return ['Waiting to start']
    case SetupTrackStates.running: {
      const progress = track.progress
      if (progress?.phase === siteAuditRunPhaseSchema.enum.checking) {
        return [`Checking pages · ${progress.pagesChecked}${progress.pageLimit === null ? '' : ` of up to ${progress.pageLimit}`}`]
      }
      return [`Finding pages${progress?.pagesFound == null ? '' : ` · ${progress.pagesFound} found`}`]
    }
    case SetupTrackStates.completed:
    case SetupTrackStates.partial:
      return [track.result?.score == null
        ? 'No page was scored.'
        : `Score ${track.result.score}/100 · ${track.result.pagesScored} ${track.result.pagesScored === 1 ? 'page' : 'pages'} scored`]
    case SetupTrackStates.failed:
      return [`The scan did not finish.${track.error ? ` ${track.error}` : ''}`]
    case SetupTrackStates.cancelled:
      return ['The scan was cancelled.']
  }
}

function blockerLine(blocker: AiVisibilitySetupBlocker): string {
  switch (blocker) {
    case AiVisibilitySetupBlockers.no_engine:
      return 'Needs an AI engine.'
    case AiVisibilitySetupBlockers.no_queries:
      return 'Add queries to check.'
    case AiVisibilitySetupBlockers.plan_unpublished:
      return 'Publish the Advanced Measurement plan before the first check.'
    case AiVisibilitySetupBlockers.engines_failing:
      return 'Every AI engine it would ask keeps failing on its account.'
  }
}

/** The tracked queries, each class counted on its own. */
function trackedQueriesLine(queries: AiVisibilitySetupTrack['queries']): string {
  const classes = [`${queries.nonBrand} non-brand`, `${queries.branded} branded`]
  if (queries.unclassified > 0) classes.push(`${queries.unclassified} without a class`)
  return `${queries.total} ${queries.total === 1 ? 'query' : 'queries'} tracked: ${classes.join(', ')}`
}

/** One population's mentioned and cited counts, each over its own denominator. */
function signalCounts(counts: ObservedQueryCounts): string {
  if (counts.totalQueries === 0) return 'none in this check'
  const citedTotal = counts.totalQueries - (counts.citationNotMeasuredQueries ?? 0)
  const cited = citedTotal === 0 ? 'citations not measured' : `cited in ${counts.citedQueries} of ${citedTotal}`
  return `mentioned in ${counts.mentionedQueries} of ${counts.totalQueries}, ${cited}`
}

function resultLines(result: NonNullable<AiVisibilitySetupTrack['result']>): string[] {
  // The latest check is the baseline only when it is the project's first, as the dashboard says.
  const lines = [`${result.first ? 'Baseline' : 'Latest check'} · ${result.answers} ${result.answers === 1 ? 'answer' : 'answers'} from ${result.engines} ${result.engines === 1 ? 'engine' : 'engines'}`]
  if (result.queryCountsByClass) {
    // Branded and non-brand never share a denominator: each is its own line.
    lines.push(`Non-brand queries: ${signalCounts(result.queryCountsByClass.nonBrand)}`)
    lines.push(`Branded queries: ${signalCounts(result.queryCountsByClass.branded)}`)
    if (result.queryCountsByClass.unclassifiedQueries > 0) {
      const unclassified = result.queryCountsByClass.unclassifiedQueries
      lines.push(`${unclassified} ${unclassified === 1 ? 'query' : 'queries'} without a class, counted in neither`)
    }
  } else if (result.queryCounts) {
    lines.push(`All queries, pooled (no query has a class): ${signalCounts(result.queryCounts)}`)
  }
  return lines
}

function failureLines(track: AiVisibilitySetupTrack): string[] {
  return Object.entries(track.providerFailures ?? {}).map(([engine, failure]) =>
    `${engine}: ${failure.failedQueries} ${failure.failedQueries === 1 ? 'query' : 'queries'} failed${failure.stopped ? ', so this check stopped asking it' : ''}. ${failure.message}`)
}

function aiVisibilityLines(track: AiVisibilitySetupTrack): string[] {
  switch (track.state) {
    case SetupTrackStates.not_started:
      if (track.blockedBy) return [blockerLine(track.blockedBy)]
      return [track.engines.length > 0 ? `Ready to ask ${track.engines.join(', ')}` : 'Ready to check', trackedQueriesLine(track.queries)]
    case SetupTrackStates.queued:
      return ['Waiting to start', ...failureLines(track)]
    case SetupTrackStates.running: {
      const saved = track.progress?.answersSaved ?? 0
      const planned = track.progress?.answersPlanned ?? null
      const engines = track.engines.length > 0 ? `Asking ${track.engines.join(', ')}` : 'Asking engines'
      return [
        planned === null
          ? `${engines} · ${saved} ${saved === 1 ? 'answer' : 'answers'} saved`
          : `${engines} · ${saved} of ${planned} ${planned === 1 ? 'answer' : 'answers'} saved`,
        ...failureLines(track),
      ]
    }
    case SetupTrackStates.completed:
    case SetupTrackStates.partial:
      return track.result ? resultLines(track.result) : ['Result unavailable']
    case SetupTrackStates.failed: {
      const engines = track.failedEngines ?? []
      if (engines.length === 0) return [`The check did not finish.${track.error ? ` ${track.error}` : ''}`]
      // Each engine's message, then what to do about it. The account belongs to
      // the connection, so a routed model names OpenRouter, not the model.
      return ['The check did not finish.', ...engines.flatMap((engine) => {
        const remedy = providerFailureRemedy(engine.code, defaultProviderDisplayName(providerConnectionName(engine.provider)))
        return [`${engine.provider}: ${engine.message}`, ...(remedy ? [remedy] : [])]
      })]
    }
    case SetupTrackStates.cancelled:
      return ['The check was cancelled.', ...(track.blockedBy ? [blockerLine(track.blockedBy)] : [])]
  }
}

/** The CLI command for the server's next action. */
function nextStep(setup: ProjectSetupDto): string {
  const project = shellQuote(setup.project.name)
  const scan = `cnry agent-readiness run ${project} --max-pages ${SITE_AUDIT_ONBOARDING_PAGE_LIMIT}`
  const aiVisibility = setup.tracks.aiVisibility
  switch (setup.nextAction) {
    case ProjectSetupNextActions.run_agent_readiness:
      return `run the Agent Readiness audit scan: ${scan}`
    case ProjectSetupNextActions.retry_agent_readiness:
      return `run the audit scan again: ${scan}`
    case ProjectSetupNextActions.connect_engine:
      return 'connect an AI engine: cnry settings provider <name> --api-key <key>'
    case ProjectSetupNextActions.add_queries:
      return `add queries: cnry query add ${project} "<query>"`
    case ProjectSetupNextActions.publish_plan:
      return `publish the Advanced Measurement draft: cnry measurement-plan advanced ${project} draft-action <json>, with action "publish"`
    case ProjectSetupNextActions.run_ai_visibility:
      return `run the AI Visibility check (cnry run preview ${project} shows what it will ask): cnry run ${project}`
    case ProjectSetupNextActions.repair_ai_visibility:
      return aiVisibility.state === SetupTrackStates.failed && aiVisibility.runId
        ? `see why the check failed, then fix the engine: cnry run show ${shellQuote(aiVisibility.runId)}`
        : 'fix the failing engine\'s key, access or billing, then save it: cnry settings provider <name> --api-key <key>'
    case ProjectSetupNextActions.wait:
      return `wait for the work in progress, then check again: cnry project setup ${project}`
    case ProjectSetupNextActions.open_project:
      return `read the results: cnry overview ${project}`
  }
}

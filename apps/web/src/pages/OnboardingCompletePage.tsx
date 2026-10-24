import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameRunsOptions, getApiV1ProjectsByNameMeasurementSetupOptions, getApiV1ProjectsByNameQueriesOptions } from '@canonry/canonry-api-client/react-query'
import { ONBOARDING_FLOW_VERSION, RunKinds, RunStatuses, RunTriggers, type OnboardingNextAction, type RunKind } from '@canonry/canonry-contracts'
import { ArrowRight, Check, Copy } from 'lucide-react'

import { heyClient, recordOnboardingEvent } from '../api.js'
import { createOnboardingEventId, getOrCreateOnboardingSessionId } from '../lib/onboarding-telemetry.js'
import { wasOnboardingScanSkipped } from '../lib/onboarding-draft.js'
import { addToast } from '../lib/toast-store.js'
import { OnboardingProgress, type OnboardingStage, type OnboardingStageOutcome } from '../components/shared/OnboardingProgress.js'
import { Button } from '../components/ui/button.js'

export const AGENT_MCP_INSTALL_COMMAND = 'canonry mcp install --client claude-code'
const AGENT_DOCS_URL = 'https://github.com/Canonry/canonry/blob/main/docs/mcp.md'

/**
 * Finish-step telemetry. Rides the existing `onboarding.started` and
 * `onboarding.step_completed` events with `step: 'finish'`, because the
 * canonry.ai collector allowlists event NAMES and silently drops new ones.
 * Tagged `platform`: every path here starts at the first-run launchpad, and
 * the same session id ties it to that funnel. Each action is recorded once.
 */
function useFinishTelemetry() {
  const onboardingSessionId = useRef(getOrCreateOnboardingSessionId()).current
  const recorded = useRef(new Set<string>())
  const send = useCallback((key: string, event: Record<string, unknown>) => {
    if (recorded.current.has(key)) return
    recorded.current.add(key)
    void recordOnboardingEvent({
      ...event,
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      surface: 'platform',
      eventId: createOnboardingEventId(),
    } as Parameters<typeof recordOnboardingEvent>[0])
  }, [onboardingSessionId])
  useEffect(() => {
    send('started', { event: 'onboarding.started', step: 'finish', resumed: false })
  }, [send])
  return useCallback((nextAction: OnboardingNextAction) => {
    send(`action:${nextAction}`, { event: 'onboarding.step_completed', step: 'finish', method: 'manual', nextAction })
  }, [send])
}

export function OnboardingCompletePage({
  projectName,
  skippedVisibility = false,
}: {
  projectName: string
  skippedVisibility?: boolean
}) {
  const trackNextAction = useFinishTelemetry()
  const scan = useOnboardingRunOutcome(projectName, RunKinds['site-audit'])
  const scanOutcome = scan.outcome === 'not-started' && wasOnboardingScanSkipped(projectName) ? 'skipped' : scan.outcome
  const sweep = useOnboardingRunOutcome(projectName, RunKinds['answer-visibility'])
  const sweepOutcome = sweep.outcome
  const readiness = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({ client: heyClient, path: { name: projectName } }),
    enabled: sweepOutcome === 'not-started',
    retry: false,
  })
  const savedQueries = useQuery({
    ...getApiV1ProjectsByNameQueriesOptions({ client: heyClient, path: { name: projectName } }),
    enabled: sweepOutcome === 'not-started',
    retry: false,
  })
  const setupAction = readiness.data?.answerVisibilityProviderReady === false
    ? 'Connect an engine'
    : savedQueries.isSuccess && savedQueries.data.length === 0
      ? 'Add queries'
      : readiness.data?.answerVisibilityProviderReady === true && savedQueries.isSuccess
        ? 'Start first sweep'
        : 'Continue setup'
  const outcomes: Partial<Record<OnboardingStage, OnboardingStageOutcome>> = {
    ...(scanOutcome ? { site: scanOutcome, fixes: scanOutcome } : {}),
    ...visibilityOutcome(sweepOutcome, skippedVisibility),
  }

  return (
    <div className="page-container max-w-4xl py-8 md:py-10">
      <OnboardingProgress current="done" outcomes={outcomes} />
      <div className="mx-auto mt-10 max-w-2xl md:mt-14">
        <header>
          <p className="break-words text-sm text-secondary">{projectName}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-heading">Project saved</h1>
          <p className="mt-3 text-base text-secondary" role="status">
            {sweepOutcome === undefined ? 'Latest AI sweep complete.'
              : sweepOutcome === 'partial' ? 'Latest AI sweep has partial results.'
              : sweepOutcome === 'queued' ? 'AI sweep queued.'
              : sweepOutcome === 'running' ? 'AI sweep running.'
              : sweepOutcome === 'failed' ? 'Latest AI sweep failed.'
              : sweepOutcome === 'cancelled' ? 'Latest AI sweep cancelled.'
              : sweepOutcome === 'unknown' ? 'AI Visibility status unconfirmed.'
              : 'No AI sweep yet.'}
          </p>
          {sweep.hasEarlierResults ? <p className="mt-2 text-sm text-secondary">Earlier AI results remain available.</p> : null}
          {scan.hasEarlierResults ? <p className="mt-2 text-sm text-secondary">Earlier page health results remain available.</p> : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild className="h-11">
              <Link to="/projects/$projectName" params={{ projectName }} replace aria-label={`Open project ${projectName}`} onClick={() => trackNextAction('open_project')}>
                Open project <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            {sweepOutcome === 'not-started' ? (
              <Button asChild variant="secondary" className="h-11">
                <Link to="/setup" search={{ experience: 'legacy', onboarding: 'first-run', setupProject: projectName }}>{setupAction}</Link>
              </Button>
            ) : null}
          </div>
        </header>
        <OptionalSetup projectName={projectName} onAction={trackNextAction} />
      </div>
    </div>
  )
}

/** The outcome of a project's runs of one kind, re-read while one is in flight. */
export function useOnboardingRunOutcome(projectName: string, kind: RunKind, enabled = true): { outcome: OnboardingStageOutcome | undefined; hasEarlierResults: boolean } {
  const query = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind, limit: 5000 },
    }),
    enabled,
    retry: false,
    // A run still going when the operator got here finishes on its own;
    // re-read until it does, so the step turns complete without a reload.
    refetchInterval: (current) => {
      const outcome = runOutcome(current.state.status === 'success'
        ? { isSuccess: true, data: current.state.data }
        : { isSuccess: false })
      return outcome === 'queued' || outcome === 'running' ? 5_000 : false
    },
  })
  const runs = query.data?.filter(run => run.trigger !== RunTriggers.probe) ?? []
  return {
    outcome: runOutcome(query),
    hasEarlierResults: runs.slice(0, -1).some(run => run.status === RunStatuses.completed || run.status === RunStatuses.partial),
  }
}

/**
 * AI Visibility is done only when a sweep finished. Skipping it this visit
 * reads "Skipped" unless an earlier sweep already finished; "Finish setup"
 * pressed mid-sweep reads "In progress" until the sweep lands.
 */
export function visibilityOutcome(
  sweep: OnboardingStageOutcome | undefined,
  skipped: boolean,
): Partial<Record<OnboardingStage, OnboardingStageOutcome>> {
  if (sweep === undefined) return {}
  if (skipped && sweep === 'not-started') return { visibility: 'skipped' }
  return { visibility: sweep }
}

/**
 * How the latest non-probe run ended, or `undefined` when it completed. A
 * partial run keeps its coverage qualifier; a queued or running one is still in progress, a
 * failed one did not finish, and a history read that has not answered (or
 * failed) proves nothing either way.
 */
export function runOutcome(query: {
  isSuccess: boolean
  data?: ReadonlyArray<{ trigger: string; status: string }>
}): OnboardingStageOutcome | undefined {
  if (!query.isSuccess || !query.data) return 'unknown'
  const scans = query.data.filter(run => run.trigger !== RunTriggers.probe)
  // The project-scoped runs endpoint returns chronological order.
  const latest = scans.at(-1)
  if (!latest) return 'not-started'
  if (latest.status === RunStatuses.completed) return undefined
  if (latest.status === RunStatuses.partial) return 'partial'
  if (latest.status === RunStatuses.queued) return 'queued'
  if (latest.status === RunStatuses.running) return 'running'
  if (latest.status === RunStatuses.failed) return 'failed'
  if (latest.status === RunStatuses.cancelled) return 'cancelled'
  return 'unknown'
}

const DATA_SOURCES = [
  { label: 'Search Console', action: 'connect_search_console', to: '/projects/$projectName/search-console' },
  { label: 'Google Analytics', action: 'connect_analytics', to: '/projects/$projectName/activity' },
  { label: 'Business Profile', action: 'connect_business_profile', to: '/projects/$projectName/local' },
] as const

function OptionalSetup({ projectName, onAction }: { projectName: string; onAction: (action: OnboardingNextAction) => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_MCP_INSTALL_COMMAND)
      onAction('copy_agent_command')
      setCopied(true)
    } catch {
      addToast({ tone: 'negative', title: 'Could not copy the command', detail: `Run ${AGENT_MCP_INSTALL_COMMAND} in your terminal.` })
    }
  }
  const linkClass = 'inline-flex min-h-11 items-center text-sm font-medium text-link underline-offset-4 hover:underline'

  return (
    <section aria-labelledby="onb-options-heading" className="mt-10">
      <h2 id="onb-options-heading" className="mb-2 text-sm font-medium text-secondary">Optional setup</h2>
      <ul className="divide-y divide-default border-y border-default">
        <li>
          <details>
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-heading">Connect your agent</summary>
            <div className="flex flex-wrap items-center gap-3 pb-4">
              <code className="min-w-0 break-all text-[13px] text-secondary">{AGENT_MCP_INSTALL_COMMAND}</code>
              <Button type="button" variant="secondary" size="sm" onClick={() => { void copy() }}>
                {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy command'}
              </Button>
              <a href={AGENT_DOCS_URL} target="_blank" rel="noreferrer" className={linkClass}>Other clients</a>
            </div>
          </details>
        </li>
        <li>
          <details>
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-heading">Connect data sources</summary>
            <ul className="pb-3 pl-4">
              <li><Link to="/traffic" className={linkClass} onClick={() => onAction('connect_server_traffic')}>Connect server-side traffic</Link></li>
              {DATA_SOURCES.map(({ label, action, to }) => (
                <li key={label}><Link to={to} params={{ projectName }} className={linkClass} onClick={() => onAction(action)}>Connect {label}</Link></li>
              ))}
            </ul>
          </details>
        </li>
        <li>
          <Link to="/projects/$projectName/settings" params={{ projectName }} className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm font-medium text-heading" onClick={() => onAction('set_schedule')}>
            Set a schedule <ArrowRight className="size-4 text-muted" aria-hidden="true" />
          </Link>
        </li>
        <li>
          <Link to="/projects/$projectName/settings" params={{ projectName }} className="flex min-h-11 items-center justify-between gap-3 py-3 text-sm font-medium text-heading" onClick={() => onAction('add_notification')}>
            Add a notification <ArrowRight className="size-4 text-muted" aria-hidden="true" />
          </Link>
        </li>
      </ul>
      <Link to="/projects/$projectName/technical-aeo" params={{ projectName }} className={`${linkClass} mt-2`} onClick={() => onAction('review_page_health')}>Review page health</Link>
    </section>
  )
}

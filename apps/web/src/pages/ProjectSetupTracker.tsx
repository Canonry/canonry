import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import {
  AiVisibilitySetupBlockers,
  ONBOARDING_FLOW_VERSION,
  RunKinds,
  SITE_AUDIT_ONBOARDING_PAGE_LIMIT,
  SetupTrackStates,
  bucketOnboardingCount,
  describeError,
  formatLocaleLabel,
  normalizeProjectDomain,
  providerConnectionName,
  providerFailureRemedy,
  siteAuditRunPhaseSchema,
  type AgentReadinessSetupTrack,
  type AiVisibilitySetupBlocker,
  type AiVisibilitySetupTrack,
  type ProjectSetupDto,
  type RunKind,
  type SetupTrackState,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameOptions,
  getApiV1ProjectsByNameQueriesOptions,
  getApiV1ProjectsByNameSetupOptions,
  getApiV1ProjectsByNameSetupQueryKey,
  getApiV1RunsByIdOptions,
  getApiV1RunsQueryKey,
  postApiV1RunsByIdCancelMutation,
} from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../api.js'
import { extractApiErrorInfo } from '../lib/extract-error-message.js'
import { Button } from '../components/ui/button.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { JobProgress } from '../components/shared/JobProgress.js'
import { NextSteps } from '../components/shared/NextSteps.js'
import { SetupTrackBadge, SetupTrackerList, SetupTrackerRow, setupRowMark } from '../components/setup/SetupTracker.js'
import { AiVisibilitySetupPanel, type SetupPanelStep } from '../components/setup/AiVisibilitySetupPanel.js'
import { FeaturedAnswer, FirstResultTable, featuredSetupAnswer } from '../components/setup/FirstResult.js'
import { useAccount } from '../contexts/account-context.js'
import { useOnboardingTelemetry } from '../hooks/use-onboarding-telemetry.js'
import { formatSweepInstant } from '../lib/format-helpers.js'
import { markOnboardingRunHandled, markOnboardingRunLaunched, onboardingErrorReason, readOnboardingLaunchedRun } from '../lib/onboarding-telemetry.js'
import { providerDisplayName } from '../lib/visibility-trend-helpers.js'
import { useTriggerSiteAudit } from '../queries/mutations.js'

/** The tracker row a link opens: the URL holds which row is open, never progress. */
export type SetupTrackName = 'agent-readiness' | 'ai-visibility'

export const CRAWL_CONSENT_HELP = `Public pages only, read by this Canonry server and stored with this project. The first scan reads up to ${SITE_AUDIT_ONBOARDING_PAGE_LIMIT} pages, then stops.`

const ScanPhases = siteAuditRunPhaseSchema.enum

function isActive(state: SetupTrackState): boolean {
  return state === SetupTrackStates.queued || state === SetupTrackStates.running
}

/** A row whose next step starts something: never run, cancelled, or failed. */
function needsStart(state: SetupTrackState): boolean {
  return state === SetupTrackStates.not_started || state === SetupTrackStates.cancelled || state === SetupTrackStates.failed
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * One project's setup as a tracker: Website, Agent Readiness, and AI Visibility,
 * in that order, each read from `GET /projects/{name}/setup`. The two tracks are
 * independent: starting one never hides or misstates the other, and a row says
 * what the server says, never what the browser guessed from a step position.
 */
export function ProjectSetupTracker({
  projectName,
  firstRun,
  track,
}: {
  projectName: string
  /** First setup of the install: the page says so. */
  firstRun: boolean
  track?: SetupTrackName
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { canWrite, isAdmin } = useAccount()
  const setupQuery = useQuery({
    ...getApiV1ProjectsByNameSetupOptions({ client: heyClient, path: { name: projectName } }),
    retry: false,
    // Fast while a job runs; slowly otherwise, so work started from the CLI or
    // an agent shows up without a reload.
    refetchInterval: ({ state }) => state.data && (isActive(state.data.tracks.agentReadiness.state) || isActive(state.data.tracks.aiVisibility.state))
      ? 3_000
      : 15_000,
  })
  const projectQuery = useQuery({
    ...getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: projectName } }),
    retry: false,
  })
  const [aiPanelStep, setAiPanelStep] = useState<SetupPanelStep | null>(null)
  /**
   * A check queued from the panel, with the run the setup read listed when it
   * was queued. It reads as starting only while the read still lists that
   * run: once it lists any other (this check, or a newer one started from the
   * CLI or an agent), the read is current again.
   */
  const [pendingCheck, setPendingCheck] = useState<{ runId: string; listedRunId: string | null } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const deepLinkHandled = useRef(false)
  const aiTrack = setupQuery.data?.tracks.aiVisibility
  useEffect(() => {
    if (!aiTrack) return
    // A check that started anywhere (here, the CLI, an agent) closes the panel,
    // so it cannot reopen on its own when that check ends.
    if (isActive(aiTrack.state)) {
      deepLinkHandled.current = true
      setAiPanelStep(null)
      return
    }
    // A link that names the AI Visibility row opens its panel once, at the step
    // the server's blocker calls for.
    if (track === 'ai-visibility' && !deepLinkHandled.current) {
      deepLinkHandled.current = true
      setAiPanelStep(panelStepFor(aiTrack.blockedBy))
    }
  }, [track, aiTrack])

  const refreshSetup = () => queryClient.invalidateQueries({
    queryKey: getApiV1ProjectsByNameSetupQueryKey({ client: heyClient, path: { name: projectName } }),
  })
  const reportRunStarted = useRunOutcomeTelemetry(projectName, setupQuery.data)
  useRunsListRefreshOnFinish(setupQuery.data)
  const loaded = setupQuery.isSuccess
  useEffect(() => {
    if (loaded) headingRef.current?.focus({ preventScroll: true })
  }, [loaded])
  const setOpenTrack = (next: SetupTrackName | undefined) => {
    void navigate({ to: '/setup', search: prev => ({ ...prev, track: next }), replace: true })
  }
  const openAiPanel = (step: SetupPanelStep) => {
    setAiPanelStep(step)
    setOpenTrack('ai-visibility')
  }
  const closeAiPanel = () => {
    setAiPanelStep(null)
    setOpenTrack(undefined)
  }

  if (setupQuery.isPending) return <SetupTrackerSkeleton />
  if (setupQuery.isError) {
    const notFound = extractApiErrorInfo(setupQuery.error).code === 'NOT_FOUND'
    return (
      <div className="page-container max-w-3xl">
        <h1 className="text-heading-24 text-heading">{firstRun ? 'Set up Canonry' : 'Project setup'}</h1>
        <div role="alert" className="mt-6 rounded-md border border-negative bg-negative-soft p-4">
          <p className="text-copy-14-strong text-heading">{notFound ? `No project named ${projectName}.` : 'Setup status could not be loaded.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {notFound
              ? <Button asChild variant="secondary" size="sm"><Link to="/projects">View projects</Link></Button>
              : <Button type="button" variant="secondary" size="sm" onClick={() => { void setupQuery.refetch() }}>Retry</Button>}
          </div>
        </div>
      </div>
    )
  }

  const setup = setupQuery.data
  const project = projectQuery.data
  const brand = setup.project.displayName || setup.project.name
  const domain = normalizeProjectDomain(setup.project.canonicalDomain)
  const locale = project ? formatLocaleLabel(project.country, project.language) : null
  const scan = setup.tracks.agentReadiness
  const ai = setup.tracks.aiVisibility
  const checkStarting = pendingCheck !== null && ai.runId === pendingCheck.listedRunId && ai.runId !== pendingCheck.runId
  const aiPanelOpen = canWrite && aiPanelStep !== null && !isActive(ai.state)
  // One primary per view: the open panel owns it; otherwise the first row, in
  // order, whose next step starts something.
  const primaryRow: SetupTrackName | null = aiPanelOpen || !canWrite
    ? null
    : needsStart(scan.state)
      ? 'agent-readiness'
      : needsStart(ai.state) && !checkStarting
        ? 'ai-visibility'
        : null

  return (
    <div className="page-container max-w-3xl">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 ref={headingRef} tabIndex={-1} className="text-heading-24 text-heading outline-none">{firstRun ? 'Set up Canonry' : 'Project setup'}</h1>
          <p className="mt-1 text-copy-14 text-secondary">{setup.complete ? 'Setup complete · ' : null}{brand} · {domain}</p>
        </div>
        <Button asChild variant={setup.complete ? 'default' : 'ghost'} className="shrink-0">
          <Link to="/projects/$projectName" params={{ projectName }}>
            Open project
            {setup.complete ? null : <ArrowRight className="size-4" aria-hidden="true" />}
          </Link>
        </Button>
      </header>

      <SetupTrackerList label="Setup progress">
        <SetupTrackerRow
          id="setup-website"
          title="Website"
          mark="done"
          summary={locale ? `${domain} · ${locale}` : domain}
          trailing={canWrite ? (
            <Link
              className="shrink-0 text-label-14 text-secondary underline underline-offset-4 hover:text-primary"
              to="/projects/$projectName/settings"
              params={{ projectName }}
            >
              Edit<span className="sr-only"> website</span>
            </Link>
          ) : null}
        />
        <AgentReadinessRow
          projectName={projectName}
          projectId={project?.id ?? null}
          brand={brand}
          track={scan}
          primary={primaryRow === 'agent-readiness'}
          canWrite={canWrite}
          onStarted={async (runId) => {
            reportRunStarted(runId, RunKinds['site-audit'])
            await refreshSetup()
          }}
          onCancelled={refreshSetup}
        />
        <AiVisibilityRow
          projectName={projectName}
          brand={brand}
          domain={domain}
          track={ai}
          panelStep={aiPanelOpen ? aiPanelStep : null}
          onOpenPanel={openAiPanel}
          onClosePanel={closeAiPanel}
          starting={checkStarting}
          onLaunched={(runId) => {
            reportRunStarted(runId, RunKinds['answer-visibility'])
            setPendingCheck({ runId, listedRunId: ai.runId })
            closeAiPanel()
            void refreshSetup()
          }}
          onCancelled={refreshSetup}
          primary={primaryRow === 'ai-visibility'}
          canWrite={canWrite}
          isAdmin={isAdmin}
        />
      </SetupTrackerList>
      {/* Screen readers hear each track's state when it changes, never each progress tick. */}
      <p role="status" className="sr-only">{scanStatusLine(scan)}</p>
      <p role="status" className="sr-only">{checkStatusLine(ai, checkStarting ? SetupTrackStates.queued : ai.state)}</p>

      {setup.complete ? <NextSteps projectName={projectName} /> : null}
    </div>
  )
}

/**
 * Onboarding telemetry for the runs started from this tracker: each run's start
 * and its outcome, once, on the surface its funnel has always used (the audit
 * scan on `site_health`, the AI Visibility check on `wizard`). The tracker
 * remembers the runs it started; after a reload, the session's launched-run
 * marker still names the last one.
 */
function useRunOutcomeTelemetry(projectName: string, setup: ProjectSetupDto | undefined) {
  const { emit: emitScan, onboardingSessionId: scanSession } = useOnboardingTelemetry('site_health')
  const { emit: emitCheck, onboardingSessionId: checkSession } = useOnboardingTelemetry('wizard')
  const started = useRef(new Map<string, RunKind>())
  useEffect(() => {
    const marker = readOnboardingLaunchedRun(projectName)
    if (marker?.kind) started.current.set(marker.runId, marker.kind)
  }, [projectName])

  useEffect(() => {
    if (!setup) return
    const tracks: Array<{ runId: string | null; state: SetupTrackState; kind: RunKind; answers: number | null }> = [
      { ...setup.tracks.agentReadiness, kind: RunKinds['site-audit'], answers: null },
      { ...setup.tracks.aiVisibility, kind: RunKinds['answer-visibility'], answers: setup.tracks.aiVisibility.result?.answers ?? null },
    ]
    for (const { runId, state, kind, answers } of tracks) {
      if (!runId || started.current.get(runId) !== kind) continue
      const telemetry = kind === RunKinds['site-audit']
        ? { emit: emitScan, onboardingSessionId: scanSession }
        : { emit: emitCheck, onboardingSessionId: checkSession }
      // A check that finished without saving an answer produced nothing to read.
      const succeeded = (state === SetupTrackStates.completed || state === SetupTrackStates.partial) && answers !== 0
      const reasonCode = state === SetupTrackStates.cancelled
        ? 'run_cancelled' as const
        : state === SetupTrackStates.failed || ((state === SetupTrackStates.completed || state === SetupTrackStates.partial) && answers === 0)
          ? 'run_failed' as const
          : null
      if (succeeded) {
        telemetry.emit({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId: telemetry.onboardingSessionId,
          event: 'onboarding.step_completed',
          step: 'run',
          method: 'automatic',
          ...(answers === null ? {} : { countBucket: bucketOnboardingCount(answers) }),
        }, `onboarding.step_completed:run:${runId}`)
      } else if (reasonCode) {
        telemetry.emit({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId: telemetry.onboardingSessionId,
          event: 'onboarding.blocked',
          step: 'run',
          action: 'retry_run',
          reasonCode,
        }, `onboarding.blocked:run:${runId}:${reasonCode}`)
      } else {
        continue
      }
      // Reported once: a later read or a remount does not report it again.
      started.current.delete(runId)
      markOnboardingRunHandled(runId)
    }
  }, [checkSession, emitCheck, emitScan, scanSession, setup])

  return (runId: string, kind: RunKind) => {
    started.current.set(runId, kind)
    if (kind === RunKinds['site-audit']) {
      markOnboardingRunLaunched(projectName, runId, kind)
      emitScan({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId: scanSession,
        event: 'onboarding.started',
        step: 'run',
        resumed: false,
      }, `onboarding.started:${runId}`)
    }
  }
}

/**
 * The top bar's task list and the run notices read the runs list on their own
 * clock. When this tracker sees a scan or check finish, read the list now, so
 * the top bar never says Running beside a row that already finished.
 */
function useRunsListRefreshOnFinish(setup: ProjectSetupDto | undefined) {
  const queryClient = useQueryClient()
  const scan = setup?.tracks.agentReadiness.state
  const check = setup?.tracks.aiVisibility.state
  const previous = useRef<{ scan?: SetupTrackState; check?: SetupTrackState }>({})
  useEffect(() => {
    const before = previous.current
    previous.current = { scan, check }
    const finished = (from: SetupTrackState | undefined, to: SetupTrackState | undefined) =>
      from !== undefined && to !== undefined && isActive(from) && !isActive(to)
    if (finished(before.scan, scan) || finished(before.check, check)) {
      void queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) })
    }
  }, [scan, check, queryClient])
}

/**
 * Stops a queued or running scan or check once the operator confirms in place.
 * Stopping is final and keeps no result, so the confirmation says so and its
 * first button keeps the job running.
 */
function CancelRunAction({ runId, noun, onCancelled }: { runId: string; noun: 'scan' | 'check'; onCancelled: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = useMutation({ ...postApiV1RunsByIdCancelMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  // The question and its answers swap places in this component alone, so it
  // moves focus itself: to Keep running when asked, back to the question after.
  const askRef = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const moveFocus = useRef(false)
  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    ;(confirming ? keepRef : askRef).current?.focus()
  }, [confirming])
  const toggle = (next: boolean) => {
    moveFocus.current = true
    setError(null)
    setConfirming(next)
  }
  const stop = async () => {
    if (cancel.isPending) return
    setError(null)
    try {
      await cancel.mutateAsync({ path: { id: runId } })
    } catch (cause) {
      setError(`The ${noun} could not be stopped. ${describeError(cause)}`)
    }
    // Read setup either way: a job that could not be stopped may have just finished.
    await onCancelled()
  }
  if (!confirming) {
    // The row never lands focus here on its own: after a start, a stray Enter must not begin stopping the job.
    return <Button ref={askRef} type="button" variant="ghost" data-focus-skip onClick={() => toggle(true)}>Cancel {noun}</Button>
  }
  return (
    <div role="group" aria-label={`Stop the ${noun}`} className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      <p className="text-copy-14 text-secondary">Stop the {noun}? {noun === 'scan' ? 'It saves no score.' : 'It saves no baseline.'}</p>
      {/* Stay focusable while stopping (aria-disabled), so focus never drops to the page. */}
      <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
        <Button ref={keepRef} type="button" variant="ghost" aria-disabled={cancel.isPending || undefined} onClick={() => { if (!cancel.isPending) toggle(false) }}>Keep running</Button>
        <Button type="button" variant="secondary" aria-disabled={cancel.isPending || undefined} onClick={() => { void stop() }}>
          {cancel.isPending ? 'Stopping…' : `Stop ${noun}`}
        </Button>
      </div>
      {error ? <p role="alert" className="w-full text-right text-copy-14 text-negative">{error}</p> : null}
    </div>
  )
}

function SetupTrackerSkeleton() {
  return (
    <div className="page-container max-w-3xl" aria-busy="true">
      <div className="skeleton-text h-6 w-40" />
      <div className="skeleton-text-sm mt-2 w-56" />
      <div className="material-base mt-6 space-y-6 p-5">
        {[1, 2, 3].map(row => (
          <div key={row} className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <div className="skeleton-text w-32" />
              <div className="skeleton-text-sm w-64" />
            </div>
            <div className="skeleton h-5 w-20 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** The audit scan's state in one sentence for screen readers; nothing before it starts. */
function scanStatusLine(track: AgentReadinessSetupTrack): string {
  switch (track.state) {
    case SetupTrackStates.not_started:
      return ''
    case SetupTrackStates.queued:
      return 'Agent Readiness audit scan queued.'
    case SetupTrackStates.running:
      return 'Agent Readiness audit scan running.'
    case SetupTrackStates.completed:
    case SetupTrackStates.partial: {
      const head = track.state === SetupTrackStates.partial ? 'Agent Readiness audit scan stopped partway.' : 'Agent Readiness audit scan complete.'
      const score = track.result?.score ?? null
      return score === null ? head : `${head} Score ${Math.round(score)} of 100.`
    }
    case SetupTrackStates.failed:
      return 'Agent Readiness audit scan failed.'
    case SetupTrackStates.cancelled:
      return 'Agent Readiness audit scan cancelled.'
    default: {
      const exhaustive: never = track.state
      return exhaustive
    }
  }
}

/** The AI Visibility check's state in one sentence for screen readers; nothing before it starts. */
function checkStatusLine(track: AiVisibilitySetupTrack, state: SetupTrackState): string {
  switch (state) {
    case SetupTrackStates.not_started:
      return ''
    case SetupTrackStates.queued:
      return 'AI Visibility check queued.'
    case SetupTrackStates.running:
      return 'AI Visibility check running.'
    case SetupTrackStates.completed:
    case SetupTrackStates.partial: {
      const head = state === SetupTrackStates.partial ? 'AI Visibility check stopped partway.' : 'AI Visibility check complete.'
      const result = track.result
      return result ? `${head} ${plural(result.answers, 'answer', 'answers')} from ${plural(result.engines, 'engine', 'engines')}.` : head
    }
    case SetupTrackStates.failed:
      return 'AI Visibility check failed.'
    case SetupTrackStates.cancelled:
      return 'AI Visibility check cancelled.'
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

/** What the audit scan is doing now, from the server's exact progress. */
function scanProgressLine(track: AgentReadinessSetupTrack): { phase: string; count: string | null; done: number | null; total: number | null } {
  const progress = track.progress
  if (!progress) {
    return { phase: track.state === SetupTrackStates.queued ? 'Waiting to start' : 'Starting the scan', count: null, done: null, total: null }
  }
  switch (progress.phase) {
    case ScanPhases.queued:
      return { phase: 'Waiting to start', count: null, done: null, total: null }
    case ScanPhases.discovering:
      return { phase: 'Finding pages', count: progress.pagesFound === null ? null : `${progress.pagesFound} found`, done: null, total: null }
    case ScanPhases.checking: {
      // Against the pages found so far, once fewer than the cap: a bar measured
      // against the cap could never fill on a site smaller than it.
      const found = progress.pagesFound
      const limit = progress.pageLimit
      if (found !== null && (limit === null || found < limit)) {
        return { phase: 'Checking pages', count: `${progress.pagesChecked} of ${found}`, done: progress.pagesChecked, total: found }
      }
      return {
        phase: 'Checking pages',
        count: limit === null ? `${progress.pagesChecked} checked` : `${progress.pagesChecked} of up to ${limit}`,
        done: progress.pagesChecked,
        total: limit,
      }
    }
    case ScanPhases['arranging-map']:
      return { phase: 'Building the score', count: plural(progress.pagesChecked, 'page checked', 'pages checked'), done: null, total: null }
    case ScanPhases.completed:
    case ScanPhases.partial:
    case ScanPhases.failed:
    case ScanPhases.cancelled:
      // The run's status catches up on the next read.
      return { phase: 'Finishing', count: null, done: null, total: null }
    default: {
      const exhaustive: never = progress.phase
      return exhaustive
    }
  }
}

function AgentReadinessRow({
  projectName,
  projectId,
  brand,
  track,
  primary,
  canWrite,
  onStarted,
  onCancelled,
}: {
  projectName: string
  projectId: string | null
  brand: string
  track: AgentReadinessSetupTrack
  primary: boolean
  canWrite: boolean
  onStarted: (runId: string) => Promise<void>
  onCancelled: () => Promise<unknown>
}) {
  const siteAudit = useTriggerSiteAudit()
  const { onboardingSessionId, emit } = useOnboardingTelemetry('platform')
  const [startError, setStartError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const state = track.state

  const start = async () => {
    if (!projectId || starting) return
    setStartError(null)
    setStarting(true)
    try {
      const started = await siteAudit.mutateAsync({
        projectName,
        projectId,
        projectLabel: brand,
        suppressErrorToast: true,
        // The row shows the queued scan; a toast would repeat it.
        suppressQueuedToast: true,
        body: { checkDeadLinks: true, maxPages: SITE_AUDIT_ONBOARDING_PAGE_LIMIT },
      })
      // A crawl has no engines and no queries, so the zero buckets are honest.
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'queued',
        kind: 'site_health',
        providerCountBucket: '0',
        queryCountBucket: '0',
      })
      await onStarted(started.runId)
    } catch (error) {
      setStartError(`The audit scan could not start. ${describeError(error)}`)
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'rejected',
        kind: 'site_health',
        providerCountBucket: '0',
        queryCountBucket: '0',
        reasonCode: onboardingErrorReason(error, 'run_rejected'),
      })
    } finally {
      setStarting(false)
    }
  }

  // While starting, the button stays enabled (aria-disabled) so it keeps focus
  // until the row swaps it for progress; `start` ignores a second press.
  const startButton = (label: string) => canWrite ? (
    <Button
      type="button"
      variant={primary ? 'default' : 'secondary'}
      disabled={!projectId}
      aria-disabled={starting || undefined}
      className={starting ? 'opacity-50' : undefined}
      onClick={() => { void start() }}
    >
      {starting ? 'Starting…' : label}
    </Button>
  ) : null

  let summary: ReactNode = null
  let body: ReactNode = null
  let action: ReactNode = null
  switch (state) {
    case SetupTrackStates.not_started:
    case SetupTrackStates.cancelled:
      summary = (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          {state === SetupTrackStates.cancelled ? 'The last scan was cancelled. ' : null}
          Reads up to {SITE_AUDIT_ONBOARDING_PAGE_LIMIT} public pages. No AI engine needed.
          <InfoTooltip text={CRAWL_CONSENT_HELP} />
        </span>
      )
      action = startButton(state === SetupTrackStates.cancelled ? 'Run audit scan again' : 'Run audit scan')
      break
    case SetupTrackStates.queued:
    case SetupTrackStates.running: {
      const line = scanProgressLine(track)
      const progress = track.progress
      body = (
        <>
          <JobProgress
            label="Agent Readiness audit scan progress"
            noun="scan"
            phase={line.phase}
            count={line.count}
            done={line.done}
            total={line.total}
            startedAt={track.startedAt}
          />
          {progress ? (
            <details className="mt-2">
              <summary className="cursor-pointer py-1 text-label-14 text-secondary">Scan details</summary>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                {([
                  ['Pages found', progress.pagesFound],
                  ['Pages checked', progress.pagesChecked],
                  ['Links found', progress.linksFound],
                  ['Pages failed', progress.pagesFailed],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-label-13 text-secondary">{label}</dt>
                    <dd className="text-label-14-strong tabular-nums text-heading">{value === null ? 'Unavailable' : value.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </>
      )
      action = canWrite && track.runId ? <CancelRunAction key={track.runId} runId={track.runId} noun="scan" onCancelled={onCancelled} /> : null
      break
    }
    case SetupTrackStates.completed:
    case SetupTrackStates.partial: {
      const result = track.result
      summary = state === SetupTrackStates.partial ? 'The scan stopped before it reached every page.' : null
      // The score carries the same weight as the AI Visibility figures beside it.
      body = result ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-heading-20 tabular-nums text-heading">{result.score === null ? '–' : Math.round(result.score)}</span>
          <span className="text-label-14 text-secondary">
            {result.score === null ? 'Score unavailable' : state === SetupTrackStates.partial ? 'of 100 so far' : 'of 100'}
            {' · '}{plural(result.pagesScored, 'page scored', 'pages scored')}
          </span>
        </p>
      ) : <p className="text-copy-14 text-secondary">The scan finished.</p>
      action = (
        <Button asChild variant="ghost">
          <Link to="/projects/$projectName/agent-readiness" params={{ projectName }}>
            Open Agent Readiness
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      )
      break
    }
    case SetupTrackStates.failed:
      summary = `The scan did not finish.${track.error ? ` ${track.error}` : ''}`
      action = startButton('Run audit scan again')
      break
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }

  return (
    <SetupTrackerRow
      id="setup-agent-readiness"
      title="Agent Readiness"
      mark={setupRowMark(state)}
      summary={summary}
      trailing={<SetupTrackBadge state={state} />}
      action={action}
    >
      {body}
      {startError ? <p role="alert" className={`${body ? 'mt-3 ' : ''}text-copy-14 text-negative`}>{startError}</p> : null}
    </SetupTrackerRow>
  )
}

/** The AI Visibility panel step that clears the server's blocker; an unpublished plan is published elsewhere. */
function panelStepFor(blockedBy: AiVisibilitySetupBlocker | null): SetupPanelStep | null {
  switch (blockedBy) {
    case null:
      return 'first-check'
    case AiVisibilitySetupBlockers.no_engine:
    case AiVisibilitySetupBlockers.engines_failing:
      return 'engine'
    case AiVisibilitySetupBlockers.no_queries:
      return 'queries'
    case AiVisibilitySetupBlockers.plan_unpublished:
      return null
    default: {
      const exhaustive: never = blockedBy
      return exhaustive
    }
  }
}

/** The AI Visibility row's line and action when no check is running. */
function aiVisibilityNextStep(track: AiVisibilitySetupTrack, brand: string, domain: string): { line: string; action: string; step: SetupPanelStep | 'plan' } {
  const purpose = `Whether AI answers mention ${brand} and cite ${domain}.`
  switch (track.blockedBy) {
    case AiVisibilitySetupBlockers.no_engine:
      return { line: `${purpose} Needs an AI engine.`, action: 'Connect an AI engine', step: 'engine' }
    case AiVisibilitySetupBlockers.no_queries:
      return { line: `${purpose} Add queries to check.`, action: 'Add queries', step: 'queries' }
    case AiVisibilitySetupBlockers.plan_unpublished:
      return { line: 'Publish the measurement plan before the first check.', action: 'Open measurement plan', step: 'plan' }
    case AiVisibilitySetupBlockers.engines_failing:
      return { line: `${purpose} The AI engine connection needs attention.`, action: 'Repair connection', step: 'engine' }
    case null: {
      const engines = track.engines.length
      return {
        line: `Asks ${plural(engines, 'engine', 'engines')} your ${plural(track.queries.total, 'query', 'queries')}.`,
        action: 'Review first check',
        step: 'first-check',
      }
    }
    default: {
      const exhaustive: never = track.blockedBy
      return exhaustive
    }
  }
}

function AiVisibilityRow({
  projectName,
  brand,
  domain,
  track,
  panelStep,
  onOpenPanel,
  onClosePanel,
  onLaunched,
  onCancelled,
  starting,
  primary,
  canWrite,
  isAdmin,
}: {
  projectName: string
  brand: string
  domain: string
  track: AiVisibilitySetupTrack
  panelStep: SetupPanelStep | null
  onOpenPanel: (step: SetupPanelStep) => void
  onClosePanel: () => void
  onLaunched: (runId: string) => void
  onCancelled: () => Promise<unknown>
  /** A check queued here that the setup read does not list yet. */
  starting: boolean
  primary: boolean
  canWrite: boolean
  isAdmin: boolean
}) {
  const state = starting ? SetupTrackStates.queued : track.state
  const variant = primary ? 'default' : 'secondary'
  if (panelStep !== null) {
    return (
      <SetupTrackerRow id="setup-ai-visibility" title="AI Visibility" mark={setupRowMark(state)} trailing={<SetupTrackBadge state={state} />} childrenManageFocus>
        <AiVisibilitySetupPanel
          projectName={projectName}
          initialStep={panelStep}
          onClose={onClosePanel}
          onLaunched={onLaunched}
        />
      </SetupTrackerRow>
    )
  }

  let summary: ReactNode = null
  let body: ReactNode = null
  let action: ReactNode = null
  switch (state) {
    case SetupTrackStates.not_started:
    case SetupTrackStates.cancelled: {
      const next = aiVisibilityNextStep(track, brand, domain)
      summary = state === SetupTrackStates.cancelled ? `The last check was cancelled. ${next.line}` : next.line
      if (canWrite) {
        const step = next.step
        action = step === 'plan'
          ? <Button asChild variant={variant}><Link to="/projects/$projectName/portfolio" params={{ projectName }}>{next.action}</Link></Button>
          : <Button type="button" variant={variant} onClick={() => onOpenPanel(step)}>{next.action}</Button>
      }
      break
    }
    case SetupTrackStates.queued:
    case SetupTrackStates.running: {
      const progress = track.progress
      const count = progress
        ? progress.answersPlanned !== null && progress.answersSaved <= progress.answersPlanned
          ? `${progress.answersSaved} of ${plural(progress.answersPlanned, 'answer', 'answers')} saved`
          : `${plural(progress.answersSaved, 'answer', 'answers')} saved`
        : null
      body = (
        <>
          <JobProgress
            label="AI Visibility check progress"
            noun="check"
            phase={state === SetupTrackStates.queued ? 'Waiting to start' : 'Asking engines'}
            count={count}
            done={progress?.answersSaved ?? null}
            total={progress?.answersPlanned ?? null}
            startedAt={track.startedAt}
          />
          {/* An engine failing now, said before the check ends rather than after minutes of waiting. */}
          {Object.entries(track.providerFailures ?? {}).map(([provider, failure]) => (
            <div key={provider} role="status" className="mt-3 rounded-md border border-caution px-3 py-2">
              <p className="text-copy-14 text-primary">
                {providerDisplayName(provider)}: {plural(failure.failedQueries, 'query', 'queries')} failed{failure.stopped ? ', so this check stopped asking it' : ''}.
              </p>
              <details className="mt-1">
                <summary className="cursor-pointer text-label-13 text-secondary">Engine message</summary>
                <p className="mt-1 break-words text-copy-13 text-secondary">{failure.message}</p>
              </details>
            </div>
          ))}
          <details className="mt-2">
            <summary className="cursor-pointer py-1 text-label-14 text-secondary">Check details</summary>
            <dl className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-label-13 text-secondary">Engines</dt>
                <dd className="text-label-14 text-heading">{track.engines.length > 0 ? track.engines.map(name => providerDisplayName(name)).join(', ') : 'Unavailable'}</dd>
              </div>
              <div>
                <dt className="text-label-13 text-secondary">Queries</dt>
                <dd className="text-label-14 tabular-nums text-heading">
                  {plural(track.queries.nonBrand, 'non-brand', 'non-brand')} · {plural(track.queries.branded, 'branded', 'branded')}
                </dd>
              </div>
            </dl>
          </details>
        </>
      )
      // A check queued here and not listed yet has no run of its own to stop.
      action = canWrite && !starting && track.runId ? <CancelRunAction key={track.runId} runId={track.runId} noun="check" onCancelled={onCancelled} /> : null
      break
    }
    case SetupTrackStates.completed:
    case SetupTrackStates.partial: {
      const result = track.result
      // The row shows the latest check: the baseline only when the server says it is the project's first.
      summary = result
        ? `${state === SetupTrackStates.partial ? 'Partial results' : result.first ? 'Baseline' : 'Latest check'} · ${plural(result.answers, 'answer', 'answers')} from ${plural(result.engines, 'engine', 'engines')}${track.finishedAt ? ` · ${formatSweepInstant(track.finishedAt)}` : ''}`
        : 'The check finished.'
      body = result ? (
        <>
          <FirstResultTable
            byClass={result.queryCountsByClass}
            pooled={result.queryCounts}
            caption={result.first ? undefined : 'Latest AI Visibility check by query class'}
          />
          {result.first ? <p className="mt-3 text-copy-13 text-secondary">Later checks are compared with this baseline.</p> : null}
          {track.runId ? <ExampleAnswer runId={track.runId} projectName={projectName} /> : null}
        </>
      ) : null
      action = (
        <Button asChild variant="ghost">
          <Link to="/projects/$projectName" params={{ projectName }}>
            Open AI Visibility
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Button>
      )
      break
    }
    case SetupTrackStates.failed: {
      summary = 'The check did not finish. No baseline was saved.'
      const adminNote = isAdmin ? null : <p className="text-copy-14 text-secondary">Ask an administrator to check the AI engine connection.</p>
      const failedEngines = track.failedEngines ?? []
      // Engine by engine: what to do first, the engine's own words one step away.
      body = failedEngines.length > 0 ? (
        <div className="space-y-2">
          {failedEngines.map((engine) => {
            const name = providerDisplayName(engine.provider)
            // The account belongs to the connection: a routed model's credit is OpenRouter's.
            const remedy = providerFailureRemedy(engine.code, providerDisplayName(providerConnectionName(engine.provider)))
            return (
              <div key={engine.provider} className="rounded-md border border-caution px-3 py-2">
                {remedy ? (
                  <>
                    <p className="text-copy-14 text-primary">{remedy}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-label-13 text-secondary">Engine message</summary>
                      <p className="mt-1 break-words text-copy-13 text-secondary">{name}: {engine.message}</p>
                    </details>
                  </>
                ) : <p className="break-words text-copy-14 text-primary">{name}: {engine.message}</p>}
              </div>
            )
          })}
          {adminNote}
        </div>
      ) : track.error ? (
        <div className="rounded-md border border-caution px-3 py-2">
          <p className="break-words text-copy-14 text-primary">{track.error}</p>
          {adminNote ? <div className="mt-1">{adminNote}</div> : null}
        </div>
      ) : null
      if (canWrite) {
        action = (
          <>
            {isAdmin ? <Button type="button" variant="ghost" onClick={() => onOpenPanel('engine')}>Change AI engines</Button> : null}
            <Button type="button" variant={variant} onClick={() => onOpenPanel('first-check')}>Run check again</Button>
          </>
        )
      }
      break
    }
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }

  return (
    <SetupTrackerRow
      id="setup-ai-visibility"
      title="AI Visibility"
      mark={setupRowMark(state)}
      summary={summary}
      trailing={<SetupTrackBadge state={state} />}
      action={action}
    >
      {body}
    </SetupTrackerRow>
  )
}

/** One saved answer from the check the row shows, read only when the operator opens it. */
function ExampleAnswer({ runId, projectName }: { runId: string; projectName: string }) {
  const [open, setOpen] = useState(false)
  const run = useQuery({
    ...getApiV1RunsByIdOptions({ client: heyClient, path: { id: runId } }),
    enabled: open,
  })
  const queries = useQuery({
    ...getApiV1ProjectsByNameQueriesOptions({ client: heyClient, path: { name: projectName } }),
    enabled: open,
  })
  const featured = run.data
    ? featuredSetupAnswer(run.data.snapshots ?? [], queryId => queries.data?.find(query => query.id === queryId)?.queryClass)
    : undefined
  return (
    <details className="mt-3" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer py-1 text-label-14 text-link">Example answer</summary>
      <div className="mt-3 border-t border-default pt-4">
        {run.isPending
          ? <p role="status" className="text-copy-14 text-secondary">Loading the answer…</p>
          : run.isError
            ? <p role="alert" className="text-copy-14 text-negative">The answer could not be loaded.</p>
            : featured
              ? <FeaturedAnswer answer={featured} />
              : <p className="text-copy-14 text-secondary">This check saved no answer text.</p>}
      </div>
    </details>
  )
}

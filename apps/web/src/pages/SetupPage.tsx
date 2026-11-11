import { RunPreviewSummary, useRunPreview } from '../components/project/RunAdmissionNotice.js'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { isDashboardManagedSweeps } from '../api.js'
import { MANAGED_SWEEPS_COPY } from '../components/project/ManagedSweepStatus.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ONBOARDING_FLOW_VERSION,
  RunKinds,
  RunStatuses,
  bucketOnboardingCount,
  formatLocaleLabel,
  type OnboardingTelemetryEvent,
} from '@canonry/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { NextSteps } from '../components/shared/NextSteps.js'
import { JobProgress } from '../components/shared/JobProgress.js'
import { FeaturedAnswer, FirstResultTable, featuredSetupAnswer } from '../components/setup/FirstResult.js'
import { AiEnginesSection, ChangeEngines } from '../components/setup/AiEnginesSection.js'
import { FirstCheckReview, ManagedFirstCheck, firstCheckHelp, previewUsesProviderAccount } from '../components/setup/FirstCheckReview.js'
import { SetupQueriesForm } from '../components/setup/SetupQueriesForm.js'
import { firstCheckReadiness, useAiEngineSetup } from '../components/setup/use-ai-engine-setup.js'
import { refreshSavedQueries, setupSavedQueriesKey, useSetupQueries } from '../components/setup/use-setup-queries.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ProviderConfigForm } from '../components/settings/ProviderConfigForm.js'
import { providerDisplayName } from '../lib/visibility-trend-helpers.js'
import { addToast } from '../lib/toast-store.js'
import {
  createProject,
  setCompetitors,
  updateProviderConfig,
  fetchQueries,
  heyClient,
  recordOnboardingEvent,
} from '../api.js'
import { getApiV1RunsByIdOptions } from '@canonry/canonry-api-client/react-query'
import { useTriggerRun } from '../queries/mutations.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useAccount } from '../contexts/account-context.js'
import type { PendingOnboardingTelemetryEvent } from '../hooks/use-onboarding-telemetry.js'
import { CHECKING_HEALTH_SNAPSHOT, buildSetupModel, serviceStatusTooltip } from '../lib/health-helpers.js'
import { clearOnboardingDraft, readOnboardingDraft, writeOnboardingDraft } from '../lib/onboarding-draft.js'
import { asyncHandler } from '../lib/async-handler.js'
import { summarizeRunError } from '../lib/format-helpers.js'
import {
  createOnboardingEventId,
  getOrCreateOnboardingSessionId,
  isAiVisibilityLaunchedRun,
  isOnboardingHealthSettled,
  markOnboardingRunHandled,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  onboardingStepFromIndex,
  readOnboardingLaunchedRun,
} from '../lib/onboarding-telemetry.js'
import type { DashboardVm, HealthSnapshot, ProjectCommandCenterVm, RunListItemVm } from '../view-models.js'

const SETUP_STEPS = [
  { label: 'System check', description: 'Verify your instance is ready' },
  { label: 'Create project', description: 'Name, domain, and locale' },
  { label: 'Queries', description: 'Add queries to track' },
  { label: 'Competitors', description: 'Add competitor domains' },
  { label: 'Launch', description: 'Start your first AI Visibility check' },
] as const

const PROJECT_VISIBILITY_STEPS = [
  // The step opens on connecting an engine when none is ready.
  { label: 'Engines and queries' },
  { label: 'First check' },
] as const

type SetupStep = 0 | 1 | 2 | 3 | 4

export function isSuccessfulSetupRun(
  status: RunListItemVm['status'],
  snapshotCount: number,
): boolean {
  return (status === 'completed' || status === 'partial') && snapshotCount > 0
}

export function deriveSetupStep(input: {
  launchReady: boolean
  hasProject: boolean
  queryCount: number
  competitorCount: number
  hasRunAttempt: boolean
}): SetupStep {
  if (!input.launchReady) return 0
  if (!input.hasProject) return 1
  // Where an operator RESUMES. Skipping is a session choice handled by the step
  // control itself; this only decides where a reload drops you.
  if (input.queryCount === 0) return 2
  if (input.competitorCount === 0 && !input.hasRunAttempt) return 3
  return 4
}

function projectHasSuccessfulBaseline(
  project: ProjectCommandCenterVm,
): boolean {
  // The project overview derives this count from the latest successful
  // non-probe answer-visibility snapshots. Unlike the global run list, it is
  // not capped to a recent window, so an older activation remains complete.
  return project.queryCounts.total > 0
}

export function selectSetupProject(
  projects: ProjectCommandCenterVm[],
  preferredProjectName?: string,
): ProjectCommandCenterVm | null {
  if (preferredProjectName) {
    return projects.find(project => project.project.name === preferredProjectName) ?? null
  }
  return projects.find(project => !projectHasSuccessfulBaseline(project))
    ?? projects.at(0)
    ?? null
}

function SetupStepIndicator({ current, labels }: { current: number; labels: readonly { label: string }[] }) {
  return (
    <div className="setup-steps" role="list" aria-label="Setup progress">
      {labels.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={s.label} className={`setup-step ${done ? 'setup-step-done' : ''} ${active ? 'setup-step-active' : ''}`} role="listitem" aria-current={active ? 'step' : undefined}>
            <span className="setup-step-number" aria-hidden="true">{done ? '\u2713' : i + 1}</span>
            <span>{s.label}</span>
            {done ? <span className="sr-only">Complete</span> : null}
          </div>
        )
      })}
    </div>
  )
}

interface SetupPageProps {
  /** The project-scoped Set up AI Visibility page; without one, the whole setup wizard. */
  visibilityProjectName?: string
}

/**
 * The established setup wizard (`/setup?experience=legacy`), or one project's
 * Set up AI Visibility page. The wizard exists to CREATE things — a project,
 * its queries, its first sweep. There is nothing in it for a view-only account.
 */
export function SetupPage({ visibilityProjectName }: SetupPageProps = {}) {
  const { canWrite } = useAccount()
  if (visibilityProjectName && canWrite) {
    return <SetupPageBody visibilityProjectName={visibilityProjectName} />
  }
  return (
    <AdminOnly title={visibilityProjectName ? 'Set up AI Visibility' : 'Setup'}>
      <SetupPageBody visibilityProjectName={visibilityProjectName} />
    </AdminOnly>
  )
}

function SetupPageBody({ visibilityProjectName }: SetupPageProps) {
  const contextDashboard = useInitialDashboard()
  const { isAdmin } = useAccount()
  // RootLayout and this page are separate observers of the same project query.
  // Both must pause the zero-project interval while setup owns project creation.
  const { dashboard, refetch } = useDashboard(undefined, {
    pauseProjectPolling: true,
    includeSettings: isAdmin,
  })
  const lastDashboard = useRef<DashboardVm | null>(null)
  useEffect(() => {
    if (dashboard) lastDashboard.current = dashboard
  }, [dashboard])
  // A completed run changes the overview cache key. Keep the wizard mounted
  // while that background summary loads so its exact launched run survives.
  const safeDashboard = dashboard ?? contextDashboard?.dashboard ?? lastDashboard.current
  const visibilityHeadingRef = useCallback<RefCallback<HTMLHeadingElement>>((node) => {
    if (node && visibilityProjectName) node.focus()
  }, [visibilityProjectName])

  if (!safeDashboard) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-24" />
          <div className="skeleton-text-sm w-80" />
        </div>
        <div className="page-skeleton-card">
          <div className="skeleton-text w-32" />
          <div className="space-y-3 mt-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="space-y-1 flex-1">
                  <div className="skeleton-text w-24" />
                  <div className="skeleton-text-sm w-48" />
                </div>
                <div className="skeleton h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (visibilityProjectName && !safeDashboard.projects.some(project => project.project.name === visibilityProjectName)) {
    return (
      <div className="page-container">
        <div className="page-header">
          <div className="page-header-left">
            <h1 ref={visibilityHeadingRef} tabIndex={-1} className="page-title outline-none">Set up AI Visibility</h1>
            <p className="page-subtitle">Choose what to track, then run your first AI Visibility check.</p>
          </div>
        </div>
        <Card role="alert" className="compact-stack">
          <h2>Project not found</h2>
          <p className="text-secondary">
            Canonry could not find {visibilityProjectName}. Refresh the project list or choose a project to continue.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => { void refetch() }}>Retry</Button>
            <Button type="button" asChild><Link to="/projects">View projects</Link></Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <ReadySetupPage
      key={visibilityProjectName ?? 'global'}
      dashboard={safeDashboard}
      initialHealth={contextDashboard?.health}
      enableLiveStatus={!contextDashboard}
      refetch={refetch}
      visibilityProjectName={visibilityProjectName}
      visibilityHeadingRef={visibilityHeadingRef}
    />
  )
}

function ReadySetupPage({
  dashboard: safeDashboard,
  initialHealth,
  enableLiveStatus,
  refetch,
  visibilityProjectName,
  visibilityHeadingRef,
}: {
  dashboard: DashboardVm
  initialHealth?: HealthSnapshot
  enableLiveStatus: boolean
  refetch: () => Promise<void>
  visibilityProjectName?: string
  visibilityHeadingRef: RefCallback<HTMLHeadingElement>
}) {
  const settings = safeDashboard.settings
  const { isAdmin } = useAccount()

  const healthQuery = useHealth(enableLiveStatus, initialHealth)
  const healthSnapshot = healthQuery.data ?? initialHealth ?? CHECKING_HEALTH_SNAPSHOT
  const model = buildSetupModel(safeDashboard.setup, healthSnapshot, settings)
  const isProjectScoped = Boolean(visibilityProjectName)

  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const onboardingSessionId = useRef(getOrCreateOnboardingSessionId()).current
  const recordedOnboardingEvents = useRef(new Set<string>())
  const emitOnboardingEvent = useCallback((
    event: PendingOnboardingTelemetryEvent<OnboardingTelemetryEvent>,
    dedupeKey?: string,
  ) => {
    if (dedupeKey) {
      if (recordedOnboardingEvents.current.has(dedupeKey)) return
      recordedOnboardingEvents.current.add(dedupeKey)
    }
    void recordOnboardingEvent({
      // Stamped centrally so no call site can forget it. Without a surface the
      // wizard's funnel and the first-run launchpad's funnel pool into one
      // number that describes neither.
      surface: 'wizard',
      ...event,
      eventId: createOnboardingEventId(),
    } as OnboardingTelemetryEvent)
  }, [])

  const resumeProject = selectSetupProject(safeDashboard.projects, visibilityProjectName)
  const resumeProjectRuns = resumeProject
    ? safeDashboard.runs
      .filter(run => run.projectId === resumeProject.project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : []
  // Overview queryCounts is snapshot-derived, so it is only a fast fallback
  // while the canonical tracked-query list loads. Always fetch that list:
  // partial runs may contain fewer snapshots than the project's actual basket.
  const snapshotQueryCount = resumeProject?.queryCounts.total ?? 0
  const resumeProjectName = resumeProject?.project.name
  const resumeQueriesQuery = useQuery({
    queryKey: setupSavedQueriesKey(resumeProjectName),
    queryFn: () => resumeProjectName ? fetchQueries(resumeProjectName) : Promise.resolve([]),
    enabled: !!resumeProjectName,
  })
  const durableQueries = resumeQueriesQuery.data ?? []
  const durableQueryCount = resumeQueriesQuery.data?.length ?? snapshotQueryCount
  const durableCompetitors = resumeProject?.competitors.map(competitor => competitor.domain) ?? []
  const latestPersistedRun = resumeProjectRuns.at(0) ?? null
  const hasExistingSuccessfulBaseline = !!resumeProject
    && projectHasSuccessfulBaseline(resumeProject)
  const resumeLoading = !!resumeProject && resumeQueriesQuery.isPending
  const answerVisibilityRunIds = new Set(resumeProjectRuns
    .filter(run => run.kind === RunKinds['answer-visibility'])
    .map(run => run.id))
  const sessionLaunchedRun = useRef(readOnboardingLaunchedRun(resumeProjectName, true)).current
  // The Agent Readiness audit scan shares the launched-run marker, so only an AI
  // Visibility check resumes here. Handled means the outcome was reported, not
  // that its result was dismissed, so a handled check resumes while it is listed.
  const resumableLaunchedRunId = sessionLaunchedRun
    && isAiVisibilityLaunchedRun(sessionLaunchedRun, answerVisibilityRunIds)
    && (!sessionLaunchedRun.handled || answerVisibilityRunIds.has(sessionLaunchedRun.runId))
    ? sessionLaunchedRun.runId
    : null
  const engines = useAiEngineSetup({
    settings,
    project: resumeProject?.project ?? null,
    projectScoped: isProjectScoped,
    refresh: refetch,
  })
  const connectionSetupReady = model.launchState.enabled || (engines.openRouterConnected && model.healthChecks.every(check => check.state === 'ready' || check.id === 'provider'))
  // Project-scoped AI Visibility setup starts with the measurement input, not
  // instance or project ceremony. Provider readiness gates only the paid run.
  const initialResumeStep: SetupStep = isProjectScoped
    ? (resumableLaunchedRunId || (resumeProjectRuns.length > 0 && !hasExistingSuccessfulBaseline) ? 4 : 2)
    : deriveSetupStep({
        launchReady: connectionSetupReady,
        hasProject: !!resumeProject,
        queryCount: durableQueryCount,
        competitorCount: durableCompetitors.length,
        hasRunAttempt: resumeProjectRuns.length > 0 || hasExistingSuccessfulBaseline,
      })
  const nextStepAfterSystemCheck = deriveSetupStep({
    launchReady: true,
    hasProject: !!resumeProject,
    queryCount: durableQueryCount,
    competitorCount: durableCompetitors.length,
    hasRunAttempt: resumeProjectRuns.length > 0 || hasExistingSuccessfulBaseline,
  })

  const [draftScope] = useState(() => `wizard:${resumeProjectName ?? 'new'}`)
  const [draft] = useState(() => readOnboardingDraft(draftScope))
  const [step, setStep] = useState<SetupStep>(initialResumeStep)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const previousStep = useRef(step)
  useEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step
    const heading = stepContentRef.current?.querySelector<HTMLElement>('h2, h3')
    if (heading) {
      heading.tabIndex = -1
      heading.focus()
    }
  }, [step])
  const [resumeApplied, setResumeApplied] = useState(!resumeLoading)
  const queriesHydrating = isProjectScoped && (resumeLoading || !resumeApplied)

  const [projectName, setProjectName] = useState(resumeProject?.project.name ?? draft.projectName ?? '')
  const [displayName, setDisplayName] = useState(resumeProject?.project.displayName ?? draft.displayName ?? '')
  const [domain, setDomain] = useState(resumeProject?.project.canonicalDomain ?? draft.domain ?? '')
  const [country, setCountry] = useState(resumeProject?.project.country ?? draft.country ?? 'US')
  const [language, setLanguage] = useState(resumeProject?.project.language ?? draft.language ?? 'en')
  const [autoExtractBacklinks, setAutoExtractBacklinks] = useState(resumeProject?.project.autoExtractBacklinks ?? false)
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(resumeProject?.project.name ?? null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)

  const openProjectDashboard = () => {
    if (!createdProjectName) {
      void navigate({ to: '/', replace: Boolean(visibilityProjectName) })
      return
    }
    void navigate({
      to: '/projects/$projectName',
      params: { projectName: createdProjectName },
      // Project-scoped setup replaces the project route on entry. Replace it
      // again on exit so Back cannot reopen a wizard the operator just finished.
      replace: Boolean(visibilityProjectName),
    })
  }
  const finishSetup = () => openProjectDashboard()

  const queries = useSetupQueries({
    projectName: createdProjectName,
    initialText: draft.queriesText ?? durableQueries.map(query => query.query).join('\n'),
    initialSaved: draft.queriesText === undefined && durableQueryCount > 0,
    generateProviders: engines.runnableApiProviders,
    research: { projectName: createdProjectName ?? projectName, domain },
    telemetry: { emit: emitOnboardingEvent, onboardingSessionId },
    refreshAfterSave: name => isProjectScoped ? refreshSavedQueries(queryClient, name) : refetch(),
    onContinue: () => setStep(isProjectScoped ? 4 : 3),
  })

  const [competitorsText, setCompetitorsText] = useState(draft.competitorsText ?? durableCompetitors.join('\n'))
  const [competitorsSaved, setCompetitorsSaved] = useState(draft.competitorsText === undefined && durableCompetitors.length > 0)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  useEffect(() => {
    if (!resumeApplied) return
    const activeScope = createdProjectName ? `wizard:${createdProjectName}` : draftScope
    writeOnboardingDraft(activeScope, {
      ...(!createdProjectName ? { projectName, displayName, domain, country, language } : {}),
      ...(!queries.saved && queries.text !== durableQueries.map(query => query.query).join('\n') ? { queriesText: queries.text } : {}),
      ...(!competitorsSaved && competitorsText !== durableCompetitors.join('\n') ? { competitorsText } : {}),
    })
    if (activeScope !== draftScope) clearOnboardingDraft(draftScope)
  }, [competitorsSaved, competitorsText, country, createdProjectName, displayName, domain, draftScope, durableCompetitors, durableQueries, language, projectName, queries.saved, queries.text, resumeApplied])

  const resetDraft = () => {
    clearOnboardingDraft(draftScope)
    if (createdProjectName) clearOnboardingDraft(`wizard:${createdProjectName}`)
    if (!createdProjectName) {
      setProjectName('')
      setDisplayName('')
      setDomain('')
      setCountry('US')
      setLanguage('en')
    }
    queries.setText(durableQueries.map(query => query.query).join('\n'))
    queries.setSaved(durableQueryCount > 0)
    setCompetitorsText(durableCompetitors.join('\n'))
    setCompetitorsSaved(durableCompetitors.length > 0)
    queries.setError(null)
    setCompetitorsError(null)
  }

  // A run THIS onboarding session launched for THIS project and never saw
  // finish. The wizard otherwise treats an already-successful project as
  // settled history and stops polling, so a reload during a multi-minute sweep
  // permanently loses the run-step completion. Failures land in under a second
  // and always emitted; the funnel could record a failure but not a success.
  const pendingLaunchedRun = useRef(readOnboardingLaunchedRun(resumeProjectName)).current
  // A pending Agent Readiness audit scan's outcome belongs to the Agent Readiness surface.
  const pendingLaunchedRunId = pendingLaunchedRun && isAiVisibilityLaunchedRun(pendingLaunchedRun, answerVisibilityRunIds)
    ? pendingLaunchedRun.runId
    : null
  // The run whose outcome this onboarding session is entitled to report: one it
  // launched, in this mount or an earlier one. `latestPersistedRun` also drives
  // the poll so the UI can show an in-flight sweep, but a run the user never
  // launched here is somebody else's history, and emitting for it re-reported
  // the same failure on every single remount.
  const launchedThisSessionRunId = useRef<string | null>(pendingLaunchedRunId)
  const [runTriggered, setRunTriggered] = useState(
    !!resumableLaunchedRunId || (!!latestPersistedRun && !hasExistingSuccessfulBaseline),
  )
  const [runSaving, setRunSaving] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(
    resumableLaunchedRunId
      ?? (hasExistingSuccessfulBaseline ? null : latestPersistedRun?.id ?? null),
  )
  const triggerRunMutation = useTriggerRun()
  const runPreview = useRunPreview(createdProjectName, step === 4 && !isDashboardManagedSweeps())
  const firstCheckUsesAccount = previewUsesProviderAccount(runPreview.data)
  // The provider requests the server previewed for the check launched here:
  // one engine result each. A check resumed from an earlier visit has none.
  const [launchedRunPlan, setLaunchedRunPlan] = useState<{ runId: string; requestCount: number } | null>(null)

  // Poll the newly-triggered run so Step 5 can show results inline instead
  // of the previous "queued — open project page" handoff. Refetches every
  // 2s while the run is in flight, then stops once a terminal status
  // (`completed`/`partial`/`failed`/`cancelled`) lands.
  //
  // `refetchIntervalInBackground: true` is load-bearing: without it,
  // react-query v5 silently suppresses interval refetches whenever the
  // tab loses focus (real user alt-tabbing during the 30-60s sweep, or
  // any headless test environment). Symptom was: server completes the
  // run, dashboard surfaces the result toast, but the wizard's Step 5
  // card stays "Running" forever. Diagnosed via a remote PR walkthrough
  // where the failure toast fired on the dashboard while the wizard
  // card remained amber.
  const launchedRun = useQuery({
    ...getApiV1RunsByIdOptions({ client: heyClient, path: { id: launchedRunId ?? '' } }),
    enabled: !!launchedRunId,
    refetchInterval: ({ state }) => {
      const status = state.data?.status
      const terminal = status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled'
      return terminal ? false : 2000
    },
    refetchIntervalInBackground: true,
  })

  // Inline provider key entry for Step 1. Replaces the prior "go to /settings"
  // link that caused the wizard's biggest drop-off: users left the wizard,
  // entered the key, and often forgot to navigate back. Keeping the form
  // here lets first-time users stay in flow through the whole 5-step setup.
  const [geminiKey, setGeminiKey] = useState('')
  const [geminiSaving, setGeminiSaving] = useState(false)
  const [geminiError, setGeminiError] = useState<string | null>(null)

  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const parsedCompetitors = competitorsText.split('\n').map(c => c.trim()).filter(Boolean)
  const effectiveQueryCount = durableQueryCount
  const { systemBlockReason, blockedReason: readinessBlockedReason } = firstCheckReadiness(healthSnapshot, settings, engines)
  const launchBlockedReason = readinessBlockedReason
    ?? (!createdProjectName
      ? 'Create a project before launching the first check.'
      : effectiveQueryCount === 0
        ? 'Add at least one query before launching the first check.'
        : undefined)

  const { setText: setQueriesText, setSaved: setQueriesSaved } = queries
  useEffect(() => {
    if (resumeApplied || resumeLoading) return
    // Query hydration must not reset a user who has already advanced or resumed a run.
    if (!isProjectScoped) setStep(initialResumeStep)
    if (durableQueries.length > 0 && draft.queriesText === undefined) {
      setQueriesText(durableQueries.map(query => query.query).join('\n'))
      setQueriesSaved(true)
    }
    setResumeApplied(true)
  }, [draft.queriesText, durableQueries, initialResumeStep, isProjectScoped, resumeApplied, resumeLoading, setQueriesSaved, setQueriesText])

  useEffect(() => {
    if (!resumeApplied) return
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.started',
      step: onboardingStepFromIndex(initialResumeStep),
      resumed: !!resumeProject,
    }, 'onboarding.started')

    if (!resumeProject && initialResumeStep > 0) {
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'system',
        method: 'automatic',
      }, 'onboarding.step_completed:system')
    }
  }, [
    emitOnboardingEvent,
    initialResumeStep,
    onboardingSessionId,
    resumeApplied,
    resumeProject,
  ])

  useEffect(() => {
    if (isProjectScoped) return
    if (!isOnboardingHealthSettled(healthSnapshot) || !systemBlockReason) return
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.blocked',
      step: 'system',
      action: systemBlockReason === 'no_provider' ? 'configure_provider' : 'continue',
      reasonCode: systemBlockReason,
    }, `onboarding.blocked:system:${systemBlockReason}`)
  }, [emitOnboardingEvent, healthSnapshot, isProjectScoped, onboardingSessionId, systemBlockReason])

  const polledRunStatus = launchedRun.data?.status
  const polledSnapshotCount = launchedRun.data?.snapshots?.length ?? 0
  const showingSuccessfulRun = step === 4 && runTriggered && Boolean(polledRunStatus && isSuccessfulSetupRun(polledRunStatus, polledSnapshotCount))
  // A baseline saved before this visit, which launched no check of its own.
  const persistedSetupComplete = hasExistingSuccessfulBaseline && !runTriggered
  useEffect(() => {
    if (!runTriggered || !polledRunStatus) return
    // Only a run this onboarding session actually launched.
    const reportableRunId = launchedThisSessionRunId.current
    if (!reportableRunId || reportableRunId !== launchedRunId) return
    if (isSuccessfulSetupRun(polledRunStatus, polledSnapshotCount)) {
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'run',
        method: 'automatic',
        countBucket: bucketOnboardingCount(polledSnapshotCount),
      }, `onboarding.step_completed:run:${reportableRunId}`)
      markOnboardingRunHandled(reportableRunId)
      return
    }

    const reasonCode = polledRunStatus === 'cancelled'
      ? 'run_cancelled'
      : polledRunStatus === 'failed'
        || ((polledRunStatus === 'completed' || polledRunStatus === 'partial') && polledSnapshotCount === 0)
        ? 'run_failed'
        : undefined
    if (!reasonCode) return
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.blocked',
      step: 'run',
      action: 'retry_run',
      reasonCode,
    }, `onboarding.blocked:run:${reportableRunId}:${reasonCode}`)
    // Terminal either way: the run has been accounted for, so a later mount
    // must not re-open the poll and emit the same outcome twice.
    markOnboardingRunHandled(reportableRunId)
  }, [
    emitOnboardingEvent,
    launchedRunId,
    onboardingSessionId,
    polledRunStatus,
    polledSnapshotCount,
    runTriggered,
  ])

  const handleCreateProject = async () => {
    if (!slug || !domain) return
    setProjectSaving(true)
    setProjectError(null)
    try {
      const project = await createProject(slug, {
        displayName: displayName || projectName,
        canonicalDomain: domain,
        country,
        language,
        autoExtractBacklinks,
      })
      setCreatedProjectName(slug)
      engines.setEngineProject(project)
      addToast({
        title: 'Project created',
        detail: `${project.displayName || project.name} is ready for setup.`,
        tone: 'positive',
        dedupeKey: `project:create:${project.name}`,
        dedupeMode: 'drop',
      })
      // Await the dashboard refetch before advancing the step so the new
      // project's row is in cache by the time Step 2's "Created" badge
      // and Step 3's createdProjectName-dependent render run. Prior
      // `void refetch()` raced with `setStep`, occasionally leaving the
      // step indicator at 2 while the card content reverted to step 1.
      await refetch()
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'project',
        method: 'manual',
      }, 'onboarding.step_completed:project')
      setStep(2)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Failed to create project')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'project',
        action: 'save',
        reasonCode: 'project_create_failed',
      }, 'onboarding.blocked:project:project_create_failed')
    } finally {
      setProjectSaving(false)
    }
  }

  const handleSaveCompetitors = async () => {
    if (!createdProjectName) return
    const competitors = parsedCompetitors
    if (competitors.length === 0) return
    setCompetitorsSaving(true)
    setCompetitorsError(null)
    try {
      await setCompetitors(createdProjectName, competitors)
      setCompetitorsSaved(true)
      await refetch()
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'competitors',
        method: 'manual',
        countBucket: bucketOnboardingCount(competitors.length),
      }, 'onboarding.step_completed:competitors')
      setStep(4)
    } catch (err) {
      setCompetitorsError(err instanceof Error ? err.message : 'Failed to save competitors')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'competitors',
        action: 'save',
        reasonCode: 'unknown',
      }, 'onboarding.blocked:competitors:save')
    } finally {
      setCompetitorsSaving(false)
    }
  }

  const handleSaveGeminiKey = async () => {
    const key = geminiKey.trim()
    if (!key) return
    setGeminiSaving(true)
    setGeminiError(null)
    try {
      await updateProviderConfig('gemini', { apiKey: key })
      addToast({
        title: 'Gemini configured',
        detail: 'Connection saved. Your first check will verify it.',
        tone: 'positive',
        dedupeKey: 'setup:gemini:configured',
        dedupeMode: 'drop',
      })
      setGeminiKey('')
      // Refetch dashboard so provider health and the launch gate both use the
      // newly-saved configuration. Select Gemini immediately so query
      // generation is ready when the operator reaches Step 3.
      await refetch()
      queries.setSelectedProvider(
        settings.providerStatuses.find(provider => provider.name.toLowerCase() === 'gemini')?.name
          ?? 'gemini',
      )
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'system',
        method: 'inline',
      }, 'onboarding.step_completed:system')
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : 'Failed to save Gemini key')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'system',
        action: 'configure_provider',
        reasonCode: 'provider_save_failed',
      }, 'onboarding.blocked:system:provider_save_failed')
    } finally {
      setGeminiSaving(false)
    }
  }

  const handleLaunchRun = async () => {
    if (isDashboardManagedSweeps()) return
    if (runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true) return
    if (!createdProjectName || launchBlockedReason) {
      setRunError(launchBlockedReason ?? 'Complete setup before launching the first check.')
      const reasonCode = systemBlockReason
        ?? (!createdProjectName ? 'unknown' : effectiveQueryCount === 0 ? 'no_queries' : 'run_rejected')
      // Project-readable readiness is a boolean, not an inventory we can count.
      if (!engines.usesProjectProviderReadiness) {
        emitOnboardingEvent({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'rejected',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
          reasonCode,
        })
      }
      return
    }
    setRunSaving(true)
    setRunError(null)
    // The preview is the server's projection of exactly this launch, read fresh.
    const plannedRequests = runPreview.data.requestCount
    try {
      const run = await triggerRunMutation.mutateAsync({
        projectName: createdProjectName,
        projectLabel: displayName || projectName || createdProjectName,
        sourceAction: 'setup-launch',
      })
      setLaunchedRunPlan({ runId: run.id, requestCount: plannedRequests })
      setLaunchedRunId(run.id)
      setRunTriggered(true)
      markOnboardingRunLaunched(createdProjectName, run.id, RunKinds['answer-visibility'])
      launchedThisSessionRunId.current = run.id
      if (!engines.usesProjectProviderReadiness) {
        emitOnboardingEvent({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'queued',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
        })
      }
      await refetch()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to queue the AI Visibility check. Retry when the instance is ready.')
      if (!engines.usesProjectProviderReadiness) {
        emitOnboardingEvent({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'rejected',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
          reasonCode: onboardingErrorReason(err, 'run_rejected'),
        })
      }
    } finally {
      setRunSaving(false)
    }
  }

  const goBack = () => setStep((s) => {
    if (isProjectScoped) return 2
    return Math.max(0, s - 1) as SetupStep
  })
  const completeExistingStep = (
    completedStep: 'project' | 'competitors',
    nextStep: SetupStep,
    count?: number,
  ) => {
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.step_completed',
      step: completedStep,
      method: 'existing',
      ...(count === undefined ? {} : { countBucket: bucketOnboardingCount(count) }),
    }, `onboarding.step_completed:${completedStep}`)
    setStep(nextStep)
  }

  const skipQueries = () => {
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.step_completed',
      step: 'queries',
      method: 'skipped',
      countBucket: '0',
    }, 'onboarding.step_completed:queries')
    if (isProjectScoped) {
      finishSetup()
      return
    }
    setStep(3)
  }

  const skipCompetitors = () => {
    emitOnboardingEvent({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.step_completed',
      step: 'competitors',
      method: 'skipped',
      countBucket: '0',
    }, 'onboarding.step_completed:competitors')
    setStep(4)
  }

  const StepSurface = isProjectScoped ? 'section' : Card
  const leaveFirstStep = isProjectScoped ? openProjectDashboard : goBack
  const providerSetup = (isProjectScoped && step === 2) || (step === 4 && (engines.showProviderConfig || engines.providerReadiness !== true))
    ? <AiEnginesSection engines={engines} headingLevel="h2" separated />
    : null

  const stepContent = (() => {
    switch (step) {
      case 0:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <h2>System check</h2>
              </div>
            </div>
            <p className="supporting-copy">Checking that your Canonry instance is configured and reachable.</p>
            <div className="compact-stack">
              {model.healthChecks.map((check) => (
                <div key={check.id} className="health-check-row">
                  <div>
                    <p className="run-row-title">{check.label}</p>
                    <p className="supporting-copy">{check.id === 'provider' && engines.openRouterConnected ? 'OpenRouter connected. Choose models before your first check.' : check.detail}</p>
                    {check.id === 'provider' && check.state !== 'ready' && (
                      <div className="mt-3 space-y-2">
                        <p className="text-copy-13 text-secondary">
                          Connect Gemini with a key from{' '}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noreferrer"
                            className="text-positive-400 hover:text-positive underline underline-offset-2"
                          >
                            aistudio.google.com
                          </a>
                          .
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            aria-label="Gemini API key"
                            autoComplete="new-password"
                            value={geminiKey}
                            onChange={(e) => setGeminiKey(e.target.value)}
                            placeholder="AI… (paste here)"
                            className="flex-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-14-mono text-heading placeholder:text-faint focus:border-mono-600 focus:outline-none"
                            disabled={geminiSaving}
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={geminiSaving || !geminiKey.trim()}
                            onClick={asyncHandler(handleSaveGeminiKey)}
                          >
                            {geminiSaving ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                        {geminiError && (
                          <div role="alert" className="space-y-1 text-label-12 text-negative">
                            <p>{geminiError}</p>
                            <p>Check that the key is complete, then retry Save.</p>
                          </div>
                        )}
                        <p className="text-copy-14 text-secondary">
                          Connect more answer engines later in{' '}
                          <Link to="/settings" className="text-link hover:underline">
                            Settings
                          </Link>
                          .
                        </p>
                        {settings.providerStatuses.some(provider => provider.name === 'openrouter') && <details><summary className="min-h-11 cursor-pointer py-3 text-label-14 text-link">Connect OpenRouter</summary><ProviderConfigForm providerName="openrouter" compact keyUrl={settings.providerStatuses.find(provider => provider.name === 'openrouter')?.keyUrl} onSaved={() => { void refetch() }} /></details>}
                      </div>
                    )}
                  </div>
                  <ToneBadge
                    tone={check.state === 'ready' ? check.id === 'provider' ? engines.connectionStatus.tone : 'positive' : 'caution'}
                    title={
                      check.id === 'api'
                        ? serviceStatusTooltip(healthSnapshot.apiStatus)
                        : check.id === 'worker'
                          ? serviceStatusTooltip(healthSnapshot.workerStatus)
                          : check.detail
                    }
                  >
                    {check.state === 'ready' ? check.id === 'provider' ? engines.connectionStatus.label : 'Ready' : 'Attention'}
                  </ToneBadge>
                </div>
              ))}
            </div>
            <div className="setup-nav">
              {model.launchState.blockedReason ? (
                <p role="status" className="supporting-copy text-negative">
                  {model.launchState.blockedReason}
                </p>
              ) : <span />}
              <Button
                type="button"
                disabled={!connectionSetupReady}
                title={model.launchState.blockedReason}
                onClick={() => {
                  emitOnboardingEvent({
                    flowVersion: ONBOARDING_FLOW_VERSION,
                    onboardingSessionId,
                    event: 'onboarding.step_completed',
                    step: 'system',
                    method: 'automatic',
                  }, 'onboarding.step_completed:system')
                  setStep(nextStepAfterSystemCheck)
                }}
              >
                Continue
              </Button>
            </div>
          </Card>
        )

      case 1:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <h2>Create project</h2>
              </div>
              {createdProjectName ? <ToneBadge tone="positive">Created</ToneBadge> : null}
            </div>
            {createdProjectName ? (
              <div className="compact-stack">
                <p className="text-neutral">Project <span className="text-heading text-label-14-strong">{createdProjectName}</span> created successfully.</p>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" onClick={() => completeExistingStep('project', 2)}>Continue</Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <div className="setup-field">
                  <label className="setup-label" htmlFor="project-name">Project name</label>
                  <input id="project-name" className="setup-input" type="text" placeholder="my-website" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                  {slug && slug !== projectName ? <p className="supporting-copy">Slug: {slug}</p> : null}
                </div>
                <div className="setup-field">
                  <label className="setup-label" htmlFor="display-name">Display name (optional)</label>
                  <input id="display-name" className="setup-input" type="text" placeholder="My Website" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
                <div className="setup-field">
                  <label className="setup-label" htmlFor="domain">Canonical domain</label>
                  <input id="domain" className="setup-input" type="text" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
                </div>
                <div className="setup-field-row">
                  <div className="setup-field">
                    <label className="setup-label" htmlFor="country">Country</label>
                    <input id="country" className="setup-input" type="text" placeholder="US" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
                  </div>
                  <div className="setup-field">
                    <label className="setup-label" htmlFor="language">Language</label>
                    <input id="language" className="setup-input" type="text" placeholder="en" maxLength={5} value={language} onChange={(e) => setLanguage(e.target.value.toLowerCase())} />
                  </div>
                </div>
                <details><summary className="cursor-pointer py-2 text-label-14 text-link">Backlink tracking</summary><label className="flex items-start gap-3 py-3 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-strong bg-bg"
                    checked={autoExtractBacklinks}
                    onChange={(e) => setAutoExtractBacklinks(e.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="block text-label-14 text-heading">Auto-extract backlinks</span>
                    <span className="block text-label-12 text-muted mt-0.5">
                      When a new Common Crawl release syncs, automatically extract backlinks for this project.{' '}
                      <Link to="/backlinks" className="text-positive-400 hover:text-positive underline underline-offset-2">
                        Manage backlinks
                      </Link>
                    </span>
                  </span>
                </label></details>
                {projectError ? <p className="text-negative-400 text-copy-14">{projectError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={!slug || !domain || projectSaving} onClick={asyncHandler(handleCreateProject)}>
                    {projectSaving ? 'Creating…' : 'Create project'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )

      case 2:
        return (
          <StepSurface className={isProjectScoped ? 'visibility-setup-section step-card' : 'surface-card step-card'} aria-labelledby="setup-queries-heading">
            <SetupQueriesForm
              queries={queries}
              headingLevel="h2"
              loading={queriesHydrating}
              loadFailed={resumeQueriesQuery.isError}
              onRetryLoad={() => { void resumeQueriesQuery.refetch() }}
              onBack={leaveFirstStep}
              skipAction={(
                <Button type="button" variant="ghost" onClick={skipQueries}>
                  {isProjectScoped ? 'Finish without AI Visibility' : 'Skip for now'}
                </Button>
              )}
              // The provider form above carries the primary action until it is saved.
              saveVariant={engines.providerFormVisible ? 'secondary' : 'default'}
            />
          </StepSurface>
        )

      case 3:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <h2>Add competitors</h2>
              </div>
              {competitorsSaved ? <ToneBadge tone="positive">Saved</ToneBadge> : null}
            </div>
            <p className="supporting-copy">Optional. Domains that compete for the same queries, one per line. You can add them later from the project.</p>
            {competitorsSaved ? (
              <div className="compact-stack">
                <ul className="detail-list">
                  {parsedCompetitors.map((c) => <li key={c}>{c}</li>)}
                </ul>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" onClick={() => completeExistingStep('competitors', 4, parsedCompetitors.length)}>Continue</Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <div className="setup-field">
                  <label className="setup-label" htmlFor="competitors">Competitor domains (one per line)</label>
                  <textarea
                    id="competitors"
                    className="setup-textarea text-copy-14"
                    rows={4}
                    placeholder={'competitor1.com\ncompetitor2.com'}
                    value={competitorsText}
                    onChange={(e) => setCompetitorsText(e.target.value)}
                  />
                </div>
                {competitorsError ? <p className="text-negative-400 text-copy-14">{competitorsError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <div className="flex gap-2">
                    {parsedCompetitors.length === 0 ? (
                      // Optional step: with nothing entered, the primary action
                      // moves on. A disabled "Save 0 competitors" read as a dead
                      // end, and half of the users who reached this step left.
                      <Button type="button" onClick={skipCompetitors}>
                        Continue without competitors
                      </Button>
                    ) : (
                      <>
                        <Button type="button" variant="outline" onClick={skipCompetitors}>
                          Skip
                        </Button>
                        <Button type="button" disabled={competitorsSaving} onClick={asyncHandler(handleSaveCompetitors)}>
                          {competitorsSaving ? 'Saving…' : `Save ${parsedCompetitors.length} competitor${parsedCompetitors.length !== 1 ? 's' : ''}`}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        )

      case 4: {
        const run = launchedRun.data
        const awaitingRunDetails = runTriggered && !run && Boolean(launchedRunId)
        const runStatus = run?.status
          ?? (launchedRunId === latestPersistedRun?.id ? latestPersistedRun.status : undefined)
        const terminal = runStatus === 'completed'
          || runStatus === 'partial'
          || runStatus === 'failed'
          || runStatus === 'cancelled'
        const snapshots = run?.snapshots ?? []
        // The run's own planned total, stored when its sweep starts; the preview's
        // count stands in only until the run reports one.
        const plannedResults = run?.plannedAnswers ?? (run && launchedRunPlan?.runId === run.id ? launchedRunPlan.requestCount : null)
        const featured = featuredSetupAnswer(snapshots, queryId => durableQueries.find(saved => saved.id === queryId)?.queryClass)
        const brandLabel = displayName || createdProjectName || 'your brand'
        const successfulRun = runStatus ? isSuccessfulSetupRun(runStatus, snapshots.length) : false
        const runFailureDetail = runError
          ?? (run?.error
            ? summarizeRunError(run.error)
            : runStatus === 'cancelled'
              ? 'The check was cancelled before it produced a baseline.'
              : (runStatus === 'completed' || runStatus === 'partial') && snapshots.length === 0
                ? 'The check finished without saving any engine results.'
                : latestPersistedRun?.statusDetail
                  || 'The check did not produce a baseline.')

        let stepBadge: ReactNode = null
        if (persistedSetupComplete || successfulRun) {
          stepBadge = <ToneBadge tone="positive">Complete</ToneBadge>
        } else if (runError && !runTriggered) {
          stepBadge = <ToneBadge tone="negative">Failed</ToneBadge>
        } else if (awaitingRunDetails) {
          stepBadge = <ToneBadge tone="neutral">{launchedRun.isError ? 'Unavailable' : 'Loading'}</ToneBadge>
        } else if (terminal) {
          stepBadge = <ToneBadge tone="negative">{runStatus === 'cancelled' ? 'Cancelled' : 'Failed'}</ToneBadge>
        } else if (runTriggered) {
          stepBadge = <ToneBadge tone="caution">{runStatus === RunStatuses.queued ? 'Queued' : 'Running'}</ToneBadge>
        }

        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <div className="flex items-center gap-2"><h2>{successfulRun ? 'Saved answers' : isDashboardManagedSweeps() ? 'AI Visibility' : runTriggered ? 'Your first AI Visibility check' : 'Run your first AI Visibility check'}</h2>{successfulRun || isDashboardManagedSweeps() ? null : <InfoTooltip text={firstCheckHelp(brandLabel, firstCheckUsesAccount)} />}</div>
              </div>
              {stepBadge}
            </div>
            {persistedSetupComplete ? (
              <div className="compact-stack">
                <p className="text-secondary">
                  <span className="text-strong text-label-14-strong">{createdProjectName}</span> has saved AI Visibility results.
                </p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => finishSetup()}>
                    Open project dashboard →
                  </Button>
                </div>
              </div>
            ) : !runTriggered && isDashboardManagedSweeps() ? (
              <ManagedFirstCheck
                projectName={createdProjectName}
                error={runError}
                actions={<><span /><Button type="button" onClick={() => finishSetup()}>Open project dashboard →</Button></>}
              />
            ) : !runTriggered ? (
              <FirstCheckReview
                preview={runPreview}
                details={[
                  { label: 'Website', value: domain },
                  { label: 'Market', value: formatLocaleLabel(country, language) },
                ]}
                queries={durableQueries}
                usesAccount={firstCheckUsesAccount}
                alert={runError ?? launchBlockedReason ?? null}
                actions={(
                  <>
                    <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={finishSetup}
                    >
                      Finish without running
                    </Button>
                    {systemBlockReason === 'no_provider' && !isProjectScoped ? (
                      <Button type="button" onClick={() => engines.setShowProviderConfig(true)}>Connect an AI engine</Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={runSaving || !!launchBlockedReason || runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true}
                        title={launchBlockedReason}
                        onClick={asyncHandler(handleLaunchRun)}
                      >
                        {runSaving ? 'Starting…' : runError ? 'Retry check' : 'Run check'}
                      </Button>
                    )}
                  </>
                )}
              />
            ) : awaitingRunDetails ? (
              <div className="compact-stack">
                <p role={launchedRun.isError ? 'alert' : 'status'} className="text-copy-14 text-secondary">
                  {launchedRun.isError ? 'Could not load the saved check. Try again to see its result.' : 'Loading saved check…'}
                </p>
                <div className="setup-nav">
                  <Button type="button" variant="ghost" onClick={() => finishSetup()}>Open project dashboard →</Button>
                  {launchedRun.isError ? <Button type="button" variant="outline" onClick={() => { void launchedRun.refetch() }}>Retry status check</Button> : null}
                </div>
              </div>
            ) : !terminal ? (
              <div className="space-y-5">
                <JobProgress
                  label="AI Visibility check progress"
                  noun="check"
                  phase={run?.startedAt ? 'Asking engines' : 'Waiting to start'}
                  count={run
                    ? plannedResults !== null && snapshots.length <= plannedResults
                      ? `${snapshots.length} of ${plannedResults} ${plannedResults === 1 ? 'answer' : 'answers'} saved`
                      : `${snapshots.length} ${snapshots.length === 1 ? 'answer' : 'answers'} saved`
                    : null}
                  done={run ? snapshots.length : null}
                  total={plannedResults}
                  startedAt={run?.startedAt}
                  queuedAt={run?.createdAt}
                />
                {/* An engine failing now, said before the check ends rather than after minutes of waiting. */}
                {Object.entries(run?.providerFailures ?? {}).map(([provider, failure]) => (
                  <div key={provider} role="status" className="rounded-md border border-caution px-3 py-2">
                    <p className="text-copy-14 text-primary">
                      {providerDisplayName(provider)}: {failure.failedQueries} {failure.failedQueries === 1 ? 'query' : 'queries'} failed{failure.stopped ? ', so this check stopped asking it' : ''}.
                    </p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-label-13 text-secondary">Engine message</summary>
                      <p className="mt-1 break-words text-copy-13 text-secondary">{failure.message}</p>
                    </details>
                  </div>
                ))}
                {launchedRun.isError && (
                  <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
                    <p>{launchedRun.error instanceof Error ? launchedRun.error.message : 'Could not refresh the check status.'}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void launchedRun.refetch() }}>
                      Retry status check
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => finishSetup()}>
                    Open project dashboard →
                  </Button>
                </div>
              </div>
            ) : !successfulRun ? (
              <div className="compact-stack">
                <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
                  <p>{runFailureDetail}</p>
                  <p className="mt-1 text-copy-13 text-secondary">{isDashboardManagedSweeps()
                    ? MANAGED_SWEEPS_COPY
                    : isAdmin
                      ? 'Review the connection, then retry.'
                      : 'Ask an administrator to review the provider and query configuration.'}</p>
                </div>
                {runPreview.isError && !isDashboardManagedSweeps() ? <RunPreviewSummary preview={runPreview.data} pending={runPreview.isFetching} failed onRetry={() => { void runPreview.refetch() }} /> : null}
                <div className="setup-nav">
                  {isAdmin && !isDashboardManagedSweeps() ? (
                    <Button type="button" variant="outline" onClick={engines.repairConnection}>Repair connection</Button>
                  ) : <span />}
                  {isDashboardManagedSweeps() || !isAdmin ? (
                    <Button type="button" onClick={() => finishSetup()}>Open project dashboard →</Button>
                  ) : <><Button type="button" variant="ghost" onClick={() => finishSetup()}>Open project dashboard →</Button><Button type="button" disabled={runSaving || !!launchBlockedReason || runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true} onClick={asyncHandler(handleLaunchRun)}>
                    {runSaving ? 'Retrying…' : 'Retry check'}
                  </Button></>}
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <p className="text-copy-14 text-secondary">
                  <span className="text-label-14-strong text-heading">{displayName || createdProjectName}</span>
                  {' · '}{snapshots.length} {snapshots.length === 1 ? 'answer' : 'answers'}
                </p>
                {/* Branded and non-brand queries never share a denominator, so each class is its own row. */}
                <FirstResultTable byClass={run?.queryCountsByClass} pooled={run?.queryCounts} />
                {featured ? <section className="mt-3 border-t border-default pt-4" aria-label="Your first saved answer"><FeaturedAnswer answer={featured} /></section> : null}
                {createdProjectName ? <details><summary className="cursor-pointer py-2 text-label-14 text-link">More setup options</summary><NextSteps projectName={createdProjectName} /></details> : null}
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => finishSetup()}>
                    Open project dashboard →
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )
      }

      default:
        return null
    }
  })()

  const stepIndicatorLabels = isProjectScoped ? PROJECT_VISIBILITY_STEPS : SETUP_STEPS
  // A first check that saved answers completes the last step as well.
  const stepIndicatorCurrent = step === 4 && (showingSuccessfulRun || persistedSetupComplete)
    ? stepIndicatorLabels.length
    : isProjectScoped ? (step === 4 ? 1 : 0) : step

  const changeEngines = step === 4 && !runTriggered ? <ChangeEngines engines={engines} /> : null

  return (
    <div className={isProjectScoped ? 'page-container visibility-setup' : 'page-container'}>
      <div className="page-header">
        <div className="page-header-left">
          <h1
            ref={visibilityProjectName ? visibilityHeadingRef : undefined}
            tabIndex={visibilityProjectName ? -1 : undefined}
            className="page-title outline-none"
          >
            {showingSuccessfulRun ? 'Your first AI Visibility result' : visibilityProjectName ? 'Set up AI Visibility' : 'Setup'}
          </h1>
          {!showingSuccessfulRun && !(step === 4 && runTriggered) ? <p className="page-subtitle">
            {visibilityProjectName
              ? step === 4
                ? 'Review the queries and engines for your first check.'
                : engines.providerReadiness === true
                  ? 'Choose the queries you want to track.'
                  : 'Connect an AI engine and add the queries you want to track.'
              : 'Create a project and run its first AI Visibility check.'}
          </p> : null}
        </div>
        {!showingSuccessfulRun && step !== 4 ? (
          <div className="page-header-right">
            <Button type="button" variant="ghost" size="sm" disabled={(Boolean(resumeProjectName) && !resumeQueriesQuery.isSuccess) || projectSaving || queries.saving || competitorsSaving || runSaving} onClick={resetDraft}>Reset unsaved fields</Button>
          </div>
        ) : null}
      </div>

      <SetupStepIndicator current={stepIndicatorCurrent} labels={stepIndicatorLabels} />

      <section className="setup-wizard">
        {providerSetup}
        {changeEngines}
        <div ref={stepContentRef}>{stepContent}</div>
      </section>
      {engines.providerGuard.dialog}
    </div>
  )
}

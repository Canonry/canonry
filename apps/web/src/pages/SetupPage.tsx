import { useCallback, useEffect, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ONBOARDING_FLOW_VERSION,
  bucketOnboardingCount,
  type OnboardingTelemetryEvent,
} from '@ainyc/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { OnboardingProgress } from '../components/shared/OnboardingProgress.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { addToast } from '../lib/toast-store.js'
import {
  createProject,
  setQueries,
  setCompetitors,
  generateQueries as apiGenerateQueries,
  updateProviderConfig,
  fetchQueries,
  heyClient,
  recordOnboardingEvent,
} from '../api.js'
import {
  getApiV1CdpStatusOptions,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1RunsByIdOptions,
} from '@ainyc/canonry-api-client/react-query'
import { isProjectDetailQuery, useTriggerRun } from '../queries/mutations.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useAccount } from '../contexts/account-context.js'
import { buildSetupModel, serviceStatusTooltip } from '../lib/health-helpers.js'
import { asyncHandler } from '../lib/async-handler.js'
import { summarizeRunError } from '../lib/format-helpers.js'
import {
  CDP_PROVIDER_NAME,
  normalizeProviderName,
  resolveAiVisibilityProviderReadiness,
} from '../lib/ai-visibility-provider-readiness.js'
import {
  createOnboardingEventId,
  getOrCreateOnboardingSessionId,
  isOnboardingHealthSettled,
  markOnboardingRunHandled,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  onboardingStepFromIndex,
  onboardingSystemBlockReason,
  readOnboardingLaunchedRun,
} from '../lib/onboarding-telemetry.js'
import type { DashboardVm, HealthSnapshot, ProjectCommandCenterVm, RunListItemVm } from '../view-models.js'

const SETUP_STEPS = [
  { label: 'System check', description: 'Verify your instance is ready' },
  { label: 'Create project', description: 'Name, domain, and locale' },
  { label: 'Queries', description: 'Add queries to track' },
  { label: 'Competitors', description: 'Add competitor domains' },
  { label: 'Launch', description: 'Start your first visibility sweep' },
] as const

const PROJECT_VISIBILITY_STEPS = [
  { label: 'Queries' },
  { label: 'First sweep' },
] as const

type SetupStep = 0 | 1 | 2 | 3 | 4
// `surface` is stamped centrally in `emitOnboardingEvent`, so no call site
// supplies it.
type PendingOnboardingTelemetryEvent<T> = T extends unknown ? Omit<T, 'eventId' | 'surface'> : never

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
            <span className="setup-step-number">{done ? '\u2713' : i + 1}</span>
            <span>{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The setup wizard exists to CREATE things — a project, its queries, its
 * first sweep. There is nothing in it for a view-only account.
 */
interface SetupPageProps {
  visibilityProjectName?: string
  siteHealthOnboarding?: boolean
}

export function SetupPage({
  visibilityProjectName,
  siteHealthOnboarding = false,
}: SetupPageProps = {}) {
  const { canWrite } = useAccount()
  if (visibilityProjectName && canWrite) {
    return (
      <SetupPageBody
        visibilityProjectName={visibilityProjectName}
        siteHealthOnboarding={siteHealthOnboarding}
      />
    )
  }
  return (
    <AdminOnly title={visibilityProjectName ? 'Set up AI Visibility' : 'Setup'}>
      <SetupPageBody
        visibilityProjectName={visibilityProjectName}
        siteHealthOnboarding={siteHealthOnboarding}
      />
    </AdminOnly>
  )
}

function SetupPageBody({ visibilityProjectName, siteHealthOnboarding }: SetupPageProps) {
  const contextDashboard = useInitialDashboard()
  // RootLayout and this page are separate observers of the same project query.
  // Both must pause the zero-project interval while setup owns project creation.
  const { dashboard, isLoading, refetch } = useDashboard(undefined, { pauseProjectPolling: true })
  const safeDashboard = dashboard ?? contextDashboard?.dashboard
  const navigate = useNavigate()
  const visibilityHeadingRef = useCallback<RefCallback<HTMLHeadingElement>>((node) => {
    if (node && visibilityProjectName) node.focus()
  }, [visibilityProjectName])
  const skipAiVisibility = () => {
    if (!visibilityProjectName) {
      void navigate({ to: '/', replace: true })
      return
    }
    void navigate({
      to: siteHealthOnboarding
        ? '/projects/$projectName/technical-aeo'
        : '/projects/$projectName',
      params: { projectName: visibilityProjectName },
      replace: true,
    })
  }

  if (!safeDashboard || isLoading) {
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
        {siteHealthOnboarding ? <OnboardingProgress current="visibility" /> : null}
        <div className="page-header">
          <div className="page-header-left">
            <h1 ref={visibilityHeadingRef} tabIndex={-1} className="page-title">Set up AI Visibility</h1>
            <p className="page-subtitle">Choose what to track, then run your first visibility sweep.</p>
          </div>
          {siteHealthOnboarding ? (
            <div className="page-header-right">
              <Button type="button" variant="outline" onClick={skipAiVisibility}>
                Skip AI Visibility
              </Button>
            </div>
          ) : null}
        </div>
        <Card role="alert" className="compact-stack">
          <h2>Project not found</h2>
          <p className="text-secondary">
            Canonry could not find the project handed off from Site Health. Refresh the project list or choose a project to continue.
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
      dashboard={safeDashboard}
      initialHealth={contextDashboard?.health}
      enableLiveStatus={!contextDashboard}
      refetch={refetch}
      visibilityProjectName={visibilityProjectName}
      visibilityHeadingRef={visibilityHeadingRef}
      siteHealthOnboarding={siteHealthOnboarding}
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
  siteHealthOnboarding,
}: {
  dashboard: DashboardVm
  initialHealth?: HealthSnapshot
  enableLiveStatus: boolean
  refetch: () => Promise<void>
  visibilityProjectName?: string
  visibilityHeadingRef: RefCallback<HTMLHeadingElement>
  siteHealthOnboarding?: boolean
}) {
  const settings = safeDashboard.settings

  const healthQuery = useHealth(enableLiveStatus, initialHealth)
  const healthSnapshot = healthQuery.data ?? initialHealth ?? { apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' }, workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' } }
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
    queryKey: ['setup', 'resume-queries', resumeProjectName],
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
  // Project-scoped AI Visibility setup starts with the measurement input, not
  // instance or project ceremony. Provider readiness gates only the paid run.
  const initialResumeStep: SetupStep = isProjectScoped
    ? 2
    : deriveSetupStep({
        launchReady: model.launchState.enabled,
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

  const [step, setStep] = useState<SetupStep>(initialResumeStep)
  const [resumeApplied, setResumeApplied] = useState(!resumeLoading)
  const queriesHydrating = isProjectScoped && (resumeLoading || !resumeApplied)

  const [projectName, setProjectName] = useState(resumeProject?.project.name ?? '')
  const [displayName, setDisplayName] = useState(resumeProject?.project.displayName ?? '')
  const [domain, setDomain] = useState(resumeProject?.project.canonicalDomain ?? '')
  const [country, setCountry] = useState(resumeProject?.project.country ?? 'US')
  const [language, setLanguage] = useState(resumeProject?.project.language ?? 'en')
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
      to: siteHealthOnboarding
        ? '/projects/$projectName/technical-aeo'
        : '/projects/$projectName',
      params: { projectName: createdProjectName },
      // Project-scoped setup replaces the project route on entry. Replace it
      // again on exit so Back cannot reopen a wizard the operator just finished.
      replace: Boolean(visibilityProjectName),
    })
  }

  const [queriesText, setQueriesText] = useState(durableQueries.map(query => query.query).join('\n'))
  const [queriesSaved, setQueriesSaved] = useState(durableQueryCount > 0)
  const [queriesError, setQueriesError] = useState<string | null>(null)
  const [queriesSaving, setQueriesSaving] = useState(false)
  const [queriesGenerated, setQueriesGenerated] = useState(false)

  const readyProviders = settings.providerStatuses.filter(p => p.state === 'ready')
  const projectProviders = resumeProject?.project.providers.map(normalizeProviderName) ?? []
  const runnableApiProviders = readyProviders.filter(provider => (
    projectProviders.length === 0 || projectProviders.includes(normalizeProviderName(provider.name))
  ))
  const configuredApiProviders = readyProviders.map(provider => normalizeProviderName(provider.name))
  const selectedApiProviderReady = runnableApiProviders.length > 0
  const selectionCanUseCdp = projectProviders.length === 0 || projectProviders.includes(CDP_PROVIDER_NAME)
  const cdpStatusQuery = useQuery({
    ...getApiV1CdpStatusOptions({ client: heyClient }),
    enabled: selectionCanUseCdp && !selectedApiProviderReady,
    staleTime: 60_000,
    retry: false,
  })
  // A registered CDP adapter remains a runnable provider when Chrome is
  // temporarily disconnected. `browserVersion` is absent only when no adapter
  // was registered, matching the project-page readiness contract.
  const cdpConfigured = !selectionCanUseCdp
    ? false
    : cdpStatusQuery.isSuccess
      ? typeof cdpStatusQuery.data.browserVersion === 'string'
      : cdpStatusQuery.isError ? false : undefined
  const providerReadiness = resolveAiVisibilityProviderReadiness({
    projectProviders,
    configuredApiProviders,
    cdpConfigured,
  })
  const runnableProviderCount = runnableApiProviders.length + (cdpConfigured === true ? 1 : 0)
  const [selectedProvider, setSelectedProvider] = useState(runnableApiProviders[0]?.name ?? '')
  const [generateCount, setGenerateCount] = useState(5)
  const [generatingQueries, setGeneratingQueries] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [competitorsText, setCompetitorsText] = useState(durableCompetitors.join('\n'))
  const [competitorsSaved, setCompetitorsSaved] = useState(durableCompetitors.length > 0)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  // A run THIS onboarding session launched for THIS project and never saw
  // finish. The wizard otherwise treats an already-successful project as
  // settled history and stops polling, so a reload during a multi-minute sweep
  // permanently loses the run-step completion. Failures land in under a second
  // and always emitted; the funnel could record a failure but not a success.
  const pendingLaunchedRun = useRef(readOnboardingLaunchedRun(resumeProjectName)).current
  const pendingLaunchedRunId = pendingLaunchedRun?.runId ?? null
  // The run whose outcome this onboarding session is entitled to report: one it
  // launched, in this mount or an earlier one. `latestPersistedRun` also drives
  // the poll so the UI can show an in-flight sweep, but a run the user never
  // launched here is somebody else's history, and emitting for it re-reported
  // the same failure on every single remount.
  const launchedThisSessionRunId = useRef<string | null>(pendingLaunchedRunId)
  const [runTriggered, setRunTriggered] = useState(
    !!pendingLaunchedRunId || (!!latestPersistedRun && !hasExistingSuccessfulBaseline),
  )
  const [runSaving, setRunSaving] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(
    pendingLaunchedRunId
      ?? (hasExistingSuccessfulBaseline ? null : latestPersistedRun?.id ?? null),
  )
  const triggerRunMutation = useTriggerRun()

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
  const parsedQueries = queriesText.split('\n').map(k => k.trim()).filter(Boolean)
  const parsedCompetitors = competitorsText.split('\n').map(c => c.trim()).filter(Boolean)
  const effectiveQueryCount = Math.max(durableQueryCount, queriesSaved ? parsedQueries.length : 0)
  const systemBlockReason = onboardingSystemBlockReason({
    apiReady: healthSnapshot.apiStatus.state === 'ok',
    databaseConfigured: healthSnapshot.apiStatus.databaseConfigured,
    workerReady: healthSnapshot.workerStatus.state === 'ok',
    // A pending CDP read is not yet a confirmed provider failure. The explicit
    // readiness message below keeps launch disabled until it settles.
    providerReady: providerReadiness !== false,
  })
  const readinessBlockedReason = systemBlockReason && systemBlockReason !== 'no_provider'
    ? model.launchState.blockedReason
    : providerReadiness === undefined
      ? 'Checking provider readiness before launch.'
      : systemBlockReason === 'no_provider'
        ? 'Launch is blocked until a provider allowed by this project is configured.'
        : undefined
  const launchBlockedReason = readinessBlockedReason
    ?? (!createdProjectName
      ? 'Create a project before launching the first sweep.'
      : effectiveQueryCount === 0
        ? 'Add at least one query before launching the first sweep.'
        : undefined)

  useEffect(() => {
    if (resumeApplied || resumeLoading) return
    // Project-scoped setup always starts on queries. Do not reset a fast user
    // who advances during the render/effect boundary after those queries load.
    if (!isProjectScoped) setStep(initialResumeStep)
    if (durableQueries.length > 0) {
      setQueriesText(durableQueries.map(query => query.query).join('\n'))
      setQueriesSaved(true)
    }
    setResumeApplied(true)
  }, [durableQueries, initialResumeStep, isProjectScoped, resumeApplied, resumeLoading])

  useEffect(() => {
    if (runnableApiProviders.length === 0) {
      setSelectedProvider('')
      return
    }
    if (!runnableApiProviders.some(provider => provider.name === selectedProvider)) {
      setSelectedProvider(runnableApiProviders[0]!.name)
    }
  }, [runnableApiProviders, selectedProvider])

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
      }, 'onboarding.step_completed:run')
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
    }, `onboarding.blocked:run:${reasonCode}`)
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

  const handleSaveQueries = async () => {
    if (!createdProjectName) return
    const queries = parsedQueries
    if (queries.length === 0) return
    setQueriesSaving(true)
    setQueriesError(null)
    try {
      await setQueries(createdProjectName, queries)
      setQueriesSaved(true)
      if (isProjectScoped) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getApiV1ProjectsByNameQueriesQueryKey({
              client: heyClient,
              path: { name: createdProjectName },
            }),
          }),
          queryClient.invalidateQueries({ predicate: isProjectDetailQuery }),
          queryClient.invalidateQueries({
            queryKey: ['setup', 'resume-queries', createdProjectName],
          }),
        ])
      } else {
        await refetch()
      }
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'queries',
        method: queriesGenerated ? 'generated' : 'manual',
        countBucket: bucketOnboardingCount(queries.length),
      }, 'onboarding.step_completed:queries')
      setStep(isProjectScoped ? 4 : 3)
    } catch (err) {
      setQueriesError(err instanceof Error ? err.message : 'Failed to save queries')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'queries',
        action: 'save',
        reasonCode: 'query_save_failed',
      }, 'onboarding.blocked:queries:query_save_failed')
    } finally {
      setQueriesSaving(false)
    }
  }

  const handleGenerateQueries = async () => {
    if (!createdProjectName || !selectedProvider) return
    setGeneratingQueries(true)
    setGenerateError(null)
    try {
      const result = await apiGenerateQueries(createdProjectName, selectedProvider, generateCount)
      if (result.queries.length > 0) {
        const newText = queriesText
          ? queriesText.trimEnd() + '\n' + result.queries.join('\n')
          : result.queries.join('\n')
        setQueriesText(newText)
        setQueriesGenerated(true)
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate queries')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'queries',
        action: 'generate_queries',
        reasonCode: onboardingErrorReason(err, 'unknown'),
      }, 'onboarding.blocked:queries:generate')
    } finally {
      setGeneratingQueries(false)
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
        detail: 'Provider is ready — continuing setup.',
        tone: 'positive',
        dedupeKey: 'setup:gemini:configured',
        dedupeMode: 'drop',
      })
      setGeminiKey('')
      // Refetch dashboard so provider health and the launch gate both use the
      // newly-saved configuration. Select Gemini immediately so query
      // generation is ready when the operator reaches Step 3.
      await refetch()
      setSelectedProvider(
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
    if (!createdProjectName || launchBlockedReason) {
      setRunError(launchBlockedReason ?? 'Complete setup before launching the first sweep.')
      const reasonCode = systemBlockReason
        ?? (!createdProjectName ? 'unknown' : effectiveQueryCount === 0 ? 'no_queries' : 'run_rejected')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'rejected',
        providerCountBucket: bucketOnboardingCount(runnableProviderCount),
        queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
        reasonCode,
      })
      return
    }
    setRunSaving(true)
    setRunError(null)
    try {
      const run = await triggerRunMutation.mutateAsync({
        projectName: createdProjectName,
        projectLabel: displayName || projectName || createdProjectName,
        sourceAction: 'setup-launch',
      })
      setLaunchedRunId(run.id)
      setRunTriggered(true)
      markOnboardingRunLaunched(createdProjectName, run.id)
      launchedThisSessionRunId.current = run.id
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'queued',
        providerCountBucket: bucketOnboardingCount(runnableProviderCount),
        queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
      })
      await refetch()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to queue the visibility sweep. Retry when the instance is ready.')
      emitOnboardingEvent({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'rejected',
        providerCountBucket: bucketOnboardingCount(runnableProviderCount),
        queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
        reasonCode: onboardingErrorReason(err, 'run_rejected'),
      })
    } finally {
      setRunSaving(false)
    }
  }

  const goBack = () => setStep((s) => {
    if (isProjectScoped) return 2
    return Math.max(0, s - 1) as SetupStep
  })
  const completeExistingStep = (
    completedStep: 'project' | 'queries' | 'competitors',
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
      openProjectDashboard()
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

  const stepContent = (() => {
    switch (step) {
      case 0:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Step 1 of 5</p>
                <h2>System check</h2>
              </div>
            </div>
            <p className="supporting-copy">Checking that your Canonry instance is configured and reachable.</p>
            <div className="compact-stack">
              {model.healthChecks.map((check) => (
                <div key={check.id} className="health-check-row">
                  <div>
                    <p className="run-row-title">{check.label}</p>
                    <p className="supporting-copy">{check.detail}</p>
                    {check.id === 'provider' && check.state !== 'ready' && (
                      <div className="mt-3 rounded-md border border-default bg-bg-elevated/40 p-3 space-y-2">
                        <p className="text-xs text-secondary">
                          Paste a Gemini key to enable visibility checks (free at{' '}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noreferrer"
                            className="text-positive-400 hover:text-positive underline underline-offset-2"
                          >
                            aistudio.google.com
                          </a>
                          ).
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={geminiKey}
                            onChange={(e) => setGeminiKey(e.target.value)}
                            placeholder="AI... (paste here)"
                            className="flex-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-sm text-heading placeholder:text-faint focus:border-mono-600 focus:outline-none font-mono"
                            disabled={geminiSaving}
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={geminiSaving || !geminiKey.trim()}
                            onClick={asyncHandler(handleSaveGeminiKey)}
                          >
                            {geminiSaving ? 'Saving...' : 'Save'}
                          </Button>
                        </div>
                        {geminiError && (
                          <div role="alert" className="space-y-1 text-xs text-negative">
                            <p>{geminiError}</p>
                            <p>Check that the key is complete, then retry Save.</p>
                          </div>
                        )}
                        <p className="text-sm text-secondary">
                          Connect more answer engines later in{' '}
                          <Link to="/settings" className="text-link hover:underline">
                            Settings
                          </Link>
                          .
                        </p>
                      </div>
                    )}
                  </div>
                  <ToneBadge
                    tone={check.state === 'ready' ? 'positive' : 'caution'}
                    title={
                      check.id === 'api'
                        ? serviceStatusTooltip(healthSnapshot.apiStatus)
                        : check.id === 'worker'
                          ? serviceStatusTooltip(healthSnapshot.workerStatus)
                          : check.detail
                    }
                  >
                    {check.state === 'ready' ? 'Ready' : 'Attention'}
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
                disabled={!model.launchState.enabled}
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
                <p className="eyebrow eyebrow-soft">Step 2 of 5</p>
                <h2>Create project</h2>
              </div>
              {createdProjectName ? <ToneBadge tone="positive">Created</ToneBadge> : null}
            </div>
            {createdProjectName ? (
              <div className="compact-stack">
                <p className="text-neutral">Project <span className="text-heading font-medium">{createdProjectName}</span> created successfully.</p>
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
                <label className="flex items-start gap-3 rounded-md border border-default bg-surface p-3 cursor-pointer hover:border-strong">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-strong bg-bg"
                    checked={autoExtractBacklinks}
                    onChange={(e) => setAutoExtractBacklinks(e.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="block text-sm text-heading">Auto-extract backlinks</span>
                    <span className="block text-xs text-muted mt-0.5">
                      When a new Common Crawl release syncs, automatically extract backlinks for this project.{' '}
                      <Link to="/backlinks" className="text-positive-400 hover:text-positive underline underline-offset-2">
                        Manage backlinks
                      </Link>
                    </span>
                  </span>
                </label>
                {projectError ? <p className="text-negative-400 text-sm">{projectError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={!slug || !domain || projectSaving} onClick={asyncHandler(handleCreateProject)}>
                    {projectSaving ? 'Creating...' : 'Create project'}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )

      case 2:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">{isProjectScoped ? 'Step 1 of 2' : 'Step 3 of 5'}</p>
                <h2>Add queries</h2>
              </div>
              {queriesHydrating ? (
                <ToneBadge tone="neutral">Loading</ToneBadge>
              ) : resumeQueriesQuery.isError ? (
                <ToneBadge tone="negative">Load failed</ToneBadge>
              ) : queriesSaved ? (
                <ToneBadge tone="positive">{parsedQueries.length} saved</ToneBadge>
              ) : (
                <ToneBadge tone="neutral">{parsedQueries.length} quer{parsedQueries.length !== 1 ? 'ies' : 'y'}</ToneBadge>
              )}
            </div>
            <p className="supporting-copy">
              Enter the queries you want to track, one per line. A rough first list is
              fine: you can edit them, research more, and add to them at any time from the
              project.
            </p>
            {queriesHydrating ? (
              <div className="rounded-md border border-default bg-bg-elevated/40 p-4 text-sm text-secondary" role="status">
                Loading saved queries…
              </div>
            ) : resumeQueriesQuery.isError ? (
              <div className="compact-stack">
                <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-sm text-negative">
                  Saved queries could not be loaded. Retry before changing the query basket.
                </div>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={isProjectScoped ? openProjectDashboard : goBack}>Back</Button>
                  <Button type="button" onClick={() => { void resumeQueriesQuery.refetch() }}>
                    Retry loading queries
                  </Button>
                </div>
              </div>
            ) : queriesSaved ? (
              <div className="compact-stack">
                <ul className="detail-list">
                  {parsedQueries.map((q) => <li key={q}>{q}</li>)}
                </ul>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={isProjectScoped ? openProjectDashboard : goBack}>Back</Button>
                  <Button type="button" onClick={() => completeExistingStep('queries', isProjectScoped ? 4 : 3, parsedQueries.length)}>Continue</Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                {runnableApiProviders.length > 0 ? (
                  <div className="compact-stack">
                    <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wide">
                      <span className="flex-1 border-t border-base" />
                      auto-generate
                      <span className="flex-1 border-t border-base" />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="setup-field flex-1">
                        <label className="setup-label" htmlFor="gen-provider">Provider</label>
                        <select
                          id="gen-provider"
                          className="setup-input"
                          value={selectedProvider}
                          onChange={(e) => setSelectedProvider(e.target.value)}
                        >
                          {runnableApiProviders.map((p) => (
                            <option key={p.name} value={p.name}>{p.displayName ?? p.name}{p.model ? ` (${p.model})` : ''}</option>
                          ))}
                        </select>
                      </div>
                      <div className="setup-field">
                        <label className="setup-label" htmlFor="gen-count">Count</label>
                        <select
                          id="gen-count"
                          className="setup-input"
                          value={generateCount}
                          onChange={(e) => setGenerateCount(Number(e.target.value))}
                        >
                          {[3, 5, 10, 15, 20].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={generatingQueries || !selectedProvider}
                        onClick={asyncHandler(handleGenerateQueries)}
                      >
                        {generatingQueries ? 'Analyzing site...' : 'Generate'}
                      </Button>
                    </div>
                    {generateError ? <p className="text-negative-400 text-sm">{generateError}</p> : null}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 text-muted text-xs uppercase tracking-wide">
                  <span className="flex-1 border-t border-base" />
                  or type manually
                  <span className="flex-1 border-t border-base" />
                </div>
                <div className="setup-field">
                  <label className="setup-label" htmlFor="queries">Queries (one per line)</label>
                  <textarea
                    id="queries"
                    className="setup-textarea"
                    rows={6}
                    placeholder={'emergency dentist brooklyn\nbest invisalign downtown brooklyn\npediatric dentist brooklyn heights'}
                    value={queriesText}
                    onChange={(e) => setQueriesText(e.target.value)}
                  />
                </div>
                {queriesError ? <p className="text-negative-400 text-sm">{queriesError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={isProjectScoped ? openProjectDashboard : goBack}>Back</Button>
                  <Button type="button" variant="ghost" onClick={skipQueries}>
                    {isProjectScoped ? 'Finish without AI Visibility' : 'Skip for now'}
                  </Button>
                  <Button type="button" disabled={parsedQueries.length === 0 || queriesSaving} onClick={asyncHandler(handleSaveQueries)}>
                    {queriesSaving ? 'Saving...' : `Save ${parsedQueries.length} quer${parsedQueries.length !== 1 ? 'ies' : 'y'}`}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )

      case 3:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Step 4 of 5</p>
                <h2>Add competitors</h2>
              </div>
              {competitorsSaved ? <ToneBadge tone="positive">Saved</ToneBadge> : null}
            </div>
            <p className="supporting-copy">Domains that compete for the same queries. One per line.</p>
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
                    className="setup-textarea"
                    rows={4}
                    placeholder={'competitor1.com\ncompetitor2.com'}
                    value={competitorsText}
                    onChange={(e) => setCompetitorsText(e.target.value)}
                  />
                </div>
                {competitorsError ? <p className="text-negative-400 text-sm">{competitorsError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={skipCompetitors}>
                      Skip
                    </Button>
                    <Button type="button" disabled={parsedCompetitors.length === 0 || competitorsSaving} onClick={asyncHandler(handleSaveCompetitors)}>
                      {competitorsSaving ? 'Saving...' : `Save ${parsedCompetitors.length} competitor${parsedCompetitors.length !== 1 ? 's' : ''}`}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        )

      case 4: {
        const run = launchedRun.data
        const runStatus = run?.status
          ?? (launchedRunId === latestPersistedRun?.id ? latestPersistedRun.status : undefined)
        const terminal = runStatus === 'completed'
          || runStatus === 'partial'
          || runStatus === 'failed'
          || runStatus === 'cancelled'
        const snapshots = run?.snapshots ?? []
        const cited = snapshots.filter(s => s.citationState === 'cited').length
        const mentioned = snapshots.filter(s => s.answerMentioned === true).length
        const totalQueries = new Set(snapshots.map(s => s.query).filter((q): q is string => !!q)).size
        const successfulRun = runStatus ? isSuccessfulSetupRun(runStatus, snapshots.length) : false
        const persistedSetupComplete = hasExistingSuccessfulBaseline && !runTriggered
        const runFailureDetail = runError
          ?? (run?.error
            ? summarizeRunError(run.error)
            : runStatus === 'cancelled'
              ? 'The sweep was cancelled before it produced a baseline.'
              : (runStatus === 'completed' || runStatus === 'partial') && snapshots.length === 0
                ? 'The sweep finished without producing any snapshots. Confirm the query set and provider configuration, then retry.'
                : latestPersistedRun?.statusDetail
                  || 'The sweep did not produce a baseline. Review provider configuration, then retry.')

        let stepBadge: ReactNode = null
        if (persistedSetupComplete || successfulRun) {
          stepBadge = <ToneBadge tone="positive">Complete</ToneBadge>
        } else if (runError && !runTriggered) {
          stepBadge = <ToneBadge tone="negative">Failed</ToneBadge>
        } else if (terminal) {
          stepBadge = <ToneBadge tone="negative">{runStatus === 'cancelled' ? 'Cancelled' : 'Failed'}</ToneBadge>
        } else if (runTriggered) {
          stepBadge = <ToneBadge tone="caution">Running</ToneBadge>
        }

        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">{isProjectScoped ? 'Step 2 of 2' : 'Step 5 of 5'}</p>
                <h2>Launch first run</h2>
              </div>
              {stepBadge}
            </div>
            {persistedSetupComplete ? (
              <div className="compact-stack">
                <p className="text-secondary">
                  Setup is complete. <span className="text-strong font-medium">{createdProjectName}</span> already has a successful answer-visibility baseline.
                </p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={openProjectDashboard}>
                    {siteHealthOnboarding ? 'Finish and open project' : 'Open project dashboard →'}
                  </Button>
                </div>
              </div>
            ) : !runTriggered ? (
              <div className="compact-stack">
                <p className="supporting-copy">
                  Setup is done. You can run a first sweep now to get a baseline for{' '}
                  <span className="text-heading font-medium">{createdProjectName}</span>, or
                  finish and run it later from the project. A sweep calls the answer
                  engines, so it costs provider usage.
                </p>
                {(launchBlockedReason || runError) && (
                  <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-sm text-negative">
                    <p>{runError ?? launchBlockedReason}</p>
                    <p className="mt-1 text-xs text-secondary">Resolve the blocker above, then retry the sweep here.</p>
                  </div>
                )}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={openProjectDashboard}
                  >
                    Finish without running
                  </Button>
                  {systemBlockReason === 'no_provider' ? (
                    <Button type="button" asChild>
                      <Link to="/settings">Configure a provider</Link>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={runSaving || !!launchBlockedReason}
                      title={launchBlockedReason}
                      onClick={asyncHandler(handleLaunchRun)}
                    >
                      {runSaving ? 'Launching...' : runError ? 'Retry visibility sweep' : 'Launch visibility sweep'}
                    </Button>
                  )}
                </div>
              </div>
            ) : !terminal ? (
              <div className="compact-stack">
                <p className="text-neutral">
                  Sweep running. This usually takes 30 to 60 seconds.
                </p>
                <div className="rounded-md border border-default bg-surface p-3 text-xs text-muted">
                  <p>Status: <span className="text-neutral">{runStatus ?? 'queued'}</span></p>
                </div>
                {launchedRun.isError && (
                  <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-sm text-negative">
                    <p>{launchedRun.error instanceof Error ? launchedRun.error.message : 'Could not refresh the sweep status.'}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void launchedRun.refetch() }}>
                      Retry status check
                    </Button>
                  </div>
                )}
                <div className="setup-nav">
                  <span />
                  <Button type="button" variant="outline" onClick={openProjectDashboard}>
                    {siteHealthOnboarding ? 'Finish and open project' : 'Watch on project page'}
                  </Button>
                </div>
              </div>
            ) : !successfulRun ? (
              <div className="compact-stack">
                <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-sm text-negative">
                  <p>{runFailureDetail}</p>
                  <p className="mt-1 text-xs text-secondary">Fix provider or query configuration if needed, then retry without leaving setup.</p>
                </div>
                <div className="setup-nav">
                  <Button type="button" variant="outline" asChild>
                    <Link to="/settings">Configure providers</Link>
                  </Button>
                  <Button type="button" disabled={runSaving || !!launchBlockedReason} onClick={asyncHandler(handleLaunchRun)}>
                    {runSaving ? 'Retrying...' : 'Retry visibility sweep'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <p className="text-neutral">
                  Sweep complete. Your first answer-visibility snapshot for{' '}
                  <span className="text-heading font-medium">{createdProjectName}</span>:
                </p>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  <div className="rounded-md border border-default bg-surface p-3">
                    <p className="text-xs font-medium text-secondary">Mentioned</p>
                    <p className="text-2xl font-bold tabular-nums text-primary mt-1">{mentioned}<span className="text-faint text-lg"> / {totalQueries}</span></p>
                    <p className="mt-0.5 text-sm text-secondary">queries naming your brand</p>
                  </div>
                  <div className="rounded-md border border-default bg-surface p-3">
                    <p className="text-xs font-medium text-secondary">Cited</p>
                    <p className="text-2xl font-bold tabular-nums text-primary mt-1">{cited}<span className="text-faint text-lg"> / {totalQueries}</span></p>
                    <p className="mt-0.5 text-sm text-secondary">queries citing your site</p>
                  </div>
                  <div className="rounded-md border border-default bg-surface p-3">
                    <p className="text-xs font-medium text-secondary">Results</p>
                    <p className="text-2xl font-bold tabular-nums text-primary mt-1">{snapshots.length}</p>
                    <p className="mt-0.5 text-sm text-secondary">completed engine checks</p>
                  </div>
                </div>
                <p className="mt-1 text-sm text-secondary">
                  {siteHealthOnboarding
                    ? 'Your project is ready. Review the evidence in the project.'
                    : 'Open the project to review the evidence.'}
                </p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={openProjectDashboard}>
                    {siteHealthOnboarding ? 'Finish and open project' : 'Open project dashboard →'}
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

  return (
    <div className="page-container">
      {siteHealthOnboarding ? <OnboardingProgress current="visibility" /> : null}
      <div className="page-header">
        <div className="page-header-left">
          <h1
            ref={visibilityProjectName ? visibilityHeadingRef : undefined}
            tabIndex={visibilityProjectName ? -1 : undefined}
            className="page-title"
          >
            {visibilityProjectName ? 'Set up AI Visibility' : 'Setup'}
          </h1>
          <p className="page-subtitle">
            {visibilityProjectName
              ? 'Choose what to track. Connect a provider only when you are ready to run.'
              : 'Create a project and run its first visibility check.'}
          </p>
        </div>
        {siteHealthOnboarding ? (
          <div className="page-header-right">
            <Button type="button" variant="outline" onClick={openProjectDashboard}>
              Skip AI Visibility
            </Button>
          </div>
        ) : null}
      </div>

      <SetupStepIndicator
        current={isProjectScoped ? (step === 4 ? 1 : 0) : step}
        labels={isProjectScoped ? PROJECT_VISIBILITY_STEPS : SETUP_STEPS}
      />

      <section className="setup-wizard">
        {stepContent}
      </section>
    </div>
  )
}

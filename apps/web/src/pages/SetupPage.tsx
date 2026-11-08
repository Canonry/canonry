import { CitationStates } from '@canonry/canonry-contracts'
import { AnswerMarkdown } from '../components/shared/AnswerMarkdown.js'
import { ProviderBadge } from '../components/shared/ProviderBadge.js'
import { RunPreviewSummary, useRunPreview } from '../components/project/RunAdmissionNotice.js'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { isDashboardManagedSweeps, type ApiProject } from '../api.js'
import { ManagedSweepStatus, MANAGED_SWEEPS_COPY } from '../components/project/ManagedSweepStatus.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ONBOARDING_FLOW_VERSION,
  ProviderNames,
  RunKinds,
  RunStatuses,
  bucketOnboardingCount,
  formatLocaleLabel,
  isOpenRouterRoute,
  normalizeQueryText,
  openRouterRouteModel,
  providerConnectionName,
  uniqueQueryTexts,
  QueryClasses,
  type QueryClass,
  type CitationState,
  type OnboardingTelemetryEvent,
} from '@canonry/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { OnboardingProgress } from '../components/shared/OnboardingProgress.js'
import { NextSteps } from '../components/shared/NextSteps.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ProviderConfigForm } from '../components/settings/ProviderConfigForm.js'
import { PROVIDER_CONNECTION_TEST_COPY, ProviderConnectionTestLine, providerConnectionStatus } from '../components/settings/ProviderConnectionTest.js'
import { useProviderConnectionTests } from '../queries/provider-connection-tests.js'
import { catalogRouteFamilies } from '../lib/provider-routes.js'
import { ProjectEngineSettingsSection } from '../components/project/ProjectEngineSettingsSection.js'
import { OpenRouterModelPicker } from '../components/shared/OpenRouterModelPicker.js'
import { providerDisplayName } from '../lib/visibility-trend-helpers.js'
import { addToast } from '../lib/toast-store.js'
import {
  createProject,
  setQueries,
  setCompetitors,
  generateQueries as apiGenerateQueries,
  updateProviderConfig,
  updateProject,
  fetchQueries,
  fetchSettings,
  heyClient,
  recordOnboardingEvent,
} from '../api.js'
import {
  getApiV1CdpStatusOptions,
  getApiV1ProjectsByNameMeasurementSetupOptions,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1RunsByIdOptions,
} from '@canonry/canonry-api-client/react-query'
import { isProjectDetailQuery, useTriggerRun } from '../queries/mutations.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useAccount } from '../contexts/account-context.js'
import { buildSetupModel, serviceStatusTooltip } from '../lib/health-helpers.js'
import { useOnboardingRunOutcome } from './OnboardingCompletePage.js'
import { clearOnboardingDraft, readOnboardingDraft, wasOnboardingScanSkipped, writeOnboardingDraft } from '../lib/onboarding-draft.js'
import { useUnsavedChanges } from '../hooks/use-unsaved-changes.js'
import { asyncHandler } from '../lib/async-handler.js'
import { formatSweepInstant, summarizeRunError } from '../lib/format-helpers.js'
import {
  CDP_PROVIDER_NAME,
  normalizeProviderName,
  resolveAiVisibilityProviderReadiness,
} from '../lib/ai-visibility-provider-readiness.js'
import {
  createOnboardingEventId,
  getOrCreateOnboardingSessionId,
  isAiVisibilityLaunchedRun,
  isOnboardingHealthSettled,
  markOnboardingRunHandled,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  onboardingStepFromIndex,
  onboardingSystemBlockReason,
  readOnboardingLaunchedRun,
} from '../lib/onboarding-telemetry.js'
import type { DashboardVm, HealthSnapshot, ProjectCommandCenterVm, RunListItemVm } from '../view-models.js'

/** Compact for a mouse on a desktop; 44px tall for touch and narrow screens. */
const TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'

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

/** Characters of the first saved answer shown before "Read full answer". */
const FIRST_ANSWER_PREVIEW_LENGTH = 650

/**
 * What each provider is and what connecting it takes, as its adapter
 * (`packages/provider-*`) and `docs/providers/` describe it.
 */
const PROVIDER_CONNECT_GUIDANCE: Readonly<Partial<Record<string, string>>> = {
  [ProviderNames.gemini]: "Google's Gemini models, answering with Google Search. Needs an API key.",
  [ProviderNames.openai]: "OpenAI's GPT models, answering with web search. Needs an API key.",
  [ProviderNames.claude]: "Anthropic's Claude models, answering with web search. Needs an API key.",
  [ProviderNames.perplexity]: 'Perplexity, answering with web search. Needs an API key.',
  [ProviderNames.muse]: "Meta's Muse models, answering with web search. Needs a Meta Model API key.",
  [ProviderNames.openrouter]: 'Models from several makers through one key. You choose which models to check. Needs an API key.',
  [ProviderNames.local]: 'A model you run on an OpenAI-compatible server, without web search. Needs its base URL; an API key is optional.',
}

/**
 * The queries in a one-per-line list, each once. Lines match as the server's
 * query replace matches them (`normalizeQueryText`), keeping the first
 * spelling, so a count read from this is the number Save stores.
 */
function uniqueQueryLines(text: string): string[] {
  return uniqueQueryTexts(text.split('\n'))
}

/** Generated suggestions the list does not hold yet, and how many it already held. */
function newQuerySuggestions(currentText: string, suggestions: readonly string[]): { added: string[]; skipped: number } {
  const known = new Set(uniqueQueryLines(currentText).map(normalizeQueryText))
  const added: string[] = []
  let skipped = 0
  for (const suggestion of suggestions) {
    const query = suggestion.trim()
    const key = normalizeQueryText(query)
    if (!key) continue
    if (known.has(key)) {
      skipped += 1
      continue
    }
    known.add(key)
    added.push(query)
  }
  return { added, skipped }
}

/**
 * The saved answer to show first: one that names the brand, else one that
 * cites the site, else the first. Only an answer with text can be shown.
 */
function featuredSetupAnswer<T extends { queryId: string; answerText?: string | null; answerMentioned?: boolean | null; citationState: CitationState }>(
  snapshots: readonly T[],
  queryClassOf: (queryId: string) => QueryClass | null | undefined = () => undefined,
): T | undefined {
  const answered = snapshots.filter(snapshot => Boolean(snapshot.answerText?.trim()))
  // A branded query hands the engine the brand's name, so its mention says
  // little; a non-brand answer that names or cites the brand is the proof.
  const nonBrand = answered.filter(snapshot => queryClassOf(snapshot.queryId) === QueryClasses['non-brand'])
  return nonBrand.find(snapshot => snapshot.answerMentioned === true)
    ?? nonBrand.find(snapshot => snapshot.citationState === CitationStates.cited)
    ?? answered.find(snapshot => snapshot.answerMentioned === true)
    ?? answered.find(snapshot => snapshot.citationState === CitationStates.cited)
    ?? answered[0]
}

/** One figure in the first result's summary row. Its value names the query class for screen readers. */
function ResultFigure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-3 sm:px-4 sm:first:pl-0 sm:last:pr-0">
      <dt className="text-label-14 text-secondary">{label}</dt>
      <dd className="mt-1">{children}<span className="sr-only"> · all queries</span></dd>
    </div>
  )
}

/** "3 of 7 queries", or Unavailable when the run reports no query counts. */
function QueryShare({ count, total }: { count: number | undefined; total: number | undefined }) {
  if (count === undefined || total === undefined) return <span className="text-label-14 text-secondary">Unavailable</span>
  return (
    <>
      <span className="text-heading-20 tabular-nums text-heading">{count}</span>{' '}
      <span className="text-label-14 text-secondary">of {total} {total === 1 ? 'query' : 'queries'}</span>
    </>
  )
}

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
            <span className="setup-step-number" aria-hidden="true">{done ? '\u2713' : i + 1}</span>
            <span>{s.label}</span>
            {done ? <span className="sr-only">Complete</span> : null}
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
  /**
   * This visit is part of first-run onboarding, so finishing or skipping ends
   * on its "You're set" step. True for the Agent Readiness handoff and for the
   * first run that skipped the site scan, which shares no other UI with it.
   */
  onboardingFinish?: boolean
}

export function SetupPage({
  visibilityProjectName,
  siteHealthOnboarding = false,
  onboardingFinish = siteHealthOnboarding,
}: SetupPageProps = {}) {
  const { canWrite } = useAccount()
  if (visibilityProjectName && canWrite) {
    return (
      <SetupPageBody
        visibilityProjectName={visibilityProjectName}
        siteHealthOnboarding={siteHealthOnboarding}
        onboardingFinish={onboardingFinish}
      />
    )
  }
  return (
    <AdminOnly title={visibilityProjectName ? 'Set up AI Visibility' : 'Setup'}>
      <SetupPageBody
        visibilityProjectName={visibilityProjectName}
        siteHealthOnboarding={siteHealthOnboarding}
        onboardingFinish={onboardingFinish}
      />
    </AdminOnly>
  )
}

function SetupPageBody({ visibilityProjectName, siteHealthOnboarding, onboardingFinish }: SetupPageProps) {
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
  const navigate = useNavigate()
  const visibilityHeadingRef = useCallback<RefCallback<HTMLHeadingElement>>((node) => {
    if (node && visibilityProjectName) node.focus()
  }, [visibilityProjectName])
  const skipAiVisibility = () => {
    if (!visibilityProjectName) {
      void navigate({ to: '/', replace: true })
      return
    }
    if (onboardingFinish) {
      void navigate({
        to: '/setup',
        search: { onboarding: 'complete', setupProject: visibilityProjectName, skipped: 'visibility' },
        replace: true,
      })
      return
    }
    void navigate({
      to: '/projects/$projectName',
      params: { projectName: visibilityProjectName },
      replace: true,
    })
  }

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
        {siteHealthOnboarding ? <OnboardingProgress current="visibility" outcomes={{ site: 'unknown', fixes: 'unknown' }} /> : null}
        <div className="page-header">
          <div className="page-header-left">
            <h1 ref={visibilityHeadingRef} tabIndex={-1} className="page-title outline-none">Set up AI Visibility</h1>
            <p className="page-subtitle">Choose what to track, then run your first AI Visibility check.</p>
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
            Canonry could not find the project handed off from Agent Readiness. Refresh the project list or choose a project to continue.
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
      siteHealthOnboarding={siteHealthOnboarding}
      onboardingFinish={onboardingFinish}
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
  onboardingFinish,
}: {
  dashboard: DashboardVm
  initialHealth?: HealthSnapshot
  enableLiveStatus: boolean
  refetch: () => Promise<void>
  visibilityProjectName?: string
  visibilityHeadingRef: RefCallback<HTMLHeadingElement>
  siteHealthOnboarding?: boolean
  onboardingFinish?: boolean
}) {
  const settings = safeDashboard.settings
  const { isAdmin } = useAccount()

  const healthQuery = useHealth(enableLiveStatus, initialHealth)
  const healthSnapshot = healthQuery.data ?? initialHealth ?? { apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' }, workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' } }
  const model = buildSetupModel(safeDashboard.setup, healthSnapshot, settings)
  const openRouterConnected = settings.providerStatuses.some(provider => provider.name === 'openrouter' && (provider.state === 'ready' || provider.state === 'configured'))
  const connectionSetupReady = model.launchState.enabled || (openRouterConnected && model.healthChecks.every(check => check.state === 'ready' || check.id === 'provider'))
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
  const scan = useOnboardingRunOutcome(resumeProjectName ?? '', RunKinds['site-audit'], Boolean(siteHealthOnboarding && resumeProjectName))
  const scanOutcome = scan.outcome === 'not-started' && resumeProjectName && wasOnboardingScanSkipped(resumeProjectName) ? 'skipped' : scan.outcome
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
  const answerVisibilityRunIds = new Set(resumeProjectRuns
    .filter(run => run.kind === RunKinds['answer-visibility'])
    .map(run => run.id))
  const sessionLaunchedRun = useRef(readOnboardingLaunchedRun(resumeProjectName, true)).current
  // The Agent Readiness scan shares the launched-run marker, so only an AI
  // Visibility check resumes here. Handled means the outcome was reported, not
  // that its result was dismissed, so a handled check resumes while it is listed.
  const resumableLaunchedRunId = sessionLaunchedRun
    && isAiVisibilityLaunchedRun(sessionLaunchedRun, answerVisibilityRunIds)
    && (!sessionLaunchedRun.handled || answerVisibilityRunIds.has(sessionLaunchedRun.runId))
    ? sessionLaunchedRun.runId
    : null
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
    const heading = stepContentRef.current?.querySelector('h2')
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
  const [setupEngineProject, setSetupEngineProject] = useState(resumeProject?.project ?? null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)

  const openProjectDashboard = () => {
    if (!createdProjectName) {
      void navigate({ to: '/', replace: Boolean(visibilityProjectName) })
      return
    }
    void navigate({
      to: siteHealthOnboarding
        ? '/projects/$projectName/agent-readiness'
        : '/projects/$projectName',
      params: { projectName: createdProjectName },
      // Project-scoped setup replaces the project route on entry. Replace it
      // again on exit so Back cannot reopen a wizard the operator just finished.
      replace: Boolean(visibilityProjectName),
    })
  }
  // Forward exits record the selected next action even when AI-first setup
  // opens the project directly instead of showing the optional finish page.
  const finishSetup = (skippedVisibility = false) => {
    if (!onboardingFinish || !createdProjectName || !siteHealthOnboarding) {
      if (onboardingFinish && createdProjectName) {
        emitOnboardingEvent({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'onboarding.step_completed',
          step: 'finish',
          method: skippedVisibility ? 'skipped' : 'manual',
          nextAction: 'open_project',
        }, 'onboarding.step_completed:finish:open_project')
      }
      openProjectDashboard()
      return
    }
    void navigate({
      to: '/setup',
      search: {
        onboarding: 'complete',
        setupProject: createdProjectName,
        ...(skippedVisibility ? { skipped: 'visibility' as const } : {}),
      },
      replace: true,
    })
  }
  const skipToFinish = () => finishSetup(true)

  const [queriesText, setQueriesText] = useState(draft.queriesText ?? durableQueries.map(query => query.query).join('\n'))
  const [queriesSaved, setQueriesSaved] = useState(draft.queriesText === undefined && durableQueryCount > 0)
  const [queriesError, setQueriesError] = useState<string | null>(null)
  const [queriesSaving, setQueriesSaving] = useState(false)
  const [queriesGenerated, setQueriesGenerated] = useState(false)
  // Suggestions the last Generate left out because the list already held them.
  const [generatedDuplicates, setGeneratedDuplicates] = useState(0)
  // Generate appends after a provider round trip; read the list as it is then.
  const latestQueriesText = useRef(queriesText)
  useEffect(() => { latestQueriesText.current = queriesText }, [queriesText])

  const projectProviders = (setupEngineProject?.providers ?? resumeProject?.project.providers ?? []).map(normalizeProviderName)
  // OpenRouter routes are named from OpenRouter's catalog (the administrator
  // settings read), so setup shows a readable model name via OpenRouter rather
  // than the raw model ID.
  const settingsCatalogQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
    enabled: isAdmin && openRouterConnected && projectProviders.some(isOpenRouterRoute),
  })
  const readyProviders = [
    // A search answer service runs only where a project picks its profiles, so it never makes setup ready.
    ...settings.providerStatuses.filter(provider => (provider.state === 'ready' || provider.state === 'configured') && provider.name !== 'openrouter' && provider.kind !== 'answer-service'),
    ...(openRouterConnected ? projectProviders.filter(isOpenRouterRoute).map(name => ({ name, displayName: providerDisplayName(name, settingsCatalogQuery.data?.providerCatalog), model: openRouterRouteModel(name), state: 'ready' as const, detail: 'OpenRouter model configured.' })) : []),
  ]
  const runnableApiProviders = readyProviders.filter(provider => (
    projectProviders.length === 0 || projectProviders.includes(normalizeProviderName(provider.name))
  ))
  const configuredApiProviders = readyProviders.map(provider => normalizeProviderName(provider.name))
  const selectedApiProviderReady = runnableApiProviders.length > 0
  const selectionCanUseCdp = projectProviders.length === 0 || projectProviders.includes(CDP_PROVIDER_NAME)
  // Scoped writers cannot read the administrator's provider catalog. The
  // project-readable setup response exposes readiness without credentials or
  // instance capability inventory, using the server's exact run preflight.
  const usesProjectProviderReadiness = isProjectScoped && !isAdmin
  const projectProviderQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({
      client: heyClient,
      path: { name: resumeProjectName ?? '' },
    }),
    enabled: usesProjectProviderReadiness && Boolean(resumeProjectName),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  const projectProviderReady = projectProviderQuery.data?.answerVisibilityProviderReady
  const providerReadinessFailed = usesProjectProviderReadiness && (
    projectProviderQuery.isError
    || (projectProviderQuery.isSuccess && typeof projectProviderReady !== 'boolean')
  )
  const cdpStatusQuery = useQuery({
    ...getApiV1CdpStatusOptions({ client: heyClient }),
    enabled: !usesProjectProviderReadiness && selectionCanUseCdp && !selectedApiProviderReady,
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
  const providerReadiness = usesProjectProviderReadiness
    ? projectProviderQuery.isSuccess && projectProviderQuery.isFetchedAfterMount && !projectProviderQuery.isFetching
      ? projectProviderReady
      : undefined
    : resolveAiVisibilityProviderReadiness({
      projectProviders,
      configuredApiProviders,
      cdpConfigured,
    })
  const openRouterModelsNeeded = openRouterConnected && projectProviders.length === 0 && providerReadiness === false
  const providerNeedsConnection = providerReadiness === false && !openRouterModelsNeeded
  // An administrator picks OpenRouter models right in the provider step, so
  // connecting OpenRouter finishes here as a direct provider does. The catalog
  // is the administrator settings read the project Answer engines section uses.
  const inlineModelPicker = isProjectScoped && isAdmin && openRouterModelsNeeded
  const openRouterSettingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
    enabled: inlineModelPicker,
  })
  const openRouterCatalog = (openRouterSettingsQuery.data?.providerCatalog ?? []).find(provider => provider.name === 'openrouter')
  const runnableProviderCount = runnableApiProviders.length + (cdpConfigured === true ? 1 : 0)
  // The saved connections behind the listed engines: every route of a routed
  // family (OpenRouter models, answer-service profiles) shares its connection.
  const engineRouteFamilies = catalogRouteFamilies(settingsCatalogQuery.data?.providerCatalog ?? [])
  const engineConnectionNames = [...new Set([
    ...runnableApiProviders.map(provider => providerConnectionName(normalizeProviderName(provider.name), engineRouteFamilies)),
    ...(runnableApiProviders.length === 0 && cdpConfigured === true ? [CDP_PROVIDER_NAME] : []),
  ])]
  const engineConnectionStatusOf = (name: string) => settings.providerStatuses.find(provider => normalizeProviderName(provider.name) === name)
  // An administrator's settings read carries each connection's saved revision.
  const engineConnectionTests = useProviderConnectionTests(engineConnectionNames.map(name => {
    const revision = engineConnectionStatusOf(name)?.revision
    return revision === undefined ? { name } : { name, revision }
  }))
  const engineConnectionLabel = (name: string): string => {
    if (name === CDP_PROVIDER_NAME) return 'ChatGPT in Chrome'
    const status = engineConnectionStatusOf(name)
    return status?.displayName ?? status?.name ?? name
  }
  // A test of an API connection reaches the provider on the operator's account; Chrome's does not.
  const engineConnectionTestNoticeId = useId()
  const engineConnectionTestNotice = engineConnectionNames.includes(CDP_PROVIDER_NAME)
    ? null
    : PROVIDER_CONNECTION_TEST_COPY.sends(engineConnectionNames.map(engineConnectionLabel))
  // Connected only after a passing test of every listed connection; saved settings alone prove nothing.
  const engineConnectionStatus = providerConnectionStatus(engineConnectionTests.records)
  const [selectedProvider, setSelectedProvider] = useState(runnableApiProviders[0]?.name ?? '')
  const [generateCount, setGenerateCount] = useState(5)
  const [generatingQueries, setGeneratingQueries] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [configuringProvider, setConfiguringProvider] = useState('')
  const restoreProviderFocus = useRef(false)
  const scrollProviderFocus = useRef(false)
  const providerSelectorRef = useCallback<RefCallback<HTMLSelectElement>>((node) => {
    if (!node || !restoreProviderFocus.current) return
    // The keyed form must reset credentials and advanced fields on switch.
    // Restore only focus the user already had, not focus after background reads.
    restoreProviderFocus.current = false
    node.focus({ preventScroll: !scrollProviderFocus.current })
    scrollProviderFocus.current = false
  }, [])
  const [showProviderConfig, setShowProviderConfig] = useState(false)
  const [providerDirty, setProviderDirty] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const providerGuard = useUnsavedChanges(providerDirty, providerBusy)
  const [researchPromptCopied, setResearchPromptCopied] = useState(false)
  const [researchCopyError, setResearchCopyError] = useState(false)
  const configurableProviders = settings.providerStatuses.filter(provider => (
    normalizeProviderName(provider.name) !== CDP_PROVIDER_NAME
    && provider.kind !== 'answer-service'
    && (projectProviders.length === 0 || projectProviders.includes(normalizeProviderName(provider.name)) || (provider.name === 'openrouter' && projectProviders.some(isOpenRouterRoute)))
  ))
  const providerToConfigure = configurableProviders.find(provider => provider.name === configuringProvider)
    ?? configurableProviders.find(provider => provider.state !== 'ready' && provider.state !== 'configured')
    ?? configurableProviders.at(0)
  const providerGuidance = providerToConfigure ? PROVIDER_CONNECT_GUIDANCE[normalizeProviderName(providerToConfigure.name)] : undefined
  const researchPrompt = `Help me choose AI Visibility queries for Canonry project ${JSON.stringify(createdProjectName ?? projectName)} (${domain}).
1. Read the project, its existing tracked queries, and Agent Readiness findings. Ask about my customers, services, and locations if needed, then propose relevant customer queries.
2. Check the configured connection's capabilities, then use Canonry's Research flow to test a small approved batch. Retrieve saved answers and any available sources. Compare brand mentions separately from site citations; unavailable citation evidence is not a "not cited" result. Text-only routes can inform query research but cannot establish an AI Visibility baseline. Research does not add queries to tracking. If more candidates are needed, propose ICP Discovery separately.
3. Recommend a short list with reasons. Ask before provider usage. Once I approve, preserve existing queries and return the combined list, one query per line, for me to paste into setup. Do not change tracked queries or launch an AI Visibility check.`
  const copyResearchPrompt = async () => {
    setResearchCopyError(false)
    try {
      await navigator.clipboard.writeText(researchPrompt)
      setResearchPromptCopied(true)
    } catch {
      setResearchCopyError(true)
    }
  }

  const [competitorsText, setCompetitorsText] = useState(draft.competitorsText ?? durableCompetitors.join('\n'))
  const [competitorsSaved, setCompetitorsSaved] = useState(draft.competitorsText === undefined && durableCompetitors.length > 0)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  useEffect(() => {
    if (!resumeApplied) return
    const activeScope = createdProjectName ? `wizard:${createdProjectName}` : draftScope
    writeOnboardingDraft(activeScope, {
      ...(!createdProjectName ? { projectName, displayName, domain, country, language } : {}),
      ...(!queriesSaved && queriesText !== durableQueries.map(query => query.query).join('\n') ? { queriesText } : {}),
      ...(!competitorsSaved && competitorsText !== durableCompetitors.join('\n') ? { competitorsText } : {}),
    })
    if (activeScope !== draftScope) clearOnboardingDraft(draftScope)
  }, [competitorsSaved, competitorsText, country, createdProjectName, displayName, domain, draftScope, durableCompetitors, durableQueries, language, projectName, queriesSaved, queriesText, resumeApplied])

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
    setQueriesText(durableQueries.map(query => query.query).join('\n'))
    setQueriesSaved(durableQueryCount > 0)
    setCompetitorsText(durableCompetitors.join('\n'))
    setCompetitorsSaved(durableCompetitors.length > 0)
    setQueriesError(null)
    setCompetitorsError(null)
  }

  // A run THIS onboarding session launched for THIS project and never saw
  // finish. The wizard otherwise treats an already-successful project as
  // settled history and stops polling, so a reload during a multi-minute sweep
  // permanently loses the run-step completion. Failures land in under a second
  // and always emitted; the funnel could record a failure but not a success.
  const pendingLaunchedRun = useRef(readOnboardingLaunchedRun(resumeProjectName)).current
  // A pending Agent Readiness scan's outcome belongs to the Agent Readiness surface.
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
  const parsedQueries = uniqueQueryLines(queriesText)
  const parsedCompetitors = competitorsText.split('\n').map(c => c.trim()).filter(Boolean)
  const effectiveQueryCount = durableQueryCount
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
    : providerReadinessFailed
      ? 'Provider connections could not be checked. Try again.'
      : providerReadiness === undefined
      ? 'Checking provider connections before launch.'
      : systemBlockReason === 'no_provider'
        ? 'Launch is blocked until a provider allowed by this project is configured.'
        : undefined
  const launchBlockedReason = readinessBlockedReason
    ?? (!createdProjectName
      ? 'Create a project before launching the first check.'
      : effectiveQueryCount === 0
        ? 'Add at least one query before launching the first check.'
        : undefined)

  useEffect(() => {
    if (resumeApplied || resumeLoading) return
    // Query hydration must not reset a user who has already advanced or resumed a run.
    if (!isProjectScoped) setStep(initialResumeStep)
    if (durableQueries.length > 0 && draft.queriesText === undefined) {
      setQueriesText(durableQueries.map(query => query.query).join('\n'))
      setQueriesSaved(true)
    }
    setResumeApplied(true)
  }, [draft.queriesText, durableQueries, initialResumeStep, isProjectScoped, resumeApplied, resumeLoading])

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
      setSetupEngineProject(project)
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
      const savedQueries = await setQueries(createdProjectName, queries)
      queryClient.setQueryData(['setup', 'resume-queries', createdProjectName], savedQueries)
      setQueriesText(savedQueries.map(query => query.query).join('\n'))
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
        countBucket: bucketOnboardingCount(savedQueries.length),
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
    setGeneratedDuplicates(0)
    try {
      const result = await apiGenerateQueries(createdProjectName, selectedProvider, generateCount)
      const currentText = latestQueriesText.current
      const { added, skipped } = newQuerySuggestions(currentText, result.queries)
      if (added.length > 0) {
        setQueriesText(currentText.trim() ? `${currentText.trimEnd()}\n${added.join('\n')}` : added.join('\n'))
        setQueriesGenerated(true)
      }
      setGeneratedDuplicates(skipped)
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

  // The project's engines, saved through the same project update the Answer
  // engines section uses. The returned project drives provider readiness here.
  const saveSetupEngines = async (next: Pick<ApiProject, 'providers' | 'providerModels'>) => {
    const name = setupEngineProject?.name ?? createdProjectName
    if (!name) throw new Error('Create a project before choosing models.')
    const project = await updateProject(name, next)
    setSetupEngineProject(project)
    await refetch()
  }

  const handleLaunchRun = async () => {
    if (isDashboardManagedSweeps()) return
    if (runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true) return
    if (!createdProjectName || launchBlockedReason) {
      setRunError(launchBlockedReason ?? 'Complete setup before launching the first check.')
      const reasonCode = systemBlockReason
        ?? (!createdProjectName ? 'unknown' : effectiveQueryCount === 0 ? 'no_queries' : 'run_rejected')
      // Project-readable readiness is a boolean, not an inventory we can count.
      if (!usesProjectProviderReadiness) {
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
      if (!usesProjectProviderReadiness) {
        emitOnboardingEvent({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'queued',
          providerCountBucket: bucketOnboardingCount(runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(effectiveQueryCount),
        })
      }
      await refetch()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to queue the AI Visibility check. Retry when the instance is ready.')
      if (!usesProjectProviderReadiness) {
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
      skipToFinish()
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
  const providerRefreshAction = providerReadiness !== true || cdpConfigured === true ? (
    <Button type="button" variant="ghost" size="sm" className={TOUCH_TARGET} onClick={() => {
      void refetch()
      if (selectionCanUseCdp) void cdpStatusQuery.refetch()
      if (inlineModelPicker) void openRouterSettingsQuery.refetch()
    }}>
      Refresh connections
    </Button>
  ) : null
  const providerFormVisible = (providerNeedsConnection || showProviderConfig) && !!providerToConfigure
  const providerSetup = (isProjectScoped && step === 2) || (step === 4 && (showProviderConfig || providerReadiness !== true)) ? (
    !isAdmin ? (
      <section aria-labelledby="setup-provider-heading" className="space-y-2 border-b border-default pb-6 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="setup-provider-heading" className="text-heading-20 text-heading">AI engines</h2>
          {providerReadinessFailed ? null : (
            <span role="status" className="flex items-center gap-2">
              <ToneBadge tone={providerReadiness === true ? engineConnectionStatus.tone : 'neutral'}>
                {providerReadiness === true ? engineConnectionStatus.label : providerReadiness === false ? 'Not connected' : 'Checking'}
              </ToneBadge>
              <InfoTooltip text={providerReadiness === true
                ? 'Connection settings are saved. An administrator can test the connection, and a successful check also confirms access.'
                : providerReadiness === false
                  ? 'Ask an administrator to connect an AI engine for this project. You can save queries now.'
                  : 'Checking for a connected AI engine. An administrator manages provider settings. You can save queries now.'} />
            </span>
          )}
        </div>
        {providerReadinessFailed ? (
          <p role="alert" className="text-copy-14 text-negative">Provider connections could not be checked. Try again.</p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={TOUCH_TARGET}
          disabled={projectProviderQuery.isFetching}
          onClick={() => { void projectProviderQuery.refetch() }}
        >
          {providerReadinessFailed ? 'Retry provider check' : 'Refresh connections'}
        </Button>
      </section>
    ) : (
    <section aria-labelledby="setup-provider-heading" className="space-y-3 border-b border-default pb-6 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="setup-provider-heading" className="text-heading-20 text-heading">AI engines</h2>
        <ToneBadge tone={openRouterModelsNeeded ? 'caution' : providerReadiness === true ? engineConnectionStatus.tone : 'neutral'}>
          {providerReadiness === true ? engineConnectionStatus.label : openRouterModelsNeeded ? 'Choose models' : providerNeedsConnection ? 'Not connected' : 'Checking'}
        </ToneBadge>
        <InfoTooltip text={providerReadiness === true
          ? runnableApiProviders.length > 0
            ? engineConnectionTests.allConnected
              ? 'A test reached each provider with the saved settings. Checks and Research use your provider account and its quota.'
              : 'Connection settings are saved, but access and quota are not verified. Test the connection before your first check. Checks and Research use your provider account.'
            : 'ChatGPT in Chrome runs AI Visibility checks. Query Research needs an API provider.'
          : openRouterModelsNeeded
            ? 'OpenRouter is connected. Choose the models your AI Visibility checks ask. You can save queries now.'
          : providerNeedsConnection
            ? 'AI Visibility checks need an AI engine. You can save queries now and connect one later.'
            : 'Checking connected AI engines. You can choose queries meanwhile.'} />
      </div>
      {providerReadiness === true && (runnableApiProviders.length > 0 || cdpConfigured === true) ? (
        <ul aria-label="Saved AI engines" className="divide-y divide-default">
          {runnableApiProviders.map(provider => {
            const routed = isOpenRouterRoute(provider.name)
            const label = provider.displayName ?? provider.name
            const effectiveModel = setupEngineProject?.providerModels?.[provider.name] ?? resumeProject?.project.providerModels?.[provider.name] ?? provider.model
            return (
              <li key={provider.name} className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-2 text-label-14" title={routed ? openRouterRouteModel(provider.name) : undefined}>
                <span className="min-w-0 truncate text-heading">{routed ? label.replace(/ via OpenRouter$/, '') : label}</span>
                <span className="shrink-0 text-secondary">{routed ? 'OpenRouter' : effectiveModel ?? ''}</span>
              </li>
            )
          })}
          {runnableApiProviders.length === 0 ? <li className="flex min-h-11 items-center px-3.5 py-2 text-label-14 text-heading">ChatGPT in Chrome</li> : null}
        </ul>
      ) : null}
      {providerReadiness === true && engineConnectionNames.length > 0 && !providerFormVisible ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button type="button" variant="outline" size="sm" className={TOUCH_TARGET} disabled={engineConnectionTests.testing} aria-describedby={engineConnectionTestNotice ? engineConnectionTestNoticeId : undefined} onClick={engineConnectionTests.test}>
              {engineConnectionTests.testing
                ? PROVIDER_CONNECTION_TEST_COPY.testing
                : engineConnectionNames.length > 1 ? PROVIDER_CONNECTION_TEST_COPY.testMany : PROVIDER_CONNECTION_TEST_COPY.testOne}
            </Button>
            {engineConnectionTestNotice ? <p id={engineConnectionTestNoticeId} className="text-copy-14 text-secondary">{engineConnectionTestNotice}</p> : null}
          </div>
          <div role="status">
            {engineConnectionTests.records.some(record => record !== undefined) ? (
              <ul aria-label={PROVIDER_CONNECTION_TEST_COPY.results} className="space-y-1">
                {engineConnectionNames.map((name, index) => {
                  const record = engineConnectionTests.records[index]
                  return record ? <li key={name}><ProviderConnectionTestLine record={record} label={engineConnectionLabel(name)} /></li> : null
                })}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
      {inlineModelPicker ? (
        openRouterCatalog ? (
          <OpenRouterModelPicker
            inline
            catalog={openRouterCatalog}
            selected={projectProviders}
            // Explicit engines keep no model override for engines left out, as
            // Save engines does, and an OpenRouter model takes none of its own.
            onAdd={routes => saveSetupEngines({ providers: routes, providerModels: {} })}
          />
        ) : openRouterSettingsQuery.isPending ? (
          <p role="status" className="text-copy-14 text-secondary">Loading OpenRouter models…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-copy-14 text-negative">Couldn't load OpenRouter's model list.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => { void openRouterSettingsQuery.refetch() }}>Retry</Button>
          </div>
        )
      ) : null}
      {providerNeedsConnection || showProviderConfig ? (
        providerToConfigure ? (
          <div>
            <ProviderConfigForm
              key={providerToConfigure.name}
              compact
              configured={providerToConfigure.state === 'configured' || providerToConfigure.state === 'ready'}
              onDirtyChange={setProviderDirty}
              onBusyChange={setProviderBusy}
              onCancel={() => providerGuard.request(() => { setProviderDirty(false); setShowProviderConfig(false) })}
              leadingField={(
                <div className="min-w-0 space-y-1.5">
                  <label className="block text-label-14-strong text-secondary" htmlFor="setup-provider">Provider to connect</label>
                  <select
                    ref={providerSelectorRef}
                    id="setup-provider"
                    className="setup-input"
                    aria-describedby={providerGuidance ? 'setup-provider-guidance' : undefined}
                    value={providerToConfigure.name}
                    onChange={event => {
                      if (event.target.value === providerToConfigure.name) return
                      const nextProvider = event.target.value
                      providerGuard.request(() => {
                        restoreProviderFocus.current = true
                        setProviderDirty(false)
                        setConfiguringProvider(nextProvider)
                      })
                    }}
                  >
                    {configurableProviders.map(provider => (
                      <option key={provider.name} value={provider.name}>{provider.displayName ?? provider.name}</option>
                    ))}
                  </select>
                  {providerGuidance ? <p id="setup-provider-guidance" className="text-copy-13 text-secondary">{providerGuidance}</p> : null}
                </div>
              )}
              secondaryActions={providerRefreshAction}
              offerFreeTier={providerNeedsConnection}
              providerName={providerToConfigure.name}
              keyUrl={providerToConfigure.keyUrl}
              modelHint={providerToConfigure.modelHint}
              defaultModel={providerToConfigure.defaultModel}
              onSaved={() => {
                setProviderDirty(false)
                setShowProviderConfig(false)
                void refetch()
              }}
            />
          </div>
        ) : (
          <p className="max-w-prose text-copy-14 text-secondary">
            {projectProviders.length > 0
              ? `This project's provider selection is ${projectProviders.join(', ')}. Configure an allowed provider in Settings, or change the selection in project Settings.`
              : 'Provider configuration is unavailable here. Open Settings to connect an answer engine, then check again.'}
          </p>
        )
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {(providerReadiness === true || openRouterModelsNeeded) && !showProviderConfig && providerToConfigure ? (
          <Button type="button" variant="ghost" size="sm" className="-ml-3 text-button-14" onClick={() => setShowProviderConfig(true)}>
            Use a different provider
          </Button>
        ) : null}
        {!providerToConfigure || cdpConfigured === true ? (
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to="/settings" target="_blank" rel="noopener noreferrer">Open provider settings</Link>
          </Button>
        ) : null}
        {!providerFormVisible && !inlineModelPicker ? providerRefreshAction : null}
      </div>
    </section>
    )
  ) : null

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
                    <p className="supporting-copy">{check.id === 'provider' && openRouterConnected ? 'OpenRouter connected. Choose models before your first check.' : check.detail}</p>
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
                    tone={check.state === 'ready' ? check.id === 'provider' ? engineConnectionStatus.tone : 'positive' : 'caution'}
                    title={
                      check.id === 'api'
                        ? serviceStatusTooltip(healthSnapshot.apiStatus)
                        : check.id === 'worker'
                          ? serviceStatusTooltip(healthSnapshot.workerStatus)
                          : check.detail
                    }
                  >
                    {check.state === 'ready' ? check.id === 'provider' ? engineConnectionStatus.label : 'Ready' : 'Attention'}
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
            <div className="section-head">
              <div>
                <div className="flex items-center gap-2"><h2 id="setup-queries-heading">Add queries</h2><InfoTooltip text="Queries your customers ask AI assistants, one per line. You can refine the list later." /></div>
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
            {queriesHydrating ? (
              <div className="material-base p-4 text-label-14 text-secondary" role="status">
                Loading saved queries…
              </div>
            ) : resumeQueriesQuery.isError ? (
              <div className="compact-stack">
                <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
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
                  <Button type="button" variant="outline" onClick={() => setQueriesSaved(false)}>Edit queries</Button>
                  <Button type="button" onClick={() => completeExistingStep('queries', isProjectScoped ? 4 : 3, parsedQueries.length)}>Continue</Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <div className="setup-field">
                  <label className="setup-label" htmlFor="queries">Queries (one per line)</label>
                  <textarea
                    id="queries"
                    className="setup-textarea"
                    rows={6}
                    placeholder="One query per line"
                    value={queriesText}
                    onChange={(e) => setQueriesText(e.target.value)}
                  />
                </div>
                {runnableApiProviders.length > 0 ? (
                  <details className="compact-stack"><summary className="cursor-pointer py-2 text-label-14 text-link">Generate query suggestions</summary>
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
                            <option key={p.name} value={p.name}>{p.displayName ?? p.name}{p.model && !isOpenRouterRoute(p.name) ? ` (${p.model})` : ''}</option>
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
                        {generatingQueries ? 'Analyzing site…' : 'Generate'}
                      </Button>
                    </div>
                    {generateError ? <p role="alert" className="text-negative-400 text-copy-14">{generateError}</p> : null}
                    {/* Always mounted, so the count is announced when it appears. */}
                    <p role="status" className={generatedDuplicates > 0 ? 'pt-2 text-copy-13 text-secondary' : undefined}>
                      {generatedDuplicates > 0 ? `${generatedDuplicates} ${generatedDuplicates === 1 ? 'duplicate' : 'duplicates'} skipped` : ''}
                    </p>
                  </details>
                ) : null}
                <details open={researchCopyError || undefined} className="space-y-2">
                  <summary className="cursor-pointer py-2 text-label-14 text-link">Research queries with your agent</summary>
                  <textarea aria-label="Agent query research prompt" readOnly className="setup-textarea w-full" rows={8} value={researchPrompt} />
                  <Button type="button" variant="outline" size="sm" className={`shrink-0 self-start ${TOUCH_TARGET}`} onClick={asyncHandler(copyResearchPrompt)}>
                    {researchPromptCopied ? 'Research prompt copied' : 'Copy research prompt'}
                  </Button>
                  {researchCopyError ? <p role="alert" className="text-copy-14 text-negative">Could not copy. Select and copy the prompt above.</p> : null}
                </details>
                {queriesError ? <p role="alert" className="text-negative-400 text-copy-14">{queriesError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={isProjectScoped ? openProjectDashboard : goBack}>Back</Button>
                  <Button type="button" variant="ghost" onClick={skipQueries}>
                    {isProjectScoped ? 'Finish without AI Visibility' : 'Skip for now'}
                  </Button>
                  <Button type="button" disabled={parsedQueries.length === 0 || queriesSaving} onClick={asyncHandler(handleSaveQueries)}>
                    {queriesSaving ? 'Saving…' : `Save ${parsedQueries.length} quer${parsedQueries.length !== 1 ? 'ies' : 'y'}`}
                  </Button>
                </div>
              </div>
            )}
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
                    className="setup-textarea"
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
        const queryCounts = run?.queryCounts
        const plannedResults = run && launchedRunPlan?.runId === run.id ? launchedRunPlan.requestCount : null
        const featured = featuredSetupAnswer(snapshots, queryId => durableQueries.find(saved => saved.id === queryId)?.queryClass)
        const featuredAnswer = featured?.answerText ?? ''
        // AnswerMarkdown cuts its preview past this many parsed characters.
        // Markdown syntax and link URLs only make the written text longer, so
        // an answer within the limit always shows in full.
        const answerPreviewTruncated = Array.from(featuredAnswer).length > FIRST_ANSWER_PREVIEW_LENGTH
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
                <div className="flex items-center gap-2"><h2>{successfulRun ? 'Saved answers' : isDashboardManagedSweeps() ? 'AI Visibility' : 'Run your first AI Visibility check'}</h2>{successfulRun || isDashboardManagedSweeps() ? null : <InfoTooltip text={`Asks each AI engine your queries and records whether ${createdProjectName ?? 'your site'} is mentioned and cited. It uses your provider account. You can also finish now and run it later from the project.`} />}</div>
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
                    {siteHealthOnboarding ? 'Finish setup' : 'Open project dashboard →'}
                  </Button>
                </div>
              </div>
            ) : !runTriggered && isDashboardManagedSweeps() ? (
              <div className="compact-stack">
                {createdProjectName ? <ManagedSweepStatus projectName={createdProjectName} /> : <p className="text-copy-14 text-secondary">{MANAGED_SWEEPS_COPY}</p>}
                {runError && <p role="alert" className="text-copy-14 text-negative">{runError}</p>}
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => finishSetup()}>Open project dashboard →</Button>
                </div>
              </div>
            ) : !runTriggered ? (
              <div className="compact-stack">
                <RunPreviewSummary
                  preview={runPreview.data}
                  pending={runPreview.isFetching}
                  failed={runPreview.isError}
                  onRetry={() => { void runPreview.refetch() }}
                  details={[
                    { label: 'Website', value: domain },
                    { label: 'Market', value: formatLocaleLabel(country, language) },
                  ]}
                />
                <details>
                  <summary className="cursor-pointer py-2 text-label-14 text-link">Review saved queries</summary>
                  <ul className="detail-list mt-2" aria-label="Queries in this check">
                    {durableQueries.map(query => <li key={query.id}>{query.query}</li>)}
                  </ul>
                </details>
                <p className="text-copy-13 text-secondary">Runs once using your provider account. No schedule is created.</p>
                {(launchBlockedReason || runError) && (
                  <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
                    <p>{runError ?? launchBlockedReason}</p>
                  </div>
                )}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={skipToFinish}
                  >
                    Finish without running
                  </Button>
                  {systemBlockReason === 'no_provider' && !isProjectScoped ? (
                    <Button type="button" onClick={() => setShowProviderConfig(true)}>Connect an AI engine</Button>
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
                </div>
              </div>
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
              <div className="compact-stack">
                <p className="text-neutral">
                  Your check is running. You can leave this page and return to its progress.
                </p>
                {run ? <p className="text-copy-13 text-secondary" role="status">
                  {plannedResults !== null && snapshots.length <= plannedResults
                    ? `${snapshots.length} of ${plannedResults} engine ${plannedResults === 1 ? 'result' : 'results'} saved`
                    : `${snapshots.length} engine ${snapshots.length === 1 ? 'result' : 'results'} saved`} · {run.startedAt ? 'Started' : 'Queued'}{' '}
                  <time dateTime={run.startedAt ?? run.createdAt}>{formatSweepInstant(run.startedAt ?? run.createdAt)}</time>
                </p> : null}
                {launchedRun.isError && (
                  <div role="alert" className="rounded-md border border-negative bg-negative-soft p-3 text-label-14 text-negative">
                    <p>{launchedRun.error instanceof Error ? launchedRun.error.message : 'Could not refresh the check status.'}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void launchedRun.refetch() }}>
                      Retry status check
                    </Button>
                  </div>
                )}
                <div className="setup-nav">
                  <span />
                  <Button type="button" variant="outline" onClick={() => finishSetup()}>
                    {siteHealthOnboarding ? 'Finish setup' : 'Watch on project page'}
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
                    <Button type="button" variant="outline" onClick={() => {
                      restoreProviderFocus.current = true
                      scrollProviderFocus.current = true
                      setConfiguringProvider(runnableApiProviders[0]?.name ?? providerToConfigure?.name ?? '')
                      setShowProviderConfig(true)
                    }}>Repair connection</Button>
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
                {/* The run's own counts, branded and non-brand queries together: the class is named once here. */}
                <p className="text-copy-14 text-secondary">
                  <span className="text-label-14-strong text-heading">{displayName || createdProjectName}</span> · all queries
                </p>
                <dl className="grid grid-cols-1 divide-y divide-default sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <ResultFigure label="Mentioned">
                    <QueryShare count={queryCounts?.mentionedQueries} total={queryCounts?.totalQueries} />
                  </ResultFigure>
                  <ResultFigure label="Cited">
                    <QueryShare count={queryCounts?.citedQueries} total={queryCounts?.totalQueries} />
                  </ResultFigure>
                  <ResultFigure label="Engine results">
                    <span className="text-heading-20 tabular-nums text-heading">{snapshots.length}</span>
                  </ResultFigure>
                </dl>
                {featured ? <section className="mt-3 border-t border-default pt-4" aria-label="Your first saved answer">
                  <div className="mb-3 flex flex-wrap items-center gap-2"><ProviderBadge provider={featured.provider} displayName={providerDisplayName(featured.provider)} /><ToneBadge tone={featured.answerMentioned ? 'positive' : 'neutral'}>{featured.answerMentioned === true ? 'Mentioned' : featured.answerMentioned === false ? 'Not mentioned' : 'Mention not measured'}</ToneBadge><ToneBadge tone={featured.citationState === CitationStates.cited ? 'positive' : 'neutral'}>{featured.citationState === CitationStates.cited ? 'Cited' : 'Not cited'}</ToneBadge></div>
                  {featured.query ? <h3 className="text-heading-16 text-heading">{featured.query}</h3> : null}
                  {/* A preview that shows the whole answer carries its copy action; a cut one leaves it to the full answer. */}
                  <div className="mt-3 text-copy-14 text-secondary"><AnswerMarkdown previewLength={FIRST_ANSWER_PREVIEW_LENGTH} copyable={!answerPreviewTruncated}>{featuredAnswer}</AnswerMarkdown></div>
                  {answerPreviewTruncated ? <details className="mt-3"><summary className="cursor-pointer text-label-14 text-link">Read full answer</summary><div className="mt-3 text-copy-14 text-secondary"><AnswerMarkdown copyable>{featuredAnswer}</AnswerMarkdown></div></details> : null}
                </section> : null}
                {!onboardingFinish && createdProjectName ? <details><summary className="cursor-pointer py-2 text-label-14 text-link">More setup options</summary><NextSteps projectName={createdProjectName} /></details> : null}
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => finishSetup()}>
                    {siteHealthOnboarding ? 'Finish setup' : 'Open project dashboard →'}
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

  return (
    <div className={isProjectScoped ? 'page-container visibility-setup' : 'page-container'}>
      {siteHealthOnboarding ? <OnboardingProgress current="visibility" outcomes={{ site: scanOutcome, fixes: scanOutcome }} /> : null}
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
                : providerReadiness === true
                  ? 'Choose the queries you want to track.'
                  : 'Connect an AI engine and add the queries you want to track.'
              : 'Create a project and run its first AI Visibility check.'}
          </p> : null}
        </div>
        {!showingSuccessfulRun && (siteHealthOnboarding || step !== 4) ? (
          <div className="page-header-right">
            {step !== 4 ? <Button type="button" variant="ghost" size="sm" disabled={(Boolean(resumeProjectName) && !resumeQueriesQuery.isSuccess) || projectSaving || queriesSaving || competitorsSaving || runSaving} onClick={resetDraft}>Reset unsaved fields</Button> : null}
            {siteHealthOnboarding ? <Button type="button" variant="outline" className={TOUCH_TARGET} onClick={skipToFinish}>
              Skip AI Visibility
            </Button> : null}
          </div>
        ) : null}
      </div>

      {!siteHealthOnboarding ? <SetupStepIndicator current={stepIndicatorCurrent} labels={stepIndicatorLabels} /> : null}

      <section className="setup-wizard">
        {providerSetup}
        {step === 4 && !runTriggered && isAdmin && openRouterConnected && setupEngineProject && !inlineModelPicker && <details className="mb-4"><summary className="cursor-pointer py-2 text-label-14 text-link">Change engines</summary><ProjectEngineSettingsSection project={setupEngineProject} onSave={saveSetupEngines} /></details>}
        <div ref={stepContentRef}>{stepContent}</div>
      </section>
      {providerGuard.dialog}
    </div>
  )
}

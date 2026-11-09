import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import {
  getApiV1ProjectsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1RunsByIdOptions,
  getApiV1RunsOptions,
  getApiV1TelemetryOptions,
  getApiV1TelemetryQueryKey,
  putApiV1TelemetryMutation,
} from '@canonry/canonry-api-client/react-query'

import {
  ApiError,
  createOnboardingProject,
  getOnboardingMode,
  hasExplicitBrowserApiKey,
  heyClient,
  recordOnboardingEvent,
  shouldShowDashboardLocalAgentSetup,
  shouldShowDashboardResourceLinks,
  type ApiProject,
  type OnboardingMode,
} from '../api.js'
import {
  ONBOARDING_FLOW_VERSION,
  RunKinds,
  RunStatuses,
  RunTriggers,
  SITE_AUDIT_ONBOARDING_PAGE_LIMIT,
  formatLocaleLabel,
  normalizeProjectName,
  suggestedBrandName,
  type OnboardingSurface as OnboardingTelemetrySurface,
  type OnboardingTelemetryEvent,
} from '@canonry/canonry-contracts'
import { clearOnboardingDraft, markOnboardingScanSkipped, readOnboardingDraft, writeOnboardingDraft } from '../lib/onboarding-draft.js'
import { agentSetupRequest } from '../lib/agent-setup-request.js'
import { asyncHandler } from '../lib/async-handler.js'
import { addToast } from '../lib/toast-store.js'
import {
  createOnboardingEventId,
  getOrCreateOnboardingSessionId,
  markOnboardingRunHandled,
  clearOnboardingHandoff,
  isOnboardingHandoff,
  markOnboardingHandoff,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  readOnboardingLaunchedRun,
} from '../lib/onboarding-telemetry.js'
import { useTriggerSiteAudit } from '../queries/mutations.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { OnboardingProgress } from '../components/shared/OnboardingProgress.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { Button } from '../components/ui/button.js'
import { SetupPage } from './SetupPage.js'
import { OnboardingCompletePage } from './OnboardingCompletePage.js'

const LazySiteHealthSection = lazy(async () => {
  const module = await import('../components/project/SiteHealthSection.js')
  return { default: module.SiteHealthSection }
})

/** Asked for, not announced: the consent line states the ask, this explains it. */
const CRAWL_CONSENT_HELP = `Public pages only, crawled from this computer and stored locally. The first scan reads up to ${SITE_AUDIT_ONBOARDING_PAGE_LIMIT} pages, then stops.`

export const SITE_HEALTH_DISPATCH_BOUNDARY_MS = 1_800
export const AGENT_SETUP_GUIDE_URL = 'https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent'

export type OnboardingProjectListState =
  | { state: 'idle' | 'loading' | 'error' }
  | { state: 'success'; projectCount: number }

export type OnboardingSurface = 'legacy' | 'loading' | 'platform' | 'retry'

/**
 * `auto` is intentionally conservative. An unavailable project-list request
 * is not evidence that the install has no projects, so it gets recovery UI
 * rather than a potentially destructive first-open flow.
 */
export function resolveOnboardingSurface(
  mode: OnboardingMode,
  projectList: OnboardingProjectListState,
): OnboardingSurface {
  if (mode === 'legacy') return 'legacy'
  if (mode === 'platform') return 'platform'
  if (projectList.state === 'success') {
    return projectList.projectCount === 0 ? 'platform' : 'legacy'
  }
  if (projectList.state === 'error') return 'retry'
  return 'loading'
}

/** Compact for a mouse on a desktop; 44px tall for touch and narrow screens. */
const TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'
/**
 * Every launchpad field, inputs and selects alike: the shared input style at
 * 40px, with 16px text on narrow screens so a phone does not zoom on focus.
 */
const LAUNCHPAD_FIELD = `setup-input h-10 w-full max-md:text-label-16 ${TOUCH_TARGET}`
/** Before any Canonry install could exist: the whole scan history. */
const AUTO_RESUME_HISTORY_SINCE = '2000-01-01T00:00:00.000Z'
/** The runs endpoint's own maximum. Newest-first, so older scans fall off last. */
const AUTO_RESUME_HISTORY_LIMIT = 5000

/** The shape `resolveAutoResumeTarget` needs from a site-audit run. */
export interface AutoResumeRun {
  id: string
  projectId: string
  status: string
  trigger?: string
}

export interface AutoResumeTarget {
  projectName: string
  /** The scan to pin, when one exists. Absent means nothing has run yet. */
  runId?: string
}

/**
 * Where a bare `/setup` should land on an install that already has projects.
 *
 * This has to agree with `buildServeOpenLine` in the CLI, which is the other
 * half of the same decision. `serve` sends an operator to first-run setup only
 * while something is still unscanned, and names the FIRST UNSCANNED project.
 * Without the same two rules here, the `/setup` URL `serve` printed on an empty
 * install becomes a bookmark that later traps a returning operator in first-run
 * setup for a project that finished months ago, with `replace: true` and no way
 * back.
 *
 * Pinning the run matters to the funnel as much as to the UI. Every terminal
 * onboarding event is gated on a run id, so a resume that arrives without one
 * emits `onboarding.started` and can never emit anything after it: a permanent
 * open entry in the `site_health` surface that depresses its conversion rate.
 *
 * Probes are excluded for the same reason the scan-history endpoint excludes
 * them: a probe is not a scan the operator asked for or can read.
 */
export function resolveAutoResumeTarget(
  projects: readonly ApiProject[],
  siteAuditRuns: readonly AutoResumeRun[],
): AutoResumeTarget | null {
  const scanned = new Set<string>()
  const latestRunByProject = new Map<string, string>()
  // The runs list is newest-first, so the first row per project is its latest.
  for (const run of siteAuditRuns) {
    if (run.trigger === RunTriggers.probe) continue
    if (!latestRunByProject.has(run.projectId)) latestRunByProject.set(run.projectId, run.id)
    if (run.status === RunStatuses.completed || run.status === RunStatuses.partial) {
      scanned.add(run.projectId)
    }
  }
  // `serve` orders by created-at and the projects list is insertion-ordered,
  // which is the same sequence in practice. Sort when the DTO carries the
  // timestamp so the two agree by construction rather than by coincidence.
  const ordered = projects.every(project => project.createdAt)
    ? [...projects].sort((a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.name.localeCompare(b.name))
    : projects
  const target = ordered.find(project => !scanned.has(project.id))
  if (!target) return null
  return { projectName: target.name, runId: latestRunByProject.get(target.id) }
}

export interface LaunchpadIdentity {
  canonicalDomain: string
  projectName: string
  /** The brand name suggested for the website, used when the field is left blank. */
  displayName: string
}

export const LAUNCHPAD_COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'AU', label: 'Australia' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'IE', label: 'Ireland' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'ES', label: 'Spain' },
  { value: 'IT', label: 'Italy' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'BR', label: 'Brazil' },
  { value: 'MX', label: 'Mexico' },
  { value: 'IN', label: 'India' },
  { value: 'SG', label: 'Singapore' },
  { value: 'JP', label: 'Japan' },
] as const

export const LAUNCHPAD_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
] as const

/** Keep project creation on the locale values the launchpad explicitly supports. */
export function validateLaunchpadLocale(country: string, language: string): {
  countryValid: boolean
  languageValid: boolean
} {
  const normalizedCountry = country.trim().toUpperCase()
  const normalizedLanguage = language.trim().toLowerCase()
  return {
    countryValid: LAUNCHPAD_COUNTRIES.some(option => option.value === normalizedCountry),
    languageValid: LAUNCHPAD_LANGUAGES.some(option => option.value === normalizedLanguage),
  }
}

function isIpLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '')
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')
}

/**
 * Accept a public host or URL and make the intended server values visible
 * before submission. The server remains the authority for normalization and
 * validation; this protects the form from submitting obvious non-host input.
 */
export function deriveLaunchpadIdentity(value: string): LaunchpadIdentity | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const canonicalDomain = parsed.hostname.toLowerCase().replace(/^www\./, '')
  if (
    !canonicalDomain
    || canonicalDomain === 'localhost'
    || isIpLiteralHost(canonicalDomain)
    || !canonicalDomain.includes('.')
  ) {
    return null
  }

  const projectName = normalizeProjectName(canonicalDomain)

  return projectName
    ? { canonicalDomain, projectName, displayName: suggestedBrandName(canonicalDomain) }
    : null
}

export type SiteHealthDispatchResult = {
  runId: string
  status: string
}

export type SiteHealthDispatchSettlement<T extends SiteHealthDispatchResult> =
  | { state: 'queued'; run: T }
  | { state: 'timed-out' }

/**
 * The site scan can take a moment to queue on a cold worker. Bound only the
 * handoff, not the server job: after the boundary the valid project moves into
 * Agent Readiness, where the normal persisted run list resumes it.
 */
export async function settleSiteHealthDispatch<T extends SiteHealthDispatchResult>(
  dispatch: Promise<T>,
  timeoutMs = SITE_HEALTH_DISPATCH_BOUNDARY_MS,
): Promise<SiteHealthDispatchSettlement<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ state: 'timed-out' }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ state: 'timed-out' }), timeoutMs)
  })
  const result = await Promise.race([
    dispatch.then((run) => ({ state: 'queued' as const, run })),
    timeout,
  ])
  if (timeoutId) clearTimeout(timeoutId)
  return result
}

/** Keep a timed-out request observable after the launchpad has navigated away. */
export function watchTimedOutSiteHealthDispatch(
  dispatch: Promise<SiteHealthDispatchResult>,
  projectId: string,
): void {
  void dispatch.catch(() => {
    addToast({
      title: 'Agent Readiness audit scan did not start',
      detail: 'The project is safe. Choose Run scan in Agent Readiness to retry.',
      tone: 'negative',
      dedupeKey: `site-health-dispatch:${projectId}`,
    })
  })
}

type PendingOnboardingTelemetryEvent<T> = T extends unknown ? Omit<T, 'eventId' | 'surface'> : never

/**
 * Emit onboarding telemetry from a non-wizard surface.
 *
 * The first-run launchpad shipped with no instrumentation at all, so the
 * `/setup` funnel measured only the returning-user wizard — the one surface a
 * first-run user never sees. Same event vocabulary and same session id as the
 * wizard, tagged with the surface so the two funnels stay separable.
 */
function useOnboardingTelemetry(surface: OnboardingTelemetrySurface) {
  const onboardingSessionId = useRef(getOrCreateOnboardingSessionId()).current
  const recorded = useRef(new Set<string>())
  const emit = useCallback((
    event: PendingOnboardingTelemetryEvent<OnboardingTelemetryEvent>,
    dedupeKey?: string,
  ) => {
    if (dedupeKey) {
      if (recorded.current.has(dedupeKey)) return
      recorded.current.add(dedupeKey)
    }
    void recordOnboardingEvent({
      ...event,
      surface,
      eventId: createOnboardingEventId(),
    } as OnboardingTelemetryEvent)
  }, [surface])
  return { onboardingSessionId, emit }
}

function onboardingError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.statusCode === 409) {
    return 'A project with this name already exists. Change the project name, or open the existing project.'
  }
  return error instanceof Error && error.message ? error.message : fallback
}

function AutoModeLoading() {
  return (
    <div className="page-container max-w-3xl" aria-busy="true" aria-live="polite">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Preparing setup</h1>
          <p className="page-subtitle">Checking the projects already on this install.</p>
        </div>
      </div>
      <div className="flex items-center gap-3 material-base p-4 text-label-14 text-secondary" role="status">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        Loading projects…
      </div>
    </div>
  )
}

function AutoModeRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="page-container max-w-3xl">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Can’t load projects</h1>
          <p className="page-subtitle">Canonry could not confirm whether this install already has a project.</p>
        </div>
      </div>
      <div className="rounded-md border border-negative bg-negative-soft p-4" role="alert" tabIndex={-1}>
        <p className="text-copy-14-strong text-heading">Setup is paused to protect existing projects.</p>
        <p className="mt-1 text-copy-14 text-secondary">Check the connection or sign in again, then retry.</p>
        <Button type="button" className="mt-4" variant="secondary" onClick={onRetry}>
          Retry project check
        </Button>
      </div>
    </div>
  )
}

function SiteHealthOnboardingPage({
  projectName,
  initialRunId,
}: {
  projectName?: string
  initialRunId?: string
}) {
  return (
    <AdminOnly title="Project setup">
      <SiteHealthOnboardingPageBody projectName={projectName} initialRunId={initialRunId} />
    </AdminOnly>
  )
}

function SiteHealthOnboardingPageBody({
  projectName,
  initialRunId,
}: {
  projectName?: string
  initialRunId?: string
}) {
  const navigate = useNavigate()
  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: Boolean(projectName),
    retry: false,
    refetchOnMount: 'always',
  })
  const { onboardingSessionId, emit } = useOnboardingTelemetry('site_health')
  // Read on arrival, then spent in an effect (not in the initializer, which
  // StrictMode runs twice): spending it is what makes a later reload a resume.
  const [freshHandoff] = useState(() => isOnboardingHandoff(initialRunId))
  useEffect(() => {
    if (freshHandoff) clearOnboardingHandoff()
  }, [freshHandoff])

  // Before every early return below, so the funnel records that the handoff
  // from the launchpad actually landed. Reaching this page without a project
  // name is a broken link, not an onboarding step.
  useEffect(() => {
    if (!projectName) return
    emit({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.started',
      step: 'run',
      // A run is only a resume when this page was not just handed it by the
      // launchpad (a reload, the serve banner URL, or the auto-resume redirect).
      resumed: Boolean(initialRunId) && !freshHandoff,
    }, 'onboarding.started')
  }, [emit, freshHandoff, initialRunId, onboardingSessionId, projectName])

  // Claim the handed-off scan for this onboarding session, so its outcome is
  // reported once rather than on every remount of a page whose run is already
  // terminal.
  useEffect(() => {
    if (!projectName || !initialRunId) return
    if (readOnboardingLaunchedRun(projectName, true)?.runId === initialRunId) return
    markOnboardingRunLaunched(projectName, initialRunId, RunKinds['site-audit'])
  }, [initialRunId, projectName])

  // The scan's lifecycle lives inside SiteHealthSection, which is also rendered
  // on the project page where onboarding telemetry would be wrong. Polling the
  // run here keeps the terminal funnel event with the onboarding surface that
  // owns it, instead of pushing onboarding concerns into a shared component.
  const scanRun = useQuery({
    ...getApiV1RunsByIdOptions({ client: heyClient, path: { id: initialRunId ?? '' } }),
    enabled: Boolean(initialRunId),
    refetchInterval: ({ state }) => {
      const status = state.data?.status
      const terminal = status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled'
      return terminal ? false : 2000
    },
    // Same reason as the wizard's poll: without this, react-query suppresses
    // interval refetches whenever the tab loses focus, and a crawl outruns a
    // user's attention span.
    refetchIntervalInBackground: true,
  })
  const scanStatus = scanRun.data?.status
  useEffect(() => {
    if (!projectName || !initialRunId || !scanStatus) return
    if (readOnboardingLaunchedRun(projectName)?.runId !== initialRunId) return
    // A crawl has no snapshots, so status alone is the terminal signal.
    if (scanStatus === 'completed' || scanStatus === 'partial') {
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'run',
        method: 'automatic',
      }, `onboarding.step_completed:run:${initialRunId}`)
      markOnboardingRunHandled(initialRunId)
      return
    }
    if (scanStatus !== 'failed' && scanStatus !== 'cancelled') return
    const reasonCode = scanStatus === 'cancelled' ? 'run_cancelled' : 'run_failed'
    emit({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.blocked',
      step: 'run',
      action: 'retry_run',
      reasonCode,
    }, `onboarding.blocked:run:${initialRunId}:${reasonCode}`)
    markOnboardingRunHandled(initialRunId)
  }, [emit, initialRunId, onboardingSessionId, projectName, scanStatus])

  if (!projectName) {
    return (
      <div className="page-container max-w-3xl">
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">Project not found</h1>
            <p className="page-subtitle">This setup link does not identify a project.</p>
          </div>
        </div>
        <Button type="button" variant="secondary" onClick={() => { void navigate({ to: '/projects' }) }}>
          View projects
        </Button>
      </div>
    )
  }

  if (projectsQuery.isPending) {
    return (
      <div className="page-container max-w-3xl" aria-busy="true" aria-live="polite">
        <OnboardingProgress current="site" />
        <div className="mt-8 flex items-center gap-3 text-label-14 text-secondary" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          Loading Agent Readiness setup…
        </div>
      </div>
    )
  }

  if (projectsQuery.isError) {
    return (
      <div className="page-container max-w-3xl">
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">Can’t resume setup</h1>
            <p className="page-subtitle">Canonry could not load the project for this Agent Readiness audit scan.</p>
          </div>
        </div>
        <div className="rounded-md border border-negative bg-negative-soft p-4" role="alert">
          <p className="text-copy-14 text-secondary">Check the connection or sign in again, then retry.</p>
          <Button type="button" className="mt-4" variant="secondary" onClick={() => { void projectsQuery.refetch() }}>
            Retry project check
          </Button>
        </div>
      </div>
    )
  }

  const project = projectsQuery.data.find((candidate) => candidate.name === projectName)
  if (!project) {
    return (
      <div className="page-container max-w-3xl">
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">Project not found</h1>
            <p className="page-subtitle">
              Canonry could not find {projectName}. It will not open a different project.
            </p>
          </div>
        </div>
        <Button type="button" variant="secondary" onClick={() => { void navigate({ to: '/projects' }) }}>
          View projects
        </Button>
      </div>
    )
  }

  const releaseInitialRun = () => {
    void navigate({
      to: '/setup',
      search: { onboarding: 'site-health', setupProject: project.name },
      replace: true,
    })
  }
  const continueOnboarding = () => {
    if (!initialRunId) markOnboardingScanSkipped(project.name)
    void navigate({
      to: '/setup',
      search: {
        experience: 'legacy',
        onboarding: 'site-health',
        setupProject: project.name,
      },
      replace: true,
    })
  }
  const skipOnboarding = () => {
    if (!initialRunId) markOnboardingScanSkipped(project.name)
    // Leaving on purpose is an outcome, not an absence of one. Without this the
    // funnel cannot tell a user who chose to stop from one who vanished.
    emit({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.step_completed',
      step: 'run',
      method: 'skipped',
    }, 'onboarding.step_completed:run')
    void navigate({
      to: '/setup',
      search: { onboarding: 'complete', setupProject: project.name, skipped: 'visibility' },
      replace: true,
    })
  }

  return (
    <div className="page-container max-w-7xl py-8 md:py-10">
      <h1 className="sr-only">Set up Canonry</h1>
      <Suspense
        fallback={(
          <div className="space-y-5">
            <OnboardingProgress current="site" />
            <div className="flex min-h-72 items-center justify-center gap-3 text-label-14 text-secondary" role="status">
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              Loading Agent Readiness…
            </div>
          </div>
        )}
      >
        <LazySiteHealthSection
          projectName={project.name}
          projectId={project.id}
          initialRunId={initialRunId}
          onReleaseInitialRun={releaseInitialRun}
          showOnboardingActions
          onContinueOnboarding={continueOnboarding}
          onSkipOnboarding={skipOnboarding}
        />
      </Suspense>
    </div>
  )
}

/** Runtime switch around the existing wizard; legacy is unchanged when off. */
export function OnboardingSetupPage() {
  const search = useSearch({ from: '/setup' })
  const missingSiteHealthProject = search.onboarding === 'site-health' && !search.setupProject
  const explicitSiteHealthOnboarding = search.onboarding === 'site-health'
    && search.experience !== 'legacy'
  const configuredMode = getOnboardingMode()
  const mode: OnboardingMode = search.experience === 'legacy'
    ? 'legacy'
    : search.experience === 'platform'
      ? 'platform'
      : configuredMode
  const [platformLatched, setPlatformLatched] = useState(false)
  // `undefined` = not decided yet. The decision is made once per mount and then
  // held: re-deciding on every refetch would redirect an operator out of the
  // legacy wizard the moment it creates a project, taking its steps with it.
  const [autoResumeDecision, setAutoResumeDecision] = useState<AutoResumeTarget | null | undefined>(undefined)
  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: mode === 'auto',
    retry: false,
    // A cached empty list can be stale after a CLI/API creation. `auto` waits
    // for one mount-time confirmation before it treats this as first open.
    refetchOnMount: 'always',
  })
  // Scoped to site-audit for the same reason the dashboard scopes its own run
  // list: an unscoped read fills the server's row cap with integration syncs.
  // `since` is explicit because the endpoint otherwise returns only the last
  // 30 days, and a project scanned before that would read as never scanned.
  // `serve` reads all history; the two must agree.
  const siteAuditRunsQuery = useQuery({
    ...getApiV1RunsOptions({
      client: heyClient,
      query: { kind: RunKinds['site-audit'], since: AUTO_RESUME_HISTORY_SINCE, limit: AUTO_RESUME_HISTORY_LIMIT },
    }),
    enabled: mode === 'auto',
    retry: false,
    refetchOnMount: 'always',
  })
  const hasAuthoritativeEmptyProjectList = mode === 'auto'
    && projectsQuery.isSuccess
    && projectsQuery.isFetchedAfterMount
    && projectsQuery.data.length === 0

  useEffect(() => {
    if (hasAuthoritativeEmptyProjectList) setPlatformLatched(true)
  }, [hasAuthoritativeEmptyProjectList])

  const projectList: OnboardingProjectListState = mode !== 'auto'
    ? { state: 'idle' }
    : projectsQuery.isSuccess && projectsQuery.isFetchedAfterMount
      ? { state: 'success', projectCount: projectsQuery.data.length }
      : projectsQuery.isError
        ? { state: 'error' }
        : { state: 'loading' }
  const surface = mode === 'legacy'
    ? 'legacy'
    : platformLatched || hasAuthoritativeEmptyProjectList
      ? 'platform'
      : resolveOnboardingSurface(mode, projectList)

  if (search.onboarding === 'complete' && search.setupProject) {
    return <OnboardingCompletePage projectName={search.setupProject} skippedVisibility={search.skipped === 'visibility'} />
  }
  if (missingSiteHealthProject || explicitSiteHealthOnboarding) {
    return <SiteHealthOnboardingPage projectName={search.setupProject} initialRunId={search.siteHealthRunId} />
  }
  const autoResumeEligible = mode === 'auto'
    && surface === 'legacy'
    && !search.setupProject
    && projectsQuery.isSuccess
  if (autoResumeEligible && autoResumeDecision === undefined) {
    // Only the mount-time read counts: a cached list can predate a CLI scan.
    // A failed read is no evidence anything is unscanned, so it keeps the wizard.
    if (siteAuditRunsQuery.isError) {
      setAutoResumeDecision(null)
    } else if (siteAuditRunsQuery.isSuccess && siteAuditRunsQuery.isFetchedAfterMount) {
      setAutoResumeDecision(resolveAutoResumeTarget(projectsQuery.data, siteAuditRunsQuery.data))
    }
    // Deciding without the scan history would mean guessing that every project
    // is unscanned, which is the wrong guess in exactly the case that matters.
    // Wait instead of flashing the wizard and redirecting out of it a moment later.
    return <AutoModeLoading />
  }
  const autoResume = autoResumeEligible ? autoResumeDecision : null
  if (autoResume) {
    return <AutoResumeSetupRedirect projectName={autoResume.projectName} runId={autoResume.runId} />
  }
  if (surface === 'legacy') {
    return (
      <SetupPage
        visibilityProjectName={search.setupProject}
        siteHealthOnboarding={search.onboarding === 'site-health'}
        onboardingFinish={search.onboarding === 'site-health' || search.onboarding === 'first-run'}
      />
    )
  }
  if (surface === 'loading') return <AutoModeLoading />
  if (surface === 'retry') return <AutoModeRetry onRetry={() => { void projectsQuery.refetch() }} />
  return (
    <PlatformSetupPage
      onActivationStarted={() => setPlatformLatched(true)}
      skipSiteScan={search.siteScan !== 'scan'}
    />
  )
}

/** Resume an existing scan; otherwise continue the project’s first AI check. */
function AutoResumeSetupRedirect({ projectName, runId }: { projectName: string; runId?: string }) {
  const navigate = useNavigate()
  useEffect(() => {
    void navigate({
      to: '/setup',
      search: runId ? {
        onboarding: 'site-health',
        setupProject: projectName,
        siteHealthRunId: runId,
      } : {
        experience: 'legacy',
        onboarding: 'first-run',
        setupProject: projectName,
      },
      replace: true,
    })
  }, [navigate, projectName, runId])
  return <AutoModeLoading />
}

function PlatformSetupPage({
  onActivationStarted,
  skipSiteScan,
}: {
  onActivationStarted: () => void
  skipSiteScan: boolean
}) {
  return (
    <AdminOnly title="Project setup">
      <PlatformSetupPageBody
        onActivationStarted={onActivationStarted}
        skipSiteScan={skipSiteScan}
      />
    </AdminOnly>
  )
}

function PlatformSetupPageBody({
  onActivationStarted,
  skipSiteScan,
}: {
  onActivationStarted: () => void
  skipSiteScan: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const siteAuditMutation = useTriggerSiteAudit()
  // Telemetry status is operator-only, and the server grants operator access
  // only to a key sent as a bearer header, never to a session cookie. Without
  // its own browser key this dashboard signs requests with the cookie, so the
  // read could only be refused.
  const telemetryReadable = hasExplicitBrowserApiKey()
  const telemetryQuery = useQuery({
    ...getApiV1TelemetryOptions({ client: heyClient }),
    enabled: telemetryReadable,
    retry: false,
  })
  const telemetryMutation = useMutation(putApiV1TelemetryMutation())
  const [draft] = useState(() => readOnboardingDraft('platform'))
  const [domain, setDomain] = useState(draft.domain ?? '')
  const [projectName, setProjectName] = useState(draft.projectName ?? '')
  const [displayName, setDisplayName] = useState(draft.displayName ?? '')
  const [country, setCountry] = useState(draft.country ?? 'US')
  const [language, setLanguage] = useState(draft.language ?? 'en')
  const [crawlApproved, setCrawlApproved] = useState(false)
  useEffect(() => { setCrawlApproved(false) }, [domain, skipSiteScan])
  const [phase, setPhase] = useState<'idle' | 'creating' | 'dispatching' | 'recovery'>('idle')
  const [createdProject, setCreatedProject] = useState<ApiProject | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  /** The project name a create collided with, normalized as the server compares names. */
  const [conflictName, setConflictName] = useState<string | null>(null)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [agentRequestCopied, setAgentRequestCopied] = useState(false)
  const showLocalAgentSetup = shouldShowDashboardLocalAgentSetup()
  const showResourceLinks = shouldShowDashboardResourceLinks()
  // A legacy project can predate normalized names, so the recovery link uses
  // the stored name that collided, not the one this form would have created.
  const conflictProjectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: conflictName !== null,
    retry: false,
  })
  const existingProjectName = conflictName === null
    ? null
    : conflictProjectsQuery.data?.find(project => normalizeProjectName(project.name) === conflictName)?.name ?? conflictName
  // A denied refresh must not keep showing internal state from an older cache.
  const telemetryStatus = !telemetryReadable || telemetryQuery.isError ? undefined : telemetryQuery.data
  const telemetryEnabled = typeof telemetryStatus?.enabled === 'boolean'
    ? telemetryStatus.enabled
    : null
  const telemetryChecked = telemetryMutation.isPending
    ? telemetryMutation.variables.body.enabled
    : telemetryEnabled
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const projectDetailsRef = useRef<HTMLDetailsElement>(null)
  const projectNameRef = useRef<HTMLInputElement>(null)
  const { onboardingSessionId, emit } = useOnboardingTelemetry('platform')

  useEffect(() => {
    emit({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.started',
      step: 'project',
      resumed: false,
    }, 'onboarding.started')
  }, [emit, onboardingSessionId])

  useEffect(() => {
    if (createdProject) return
    writeOnboardingDraft('platform', { domain, projectName, displayName, country, language })
  }, [createdProject, domain, projectName, displayName, country, language])

  const resetDraft = () => {
    clearOnboardingDraft('platform')
    setDomain('')
    setProjectName('')
    setDisplayName('')
    setCountry('US')
    setLanguage('en')
    setCrawlApproved(false)
    setCreateError(null)
    setConflictName(null)
  }

  const identity = deriveLaunchpadIdentity(domain)
  // The fields hold only what the operator typed; the names derived from the
  // website are their placeholders and apply when a field is left blank. A
  // derived value shown as text would be appended to by typing and come back
  // after the field is cleared.
  const resolvedProjectName = projectName.trim() || identity?.projectName || ''
  const resolvedDisplayName = displayName.trim() || identity?.displayName || ''
  const busy = phase === 'creating' || phase === 'dispatching'
  const visibleError = createError ?? dispatchError
  const localeLabel = formatLocaleLabel(country, language)
  const { countryValid, languageValid } = validateLaunchpadLocale(country, language)
  const localeValid = countryValid && languageValid

  useEffect(() => {
    if (!visibleError) return
    // A name collision is fixed in the Project name field, so open its section
    // and move there; the alert below still says why.
    if (conflictName !== null && projectNameRef.current) {
      if (projectDetailsRef.current) projectDetailsRef.current.open = true
      projectNameRef.current.focus()
      return
    }
    errorRef.current?.focus()
  }, [conflictName, visibleError])

  const openSiteHealthSetup = (project: ApiProject, runId?: string) => navigate({
    to: '/setup',
    search: {
      ...(runId ? { siteHealthRunId: runId } : {}),
      onboarding: 'site-health',
      setupProject: project.name,
    },
    replace: true,
  })

  const dispatchSiteHealth = async (project: ApiProject) => {
    setPhase('dispatching')
    setDispatchError(null)
    try {
      const dispatch = siteAuditMutation.mutateAsync({
        projectName: project.name,
        projectId: project.id,
        projectLabel: project.displayName || project.name,
        suppressErrorToast: true,
        body: { checkDeadLinks: true, maxPages: SITE_AUDIT_ONBOARDING_PAGE_LIMIT },
      })
      const settlement = await settleSiteHealthDispatch(dispatch)
      if (settlement.state === 'queued') {
        // A site-health crawl has no providers and no tracked queries, so the
        // zero buckets are the honest values; `kind` is what keeps them from
        // reading as a misconfigured visibility sweep.
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
        markOnboardingHandoff(settlement.run.runId)
        await openSiteHealthSetup(project, settlement.run.runId)
        return
      }
      // Timed out is "we stopped waiting", not "it queued" and not "it failed",
      // so nothing is claimed HERE. But the request is still in flight and will
      // settle, and dropping that outcome would make every slow dispatch vanish
      // from the funnel — reading as "nobody started a scan" rather than "we
      // navigated on". Report it when it actually resolves.
      void dispatch.then(
        () => {
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
        },
        (error: unknown) => {
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
        },
      )

      // Do not leave a valid project pinned to the form while the request is
      // still settling. Agent Readiness's normal persisted run list will pick up
      // the queued scan as soon as it exists.
      watchTimedOutSiteHealthDispatch(dispatch, project.id)
      await openSiteHealthSetup(project)
    } catch (error) {
      setPhase('recovery')
      setDispatchError(onboardingError(error, 'The project was created, but the Agent Readiness audit scan could not be started.'))
      const reasonCode = onboardingErrorReason(error, 'run_rejected')
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'run.requested',
        origin: 'dashboard_setup',
        result: 'rejected',
        kind: 'site_health',
        providerCountBucket: '0',
        queryCountBucket: '0',
        reasonCode,
      })
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'run',
        action: 'retry_run',
        reasonCode,
      }, `onboarding.blocked:run:${reasonCode}`)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!identity || (!skipSiteScan && !crawlApproved) || !localeValid || busy) return

    setPhase('creating')
    setCreateError(null)
    setConflictName(null)
    setDispatchError(null)
    try {
      const project = await createOnboardingProject({
        name: resolvedProjectName,
        displayName: resolvedDisplayName,
        canonicalDomain: identity.canonicalDomain,
        country,
        language,
      })
      // `auto` would otherwise switch back to legacy as soon as creation makes
      // the authoritative project list non-empty, unmounting the handoff or
      // dispatch recovery.
      onActivationStarted()
      setCreatedProject(project)
      clearOnboardingDraft('platform')
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'project',
        method: 'manual',
      }, 'onboarding.step_completed:project')
      await queryClient.invalidateQueries({
        queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
      })
      if (skipSiteScan) {
        markOnboardingScanSkipped(project.name)
        await navigate({
          to: '/setup',
          search: {
            experience: 'legacy',
            onboarding: 'first-run',
            setupProject: project.name,
          },
          replace: true,
        })
        return
      }
      await dispatchSiteHealth(project)
    } catch (error) {
      setPhase('idle')
      const conflict = error instanceof ApiError && error.statusCode === 409
      setConflictName(conflict ? normalizeProjectName(resolvedProjectName) : null)
      setCreateError(onboardingError(error, 'Could not create the project. Try again.'))
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.blocked',
        step: 'project',
        action: 'save',
        reasonCode: onboardingErrorReason(error, 'project_create_failed'),
      }, 'onboarding.blocked:project')
      if (conflict) {
        // Keep the actionable collision recovery visible while `auto`
        // refreshes and discovers the project that won the create race.
        onActivationStarted()
        void queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
        })
      }
    }
  }

  const retryDispatch = () => {
    if (createdProject && !busy) {
      void dispatchSiteHealth(createdProject)
    }
  }

  const copyAgentSetupRequest = async () => {
    try {
      await navigator.clipboard.writeText(agentSetupRequest(showResourceLinks))
      setAgentRequestCopied(true)
    } catch {
      addToast({
        tone: 'negative',
        title: 'Could not copy setup request',
        detail: showResourceLinks ? 'Open the agent quickstart to continue with the CLI instead.' : 'Check your browser’s clipboard permission and try again.',
      })
    }
  }

  const updateTelemetry = async (enabled: boolean) => {
    setTelemetryError(null)
    try {
      const status = await telemetryMutation.mutateAsync({ client: heyClient, body: { enabled } })
      queryClient.setQueryData(
        getApiV1TelemetryQueryKey({ client: heyClient }),
        status,
      )
      if (status.enabled !== enabled) {
        setTelemetryError(`The server kept telemetry ${status.enabled ? 'on' : 'off'}. Check its telemetry settings.`)
      }
    } catch {
      setTelemetryError('Could not update telemetry. Try again.')
    }
  }

  if (createdProject && phase === 'recovery') {
    return (
      <div className="page-container max-w-3xl">
        <OnboardingProgress current="site" />
        <div className="page-header mt-8">
          <div className="page-header-left">
            <h1 className="page-title">Project created</h1>
            <p className="page-subtitle">{createdProject.displayName || createdProject.name} is ready. The Agent Readiness audit scan needs another try.</p>
          </div>
        </div>
        <div ref={errorRef} className="rounded-md border border-negative bg-negative-soft p-4" role="alert" tabIndex={-1}>
          <p className="text-copy-14-strong text-heading">{dispatchError}</p>
          <p className="mt-1 text-copy-14 text-secondary">You can retry the scan or continue setup and retry from Agent Readiness.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button type="button" onClick={retryDispatch}>Retry Agent Readiness audit scan</Button>
            <Button type="button" variant="secondary" onClick={() => { void openSiteHealthSetup(createdProject) }}>Continue setup</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container max-w-xl py-5 md:py-8">
      {!skipSiteScan ? <OnboardingProgress current="site" /> : null}
      <header className={`mb-8 ${skipSiteScan ? '' : 'mt-8'}`}>
        <h1 id="site-map-setup-title" className="text-heading-24 text-heading">
          {skipSiteScan ? 'Track your brand in AI answers' : 'Scan your site'}
        </h1>
        <p className="mt-2 max-w-lg text-copy-14 text-secondary">
          {skipSiteScan
            ? 'See how AI assistants mention your brand and cite your website.'
            : 'Check how ready your public website is for AI agents.'}
        </p>
      </header>

      <form aria-labelledby="site-map-setup-title" className="space-y-6" onSubmit={asyncHandler(submit)} noValidate>
        <div className="grid gap-2">
          <label className="text-label-14-strong text-heading" htmlFor="launchpad-domain">Website URL</label>
          <input
            id="launchpad-domain"
            className={LAUNCHPAD_FIELD}
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(domain && !identity)}
            aria-describedby={domain && !identity ? 'launchpad-domain-error' : undefined}
            placeholder="https://example.com"
            value={domain}
            onChange={(event) => {
              setDomain(event.target.value)
              setCreateError(null)
              setConflictName(null)
            }}
          />
          {domain && !identity ? <p id="launchpad-domain-error" className="text-copy-14 text-negative" role="alert">Enter a public domain, such as example.com.</p> : null}
        </div>

        <div className="grid gap-2">
          <label className="text-label-14-strong text-heading" htmlFor="launchpad-display-name">Brand name</label>
          <input id="launchpad-display-name" className={LAUNCHPAD_FIELD} type="text" autoComplete="organization" placeholder={identity?.displayName ?? 'Your brand'} value={displayName} onChange={event => setDisplayName(event.target.value)} />
        </div>

        <details ref={projectDetailsRef} className="group border-t border-default">
          <summary className={`flex min-h-9 cursor-pointer list-none items-center justify-between gap-4 py-2 text-label-14 [&::-webkit-details-marker]:hidden ${TOUCH_TARGET}`}>
            <span className="text-label-14-strong text-heading">Project details</span>
            <span className="flex items-center gap-2 text-secondary">
              {localeLabel}
              <ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-5 pb-4 pt-2">
            {identity ? (
              <div>
                <p className="mb-3 text-copy-14-strong text-heading">Project</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <label className="text-label-14 text-secondary" htmlFor="launchpad-project-name">Project name</label>
                    <input
                      ref={projectNameRef}
                      id="launchpad-project-name"
                      className={LAUNCHPAD_FIELD}
                      type="text"
                      placeholder={identity.projectName}
                      aria-invalid={conflictName !== null}
                      aria-describedby={conflictName !== null ? 'launchpad-create-error' : undefined}
                      value={projectName}
                      onChange={(event) => {
                        setProjectName(event.target.value)
                        // The collision was with the old name; a new one gets its own answer on submit.
                        if (conflictName !== null) {
                          setConflictName(null)
                          setCreateError(null)
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div>
              <p className="mb-3 text-copy-14-strong text-heading">Locale</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-label-14 text-secondary" htmlFor="launchpad-country">Country</label>
                  <select
                    id="launchpad-country"
                    className={LAUNCHPAD_FIELD}
                    value={country}
                    onChange={(event) => setCountry(event.target.value)}
                  >
                    {LAUNCHPAD_COUNTRIES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-label-14 text-secondary" htmlFor="launchpad-language">Language</label>
                  <select
                    id="launchpad-language"
                    className={LAUNCHPAD_FIELD}
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                  >
                    {LAUNCHPAD_LANGUAGES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </details>

        {!skipSiteScan ? <p className="text-copy-14 text-secondary">First scan: up to {SITE_AUDIT_ONBOARDING_PAGE_LIMIT} pages.</p> : null}
        {!skipSiteScan ? (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
            <input
              className="mt-0.5 size-4 shrink-0 rounded border-strong bg-bg"
              type="checkbox"
              checked={crawlApproved}
              onChange={(event) => setCrawlApproved(event.target.checked)}
              aria-label="Allow Canonry to scan this public site."
            />
            <span className="flex items-center gap-1.5">
              <span className="text-label-14 text-heading">Allow Canonry to scan this public site.</span>
              <InfoTooltip text={CRAWL_CONSENT_HELP} />
            </span>
          </label>
        ) : null}

        {visibleError ? (
          <div ref={errorRef} className="rounded-md border border-negative bg-negative-soft p-3" role="alert" tabIndex={-1}>
            <p id="launchpad-create-error" className="text-copy-14-strong text-heading">{visibleError}</p>
            {existingProjectName !== null ? (
              <Button asChild variant="secondary" size="sm" className="mt-3">
                <Link to="/projects/$projectName" params={{ projectName: existingProjectName }}>Open {existingProjectName}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-2">
          <Button
            className={`w-full ${TOUCH_TARGET}`}
            type="submit"
            disabled={!identity || (!skipSiteScan && !crawlApproved) || !localeValid || busy}
          >
            {phase === 'creating' || phase === 'dispatching'
              ? <><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> {skipSiteScan ? 'Creating project…' : 'Mapping site…'}</>
              : skipSiteScan ? 'Continue' : 'Scan site'}
          </Button>
          {phase === 'dispatching' ? <span className="text-center text-label-14 text-secondary" role="status">Opening Agent Readiness when the scan is ready.</span> : null}
          <Button asChild type="button" variant="ghost" className={TOUCH_TARGET}>
            <Link to="/setup" search={{ experience: 'platform', siteScan: skipSiteScan ? 'scan' : 'skip' }}>
              {skipSiteScan ? 'Scan site first' : 'Set up AI Visibility instead'}
            </Link>
          </Button>
        </div>
      </form>
      {(domain || projectName || displayName || country !== 'US' || language !== 'en') && <div className="mt-2 text-right"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={resetDraft}>Reset draft</Button></div>}

      <details className="mt-6 border-t border-default pt-4">
        <summary className="cursor-pointer text-label-14 text-secondary">Use your agent instead</summary>
        <p className="mt-1 text-copy-14 text-secondary">{showLocalAgentSetup ? 'Connect your agent to this instance, or copy a request for a new local installation.' : 'Connect ChatGPT or Claude Desktop to this instance.'}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <Button asChild variant="secondary" size="sm">
            <Link to="/agent-setup">Agent setup</Link>
          </Button>
          {showLocalAgentSetup ? <Button type="button" variant="ghost" size="sm" onClick={asyncHandler(copyAgentSetupRequest)}>
            {agentRequestCopied
              ? <Check className="size-3.5" aria-hidden="true" />
              : <Copy className="size-3.5" aria-hidden="true" />}
            <span aria-live="polite">
              {agentRequestCopied ? 'Copied new-install request' : 'Copy new-install request'}
            </span>
          </Button> : null}
          {showLocalAgentSetup && showResourceLinks ? <Button asChild variant="ghost" size="sm">
            <a href={AGENT_SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              Agent quickstart
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button> : null}
        </div>
      </details>

      {telemetryEnabled !== null ? (
        <section className="mt-6 border-t border-default pt-5" aria-labelledby="telemetry-title">
          <label className={`flex min-h-11 items-start gap-3 py-2 ${telemetryMutation.isPending ? 'cursor-wait' : 'cursor-pointer'}`}>
            <input
              className="mt-0.5 size-4 shrink-0 rounded border-strong bg-bg accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mono-500 disabled:cursor-wait"
              type="checkbox"
              checked={telemetryChecked ?? false}
              disabled={telemetryMutation.isPending}
              onChange={(event) => { void updateTelemetry(event.target.checked) }}
              aria-describedby="telemetry-detail"
            />
            <span className="grid gap-0.5">
              <span id="telemetry-title" className="text-label-14 text-heading">Share anonymous product telemetry</span>
              <span id="telemetry-detail" className="max-w-[70ch] text-label-14 text-secondary">
                Helps prioritize improvements. Canonry does not send raw domains, URLs, queries, answer content, or credentials.
              </span>
            </span>
          </label>
          {telemetryMutation.isPending ? <p className="mt-1 text-copy-14 text-secondary" role="status">Saving preference…</p> : null}
          {telemetryError ? <p className="mt-1 text-copy-14 text-negative" role="alert">{telemetryError}</p> : null}
        </section>
      ) : null}
    </div>
  )
}

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, ExternalLink, LoaderCircle } from 'lucide-react'
import {
  getApiV1ProjectsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1RunsByIdOptions,
  getApiV1TelemetryOptions,
  getApiV1TelemetryQueryKey,
  putApiV1TelemetryMutation,
} from '@ainyc/canonry-api-client/react-query'

import {
  ApiError,
  createOnboardingProject,
  getOnboardingMode,
  heyClient,
  recordOnboardingEvent,
  type ApiProject,
  type OnboardingMode,
} from '../api.js'
import {
  ONBOARDING_FLOW_VERSION,
  type OnboardingSurface as OnboardingTelemetrySurface,
  type OnboardingTelemetryEvent,
} from '@ainyc/canonry-contracts'
import { asyncHandler } from '../lib/async-handler.js'
import { addToast } from '../lib/toast-store.js'
import {
  createOnboardingEventId,
  getOrCreateOnboardingSessionId,
  markOnboardingRunHandled,
  markOnboardingRunLaunched,
  onboardingErrorReason,
  readOnboardingLaunchedRun,
} from '../lib/onboarding-telemetry.js'
import { useTriggerSiteAudit } from '../queries/mutations.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { OnboardingProgress } from '../components/shared/OnboardingProgress.js'
import { Button } from '../components/ui/button.js'
import { SetupPage } from './SetupPage.js'

const LazySiteHealthSection = lazy(async () => {
  const module = await import('../components/project/SiteHealthSection.js')
  return { default: module.SiteHealthSection }
})

export const SITE_HEALTH_DISPATCH_BOUNDARY_MS = 1_800
export const AGENT_SETUP_GUIDE_URL = 'https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent'
export const AGENT_SETUP_REQUEST = `Help me set up Canonry for my public site.

Use Canonry's official docs:
- Agent quickstart: https://github.com/Canonry/canonry#or-use-any-shell-capable-coding-agent
- CLI reference: https://github.com/Canonry/canonry/blob/main/skills/canonry/references/canonry-cli.md
- Plugin setup: https://github.com/Canonry/canonry/blob/main/docs/plugins.md
- MCP setup: https://github.com/Canonry/canonry/blob/main/docs/mcp.md

Use an existing Canonry installation or connected plugin/MCP if one is already available. Do not create a duplicate. The \`cnry\` and \`canonry\` commands are interchangeable.

1. Ask for my public domain, country, and language. Do not create or scan anything yet.
2. Check the local setup with \`command -v cnry\`, \`cnry --version\`, \`cnry doctor --format json\`, and \`cnry project list --format json\`. If Canonry is missing, propose \`npm install -g @canonry/canonry\` and wait for approval. If initialization is required, tell me to run \`cnry bootstrap\` in my private terminal and wait. Never ask me to paste passwords, API keys, OAuth credentials, or \`cnry bootstrap\` output.
3. Show the normalized domain, proposed project name, exact \`cnry project create ...\` command, and wait for explicit approval before creating it.
4. Propose a bounded Site Health scan, including \`--max-pages\` and whether dead-link checking is enabled. Show the exact \`cnry technical-aeo run ... --wait --format json\` command and wait for separate approval before scanning.
5. After the crawl, summarize the findings and propose AI Visibility setup. Ask before adding queries, connecting providers, starting any provider-backed or quota-consuming run, editing files, or publishing.`

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

export interface LaunchpadIdentity {
  canonicalDomain: string
  projectName: string
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

function launchpadLocaleLabel(country: string, language: string): string {
  try {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
    const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })
    const region = country.length === 2 ? regionNames.of(country.toUpperCase()) : undefined
    const locale = language ? languageNames.of(language.toLowerCase()) : undefined
    return `${region ?? (country || 'Country')} · ${locale ?? (language || 'Language')}`
  } catch {
    return `${country || 'Country'} · ${language || 'Language'}`
  }
}

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

  const projectName = canonicalDomain
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return projectName
    ? { canonicalDomain, projectName, displayName: canonicalDomain }
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
 * Site Health, where the normal persisted run list resumes it.
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
      title: 'Site Health scan did not start',
      detail: 'The project is safe. Choose Run scan in Site Health to retry.',
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
      <div className="flex items-center gap-3 rounded-lg border border-default bg-surface p-4 text-sm text-secondary" role="status">
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
      <div className="rounded-lg border border-negative bg-negative-soft p-4" role="alert" tabIndex={-1}>
        <p className="text-sm font-medium text-heading">Setup is paused to protect existing projects.</p>
        <p className="mt-1 text-sm text-secondary">Check the connection or sign in again, then retry.</p>
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
    <AdminOnly title="Site Health setup">
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
      resumed: Boolean(initialRunId),
    }, 'onboarding.started')
  }, [emit, initialRunId, onboardingSessionId, projectName])

  // Claim the handed-off scan for this onboarding session, so its outcome is
  // reported once rather than on every remount of a page whose run is already
  // terminal.
  useEffect(() => {
    if (!projectName || !initialRunId) return
    if (readOnboardingLaunchedRun(projectName)?.runId === initialRunId) return
    markOnboardingRunLaunched(projectName, initialRunId)
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
    // A crawl has no snapshots, so status alone is the terminal signal.
    if (scanStatus === 'completed' || scanStatus === 'partial') {
      emit({
        flowVersion: ONBOARDING_FLOW_VERSION,
        onboardingSessionId,
        event: 'onboarding.step_completed',
        step: 'run',
        method: 'automatic',
      }, 'onboarding.step_completed:run')
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
    }, `onboarding.blocked:run:${reasonCode}`)
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
        <div className="mt-8 flex items-center gap-3 text-sm text-secondary" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          Loading Site Health setup…
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
            <p className="page-subtitle">Canonry could not load the project for this Site Health scan.</p>
          </div>
        </div>
        <div className="rounded-lg border border-negative bg-negative-soft p-4" role="alert">
          <p className="text-sm text-secondary">Check the connection or sign in again, then retry.</p>
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
      to: '/projects/$projectName/technical-aeo',
      params: { projectName: project.name },
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
            <div className="flex min-h-72 items-center justify-center gap-3 text-sm text-secondary" role="status">
              <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
              Loading Site Health…
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
  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: mode === 'auto',
    retry: false,
    // A cached empty list can be stale after a CLI/API creation. `auto` waits
    // for one mount-time confirmation before it treats this as first open.
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

  if (missingSiteHealthProject || explicitSiteHealthOnboarding) {
    return <SiteHealthOnboardingPage projectName={search.setupProject} initialRunId={search.siteHealthRunId} />
  }
  if (surface === 'legacy') {
    return (
      <SetupPage
        visibilityProjectName={search.setupProject}
        siteHealthOnboarding={search.onboarding === 'site-health'}
      />
    )
  }
  if (surface === 'loading') return <AutoModeLoading />
  if (surface === 'retry') return <AutoModeRetry onRetry={() => { void projectsQuery.refetch() }} />
  return (
    <PlatformSetupPage
      onActivationStarted={() => setPlatformLatched(true)}
      skipSiteScan={search.siteScan === 'skip'}
    />
  )
}

function PlatformSetupPage({
  onActivationStarted,
  skipSiteScan,
}: {
  onActivationStarted: () => void
  skipSiteScan: boolean
}) {
  return (
    <AdminOnly title="Site Health setup">
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
  const telemetryQuery = useQuery({
    ...getApiV1TelemetryOptions({ client: heyClient }),
    retry: false,
  })
  const telemetryMutation = useMutation(putApiV1TelemetryMutation())
  const [domain, setDomain] = useState('')
  const [projectName, setProjectName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [country, setCountry] = useState('US')
  const [language, setLanguage] = useState('en')
  const [crawlApproved, setCrawlApproved] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'creating' | 'dispatching' | 'recovery'>('idle')
  const [createdProject, setCreatedProject] = useState<ApiProject | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createConflict, setCreateConflict] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [agentRequestCopied, setAgentRequestCopied] = useState(false)
  const telemetryStatus = telemetryMutation.data ?? telemetryQuery.data
  const telemetryEnabled = typeof telemetryStatus?.enabled === 'boolean'
    ? telemetryStatus.enabled
    : null
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)
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

  const identity = deriveLaunchpadIdentity(domain)
  const resolvedProjectName = projectName || identity?.projectName || ''
  const resolvedDisplayName = displayName || identity?.displayName || ''
  const busy = phase === 'creating' || phase === 'dispatching'
  const visibleError = createError ?? dispatchError
  const localeLabel = launchpadLocaleLabel(country, language)
  const { countryValid, languageValid } = validateLaunchpadLocale(country, language)
  const localeValid = countryValid && languageValid

  useEffect(() => {
    if (visibleError) errorRef.current?.focus()
  }, [visibleError])

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
        body: { checkDeadLinks: true },
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
      // still settling. Site Health's normal persisted run list will pick up
      // the queued scan as soon as it exists.
      watchTimedOutSiteHealthDispatch(dispatch, project.id)
      await openSiteHealthSetup(project)
    } catch (error) {
      setPhase('recovery')
      setDispatchError(onboardingError(error, 'The project was created, but the Site Health scan could not be started.'))
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
    setCreateConflict(false)
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
      setCreateConflict(conflict)
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

  const cancel = () => {
    if (busy) return
    void navigate({ to: '/projects' })
  }

  const copyAgentSetupRequest = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_SETUP_REQUEST)
      setAgentRequestCopied(true)
    } catch {
      addToast({
        tone: 'negative',
        title: 'Could not copy setup request',
        detail: 'Open the agent quickstart to continue with the CLI instead.',
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
            <p className="page-subtitle">{createdProject.displayName || createdProject.name} is ready. The Site Health scan needs another try.</p>
          </div>
        </div>
        <div ref={errorRef} className="rounded-lg border border-negative bg-negative-soft p-4" role="alert" tabIndex={-1}>
          <p className="text-sm font-medium text-heading">{dispatchError}</p>
          <p className="mt-1 text-sm text-secondary">You can retry the scan or continue setup and retry from Site Health.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button type="button" onClick={retryDispatch}>Retry Site Health scan</Button>
            <Button type="button" variant="secondary" onClick={() => { void openSiteHealthSetup(createdProject) }}>Continue setup</Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container max-w-xl py-8 md:py-12">
      {!skipSiteScan ? <OnboardingProgress current="site" /> : null}
      <header className={`mb-8 ${skipSiteScan ? '' : 'mt-8'}`}>
        <h1 id="site-map-setup-title" className="text-2xl font-semibold tracking-[-0.025em] text-heading">
          {skipSiteScan ? 'Create a project' : 'Map your site'}
        </h1>
        <p className="mt-2 max-w-lg text-sm leading-6 text-secondary">
          {skipSiteScan
            ? 'Add a public domain, then choose the queries you want to track. No site scan will run.'
            : 'Enter your public website to see its pages, structure, and internal links.'}
        </p>
      </header>

      <form aria-labelledby="site-map-setup-title" className="space-y-6" onSubmit={asyncHandler(submit)} noValidate>
        <div className="grid gap-2">
          <label className="text-sm font-medium text-heading" htmlFor="launchpad-domain">Website URL</label>
          <input
            id="launchpad-domain"
            className="h-11 w-full rounded-md border border-strong bg-bg-elevated/50 px-3 text-base text-heading outline-none transition placeholder:text-muted focus:border-mono-500 focus:ring-1 focus:ring-mono-500"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={Boolean(domain && !identity)}
            aria-describedby={domain && !identity ? 'launchpad-domain-hint launchpad-domain-error' : 'launchpad-domain-hint'}
            placeholder="https://example.com"
            value={domain}
            onChange={(event) => {
              setDomain(event.target.value)
              setCreateError(null)
              setCreateConflict(false)
            }}
          />
          <p id="launchpad-domain-hint" className="text-sm text-secondary">
            {skipSiteScan ? (
              <>
                A public domain is still required.{' '}
                <Link
                  to="/setup"
                  search={{ experience: 'platform' }}
                  className="font-medium text-link underline-offset-4 hover:underline"
                >
                  Map with Site Health instead
                </Link>
              </>
            ) : (
              <>
                Only public pages are scanned.{' '}
                <Link
                  to="/setup"
                  search={{ experience: 'platform', onboarding: 'first-run', siteScan: 'skip' }}
                  className="font-medium text-link underline-offset-4 hover:underline"
                >
                  Set up without a site scan
                </Link>
              </>
            )}
          </p>
          {domain && !identity ? <p id="launchpad-domain-error" className="text-sm text-negative" role="alert">Enter a public domain, such as example.com.</p> : null}
        </div>

        <details className="group border-y border-default">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
            <span className="font-medium text-heading">Advanced settings</span>
            <span className="flex items-center gap-2 text-secondary">
              {localeLabel}
              <ChevronDown className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-5 border-t border-default py-4">
            {identity ? (
              <div>
                <p className="mb-3 text-sm font-medium text-heading">Project</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <label className="text-sm text-secondary" htmlFor="launchpad-project-name">Project name</label>
                    <input
                      id="launchpad-project-name"
                      className="setup-input h-10"
                      type="text"
                      value={resolvedProjectName}
                      onChange={(event) => setProjectName(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm text-secondary" htmlFor="launchpad-display-name">Display name</label>
                    <input
                      id="launchpad-display-name"
                      className="setup-input h-10"
                      type="text"
                      value={resolvedDisplayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div>
              <p className="mb-3 text-sm font-medium text-heading">Locale</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <label className="text-sm text-secondary" htmlFor="launchpad-country">Country</label>
                  <select
                    id="launchpad-country"
                    className="setup-input h-10"
                    value={country}
                    onChange={(event) => setCountry(event.target.value)}
                  >
                    {LAUNCHPAD_COUNTRIES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm text-secondary" htmlFor="launchpad-language">Language</label>
                  <select
                    id="launchpad-language"
                    className="setup-input h-10"
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

        {!skipSiteScan ? (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
            <input
              className="mt-0.5 size-4 shrink-0 rounded border-strong bg-bg"
              type="checkbox"
              checked={crawlApproved}
              onChange={(event) => setCrawlApproved(event.target.checked)}
              aria-label="Allow Canonry to scan this public site."
              aria-describedby="local-crawl-note"
            />
            <span className="grid gap-0.5">
              <span className="text-sm leading-5 text-heading">Allow Canonry to scan this public site.</span>
              <span id="local-crawl-note" className="text-sm leading-5 text-secondary">
                The crawl runs on this Canonry instance, follows internal links, and stores its results locally.
              </span>
            </span>
          </label>
        ) : null}

        {visibleError ? (
          <div ref={errorRef} className="rounded-md border border-negative bg-negative-soft p-3" role="alert" tabIndex={-1}>
            <p className="text-sm font-medium text-heading">{visibleError}</p>
            {createConflict ? (
              <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={cancel}>View projects</Button>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-2">
          <Button
            className="h-11 w-full"
            type="submit"
            disabled={!identity || (!skipSiteScan && !crawlApproved) || !localeValid || busy}
          >
            {phase === 'creating' || phase === 'dispatching'
              ? <><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> {skipSiteScan ? 'Creating project…' : 'Mapping site…'}</>
              : skipSiteScan ? 'Create project' : 'Map site'}
          </Button>
          {phase === 'dispatching' ? <span className="text-center text-sm text-secondary" role="status">Opening Site Health when the scan is ready.</span> : null}
        </div>
      </form>

      <section className="mt-8 border-t border-default pt-6" aria-labelledby="agent-setup-title">
        <p id="agent-setup-title" className="text-sm font-medium text-heading">Use your agent instead</p>
        <p className="mt-1 text-sm leading-5 text-secondary">Copy a complete CLI setup request into any coding agent.</p>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="-ml-3" onClick={asyncHandler(copyAgentSetupRequest)}>
            {agentRequestCopied
              ? <Check className="size-3.5" aria-hidden="true" />
              : <Copy className="size-3.5" aria-hidden="true" />}
            <span aria-live="polite">
              {agentRequestCopied ? 'Copied setup request' : 'Copy setup request'}
            </span>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a href={AGENT_SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer">
              Agent quickstart
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
        </div>
      </section>

      {telemetryEnabled !== null ? (
        <section className="mt-6 border-t border-default pt-5" aria-labelledby="telemetry-title">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 py-2">
            <input
              className="mt-0.5 size-4 shrink-0 rounded border-strong bg-bg"
              type="checkbox"
              checked={telemetryEnabled}
              disabled={telemetryMutation.isPending}
              onChange={(event) => { void updateTelemetry(event.target.checked) }}
              aria-describedby="telemetry-detail"
            />
            <span className="grid gap-0.5">
              <span id="telemetry-title" className="text-sm leading-5 text-heading">Share anonymous product telemetry</span>
              <span id="telemetry-detail" className="max-w-[70ch] text-sm leading-5 text-secondary">
                Helps prioritize improvements. Canonry does not send raw domains, URLs, queries, answer content, or credentials.
              </span>
            </span>
          </label>
          {telemetryError ? <p className="mt-1 text-sm text-negative" role="alert">{telemetryError}</p> : null}
        </section>
      ) : null}
    </div>
  )
}

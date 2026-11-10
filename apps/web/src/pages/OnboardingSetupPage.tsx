import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, ChevronDown, LoaderCircle } from 'lucide-react'
import {
  getApiV1ProjectsOptions,
  getApiV1ProjectsQueryKey,
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
} from '../api.js'
import {
  ONBOARDING_FLOW_VERSION,
  SetupTrackStates,
  formatLocaleLabel,
  normalizeProjectName,
  suggestedBrandName,
} from '@canonry/canonry-contracts'
import { clearOnboardingDraft, readOnboardingDraft, writeOnboardingDraft } from '../lib/onboarding-draft.js'
import { asyncHandler } from '../lib/async-handler.js'
import { onboardingErrorReason } from '../lib/onboarding-telemetry.js'
import { useOnboardingTelemetry } from '../hooks/use-onboarding-telemetry.js'
import { AdminOnly } from '../components/shared/AccessControls.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { SetupTrackBadge, SetupTrackerList, SetupTrackerRow } from '../components/setup/SetupTracker.js'
import { Button } from '../components/ui/button.js'
import { SetupPage } from './SetupPage.js'
import { ProjectSetupTracker, type SetupTrackName } from './ProjectSetupTracker.js'

/** Compact for a mouse on a desktop; 44px tall for touch and narrow screens. */
const TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'
/**
 * Every website field, inputs and selects alike: the shared input style at
 * 40px, with 16px text on narrow screens so a phone does not zoom on focus.
 */
const LAUNCHPAD_FIELD = `setup-input h-10 w-full max-md:text-label-16 ${TOUCH_TARGET}`

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

/** Keep project creation on the locale values the website form explicitly supports. */
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

function onboardingError(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.statusCode === 409) {
    return 'A project with this name already exists. Change the project name, or open the existing project.'
  }
  return error instanceof Error && error.message ? error.message : fallback
}

function SetupLoading() {
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

function SetupRetry({ onRetry }: { onRetry: () => void }) {
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

/**
 * `/setup`. One setup tracker serves every context: the install's first setup,
 * adding a project, and an existing project's setup. `?experience=legacy` (or
 * the `legacy` onboarding mode) keeps the established wizard as a rescue path.
 */
export function OnboardingSetupPage() {
  const search = useSearch({ from: '/setup' })
  const legacy = search.experience === 'legacy'
    || (search.experience !== 'platform' && getOnboardingMode() === 'legacy')
  if (legacy) return <SetupPage visibilityProjectName={search.setupProject ?? search.project} />

  // `setupProject` and the `onboarding` frames are older first-run links; each
  // named a project, and every one of them was first-run setup.
  const projectName = search.project ?? search.setupProject
  if (projectName) {
    const track: SetupTrackName | undefined = search.track
      ?? (search.onboarding === 'site-health' ? 'agent-readiness' : undefined)
    return <ProjectSetupTracker key={projectName} projectName={projectName} firstRun={search.onboarding !== undefined} track={track} />
  }
  return <SetupEntry addProject={search.experience === 'platform'} />
}

/** A bare `/setup`: the first setup, the one project's setup, or adding a project. */
function SetupEntry({ addProject }: { addProject: boolean }) {
  const navigate = useNavigate()
  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    retry: false,
    // A cached list can predate a CLI or API creation; decide on a fresh read.
    refetchOnMount: 'always',
  })
  const fresh = projectsQuery.isSuccess && projectsQuery.isFetchedAfterMount
  // Decided once, on the first fresh read. A later refetch (the form refreshes
  // the list after a name conflict) must not swap the form for a redirect and
  // hide the conflict it is reporting.
  const [entry, setEntry] = useState<{ redirectTo: string } | { firstRun: boolean } | null>(null)
  useEffect(() => {
    if (entry || !fresh) return
    const projects = projectsQuery.data
    // The install's only project continues its own setup. An agent or the CLI
    // may have created it, and the tracker shows exactly where it stands.
    setEntry(!addProject && projects.length === 1 && projects[0]
      ? { redirectTo: projects[0].name }
      : { firstRun: projects.length === 0 })
  }, [addProject, entry, fresh, projectsQuery.data])
  useEffect(() => {
    if (!entry || !('redirectTo' in entry)) return
    void navigate({ to: '/setup', search: { project: entry.redirectTo, onboarding: 'first-run' }, replace: true })
  }, [entry, navigate])

  if (!entry && projectsQuery.isError) return <SetupRetry onRetry={() => { void projectsQuery.refetch() }} />
  if (!entry || 'redirectTo' in entry) return <SetupLoading />
  return <NewProjectSetup firstRun={entry.firstRun} />
}

function NewProjectSetup({ firstRun }: { firstRun: boolean }) {
  return (
    <AdminOnly title={firstRun ? 'Set up Canonry' : 'Add a project'}>
      <NewProjectSetupBody firstRun={firstRun} />
    </AdminOnly>
  )
}

/**
 * The tracker before its project exists: the Website row is the form, and the
 * two tracks below it say what setup leads to. Nothing runs from this page; each
 * track starts from its own button once the website is saved.
 */
function NewProjectSetupBody({ firstRun }: { firstRun: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Telemetry status is operator-only, and the server grants operator access
  // only to a key sent as a bearer header, never to a session cookie. Without
  // its own browser key this dashboard signs requests with the cookie, so the
  // read could only be refused.
  const telemetryReadable = firstRun && hasExplicitBrowserApiKey()
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
  const [creating, setCreating] = useState(false)
  /** Whether to say the website is invalid: only once the field is left or the form submitted, never mid-typing. */
  const [domainChecked, setDomainChecked] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  /** The project name a create collided with, normalized as the server compares names. */
  const [conflictName, setConflictName] = useState<string | null>(null)
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
    writeOnboardingDraft('platform', { domain, projectName, displayName, country, language })
  }, [domain, projectName, displayName, country, language])

  const resetDraft = () => {
    clearOnboardingDraft('platform')
    setDomain('')
    setProjectName('')
    setDisplayName('')
    setCountry('US')
    setLanguage('en')
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
  const localeLabel = formatLocaleLabel(country, language)
  const { countryValid, languageValid } = validateLaunchpadLocale(country, language)
  const localeValid = countryValid && languageValid
  const dirty = Boolean(domain || projectName || displayName || country !== 'US' || language !== 'en')
  const domainInvalid = Boolean(domain && !identity && domainChecked)

  useEffect(() => {
    if (!createError) return
    // A name collision is fixed in the Project name field, so open its section
    // and move there; the alert below still says why.
    if (conflictName !== null && projectNameRef.current) {
      if (projectDetailsRef.current) projectDetailsRef.current.open = true
      projectNameRef.current.focus()
      return
    }
    errorRef.current?.focus()
  }, [conflictName, createError])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDomainChecked(true)
    if (!identity || !localeValid || creating) return

    setCreating(true)
    setCreateError(null)
    setConflictName(null)
    try {
      const project = await createOnboardingProject({
        name: resolvedProjectName,
        displayName: resolvedDisplayName,
        canonicalDomain: identity.canonicalDomain,
        country,
        language,
      })
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
      // The tracker takes over on the same page: its two tracks start from their own buttons.
      await navigate({
        to: '/setup',
        search: { project: project.name, ...(firstRun ? { onboarding: 'first-run' as const } : {}) },
        replace: true,
      })
    } catch (error) {
      setCreating(false)
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
        void queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
        })
      }
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

  return (
    <div className="page-container max-w-3xl">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-heading-24 text-heading">{firstRun ? 'Set up Canonry' : 'Add a project'}</h1>
          {firstRun ? (
            <p className="mt-1 max-w-prose text-copy-14 text-secondary">
              Add your first website to get its Agent Readiness score and first AI Visibility result.
            </p>
          ) : null}
        </div>
        {firstRun ? (
          <Button asChild variant="ghost" className="shrink-0">
            <Link to="/agent-setup">
              <Bot className="size-4" aria-hidden="true" />
              Set up with an agent
            </Link>
          </Button>
        ) : null}
      </header>

      <SetupTrackerList label="Setup progress">
        <SetupTrackerRow
          id="setup-website"
          title="Website"
          mark="idle"
          trailing={<ToneBadge tone="neutral" className="shrink-0">Required</ToneBadge>}
        >
          <form aria-label="Website" className="space-y-5" onSubmit={asyncHandler(submit)} noValidate>
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
                aria-invalid={domainInvalid}
                aria-describedby={domainInvalid ? 'launchpad-domain-error' : undefined}
                placeholder="https://example.com"
                value={domain}
                onBlur={() => setDomainChecked(true)}
                onChange={(event) => {
                  setDomain(event.target.value)
                  setCreateError(null)
                  setConflictName(null)
                }}
              />
              {domainInvalid ? <p id="launchpad-domain-error" className="text-copy-14 text-negative" role="alert">Enter a public domain, such as example.com.</p> : null}
            </div>

            <div className="grid gap-2">
              <label className="text-label-14-strong text-heading" htmlFor="launchpad-display-name">Brand name</label>
              <input
                id="launchpad-display-name"
                className={LAUNCHPAD_FIELD}
                type="text"
                autoComplete="organization"
                aria-describedby="launchpad-display-name-hint"
                placeholder={identity?.displayName ?? 'Your brand'}
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
              />
              <p id="launchpad-display-name-hint" className="text-copy-13 text-secondary">Answers that name this brand count as mentions.</p>
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
                  <div className="grid gap-2 sm:max-w-[50%]">
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
                ) : null}

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
            </details>

            {createError ? (
              <div ref={errorRef} className="rounded-md border border-negative bg-negative-soft p-3" role="alert" tabIndex={-1}>
                <p id="launchpad-create-error" className="text-copy-14-strong text-heading">{createError}</p>
                {existingProjectName !== null ? (
                  <Button asChild variant="secondary" size="sm" className="mt-3">
                    <Link to="/projects/$projectName" params={{ projectName: existingProjectName }}>Open {existingProjectName}</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:[&>*]:w-full">
              {dirty ? <Button type="button" variant="ghost" disabled={creating} onClick={resetDraft}>Reset unsaved fields</Button> : null}
              {/* Adding a project can be abandoned; the first setup has nowhere else to go. Cancel drops the draft. */}
              {firstRun ? null : (
                <Button asChild variant="ghost" className={TOUCH_TARGET}>
                  <Link to="/projects" onClick={() => clearOnboardingDraft('platform')}>Cancel</Link>
                </Button>
              )}
              <Button className={TOUCH_TARGET} type="submit" disabled={!identity || !localeValid || creating}>
                {creating ? <><LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> Creating project…</> : 'Continue'}
              </Button>
            </div>
          </form>
        </SetupTrackerRow>
        <SetupTrackerRow
          id="setup-agent-readiness"
          title="Agent Readiness"
          mark="idle"
          summary="How well AI agents can read your site"
          trailing={<SetupTrackBadge state={SetupTrackStates.not_started} />}
        />
        <SetupTrackerRow
          id="setup-ai-visibility"
          title="AI Visibility"
          mark="idle"
          summary="Whether AI answers mention your brand and cite your site"
          trailing={<SetupTrackBadge state={SetupTrackStates.not_started} />}
        />
      </SetupTrackerList>

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

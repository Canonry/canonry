import { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiV1ProjectsOptions, getApiV1SettingsOptions } from '@canonry/canonry-api-client/react-query'
import { ONBOARDING_FLOW_VERSION, RunKinds, bucketOnboardingCount, formatLocaleLabel } from '@canonry/canonry-contracts'

import { fetchQueries, heyClient, isDashboardManagedSweeps, type ApiProject } from '../../api.js'
import { buildSettingsVm } from '../../build-dashboard.js'
import { useAccount } from '../../contexts/account-context.js'
import { useInitialDashboard } from '../../contexts/dashboard-context.js'
import { useOnboardingTelemetry } from '../../hooks/use-onboarding-telemetry.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { CHECKING_HEALTH_SNAPSHOT } from '../../lib/health-helpers.js'
import { readOnboardingDraft, writeOnboardingDraft } from '../../lib/onboarding-draft.js'
import { markOnboardingRunLaunched, onboardingErrorReason } from '../../lib/onboarding-telemetry.js'
import { useTriggerRun } from '../../queries/mutations.js'
import { useHealth } from '../../queries/use-health.js'
import type { HealthSnapshot, SettingsVm } from '../../view-models.js'
import { useRunPreview } from '../project/RunAdmissionNotice.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { Button } from '../ui/button.js'
import { AiEnginesSection, ChangeEngines } from './AiEnginesSection.js'
import { FirstCheckReview, ManagedFirstCheck, firstCheckHelp, previewUsesProviderAccount } from './FirstCheckReview.js'
import { SetupQueriesForm } from './SetupQueriesForm.js'
import { firstCheckReadiness, useAiEngineSetup } from './use-ai-engine-setup.js'
import { refreshSavedQueries, setupSavedQueriesKey, useSetupQueries } from './use-setup-queries.js'

/** The tracker's AI Visibility panel, one step at a time: connect an AI engine, add queries, review the check (the first, until the project has a baseline). */
export type SetupPanelStep = 'engine' | 'queries' | 'first-check'

const PANEL_STEPS: ReadonlyArray<{ id: SetupPanelStep; label: string }> = [
  { id: 'engine', label: 'AI engine' },
  { id: 'queries', label: 'Queries' },
  { id: 'first-check', label: 'First check' },
]

/** Where the panel stands: the current step named, steps already done checked. */
function PanelStepLine({ current, done, hasBaseline }: { current: SetupPanelStep; done: Readonly<Record<SetupPanelStep, boolean>>; hasBaseline: boolean }) {
  return (
    <ol aria-label="AI Visibility steps" className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-label-14 text-secondary">
      {PANEL_STEPS.map((step, index) => {
        const isCurrent = step.id === current
        const isDone = !isCurrent && done[step.id]
        return (
          <li key={step.id} aria-current={isCurrent ? 'step' : undefined} className={isCurrent ? 'inline-flex items-center gap-1.5 text-heading' : 'inline-flex items-center gap-1.5'}>
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            {isDone
              ? <Check className="size-3.5 text-positive" aria-hidden="true" />
              : <span className="tabular-nums" aria-hidden="true">{index + 1}</span>}
            {step.id === 'first-check' && hasBaseline ? 'Check' : step.label}
            {isDone ? <span className="sr-only">, done</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The panel's own reads: the project, from the project list the app shell
 * keeps fresh, an administrator's provider settings, and service health.
 * Saved queries, provider readiness and the run preview are read by the steps
 * that show them. An injected dashboard (tests, server rendering) stands in
 * for the project and settings reads, as it does on every page.
 */
function usePanelReads(projectName: string) {
  const injected = useInitialDashboard()
  const { isAdmin } = useAccount()
  const projectsQuery = useQuery({ ...getApiV1ProjectsOptions({ client: heyClient }), enabled: !injected })
  // Instance settings carry provider credentials, so only an administrator reads them.
  const settingsQuery = useQuery({ ...getApiV1SettingsOptions({ client: heyClient }), enabled: !injected && isAdmin })
  const healthQuery = useHealth(!injected, injected?.health)
  const readSettings = useMemo(() => buildSettingsVm(settingsQuery.data ?? null), [settingsQuery.data])
  const { refetch: refetchProjects } = projectsQuery
  const { refetch: refetchSettings } = settingsQuery
  return {
    project: injected
      ? injected.dashboard.projects.find(entry => entry.project.name === projectName)?.project ?? null
      : projectsQuery.data?.find(project => project.name === projectName) ?? null,
    settings: injected?.dashboard.settings ?? readSettings,
    health: healthQuery.data ?? injected?.health ?? CHECKING_HEALTH_SNAPSHOT,
    loading: !injected && (projectsQuery.isPending || (isAdmin && settingsQuery.isPending)),
    failed: !injected && projectsQuery.isError,
    /** Reads the project and provider settings again: after a save, and on Refresh connections. */
    refresh: async () => {
      await Promise.all([refetchProjects(), ...(isAdmin ? [refetchSettings()] : [])])
    },
  }
}

/**
 * The AI Visibility steps inside the setup tracker's AI Visibility row. The
 * tracker shows the check's progress and result from the server, so the panel
 * ends once the check is queued.
 */
export function AiVisibilitySetupPanel({ projectName, initialStep, hasBaseline = false, onClose, onLaunched }: {
  projectName: string
  /** Where the panel opens: the step that clears the server's blocker. */
  initialStep: SetupPanelStep
  /** The project already has a baseline (the setup read's `baselineRunId`), so this check is not its first. */
  hasBaseline?: boolean
  /** Back from the AI engine step: the tracker closes the panel. */
  onClose: () => void
  /** The check was queued. */
  onLaunched: (runId: string) => void
}) {
  const reads = usePanelReads(projectName)
  // Inside a tracker row, a page skeleton would draw a second page header.
  if (reads.loading) return <p role="status" className="text-copy-14 text-secondary">Loading AI engines and queries…</p>
  if (!reads.project) {
    return (
      <div role="alert" className="rounded-md border border-caution px-3 py-2">
        <p className="text-copy-14 text-primary">
          {reads.failed ? 'Canonry could not load the project list.' : <>Canonry could not find {projectName} in the project list.</>}
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => { void reads.refresh() }}>Retry</Button>
      </div>
    )
  }
  return (
    <PanelSteps
      key={projectName}
      project={reads.project}
      settings={reads.settings}
      health={reads.health}
      refresh={reads.refresh}
      initialStep={initialStep}
      hasBaseline={hasBaseline}
      onClose={onClose}
      onLaunched={onLaunched}
    />
  )
}

function PanelSteps({ project, settings, health, refresh, initialStep, hasBaseline, onClose, onLaunched }: {
  project: ApiProject
  settings: SettingsVm
  health: HealthSnapshot
  refresh: () => Promise<void>
  initialStep: SetupPanelStep
  hasBaseline: boolean
  onClose: () => void
  onLaunched: (runId: string) => void
}) {
  const projectName = project.name
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const telemetry = useOnboardingTelemetry('wizard')
  const savedQueriesQuery = useQuery({
    queryKey: setupSavedQueriesKey(projectName),
    queryFn: () => fetchQueries(projectName),
  })
  const savedQueries = savedQueriesQuery.data
  const savedQueryCount = savedQueries?.length ?? 0
  const savedText = (savedQueries ?? []).map(query => query.query).join('\n')
  const draftScope = `wizard:${projectName}`
  const [draft] = useState(() => readOnboardingDraft(draftScope))
  const [step, setStep] = useState<SetupPanelStep>(initialStep)
  // Saved queries fill the form once they load, unless an unsaved draft already did.
  const [resumeApplied, setResumeApplied] = useState(!savedQueriesQuery.isPending)
  const engines = useAiEngineSetup({ settings, project, projectScoped: true, refresh })
  const queries = useSetupQueries({
    projectName,
    initialText: draft.queriesText ?? savedText,
    initialSaved: draft.queriesText === undefined && savedQueryCount > 0,
    generateProviders: engines.runnableApiProviders,
    research: { projectName, domain: project.canonicalDomain },
    telemetry,
    refreshAfterSave: name => refreshSavedQueries(queryClient, name),
    onContinue: () => setStep('first-check'),
  })

  const { setText: setQueriesText, setSaved: setQueriesSaved } = queries
  useEffect(() => {
    if (resumeApplied || savedQueriesQuery.isPending) return
    if (savedQueries && savedQueries.length > 0 && draft.queriesText === undefined) {
      setQueriesText(savedQueries.map(query => query.query).join('\n'))
      setQueriesSaved(true)
    }
    setResumeApplied(true)
  }, [draft.queriesText, resumeApplied, savedQueries, savedQueriesQuery.isPending, setQueriesSaved, setQueriesText])

  useEffect(() => {
    if (!resumeApplied) return
    writeOnboardingDraft(draftScope, {
      ...(!queries.saved && queries.text !== savedText ? { queriesText: queries.text } : {}),
      // Competitors are the wizard's step: keep what it left unsaved.
      ...(draft.competitorsText === undefined ? {} : { competitorsText: draft.competitorsText }),
    })
  }, [draft.competitorsText, draftScope, queries.saved, queries.text, resumeApplied, savedText])

  const { emit, onboardingSessionId } = telemetry
  useEffect(() => {
    if (!resumeApplied) return
    emit({
      flowVersion: ONBOARDING_FLOW_VERSION,
      onboardingSessionId,
      event: 'onboarding.started',
      step: initialStep === 'first-check' ? 'run' : 'queries',
      resumed: true,
    }, 'onboarding.started')
  }, [emit, initialStep, onboardingSessionId, resumeApplied])

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
  const panelRef = useRef<HTMLDivElement>(null)
  const panelFocusPending = useRef(true)
  useEffect(() => {
    // The tracker replaces the button that opened this panel with the panel, so
    // focus left on nothing moves to the panel's first heading once it shows.
    // Focus the operator already moved elsewhere stays where it is.
    if (!panelFocusPending.current) return
    const active = document.activeElement
    if (active && active !== document.body) {
      panelFocusPending.current = false
      return
    }
    const heading = panelRef.current?.querySelector<HTMLElement>('h3')
    if (!heading) return
    panelFocusPending.current = false
    heading.tabIndex = -1
    heading.focus()
  })

  const managedSweeps = isDashboardManagedSweeps()
  const runPreview = useRunPreview(projectName, step === 'first-check' && !managedSweeps)
  const firstCheckUsesAccount = previewUsesProviderAccount(runPreview.data)
  const { systemBlockReason, blockedReason: readinessBlockedReason } = firstCheckReadiness(health, settings, engines)
  // Counted once the saved queries load; the server's preview gates the check meanwhile.
  const launchBlockedReason = readinessBlockedReason
    ?? (savedQueriesQuery.isSuccess && savedQueryCount === 0 ? 'Add at least one query before launching the first check.' : undefined)
  const triggerRunMutation = useTriggerRun()
  const [runSaving, setRunSaving] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const brandLabel = project.displayName || projectName

  const handleLaunchRun = async () => {
    if (managedSweeps) return
    if (runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true) return
    if (launchBlockedReason) {
      setRunError(launchBlockedReason)
      // Project-readable readiness is a boolean, not an inventory we can count.
      if (!engines.usesProjectProviderReadiness) {
        emit({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'rejected',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(savedQueryCount),
          reasonCode: systemBlockReason ?? (savedQueryCount === 0 ? 'no_queries' : 'run_rejected'),
        })
      }
      return
    }
    setRunSaving(true)
    setRunError(null)
    try {
      const run = await triggerRunMutation.mutateAsync({
        projectName,
        projectLabel: brandLabel,
        sourceAction: 'setup-launch',
        // The tracker's row shows the queued check.
        suppressQueuedToast: true,
      })
      markOnboardingRunLaunched(projectName, run.id, RunKinds['answer-visibility'])
      // The tracker's row shows the queued check from the server from here on.
      onLaunched(run.id)
      if (!engines.usesProjectProviderReadiness) {
        emit({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'queued',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(savedQueryCount),
        })
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to queue the AI Visibility check. Retry when the instance is ready.')
      if (!engines.usesProjectProviderReadiness) {
        emit({
          flowVersion: ONBOARDING_FLOW_VERSION,
          onboardingSessionId,
          event: 'run.requested',
          origin: 'dashboard_setup',
          result: 'rejected',
          providerCountBucket: bucketOnboardingCount(engines.runnableProviderCount),
          queryCountBucket: bucketOnboardingCount(savedQueryCount),
          reasonCode: onboardingErrorReason(err, 'run_rejected'),
        })
      }
    } finally {
      setRunSaving(false)
    }
  }

  // A provider form or OpenRouter's model picker carries the engine step's own primary action.
  const engineStepHasOwnAction = engines.isAdmin && (engines.providerFormVisible || engines.inlineModelPicker)
  // Queries were saved without an engine: the next step is to connect one.
  const needsEngine = engines.providerReadiness === false && !runError
  return (
    <div ref={panelRef}>
      <PanelStepLine current={step} done={{ engine: engines.providerReadiness === true, queries: savedQueryCount > 0, 'first-check': false }} hasBaseline={hasBaseline} />
      <div ref={stepContentRef}>
        {step === 'engine' ? (
          <div className="space-y-5">
            <AiEnginesSection engines={engines} headingLevel="h3" />
            <div className="setup-nav">
              <Button type="button" variant="outline" onClick={() => engines.providerGuard.request(onClose)}>Back</Button>
              {/* Queries can be saved before an engine is connected. */}
              <Button
                type="button"
                variant={engineStepHasOwnAction ? 'secondary' : 'default'}
                onClick={() => engines.providerGuard.request(() => {
                  engines.closeProviderForm()
                  setStep('queries')
                })}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : step === 'queries' ? (
          <div className="space-y-3" aria-labelledby="setup-queries-heading">
            <SetupQueriesForm
              queries={queries}
              headingLevel="h3"
              loading={savedQueriesQuery.isPending || !resumeApplied}
              loadFailed={savedQueriesQuery.isError}
              onRetryLoad={() => { void savedQueriesQuery.refetch() }}
              onBack={() => setStep('engine')}
              note={<p className="text-copy-13 text-secondary">Queries naming {brandLabel} are branded. Results keep branded and non-brand queries apart.</p>}
              saveVariant="default"
            />
          </div>
        ) : (
          <>
            <ChangeEngines engines={engines} />
            <div className="space-y-3">
              <div className="section-head">
                <div>
                  <div className="flex items-center gap-2"><h3 className="text-heading-16 text-heading">{managedSweeps ? 'AI Visibility' : hasBaseline ? 'Run an AI Visibility check' : 'Run your first AI Visibility check'}</h3>{managedSweeps ? null : <InfoTooltip text={firstCheckHelp(brandLabel, firstCheckUsesAccount)} />}</div>
                </div>
              </div>
              {managedSweeps ? (
                <ManagedFirstCheck
                  projectName={projectName}
                  error={runError}
                  actions={<><span /><Button type="button" onClick={() => { void navigate({ to: '/projects/$projectName', params: { projectName }, replace: true }) }}>Open project dashboard →</Button></>}
                />
              ) : (
                <FirstCheckReview
                  preview={runPreview}
                  details={[
                    { label: 'Website', value: project.canonicalDomain },
                    { label: 'Market', value: formatLocaleLabel(project.country, project.language) },
                  ]}
                  queries={savedQueries ?? []}
                  usesAccount={firstCheckUsesAccount}
                  // A missing engine is the AI engine step's job; the preview above already names it.
                  alert={needsEngine ? null : runError ?? launchBlockedReason ?? null}
                  actions={(
                    <>
                      <Button type="button" variant="outline" onClick={() => setStep('queries')}>Back</Button>
                      {needsEngine ? (
                        <Button type="button" onClick={() => setStep('engine')}>Connect an AI engine</Button>
                      ) : (
                        <Button
                          type="button"
                          disabled={runSaving || !!launchBlockedReason || runPreview.isError || runPreview.isFetching || runPreview.data?.canStart !== true}
                          title={launchBlockedReason}
                          onClick={asyncHandler(handleLaunchRun)}
                        >
                          {runSaving ? 'Starting…' : runError ? 'Retry check' : hasBaseline ? 'Run check' : 'Run first check'}
                        </Button>
                      )}
                    </>
                  )}
                />
              )}
            </div>
          </>
        )}
      </div>
      {engines.providerGuard.dialog}
    </div>
  )
}

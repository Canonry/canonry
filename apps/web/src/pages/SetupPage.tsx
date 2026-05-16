import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { addToast } from '../lib/toast-store.js'
import {
  createProject,
  setQueries,
  setCompetitors,
  fetchRunDetail,
  generateQueries as apiGenerateQueries,
  updateProviderConfig,
} from '../api.js'
import { useTriggerRun } from '../queries/mutations.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { buildSetupModel, serviceStatusTooltip } from '../lib/health-helpers.js'

const SETUP_STEPS = [
  { label: 'System check', description: 'Verify your instance is ready' },
  { label: 'Create project', description: 'Name, domain, and locale' },
  { label: 'Queries', description: 'Add queries to track' },
  { label: 'Competitors', description: 'Add competitor domains' },
  { label: 'Launch', description: 'Start your first visibility sweep' },
] as const

function SetupStepIndicator({ current, labels }: { current: number; labels: readonly { label: string }[] }) {
  return (
    <div className="setup-steps" role="list" aria-label="Setup progress">
      {labels.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <div key={s.label} className={`setup-step ${done ? 'setup-step-done' : ''} ${active ? 'setup-step-active' : ''}`} role="listitem" aria-current={active ? 'step' : undefined}>
            <span className="setup-step-number">{done ? '\u2713' : i + 1}</span>
            <span className="setup-step-label">{s.label}</span>
          </div>
        )
      })}
    </div>
  )
}

export function SetupPage() {
  const contextDashboard = useInitialDashboard()
  const { dashboard, isLoading, refetch } = useDashboard()
  const safeDashboard = dashboard ?? contextDashboard?.dashboard

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

  const settings = safeDashboard.settings

  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? { apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' }, workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' } }
  const model = buildSetupModel(safeDashboard.setup, healthSnapshot, settings)

  const navigate = useNavigate()

  const [step, setStep] = useState(0)

  const [projectName, setProjectName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [domain, setDomain] = useState('')
  const [country, setCountry] = useState('US')
  const [language, setLanguage] = useState('en')
  const [autoExtractBacklinks, setAutoExtractBacklinks] = useState(false)
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(null)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)

  const [queriesText, setQueriesText] = useState('')
  const [queriesSaved, setQueriesSaved] = useState(false)
  const [queriesError, setQueriesError] = useState<string | null>(null)
  const [queriesSaving, setQueriesSaving] = useState(false)

  const readyProviders = settings.providerStatuses.filter(p => p.state === 'ready')
  const [selectedProvider, setSelectedProvider] = useState(readyProviders[0]?.name ?? '')
  const [generateCount, setGenerateCount] = useState(5)
  const [generatingQueries, setGeneratingQueries] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [competitorsText, setCompetitorsText] = useState('')
  const [competitorsSaved, setCompetitorsSaved] = useState(false)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  const [runTriggered, setRunTriggered] = useState(false)
  const [runSaving, setRunSaving] = useState(false)
  const [launchedRunId, setLaunchedRunId] = useState<string | null>(null)
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
    queryKey: ['setup', 'launched-run', launchedRunId],
    queryFn: () => fetchRunDetail(launchedRunId!),
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

  const apiReady = model.healthChecks.some((c) => c.id === 'api' && c.state === 'ready')

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
      setCreatedProjectId(project.id)
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
      setStep(2)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Failed to create project')
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
      await refetch()
      setStep(3)
    } catch (err) {
      setQueriesError(err instanceof Error ? err.message : 'Failed to save queries')
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
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate queries')
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
      setStep(4)
    } catch (err) {
      setCompetitorsError(err instanceof Error ? err.message : 'Failed to save competitors')
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
      // Refetch dashboard so the health-check row flips to "Ready" and the
      // "Continue" button at the bottom of Step 1 becomes enabled.
      await refetch()
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : 'Failed to save Gemini key')
    } finally {
      setGeminiSaving(false)
    }
  }

  const handleLaunchRun = async () => {
    if (!createdProjectName) return
    setRunSaving(true)
    try {
      const run = await triggerRunMutation.mutateAsync({
        projectName: createdProjectName,
        projectLabel: displayName || projectName || createdProjectName,
        sourceAction: 'setup-launch',
      })
      setLaunchedRunId(run.id)
      setRunTriggered(true)
      await refetch()
    } catch {
      // Mutation hook surfaces the toast and error state.
    } finally {
      setRunSaving(false)
    }
  }

  const goBack = () => setStep((s) => Math.max(0, s - 1))

  const stepContent = (() => {
    switch (step) {
      case 0:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Step 1 of 5</p>
                <h2>System ready</h2>
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
                      <div className="mt-3 rounded-md border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-2">
                        <p className="text-xs text-zinc-400">
                          Paste a Gemini key to enable visibility checks (free at{' '}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noreferrer"
                            className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2"
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
                            className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none font-mono"
                            disabled={geminiSaving}
                          />
                          <Button
                            type="button"
                            size="sm"
                            disabled={geminiSaving || !geminiKey.trim()}
                            onClick={handleSaveGeminiKey}
                          >
                            {geminiSaving ? 'Saving...' : 'Save'}
                          </Button>
                        </div>
                        {geminiError && <p className="text-xs text-rose-400">{geminiError}</p>}
                        <p className="text-[11px] text-zinc-600">
                          Other providers (OpenAI, Claude, Perplexity) configurable later via{' '}
                          <Link to="/settings" className="text-zinc-500 hover:text-zinc-300 underline underline-offset-2">
                            /settings
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
              <span />
              <Button type="button" disabled={!apiReady} onClick={() => setStep(1)}>
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
                <p className="text-zinc-300">Project <span className="text-zinc-100 font-medium">{createdProjectName}</span> created successfully.</p>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" onClick={() => setStep(2)}>Continue</Button>
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
                <label className="flex items-start gap-3 rounded-md border border-zinc-800/60 bg-zinc-900/30 p-3 cursor-pointer hover:border-zinc-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-zinc-950"
                    checked={autoExtractBacklinks}
                    onChange={(e) => setAutoExtractBacklinks(e.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="block text-sm text-zinc-100">Auto-extract backlinks</span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      When a new Common Crawl release syncs, automatically extract backlinks for this project.{' '}
                      <Link to="/backlinks" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">
                        Manage backlinks
                      </Link>
                    </span>
                  </span>
                </label>
                {projectError ? <p className="text-rose-400 text-sm">{projectError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={!slug || !domain || projectSaving} onClick={handleCreateProject}>
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
                <p className="eyebrow eyebrow-soft">Step 3 of 5</p>
                <h2>Add queries</h2>
              </div>
              {queriesSaved ? (
                <ToneBadge tone="positive">{parsedQueries.length} saved</ToneBadge>
              ) : (
                <ToneBadge tone="neutral">{parsedQueries.length} quer{parsedQueries.length !== 1 ? 'ies' : 'y'}</ToneBadge>
              )}
            </div>
            <p className="supporting-copy">Enter the search queries you want to track. One per line.</p>
            {queriesSaved ? (
              <div className="compact-stack">
                <ul className="detail-list">
                  {parsedQueries.map((q) => <li key={q}>{q}</li>)}
                </ul>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" onClick={() => setStep(3)}>Continue</Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                {readyProviders.length > 0 ? (
                  <div className="compact-stack">
                    <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wide">
                      <span className="flex-1 border-t border-zinc-800" />
                      auto-generate
                      <span className="flex-1 border-t border-zinc-800" />
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
                          {readyProviders.map((p) => (
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
                        onClick={handleGenerateQueries}
                      >
                        {generatingQueries ? 'Analyzing site...' : 'Generate'}
                      </Button>
                    </div>
                    {generateError ? <p className="text-rose-400 text-sm">{generateError}</p> : null}
                  </div>
                ) : null}
                <div className="flex items-center gap-2 text-zinc-500 text-xs uppercase tracking-wide">
                  <span className="flex-1 border-t border-zinc-800" />
                  or type manually
                  <span className="flex-1 border-t border-zinc-800" />
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
                {queriesError ? <p className="text-rose-400 text-sm">{queriesError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={parsedQueries.length === 0 || queriesSaving} onClick={handleSaveQueries}>
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
                  <Button type="button" onClick={() => setStep(4)}>Continue</Button>
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
                {competitorsError ? <p className="text-rose-400 text-sm">{competitorsError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setStep(4)}>
                      Skip
                    </Button>
                    <Button type="button" disabled={parsedCompetitors.length === 0 || competitorsSaving} onClick={handleSaveCompetitors}>
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
        const terminal = run?.status === 'completed' || run?.status === 'partial' || run?.status === 'failed' || run?.status === 'cancelled'
        const snapshots = run?.snapshots ?? []
        const cited = snapshots.filter(s => s.citationState === 'cited').length
        const mentioned = snapshots.filter(s => s.answerMentioned === true).length
        const totalQueries = new Set(snapshots.map(s => s.query).filter((q): q is string => !!q)).size

        const stepBadge = !runTriggered
          ? null
          : terminal && (run?.status === 'completed' || run?.status === 'partial')
            ? <ToneBadge tone="positive">Complete</ToneBadge>
            : terminal
              ? <ToneBadge tone="negative">Failed</ToneBadge>
              : <ToneBadge tone="caution">Running</ToneBadge>

        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Step 5 of 5</p>
                <h2>Launch first run</h2>
              </div>
              {stepBadge}
            </div>
            {!runTriggered ? (
              <div className="compact-stack">
                <p className="supporting-copy">
                  Everything is configured. Launch an answer-visibility sweep to start tracking citations for <span className="text-zinc-100 font-medium">{createdProjectName}</span>.
                </p>
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={runSaving} onClick={handleLaunchRun}>
                    {runSaving ? 'Launching...' : 'Launch visibility sweep'}
                  </Button>
                </div>
              </div>
            ) : !terminal ? (
              <div className="compact-stack">
                <p className="text-zinc-300">
                  Sweep running — typically 30-60s. Polling every 2s…
                </p>
                <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 p-3 text-xs text-zinc-500">
                  <p>Status: <span className="text-zinc-300">{run?.status ?? 'queued'}</span></p>
                </div>
                <div className="setup-nav">
                  <span />
                  <Button type="button" variant="outline" onClick={() => navigate({ to: createdProjectId ? `/projects/${createdProjectId}` : '/' })}>
                    Watch on project page
                  </Button>
                </div>
              </div>
            ) : run?.status === 'failed' ? (
              <div className="compact-stack">
                <p className="text-rose-400">Sweep failed. Inspect the run on the project page for the provider error and retry from there.</p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => navigate({ to: createdProjectId ? `/projects/${createdProjectId}` : '/' })}>
                    Open project
                  </Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <p className="text-zinc-300">
                  Sweep complete. Your first answer-visibility snapshot for{' '}
                  <span className="text-zinc-100 font-medium">{createdProjectName}</span>:
                </p>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Mentioned</p>
                    <p className="text-2xl font-bold tabular-nums text-zinc-50 mt-1">{mentioned}<span className="text-zinc-600 text-lg"> / {totalQueries}</span></p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">queries with brand in answer</p>
                  </div>
                  <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Cited</p>
                    <p className="text-2xl font-bold tabular-nums text-zinc-50 mt-1">{cited}<span className="text-zinc-600 text-lg"> / {totalQueries}</span></p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">queries with domain in sources</p>
                  </div>
                  <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">Snapshots</p>
                    <p className="text-2xl font-bold tabular-nums text-zinc-50 mt-1">{snapshots.length}</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">total (query × provider)</p>
                  </div>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Full evidence, per-provider breakdown, and suggested next queries on the project dashboard.
                </p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => navigate({ to: createdProjectId ? `/projects/${createdProjectId}` : '/' })}>
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

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Setup</h1>
          <p className="page-subtitle">Create a project, add queries, add competitors, and launch the first run.</p>
        </div>
      </div>

      <SetupStepIndicator current={step} labels={SETUP_STEPS} />

      <section className="setup-wizard">
        {stepContent}
      </section>
    </div>
  )
}

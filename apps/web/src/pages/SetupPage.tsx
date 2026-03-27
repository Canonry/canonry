import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { addToast } from '../lib/toast-store.js'
import {
  createProject,
  setKeywords,
  setCompetitors,
  generateKeywords as apiGenerateKeywords,
} from '../api.js'
import { useTriggerRun } from '../queries/mutations.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { useHealth } from '../queries/use-health.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { buildSetupModel } from '../lib/health-helpers.js'

const SETUP_STEPS = [
  { label: 'System check', description: 'Verify your instance is ready' },
  { label: 'Create project', description: 'Name, domain, and locale' },
  { label: 'Key phrases', description: 'Add key phrases to track' },
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
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(null)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSaving, setProjectSaving] = useState(false)

  const [keywordsText, setKeywordsText] = useState('')
  const [keywordsSaved, setKeywordsSaved] = useState(false)
  const [keywordsError, setKeywordsError] = useState<string | null>(null)
  const [keywordsSaving, setKeywordsSaving] = useState(false)

  const readyProviders = settings.providerStatuses.filter(p => p.state === 'ready')
  const [selectedProvider, setSelectedProvider] = useState(readyProviders[0]?.name ?? '')
  const [generateCount, setGenerateCount] = useState(5)
  const [generatingKeywords, setGeneratingKeywords] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [competitorsText, setCompetitorsText] = useState('')
  const [competitorsSaved, setCompetitorsSaved] = useState(false)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  const [runTriggered, setRunTriggered] = useState(false)
  const [runSaving, setRunSaving] = useState(false)
  const triggerRunMutation = useTriggerRun()

  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const parsedKeywords = keywordsText.split('\n').map(k => k.trim()).filter(Boolean)
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
      void refetch()
      setStep(2)
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setProjectSaving(false)
    }
  }

  const handleSaveKeywords = async () => {
    if (!createdProjectName) return
    const keywords = parsedKeywords
    if (keywords.length === 0) return
    setKeywordsSaving(true)
    setKeywordsError(null)
    try {
      await setKeywords(createdProjectName, keywords)
      setKeywordsSaved(true)
      void refetch()
      setStep(3)
    } catch (err) {
      setKeywordsError(err instanceof Error ? err.message : 'Failed to save key phrases')
    } finally {
      setKeywordsSaving(false)
    }
  }

  const handleGenerateKeywords = async () => {
    if (!createdProjectName || !selectedProvider) return
    setGeneratingKeywords(true)
    setGenerateError(null)
    try {
      const result = await apiGenerateKeywords(createdProjectName, selectedProvider, generateCount)
      if (result.keywords.length > 0) {
        const newText = keywordsText
          ? keywordsText.trimEnd() + '\n' + result.keywords.join('\n')
          : result.keywords.join('\n')
        setKeywordsText(newText)
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate key phrases')
    } finally {
      setGeneratingKeywords(false)
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
      void refetch()
      setStep(4)
    } catch (err) {
      setCompetitorsError(err instanceof Error ? err.message : 'Failed to save competitors')
    } finally {
      setCompetitorsSaving(false)
    }
  }

  const handleLaunchRun = async () => {
    if (!createdProjectName) return
    setRunSaving(true)
    try {
      await triggerRunMutation.mutateAsync({
        projectName: createdProjectName,
        projectLabel: displayName || projectName || createdProjectName,
        sourceAction: 'setup-launch',
      })
      setRunTriggered(true)
      void refetch()
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
                      <Link
                        to="/settings"
                        className="text-emerald-400 hover:text-emerald-300 text-sm mt-1 underline underline-offset-2 cursor-pointer"
                      >
                        Configure providers
                      </Link>
                    )}
                  </div>
                  <ToneBadge tone={check.state === 'ready' ? 'positive' : 'caution'}>
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
                <h2>Add key phrases</h2>
              </div>
              {keywordsSaved ? (
                <ToneBadge tone="positive">{parsedKeywords.length} saved</ToneBadge>
              ) : (
                <ToneBadge tone="neutral">{parsedKeywords.length} key phrase{parsedKeywords.length !== 1 ? 's' : ''}</ToneBadge>
              )}
            </div>
            <p className="supporting-copy">Enter the search queries you want to track. One per line.</p>
            {keywordsSaved ? (
              <div className="compact-stack">
                <ul className="detail-list">
                  {parsedKeywords.map((kw) => <li key={kw}>{kw}</li>)}
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
                        disabled={generatingKeywords || !selectedProvider}
                        onClick={handleGenerateKeywords}
                      >
                        {generatingKeywords ? 'Analyzing site...' : 'Generate'}
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
                  <label className="setup-label" htmlFor="keywords">Key phrases (one per line)</label>
                  <textarea
                    id="keywords"
                    className="setup-textarea"
                    rows={6}
                    placeholder={'emergency dentist brooklyn\nbest invisalign downtown brooklyn\npediatric dentist brooklyn heights'}
                    value={keywordsText}
                    onChange={(e) => setKeywordsText(e.target.value)}
                  />
                </div>
                {keywordsError ? <p className="text-rose-400 text-sm">{keywordsError}</p> : null}
                <div className="setup-nav">
                  <Button type="button" variant="outline" onClick={goBack}>Back</Button>
                  <Button type="button" disabled={parsedKeywords.length === 0 || keywordsSaving} onClick={handleSaveKeywords}>
                    {keywordsSaving ? 'Saving...' : `Save ${parsedKeywords.length} key phrase${parsedKeywords.length !== 1 ? 's' : ''}`}
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
            <p className="supporting-copy">Domains that compete for the same key phrases. One per line.</p>
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

      case 4:
        return (
          <Card className="surface-card step-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Step 5 of 5</p>
                <h2>Launch first run</h2>
              </div>
              {runTriggered ? <ToneBadge tone="positive">Queued</ToneBadge> : null}
            </div>
            {runTriggered ? (
              <div className="compact-stack">
                <p className="text-zinc-300">Visibility sweep has been queued. View progress on the project page.</p>
                <div className="setup-nav">
                  <span />
                  <Button type="button" onClick={() => navigate({ to: createdProjectId ? `/projects/${createdProjectId}` : '/' })}>
                    Open project
                  </Button>
                </div>
              </div>
            ) : (
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
            )}
          </Card>
        )

      default:
        return null
    }
  })()

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Setup</h1>
          <p className="page-subtitle">Create a project, add key phrases, add competitors, and launch the first run.</p>
        </div>
      </div>

      <SetupStepIndicator current={step} labels={SETUP_STEPS} />

      <section className="setup-wizard">
        {stepContent}
      </section>
    </div>
  )
}

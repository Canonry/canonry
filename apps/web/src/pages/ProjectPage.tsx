import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, Download, Trash2 } from 'lucide-react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { CitationBadge } from '../components/shared/CitationBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ProviderBadge } from '../components/shared/ProviderBadge.js'
import { RunRow } from '../components/shared/RunRow.js'
import { ScoreGauge } from '../components/shared/ScoreGauge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { EvidenceTable } from '../components/project/EvidenceTable.js'
import { CompetitorTable } from '../components/project/CompetitorTable.js'
import { AnalyticsSection } from '../components/project/AnalyticsSection.js'
import { GscSection } from '../components/project/GscSection.js'
import { ProjectSettingsSection } from '../components/project/ProjectSettingsSection.js'
import { ScheduleSection } from '../components/project/ScheduleSection.js'
import { NotificationsSection } from '../components/project/NotificationsSection.js'
import {
  fetchExport,
  fetchTimeline,
  triggerRun as apiTriggerRun,
  deleteProject as apiDeleteProject,
  appendKeywords as apiAppendKeywords,
  fetchCompetitors as apiFetchCompetitors,
  setCompetitors as apiSetCompetitors,
  updateOwnedDomains as apiUpdateOwnedDomains,
  updateProject as apiUpdateProject,
} from '../api.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { useDrawer } from '../hooks/use-drawer.js'
import { findProjectVm, createDashboardFixture } from '../mock-data.js'
import type { ProjectCommandCenterVm, RunHistoryPoint } from '../view-models.js'

export type ProjectPageTab = 'overview' | 'search-console' | 'analytics'

const defaultFixture = createDashboardFixture()

function InsightSignals({
  insights,
}: {
  insights: ProjectCommandCenterVm['insights']
}) {
  const { openEvidence } = useDrawer()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="insight-list">
      {insights.map((insight) => {
        const isExpanded = expandedId === insight.id
        const hasAffected = insight.affectedPhrases.length > 0

        return (
          <div key={insight.id}>
            <div
              className={`insight-row insight-row-${insight.tone} ${hasAffected ? 'cursor-pointer' : ''}`}
              onClick={hasAffected ? () => setExpandedId(isExpanded ? null : insight.id) : undefined}
            >
              <div className="flex items-center gap-2 min-w-0">
                {hasAffected && (
                  <ChevronRight
                    size={12}
                    className={`shrink-0 text-zinc-500 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                  />
                )}
                <ToneBadge tone={insight.tone}>{insight.actionLabel}</ToneBadge>
                <span className="text-sm font-medium text-zinc-100 truncate">{insight.title}</span>
                <span className="hidden sm:inline text-xs text-zinc-500 truncate">{insight.detail}</span>
              </div>
              {hasAffected && (
                <span className="text-[11px] text-zinc-600 whitespace-nowrap">
                  {insight.affectedPhrases.length} phrase{insight.affectedPhrases.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
            {isExpanded && (
              <div className="divide-y divide-zinc-800/20">
                {insight.affectedPhrases.map((ap) => (
                  <div
                    key={ap.evidenceId}
                    className="flex items-center justify-between gap-3 px-4 py-2 pl-9 bg-zinc-900/40"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <CitationBadge state={ap.citationState} />
                      <span className="text-sm text-zinc-200 truncate">{ap.keyword}</span>
                      <div className="hidden sm:flex gap-1">
                        {ap.provider && <ProviderBadge provider={ap.provider} />}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-zinc-400 hover:text-zinc-200 whitespace-nowrap transition-colors"
                      onClick={(e) => { e.stopPropagation(); openEvidence(ap.evidenceId) }}
                    >
                      View &rarr;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ProjectPage({
  tab,
}: {
  tab: ProjectPageTab
}) {
  const { projectId } = useParams({ from: '/projects/$projectId' })
  const navigate = useNavigate()
  const { dashboard, refetch } = useDashboard()
  const safeDashboard = dashboard ?? defaultFixture.dashboard
  const model = findProjectVm(safeDashboard, projectId)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [runTriggering, setRunTriggering] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [addingKeywords, setAddingKeywords] = useState(false)
  const [newKeywordText, setNewKeywordText] = useState('')
  const [keywordSaving, setKeywordSaving] = useState(false)
  const [addingCompetitor, setAddingCompetitor] = useState(false)
  const [newCompetitorDomain, setNewCompetitorDomain] = useState('')
  const [competitorSaving, setCompetitorSaving] = useState(false)
  const [addingOwnedDomain, setAddingOwnedDomain] = useState(false)
  const [newOwnedDomain, setNewOwnedDomain] = useState('')
  const [ownedDomainSaving, setOwnedDomainSaving] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string | undefined>(undefined)
  const [compareLocations, setCompareLocations] = useState(false)
  const [locationTimeline, setLocationTimeline] = useState<import('../api.js').ApiTimelineEntry[] | null>(null)
  const [_locationTimelineLoading, setLocationTimelineLoading] = useState(false)

  const visibilityEvidence = model?.visibilityEvidence ?? []
  const projectName = model?.project.name ?? ''

  const locationLabelsInEvidence = useMemo(() => new Set(visibilityEvidence.map(e => e.location ?? '')), [visibilityEvidence])
  const hasNullLocationEvidence = locationLabelsInEvidence.has('')
  const distinctLocationsWithEvidence = useMemo(() => [...locationLabelsInEvidence].filter(Boolean), [locationLabelsInEvidence])

  useEffect(() => {
    if (locationFilter === undefined || locationFilter === '' || !projectName) {
      setLocationTimeline(null)
      setLocationTimelineLoading(false)
      return
    }
    setLocationTimelineLoading(true)
    fetchTimeline(projectName, locationFilter)
      .then(tl => { setLocationTimeline(tl); setLocationTimelineLoading(false) })
      .catch(() => { setLocationTimeline(null); setLocationTimelineLoading(false) })
  }, [locationFilter, projectName])

  // Build a runHistory override map keyed by keyword::provider from the location-scoped timeline
  const locationRunHistoryMap = useMemo<Map<string, RunHistoryPoint[]> | null>(() => {
    if (!locationTimeline) return null
    const map = new Map<string, RunHistoryPoint[]>()
    for (const entry of locationTimeline) {
      for (const [provider, runs] of Object.entries(entry.providerRuns ?? {})) {
        map.set(`${entry.keyword}::${provider}`, runs.map(r => ({
          runId: r.runId,
          citationState: r.citationState,
          createdAt: r.createdAt,
        })))
      }
      // Fallback: keyword-level history when no per-provider data
      if (!entry.providerRuns || Object.keys(entry.providerRuns).length === 0) {
        map.set(`${entry.keyword}::`, entry.runs.map(r => ({
          runId: r.runId,
          citationState: r.citationState,
          createdAt: r.createdAt,
        })))
      }
    }
    return map
  }, [locationTimeline])

  const filteredEvidence = useMemo(() => {
    const filtered = locationFilter !== undefined
      ? visibilityEvidence.filter(e => locationFilter === '' ? !e.location : e.location === locationFilter)
      : visibilityEvidence
    if (!locationRunHistoryMap) return filtered
    return filtered.map(item => {
      const history = locationRunHistoryMap.get(`${item.keyword}::${item.provider}`)
        ?? locationRunHistoryMap.get(`${item.keyword}::`)
      return history ? { ...item, runHistory: history } : item
    })
  }, [visibilityEvidence, locationFilter, locationRunHistoryMap])

  if (!model) {
    return (
      <div className="page-container">
        <Card className="surface-card empty-card">
          <h1>Project not found</h1>
          <p>Could not find a project with ID "{projectId}".</p>
          <Button asChild>
            <Link to="/">Return to overview</Link>
          </Button>
        </Card>
      </div>
    )
  }

  async function handleTriggerRun() {
    setRunTriggering(true)
    setRunError(null)
    try {
      await apiTriggerRun(projectName)
      void refetch()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to trigger run')
    } finally {
      setRunTriggering(false)
    }
  }

  async function handleDeleteProject() {
    setDeleting(true)
    try {
      await apiDeleteProject(projectName)
      navigate({ to: '/' })
      void refetch()
    } catch (err) {
      console.error('Failed to delete project:', err)
    } finally {
      setDeleting(false)
    }
  }

  async function handleExport() {
    const data = await fetchExport(projectName)
    const yaml = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}.yaml`
    a.click()
    // Blob URL is revoked asynchronously — a.click() returns void with no
    // completion signal, so revoking synchronously can break the download.
    // The blob is small and will be GC'd when the page unloads.

  }

  async function handleAddKeywords() {
    const keywords = newKeywordText.split('\n').map(k => k.trim()).filter(Boolean)
    if (keywords.length === 0) return
    setKeywordSaving(true)
    try {
      await apiAppendKeywords(projectName, keywords)
      void refetch()
      setNewKeywordText('')
      setAddingKeywords(false)
    } finally {
      setKeywordSaving(false)
    }
  }

  async function handleAddCompetitor() {
    const domain = newCompetitorDomain.trim()
    if (!domain) return
    setCompetitorSaving(true)
    try {
      const existing = await apiFetchCompetitors(projectName)
      const existingDomains = existing.map(c => c.domain)
      const merged = [...new Set([...existingDomains, domain])]
      await apiSetCompetitors(projectName, merged)
      void refetch()
      setNewCompetitorDomain('')
      setAddingCompetitor(false)
    } finally {
      setCompetitorSaving(false)
    }
  }

  async function handleAddOwnedDomain() {
    const domain = newOwnedDomain.trim()
    if (!domain) return
    setOwnedDomainSaving(true)
    try {
      const current = model?.project.ownedDomains ?? []
      await apiUpdateOwnedDomains(projectName, [...current, domain])
      void refetch()
      setNewOwnedDomain('')
      setAddingOwnedDomain(false)
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  async function handleRemoveOwnedDomain(domain: string) {
    setOwnedDomainSaving(true)
    try {
      const current = model?.project.ownedDomains ?? []
      await apiUpdateOwnedDomains(projectName, current.filter(d => d !== domain))
      void refetch()
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  async function handleUpdateProject(pName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) {
    await apiUpdateProject(pName, updates)
    void refetch()
  }

  const isNumericScore = (value: string) => !Number.isNaN(Number.parseInt(value, 10))
  const projectTabItems: Array<{ key: ProjectPageTab; label: string; href: string }> = [
    { key: 'overview', label: 'Overview', href: `/projects/${model.project.id}` },
    { key: 'search-console', label: 'Search Console', href: `/projects/${model.project.id}/search-console` },
    { key: 'analytics', label: 'Analytics', href: `/projects/${model.project.id}/analytics` },
  ]

  return (
    <div className="page-container">
      {showDeleteConfirm ? (
        <Card className="surface-card p-6 mb-6 border-rose-800/60">
          <h3 className="text-base font-semibold text-rose-400 mb-2">Delete project?</h3>
          <p className="text-sm text-zinc-400 mb-4">
            This will permanently delete <strong className="text-zinc-200">{model.project.displayName || model.project.name}</strong> and
            all its key phrases, competitors, runs, and snapshots. This cannot be undone.
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={handleDeleteProject}
            >
              {deleting ? 'Deleting...' : 'Yes, delete project'}
            </Button>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">{model.project.displayName || model.project.name}</h1>
          <p className="page-subtitle">
            {model.project.canonicalDomain}
            {(model.project.ownedDomains ?? []).length === 0 && !addingOwnedDomain && (
              <button
                type="button"
                className="ml-2 text-[10px] uppercase tracking-wide text-zinc-600 hover:text-zinc-400 transition-colors"
                onClick={() => setAddingOwnedDomain(true)}
              >+ add domain</button>
            )}
            {' '} · {model.contextLabel}
          </p>
          <div className="tag-row">
            <span className="tag">{model.project.country}</span>
            <span className="tag">{model.project.language.toUpperCase()}</span>
            {model.project.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
          {((model.project.ownedDomains ?? []).length > 0 || addingOwnedDomain) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Also tracking</span>
              {(model.project.ownedDomains ?? []).map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">
                  {d}
                  <button
                    type="button"
                    className="ml-0.5 text-zinc-500 hover:text-zinc-200 transition-colors"
                    disabled={ownedDomainSaving}
                    onClick={() => handleRemoveOwnedDomain(d)}
                    aria-label={`Remove ${d}`}
                  >×</button>
                </span>
              ))}
              {addingOwnedDomain ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-1.5 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none w-40"
                    type="text"
                    placeholder="docs.example.com"
                    value={newOwnedDomain}
                    onChange={(e) => setNewOwnedDomain(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddOwnedDomain()}
                    autoFocus
                  />
                  <Button type="button" size="sm" disabled={!newOwnedDomain.trim() || ownedDomainSaving} onClick={handleAddOwnedDomain}>
                    {ownedDomainSaving ? '...' : 'Add'}
                  </Button>
                  <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => { setAddingOwnedDomain(false); setNewOwnedDomain('') }}>Cancel</button>
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-dashed border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                  onClick={() => setAddingOwnedDomain(true)}
                >+ domain</button>
              )}
            </div>
          )}
        </div>
        <div className="page-header-right">
          <p className="text-sm text-zinc-500">{model.dateRangeLabel}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" onClick={handleExport} aria-label="Export project as YAML">
              <Download className="h-4 w-4 text-zinc-400" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => setShowDeleteConfirm(true)} aria-label="Delete project">
              <Trash2 className="h-4 w-4 text-zinc-400" />
            </Button>
            <Button
              type="button"
              disabled={runTriggering}
              onClick={handleTriggerRun}
            >
              {runTriggering ? 'Starting...' : 'Run now'}
            </Button>
          </div>
        </div>
      </div>

      {runError && (
        <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
          {runError}
          <button type="button" className="ml-2 text-rose-400 hover:text-rose-200" onClick={() => setRunError(null)}>×</button>
        </div>
      )}

      <nav className="project-subnav" aria-label="Project sections">
        {projectTabItems.map((item) => (
          <Link
            key={item.key}
            to={item.href}
            className={`project-subnav-link ${item.key === tab ? 'project-subnav-link-active' : ''}`}
            aria-current={item.key === tab ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {tab === 'overview' ? (
        <>
          {/* Score gauges */}
          <section className="gauge-row">
            <ScoreGauge
              value={model.visibilitySummary.value}
              label={model.visibilitySummary.label}
              delta={model.visibilitySummary.delta}
              tone={model.visibilitySummary.tone}
              description={model.visibilitySummary.description}
              tooltip={model.visibilitySummary.tooltip}
              isNumeric={isNumericScore(model.visibilitySummary.value)}
            />
            <ScoreGauge
              value={model.competitorPressure.value}
              label={model.competitorPressure.label}
              delta={model.competitorPressure.delta}
              tone={model.competitorPressure.tone}
              description={model.competitorPressure.description}
              tooltip={model.competitorPressure.tooltip}
              isNumeric={isNumericScore(model.competitorPressure.value)}
            />
            <ScoreGauge
              value={model.runStatus.value}
              label={model.runStatus.label}
              delta={model.runStatus.delta}
              tone={model.runStatus.tone}
              description={model.runStatus.description}
              tooltip={model.runStatus.tooltip}
              isNumeric={isNumericScore(model.runStatus.value)}
            />
          </section>

          {/* Per-provider visibility breakdown */}
          {model.providerScores.length > 1 && (
            <section className="page-section-divider">
              <div className="section-head section-head-inline">
                <div>
                  <p className="eyebrow eyebrow-soft">Model breakdown</p>
                  <h2>Visibility by model <InfoTooltip text="Per-model citation rate. Shows how often each AI model cites your domain across all tracked key phrases. Switching models can significantly affect citation rates." /></h2>
                </div>
              </div>
              <div className="evidence-table-wrap">
                <table className="evidence-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Score</th>
                      <th>Cited key phrases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.providerScores.map((ps) => (
                      <tr key={`${ps.provider}::${ps.model ?? 'unknown'}`}>
                        <td>
                          <div className="flex flex-col gap-0.5">
                            <ProviderBadge provider={ps.provider} />
                            {ps.model && <span className="text-[11px] font-mono text-zinc-500">{ps.model}</span>}
                          </div>
                        </td>
                        <td>
                          <span className={`font-semibold ${ps.score >= 70 ? 'text-emerald-400' : ps.score >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                            {ps.score}%
                          </span>
                        </td>
                        <td className="text-zinc-500">{ps.cited} of {ps.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Insights */}
          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">What changed</p>
                <h2>Citation signals</h2>
              </div>
            </div>
            <InsightSignals insights={model.insights} />
          </section>

          {/* Evidence table */}
          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Visibility evidence</p>
                <h2>Key phrase citation tracking</h2>
              </div>
              <div className="flex items-center gap-3">
                <p className="supporting-copy">{new Set(model.visibilityEvidence.map(e => e.keyword)).size} key phrases tracked</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setAddingKeywords(!addingKeywords)}>
                  {addingKeywords ? 'Cancel' : '+ Add key phrases'}
                </Button>
              </div>
            </div>
            {addingKeywords && (
              <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <textarea
                  className="w-full resize-none rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  rows={3}
                  placeholder="Enter key phrases, one per line"
                  value={newKeywordText}
                  onChange={(e) => setNewKeywordText(e.target.value)}
                />
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-zinc-500">{newKeywordText.split('\n').filter(k => k.trim()).length} key phrases</p>
                  <Button type="button" size="sm" disabled={!newKeywordText.trim() || keywordSaving} onClick={handleAddKeywords}>
                    {keywordSaving ? 'Adding...' : 'Add key phrases'}
                  </Button>
                </div>
              </div>
            )}
            {model.project.locations && model.project.locations.length > 0 && (
              <div className="filter-row mb-3" role="toolbar" aria-label="Location filters">
                <button
                  className={`filter-chip ${locationFilter === undefined ? 'filter-chip-active' : ''}`}
                  type="button"
                  aria-pressed={locationFilter === undefined}
                  onClick={() => { setLocationFilter(undefined) }}
                >
                  All locations
                </button>
                {model.project.locations.map((loc: { label: string }) => (
                  locationLabelsInEvidence.has(loc.label) && (
                    <button
                      key={loc.label}
                      className={`filter-chip ${locationFilter === loc.label ? 'filter-chip-active' : ''}`}
                      type="button"
                      aria-pressed={locationFilter === loc.label}
                      onClick={() => { setLocationFilter(loc.label); setCompareLocations(false) }}
                    >
                      {loc.label}
                    </button>
                  )
                ))}
                {hasNullLocationEvidence && (
                  <button
                    className={`filter-chip ${locationFilter === '' ? 'filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={locationFilter === ''}
                    onClick={() => { setLocationFilter(''); setCompareLocations(false) }}
                  >
                    No location
                  </button>
                )}
                {distinctLocationsWithEvidence.length > 1 && locationFilter === undefined && (
                  <button
                    className={`filter-chip filter-chip-compare ${compareLocations ? 'filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={compareLocations}
                    onClick={() => setCompareLocations(v => !v)}
                    title="Side-by-side location comparison"
                  >
                    Compare
                  </button>
                )}
              </div>
            )}
            <EvidenceTable
              evidence={filteredEvidence}
            />
          </section>

          {/* Competitor table */}
          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Competitors</p>
                <h2>Competitive landscape</h2>
              </div>
              <div className="flex items-center gap-3">
                <p className="supporting-copy">{model.competitors.length} tracked</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setAddingCompetitor(!addingCompetitor)}>
                  {addingCompetitor ? 'Cancel' : '+ Add competitor'}
                </Button>
              </div>
            </div>
            {addingCompetitor && (
              <div className="mb-3 flex gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <input
                  className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  type="text"
                  placeholder="competitor.com"
                  value={newCompetitorDomain}
                  onChange={(e) => setNewCompetitorDomain(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddCompetitor()}
                />
                <Button type="button" size="sm" disabled={!newCompetitorDomain.trim() || competitorSaving} onClick={handleAddCompetitor}>
                  {competitorSaving ? 'Adding...' : 'Add'}
                </Button>
              </div>
            )}
            <CompetitorTable competitors={model.competitors} />
          </section>

          {/* Run timeline */}
          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Run timeline</p>
                <h2>Recent execution history</h2>
              </div>
            </div>
            <div className="run-list">
              {model.recentRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </section>

          <ProjectSettingsSection project={{ ...model.project, displayName: model.project.displayName ?? model.project.name, defaultLocation: model.project.defaultLocation ?? null }} onUpdateProject={handleUpdateProject} onRefresh={() => void refetch()} />
          <ScheduleSection projectName={model.project.name} />
          <NotificationsSection projectName={model.project.name} />
        </>
      ) : tab === 'analytics' ? (
        <AnalyticsSection projectName={model.project.name} />
      ) : (
        <GscSection projectName={model.project.name} />
      )}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  ChevronRight,
  Github,
  Globe,
  LayoutDashboard,
  Menu,
  Play,
  Rocket,
  Settings,
  X,
} from 'lucide-react'

import { formatErrorLog } from './lib/format-helpers.js'
import { fetchAllRuns, fetchProjects, type ApiProject, type ApiRun } from './api.js'
import { addToast, type ToastTone } from './lib/toast-store.js'
import {
  getRunTrackerState,
  isTerminalRunStatus,
  removeTrackedBatch,
  removeTrackedRun,
  subscribeRunTracker,
  summarizeBatchStatuses,
} from './lib/run-tracker-store.js'

import { Button } from './components/ui/button.js'
import { Badge } from './components/ui/badge.js'
import { BrandLockup } from './components/shared/BrandLockup.js'
import { ProviderBadge } from './components/shared/ProviderBadge.js'
import { StatusBadge } from './components/shared/StatusBadge.js'
import { Drawer } from './components/layout/Drawer.js'
import { EvidenceDetailModal } from './components/layout/EvidenceDetailModal.js'
import { findEvidenceById, findRunById } from './mock-data.js'
import { useDashboard } from './queries/use-dashboard.js'
import { useHealth } from './queries/use-health.js'
import { useRunDetail } from './queries/use-run-detail.js'
import { useDrawer } from './hooks/use-drawer.js'
import { useInitialDashboard } from './contexts/dashboard-context.js'
import { Toaster } from './components/layout/Toaster.js'
import { queryKeys } from './queries/query-keys.js'
import type {
  HealthSnapshot,
  ServiceStatus,
} from './view-models.js'

import { Outlet, Link, useLocation } from '@tanstack/react-router'

const docs = [
  { label: 'Architecture', href: 'https://github.com/AINYC/canonry/blob/main/docs/architecture.md' },
  { label: 'Testing Guide', href: 'https://github.com/AINYC/canonry/blob/main/docs/testing.md' },
]

const checkingStatus = (label: string): ServiceStatus => ({
  label,
  state: 'checking',
  detail: 'Checking service health',
})

const defaultHealthSnapshot: HealthSnapshot = {
  apiStatus: checkingStatus('API'),
  workerStatus: checkingStatus('Worker'),
}

function formatTrackedRunKind(kind: string) {
  if (kind === 'gsc-sync') return 'GSC sync'
  if (kind === 'inspect-sitemap') return 'Sitemap inspection'
  return 'Visibility sweep'
}

function terminalToneForRun(status: string): ToastTone {
  if (status === 'completed') return 'positive'
  if (status === 'partial') return 'caution'
  return 'negative'
}

function terminalTitleForRun(run: ApiRun) {
  const kindLabel = formatTrackedRunKind(run.kind)
  if (run.status === 'completed') return `${kindLabel} completed`
  if (run.status === 'partial') return `${kindLabel} completed with partial results`
  if (run.status === 'cancelled') return `${kindLabel} cancelled`
  return `${kindLabel} failed`
}

function terminalDetailForRun(run: ApiRun, projectLabel: string) {
  if (run.error) {
    return `${projectLabel}: ${run.error}`
  }
  if (run.location) {
    return `${projectLabel} · ${run.location}`
  }
  return projectLabel
}

function resolveProjectLabel(projectId: string, trackedLabel: string | undefined, projects: ApiProject[]) {
  if (trackedLabel) return trackedLabel
  const project = projects.find((candidate) => candidate.id === projectId)
  return project?.displayName || project?.name || projectId
}

function batchDetail(summary: ReturnType<typeof summarizeBatchStatuses>, skippedCount: number) {
  const parts = [
    summary.completed > 0 ? `${summary.completed} completed` : null,
    summary.partial > 0 ? `${summary.partial} partial` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.cancelled > 0 ? `${summary.cancelled} cancelled` : null,
    skippedCount > 0 ? `${skippedCount} skipped at queue time` : null,
  ].filter(Boolean)

  return parts.join(', ')
}

function batchTone(summary: ReturnType<typeof summarizeBatchStatuses>): ToastTone {
  if (summary.failed > 0 || summary.cancelled > 0) return 'negative'
  if (summary.partial > 0) return 'caution'
  return 'positive'
}

export function RunNotificationObserver() {
  const trackedState = useSyncExternalStore(subscribeRunTracker, getRunTrackerState, getRunTrackerState)
  const hasPendingTracking = Object.keys(trackedState.runs).length > 0 || Object.keys(trackedState.batches).length > 0
  const runsQuery = useQuery({
    queryKey: queryKeys.runs.all,
    queryFn: fetchAllRuns,
    // Keep notification polling live whenever this browser session is tracking runs,
    // even if the app was bootstrapped with initial dashboard context.
    enabled: hasPendingTracking,
  })
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    enabled: hasPendingTracking,
  })
  const prevStatusesRef = useRef<Record<string, string>>({})
  const refetchRuns = useCallback(() => {
    void runsQuery.refetch()
  }, [runsQuery.refetch])

  useEffect(() => {
    if (!hasPendingTracking) return
    refetchRuns()
  }, [hasPendingTracking, refetchRuns])

  useEffect(() => {
    if (!hasPendingTracking || typeof window === 'undefined') return

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetchRuns()
      }
    }

    window.addEventListener('focus', refetchRuns)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', refetchRuns)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [hasPendingTracking, refetchRuns])

  useEffect(() => {
    const runs = runsQuery.data ?? []
    const projects = projectsQuery.data ?? []
    const runsById = Object.fromEntries(runs.map((run) => [run.id, run]))
    const nextStatuses = Object.fromEntries(runs.map((run) => [run.id, run.status]))

    for (const trackedRun of Object.values(trackedState.runs)) {
      const run = runsById[trackedRun.runId]
      if (!run || !isTerminalRunStatus(run.status)) continue

      const previousStatus = prevStatusesRef.current[run.id] ?? trackedRun.lastAnnouncedStatus
      if (previousStatus === run.status) continue

      if (trackedRun.sourceAction === 'run-all') {
        removeTrackedRun(run.id)
        continue
      }

      const projectLabel = resolveProjectLabel(run.projectId, trackedRun.projectLabel, projects)
      addToast({
        title: terminalTitleForRun(run),
        detail: terminalDetailForRun(run, projectLabel),
        tone: terminalToneForRun(run.status),
        dedupeKey: `run:${run.id}`,
        dedupeMode: 'replace',
        cta: {
          label: 'View run',
          intent: 'open-run-drawer',
          runId: run.id,
        },
      })
      removeTrackedRun(run.id)
    }

    for (const batch of Object.values(trackedState.batches)) {
      const summary = summarizeBatchStatuses(batch.runIds, runsById)
      if (!summary.finished) continue

      addToast({
        title: 'Run-all batch finished',
        detail: batchDetail(summary, batch.skippedCount),
        tone: batchTone(summary),
        dedupeKey: `batch:${batch.batchId}`,
        dedupeMode: 'replace',
        cta: {
          label: 'View runs',
          intent: 'go-to-runs',
        },
      })
      removeTrackedBatch(batch.batchId)
    }

    prevStatusesRef.current = nextStatuses
  }, [projectsQuery.data, runsQuery.data, trackedState])

  return null
}

/* ────────────────────────────────────────────
   Root layout — renders the shell + <Outlet />
   ──────────────────────────────────────────── */

export function RootLayout() {
  // ── Context-based initial data (tests inject via DashboardProvider) ──
  const contextDashboard = useInitialDashboard()

  // ── Data fetching via TanStack Query ──
  const { dashboard, isLoading, refetch: refreshData } = useDashboard()
  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? defaultHealthSnapshot

  // ── Router state ──
  const location = useLocation()
  const { runId, evidenceId, closeDrawer } = useDrawer()

  // ── UI state ──
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // ── Run detail for drawer ──
  const runDetailQuery = useRunDetail(runId)
  const runDetail = runDetailQuery.data ?? null
  const runDetailLoading = runDetailQuery.isLoading

  // When run finishes, refresh dashboard data
  useEffect(() => {
    if (!runDetail) return
    if (runDetail.status !== 'running' && runDetail.status !== 'queued') {
      void refreshData()
    }
  }, [runDetail?.status, refreshData])

  // Close mobile nav on navigation
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  // Escape key closes drawer
  useEffect(() => {
    if (typeof window === 'undefined' || (!runId && !evidenceId)) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawer()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [runId, evidenceId, closeDrawer])

  // While loading or dashboard not yet available, use context data or null (no mock fallback)
  const safeDashboard = dashboard ?? contextDashboard?.dashboard ?? null

  const selectedRun = runId && safeDashboard ? findRunById(safeDashboard, runId) : undefined
  const selectedEvidenceContext = evidenceId && safeDashboard ? findEvidenceById(safeDashboard, evidenceId) : undefined

  // Derive breadcrumb label from current location
  const breadcrumbLabel = (() => {
    const path = location.pathname
    if (path === '/') return 'Portfolio'
    if (path === '/projects') return 'Projects'
    if (path === '/runs') return 'Runs'
    if (path === '/settings') return 'Settings'
    if (path === '/setup') return 'Setup'
    if (path.startsWith('/projects/')) {
      // Try to find project name
      const segments = path.split('/').filter(Boolean)
      const projectId = segments[1]
      if (projectId && safeDashboard) {
        const projectVm = safeDashboard.projects.find(p => p.project.id === projectId)
        if (projectVm) return projectVm.project.name
      }
      return 'Project'
    }
    return 'Not found'
  })()

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      {/* ── Sidebar (desktop) ── */}
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="sidebar-brand">
          <BrandLockup />
        </div>

        <nav className="sidebar-nav">
          <Link
            to="/"
            className="sidebar-link"
            activeProps={{ className: 'sidebar-link sidebar-link-active' }}
            activeOptions={{ exact: true }}
          >
            <LayoutDashboard className="sidebar-icon" />
            <span>Overview</span>
          </Link>
          <Link
            to="/projects"
            className="sidebar-link"
            activeProps={{ className: 'sidebar-link sidebar-link-active' }}
            activeOptions={{ exact: false }}
          >
            <Globe className="sidebar-icon" />
            <span>Projects</span>
          </Link>
          <Link
            to="/runs"
            className="sidebar-link"
            activeProps={{ className: 'sidebar-link sidebar-link-active' }}
            activeOptions={{ exact: true }}
          >
            <Play className="sidebar-icon" />
            <span>Runs</span>
          </Link>
          <Link
            to="/settings"
            className="sidebar-link"
            activeProps={{ className: 'sidebar-link sidebar-link-active' }}
            activeOptions={{ exact: true }}
          >
            <Settings className="sidebar-icon" />
            <span>Settings</span>
          </Link>

          {isLoading ? (
            <>
              <p className="sidebar-section-title">Projects</p>
              {[1, 2, 3].map((i) => (
                <div key={i} className="sidebar-skeleton-item">
                  <span className="skeleton-circle size-2" />
                  <span className="skeleton-text flex-1" style={{ width: `${50 + i * 15}%` }} />
                </div>
              ))}
            </>
          ) : safeDashboard && safeDashboard.projects.length > 0 ? (
            <>
              <p className="sidebar-section-title">Projects</p>
              {safeDashboard.projects.map((projectVm) => {
                const visibilityTone = projectVm.visibilitySummary.tone
                return (
                  <Link
                    key={projectVm.project.id}
                    to="/projects/$projectId"
                    params={{ projectId: projectVm.project.id }}
                    className="sidebar-project"
                    activeProps={{ className: 'sidebar-project sidebar-project-active' }}
                  >
                    <span className={`sidebar-dot sidebar-dot-${visibilityTone}`} />
                    <span>{projectVm.project.name}</span>
                  </Link>
                )
              })}
            </>
          ) : !isLoading ? (
            <>
              <p className="sidebar-section-title">Resources</p>
              <Link
                to="/setup"
                className="sidebar-link"
                activeProps={{ className: 'sidebar-link sidebar-link-active' }}
                activeOptions={{ exact: true }}
              >
                <Rocket className="sidebar-icon" />
                <span>Setup</span>
              </Link>
            </>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          {docs.map((doc) => (
            <a key={doc.href} className="sidebar-footer-link" href={doc.href} target="_blank" rel="noopener noreferrer">
              {doc.label}
            </a>
          ))}
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="main-area">
        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-brand-mobile">
              <BrandLockup compact />
            </div>
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <Link to="/">
                Home
              </Link>
              <ChevronRight className="breadcrumb-sep size-3" />
              <span className="breadcrumb-current">{breadcrumbLabel}</span>
            </nav>
          </div>

          <div className="topbar-actions">
            <div className="health-pill-row">
              <span className={`health-pill health-pill-${healthSnapshot.apiStatus.state}`}>
                API {healthSnapshot.apiStatus.state === 'ok' ? 'ok' : healthSnapshot.apiStatus.state}
              </span>
              <span className={`health-pill health-pill-${healthSnapshot.workerStatus.state}`}>
                Worker {healthSnapshot.workerStatus.state === 'ok' ? 'ok' : healthSnapshot.workerStatus.state}
              </span>
            </div>
            <Button
              className="nav-toggle"
              variant="secondary"
              size="icon"
              type="button"
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav"
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <Menu className="size-4" />
              <span className="sr-only">Open navigation</span>
            </Button>
          </div>
        </header>

        {/* Mobile nav overlay */}
        <div id="mobile-nav" className={`mobile-nav ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
          <Button
            className="mobile-nav-close"
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => setMobileNavOpen(false)}
          >
            <X className="size-5" />
            <span className="sr-only">Close navigation</span>
          </Button>
          <Link to="/" className="mobile-nav-link" activeProps={{ className: 'mobile-nav-link mobile-nav-link-active' }} activeOptions={{ exact: true }}>
            Overview
          </Link>
          <Link to="/projects" className="mobile-nav-link" activeProps={{ className: 'mobile-nav-link mobile-nav-link-active' }} activeOptions={{ exact: false }}>
            Projects
          </Link>
          <Link to="/runs" className="mobile-nav-link" activeProps={{ className: 'mobile-nav-link mobile-nav-link-active' }} activeOptions={{ exact: true }}>
            Runs
          </Link>
          <Link to="/settings" className="mobile-nav-link" activeProps={{ className: 'mobile-nav-link mobile-nav-link-active' }} activeOptions={{ exact: true }}>
            Settings
          </Link>
          {safeDashboard && safeDashboard.projects.length > 0 ? (
            <div className="mobile-nav-section">
              <p className="mobile-nav-section-title">Projects</p>
              {safeDashboard.projects.map((projectVm) => (
                <Link
                  key={projectVm.project.id}
                  to="/projects/$projectId"
                  params={{ projectId: projectVm.project.id }}
                  className="mobile-nav-link"
                >
                  {projectVm.project.name}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        {/* Page content */}
        <main id="content" className="page-shell">
          {isLoading && !contextDashboard ? (
            <div className="page-skeleton">
              <div className="page-skeleton-header">
                <div className="skeleton-text h-6 w-40" />
                <div className="skeleton-text-sm w-72" />
              </div>
              <div className="page-skeleton-grid">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="page-skeleton-card">
                    <div className="skeleton-text w-24" />
                    <div className="skeleton-text w-full" />
                    <div className="skeleton-text-sm w-3/4" />
                  </div>
                ))}
              </div>
              <div className="page-skeleton-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                {[1, 2].map((i) => (
                  <div key={i} className="page-skeleton-card">
                    <div className="skeleton-text w-20" />
                    <div className="space-y-2">
                      {[1, 2, 3].map((j) => (
                        <div key={j} className="skeleton-text-sm w-full" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Outlet />
          )}
        </main>

        <footer className="footer">
          <a href="https://github.com/AINYC/canonry" target="_blank" rel="noopener noreferrer" className="footer-brand">
            <Github className="size-3.5" />
            <span>Canonry</span>
          </a>
          <div className="footer-links">
            {docs.map((doc) => (
              <a key={doc.href} href={doc.href} target="_blank" rel="noopener noreferrer">
                {doc.label}
              </a>
            ))}
          </div>
        </footer>
      </div>

      {/* ── Drawers ── */}
      {selectedRun ? (
        <Drawer
          open={selectedRun !== undefined}
          title={selectedRun.summary}
          subtitle={`${selectedRun.projectName} \u00b7 ${selectedRun.kindLabel}`}
          onClose={closeDrawer}
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <StatusBadge status={selectedRun.status} />
            <span className="text-zinc-400">{selectedRun.startedAt}</span>
            <span className="text-zinc-500">{selectedRun.duration}</span>
            <span className="text-zinc-600">{selectedRun.triggerLabel}</span>
          </div>
          {selectedRun.status === 'failed' && selectedRun.statusDetail && (
            <p className="text-sm text-rose-300/80 mt-2">{selectedRun.statusDetail}</p>
          )}

          {/* Run activity log */}
          <div className="mt-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Activity Log</p>
            {runDetailLoading ? (
              <p className="text-sm text-zinc-500">Loading run details...</p>
            ) : runDetail && runDetail.snapshots.length > 0 ? (
              <div className="space-y-2">
                {runDetail.snapshots.map((snap) => (
                  <div key={snap.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-sm font-medium text-zinc-200 truncate">{snap.keyword ?? 'Unknown key phrase'}</p>
                      <div className="flex items-center gap-1.5">
                        <ProviderBadge provider={snap.provider} />
                        <Badge variant={snap.citationState === 'cited' ? 'success' : 'neutral'}>
                          {snap.citationState}
                        </Badge>
                      </div>
                    </div>
                    {snap.model && (
                      <p className="text-[11px] text-zinc-500 font-mono">{snap.model}</p>
                    )}
                    {snap.citedDomains.length > 0 && (
                      <p className="text-xs text-zinc-500 mt-1">
                        <span className="text-zinc-400">Sources:</span> {snap.citedDomains.join(', ')}
                      </p>
                    )}
                    {snap.competitorOverlap.length > 0 && (
                      <p className="text-xs text-rose-400/80 mt-0.5">
                        Competitor cited: {snap.competitorOverlap.join(', ')}
                      </p>
                    )}
                    {snap.groundingSources && snap.groundingSources.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">
                          {snap.groundingSources.length} grounding source{snap.groundingSources.length !== 1 ? 's' : ''}
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {snap.groundingSources.map((src: { uri: string; title: string }, i: number) => (
                            <li key={i} className="text-xs text-zinc-500 truncate">
                              <a href={src.uri} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300">{src.title || src.uri}</a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {snap.answerText && (
                      <details className="mt-1">
                        <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-400">Answer preview</summary>
                        <p className="mt-1 text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">{snap.answerText}</p>
                      </details>
                    )}
                  </div>
                ))}
                {runDetail.status === 'running' && (
                  <div className="flex items-center gap-2 p-3 text-sm text-zinc-500">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    Querying remaining key phrases...
                  </div>
                )}
              </div>
            ) : runDetail && runDetail.status === 'running' ? (
              <div className="flex items-center gap-2 p-3 text-sm text-zinc-500">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                Waiting for first key phrase result...
              </div>
            ) : runDetail && runDetail.status === 'queued' ? (
              <div className="flex items-center gap-2 p-3 text-sm text-zinc-500">
                <span className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-pulse" />
                Run queued, waiting for execution slot...
              </div>
            ) : runDetail && runDetail.error ? (
              <div className="rounded-lg border border-rose-800/40 bg-rose-950/20 p-3">
                <p className="text-sm font-medium text-rose-300 mb-2">Run failed</p>
                <pre className="text-xs text-rose-300/80 whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono leading-5">{formatErrorLog(runDetail.error)}</pre>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">No snapshot data available.</p>
            )}
          </div>
        </Drawer>
      ) : null}

      {selectedEvidenceContext ? (
        <EvidenceDetailModal evidence={selectedEvidenceContext.evidence} project={selectedEvidenceContext.project} onClose={closeDrawer} />
      ) : null}

      <RunNotificationObserver />
      <Toaster />
    </div>
  )
}

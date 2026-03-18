import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'

import {
  ChevronRight,
  Globe,
  LayoutDashboard,
  Menu,
  Play,
  Rocket,
  Settings,
  X,
} from 'lucide-react'

import { _BASE_PREFIX, appHref, normalizePathname } from './lib/base-path.js'
import { formatErrorLog } from './lib/format-helpers.js'
import { buildSystemHealthCards, buildSetupModel } from './lib/health-helpers.js'

import { Button } from './components/ui/button.js'
import { Badge } from './components/ui/badge.js'
import { BrandLockup } from './components/shared/BrandLockup.js'
import { ProviderBadge } from './components/shared/ProviderBadge.js'
import { StatusBadge } from './components/shared/StatusBadge.js'
import { Drawer } from './components/layout/Drawer.js'
import { EvidenceDetailModal } from './components/layout/EvidenceDetailModal.js'
import { OverviewPage } from './pages/OverviewPage.js'
import { ProjectsPage } from './pages/ProjectsPage.js'
import { ProjectPage } from './pages/ProjectPage.js'
import type { ProjectPageTab } from './pages/ProjectPage.js'
import { RunsPage } from './pages/RunsPage.js'
import { SettingsPage } from './pages/SettingsPage.js'
import { SetupPage } from './pages/SetupPage.js'
import { NotFoundPage } from './pages/NotFoundPage.js'
import { createDashboardFixture, findEvidenceById, findProjectVm, findRunById } from './mock-data.js'
import { useDashboard } from './queries/use-dashboard.js'
import { useHealth } from './queries/use-health.js'
import { useRunDetail } from './queries/use-run-detail.js'
import type {
  DashboardVm,
  HealthSnapshot,
  ServiceStatus,
} from './view-models.js'

const docs = [
  { label: 'Architecture', href: 'https://github.com/AINYC/canonry/blob/main/docs/architecture.md' },
  { label: 'Testing Guide', href: 'https://github.com/AINYC/canonry/blob/main/docs/testing.md' },
]

const defaultFixture = createDashboardFixture()

const checkingStatus = (label: string): ServiceStatus => ({
  label,
  state: 'checking',
  detail: 'Checking service health',
})

const defaultHealthSnapshot: HealthSnapshot = {
  apiStatus: checkingStatus('API'),
  workerStatus: checkingStatus('Worker'),
}

type AppRoute =
  | { kind: 'overview'; path: '/' }
  | { kind: 'projects'; path: '/projects' }
  | { kind: 'project'; path: string; projectId: string; tab: ProjectPageTab }
  | { kind: 'runs'; path: '/runs' }
  | { kind: 'settings'; path: '/settings' }
  | { kind: 'setup'; path: '/setup' }
  | { kind: 'not-found'; path: string }

type DrawerState =
  | { kind: 'run'; runId: string }
  | { kind: 'evidence'; evidenceId: string }
  | null

export interface AppProps {
  initialPathname?: string
  initialDashboard?: DashboardVm
  initialHealthSnapshot?: HealthSnapshot
  enableLiveStatus?: boolean
}

export async function fetchServiceStatus(url: string, label: string): Promise<ServiceStatus> {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      return {
        label,
        state: 'error',
        detail: `HTTP ${response.status}`,
      }
    }

    const payload = (await response.json()) as Record<string, unknown>
    const version = typeof payload.version === 'string' ? payload.version : 'unknown'
    const databaseConfigured =
      typeof payload.databaseUrlConfigured === 'boolean' ? payload.databaseUrlConfigured : undefined
    const lastHeartbeatAt = typeof payload.lastHeartbeatAt === 'string' ? payload.lastHeartbeatAt : undefined
    const detail = [
      version,
      databaseConfigured === false ? 'database not configured' : 'database configured',
      lastHeartbeatAt ? `heartbeat ${lastHeartbeatAt}` : undefined,
    ]
      .filter(Boolean)
      .join(' \u00b7 ')

    return {
      label,
      state: 'ok',
      detail,
      version,
      databaseConfigured,
      lastHeartbeatAt,
    }
  } catch (error) {
    return {
      label,
      state: 'error',
      detail: error instanceof Error ? error.message : 'unreachable',
    }
  }
}

function resolveRoute(pathname: string, dashboard: DashboardVm): AppRoute {
  const normalized = normalizePathname(pathname)

  if (normalized === '/') {
    return { kind: 'overview', path: '/' }
  }

  if (normalized === '/runs') {
    return { kind: 'runs', path: '/runs' }
  }

  if (normalized === '/settings') {
    return { kind: 'settings', path: '/settings' }
  }

  if (normalized === '/setup') {
    return { kind: 'setup', path: '/setup' }
  }

  if (normalized === '/projects') {
    return { kind: 'projects', path: '/projects' }
  }

  if (normalized.startsWith('/projects/')) {
    const segments = normalized.split('/').filter(Boolean)
    if (segments.length < 2 || segments.length > 3) {
      return { kind: 'not-found', path: normalized }
    }

    const [, projectId, rawTab] = segments
    const tab: ProjectPageTab | null =
      rawTab === undefined
        ? 'overview'
        : rawTab === 'search-console'
          ? 'search-console'
          : rawTab === 'analytics'
            ? 'analytics'
            : null

    if (!tab) {
      return { kind: 'not-found', path: normalized }
    }

    return findProjectVm(dashboard, projectId)
      ? { kind: 'project', path: normalized, projectId, tab }
      : { kind: 'not-found', path: normalized }
  }

  return { kind: 'not-found', path: normalized }
}

function getInitialPathname(initialPathname?: string): string {
  if (initialPathname) {
    return normalizePathname(initialPathname)
  }

  if (typeof window !== 'undefined') {
    return normalizePathname(window.location.pathname)
  }

  return '/'
}

function createNavigationHandler(navigate: (to: string) => void, to: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    navigate(to)
  }
}

function isNavActive(route: AppRoute, section: 'overview' | 'projects' | 'project' | 'runs' | 'settings'): boolean {
  if (section === 'projects') {
    return route.kind === 'projects' || route.kind === 'project'
  }

  if (section === 'project') {
    return route.kind === 'project'
  }

  return route.kind === section
}

/* ────────────────────────────────────────────
   Root app
   ──────────────────────────────────────────── */

export function App({
  initialPathname,
  initialDashboard,
  initialHealthSnapshot,
  enableLiveStatus = true,
}: AppProps) {
  // ── Data fetching via TanStack Query ──
  const { dashboard, isLoading, refetch: refreshData } = useDashboard(initialDashboard)
  const healthQuery = useHealth(enableLiveStatus && !initialHealthSnapshot, initialHealthSnapshot ?? defaultHealthSnapshot)
  const healthSnapshot = healthQuery.data ?? initialHealthSnapshot ?? defaultHealthSnapshot

  // ── UI state ──
  const [pathname, setPathname] = useState(() => getInitialPathname(initialPathname))
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [drawerState, setDrawerState] = useState<DrawerState>(null)

  // ── Run detail for drawer ──
  const activeRunId = drawerState?.kind === 'run' ? drawerState.runId : null
  const runDetailQuery = useRunDetail(activeRunId)
  const runDetail = runDetailQuery.data ?? null
  const runDetailLoading = runDetailQuery.isLoading

  // When run finishes, refresh dashboard data
  useEffect(() => {
    if (!runDetail) return
    if (runDetail.status !== 'running' && runDetail.status !== 'queued') {
      void refreshData()
    }
  }, [runDetail?.status, refreshData])

  // ── Browser history sync ──
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const syncPathname = () => {
      setPathname(normalizePathname(window.location.pathname))
    }

    window.addEventListener('popstate', syncPathname)
    return () => {
      window.removeEventListener('popstate', syncPathname)
    }
  }, [])

  useEffect(() => {
    setMobileNavOpen(false)
    setDrawerState(null)
  }, [pathname])

  // Smart redirect: skip setup when projects already exist, go to setup when none
  useEffect(() => {
    if (isLoading || !dashboard) return
    const hasProjects = dashboard.projects.length > 0

    if (pathname === '/setup' && hasProjects) {
      const nextPath = '/'
      if (typeof window !== 'undefined' && normalizePathname(window.location.pathname) !== nextPath) {
        window.history.replaceState({}, '', _BASE_PREFIX + nextPath)
      }
      setPathname(nextPath)
    } else if (pathname === '/' && !hasProjects) {
      const nextPath = '/setup'
      if (typeof window !== 'undefined' && normalizePathname(window.location.pathname) !== nextPath) {
        window.history.replaceState({}, '', _BASE_PREFIX + nextPath)
      }
      setPathname(nextPath)
    }
  }, [isLoading, dashboard, pathname])

  useEffect(() => {
    if (typeof window === 'undefined' || drawerState === null) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerState(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [drawerState])

  // Show disconnected state when API is unreachable
  const apiConnected = dashboard !== null || isLoading
  if (!isLoading && !dashboard && !apiConnected) {
    return (
      <div className="app-shell">
        <div className="main-area" style={{ gridColumn: '1 / -1' }}>
          <main id="content" className="page-shell">
            <div className="page-container">
              <div className="page-header">
                <div className="page-header-left">
                  <h1 className="page-title">Cannot connect to API</h1>
                  <p className="page-subtitle">
                    The dashboard could not reach the Canonry API. Make sure <code>canonry serve</code> is running
                    and try refreshing the page.
                  </p>
                </div>
              </div>
              <Button type="button" onClick={() => { void refreshData() }}>
                Retry connection
              </Button>
            </div>
          </main>
        </div>
      </div>
    )
  }

  // While loading or dashboard not yet available, use a safe fallback for derived values
  const safeDashboard = dashboard ?? defaultFixture.dashboard

  const route = resolveRoute(pathname, safeDashboard)
  const activeProject = route.kind === 'project' ? findProjectVm(safeDashboard, route.projectId) : undefined
  const navigate = (to: string) => {
    const nextPath = normalizePathname(to)

    if (typeof window === 'undefined') {
      setPathname(nextPath)
      return
    }

    if (normalizePathname(window.location.pathname) !== nextPath) {
      window.history.pushState({}, '', _BASE_PREFIX + nextPath)
    }

    setPathname(nextPath)
  }

  const openRun = (runId?: string) => {
    if (!runId) {
      return
    }
    setDrawerState({ kind: 'run', runId })
  }

  const handleTriggerAllRuns = () => {
    import('./api.js').then(({ triggerAllRuns }) =>
      triggerAllRuns().catch((err: unknown) => {
        console.error('Failed to trigger all runs', err)
      }).finally(() => {
        void refreshData()
      }),
    )
  }

  const openEvidence = (evidenceId: string) => {
    setDrawerState({ kind: 'evidence', evidenceId })
  }

  const handleTriggerRun = async (projectName: string) => {
    const { triggerRun } = await import('./api.js')
    await triggerRun(projectName)
    void refreshData()
  }

  const handleDeleteProject = async (projectName: string) => {
    try {
      const { deleteProject } = await import('./api.js')
      await deleteProject(projectName)
      navigate('/')
      void refreshData()
    } catch (err) {
      console.error('Failed to delete project:', err)
    }
  }

  const handleAddKeywords = async (projectName: string, keywords: string[]) => {
    const { appendKeywords } = await import('./api.js')
    await appendKeywords(projectName, keywords)
    await refreshData()
  }

  const handleDeleteKeywords = async (projectName: string, keywords: string[]) => {
    const { deleteKeywords } = await import('./api.js')
    await deleteKeywords(projectName, keywords)
    await refreshData()
  }

  const handleAddCompetitors = async (projectName: string, domains: string[]) => {
    const { fetchCompetitors, setCompetitors } = await import('./api.js')
    const existing = await fetchCompetitors(projectName)
    const existingDomains = existing.map(c => c.domain)
    const merged = [...new Set([...existingDomains, ...domains])]
    await setCompetitors(projectName, merged)
    await refreshData()
  }

  const handleUpdateOwnedDomains = async (projectName: string, ownedDomains: string[]) => {
    const { updateOwnedDomains } = await import('./api.js')
    await updateOwnedDomains(projectName, ownedDomains)
    await refreshData()
  }

  const handleUpdateProject = async (projectName: string, updates: {
    displayName?: string
    canonicalDomain?: string
    ownedDomains?: string[]
    country?: string
    language?: string
  }) => {
    const { updateProject } = await import('./api.js')
    await updateProject(projectName, updates)
    await refreshData()
  }

  const systemHealthCards = buildSystemHealthCards(safeDashboard.portfolioOverview.systemHealth, healthSnapshot, safeDashboard.settings)
  const setupModel = buildSetupModel(safeDashboard.setup, healthSnapshot, safeDashboard.settings)
  const selectedRun = drawerState?.kind === 'run' ? findRunById(safeDashboard, drawerState.runId) : undefined
  const selectedEvidenceContext =
    drawerState?.kind === 'evidence' ? findEvidenceById(safeDashboard, drawerState.evidenceId) : undefined

  const mainNavItems = [
    { label: 'Overview', href: '/', icon: LayoutDashboard, active: isNavActive(route, 'overview') },
    { label: 'Projects', href: '/projects', icon: Globe, active: isNavActive(route, 'projects') },
    { label: 'Runs', href: '/runs', icon: Play, active: isNavActive(route, 'runs') },
    { label: 'Settings', href: '/settings', icon: Settings, active: isNavActive(route, 'settings') },
  ]

  const breadcrumbLabel =
    route.kind === 'overview'
      ? 'Portfolio'
      : route.kind === 'projects'
        ? 'Projects'
        : route.kind === 'project' && activeProject
          ? activeProject.project.name
          : route.kind === 'runs'
            ? 'Runs'
            : route.kind === 'settings'
              ? 'Settings'
              : route.kind === 'setup'
                ? 'Setup'
                : 'Not found'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      {/* ── Sidebar (desktop) ── */}
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="sidebar-brand">
          <BrandLockup navigate={navigate} />
        </div>

        <nav className="sidebar-nav">
          {mainNavItems.map((item) => (
            <a
              key={item.label}
              className={`sidebar-link ${item.active ? 'sidebar-link-active' : ''}`}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              onClick={createNavigationHandler(navigate, item.href)}
            >
              <item.icon className="sidebar-icon" />
              <span>{item.label}</span>
            </a>
          ))}

          {safeDashboard.projects.length > 0 ? (
            <>
              <p className="sidebar-section-title">Projects</p>
              {safeDashboard.projects.map((projectVm) => {
                const isActive = route.kind === 'project' && activeProject?.project.id === projectVm.project.id
                const visibilityTone = projectVm.visibilitySummary.tone
                return (
                  <a
                    key={projectVm.project.id}
                    className={`sidebar-project ${isActive ? 'sidebar-project-active' : ''}`}
                    href={`/projects/${projectVm.project.id}`}
                    onClick={createNavigationHandler(navigate, `/projects/${projectVm.project.id}`)}
                  >
                    <span className={`sidebar-dot sidebar-dot-${visibilityTone}`} />
                    <span>{projectVm.project.name}</span>
                  </a>
                )
              })}
            </>
          ) : null}

          {safeDashboard.projects.length === 0 ? (
            <>
              <p className="sidebar-section-title">Resources</p>
              <a
                className="sidebar-link"
                href={appHref('/setup')}
                aria-current={route.kind === 'setup' ? 'page' : undefined}
                onClick={createNavigationHandler(navigate, '/setup')}
              >
                <Rocket className="sidebar-icon" />
                <span>Setup</span>
              </a>
            </>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          {docs.map((doc) => (
            <a key={doc.href} className="sidebar-footer-link" href={doc.href} target="_blank" rel="noreferrer">
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
              <BrandLockup compact navigate={navigate} />
            </div>
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <a href={appHref('/')} onClick={createNavigationHandler(navigate, '/')}>
                Home
              </a>
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
          {mainNavItems.map((item) => (
            <a
              key={item.label}
              className={`mobile-nav-link ${item.active ? 'mobile-nav-link-active' : ''}`}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              onClick={createNavigationHandler(navigate, item.href)}
            >
              {item.label}
            </a>
          ))}
          {safeDashboard.projects.length > 0 ? (
            <div className="mobile-nav-section">
              <p className="mobile-nav-section-title">Projects</p>
              {safeDashboard.projects.map((projectVm) => (
                <a
                  key={projectVm.project.id}
                  className="mobile-nav-link"
                  href={`/projects/${projectVm.project.id}`}
                  onClick={createNavigationHandler(navigate, `/projects/${projectVm.project.id}`)}
                >
                  {projectVm.project.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>

        {/* Page content */}
        <main id="content" className="page-shell">
          {isLoading ? (
            <div className="page-container">
              <div className="page-header">
                <div className="page-header-left">
                  <h1 className="page-title">Loading</h1>
                  <p className="page-subtitle">Connecting to API and loading dashboard data...</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {route.kind === 'overview' ? (
                <OverviewPage
                  model={safeDashboard.portfolioOverview}
                  systemHealth={systemHealthCards}
                  onNavigate={navigate}
                  onOpenRun={openRun}
                />
              ) : null}
              {route.kind === 'projects' ? (
                <ProjectsPage
                  projects={safeDashboard.projects}
                  onNavigate={navigate}
                  onProjectCreated={refreshData}
                />
              ) : null}
              {route.kind === 'project' && activeProject ? (
                <ProjectPage model={activeProject} tab={route.tab} onOpenEvidence={openEvidence} onOpenRun={openRun} onTriggerRun={handleTriggerRun} onDeleteProject={handleDeleteProject} onAddKeywords={handleAddKeywords} onDeleteKeywords={handleDeleteKeywords} onAddCompetitors={handleAddCompetitors} onUpdateOwnedDomains={handleUpdateOwnedDomains} onUpdateProject={handleUpdateProject} onNavigate={navigate} />
              ) : null}
              {route.kind === 'runs' ? <RunsPage runs={safeDashboard.runs} onOpenRun={openRun} onTriggerAll={handleTriggerAllRuns} /> : null}
              {route.kind === 'settings' ? (
                <SettingsPage settings={safeDashboard.settings} healthSnapshot={healthSnapshot} onSettingsChanged={refreshData} />
              ) : null}
              {route.kind === 'setup' ? <SetupPage model={setupModel} settings={safeDashboard.settings} onProjectCreated={refreshData} onNavigate={navigate} /> : null}
              {route.kind === 'not-found' ? <NotFoundPage onNavigate={navigate} /> : null}
            </>
          )}
        </main>

        <footer className="footer">
          <p className="supporting-copy">Technical readiness and answer visibility stay separate.</p>
          <div className="footer-links">
            {docs.map((doc) => (
              <a key={doc.href} href={doc.href} target="_blank" rel="noreferrer">
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
          onClose={() => setDrawerState(null)}
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
                              <a href={src.uri} target="_blank" rel="noreferrer" className="hover:text-zinc-300">{src.title || src.uri}</a>
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
        <EvidenceDetailModal evidence={selectedEvidenceContext.evidence} project={selectedEvidenceContext.project} onClose={() => setDrawerState(null)} />
      ) : null}
    </div>
  )
}

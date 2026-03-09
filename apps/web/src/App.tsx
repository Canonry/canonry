import { useCallback, useEffect, useId, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'

import {
  Activity,
  ChevronRight,
  Download,
  Globe,
  LayoutDashboard,
  Menu,
  Play,
  Rocket,
  Settings,
  Trash2,
  Users,
  X,
} from 'lucide-react'

import { Badge } from './components/ui/badge.js'
import { Button } from './components/ui/button.js'
import { Card } from './components/ui/card.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './components/ui/sheet.js'
import { createDashboardFixture, findEvidenceById, findProjectVm, findRunById } from './mock-data.js'
import {
  createProject,
  fetchAllRuns,
  fetchCompetitors,
  fetchExport,
  fetchKeywords,
  fetchProjects,
  fetchRunDetail,
  fetchTimeline,
  setCompetitors,
  setKeywords,
  triggerRun as apiTriggerRun,
  deleteProject as apiDeleteProject,
} from './api.js'
import { buildDashboard } from './build-dashboard.js'
import type { ProjectData } from './build-dashboard.js'
import type {
  CitationInsightVm,
  DashboardVm,
  HealthSnapshot,
  MetricTone,
  PortfolioOverviewVm,
  PortfolioProjectVm,
  ProjectCommandCenterVm,
  RunFilter,
  RunListItemVm,
  ServiceStatus,
  SettingsVm,
  SetupWizardVm,
  SystemHealthCardVm,
  TechnicalFindingVm,
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
  | { kind: 'project'; path: string; projectId: string }
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
      .join(' · ')

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

function normalizePathname(pathname: string): string {
  if (!pathname) {
    return '/'
  }

  const normalized = pathname.split('?')[0] ?? '/'
  if (normalized === '') {
    return '/'
  }

  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
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
    const firstProject = dashboard.projects[0]
    return firstProject
      ? { kind: 'project', path: `/projects/${firstProject.project.id}`, projectId: firstProject.project.id }
      : { kind: 'setup', path: '/setup' }
  }

  if (normalized.startsWith('/projects/')) {
    const projectId = normalized.slice('/projects/'.length)
    return findProjectVm(dashboard, projectId)
      ? { kind: 'project', path: normalized, projectId }
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

function toneFromService(status: ServiceStatus): MetricTone {
  if (status.state === 'ok') {
    return 'positive'
  }

  if (status.state === 'checking') {
    return 'neutral'
  }

  return 'negative'
}

function toneFromRunStatus(status: RunListItemVm['status']): MetricTone {
  switch (status) {
    case 'completed':
      return 'positive'
    case 'partial':
      return 'caution'
    case 'failed':
      return 'negative'
    case 'queued':
    case 'running':
      return 'neutral'
  }
}

function toneFromCitationState(state: CitationInsightVm['citationState']): MetricTone {
  switch (state) {
    case 'cited':
      return 'positive'
    case 'emerging':
      return 'positive'
    case 'not-cited':
      return 'caution'
    case 'lost':
      return 'negative'
  }
}

function toneFromFindingSeverity(severity: TechnicalFindingVm['severity']): MetricTone {
  switch (severity) {
    case 'high':
      return 'negative'
    case 'medium':
      return 'caution'
    case 'low':
      return 'neutral'
  }
}

function toTitleCase(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildSystemHealthCards(
  cards: SystemHealthCardVm[],
  healthSnapshot: HealthSnapshot,
  settings: SettingsVm,
): SystemHealthCardVm[] {
  return cards.map((card) => {
    if (card.id === 'api') {
      return {
        ...card,
        tone: toneFromService(healthSnapshot.apiStatus),
        detail: healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Needs attention',
        meta: healthSnapshot.apiStatus.detail,
      }
    }

    if (card.id === 'worker') {
      return {
        ...card,
        tone: toneFromService(healthSnapshot.workerStatus),
        detail: healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : 'Needs attention',
        meta: healthSnapshot.workerStatus.detail,
      }
    }

    return {
      ...card,
      label: settings.providerStatus.name,
      tone: settings.providerStatus.state === 'ready' ? 'positive' : 'caution',
      detail: settings.providerStatus.state === 'ready' ? 'Configured' : 'Needs config',
      meta: settings.providerStatus.detail,
    }
  })
}

function getLaunchBlockedReason(healthSnapshot: HealthSnapshot, settings: SettingsVm): string | undefined {
  if (healthSnapshot.apiStatus.state !== 'ok') {
    return 'Launch is blocked until the API responds cleanly.'
  }

  if (healthSnapshot.apiStatus.databaseConfigured === false) {
    return 'Launch is blocked until the API has a database connection configured.'
  }

  if (healthSnapshot.workerStatus.state !== 'ok') {
    return 'Launch is blocked until the worker is healthy and heartbeats are current.'
  }

  if (settings.providerStatus.state !== 'ready') {
    return 'Launch is blocked until Gemini credentials are configured.'
  }

  return undefined
}

function buildSetupModel(base: SetupWizardVm, healthSnapshot: HealthSnapshot, settings: SettingsVm): SetupWizardVm {
  const blockedReason = getLaunchBlockedReason(healthSnapshot, settings)
  const model = structuredClone(base)

  model.healthChecks = model.healthChecks.map((check) => {
    if (check.id === 'api') {
      return {
        ...check,
        detail: healthSnapshot.apiStatus.detail,
        state: healthSnapshot.apiStatus.state === 'ok' ? 'ready' : 'attention',
      }
    }

    if (check.id === 'worker') {
      return {
        ...check,
        detail: healthSnapshot.workerStatus.detail,
        state: healthSnapshot.workerStatus.state === 'ok' ? 'ready' : 'attention',
      }
    }

    return {
      ...check,
      detail: settings.providerStatus.detail,
      state: settings.providerStatus.state === 'ready' ? 'ready' : 'attention',
    }
  })

  model.launchState.enabled = blockedReason === undefined
  model.launchState.blockedReason = blockedReason
  model.launchState.summary =
    blockedReason ?? 'Queue a visibility sweep first, then follow with a site audit to explain movement.'

  return model
}

function findLatestRunForProject(dashboard: DashboardVm, projectId: string): RunListItemVm | undefined {
  return dashboard.runs.find((run) => run.projectId === projectId)
}

function createNavigationHandler(navigate: (to: string) => void, to: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    navigate(to)
  }
}

function isNavActive(route: AppRoute, section: 'overview' | 'project' | 'runs' | 'settings'): boolean {
  if (section === 'project') {
    return route.kind === 'project'
  }

  return route.kind === section
}

/* ────────────────────────────────────────────
   Presentational components
   ──────────────────────────────────────────── */

function Sparkline({ points, tone }: { points: number[]; tone: MetricTone }) {
  const clipId = useId()
  if (points.length === 0) return null
  const height = 42
  const width = 132
  const padding = 5
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2
  const coordinates = points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * innerWidth
      const y = padding + (1 - (point - min) / range) * innerHeight
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg className={`sparkline sparkline-${tone}`} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x={padding} y={padding} width={innerWidth} height={innerHeight} rx="8" />
        </clipPath>
      </defs>
      <line className="sparkline-guide" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
      <polyline clipPath={`url(#${clipId})`} points={coordinates} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function ScoreGauge({
  value,
  label,
  delta,
  tone,
  description,
  isNumeric = true,
}: {
  value: string
  label: string
  delta: string
  tone: MetricTone
  description: string
  isNumeric?: boolean
}) {
  const radius = 48
  const strokeWidth = 6
  const circumference = 2 * Math.PI * radius
  const numericValue = Number.parseInt(value, 10)
  const progress = isNumeric && !Number.isNaN(numericValue) ? Math.min(numericValue / 100, 1) : 0.5
  const dashOffset = circumference * (1 - progress)

  return (
    <div className="score-gauge">
      <div className="gauge-ring-wrapper">
        <svg className="gauge-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle className="gauge-bg" cx="60" cy="60" r={radius} strokeWidth={strokeWidth} />
          <circle
            className={`gauge-fill gauge-fill-${tone}`}
            cx="60"
            cy="60"
            r={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="gauge-center">
          <span className={isNumeric ? 'gauge-value' : 'gauge-value-text'}>{value.split(' / ')[0]}</span>
        </div>
      </div>
      <p className="gauge-label">{label}</p>
      <p className="gauge-delta">{delta}</p>
      <p className="gauge-description">{description}</p>
    </div>
  )
}

function ToneBadge({ tone, children }: { tone: MetricTone; children: ReactNode }) {
  const variant =
    tone === 'positive' ? 'success' : tone === 'caution' ? 'warning' : tone === 'negative' ? 'destructive' : 'neutral'

  return <Badge variant={variant}>{children}</Badge>
}

function StatusBadge({ status }: { status: RunListItemVm['status'] }) {
  return <ToneBadge tone={toneFromRunStatus(status)}>{toTitleCase(status)}</ToneBadge>
}

function CitationBadge({ state }: { state: CitationInsightVm['citationState'] }) {
  return <ToneBadge tone={toneFromCitationState(state)}>{toTitleCase(state)}</ToneBadge>
}

function MetricCard({ metric }: { metric: ProjectCommandCenterVm['visibilitySummary'] }) {
  const numericValue = Number.parseInt(metric.value, 10)
  const progressValue = Number.isNaN(numericValue) ? 0 : Math.max(0, Math.min(numericValue, 100))

  return (
    <Card className={`metric-card metric-card-${metric.tone}`}>
      <div className="metric-card-head">
        <p className="eyebrow eyebrow-soft">{metric.label}</p>
        <ToneBadge tone={metric.tone}>{metric.delta}</ToneBadge>
      </div>
      <div className="metric-card-body">
        <div>
          <p className="metric-value">{metric.value}</p>
          <p className="metric-description">{metric.description}</p>
        </div>
        <Sparkline points={metric.trend} tone={metric.tone} />
      </div>
      <div className="progress-track" aria-hidden="true">
        <div className={`progress-fill progress-fill-${metric.tone}`} style={{ width: `${progressValue}%` }} />
      </div>
    </Card>
  )
}

function RunRow({
  run,
  onOpen,
}: {
  run: RunListItemVm
  onOpen: (runId: string) => void
}) {
  return (
    <article className="run-row">
      <div className="run-row-main">
        <div className="run-row-head">
          <div>
            <p className="run-row-title">{run.summary}</p>
            <p className="run-row-subtitle">
              {run.projectName} · {run.kindLabel}
            </p>
          </div>
          <StatusBadge status={run.status} />
        </div>
        <p className="run-row-detail">{run.statusDetail}</p>
      </div>
      <dl className="run-row-meta">
        <div>
          <dt>Started</dt>
          <dd>{run.startedAt}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{run.duration}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{run.triggerLabel}</dd>
        </div>
      </dl>
      <Button variant="outline" size="sm" type="button" onClick={() => onOpen(run.id)}>
        View run
      </Button>
    </article>
  )
}

function EvidenceTable({
  evidence,
  onOpenEvidence,
}: {
  evidence: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
}) {
  return (
    <div className="evidence-table-wrap">
      <table className="evidence-table">
        <thead>
          <tr>
            <th>Keyword</th>
            <th>Status</th>
            <th>Change</th>
            <th>Summary</th>
            <th>Snippet</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {evidence.map((item) => (
            <tr key={item.id}>
              <td className="evidence-keyword-cell">{item.keyword}</td>
              <td>
                <CitationBadge state={item.citationState} />
              </td>
              <td className="evidence-change-cell">{item.changeLabel}</td>
              <td className="evidence-summary-cell">{item.summary}</td>
              <td className="evidence-snippet-cell" title={item.answerSnippet}>
                {item.answerSnippet}
              </td>
              <td>
                <Button variant="ghost" size="sm" type="button" onClick={() => onOpenEvidence(item.id)}>
                  View
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FindingsTable({ findings }: { findings: TechnicalFindingVm[] }) {
  return (
    <div className="findings-table-wrap">
      <table className="findings-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Finding</th>
            <th>Detail</th>
            <th>Impact</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => (
            <tr key={finding.id}>
              <td>
                <ToneBadge tone={toneFromFindingSeverity(finding.severity)}>{toTitleCase(finding.severity)}</ToneBadge>
              </td>
              <td className="font-medium text-zinc-100">{finding.title}</td>
              <td className="text-zinc-400">{finding.detail}</td>
              <td className="text-zinc-500">{finding.impact}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CompetitorTable({ competitors }: { competitors: ProjectCommandCenterVm['competitors'] }) {
  return (
    <div className="competitor-table-wrap">
      <table className="competitor-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Pressure</th>
            <th>Movement</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((competitor) => (
            <tr key={competitor.id}>
              <td className="font-medium text-zinc-100">{competitor.domain}</td>
              <td>
                <ToneBadge tone={competitor.pressureLabel === 'High' ? 'negative' : 'caution'}>
                  {competitor.pressureLabel}
                </ToneBadge>
              </td>
              <td className="text-zinc-300">{competitor.movement}</td>
              <td className="text-zinc-500">{competitor.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ────────────────────────────────────────────
   Page components
   ──────────────────────────────────────────── */

function OverviewProjectCard({
  project,
  onNavigate,
}: {
  project: PortfolioProjectVm
  onNavigate: (to: string) => void
}) {
  const projectPath = `/projects/${project.project.id}`

  return (
    <article className="project-row">
      <div className="project-row-primary">
        <div>
          <p className="project-name">{project.project.name}</p>
          <p className="project-domain">{project.project.canonicalDomain}</p>
        </div>
        <p className="project-insight">{project.insight}</p>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Answer Visibility</p>
          <p className="metric-inline-value">{project.visibilityScore}</p>
          <p className="metric-inline-delta">{project.visibilityDelta}</p>
        </div>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Technical Readiness</p>
          <p className="metric-inline-value text-zinc-500">{project.readinessScore ?? '—'}</p>
          <p className="metric-inline-delta">{project.readinessDelta ?? 'Coming soon'}</p>
        </div>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Competitor Pressure</p>
          <p className="metric-inline-value">{project.competitorPressureLabel}</p>
          <p className="metric-inline-delta">
            {project.lastRun.kindLabel} · {toTitleCase(project.lastRun.status)}
          </p>
        </div>
      </div>
      <div className="project-row-chart">
        <Sparkline points={project.trend} tone={toneFromRunStatus(project.lastRun.status)} />
      </div>
      <Button asChild variant="ghost" size="sm" className="project-row-link">
        <a href={projectPath} onClick={createNavigationHandler(onNavigate, projectPath)}>
          Open
        </a>
      </Button>
    </article>
  )
}

function OverviewPage({
  model,
  systemHealth,
  onNavigate,
  onOpenRun,
}: {
  model: PortfolioOverviewVm
  systemHealth: SystemHealthCardVm[]
  onNavigate: (to: string) => void
  onOpenRun: (runId: string) => void
}) {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Portfolio</h1>
          <p className="page-subtitle">Answer visibility, technical readiness, and execution state across all projects.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Needs attention</p>
              <h2>What changed</h2>
            </div>
            <p className="supporting-copy">{model.lastUpdatedAt}</p>
          </div>
          <div className="attention-list">
            {model.attentionItems.map((item) => (
              <a
                key={item.id}
                className={`attention-item attention-item-${item.tone}`}
                href={item.href}
                onClick={createNavigationHandler(onNavigate, item.href)}
              >
                <div>
                  <p className="attention-title">{item.title}</p>
                  <p className="attention-detail">{item.detail}</p>
                </div>
                <span className="attention-action">{item.actionLabel}</span>
              </a>
            ))}
          </div>
        </Card>

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Recent runs</p>
              <h2>Operational pulse</h2>
            </div>
          </div>
          <div className="compact-stack">
            {model.recentRuns.length > 0 ? (
              model.recentRuns.map((run) => (
                <button key={run.id} className="compact-run" type="button" onClick={() => onOpenRun(run.id)}>
                  <div>
                    <p className="compact-run-title">{run.projectName}</p>
                    <p className="compact-run-detail">{run.summary}</p>
                  </div>
                  <StatusBadge status={run.status} />
                </button>
              ))
            ) : (
              <p className="supporting-copy">Run history appears here after the first launch.</p>
            )}
          </div>
        </Card>
      </div>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Projects</p>
            <h2>Portfolio ranking</h2>
          </div>
        </div>

        {model.projects.length > 0 ? (
          <div className="project-list">
            {model.projects.map((project) => (
              <OverviewProjectCard key={project.project.id} project={project} onNavigate={onNavigate} />
            ))}
          </div>
        ) : (
          <Card className="surface-card empty-card">
            <h3>{model.emptyState?.title ?? 'No projects yet'}</h3>
            <p>{model.emptyState?.detail}</p>
            <Button asChild>
              <a
                href={model.emptyState?.ctaHref ?? '/setup'}
                onClick={createNavigationHandler(onNavigate, model.emptyState?.ctaHref ?? '/setup')}
              >
                {model.emptyState?.ctaLabel ?? 'Launch setup'}
              </a>
            </Button>
          </Card>
        )}
      </section>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">System health</p>
            <h2>Infrastructure</h2>
          </div>
        </div>
        <div className="health-grid">
          {systemHealth.map((item) => (
            <Card key={item.id} className="surface-card compact-card">
              <div className="section-head">
                <div>
                  <p className="eyebrow eyebrow-soft">{item.label}</p>
                  <h3>{item.detail}</h3>
                </div>
                <ToneBadge tone={item.tone}>{item.label}</ToneBadge>
              </div>
              <p className="supporting-copy">{item.meta}</p>
            </Card>
          ))}
        </div>
      </section>
    </div>
  )
}

function ProjectPage({
  model,
  onOpenEvidence,
  onOpenRun,
  onTriggerRun,
  onDeleteProject,
}: {
  model: ProjectCommandCenterVm
  onOpenEvidence: (evidenceId: string) => void
  onOpenRun: (runId?: string) => void
  onTriggerRun: (projectName: string) => void
  onDeleteProject: (projectName: string) => void
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleExport() {
    const data = await fetchExport(model.project.name)
    const yaml = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${model.project.name}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }
  const isNumericScore = (value: string) => !Number.isNaN(Number.parseInt(value, 10))

  return (
    <div className="page-container">
      {showDeleteConfirm ? (
        <Card className="surface-card p-6 mb-6 border-rose-800/60">
          <h3 className="text-base font-semibold text-rose-400 mb-2">Delete project?</h3>
          <p className="text-sm text-zinc-400 mb-4">
            This will permanently delete <strong className="text-zinc-200">{model.project.displayName || model.project.name}</strong> and
            all its keywords, competitors, runs, and snapshots. This cannot be undone.
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true)
                onDeleteProject(model.project.name)
              }}
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
            {model.project.canonicalDomain} · {model.contextLabel}
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
            <Button type="button" onClick={() => onTriggerRun(model.project.name)}>
              Run now
            </Button>
          </div>
        </div>
      </div>

      {/* Score gauges */}
      <section className="gauge-row">
        <ScoreGauge
          value={model.visibilitySummary.value}
          label={model.visibilitySummary.label}
          delta={model.visibilitySummary.delta}
          tone={model.visibilitySummary.tone}
          description={model.visibilitySummary.description}
          isNumeric={isNumericScore(model.visibilitySummary.value)}
        />
        {model.readinessSummary ? (
          <ScoreGauge
            value={model.readinessSummary.value}
            label={model.readinessSummary.label}
            delta={model.readinessSummary.delta}
            tone={model.readinessSummary.tone}
            description={model.readinessSummary.description}
            isNumeric={isNumericScore(model.readinessSummary.value)}
          />
        ) : (
          <ScoreGauge
            value="N/A"
            label="Technical Readiness"
            delta="Coming soon"
            tone="neutral"
            description="Enable with site audits in a future release."
            isNumeric={false}
          />
        )}
        <ScoreGauge
          value={model.competitorPressure.value}
          label={model.competitorPressure.label}
          delta={model.competitorPressure.delta}
          tone={model.competitorPressure.tone}
          description={model.competitorPressure.description}
          isNumeric={isNumericScore(model.competitorPressure.value)}
        />
        <ScoreGauge
          value={model.runStatus.value}
          label={model.runStatus.label}
          delta={model.runStatus.delta}
          tone={model.runStatus.tone}
          description={model.runStatus.description}
          isNumeric={isNumericScore(model.runStatus.value)}
        />
      </section>

      {/* Insights */}
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">What changed</p>
            <h2>Interpretation before raw evidence</h2>
          </div>
        </div>
        <div className="insight-grid">
          {model.insights.map((insight) => (
            <Card key={insight.id} className={`surface-card insight-card insight-card-${insight.tone}`}>
              <ToneBadge tone={insight.tone}>{insight.actionLabel}</ToneBadge>
              <h3>{insight.title}</h3>
              <p>{insight.detail}</p>
              {insight.evidenceId ? (
                <Button variant="outline" size="sm" type="button" onClick={() => onOpenEvidence(insight.evidenceId!)}>
                  Open evidence
                </Button>
              ) : (
                <span className="supporting-copy">Monitor in the next run.</span>
              )}
            </Card>
          ))}
        </div>
      </section>

      {/* Evidence table */}
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Visibility evidence</p>
            <h2>Keyword citation tracking</h2>
          </div>
          <p className="supporting-copy">{model.visibilityEvidence.length} keywords tracked</p>
        </div>
        <EvidenceTable evidence={model.visibilityEvidence} onOpenEvidence={onOpenEvidence} />
      </section>

      {/* Technical findings table — hidden when no site-audit data */}
      {model.technicalFindings && model.technicalFindings.length > 0 ? (
        <section className="page-section-divider">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Technical findings</p>
              <h2>Readiness signals</h2>
            </div>
            <p className="supporting-copy">{model.technicalFindings.length} findings</p>
          </div>
          <FindingsTable findings={model.technicalFindings} />
        </section>
      ) : (
        <section className="page-section-divider">
          <Card className="surface-card compact-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Technical findings</p>
                <h2 className="text-zinc-500">Unavailable</h2>
              </div>
              <ToneBadge tone="neutral">Coming soon</ToneBadge>
            </div>
            <p className="supporting-copy">Technical readiness findings require site audits, which are planned for a future release.</p>
          </Card>
        </section>
      )}

      {/* Competitor table */}
      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Competitors</p>
            <h2>Competitive landscape</h2>
          </div>
          <p className="supporting-copy">{model.competitors.length} tracked</p>
        </div>
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
            <RunRow key={run.id} run={run} onOpen={onOpenRun} />
          ))}
        </div>
      </section>
    </div>
  )
}

function RunsPage({ runs, onOpenRun }: { runs: RunListItemVm[]; onOpenRun: (runId: string) => void }) {
  const [filter, setFilter] = useState<RunFilter>('all')
  const filteredRuns = filter === 'all' ? runs : runs.filter((run) => run.status === filter)

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Runs</h1>
          <p className="page-subtitle">
            Status, type, project, duration, and the shortest explanation that makes the outcome trustworthy.
          </p>
        </div>
      </div>

      <section>
        <div className="filter-row" role="toolbar" aria-label="Run filters">
          {(['all', 'queued', 'running', 'completed', 'partial', 'failed'] as const).map((option) => (
            <button
              key={option}
              className={`filter-chip ${filter === option ? 'filter-chip-active' : ''}`}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? 'All runs' : toTitleCase(option)}
            </button>
          ))}
        </div>

        <div className="run-list">
          {filteredRuns.length > 0 ? (
            filteredRuns.map((run) => <RunRow key={run.id} run={run} onOpen={onOpenRun} />)
          ) : (
            <Card className="surface-card empty-card">
              <h2>No runs match this filter</h2>
              <p>Try another status filter or queue a new run from a project command center.</p>
            </Card>
          )}
        </div>
      </section>
    </div>
  )
}

function SettingsPage({
  settings,
  healthSnapshot,
}: {
  settings: SettingsVm
  healthSnapshot: HealthSnapshot
}) {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Provider state, quotas, and service health.</p>
        </div>
      </div>

      <section className="settings-grid">
        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Provider</p>
              <h2>{settings.providerStatus.name}</h2>
            </div>
            <ToneBadge tone={settings.providerStatus.state === 'ready' ? 'positive' : 'caution'}>
              {settings.providerStatus.state === 'ready' ? 'Ready' : 'Needs config'}
            </ToneBadge>
          </div>
          <p>{settings.providerStatus.detail}</p>
        </Card>

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Quota summary</p>
              <h2>Conservative defaults</h2>
            </div>
          </div>
          <dl className="definition-list">
            <div>
              <dt>Max concurrency</dt>
              <dd>{settings.quotaSummary.maxConcurrency}</dd>
            </div>
            <div>
              <dt>Requests per minute</dt>
              <dd>{settings.quotaSummary.maxRequestsPerMinute}</dd>
            </div>
            <div>
              <dt>Requests per day</dt>
              <dd>{settings.quotaSummary.maxRequestsPerDay}</dd>
            </div>
          </dl>
        </Card>

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Service health</p>
              <h2>API and worker</h2>
            </div>
          </div>
          <div className="compact-stack">
            <div className="health-row">
              <div>
                <p className="run-row-title">API</p>
                <p className="supporting-copy">{healthSnapshot.apiStatus.detail}</p>
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.apiStatus)}>
                {healthSnapshot.apiStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
            <div className="health-row">
              <div>
                <p className="run-row-title">Worker</p>
                <p className="supporting-copy">{healthSnapshot.workerStatus.detail}</p>
              </div>
              <ToneBadge tone={toneFromService(healthSnapshot.workerStatus)}>
                {healthSnapshot.workerStatus.state === 'ok' ? 'Healthy' : 'Attention'}
              </ToneBadge>
            </div>
          </div>
        </Card>
      </section>

      <section className="page-section">
        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Self-host notes</p>
              <h2>Operational guidance</h2>
            </div>
          </div>
          <ul className="detail-list">
            {settings.selfHostNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <p className="supporting-copy">{settings.bootstrapNote}</p>
        </Card>
      </section>
    </div>
  )
}

const SETUP_STEPS = [
  { label: 'System check', description: 'Verify your instance is ready' },
  { label: 'Create project', description: 'Name, domain, and locale' },
  { label: 'Keywords', description: 'Add keywords to track' },
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

function SetupPage({
  model,
  onProjectCreated,
  onNavigate,
}: {
  model: SetupWizardVm
  onProjectCreated: () => void
  onNavigate: (to: string) => void
}) {
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

  const [competitorsText, setCompetitorsText] = useState('')
  const [competitorsSaved, setCompetitorsSaved] = useState(false)
  const [competitorsError, setCompetitorsError] = useState<string | null>(null)
  const [competitorsSaving, setCompetitorsSaving] = useState(false)

  const [runTriggered, setRunTriggered] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [runSaving, setRunSaving] = useState(false)

  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const parsedKeywords = keywordsText.split('\n').map(k => k.trim()).filter(Boolean)
  const parsedCompetitors = competitorsText.split('\n').map(c => c.trim()).filter(Boolean)

  const allHealthy = model.healthChecks.every((c) => c.state === 'ready')

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
      onProjectCreated()
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
      onProjectCreated()
      setStep(3)
    } catch (err) {
      setKeywordsError(err instanceof Error ? err.message : 'Failed to save keywords')
    } finally {
      setKeywordsSaving(false)
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
      onProjectCreated()
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
    setRunError(null)
    try {
      await apiTriggerRun(createdProjectName)
      setRunTriggered(true)
      onProjectCreated()
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to trigger run')
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
                  </div>
                  <ToneBadge tone={check.state === 'ready' ? 'positive' : 'caution'}>
                    {check.state === 'ready' ? 'Ready' : 'Attention'}
                  </ToneBadge>
                </div>
              ))}
            </div>
            <div className="setup-nav">
              <span />
              <Button type="button" disabled={!allHealthy} onClick={() => setStep(1)}>
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
                <h2>Add keywords</h2>
              </div>
              {keywordsSaved ? (
                <ToneBadge tone="positive">{parsedKeywords.length} saved</ToneBadge>
              ) : (
                <ToneBadge tone="neutral">{parsedKeywords.length} keyword{parsedKeywords.length !== 1 ? 's' : ''}</ToneBadge>
              )}
            </div>
            <p className="supporting-copy">Enter the search queries you want to track. One keyword per line.</p>
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
                <div className="setup-field">
                  <label className="setup-label" htmlFor="keywords">Keywords (one per line)</label>
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
                    {keywordsSaving ? 'Saving...' : `Save ${parsedKeywords.length} keyword${parsedKeywords.length !== 1 ? 's' : ''}`}
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
            <p className="supporting-copy">Domains that compete for the same keywords. One per line.</p>
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
                  <Button type="button" disabled={parsedCompetitors.length === 0 || competitorsSaving} onClick={handleSaveCompetitors}>
                    {competitorsSaving ? 'Saving...' : `Save ${parsedCompetitors.length} competitor${parsedCompetitors.length !== 1 ? 's' : ''}`}
                  </Button>
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
                  <Button type="button" onClick={() => onNavigate(createdProjectId ? `/projects/${createdProjectId}` : '/')}>
                    Open project
                  </Button>
                </div>
              </div>
            ) : (
              <div className="compact-stack">
                <p className="supporting-copy">
                  Everything is configured. Launch an answer-visibility sweep to start tracking citations for <span className="text-zinc-100 font-medium">{createdProjectName}</span>.
                </p>
                {runError ? <p className="text-rose-400 text-sm">{runError}</p> : null}
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
          <p className="page-subtitle">Create a project, import keywords, add competitors, and launch the first run.</p>
        </div>
      </div>

      <SetupStepIndicator current={step} labels={SETUP_STEPS} />

      <section className="setup-wizard">
        {stepContent}
      </section>
    </div>
  )
}

function NotFoundPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
    <div className="page-container">
      <section className="page-section">
        <Card className="surface-card empty-card">
          <h1>Route not found</h1>
          <p>The current path does not map to a dashboard view.</p>
          <Button asChild>
            <a href="/" onClick={createNavigationHandler(onNavigate, '/')}>
              Return to overview
            </a>
          </Button>
        </Card>
      </section>
    </div>
  )
}

function Drawer({
  title,
  subtitle,
  children,
  open,
  onClose,
}: {
  title: string
  subtitle: string
  children: ReactNode
  open: boolean
  onClose: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : onClose())}>
      <SheetContent>
        <SheetHeader className="drawer-head">
          <p className="eyebrow eyebrow-soft">{subtitle}</p>
          <SheetTitle id="drawer-title">{title}</SheetTitle>
          <SheetDescription className="sr-only">{subtitle}</SheetDescription>
        </SheetHeader>
        <div className="drawer-body">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

/* ────────────────────────────────────────────
   Root app
   ──────────────────────────────────────────── */

async function loadDashboardData(): Promise<DashboardVm | null> {
  try {
    const [projects, allRuns] = await Promise.all([fetchProjects(), fetchAllRuns()])

    const projectDataList: ProjectData[] = await Promise.all(
      projects.map(async (project) => {
        const projectRuns = allRuns.filter(r => r.projectId === project.id)
        const completedRuns = projectRuns
          .filter(r => r.status === 'completed')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

        const [kws, comps, timeline, latestRunDetail] = await Promise.all([
          fetchKeywords(project.name).catch(() => []),
          fetchCompetitors(project.name).catch(() => []),
          fetchTimeline(project.name).catch(() => []),
          completedRuns[0] ? fetchRunDetail(completedRuns[0].id).catch(() => null) : Promise.resolve(null),
        ])

        return {
          project,
          runs: projectRuns,
          keywords: kws,
          competitors: comps,
          timeline,
          latestRunDetail: latestRunDetail,
        }
      }),
    )

    return buildDashboard(projectDataList)
  } catch {
    return null
  }
}

export function App({
  initialPathname,
  initialDashboard,
  initialHealthSnapshot,
  enableLiveStatus = true,
}: AppProps) {
  const [dashboard, setDashboard] = useState<DashboardVm | null>(
    initialDashboard ?? null,
  )
  const [loading, setLoading] = useState(!initialDashboard)
  const [apiConnected, setApiConnected] = useState<boolean | null>(initialDashboard ? true : null)
  const [pathname, setPathname] = useState(() => getInitialPathname(initialPathname))
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [drawerState, setDrawerState] = useState<DrawerState>(null)
  const [healthSnapshot, setHealthSnapshot] = useState<HealthSnapshot>(
    initialHealthSnapshot ?? defaultHealthSnapshot,
  )

  const refreshData = useCallback(async () => {
    const data = await loadDashboardData()
    if (data) {
      setDashboard(data)
      setApiConnected(true)
    } else {
      setApiConnected(false)
    }
    setLoading(false)
  }, [])

  // Initial data load from API
  useEffect(() => {
    if (initialDashboard) return
    void refreshData()
  }, [initialDashboard, refreshData])

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

  // Health check polling — uses /health endpoint from canonry serve
  useEffect(() => {
    if (!enableLiveStatus || typeof window === 'undefined') {
      return
    }

    let active = true

    const refresh = async () => {
      const apiStatus = await fetchServiceStatus('/health', 'API')
      // Single-process local server has no separate worker
      const workerStatus: ServiceStatus = apiStatus.state === 'ok'
        ? { label: 'Runner', state: 'ok', detail: 'In-process job runner' }
        : { label: 'Runner', state: apiStatus.state, detail: 'Depends on API' }

      if (!active) {
        return
      }

      setHealthSnapshot({ apiStatus, workerStatus })
    }

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 15_000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [enableLiveStatus])

  // Show disconnected state when API is unreachable (no mock data fallback)
  if (!loading && !dashboard && apiConnected === false) {
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
              <Button type="button" onClick={() => { setLoading(true); void refreshData() }}>
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
  const projectPath = activeProject
    ? `/projects/${activeProject.project.id}`
    : safeDashboard.projects[0]
      ? `/projects/${safeDashboard.projects[0].project.id}`
      : '/setup'

  const navigate = (to: string) => {
    const nextPath = normalizePathname(to)

    if (typeof window === 'undefined') {
      setPathname(nextPath)
      return
    }

    if (normalizePathname(window.location.pathname) !== nextPath) {
      window.history.pushState({}, '', nextPath)
    }

    setPathname(nextPath)
  }

  const openRun = (runId?: string) => {
    if (!runId) {
      return
    }

    setDrawerState({ kind: 'run', runId })
  }

  const openEvidence = (evidenceId: string) => {
    setDrawerState({ kind: 'evidence', evidenceId })
  }

  const handleTriggerRun = async (projectName: string) => {
    try {
      await apiTriggerRun(projectName)
      void refreshData()
    } catch (err) {
      console.error('Failed to trigger run:', err)
    }
  }

  const handleDeleteProject = async (projectName: string) => {
    try {
      await apiDeleteProject(projectName)
      navigate('/')
      void refreshData()
    } catch (err) {
      console.error('Failed to delete project:', err)
    }
  }

  const systemHealthCards = buildSystemHealthCards(safeDashboard.portfolioOverview.systemHealth, healthSnapshot, safeDashboard.settings)
  const setupModel = buildSetupModel(safeDashboard.setup, healthSnapshot, safeDashboard.settings)
  const selectedRun = drawerState?.kind === 'run' ? findRunById(safeDashboard, drawerState.runId) : undefined
  const selectedEvidenceContext =
    drawerState?.kind === 'evidence' ? findEvidenceById(safeDashboard, drawerState.evidenceId) : undefined

  const mainNavItems = [
    { label: 'Overview', href: '/', icon: LayoutDashboard, active: isNavActive(route, 'overview') },
    { label: 'Projects', href: projectPath, icon: Globe, active: isNavActive(route, 'project') },
    { label: 'Runs', href: '/runs', icon: Play, active: isNavActive(route, 'runs') },
    { label: 'Settings', href: '/settings', icon: Settings, active: isNavActive(route, 'settings') },
  ]

  const primaryAction =
    route.kind === 'project' && activeProject
      ? {
          label: 'Run now',
          action: () => openRun(findLatestRunForProject(safeDashboard, activeProject.project.id)?.id),
        }
      : {
          label: safeDashboard.projects.length > 0 ? 'Open project' : 'Launch setup',
          action: () => navigate(safeDashboard.projects.length > 0 ? projectPath : '/setup'),
        }

  const breadcrumbLabel =
    route.kind === 'overview'
      ? 'Portfolio'
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
          <a href="/" onClick={createNavigationHandler(navigate, '/')}>
            <span className="brand-mark">Canonry</span>
            <p className="brand-subtitle">AEO Monitor</p>
          </a>
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

          <p className="sidebar-section-title">Resources</p>
          <a
            className="sidebar-link"
            href="/setup"
            aria-current={route.kind === 'setup' ? 'page' : undefined}
            onClick={createNavigationHandler(navigate, '/setup')}
          >
            <Rocket className="sidebar-icon" />
            <span>Setup</span>
          </a>
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
              <a className="brand-mark" href="/" onClick={createNavigationHandler(navigate, '/')}>
                Canonry
              </a>
            </div>
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <a href="/" onClick={createNavigationHandler(navigate, '/')}>
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
            <Button className="topbar-cta" type="button" onClick={primaryAction.action}>
              {primaryAction.label}
            </Button>
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
          {loading ? (
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
              {route.kind === 'project' && activeProject ? (
                <ProjectPage model={activeProject} onOpenEvidence={openEvidence} onOpenRun={openRun} onTriggerRun={handleTriggerRun} onDeleteProject={handleDeleteProject} />
              ) : null}
              {route.kind === 'runs' ? <RunsPage runs={safeDashboard.runs} onOpenRun={openRun} /> : null}
              {route.kind === 'settings' ? (
                <SettingsPage settings={safeDashboard.settings} healthSnapshot={healthSnapshot} />
              ) : null}
              {route.kind === 'setup' ? <SetupPage model={setupModel} onProjectCreated={refreshData} onNavigate={navigate} /> : null}
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
          subtitle={`${selectedRun.projectName} · ${selectedRun.kindLabel}`}
          onClose={() => setDrawerState(null)}
        >
          <div className="detail-grid">
            <div>
              <p className="detail-label">Status</p>
              <StatusBadge status={selectedRun.status} />
            </div>
            <div>
              <p className="detail-label">Started</p>
              <p>{selectedRun.startedAt}</p>
            </div>
            <div>
              <p className="detail-label">Duration</p>
              <p>{selectedRun.duration}</p>
            </div>
            <div>
              <p className="detail-label">Trigger</p>
              <p>{selectedRun.triggerLabel}</p>
            </div>
          </div>
          <p className="drawer-copy">{selectedRun.statusDetail}</p>
        </Drawer>
      ) : null}

      {selectedEvidenceContext ? (
        <Drawer
          open={selectedEvidenceContext !== undefined}
          title={selectedEvidenceContext.evidence.keyword}
          subtitle={`${selectedEvidenceContext.project.project.name} · visibility evidence`}
          onClose={() => setDrawerState(null)}
        >
          <div className="detail-grid">
            <div>
              <p className="detail-label">Citation state</p>
              <CitationBadge state={selectedEvidenceContext.evidence.citationState} />
            </div>
            <div>
              <p className="detail-label">Change</p>
              <p>{selectedEvidenceContext.evidence.changeLabel}</p>
            </div>
          </div>
          <p className="drawer-copy">"{selectedEvidenceContext.evidence.answerSnippet}"</p>
          <div className="drawer-section">
            <p className="detail-label">Cited domains</p>
            <p>{selectedEvidenceContext.evidence.citedDomains.join(', ')}</p>
          </div>
          <div className="drawer-section">
            <p className="detail-label">Evidence URLs</p>
            <ul className="detail-list">
              {selectedEvidenceContext.evidence.evidenceUrls.map((url) => (
                <li key={url}>{url}</li>
              ))}
            </ul>
          </div>
          <div className="drawer-section">
            <p className="detail-label">Competitor overlap</p>
            <p>{selectedEvidenceContext.evidence.competitorDomains.join(', ')}</p>
          </div>
          <div className="drawer-section">
            <p className="detail-label">Related technical signals</p>
            <ul className="detail-list">
              {selectedEvidenceContext.evidence.relatedTechnicalSignals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          </div>
        </Drawer>
      ) : null}
    </div>
  )
}

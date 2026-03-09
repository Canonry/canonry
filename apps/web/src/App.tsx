import { useEffect, useId, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'

import { Menu } from 'lucide-react'

import { Badge } from './components/ui/badge.js'
import { Button } from './components/ui/button.js'
import { Card } from './components/ui/card.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './components/ui/sheet.js'
import { createDashboardFixture, findEvidenceById, findProjectVm, findRunById } from './mock-data.js'
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
  { label: 'Self-Hosting', href: 'https://github.com/AINYC/canonry/blob/main/docs/self-hosting.md' },
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

function Sparkline({ points, tone }: { points: number[]; tone: MetricTone }) {
  const clipId = useId()
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
          <p className="metric-inline-value">{project.readinessScore}</p>
          <p className="metric-inline-delta">{project.readinessDelta}</p>
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
    <>
      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">Portfolio overview</p>
          <h1>Portfolio</h1>
          <p className="lede">Answer visibility, technical readiness, and execution state in one compact view.</p>
        </div>
        <div className="hero-stack">
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
                <p className="eyebrow eyebrow-soft">Recent run state</p>
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
      </section>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Projects</p>
            <h2>Portfolio ranking</h2>
          </div>
          <p className="supporting-copy">Compact rows, separate signals.</p>
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
            <h2>Trust the monitoring layer</h2>
          </div>
          <p className="supporting-copy">Operational confidence stays visible, but secondary.</p>
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
    </>
  )
}

function ProjectPage({
  model,
  onOpenEvidence,
  onOpenRun,
}: {
  model: ProjectCommandCenterVm
  onOpenEvidence: (evidenceId: string) => void
  onOpenRun: (runId?: string) => void
}) {
  return (
    <>
      <section className="hero-grid hero-grid-project">
        <div className="hero-copy">
          <p className="eyebrow">Project command center</p>
          <h1>{model.project.name}</h1>
          <p className="lede">{model.project.canonicalDomain} · {model.contextLabel}</p>
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
        <Card className="surface-card hero-action">
          <p className="eyebrow eyebrow-soft">Monitoring window</p>
          <h2>{model.dateRangeLabel}</h2>
          <p className="supporting-copy">
            Use the summary cards to separate visibility movement from readiness drift, then move into evidence.
          </p>
          <Button type="button" onClick={() => onOpenRun(model.recentRuns[0]?.id)}>
            Run now
          </Button>
        </Card>
      </section>

      <section className="metric-grid">
        <MetricCard metric={model.visibilitySummary} />
        <MetricCard metric={model.readinessSummary} />
        <MetricCard metric={model.competitorPressure} />
        <MetricCard metric={model.runStatus} />
      </section>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">What changed</p>
            <h2>Interpretation before raw evidence</h2>
          </div>
        </div>
        <div className="insight-grid">
          {model.insights.map((insight) => (
            <Card key={insight.id} className="surface-card insight-card">
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

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Visibility evidence</p>
            <h2>Why you are or are not cited</h2>
          </div>
          <p className="supporting-copy">Answer snippets, cited domains, competitor overlap, and technical context.</p>
        </div>
        <div className="evidence-grid">
          {model.visibilityEvidence.map((item) => (
            <Card key={item.id} className="surface-card evidence-card">
              <div className="section-head">
                <div>
                  <p className="evidence-keyword">{item.keyword}</p>
                  <p className="supporting-copy">{item.changeLabel}</p>
                </div>
                <CitationBadge state={item.citationState} />
              </div>
              <p className="evidence-summary">{item.summary}</p>
              <p className="evidence-snippet">“{item.answerSnippet}”</p>
              <Button variant="outline" size="sm" type="button" onClick={() => onOpenEvidence(item.id)}>
                View evidence
              </Button>
            </Card>
          ))}
        </div>
      </section>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Technical findings</p>
            <h2>Readiness signals connected to visibility</h2>
          </div>
        </div>
        <div className="finding-grid">
          {model.technicalFindings.map((finding) => (
            <Card key={finding.id} className="surface-card finding-card">
              <div className="section-head">
                <ToneBadge tone={toneFromFindingSeverity(finding.severity)}>{toTitleCase(finding.severity)}</ToneBadge>
              </div>
              <h3>{finding.title}</h3>
              <p>{finding.detail}</p>
              <p className="supporting-copy">Impact: {finding.impact}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Competitors</p>
            <h2>Who is displacing you</h2>
          </div>
        </div>
        <div className="competitor-grid">
          {model.competitors.map((competitor) => (
            <Card key={competitor.id} className="surface-card competitor-card">
              <div className="section-head">
                <h3>{competitor.domain}</h3>
                <ToneBadge tone={competitor.pressureLabel === 'High' ? 'negative' : 'caution'}>
                  {competitor.pressureLabel}
                </ToneBadge>
              </div>
              <p>{competitor.movement}</p>
              <p className="supporting-copy">{competitor.notes}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="page-section">
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
    </>
  )
}

function RunsPage({ runs, onOpenRun }: { runs: RunListItemVm[]; onOpenRun: (runId: string) => void }) {
  const [filter, setFilter] = useState<RunFilter>('all')
  const filteredRuns = filter === 'all' ? runs : runs.filter((run) => run.status === filter)

  return (
    <>
      <section className="hero-grid hero-grid-compact">
        <div className="hero-copy">
          <p className="eyebrow">Runs</p>
          <h1>Operational timeline</h1>
          <p className="lede">Status, type, project, duration, and the shortest explanation that makes the outcome trustworthy.</p>
        </div>
      </section>

      <section className="page-section">
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
    </>
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
    <>
      <section className="hero-grid hero-grid-compact">
        <div className="hero-copy">
          <p className="eyebrow">Settings</p>
          <h1>Settings</h1>
          <p className="lede">Provider state, quotas, and service health. Nothing more than the dashboard needs.</p>
        </div>
      </section>

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
              <h2>Keep operational detail sparse</h2>
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
    </>
  )
}

function SetupPage({ model }: { model: SetupWizardVm }) {
  return (
    <>
      <section className="hero-grid hero-grid-compact">
        <div className="hero-copy">
          <p className="eyebrow">Setup</p>
          <h1>Setup</h1>
          <p className="lede">Create a project, import keywords, add competitors, and launch the first run.</p>
        </div>
      </section>

      <section className="setup-grid">
        <Card className="surface-card step-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Step 1</p>
              <h2>System ready</h2>
            </div>
          </div>
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
        </Card>

        <Card className="surface-card step-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Step 2</p>
              <h2>Create project</h2>
            </div>
          </div>
          <dl className="definition-list">
            <div>
              <dt>Name</dt>
              <dd>{model.projectDraft.name}</dd>
            </div>
            <div>
              <dt>Domain</dt>
              <dd>{model.projectDraft.canonicalDomain}</dd>
            </div>
            <div>
              <dt>Locale</dt>
              <dd>
                {model.projectDraft.country} / {model.projectDraft.language.toUpperCase()}
              </dd>
            </div>
          </dl>
        </Card>

        <Card className="surface-card step-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Step 3</p>
              <h2>Import or paste keywords</h2>
            </div>
            <ToneBadge tone="neutral">{model.keywordImportState.keywordCount} keywords</ToneBadge>
          </div>
          <p className="supporting-copy">
            Mode: {model.keywordImportState.mode === 'paste' ? 'Paste list' : 'CSV import'}
          </p>
          <ul className="detail-list">
            {model.keywordImportState.preview.map((keyword) => (
              <li key={keyword}>{keyword}</li>
            ))}
          </ul>
        </Card>

        <Card className="surface-card step-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Step 4</p>
              <h2>Add competitors</h2>
            </div>
          </div>
          <ul className="detail-list">
            {model.competitorDraft.domains.map((domain) => (
              <li key={domain}>{domain}</li>
            ))}
          </ul>
          <p className="supporting-copy">{model.competitorDraft.notes}</p>
        </Card>

        <Card className="surface-card step-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Step 5</p>
              <h2>Launch first run</h2>
            </div>
          </div>
          <p>{model.launchState.summary}</p>
          {model.launchState.blockedReason ? (
            <p className="blocking-copy">{model.launchState.blockedReason}</p>
          ) : null}
          <Button type="button" disabled={!model.launchState.enabled}>
            {model.launchState.ctaLabel}
          </Button>
        </Card>
      </section>
    </>
  )
}

function NotFoundPage({ onNavigate }: { onNavigate: (to: string) => void }) {
  return (
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

export function App({
  initialPathname,
  initialDashboard,
  initialHealthSnapshot,
  enableLiveStatus = true,
}: AppProps) {
  const dashboard = initialDashboard ?? defaultFixture.dashboard
  const [pathname, setPathname] = useState(() => getInitialPathname(initialPathname))
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [drawerState, setDrawerState] = useState<DrawerState>(null)
  const [healthSnapshot, setHealthSnapshot] = useState<HealthSnapshot>(
    initialHealthSnapshot ?? defaultFixture.health ?? defaultHealthSnapshot,
  )

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

  useEffect(() => {
    if (!enableLiveStatus || typeof window === 'undefined') {
      return
    }

    let active = true

    const refresh = async () => {
      const [apiStatus, workerStatus] = await Promise.all([
        fetchServiceStatus('/api-health', 'API'),
        fetchServiceStatus('/worker-health', 'Worker'),
      ])

      if (!active) {
        return
      }

      setHealthSnapshot({ apiStatus, workerStatus })
    }

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 10_000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [enableLiveStatus])

  const route = resolveRoute(pathname, dashboard)
  const activeProject = route.kind === 'project' ? findProjectVm(dashboard, route.projectId) : undefined
  const projectPath = activeProject
    ? `/projects/${activeProject.project.id}`
    : dashboard.projects[0]
      ? `/projects/${dashboard.projects[0].project.id}`
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

  const systemHealthCards = buildSystemHealthCards(dashboard.portfolioOverview.systemHealth, healthSnapshot, dashboard.settings)
  const setupModel = buildSetupModel(dashboard.setup, healthSnapshot, dashboard.settings)
  const selectedRun = drawerState?.kind === 'run' ? findRunById(dashboard, drawerState.runId) : undefined
  const selectedEvidenceContext =
    drawerState?.kind === 'evidence' ? findEvidenceById(dashboard, drawerState.evidenceId) : undefined

  const navItems = [
    { label: 'Overview', href: '/', active: isNavActive(route, 'overview') },
    { label: 'Projects', href: projectPath, active: isNavActive(route, 'project') },
    { label: 'Runs', href: '/runs', active: isNavActive(route, 'runs') },
    { label: 'Settings', href: '/settings', active: isNavActive(route, 'settings') },
  ]

  const primaryAction =
    route.kind === 'project' && activeProject
      ? {
          label: 'Run now',
          action: () => openRun(findLatestRunForProject(dashboard, activeProject.project.id)?.id),
        }
      : {
          label: dashboard.projects.length > 0 ? 'Open project' : 'Launch setup',
          action: () => navigate(dashboard.projects.length > 0 ? projectPath : '/setup'),
        }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>

      <header className="topbar">
        <div className="brand-lockup">
          <a className="brand-mark" href="/" onClick={createNavigationHandler(navigate, '/')}>
            Canonry
          </a>
          <p className="brand-subtitle">Monitoring</p>
        </div>

        <nav className="topnav" aria-label="Primary">
          {navItems.map((item) => (
            <a
              key={item.label}
              className={`topnav-link ${item.active ? 'topnav-link-active' : ''}`}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              onClick={createNavigationHandler(navigate, item.href)}
            >
              {item.label}
            </a>
          ))}
        </nav>

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

      <div id="mobile-nav" className={`mobile-nav ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
        {navItems.map((item) => (
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
      </div>

      <main id="content" className="page-shell">
        {route.kind === 'overview' ? (
          <OverviewPage
            model={dashboard.portfolioOverview}
            systemHealth={systemHealthCards}
            onNavigate={navigate}
            onOpenRun={openRun}
          />
        ) : null}
        {route.kind === 'project' && activeProject ? (
          <ProjectPage model={activeProject} onOpenEvidence={openEvidence} onOpenRun={openRun} />
        ) : null}
        {route.kind === 'runs' ? <RunsPage runs={dashboard.runs} onOpenRun={openRun} /> : null}
        {route.kind === 'settings' ? (
          <SettingsPage settings={dashboard.settings} healthSnapshot={healthSnapshot} />
        ) : null}
        {route.kind === 'setup' ? <SetupPage model={setupModel} /> : null}
        {route.kind === 'not-found' ? <NotFoundPage onNavigate={navigate} /> : null}
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
          <p className="drawer-copy">“{selectedEvidenceContext.evidence.answerSnippet}”</p>
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

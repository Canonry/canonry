import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { parseAllDocuments } from 'yaml'
import type { MouseEvent, ReactNode } from 'react'

import * as Dialog from '@radix-ui/react-dialog'
import {
  Activity,
  ChevronRight,
  Download,
  Globe,
  LayoutDashboard,
  Menu,
  Play,
  Plus,
  Rocket,
  Settings,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { effectiveDomains, normalizeProjectDomain } from '@ainyc/canonry-contracts'

import { Badge } from './components/ui/badge.js'
import { Button } from './components/ui/button.js'
import { Card } from './components/ui/card.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './components/ui/sheet.js'
import { createDashboardFixture, findEvidenceById, findProjectVm, findRunById } from './mock-data.js'
import {
  appendKeywords,
  deleteKeywords,
  createProject,
  fetchAllRuns,
  triggerAllRuns,
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
  fetchSettings,
  updateProviderConfig,
  updateGoogleAuthConfig,
  fetchSchedule,
  saveSchedule,
  removeSchedule,
  listNotifications,
  addNotification,
  removeNotification,
  sendTestNotification,
  applyProjectConfig,
  generateKeywords as apiGenerateKeywords,
  updateOwnedDomains,
  updateProject,
  fetchGoogleConnections,
  fetchGoogleProperties,
  googleConnect,
  googleDisconnect,
  saveGoogleProperty,
  triggerGscSync,
  fetchGscPerformance,
  inspectGscUrl,
  fetchGscInspections,
  fetchGscDeindexed,
  fetchGscCoverage,
  fetchGscCoverageHistory,
  triggerInspectSitemap,
  triggerDiscoverSitemaps,
  saveSitemapUrl,
  fetchGscSitemaps,
  type ApiGscSitemap,
  addLocation,
  removeLocation,
  setDefaultLocation,
  type ApiLocation,
  type ApiGscCoverageSummary,
  type ApiSchedule,
  type ApiNotification,
  type ApiGoogleConnection,
  type ApiGoogleProperty,
  type ApiGscPerformanceRow,
  type ApiGscInspection,
  type ApiGscDeindexedRow,
  type GroundingSource,
} from './api.js'
import { buildDashboard } from './build-dashboard.js'
import type { ProjectData } from './build-dashboard.js'
import type {
  CitationInsightVm,
  CitationState,
  DashboardVm,
  HealthSnapshot,
  MetricTone,
  PortfolioOverviewVm,
  PortfolioProjectVm,
  ProjectCommandCenterVm,
  RunFilter,
  RunHistoryPoint,
  RunListItemVm,
  ServiceStatus,
  SettingsVm,
  SetupWizardVm,
  SystemHealthCardVm,
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

type ProjectPageTab = 'overview' | 'search-console'

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
      return 'caution'
    case 'not-cited':
      return 'caution'
    case 'lost':
      return 'negative'
    case 'pending':
      return 'neutral'
  }
}

function formatErrorLog(error: string): string {
  // Extract the human-readable prefix and try to pretty-print any JSON within
  const bracketMatch = error.match(/^(\[.*?\])\s*(.+)/)
  if (bracketMatch) {
    const prefix = bracketMatch[1]
    const rest = bracketMatch[2]
    // Try to find and pretty-print embedded JSON
    const jsonStart = rest.indexOf('{')
    if (jsonStart >= 0) {
      const message = rest.slice(0, jsonStart).trim()
      const jsonPart = rest.slice(jsonStart)
      try {
        const parsed = JSON.parse(jsonPart)
        return `${prefix} ${message}\n\n${JSON.stringify(parsed, null, 2)}`
      } catch {
        // Not valid JSON, just format the text
      }
    }
    return `${prefix}\n${rest}`
  }
  // Try to pretty-print the whole thing as JSON
  try {
    const parsed = JSON.parse(error)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return error
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

    const configuredCount = settings.providerStatuses.filter(p => p.state === 'ready').length
    const totalCount = settings.providerStatuses.length
    const allReady = configuredCount > 0
    const configuredNames = settings.providerStatuses.filter(p => p.state === 'ready').map(p => PROVIDER_DISPLAY_NAMES[p.name] ?? p.name).join(' · ')
    return {
      ...card,
      label: 'Providers',
      tone: allReady ? 'positive' : 'caution',
      detail: `${configuredCount} of ${totalCount} configured`,
      meta: configuredNames || 'None configured',
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

  if (!settings.providerStatuses.some(p => p.state === 'ready')) {
    return 'Launch is blocked until at least one provider is configured.'
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

    const anyReady = settings.providerStatuses.some(p => p.state === 'ready')
    return {
      ...check,
      detail: anyReady ? 'At least one provider configured.' : 'No providers configured.',
      state: anyReady ? 'ready' : 'attention',
    }
  })

  model.launchState.enabled = blockedReason === undefined
  model.launchState.blockedReason = blockedReason
  model.launchState.summary =
    blockedReason ?? 'Queue a visibility sweep first, then follow with a site audit to explain movement.'

  return model
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
   Presentational components
   ──────────────────────────────────────────── */

function BrandLockup({ compact = false, navigate }: { compact?: boolean; navigate: (to: string) => void }) {
  return (
    <a
      className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}
      href="/"
      aria-label="Canonry home"
      onClick={createNavigationHandler(navigate, '/')}
    >
      <img className="brand-icon" src="/favicon.svg" alt="" aria-hidden="true" />
      <span className="brand-copy">
        <span className="brand-mark">Canonry</span>
        {compact ? null : <span className="brand-subtitle">AEO Monitor</span>}
      </span>
    </a>
  )
}

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

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="info-tooltip-wrapper">
      <svg className="info-tooltip-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7v4M8 5.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="info-tooltip-bubble" role="tooltip">{text}</span>
    </span>
  )
}

function ScoreGauge({
  value,
  label,
  delta,
  tone,
  description,
  tooltip,
  isNumeric = true,
}: {
  value: string
  label: string
  delta: string
  tone: MetricTone
  description: string
  tooltip?: string
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
      <p className="gauge-label">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
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
              {run.projectName}{run.location ? ` · ${run.location}` : ''} · {run.kindLabel}
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

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    gemini: 'border-blue-800/50 bg-blue-950/40 text-blue-300',
    openai: 'border-green-800/50 bg-green-950/40 text-green-300',
    claude: 'border-amber-800/50 bg-amber-950/40 text-amber-300',
    local: 'border-purple-800/50 bg-purple-950/40 text-purple-300',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${colors[provider] ?? 'border-zinc-700 bg-zinc-800 text-zinc-300'}`}>
      {provider}
    </span>
  )
}

function InsightSignals({
  insights,
  onOpenEvidence,
}: {
  insights: ProjectCommandCenterVm['insights']
  onOpenEvidence: (evidenceId: string) => void
}) {
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
                      onClick={(e) => { e.stopPropagation(); onOpenEvidence(ap.evidenceId) }}
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

/** Inline dot chart showing citation history over recent runs. */
function CitationTimeline({ history, maxDots = 12 }: { history: RunHistoryPoint[]; maxDots?: number }) {
  const dots = history.slice(-maxDots)
  if (dots.length === 0) return <span className="text-[11px] text-zinc-600">No data</span>

  const colorMap: Record<string, string> = {
    cited: 'bg-emerald-400',
    'not-cited': 'bg-zinc-600',
    lost: 'bg-rose-400',
    emerging: 'bg-amber-400 ring-1 ring-amber-300/60',
  }

  const firstDate = new Date(dots[0].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const lastDate = new Date(dots[dots.length - 1].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-zinc-600 shrink-0">{firstDate}</span>
      <div className="flex items-center gap-[3px]" title={`${dots.length} runs`}>
        {dots.map((d, i) => (
          <div
            key={i}
            className={`h-2.5 w-2.5 rounded-sm ${colorMap[d.citationState] ?? 'bg-zinc-700'} ${
              d.model && i > 0 && dots[i - 1]?.model && dots[i - 1]!.model !== d.model
                ? 'ring-1 ring-amber-300/80 ring-offset-1 ring-offset-zinc-950'
                : ''
            }`}
            title={[
              d.citationState,
              new Date(d.createdAt).toLocaleDateString(),
              d.model ? `model ${d.model}` : null,
              d.model && i > 0 && dots[i - 1]?.model && dots[i - 1]!.model !== d.model ? 'model changed' : null,
            ].filter(Boolean).join(' — ')}
          />
        ))}
      </div>
      <span className="text-[9px] text-zinc-600 shrink-0">{lastDate}</span>
    </div>
  )
}

/** Aggregate citation timeline from multiple provider histories into a single merged timeline. */
function mergeProviderHistories(items: CitationInsightVm[]): RunHistoryPoint[] {
  // Collect all states + runId per run timestamp across providers.
  const byRun = new Map<string, { states: string[]; runId: string }>()
  for (const item of items) {
    for (const h of item.runHistory) {
      const existing = byRun.get(h.createdAt)
      if (existing) existing.states.push(h.citationState)
      else byRun.set(h.createdAt, { states: [h.citationState], runId: h.runId })
    }
  }
  // For each run, pick the best state: cited > emerging > not-cited
  const sorted = [...byRun.entries()].sort(([a], [b]) => a.localeCompare(b))
  return sorted.map(([createdAt, { states, runId }]) => ({
    runId,
    createdAt,
    citationState: states.includes('cited') ? 'cited'
      : states.includes('emerging') ? 'emerging'
      : 'not-cited',
  }))
}

function EvidenceTable({
  evidence,
  onOpenEvidence,
}: {
  evidence: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
}) {
  const [expandedPhrases, setExpandedPhrases] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const map = new Map<string, CitationInsightVm[]>()
    for (const item of evidence) {
      const existing = map.get(item.keyword) ?? []
      map.set(item.keyword, [...existing, item])
    }
    return [...map.entries()].map(([phrase, items]) => ({ phrase, items }))
  }, [evidence])

  const togglePhrase = (phrase: string) => {
    setExpandedPhrases(prev => {
      const next = new Set(prev)
      if (next.has(phrase)) next.delete(phrase)
      else next.add(phrase)
      return next
    })
  }

  return (
    <div className="evidence-table-wrap">
      <table className="evidence-table">
        <thead>
          <tr>
            <th style={{ width: '2rem' }} />
            <th>Key Phrase</th>
            <th>Status</th>
            <th>Citation History</th>
            <th>Change</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map(({ phrase, items }) => {
            const isExpanded = expandedPhrases.has(phrase)
            const states = items.map(i => i.citationState)
            const aggState: CitationState =
              states.includes('cited') ? 'cited' :
              states.includes('emerging') ? 'emerging' :
              states.includes('lost') ? 'lost' :
              states.every(s => s === 'pending') ? 'pending' : 'not-cited'

            const mergedHistory = mergeProviderHistories(items)
            const citedCount = items.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length

            // Compute phrase-level change label from merged history
            const aggChangeLabel = (() => {
              if (mergedHistory.length === 0) return 'Awaiting first run'
              if (mergedHistory.length === 1) return 'First observation'
              const latest = mergedHistory[mergedHistory.length - 1]!.citationState
              const prev = mergedHistory[mergedHistory.length - 2]!.citationState
              if (prev !== 'cited' && latest === 'cited') return 'Newly cited'
              if (prev === 'cited' && latest !== 'cited') return 'Lost since last run'
              // Count streak
              let streak = 0
              for (let i = mergedHistory.length - 1; i >= 0; i--) {
                if (mergedHistory[i]!.citationState === latest) streak++
                else break
              }
              if (latest === 'cited') return streak <= 1 ? 'Cited in latest run' : `Cited for ${streak} runs`
              return streak <= 1 ? 'Not cited in latest run' : `Not cited across ${streak} runs`
            })()

            return (
              <Fragment key={phrase}>
                <tr
                  className="evidence-phrase-row cursor-pointer hover:bg-zinc-800/40"
                  onClick={() => togglePhrase(phrase)}
                  aria-expanded={isExpanded}
                >
                  <td>
                    <ChevronRight
                      size={14}
                      className={`transition-transform duration-150 text-zinc-500 ${isExpanded ? 'rotate-90' : ''}`}
                    />
                  </td>
                  <td className="evidence-keyword-cell">
                    <div>
                      <span className="font-medium text-zinc-100">{phrase}</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {items.map(item => (
                          <ProviderBadge key={item.id} provider={item.provider} />
                        ))}
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <CitationBadge state={aggState} />
                      <span className="text-[11px] text-zinc-500">{citedCount}/{items.length}</span>
                    </div>
                  </td>
                  <td>
                    <CitationTimeline history={mergedHistory} />
                  </td>
                  <td className="evidence-change-cell">
                    {aggChangeLabel}
                  </td>
                  <td />
                </tr>
                {isExpanded && items.map(item => (
                  <tr key={item.id} className="bg-zinc-900/30">
                    <td />
                    <td className="evidence-keyword-cell pl-5">
                      <ProviderBadge provider={item.provider} />
                    </td>
                    <td><CitationBadge state={item.citationState} /></td>
                    <td>
                      <CitationTimeline history={item.runHistory} />
                    </td>
                    <td className="evidence-change-cell">{item.changeLabel}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenEvidence(item.id) }}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ────────────────────────────────────────────
   Evidence phrase cards (redesigned evidence tracking)
   ──────────────────────────────────────────── */

function EvidencePhraseCard({
  phrase,
  items,
  onOpenEvidence,
  showLocationLabels = true,
  compareLocations = false,
  timelineLoading = false,
  onDeleteKeyword,
}: {
  phrase: string
  items: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
  showLocationLabels?: boolean
  compareLocations?: boolean
  timelineLoading?: boolean
  onDeleteKeyword?: () => void
}) {
  const states = items.map(i => i.citationState)
  const aggState: CitationState =
    states.includes('cited') ? 'cited' :
    states.includes('emerging') ? 'emerging' :
    states.includes('lost') ? 'lost' :
    states.every(s => s === 'pending') ? 'pending' : 'not-cited'

  const mergedHistory = mergeProviderHistories(items)
  const citedCount = items.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length

  const trendDir: 'up' | 'down' | 'flat' = (() => {
    if (mergedHistory.length < 4) return 'flat'
    const recent = mergedHistory.slice(-3)
    const older = mergedHistory.slice(-6, -3)
    if (older.length === 0) return 'flat'
    const recentCited = recent.filter(p => p.citationState === 'cited' || p.citationState === 'emerging').length
    const olderCited = older.filter(p => p.citationState === 'cited' || p.citationState === 'emerging').length
    if (recentCited > olderCited) return 'up'
    if (recentCited < olderCited) return 'down'
    return 'flat'
  })()

  const changeLabel = (() => {
    if (mergedHistory.length === 0) return 'Awaiting first run'
    if (mergedHistory.length === 1) return 'First observation'
    const latest = mergedHistory[mergedHistory.length - 1]!.citationState
    const prev = mergedHistory[mergedHistory.length - 2]!.citationState
    const latestCited = latest === 'cited' || latest === 'emerging'
    const prevCited = prev === 'cited' || prev === 'emerging'
    if (!prevCited && latestCited) return 'Newly cited'
    if (prevCited && !latestCited) return 'Lost citation'
    let streak = 0
    for (let i = mergedHistory.length - 1; i >= 0; i--) {
      const s = mergedHistory[i]!.citationState
      const isCited = s === 'cited' || s === 'emerging'
      if (isCited === latestCited) streak++
      else break
    }
    if (latestCited) return streak <= 1 ? 'Cited in latest run' : `Cited ${streak} runs in a row`
    return streak <= 1 ? 'Missed in latest run' : `Missed for ${streak} runs`
  })()

  const trendIcon = trendDir === 'up' ? '↑' : trendDir === 'down' ? '↓' : '→'

  return (
    <div className={`evidence-phrase-card evidence-phrase-card--${aggState}`}>
      <div className="evidence-card-header">
        <div className="min-w-0 flex-1">
          <p className="evidence-card-keyword">{phrase}</p>
          <div className="evidence-card-status-row">
            <CitationBadge state={aggState} />
            <span className={`evidence-card-trend evidence-card-trend--${trendDir}`}>
              <span aria-hidden="true">{trendIcon}</span>
              <span>{changeLabel}</span>
            </span>
          </div>
        </div>
        {onDeleteKeyword && (
          <button
            type="button"
            className="ml-2 shrink-0 text-zinc-600 hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500"
            onClick={onDeleteKeyword}
            title={`Remove "${phrase}"`}
            aria-label={`Remove key phrase "${phrase}"`}
          >
            ×
          </button>
        )}
      </div>

      <div className={`evidence-card-timeline-row${timelineLoading ? ' opacity-40 pointer-events-none' : ''}`}>
        {timelineLoading
          ? <span className="text-[10px] text-zinc-500 italic animate-pulse">Loading…</span>
          : <CitationTimeline history={mergedHistory} maxDots={14} />
        }
        <span className="evidence-card-ratio">
          {citedCount}/{items.length} provider{items.length !== 1 ? 's' : ''}
        </span>
      </div>

      {compareLocations ? (() => {
        // Group items by location for side-by-side comparison
        const locationGroups = Array.from(
          items.reduce((map, item) => {
            const key = item.location ?? ''
            const existing = map.get(key) ?? []
            map.set(key, [...existing, item])
            return map
          }, new Map<string, CitationInsightVm[]>()),
        ).map(([loc, locItems]) => ({ loc: loc || 'No location', locItems }))
        return (
          <div className="evidence-card-location-compare">
            {locationGroups.map(({ loc, locItems }) => {
              const locCited = locItems.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length
              return (
                <div key={loc} className="evidence-card-location-row">
                  <span className="evidence-card-location-label">{loc}</span>
                  <div className="evidence-card-location-providers">
                    {locItems.filter(i => i.citationState !== 'pending').map(item => (
                      <button
                        key={item.id}
                        type="button"
                        className={`evidence-provider-btn evidence-provider-btn--${item.citationState} evidence-provider-btn--compact`}
                        onClick={() => onOpenEvidence(item.id)}
                        title={`View ${item.provider} evidence for "${phrase}" in ${loc}`}
                      >
                        <span className="capitalize">{item.provider}</span>
                        <span aria-hidden="true" className="font-bold">
                          {item.citationState === 'cited' || item.citationState === 'emerging' ? '✓' : item.citationState === 'lost' ? '✗' : '–'}
                        </span>
                      </button>
                    ))}
                    {locItems.every(i => i.citationState === 'pending') && (
                      <span className="text-xs text-zinc-500 italic">Pending</span>
                    )}
                  </div>
                  <span className="evidence-card-location-score">{locCited}/{locItems.length}</span>
                </div>
              )
            })}
          </div>
        )
      })() : (
        <div className="evidence-card-providers">
          {items.filter(item => item.citationState !== 'pending').map(item => (
            <button
              key={item.id}
              type="button"
              className={`evidence-provider-btn evidence-provider-btn--${item.citationState}`}
              onClick={() => onOpenEvidence(item.id)}
              title={`View ${item.provider} evidence for "${phrase}"`}
            >
              <span className="capitalize">{item.provider}</span>
              {item.location && showLocationLabels && <span className="text-[9px] opacity-60">{item.location}</span>}
              <span aria-hidden="true" className="font-bold">
                {item.citationState === 'cited' || item.citationState === 'emerging' ? '✓' : item.citationState === 'lost' ? '✗' : '–'}
              </span>
              <span className="opacity-50 text-[10px]">View →</span>
            </button>
          ))}
          {items.every(item => item.citationState === 'pending') && (
            <span className="text-xs text-zinc-500 italic py-1">Awaiting first run</span>
          )}
        </div>
      )}
    </div>
  )
}

function EvidencePhraseCards({
  evidence,
  onOpenEvidence,
  showLocationLabels = true,
  compareLocations = false,
  timelineLoading = false,
  onDeleteKeyword,
}: {
  evidence: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
  showLocationLabels?: boolean
  compareLocations?: boolean
  timelineLoading?: boolean
  onDeleteKeyword?: (phrase: string) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CitationInsightVm[]>()
    for (const item of evidence) {
      const existing = map.get(item.keyword) ?? []
      map.set(item.keyword, [...existing, item])
    }
    return [...map.entries()].map(([phrase, items]) => ({ phrase, items }))
  }, [evidence])

  if (groups.length === 0) {
    return <p className="supporting-copy">No key phrases tracked yet.</p>
  }

  return (
    <div className="evidence-card-grid">
      {groups.map(({ phrase, items }) => (
        <EvidencePhraseCard
          key={phrase}
          phrase={phrase}
          items={items}
          onOpenEvidence={onOpenEvidence}
          showLocationLabels={showLocationLabels}
          compareLocations={compareLocations}
          timelineLoading={timelineLoading}
          onDeleteKeyword={onDeleteKeyword ? () => onDeleteKeyword(phrase) : undefined}
        />
      ))}
    </div>
  )
}

function competitorTone(label: string): MetricTone {
  if (label === 'High') return 'negative'
  if (label === 'Moderate') return 'caution'
  if (label === 'Low') return 'neutral'
  return 'neutral'
}

function CompetitorTable({ competitors }: { competitors: ProjectCommandCenterVm['competitors'] }) {
  if (competitors.length === 0) {
    return <p className="text-sm text-zinc-500">No competitors configured. Add competitors to track overlap.</p>
  }

  return (
    <div className="competitor-table-wrap">
      <table className="competitor-table">
        <thead>
          <tr>
            <th>Domain</th>
            <th>Pressure</th>
            <th>Citations</th>
            <th>Key Phrases</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((competitor) => (
            <tr key={competitor.id}>
              <td className="font-medium text-zinc-100">{competitor.domain}</td>
              <td>
                <ToneBadge tone={competitorTone(competitor.pressureLabel)}>
                  {competitor.pressureLabel}
                </ToneBadge>
              </td>
              <td className="text-zinc-300 tabular-nums">
                {competitor.totalKeywords > 0
                  ? `${competitor.citationCount} / ${competitor.totalKeywords}`
                  : '—'}
              </td>
              <td className="text-zinc-500 text-xs">
                {competitor.citedKeywords.length > 0
                  ? competitor.citedKeywords.join(', ')
                  : 'Not cited'}
              </td>
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
    <a
      className="project-row cursor-pointer"
      href={projectPath}
      onClick={createNavigationHandler(onNavigate, projectPath)}
    >
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
      <span className="project-row-link">
        <ChevronRight className="h-4 w-4 text-zinc-500" />
      </span>
    </a>
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
          <p className="page-subtitle">Visibility and execution state across all projects</p>
        </div>
        <div className="page-header-right">
          <p className="text-[11px] text-zinc-600">{model.lastUpdatedAt}</p>
        </div>
      </div>

      {model.projects.length > 0 ? (
        <div className="project-list project-list-scrollable">
          {model.projects.map((project) => (
            <OverviewProjectCard key={project.project.id} project={project} onNavigate={onNavigate} />
          ))}
        </div>
      ) : (
        <Card className="surface-card empty-card">
          <h3>{model.emptyState?.title ?? 'No projects yet'}</h3>
          <p className="supporting-copy">{model.emptyState?.detail}</p>
          <Button size="sm" asChild>
            <a
              href={model.emptyState?.ctaHref ?? '/setup'}
              onClick={createNavigationHandler(onNavigate, model.emptyState?.ctaHref ?? '/setup')}
            >
              {model.emptyState?.ctaLabel ?? 'Launch setup'}
            </a>
          </Button>
        </Card>
      )}

      <div className="overview-secondary-grid">
        {model.attentionItems.length > 0 && (
          <section className="overview-secondary-section">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Needs attention</p>
                <h2 className="section-title-sm">What changed</h2>
              </div>
            </div>
            <div className="attention-list attention-list-scrollable">
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
          </section>
        )}

        <section className="overview-secondary-section">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Recent runs</p>
              <h2 className="section-title-sm">Activity</h2>
            </div>
          </div>
          <div className="compact-stack compact-stack-scrollable">
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
        </section>
      </div>

      <section className="page-section">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">System health</p>
            <h2 className="section-title-sm">Infrastructure</h2>
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

function ProjectsPage({
  projects,
  onNavigate,
  onProjectCreated,
}: {
  projects: ProjectCommandCenterVm[]
  onNavigate: (to: string) => void
  onProjectCreated: () => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [domain, setDomain] = useState('')
  const [country, setCountry] = useState('US')
  const [language, setLanguage] = useState('en')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

  const handleCreate = async () => {
    if (!slug || !domain) return
    setSaving(true)
    setError(null)
    try {
      const project = await createProject(slug, {
        displayName: displayName || projectName,
        canonicalDomain: domain,
        country,
        language,
      })
      onProjectCreated()
      setProjectName('')
      setDisplayName('')
      setDomain('')
      setCountry('US')
      setLanguage('en')
      setShowForm(false)
      onNavigate(`/projects/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Projects</h1>
          <p className="page-subtitle">{projects.length} project{projects.length !== 1 ? 's' : ''} tracked</p>
        </div>
        <div className="page-header-right">
          <Button type="button" onClick={() => setShowForm((v) => !v)}>
            <Plus className="size-4 mr-1.5" />
            Add project
          </Button>
        </div>
      </div>

      {showForm ? (
        <Card className="surface-card mb-6">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">New project</p>
              <h2 className="text-sm font-medium text-zinc-200">Create a new monitoring project</h2>
            </div>
          </div>
          <div className="compact-stack mt-4">
            <div className="setup-field-row">
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-project-name">Project name</label>
                <input
                  id="new-project-name"
                  className="setup-input"
                  type="text"
                  placeholder="my-project"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                />
                {slug && slug !== projectName ? (
                  <p className="supporting-copy">Slug: {slug}</p>
                ) : null}
              </div>
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-display-name">Display name</label>
                <input
                  id="new-display-name"
                  className="setup-input"
                  type="text"
                  placeholder="My Project"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            </div>
            <div className="setup-field">
              <label className="setup-label" htmlFor="new-domain">Canonical domain</label>
              <input
                id="new-domain"
                className="setup-input"
                type="text"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <div className="setup-field-row">
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-country">Country</label>
                <input
                  id="new-country"
                  className="setup-input"
                  type="text"
                  placeholder="US"
                  maxLength={2}
                  value={country}
                  onChange={(e) => setCountry(e.target.value.toUpperCase())}
                />
              </div>
              <div className="setup-field">
                <label className="setup-label" htmlFor="new-language">Language</label>
                <input
                  id="new-language"
                  className="setup-input"
                  type="text"
                  placeholder="en"
                  maxLength={5}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value.toLowerCase())}
                />
              </div>
            </div>
          </div>
          {error ? <p className="text-rose-400 text-sm mt-3">{error}</p> : null}
          <div className="flex items-center gap-3 mt-4">
            <Button type="button" disabled={!slug || !domain || saving} onClick={handleCreate}>
              {saving ? 'Creating...' : 'Create project'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {projects.length > 0 ? (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Domain</th>
                <th>Visibility</th>
                <th>Last run</th>
                <th className="text-right">Country</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const href = `/projects/${p.project.id}`
                const latestRun = p.recentRuns[0]
                return (
                  <tr key={p.project.id} className="cursor-pointer" onClick={() => onNavigate(href)}>
                    <td>
                      <a
                        className="text-zinc-100 font-medium hover:underline"
                        href={href}
                        onClick={createNavigationHandler(onNavigate, href)}
                      >
                        {p.project.displayName || p.project.name}
                      </a>
                      <p className="text-[11px] text-zinc-500">{p.project.name}</p>
                    </td>
                    <td className="text-zinc-400">{p.project.canonicalDomain}</td>
                    <td>
                      <ToneBadge tone={p.visibilitySummary.tone}>{p.visibilitySummary.value}</ToneBadge>
                    </td>
                    <td className="text-zinc-500 text-sm">
                      {latestRun ? (
                        <StatusBadge status={latestRun.status} />
                      ) : (
                        <span className="text-zinc-600">No runs</span>
                      )}
                    </td>
                    <td className="text-right text-zinc-500">{p.project.country}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : !showForm ? (
        <Card className="surface-card empty-card">
          <h3>No projects yet</h3>
          <p className="supporting-copy">Create your first monitoring project to start tracking AI visibility.</p>
          <Button type="button" onClick={() => setShowForm(true)}>
            <Plus className="size-4 mr-1.5" />
            Add project
          </Button>
        </Card>
      ) : null}

      <YamlApplyPanel onApplied={onProjectCreated} />
    </div>
  )
}

function YamlApplyPanel({ onApplied }: { onApplied: () => void }) {
  const [yamlText, setYamlText] = useState('')
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])

  const handleApply = async () => {
    if (!yamlText.trim()) return
    setApplying(true)
    setResults([])
    setErrors([])

    const docs = parseAllDocuments(yamlText)
    const errs: string[] = []
    const applied: string[] = []

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!
      if (doc.errors.length > 0) {
        errs.push(`Document ${i + 1}: ${doc.errors[0]?.message}`)
        continue
      }
      const config = doc.toJSON() as object
      if (!config || typeof config !== 'object') continue
      try {
        const result = await applyProjectConfig(config)
        applied.push(`Applied "${result.displayName || result.name}" (revision ${result.configRevision})`)
      } catch (err) {
        errs.push(`Document ${i + 1}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    setResults(applied)
    setErrors(errs)
    setApplying(false)
    if (applied.length > 0) onApplied()
  }

  return (
    <section className="mt-8">
      <div className="page-section-divider" />
      <div className="section-head mt-6">
        <div>
          <p className="eyebrow eyebrow-soft">Config as code</p>
          <h2 className="text-sm font-medium text-zinc-200">Apply YAML</h2>
        </div>
      </div>
      <p className="text-zinc-500 text-sm mb-3">Paste a <code className="text-zinc-400">canonry.yaml</code> config (multi-document YAML with <code className="text-zinc-400">---</code> separators supported).</p>
      <textarea
        className="setup-input w-full font-mono text-xs"
        rows={10}
        placeholder={'apiVersion: canonry/v1\nkind: Project\nmetadata:\n  name: my-project\nspec:\n  canonicalDomain: example.com\n  country: US\n  language: en\n  keywords: []'}
        value={yamlText}
        onChange={(e) => setYamlText(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="mt-2 space-y-1">
          {results.map((r, i) => <li key={i} className="text-emerald-400 text-sm">{r}</li>)}
        </ul>
      )}
      {errors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {errors.map((e, i) => <li key={i} className="text-rose-400 text-sm">{e}</li>)}
        </ul>
      )}
      <div className="mt-3">
        <Button type="button" disabled={!yamlText.trim() || applying} onClick={handleApply}>
          {applying ? 'Applying...' : 'Apply'}
        </Button>
      </div>
    </section>
  )
}

function ProjectPage({
  model,
  tab,
  onOpenEvidence,
  onOpenRun,
  onTriggerRun,
  onDeleteProject,
  onAddKeywords,
  onDeleteKeywords,
  onAddCompetitors,
  onUpdateOwnedDomains,
  onUpdateProject,
  onNavigate,
}: {
  model: ProjectCommandCenterVm
  tab: ProjectPageTab
  onOpenEvidence: (evidenceId: string) => void
  onOpenRun: (runId?: string) => void
  onTriggerRun: (projectName: string) => Promise<void>
  onDeleteProject: (projectName: string) => void
  onAddKeywords: (projectName: string, keywords: string[]) => Promise<void>
  onDeleteKeywords: (projectName: string, keywords: string[]) => Promise<void>
  onAddCompetitors: (projectName: string, domains: string[]) => Promise<void>
  onUpdateOwnedDomains: (projectName: string, ownedDomains: string[]) => Promise<void>
  onUpdateProject: (projectName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) => Promise<void>
  onNavigate: (to: string) => void
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [runTriggering, setRunTriggering] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [addingKeywords, setAddingKeywords] = useState(false)
  const [newKeywordText, setNewKeywordText] = useState('')
  const [keywordSaving, setKeywordSaving] = useState(false)
  const [keywordDeleting, setKeywordDeleting] = useState<string | null>(null)
  const [addingCompetitor, setAddingCompetitor] = useState(false)
  const [newCompetitorDomain, setNewCompetitorDomain] = useState('')
  const [competitorSaving, setCompetitorSaving] = useState(false)
  const [addingOwnedDomain, setAddingOwnedDomain] = useState(false)
  const [newOwnedDomain, setNewOwnedDomain] = useState('')
  const [ownedDomainSaving, setOwnedDomainSaving] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string | undefined>(undefined)
  const [compareLocations, setCompareLocations] = useState(false)
  const [locationTimeline, setLocationTimeline] = useState<import('./api.js').ApiTimelineEntry[] | null>(null)
  const [locationTimelineLoading, setLocationTimelineLoading] = useState(false)

  const locationLabelsInEvidence = useMemo(() => new Set(model.visibilityEvidence.map(e => e.location ?? '')), [model.visibilityEvidence])
  const hasNullLocationEvidence = locationLabelsInEvidence.has('')
  const distinctLocationsWithEvidence = useMemo(() => [...locationLabelsInEvidence].filter(Boolean), [locationLabelsInEvidence])

  useEffect(() => {
    if (locationFilter === undefined || locationFilter === '') {
      setLocationTimeline(null)
      setLocationTimelineLoading(false)
      return
    }
    setLocationTimelineLoading(true)
    fetchTimeline(model.project.name, locationFilter)
      .then(tl => { setLocationTimeline(tl); setLocationTimelineLoading(false) })
      .catch(() => { setLocationTimeline(null); setLocationTimelineLoading(false) })
  }, [locationFilter, model.project.name])

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
      ? model.visibilityEvidence.filter(e => locationFilter === '' ? !e.location : e.location === locationFilter)
      : model.visibilityEvidence
    if (!locationRunHistoryMap) return filtered
    return filtered.map(item => {
      const history = locationRunHistoryMap.get(`${item.keyword}::${item.provider}`)
        ?? locationRunHistoryMap.get(`${item.keyword}::`)
      return history ? { ...item, runHistory: history } : item
    })
  }, [model.visibilityEvidence, locationFilter, locationRunHistoryMap])

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
  async function handleDeleteKeyword(phrase: string) {
    setKeywordDeleting(phrase)
    try {
      await onDeleteKeywords(model.project.name, [phrase])
    } finally {
      setKeywordDeleting(null)
    }
  }

  async function handleAddKeywords() {
    const keywords = newKeywordText.split('\n').map(k => k.trim()).filter(Boolean)
    if (keywords.length === 0) return
    setKeywordSaving(true)
    try {
      await onAddKeywords(model.project.name, keywords)
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
      await onAddCompetitors(model.project.name, [domain])
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
      const current = model.project.ownedDomains ?? []
      await onUpdateOwnedDomains(model.project.name, [...current, domain])
      setNewOwnedDomain('')
      setAddingOwnedDomain(false)
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  async function handleRemoveOwnedDomain(domain: string) {
    setOwnedDomainSaving(true)
    try {
      const current = model.project.ownedDomains ?? []
      await onUpdateOwnedDomains(model.project.name, current.filter(d => d !== domain))
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  const isNumericScore = (value: string) => !Number.isNaN(Number.parseInt(value, 10))
  const projectTabItems: Array<{ key: ProjectPageTab; label: string; href: string }> = [
    { key: 'overview', label: 'Overview', href: `/projects/${model.project.id}` },
    { key: 'search-console', label: 'Search Console', href: `/projects/${model.project.id}/search-console` },
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
              onClick={async () => {
                setRunTriggering(true)
                setRunError(null)
                try {
                  await onTriggerRun(model.project.name)
                } catch (err) {
                  setRunError(err instanceof Error ? err.message : 'Failed to trigger run')
                } finally {
                  setRunTriggering(false)
                }
              }}
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
          <a
            key={item.key}
            className={`project-subnav-link ${item.key === tab ? 'project-subnav-link-active' : ''}`}
            href={item.href}
            aria-current={item.key === tab ? 'page' : undefined}
            onClick={createNavigationHandler(onNavigate, item.href)}
          >
            {item.label}
          </a>
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
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {model.providerScores.map((ps) => (
                  <Card key={`${ps.provider}::${ps.model ?? 'unknown'}`} className="surface-card compact-card">
                    <div className="flex items-center justify-between">
                      <ProviderBadge provider={ps.provider} />
                      <span className={`text-lg font-semibold ${ps.score >= 70 ? 'text-emerald-400' : ps.score >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                        {ps.score}%
                      </span>
                    </div>
                    {ps.model && <p className="mt-0.5 text-[11px] font-mono text-zinc-500 truncate">{ps.model}</p>}
                    <p className="mt-1 text-xs text-zinc-500">{ps.cited} of {ps.total} key phrases cited</p>
                  </Card>
                ))}
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
            <InsightSignals insights={model.insights} onOpenEvidence={onOpenEvidence} />
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
            <EvidencePhraseCards
              evidence={filteredEvidence}
              onOpenEvidence={onOpenEvidence}
              showLocationLabels={locationFilter === undefined}
              compareLocations={locationFilter === undefined && compareLocations}
              timelineLoading={locationTimelineLoading}
              onDeleteKeyword={keywordDeleting ? undefined : handleDeleteKeyword}
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
                <RunRow key={run.id} run={run} onOpen={onOpenRun} />
              ))}
            </div>
          </section>

          <ProjectSettingsSection project={{ ...model.project, displayName: model.project.displayName ?? model.project.name, defaultLocation: model.project.defaultLocation ?? null }} onUpdateProject={onUpdateProject} />
          <ScheduleSection projectName={model.project.name} />
          <NotificationsSection projectName={model.project.name} />
        </>
      ) : (
        <GscSection projectName={model.project.name} onOpenSettings={() => onNavigate('/settings')} />
      )}
    </div>
  )
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatBooleanState(value: boolean | null): string {
  if (value === null) return 'Unknown'
  return value ? 'Pass' : 'Fail'
}

function GscSection({
  projectName,
  onOpenSettings,
}: {
  projectName: string
  onOpenSettings?: () => void
}) {
  const [googleConfigured, setGoogleConfigured] = useState(false)
  const [connections, setConnections] = useState<ApiGoogleConnection[]>([])
  const [properties, setProperties] = useState<ApiGoogleProperty[]>([])
  const [performance, setPerformance] = useState<ApiGscPerformanceRow[]>([])
  const [inspections, setInspections] = useState<ApiGscInspection[]>([])
  const [deindexed, setDeindexed] = useState<ApiGscDeindexedRow[]>([])
  const [inspectionResult, setInspectionResult] = useState<ApiGscInspection | null>(null)
  const [selectedProperty, setSelectedProperty] = useState('')
  const [inspectionUrl, setInspectionUrl] = useState('')
  const [syncDays, setSyncDays] = useState('30')
  const [fullSync, setFullSync] = useState(false)
  const [performanceFilters, setPerformanceFilters] = useState({
    startDate: '',
    endDate: '',
    query: '',
    page: '',
    limit: '20',
  })
  const [inspectionFilterUrl, setInspectionFilterUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [savingProperty, setSavingProperty] = useState(false)
  const [loadingPerformance, setLoadingPerformance] = useState(false)
  const [loadingInspections, setLoadingInspections] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [coverage, setCoverage] = useState<ApiGscCoverageSummary | null>(null)
  const [loadingCoverage, setLoadingCoverage] = useState(false)
  const [inspectingSitemap, setInspectingSitemap] = useState(false)
  const [discoveringSitemaps, setDiscoveringSitemaps] = useState(false)
  const [listingSitemaps, setListingSitemaps] = useState(false)
  const [discoveredSitemaps, setDiscoveredSitemaps] = useState<ApiGscSitemap[] | null>(null)
  const [sitemapUrlInput, setSitemapUrlInput] = useState('')
  const [savingSitemap, setSavingSitemap] = useState(false)
  const [setupExpanded, setSetupExpanded] = useState(false)
  const [coverageTab, setCoverageTab] = useState<'indexed' | 'notIndexed' | 'deindexed'>('indexed')
  const [_coverageHistory, setCoverageHistory] = useState<Array<{ date: string; indexed: number; notIndexed: number; reasonBreakdown: Record<string, number> }>>([])
  const [selectedReason, setSelectedReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const gscConn = connections.find((c) => c.connectionType === 'gsc')
  const hasHistoricalData = performance.length > 0 || inspections.length > 0 || deindexed.length > 0

  async function loadProperties(currentConn: ApiGoogleConnection | undefined) {
    if (!currentConn) {
      setProperties([])
      setSelectedProperty('')
      return
    }

    setPropertiesLoading(true)
    try {
      const { sites } = await fetchGoogleProperties(projectName)
      setProperties(sites)
      setSelectedProperty(currentConn.propertyId ?? sites[0]?.siteUrl ?? '')
    } catch (err) {
      setProperties([])
      setError(err instanceof Error ? err.message : 'Failed to load Search Console properties')
    } finally {
      setPropertiesLoading(false)
    }
  }

  async function loadPerformanceRows() {
    setLoadingPerformance(true)
    try {
      const rows = await fetchGscPerformance(projectName, {
        startDate: performanceFilters.startDate || undefined,
        endDate: performanceFilters.endDate || undefined,
        query: performanceFilters.query || undefined,
        page: performanceFilters.page || undefined,
        limit: parseInt(performanceFilters.limit, 10) || 20,
      })
      setPerformance(rows)
    } catch (err) {
      setPerformance([])
      setError(err instanceof Error ? err.message : 'Failed to load GSC performance data')
    } finally {
      setLoadingPerformance(false)
    }
  }

  async function loadInspectionHistory() {
    setLoadingInspections(true)
    try {
      const [history, deindexedRows] = await Promise.all([
        fetchGscInspections(projectName, {
          url: inspectionFilterUrl.trim() || undefined,
          limit: 20,
        }),
        fetchGscDeindexed(projectName),
      ])
      setInspections(history)
      setDeindexed(deindexedRows)
    } catch (err) {
      setInspections([])
      setDeindexed([])
      setError(err instanceof Error ? err.message : 'Failed to load GSC inspection history')
    } finally {
      setLoadingInspections(false)
    }
  }

  async function loadCoverage() {
    setLoadingCoverage(true)
    try {
      const [data, history] = await Promise.all([
        fetchGscCoverage(projectName),
        fetchGscCoverageHistory(projectName).catch(() => []),
      ])
      setCoverage(data)
      setCoverageHistory(history)
    } catch {
      setCoverage(null)
      setCoverageHistory([])
    } finally {
      setLoadingCoverage(false)
    }
  }

  async function handleSaveSitemap() {
    if (!sitemapUrlInput.trim()) return
    setSavingSitemap(true)
    setError(null)
    try {
      await saveSitemapUrl(projectName, 'gsc', sitemapUrlInput.trim())
      setConnections((prev) => prev.map((c) => (
        c.connectionType === 'gsc' ? { ...c, sitemapUrl: sitemapUrlInput.trim() } : c
      )))
      setNotice('Sitemap URL saved.')
      setSitemapUrlInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sitemap URL')
    } finally {
      setSavingSitemap(false)
    }
  }

  async function handleDiscoverSitemaps() {
    setDiscoveringSitemaps(true)
    setError(null)
    try {
      const result = await triggerDiscoverSitemaps(projectName)
      setDiscoveredSitemaps(result.sitemaps)
      setConnections((prev) => prev.map((c) => (
        c.connectionType === 'gsc' ? { ...c, sitemapUrl: result.primarySitemapUrl } : c
      )))
      setNotice(`Discovered ${result.sitemaps.length} sitemap(s). Primary sitemap saved and inspection queued (run ${result.run.id}).`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover sitemaps')
    } finally {
      setDiscoveringSitemaps(false)
    }
  }

  async function handleListSitemaps() {
    setListingSitemaps(true)
    setError(null)
    try {
      const result = await fetchGscSitemaps(projectName)
      setDiscoveredSitemaps(result.sitemaps)
      if (result.sitemaps.length === 0) {
        setNotice('No sitemaps found in this GSC property. Submit a sitemap in Google Search Console first.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list sitemaps')
    } finally {
      setListingSitemaps(false)
    }
  }

  async function loadSection() {
    setLoading(true)
    setError(null)
    try {
      const [settings, conns] = await Promise.all([
        fetchSettings().catch(() => null),
        fetchGoogleConnections(projectName).catch(() => [] as ApiGoogleConnection[]),
      ])
      setGoogleConfigured(Boolean(settings?.google?.configured))
      setConnections(conns)

      const currentConn = conns.find((c) => c.connectionType === 'gsc')
      await Promise.all([
        loadProperties(currentConn),
        loadPerformanceRows(),
        loadInspectionHistory(),
        loadCoverage(),
      ])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSection()
  }, [projectName])

  async function handleConnect() {
    if (!googleConfigured) {
      setError('Google OAuth app credentials are not configured yet. Set them on the Settings page first.')
      return
    }

    setConnecting(true)
    setError(null)
    setNotice(null)
    try {
      const { authUrl } = await googleConnect(projectName, 'gsc')
      const popup = window.open(authUrl, '_blank', 'width=600,height=700')
      if (!popup) {
        window.location.assign(authUrl)
        return
      }
      setNotice('Finish the Google consent flow in the popup, then close it to refresh this project.')
      const timer = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(timer)
          setNotice(null)
          void loadSection()
        }
      }, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth flow')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    setError(null)
    setNotice(null)
    try {
      await googleDisconnect(projectName, 'gsc')
      setConnections((prev) => prev.filter((c) => c.connectionType !== 'gsc'))
      setProperties([])
      setSelectedProperty('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  async function handleSaveProperty() {
    if (!selectedProperty) return
    setSavingProperty(true)
    setError(null)
    try {
      await saveGoogleProperty(projectName, 'gsc', selectedProperty)
      setConnections((prev) => prev.map((connection) => (
        connection.connectionType === 'gsc'
          ? { ...connection, propertyId: selectedProperty }
          : connection
      )))
      setNotice('GSC property updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save GSC property')
    } finally {
      setSavingProperty(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      await triggerGscSync(projectName, {
        days: parseInt(syncDays, 10) || undefined,
        full: fullSync || undefined,
      })
      setNotice('GSC sync queued. Refresh after the run completes to see imported data.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger sync')
    } finally {
      setSyncing(false)
    }
  }

  async function handleInspect() {
    if (!inspectionUrl.trim()) return
    setInspecting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await inspectGscUrl(projectName, inspectionUrl.trim())
      setInspectionResult(result)
      setInspectionUrl('')
      await loadInspectionHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect URL')
    } finally {
      setInspecting(false)
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Search Console</p>
          <h2>Google Search Console</h2>
        </div>
        <div className="flex items-center gap-2">
          {gscConn && (
            <Button type="button" variant="outline" size="sm" disabled={loadingPerformance} onClick={() => void loadPerformanceRows()}>
              {loadingPerformance ? 'Refreshing…' : 'Refresh data'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
          {error}
          <button type="button" className="ml-2 text-rose-400 hover:text-rose-200" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {notice}
          <button type="button" className="ml-2 text-emerald-400 hover:text-emerald-200" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Connection</p>
                <h3>Domain authorization</h3>
              </div>
              <ToneBadge tone={gscConn ? 'positive' : googleConfigured ? 'caution' : 'negative'}>
                {gscConn ? 'Connected' : googleConfigured ? 'Ready to connect' : 'App credentials missing'}
              </ToneBadge>
            </div>
            {gscConn ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-sm text-zinc-200">Authorized for this project domain</span>
                    <span className="text-xs text-zinc-500">{gscConn.domain}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-zinc-500 hover:text-rose-400 transition-colors"
                      onClick={handleDisconnect}
                    >
                      Disconnect
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    Canonry stores OAuth tokens per canonical domain. This project currently maps to <code>{gscConn.domain}</code>.
                  </p>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Selected property</p>
                    <p className="mt-1 text-sm text-zinc-200">{gscConn.propertyId ?? 'No property selected yet'}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Last auth update</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(gscConn.updatedAt)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-5">
                <p className="text-sm text-zinc-300">
                  {googleConfigured
                    ? 'Generate a Google OAuth link for this project and have the client sign in with a Google account that already has access to the correct Search Console property.'
                    : 'Set Google OAuth client credentials first. Once configured, you can generate a consent link for this project domain.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {googleConfigured ? (
                    <Button type="button" variant="outline" size="sm" disabled={connecting} onClick={handleConnect}>
                      {connecting ? 'Opening…' : 'Connect Google Search Console'}
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" disabled={!onOpenSettings} onClick={onOpenSettings}>
                      Open Settings
                    </Button>
                  )}
                  {!googleConfigured && (
                    <p className="text-xs text-zinc-500">The same Google OAuth app credentials are shared across all projects.</p>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* One-time sitemap prompt — shown when connected but no sitemap URL stored */}
          {gscConn && !gscConn.sitemapUrl && (
            <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-amber-400">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-amber-300">Set your sitemap URL</p>
                  <p className="mt-1 text-xs text-amber-400/70">Canonry uses your sitemap to discover URLs for index coverage inspection. Auto-discover from GSC or enter it manually.</p>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-col gap-2 lg:flex-row">
                      <Button
                        type="button"
                        size="sm"
                        disabled={discoveringSitemaps || !gscConn.propertyId}
                        onClick={handleDiscoverSitemaps}
                      >
                        {discoveringSitemaps ? 'Discovering…' : 'Auto-discover from GSC'}
                      </Button>
                      <span className="self-center text-xs text-amber-400/60">or enter manually:</span>
                    </div>
                    <div className="flex flex-col gap-2 lg:flex-row">
                      <input
                        className="flex-1 rounded border border-amber-800/40 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-amber-600 focus:outline-none"
                        type="url"
                        placeholder="https://example.com/sitemap.xml"
                        value={sitemapUrlInput}
                        onChange={(e) => setSitemapUrlInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handleSaveSitemap()}
                      />
                      <Button type="button" size="sm" variant="outline" disabled={savingSitemap || !sitemapUrlInput.trim()} onClick={handleSaveSitemap}>
                        {savingSitemap ? 'Saving…' : 'Save sitemap URL'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── DATA SECTIONS (shown first for connected projects) ── */}

          {(gscConn || hasHistoricalData) && (
            <>
              {/* Coverage overview + donut + history chart — shown first for relevance */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Coverage</p>
                    <h3>Index coverage</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={loadingCoverage} onClick={() => void loadCoverage()}>
                      {loadingCoverage ? 'Loading…' : 'Refresh coverage'}
                    </Button>
                  </div>
                </div>

                {coverage && coverage.summary.total > 0 ? (
                  <>
                    {/* Hero donut — centered, front and center */}
                    <div className="mt-6 flex flex-col items-center">
                      {(() => {
                        const total = coverage.summary.indexed + coverage.summary.notIndexed
                        const pct = total > 0 ? coverage.summary.indexed / total : 0
                        const notPct = total > 0 ? coverage.summary.notIndexed / total : 0
                        const r = 54
                        const circ = 2 * Math.PI * r
                        const indexedOffset = circ * (1 - pct)
                        const notIndexedArc = circ * notPct
                        const notIndexedStart = circ * pct
                        return (
                          <>
                            <div className="relative h-48 w-48">
                              <svg viewBox="0 0 128 128" className="h-full w-full" aria-hidden="true">
                                {/* Background track */}
                                <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="14" />
                                {/* Indexed arc — emerald */}
                                <circle
                                  cx="64" cy="64" r={r} fill="none"
                                  stroke="#10b981" strokeWidth="14"
                                  strokeDasharray={circ} strokeDashoffset={indexedOffset}
                                  strokeLinecap="round"
                                  transform="rotate(-90 64 64)"
                                  style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                                />
                                {/* Not-indexed arc — zinc */}
                                {coverage.summary.notIndexed > 0 && (
                                  <circle
                                    cx="64" cy="64" r={r} fill="none"
                                    stroke="#52525b" strokeWidth="14"
                                    strokeDasharray={`${notIndexedArc} ${circ - notIndexedArc}`}
                                    strokeDashoffset={-notIndexedStart}
                                    transform="rotate(-90 64 64)"
                                    style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
                                  />
                                )}
                              </svg>
                              <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className="text-3xl font-bold tabular-nums text-zinc-50">{(pct * 100).toFixed(0)}%</span>
                                <span className="text-xs uppercase tracking-widest text-zinc-500 mt-0.5">Indexed</span>
                              </div>
                            </div>

                            {/* Counts row beneath donut */}
                            <div className="mt-4 flex items-center justify-center gap-8">
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.indexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Indexed</p>
                                </div>
                              </div>
                              <div className="h-8 w-px bg-zinc-800" />
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.notIndexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                                    Not indexed
                                    {(coverage.reasonGroups ?? []).length > 0 && (
                                      <span className="ml-1 text-zinc-600">
                                        · {(coverage.reasonGroups ?? []).length} {(coverage.reasonGroups ?? []).length === 1 ? 'reason' : 'reasons'}
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                              {coverage.summary.deindexed > 0 && (
                                <>
                                  <div className="h-8 w-px bg-zinc-800" />
                                  <div className="flex items-center gap-2">
                                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" />
                                    <div>
                                      <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.deindexed.toLocaleString()}</p>
                                      <p className="text-[11px] uppercase tracking-wide text-zinc-500">Deindexed</p>
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </>
                        )
                      })()}
                    </div>


                    {/* Tab pills */}
                    <div className="mt-3 flex gap-1">
                      {(['indexed', 'notIndexed', 'deindexed'] as const).map((tab) => {
                        const count = tab === 'indexed' ? coverage.indexed.length
                          : tab === 'notIndexed' ? coverage.notIndexed.length
                          : coverage.deindexed.length
                        const label = tab === 'indexed' ? 'Indexed' : tab === 'notIndexed' ? 'Not Indexed' : 'Deindexed'
                        return (
                          <button
                            key={tab}
                            type="button"
                            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                              coverageTab === tab
                                ? 'bg-zinc-700 text-zinc-100'
                                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                            }`}
                            onClick={() => { setCoverageTab(tab); setSelectedReason(null) }}
                          >
                            {label} ({count})
                          </button>
                        )
                      })}
                    </div>

                    <div className="mt-3 overflow-x-auto">
                      {/* Indexed URL table */}
                      {coverageTab === 'indexed' && coverage.indexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Verdict</th>
                              <th className="text-left">Last Crawl</th>
                              <th className="text-left">Mobile</th>
                            </tr>
                          </thead>
                          <tbody>
                            {coverage.indexed.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.verdict ?? 'Unknown'}</td>
                                <td className="text-zinc-400">{row.crawlTime ? row.crawlTime.split('T')[0] : '—'}</td>
                                <td className="text-zinc-400">{row.isMobileFriendly === true ? 'Yes' : row.isMobileFriendly === false ? 'No' : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Not Indexed — reason groups + detail drill-down */}
                      {coverageTab === 'notIndexed' && !selectedReason && (coverage.reasonGroups ?? []).length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">Reason</th>
                              <th className="text-right">Pages</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(coverage.reasonGroups ?? []).map((group) => (
                              <tr
                                key={group.reason}
                                className="cursor-pointer hover:bg-zinc-800/40"
                                onClick={() => setSelectedReason(group.reason)}
                              >
                                <td className="text-zinc-200">{group.reason}</td>
                                <td className="text-right tabular-nums text-zinc-400">{group.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Not Indexed — no reason groups, show flat list */}
                      {coverageTab === 'notIndexed' && !selectedReason && (coverage.reasonGroups ?? []).length === 0 && coverage.notIndexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Indexing State</th>
                              <th className="text-left">Coverage</th>
                            </tr>
                          </thead>
                          <tbody>
                            {coverage.notIndexed.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.indexingState ?? 'Unknown'}</td>
                                <td className="text-zinc-400">{row.coverageState ?? 'Unknown'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Reason detail view — drill-down for a specific reason */}
                      {coverageTab === 'notIndexed' && selectedReason && (() => {
                        const group = (coverage.reasonGroups ?? []).find((g) => g.reason === selectedReason)
                        if (!group) return null
                        return (
                          <div>
                            <div className="flex items-center gap-2 mb-3">
                              <button
                                type="button"
                                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                onClick={() => setSelectedReason(null)}
                              >
                                ← Back to reasons
                              </button>
                            </div>
                            <div className="mb-3 rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                              <p className="text-sm font-medium text-zinc-200">{group.reason}</p>
                              <p className="mt-1 text-xs text-zinc-500">{group.count} affected page{group.count !== 1 ? 's' : ''}</p>
                            </div>

                            <table className="data-table w-full text-sm">
                              <thead>
                                <tr>
                                  <th className="text-left">URL</th>
                                  <th className="text-left">Last Crawl</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.urls.map((row) => (
                                  <tr key={row.id}>
                                    <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                    <td className="text-zinc-400">{row.crawlTime ? row.crawlTime.split('T')[0] : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      })()}

                      {/* Deindexed table */}
                      {coverageTab === 'deindexed' && coverage.deindexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Previous</th>
                              <th className="text-left">Current</th>
                              <th className="text-left">Detected</th>
                            </tr>
                          </thead>
                          <tbody>
                            {coverage.deindexed.map((row, i) => (
                              <tr key={`${row.url}-${i}`}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.previousState}</td>
                                <td className="text-zinc-400">{row.currentState}</td>
                                <td className="text-zinc-400">{row.transitionDate.split('T')[0]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {((coverageTab === 'indexed' && coverage.indexed.length === 0) ||
                        (coverageTab === 'notIndexed' && !selectedReason && coverage.notIndexed.length === 0) ||
                        (coverageTab === 'deindexed' && coverage.deindexed.length === 0)) && (
                        <p className="text-sm text-zinc-500">No URLs in this category.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">
                    {loadingCoverage ? 'Loading coverage data…' : 'No coverage data yet. Inspect your sitemap to populate this view.'}
                  </p>
                )}
              </Card>

              {/* Performance summary + charts */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Performance</p>
                    <h3>Search performance</h3>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={loadingPerformance} onClick={() => void loadPerformanceRows()}>
                    {loadingPerformance ? 'Loading…' : 'Apply filters'}
                  </Button>
                </div>

                {/* Clicks + Impressions bar chart */}
                {performance.length > 0 && (() => {
                  const byDate = new Map<string, { clicks: number; impressions: number }>()
                  for (const row of performance) {
                    const existing = byDate.get(row.date)
                    if (existing) {
                      existing.clicks += row.clicks
                      existing.impressions += row.impressions
                    } else {
                      byDate.set(row.date, { clicks: row.clicks, impressions: row.impressions })
                    }
                  }
                  const sorted = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
                  if (sorted.length === 0) return null
                  const maxImpressions = Math.max(...sorted.map(([, d]) => d.impressions), 1)
                  const totalClicks = sorted.reduce((sum, [, d]) => sum + d.clicks, 0)
                  const totalImpressions = sorted.reduce((sum, [, d]) => sum + d.impressions, 0)
                  const avgCtr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(1) : '0.0'

                  const w = 700
                  const h = 220
                  const pad = { top: 12, bottom: 36, left: 48, right: 12 }
                  const plotW = w - pad.left - pad.right
                  const plotH = h - pad.top - pad.bottom
                  const barGroupW = plotW / sorted.length
                  const barW = Math.max(Math.min(barGroupW * 0.35, 24), 4)
                  const barGap = Math.max(barW * 0.15, 1)

                  // Y-axis ticks
                  const niceMax = (v: number) => {
                    if (v <= 0) return 1
                    const mag = Math.pow(10, Math.floor(Math.log10(v)))
                    const norm = v / mag
                    const nice = norm <= 1.5 ? 1.5 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10
                    return Math.ceil(nice * mag)
                  }
                  const tickCount = 4
                  const ceilVal = Math.ceil(niceMax(maxImpressions) / tickCount) * tickCount
                  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (ceilVal / tickCount) * i)
                  const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)

                  return (
                    <div className="mt-3">
                      <div className="flex items-center gap-5 mb-2">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                          <span className="text-xs text-zinc-400">Clicks <span className="text-zinc-200 tabular-nums font-medium">{totalClicks.toLocaleString()}</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500" />
                          <span className="text-xs text-zinc-400">Impressions <span className="text-zinc-200 tabular-nums font-medium">{totalImpressions.toLocaleString()}</span></span>
                        </div>
                        <span className="text-xs text-zinc-500">CTR <span className="text-amber-400 tabular-nums font-medium">{avgCtr}%</span></span>
                      </div>
                      <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
                        <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full">
                          {/* Grid lines + Y-axis */}
                          {ticks.map((tick, i) => {
                            const y = pad.top + plotH - (tick / ceilVal) * plotH
                            return (
                              <g key={`t-${i}`}>
                                <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                                <text x={pad.left - 6} y={y + 3.5} textAnchor="end" fill="#a1a1aa" fontSize="10" fontFamily="inherit">{fmtNum(tick)}</text>
                              </g>
                            )
                          })}
                          {/* Bars */}
                          {sorted.map(([date, d], i) => {
                            const cx = pad.left + barGroupW * i + barGroupW / 2
                            const impressionH = (d.impressions / ceilVal) * plotH
                            const clickH = (d.clicks / ceilVal) * plotH
                            return (
                              <g key={date}>
                                <title>{`${date}\nClicks: ${d.clicks}\nImpressions: ${d.impressions}\nCTR: ${d.impressions > 0 ? ((d.clicks / d.impressions) * 100).toFixed(1) : 0}%`}</title>
                                <rect
                                  x={cx - barW - barGap / 2}
                                  y={pad.top + plotH - impressionH}
                                  width={barW}
                                  height={Math.max(impressionH, 1)}
                                  rx={2}
                                  fill="#3b82f6"
                                  opacity={0.85}
                                />
                                <rect
                                  x={cx + barGap / 2}
                                  y={pad.top + plotH - clickH}
                                  width={barW}
                                  height={Math.max(clickH, 1)}
                                  rx={2}
                                  fill="#10b981"
                                  opacity={0.85}
                                />
                              </g>
                            )
                          })}
                          {/* X-axis date labels — pick up to 7 evenly spaced */}
                          {(() => {
                            const labelCount = Math.min(sorted.length, 7)
                            return Array.from({ length: labelCount }, (_, i) => {
                              const idx = sorted.length === 1 ? 0 : Math.round((i / (labelCount - 1)) * (sorted.length - 1))
                              const cx = pad.left + barGroupW * idx + barGroupW / 2
                              return (
                                <text key={`xl-${idx}`} x={cx} y={h - 8} textAnchor="middle" fill="#71717a" fontSize="10" fontFamily="inherit">
                                  {sorted[idx]![0].slice(5)}
                                </text>
                              )
                            })
                          })()}
                        </svg>
                      </div>
                    </div>
                  )
                })()}

                <div className="mt-3 grid gap-2 lg:grid-cols-5">
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="date"
                    value={performanceFilters.startDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="date"
                    value={performanceFilters.endDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter query"
                    value={performanceFilters.query}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, query: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter page"
                    value={performanceFilters.page}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, page: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="number"
                    min="1"
                    placeholder="Limit"
                    value={performanceFilters.limit}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, limit: e.target.value }))}
                  />
                </div>
                {performance.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">Date</th>
                          <th className="text-left">Query</th>
                          <th className="text-left">Page</th>
                          <th className="text-right">Clicks</th>
                          <th className="text-right">Impressions</th>
                          <th className="text-right">CTR</th>
                          <th className="text-right">Position</th>
                        </tr>
                      </thead>
                      <tbody>
                        {performance.map((row, i) => (
                          <tr key={`${row.date}:${row.query}:${row.page}:${i}`}>
                            <td className="text-zinc-400">{row.date}</td>
                            <td className="max-w-xs truncate text-zinc-200">{row.query}</td>
                            <td className="max-w-xs truncate text-zinc-400">{row.page}</td>
                            <td className="text-right tabular-nums text-zinc-300">{row.clicks.toLocaleString()}</td>
                            <td className="text-right tabular-nums text-zinc-400">{row.impressions.toLocaleString()}</td>
                            <td className="text-right tabular-nums text-zinc-400">{(row.ctr * 100).toFixed(1)}%</td>
                            <td className="text-right tabular-nums text-zinc-400">{row.position.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No performance rows match the current filters yet.</p>
                )}
              </Card>

              {/* URL Inspection */}
              <Card className="surface-card">
                <div className="section-head">
                  <div>
                    <p className="eyebrow eyebrow-soft">Inspection</p>
                    <h3>Inspect a URL</h3>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="url"
                    placeholder="https://example.com/page"
                    value={inspectionUrl}
                    onChange={(e) => setInspectionUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleInspect()}
                  />
                  <Button type="button" size="sm" disabled={inspecting || !gscConn?.propertyId || !inspectionUrl.trim()} onClick={handleInspect}>
                    {inspecting ? 'Inspecting…' : 'Inspect URL'}
                  </Button>
                </div>
                {inspectionResult && (
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Indexing state</p>
                      <p className="mt-1 text-sm text-zinc-200">{inspectionResult.indexingState ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Verdict</p>
                      <p className="mt-1 text-sm text-zinc-200">{inspectionResult.verdict ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Mobile friendly</p>
                      <p className="mt-1 text-sm text-zinc-200">{formatBooleanState(inspectionResult.isMobileFriendly)}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Last crawl</p>
                      <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(inspectionResult.crawlTime)}</p>
                    </div>
                  </div>
                )}
              </Card>

              {/* Inspection log */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">History</p>
                    <h3>Inspection log</h3>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={loadingInspections} onClick={() => void loadInspectionHistory()}>
                    {loadingInspections ? 'Loading…' : 'Refresh history'}
                  </Button>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter exact URL"
                    value={inspectionFilterUrl}
                    onChange={(e) => setInspectionFilterUrl(e.target.value)}
                  />
                  <Button type="button" size="sm" variant="outline" disabled={loadingInspections} onClick={() => void loadInspectionHistory()}>
                    Apply filter
                  </Button>
                </div>
                {inspections.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">URL</th>
                          <th className="text-left">Indexing</th>
                          <th className="text-left">Verdict</th>
                          <th className="text-left">Coverage</th>
                          <th className="text-left">Mobile</th>
                          <th className="text-left">Inspected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inspections.map((row) => (
                          <tr key={row.id}>
                            <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                            <td className="text-zinc-300">{row.indexingState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{row.verdict ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{row.coverageState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{formatBooleanState(row.isMobileFriendly)}</td>
                            <td className="text-zinc-400">{formatTimestamp(row.inspectedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No inspection history yet.</p>
                )}
              </Card>

              {/* Recent indexing losses */}
              <Card className="surface-card">
                <div className="section-head">
                  <div>
                    <p className="eyebrow eyebrow-soft">Deindexed</p>
                    <h3>Recent indexing losses</h3>
                  </div>
                </div>
                {deindexed.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">URL</th>
                          <th className="text-left">Previous</th>
                          <th className="text-left">Current</th>
                          <th className="text-left">Changed at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deindexed.map((row) => (
                          <tr key={`${row.url}:${row.transitionDate}`}>
                            <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                            <td className="text-zinc-400">{row.previousState ?? 'Unknown'}</td>
                            <td className="text-zinc-300">{row.currentState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{formatTimestamp(row.transitionDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No deindexed transitions recorded.</p>
                )}
              </Card>
            </>
          )}

          {/* ── SETUP SECTION (at bottom, collapsible for connected projects) ── */}
          {gscConn && (
            <>
              <div className="border-t border-zinc-800/60 pt-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setSetupExpanded((prev) => !prev)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className={`h-4 w-4 text-zinc-500 transition-transform ${setupExpanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs uppercase tracking-wide text-zinc-500">Setup &amp; Configuration</span>
                </button>
              </div>

              {setupExpanded && (
                <div className="space-y-3">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <Card className="surface-card">
                      <div className="section-head">
                        <div>
                          <p className="eyebrow eyebrow-soft">Property</p>
                          <h3>Pick the Search Console property</h3>
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        <label className="text-xs text-zinc-500" htmlFor={`gsc-property-${projectName}`}>Property URL</label>
                        <select
                          id={`gsc-property-${projectName}`}
                          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
                          value={selectedProperty}
                          disabled={propertiesLoading || properties.length === 0}
                          onChange={(e) => setSelectedProperty(e.target.value)}
                        >
                          {properties.length === 0 ? (
                            <option value="">{propertiesLoading ? 'Loading properties…' : 'No properties available'}</option>
                          ) : (
                            properties.map((site) => (
                              <option key={site.siteUrl} value={site.siteUrl}>
                                {site.siteUrl} · {site.permissionLevel}
                              </option>
                            ))
                          )}
                        </select>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button type="button" size="sm" variant="outline" disabled={propertiesLoading} onClick={() => void loadProperties(gscConn)}>
                            {propertiesLoading ? 'Refreshing…' : 'Refresh properties'}
                          </Button>
                          <Button type="button" size="sm" disabled={!selectedProperty || savingProperty} onClick={handleSaveProperty}>
                            {savingProperty ? 'Saving…' : 'Save property'}
                          </Button>
                        </div>
                        <p className="text-xs text-zinc-500">The selected property is used for future syncs and URL inspections for this project.</p>
                      </div>
                    </Card>

                    <Card className="surface-card">
                      <div className="section-head">
                        <div>
                          <p className="eyebrow eyebrow-soft">Sync</p>
                          <h3>Import GSC performance data</h3>
                        </div>
                      </div>
                      <div className="mt-3 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                          <div>
                            <label className="text-xs text-zinc-500" htmlFor={`gsc-sync-days-${projectName}`}>Days</label>
                            <input
                              id={`gsc-sync-days-${projectName}`}
                              type="number"
                              min="1"
                              className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                              value={syncDays}
                              onChange={(e) => setSyncDays(e.target.value)}
                            />
                          </div>
                          <label className="flex items-center gap-2 rounded border border-zinc-800/60 bg-zinc-900/20 px-3 py-2 text-sm text-zinc-300">
                            <input
                              type="checkbox"
                              checked={fullSync}
                              onChange={(e) => setFullSync(e.target.checked)}
                            />
                            Replace existing imported rows for the requested range
                          </label>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          disabled={syncing || !gscConn.propertyId}
                          onClick={handleSync}
                        >
                          {syncing ? 'Queueing…' : 'Queue sync'}
                        </Button>
                        {!gscConn.propertyId && (
                          <p className="text-xs text-amber-400">Select a Search Console property before queueing a sync.</p>
                        )}
                      </div>
                    </Card>
                  </div>

                  {/* Sitemap configuration */}
                  <Card className="surface-card">
                    <div className="section-head">
                      <div>
                        <p className="eyebrow eyebrow-soft">Sitemap</p>
                        <h3>Sitemap configuration</h3>
                      </div>
                    </div>
                    <div className="mt-3 space-y-3">
                      {gscConn.sitemapUrl && (
                        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                          <p className="text-xs uppercase tracking-wide text-zinc-500">Current sitemap URL</p>
                          <p className="mt-1 text-sm text-zinc-200 break-all">{gscConn.sitemapUrl}</p>
                        </div>
                      )}
                      {/* Sitemap actions: list (no run) or auto-discover (saves + queues run) */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={listingSitemaps || !gscConn.propertyId}
                          onClick={() => void handleListSitemaps()}
                        >
                          {listingSitemaps ? 'Loading…' : 'Browse sitemaps from GSC'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={discoveringSitemaps || !gscConn.propertyId}
                          onClick={handleDiscoverSitemaps}
                        >
                          {discoveringSitemaps ? 'Discovering…' : 'Auto-discover and queue inspection'}
                        </Button>
                      </div>
                      <p className="text-xs text-zinc-500">Browse lists available sitemaps without queueing a run. Auto-discover saves the primary sitemap and queues an inspection.</p>
                      {discoveredSitemaps && discoveredSitemaps.length > 0 && (
                        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3 space-y-2">
                          <p className="text-xs uppercase tracking-wide text-zinc-500">Sitemaps ({discoveredSitemaps.length})</p>
                          {discoveredSitemaps.map((s) => {
                            const content = s.contents?.[0]
                            return (
                              <div key={s.path} className="flex items-start justify-between gap-2 text-xs">
                                <div>
                                  <p className="text-zinc-200 break-all">{s.path}</p>
                                  {s.lastSubmitted && (
                                    <p className="text-zinc-500">Submitted: {s.lastSubmitted.split('T')[0]}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                  {content && (
                                    <div className="text-right">
                                      <p className="text-zinc-300">{content.indexed} / {content.submitted}</p>
                                      <p className="text-zinc-500">indexed</p>
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                    onClick={() => setSitemapUrlInput(s.path)}
                                  >
                                    Use
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      <div className="flex flex-col gap-2 lg:flex-row">
                        <input
                          className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                          type="url"
                          placeholder={gscConn.sitemapUrl ? 'Update sitemap URL…' : 'https://example.com/sitemap.xml'}
                          value={sitemapUrlInput}
                          onChange={(e) => setSitemapUrlInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && sitemapUrlInput.trim() && void handleSaveSitemap()}
                        />
                        <Button type="button" size="sm" disabled={savingSitemap || !sitemapUrlInput.trim()} onClick={handleSaveSitemap}>
                          {savingSitemap ? 'Saving…' : gscConn.sitemapUrl ? 'Update' : 'Save'}
                        </Button>
                      </div>
                      <div className="flex flex-col gap-2 lg:flex-row">
                        <input
                          className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                          type="url"
                          placeholder="Sitemap URL for inspection (leave empty for saved default)"
                          id={`gsc-sitemap-inspect-${projectName}`}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={inspectingSitemap || !gscConn.propertyId}
                          onClick={() => {
                            const el = document.getElementById(`gsc-sitemap-inspect-${projectName}`) as HTMLInputElement | null
                            const url = el?.value?.trim() || gscConn.sitemapUrl || undefined
                            setInspectingSitemap(true)
                            void triggerInspectSitemap(projectName, { sitemapUrl: url }).then((run) => {
                              setNotice(`Sitemap inspection queued (run ${run.id}). Refresh coverage after the run completes.`)
                            }).catch((err) => {
                              setError(err instanceof Error ? err.message : 'Failed to queue sitemap inspection')
                            }).finally(() => setInspectingSitemap(false))
                          }}
                        >
                          {inspectingSitemap ? 'Queueing…' : 'Inspect sitemap'}
                        </Button>
                      </div>
                      {!gscConn.propertyId && (
                        <p className="text-xs text-amber-400">Select a Search Console property first.</p>
                      )}
                    </div>
                  </Card>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function ProjectSettingsSection({
  project,
  onUpdateProject,
}: {
  project: { name: string; displayName: string; canonicalDomain: string; ownedDomains: string[]; country: string; language: string; locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }
  onUpdateProject: (projectName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(project.displayName)
  const [canonicalDomain, setCanonicalDomain] = useState(project.canonicalDomain)
  const [country, setCountry] = useState(project.country)
  const [language, setLanguage] = useState(project.language)
  const [ownedDomains, setOwnedDomains] = useState<string[]>(project.ownedDomains ?? [])
  const [newDomain, setNewDomain] = useState('')

  // Location management state
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationWorking, setLocationWorking] = useState(false)
  const [showAddLocation, setShowAddLocation] = useState(false)
  const [newLocLabel, setNewLocLabel] = useState('')
  const [newLocCity, setNewLocCity] = useState('')
  const [newLocRegion, setNewLocRegion] = useState('')
  const [newLocCountry, setNewLocCountry] = useState('')
  const [newLocTimezone, setNewLocTimezone] = useState('')

  // Sync local state when project prop changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setDisplayName(project.displayName)
      setCanonicalDomain(project.canonicalDomain)
      setCountry(project.country)
      setLanguage(project.language)
      setOwnedDomains(project.ownedDomains ?? [])
    }
  }, [project, editing])

  function handleCancel() {
    setEditing(false)
    setError(null)
    setDisplayName(project.displayName)
    setCanonicalDomain(project.canonicalDomain)
    setCountry(project.country)
    setLanguage(project.language)
    setOwnedDomains(project.ownedDomains ?? [])
    setNewDomain('')
  }

  function handleAddDomain() {
    const d = newDomain.trim()
    if (!d) return
    if (!ownedDomains.includes(d)) {
      setOwnedDomains([...ownedDomains, d])
    }
    setNewDomain('')
  }

  function handleRemoveDomain(domain: string) {
    setOwnedDomains(ownedDomains.filter(d => d !== domain))
  }

  async function handleSave() {
    if (!displayName.trim() || !canonicalDomain.trim() || !country.trim() || !language.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onUpdateProject(project.name, {
        displayName: displayName.trim(),
        canonicalDomain: canonicalDomain.trim(),
        ownedDomains,
        country: country.trim(),
        language: language.trim(),
      })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleAddLocation() {
    const label = newLocLabel.trim()
    const city = newLocCity.trim()
    const region = newLocRegion.trim()
    const locCountry = newLocCountry.trim()
    if (!label || !city || !region || !locCountry) return
    setLocationWorking(true)
    setLocationError(null)
    try {
      const loc: ApiLocation = { label, city, region, country: locCountry }
      if (newLocTimezone.trim()) loc.timezone = newLocTimezone.trim()
      await addLocation(project.name, loc)
      await onUpdateProject(project.name, {})
      setNewLocLabel('')
      setNewLocCity('')
      setNewLocRegion('')
      setNewLocCountry('')
      setNewLocTimezone('')
      setShowAddLocation(false)
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to add location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleRemoveLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await removeLocation(project.name, label)
      await onUpdateProject(project.name, {})
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to remove location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleSetDefaultLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await setDefaultLocation(project.name, label)
      await onUpdateProject(project.name, {})
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to set default location')
    } finally {
      setLocationWorking(false)
    }
  }

  const hasChanges = displayName !== project.displayName ||
    canonicalDomain !== project.canonicalDomain ||
    country !== project.country ||
    language !== project.language ||
    JSON.stringify(ownedDomains) !== JSON.stringify(project.ownedDomains ?? [])

  const inputClass = 'w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none'
  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1'
  const newLocValid = newLocLabel.trim() && newLocCity.trim() && newLocRegion.trim() && newLocCountry.trim()

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Configuration</p>
          <h2>Project settings</h2>
        </div>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit settings
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
          {error}
          <button type="button" className="ml-2 text-rose-400 hover:text-rose-200" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {editing ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Display name</label>
              <input className={inputClass} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Project" />
            </div>
            <div>
              <label className={labelClass}>Canonical domain</label>
              <input className={inputClass} type="text" value={canonicalDomain} onChange={(e) => setCanonicalDomain(e.target.value)} placeholder="example.com" />
            </div>
            <div>
              <label className={labelClass}>Country</label>
              <input className={inputClass} type="text" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US" maxLength={2} />
            </div>
            <div>
              <label className={labelClass}>Language</label>
              <input className={inputClass} type="text" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
            </div>
          </div>

          <div>
            <label className={labelClass}>Owned domains</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ownedDomains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">
                  {d}
                  <button type="button" className="ml-0.5 text-zinc-500 hover:text-zinc-200 transition-colors" onClick={() => handleRemoveDomain(d)} aria-label={`Remove ${d}`}>×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className={`${inputClass} flex-1`}
                type="text"
                placeholder="docs.example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddDomain())}
              />
              <Button type="button" variant="outline" size="sm" disabled={!newDomain.trim()} onClick={handleAddDomain}>
                Add
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/60">
            <Button type="button" disabled={saving || !hasChanges || !displayName.trim() || !canonicalDomain.trim()} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium w-40">Display name</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.displayName || '—'}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Canonical domain</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.canonicalDomain}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Owned domains</td>
                <td className="px-4 py-2.5">
                  {(project.ownedDomains ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.ownedDomains.map((d) => (
                        <span key={d} className="rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">{d}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-zinc-500">—</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Country</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.country}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Language</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.language}</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-500 font-medium align-top pt-3">Locations</td>
                <td className="px-4 py-2.5">
                  {locationError && (
                    <div className="mb-2 rounded border border-rose-800/40 bg-rose-950/20 px-2 py-1 text-xs text-rose-300">
                      {locationError}
                      <button type="button" className="ml-1 text-rose-400 hover:text-rose-200" onClick={() => setLocationError(null)}>×</button>
                    </div>
                  )}
                  {(project.locations ?? []).length > 0 ? (
                    <table className="w-full text-xs mb-2">
                      <thead>
                        <tr className="text-zinc-600">
                          <th className="text-left pb-1 font-medium pr-3">Label</th>
                          <th className="text-left pb-1 font-medium pr-3">City</th>
                          <th className="text-left pb-1 font-medium pr-3">Region</th>
                          <th className="text-left pb-1 font-medium pr-3">Country</th>
                          <th className="text-left pb-1 font-medium pr-3">Timezone</th>
                          <th className="pb-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {project.locations.map((loc) => (
                          <tr key={loc.label} className="border-t border-zinc-800/30">
                            <td className="py-1.5 pr-3">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${loc.label === project.defaultLocation ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300' : 'border-zinc-700/60 bg-zinc-800/40 text-zinc-300'}`}>
                                {loc.label}{loc.label === project.defaultLocation ? ' ★' : ''}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.city}</td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.region}</td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.country}</td>
                            <td className="py-1.5 pr-3 text-zinc-500">{loc.timezone ?? '—'}</td>
                            <td className="py-1.5">
                              <div className="flex items-center gap-1.5">
                                {loc.label !== project.defaultLocation && (
                                  <button
                                    type="button"
                                    disabled={locationWorking}
                                    onClick={() => handleSetDefaultLocation(loc.label)}
                                    className="text-[10px] text-zinc-500 hover:text-emerald-400 transition-colors disabled:opacity-40"
                                    aria-label={`Set ${loc.label} as default location`}
                                  >
                                    Set default
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={locationWorking}
                                  onClick={() => handleRemoveLocation(loc.label)}
                                  className="text-[10px] text-zinc-500 hover:text-rose-400 transition-colors disabled:opacity-40"
                                  aria-label={`Remove location ${loc.label}`}
                                >
                                  Remove
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-zinc-500 text-xs mb-2">No locations configured</p>
                  )}
                  {showAddLocation ? (
                    <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Add location</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Label *</label>
                          <input className={inputClass} type="text" value={newLocLabel} onChange={(e) => setNewLocLabel(e.target.value)} placeholder="nyc" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">City *</label>
                          <input className={inputClass} type="text" value={newLocCity} onChange={(e) => setNewLocCity(e.target.value)} placeholder="New York" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Region *</label>
                          <input className={inputClass} type="text" value={newLocRegion} onChange={(e) => setNewLocRegion(e.target.value)} placeholder="NY" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Country *</label>
                          <input className={inputClass} type="text" value={newLocCountry} onChange={(e) => setNewLocCountry(e.target.value)} placeholder="US" maxLength={2} />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Timezone (optional)</label>
                          <input className={inputClass} type="text" value={newLocTimezone} onChange={(e) => setNewLocTimezone(e.target.value)} placeholder="America/New_York" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button type="button" size="sm" disabled={locationWorking || !newLocValid} onClick={handleAddLocation}>
                          {locationWorking ? 'Adding...' : 'Add location'}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={locationWorking} onClick={() => { setShowAddLocation(false); setLocationError(null) }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setShowAddLocation(true)}>
                      + Add location
                    </Button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// --- Schedule helpers ---
const FREQ_OPTIONS = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly@mon', label: 'Every Monday' },
  { value: 'weekly@wed', label: 'Every Wednesday' },
  { value: 'weekly@fri', label: 'Every Friday' },
  { value: 'twice-daily', label: 'Twice a day (6am & 6pm)' },
  { value: 'custom', label: 'Custom cron expression' },
] as const

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
] as const

function formatHour(h: number): string {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

function buildPreset(freq: string, hour: number): string {
  if (freq === 'twice-daily') return 'twice-daily'
  if (freq.startsWith('weekly@')) return `${freq}@${hour}`
  return `daily@${hour}`
}

function parsePreset(preset: string | null, cronExpr: string): { freq: string; hour: number; customCron: string } {
  if (!preset) return { freq: 'custom', hour: 6, customCron: cronExpr }
  if (preset === 'twice-daily') return { freq: 'twice-daily', hour: 6, customCron: '' }
  const dailyMatch = preset.match(/^daily(?:@(\d+))?$/)
  if (dailyMatch) return { freq: 'daily', hour: dailyMatch[1] ? parseInt(dailyMatch[1]) : 6, customCron: '' }
  const weeklyMatch = preset.match(/^(weekly@(?:mon|tue|wed|thu|fri|sat|sun))(?:@(\d+))?$/)
  if (weeklyMatch) return { freq: weeklyMatch[1], hour: weeklyMatch[2] ? parseInt(weeklyMatch[2]) : 6, customCron: '' }
  return { freq: 'custom', hour: 6, customCron: cronExpr }
}

function scheduleLabel(preset: string | null, cronExpr: string, timezone: string): string {
  const tzShort = timezone === 'UTC' ? 'UTC' : (timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone)
  if (!preset) return `Custom: ${cronExpr} · ${tzShort}`
  if (preset === 'twice-daily') return `Twice a day (6am & 6pm) · ${tzShort}`
  const dailyMatch = preset.match(/^daily(?:@(\d+))?$/)
  if (dailyMatch) {
    const h = dailyMatch[1] ? parseInt(dailyMatch[1]) : 6
    return `Every day at ${formatHour(h)} · ${tzShort}`
  }
  const weeklyMatch = preset.match(/^weekly@(mon|tue|wed|thu|fri|sat|sun)(?:@(\d+))?$/)
  if (weeklyMatch) {
    const days: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }
    const h = weeklyMatch[2] ? parseInt(weeklyMatch[2]) : 6
    return `Every ${days[weeklyMatch[1]]} at ${formatHour(h)} · ${tzShort}`
  }
  return `${preset} · ${tzShort}`
}

function ScheduleSection({ projectName }: { projectName: string }) {
  const [schedule, setSchedule] = useState<ApiSchedule | null | 'loading'>('loading')
  const [editing, setEditing] = useState(false)
  const [freq, setFreq] = useState('daily')
  const [hour, setHour] = useState(6)
  const [customCron, setCustomCron] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [tzOther, setTzOther] = useState(false)
  const [tzOtherValue, setTzOtherValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSchedule(projectName).then(setSchedule).catch(() => setSchedule(null))
  }, [projectName])

  const startEditing = () => {
    if (schedule && schedule !== 'loading') {
      const parsed = parsePreset(schedule.preset ?? null, schedule.cronExpr)
      setFreq(parsed.freq)
      setHour(parsed.hour)
      setCustomCron(parsed.customCron)
      const isKnownTz = (COMMON_TIMEZONES as readonly string[]).includes(schedule.timezone)
      setTimezone(isKnownTz ? schedule.timezone : 'Other')
      setTzOther(!isKnownTz)
      setTzOtherValue(isKnownTz ? '' : schedule.timezone)
    } else {
      setFreq('daily')
      setHour(6)
      setCustomCron('')
      setTimezone('UTC')
      setTzOther(false)
      setTzOtherValue('')
    }
    setError(null)
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const effectiveTz = tzOther ? tzOtherValue.trim() || 'UTC' : timezone
      const body: Parameters<typeof saveSchedule>[1] = { timezone: effectiveTz }
      if (freq === 'custom') body.cron = customCron.trim()
      else body.preset = buildPreset(freq, hour)
      const result = await saveSchedule(projectName, body)
      setSchedule(result)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async () => {
    if (!schedule || schedule === 'loading') return
    setSaving(true)
    setError(null)
    try {
      const body: Parameters<typeof saveSchedule>[1] = {
        timezone: schedule.timezone,
        enabled: !schedule.enabled,
      }
      if (schedule.preset) body.preset = schedule.preset
      else body.cron = schedule.cronExpr
      setSchedule(await saveSchedule(projectName, body))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update schedule')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    setRemoving(true)
    setError(null)
    try {
      await removeSchedule(projectName)
      setSchedule(null)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove schedule')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Automation</p>
          <h2>Scheduled runs</h2>
        </div>
        {schedule !== 'loading' && !editing && (
          <Button type="button" variant="outline" size="sm" onClick={startEditing}>
            {schedule ? 'Edit schedule' : '+ Set schedule'}
          </Button>
        )}
      </div>

      {schedule === 'loading' && <p className="supporting-copy">Loading...</p>}

      {schedule !== 'loading' && !editing && schedule === null && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No schedule configured. Set one to automatically trigger visibility sweeps.</p>
        </Card>
      )}

      {schedule !== 'loading' && !editing && schedule !== null && (
        <Card className="surface-card compact-card">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium text-zinc-200">{scheduleLabel(schedule.preset ?? null, schedule.cronExpr, schedule.timezone)}</p>
              <p className="text-xs text-zinc-500">Cron: <span className="font-mono">{schedule.cronExpr}</span></p>
              {schedule.nextRunAt && (
                <p className="text-xs text-zinc-500">Next run: {new Date(schedule.nextRunAt).toLocaleString()}</p>
              )}
              {schedule.lastRunAt && (
                <p className="text-xs text-zinc-500">Last run: {new Date(schedule.lastRunAt).toLocaleString()}</p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <ToneBadge tone={schedule.enabled ? 'positive' : 'neutral'}>
                {schedule.enabled ? 'Active' : 'Paused'}
              </ToneBadge>
              <Button type="button" variant="outline" size="sm" disabled={saving} onClick={handleToggleEnabled}>
                {schedule.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={removing} onClick={handleRemove}>
                {removing ? 'Removing...' : 'Remove'}
              </Button>
            </div>
          </div>
          {error && <p className="text-rose-400 text-sm mt-2">{error}</p>}
        </Card>
      )}

      {editing && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Frequency</label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
                value={freq}
                onChange={(e) => setFreq(e.target.value)}
              >
                {FREQ_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Time</label>
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none disabled:opacity-40"
                value={hour}
                disabled={freq === 'twice-daily' || freq === 'custom'}
                onChange={(e) => setHour(parseInt(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHour(i)}</option>
                ))}
              </select>
            </div>
          </div>
          {freq === 'custom' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">Cron expression</label>
              <input
                className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 font-mono focus:border-zinc-500 focus:outline-none"
                type="text"
                placeholder="0 9 * * 1-5"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Timezone</label>
            <select
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
              value={tzOther ? 'Other' : timezone}
              onChange={(e) => {
                if (e.target.value === 'Other') { setTzOther(true); setTimezone('Other') }
                else { setTzOther(false); setTimezone(e.target.value) }
              }}
            >
              {COMMON_TIMEZONES.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
              <option value="Other">Other (enter manually)…</option>
            </select>
            {tzOther && (
              <input
                className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                type="text"
                placeholder="e.g. America/New_York"
                value={tzOtherValue}
                onChange={(e) => setTzOtherValue(e.target.value)}
              />
            )}
          </div>
          {error && <p className="text-rose-400 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => { setEditing(false); setError(null) }}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || (freq === 'custom' && !customCron.trim())}
              onClick={handleSave}
            >
              {saving ? 'Saving...' : 'Save schedule'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

// --- Notification events ---
const NOTIFICATION_EVENTS = [
  { value: 'citation.lost', label: 'Citation lost' },
  { value: 'citation.gained', label: 'Citation gained' },
  { value: 'run.completed', label: 'Run completed' },
  { value: 'run.failed', label: 'Run failed' },
] as const

function NotificationsSection({ projectName }: { projectName: string }) {
  const [notifs, setNotifs] = useState<ApiNotification[] | 'loading'>('loading')
  const [adding, setAdding] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [selectedEvents, setSelectedEvents] = useState<string[]>(['citation.lost', 'citation.gained'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testStates, setTestStates] = useState<Record<string, { state: 'testing' | 'ok' | 'fail'; status?: number }>>({})

  useEffect(() => {
    listNotifications(projectName).then(setNotifs).catch(() => setNotifs([]))
  }, [projectName])

  const toggleEvent = (evt: string) => {
    setSelectedEvents(prev => prev.includes(evt) ? prev.filter(e => e !== evt) : [...prev, evt])
  }

  const handleAdd = async () => {
    if (!webhookUrl.trim() || selectedEvents.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const result = await addNotification(projectName, {
        channel: 'webhook',
        url: webhookUrl.trim(),
        events: selectedEvents,
      })
      setNotifs(prev => prev === 'loading' ? [result] : [...prev, result])
      setWebhookUrl('')
      setSelectedEvents(['citation.lost', 'citation.gained'])
      setAdding(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add webhook')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await removeNotification(projectName, id)
      setNotifs(prev => prev === 'loading' ? prev : prev.filter(n => n.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove webhook')
    }
  }

  const handleTest = async (id: string) => {
    setTestStates(prev => ({ ...prev, [id]: { state: 'testing' } }))
    try {
      const result = await sendTestNotification(projectName, id)
      setTestStates(prev => ({ ...prev, [id]: { state: result.ok ? 'ok' : 'fail', status: result.status } }))
    } catch {
      setTestStates(prev => ({ ...prev, [id]: { state: 'fail' } }))
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Automation</p>
          <h2>Notifications</h2>
        </div>
        {notifs !== 'loading' && (
          <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(!adding); setError(null) }}>
            {adding ? 'Cancel' : '+ Add webhook'}
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Webhook URL</label>
            <input
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              type="url"
              placeholder="https://hooks.example.com/canonry"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-400">Trigger on</label>
            <div className="flex flex-wrap gap-3">
              {NOTIFICATION_EVENTS.map(evt => (
                <label key={evt.value} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    className="rounded border-zinc-600 bg-zinc-800"
                    checked={selectedEvents.includes(evt.value)}
                    onChange={() => toggleEvent(evt.value)}
                  />
                  <span className="text-sm text-zinc-300">{evt.label}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <p className="text-rose-400 text-sm">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(false); setError(null) }}>Cancel</Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || !webhookUrl.trim() || selectedEvents.length === 0}
              onClick={handleAdd}
            >
              {saving ? 'Adding...' : 'Add webhook'}
            </Button>
          </div>
        </div>
      )}

      {notifs === 'loading' && <p className="supporting-copy">Loading...</p>}

      {notifs !== 'loading' && notifs.length === 0 && !adding && (
        <Card className="surface-card compact-card">
          <p className="supporting-copy">No webhooks configured. Add one to get alerted when citations change or runs complete.</p>
        </Card>
      )}

      {notifs !== 'loading' && notifs.length > 0 && (
        <div className="evidence-table-wrap">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {notifs.map(n => (
                <tr key={n.id}>
                  <td className="evidence-keyword-cell">
                    <span className="font-mono text-xs text-zinc-300 break-all">{n.url}</span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {n.events.map(evt => (
                        <span key={evt} className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
                          {evt.replace('.', ' ')}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <ToneBadge tone={n.enabled ? 'positive' : 'neutral'}>
                      {n.enabled ? 'Active' : 'Paused'}
                    </ToneBadge>
                  </td>
                  <td>
                    <div className="flex items-center gap-1 justify-end">
                      {testStates[n.id] && (() => {
                        const t = testStates[n.id]
                        const label = t.state === 'testing' ? 'Sending…'
                          : t.state === 'ok' ? `Delivered${t.status ? ` (${t.status})` : ''}`
                          : `Failed${t.status ? ` (${t.status})` : ''}`
                        return (
                          <ToneBadge tone={t.state === 'ok' ? 'positive' : t.state === 'fail' ? 'negative' : 'neutral'}>
                            {label}
                          </ToneBadge>
                        )
                      })()}
                      <Button variant="ghost" size="sm" type="button" disabled={testStates[n.id]?.state === 'testing'} onClick={() => handleTest(n.id)}>
                        Test
                      </Button>
                      <Button variant="ghost" size="sm" type="button" onClick={() => handleRemove(n.id)}>
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <p className="text-rose-400 text-sm mt-2">{error}</p>}
        </div>
      )}
    </section>
  )
}

function RunsPage({ runs, onOpenRun, onTriggerAll }: { runs: RunListItemVm[]; onOpenRun: (runId: string) => void; onTriggerAll?: () => void }) {
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
        {onTriggerAll && (
          <Button type="button" variant="outline" size="sm" onClick={onTriggerAll}>
            Run all projects
          </Button>
        )}
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

const PROVIDER_KEY_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://platform.claude.com/settings/keys',
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  claude: 'Claude',
  local: 'Local',
}

const PROVIDER_MODEL_PLACEHOLDERS: Record<string, string> = {
  gemini: 'e.g. gemini-3-flash',
  openai: 'e.g. gpt-5.4',
  claude: 'e.g. claude-sonnet-4-6',
  local: 'e.g. llama3, mistral',
}

function ProviderConfigForm({ providerName, onSaved }: { providerName: string; onSaved: () => void }) {
  const isLocal = providerName.toLowerCase() === 'local'
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('')
  const [maxPerMinute, setMaxPerMinute] = useState('')
  const [maxPerDay, setMaxPerDay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = isLocal ? baseUrl.trim().length > 0 : apiKey.trim().length > 0

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      const quota: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number } = {}
      if (maxConcurrency.trim()) quota.maxConcurrency = parseInt(maxConcurrency.trim(), 10)
      if (maxPerMinute.trim()) quota.maxRequestsPerMinute = parseInt(maxPerMinute.trim(), 10)
      if (maxPerDay.trim()) quota.maxRequestsPerDay = parseInt(maxPerDay.trim(), 10)
      await updateProviderConfig(providerName.toLowerCase(), {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(Object.keys(quota).length > 0 ? { quota } : {}),
      })
      setApiKey('')
      setBaseUrl('')
      setModel('')
      setMaxConcurrency('')
      setMaxPerMinute('')
      setMaxPerDay('')
      setSuccess(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update provider')
    } finally {
      setSaving(false)
    }
  }

  const keyUrl = PROVIDER_KEY_URLS[providerName.toLowerCase()]
  const modelPlaceholder = PROVIDER_MODEL_PLACEHOLDERS[providerName.toLowerCase()] ?? 'Use default model'

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      {isLocal && (
        <div>
          <label className="text-xs text-zinc-500" htmlFor={`base-url-${providerName}`}>Base URL</label>
          <input
            id={`base-url-${providerName}`}
            type="text"
            className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
            placeholder="http://localhost:11434/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="mt-0.5 text-[10px] text-zinc-600">Any OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp, vLLM</p>
        </div>
      )}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-500" htmlFor={`api-key-${providerName}`}>
            API Key{isLocal ? ' (optional)' : ''}
          </label>
          {keyUrl && (
            <a
              href={keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
            >
              Get API key ↗
            </a>
          )}
        </div>
        <input
          id={`api-key-${providerName}`}
          type="password"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder={isLocal ? 'Optional — most local servers don\'t need one' : `Enter ${providerName} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-zinc-500" htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder={modelPlaceholder}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-zinc-500">Quota (optional)</label>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder="Concurrent"
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-zinc-600">Max concurrent</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder="/min"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-zinc-600">Per minute</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder="/day"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
            <p className="mt-0.5 text-[10px] text-zinc-600">Per day</p>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Provider updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={handleSave}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  )
}

function GoogleOAuthConfigForm({ onSaved }: { onSaved: () => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setSuccess(false)
    try {
      await updateGoogleAuthConfig({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      })
      setClientId('')
      setClientSecret('')
      setSuccess(true)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Google OAuth credentials')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-500" htmlFor="google-client-id">Client ID</label>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2"
          >
            Google Cloud ↗
          </a>
        </div>
        <input
          id="google-client-id"
          type="text"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder="Google OAuth client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs text-zinc-500" htmlFor="google-client-secret">Client secret</label>
        <input
          id="google-client-secret"
          type="password"
          className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
          placeholder="Google OAuth client secret"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </div>
      <p className="text-[11px] text-zinc-500">
        These credentials are stored in <code>~/.canonry/config.yaml</code>. Project-level Search Console connections are created separately per canonical domain.
      </p>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {success && <p className="text-xs text-emerald-400">Google OAuth credentials updated.</p>}
      <Button type="button" size="sm" disabled={!canSave || saving} onClick={handleSave}>
        {saving ? 'Saving...' : 'Save Google OAuth app'}
      </Button>
    </div>
  )
}

function SettingsPage({
  settings,
  healthSnapshot,
  onSettingsChanged,
}: {
  settings: SettingsVm
  healthSnapshot: HealthSnapshot
  onSettingsChanged?: () => void
}) {
  const [configuringProvider, setConfiguringProvider] = useState<string | null>(null)
  const [configuringGoogle, setConfiguringGoogle] = useState(false)

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Provider state, Google OAuth setup, and service health.</p>
        </div>
      </div>

      <section className="settings-grid">
        {settings.providerStatuses.map((provider) => (
          <Card key={provider.name} className="surface-card">
            <div className="section-head">
              <div>
                <p className="eyebrow eyebrow-soft">Provider</p>
                <h2>{provider.name}</h2>
              </div>
              <ToneBadge tone={provider.state === 'ready' ? 'positive' : 'caution'}>
                {provider.state === 'ready' ? 'Ready' : 'Needs config'}
              </ToneBadge>
            </div>
            <dl className="definition-list mt-3">
              <div>
                <dt>Model</dt>
                <dd className="font-mono text-xs">{provider.model}</dd>
              </div>
              {provider.quota && (
                <>
                  <div>
                    <dt>Concurrency</dt>
                    <dd>{provider.quota.maxConcurrency}</dd>
                  </div>
                  <div>
                    <dt>Rate limit</dt>
                    <dd>{provider.quota.maxRequestsPerMinute}/min · {provider.quota.maxRequestsPerDay}/day</dd>
                  </div>
                </>
              )}
            </dl>
            <p className="mt-2 text-sm text-zinc-500">{provider.detail}</p>
            <div className="mt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfiguringProvider(configuringProvider === provider.name ? null : provider.name)}
              >
                {configuringProvider === provider.name ? 'Cancel' : provider.state === 'ready' ? (provider.name.toLowerCase() === 'local' ? 'Update config' : 'Update key') : 'Configure'}
              </Button>
            </div>
            {configuringProvider === provider.name && (
              <ProviderConfigForm
                providerName={provider.name}
                onSaved={() => {
                  setConfiguringProvider(null)
                  onSettingsChanged?.()
                }}
              />
            )}
          </Card>
        ))}

        <Card className="surface-card">
          <div className="section-head">
            <div>
              <p className="eyebrow eyebrow-soft">Google</p>
              <h2>Search Console OAuth</h2>
            </div>
            <ToneBadge tone={settings.google.state === 'ready' ? 'positive' : 'caution'}>
              {settings.google.state === 'ready' ? 'Ready' : 'Needs config'}
            </ToneBadge>
          </div>
          <dl className="definition-list mt-3">
            <div>
              <dt>Auth model</dt>
              <dd>One app credential set, then one OAuth connection per project domain</dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd className="font-mono text-xs">~/.canonry/config.yaml</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-zinc-500">{settings.google.detail}</p>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfiguringGoogle(!configuringGoogle)}
            >
              {configuringGoogle ? 'Cancel' : settings.google.state === 'ready' ? 'Update OAuth app' : 'Configure Google OAuth'}
            </Button>
          </div>
          {configuringGoogle && (
            <GoogleOAuthConfigForm
              onSaved={() => {
                setConfiguringGoogle(false)
                onSettingsChanged?.()
              }}
            />
          )}
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

function SetupPage({
  model,
  settings,
  onProjectCreated,
  onNavigate,
}: {
  model: SetupWizardVm
  settings: SettingsVm
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
  const [runError, setRunError] = useState<string | null>(null)
  const [runSaving, setRunSaving] = useState(false)

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
                    {check.id === 'provider' && check.state !== 'ready' && (
                      <button
                        type="button"
                        className="text-emerald-400 hover:text-emerald-300 text-sm mt-1 underline underline-offset-2 cursor-pointer bg-transparent border-none p-0"
                        onClick={() => onNavigate('/settings')}
                      >
                        Configure providers
                      </button>
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
                            <option key={p.name} value={p.name}>{PROVIDER_DISPLAY_NAMES[p.name] ?? p.name}{p.model ? ` (${p.model})` : ''}</option>
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

/**
 * Split text on highlight terms and return ReactNodes with <mark> spans for matches.
 * Also handles **bold** markdown. Bold is parsed first so highlight splits don't
 * break ** markers apart.
 */
function highlightTermsInText(text: string, terms: string[]): ReactNode[] {
  const nonEmpty = terms.filter(t => t.trim().length > 1)

  // Step 1: parse **bold** spans into typed segments
  type Segment = { type: 'text' | 'bold'; value: string }
  const segments: Segment[] = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(seg => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return { type: 'bold' as const, value: seg.slice(2, -2) }
    }
    return { type: 'text' as const, value: seg }
  })

  if (nonEmpty.length === 0) {
    return segments.map((seg, i) =>
      seg.type === 'bold'
        ? <strong key={`b-${i}`} className="text-zinc-200 font-semibold">{seg.value}</strong>
        : seg.value,
    ).filter(Boolean) as ReactNode[]
  }

  // Step 2: within each segment, split on highlight terms
  const escaped = nonEmpty.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')

  return segments.flatMap((seg, si) => {
    const parts = seg.value.split(regex)
    return parts.map((part, pi) => {
      if (!part) return null
      const isMatch = pi % 2 === 1
      if (isMatch) {
        return seg.type === 'bold'
          ? <mark key={`hl-${si}-${pi}`} className="answer-highlight"><strong className="text-zinc-200 font-semibold">{part}</strong></mark>
          : <mark key={`hl-${si}-${pi}`} className="answer-highlight">{part}</mark>
      }
      return seg.type === 'bold'
        ? <strong key={`b-${si}-${pi}`} className="text-zinc-200 font-semibold">{part}</strong>
        : part
    })
  }).filter(Boolean) as ReactNode[]
}

/** Shape of snapshot data used for display — works for both current evidence and fetched historical snapshots. */
interface EvidenceDisplayData {
  citationState: string
  provider: string
  model: string | null
  answerSnippet: string
  citedDomains: string[]
  competitorDomains: string[]
  groundingSources: GroundingSource[]
  evidenceUrls: string[]
  changeLabel: string
  summary: string
}

function EvidenceDetailModal({
  evidence,
  project,
  onClose,
}: {
  evidence: CitationInsightVm
  project: ProjectCommandCenterVm
  onClose: () => void
}) {
  const [showFullAnswer, setShowFullAnswer] = useState(false)
  const [selectedRunIdx, setSelectedRunIdx] = useState(-1) // -1 = latest (current)
  const [historicalSnapshot, setHistoricalSnapshot] = useState<EvidenceDisplayData | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  // Cache fetched run details so re-clicking a dot is instant
  const [runCache, setRunCache] = useState<Record<string, EvidenceDisplayData>>({})

  const projectDomains = effectiveDomains(project.project)
  const myDomains = new Set(projectDomains.map(normalizeProjectDomain))
  const history = evidence.runHistory
  const hasHistory = history.length > 1

  // Current display data — from historical snapshot when viewing past runs, otherwise from latest evidence
  const isViewingHistory = selectedRunIdx >= 0 && historicalSnapshot !== null
  const display: EvidenceDisplayData = isViewingHistory ? historicalSnapshot : {
    citationState: evidence.citationState,
    provider: evidence.provider,
    model: evidence.model,
    answerSnippet: evidence.answerSnippet,
    citedDomains: evidence.citedDomains,
    competitorDomains: evidence.competitorDomains,
    groundingSources: evidence.groundingSources,
    evidenceUrls: evidence.evidenceUrls,
    changeLabel: evidence.changeLabel,
    summary: evidence.summary,
  }

  const isCited = display.citationState === 'cited' || display.citationState === 'emerging'
  const positionIndex = display.citedDomains.findIndex(
    d => myDomains.has(d.toLowerCase().replace(/^www\./, '')),
  )
  const position = positionIndex + 1
  const totalCited = display.citedDomains.length

  // Terms to highlight in the AI answer
  const projectDisplayName = project.project.displayName || project.project.name
  const highlightTerms = [
    ...projectDomains.map(normalizeProjectDomain),
    projectDisplayName,
    projectDisplayName.split(' ').slice(0, 2).join(' '),
  ].filter(t => t.trim().length > 2)

  // State key for CSS variants
  const stateKey: 'cited' | 'not-cited' | 'lost' | 'pending' =
    isCited ? 'cited' :
    display.citationState === 'lost' ? 'lost' :
    display.citationState === 'pending' ? 'pending' : 'not-cited'

  // Guard against out-of-order async completions when clicking dots quickly
  const activeRequestRef = useRef(0)

  // Fetch historical run data when a dot is clicked
  const selectHistoricalRun = useCallback(async (idx: number) => {
    const requestId = ++activeRequestRef.current

    if (idx === -1 || idx === history.length - 1) {
      setSelectedRunIdx(-1)
      setHistoricalSnapshot(null)
      setShowFullAnswer(false)
      return
    }
    setSelectedRunIdx(idx)
    setShowFullAnswer(false)

    const run = history[idx]
    // Check cache first
    const cacheKey = `${run.runId}::${evidence.keyword}::${evidence.provider}`
    if (runCache[cacheKey]) {
      setHistoricalSnapshot(runCache[cacheKey])
      return
    }

    setLoadingHistory(true)
    try {
      const runDetail = await fetchRunDetail(run.runId)
      // Discard result if a newer request was fired while we were fetching
      if (requestId !== activeRequestRef.current) return

      // Find the snapshot matching this keyword + provider
      const snap = runDetail.snapshots.find(
        s => s.keyword === evidence.keyword && s.provider === evidence.provider,
      ) ?? runDetail.snapshots.find(
        s => s.keyword === evidence.keyword,
      )

      const data: EvidenceDisplayData = snap ? {
        citationState: snap.citationState,
        provider: snap.provider,
        model: snap.model ?? null,
        answerSnippet: snap.answerText ?? '',
        citedDomains: snap.citedDomains,
        competitorDomains: snap.competitorOverlap,
        groundingSources: snap.groundingSources,
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: '',
      } : {
        citationState: run.citationState,
        provider: evidence.provider,
        model: run.model ?? null,
        answerSnippet: '',
        citedDomains: [],
        competitorDomains: [],
        groundingSources: [],
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: 'Snapshot data not available for this run.',
      }

      setRunCache(prev => ({ ...prev, [cacheKey]: data }))
      setHistoricalSnapshot(data)
    } catch {
      if (requestId !== activeRequestRef.current) return
      setHistoricalSnapshot({
        citationState: run.citationState,
        provider: evidence.provider,
        model: run.model ?? null,
        answerSnippet: '',
        citedDomains: [],
        competitorDomains: [],
        groundingSources: [],
        evidenceUrls: [],
        changeLabel: run.citationState,
        summary: 'Failed to load historical run data.',
      })
    } finally {
      if (requestId === activeRequestRef.current) {
        setLoadingHistory(false)
      }
    }
  }, [history, evidence.keyword, evidence.provider, runCache])

  // Hero copy
  const showModelInHeadline = isViewingHistory || evidence.historyScope !== 'provider'
  const providerMeta = showModelInHeadline && display.model
    ? `${display.provider} (${display.model}) · ${display.changeLabel.toLowerCase()}`
    : `${display.provider} · ${display.changeLabel.toLowerCase()}`
  const providerMetaNote = !isViewingHistory && evidence.historyScope === 'provider'
    ? [
        evidence.model ? `Current model: ${evidence.model}` : null,
        evidence.modelsSeen && evidence.modelsSeen.length > 1 ? `History spans ${evidence.modelsSeen.length} models` : null,
      ].filter(Boolean).join(' · ')
    : ''
  const heroCopy = (() => {
    if (isCited && position > 0) {
      return {
        label: 'Citation confirmed',
        title: `Cited #${position} of ${totalCited} domain${totalCited !== 1 ? 's' : ''}`,
        meta: providerMeta,
      }
    }
    if (isCited) {
      return {
        label: 'Citation confirmed',
        title: 'Cited in this answer',
        meta: providerMeta,
      }
    }
    if (display.citationState === 'lost') {
      return {
        label: 'Citation lost',
        title: totalCited > 0
          ? `${totalCited} domain${totalCited !== 1 ? 's' : ''} cited instead`
          : 'No longer appearing in this answer',
        meta: providerMeta,
      }
    }
    if (display.citationState === 'pending') {
      return {
        label: 'Pending',
        title: 'Awaiting first visibility run',
        meta: 'No provider data yet',
      }
    }
    return {
      label: 'Not in this answer',
      title: totalCited > 0
        ? `${totalCited} domain${totalCited !== 1 ? 's' : ''} cited instead`
        : 'No domains cited for this query',
      meta: providerMeta,
    }
  })()

  // Render markdown-aware AI answer
  const renderHighlightedAnswer = () => {
    if (!display.answerSnippet) return null
    const lines = display.answerSnippet.split('\n')
    const elements: ReactNode[] = []
    let paraLines: string[] = []
    let key = 0

    const flushPara = () => {
      if (paraLines.length === 0) return
      const text = paraLines.join(' ').trim()
      if (text) {
        elements.push(
          <p key={key++} className={elements.length > 0 ? 'mt-2.5' : ''}>
            {highlightTermsInText(text, highlightTerms)}
          </p>,
        )
      }
      paraLines = []
    }

    for (const raw of lines) {
      const line = raw.trim()
      if (/^[-–—]{3,}$/.test(line)) {
        flushPara()
        elements.push(<hr key={key++} className="border-zinc-800/60 my-3" />)
        continue
      }
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
      if (headingMatch) {
        flushPara()
        const level = headingMatch[1].length
        const text = headingMatch[2].replace(/^[\p{Emoji}\p{Emoji_Component}\s#]+/u, '').trim() || headingMatch[2]
        const cls = level === 1
          ? 'text-[13px] font-semibold text-zinc-100 mt-4 mb-1'
          : level === 2
            ? 'text-xs font-semibold text-zinc-200 mt-3 mb-0.5'
            : 'text-xs font-medium text-zinc-300 mt-2'
        elements.push(
          <p key={key++} className={cls}>
            {highlightTermsInText(text, highlightTerms)}
          </p>,
        )
        continue
      }
      if (line === '') {
        flushPara()
        continue
      }
      paraLines.push(line)
    }
    flushPara()
    return elements
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
        <Dialog.Content
          className="evidence-modal"
          aria-describedby={undefined}
        >
          {/* ── Header ── */}
          <div className="evidence-modal-header">
            <div className="min-w-0 flex-1">
              <p className="eyebrow eyebrow-soft">{project.project.name} · {display.provider || 'All providers'}</p>
              <Dialog.Title className="text-lg font-semibold text-zinc-50 truncate">{evidence.keyword}</Dialog.Title>
            </div>
            <Dialog.Close className="inline-flex size-8 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 shrink-0">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>

          {/* ── Run history timeline ── */}
          {hasHistory && (
            <div className="evidence-modal-timeline">
              <p className="drawer-section-label mb-1.5">Run history</p>
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {history.map((run, i) => {
                  const isSelected = (selectedRunIdx === -1 && i === history.length - 1) || selectedRunIdx === i
                  const dotColor = run.citationState === 'cited'
                    ? 'bg-emerald-400' : run.citationState === 'emerging'
                      ? 'bg-amber-400' : run.citationState === 'lost'
                        ? 'bg-rose-400' : 'bg-zinc-600'
                  const date = new Date(run.createdAt)
                  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  const modelChanged = Boolean(run.model && i > 0 && history[i - 1]?.model && history[i - 1]!.model !== run.model)
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`evidence-run-dot ${isSelected ? 'evidence-run-dot--selected' : ''}`}
                      onClick={() => selectHistoricalRun(i === history.length - 1 ? -1 : i)}
                      aria-label={[
                        `Run ${label}: ${run.citationState}`,
                        run.model ? `model ${run.model}` : null,
                        modelChanged ? 'model changed' : null,
                      ].filter(Boolean).join(' — ')}
                      aria-pressed={isSelected}
                    >
                      <span
                        className={`size-2 rounded-full ${dotColor} ${modelChanged ? 'ring-1 ring-amber-300/80 ring-offset-2 ring-offset-zinc-950' : ''}`}
                        aria-hidden="true"
                      />
                      <span className="text-[10px] text-zinc-500">{label}</span>
                    </button>
                  )
                })}
              </div>
              {selectedRunIdx >= 0 && selectedRunIdx < history.length && (
                <p className="text-[11px] text-zinc-500 mt-1">
                  Viewing run from {new Date(history[selectedRunIdx].createdAt).toLocaleString()} — <span className="capitalize">{history[selectedRunIdx].citationState}</span>
                  <button type="button" className="text-zinc-400 hover:text-zinc-200 ml-2" onClick={() => selectHistoricalRun(-1)}>← Back to latest</button>
                </p>
              )}
              {!isViewingHistory && (evidence.modelTransitions?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {evidence.modelTransitions!.map((transition) => (
                    <span
                      key={`${transition.runId}:${transition.toModel ?? 'unknown'}`}
                      className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-100"
                    >
                      {`${transition.fromModel ?? 'unknown'} -> ${transition.toModel ?? 'unknown'} on ${new Date(transition.createdAt).toLocaleDateString()}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Two-column body ── */}
          <div className="evidence-modal-body">
            {loadingHistory && (
              <div className="md:col-span-2 flex items-center justify-center py-12 text-zinc-500 text-sm">
                Loading historical run data…
              </div>
            )}

            {!loadingHistory && (
              <>
                {/* Left: status + AI answer */}
                <div className="evidence-modal-main">
                  {/* Position hero */}
                  <div className={`evidence-position-hero evidence-position-hero--${stateKey}`}>
                    <p className={`evidence-position-label evidence-position-label--${stateKey}`}>
                      {heroCopy.label}
                    </p>
                    <p className={`evidence-position-title evidence-position-title--${stateKey}`}>
                      {heroCopy.title}
                    </p>
                    <p className="evidence-position-meta">{heroCopy.meta}</p>
                    {providerMetaNote && (
                      <p className="mt-1 text-[11px] text-zinc-500">{providerMetaNote}</p>
                    )}
                  </div>

                  {/* AI answer */}
                  {display.answerSnippet && (
                    <div>
                      <p className="drawer-section-label">What the AI said</p>
                      <div className={`answer-snippet-block ${showFullAnswer ? 'evidence-answer-expanded' : 'evidence-answer-collapsed'}`}>
                        {renderHighlightedAnswer()}
                      </div>
                      {display.answerSnippet.length > 280 && (
                        <button
                          type="button"
                          className="mt-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                          onClick={() => setShowFullAnswer(!showFullAnswer)}
                        >
                          {showFullAnswer ? '↑ Collapse' : '↓ Show full answer'}
                        </button>
                      )}
                    </div>
                  )}

                  {!display.answerSnippet && !loadingHistory && (
                    <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/20 px-4 py-8 text-center text-zinc-600 text-sm">
                      No answer text recorded for this run
                    </div>
                  )}

                  {/* Action items — only for latest run */}
                  {!isViewingHistory && evidence.relatedTechnicalSignals.length > 0 && (
                    <div>
                      <p className="drawer-section-label">
                        {isCited ? 'Why you\'re cited' : 'What to fix'}
                      </p>
                      <div className="action-items-list">
                        {evidence.relatedTechnicalSignals.map((signal, i) => (
                          <div key={i} className="action-item">
                            <svg
                              className={`action-item-icon ${isCited ? 'text-emerald-400' : 'text-amber-400'}`}
                              viewBox="0 0 16 16" fill="none" aria-hidden="true"
                            >
                              {isCited
                                ? <path d="M3 8l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                : (
                                  <>
                                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                                    <path d="M8 5v3.5M8 10.5v0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                  </>
                                )
                              }
                            </svg>
                            <span className="action-item-text">{signal}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Summary */}
                  {display.summary && (
                    <p className="text-xs text-zinc-600 border-t border-zinc-800/40 pt-3 mt-1">{display.summary}</p>
                  )}
                </div>

                {/* Right: leaderboard + sources */}
                <div className="evidence-modal-sidebar">
                  {/* Citation leaderboard */}
                  {display.citedDomains.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Who was cited — in order</p>
                      <div className="citation-leaderboard">
                        {display.citedDomains.map((domain, i) => {
                          const norm = domain.toLowerCase().replace(/^www\./, '')
                          const isYou = myDomains.has(norm)
                          const isCompetitor = !isYou && display.competitorDomains.some(
                            c => c.toLowerCase().replace(/^www\./, '') === norm,
                          )
                          const variant = isYou ? 'you' : isCompetitor ? 'competitor' : 'other'
                          return (
                            <div key={domain} className={`citation-leaderboard-item citation-leaderboard-item--${variant}`}>
                              <span className="citation-leaderboard-rank">#{i + 1}</span>
                              <span className="citation-leaderboard-domain">{domain}</span>
                              {isYou && <span className="citation-leaderboard-tag">You</span>}
                              {isCompetitor && <span className="citation-leaderboard-tag">Competitor</span>}
                            </div>
                          )
                        })}
                        {!isCited && (
                          <div className="citation-leaderboard-item citation-leaderboard-item--not-cited border-dashed">
                            <span className="citation-leaderboard-rank text-zinc-600">—</span>
                            <span className="citation-leaderboard-domain text-zinc-600">{project.project.canonicalDomain}</span>
                            <span className="citation-leaderboard-tag text-zinc-600">Not cited</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Grounding sources */}
                  {display.groundingSources.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Grounding sources ({display.groundingSources.length})</p>
                      <ul className="grid gap-0.5">
                        {display.groundingSources.map((src, i) => (
                          <li key={i} className="truncate text-sm">
                            <a href={src.uri} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-200 transition-colors">
                              {src.title || src.uri}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Evidence URLs */}
                  {display.evidenceUrls.length > 0 && (
                    <div>
                      <p className="drawer-section-label">Evidence URLs</p>
                      <ul className="grid gap-1">
                        {display.evidenceUrls.map((url) => (
                          <li key={url} className="truncate text-sm">
                            <a href={url} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-200 transition-colors">
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* No data state */}
                  {display.citedDomains.length === 0 && display.groundingSources.length === 0 && display.evidenceUrls.length === 0 && (
                    <div className="flex items-center justify-center h-24 text-zinc-600 text-sm">
                      No citation data {isViewingHistory ? 'for this run' : 'yet'}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/* ────────────────────────────────────────────
   Root app
   ──────────────────────────────────────────── */

async function loadDashboardData(): Promise<DashboardVm | null> {
  try {
    const [projects, allRuns, apiSettings] = await Promise.all([
      fetchProjects(),
      fetchAllRuns(),
      fetchSettings().catch(() => null),
    ])

    const projectDataList: ProjectData[] = await Promise.all(
      projects.map(async (project) => {
        const projectRuns = allRuns.filter(r => r.projectId === project.id)
        const completedRuns = projectRuns
          .filter(r => (r.status === 'completed' || r.status === 'partial') && r.kind === 'answer-visibility')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

        const [kws, comps, timeline, latestRunDetail, previousRunDetail] = await Promise.all([
          fetchKeywords(project.name).catch(() => []),
          fetchCompetitors(project.name).catch(() => []),
          fetchTimeline(project.name).catch(() => []),
          completedRuns[0] ? fetchRunDetail(completedRuns[0].id).catch(() => null) : Promise.resolve(null),
          completedRuns[1] ? fetchRunDetail(completedRuns[1].id).catch(() => null) : Promise.resolve(null),
        ])

        return {
          project,
          runs: projectRuns,
          keywords: kws,
          competitors: comps,
          timeline,
          latestRunDetail: latestRunDetail,
          previousRunDetail: previousRunDetail,
        }
      }),
    )

    return buildDashboard(projectDataList, apiSettings)
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
  const [runDetail, setRunDetail] = useState<import('./api.js').ApiRunDetail | null>(null)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
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

  // Poll for dashboard updates while any run is active (queued/running)
  const hasActiveRun = dashboard?.runs.some(
    r => r.status === 'running' || r.status === 'queued',
  ) ?? false

  useEffect(() => {
    if (!hasActiveRun) return

    const interval = setInterval(() => {
      void refreshData()
    }, 3000)

    return () => clearInterval(interval)
  }, [hasActiveRun, refreshData])

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
    if (loading || !dashboard) return
    const hasProjects = dashboard.projects.length > 0

    if (pathname === '/setup' && hasProjects) {
      // User already has projects — no need for setup wizard
      const nextPath = '/'
      if (typeof window !== 'undefined' && normalizePathname(window.location.pathname) !== nextPath) {
        window.history.replaceState({}, '', nextPath)
      }
      setPathname(nextPath)
    } else if (pathname === '/' && !hasProjects) {
      // No projects yet — guide user to setup
      const nextPath = '/setup'
      if (typeof window !== 'undefined' && normalizePathname(window.location.pathname) !== nextPath) {
        window.history.replaceState({}, '', nextPath)
      }
      setPathname(nextPath)
    }
  }, [loading, dashboard, pathname])

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
    setRunDetail(null)
    setRunDetailLoading(true)
    const requestedRunId = runId
    fetchRunDetail(runId)
      .then(detail => {
        setDrawerState(current => {
          if (current?.kind === 'run' && current.runId === requestedRunId) {
            setRunDetail(detail)
          }
          return current
        })
      })
      .catch(() => {
        setDrawerState(current => {
          if (current?.kind === 'run' && current.runId === requestedRunId) {
            setRunDetail(null)
          }
          return current
        })
      })
      .finally(() => setRunDetailLoading(false))
  }

  const handleTriggerAllRuns = () => {
    triggerAllRuns().catch((err: unknown) => {
      console.error('Failed to trigger all runs', err)
    }).finally(() => {
      refreshData()
    })
  }

  // Poll for run detail updates when run is in progress
  useEffect(() => {
    if (drawerState?.kind !== 'run' || !runDetail) return
    if (runDetail.status !== 'running' && runDetail.status !== 'queued') return

    const interval = setInterval(() => {
      fetchRunDetail(drawerState.runId)
        .then(detail => {
          setRunDetail(detail)
          if (detail.status !== 'running' && detail.status !== 'queued') {
            void refreshData()
          }
        })
        .catch(() => {})
    }, 3000)

    return () => clearInterval(interval)
  }, [drawerState, runDetail?.status, runDetail?.snapshots.length, refreshData])

  const openEvidence = (evidenceId: string) => {
    setDrawerState({ kind: 'evidence', evidenceId })
  }

  const handleTriggerRun = async (projectName: string) => {
    await apiTriggerRun(projectName)
    void refreshData()
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

  const handleAddKeywords = async (projectName: string, keywords: string[]) => {
    await appendKeywords(projectName, keywords)
    await refreshData()
  }

  const handleDeleteKeywords = async (projectName: string, keywords: string[]) => {
    await deleteKeywords(projectName, keywords)
    await refreshData()
  }

  const handleAddCompetitors = async (projectName: string, domains: string[]) => {
    const existing = await fetchCompetitors(projectName)
    const existingDomains = existing.map(c => c.domain)
    const merged = [...new Set([...existingDomains, ...domains])]
    await setCompetitors(projectName, merged)
    await refreshData()
  }

  const handleUpdateOwnedDomains = async (projectName: string, ownedDomains: string[]) => {
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
                href="/setup"
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
          subtitle={`${selectedRun.projectName} · ${selectedRun.kindLabel}`}
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

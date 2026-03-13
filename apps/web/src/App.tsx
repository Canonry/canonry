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

import { Badge } from './components/ui/badge.js'
import { Button } from './components/ui/button.js'
import { Card } from './components/ui/card.js'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './components/ui/sheet.js'
import { createDashboardFixture, findEvidenceById, findProjectVm, findRunById } from './mock-data.js'
import {
  appendKeywords,
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
  fetchSchedule,
  saveSchedule,
  removeSchedule,
  listNotifications,
  addNotification,
  removeNotification,
  sendTestNotification,
  applyProjectConfig,
  generateKeywords as apiGenerateKeywords,
  type ApiSchedule,
  type ApiNotification,
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
    return { kind: 'projects', path: '/projects' }
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
    emerging: 'bg-emerald-400 ring-1 ring-emerald-300/60',
  }

  return (
    <div className="flex items-center gap-[3px]" title={`${dots.length} runs`}>
      {dots.map((d, i) => (
        <div
          key={i}
          className={`h-2.5 w-2.5 rounded-sm ${colorMap[d.citationState] ?? 'bg-zinc-700'}`}
          title={`${d.citationState} — ${new Date(d.createdAt).toLocaleDateString()}`}
        />
      ))}
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
}: {
  phrase: string
  items: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
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
      </div>

      <div className="evidence-card-timeline-row">
        <CitationTimeline history={mergedHistory} maxDots={14} />
        <span className="evidence-card-ratio">
          {citedCount}/{items.length} provider{items.length !== 1 ? 's' : ''}
        </span>
      </div>

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
    </div>
  )
}

function EvidencePhraseCards({
  evidence,
  onOpenEvidence,
}: {
  evidence: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
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
  onOpenEvidence,
  onOpenRun,
  onTriggerRun,
  onDeleteProject,
  onAddKeywords,
  onAddCompetitors,
}: {
  model: ProjectCommandCenterVm
  onOpenEvidence: (evidenceId: string) => void
  onOpenRun: (runId?: string) => void
  onTriggerRun: (projectName: string) => Promise<void>
  onDeleteProject: (projectName: string) => void
  onAddKeywords: (projectName: string, keywords: string[]) => Promise<void>
  onAddCompetitors: (projectName: string, domains: string[]) => Promise<void>
}) {
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

  const isNumericScore = (value: string) => !Number.isNaN(Number.parseInt(value, 10))

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
              <p className="eyebrow eyebrow-soft">Provider breakdown</p>
              <h2>Visibility by provider <InfoTooltip text="Per-provider citation rate. Shows how often each AI engine cites your domain across all tracked key phrases. Useful for identifying which engines favor your content." /></h2>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {model.providerScores.map((ps) => (
              <Card key={ps.provider} className="surface-card compact-card">
                <div className="flex items-center justify-between">
                  <ProviderBadge provider={ps.provider} />
                  <span className={`text-lg font-semibold ${ps.score >= 70 ? 'text-emerald-400' : ps.score >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                    {ps.score}%
                  </span>
                </div>
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
        <EvidencePhraseCards evidence={model.visibilityEvidence} onOpenEvidence={onOpenEvidence} />
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

      <ScheduleSection projectName={model.project.name} />
      <NotificationsSection projectName={model.project.name} />
    </div>
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
  gemini: 'e.g. gemini-2.5-flash',
  openai: 'e.g. gpt-4o',
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

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Provider state, quotas, and service health.</p>
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

  const myDomain = project.project.canonicalDomain.toLowerCase().replace(/^www\./, '')
  const history = evidence.runHistory
  const hasHistory = history.length > 1

  // Current display data — from historical snapshot when viewing past runs, otherwise from latest evidence
  const isViewingHistory = selectedRunIdx >= 0 && historicalSnapshot !== null
  const display: EvidenceDisplayData = isViewingHistory ? historicalSnapshot : {
    citationState: evidence.citationState,
    provider: evidence.provider,
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
    d => d.toLowerCase().replace(/^www\./, '') === myDomain,
  )
  const position = positionIndex + 1
  const totalCited = display.citedDomains.length

  // Terms to highlight in the AI answer
  const projectDisplayName = project.project.displayName || project.project.name
  const highlightTerms = [
    project.project.canonicalDomain.replace(/^www\./, ''),
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
  const heroCopy = (() => {
    if (isCited && position > 0) {
      return {
        label: 'Citation confirmed',
        title: `Cited #${position} of ${totalCited} domain${totalCited !== 1 ? 's' : ''}`,
        meta: `${display.provider} · ${display.changeLabel.toLowerCase()}`,
      }
    }
    if (isCited) {
      return {
        label: 'Citation confirmed',
        title: 'Cited in this answer',
        meta: `${display.provider} · ${display.changeLabel.toLowerCase()}`,
      }
    }
    if (display.citationState === 'lost') {
      return {
        label: 'Citation lost',
        title: totalCited > 0
          ? `${totalCited} domain${totalCited !== 1 ? 's' : ''} cited instead`
          : 'No longer appearing in this answer',
        meta: `${display.provider} · ${display.changeLabel.toLowerCase()}`,
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
      meta: `${display.provider} · ${display.changeLabel.toLowerCase()}`,
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
                  const dotColor = run.citationState === 'cited' || run.citationState === 'emerging'
                    ? 'bg-emerald-400' : run.citationState === 'lost'
                      ? 'bg-rose-400' : 'bg-zinc-600'
                  const date = new Date(run.createdAt)
                  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`evidence-run-dot ${isSelected ? 'evidence-run-dot--selected' : ''}`}
                      onClick={() => selectHistoricalRun(i === history.length - 1 ? -1 : i)}
                      aria-label={`Run ${label}: ${run.citationState}`}
                      aria-pressed={isSelected}
                    >
                      <span className={`size-2 rounded-full ${dotColor}`} aria-hidden="true" />
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
                          const isYou = norm === myDomain
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
          .filter(r => r.status === 'completed' || r.status === 'partial')
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

  const handleAddCompetitors = async (projectName: string, domains: string[]) => {
    const existing = await fetchCompetitors(projectName)
    const existingDomains = existing.map(c => c.domain)
    const merged = [...new Set([...existingDomains, ...domains])]
    await setCompetitors(projectName, merged)
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
                <ProjectPage model={activeProject} onOpenEvidence={openEvidence} onOpenRun={openRun} onTriggerRun={handleTriggerRun} onDeleteProject={handleDeleteProject} onAddKeywords={handleAddKeywords} onAddCompetitors={handleAddCompetitors} />
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
            {runDetail?.snapshots?.[0]?.model && (
              <p className="mt-3 text-[10px] text-zinc-600">Model: {runDetail.snapshots[0].model}</p>
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

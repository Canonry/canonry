import { ChevronRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { Sparkline } from '../components/shared/Sparkline.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { toneFromRunStatus } from '../lib/tone-helpers.js'
import { toTitleCase } from '../lib/format-helpers.js'
import { buildSystemHealthCards } from '../lib/health-helpers.js'
import { useDashboard } from '../queries/use-dashboard.js'
import { useHealth } from '../queries/use-health.js'
import { useDrawer } from '../hooks/use-drawer.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import type { PortfolioProjectVm } from '../view-models.js'

function OverviewProjectCard({
  project,
}: {
  project: PortfolioProjectVm
}) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.project.id }}
      className="project-row cursor-pointer"
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
    </Link>
  )
}

export function OverviewPage() {
  const contextDashboard = useInitialDashboard()
  const { dashboard, isLoading } = useDashboard()
  const safeDashboard = dashboard ?? contextDashboard?.dashboard

  if (!safeDashboard || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-32" />
          <div className="skeleton-text-sm w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4 flex items-center gap-4">
              <div className="flex-1 space-y-2">
                <div className="skeleton-text w-36" />
                <div className="skeleton-text-sm w-48" />
              </div>
              <div className="skeleton-text w-16" />
              <div className="skeleton-text w-16" />
              <div className="skeleton h-8 w-20 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const model = safeDashboard.portfolioOverview

  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? { apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' }, workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' } }
  const systemHealth = buildSystemHealthCards(model.systemHealth, healthSnapshot, safeDashboard.settings)

  const { openRun } = useDrawer()

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
            <OverviewProjectCard key={project.project.id} project={project} />
          ))}
        </div>
      ) : (
        <Card className="surface-card empty-card">
          <h3>{model.emptyState?.title ?? 'No projects yet'}</h3>
          <p className="supporting-copy">{model.emptyState?.detail}</p>
          <Button size="sm" asChild>
            <Link to={model.emptyState?.ctaHref === '/setup' || !model.emptyState?.ctaHref ? '/setup' : '/'}>
              {model.emptyState?.ctaLabel ?? 'Launch setup'}
            </Link>
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
                <Link
                  key={item.id}
                  to={item.href}
                  className={`attention-item attention-item-${item.tone}`}
                >
                  <div>
                    <p className="attention-title">{item.title}</p>
                    <p className="attention-detail">{item.detail}</p>
                  </div>
                  <span className="attention-action">{item.actionLabel}</span>
                </Link>
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
                <button key={run.id} className="compact-run" type="button" onClick={() => openRun(run.id)}>
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

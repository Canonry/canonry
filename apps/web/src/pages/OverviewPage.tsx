import { ChevronRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { Sparkline } from '../components/shared/Sparkline.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { toneFromRunStatus } from '../lib/tone-helpers.js'
import { buildSystemHealthCards, serviceStatusTooltip } from '../lib/health-helpers.js'
import { useDashboardOverview as useDashboard } from '../queries/use-dashboard-overview.js'
import { useHealth } from '../queries/use-health.js'
import { useDrawer } from '../hooks/use-drawer.js'
import { useAccount } from '../contexts/account-context.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import type { PortfolioProjectVm } from '../view-models.js'

function OverviewProjectCard({
  project,
}: {
  project: PortfolioProjectVm
}) {
  return (
    <Link
      to="/projects/$projectName"
      params={{ projectName: project.project.name }}
      className="project-row cursor-pointer"
    >
      <div className="project-row-chart">
        <Sparkline points={project.trend} tone={toneFromRunStatus(project.lastRun.status)} />
      </div>
      <div className="project-row-primary">
        <div>
          <p className="project-name">{project.project.name}</p>
          <p className="project-domain">{project.project.canonicalDomain}</p>
        </div>
        <p className="project-insight">{project.insight}</p>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          <p className="metric-inline-label">Mentioned</p>
          <p className={`metric-inline-value ${project.mentionTone === 'caution' ? 'text-caution-400' : ''}`}>{project.hasMeasurement === false ? 'Not measured' : project.mentionScore}</p>
          {/* `providerCoverage` is only set when the sweep covered a SUBSET of
              configured providers, and it is why the tone shifted to caution:
              the score above is built on incomplete data and is not comparable
              to a full sweep. It therefore keeps the caution tone and takes the
              caption slot outright — folding it into the faint delta text would
              bury a data-validity caveat, and appending it would just truncate.
              The query counts it displaces are still on `project.insight`. */}
          <p
            className={`metric-inline-caption${project.providerCoverage ? ' text-caution' : ''}`}
            title={project.providerCoverage}
          >
            {project.providerCoverage
              ? <><span className="sr-only">Partial sweep: </span>{project.providerCoverage}</>
              : project.mentionDelta}
          </p>
        </div>
      </div>
      <div className="project-row-stat">
        <div className="metric-inline-block">
          {/* `aria-label` does NOT work here: a bare <p> has role `paragraph`,
              which does not support an accessible name, so screen readers are
              free to ignore it and most do. The visually-hidden span is what
              actually carries "competitor" to assistive tech. */}
          <p className="metric-inline-label">
            <span aria-hidden="true">Pressure</span>
            <span className="sr-only">Competitor pressure</span>
          </p>
          <p className="metric-inline-value">{project.hasMeasurement === false ? 'Not measured' : project.competitorPressureLabel}</p>
          {/* Empty caption slot, always rendered (not conditionally omitted) so
              this cell keeps the same three-row template as the "Mentioned"
              cell above — that's what keeps the two VALUES on a shared
              baseline when `.project-row` centers each stat cell. */}
          <p className="metric-inline-caption" aria-hidden="true"></p>
        </div>
      </div>
      <span className="project-row-link">
        <ChevronRight className="h-4 w-4 text-muted" />
      </span>
    </Link>
  )
}

export function OverviewPage() {
  const { isAdmin } = useAccount()
  const contextDashboard = useInitialDashboard()
  const { dashboard, isLoading, isError, refetch } = useDashboard()
  const safeDashboard = dashboard ?? contextDashboard?.dashboard

  // Every hook has to run on every render, so they all sit above the skeleton
  // return. React identifies hooks by call order, so a return placed between
  // two of them changes the count from one render to the next and throws
  // "rendered more hooks than during the previous render". The embed shell has
  // no server-rendered dashboard to fall back on, so it always takes the
  // skeleton branch first and hit this on every cold load.
  const enableLiveStatus = !contextDashboard
  const healthQuery = useHealth(enableLiveStatus, contextDashboard?.health)
  const { openRun } = useDrawer()

  if (isError && !safeDashboard) {
    return (
      <div className="page-container">
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">Portfolio unavailable</h1>
            <p className="page-subtitle">Canonry could not load the project list.</p>
          </div>
        </div>
        <div className="max-w-xl rounded-lg border border-negative bg-negative-soft p-4" role="alert">
          <p className="text-sm font-medium text-heading">Your projects have not been changed.</p>
          <p className="mt-1 text-sm text-secondary">Check the connection or sign in again, then retry.</p>
          <Button type="button" variant="secondary" className="mt-4" onClick={() => { void refetch() }}>
            Retry loading portfolio
          </Button>
        </div>
      </div>
    )
  }

  if (!safeDashboard || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-32" />
          <div className="skeleton-text-sm w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-default bg-surface p-4 flex items-center gap-4">
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
  const awaitingBaseline = model.projects.length > 0 && model.projects.every(project => project.hasMeasurement === false)
  const attentionItems = model.attentionItems.map(item => awaitingBaseline && item.id === 'attention_stable'
    ? { ...item, tone: 'neutral' as const, title: 'Awaiting first measurement', detail: 'Visibility results will appear after the first sweep.' }
    : item)

  const healthSnapshot = healthQuery.data ?? contextDashboard?.health ?? { apiStatus: { label: 'API', state: 'checking', detail: 'Checking service health' }, workerStatus: { label: 'Worker', state: 'checking', detail: 'Checking service health' } }
  const systemHealth = buildSystemHealthCards(model.systemHealth.filter(card => isAdmin || card.id === 'api' || card.id === 'worker'), healthSnapshot, safeDashboard.settings)

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Portfolio</h1>
          <p className="page-subtitle">Visibility across all projects.</p>
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
        {attentionItems.length > 0 && (
          <section className="overview-secondary-section">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Needs attention</p>
                <h2 className="section-title-sm">What changed</h2>
              </div>
            </div>
            <div className="attention-list attention-list-scrollable">
              {attentionItems.map((item) =>
                item.href ? (
                  <Link
                    key={item.id}
                    to={item.href}
                    className={`attention-item attention-item-${item.tone}`}
                  >
                    <div>
                      <p className="attention-title">{item.title}</p>
                      <p className="attention-detail">{item.detail}</p>
                    </div>
                    {item.actionLabel && <span className="attention-action">{item.actionLabel}</span>}
                  </Link>
                ) : (
                  <div
                    key={item.id}
                    className={`attention-item attention-item-static attention-item-${item.tone}`}
                  >
                    <div>
                      <p className="attention-title">{item.title}</p>
                      <p className="attention-detail">{item.detail}</p>
                    </div>
                    {item.actionLabel && <span className="attention-action">{item.actionLabel}</span>}
                  </div>
                ),
              )}
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
        <div className="divide-y divide-default border-y border-default">
          {systemHealth.map((item) => {
            const serviceStatus = item.id === 'api'
              ? healthSnapshot.apiStatus
              : item.id === 'worker'
                ? healthSnapshot.workerStatus
                : undefined
            const visibleDetail = serviceStatus
              ? serviceStatus.state === 'ok' ? undefined : serviceStatusTooltip(serviceStatus)
              : item.tone === 'positive' ? undefined : item.meta

            return (
              <div key={item.id} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-sm font-medium text-heading">{item.label}</p>
                  {visibleDetail && <p className="mt-1 text-sm text-secondary">{visibleDetail}</p>}
                </div>
                <ToneBadge tone={item.tone} title={serviceStatus ? serviceStatusTooltip(serviceStatus) : item.meta}>
                  {item.detail}
                </ToneBadge>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

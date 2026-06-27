import { Link } from '@tanstack/react-router'
import { formatRelativeTime } from '@ainyc/canonry-contracts'
import type {
  MetricTone,
  PortfolioChangeDto,
  PortfolioDto,
  PortfolioProjectRowDto,
  PortfolioRunDto,
} from '@ainyc/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { Sparkline } from '../components/shared/Sparkline.js'
import { StatusBadge } from '../components/shared/StatusBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { toneFromService } from '../lib/tone-helpers.js'
import { serviceStatusTooltip } from '../lib/health-helpers.js'
import { usePortfolio } from '../queries/use-portfolio.js'
import { useHealth } from '../queries/use-health.js'
import { useDrawer } from '../hooks/use-drawer.js'
import type { ServiceStatus } from '../view-models.js'

const MENTION_TOOLTIP = 'Mentioned: the brand or domain appears in the AI answer text itself.'
const CITED_TOOLTIP = 'Cited: the domain appears in the source list the AI used — independent of whether it was mentioned in the answer.'
const FEED_TOOLTIP = 'Movement compares only the queries shared with the previous sweep. Query-basket changes are listed separately, never as a gain or loss.'

/** Absolute local timestamp for hover titles — formats a real ISO instant
 *  (not a render-time clock), so it complements the relative label. */
function absoluteTitle(iso: string | null): string | undefined {
  if (!iso) return undefined
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function changeGlyph(tone: MetricTone): string {
  switch (tone) {
    case 'negative': return '↓'
    case 'positive': return '↑'
    case 'caution': return '!'
    case 'neutral': return '•'
  }
}

export function OverviewPage() {
  const { data: portfolio } = usePortfolio()
  const healthQuery = useHealth(true)
  const { openRun } = useDrawer()

  // No cached data yet → first load. A background refetch keeps `portfolio`
  // defined, so the skeleton only shows on the genuine cold load.
  if (!portfolio) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-32" />
          <div className="skeleton-text-sm w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-4">
              <div className="skeleton-text w-48" />
              <div className="skeleton-text-sm mt-2 w-64" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const now = portfolio.generatedAt

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Portfolio</h1>
          <p className="page-subtitle">Visibility and execution state across all projects</p>
        </div>
        <div className="page-header-right">
          <span className="portfolio-freshness" title={absoluteTitle(portfolio.lastSweepAt)}>
            Last sweep {portfolio.lastSweepAt ? formatRelativeTime(portfolio.lastSweepAt, now) : '—'}
          </span>
          <InfoTooltip text="Reflects the most recent completed answer-visibility sweep across your projects — not when this page loaded." />
        </div>
      </div>

      {portfolio.projectCount === 0 ? (
        <Card className="surface-card empty-card">
          <h3>No projects yet</h3>
          <p className="supporting-copy">
            Canonry becomes useful after one project, a small query set, and a competitor list are in place.
          </p>
          <Button size="sm" asChild>
            <Link to="/setup">Launch setup</Link>
          </Button>
        </Card>
      ) : (
        <>
          <ChangeFeedSection portfolio={portfolio} now={now} />
          <RecentRunsSection portfolio={portfolio} now={now} onOpenRun={openRun} />
          <ProjectsSection portfolio={portfolio} />
        </>
      )}

      <HealthStrip apiStatus={healthQuery.data?.apiStatus} workerStatus={healthQuery.data?.workerStatus} />
    </div>
  )
}

function ChangeFeedSection({ portfolio, now }: { portfolio: PortfolioDto; now: string }) {
  const more = portfolio.changeFeedTotal > portfolio.changeFeed.length
  return (
    <section className="page-section">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Since the last sweep</p>
          <h2 className="section-title-sm">
            What changed
            <InfoTooltip text={FEED_TOOLTIP} />
          </h2>
        </div>
      </div>
      {portfolio.changeFeed.length === 0 ? (
        <div className="change-feed-empty">
          {portfolio.feedEmptyState?.title ?? 'No changes since the last sweep'}
          <p className="change-feed-empty-detail">{portfolio.feedEmptyState?.detail ?? ''}</p>
        </div>
      ) : (
        <div className="change-feed-list">
          {portfolio.changeFeed.map((change) => (
            <ChangeRow key={change.id} change={change} now={now} />
          ))}
          {more && (
            <p className="change-feed-more">
              Showing {portfolio.changeFeed.length} of {portfolio.changeFeedTotal} changes
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function ChangeRow({ change, now }: { change: PortfolioChangeDto; now: string }) {
  const inner = (
    <>
      <span className={`change-feed-glyph change-feed-glyph-${change.tone}`} aria-hidden="true">
        {changeGlyph(change.tone)}
      </span>
      <span className="change-feed-body">
        <span className="change-feed-title">{change.title}</span>
        {change.detail && <span className="change-feed-detail">{change.detail}</span>}
      </span>
      <span className="change-feed-time" title={absoluteTitle(change.occurredAt)}>
        {formatRelativeTime(change.occurredAt, now)}
      </span>
    </>
  )
  const className = `change-feed-row change-feed-row-${change.tone}`
  return change.href ? (
    <Link to={change.href} className={className}>{inner}</Link>
  ) : (
    <div className={className}>{inner}</div>
  )
}

function RecentRunsSection({
  portfolio,
  now,
  onOpenRun,
}: {
  portfolio: PortfolioDto
  now: string
  onOpenRun: (id: string) => void
}) {
  return (
    <section className="page-section">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Recent runs</p>
          <h2 className="section-title-sm">Activity</h2>
        </div>
      </div>
      <p className="portfolio-legend">M = mentioned in answer · C = cited in sources</p>
      {portfolio.recentRuns.length === 0 ? (
        <p className="supporting-copy">Run history appears here after the first sweep.</p>
      ) : (
        <div className="portfolio-table-wrap">
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Result</th>
                <th>Status</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.recentRuns.map((run) => (
                <tr
                  key={run.runId}
                  className="portfolio-row-button"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRun(run.runId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onOpenRun(run.runId)
                    }
                  }}
                >
                  <td>
                    <span className="portfolio-project-name">{run.projectName}</span>
                  </td>
                  <td>{runResultCell(run)}</td>
                  <td><StatusBadge status={run.status} /></td>
                  <td className="portfolio-when">{runDuration(run)}</td>
                  <td className="portfolio-when" title={absoluteTitle(run.finishedAt ?? run.startedAt ?? run.createdAt)}>
                    {runWhen(run, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function runResultCell(run: PortfolioRunDto) {
  if (run.status === 'failed') {
    return <span className="portfolio-result-error">{run.errorSummary ?? 'Failed'}</span>
  }
  if (run.mentionedCount == null || run.citedCount == null || run.totalCount == null) {
    return <span className="portfolio-result">—</span>
  }
  return (
    <span className="portfolio-result">
      M {run.mentionedCount}/{run.totalCount} · C {run.citedCount}/{run.totalCount}
    </span>
  )
}

function runWhen(run: PortfolioRunDto, now: string): string {
  const ts = run.finishedAt ?? run.startedAt ?? run.createdAt
  const rel = formatRelativeTime(ts, now)
  if (run.status === 'running') return `started ${rel}`
  if (run.status === 'queued') return `queued ${rel}`
  return `finished ${rel}`
}

function runDuration(run: PortfolioRunDto): string {
  if (run.durationMs == null) {
    return run.status === 'running' ? 'Running' : run.status === 'queued' ? 'Waiting' : '—'
  }
  const seconds = Math.floor(run.durationMs / 1000)
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function ProjectsSection({ portfolio }: { portfolio: PortfolioDto }) {
  return (
    <section className="page-section">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Projects</p>
          <h2 className="section-title-sm">Current state</h2>
        </div>
      </div>
      <div className="portfolio-table-wrap">
        <table className="portfolio-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Mentioned <InfoTooltip text={MENTION_TOOLTIP} /></th>
              <th>Cited <InfoTooltip text={CITED_TOOLTIP} /></th>
              <th>Δ since last sweep</th>
              <th>Pressure</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.projects.map((proj) => (
              <tr key={proj.projectSlug}>
                <td>
                  <div className="flex items-center gap-3">
                    {proj.mentionTrend.length > 1 && (
                      <span className="hidden lg:block">
                        <Sparkline points={proj.mentionTrend} tone={proj.mentionTone} />
                      </span>
                    )}
                    <Link to="/projects/$projectName" params={{ projectName: proj.projectSlug }} className="no-underline">
                      <span className="portfolio-project-name">{proj.projectName}</span>
                      <span className="block portfolio-project-domain">{proj.canonicalDomain}</span>
                    </Link>
                  </div>
                </td>
                <td>
                  <span className="portfolio-score">{proj.hasEverRun ? proj.mentionScore : '—'}</span>
                  <span className="block portfolio-caption">M {proj.mentionedOfTotal.mentioned}/{proj.mentionedOfTotal.total}</span>
                </td>
                <td>
                  <span className="portfolio-caption">C {proj.citedOfTotal.cited}/{proj.citedOfTotal.total}</span>
                </td>
                <td>{deltaCell(proj)}</td>
                <td className="portfolio-caption">{proj.competitorPressureLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function deltaCell(proj: PortfolioProjectRowDto) {
  if (!proj.hasEverRun) return <span className="portfolio-delta-neutral">never run</span>
  const { gained, lost, comparable } = proj.mentionDelta
  if (!comparable) {
    return (
      <span className="portfolio-delta-neutral" title="No comparable previous sweep — the tracked query set changed.">
        first sweep
      </span>
    )
  }
  if (gained === 0 && lost === 0) return <span className="portfolio-delta-neutral">no change</span>
  return (
    <span>
      {gained > 0 && <span className="portfolio-delta-positive">+{gained}</span>}
      {gained > 0 && lost > 0 && ' '}
      {lost > 0 && <span className="portfolio-delta-negative">−{lost}</span>}
      <span className="portfolio-caption"> mentioned</span>
    </span>
  )
}

function HealthStrip({ apiStatus, workerStatus }: { apiStatus?: ServiceStatus; workerStatus?: ServiceStatus }) {
  const pills: { id: string; label: string; status?: ServiceStatus }[] = [
    { id: 'api', label: 'API', status: apiStatus },
    { id: 'worker', label: 'Worker', status: workerStatus },
  ]
  return (
    <section className="page-section">
      <div className="health-strip">
        {pills.map(({ id, label, status }) => {
          const tone: MetricTone = status ? toneFromService(status) : 'neutral'
          return (
            <span
              key={id}
              className={`health-pill health-pill-${tone}`}
              title={status ? serviceStatusTooltip(status) : undefined}
            >
              <span className="health-pill-dot" aria-hidden="true" />
              {label}
            </span>
          )
        })}
      </div>
    </section>
  )
}

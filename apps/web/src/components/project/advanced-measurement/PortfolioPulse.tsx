import type {
  MeasurementOverviewResponse,
  MeasurementPortfolioSummaryResponse,
} from '@ainyc/canonry-api-client'
import type { ReactNode } from 'react'

import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'

type PulseMetric = MeasurementPortfolioSummaryResponse['metrics']['mentionCoverage']
type PulseOutcomes = MeasurementOverviewResponse['outcomes']

export interface PortfolioPulseProps {
  summary?: MeasurementPortfolioSummaryResponse
  state: 'loading' | 'ready' | 'error'
  outcomes?: PulseOutcomes
  /** Reuses the existing project-wide trend without implying Group-level history. */
  projectTrend?: ReactNode
  onRetry?: () => void
  onSelectGroup?: (groupKey: string) => void
  onOpenPortfolio?: () => void
  renderGroupLink?: (group: { id: string; name: string }) => ReactNode
  renderPortfolioLink?: () => ReactNode
}

const unavailableLabels: Record<Extract<PulseMetric, { state: 'unavailable' }>['reason'], string> = {
  no_completed_run: 'Not measured',
  plan_v1: 'Update setup',
  no_population: 'No matching queries',
  evidence_incomplete: 'Evidence incomplete',
  not_applicable: 'Not applicable',
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`
}

function metricParts(metric: PulseMetric, kind: 'count' | 'coverage'): { value: string; detail?: string } {
  if (metric.state === 'unavailable') return { value: unavailableLabels[metric.reason] }

  if (kind === 'count') {
    const value = metric.numerator !== undefined && metric.denominator !== undefined
      ? `${metric.numerator} of ${metric.denominator}`
      : String(metric.value)
    const detail = metric.rate !== undefined
      ? percentage(metric.rate)
      : undefined
    return { value, ...(detail ? { detail } : {}) }
  }

  return {
    value: percentage(metric.value),
    ...(metric.numerator !== undefined && metric.denominator !== undefined
      ? { detail: `${metric.numerator} of ${metric.denominator} answers` }
      : {}),
  }
}

function PulseMetricValue({ metric, kind = 'coverage', compact = false }: {
  metric: PulseMetric
  kind?: 'count' | 'coverage'
  compact?: boolean
}) {
  const parts = metricParts(metric, kind)
  return (
    <div>
      <span className={`${compact ? 'text-sm' : 'font-mono text-2xl'} font-semibold tabular-nums text-heading`}>
        {parts.value}
      </span>
      {parts.detail ? <span className={`block ${compact ? 'text-[11px]' : 'mt-1 text-xs'} text-faint`}>{parts.detail}</span> : null}
    </div>
  )
}

function OutcomeStrip({ outcomes }: { outcomes: PulseOutcomes }) {
  const entries = [
    { key: 'both', label: 'Mentioned and cited', count: outcomes.bothSignals, color: 'bg-positive-400' },
    // The one-signal states are independent categories, not better/worse
    // statuses. Categorical series colors keep citation from reading as a warning.
    { key: 'mention', label: 'Mention only', count: outcomes.mentionedOnly, color: 'bg-[var(--chart-series-2)]' },
    { key: 'citation', label: 'Citation only', count: outcomes.citedOnly, color: 'bg-[var(--chart-series-3)]' },
    { key: 'neither', label: 'Neither', count: outcomes.neither, color: 'bg-negative-400' },
    ...(outcomes.notMeasured > 0
      ? [{ key: 'unmeasured', label: 'Not measured', count: outcomes.notMeasured, color: 'bg-mono-600' }]
      : []),
  ] as const
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)

  if (total === 0) return null

  return (
    <section aria-labelledby="portfolio-pulse-outcomes" className="border-b border-default pb-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id="portfolio-pulse-outcomes" className="text-sm font-medium text-heading">Outcomes</h3>
        <span className="text-xs tabular-nums text-faint">{outcomes.total} {outcomes.total === 1 ? 'Property' : 'Properties'}</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-mono-800" aria-hidden="true">
        {entries.filter(entry => entry.count > 0).map(entry => (
          <span
            key={entry.key}
            data-outcome={entry.key}
            className={entry.color}
            style={{ width: `${(entry.count / total) * 100}%` }}
          />
        ))}
      </div>
      <dl aria-label="Property outcomes" className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
        {entries.map(entry => (
          <div key={entry.key}>
            <dt className="text-xs text-secondary">
              {entry.label}
              {entry.key === 'unmeasured' ? (
                <InfoTooltip text="One or both signals missing. Not the same as neither." />
              ) : null}
            </dt>
            <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-heading">{entry.count}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function GroupName({
  id,
  name,
  renderGroupLink,
  onSelectGroup,
}: {
  id: string
  name: string
  renderGroupLink?: PortfolioPulseProps['renderGroupLink']
  onSelectGroup?: PortfolioPulseProps['onSelectGroup']
}) {
  if (renderGroupLink) return renderGroupLink({ id, name })
  if (onSelectGroup) {
    return (
      <button
        type="button"
        className="rounded-sm text-left font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
        onClick={() => onSelectGroup(id)}
      >
        {name}
      </button>
    )
  }
  return <span className="font-medium text-heading">{name}</span>
}

function GroupTable({
  summary,
  renderGroupLink,
  onSelectGroup,
}: Pick<PortfolioPulseProps, 'renderGroupLink' | 'onSelectGroup'> & { summary: MeasurementPortfolioSummaryResponse }) {
  if (summary.markets.length === 0) {
    return <p className="py-5 text-sm text-secondary">No Groups configured.</p>
  }

  return (
    <section aria-labelledby="portfolio-pulse-groups">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id="portfolio-pulse-groups" className="text-sm font-medium text-heading">Groups</h3>
        <span className="text-xs tabular-nums text-faint">{summary.markets.length}</span>
      </div>
      <div className="overflow-x-auto rounded-md border border-default">
        <table className="evidence-table min-w-[620px]">
          <caption className="sr-only">Advanced measurement Groups, ordered by the server from weakest mention coverage</caption>
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Properties</th>
              <th scope="col">Mention</th>
              <th scope="col">Citation</th>
            </tr>
          </thead>
          <tbody>
            {summary.markets.map(group => (
              <tr key={group.groupKey}>
                <td>
                  <GroupName
                    id={group.groupKey}
                    name={group.label}
                    renderGroupLink={renderGroupLink}
                    onSelectGroup={onSelectGroup}
                  />
                </td>
                <td className="font-mono text-sm tabular-nums text-secondary">{group.propertyCount}</td>
                <td><PulseMetricValue metric={group.mentionCoverage} compact /></td>
                <td><PulseMetricValue metric={group.citationCoverage} compact /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function ProjectTrend({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <div className="border-b border-default pb-5">
      <p className="mb-2 text-xs text-secondary">Project-wide · all tracked queries</p>
      {children}
    </div>
  )
}

export function PortfolioPulse({
  summary,
  state,
  outcomes,
  projectTrend,
  onRetry,
  onSelectGroup,
  onOpenPortfolio,
  renderGroupLink,
  renderPortfolioLink,
}: PortfolioPulseProps) {
  if (state === 'loading') {
    return (
      <div className="space-y-5">
        <section aria-label="Loading Portfolio pulse" className="space-y-4">
          <div className="h-20 animate-pulse rounded-md bg-surface-subtle" />
          <div className="h-40 animate-pulse rounded-md bg-surface-subtle" />
        </section>
        <ProjectTrend>{projectTrend}</ProjectTrend>
      </div>
    )
  }

  if (state === 'error' || !summary) {
    return (
      <div className="space-y-5">
        <section role="alert" aria-label="Portfolio pulse" className="border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
          <span>Could not load the portfolio summary.</span>
          {onRetry ? <Button className="ml-3" type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button> : null}
        </section>
        <ProjectTrend>{projectTrend}</ProjectTrend>
      </div>
    )
  }

  const isGroup = summary.portfolio.groupKey !== null
  const title = isGroup ? summary.portfolio.label ?? 'Group pulse' : 'Portfolio pulse'

  return (
    <section aria-labelledby="portfolio-pulse-title" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {isGroup ? (
            <div className="mb-1 text-xs text-secondary">
              {renderPortfolioLink ? renderPortfolioLink() : onOpenPortfolio ? (
                <button type="button" className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400" onClick={onOpenPortfolio}>
                  Portfolio
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="portfolio-pulse-title" className="truncate text-lg font-semibold text-heading">{title}</h2>
            {summary.portfolio.measurementScope === 'spot_check' ? <ToneBadge tone="caution">Spot check</ToneBadge> : null}
          </div>
        </div>
        <span className="text-sm tabular-nums text-secondary">
          {summary.totalProperties} {summary.totalProperties === 1 ? 'Property' : 'Properties'}
        </span>
      </div>

      <dl className="grid border-y border-default sm:grid-cols-3">
        <div className="py-4 sm:pr-5">
          <dt className="text-xs font-medium text-secondary">Properties mentioned</dt>
          <dd className="mt-2"><PulseMetricValue metric={summary.metrics.propertiesMentioned} kind="count" /></dd>
        </div>
        <div className="border-t border-default py-4 sm:border-l sm:border-t-0 sm:px-5">
          <dt className="text-xs font-medium text-secondary">Mentioned answers</dt>
          <dd className="mt-2"><PulseMetricValue metric={summary.metrics.mentionCoverage} /></dd>
        </div>
        <div className="border-t border-default py-4 sm:border-l sm:border-t-0 sm:pl-5">
          <dt className="text-xs font-medium text-secondary">Cited answers</dt>
          <dd className="mt-2"><PulseMetricValue metric={summary.metrics.citationCoverage} /></dd>
        </div>
      </dl>

      {outcomes ? <OutcomeStrip outcomes={outcomes} /> : null}
      {!isGroup ? <ProjectTrend>{projectTrend}</ProjectTrend> : null}
      {!isGroup ? (
        <GroupTable summary={summary} renderGroupLink={renderGroupLink} onSelectGroup={onSelectGroup} />
      ) : null}
    </section>
  )
}

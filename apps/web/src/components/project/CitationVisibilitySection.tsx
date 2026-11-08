import React, { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatPercent, RatioUnits, type VisibilityReportPopulationClass, type VisibilityReportRate } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameVisibilityReportOptions } from '@canonry/canonry-api-client/react-query'
import { heyClient, isDashboardManagedSweeps } from '../../api.js'
import { MANAGED_SWEEPS_COPY } from './ManagedSweepStatus.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import { formatSweepInstant } from '../../lib/format-helpers.js'
import { AnswerEngineLabel } from '../shared/AnswerEngineLabel.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SegmentedRadioGroup } from '../shared/SegmentedRadioGroup.js'
import { Button } from '../ui/button.js'

const CLASS_LABEL: Record<VisibilityReportPopulationClass, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  unknown: 'Unclassified',
}

const RATE_REASON: Record<NonNullable<VisibilityReportRate['reason']>, string> = {
  'no-population': 'No answers in this class',
  incomplete: 'Awaiting answers',
  'evidence-incomplete': 'Incomplete evidence',
  'identity-ambiguous': 'Brand identity unavailable',
  'not-applicable': 'Not measured',
}

function EngineMetric({ value, queryClass }: { value: VisibilityReportRate; queryClass: VisibilityReportPopulationClass }) {
  return (
    <>
      <span className="engine-comparison-metric">
        <span className="text-label-14-strong text-primary">
          {value.rate === null ? '—' : formatPercent(value.rate, RatioUnits.fraction)}
          <span className="sr-only"> · {CLASS_LABEL[queryClass].toLowerCase()} queries</span>
        </span>
        {value.rate !== null && <>
          <span aria-hidden="true" className="text-label-13 text-secondary">{value.numerator}/{value.denominator}</span>
          <span className="sr-only">{value.numerator} of {value.denominator} answers</span>
        </>}
      </span>
      {value.rate === null && <span className="block text-label-13 text-secondary">{RATE_REASON[value.reason ?? 'not-applicable']}</span>}
      {value.unattributed !== undefined && value.unattributed > 0 ? <span className="block text-label-13 text-secondary">{value.unattributed} unattributed</span> : null}
      {value.unchecked !== undefined && value.unchecked > 0 ? <span className="block text-label-13 text-secondary">{value.unchecked} unchecked</span> : null}
    </>
  )
}

/** The API owns each class and engine denominator, including unavailable evidence. */
export function CitationVisibilitySection({ projectName, revision }: { projectName: string; revision?: string }) {
  const titleId = useId()
  const [selected, setSelected] = useState<VisibilityReportPopulationClass>('non-brand')
  const options = getApiV1ProjectsByNameVisibilityReportOptions({
    client: heyClient,
    path: { name: projectName },
    query: { queryClass: 'all', limit: 1 },
  })
  const visibilityQuery = useQuery({
    ...options,
    // Polling the completed run set rotates this key even without an event stream.
    queryKey: [{ ...options.queryKey[0], tags: [revision ?? 'no-sweep'] }],
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = visibilityQuery.data
  const classes = (['non-brand', 'branded', 'unknown'] as const).flatMap(queryClass => {
    const population = data?.populations.find(entry => entry.queryClass === queryClass)
    return population && (queryClass === 'non-brand' || population.summary.queryCount > 0) ? [population] : []
  })
  const active = classes.find(population => population.queryClass === selected) ?? classes[0]
  const engines = active?.breakdown.providers
  const latestAt = data?.selection.measurement.completedAt

  let body: React.ReactNode
  if (visibilityQuery.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-3 text-label-14 text-secondary">
        <span>Could not load engine results: {extractErrorMessage(visibilityQuery.error)}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => { void visibilityQuery.refetch() }}>Retry</Button>
      </div>
    )
  } else if (!data) {
    body = <p role="status" className="text-copy-14 text-secondary">Loading engine results…</p>
  } else if (data.selection.availability.state !== 'available' || engines === undefined) {
    body = <p className="text-copy-14 text-secondary">Engine breakdown unavailable for this report.</p>
  } else if (!data.selection.run.id) {
    body = <p className="text-copy-14 text-secondary">{isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Engine results appear after your first check.'}</p>
  } else if (engines.length === 0) {
    body = <p className="text-copy-14 text-secondary">No {CLASS_LABEL[active!.queryClass].toLowerCase()} queries in this check.</p>
  } else if (active) {
    body = (
      <table className="engine-comparison" aria-label={`By engine, ${CLASS_LABEL[active.queryClass].toLowerCase()} queries`}>
        <thead>
          <tr>
            <th scope="col">Engine</th>
            <th scope="col">Mentioned</th>
            <th scope="col">Cited</th>
          </tr>
        </thead>
        <tbody>
          {engines.map(engine => (
            <tr key={engine.provider}>
              <th scope="row"><AnswerEngineLabel provider={engine.provider} /></th>
              <td><EngineMetric value={engine.mentionCoverage} queryClass={active.queryClass} /></td>
              <td><EngineMetric value={engine.citationCoverage} queryClass={active.queryClass} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <section className="overview-brief max-w-2xl" aria-labelledby={titleId}>
      <div className="av-card-head">
        <div className="inline-flex flex-wrap items-center">
          <h2 id={titleId} className="av-card-title">By engine</h2>
          <InfoTooltip text="Mentioned: the answer names you. Cited: its sources link to your site. Each rate uses this check’s answers in the selected query class. Missing answers are never counted as negative results." />
          {active && <span className="ml-3 text-label-13 text-secondary">{CLASS_LABEL[active.queryClass]} queries</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {latestAt ? <p className="av-card-meta">Latest check {formatSweepInstant(latestAt)}{data?.selection.measurement.state === 'partial' ? ' · incomplete' : ''}</p> : null}
          {classes.length > 1 ? (
            <SegmentedRadioGroup
              label="Query type"
              className="flex-wrap"
              options={classes.map(population => ({ value: population.queryClass, label: CLASS_LABEL[population.queryClass] }))}
              value={active!.queryClass}
              onChange={setSelected}
            />
          ) : null}
        </div>
      </div>
      <div className="av-card-body">{body}</div>
    </section>
  )
}

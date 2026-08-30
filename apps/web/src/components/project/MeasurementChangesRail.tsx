import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { MeasurementChangesResponse } from '@ainyc/canonry-api-client'
import { getApiV1ProjectsByNameMeasurementChangesOptions } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { Button } from '../ui/button.js'

type ChangesQueryClass = 'all' | 'branded' | 'non-brand'

type MeasurementChangesRailProps = {
  project: string
  queryClass: ChangesQueryClass
  /** The resolved overview run. Never let this rail choose a newer default. */
  runId: string
} & (
  | { scope: 'group'; groupKey: string }
  | { scope: 'property'; targetKey: string }
)

const UNAVAILABLE_COPY = {
  no_previous_run: 'No comparable sweep yet.',
  incomplete: 'Latest measurement incomplete.',
  execution_identity_changed: 'Answer-engine setup changed.',
  not_comparable: 'Prior sweep differs in scope or setup.',
} as const

function percentagePoints(delta: number): string {
  const points = Math.round(delta * 1_000) / 10
  const digits = Number.isInteger(points) ? String(points) : points.toFixed(1)
  return `${points > 0 ? '+' : ''}${digits} pp`
}

function Delta({
  label,
  metric,
}: {
  label: string
  metric: Extract<MeasurementChangesResponse['comparison'], { state: 'available' }>['metrics']['mentionCoverage']
}) {
  const value = metric.state === 'available' && Number.isFinite(metric.delta)
    ? percentagePoints(metric.delta)
    : 'Unavailable'
  return (
    <div>
      <dt className="text-xs text-secondary">{label}</dt>
      <dd className="mt-0.5 font-mono text-base font-semibold tabular-nums text-heading">{value}</dd>
    </div>
  )
}

function Rail({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <section aria-labelledby="measurement-changes-rail-heading" aria-busy={busy} className="border-y border-default py-4">
      <h2 id="measurement-changes-rail-heading" className="text-base font-semibold text-heading">Since previous comparable sweep</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function MeasurementChangesRail(props: MeasurementChangesRailProps) {
  const query = useQuery({
    ...getApiV1ProjectsByNameMeasurementChangesOptions({
      client: heyClient,
      path: { name: props.project },
      query: {
        scope: props.scope,
        ...(props.scope === 'group' ? { groupKey: props.groupKey } : { targetKey: props.targetKey }),
        queryClass: props.queryClass,
        runId: props.runId,
      },
    }),
    enabled: Boolean(props.project) && Boolean(props.runId),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // Do not keep a prior scope or run's comparison on screen while this key is
  // refreshing. The adjacent pulse and evidence stay mounted; only this local
  // comparison waits for the exact requested run.
  if (query.isPending || query.isFetching) {
    return <Rail busy><p className="text-sm text-secondary">Loading changes…</p></Rail>
  }

  if (query.isError) {
    return (
      <Rail>
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-negative">
          <span>Could not load measurement changes.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => { void query.refetch() }}>Retry</Button>
        </div>
      </Rail>
    )
  }

  const comparison = query.data.comparison
  if (comparison.state === 'unavailable') {
    return <Rail><p className="text-sm text-secondary">{UNAVAILABLE_COPY[comparison.reason]}</p></Rail>
  }

  return (
    <Rail>
      <dl className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <Delta label="Mention" metric={comparison.metrics.mentionCoverage} />
        <Delta label="Citation" metric={comparison.metrics.citationCoverage} />
      </dl>
      {props.scope === 'group' ? (
        <p className="mt-3 text-sm text-secondary">
          {comparison.totalProperties} {comparison.totalProperties === 1 ? 'property' : 'properties'} changed
        </p>
      ) : null}
    </Rail>
  )
}

import { useId } from 'react'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import type { RunListItemVm } from '../../view-models.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import { Disclosure } from '../shared/Disclosure.js'

/** One status word per sweep. Only a sweep that did not simply complete is coloured. */
const STATUS_WORD: Record<RunListItemVm['status'], { word: string; tone: string }> = {
  [RunStatuses.queued]: { word: 'queued', tone: 'text-secondary' },
  [RunStatuses.running]: { word: 'running', tone: 'text-info-300' },
  [RunStatuses.completed]: { word: 'completed', tone: 'text-secondary' },
  [RunStatuses.partial]: { word: 'partial', tone: 'text-caution-400' },
  [RunStatuses.failed]: { word: 'failed', tone: 'text-negative-400' },
  [RunStatuses.cancelled]: { word: 'cancelled', tone: 'text-secondary' },
}

/**
 * "Past sweeps": one line per run with its time, trigger ("Spot check" for a
 * probe), duration in words and status word, and the run count in the head. A
 * partial or failed sweep keeps its error detail on the line, and the time
 * opens the run. The kind gets a column when the list holds more than AI
 * sweeps. Details keeps each run's summary and status detail, the old run
 * card's title and detail line. RunsPage keeps the fuller `RunRow` card.
 */
export function PastSweeps({ runs }: { runs: readonly RunListItemVm[] }) {
  const titleId = useId()
  const { openRun } = useDrawer()
  // Multi-location sweeps share a start time, so the location tells them apart.
  const showLocation = new Set(runs.map(run => run.location ?? '')).size > 1
  // The title says "sweeps"; any other run kind in the list is named on its line.
  const showKind = runs.some(run => run.kind !== RunKinds['answer-visibility'])
  const details = runs.map(run => `${run.startedAt}: ${run.summary}.${run.statusDetail ? ` ${run.statusDetail}` : ''}`)

  return (
    <section className="overview-brief" aria-labelledby={titleId}>
      <div className="av-card-head">
        <h2 id={titleId} className="av-card-title">Past sweeps</h2>
        {runs.length > 0 ? <p className="av-card-meta">{runs.length} recent</p> : null}
      </div>
      <div className="av-card-body">
        {runs.length === 0 ? (
          <p className="text-sm text-secondary">No sweeps yet.</p>
        ) : (
          <table className="av-grid av-grid-dense av-grid-sweeps" aria-labelledby={titleId}>
            <thead className="sr-only">
              <tr>
                <th scope="col">Started</th>
                {showKind ? <th scope="col">Type</th> : null}
                <th scope="col">Trigger</th>
                {showLocation ? <th scope="col">Location</th> : null}
                <th scope="col">Duration</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const status = STATUS_WORD[run.status]
                const showDetail = run.status === RunStatuses.partial || run.status === RunStatuses.failed
                return (
                  <tr key={run.id}>
                    <th scope="row" className="av-row-label tabular-nums">
                      <button type="button" className="av-link" onClick={() => openRun(run.id)} aria-label={`View the ${run.startedAt} sweep`}>
                        {run.startedAt}
                      </button>
                    </th>
                    {showKind ? <td className="text-[13px] text-secondary">{run.kindLabel}</td> : null}
                    <td className="text-[13px] text-secondary">{run.triggerLabel}</td>
                    {showLocation ? <td className="text-[13px] text-secondary">{run.location ?? 'No location'}</td> : null}
                    <td className="text-[13px] text-secondary">{run.duration}</td>
                    <td>
                      <span className={`av-status ${status.tone}`}>{status.word}</span>
                      {showDetail && run.statusDetail ? <span className="ml-2 text-[13px] text-secondary">{run.statusDetail}</span> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      <Disclosure items={details} />
    </section>
  )
}

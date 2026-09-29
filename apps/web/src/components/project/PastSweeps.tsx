import { useId } from 'react'
import { RunStatuses } from '@ainyc/canonry-contracts'
import type { RunListItemVm } from '../../view-models.js'
import { useDrawer } from '../../hooks/use-drawer.js'

/** A status word only when the sweep did not simply complete. */
const STATUS_WORD: Partial<Record<RunListItemVm['status'], { word: string; tone: string }>> = {
  [RunStatuses.partial]: { word: 'partial', tone: 'text-caution-400' },
  [RunStatuses.failed]: { word: 'failed', tone: 'text-negative-400' },
  [RunStatuses.cancelled]: { word: 'cancelled', tone: 'text-secondary' },
}

/**
 * "Past sweeps": one line per sweep with its time, trigger ("Spot check" for a
 * probe) and duration in words. A partial or failed sweep keeps its error
 * detail on the line, and the time opens the run. RunsPage keeps the fuller
 * `RunRow` card.
 */
export function PastSweeps({ runs }: { runs: readonly RunListItemVm[] }) {
  const titleId = useId()
  const { openRun } = useDrawer()
  // Multi-location sweeps share a start time, so the location tells them apart.
  const showLocation = new Set(runs.map(run => run.location ?? '')).size > 1

  return (
    <section className="overview-brief" aria-labelledby={titleId}>
      <div className="av-card-head">
        <h2 id={titleId} className="av-card-title">Past sweeps</h2>
      </div>
      <div className="av-card-body">
        {runs.length === 0 ? (
          <p className="text-sm text-secondary">No sweeps yet.</p>
        ) : (
          <table className="av-grid av-grid-dense av-grid-sweeps" aria-labelledby={titleId}>
            <thead className="sr-only">
              <tr>
                <th scope="col">Started</th>
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
                    <td className="text-[13px] text-secondary">{run.triggerLabel}</td>
                    {showLocation ? <td className="text-[13px] text-secondary">{run.location ?? 'No location'}</td> : null}
                    <td className="text-[13px] text-secondary">{run.duration}</td>
                    <td>
                      {status ? <span className={`av-status ${status.tone}`}>{status.word}</span> : null}
                      {showDetail && run.statusDetail ? <span className="ml-2 text-[13px] text-secondary">{run.statusDetail}</span> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

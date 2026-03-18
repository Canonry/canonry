import type { RunListItemVm } from '../../view-models.js'
import { Button } from '../ui/button.js'
import { StatusBadge } from './StatusBadge.js'

export function RunRow({
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

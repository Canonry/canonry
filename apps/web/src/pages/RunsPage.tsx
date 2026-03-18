import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { RunRow } from '../components/shared/RunRow.js'
import { toTitleCase } from '../lib/format-helpers.js'
import { useDashboard } from '../queries/use-dashboard.js'
import type { RunFilter } from '../view-models.js'

export function RunsPage() {
  const { dashboard } = useDashboard()
  const runs = dashboard?.runs ?? []
  const [filter, setFilter] = useState<RunFilter>('all')
  const filteredRuns = filter === 'all' ? runs : runs.filter((run) => run.status === filter)

  const handleTriggerAll = () => {
    import('../api.js').then(({ triggerAllRuns }) =>
      triggerAllRuns().catch((err: unknown) => {
        console.error('Failed to trigger all runs', err)
      }),
    )
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Runs</h1>
          <p className="page-subtitle">
            Status, type, project, duration, and the shortest explanation that makes the outcome trustworthy.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleTriggerAll}>
          Run all projects
        </Button>
      </div>

      <section>
        <div className="filter-row" role="toolbar" aria-label="Run filters">
          {(['all', 'queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const).map((option) => (
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
            filteredRuns.map((run) => <RunRow key={run.id} run={run} />)
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

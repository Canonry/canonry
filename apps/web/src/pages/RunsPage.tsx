import { useState } from 'react'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { RunRow } from '../components/shared/RunRow.js'
import { toTitleCase } from '../lib/format-helpers.js'
import { useTriggerAllRuns } from '../queries/mutations.js'
import { useDashboard } from '../queries/use-dashboard.js'
import type { RunFilter } from '../view-models.js'

export function RunsPage() {
  const { dashboard, isLoading } = useDashboard()
  const triggerAllRunsMutation = useTriggerAllRuns()

  if (!dashboard || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-20" />
          <div className="skeleton-text-sm w-72" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-3 flex items-center gap-3">
              <div className="flex-1 space-y-1.5">
                <div className="skeleton-text w-40" />
                <div className="skeleton-text-sm w-56" />
              </div>
              <div className="skeleton h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const runs = dashboard.runs
  const [filter, setFilter] = useState<RunFilter>('all')
  const filteredRuns = filter === 'all' ? runs : runs.filter((run) => run.status === filter)

  const handleTriggerAll = async () => {
    try {
      await triggerAllRunsMutation.mutateAsync(undefined)
    } catch {
      // Mutation hook surfaces the toast and error state.
    }
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
        <Button type="button" variant="outline" size="sm" disabled={triggerAllRunsMutation.isPending} onClick={() => void handleTriggerAll()}>
          {triggerAllRunsMutation.isPending ? 'Queueing…' : 'Run all projects'}
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

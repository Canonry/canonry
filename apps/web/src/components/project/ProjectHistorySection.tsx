import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getApiV1ProjectsByNameHealthHistoryOptions,
  getApiV1ProjectsByNameRunsOptions,
  getApiV1ProjectsByNameSnapshotsDiffOptions,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { AuditHistoryPanel } from '../shared/AuditHistoryPanel.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'

type HistoryView = 'changes' | 'health' | 'compare'

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function ProjectHistorySection({ projectName }: { projectName: string }) {
  const [view, setView] = useState<HistoryView>('changes')
  const [firstRunId, setFirstRunId] = useState<string | null>(null)
  const [secondRunId, setSecondRunId] = useState<string | null>(null)

  const healthQuery = useQuery({
    ...getApiV1ProjectsByNameHealthHistoryOptions({ client: heyClient, path: { name: projectName }, query: { limit: 30 } }),
    enabled: view === 'health',
  })
  const runsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: 'answer-visibility', limit: 100 },
    }),
    enabled: view === 'compare',
  })
  const comparableRuns = (runsQuery.data ?? [])
    .filter((run) => (run.status === 'completed' || run.status === 'partial') && run.trigger !== 'probe')
    .reverse()
  const resolvedSecondRunId = secondRunId ?? comparableRuns[0]?.id ?? ''
  const resolvedFirstRunId = firstRunId ?? comparableRuns.find((run) => run.id !== resolvedSecondRunId)?.id ?? ''
  const canCompare = Boolean(resolvedFirstRunId && resolvedSecondRunId && resolvedFirstRunId !== resolvedSecondRunId)
  const diffQuery = useQuery({
    ...getApiV1ProjectsByNameSnapshotsDiffOptions({
      client: heyClient,
      path: { name: projectName },
      query: { run1: resolvedFirstRunId, run2: resolvedSecondRunId },
    }),
    enabled: view === 'compare' && canCompare,
  })
  const healthRows = healthQuery.data ?? []
  const changedRows = diffQuery.data?.diff.filter((row) => row.changed || row.visibilityChanged) ?? []

  return (
    <div className="mt-6">
      <div className="filter-row" role="tablist" aria-label="Project history views">
        {([
          ['changes', 'Changes'],
          ['health', 'Coverage history'],
          ['compare', 'Compare runs'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={`filter-chip ${view === key ? 'filter-chip-active' : ''}`}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'changes' ? <AuditHistoryPanel projectName={projectName} /> : null}

      {view === 'health' ? (
        <section className="mt-6" aria-labelledby="coverage-history-heading">
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Query evidence</p>
            <h2 id="coverage-history-heading">Mention and citation coverage</h2>
            <p className="supporting-copy mt-1">Independent answer-text mentions and source citations across completed sweeps.</p>
          </div>
          {healthQuery.isLoading ? <p className="supporting-copy mt-4" role="status">Loading coverage history…</p> : null}
          {!healthQuery.isLoading && healthRows.length === 0 ? (
            <Card className="surface-card empty-card mt-4">
              <h3>No coverage history yet</h3>
              <p>Complete an answer visibility sweep to create the first snapshot.</p>
            </Card>
          ) : null}
          {healthRows.length > 0 ? (
            <div className="evidence-table-wrap mt-4">
              <table className="evidence-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="text-right">Mentioned</th>
                    <th className="text-right">Mention coverage</th>
                    <th className="text-right">Cited</th>
                    <th className="text-right">Citation coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {healthRows.map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td className="whitespace-nowrap tabular-nums text-secondary">{new Date(snapshot.createdAt).toLocaleString()}</td>
                      <td className="text-right tabular-nums text-secondary">{snapshot.mentionedPairs}/{snapshot.totalPairs}</td>
                      <td className="text-right tabular-nums text-strong">{percent(snapshot.overallMentionRate)}</td>
                      <td className="text-right tabular-nums text-secondary">{snapshot.citedPairs}/{snapshot.totalPairs}</td>
                      <td className="text-right tabular-nums text-strong">{percent(snapshot.overallCitedRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {view === 'compare' ? (
        <section className="mt-6" aria-labelledby="compare-runs-heading">
          <div className="section-head">
            <p className="eyebrow eyebrow-soft">Evidence diff</p>
            <h2 id="compare-runs-heading">Compare answer visibility runs</h2>
            <p className="supporting-copy mt-1">See which tracked queries changed mention or citation state between two sweeps.</p>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Earlier run
              <select
                value={resolvedFirstRunId}
                onChange={(event) => setFirstRunId(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-base bg-bg px-3 text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                {comparableRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted">
              Later run
              <select
                value={resolvedSecondRunId}
                onChange={(event) => setSecondRunId(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-base bg-bg px-3 text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                {comparableRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </label>
          </div>
          {runsQuery.isLoading || diffQuery.isLoading ? <p className="supporting-copy mt-4" role="status">Comparing runs…</p> : null}
          {!runsQuery.isLoading && comparableRuns.length < 2 ? (
            <Card className="surface-card empty-card mt-4">
              <h3>Two completed sweeps are required</h3>
              <p>Run another answer visibility sweep before comparing historical evidence.</p>
            </Card>
          ) : null}
          {diffQuery.data && changedRows.length === 0 ? (
            <Card className="surface-card empty-card mt-4">
              <h3>No mention or citation changes</h3>
              <p>The selected sweeps have the same states for every comparable tracked query.</p>
            </Card>
          ) : null}
          {changedRows.length > 0 ? (
            <div className="evidence-table-wrap mt-4">
              <table className="evidence-table">
                <thead>
                  <tr>
                    <th>Query</th>
                    <th>Citation</th>
                    <th>Mention</th>
                  </tr>
                </thead>
                <tbody>
                  {changedRows.map((row) => (
                    <tr key={row.queryId ?? row.query ?? 'unknown'}>
                      <td className="text-strong">{row.query ?? 'Archived query'}</td>
                      <td>
                        <ToneBadge tone={row.changed ? 'caution' : 'neutral'}>{row.run1State ?? 'none'} → {row.run2State ?? 'none'}</ToneBadge>
                      </td>
                      <td>
                        <ToneBadge tone={row.visibilityChanged ? 'caution' : 'neutral'}>{row.run1MentionState ?? 'none'} → {row.run2MentionState ?? 'none'}</ToneBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

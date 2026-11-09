import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatPercent, RunKinds, RunStatuses, RunTriggers } from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameHealthHistoryOptions,
  getApiV1ProjectsByNameRunsOptions,
  getApiV1ProjectsByNameSnapshotsDiffOptions,
} from '@canonry/canonry-api-client/react-query'

import { heyClient, isDashboardManagedSweeps } from '../../api.js'
import { MANAGED_SWEEPS_COPY } from './ManagedSweepStatus.js'
import { AuditHistoryPanel } from '../shared/AuditHistoryPanel.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { WorkspaceTabs } from '../shared/WorkspaceTabs.js'

type HistoryView = 'changes' | 'health' | 'compare'

export function ProjectHistorySection({ projectName }: { projectName: string }) {
  const tabsId = useId()
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
      query: { kind: RunKinds['answer-visibility'], limit: 100 },
    }),
    enabled: view === 'compare',
  })
  const comparableRuns = (runsQuery.data ?? [])
    .filter((run) => (run.status === RunStatuses.completed || run.status === RunStatuses.partial) && run.trigger !== RunTriggers.probe)
    .reverse()
  const hasComparableRuns = new Set(comparableRuns.map(run => run.id)).size > 1
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
      <WorkspaceTabs
        id={tabsId}
        label="Project history views"
        value={view}
        onChange={setView}
        className="filter-row"
        tabClassName="filter-chip"
        activeTabClassName="filter-chip-active"
        options={[
          ['changes', 'Changes'],
          ['health', 'Coverage history'],
          ['compare', 'Compare runs'],
        ]}
      />
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${view}`} tabIndex={0}>
      {view === 'changes' ? <AuditHistoryPanel projectName={projectName} /> : null}

      {view === 'health' ? (
        <section className="mt-6" aria-labelledby="coverage-history-heading">
          <div className="flex items-center gap-2">
            <h2 id="coverage-history-heading" className="text-heading-16 text-heading">Mention and citation coverage</h2>
            <InfoTooltip text="Independent answer-text mentions and source citations across completed checks." />
          </div>
          {healthQuery.isLoading ? <p className="supporting-copy mt-4" role="status">Loading coverage history…</p> : null}
          {!healthQuery.isLoading && healthRows.length === 0 ? (
            <Card className="surface-card empty-card mt-4">
              <h3>No coverage history yet</h3>
              <p>{isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Complete an AI Visibility check to create the first snapshot.'}</p>
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
                      <td className="text-right tabular-nums text-strong">{formatPercent(snapshot.overallMentionRate)}</td>
                      <td className="text-right tabular-nums text-secondary">{snapshot.citedPairs}/{snapshot.totalPairs}</td>
                      <td className="text-right tabular-nums text-strong">{formatPercent(snapshot.overallCitedRate)}</td>
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
          <div className="flex items-center gap-2">
            <h2 id="compare-runs-heading" className="text-heading-16 text-heading">Compare answer visibility runs</h2>
            <InfoTooltip text="See which tracked queries changed mention or citation state between two checks." />
          </div>
          {hasComparableRuns && <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-label-12 text-muted">
              Earlier run
              <select
                value={resolvedFirstRunId}
                onChange={(event) => setFirstRunId(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-base bg-bg px-3 text-label-14 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                {comparableRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </label>
            <label className="text-label-12 text-muted">
              Later run
              <select
                value={resolvedSecondRunId}
                onChange={(event) => setSecondRunId(event.target.value)}
                className="mt-1 min-h-11 w-full rounded-md border border-base bg-bg px-3 text-label-14 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                {comparableRuns.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()}</option>)}
              </select>
            </label>
          </div>}
          {runsQuery.isLoading || diffQuery.isLoading ? <p className="supporting-copy mt-4" role="status">Comparing runs…</p> : null}
          {!runsQuery.isLoading && !hasComparableRuns ? (
            <Card className="surface-card empty-card mt-4">
              <h3>Two completed checks are required</h3>
              <p>{isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Run another AI Visibility check before comparing historical evidence.'}</p>
            </Card>
          ) : null}
          {diffQuery.data && changedRows.length === 0 ? (
            <Card className="surface-card empty-card mt-4">
              <h3>No mention or citation changes</h3>
              <p>The selected checks have the same states for every comparable tracked query.</p>
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
    </div>
  )
}

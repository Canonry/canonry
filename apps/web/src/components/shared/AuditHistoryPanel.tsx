import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AuditLogEntry } from '@canonry/canonry-contracts'
import {
  getApiV1HistoryOptions,
  getApiV1ProjectsOptions,
  getApiV1ProjectsByNameHistoryOptions,
} from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../api.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from './ToneBadge.js'

function TrackingHistoryDetail({ entry }: { entry: AuditLogEntry }) {
  const diff = entry.diff && typeof entry.diff === 'object' ? entry.diff as Record<string, unknown> : {}
  const queries = diff.queries && typeof diff.queries === 'object' ? diff.queries as Record<string, unknown> : null
  const counts = queries?.counts && typeof queries.counts === 'object' ? queries.counts as Record<string, unknown> : null
  const kinds = ['added', 'stopped', 'removed', 'changed'] as const
  const lists = kinds.map(kind => ({ kind, texts: Array.isArray(queries?.[kind]) ? (queries[kind] as unknown[]).filter((text): text is string => typeof text === 'string') : [] }))
  const summary = queries ? lists.flatMap(({ kind, texts }) => {
    const recorded = counts?.[kind]
    const total = typeof recorded === 'number' ? recorded : texts.length
    return total ? [`${total.toLocaleString('en-US')} ${kind}`] : []
  }).join(' · ') : [typeof diff.added === 'number' ? `${diff.added} added` : '', typeof diff.removed === 'number' ? `${diff.removed} ${entry.action === 'query-tracking.updated' ? 'removed' : 'stopped'}` : '', typeof diff.reused === 'number' && diff.reused > 0 ? `${diff.reused} matched` : ''].filter(Boolean).join(' · ')
  return <div className="text-sm text-secondary">
    <p>{summary || 'Tracked queries updated'}</p>
    {lists.some(list => list.texts.length > 0) ? <details>
      <summary className="min-h-11 cursor-pointer py-3">View queries</summary>
      <ul className="max-h-72 space-y-2 overflow-auto">{lists.flatMap(({ kind, texts }) => texts.map((text, index) => <li key={`${kind}:${index}`}>{kind[0]!.toUpperCase() + kind.slice(1)} · {text}</li>))}</ul>
      {queries?.truncated === true ? <p>More queries changed.</p> : null}
    </details> : null}
  </div>
}

const PAGE_SIZE = 100

type HistoryWindow = '30d' | '90d' | '365d' | 'all'

function sinceForWindow(window: HistoryWindow): string | undefined {
  if (window === 'all') return undefined
  const days = Number.parseInt(window, 10)
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function clientLabel(entry: AuditLogEntry): string {
  const userAgent = entry.userAgent?.toLowerCase() ?? ''
  if (userAgent.includes('canonry-mcp')) return 'MCP'
  if (userAgent.includes('canonry-cli')) return 'CLI'
  if (userAgent.includes('mozilla/')) return 'Dashboard'
  if (entry.actor === 'scheduler') return 'Scheduler'
  if (entry.actor === 'agent') return 'Agent'
  if (entry.actor === 'mcp') return 'MCP'
  if (entry.actor === 'cli') return 'CLI'
  return entry.actor
}

function actionTone(action: string): 'positive' | 'caution' | 'negative' | 'neutral' {
  if (/delete|remove|revoke|disconnect|failed|refused/.test(action)) return 'negative'
  if (/create|add|connect|completed/.test(action)) return 'positive'
  if (/update|replace|sync|apply/.test(action)) return 'caution'
  return 'neutral'
}

function searchableEntry(entry: AuditLogEntry): string {
  return [
    entry.action,
    entry.actor,
    entry.entityType,
    entry.entityId,
    entry.actorSession,
    entry.userAgent,
    entry.diff == null ? '' : JSON.stringify(entry.diff),
  ].filter(Boolean).join(' ').toLowerCase()
}

export function AuditHistoryPanel({ projectName }: { projectName?: string }) {
  const [page, setPage] = useState(0)
  const [window, setWindow] = useState<HistoryWindow>('90d')
  const [actor, setActor] = useState('')
  const [search, setSearch] = useState('')
  const since = useMemo(() => sinceForWindow(window), [window])
  const query = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    since,
    actor: actor || undefined,
  }
  const projectHistoryQuery = useQuery({
    ...getApiV1ProjectsByNameHistoryOptions({ client: heyClient, path: { name: projectName ?? '' }, query }),
    enabled: Boolean(projectName),
  })
  const globalHistoryQuery = useQuery({
    ...getApiV1HistoryOptions({ client: heyClient, query }),
    enabled: !projectName,
  })
  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: !projectName,
  })
  const historyQuery = projectName ? projectHistoryQuery : globalHistoryQuery
  const entries = historyQuery.data ?? []
  const projectLabels = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project.displayName || project.name])),
    [projectsQuery.data],
  )
  const normalizedSearch = search.trim().toLowerCase()
  const visibleEntries = useMemo(
    () => normalizedSearch ? entries.filter((entry) => searchableEntry(entry).includes(normalizedSearch)) : entries,
    [entries, normalizedSearch],
  )

  const resetPage = (callback: () => void) => {
    setPage(0)
    callback()
  }

  if (historyQuery.isLoading) {
    return <p className="supporting-copy mt-6" role="status">Loading change history…</p>
  }

  return (
    <section className="mt-6" aria-labelledby="change-history-heading">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Audit trail</p>
          <h2 id="change-history-heading">Change history</h2>
          <p className="supporting-copy mt-1 max-w-2xl">
            Configuration and operator actions. Execution outcomes remain in Runs.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void historyQuery.refetch()} disabled={historyQuery.isFetching}>
          {historyQuery.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <input
          type="search"
          aria-label="Search change history"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search actions, entities, or details"
          className="min-h-11 rounded-md border border-base bg-bg px-3 text-sm text-strong placeholder-mono-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
        />
        <select
          aria-label="Filter change history by actor"
          value={actor}
          onChange={(event) => resetPage(() => setActor(event.target.value))}
          className="min-h-11 rounded-md border border-base bg-bg px-3 text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
        >
          <option value="">All actors</option>
          <option value="api">API and dashboard</option>
          <option value="cli">CLI</option>
          <option value="scheduler">Scheduler</option>
          <option value="agent">Agent</option>
          <option value="mcp">MCP</option>
        </select>
        <select
          aria-label="Filter change history by date range"
          value={window}
          onChange={(event) => resetPage(() => setWindow(event.target.value as HistoryWindow))}
          className="min-h-11 rounded-md border border-base bg-bg px-3 text-sm text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
        >
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="365d">Last year</option>
          <option value="all">All retained history</option>
        </select>
      </div>

      {historyQuery.isError ? (
        <Card className="surface-card empty-card mt-4">
          <h3>Change history unavailable</h3>
          <p>{historyQuery.error instanceof Error ? historyQuery.error.message : 'Could not load the audit trail.'}</p>
        </Card>
      ) : visibleEntries.length === 0 ? (
        <Card className="surface-card empty-card mt-4">
          <h3>No changes match these filters</h3>
          <p>Widen the date range or clear the actor and search filters.</p>
        </Card>
      ) : (
        <div className="evidence-table-wrap mt-4">
          <table className="evidence-table">
            <thead>
              <tr>
                <th>When</th>
                {!projectName ? <th>Scope</th> : null}
                <th>Action</th>
                <th>Entity</th>
                <th>Origin</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap tabular-nums text-muted">{new Date(entry.createdAt).toLocaleString()}</td>
                  {!projectName ? (
                    <td className="text-secondary">
                      {entry.projectId
                        ? projectLabels.get(entry.projectId) ?? `Deleted project · ${entry.projectId}`
                        : 'Instance settings'}
                    </td>
                  ) : null}
                  <td><ToneBadge tone={actionTone(entry.action)}>{entry.action}</ToneBadge></td>
                  <td>
                    <span className="text-strong">{entry.entityType}</span>
                    {entry.entityId ? <span className="mt-0.5 block max-w-48 truncate font-mono text-[11px] text-faint" title={entry.entityId}>{entry.entityId}</span> : null}
                  </td>
                  <td>
                    <span className="text-secondary">{clientLabel(entry)}</span>
                    {entry.actorSession ? <span className="mt-0.5 block max-w-40 truncate font-mono text-[11px] text-faint" title={entry.actorSession}>Session {entry.actorSession}</span> : null}
                  </td>
                  <td>
                    {entry.action === 'query-tracking.published' || entry.action === 'query-tracking.updated' ? <TrackingHistoryDetail entry={entry} /> : entry.diff == null ? <span className="text-faint">No field diff</span> : (
                      <details>
                        <summary className="min-h-11 cursor-pointer py-3 text-sm text-secondary hover:text-strong">View diff</summary>
                        <pre className="max-h-72 max-w-xl overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-elevated p-3 text-xs text-secondary">{JSON.stringify(entry.diff, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!historyQuery.isError && (page > 0 || entries.length === PAGE_SIZE) ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</Button>
          <span className="text-xs tabular-nums text-muted">Page {page + 1}</span>
          <Button type="button" variant="outline" size="sm" disabled={entries.length < PAGE_SIZE} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      ) : null}
    </section>
  )
}

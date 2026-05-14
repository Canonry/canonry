import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Play, RefreshCw } from 'lucide-react'
import type { DiscoveryBucket, DiscoverySessionDto } from '@ainyc/canonry-contracts'

import {
  fetchDiscoverySession,
  fetchDiscoverySessions,
  previewDiscoveryPromote,
  promoteDiscovery,
  triggerDiscoveryRun,
  type DiscoveryPromoteResult,
} from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { queryKeys } from '../../queries/query-keys.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])

export function DiscoverySection({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [icpDescription, setIcpDescription] = useState('')
  const [maxProbes, setMaxProbes] = useState('100')

  const sessionsQuery = useQuery({
    queryKey: queryKeys.discovery.sessions(projectName),
    queryFn: () => fetchDiscoverySessions(projectName, { limit: 10 }),
    refetchInterval: (query) => {
      const sessions = query.state.data
      return sessions?.some(session => ACTIVE_DISCOVERY_STATUSES.has(session.status)) ? 3000 : false
    },
  })

  const sessions = sessionsQuery.data ?? []

  useEffect(() => {
    if (!selectedSessionId && sessions[0]) {
      setSelectedSessionId(sessions[0].id)
    }
  }, [selectedSessionId, sessions])

  const selectedSession = sessions.find(session => session.id === selectedSessionId) ?? null

  const detailQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.discovery.session(projectName, selectedSessionId)
      : queryKeys.discovery.session(projectName, 'none'),
    queryFn: () => fetchDiscoverySession(projectName, selectedSessionId ?? ''),
    enabled: Boolean(selectedSessionId),
    refetchInterval: selectedSession && ACTIVE_DISCOVERY_STATUSES.has(selectedSession.status) ? 3000 : false,
  })

  const detail = detailQuery.data ?? null

  const previewQuery = useQuery({
    queryKey: selectedSessionId
      ? queryKeys.discovery.promotePreview(projectName, selectedSessionId)
      : queryKeys.discovery.promotePreview(projectName, 'none'),
    queryFn: () => previewDiscoveryPromote(projectName, selectedSessionId ?? ''),
    enabled: Boolean(selectedSessionId && selectedSession?.status === 'completed'),
  })

  const startMutation = useMutation({
    mutationFn: () => {
      const body: { icpDescription?: string; maxProbes?: number } = {}
      const trimmedIcp = icpDescription.trim()
      if (trimmedIcp) body.icpDescription = trimmedIcp
      const parsedMax = Number.parseInt(maxProbes, 10)
      if (Number.isFinite(parsedMax) && parsedMax > 0) body.maxProbes = parsedMax
      return triggerDiscoveryRun(projectName, body)
    },
    onSuccess: async (result) => {
      setSelectedSessionId(result.sessionId)
      setIcpDescription('')
      await refreshDiscovery(queryClient, projectName, result.sessionId)
      addToast({
        title: 'Discovery queued',
        detail: `Session ${shortId(result.sessionId)} is probing representative queries.`,
        tone: 'neutral',
        dedupeKey: `discovery:start:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Discovery failed to start',
        detail: error instanceof Error ? error.message : 'Could not queue discovery.',
        tone: 'negative',
      })
    },
  })

  const promoteMutation = useMutation({
    mutationFn: (request?: { buckets?: DiscoveryBucket[]; includeCompetitors?: boolean }) => {
      if (!selectedSessionId) throw new Error('Select a completed discovery session first.')
      return promoteDiscovery(projectName, selectedSessionId, request)
    },
    onSuccess: async (result) => {
      await refreshDiscovery(queryClient, projectName, result.sessionId)
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      addToast({
        title: 'Discovery promoted',
        detail: promoteResultDetail(result),
        tone: 'positive',
        dedupeKey: `discovery:promote:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Promotion failed',
        detail: error instanceof Error ? error.message : 'Could not promote this session.',
        tone: 'negative',
      })
    },
  })

  const activeSession = detail ?? selectedSession
  const preview = previewQuery.data ?? null
  const safeDefaultCount = (preview?.queriesByBucket.cited.length ?? 0) + (preview?.queriesByBucket.aspirational.length ?? 0)
  const probeRows = useMemo(() => (detail?.probes ?? []).slice(0, 30), [detail?.probes])

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Discovery</p>
          <h2>Grounded query discovery</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">
            Seed representative ICP queries, probe grounding citations, then promote the safe default basket when the results make sense.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessionsQuery.isFetching}
          onClick={() => void sessionsQuery.refetch()}
        >
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Run</p>
                <h3>Start discovery</h3>
              </div>
              <ToneBadge tone="neutral">Gemini</ToneBadge>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-zinc-500">ICP description</span>
                <textarea
                  className="mt-1 min-h-24 w-full rounded border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  placeholder="Leave blank to use the ICP stored on the project."
                  value={icpDescription}
                  onChange={(event) => setIcpDescription(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-500">Probe budget</span>
                <input
                  className="mt-1 w-full rounded border border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  inputMode="numeric"
                  value={maxProbes}
                  onChange={(event) => setMaxProbes(event.target.value)}
                />
              </label>
              <Button
                type="button"
                size="sm"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate()}
              >
                <Play size={14} />
                {startMutation.isPending ? 'Queueing...' : 'Start discovery'}
              </Button>
            </div>
          </Card>

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Sessions</p>
                <h3>Recent runs</h3>
              </div>
              {sessionsQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {sessions.length === 0 ? (
              <p className="text-sm text-zinc-500">No discovery sessions yet.</p>
            ) : (
              <div className="space-y-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      selectedSessionId === session.id
                        ? 'border-zinc-600 bg-zinc-900/70'
                        : 'border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900/40'
                    }`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-zinc-100">{shortId(session.id)}</span>
                      <ToneBadge tone={toneForSession(session.status)}>{session.status}</ToneBadge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-zinc-500">
                      <span>Cited {session.citedCount ?? 0}</span>
                      <span>Aspir. {session.aspirationalCount ?? 0}</span>
                      <span>Waste {session.wastedCount ?? 0}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Selected session</p>
                <h3>{activeSession ? shortId(activeSession.id) : 'No session selected'}</h3>
              </div>
              {activeSession && <ToneBadge tone={toneForSession(activeSession.status)}>{activeSession.status}</ToneBadge>}
            </div>

            {!activeSession ? (
              <p className="text-sm text-zinc-500">Start or select a session to inspect discovery progress.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <DiscoveryMetric label="Probes" value={activeSession.probeCount ?? 0} />
                  <DiscoveryMetric label="Cited" value={activeSession.citedCount ?? 0} tone="positive" />
                  <DiscoveryMetric label="Aspirational" value={activeSession.aspirationalCount ?? 0} tone="caution" />
                  <DiscoveryMetric label="Wasted" value={activeSession.wastedCount ?? 0} tone="negative" />
                </div>

                {activeSession.error && (
                  <div className="rounded-md border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
                    {activeSession.error}
                  </div>
                )}

                {activeSession.icpDescription && (
                  <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-zinc-500">ICP</p>
                    <p className="mt-1 text-sm text-zinc-300">{activeSession.icpDescription}</p>
                  </div>
                )}

                {activeSession.competitorMap.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-zinc-400">Recurring citation domains</p>
                    <div className="flex flex-wrap gap-2">
                      {activeSession.competitorMap.slice(0, 8).map(entry => (
                        <span key={entry.domain} className="rounded-md border border-zinc-800/60 bg-zinc-950 px-2 py-1 text-xs text-zinc-300">
                          {entry.domain} <span className="text-zinc-500">{entry.hits}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>

          {activeSession?.status === 'completed' && (
            <Card className="surface-card">
              <div className="section-head section-head-inline">
                <div>
                  <p className="eyebrow eyebrow-soft">Promotion</p>
                  <h3>Preview candidates</h3>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={promoteMutation.isPending || safeDefaultCount === 0}
                  onClick={() => promoteMutation.mutate(undefined)}
                >
                  <CheckCircle2 size={14} />
                  {promoteMutation.isPending ? 'Promoting...' : 'Promote safe default'}
                </Button>
              </div>
              {previewQuery.isLoading ? (
                <p className="text-sm text-zinc-500">Loading promotion preview...</p>
              ) : preview ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-4">
                    <DiscoveryMetric label="Default query add" value={safeDefaultCount} tone="positive" />
                    <DiscoveryMetric label="Cited" value={preview.queriesByBucket.cited.length} tone="positive" />
                    <DiscoveryMetric label="Aspirational" value={preview.queriesByBucket.aspirational.length} tone="caution" />
                    <DiscoveryMetric label="Wasted opt-in" value={preview.queriesByBucket['wasted-surface'].length} tone="negative" />
                  </div>
                  <p className="text-xs leading-5 text-zinc-500">
                    The button promotes cited + aspirational queries and recurring competitors. Wasted-surface remains visible here as planning evidence and is not added unless an operator opts in through CLI or MCP.
                  </p>
                  {preview.suggestedCompetitors.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium text-zinc-400">Competitors promoted by default</p>
                      <div className="flex flex-wrap gap-2">
                        {preview.suggestedCompetitors.map(entry => (
                          <span key={entry.domain} className="rounded-md border border-zinc-800/60 bg-zinc-950 px-2 py-1 text-xs text-zinc-300">
                            {entry.domain} <span className="text-zinc-500">{entry.hits}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No promotion preview available.</p>
              )}
            </Card>
          )}

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Probe detail</p>
                <h3>Bucketed queries</h3>
              </div>
              {detailQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {probeRows.length === 0 ? (
              <p className="text-sm text-zinc-500">Probe rows appear once the session reaches the probing phase.</p>
            ) : (
              <div className="evidence-table-wrap">
                <table className="evidence-table">
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th>Bucket</th>
                      <th>Cited domains</th>
                    </tr>
                  </thead>
                  <tbody>
                    {probeRows.map(probe => (
                      <tr key={probe.id}>
                        <td className="font-medium text-zinc-100">{probe.query}</td>
                        <td>
                          <ToneBadge tone={toneForBucket(probe.bucket)}>{probe.bucket ?? 'unbucketed'}</ToneBadge>
                        </td>
                        <td className="text-zinc-400">
                          {probe.citedDomains.length > 0 ? probe.citedDomains.slice(0, 3).join(', ') : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </section>
  )
}

function DiscoveryMetric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'positive' | 'caution' | 'negative' | 'neutral'
}) {
  const valueClass =
    tone === 'positive' ? 'text-emerald-300' : tone === 'caution' ? 'text-amber-300' : tone === 'negative' ? 'text-rose-300' : 'text-zinc-100'
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

function toneForSession(status: DiscoverySessionDto['status']) {
  if (status === 'completed') return 'positive'
  if (status === 'failed') return 'negative'
  if (ACTIVE_DISCOVERY_STATUSES.has(status)) return 'caution'
  return 'neutral'
}

function toneForBucket(bucket: DiscoveryBucket | null) {
  if (bucket === 'cited') return 'positive'
  if (bucket === 'aspirational') return 'caution'
  if (bucket === 'wasted-surface') return 'negative'
  return 'neutral'
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function promoteResultDetail(result: DiscoveryPromoteResult): string {
  const queries = result.promoted.queries.length
  const competitors = result.promoted.competitors.length
  const skipped = result.skipped.queries.length + result.skipped.competitors.length
  return `${queries} quer${queries === 1 ? 'y' : 'ies'} and ${competitors} competitor${competitors === 1 ? '' : 's'} added${skipped > 0 ? `; ${skipped} already tracked` : ''}.`
}

async function refreshDiscovery(
  queryClient: QueryClientLike,
  projectName: string,
  sessionId: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.discovery.project(projectName) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.discovery.sessions(projectName) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.discovery.session(projectName, sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.discovery.promotePreview(projectName, sessionId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>

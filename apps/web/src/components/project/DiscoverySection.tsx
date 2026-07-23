import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Play, RefreshCw } from 'lucide-react'
import type { DiscoveryBucket, DiscoverySessionDto } from '@ainyc/canonry-contracts'

import {
  promoteDiscovery,
  triggerDiscoveryRun,
  heyClient,
  isEmbed,
  type DiscoveryPromoteResult,
} from '../../api.js'
import {
  getApiV1ProjectsByNameDiscoverSessionsByIdOptions,
  getApiV1ProjectsByNameDiscoverSessionsByIdPromoteOptions,
  getApiV1ProjectsByNameDiscoverSessionsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { addToast } from '../../lib/toast-store.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { ResearchQueriesSection } from './ResearchQueriesSection.js'

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])

export function DiscoverySection({ projectName }: { projectName: string }) {
  const [workflow, setWorkflow] = useState<'find' | 'research'>('find')

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Query discovery</p>
          <h2>Explore the questions that matter</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
            Find query ideas from an ideal customer profile, or run a focused research batch without changing what this project tracks.
          </p>
        </div>
      </div>
      <div className="inline-flex rounded-md border border-default bg-surface p-1" role="tablist" aria-label="Query discovery workflow">
        <button
          type="button"
          role="tab"
          aria-selected={workflow === 'find'}
          className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${workflow === 'find' ? 'bg-bg-elevated text-heading shadow-sm' : 'text-muted hover:text-strong'}`}
          onClick={() => setWorkflow('find')}
        >
          Find queries
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workflow === 'research'}
          className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${workflow === 'research' ? 'bg-bg-elevated text-heading shadow-sm' : 'text-muted hover:text-strong'}`}
          onClick={() => setWorkflow('research')}
        >
          Research queries
        </button>
      </div>
      <div className="mt-4">
        {workflow === 'find' ? <FindQueriesSection projectName={projectName} /> : <ResearchQueriesSection projectName={projectName} />}
      </div>
    </section>
  )
}

function FindQueriesSection({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [icpDescription, setIcpDescription] = useState('')
  const [maxProbes, setMaxProbes] = useState('100')

  const sessionsQuery = useQuery({
    ...getApiV1ProjectsByNameDiscoverSessionsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: '10' },
    }),
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
    ...getApiV1ProjectsByNameDiscoverSessionsByIdOptions({
      client: heyClient,
      path: { name: projectName, id: selectedSessionId ?? '' },
    }),
    enabled: Boolean(selectedSessionId),
    refetchInterval: selectedSession && ACTIVE_DISCOVERY_STATUSES.has(selectedSession.status) ? 3000 : false,
  })

  const detail = detailQuery.data ?? null

  const previewQuery = useQuery({
    ...getApiV1ProjectsByNameDiscoverSessionsByIdPromoteOptions({
      client: heyClient,
      path: { name: projectName, id: selectedSessionId ?? '' },
    }),
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
        title: 'Discovery started',
        detail: `Run ${shortId(result.sessionId)} is testing questions your customers might ask.`,
        tone: 'neutral',
        dedupeKey: `discovery:start:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Discovery failed to start',
        detail: error instanceof Error ? error.message : 'Could not start discovery.',
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
      // Promoting queries widens the project's tracked-query set — refresh
      // the top-level projects list so the next render reflects the new
      // count. Use the exact key (not a `getApiV1Projects` prefix predicate)
      // so we don't accidentally invalidate every project sub-endpoint.
      void queryClient.invalidateQueries({
        queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
      })
      // The per-project dashboard detail composite in `use-dashboard.ts`
      // (key shape `['projects', projectId, latestRunIdsKey]`) fans out to
      // `fetchQueries` + `fetchProjectOverview`; both surface the newly
      // promoted queries (tracked-query count, suggested-queries card
      // drops the now-tracked items). Without invalidating it the user
      // sees stale counts and a suggestion that's already been added —
      // same shape of bug as the suggested-queries "Add" button stuck on
      // "Adding…" before the per-detail invalidation landed.
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey)
          && query.queryKey[0] === 'projects'
          && query.queryKey.length > 1,
      })
      addToast({
        title: 'Queries added',
        detail: promoteResultDetail(result),
        tone: 'positive',
        dedupeKey: `discovery:promote:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Could not add queries',
        detail: error instanceof Error ? error.message : 'Could not add queries from this run.',
        tone: 'negative',
      })
    },
  })

  const activeSession = detail ?? selectedSession
  const preview = previewQuery.data ?? null
  const safeDefaultCount = (preview?.queriesByBucket.cited.length ?? 0) + (preview?.queriesByBucket.aspirational.length ?? 0)
  const probeRows = useMemo(() => (detail?.probes ?? []).slice(0, 30), [detail?.probes])

  async function handleRefreshSessions() {
    try {
      const result = await sessionsQuery.refetch()
      if (result.error) throw result.error
      const count = result.data?.length ?? 0
      addToast({
        title: 'Discovery sessions refreshed',
        detail: `${count} recent session${count === 1 ? '' : 's'} loaded.`,
        tone: 'positive',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      addToast({
        title: 'Discovery refresh failed',
        detail: error instanceof Error ? error.message : 'Could not reload discovery sessions.',
        tone: 'negative',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    }
  }

  return (
    <>
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Find queries</p>
          <h2>Find new queries to track</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
            {isEmbed()
              ? 'Generated questions your ideal customers would ask an AI engine, with a check of which ones already cite your site.'
              : 'Describe your ideal customer and Canonry generates the questions they would ask an AI engine, checks which ones already cite your site, then lets you add the promising ones to your tracked queries.'}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={sessionsQuery.isFetching}
          onClick={() => void handleRefreshSessions()}
        >
          <RefreshCw className={`size-3.5 ${sessionsQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Step 1</p>
                <h3>Describe your customer</h3>
              </div>
              <ToneBadge tone="neutral">Runs on Gemini</ToneBadge>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="text-xs text-muted">Who is your ideal customer?</span>
                <textarea
                  className="mt-1 min-h-24 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="e.g. Small e-commerce stores that want AI-powered customer support. Leave blank to use the customer profile saved on this project."
                  value={icpDescription}
                  onChange={(event) => setIcpDescription(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted">How many questions to test</span>
                <input
                  className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  inputMode="numeric"
                  value={maxProbes}
                  onChange={(event) => setMaxProbes(event.target.value)}
                />
                <span className="mt-1 block text-[11px] text-faint">
                  More questions means broader coverage but a longer run. 100 is a good default.
                </span>
              </label>
              {!isEmbed() && (
                <Button
                  type="button"
                  size="sm"
                  disabled={startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                >
                  <Play size={14} />
                  {startMutation.isPending ? 'Starting…' : 'Find queries'}
                </Button>
              )}
            </div>
          </Card>

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">History</p>
                <h3>Recent runs</h3>
              </div>
              {sessionsQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {sessions.length === 0 ? (
              <p className="text-sm text-muted">No discovery runs yet. Describe your customer above to start your first one.</p>
            ) : (
              <div className="space-y-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      selectedSessionId === session.id
                        ? 'border-mono-600 bg-bg-elevated/70'
                        : 'border-default bg-bg/40 hover:border-strong hover:bg-bg-elevated/40'
                    }`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-heading">{shortId(session.id)}</span>
                      <ToneBadge tone={toneForSession(session.status)}>{session.status}</ToneBadge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-muted">
                      <span>Cited {session.citedCount ?? 0}</span>
                      <span>Opportunity {session.aspirationalCount ?? 0}</span>
                      <span>Low value {session.wastedCount ?? 0}</span>
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
                <p className="eyebrow eyebrow-soft">Run detail</p>
                <h3>{activeSession ? shortId(activeSession.id) : 'No run selected'}</h3>
              </div>
              {activeSession && <ToneBadge tone={toneForSession(activeSession.status)}>{activeSession.status}</ToneBadge>}
            </div>

            {!activeSession ? (
              <p className="text-sm text-muted">Start a run above, or pick one from Recent runs to see its progress.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <DiscoveryMetric label="Questions tested" value={activeSession.probeCount ?? 0} />
                  <DiscoveryMetric label="Already cited" value={activeSession.citedCount ?? 0} tone="positive" />
                  <DiscoveryMetric label="Opportunities" value={activeSession.aspirationalCount ?? 0} tone="caution" />
                  <DiscoveryMetric label="Low value" value={activeSession.wastedCount ?? 0} tone="negative" />
                </div>

                {activeSession.error && (
                  <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">
                    {activeSession.error}
                  </div>
                )}

                {activeSession.warning && (
                  <div className="rounded-md border border-caution-800/40 bg-caution-950/20 px-3 py-2 text-sm text-caution">
                    {activeSession.warning}
                  </div>
                )}

                {activeSession.icpDescription && (
                  <div className="rounded-md border border-default bg-surface px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted">Customer profile</p>
                    <p className="mt-1 text-sm text-neutral">{activeSession.icpDescription}</p>
                  </div>
                )}

                {activeSession.competitorMap.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-medium text-secondary">Sites that keep getting cited</p>
                    <div className="flex flex-wrap gap-2">
                      {activeSession.competitorMap.slice(0, 8).map(entry => (
                        <span key={entry.domain} className="rounded-md border border-default bg-bg px-2 py-1 text-xs text-neutral">
                          {entry.domain} <span className="text-muted">{entry.hits}</span>
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
                  <p className="eyebrow eyebrow-soft">Step 2</p>
                  <h3>Add queries to your project</h3>
                </div>
                {!isEmbed() && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={promoteMutation.isPending || safeDefaultCount === 0}
                    onClick={() => promoteMutation.mutate(undefined)}
                  >
                    <CheckCircle2 size={14} />
                    {promoteMutation.isPending ? 'Adding…' : 'Add recommended queries'}
                  </Button>
                )}
              </div>
              {previewQuery.isLoading ? (
                <p className="text-sm text-muted">Loading recommendations…</p>
              ) : preview ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-4">
                    <DiscoveryMetric label="Queries to add" value={safeDefaultCount} tone="positive" />
                    <DiscoveryMetric label="Already cited" value={preview.queriesByBucket.cited.length} tone="positive" />
                    <DiscoveryMetric label="Opportunities" value={preview.queriesByBucket.aspirational.length} tone="caution" />
                    <DiscoveryMetric label="Low value (skipped)" value={preview.queriesByBucket['wasted-surface'].length} tone="negative" />
                  </div>
                  <p className="text-xs leading-5 text-muted">
                    Adding queries starts tracking the “already cited” and “opportunity” questions, plus any competitor sites that kept showing up. “Low value” questions are listed below for reference only and are not added.
                  </p>
                  {preview.suggestedCompetitors.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-medium text-secondary">Competitor sites that will be added</p>
                      <div className="flex flex-wrap gap-2">
                        {preview.suggestedCompetitors.map(entry => (
                          <span key={entry.domain} className="rounded-md border border-default bg-bg px-2 py-1 text-xs text-neutral">
                            {entry.domain} <span className="text-muted">{entry.hits}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">No recommendations available for this run.</p>
              )}
            </Card>
          )}

          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">All results</p>
                <h3>Every question we tested</h3>
              </div>
              {detailQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {probeRows.length === 0 ? (
              <p className="text-sm text-muted">Results show up here once the run starts testing questions.</p>
            ) : (
              <div className="evidence-table-wrap">
                <table className="evidence-table">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th>Result</th>
                      <th>Sites cited</th>
                    </tr>
                  </thead>
                  <tbody>
                    {probeRows.map(probe => (
                      <tr key={probe.id}>
                        <td className="font-medium text-heading">{probe.query}</td>
                        <td>
                          <ToneBadge tone={toneForBucket(probe.bucket)}>{bucketLabel(probe.bucket)}</ToneBadge>
                        </td>
                        <td className="text-secondary">
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
    </>
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
    tone === 'positive' ? 'text-positive' : tone === 'caution' ? 'text-caution' : tone === 'negative' ? 'text-negative' : 'text-heading'
  return (
    <div className="rounded-md border border-default bg-surface px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
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

const BUCKET_LABELS: Record<DiscoveryBucket, string> = {
  cited: 'Already cited',
  aspirational: 'Opportunity',
  'wasted-surface': 'Low value',
}

function bucketLabel(bucket: DiscoveryBucket | null): string {
  return bucket ? BUCKET_LABELS[bucket] : 'Not classified'
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
  _projectName: string,
  _sessionId: string,
) {
  // Generated `<op>QueryKey` helpers produce flat keys with no shared
  // hierarchical prefix, so match every discovery op by name pattern —
  // catches the list, detail, promote-preview, and any future discovery
  // variant. Runs list uses the exact key to avoid invalidating
  // run-detail caches unnecessarily.
  await Promise.all([
    queryClient.invalidateQueries({
      predicate: (query) => {
        const head = query.queryKey[0] as { _id?: string } | undefined
        return typeof head?._id === 'string' && head._id.startsWith('getApiV1ProjectsByNameDiscover')
      },
    }),
    queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>

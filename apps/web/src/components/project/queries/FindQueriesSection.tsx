import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, RefreshCw } from 'lucide-react'
import type { DiscoveryBucket, DiscoverySessionDto } from '@ainyc/canonry-contracts'
import {
  getApiV1ProjectsByNameDiscoverSessionsByIdOptions,
  getApiV1ProjectsByNameDiscoverSessionsOptions,
  getApiV1RunsQueryKey,
} from '@ainyc/canonry-api-client/react-query'

import { heyClient, isEmbed, triggerDiscoveryRun } from '../../../api.js'
import { addToast } from '../../../lib/toast-store.js'
import { invalidateProjectQueryDomain } from '../../../queries/query-invalidation.js'
import { WriteButton } from '../../shared/AccessControls.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'
import { Card } from '../../ui/card.js'
import { ResearchQueriesSection } from '../ResearchQueriesSection.js'

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])

export function DiscoverySection({ projectName }: { projectName: string }) {
  const [workflow, setWorkflow] = useState<'find' | 'research'>('find')

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Query discovery</p>
          <h2>Discover or research queries</h2>
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

export function FindQueriesSection({
  projectName,
  onReviewDiscoveryProbe,
}: {
  projectName: string
  onReviewDiscoveryProbe?: (discoveryProbeId: string) => void
}) {
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

  const activeSession = detail ?? selectedSession
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
          <p className="eyebrow eyebrow-soft">Step 1</p>
          <h2>Generate and check questions</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
            {isEmbed()
              ? 'Generate customer questions and check whether your site is already visible.'
              : 'Generate customer questions, check current visibility, then choose what to track.'}
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
                <span className="text-sm text-secondary">Who is your ideal customer?</span>
                <textarea
                  className="mt-1 min-h-24 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="e.g. Small e-commerce stores that want AI-powered customer support. Leave blank to use the customer profile saved on this project."
                  value={icpDescription}
                  onChange={(event) => setIcpDescription(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-sm text-secondary">How many questions to test</span>
                <input
                  className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  inputMode="numeric"
                  value={maxProbes}
                  onChange={(event) => setMaxProbes(event.target.value)}
                />
                <span className="mt-1 block text-sm text-secondary">
                  More questions means broader coverage but a longer run. 100 is a good default.
                </span>
              </label>
              {!isEmbed() && (
                <WriteButton
                  type="button"
                  size="sm"
                  disabled={startMutation.isPending}
                  onClick={() => startMutation.mutate()}
                >
                  <Play size={14} />
                  {startMutation.isPending ? 'Starting…' : 'Find queries'}
                </WriteButton>
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
              <p className="text-sm text-secondary">No discovery runs yet. Describe your customer above to start your first one.</p>
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
                    <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-secondary">
                      <span>Cited queries {session.citedCount ?? 0}</span>
                      <span>Worth tracking {session.aspirationalCount ?? 0}</span>
                      <span>Skip {session.wastedCount ?? 0}</span>
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
              <p className="text-sm text-secondary">Start a run above, or pick one from Recent runs to see its progress.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <DiscoveryMetric label="Questions tested" value={activeSession.probeCount ?? 0} />
                  <DiscoveryMetric label="Cited queries" value={activeSession.citedCount ?? 0} tone="positive" />
                  <DiscoveryMetric label="Worth tracking" value={activeSession.aspirationalCount ?? 0} tone="caution" />
                  <DiscoveryMetric label="Skip" value={activeSession.wastedCount ?? 0} tone="negative" />
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
                    <p className="mb-2 text-sm font-medium text-secondary">Sites that keep getting cited</p>
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
              <div className="section-head">
                <div>
                  <p className="eyebrow eyebrow-soft">Step 2</p>
                  <h3>Review a discovery question for tracking</h3>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
                    Choose a Cited query or Worth tracking result below. Tracking opens with the saved discovery source, where you choose its scope and review the exact next-sweep change.
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted">Discovery remains research. This review does not add competitors or start a sweep.</p>
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
                      <th><span className="sr-only">Tracking review</span></th>
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
                        <td className="whitespace-nowrap text-right">
                          {!isEmbed() && onReviewDiscoveryProbe && (probe.bucket === 'cited' || probe.bucket === 'aspirational') && (
                            <WriteButton type="button" variant="ghost" size="sm" onClick={() => onReviewDiscoveryProbe(probe.id)}>
                              Review for tracking
                            </WriteButton>
                          )}
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
  cited: 'Cited queries',
  aspirational: 'Worth tracking',
  'wasted-surface': 'Skip',
}

function bucketLabel(bucket: DiscoveryBucket | null): string {
  return bucket ? BUCKET_LABELS[bucket] : 'Not classified'
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
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
    invalidateProjectQueryDomain(queryClient, 'discovery'),
    queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>

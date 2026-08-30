import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Play, RefreshCw } from 'lucide-react'
import {
  RunKinds,
  RunStatuses,
  type DiscoveryBucket,
  type DiscoverySessionDto,
  type MeasurementQueryStatus,
  type RunDto,
} from '@ainyc/canonry-contracts'

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
  getApiV1ProjectsByNameMeasurementQueryStatusesOptions,
  getApiV1ProjectsByNameQueriesOptions,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameRunsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1RunsQueryKey,
  deleteApiV1ProjectsByNameQueriesMutation,
  postApiV1ProjectsByNameQueriesMutation,
} from '@ainyc/canonry-api-client/react-query'
import { addToast } from '../../lib/toast-store.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { RUNS_STALE_MS } from '../../queries/query-client.js'
import { Button } from '../ui/button.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { ResearchQueriesSection } from './ResearchQueriesSection.js'
import { useAccount } from '../../contexts/account-context.js'
import { assertCanWrite } from '../../lib/write-guard.js'

type QueryWorkspace = 'tracked' | 'discover' | 'test'

const measurementStatusPresentation: Record<MeasurementQueryStatus, { label: string; tone: 'neutral' | 'caution' | 'positive' }> = {
  not_in_plan: { label: 'Not in plan', tone: 'neutral' },
  awaiting_first_sweep: { label: 'Awaiting first sweep', tone: 'caution' },
  partial: { label: 'Partial', tone: 'caution' },
  measured: { label: 'Measured', tone: 'positive' },
}

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])
const ACTIVE_VISIBILITY_RUN_STATUSES = new Set<RunDto['status']>([RunStatuses.queued, RunStatuses.running])

function latestOfficialFullSweepId(runs: readonly RunDto[] | undefined): string | null {
  const latest = runs?.reduce<RunDto | null>((current, run) => {
    if (
      run.kind !== RunKinds['answer-visibility']
      || (run.status !== RunStatuses.completed && run.status !== RunStatuses.partial)
      || run.trigger === 'probe'
      || run.measurementScope != null
    ) return current
    if (!current || run.createdAt > current.createdAt || (run.createdAt === current.createdAt && run.id > current.id)) return run
    return current
  }, null)
  return latest?.id ?? null
}

export function DiscoverySection({
  projectName,
  workspace = 'discover',
}: {
  projectName: string
  workspace?: QueryWorkspace
}) {
  const tabs: ReadonlyArray<{ id: QueryWorkspace; label: string }> = [
    { id: 'tracked', label: 'Tracked' },
    { id: 'discover', label: 'Discover' },
    { id: 'test', label: 'Test' },
  ]

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Project workspace</p>
          <h2>Queries</h2>
        </div>
      </div>
      <nav className="mt-4 flex gap-5 border-b border-default" aria-label="Queries workspace">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to="/projects/$projectName/discovery"
            params={{ projectName }}
            search={(previous: Record<string, unknown>) => ({
              ...previous,
              queries: tab.id === 'discover' ? undefined : tab.id,
            })}
            aria-current={workspace === tab.id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-0.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500/60 ${workspace === tab.id ? 'border-mono-200 text-heading' : 'border-transparent text-secondary hover:border-mono-600 hover:text-heading'}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <div className="mt-4">
        {workspace === 'tracked' ? <TrackedQueriesSection projectName={projectName} /> : null}
        {workspace === 'discover' ? <FindQueriesSection projectName={projectName} /> : null}
        {workspace === 'test' ? <ResearchQueriesSection projectName={projectName} /> : null}
      </div>
    </section>
  )
}

function TrackedQueriesSection({ projectName }: { projectName: string }) {
  const account = useAccount()
  const queryClient = useQueryClient()
  const [newQueryText, setNewQueryText] = useState('')
  const [removingQuery, setRemovingQuery] = useState<string | null>(null)
  const trackedQueriesQuery = useQuery({
    ...getApiV1ProjectsByNameQueriesOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const measurementStatusesQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementQueryStatusesOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  // The project-scoped run list already has the lightest useful external-state
  // signal: it polls quickly only while a sweep is active and otherwise at its
  // normal idle cadence. Keep it active for every non-empty basket, including
  // one whose current badges are all Measured: a later scheduled full sweep
  // can legitimately make the authoritative status Partial. Statuses themselves
  // are still refetched only when a new official full sweep becomes terminal.
  const hasTrackedQueries = (trackedQueriesQuery.data?.length ?? 0) > 0
  const measurementRunsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { kind: RunKinds['answer-visibility'] },
    }),
    enabled: hasTrackedQueries && !measurementStatusesQuery.isError,
    staleTime: RUNS_STALE_MS,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => query.state.data?.some(run => ACTIVE_VISIBILITY_RUN_STATUSES.has(run.status))
      ? 3_000
      : RUNS_STALE_MS,
  })
  const latestSweepId = useMemo(
    () => latestOfficialFullSweepId(measurementRunsQuery.data),
    [measurementRunsQuery.data],
  )
  const handledSweepId = useRef<string | null>(null)
  const statusSweepId = measurementStatusesQuery.data?.latestOfficialFullRun?.id ?? null
  const refetchMeasurementStatuses = measurementStatusesQuery.refetch

  useEffect(() => {
    if (!latestSweepId) return
    if (statusSweepId === latestSweepId) {
      handledSweepId.current = latestSweepId
      return
    }
    if (handledSweepId.current === latestSweepId) return
    handledSweepId.current = latestSweepId
    void refetchMeasurementStatuses()
  }, [latestSweepId, refetchMeasurementStatuses, statusSweepId])
  const queryKey = getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } })
  const statusesByQueryId = useMemo(
    () => new Map(measurementStatusesQuery.data?.queries.map(status => [status.queryId, status.status])),
    [measurementStatusesQuery.data],
  )
  // Do not let retained TanStack data claim a status after the authoritative
  // status read failed. Likewise, after a basket/plan mutation, show a brief
  // loading state instead of flashing a status from the previous plan.
  const measurementStatusLoading = measurementStatusesQuery.isFetching && !measurementStatusesQuery.isError
  const measurementStatusUnavailable = measurementStatusesQuery.isError

  const invalidateTrackedState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) }),
      invalidateProjectQueryDomain(queryClient, 'measurement'),
      queryClient.invalidateQueries({
        predicate: (query) => Array.isArray(query.queryKey)
          && (query.queryKey[0] === 'projects' || query.queryKey[0] === 'project-dashboard-full')
          && query.queryKey.length > 1,
      }),
    ])
  }

  const addMutation = useMutation({
    ...postApiV1ProjectsByNameQueriesMutation(),
    onMutate: () => assertCanWrite(account),
    onSuccess: async () => {
      setNewQueryText('')
      await invalidateTrackedState()
    },
    onError: (error) => {
      addToast({
        title: 'Could not add queries',
        detail: error instanceof Error ? error.message : 'Try again after checking the query text.',
        tone: 'negative',
        dedupeKey: 'queries:add',
        dedupeMode: 'replace',
      })
    },
  })
  const removeMutation = useMutation({
    ...deleteApiV1ProjectsByNameQueriesMutation(),
    onMutate: () => assertCanWrite(account),
    onSuccess: async () => {
      setRemovingQuery(null)
      await invalidateTrackedState()
    },
    onError: (error) => {
      setRemovingQuery(null)
      addToast({
        title: 'Could not remove query',
        detail: error instanceof Error ? error.message : 'Try again after checking the query.',
        tone: 'negative',
        dedupeKey: 'queries:remove',
        dedupeMode: 'replace',
      })
    },
  })

  const pendingQueries = newQueryText.split('\n').map(item => item.trim()).filter(Boolean)
  const canEdit = account.canWrite && !isEmbed()

  function addQueries() {
    if (!canEdit || pendingQueries.length === 0 || addMutation.isPending) return
    addMutation.mutate({ client: heyClient, path: { name: projectName }, body: { queries: pendingQueries } })
  }

  function removeQuery(query: string) {
    if (!canEdit || removeMutation.isPending) return
    setRemovingQuery(query)
    removeMutation.mutate({ client: heyClient, path: { name: projectName }, body: { queries: [query] } })
  }

  return (
    <div className="space-y-4">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Official measurement</p>
          <h3>Tracked queries</h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">These queries are included in future AI visibility sweeps.</p>
        </div>
        {trackedQueriesQuery.isFetching ? <ToneBadge tone="neutral">Loading</ToneBadge> : null}
      </div>

      {trackedQueriesQuery.isError ? (
        <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">
          <p>Could not load tracked queries.</p>
          <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void trackedQueriesQuery.refetch() }}>Retry</Button>
        </div>
      ) : trackedQueriesQuery.isLoading ? (
        <div role="status" className="space-y-2" aria-live="polite">
          <span className="sr-only">Loading tracked queries</span>
          <div className="h-10 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
          <div className="h-10 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
        </div>
      ) : (trackedQueriesQuery.data?.length ?? 0) === 0 ? (
        <p className="border-y border-default py-4 text-sm text-secondary">No tracked queries yet. Add queries here, or promote a completed Test query.</p>
      ) : (
        <div className="space-y-3">
          {measurementStatusLoading ? (
            <p role="status" aria-live="polite" className="text-sm text-secondary">Loading measurement status</p>
          ) : null}
          {measurementStatusUnavailable ? (
            <div role="alert" className="border-y border-negative-800/40 bg-negative-950/20 py-3 text-sm text-negative">
              <p>Could not load measurement status.</p>
              <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void measurementStatusesQuery.refetch() }}>
                Retry measurement status
              </Button>
            </div>
          ) : null}
          <div className="overflow-x-auto border-y border-default">
            <table className="evidence-table min-w-[720px]">
              <thead><tr><th>Query</th><th>Measurement status</th>{canEdit ? <th className="w-28 text-right">Action</th> : null}</tr></thead>
            <tbody>
              {trackedQueriesQuery.data?.map((item) => (
                <tr key={item.id}>
                  <td className="text-sm text-strong">{item.query}</td>
                  <td aria-label={measurementStatusLoading ? 'Measurement status: Loading' : undefined}>
                    {measurementStatusLoading ? (
                      <span className="text-sm text-secondary">Loading</span>
                    ) : measurementStatusUnavailable ? (
                      <span className="text-sm text-secondary">Status unavailable</span>
                    ) : (() => {
                      const status = statusesByQueryId.get(item.id)
                      if (!status) return <span className="text-sm text-secondary">Status unavailable</span>
                      const presentation = measurementStatusPresentation[status]
                      return <span aria-label={`Measurement status: ${presentation.label}`}><ToneBadge tone={presentation.tone}>{presentation.label}</ToneBadge></span>
                    })()}
                  </td>
                  {canEdit ? (
                    <td className="text-right">
                      <WriteButton
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label={`${removingQuery === item.query ? 'Removing' : 'Remove'} ${item.query}`}
                        disabled={removeMutation.isPending}
                        onClick={() => removeQuery(item.query)}
                      >
                        {removingQuery === item.query ? 'Removing…' : 'Remove'}
                      </WriteButton>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {canEdit ? (
        <div className="border-t border-default pt-4">
          <label className="block" htmlFor="tracked-query-input">
            <span className="text-sm font-medium text-secondary">Add queries</span>
            <textarea
              id="tracked-query-input"
              className="mt-1 min-h-28 w-full resize-y rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="One query per line"
              value={newQueryText}
              onChange={(event) => setNewQueryText(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-secondary">{pendingQueries.length} {pendingQueries.length === 1 ? 'query' : 'queries'} to add</p>
            <WriteButton type="button" size="sm" disabled={pendingQueries.length === 0 || addMutation.isPending} onClick={addQueries}>
              {addMutation.isPending ? 'Adding…' : 'Add queries'}
            </WriteButton>
          </div>
        </div>
      ) : !isEmbed() ? <p className="text-sm text-secondary">View only. Your account cannot change tracked queries.</p> : null}
    </div>
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
      // Promotion mutates the tracked basket. The server owns measurement
      // membership, so its per-query statuses must be read again as well.
      void invalidateProjectQueryDomain(queryClient, 'measurement')
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
              <div className="section-head section-head-inline">
                <div>
                  <p className="eyebrow eyebrow-soft">Step 2</p>
                  <h3>Choose queries to track</h3>
                </div>
                {!isEmbed() && (
                  <WriteButton
                    type="button"
                    size="sm"
                    disabled={promoteMutation.isPending || safeDefaultCount === 0}
                    onClick={() => promoteMutation.mutate(undefined)}
                  >
                    <CheckCircle2 size={14} />
                    {promoteMutation.isPending ? 'Adding…' : 'Add recommended queries'}
                  </WriteButton>
                )}
              </div>
              {previewQuery.isLoading ? (
                <p className="text-sm text-muted">Loading recommendations…</p>
              ) : preview ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-4">
                    <DiscoveryMetric label="Queries to add" value={safeDefaultCount} tone="positive" />
                    <DiscoveryMetric label="Cited queries" value={preview.queriesByBucket.cited.length} tone="positive" />
                    <DiscoveryMetric label="Worth tracking" value={preview.queriesByBucket.aspirational.length} tone="caution" />
                    <DiscoveryMetric label="Skip" value={preview.queriesByBucket['wasted-surface'].length} tone="negative" />
                  </div>
                  <p className="text-sm leading-6 text-secondary">
                    Adds Cited queries and Worth tracking queries, plus recurring competitor sites. Skip items remain available for review only.
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
    invalidateProjectQueryDomain(queryClient, 'discovery'),
    queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>

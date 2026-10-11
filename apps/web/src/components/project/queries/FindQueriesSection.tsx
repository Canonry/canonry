import { useEffect, useId, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Clock, History, MousePointerClick, Play, RefreshCw } from 'lucide-react'
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
import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { Button } from '../../ui/button.js'
import { Card } from '../../ui/card.js'
import { ResearchQueriesSection } from '../ResearchQueriesSection.js'
import { RESEARCH_TABLE, RESEARCH_TD, RESEARCH_TH } from './research/ResearchResults.js'

const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoverySessionDto['status']>(['queued', 'seeding', 'probing'])

/**
 * The words of Find ideas. Every label is four words or fewer; the sentence
 * behind one is its `Help` or `Detail`, shown in a tooltip. A generated
 * candidate is a question a customer might ask until it is tracked.
 */
export const FIND_COPY = {
  customer: 'Ideal customer',
  customerPlaceholder: 'Saved profile if blank',
  customerHelp: 'Describe who buys from you, such as small online stores that want faster support. Find ideas writes questions your customers might ask and checks whether your site shows up for each. Leave blank to use the customer profile saved on this project.',
  count: 'Questions to test',
  countHelp: 'More questions means broader coverage and a longer run. 100 is a good default.',
  runAction: 'Start run',
  engine: 'Runs on Gemini',
  runsTitle: 'Recent runs',
  runsLoading: 'Loading recent runs',
  noRuns: 'No runs yet',
  loadError: 'Could not load',
  runsError: 'Recent runs did not load.',
  retry: 'Retry',
  noRun: 'No run selected',
  citedSites: 'Cited sites',
  resultsTitle: 'Results',
  resultsHelp: 'Choose a result marked Cited queries or Worth tracking to review it for tracking. Only its text is added, with the Subject you choose. Nothing here adds competitors or starts a sweep.',
  resultsLoading: 'Loading results',
  noResults: 'No results yet',
  resultsError: "This run's results did not load.",
} as const
const SESSION_STATUS_LABEL: Record<DiscoverySessionDto['status'], string> = { queued: 'Queued', seeding: 'Seeding', probing: 'Testing', completed: 'Completed', failed: 'Failed' }
const FIELD_LABEL = 'text-sm font-medium text-heading'
// Buttons here are 44px tall where a finger is the pointer.
const TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'
// The results header stays at the top of the table's frame while its rows scroll.
const RESULT_TH = `${RESEARCH_TH} sticky top-0 z-10 bg-bg`

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
  startControl,
  paused = false,
  onReviewDiscoveryProbe,
}: {
  projectName: string
  /** The page's "Start from" control, drawn at the head of the form when Find ideas is one of its choices. */
  startControl?: ReactNode
  /** Kept out of view behind Write or Pattern: its runs are not polled until it shows again. */
  paused?: boolean
  onReviewDiscoveryProbe?: (discoveryProbeId: string) => void
}) {
  const queryClient = useQueryClient()
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [icpDescription, setIcpDescription] = useState('')
  const [maxProbes, setMaxProbes] = useState('100')
  const resultsHeadingId = useId()

  const sessionsQuery = useQuery({
    ...getApiV1ProjectsByNameDiscoverSessionsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: '10' },
    }),
    refetchInterval: (query) => {
      const sessions = query.state.data
      return !paused && sessions?.some(session => ACTIVE_DISCOVERY_STATUSES.has(session.status)) ? 3000 : false
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
    refetchInterval: !paused && selectedSession && ACTIVE_DISCOVERY_STATUSES.has(selectedSession.status) ? 3000 : false,
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
        title: 'Find ideas started',
        detail: `Run ${shortId(result.sessionId)} · ${SESSION_STATUS_LABEL.probing}`,
        tone: 'neutral',
        dedupeKey: `discovery:start:${result.sessionId}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      // The detail is the server's own message or nothing.
      addToast({
        title: 'Could not start',
        detail: error instanceof Error ? error.message : undefined,
        tone: 'negative',
      })
    },
  })

  const activeSession = detail ?? selectedSession
  const probeRows = detail?.probes ?? []
  // A list that did not load is not an empty one. A refetch that fails keeps the runs already shown.
  const sessionsFailed = sessionsQuery.isError && !sessionsQuery.data
  const canReview = !isEmbed() && Boolean(onReviewDiscoveryProbe)

  async function handleRefreshSessions() {
    try {
      const result = await sessionsQuery.refetch()
      if (result.error) throw result.error
      const count = result.data?.length ?? 0
      addToast({
        title: 'Recent runs refreshed',
        detail: `${count} ${count === 1 ? 'run' : 'runs'}`,
        tone: 'positive',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (error) {
      addToast({
        title: 'Could not refresh',
        detail: error instanceof Error ? error.message : FIND_COPY.runsError,
        tone: 'negative',
        dedupeKey: `discovery:refresh:${projectName}`,
        dedupeMode: 'replace',
      })
    }
  }

  // Help sits beside a heading or label, never inside it, so its sentence stays out of that name.
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="surface-card min-w-0">
            <div className="space-y-4">
              {startControl}
              <div>
                <div className="flex items-center"><label className={FIELD_LABEL} htmlFor="find-ideas-customer">{FIND_COPY.customer}</label><InfoTooltip text={FIND_COPY.customerHelp} placement="bottom" /></div>
                <textarea
                  id="find-ideas-customer"
                  className="mt-1 min-h-24 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder={FIND_COPY.customerPlaceholder}
                  value={icpDescription}
                  onChange={(event) => setIcpDescription(event.target.value)}
                />
              </div>
              <div>
                <div className="flex items-center"><label className={FIELD_LABEL} htmlFor="find-ideas-count">{FIND_COPY.count}</label><InfoTooltip text={FIND_COPY.countHelp} placement="bottom" /></div>
                <input
                  id="find-ideas-count"
                  className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  inputMode="numeric"
                  value={maxProbes}
                  onChange={(event) => setMaxProbes(event.target.value)}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!isEmbed() && (
                  <WriteButton
                    type="button"
                    size="sm"
                    className={TOUCH_TARGET}
                    disabled={startMutation.isPending}
                    onClick={() => startMutation.mutate()}
                  >
                    <Play size={14} />
                    {startMutation.isPending ? 'Starting…' : FIND_COPY.runAction}
                  </WriteButton>
                )}
                <p className="text-sm text-secondary">{FIND_COPY.engine}</p>
              </div>
            </div>
          </Card>

          <Card className="surface-card min-w-0">
            <div className="section-head section-head-inline items-center">
              <h3>{FIND_COPY.runsTitle}</h3>
              {/* A failed list has one action, its Retry. */}
              {!sessionsFailed && <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH_TARGET}
                disabled={sessionsQuery.isFetching}
                onClick={() => void handleRefreshSessions()}
              >
                <RefreshCw className={`size-3.5 ${sessionsQuery.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
                Refresh
              </Button>}
            </div>
            {sessionsFailed ? (
              <div role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={FIND_COPY.loadError} detail={FIND_COPY.runsError} action={<Button type="button" variant="outline" size="sm" className={TOUCH_TARGET} aria-label={`${FIND_COPY.retry} recent runs`} onClick={() => { void sessionsQuery.refetch() }}>{FIND_COPY.retry}</Button>} /></div>
            ) : sessionsQuery.isPending ? (
              <div role="status" aria-label={FIND_COPY.runsLoading} className="space-y-2">{[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="skeleton h-[4.25rem] rounded-md" />)}</div>
            ) : sessions.length === 0 ? (
              <StatusNote icon={History} label={FIND_COPY.noRuns} />
            ) : (
              <div className="space-y-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    aria-pressed={selectedSessionId === session.id}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${
                      selectedSessionId === session.id
                        ? 'border-mono-600 bg-bg-elevated/70'
                        : 'border-default bg-bg/40 hover:border-strong hover:bg-bg-elevated/40'
                    }`}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm font-medium text-heading">{shortId(session.id)}</span>
                      <ToneBadge tone={toneForSession(session.status)}>{SESSION_STATUS_LABEL[session.status]}</ToneBadge>
                    </div>
                    {/* A short label over its number, three to a row. */}
                    <span className="mt-2 grid grid-cols-3 gap-2 text-[13px] text-secondary">
                      {([['Cited queries', session.citedCount], ['Worth tracking', session.aspirationalCount], ['Skip', session.wastedCount]] as const).map(([label, value]) => (
                        <span key={label}><span className="block">{label}</span><span className="block tabular-nums text-heading">{value ?? 0}</span></span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {/* With no runs, or a list that did not load, there is no run to show: Recent runs says so. */}
          {!sessionsFailed && (sessionsQuery.isPending || sessions.length > 0) && <Card className="surface-card min-w-0">
            {activeSession ? <div className="section-head section-head-inline items-center">
              {/* The id is in mono, as the list beside it shows it, with a gap wide enough to read as two words. */}
              <h3>Run <span className="ml-1 font-mono">{shortId(activeSession.id)}</span></h3>
              <ToneBadge tone={toneForSession(activeSession.status)}>{SESSION_STATUS_LABEL[activeSession.status]}</ToneBadge>
            </div> : sessionsQuery.isPending ? <div aria-hidden="true" className="skeleton h-24 rounded-md" /> : <StatusNote icon={MousePointerClick} label={FIND_COPY.noRun} />}

            {activeSession && (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <DiscoveryMetric label="Questions tested" value={activeSession.probeCount ?? 0} />
                  <DiscoveryMetric label="Cited queries" value={activeSession.citedCount ?? 0} tone="positive" />
                  <DiscoveryMetric label="Worth tracking" value={activeSession.aspirationalCount ?? 0} tone="caution" />
                  <DiscoveryMetric label="Skip" value={activeSession.wastedCount ?? 0} tone="negative" />
                </dl>

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
                    <p className="mb-2 text-sm font-medium text-secondary">{FIND_COPY.citedSites}</p>
                    <div className="flex flex-wrap gap-2">
                      {activeSession.competitorMap.slice(0, 8).map(entry => (
                        <span key={entry.domain} className="rounded-md border border-default bg-bg px-2 py-1 text-xs text-neutral">
                          {entry.domain} <span className="tabular-nums text-muted">{entry.hits}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>}

          {/* With no run in view there is nothing to show results for. */}
          {activeSession && <Card className="surface-card min-w-0">
            <div className="section-head section-head-inline items-center">
              <div className="flex items-center">
                <h3 id={resultsHeadingId}>{FIND_COPY.resultsTitle}</h3>
                {/* Every result the server returned is listed, so this is the length of that list. */}
                {probeRows.length > 0 && <span className="ml-2 text-sm tabular-nums text-secondary">{probeRows.length}</span>}
                {canReview && activeSession.status === 'completed' && <InfoTooltip text={FIND_COPY.resultsHelp} placement="bottom" />}
              </div>
              {detailQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
            </div>
            {detailQuery.isError && !detail ? (
              <div role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={FIND_COPY.loadError} detail={FIND_COPY.resultsError} action={<Button type="button" variant="outline" size="sm" className={TOUCH_TARGET} aria-label={`${FIND_COPY.retry} results`} onClick={() => { void detailQuery.refetch() }}>{FIND_COPY.retry}</Button>} /></div>
            ) : detailQuery.isPending ? (
              // A read still in flight is not a run with no results.
              <div role="status" aria-label={FIND_COPY.resultsLoading}>{[0, 1, 2, 3].map(row => <div key={row} aria-hidden="true" className="flex items-center gap-8 border-b border-subtle py-3"><span className="skeleton-text w-2/5" /><span className="skeleton-text ml-auto w-16" /><span className="skeleton-text w-24" /></div>)}</div>
            ) : probeRows.length === 0 ? (
              <StatusNote icon={Clock} label={FIND_COPY.noResults} />
            ) : (
              // The table's own frame scrolls both ways: sideways on a phone, and down a long run under a header that stays. Positioned, so the header's screen-reader text scrolls with the table and never widens the page.
              <div role="group" aria-labelledby={resultsHeadingId} tabIndex={0} className="relative max-h-[36rem] overflow-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">
                <table className={`${RESEARCH_TABLE} min-w-[40rem]`}>
                  <thead>
                    <tr>
                      <th scope="col" className={RESULT_TH}>Question</th>
                      <th scope="col" className={RESULT_TH}>Result</th>
                      <th scope="col" className={RESULT_TH}>{FIND_COPY.citedSites}</th>
                      <th scope="col" className={RESULT_TH}><span className="sr-only">Tracking review</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {probeRows.map(probe => (
                      <tr key={probe.id}>
                        <td className={`${RESEARCH_TD} font-medium text-heading`}>{probe.query}</td>
                        <td className={`${RESEARCH_TD} whitespace-nowrap`}>
                          <ToneBadge tone={toneForBucket(probe.bucket)}>{bucketLabel(probe.bucket)}</ToneBadge>
                        </td>
                        <td className={`${RESEARCH_TD} text-secondary`}>
                          {probe.citedDomains.length > 0 ? probe.citedDomains.slice(0, 3).join(', ') : '-'}
                        </td>
                        <td className={`${RESEARCH_TD} whitespace-nowrap text-right`}>
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
          </Card>}
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
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</dd>
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
  return bucket ? BUCKET_LABELS[bucket] : 'No result'
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
  // hierarchical prefix, so match every discovery op by name pattern:
  // it catches the list, detail, promote-preview, and any future discovery
  // variant. Runs list uses the exact key to avoid invalidating
  // run-detail caches unnecessarily.
  await Promise.all([
    invalidateProjectQueryDomain(queryClient, 'discovery'),
    queryClient.invalidateQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient }) }),
  ])
}

type QueryClientLike = Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>

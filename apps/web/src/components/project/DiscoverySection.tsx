import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Play, RefreshCw } from 'lucide-react'
import {
  RunKinds,
  RunStatuses,
  normalizeQueryText,
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
  invokeWeb,
  type DiscoveryPromoteResult,
} from '../../api.js'
import {
  getApiV1ProjectsByNameDiscoverSessionsByIdOptions,
  getApiV1ProjectsByNameDiscoverSessionsByIdPromoteOptions,
  getApiV1ProjectsByNameDiscoverSessionsOptions,
  getApiV1ProjectsByNameMeasurementQueryStatusesOptions,
  getApiV1ProjectsByNameMeasurementSetupOptions,
  getApiV1ProjectsByNameQueriesOptions,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameRunsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1RunsQueryKey,
  deleteApiV1ProjectsByNameQueriesMutation,
  postApiV1ProjectsByNameQueriesMutation,
} from '@ainyc/canonry-api-client/react-query'
import { postApiV1ProjectsByNameQueriesByIdReplace } from '@ainyc/canonry-api-client'
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
  not_in_plan: { label: 'Not in active plan', tone: 'neutral' },
  awaiting_first_sweep: { label: 'Awaiting first sweep', tone: 'caution' },
  partial: { label: 'Partial', tone: 'caution' },
  measured: { label: 'Measured', tone: 'positive' },
}

const assignedClassPresentation = {
  branded: 'Branded',
  'non-brand': 'Non-brand',
  mixed: 'Mixed',
} as const

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
  const title = workspace === 'tracked'
    ? 'Tracked queries'
    : workspace === 'test'
      ? null
      : 'Queries'
  const tabs: ReadonlyArray<{ id: QueryWorkspace; label: string }> = [
    { id: 'tracked', label: 'Tracked' },
    { id: 'discover', label: 'Discover' },
    { id: 'test', label: 'Test' },
  ]

  return (
    <section className="page-section-divider">
      {title ? <div className="section-head section-head-inline"><h2>{title}</h2></div> : null}
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
  const [isAddingQueries, setIsAddingQueries] = useState(false)
  const [isVerifyingAdd, setIsVerifyingAdd] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removalConfirmation, setRemovalConfirmation] = useState<{ id: string; query: string } | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [editingQuery, setEditingQuery] = useState<{ id: string; query: string } | null>(null)
  const [editedText, setEditedText] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [isSavingQuery, setIsSavingQuery] = useState(false)
  const [editNotice, setEditNotice] = useState<string | null>(null)
  const editInFlight = useRef(false)
  const [querySearch, setQuerySearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MeasurementQueryStatus>('all')
  const [queryClassFilter, setQueryClassFilter] = useState('all')
  const [groupFilter, setGroupFilter] = useState('all')
  const [visibleQueryLimit, setVisibleQueryLimit] = useState(50)
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
  const measurementSetupQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({ client: heyClient, path: { name: projectName } }),
    enabled: account.canWrite && !isEmbed() && measurementStatusesQuery.data?.setupMode === 'simple',
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
  const measurementRowsByQueryId = useMemo(
    () => new Map(measurementStatusesQuery.data?.queries.map(status => [status.queryId, status])),
    [measurementStatusesQuery.data],
  )
  // Do not let retained TanStack data claim a status after the authoritative
  // status read failed. Likewise, after a basket/plan mutation, show a brief
  // loading state instead of flashing a status from the previous plan.
  const measurementStatusLoading = measurementStatusesQuery.isFetching && !measurementStatusesQuery.isError
  const measurementStatusUnavailable = measurementStatusesQuery.isError
  const isAdvancedMeasurementCatalog = !measurementStatusLoading
    && !measurementStatusUnavailable
    && measurementStatusesQuery.data?.setupMode === 'active-v2'
  const trackedQueryRows = useMemo(() => {
    const catalogRows = (trackedQueriesQuery.data ?? []).map((item) => {
      const measurementRow = measurementRowsByQueryId.get(item.id)
      return {
        queryId: item.id,
        query: measurementRow?.currentQueryText ?? item.query,
        measurementRow,
      }
    })
    if (measurementStatusUnavailable) return catalogRows
    const orphans = measurementStatusesQuery.data?.activePlanOrphans ?? []
    return [
      ...catalogRows,
      ...orphans.map(measurementRow => ({
        queryId: measurementRow.queryId,
        query: measurementRow.assignmentScope.activePlanQueryText ?? 'Missing saved query',
        measurementRow,
      })),
    ]
  }, [measurementRowsByQueryId, measurementStatusUnavailable, measurementStatusesQuery.data?.activePlanOrphans, trackedQueriesQuery.data])
  const groupOptions = useMemo(() => {
    const groups = new Map<string, string>()
    for (const item of trackedQueryRows) {
      for (const group of item.measurementRow?.assignmentScope?.groupCoverage ?? []) {
        if (group.assignedMemberCount > 0) groups.set(group.groupKey, group.label)
      }
    }
    return [...groups].sort((left, right) => left[1].localeCompare(right[1]))
  }, [trackedQueryRows])
  const displayedQueries = useMemo(() => {
    const normalizedSearch = querySearch.trim().toLocaleLowerCase()
    const canFilterByStatus = isAdvancedMeasurementCatalog
    return trackedQueryRows.filter((item) => {
      if (normalizedSearch && !item.query.toLocaleLowerCase().includes(normalizedSearch)) return false
      if (isAdvancedMeasurementCatalog) {
        const scope = item.measurementRow?.assignmentScope
        if (queryClassFilter !== 'all' && !scope?.queryClasses.some(queryClass => queryClass === queryClassFilter)) return false
        if (groupFilter !== 'all' && !scope?.groupCoverage.some(group => group.groupKey === groupFilter && group.assignedMemberCount > 0)) return false
      }
      return statusFilter === 'all'
        || !canFilterByStatus
        || item.measurementRow?.status === statusFilter
    })
  }, [groupFilter, isAdvancedMeasurementCatalog, queryClassFilter, querySearch, statusFilter, trackedQueryRows])
  const visibleQueries = displayedQueries.slice(0, visibleQueryLimit)

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
      setAddError(null)
      setIsAddingQueries(false)
      await invalidateTrackedState()
    },
    onError: (error) => {
      setAddError(error instanceof Error ? error.message : 'Try again after checking the query text.')
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
      setRemovalConfirmation(null)
      setRemoveError(null)
      await invalidateTrackedState()
    },
    onError: (error) => {
      setRemoveError(error instanceof Error ? error.message : 'Try again after checking the query.')
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
  const isSimpleSetup = measurementSetupQuery.data?.mode === 'simple' && !measurementSetupQuery.isError
  const hasActiveSweep = measurementRunsQuery.data?.some(run => ACTIVE_VISIBILITY_RUN_STATUSES.has(run.status)) ?? false
  const canEditSimpleQuery = canEdit && isSimpleSetup
    && !measurementRunsQuery.isError && measurementRunsQuery.data !== undefined
    && !hasActiveSweep
  const addQueriesLabel = isAdvancedMeasurementCatalog ? 'Save queries' : 'Add queries'

  function startQueryEdit(query: { id: string; query: string }) {
    if (!canEditSimpleQuery || editInFlight.current) return
    setEditingQuery(query)
    setEditedText(query.query)
    setEditError(null)
    setEditNotice(null)
    setRemovalConfirmation(null)
  }

  async function saveQuery() {
    const text = editedText.trim()
    if (!canEdit || !editingQuery || !text || normalizeQueryText(text) === normalizeQueryText(editingQuery.query) || editInFlight.current) return
    editInFlight.current = true
    setIsSavingQuery(true)
    setEditError(null)
    try {
      assertCanWrite(account)
      const [setup, runs] = await Promise.all([measurementSetupQuery.refetch(), measurementRunsQuery.refetch()])
      if (setup.isError || !setup.data || runs.isError || !runs.data) {
        setEditError('Could not verify setup and sweep status. Retry before saving.')
        return
      }
      if (setup.data.mode !== 'simple') {
        setEditError('Setup changed. Continue editing in measurement setup.')
        return
      }
      if (runs.data.some(run => ACTIVE_VISIBILITY_RUN_STATUSES.has(run.status))) {
        setEditError('Wait for the current sweep to finish before changing this query.')
        return
      }
      await invokeWeb(() => postApiV1ProjectsByNameQueriesByIdReplace({
        client: heyClient,
        path: { name: projectName, id: editingQuery.id },
        body: { query: text, expectedQuery: editingQuery.query },
      }))
      setEditingQuery(null)
      setEditNotice('Query saved.')
      await invalidateTrackedState()
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not save the query. Check the current list before retrying.')
      // A lost response may follow a successful replacement. Refresh before
      // allowing another attempt; never replay a write against a vanished ID.
      const refreshed = await trackedQueriesQuery.refetch()
      if (!refreshed.isError && refreshed.data && !refreshed.data.some(query => query.id === editingQuery.id)) {
        setEditingQuery(null)
        setEditNotice('Could not confirm the save. The query list has been refreshed.')
        await measurementStatusesQuery.refetch()
      }
    } finally {
      editInFlight.current = false
      setIsSavingQuery(false)
    }
  }

  async function addQueries() {
    if (!canEdit || pendingQueries.length === 0 || addMutation.isPending || isVerifyingAdd) return
    setAddError(null)
    setIsVerifyingAdd(true)
    try {
      const refreshed = await measurementStatusesQuery.refetch()
      const hasAuthoritativeAssignmentState = !refreshed.isError
        && refreshed.data !== undefined
        && refreshed.data.queries.every(row => row.assignmentScope !== undefined)
      if (!hasAuthoritativeAssignmentState) {
        setAddError('Could not verify the current assignment state. Retry before changing queries.')
        return
      }
      addMutation.mutate({ client: heyClient, path: { name: projectName }, body: { queries: pendingQueries } })
    } catch {
      setAddError('Could not verify the current assignment state. Retry before changing queries.')
    } finally {
      setIsVerifyingAdd(false)
    }
  }

  function requestRemoval(query: { id: string; query: string }) {
    if (!canEdit || removeMutation.isPending) return
    setRemovalConfirmation(query)
    setRemoveError(null)
  }

  async function confirmRemoval(confirmation: { id: string; query: string }) {
    if (!canEdit || removeMutation.isPending || measurementStatusLoading) return
    setRemoveError(null)
    try {
      // Refresh at confirmation time: a query may have been assigned after the
      // operator opened this disclosure, and the browser must not delete its
      // catalog row from a stale eligibility decision.
      const refreshed = await measurementStatusesQuery.refetch()
      const currentRow = refreshed.data?.queries.find(row => row.queryId === confirmation.id)
      const currentScope = currentRow?.assignmentScope
      const currentQueryText = currentRow?.currentQueryText
      const isStillSafeToRemove = currentRow?.catalogState === 'current'
        && (currentScope?.mode === 'simple' || currentScope?.mode === 'advanced_unassigned')
        && typeof currentQueryText === 'string'

      if (refreshed.isError || !isStillSafeToRemove || typeof currentQueryText !== 'string') {
        setRemoveError('The query assignment changed. Review its current state before removing the catalog query.')
        return
      }

      removeMutation.mutate({ client: heyClient, path: { name: projectName }, body: { queries: [currentQueryText] } })
    } catch {
      setRemoveError('Could not verify the current assignment state. Retry before removing the catalog query.')
    }
  }

  return (
    <div className="space-y-4">
      {editNotice ? <p role="status" className="text-sm text-secondary">{editNotice}</p> : null}
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
      ) : trackedQueryRows.length === 0 && measurementStatusLoading ? (
        <div role="status" className="space-y-2" aria-live="polite">
          <span className="sr-only">Loading tracked query assignments</span>
          <div className="h-10 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
        </div>
      ) : trackedQueryRows.length === 0 ? (
        <p className="border-y border-default py-4 text-sm text-secondary">No tracked queries yet. Add queries here, or promote a completed Test query.</p>
      ) : (
        <div className="space-y-3">
          <div className={isAdvancedMeasurementCatalog ? 'grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_10rem_10rem_13rem] xl:items-end' : 'flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'}>
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-sm font-medium text-secondary">Search queries</span>
              <input
                type="search"
                className="h-10 w-full rounded-md border border-strong bg-transparent px-3 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                placeholder="Search tracked queries"
                value={querySearch}
                disabled={editingQuery !== null}
                onChange={(event) => { setQuerySearch(event.target.value); setVisibleQueryLimit(50) }}
              />
            </label>
            {isAdvancedMeasurementCatalog ? (
              <>
              <label className="min-w-0">
                <span className="mb-1 block text-sm font-medium text-secondary">Group</span>
                <select className="h-10 w-full rounded-md border border-strong bg-transparent px-3 text-sm text-strong focus:border-mono-500 focus:outline-none"
                  value={groupFilter} onChange={event => { setGroupFilter(event.target.value); setVisibleQueryLimit(50) }}>
                  <option value="all">All groups</option>
                  {groupOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block text-sm font-medium text-secondary">Query type</span>
                <select className="h-10 w-full rounded-md border border-strong bg-transparent px-3 text-sm text-strong focus:border-mono-500 focus:outline-none"
                  value={queryClassFilter} onChange={event => { setQueryClassFilter(event.target.value); setVisibleQueryLimit(50) }}>
                  <option value="all">All types</option>
                  <option value="non-brand">Non-brand</option>
                  <option value="branded">Branded</option>
                </select>
              </label>
              <label className="min-w-0">
                <span className="mb-1 block text-sm font-medium text-secondary">Measurement status</span>
                <select
                  className="h-10 w-full rounded-md border border-strong bg-transparent px-3 text-sm text-strong focus:border-mono-500 focus:outline-none"
                  value={statusFilter}
                  onChange={(event) => { setStatusFilter(event.target.value as 'all' | MeasurementQueryStatus); setVisibleQueryLimit(50) }}
                >
                  <option value="all">All statuses</option>
                  {(Object.entries(measurementStatusPresentation) as Array<[MeasurementQueryStatus, typeof measurementStatusPresentation[MeasurementQueryStatus]]>).map(([status, presentation]) => (
                    <option key={status} value={status}>{presentation.label}</option>
                  ))}
                </select>
              </label>
              </>
            ) : null}
          </div>
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
          {canEdit && measurementStatusesQuery.data?.setupMode === 'simple' && (measurementSetupQuery.isError || measurementRunsQuery.isError) ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-secondary">
              <span>Could not verify query editing.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { void Promise.all([measurementSetupQuery.refetch(), measurementRunsQuery.refetch()]) }}>Retry editing status</Button>
            </div>
          ) : canEdit && isSimpleSetup && hasActiveSweep ? (
            <p role="status" className="text-sm text-secondary">Query editing resumes after the current sweep.</p>
          ) : null}
          {displayedQueries.length === 0 ? (
            <p className="border-y border-default py-4 text-sm text-secondary">No tracked queries match these filters.</p>
          ) : (
            <div className="overflow-x-auto border-y border-default">
              <table className="evidence-table min-w-[900px]">
                <thead><tr><th className="w-1/2">Query</th><th>Measurement status</th><th><span title="Active-plan assignments">Properties</span></th>{canEdit ? <th className="w-40 text-right">Action</th> : null}</tr></thead>
                <tbody>
                  {visibleQueries.map((item) => {
                    const measurementRow = item.measurementRow
                    const assignmentScope = measurementRow?.assignmentScope
                    const assignmentMode = assignmentScope?.mode
                    const hasAuthoritativeAssignmentState = !measurementStatusLoading
                      && !measurementStatusUnavailable
                      && assignmentScope !== undefined
                    const isMissingCatalogQuery = measurementRow?.catalogState === 'missing'
                    const canRemoveCatalogQuery = hasAuthoritativeAssignmentState
                      && !isMissingCatalogQuery
                      && (assignmentMode === 'simple' || assignmentMode === 'advanced_unassigned')
                    const requiresAssignmentEdit = hasAuthoritativeAssignmentState
                      && (isMissingCatalogQuery || assignmentMode === 'legacy' || assignmentMode === 'advanced_assigned')
                    const isConfirmingRemoval = removalConfirmation?.id === item.queryId
                    const isEditingQuery = editingQuery?.id === item.queryId
                    const confirmationQuery = isConfirmingRemoval ? removalConfirmation.query : item.query
                    return (
                      <Fragment key={item.queryId}>
                        <tr>
                          <td className="max-w-[520px] text-sm font-medium leading-6 text-heading">
                            {isMissingCatalogQuery ? (
                              <div className="space-y-1">
                                <ToneBadge tone="caution">Missing saved query</ToneBadge>
                                <p>{item.query}</p>
                              </div>
                            ) : <span>{item.query}</span>}
                            {assignmentScope?.queryTextMatchesPlan === false && assignmentScope.activePlanQueryText ? (
                              <p className="mt-1 text-sm font-normal text-secondary">Active plan text: {assignmentScope.activePlanQueryText}</p>
                            ) : null}
                          </td>
                          <td aria-label={measurementStatusLoading ? 'Measurement status: Loading' : undefined}>
                            {measurementStatusLoading ? (
                              <span className="text-sm text-secondary">Loading</span>
                            ) : measurementStatusUnavailable || !measurementRow || assignmentMode === 'legacy' ? (
                              <span className="text-sm text-secondary">Status unavailable</span>
                            ) : assignmentMode === 'simple' || measurementStatusesQuery.data?.setupMode === 'simple' ? (
                              <span aria-label="Measurement status: Tracked"><ToneBadge tone="neutral">Tracked</ToneBadge></span>
                            ) : measurementStatusesQuery.data?.setupMode !== 'active-v2' ? (
                              <span className="text-sm text-secondary">Status unavailable</span>
                            ) : (() => {
                              const presentation = measurementStatusPresentation[measurementRow.status]
                              return <span aria-label={`Measurement status: ${presentation.label}`}><ToneBadge tone={presentation.tone}>{presentation.label}</ToneBadge></span>
                            })()}
                          </td>
                          <td>
                            {!hasAuthoritativeAssignmentState ? (
                              <span className="text-sm text-secondary">Assignment state unavailable</span>
                            ) : assignmentMode === 'simple' ? (
                              <span className="text-sm text-secondary">Simple tracking</span>
                            ) : assignmentMode === 'legacy' ? (
                              <span className="text-sm text-secondary">Legacy setup</span>
                            ) : assignmentMode === 'advanced_unassigned' ? (
                              <span className="text-sm text-secondary">Not assigned to active plan</span>
                            ) : (
                              <div className="space-y-1 text-sm text-secondary">
                                <span>{assignmentScope.assignedTargetCount} {assignmentScope.assignedTargetCount === 1 ? 'Property' : 'Properties'} assigned</span>
                                <span className="block">{assignedClassPresentation[assignmentScope.classState]}</span>
                                {assignmentScope.groupCoverage.length > 0 ? (
                                  <details className="text-sm text-secondary">
                                    <summary className="cursor-pointer text-link outline-none focus-visible:ring-2 focus-visible:ring-mono-400">Group coverage</summary>
                                    <ul className="mt-2 space-y-1">
                                      {assignmentScope.groupCoverage.map(group => (
                                        <li key={group.groupKey}>{group.label}: {group.assignedMemberCount} of {group.memberCount} Properties, {group.coverage === 'complete' ? 'Complete coverage' : 'Partial coverage'}</li>
                                      ))}
                                    </ul>
                                  </details>
                                ) : null}
                              </div>
                            )}
                          </td>
                          {canEdit ? (
                            <td className="text-right">
                              {!hasAuthoritativeAssignmentState ? (
                                null
                              ) : requiresAssignmentEdit ? (
                                <Link
                                  to="/projects/$projectName/portfolio"
                                  params={{ projectName }}
                                  search={(previous: Record<string, unknown>) => ({
                                    ...previous,
                                    measurementStep: 'queries' as const,
                                    measurementQueryId: item.queryId,
                                  })}
                                  className="text-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
                                >
                                  {assignmentMode === 'advanced_assigned' && !isMissingCatalogQuery ? 'Edit query' : 'Edit assignments'}
                                </Link>
                              ) : canRemoveCatalogQuery && !isConfirmingRemoval && !isEditingQuery ? (
                                <div className="flex flex-wrap items-center justify-end gap-1">
                                  {assignmentMode === 'advanced_unassigned' ? (
                                    <Link
                                      to="/projects/$projectName/portfolio"
                                      params={{ projectName }}
                                      search={(previous: Record<string, unknown>) => ({
                                        ...previous,
                                        measurementStep: 'queries' as const,
                                        measurementQueryId: item.queryId,
                                      })}
                                      className="text-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
                                    >Assign Properties</Link>
                                  ) : null}
                                  {assignmentMode === 'simple' && isSimpleSetup && measurementRunsQuery.data !== undefined ? (
                                    <WriteButton
                                      type="button" size="sm" variant="ghost"
                                      aria-label={`Edit ${item.query}`}
                                      disabled={!canEditSimpleQuery || isSavingQuery || editingQuery !== null}
                                      onClick={() => startQueryEdit({ id: item.queryId, query: item.query })}
                                    >Edit</WriteButton>
                                  ) : null}
                                <WriteButton
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`Remove ${item.query}`}
                                  disabled={removeMutation.isPending || isSavingQuery || editingQuery !== null}
                                  onClick={() => requestRemoval({ id: item.queryId, query: item.query })}
                                >
                                  Remove
                                </WriteButton>
                                </div>
                              ) : null}
                            </td>
                          ) : null}
                        </tr>
                        {canEdit && isEditingQuery ? (
                          <tr>
                            <td colSpan={4} className="bg-surface-subtle px-3 py-3">
                              <form onSubmit={event => { event.preventDefault(); void saveQuery() }} className="space-y-3">
                                <label className="block">
                                  <span className="text-sm font-medium text-secondary">Query text</span>
                                  <input
                                    autoFocus
                                    className="mt-1 h-10 w-full rounded-md border border-strong bg-transparent px-3 text-sm text-strong focus:border-mono-500 focus:outline-none"
                                    value={editedText}
                                    disabled={isSavingQuery}
                                    onChange={event => { setEditedText(event.target.value); setEditError(null) }}
                                  />
                                </label>
                                <p className="text-sm text-secondary">Old answers keep the original wording.</p>
                                {editError ? <p role="alert" className="text-sm text-negative">{editError}</p> : null}
                                <div className="flex justify-end gap-2">
                                  <Button type="button" size="sm" variant="outline" disabled={isSavingQuery} onClick={() => { setEditingQuery(null); setEditError(null) }}>Cancel</Button>
                                  <WriteButton type="submit" size="sm" disabled={!canEditSimpleQuery || isSavingQuery || !editedText.trim() || normalizeQueryText(editedText) === normalizeQueryText(editingQuery.query)}>
                                    {isSavingQuery ? 'Saving…' : 'Save query'}
                                  </WriteButton>
                                </div>
                              </form>
                            </td>
                          </tr>
                        ) : null}
                        {canEdit && isConfirmingRemoval ? (
                          <tr>
                            <td colSpan={4} className="bg-surface-subtle px-3 py-3">
                              <div role="group" aria-label={`Confirm removal of ${confirmationQuery}`} className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                  <p className="text-sm font-medium text-heading">
                                    {assignmentMode === 'advanced_unassigned'
                                      ? <>Remove “{confirmationQuery}” from the tracked query catalog?</>
                                      : <>Remove “{confirmationQuery}”?</>}
                                  </p>
                                  <p className="mt-1 text-sm text-secondary">
                                    {assignmentMode === 'advanced_unassigned'
                                      ? 'This query is not assigned to the active plan. Saved results remain available.'
                                      : 'This stops future tracking. Saved results remain available.'}
                                  </p>
                                  {removeError ? <p className="mt-1 text-sm text-negative" role="alert">{removeError}</p> : null}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={removeMutation.isPending || measurementStatusLoading}
                                    aria-label={`Cancel removal of ${confirmationQuery}`}
                                    onClick={() => { setRemovalConfirmation(null); setRemoveError(null) }}
                                  >
                                    Cancel
                                  </Button>
                                  <WriteButton
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    disabled={removeMutation.isPending || measurementStatusLoading}
                                    aria-label={`Confirm removal of ${confirmationQuery}`}
                                    onClick={() => { void confirmRemoval({ id: item.queryId, query: confirmationQuery }) }}
                                  >
                                    {removeMutation.isPending ? 'Removing…' : 'Remove query'}
                                  </WriteButton>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {displayedQueries.length > 50 ? (
            <div className="flex items-center justify-between gap-3 text-sm text-secondary">
              <span aria-live="polite">{visibleQueries.length} of {displayedQueries.length} queries</span>
              {visibleQueries.length < displayedQueries.length ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setVisibleQueryLimit(limit => limit + 50)}>Show more queries</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {canEdit ? (
        <div className="border-t border-default pt-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={isAddingQueries}
            aria-controls="add-tracked-queries"
            disabled={editingQuery !== null}
            onClick={() => { setIsAddingQueries(true); setAddError(null) }}
          >
            {addQueriesLabel}
          </Button>
          {isAddingQueries ? (
            <div id="add-tracked-queries" className="mt-4 border-t border-subtle pt-4">
              <label className="block" htmlFor="tracked-query-input">
                <span className="text-sm font-medium text-secondary">Queries to add</span>
                <textarea
                  id="tracked-query-input"
                  className="mt-1 min-h-28 w-full resize-y rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="One query per line"
                  value={newQueryText}
                  onChange={(event) => setNewQueryText(event.target.value)}
                />
              </label>
              {isAdvancedMeasurementCatalog ? <p className="mt-2 text-sm text-secondary">Save queries, then choose their Properties.</p> : null}
              {isAdvancedMeasurementCatalog ? (
                <Link
                  to="/projects/$projectName/portfolio"
                  params={{ projectName }}
                  search={(previous: Record<string, unknown>) => ({
                    ...previous,
                    measurementStep: 'queries' as const,
                    measurementQueryId: undefined,
                  })}
                  className="mt-2 inline-block text-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
                >
                  Edit assignments
                </Link>
              ) : null}
              {addError ? <p className="mt-2 text-sm text-negative" role="alert">{addError}</p> : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-secondary">{pendingQueries.length} {pendingQueries.length === 1 ? 'query' : 'queries'} to add</p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={addMutation.isPending}
                    aria-label="Close add queries"
                    onClick={() => { setIsAddingQueries(false); setAddError(null) }}
                  >
                    Cancel
                  </Button>
                  <WriteButton type="button" size="sm" disabled={pendingQueries.length === 0 || addMutation.isPending || isVerifyingAdd} onClick={() => { void addQueries() }}>
                    {addMutation.isPending || isVerifyingAdd ? (isAdvancedMeasurementCatalog ? 'Saving…' : 'Adding…') : addQueriesLabel}
                  </WriteButton>
                </div>
              </div>
            </div>
          ) : null}
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

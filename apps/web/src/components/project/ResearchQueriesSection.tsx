import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Play } from 'lucide-react'
import {
  ResearchQueryStatuses,
  ResearchRunStatuses,
  type ResearchPromotionCommitResult,
  type ResearchPromotionPreviewResponse,
  type ResearchRunDetailDto,
  type ResearchRunQueryDto,
  type ResearchRunStatus,
  type LocationContext,
} from '@ainyc/canonry-contracts'

import { heyClient, isEmbed } from '../../api.js'
import {
  getApiV1ProjectsByNameMeasurementPlanOptions,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupOptions,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
  getApiV1ProjectsByNameOptions,
  getApiV1ProjectsByNameQueriesQueryKey,
  getApiV1ProjectsByNameResearchRunsByRunIdOptions,
  getApiV1ProjectsByNameResearchRunsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1SettingsOptions,
  postApiV1ProjectsByNameResearchRunsByRunIdQueriesByQueryIdPromotionMutation,
  postApiV1ProjectsByNameResearchRunsByRunIdQueriesByQueryIdPromotionPreviewMutation,
  postApiV1ProjectsByNameResearchRunsMutation,
} from '@ainyc/canonry-api-client/react-query'
import type { MeasurementPlanResponse, MeasurementSetupResponse } from '@ainyc/canonry-api-client'
import { addToast } from '../../lib/toast-store.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { safeExternalUrl } from '../../lib/safe-url.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { useAccount } from '../../contexts/account-context.js'
import { assertCanWrite } from '../../lib/write-guard.js'

const ACTIVE_RESEARCH_STATUSES = new Set<ResearchRunStatus>([
  ResearchRunStatuses.queued,
  ResearchRunStatuses.running,
])

type ResearchRunPayload = {
  queries: string[]
  provider: string
  model?: string
  location: LocationContext | null
}

type ResearchIdempotency = {
  fingerprint: string
  key: string
}

export function ResearchQueriesSection({ projectName }: { projectName: string }) {
  const account = useAccount()
  const queryClient = useQueryClient()
  const embedded = isEmbed()
  const [queryText, setQueryText] = useState('')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [locationChoice, setLocationChoice] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [researchIdempotency, setResearchIdempotency] = useState<ResearchIdempotency | null>(null)
  const researchSubmitInFlight = useRef(false)

  const projectQuery = useQuery({
    ...getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 60_000,
  })
  const settingsQuery = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    staleTime: 60_000,
  })
  // This section only mounts on Queries → Test. Keep the active setup and v2
  // plan reads here so the rest of the project never pays for audience data.
  const measurementSetupQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !embedded && Boolean(projectName),
    staleTime: 0,
  })
  const activeMeasurementPlanQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPlanOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !embedded && Boolean(projectName),
    staleTime: 0,
  })
  const runsQuery = useQuery({
    ...getApiV1ProjectsByNameResearchRunsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { limit: 20 },
    }),
    refetchInterval: (query) => query.state.data?.runs.some(run => ACTIVE_RESEARCH_STATUSES.has(run.status)) ? 3000 : false,
  })
  const historyError = runsQuery.isError
  const runs = historyError ? [] : runsQuery.data?.runs ?? []

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id)
  }, [runs, selectedRunId])

  const selectedRun = runs.find(run => run.id === selectedRunId) ?? null
  const detailQuery = useQuery({
    ...getApiV1ProjectsByNameResearchRunsByRunIdOptions({
      client: heyClient,
      path: { name: projectName, runId: selectedRunId ?? '' },
    }),
    enabled: !historyError && Boolean(selectedRunId),
    refetchInterval: selectedRun && ACTIVE_RESEARCH_STATUSES.has(selectedRun.status) ? 3000 : false,
  })
  const detailError = detailQuery.isError
  const detail = historyError || detailError ? null : detailQuery.data ?? null

  const submittedQueries = useMemo(() => normalizeResearchQueries(queryText), [queryText])
  const project = projectQuery.data
  const locations = project?.locations ?? []
  const providerOptions = useMemo(() => {
    const catalog = new Map((settingsQuery.data?.providerCatalog ?? []).map(item => [item.name, item]))
    return (settingsQuery.data?.providers ?? [])
      .filter(item => item.configured && catalog.get(item.name)?.mode === 'api')
      .map(item => ({ ...item, catalog: catalog.get(item.name)! }))
  }, [settingsQuery.data])
  const noConfiguredApiProviders = !settingsQuery.isPending && providerOptions.length === 0
  const selectedProvider = providerOptions.find(item => item.name === provider) ?? null

  useEffect(() => {
    if (!settingsQuery.data) return
    if (!selectedProvider) {
      setProvider(providerOptions[0]?.name ?? '')
      setModel('')
    }
  }, [providerOptions, selectedProvider, settingsQuery.data])

  useEffect(() => {
    if (!project) return
    const hasSelectedLocation = locationChoice === '__none__' || locations.some(item => item.label === locationChoice)
    if (hasSelectedLocation) return
    const defaultLocation = project.defaultLocation
    setLocationChoice(defaultLocation && locations.some(item => item.label === defaultLocation) ? defaultLocation : '__none__')
  }, [locationChoice, locations, project])

  const selectedLocation = locationChoice === '__none__'
    ? null
    : locations.find(item => item.label === locationChoice)
  const modelIsConfigurable = selectedProvider?.catalog.modelConfigurable ?? false
  const resolvedModel = (modelIsConfigurable ? model.trim() : '')
    || (selectedProvider ? project?.providerModels[selectedProvider.name] : '')
    || selectedProvider?.catalog.defaultModel
    || null
  const researchPayload = selectedProvider && selectedLocation !== undefined && resolvedModel
    ? {
        queries: submittedQueries,
        provider: selectedProvider.name,
        ...(modelIsConfigurable ? { model: resolvedModel } : {}),
        location: selectedLocation,
      } satisfies ResearchRunPayload
    : null
  const researchPayloadFingerprint = researchPayload ? fingerprintResearchPayload(researchPayload) : null
  const selectedProviderLabel = selectedProvider?.displayName ?? selectedProvider?.catalog.displayName ?? selectedProvider?.name ?? null
  const selectedLocationLabel = selectedLocation === null ? 'No location' : selectedLocation?.label ?? null
  const scopeResolved = Boolean(selectedProvider && resolvedModel && selectedLocationLabel)
  const queryCount = submittedQueries.length
  const callCountLabel = queryCount === 0
    ? 'Enter a query.'
    : queryCount > 50
      ? `${queryCount} queries exceed the 50-query limit.`
      : `${queryCount} ${queryCount === 1 ? 'provider call' : 'provider calls'}`
  const scopeLabel = scopeResolved
    ? `${selectedProviderLabel} · ${resolvedModel} · ${selectedLocationLabel}`
    : 'Choose a provider and location.'
  const canStartResearchBase = account.canWrite
    && !embedded
    && !projectQuery.isPending
    && !projectQuery.isError
    && !settingsQuery.isPending
    && !settingsQuery.isError
    && scopeResolved
    && queryCount > 0
    && queryCount <= 50

  useEffect(() => {
    if (researchIdempotency && researchIdempotency.fingerprint !== researchPayloadFingerprint) setResearchIdempotency(null)
  }, [researchIdempotency, researchPayloadFingerprint])

  const researchMutation = useMutation({
    ...postApiV1ProjectsByNameResearchRunsMutation(),
    onSuccess: async (run) => {
      setResearchIdempotency(null)
      setSelectedRunId(run.id)
      setQueryText('')
      setModel('')
      await refreshResearch(queryClient)
      addToast({
        title: 'Research batch saved',
        detail: `${run.totalQueries} quer${run.totalQueries === 1 ? 'y is' : 'ies are'} in research history. Nothing was added to tracked queries.`,
        tone: 'positive',
        dedupeKey: `research:start:${run.id}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Could not start research',
        detail: error instanceof Error ? error.message : 'Check the provider, model, and location, then try again.',
        tone: 'negative',
      })
    },
    onSettled: () => {
      researchSubmitInFlight.current = false
    },
  })

  const canStartResearch = canStartResearchBase && !researchMutation.isPending
  const resultsLoading = runsQuery.isPending || (runs.length > 0 && (!selectedRunId || detailQuery.isPending))
  const runLabel = researchMutation.isPending
    ? 'Starting…'
    : queryCount === 0
      ? 'Run test'
      : `Run ${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`

  function submitResearch() {
    if (!account.canWrite || embedded || !canStartResearch || researchSubmitInFlight.current || !researchPayload || !researchPayloadFingerprint) return
    researchSubmitInFlight.current = true
    const retry = researchIdempotency?.fingerprint === researchPayloadFingerprint
      ? researchIdempotency
      : { fingerprint: researchPayloadFingerprint, key: createResearchIdempotencyKey() }
    if (retry !== researchIdempotency) setResearchIdempotency(retry)
    researchMutation.mutate({
      client: heyClient,
      path: { name: projectName },
      body: {
        ...researchPayload,
        idempotencyKey: retry.key,
      },
    })
  }

  return (
    <div className="space-y-6">
      <section className="border-b border-default pb-6" aria-labelledby="test-queries-title">
        <h3 id="test-queries-title">Test queries</h3>
        <div className="mt-4 space-y-4">
          <label className="block" htmlFor="research-queries">
            <span className="flex items-baseline justify-between gap-4 text-xs font-medium text-secondary">Queries <span id="research-query-limit" className="font-normal text-muted">Max 50 queries</span></span>
            <textarea
              id="research-queries"
              className="mt-1 min-h-28 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="one query per line"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              aria-label="Queries"
              aria-describedby="research-query-limit research-query-count"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-[minmax(150px,0.7fr)_minmax(180px,0.8fr)_minmax(0,1.5fr)] sm:items-end">
            <label className="block" htmlFor="research-provider">
              <span className="text-xs font-medium text-secondary">Provider</span>
              <select
                id="research-provider"
                className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                value={provider}
                disabled={settingsQuery.isPending || settingsQuery.isError || noConfiguredApiProviders}
                onChange={(event) => { setProvider(event.target.value); setModel('') }}
              >
                <option value="" disabled>{settingsQuery.isPending ? 'Loading providers…' : 'Choose provider'}</option>
                {providerOptions.map(item => <option key={item.name} value={item.name}>{item.displayName ?? item.name}</option>)}
              </select>
            </label>
            <label className="block" htmlFor="research-location">
              <span className="text-xs font-medium text-secondary">Location</span>
              <select
                id="research-location"
                className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                value={locationChoice}
                disabled={projectQuery.isPending || projectQuery.isError}
                onChange={(event) => setLocationChoice(event.target.value)}
              >
                <option value="" disabled>{projectQuery.isPending ? 'Loading locations…' : 'Choose location'}</option>
                <option value="__none__">No location</option>
                {locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-default pt-3 sm:border-t-0 sm:pt-0">
              <div className="min-w-0 text-xs leading-5 text-secondary">
                <p id="research-scope" role="status" className="truncate font-medium text-heading">{scopeLabel}</p>
                <p id="research-query-count" className={queryCount > 50 ? 'text-negative' : undefined}>{callCountLabel}</p>
                <p id="research-test-isolation">Excluded from Pulse and trends</p>
              </div>
              {!embedded && (
                <WriteButton
                  type="button"
                  size="sm"
                  aria-describedby="research-scope research-query-count research-test-isolation"
                  disabled={!canStartResearch}
                  onClick={submitResearch}
                >
                  <Play size={14} />
                  {runLabel}
                </WriteButton>
              )}
            </div>
          </div>

          <details className="border-t border-default pt-3">
            <summary className="cursor-pointer text-sm font-medium text-secondary hover:text-heading focus:outline-none focus:underline">Advanced</summary>
            <label className="mt-3 block" htmlFor="research-model">
              <span className="text-xs font-medium text-secondary">Model override</span>
              <input
                id="research-model"
                list="research-known-models"
                className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                placeholder={resolvedModel ? `Current: ${resolvedModel}` : 'Choose a provider first'}
                value={model}
                disabled={!selectedProvider || !selectedProvider.catalog.modelConfigurable}
                onChange={(event) => setModel(event.target.value)}
              />
              <datalist id="research-known-models">
                {(selectedProvider?.catalog.knownModels ?? []).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
              </datalist>
            </label>
          </details>

          {settingsQuery.isError ? (
            <div role="alert" className="border-y border-negative-800/40 py-3 text-sm text-negative">
              <p>Could not load API providers.</p>
              <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void settingsQuery.refetch() }}>Retry providers</Button>
            </div>
          ) : noConfiguredApiProviders ? (
            <p className="border-y border-caution-800/40 py-3 text-sm text-caution">Configure an API provider in Settings to run tests.</p>
          ) : null}
          {projectQuery.isError ? (
            <div role="alert" className="border-y border-negative-800/40 py-3 text-sm text-negative">
              <p>Could not load project locations.</p>
              <Button className="mt-3" type="button" size="sm" variant="outline" onClick={() => { void projectQuery.refetch() }}>Retry locations</Button>
            </div>
          ) : null}
        </div>
      </section>

      <ResearchRunDetail
        projectName={projectName}
        detail={detail}
        isLoading={resultsLoading}
        error={historyError ? 'Could not load test history.' : detailError ? 'Could not load saved test results.' : null}
        onRetry={() => { void (historyError ? runsQuery.refetch() : detailQuery.refetch()) }}
        retryLabel={historyError ? 'Retry history' : 'Retry results'}
        onUseQuery={setQueryText}
        providerLabels={new Map(providerOptions.map(item => [item.name, item.displayName ?? item.name]))}
        setup={measurementSetupQuery.data}
        activePlan={activeMeasurementPlanQuery.data}
        setupPending={measurementSetupQuery.isPending}
        setupError={measurementSetupQuery.isError}
        onRetrySetup={() => { void measurementSetupQuery.refetch() }}
        planPending={activeMeasurementPlanQuery.isPending}
        planError={activeMeasurementPlanQuery.isError}
        onRetryPlan={() => { void activeMeasurementPlanQuery.refetch() }}
        canPromote={!embedded && account.canWrite}
      />

      {!historyError ? <details className="border-t border-default pt-4">
        <summary className="cursor-pointer text-sm font-medium text-secondary hover:text-heading focus:outline-none focus:underline">Test history ({runs.length})</summary>
        <div className="mt-4">
          {runsQuery.isPending ? (
            <p role="status" className="text-sm text-secondary">Loading test history.</p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-secondary">No test history yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="evidence-table min-w-[680px]">
                <thead><tr><th>Run</th><th>Provider and model</th><th>Location</th><th>Progress</th><th>Status</th></tr></thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className={selectedRunId === run.id ? 'bg-bg-elevated/40' : undefined}>
                      <td><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedRunId(run.id)}>{formatResearchDate(run.createdAt)}</button></td>
                      <td className="text-secondary"><span className="block">{providerOptions.find(item => item.name === run.provider)?.displayName ?? run.provider}</span><span className="font-mono text-[11px] text-muted">{run.requestedModel ?? run.resolvedModel}</span></td>
                      <td className="text-secondary">{run.location?.label ?? 'No location'}</td>
                      <td className="tabular-nums text-secondary">{run.completedQueries + run.failedQueries}/{run.totalQueries}</td>
                      <td><ToneBadge tone={toneForResearchRun(run.status)}>{run.status}</ToneBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </details> : null}
    </div>
  )
}

function ResearchRunDetail({
  projectName,
  detail,
  isLoading,
  error,
  onRetry,
  retryLabel,
  onUseQuery,
  providerLabels,
  setup,
  activePlan,
  setupPending,
  setupError,
  onRetrySetup,
  planPending,
  planError,
  onRetryPlan,
  canPromote,
}: {
  projectName: string
  detail: ResearchRunDetailDto | null
  isLoading: boolean
  error: string | null
  onRetry: () => void
  retryLabel: string
  onUseQuery: (query: string) => void
  providerLabels: ReadonlyMap<string, string>
  setup: MeasurementSetupResponse | undefined
  activePlan: MeasurementPlanResponse | undefined
  setupPending: boolean
  setupError: boolean
  onRetrySetup: () => void
  planPending: boolean
  planError: boolean
  onRetryPlan: () => void
  canPromote: boolean
}) {
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedQueryId(detail?.queries[0]?.id ?? null)
  }, [detail?.id])

  const selected = detail?.queries.find(item => item.id === selectedQueryId) ?? detail?.queries[0] ?? null

  return (
    <section className="border-b border-default pb-6" aria-labelledby="test-results-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="test-results-title">Results</h3>
          {detail ? <p id="test-result-scope" className="mt-1 text-sm text-secondary">{formatResearchScope(detail, providerLabels)}</p> : null}
        </div>
        {detail && <ToneBadge tone={toneForResearchRun(detail.status)}>{detail.status}</ToneBadge>}
      </div>
      {error ? (
        <div role="alert" className="mt-4 border-y border-negative-800/40 py-3 text-sm text-negative">
          <p>{error}</p>
          <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetry}>{retryLabel}</Button>
        </div>
      ) : !detail ? (
        <p role={isLoading ? 'status' : undefined} className="mt-4 text-sm text-secondary">{isLoading ? 'Loading saved test results.' : 'No test results yet.'}</p>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="overflow-x-auto">
            <table className="evidence-table min-w-[680px]">
              <thead><tr><th>Query</th><th>Status</th><th>Brand mentioned</th><th>Site cited</th></tr></thead>
              <tbody>
                {detail.queries.map(item => (
                  <tr key={item.id} className={selected?.id === item.id ? 'bg-bg-elevated/40' : undefined}>
                    <td><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedQueryId(item.id)}>{item.query}</button></td>
                    <td><ToneBadge tone={toneForResearchQuery(item.status)}>{item.status}</ToneBadge></td>
                    <td><ToneBadge tone={item.answerMentioned === true ? 'positive' : item.answerMentioned === false ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.answerMentioned === null ? item.status === ResearchQueryStatuses.failed ? 'Unavailable' : 'Pending' : item.answerMentioned ? 'Mentioned' : 'Not mentioned'}</ToneBadge></td>
                    <td><ToneBadge tone={item.citationState === 'cited' ? 'positive' : item.citationState === 'not-cited' ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.citationState === null ? item.status === ResearchQueryStatuses.failed ? 'Unavailable' : 'Pending' : item.citationState === 'cited' ? 'Cited' : 'Not cited'}</ToneBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ResearchAnswer
            projectName={projectName}
            runId={detail.id}
            query={selected}
            isLoading={isLoading}
            onUseQuery={onUseQuery}
            setup={setup}
            activePlan={activePlan}
            setupPending={setupPending}
            setupError={setupError}
            onRetrySetup={onRetrySetup}
            planPending={planPending}
            planError={planError}
            onRetryPlan={onRetryPlan}
            canPromote={canPromote}
          />
        </div>
      )}
    </section>
  )
}

function ResearchAnswer({
  projectName,
  runId,
  query,
  isLoading,
  onUseQuery,
  setup,
  activePlan,
  setupPending,
  setupError,
  onRetrySetup,
  planPending,
  planError,
  onRetryPlan,
  canPromote,
}: {
  projectName: string
  runId: string
  query: ResearchRunQueryDto | null
  isLoading: boolean
  onUseQuery: (query: string) => void
  setup: MeasurementSetupResponse | undefined
  activePlan: MeasurementPlanResponse | undefined
  setupPending: boolean
  setupError: boolean
  onRetrySetup: () => void
  planPending: boolean
  planError: boolean
  onRetryPlan: () => void
  canPromote: boolean
}) {
  if (!query) return <p className="text-sm text-muted">{isLoading ? 'Loading saved answers…' : 'Select a query to inspect its answer.'}</p>
  return (
    <div className="space-y-4 border-t border-default pt-4 xl:border-t-0 xl:border-l xl:pl-4 xl:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Selected query</p>
          <p className="mt-1 text-sm font-medium leading-6 text-heading">{query.query}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => onUseQuery(query.query)}>Use query</Button>
      </div>
      {query.error ? (
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">{query.error}</div>
      ) : query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Saved test evidence</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-secondary">{query.answerText}</p>
          <p className="mt-2 text-sm leading-6 text-secondary">This saved answer is test evidence. It is not an official measurement.</p>
        </div>
      ) : (
        <p className="text-sm text-muted">{query.status === ResearchQueryStatuses.failed ? 'This query did not return an answer.' : 'The answer will appear here when this query finishes.'}</p>
      )}
      {query.namedCompetitors.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Named in answer</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {query.namedCompetitors.map(name => <span key={name} className="mention-chip mention-chip--competitor">{name}</span>)}
          </div>
        </div>
      )}
      {query.citedCompetitorDomains.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Cited competitor domains</p>
          <p className="mt-1 text-xs leading-5 text-muted">Cited as a source, not merely named in the answer.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {query.citedCompetitorDomains.map(domain => <span key={domain} className="mention-chip mention-chip--competitor">{domain.replace(/^www\./, '')}</span>)}
          </div>
        </div>
      )}
      {query.groundingSources.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Source links</p>
          <ul className="mt-2 space-y-1">
            {query.groundingSources.map((source, index) => {
              const href = safeExternalUrl(source.uri)
              const label = source.title || source.uri
              return <li key={`${source.uri}-${index}`} className="flex min-w-0 items-start gap-1.5 text-sm">
                {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-secondary hover:text-link focus:outline-none focus:underline">{label}</a> : <span className="truncate text-secondary">{label}</span>}
                {href && <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted" aria-hidden="true" />}
              </li>
            })}
          </ul>
        </div>
      )}
      {canPromote && query.status === ResearchQueryStatuses.completed ? (
        <ResearchPromotionPanel
          key={`${runId}:${query.id}`}
          projectName={projectName}
          runId={runId}
          query={query}
          setup={setup}
          activePlan={activePlan}
          setupPending={setupPending}
          setupError={setupError}
          onRetrySetup={onRetrySetup}
          planPending={planPending}
          planError={planError}
          onRetryPlan={onRetryPlan}
        />
      ) : null}
    </div>
  )
}

type PromotionRequest = {
  queryClass?: 'branded' | 'non-brand'
  targetKeys?: string[]
  groupKeys?: string[]
}

function ResearchPromotionPanel({
  projectName,
  runId,
  query,
  setup,
  activePlan,
  setupPending,
  setupError,
  onRetrySetup,
  planPending,
  planError,
  onRetryPlan,
}: {
  projectName: string
  runId: string
  query: ResearchRunQueryDto
  setup: MeasurementSetupResponse | undefined
  activePlan: MeasurementPlanResponse | undefined
  setupPending: boolean
  setupError: boolean
  onRetrySetup: () => void
  planPending: boolean
  planError: boolean
  onRetryPlan: () => void
}) {
  const account = useAccount()
  const queryClient = useQueryClient()
  const [queryClass, setQueryClass] = useState<'non-brand' | 'branded'>('non-brand')
  const [targetKeys, setTargetKeys] = useState<string[]>([])
  const [groupKeys, setGroupKeys] = useState<string[]>([])
  const [targetSearch, setTargetSearch] = useState('')
  const [preview, setPreview] = useState<ResearchPromotionPreviewResponse | null>(null)
  const [success, setSuccess] = useState<ResearchPromotionCommitResult | null>(null)
  const [promotionError, setPromotionError] = useState<string | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)

  const activePlanValue = activePlan?.active?.plan
  const activeV2Plan = activePlanValue?.schemaVersion === 2 ? activePlanValue : null
  const isAdvanced = setup?.mode === 'active-v2'
  const setupResolved = setup !== undefined
  const normalizedTargetSearch = targetSearch.trim().toLocaleLowerCase()
  const targets = activeV2Plan?.targets ?? []
  const requiresTargetSearch = targets.length > 12
  const visibleTargets = normalizedTargetSearch
    ? targets.filter(target => target.label.toLocaleLowerCase().includes(normalizedTargetSearch))
    : requiresTargetSearch
      ? targets.filter((target, index) => index < 12 || targetKeys.includes(target.stableKey))
      : targets
  const request: PromotionRequest = isAdvanced
    ? {
        queryClass,
        ...(targetKeys.length > 0 ? { targetKeys } : {}),
        ...(groupKeys.length > 0 ? { groupKeys } : {}),
      }
    : {}
  const hasAudience = targetKeys.length > 0 || groupKeys.length > 0
  const canPreview = account.canWrite && !isEmbed() && setupResolved && !setupPending && !setupError
    && (!isAdvanced || (Boolean(activeV2Plan) && !planPending && !planError && hasAudience))
  const canConfirmTracking = preview?.mode === 'simple'
    ? preview.trackedQuery.state === 'new'
    : preview?.mode === 'advanced'
      ? preview.assignments.added > 0
      : false

  const previewMutation = useMutation({
    ...postApiV1ProjectsByNameResearchRunsByRunIdQueriesByQueryIdPromotionPreviewMutation(),
    onMutate: () => assertCanWrite(account),
    onSuccess: (result) => {
      setPreview(result)
      setSuccess(null)
      setPromotionError(null)
      setIdempotencyKey(result.mode === 'refused' ? null : createPromotionIdempotencyKey())
    },
    onError: (error) => {
      setPreview(null)
      setPromotionError(error instanceof Error ? error.message : 'Could not preview this tracking change.')
    },
  })
  const commitMutation = useMutation({
    ...postApiV1ProjectsByNameResearchRunsByRunIdQueriesByQueryIdPromotionMutation(),
    onMutate: () => assertCanWrite(account),
    onSuccess: async (result) => {
      setSuccess(result)
      setPromotionError(null)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsByNameQueriesQueryKey({ client: heyClient, path: { name: projectName } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsQueryKey({ client: heyClient }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: projectName } }),
        }),
        queryClient.invalidateQueries({
          queryKey: getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: projectName } }),
        }),
        invalidateProjectQueryDomain(queryClient, 'measurement'),
        invalidateProjectQueryDomain(queryClient, 'researchRuns'),
        queryClient.invalidateQueries({
          predicate: (cached) => Array.isArray(cached.queryKey)
            && (cached.queryKey[0] === 'projects' || cached.queryKey[0] === 'project-dashboard-full')
            && cached.queryKey.length > 1,
        }),
      ])
    },
    onError: (error) => {
      setPromotionError(error instanceof Error ? error.message : 'The tracking change could not be confirmed. Preview it again if the project changed.')
    },
  })

  function resetPreview() {
    setPreview(null)
    setSuccess(null)
    setPromotionError(null)
    setIdempotencyKey(null)
  }

  function toggleSelection(keys: string[], key: string, setKeys: (next: string[]) => void) {
    resetPreview()
    setKeys(keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key])
  }

  function previewAssignment() {
    if (!account.canWrite || isEmbed() || !canPreview || previewMutation.isPending) return
    previewMutation.mutate({
      client: heyClient,
      path: { name: projectName, runId, queryId: query.id },
      body: request,
    })
  }

  function confirmTracking() {
    if (!account.canWrite || isEmbed() || !preview || preview.mode === 'refused' || !canConfirmTracking || commitMutation.isPending) return
    const nextIdempotencyKey = idempotencyKey ?? createPromotionIdempotencyKey()
    if (!idempotencyKey) setIdempotencyKey(nextIdempotencyKey)
    commitMutation.mutate({
      client: heyClient,
      path: { name: projectName, runId, queryId: query.id },
      headers: { 'Idempotency-Key': nextIdempotencyKey },
      body: { previewChecksum: preview.previewChecksum, request },
    })
  }

  return (
    <section className="border-t border-default pt-4" aria-labelledby={`track-test-query-${query.id}`}>
      <h4 id={`track-test-query-${query.id}`} className="text-sm font-semibold text-heading">Track query</h4>

      {!setupResolved || setupPending || setupError ? (
        <div role={setupError ? 'alert' : 'status'} className="mt-3 border-y border-default py-3 text-sm text-secondary">
          {setupError ? (
            <>
              <p>Could not load tracking setup.</p>
              <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetrySetup}>Retry setup</Button>
            </>
          ) : <p>Loading tracking setup.</p>}
        </div>
      ) : isAdvanced ? (
        activeV2Plan ? (
          <div className="mt-3 space-y-3">
            <label className="block" htmlFor={`tracking-class-${query.id}`}>
              <span className="text-sm font-medium text-secondary">Query class</span>
              <select
                id={`tracking-class-${query.id}`}
                className="mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus:border-mono-500 focus:outline-none"
                value={queryClass}
                onChange={(event) => {
                  resetPreview()
                  setQueryClass(event.target.value as 'non-brand' | 'branded')
                }}
              >
                <option value="non-brand">Non-brand</option>
                <option value="branded">Branded</option>
              </select>
            </label>
            {activeV2Plan.groups.length > 0 ? (
              <fieldset className="border-t border-default pt-3">
                <legend className="text-sm font-medium text-secondary">Groups</legend>
                <div className="mt-2 space-y-2">
                  {activeV2Plan.groups.map((group) => (
                    <label key={group.stableKey} className="flex items-start gap-2 text-sm text-secondary">
                      <input
                        type="checkbox"
                        className="mt-1 size-4 accent-current"
                        checked={groupKeys.includes(group.stableKey)}
                        onChange={() => toggleSelection(groupKeys, group.stableKey, setGroupKeys)}
                      />
                      <span>{group.label} <span className="text-muted">({group.targetKeys.length} Properties)</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            <fieldset className="border-t border-default pt-3">
              <legend className="text-sm font-medium text-secondary">Properties</legend>
              {requiresTargetSearch ? (
                <label className="mt-2 block" htmlFor={`tracking-target-search-${query.id}`}>
                  <span className="sr-only">Find Properties</span>
                  <input
                    id={`tracking-target-search-${query.id}`}
                    type="search"
                    className="w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    placeholder="Find Properties"
                    value={targetSearch}
                    onChange={(event) => setTargetSearch(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="mt-2 max-h-44 space-y-2 overflow-y-auto pr-1">
                {visibleTargets.map((target) => (
                  <label key={target.stableKey} className="flex items-start gap-2 text-sm text-secondary">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-current"
                      checked={targetKeys.includes(target.stableKey)}
                      onChange={() => toggleSelection(targetKeys, target.stableKey, setTargetKeys)}
                    />
                    <span>{target.label}</span>
                  </label>
                ))}
                {visibleTargets.length === 0 ? <p className="text-sm text-secondary">No Properties match.</p> : null}
              </div>
              {requiresTargetSearch && !normalizedTargetSearch ? <p className="mt-2 text-xs text-muted">Showing 12 of {targets.length}. Search to narrow.</p> : null}
            </fieldset>
          </div>
        ) : planError ? (
          <div role="alert" className="mt-3 border-y border-default py-3 text-sm text-secondary">
            <p>Could not load the published Portfolio setup.</p>
            <Button className="mt-3" type="button" size="sm" variant="outline" onClick={onRetryPlan}>Retry Portfolio setup</Button>
          </div>
        ) : <p role="status" className="mt-3 text-sm text-secondary">Loading the published Portfolio setup before assignment can be previewed.</p>
      ) : null}

      {promotionError ? <p role="alert" className="mt-3 text-sm leading-6 text-negative">{promotionError}</p> : null}
      {preview?.mode === 'refused' ? (
        <div role="alert" className="mt-3 border-y border-caution-800/40 bg-caution-950/20 py-3 text-sm text-caution">
          <p>{preview.refusal.message}</p>
          {preview.refusal.reason === 'active-v1' || preview.refusal.reason === 'draft-only' || preview.refusal.reason === 'draft-exists' ? (
            <Link
              to="/projects/$projectName/portfolio"
              params={{ projectName }}
              search={(previous: Record<string, unknown>) => preserveRunDrawerSearch(previous)}
              className="mt-2 inline-block font-medium text-link hover:underline focus:outline-none focus:underline"
            >
              Open Portfolio setup
            </Link>
          ) : null}
        </div>
      ) : null}
      {preview?.mode === 'simple' ? (
        <div className="mt-3 border-y border-default py-3 text-sm text-secondary">
          <p>Adds this query to tracked measurement. Saved evidence stays separate.</p>
        </div>
      ) : null}
      {preview?.mode === 'advanced' ? (
        <div className="mt-3 border-y border-default py-3">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-secondary">Query class</dt><dd className="mt-0.5 font-medium text-heading">{preview.selection.queryClass === 'branded' ? 'Branded' : 'Non-brand'}</dd></div>
            <div><dt className="text-secondary">Resolved Properties</dt><dd className="mt-0.5 font-medium text-heading">{preview.audience.targetKeys.length}</dd></div>
            <div><dt className="text-secondary">Assignments</dt><dd className="mt-0.5 font-medium text-heading">{preview.assignments.added} added, {preview.assignments.alreadyPresent} already tracked</dd></div>
            <div><dt className="text-secondary">Provider calls</dt><dd className="mt-0.5 font-medium text-heading">{preview.execution.addedProviderCalls} added, {preview.execution.fullRunProviderCalls} in the full sweep</dd></div>
          </dl>
        </div>
      ) : null}

      {preview && preview.mode !== 'refused' && !canConfirmTracking ? (
        <p className="mt-3 text-sm text-secondary">Already tracked; no change to confirm.</p>
      ) : null}

      {success ? (
        <div role="status" className="mt-3 border-y border-positive-800/40 bg-positive-950/20 py-3 text-sm text-positive">
          <p>Tracked, awaiting first sweep.</p>
          {success.publishedRevision !== null ? <p className="mt-1 text-secondary">Published revision {success.publishedRevision} will be measured by the next AI visibility sweep.</p> : null}
        </div>
      ) : null}
      {!success ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <WriteButton type="button" size="sm" variant="outline" disabled={!canPreview || previewMutation.isPending || commitMutation.isPending} onClick={previewAssignment}>
            {previewMutation.isPending ? 'Previewing…' : 'Preview assignment'}
          </WriteButton>
          {preview && preview.mode !== 'refused' ? (
            <WriteButton type="button" size="sm" disabled={!canConfirmTracking || commitMutation.isPending} onClick={confirmTracking}>
              {commitMutation.isPending ? 'Confirming…' : 'Confirm tracking'}
            </WriteButton>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function createPromotionIdempotencyKey(): string {
  const random = typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `research-promotion-${random}`
}

function createResearchIdempotencyKey(): string {
  const random = typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `research-run-${random}`
}

function fingerprintResearchPayload(payload: ResearchRunPayload): string {
  return JSON.stringify({
    queries: payload.queries,
    provider: payload.provider,
    hasModel: payload.model !== undefined,
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    location: payload.location === null ? null : {
      label: payload.location.label,
      city: payload.location.city,
      region: payload.location.region,
      country: payload.location.country,
      ...(payload.location.timezone !== undefined ? { timezone: payload.location.timezone } : {}),
    },
  })
}

function preserveRunDrawerSearch(previous: Record<string, unknown>) {
  return typeof previous.runId === 'string' ? { runId: previous.runId } : {}
}

function normalizeResearchQueries(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(item => {
      const key = item.toLocaleLowerCase()
      if (!item || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function formatResearchDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

function formatResearchScope(run: ResearchRunDetailDto, providerLabels: ReadonlyMap<string, string>): string {
  const provider = providerLabels.get(run.provider) ?? run.provider
  const model = run.requestedModel ?? run.resolvedModel
  const location = run.location?.label ?? 'No location'
  return `${provider} · ${model} · ${location}`
}

function toneForResearchRun(status: ResearchRunStatus) {
  if (status === ResearchRunStatuses.completed) return 'positive'
  if (status === ResearchRunStatuses.partial) return 'caution'
  if (status === ResearchRunStatuses.failed) return 'negative'
  return 'neutral'
}

function toneForResearchQuery(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.completed) return 'positive'
  if (status === ResearchQueryStatuses.failed) return 'negative'
  return 'neutral'
}

async function refreshResearch(queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>) {
  await invalidateProjectQueryDomain(queryClient, 'researchRuns')
}

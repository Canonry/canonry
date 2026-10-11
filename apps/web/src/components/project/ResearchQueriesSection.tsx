import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Eye, Gauge, History, Info, Key, MapPinOff, Play, Plus, RefreshCw } from 'lucide-react'
import {
  MAX_RESEARCH_BATCH_QUERIES,
  MAX_RESEARCH_BATCH_RUNS,
  ResearchRunStatuses,
  deduplicateResearchQueries,
  expandResearchTemplate,
  hostOf,
  researchTemplateBindings,
  type LocationContext,
  type ResearchRunDetailDto,
  type ResearchRunStatus,
  type ResearchRunScope,
  type ResearchBatchDto,
  type ResearchBatchCreate,
  type ResearchTemplateSelection,
  type VisibilityReportScopeOption,
} from '@ainyc/canonry-contracts'

import { heyClient, isEmbed, isPublicDemo, type ViewerResearchConfig } from '../../api.js'
import {
  getApiV1ProjectsByNameOptions,
  getApiV1ProjectsByNameResearchRunsByRunIdOptions,
  getApiV1ProjectsByNameResearchRunsInfiniteOptions,
  getApiV1SettingsOptions,
  getApiV1ProjectsByNameMeasurementQueryTemplatesQueryKey,
  postApiV1ProjectsByNameResearchBatchesMutation,
  putApiV1ProjectsByNameMeasurementQueryTemplatesByTemplateIdMutation,
} from '@ainyc/canonry-api-client/react-query'
import { addToast } from '../../lib/toast-store.js'
import { extractApiErrorInfo } from '../../lib/extract-error-message.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SegmentedRadioGroup, type SegmentedRadioOption } from '../shared/SegmentedRadioGroup.js'
import { StatusNote } from '../shared/StatusNote.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import { useAccount } from '../../contexts/account-context.js'
import {
  RESEARCH_RESULTS_COPY, RESEARCH_ROW_BUTTON, RESEARCH_STATUS_LABEL, RESEARCH_TABLE, RESEARCH_TD, RESEARCH_TH,
  ResearchRunDetail, formatResearchDate, toneForResearchRun, type ResearchTrackingSource,
} from './queries/research/ResearchResults.js'

export type { ResearchTrackingSource }

const ACTIVE_RESEARCH_STATUSES = new Set<ResearchRunStatus>([
  ResearchRunStatuses.queued,
  ResearchRunStatuses.running,
])

/**
 * Shared so assertions describe the shipped Research interface. Every label is
 * four words or fewer; the sentence behind a label is its `Detail` or `Help`,
 * shown in a tooltip. Wire names keep `property` and `location`: on screen a
 * `property` is a Location and a `location` is a Search location.
 */
export const RESEARCH_COPY = {
  ...RESEARCH_RESULTS_COPY,
  queryPlaceholder: 'One query per line',
  inheritedModel: 'Use AI Visibility model',
  runAction: 'Run',
  startFrom: 'Start from',
  startWrite: 'Write',
  startPattern: 'Pattern',
  startFind: 'Find ideas',
  introHelp: 'Write runs your queries once. Pattern repeats a query for each place you pick. Results are saved apart from tracked queries and AI Visibility numbers.',
  introHelpWithFind: 'Write runs your queries once. Pattern repeats a query for each place you pick. Find ideas tests what your customers might ask. Results are saved apart from tracked queries and AI Visibility numbers.',
  forEach: 'For each',
  noSearchLocations: 'No search locations',
  noSearchLocationsDetail: 'This project has no search location to repeat across. Add one in Settings.',
  subjectHelp: 'The market or location these results are saved under. It does not change the query text.',
  subjectUnavailable: 'Subject unavailable',
  selectedHelp: 'A market or location name changes the query text only. The engine searches from the search location set beside it.',
  queriesHelp: 'The engine receives exactly this text. Blank and repeated lines are skipped.',
  usesSearchLocation: 'Uses search location',
  usesSearchLocationDetail: "{location} is the search location. Use {property} for the location's name.",
  savedPatternsHelp: 'Reusable starting text. Saving a pattern does not run or track queries.',
  noSavedPatterns: 'No saved patterns',
  previewHelp: 'Edit any query or its search location before running.',
  refreshPreview: 'Regenerate',
  planChanged: 'Plan changed',
  planChangedDetail: 'The published plan changed after this preview. Your edits are kept. Regenerate to use the new plan.',
  setupChanged: 'Setup changed',
  setupChangedDetail: 'The setup changed after this preview. Your edits are kept. Regenerate to use the new setup.',
  notConfirmed: 'Not confirmed',
  notConfirmedDetail: 'Your entries are kept. Run again without changes to avoid duplicate work.',
  loadError: 'Could not load',
  retry: 'Retry',
  noEngineKey: 'No engine key',
  noEngineKeyDetail: 'No engine has an API key. Add one in Settings to run research. Browser engines cannot run research.',
  noEngineDetail: 'No research engine is available. Ask your Canonry team to set one up.',
  viewOnly: 'View only',
  viewOnlyDetail: 'You can preview queries and read past research. Running research needs research access.',
  demo: 'Saved results only',
  demoDetail: 'This public demo shows saved research results. Running research is unavailable.',
  historyTitle: 'Past research',
  historyMore: 'Load older runs',
  historyLoading: 'Loading older runs…',
  historyError: 'Past research did not load.',
  historyMoreError: 'Older runs did not load.',
  resultsError: "This run's results did not load.",
  emptyHistory: 'No research yet',
} as const

/** A blocking check or a failure: the label is what shows, the sentence is its tooltip. */
type ResearchNote = { label: string; detail: string; tone?: 'caution' | 'negative' }
const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`
/** The Run button's words: one engine answers each query once, so the count is the queries about to be sent. */
const researchRunLabel = (answers: number) => answers > 0 ? `${RESEARCH_COPY.runAction} ${plural(answers, 'answer', 'answers')}` : RESEARCH_COPY.runAction

export type ResearchTemplateOption = { id: string; version: string; label: string; pattern: string; variables: readonly string[] }
export type ResearchScopeOption = ResearchRunScope & { expectedPlanRevision: number }

/** Where the page starts from. Write and Pattern are this section's two forms; Find ideas is the caller's own page. */
export type ResearchStart = 'write' | 'pattern' | 'find'
/** What a pattern repeats for, as the batch modes name it: a market, a location (`properties`) or a search location (`locations`). */
type ResearchRepeat = 'markets' | 'properties' | 'locations'

/**
 * The page's first control, the same in every start: a writer picks Write,
 * Pattern or Find ideas; an account that cannot write gets the first two.
 * The help is a sibling of the group, outside its name.
 */
export function ResearchStartControl({ value, onChange, findIdeas }: { value: ResearchStart; onChange: (start: ResearchStart) => void; findIdeas: boolean }) {
  const options: SegmentedRadioOption<ResearchStart>[] = [
    { value: 'write', label: RESEARCH_COPY.startWrite },
    { value: 'pattern', label: RESEARCH_COPY.startPattern },
    ...(findIdeas ? [{ value: 'find' as const, label: RESEARCH_COPY.startFind }] : []),
  ]
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <span aria-hidden="true" className="text-sm font-medium text-heading">{RESEARCH_COPY.startFrom}</span>
    <div className="flex items-center">
      <SegmentedRadioGroup className={CHOICE_SIZE} label={RESEARCH_COPY.startFrom} options={options} value={value} onChange={onChange} />
      <InfoTooltip text={findIdeas ? RESEARCH_COPY.introHelpWithFind : RESEARCH_COPY.introHelp} placement="bottom" />
    </div>
  </div>
}

export function ResearchQueriesSection({
  projectName,
  onReviewForTracking,
  scopeOptions,
  planRevision,
  selectedScope,
  scopePending,
  scopeError,
  onRetryScope,
  templates = [],
  viewerResearchConfig = null,
  start: controlledStart,
  onStartChange,
  findIdeas = false,
  paused = false,
}: {
  projectName: string
  /** Write or Pattern, as the caller holds it. Left out, the section keeps it and opens on Write. */
  start?: Exclude<ResearchStart, 'find'>
  /** Told every choice, Find ideas included: that one is the caller's page to show. */
  onStartChange?: (start: ResearchStart) => void
  /** Offers Find ideas beside Write and Pattern. */
  findIdeas?: boolean
  /** Kept out of view behind Find ideas: its runs are not polled until it shows again. */
  paused?: boolean
  onReviewForTracking?: (source: ResearchTrackingSource) => void
  viewerResearchConfig?: ViewerResearchConfig | null
  scopeOptions?: VisibilityReportScopeOption[]
  planRevision?: number | null
  selectedScope?: ResearchScopeOption | null
  scopePending?: boolean
  scopeError?: boolean
  onRetryScope?: () => void
  templates?: readonly ResearchTemplateOption[]
}) {
  const queryClient = useQueryClient()
  const { account, canWrite } = useAccount()
  const isViewerResearch = account?.role === 'viewer' && viewerResearchConfig !== null
  const limitedAccess = !canWrite
  const publicDemo = isPublicDemo()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [uncontrolledStart, setUncontrolledStart] = useState<Exclude<ResearchStart, 'find'>>('write')
  // Kept here, above the form, so a run that clears the form leaves Pattern on the same kind of place.
  const [repeat, setRepeat] = useState<ResearchRepeat | null>(null)
  // Which kinds of place the project has is known once its places have loaded. Until then Pattern offers none, so a list that lands late never moves a form in use.
  const [placesSettled, setPlacesSettled] = useState(!scopePending)
  if (!placesSettled && !scopePending) setPlacesSettled(true)
  const start = controlledStart ?? uncontrolledStart
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [createdRuns, setCreatedRuns] = useState<ResearchRunDetailDto[]>([])
  const retryRequest = useRef<{ fingerprint: string; key: string } | null>(null)
  const submitInFlight = useRef(false)
  const [composerVersion, setComposerVersion] = useState(0)
  const [savedRuns, setSavedRuns] = useState(0)
  const resultsHeading = useRef<HTMLHeadingElement>(null)
  const batchSelect = useRef<HTMLSelectElement>(null)
  const showSavedRun = useRef(false)

  const projectQuery = useQuery({
    ...getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: projectName } }),
    staleTime: 60_000,
  })
  const settingsQuery = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    enabled: !limitedAccess && !publicDemo,
    staleTime: 60_000,
  })
  const historyInput = { client: heyClient, path: { name: projectName }, query: { limit: 20 } }
  const runsQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameResearchRunsInfiniteOptions(historyInput),
    initialData: undefined,
    initialPageParam: historyInput,
    getNextPageParam: lastPage => lastPage.nextCursor
      ? { path: historyInput.path, query: { ...historyInput.query, cursor: lastPage.nextCursor } }
      : undefined,
    refetchInterval: query => !paused && query.state.data?.pages.some(page => page.runs.some(run => ACTIVE_RESEARCH_STATUSES.has(run.status))) ? 3000 : false,
  })
  // An older-page failure must leave loaded history and the selected answer usable.
  // Failed authoritative refreshes still close the Research admission UI.
  const historyError = runsQuery.isError && !runsQuery.isFetchNextPageError
  // Widened to a boolean: `initialData` makes the query's own type say it is never pending.
  const historyPending = runsQuery.isPending as boolean
  const historyPolicy = runsQuery.data?.pages.at(-1)
  const runs = historyError ? [] : [...new Map((runsQuery.data?.pages.flatMap(page => page.runs) ?? []).map(run => [run.id, run])).values()]
  const canRun = historyPolicy?.access?.canRun ?? (canWrite || isViewerResearch)
  const dailyRunLimit = historyPolicy?.access ? historyPolicy.access.dailyRunLimit : (isViewerResearch ? viewerResearchConfig.viewerDailyRunLimit : null)

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
    refetchInterval: !paused && selectedRun && ACTIVE_RESEARCH_STATUSES.has(selectedRun.status) ? 3000 : false,
  })
  const detail = historyError || detailQuery.isError ? null : detailQuery.data ?? null

  /** Brings the Results card under the topbar and moves focus into it: to the select over a batch when asked for and shown, otherwise to the heading. */
  const showResults = (target: 'heading' | 'batch') => {
    const heading = resultsHeading.current
    if (!heading) return false
    if (typeof heading.scrollIntoView === 'function') heading.scrollIntoView({ block: 'start' })
    ;((target === 'batch' && batchSelect.current) || heading).focus({ preventScroll: true })
    return true
  }
  // A saved run clears the form, which drops focus. It goes to the run's results once they are drawn: for a first run, after past research has been read again.
  useEffect(() => {
    if (showSavedRun.current && showResults('batch')) showSavedRun.current = false
  })

  const locations = projectQuery.data?.locations ?? []
  const providerOptions = useMemo(() => {
    if (limitedAccess) return (historyPolicy?.providers ?? []).map(item => ({ ...item, catalog: item }))
    const catalog = new Map((settingsQuery.data?.providerCatalog ?? []).map(item => [item.name, item]))
    return (settingsQuery.data?.providers ?? [])
      .filter(item => item.configured && catalog.get(item.name)?.mode === 'api')
      .map(item => ({ ...item, catalog: { ...catalog.get(item.name)!, defaultModel: item.model || catalog.get(item.name)!.defaultModel } }))
  }, [limitedAccess, historyPolicy?.providers, settingsQuery.data])
  const noConfiguredApiProviders = !(limitedAccess ? runsQuery.isPending : settingsQuery.isPending) && providerOptions.length === 0
  const selectedProvider = providerOptions.find(item => item.name === provider) ?? null

  useEffect(() => {
    if (!provider && projectQuery.data && !projectQuery.isError && !settingsQuery.isError) {
      const preferred = projectQuery.data.providers.find(name => providerOptions.some(item => item.name === name))
      setProvider(preferred ?? providerOptions[0]?.name ?? '')
    }
  }, [provider, providerOptions, projectQuery.data, projectQuery.isError, settingsQuery.isError])

  const configurableModel = selectedProvider?.catalog.modelConfigurable ?? false
  const visibilityModel = limitedAccess
    ? selectedProvider?.catalog.defaultModel
    : (selectedProvider ? projectQuery.data?.providerModels[selectedProvider.name] : '') || selectedProvider?.catalog.defaultModel
  const resolvedModel = (configurableModel ? model.trim() : '') || visibilityModel
  const modelOptions = selectedProvider
    ? [...new Map([
        { id: selectedProvider.catalog.defaultModel, displayName: selectedProvider.catalog.defaultModel },
        ...(model.trim() ? [{ id: model.trim(), displayName: model.trim() }] : []),
        ...selectedProvider.catalog.knownModels,
      ].map(item => [item.id, item])).values()]
    : []
  const researchMutation = useMutation({
    ...postApiV1ProjectsByNameResearchBatchesMutation(),
    onSuccess: async (batch: ResearchBatchDto) => {
      retryRequest.current = null
      showSavedRun.current = true
      setComposerVersion(value => value + 1)
      setCreatedRuns(batch.runs)
      setSavedRuns(batch.runs.length)
      setSelectedRunId(batch.runs[0]?.id ?? null)
      await refreshResearch(queryClient)
      addToast({
        title: 'Research saved',
        detail: `${plural(batch.runs.length, 'run', 'runs')} · ${RESEARCH_COPY.historyTitle}`,
        tone: 'positive',
        dedupeKey: `research:start:${batch.runs.map(run => run.id).join(':')}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      // The generated SDK throws the API's error envelope, not an Error. The detail is the server's own message or nothing.
      const info = extractApiErrorInfo(error)
      addToast({
        title: 'Could not start research',
        detail: error instanceof Error || info.code ? info.message : undefined,
        tone: 'negative',
      })
    },
    onSettled: () => { submitInFlight.current = false },
  })

  // One note for the reads the form needs, so a server that is down shows one Retry here, not two alike.
  const settingsError = !limitedAccess && settingsQuery.isError
  const setupReadError = settingsError || projectQuery.isError
  const setupReads = settingsError && projectQuery.isError ? 'engines and search locations' : settingsError ? 'engines' : 'search locations'
  const noEngine = !(limitedAccess ? historyError : settingsQuery.isError) && noConfiguredApiProviders
  // Known only once past research has loaded: a research-only key reads as no access until then.
  const viewOnly = !canRun && !historyError && !runsQuery.isPending

  // The runs the last batch made, with the status past research now reports for each. The select over them stays for the visit, whatever run is in view.
  const batchRuns = createdRuns.map(created => runs.find(run => run.id === created.id) ?? created)
  const batch = batchRuns.length > 1 ? { runs: batchRuns, selectedRunId, onSelect: setSelectedRunId, selectRef: batchSelect } : undefined
  const changeStart = (next: ResearchStart) => {
    if (next !== 'find' && controlledStart === undefined) setUncontrolledStart(next)
    onStartChange?.(next)
  }

  return (
    <div className="space-y-4">
      {/* The words a screen reader hears when a run is saved; the toast and the Results card show it. */}
      <p role="status" className="sr-only">{savedRuns > 0 ? `${plural(savedRuns, 'run', 'runs')} saved` : ''}</p>
      {publicDemo ? (
        <Card className="surface-card min-w-0">
          <StatusNote icon={Info} label={RESEARCH_COPY.demo} detail={RESEARCH_COPY.demoDetail} />
        </Card>
      ) : (
        <ResearchBatchComposer
          key={`${projectName}:${composerVersion}`}
          projectName={projectName}
          start={start}
          onStartChange={changeStart}
          findIdeas={findIdeas}
          repeat={repeat}
          onRepeatChange={setRepeat}
          placesSettled={placesSettled}
          canWrite={canWrite}
          researchAllowed={canRun && !historyError}
          viewOnly={viewOnly}
          limitedAccess={limitedAccess}
          isEmbed={isEmbed()}
          scopeOptions={scopeOptions ?? []}
          planRevision={planRevision ?? selectedScope?.planRevision ?? null}
          initialScope={selectedScope}
          scopePending={scopePending}
          scopeError={scopeError}
          onRetryScope={onRetryScope}
          templates={templates}
          locations={locations}
          defaultLocation={projectQuery.data?.defaultLocation ?? null}
          providerOptions={providerOptions}
          provider={provider}
          onProviderChange={(next) => { setProvider(next); setModel('') }}
          resolvedModel={resolvedModel}
          visibilityModel={visibilityModel}
          configurableModel={configurableModel}
          model={model}
          onModelChange={setModel}
          modelOptions={modelOptions}
          settingsReady={limitedAccess ? !runsQuery.isPending && !historyError : !settingsQuery.isPending && !settingsQuery.isError && !settingsQuery.isFetching}
          projectReady={!projectQuery.isPending && !projectQuery.isError && !projectQuery.isFetching}
          isPending={researchMutation.isPending}
          errorMessage={researchMutation.isError ? 'The request could not be confirmed.' : undefined}
          onSubmit={(body, fingerprint) => {
            if (!canRun || historyError || isEmbed() || submitInFlight.current) return
            if (retryRequest.current?.fingerprint !== fingerprint) retryRequest.current = { fingerprint, key: crypto.randomUUID() }
            submitInFlight.current = true
            // Emptied first, so a second batch of the same size is announced too.
            setSavedRuns(0)
            researchMutation.mutate({ client: heyClient, path: { name: projectName }, body: { ...body, idempotencyKey: retryRequest.current.key } })
          }}
          runNotes={(dailyRunLimit !== null || setupReadError || noEngine) && <>
            {dailyRunLimit !== null && <StatusNote icon={Gauge} label={`${plural(dailyRunLimit, 'run', 'runs')} per day`} detail={`Up to ${plural(dailyRunLimit, 'research run', 'research runs')} per project per day. Each market, location or search location in a batch is one run.`} />}
            {setupReadError && <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={`The ${setupReads} did not load.`} action={<RetryButton name={setupReads} onClick={() => { if (settingsError) void settingsQuery.refetch(); if (projectQuery.isError) void projectQuery.refetch() }} />} /></span>}
            {noEngine && <StatusNote icon={Key} tone="caution" label={RESEARCH_COPY.noEngineKey} detail={limitedAccess ? RESEARCH_COPY.noEngineDetail : RESEARCH_COPY.noEngineKeyDetail} />}
          </>}
        />
      )}

      {/* With no run saved there is nothing to show results for: the Past research row below says so. */}
      {!historyError && (historyPending || runs.length > 0) && <ResearchRunDetail detail={detail} isLoading={detailQuery.isFetching || historyPending} onReviewForTracking={publicDemo ? undefined : onReviewForTracking}
        failedRunId={detailQuery.isError ? selectedRunId : null}
        failure={<StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.resultsError} action={<RetryButton name="results" onClick={() => { void detailQuery.refetch() }} />} />}
        batch={batch}
        headingRef={resultsHeading}
        company={projectQuery.data?.displayName || projectQuery.data?.name || 'the company'}
        domain={hostOf(projectQuery.data?.canonicalDomain) ?? 'its site'}
      />}

      {/* Closed until asked for: the page is the form and the results of the run in view. A failed, loading or empty history says so on the row itself. */}
      <Card className="surface-card min-w-0">
        {historyError ? <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2"><h3>{RESEARCH_COPY.historyTitle}</h3><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.historyError} action={<RetryButton name="past research" onClick={() => { void runsQuery.refetch() }} />} /></div>
          : historyPending ? <div className="flex items-center gap-4"><h3>{RESEARCH_COPY.historyTitle}</h3><span role="status" aria-label="Loading past research"><span aria-hidden="true" className="skeleton-text block w-14" /></span></div>
          : runs.length === 0 ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><h3>{RESEARCH_COPY.historyTitle}</h3><StatusNote icon={History} label={RESEARCH_COPY.emptyHistory} /></div>
          : <details>
            {/* More runs may be saved than are loaded, so the count of a history with an older page ends in a plus. */}
            <summary className={`-m-4 cursor-pointer rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${TOUCH_TARGET}`}>
              <h3 className="inline">{RESEARCH_COPY.historyTitle}</h3>{' '}
              <span className="ml-2 text-sm tabular-nums text-secondary">{runs.length}{runsQuery.hasNextPage ? '+' : ''} {runs.length === 1 && !runsQuery.hasNextPage ? 'run' : 'runs'}</span>
            </summary>
            <div className="mt-6 overflow-x-auto">
              <table className={`${RESEARCH_TABLE} min-w-[760px]`}>
                <thead><tr>{['Run', 'Engine', RESEARCH_COPY.subject, RESEARCH_COPY.searchLocation, 'Progress', 'Status'].map(header => <th key={header} scope="col" className={RESEARCH_TH}>{header}</th>)}</tr></thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className={selectedRunId === run.id ? 'bg-bg-elevated/40' : undefined}>
                      <td className={`${RESEARCH_TD} whitespace-nowrap`}><button type="button" className={RESEARCH_ROW_BUTTON} aria-pressed={selectedRunId === run.id} onClick={() => { setSelectedRunId(run.id); showResults('heading') }}>{formatResearchDate(run.createdAt)}</button></td>
                      <td className={`${RESEARCH_TD} whitespace-nowrap text-secondary`}><span className="block">{providerDisplayName(run.provider)}</span><span className="font-mono text-[11px] text-muted">{run.requestedModel ?? run.resolvedModel}</span></td>
                      <td className={`${RESEARCH_TD} text-secondary`}>{run.scope?.label ?? RESEARCH_COPY.notSet}</td>
                      <td className={`${RESEARCH_TD} text-secondary`}>{run.location?.label ?? RESEARCH_COPY.noSearchLocation}</td>
                      <td className={`${RESEARCH_TD} whitespace-nowrap tabular-nums text-secondary`}>{run.completedQueries + run.failedQueries} of {run.totalQueries}</td>
                      <td className={`${RESEARCH_TD} whitespace-nowrap`}><ToneBadge tone={toneForResearchRun(run.status)}>{RESEARCH_STATUS_LABEL[run.status]}</ToneBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* One button for the next page and its retry, so a failed load keeps focus on it. */}
            {(runsQuery.isFetchNextPageError || runsQuery.hasNextPage) && <div className="mt-3 flex flex-wrap items-center gap-3">
              {runsQuery.isFetchNextPageError && <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.historyMoreError} /></span>}
              {runsQuery.hasNextPage && <Button variant="outline" size="sm" className={TOUCH_TARGET} disabled={runsQuery.isFetching} aria-label={runsQuery.isFetchNextPageError && !runsQuery.isFetchingNextPage ? 'Retry older runs' : undefined} onClick={() => { void runsQuery.fetchNextPage() }}>{runsQuery.isFetchingNextPage ? RESEARCH_COPY.historyLoading : runsQuery.isFetchNextPageError ? RESEARCH_COPY.retry : RESEARCH_COPY.historyMore}</Button>}
            </div>}
          </details>}
      </Card>
    </div>
  )
}

type ResearchMode = 'once' | 'markets' | 'properties' | 'locations'
type PreviewRow = { id: string; query: string; scope: ResearchRunScope | null; location: LocationContext | null; template?: ResearchTemplateSelection }
type ResearchDestination = VisibilityReportScopeOption & { kind: 'market' | 'property' }
type ComposerProps = {
  projectName: string
  start: Exclude<ResearchStart, 'find'>
  onStartChange: (start: ResearchStart) => void
  findIdeas: boolean
  /** The kind of place Pattern repeats for, once chosen. Null takes the first kind the project has. */
  repeat: ResearchRepeat | null
  onRepeatChange: (repeat: ResearchRepeat) => void
  /** False until the project's markets and locations have loaded once: Pattern shows a skeleton in place of a kind it would have to move from. */
  placesSettled: boolean
  canWrite: boolean
  researchAllowed: boolean
  /** The account cannot run research: the footer says so in place of a Run button that could never work. */
  viewOnly: boolean
  /** Limits and failed reads that hold back a run, shown beside Run. */
  runNotes?: ReactNode
  limitedAccess: boolean
  isEmbed: boolean
  scopeOptions: readonly VisibilityReportScopeOption[]
  planRevision: number | null
  initialScope?: ResearchScopeOption | null
  scopePending?: boolean
  scopeError?: boolean
  onRetryScope?: () => void
  templates: readonly ResearchTemplateOption[]
  locations: readonly LocationContext[]
  defaultLocation: string | null
  providerOptions: readonly { name: string; displayName?: string; catalog: { modelConfigurable: boolean; defaultModel: string; knownModels: readonly { id: string; displayName: string }[] } }[]
  provider: string
  onProviderChange: (provider: string) => void
  resolvedModel: string | undefined
  visibilityModel: string | undefined
  configurableModel: boolean
  model: string
  onModelChange: (model: string) => void
  modelOptions: readonly { id: string; displayName: string }[]
  settingsReady: boolean
  projectReady: boolean
  isPending: boolean
  errorMessage?: string
  onSubmit: (body: Omit<ResearchBatchCreate, 'idempotencyKey'>, fingerprint: string) => void
}
// Buttons and links here are 44px tall where a finger is the pointer.
const TOUCH_TARGET = 'pointer-coarse:min-h-11 max-md:min-h-11'
// "Start from" and "For each" read at the size of the form's other labels, and each choice is a 44px target below md too.
const CHOICE_SIZE = '[&_[role=radio]]:text-[13px] max-md:[&_[role=radio]]:min-h-11'
const REPEAT_LABEL: Record<ResearchRepeat, string> = { markets: 'Market', properties: 'Location', locations: RESEARCH_COPY.searchLocation }
const INPUT_CLASS = 'mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
const NO_LOCATION = '__none__'
const OVER_RUNS = `Over ${MAX_RESEARCH_BATCH_RUNS} runs`
const SELECTION_UNAVAILABLE: ResearchNote = { label: 'Selection unavailable', detail: 'A selected market, location or search location is no longer available. Update the selection.' }

function ResearchBatchComposer(props: ComposerProps) {
  const { projectName, locations, provider, resolvedModel, planRevision } = props
  const queryClient = useQueryClient()
  const [queryText, setQueryText] = useState('')
  const [pattern, setPattern] = useState('')
  const [scopeKey, setScopeKey] = useState(props.initialScope ? `${props.initialScope.kind}:${props.initialScope.key}` : 'project')
  const [directLocation, setDirectLocation] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [destinationLocations, setDestinationLocations] = useState<Record<string, string>>({})
  const [selectedTemplate, setSelectedTemplate] = useState<ResearchTemplateOption | null>(null)
  const [localTemplates, setLocalTemplates] = useState<ResearchTemplateOption[]>([])
  const [preview, setPreview] = useState<{ signature: string; planRevision: number | null; rows: PreviewRow[] } | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState<ResearchNote | null>(null)
  const saveReceipt = useRef<{ fingerprint: string; id: string } | null>(null)
  const saveInFlight = useRef(false)
  const patternRef = useRef<HTMLTextAreaElement>(null)
  const initialScopeIdentity = props.initialScope ? `${props.initialScope.kind}:${props.initialScope.key}` : 'project'
  useEffect(() => { setScopeKey(initialScopeIdentity); setSelectedTemplate(null) }, [initialScopeIdentity])

  const allDestinations = props.scopeOptions.filter((option): option is ResearchDestination => option.kind === 'market' || option.kind === 'property')
  // A pattern repeats for the kinds of place the project has. A project with no plan has search locations only.
  const repeats = (['markets', 'properties', 'locations'] as const).filter(kind => kind === 'locations' || allDestinations.some(option => option.kind === (kind === 'markets' ? 'market' : 'property')))
  const repeat = props.repeat && repeats.includes(props.repeat) ? props.repeat : repeats[0]!
  const mode: ResearchMode = props.start === 'write' ? 'once' : repeat
  // Until the places have loaded once, Pattern shows no kind of place and none of the parts of the form that depend on one.
  const placesLoading = mode !== 'once' && !props.placesSettled
  const patternForm = mode !== 'once' && !placesLoading
  // A new mode starts a new selection. The pattern and a preview are kept, so the same button regenerates them.
  const [modeInView, setModeInView] = useState(mode)
  if (modeInView !== mode) { setModeInView(mode); setSelectedKeys([]); setSelectedTemplate(null); setSearch(''); setShowErrors(false) }
  const destinationKind = mode === 'markets' ? 'market' : 'property'
  const destinations = allDestinations.filter(option => option.kind === destinationKind)
  const scopeFor = (option: ResearchDestination): ResearchRunScope => ({ kind: option.kind, key: option.id, label: option.label, planRevision: planRevision ?? props.initialScope?.planRevision ?? 0 })
  const locationFor = (label: string): LocationContext | null | undefined => label === NO_LOCATION ? null : locations.find(location => location.label === label)
  const directLocationLabel = directLocation ?? props.defaultLocation ?? NO_LOCATION
  const directScopeOption = allDestinations.find(option => `${option.kind}:${option.id}` === scopeKey)
  const directScope = directScopeOption ? scopeFor(directScopeOption) : null
  const contexts = mode === 'once'
    ? [{ scope: directScope, location: locationFor(directLocationLabel) }]
    : mode === 'locations'
      ? selectedKeys.map(label => ({ scope: null, location: locationFor(label) }))
      : selectedKeys.map(key => destinations.find(option => `${option.kind}:${option.id}` === key)).map(option => option
        ? { scope: scopeFor(option), location: locationFor(destinationLocations[`${option.kind}:${option.id}`] ?? NO_LOCATION) }
        : null)
  const templates = [...new Map([...localTemplates, ...props.templates].map(template => [template.id, template])).values()]
  const currentTemplate = selectedTemplate ? templates.find(template => template.id === selectedTemplate.id) : null
  const templateStale = selectedTemplate !== null && currentTemplate?.version !== selectedTemplate.version
  const source = mode === 'once' ? queryText : pattern
  const sourceLines = source.split(/\r?\n/).filter(line => line.trim())
  const directQueries = deduplicateResearchQueries(sourceLines)
  const patternVariables = [...new Set([...pattern.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!))]
  const patternSyntaxError = /[{}]/.test(pattern.replace(/\{(?:market|submarket|property|propertyBrand|location)\}/g, ''))
  const placeNoun = mode === 'markets' ? 'market' : mode === 'properties' ? 'location' : 'search location'
  const setupErrors: ResearchNote[] = []
  if (!sourceLines.length) setupErrors.push(mode === 'once' ? { label: 'Write a query', detail: 'Enter at least one query.' } : { label: 'Write a pattern', detail: 'Enter at least one pattern.' })
  if (sourceLines.some(line => line.length > 4000)) setupErrors.push({ label: 'Query too long', detail: 'Keep each query under 4,001 characters.' })
  if (mode !== 'once' && patternSyntaxError) setupErrors.push({ label: 'Name not recognized', detail: 'Use the name button to insert a name. Remove unrecognized or incomplete braces.' })
  if (!contexts.length) setupErrors.push({ label: `Pick a ${placeNoun}`, detail: `Select at least one ${placeNoun}.` })
  if (contexts.some(context => !context || context.location === undefined)) setupErrors.push(SELECTION_UNAVAILABLE)
  const requiresScope = (mode === 'once' && scopeKey !== 'project') || mode === 'markets' || mode === 'properties'
  if (requiresScope && (props.scopePending || props.scopeError || !planRevision)) setupErrors.push({ label: 'Places not loaded', detail: 'Markets and locations are loading or did not load. Research for one of them has to wait.' })
  else if (requiresScope && contexts.some(context => !context?.scope)) setupErrors.push(mode === 'once' ? { label: RESEARCH_COPY.subjectUnavailable, detail: 'The Subject is no longer in the published plan. Pick another, or Not set.' } : SELECTION_UNAVAILABLE)
  const total = (mode === 'once' ? directQueries.length : sourceLines.length) * contexts.length
  if (contexts.length > MAX_RESEARCH_BATCH_RUNS) setupErrors.push({ label: OVER_RUNS, detail: `${contexts.length} ${placeNoun}s selected. One batch takes at most ${MAX_RESEARCH_BATCH_RUNS} runs.` })
  if (total > MAX_RESEARCH_BATCH_QUERIES) setupErrors.push({ label: `Over ${MAX_RESEARCH_BATCH_QUERIES} queries`, detail: `${total} queries selected. One batch takes at most ${MAX_RESEARCH_BATCH_QUERIES}.` })
  if (templateStale) setupErrors.push({ label: 'Pattern changed', detail: 'This saved pattern changed. Pick its current version from Saved patterns.' })
  if (mode !== 'once' && !patternSyntaxError) {
    for (const context of contexts) {
      if (!context || context.location === undefined) continue
      try { expandResearchTemplate(selectedTemplate ?? { pattern, variables: patternVariables }, context.scope, context.location) }
      catch {
        // {location} binds only where a search location is set; any other name that fails belongs to another run mode.
        setupErrors.push((selectedTemplate?.variables ?? patternVariables).includes('location') && !context.location
          ? { label: 'Pick a search location', detail: `{location} is the search location. Set one beside each selected ${placeNoun}, or remove {location}.` }
          : { label: 'Name has no value', detail: `A name in this pattern has no value for a ${placeNoun}. Use the name button to insert one that does.` })
        break
      }
    }
  }
  const signature = JSON.stringify({ mode, source, contexts, provider, resolvedModel, template: selectedTemplate, ...(requiresScope ? { planRevision } : {}) })
  const previewStale = mode !== 'once' && preview !== null && preview.signature !== signature
  const planChanged = previewStale && requiresScope && preview.planRevision !== planRevision
  const rows = mode === 'once'
    ? directQueries.map((query, index): PreviewRow => ({ id: String(index), query, scope: directScope, location: contexts[0]?.location ?? null }))
    : preview?.rows ?? []
  const groups = groupPreviewRows(rows)
  const rowErrors: ResearchNote[] = []
  if (mode !== 'once' && preview) {
    if (rows.some(row => !row.query.trim() || row.query.length > 4000 || /\{(?:market|submarket|property|propertyBrand|location)\}/.test(row.query))) rowErrors.push({ label: 'Incomplete query', detail: 'Every row needs a query of 1 to 4,000 characters with no unfilled names.' })
    if (rows.some(row => row.location && !locations.some(location => JSON.stringify(location) === JSON.stringify(row.location)))) rowErrors.push({ label: 'Search location changed', detail: 'A search location in this preview changed. Regenerate the preview.' })
    if (groups.some(group => deduplicateResearchQueries(group.queries).length !== group.queries.length)) rowErrors.push({ label: 'Duplicate queries', detail: 'Remove repeated queries within one run.' })
    if (groups.length > MAX_RESEARCH_BATCH_RUNS) rowErrors.push({ label: OVER_RUNS, detail: `This preview holds ${groups.length} runs. One batch takes at most ${MAX_RESEARCH_BATCH_RUNS}.` })
  }
  const canRun = props.researchAllowed && !props.isEmbed && !props.isPending && props.settingsReady && props.projectReady && Boolean(provider && resolvedModel) && !setupErrors.length && !rowErrors.length && !previewStale && (mode === 'once' || preview !== null)
  const buildRequest = (): Omit<ResearchBatchCreate, 'idempotencyKey'> => ({ runs: groups.map(group => ({
    queries: group.queries, provider, model: resolvedModel!, location: group.location,
    ...(group.scope ? { scope: { kind: group.scope.kind, key: group.scope.key, expectedPlanRevision: group.scope.planRevision } } : {}),
    ...(group.template ? { template: group.template } : {}),
  })) })
  const createPreview = () => {
    setShowErrors(true)
    if (setupErrors.length) return
    const nextRows = contexts.flatMap((context, contextIndex) => sourceLines.map((line, lineIndex): PreviewRow => ({
      id: `${contextIndex}:${lineIndex}`, scope: context!.scope, location: context!.location!,
      ...(selectedTemplate ? { template: { templateId: selectedTemplate.id, templateVersion: selectedTemplate.version, bindingLocation: context!.location! } } : {}),
      query: expandResearchTemplate({ pattern: line, variables: [...new Set([...line.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!))] }, context!.scope, context!.location).output,
    })))
    setPreview({ signature, planRevision, rows: nextRows })
  }
  const chooseTemplate = (template: ResearchTemplateOption) => {
    setSaveError(null)
    if (mode === 'once') {
      try { setQueryText(expandResearchTemplate(template, directScope, locationFor(directLocationLabel)).output) }
      catch { setSaveError({ label: 'Pick a place first', detail: 'This pattern uses a name the Subject or search location does not have. Pick a matching one first.' }); return }
    } else setPattern(template.pattern)
    setSelectedTemplate(template)
  }
  const insertToken = (token: string) => {
    const editor = patternRef.current
    const start = editor?.selectionStart ?? pattern.length
    const end = editor?.selectionEnd ?? start
    setPattern(`${pattern.slice(0, start)}{${token}}${pattern.slice(end)}`)
    setSelectedTemplate(null)
    requestAnimationFrame(() => { editor?.focus(); editor?.setSelectionRange(start + token.length + 2, start + token.length + 2) })
  }
  const saveMutation = useMutation({
    ...putApiV1ProjectsByNameMeasurementQueryTemplatesByTemplateIdMutation(),
    onSuccess: async saved => {
      const template = { id: saved.id, version: saved.updatedAt, label: saved.name, pattern: saved.pattern, variables: saved.variables }
      setLocalTemplates(current => [...current.filter(item => item.id !== saved.id), template])
      setSelectedTemplate(template)
      setSaveOpen(false); setSaveName(''); setSaveError(null); saveReceipt.current = null
      await queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameMeasurementQueryTemplatesQueryKey({ client: heyClient, path: { name: projectName } }) })
      addToast({ title: 'Pattern saved', detail: 'In Saved patterns', tone: 'positive' })
    },
    onError: () => setSaveError({ label: 'Could not save', detail: 'The pattern was not saved. Your text is kept. Save again to retry.', tone: 'negative' }),
    onSettled: () => { saveInFlight.current = false },
  })
  const savePattern = () => {
    if (!props.canWrite || props.isEmbed || saveInFlight.current) return
    const savedSource = mode === 'once' ? queryText : pattern
    const variables = mode === 'once' ? [] : patternVariables
    if (!saveName.trim() || !savedSource.trim() || savedSource.length > 4000 || (mode !== 'once' && patternSyntaxError)) {
      setSaveError({ label: 'Invalid pattern', detail: 'Enter a name and a pattern of 1 to 4,000 characters with no incomplete braces.' }); return
    }
    const body = { name: saveName.trim(), pattern: savedSource, variables }
    const fingerprint = JSON.stringify(body)
    if (saveReceipt.current?.fingerprint !== fingerprint) saveReceipt.current = { fingerprint, id: crypto.randomUUID() }
    saveInFlight.current = true
    saveMutation.mutate({ client: heyClient, path: { name: projectName, templateId: saveReceipt.current.id }, body })
  }
  const visibleErrors = [...new Map([...(showErrors || source.trim() ? setupErrors : []), ...rowErrors].map(note => [`${note.label}. ${note.detail}`, note])).values()]
  const selectableTemplates = templates.filter(template => {
    const available = mode === 'once' ? researchTemplateBindings(directScope, locationFor(directLocationLabel))
      : researchTemplateBindings(mode === 'markets' ? { kind: 'market', label: 'Market' } : mode === 'properties' ? { kind: 'property', label: 'Location' } : null, { label: 'Search location' })
    return template.variables.every(variable => available[variable] !== undefined)
  })

  const tokenName = mode === 'markets' ? 'market' : mode === 'properties' ? 'property' : 'location'
  // A project with no search location has nothing to list or search: the list's place says so.
  const noSearchLocations = mode === 'locations' && !locations.length && props.projectReady
  const engineLabel = props.providerOptions.find(item => item.name === provider)?.displayName ?? provider

  // Help sits beside a heading or label, never inside it, so its sentence stays out of that name.
  return <Card className="surface-card min-w-0">
    <fieldset aria-label="Research setup" className="min-w-0 space-y-5" disabled={props.isPending || saveMutation.isPending}>
      {/* The card has no heading: its first row says what the form starts from and, for a pattern, what it repeats for. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <ResearchStartControl value={props.start} onChange={props.onStartChange} findIdeas={props.findIdeas} />
        {/* One kind of place is no choice: it reads as plain text. The label is the group's name when there is one, so it is hidden from assistive tech only then. */}
        {mode !== 'once' && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span aria-hidden={patternForm && repeats.length > 1 ? 'true' : undefined} className="text-sm font-medium text-heading">{RESEARCH_COPY.forEach}</span>
          {placesLoading ? <span aria-hidden="true" className="skeleton-text block w-40" />
            : repeats.length > 1 ? <SegmentedRadioGroup className={CHOICE_SIZE} label={RESEARCH_COPY.forEach} options={repeats.map(kind => ({ value: kind, label: REPEAT_LABEL[kind] }))} value={repeat} onChange={props.onRepeatChange} />
            : <span className="text-sm text-secondary">{REPEAT_LABEL[repeat]}</span>}
        </div>}
      </div>
      {placesLoading && <div role="status" aria-label="Loading places" className="space-y-2">{[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="skeleton h-11 rounded-md" />)}</div>}
      {mode === 'once' && <div className="grid gap-4 sm:grid-cols-2">
        {(allDestinations.length > 0 || scopeKey !== 'project') && <div>
          <div className="flex items-center"><label className="text-sm font-medium text-heading" htmlFor="research-subject">{RESEARCH_COPY.subject}</label><InfoTooltip text={RESEARCH_COPY.subjectHelp} placement="bottom" /></div>
          <select id="research-subject" className={INPUT_CLASS} value={scopeKey} onChange={event => { setScopeKey(event.target.value); setSelectedTemplate(null) }}>
            <option value="project">{RESEARCH_COPY.notSet}</option>
            {scopeKey !== 'project' && !directScopeOption && <option value={scopeKey} disabled>{RESEARCH_COPY.subjectUnavailable}</option>}
            {allDestinations.map(option => <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>{option.label} ({option.kind === 'market' ? 'market' : 'location'})</option>)}
          </select>
        </div>}
        <LocationSelect label={RESEARCH_COPY.searchLocation} value={directLocationLabel} locations={locations} onChange={value => { setDirectLocation(value); setSelectedTemplate(null) }} />
      </div>}
      {patternForm && <fieldset className="space-y-3" aria-labelledby="research-places-label">
        <div className="flex items-center"><span id="research-places-label" className="text-sm font-medium text-heading">{mode === 'markets' ? 'Markets' : mode === 'properties' ? 'Locations' : 'Search locations'}</span><InfoTooltip text={`Select each ${placeNoun} yourself. Each one gets its own saved run.`} placement="bottom" /></div>
        {!noSearchLocations && <input type="search" aria-label="Search" className={INPUT_CLASS} placeholder="Search" value={search} onChange={event => setSearch(event.target.value)} />}
        {/* Column headers on the rows' own grid. Each select carries its own name, and below sm, where it stacks under its row, its own label. */}
        {mode !== 'locations' && <div aria-hidden="true" className="hidden gap-2 pr-1 text-[13px] text-secondary sm:grid sm:grid-cols-[minmax(0,1fr)_16rem]"><span>{mode === 'markets' ? 'Market' : 'Location'}</span><span>{RESEARCH_COPY.searchLocation}</span></div>}
        {noSearchLocations && <div><StatusNote icon={MapPinOff} label={RESEARCH_COPY.noSearchLocations} detail={RESEARCH_COPY.noSearchLocationsDetail} /></div>}
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {(mode === 'locations' ? locations.map(location => ({ key: location.label, label: location.label })) : destinations.map(option => ({ key: `${option.kind}:${option.id}`, label: option.label })))
            .filter(option => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option => {
              const checked = selectedKeys.includes(option.key)
              return <div key={option.key} className="grid items-center gap-2 border-b border-default pb-2 sm:grid-cols-[minmax(0,1fr)_16rem]">
                {/* A first tick settles what the pattern repeats for, so places that load later, after a failed read is retried, never move the form to another kind. */}
                <label className="flex min-h-11 items-center gap-3 text-sm text-heading"><input type="checkbox" checked={checked} onChange={() => { props.onRepeatChange(repeat); setSelectedKeys(current => checked ? current.filter(key => key !== option.key) : [...current, option.key]) }} />{option.label}</label>
                {checked && mode !== 'locations' && <LocationSelect inRow label={RESEARCH_COPY.searchLocation} name={`${RESEARCH_COPY.searchLocation} for ${option.label}`} value={destinationLocations[option.key] ?? NO_LOCATION} locations={locations} onChange={value => setDestinationLocations(current => ({ ...current, [option.key]: value }))} />}
              </div>
            })}
        </div>
        <div className="flex items-center"><p className="text-sm tabular-nums text-secondary">{selectedKeys.length} selected</p>{mode !== 'locations' && <InfoTooltip text={RESEARCH_COPY.selectedHelp} placement="bottom" />}</div>
      </fieldset>}
      {props.scopeError && <div><StatusNote icon={AlertTriangle} tone="caution" label={RESEARCH_COPY.loadError} detail="Markets and locations did not load. Research with no Subject and across search locations still works." action={<RetryButton name="markets and locations" onClick={props.onRetryScope} />} /></div>}
      {!placesLoading && <div>
        <div className="flex items-center"><label className="text-sm font-medium text-heading" htmlFor="research-query-editor">{mode === 'once' ? 'Queries' : 'Pattern'}</label><InfoTooltip text={mode === 'once' ? RESEARCH_COPY.queriesHelp : `One pattern per line. Put {${tokenName}} where each name belongs, then preview the queries before running.`} placement="bottom" /></div>
        <textarea id="research-query-editor" ref={patternRef} className={`${INPUT_CLASS} min-h-32`} aria-describedby="research-query-count" value={source} placeholder={mode === 'once' ? RESEARCH_COPY.queryPlaceholder : mode === 'markets' ? 'Best apartments in {market}' : mode === 'properties' ? 'What amenities does {property} offer?' : 'Best apartments in {location}'} onChange={event => {
          if (mode === 'once') setQueryText(event.target.value)
          else { setPattern(event.target.value); setSelectedTemplate(null) }
        }} />
        {mode !== 'once' && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" variant="outline" className={TOUCH_TARGET} onClick={() => insertToken(tokenName)}><Plus size={14} aria-hidden="true" />{mode === 'markets' ? 'Market name' : mode === 'properties' ? 'Location name' : 'Search location name'}</Button>
          {mode === 'properties' && patternVariables.includes('location') && <StatusNote icon={AlertTriangle} tone="caution" label={RESEARCH_COPY.usesSearchLocation} detail={RESEARCH_COPY.usesSearchLocationDetail} />}
        </div>}
        <p id="research-query-count" className="mt-2 text-sm tabular-nums text-secondary">{total} of {MAX_RESEARCH_BATCH_QUERIES} queries{mode === 'once' ? '' : ` · ${plural(contexts.length, 'run', 'runs')}`}</p>
      </div>}
      {patternForm && <details className="border-t border-default pt-3"><summary className="cursor-pointer text-sm font-medium text-heading focus-visible:outline focus-visible:outline-2">Saved patterns <span className="font-normal text-secondary">(optional)</span></summary>
        <div className="mt-3 space-y-3">
          {/* The help is in the panel: a button inside the summary would toggle the disclosure. It leads the row, so it never reads as help for the last pattern. */}
          <div className="flex items-start gap-2">
            <span className={`flex h-9 shrink-0 items-center md:h-8 ${TOUCH_TARGET}`}><InfoTooltip text={RESEARCH_COPY.savedPatternsHelp} placement="bottom" /></span>
            {!selectableTemplates.length ? <span className={`flex h-9 items-center text-sm text-secondary md:h-8 ${TOUCH_TARGET}`}>{RESEARCH_COPY.noSavedPatterns}</span> : <div className="flex min-w-0 flex-wrap gap-2">{selectableTemplates.map(template => <Button size="sm" variant="outline" className={TOUCH_TARGET} key={template.id} onClick={() => chooseTemplate(template)}>{template.label}</Button>)}</div>}
          </div>
          {selectedTemplate && <p className="text-sm text-secondary">Using: {selectedTemplate.label}</p>}
          {props.canWrite && !props.isEmbed && <><Button size="sm" variant="outline" className={TOUCH_TARGET} onClick={() => setSaveOpen(!saveOpen)}>{saveOpen ? 'Cancel save' : 'Save as a pattern'}</Button>
            {saveOpen && <div className="flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 text-sm text-heading">Pattern name<input className={INPUT_CLASS} value={saveName} maxLength={120} onChange={event => setSaveName(event.target.value)} /></label><WriteButton size="sm" className={TOUCH_TARGET} disabled={saveMutation.isPending || !saveName.trim() || !source.trim()} onClick={savePattern}>{saveMutation.isPending ? 'Saving…' : 'Save pattern'}</WriteButton></div>}
          </>}
          {saveError && <InlineNotes notes={[saveError]} />}
        </div>
      </details>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-heading">Engine<select className={INPUT_CLASS} value={provider} onChange={event => props.onProviderChange(event.target.value)}><option value="" disabled>Choose an engine</option>{props.providerOptions.map(item => <option key={item.name} value={item.name}>{item.displayName ?? item.name}</option>)}</select></label>
        <label className="block text-sm font-medium text-heading">Model
          {props.limitedAccess ? <select className={INPUT_CLASS} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)}><option value="">{props.visibilityModel ? `${RESEARCH_COPY.inheritedModel} · ${props.visibilityModel}` : 'Choose an engine'}</option>{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
            : <><input aria-label="Model" className={INPUT_CLASS} list="research-known-models" placeholder={resolvedModel ?? 'Choose an engine'} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)} /><datalist id="research-known-models">{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist></>}
        </label>
      </div>
      {visibleErrors.length > 0 && <InlineNotes notes={visibleErrors} />}
      {patternForm && <div className="space-y-4 border-t border-default pt-4">
        {/* The button comes first and stays mounted, so regenerating a stale preview keeps focus on it. */}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" className={TOUCH_TARGET} disabled={props.isPending || !props.projectReady} onClick={createPreview}><RefreshCw size={14} />{preview ? RESEARCH_COPY.refreshPreview : 'Preview queries'}</Button>
          {previewStale && <span role="alert"><StatusNote icon={AlertTriangle} tone="caution" label={planChanged ? RESEARCH_COPY.planChanged : RESEARCH_COPY.setupChanged} detail={planChanged ? RESEARCH_COPY.planChangedDetail : RESEARCH_COPY.setupChangedDetail} /></span>}
        </div>
        {preview && <><div>
          <div className="flex items-center"><h4 className="font-medium text-heading">Queries to run</h4><InfoTooltip text={RESEARCH_COPY.previewHelp} placement="bottom" /></div>
          <p className="mt-1 text-sm tabular-nums text-secondary">{plural(rows.length, 'query', 'queries')} · {plural(groups.length, 'run', 'runs')}</p>
        </div>
          <ConcretePreview rows={rows} locations={locations} onChange={(id, changes) => setPreview(current => current ? { ...current, rows: current.rows.map(row => row.id === id ? { ...row, ...changes } : row) } : current)} />
        </>}
      </div>}
      {props.errorMessage && <InlineNotes notes={[{ label: RESEARCH_COPY.notConfirmed, detail: `${props.errorMessage} ${RESEARCH_COPY.notConfirmedDetail}`, tone: 'negative' }]} />}
      {/* An account that cannot run research gets no Run button, only the reason. What limits or holds back a run sits beside Run. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-default pt-4">
        {props.viewOnly ? <StatusNote icon={Eye} label={RESEARCH_COPY.viewOnly} detail={RESEARCH_COPY.viewOnlyDetail} /> : <div className="flex flex-wrap items-center gap-3">
          {/* The button carries the count, so the line beside it names only the engine and the model. A stale preview's count is no longer what would run, so it shows none. */}
          {!props.isEmbed && <Button size="sm" className={TOUCH_TARGET} disabled={!canRun} onClick={() => { if (canRun) { const request = buildRequest(); props.onSubmit(request, JSON.stringify({ projectName, ...request })) } }}><Play size={14} />{props.isPending ? 'Starting…' : researchRunLabel(mode === 'once' ? directQueries.length : previewStale ? 0 : rows.length)}</Button>}
          {(engineLabel || resolvedModel) && <p className="text-sm text-secondary">{[engineLabel, resolvedModel].filter(Boolean).join(' · ')}</p>}
        </div>}
        {props.runNotes}
      </div>
    </fieldset>
  </Card>
}

/** `label` is the select's name. `name` replaces it for assistive tech when the visible label is shorter; `inRow` is for a list row under a column header, which shows the label only below sm, where the select stacks under its row. */
function LocationSelect({ label, name, inRow = false, value, locations, onChange }: { label: string; name?: string; inRow?: boolean; value: string; locations: readonly LocationContext[]; onChange: (value: string) => void }) {
  return <label className="block text-sm"><span className={inRow ? 'text-[13px] text-secondary sm:sr-only' : 'font-medium text-heading'}>{label}</span><select className={INPUT_CLASS} aria-label={name} value={value} onChange={event => onChange(event.target.value)}><option value={NO_LOCATION}>{RESEARCH_COPY.noSearchLocation}</option>{locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}</select></label>
}
function ConcretePreview({ rows, locations, onChange }: { rows: readonly PreviewRow[]; locations: readonly LocationContext[]; onChange: (id: string, changes: Partial<Pick<PreviewRow, 'query' | 'location'>>) => void }) {
  return <ol className="divide-y divide-default">{rows.map((row, index) => <li key={row.id} className="grid gap-3 py-4 md:grid-cols-[10rem_minmax(0,1fr)_15rem]">
    <div className="text-sm"><span className="block text-secondary">Query {index + 1}</span><span className="font-medium text-heading">{row.scope?.label ?? row.location?.label ?? RESEARCH_COPY.notSet}</span>{row.scope && <span className="block text-secondary">{row.scope.kind === 'market' ? 'Market' : 'Location'}</span>}</div>
    <label className="block text-sm font-medium text-heading">Query<textarea className={`${INPUT_CLASS} min-h-20`} aria-label={`Query ${index + 1} for ${row.scope?.label ?? row.location?.label ?? RESEARCH_COPY.notSet}`} value={row.query} onChange={event => onChange(row.id, { query: event.target.value })} /></label>
    <LocationSelect label={RESEARCH_COPY.searchLocation} name={`${RESEARCH_COPY.searchLocation} for query ${index + 1}`} value={row.location?.label ?? NO_LOCATION} locations={locations} onChange={value => onChange(row.id, { location: locations.find(location => location.label === value) ?? null })} />
  </li>)}</ol>
}
/** Checks that hold back a preview or a run, and failures: an icon and a short label each, the sentence in its tooltip. */
function InlineNotes({ notes }: { notes: readonly ResearchNote[] }) {
  return <div role="alert"><ul className="flex flex-wrap gap-x-5 gap-y-1">{notes.map(note => <li key={`${note.label}. ${note.detail}`}><StatusNote icon={AlertTriangle} tone={note.tone ?? 'caution'} label={note.label} detail={note.detail} /></li>)}</ul></div>
}
/** "Retry" on screen. Its name says what it reloads, because a server that is down shows several. */
function RetryButton({ name, onClick }: { name: string; onClick?: () => void }) {
  return <Button variant="outline" size="sm" className={TOUCH_TARGET} aria-label={`${RESEARCH_COPY.retry} ${name}`} onClick={onClick}>{RESEARCH_COPY.retry}</Button>
}
function groupPreviewRows(rows: readonly PreviewRow[]) {
  const groups = new Map<string, { scope: ResearchRunScope | null; location: LocationContext | null; queries: string[]; template?: ResearchTemplateSelection }>()
  for (const row of rows) {
    const key = JSON.stringify({ scope: row.scope, location: row.location, template: row.template })
    const group = groups.get(key) ?? { scope: row.scope, location: row.location, queries: [], ...(row.template ? { template: row.template } : {}) }
    group.queries.push(row.query)
    groups.set(key, group)
  }
  return [...groups.values()]
}
async function refreshResearch(queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>) {
  await invalidateProjectQueryDomain(queryClient, 'researchRuns')
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnswerMarkdown } from '../shared/AnswerMarkdown.js'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Ban, Clock, Gauge, History, Info, Key, Play, Plus, RefreshCw } from 'lucide-react'
import {
  MAX_RESEARCH_BATCH_QUERIES,
  MAX_RESEARCH_BATCH_RUNS,
  ResearchQueryStatuses,
  ResearchRunStatuses,
  deduplicateResearchQueries,
  expandResearchTemplate,
  researchTemplateBindings,
  type LocationContext,
  type ResearchRunQueryDto,
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
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { SourceLink } from '../shared/SourceLink.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { StatusNote } from '../shared/StatusNote.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import { useAccount } from '../../contexts/account-context.js'

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
  queryPlaceholder: 'Write one research query per line',
  inheritedModel: 'Use AI Visibility model',
  runAction: 'Run queries',
  introHelp: 'See how an engine answers a query. Results are saved apart from tracked queries and AI Visibility numbers.',
  subject: 'Subject',
  subjectHelp: 'The market or location these results are saved under. It does not change the query text.',
  notSet: 'Not set',
  subjectUnavailable: 'Subject unavailable',
  searchLocation: 'Search location',
  noSearchLocation: 'No search location',
  selectedHelp: 'A market or location name changes the query text only. The engine searches from the search location set beside it.',
  queriesHelp: 'One query per line. The engine receives exactly this text.',
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
  demo: 'Saved results only',
  demoDetail: 'This public demo shows saved research results. Running research is unavailable.',
  historyTitle: 'Past research',
  historyMore: 'Load older runs',
  historyLoading: 'Loading older runs…',
  historyError: 'Past research did not load.',
  historyMoreError: 'Older runs did not load.',
  resultsTitle: 'Research results',
  resultsError: "This run's results did not load.",
  emptyHistory: 'No research yet',
  resultsEmpty: 'No run selected',
  methodologySummary: 'Company names only',
  methodology: "Named checks the answer text for this project's company names and domains. Cited checks the source links for this project's domain. Neither checks a location's own names.",
  templateProvenance: 'Pattern details',
  resolvedTextHelp: 'The queries below are the final text sent to the engine, including any edits.',
  reviewHelp: 'Only this saved query text goes to tracking review. Its answer stays research evidence.',
  citedCompetitorsHelp: 'Cited as a source, not only named in the answer.',
  noAnswer: 'No answer',
  answerPending: 'Answer pending',
  brandedQuery: 'Branded',
  nonBrandQuery: 'Non-brand',
  untypedQuery: 'Not set',
} as const

/** A blocking check or a failure: the label is what shows, the sentence is its tooltip. */
type ResearchNote = { label: string; detail: string; tone?: 'caution' | 'negative' }
const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`

export type ResearchTemplateOption = { id: string; version: string; label: string; pattern: string; variables: readonly string[] }
export type ResearchScopeOption = ResearchRunScope & { expectedPlanRevision: number }

export type ResearchTrackingSource = { researchRunQueryId: string; scope?: ResearchRunScope | null }
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
}: {
  projectName: string
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [createdRuns, setCreatedRuns] = useState<ResearchRunDetailDto[]>([])
  const retryRequest = useRef<{ fingerprint: string; key: string } | null>(null)
  const submitInFlight = useRef(false)
  const [composerVersion, setComposerVersion] = useState(0)

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
    refetchInterval: query => query.state.data?.pages.some(page => page.runs.some(run => ACTIVE_RESEARCH_STATUSES.has(run.status))) ? 3000 : false,
  })
  // An older-page failure must leave loaded history and the selected answer usable.
  // Failed authoritative refreshes still close the Research admission UI.
  const historyError = runsQuery.isError && !runsQuery.isFetchNextPageError
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
    refetchInterval: selectedRun && ACTIVE_RESEARCH_STATUSES.has(selectedRun.status) ? 3000 : false,
  })
  const detail = historyError || detailQuery.isError ? null : detailQuery.data ?? null

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
      setComposerVersion(value => value + 1)
      setCreatedRuns(batch.runs)
      setSelectedRunId(batch.runs[0]?.id ?? null)
      await refreshResearch(queryClient)
      addToast({
        title: 'Research batch saved',
        detail: `${batch.runs.length} ${batch.runs.length === 1 ? 'run is' : 'runs are'} in past research. Nothing was added to tracked queries.`,
        tone: 'positive',
        dedupeKey: `research:start:${batch.runs.map(run => run.id).join(':')}`,
        dedupeMode: 'replace',
      })
    },
    onError: (error) => {
      addToast({
        title: 'Could not start research',
        detail: error instanceof Error ? error.message : 'Check the engine, model and search location, then try again.',
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

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        {publicDemo ? (
          <Card className="surface-card min-w-0">
            <StatusNote icon={Info} label={RESEARCH_COPY.demo} detail={RESEARCH_COPY.demoDetail} />
          </Card>
        ) : (
          <>
          <ResearchBatchComposer
            key={`${projectName}:${composerVersion}`}
            projectName={projectName}
            canWrite={canWrite}
            researchAllowed={canRun && !historyError}
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
              researchMutation.mutate({ client: heyClient, path: { name: projectName }, body: { ...body, idempotencyKey: retryRequest.current.key } })
            }}
          />
          {(dailyRunLimit !== null || setupReadError || noEngine) && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4">
            {dailyRunLimit !== null && <StatusNote icon={Gauge} label={`${plural(dailyRunLimit, 'run', 'runs')} per day`} detail={`Up to ${plural(dailyRunLimit, 'research run', 'research runs')} per project per day. Each market, location or search location in a batch is one run.`} />}
            {setupReadError && <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={`The ${setupReads} did not load.`} action={<RetryButton name={setupReads} onClick={() => { if (settingsError) void settingsQuery.refetch(); if (projectQuery.isError) void projectQuery.refetch() }} />} /></span>}
            {noEngine && <StatusNote icon={Key} tone="caution" label={RESEARCH_COPY.noEngineKey} detail={limitedAccess ? RESEARCH_COPY.noEngineDetail : RESEARCH_COPY.noEngineKeyDetail} />}
          </div>}
          {createdRuns.length > 0 && <p role="status" className="px-4 text-sm text-secondary">Saved runs: {createdRuns.map((run, index) => <span key={run.id}>{index > 0 ? ', ' : ''}<a href={`#research-run-${run.id}`} className="text-link underline" onClick={() => setSelectedRunId(run.id)}>{[run.scope?.label, run.location?.label].filter(Boolean).join(' · ') || RESEARCH_COPY.notSet}</a></span>)}</p>}
          </>
        )}

        <Card className="surface-card min-w-0">
          <div className="section-head section-head-inline">
            <div>
              <h3>{RESEARCH_COPY.historyTitle}</h3>
            </div>
            {runsQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
          </div>
          {historyError ? <div role="alert" className="mt-4"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.historyError} action={<RetryButton name="past research" onClick={() => { void runsQuery.refetch() }} />} /></div> : runsQuery.isPending ? <div role="status" aria-label="Loading past research" className="mt-4">{[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="flex items-center gap-8 py-3"><span className="skeleton-text w-28" /><span className="skeleton-text w-20" /><span className="skeleton-text w-36" /><span className="skeleton-text w-24" /></div>)}</div> : runs.length === 0 ? (
            <div className="mt-4"><StatusNote icon={History} label={RESEARCH_COPY.emptyHistory} /></div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="evidence-table min-w-[760px] [overflow-wrap:anywhere]">
                <thead><tr><th>Run</th><th>Engine</th><th>{RESEARCH_COPY.subject}</th><th>{RESEARCH_COPY.searchLocation}</th><th>Progress</th><th>Status</th></tr></thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className={selectedRunId === run.id ? 'bg-bg-elevated/40' : undefined}>
                      <td className="whitespace-nowrap"><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedRunId(run.id)}>{formatResearchDate(run.createdAt)}</button></td>
                      <td className="whitespace-nowrap text-secondary"><span className="block">{providerDisplayName(run.provider)}</span><span className="font-mono text-[11px] text-muted">{run.requestedModel ?? run.resolvedModel}</span></td>
                      <td className="text-secondary">{run.scope?.label ?? RESEARCH_COPY.notSet}</td>
                      <td className="text-secondary">{run.location?.label ?? RESEARCH_COPY.noSearchLocation}</td>
                      <td className="whitespace-nowrap tabular-nums text-secondary">{run.completedQueries + run.failedQueries}/{run.totalQueries}</td>
                      <td className="whitespace-nowrap"><ToneBadge tone={toneForResearchRun(run.status)}>{run.status}</ToneBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* One button for the next page and its retry, so a failed load keeps focus on it. */}
          {(runsQuery.isFetchNextPageError || runsQuery.hasNextPage) && <div className="mt-3 flex flex-wrap items-center gap-3">
            {runsQuery.isFetchNextPageError && <span role="alert"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.historyMoreError} /></span>}
            {runsQuery.hasNextPage && <Button variant="outline" disabled={runsQuery.isFetching} aria-label={runsQuery.isFetchNextPageError && !runsQuery.isFetchingNextPage ? 'Retry older runs' : undefined} onClick={() => { void runsQuery.fetchNextPage() }}>{runsQuery.isFetchingNextPage ? RESEARCH_COPY.historyLoading : runsQuery.isFetchNextPageError ? RESEARCH_COPY.retry : RESEARCH_COPY.historyMore}</Button>}
          </div>}
        </Card>
      </div>

      {!historyError && detailQuery.isError ? <div role="alert" className="px-4"><StatusNote icon={AlertTriangle} tone="negative" label={RESEARCH_COPY.loadError} detail={RESEARCH_COPY.resultsError} action={<RetryButton name="results" onClick={() => { void detailQuery.refetch() }} />} /></div> : !historyError ? <ResearchRunDetail detail={detail} isLoading={detailQuery.isFetching || runsQuery.isPending} onReviewForTracking={publicDemo ? undefined : onReviewForTracking} /> : null}
    </div>
  )
}

type ResearchMode = 'once' | 'markets' | 'properties' | 'locations'
type PreviewRow = { id: string; query: string; scope: ResearchRunScope | null; location: LocationContext | null; template?: ResearchTemplateSelection }
type ResearchDestination = VisibilityReportScopeOption & { kind: 'market' | 'property' }
type ComposerProps = {
  projectName: string
  canWrite: boolean
  researchAllowed: boolean
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
const INPUT_CLASS = 'mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
const NO_LOCATION = '__none__'
const OVER_RUNS = `Over ${MAX_RESEARCH_BATCH_RUNS} runs`
const SELECTION_UNAVAILABLE: ResearchNote = { label: 'Selection unavailable', detail: 'A ticked market, location or search location is no longer available. Update what is ticked.' }

function ResearchBatchComposer(props: ComposerProps) {
  const { projectName, locations, provider, resolvedModel, planRevision } = props
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<ResearchMode>('once')
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
  if (mode !== 'once' && patternSyntaxError) setupErrors.push({ label: 'Unknown name', detail: 'Use the name button to insert a name. Remove unknown or incomplete braces.' })
  if (!contexts.length) setupErrors.push({ label: `Pick a ${placeNoun}`, detail: `Tick at least one ${placeNoun}.` })
  if (contexts.some(context => !context || context.location === undefined)) setupErrors.push(SELECTION_UNAVAILABLE)
  const requiresScope = (mode === 'once' && scopeKey !== 'project') || mode === 'markets' || mode === 'properties'
  if (requiresScope && (props.scopePending || props.scopeError || !planRevision)) setupErrors.push({ label: 'Places not loaded', detail: 'Markets and locations are loading or did not load. Research for one of them has to wait.' })
  else if (requiresScope && contexts.some(context => !context?.scope)) setupErrors.push(mode === 'once' ? { label: RESEARCH_COPY.subjectUnavailable, detail: 'The Subject is no longer in the published plan. Pick another, or Not set.' } : SELECTION_UNAVAILABLE)
  const total = (mode === 'once' ? directQueries.length : sourceLines.length) * contexts.length
  if (contexts.length > MAX_RESEARCH_BATCH_RUNS) setupErrors.push({ label: OVER_RUNS, detail: `${contexts.length} ${placeNoun}s ticked. One batch takes at most ${MAX_RESEARCH_BATCH_RUNS} runs.` })
  if (total > MAX_RESEARCH_BATCH_QUERIES) setupErrors.push({ label: `Over ${MAX_RESEARCH_BATCH_QUERIES} queries`, detail: `${total} queries selected. One batch takes at most ${MAX_RESEARCH_BATCH_QUERIES}.` })
  if (templateStale) setupErrors.push({ label: 'Pattern changed', detail: 'This saved pattern changed. Pick its current version from Saved patterns.' })
  if (mode !== 'once' && !patternSyntaxError) {
    for (const context of contexts) {
      if (!context || context.location === undefined) continue
      try { expandResearchTemplate(selectedTemplate ?? { pattern, variables: patternVariables }, context.scope, context.location) }
      catch {
        // {location} binds only where a search location is set; any other name that fails belongs to another run mode.
        setupErrors.push((selectedTemplate?.variables ?? patternVariables).includes('location') && !context.location
          ? { label: 'Pick a search location', detail: `{location} is the search location. Set one beside each ticked ${placeNoun}, or remove {location}.` }
          : { label: 'Unknown name', detail: `A name in this pattern has no value for a ${placeNoun}. Use the name button to insert one that does.` })
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
    if (rows.some(row => row.location && !locations.some(location => JSON.stringify(location) === JSON.stringify(row.location)))) rowErrors.push({ label: SELECTION_UNAVAILABLE.label, detail: 'A search location in this preview changed. Regenerate the preview.' })
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
  const changeMode = (next: ResearchMode) => { setMode(next); setSelectedKeys([]); setSelectedTemplate(null); setSearch(''); setShowErrors(false) }
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
      addToast({ title: 'Pattern saved', detail: 'Available in Saved patterns. Tracking was not changed.', tone: 'positive' })
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
  const engineLabel = props.providerOptions.find(item => item.name === provider)?.displayName ?? provider

  // Help sits beside a heading or label, never inside it, so its sentence stays out of that name.
  return <Card className="surface-card min-w-0">
    <div className="section-head"><div className="flex items-center"><h3>Test queries</h3><InfoTooltip text={RESEARCH_COPY.introHelp} placement="bottom" /></div></div>
    <fieldset aria-label="Research setup" className="mt-5 min-w-0 space-y-5" disabled={props.isPending || saveMutation.isPending}>
      <label className="block"><span className="text-sm font-medium text-heading">Run mode</span>
        <select className={INPUT_CLASS} value={mode} disabled={props.isPending} onChange={event => changeMode(event.target.value as ResearchMode)}>
          <option value="once">Run once</option>
          <option value="markets" disabled={!allDestinations.some(item => item.kind === 'market')}>Repeat across markets</option>
          <option value="properties" disabled={!allDestinations.some(item => item.kind === 'property')}>Repeat across locations</option>
          <option value="locations" disabled={!locations.length}>Repeat across search locations</option>
        </select>
      </label>
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
      {mode !== 'once' && <fieldset className="space-y-3" aria-labelledby="research-places-label">
        <div className="flex items-center"><span id="research-places-label" className="text-sm font-medium text-heading">{mode === 'markets' ? 'Markets' : mode === 'properties' ? 'Locations' : 'Search locations'}</span><InfoTooltip text={`Tick each ${placeNoun} yourself. Each one gets its own saved run.`} placement="bottom" /></div>
        <input type="search" aria-label="Search" className={INPUT_CLASS} placeholder="Search" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {(mode === 'locations' ? locations.map(location => ({ key: location.label, label: location.label })) : destinations.map(option => ({ key: `${option.kind}:${option.id}`, label: option.label })))
            .filter(option => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option => {
              const checked = selectedKeys.includes(option.key)
              return <div key={option.key} className="grid items-center gap-2 border-b border-default pb-2 sm:grid-cols-[minmax(0,1fr)_16rem]">
                <label className="flex min-h-11 items-center gap-3 text-sm text-heading"><input type="checkbox" checked={checked} onChange={() => setSelectedKeys(current => checked ? current.filter(key => key !== option.key) : [...current, option.key])} />{option.label}</label>
                {checked && mode !== 'locations' && <LocationSelect hideLabel label={`${RESEARCH_COPY.searchLocation} for ${option.label}`} value={destinationLocations[option.key] ?? NO_LOCATION} locations={locations} onChange={value => setDestinationLocations(current => ({ ...current, [option.key]: value }))} />}
              </div>
            })}
        </div>
        <div className="flex items-center"><p className="text-sm tabular-nums text-secondary">{selectedKeys.length} selected</p>{mode !== 'locations' && <InfoTooltip text={RESEARCH_COPY.selectedHelp} placement="bottom" />}</div>
      </fieldset>}
      {props.scopeError && <div><StatusNote icon={AlertTriangle} tone="caution" label={RESEARCH_COPY.loadError} detail="Markets and locations did not load. Research with no Subject and across search locations still works." action={<RetryButton name="markets and locations" onClick={props.onRetryScope} />} /></div>}
      <div>
        <div className="flex items-center"><label className="text-sm font-medium text-heading" htmlFor="research-query-editor">{mode === 'once' ? 'Queries' : 'Pattern'}</label><InfoTooltip text={mode === 'once' ? RESEARCH_COPY.queriesHelp : `One pattern per line. Put {${tokenName}} where each name belongs, then preview the queries before running.`} placement="bottom" /></div>
        <textarea id="research-query-editor" ref={patternRef} className={`${INPUT_CLASS} min-h-32`} aria-describedby="research-query-count" value={source} placeholder={mode === 'once' ? RESEARCH_COPY.queryPlaceholder : mode === 'markets' ? 'Best apartments in {market}' : mode === 'properties' ? 'What amenities does {property} offer?' : 'Best apartments in {location}'} onChange={event => {
          if (mode === 'once') setQueryText(event.target.value)
          else { setPattern(event.target.value); setSelectedTemplate(null) }
        }} />
        {mode !== 'once' && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" variant="outline" onClick={() => insertToken(tokenName)}><Plus size={14} aria-hidden="true" />{mode === 'markets' ? 'Market name' : mode === 'properties' ? 'Location name' : 'Search location name'}</Button>
          {mode === 'properties' && patternVariables.includes('location') && <StatusNote icon={AlertTriangle} tone="caution" label={RESEARCH_COPY.usesSearchLocation} detail={RESEARCH_COPY.usesSearchLocationDetail} />}
        </div>}
        <p id="research-query-count" className="mt-2 text-sm tabular-nums text-secondary">{total} of {MAX_RESEARCH_BATCH_QUERIES} queries{mode === 'once' ? '' : ` · ${plural(contexts.length, 'run', 'runs')}`}</p>
      </div>
      {mode !== 'once' && <details className="border-t border-default pt-3"><summary className="cursor-pointer text-sm font-medium text-heading focus-visible:outline focus-visible:outline-2">Saved patterns <span className="font-normal text-secondary">(optional)</span></summary>
        <div className="mt-3 space-y-3">
          {/* The help is in the panel: a button inside the summary would toggle the disclosure. It stays beside the list when the list wraps. */}
          <div className="flex items-center">
            {!selectableTemplates.length ? <span className="text-sm text-secondary">{RESEARCH_COPY.noSavedPatterns}</span> : <div className="flex min-w-0 flex-wrap gap-2">{selectableTemplates.map(template => <Button size="sm" variant="outline" key={template.id} onClick={() => chooseTemplate(template)}>{template.label}</Button>)}</div>}
            <InfoTooltip text={RESEARCH_COPY.savedPatternsHelp} placement="bottom" />
          </div>
          {selectedTemplate && <p className="text-sm text-secondary">Using: {selectedTemplate.label}</p>}
          {props.canWrite && !props.isEmbed && <><Button size="sm" variant="outline" onClick={() => setSaveOpen(!saveOpen)}>{saveOpen ? 'Cancel save' : 'Save as a pattern'}</Button>
            {saveOpen && <div className="flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 text-sm text-heading">Pattern name<input className={INPUT_CLASS} value={saveName} maxLength={120} onChange={event => setSaveName(event.target.value)} /></label><Button size="sm" disabled={saveMutation.isPending || !saveName.trim() || !source.trim()} onClick={savePattern}>{saveMutation.isPending ? 'Saving…' : 'Save pattern'}</Button></div>}
          </>}
          {saveError && <InlineNotes notes={[saveError]} />}
        </div>
      </details>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-heading">Engine<select className={INPUT_CLASS} value={provider} onChange={event => props.onProviderChange(event.target.value)}><option value="" disabled>Choose an engine</option>{props.providerOptions.map(item => <option key={item.name} value={item.name}>{item.displayName ?? item.name}</option>)}</select></label>
        <label className="block text-sm font-medium text-heading">Model
          {props.limitedAccess ? <select className={INPUT_CLASS} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)}><option value="">Use AI Visibility model · {props.visibilityModel}</option>{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
            : <><input aria-label="Model" className={INPUT_CLASS} list="research-known-models" placeholder={resolvedModel ?? 'Choose an engine'} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)} /><datalist id="research-known-models">{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist></>}
        </label>
      </div>
      {visibleErrors.length > 0 && <InlineNotes notes={visibleErrors} />}
      {mode !== 'once' && <div className="space-y-4 border-t border-default pt-4">
        {/* The button comes first and stays mounted, so regenerating a stale preview keeps focus on it. */}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={props.isPending || !props.projectReady} onClick={createPreview}><RefreshCw size={14} />{preview ? RESEARCH_COPY.refreshPreview : 'Preview queries'}</Button>
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
      <div className="flex flex-wrap items-center gap-3 border-t border-default pt-4">
        {!props.isEmbed && <Button size="sm" disabled={!canRun} onClick={() => { if (canRun) { const request = buildRequest(); props.onSubmit(request, JSON.stringify({ projectName, ...request })) } }}><Play size={14} />{props.isPending ? 'Starting…' : RESEARCH_COPY.runAction}</Button>}
        <p className="text-sm tabular-nums text-secondary">{[plural(mode === 'once' ? directQueries.length : rows.length, 'query', 'queries'), engineLabel, resolvedModel].filter(Boolean).join(' · ')}</p>
      </div>
    </fieldset>
  </Card>
}

/** `label` is the select's name. `name` replaces it for assistive tech when the visible label is shorter; `hideLabel` is for a row whose value says what it is. */
function LocationSelect({ label, name, hideLabel = false, value, locations, onChange }: { label: string; name?: string; hideLabel?: boolean; value: string; locations: readonly LocationContext[]; onChange: (value: string) => void }) {
  return <label className="block text-sm"><span className={hideLabel ? 'sr-only' : 'font-medium text-heading'}>{label}</span><select className={INPUT_CLASS} aria-label={name} value={value} onChange={event => onChange(event.target.value)}><option value={NO_LOCATION}>{RESEARCH_COPY.noSearchLocation}</option>{locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}</select></label>
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
  return <Button variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" aria-label={`${RESEARCH_COPY.retry} ${name}`} onClick={onClick}>{RESEARCH_COPY.retry}</Button>
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
function ResearchRunDetail({
  detail,
  isLoading,
  onReviewForTracking,
}: {
  detail: ResearchRunDetailDto | null
  isLoading: boolean
  onReviewForTracking?: (source: ResearchTrackingSource) => void
}) {
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedQueryId(detail?.queries[0]?.id ?? null)
  }, [detail?.id])

  const selected = detail?.queries.find(item => item.id === selectedQueryId) ?? detail?.queries[0] ?? null

  return (
    <Card id={detail ? `research-run-${detail.id}` : undefined} className="surface-card min-w-0" role="region" aria-label={RESEARCH_COPY.resultsTitle}>
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Results</p>
          <h3>{detail ? `Research run ${shortId(detail.id)}` : isLoading ? 'Loading results…' : RESEARCH_COPY.resultsEmpty}</h3>
        </div>
        {detail && <ToneBadge tone={toneForResearchRun(detail.status)}>{detail.status}</ToneBadge>}
      </div>
      {detail && <div className="mt-3 space-y-3 text-sm text-secondary">
        <dl className="flex flex-wrap gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
          <div><dt className="font-medium">Engine</dt><dd>{providerDisplayName(detail.provider)}</dd></div>
          <div><dt className="font-medium">Model</dt><dd className="font-mono">{detail.requestedModel ?? detail.resolvedModel}</dd></div>
          <div><dt className="font-medium">{RESEARCH_COPY.searchLocation}</dt><dd>{detail.location?.label ?? RESEARCH_COPY.noSearchLocation}</dd></div>
          <div><dt className="font-medium">{RESEARCH_COPY.subject}</dt><dd>{detail.scope?.label ?? RESEARCH_COPY.notSet}</dd></div>
        </dl>
        {detail.template && <details>
          <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{RESEARCH_COPY.templateProvenance}</summary>
          <dl className="mt-2 space-y-2">
            <div><dt className="font-medium">Saved pattern</dt><dd className="whitespace-pre-wrap">{detail.template.template}</dd></div>
            <div><dt className="font-medium">Names used</dt><dd>{Object.entries(detail.template.bindings).map(([key, value]) => `{${key}}: ${value}`).join(' · ') || 'None'}</dd></div>
            <div><dt className="flex items-center font-medium">Resolved text<InfoTooltip text={RESEARCH_COPY.resolvedTextHelp} placement="bottom" /></dt><dd className="whitespace-pre-wrap">{detail.template.output}</dd></div>
          </dl>
          <p className="mt-2 font-mono text-xs">{detail.template.templateId} · {detail.template.templateVersion}</p>
        </details>}
        <div><StatusNote icon={Info} label={RESEARCH_COPY.methodologySummary} detail={RESEARCH_COPY.methodology} /></div>
      </div>}
      {detail && (
        <div className="mt-4 space-y-4">
          <div className="overflow-x-auto">
            <table className="evidence-table min-w-[760px] [overflow-wrap:anywhere]">
              <thead><tr><th>Query</th><th>Type</th><th>Status</th><th>Named</th><th>Cited</th></tr></thead>
              <tbody>
                {detail.queries.map(item => (
                  <tr key={item.id} className={selected?.id === item.id ? 'bg-bg-elevated/40' : undefined}>
                    <td><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedQueryId(item.id)}>{item.query}</button></td>
                    <td className="whitespace-nowrap"><ToneBadge tone={item.queryClass === 'branded' ? 'positive' : item.queryClass === 'non-brand' ? 'neutral' : 'caution'}>{item.queryClass === 'branded' ? RESEARCH_COPY.brandedQuery : item.queryClass === 'non-brand' ? RESEARCH_COPY.nonBrandQuery : RESEARCH_COPY.untypedQuery}</ToneBadge></td>
                    <td className="whitespace-nowrap"><ToneBadge tone={toneForResearchQuery(item.status)}>{item.status}</ToneBadge></td>
                    <td className="whitespace-nowrap"><ToneBadge tone={item.answerMentioned === true ? 'positive' : item.answerMentioned === false ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.answerMentioned === null ? unchecked(item.status) : item.answerMentioned ? 'Named' : 'Not named'}</ToneBadge></td>
                    <td className="whitespace-nowrap"><ToneBadge tone={item.citationState === 'cited' ? 'positive' : item.citationState === 'not-cited' ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.citationState === null ? unchecked(item.status) : item.citationState === 'cited' ? 'Cited' : 'Not cited'}</ToneBadge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ResearchAnswer query={selected} scope={detail.scope ?? null} isLoading={isLoading} onReviewForTracking={onReviewForTracking} />
        </div>
      )}
    </Card>
  )
}
function ResearchAnswer({
  query,
  isLoading,
  scope,
  onReviewForTracking,
}: {
  query: ResearchRunQueryDto | null
  isLoading: boolean
  scope: ResearchRunScope | null
  onReviewForTracking?: (source: ResearchTrackingSource) => void
}) {
  if (!query) return <p className="text-sm text-muted">{isLoading ? 'Loading answers…' : 'No answers yet'}</p>
  return (
    <div className="min-w-0 space-y-4 border-t border-default pt-4 [overflow-wrap:anywhere]">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted">Selected query</p>
        <p className="mt-1 text-sm font-medium leading-6 text-heading">{query.query}</p>
      </div>
      {!isEmbed() && onReviewForTracking && (
        <div className="flex items-center">
          <WriteButton type="button" size="sm" onClick={() => onReviewForTracking({ researchRunQueryId: query.id, scope })}>
            Review for tracking
          </WriteButton>
          <InfoTooltip text={RESEARCH_COPY.reviewHelp} placement="bottom" />
        </div>
      )}
      {query.error ? (
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">{query.error}</div>
      ) : query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Answer</p>
          <div className="mt-1"><AnswerMarkdown headingLevel={4} copyable>{query.answerText}</AnswerMarkdown></div>
        </div>
      ) : (
        <div>{query.status === ResearchQueryStatuses.queued || query.status === ResearchQueryStatuses.running
          ? <StatusNote icon={Clock} label={RESEARCH_COPY.answerPending} />
          : <StatusNote icon={Ban} label={RESEARCH_COPY.noAnswer} />}</div>
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
          <p className="flex items-center text-[10px] uppercase tracking-wide text-muted">Cited competitor domains<InfoTooltip text={RESEARCH_COPY.citedCompetitorsHelp} placement="bottom" /></p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {query.citedCompetitorDomains.map(domain => <span key={domain} className="mention-chip mention-chip--competitor">{domain.replace(/^www\./, '')}</span>)}
          </div>
        </div>
      )}
      {query.groundingSources.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Source links</p>
          <ul className="mt-2 space-y-3">
            {query.groundingSources.map((source, index) => (
              <li key={`${source.uri}-${index}`} className="min-w-0">
                <SourceLink url={source.uri} title={source.title} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function formatResearchDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function toneForResearchRun(status: ResearchRunStatus) {
  if (status === ResearchRunStatuses.completed) return 'positive'
  if (status === ResearchRunStatuses.partial) return 'caution'
  if (status === ResearchRunStatuses.failed) return 'negative'
  return 'neutral'
}

/** A signal with no value: the query failed, is still running, or finished without that check. Never a No. */
function unchecked(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.failed) return 'Unavailable'
  return status === ResearchQueryStatuses.completed ? 'Not checked' : 'Pending'
}

function toneForResearchQuery(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.completed) return 'positive'
  if (status === ResearchQueryStatuses.failed) return 'negative'
  return 'neutral'
}

async function refreshResearch(queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>) {
  await invalidateProjectQueryDomain(queryClient, 'researchRuns')
}

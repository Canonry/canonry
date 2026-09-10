import { useEffect, useMemo, useRef, useState } from 'react'
import { AnswerMarkdown } from '../shared/AnswerMarkdown.js'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Play, RefreshCw } from 'lucide-react'
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

import { heyClient, isEmbed, type ViewerResearchConfig } from '../../api.js'
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
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { safeExternalUrl } from '../../lib/safe-url.js'
import { WriteButton } from '../shared/AccessControls.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { Button } from '../ui/button.js'
import { useAccount } from '../../contexts/account-context.js'

const ACTIVE_RESEARCH_STATUSES = new Set<ResearchRunStatus>([
  ResearchRunStatuses.queued,
  ResearchRunStatuses.running,
])

/** Shared so assertions describe the shipped Research interface. */
export const RESEARCH_COPY = {
  queryPlaceholder: 'Write one research query per line',
  patternPlaceholder: 'best {market} apartments near transit',
  patternGuidance: 'Write one query pattern per line. For example, “best {market} apartments near transit”.',
  inheritedModel: 'Use AI Visibility model',
  runAction: 'Run queries',
  savedNote: 'Saved separately from tracked queries and AI Visibility metrics.',
  historyTitle: 'Research history',
  historyMore: 'Load older runs',
  historyLoading: 'Loading older runs…',
  historyMoreError: 'Could not load older research. Try again.',
  resultsTitle: 'Research results',
  emptyHistory: 'No saved research.',
  resultsEmpty: 'Choose a saved run.',
  methodologySummary: 'How matching works',
  methodology: 'Brand-name matches use configured project names or domains in answer text. Project-domain citations use source links. Neither verifies property identity.',
  stalePreview: 'The plan or saved pattern changed after this preview. Your edits are preserved. Regenerate before starting research.',
  refreshPreview: 'Regenerate preview',
  templateProvenance: 'Query pattern details',
  brandedQuery: 'Branded',
  discoveryQuery: 'Discovery',
  unclassifiedQuery: 'Unclassified',
} as const

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
    enabled: !limitedAccess,
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
        detail: `${batch.runs.length} ${batch.runs.length === 1 ? 'run is' : 'runs are'} in research history. Nothing was added to tracked queries.`,
        tone: 'positive',
        dedupeKey: `research:start:${batch.runs.map(run => run.id).join(':')}`,
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
    onSettled: () => { submitInFlight.current = false },
  })

  return (
    <div className="space-y-4">
      <div className="space-y-4">
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
        {dailyRunLimit !== null && <p className="text-sm text-secondary">Up to {dailyRunLimit} destination runs per project per day.</p>}
        {!limitedAccess && settingsQuery.isError ? <div role="alert" className="text-sm text-negative"><p>Could not load API providers.</p><Button variant="outline" onClick={() => { void settingsQuery.refetch() }}>Retry providers</Button></div> : null}
        {projectQuery.isError ? <div role="alert" className="text-sm text-negative"><p>Could not load project locations.</p><Button variant="outline" onClick={() => { void projectQuery.refetch() }}>Retry locations</Button></div> : null}
        {!(limitedAccess ? historyError : settingsQuery.isError) && noConfiguredApiProviders && <p className="rounded-md border border-caution-800/40 bg-caution-950/20 px-3 py-2 text-sm text-caution">{limitedAccess ? 'No research engines are available. Ask your Canonry team to configure one.' : 'Configure an API provider in Settings before starting research. Browser engines are not available for this workflow.'}</p>}
        {createdRuns.length > 0 && <p role="status" className="text-sm text-secondary">Saved runs: {createdRuns.map((run, index) => <span key={run.id}>{index > 0 ? ', ' : ''}<a href={`#research-run-${run.id}`} className="text-link underline" onClick={() => setSelectedRunId(run.id)}>{run.scope?.label ?? 'Whole site'}{run.location ? `, ${run.location.label}` : ', No location'}</a></span>)}</p>}

        <Card className="surface-card min-w-0">
          <div className="section-head section-head-inline">
            <div>
              <h3>{RESEARCH_COPY.historyTitle}</h3>
            </div>
            {runsQuery.isFetching && <ToneBadge tone="neutral">Loading</ToneBadge>}
          </div>
          {historyError ? <div role="alert" className="mt-4 text-sm text-negative"><p>Could not load research history.</p><Button variant="outline" onClick={() => { void runsQuery.refetch() }}>Retry history</Button></div> : runsQuery.isPending ? <p role="status">Loading research history…</p> : runs.length === 0 ? (
            <p className="mt-4 text-sm text-muted">{RESEARCH_COPY.emptyHistory}</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="evidence-table min-w-[760px] [overflow-wrap:anywhere]">
                <thead><tr><th>Run</th><th>Model</th><th>Destination</th><th>Location</th><th>Progress</th><th>Status</th></tr></thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className={selectedRunId === run.id ? 'bg-bg-elevated/40' : undefined}>
                      <td><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedRunId(run.id)}>{formatResearchDate(run.createdAt)}</button></td>
                      <td className="text-secondary"><span className="block">{run.provider}</span><span className="font-mono text-[11px] text-muted">{run.requestedModel ?? run.resolvedModel}</span></td>
                      <td className="text-secondary">{run.scope?.label ?? 'Whole site'}</td>
                      <td className="text-secondary">{run.location?.label ?? 'No location'}</td>
                      <td className="tabular-nums text-secondary">{run.completedQueries + run.failedQueries}/{run.totalQueries}</td>
                      <td><ToneBadge tone={toneForResearchRun(run.status)}>{run.status}</ToneBadge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runsQuery.isFetchNextPageError && <p role="alert" className="mt-3 text-sm text-negative">{RESEARCH_COPY.historyMoreError}</p>}
          {runsQuery.hasNextPage && <Button className="mt-3" variant="outline" disabled={runsQuery.isFetching} onClick={() => { void runsQuery.fetchNextPage() }}>{runsQuery.isFetchingNextPage ? RESEARCH_COPY.historyLoading : RESEARCH_COPY.historyMore}</Button>}
        </Card>
      </div>

      {!historyError && detailQuery.isError ? <div role="alert" className="text-sm text-negative"><p>Could not load saved research results.</p><Button variant="outline" onClick={() => { void detailQuery.refetch() }}>Retry results</Button></div> : !historyError ? <ResearchRunDetail detail={detail} isLoading={detailQuery.isFetching} onReviewForTracking={onReviewForTracking} /> : null}
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
  const [preview, setPreview] = useState<{ signature: string; rows: PreviewRow[] } | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveError, setSaveError] = useState('')
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
  const setupErrors: string[] = []
  if (!sourceLines.length) setupErrors.push(mode === 'once' ? 'Enter at least one query.' : 'Enter at least one query pattern.')
  if (sourceLines.some(line => line.length > 4000)) setupErrors.push('Keep each query under 4,001 characters.')
  if (mode !== 'once' && patternSyntaxError) setupErrors.push('Use the name buttons to insert a supported variable. Remove unknown or incomplete braces.')
  if (!contexts.length) setupErrors.push(mode === 'locations' ? 'Select at least one location.' : 'Select at least one destination.')
  if (contexts.some(context => !context || context.location === undefined)) setupErrors.push('A selected destination or location is no longer available. Update your selection.')
  const requiresScope = (mode === 'once' && scopeKey !== 'project') || mode === 'markets' || mode === 'properties'
  if (requiresScope && (props.scopePending || props.scopeError || !planRevision || contexts.some(context => !context?.scope))) setupErrors.push('Load the current published markets and properties before running scoped research.')
  const total = (mode === 'once' ? directQueries.length : sourceLines.length) * contexts.length
  if (contexts.length > MAX_RESEARCH_BATCH_RUNS) setupErrors.push(`Select at most ${MAX_RESEARCH_BATCH_RUNS} destinations.`)
  if (total > MAX_RESEARCH_BATCH_QUERIES) setupErrors.push(`${total} queries selected. Reduce the selection to ${MAX_RESEARCH_BATCH_QUERIES} or fewer.`)
  if (templateStale) setupErrors.push('This saved pattern changed. Select its current version from Saved patterns.')
  if (mode !== 'once' && !patternSyntaxError) {
    for (const context of contexts) {
      if (!context || context.location === undefined) continue
      try { expandResearchTemplate(selectedTemplate ?? { pattern, variables: patternVariables }, context.scope, context.location) }
      catch { setupErrors.push(`Choose a location for {location}, or use only variables available for ${mode === 'markets' ? 'markets' : mode === 'properties' ? 'properties' : 'locations'}.`); break }
    }
  }
  const signature = JSON.stringify({ mode, source, contexts, provider, resolvedModel, template: selectedTemplate, ...(requiresScope ? { planRevision } : {}) })
  const previewStale = preview !== null && preview.signature !== signature
  const rows = mode === 'once'
    ? directQueries.map((query, index): PreviewRow => ({ id: String(index), query, scope: directScope, location: contexts[0]?.location ?? null }))
    : preview?.rows ?? []
  const groups = groupPreviewRows(rows)
  const rowErrors: string[] = []
  if (mode !== 'once' && preview) {
    if (previewStale) rowErrors.push('Setup changed. Your edited queries are preserved. Regenerate the preview to use the new setup.')
    if (rows.some(row => !row.query.trim() || row.query.length > 4000 || /\{(?:market|submarket|property|propertyBrand|location)\}/.test(row.query))) rowErrors.push('Every preview row needs a complete query of 1 to 4,000 characters, with no unresolved variables.')
    if (rows.some(row => row.location && !locations.some(location => JSON.stringify(location) === JSON.stringify(row.location)))) rowErrors.push('A preview location changed. Regenerate the preview.')
    if (groups.some(group => deduplicateResearchQueries(group.queries).length !== group.queries.length)) rowErrors.push('Remove duplicate queries within each destination and location.')
    if (groups.length > MAX_RESEARCH_BATCH_RUNS) rowErrors.push(`The preview exceeds ${MAX_RESEARCH_BATCH_RUNS} runs.`)
  }
  const canRun = props.researchAllowed && !props.isEmbed && !props.isPending && props.settingsReady && props.projectReady && Boolean(provider && resolvedModel) && !setupErrors.length && !rowErrors.length && (mode === 'once' || preview !== null)
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
    setPreview({ signature, rows: nextRows })
  }
  const changeMode = (next: ResearchMode) => { setMode(next); setSelectedKeys([]); setSelectedTemplate(null); setSearch(''); setShowErrors(false) }
  const chooseTemplate = (template: ResearchTemplateOption) => {
    setSaveError('')
    if (mode === 'once') {
      try { setQueryText(expandResearchTemplate(template, directScope, locationFor(directLocationLabel)).output) }
      catch { setSaveError('Select a matching market, property, or location before using this pattern.'); return }
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
      setSaveOpen(false); setSaveName(''); setSaveError(''); saveReceipt.current = null
      await queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameMeasurementQueryTemplatesQueryKey({ client: heyClient, path: { name: projectName } }) })
      addToast({ title: 'Pattern saved', detail: 'Available in Saved patterns. Tracking was not changed.', tone: 'positive' })
    },
    onError: () => setSaveError('Could not save the pattern. Your text is preserved. Retry to save the same pattern.'),
    onSettled: () => { saveInFlight.current = false },
  })
  const savePattern = () => {
    if (!props.canWrite || props.isEmbed || saveInFlight.current) return
    const savedSource = mode === 'once' ? queryText : pattern
    const variables = mode === 'once' ? [] : patternVariables
    if (!saveName.trim() || !savedSource.trim() || savedSource.length > 4000 || (mode !== 'once' && patternSyntaxError)) {
      setSaveError('Enter a name and a valid pattern of 1 to 4,000 characters.'); return
    }
    const body = { name: saveName.trim(), pattern: savedSource, variables }
    const fingerprint = JSON.stringify(body)
    if (saveReceipt.current?.fingerprint !== fingerprint) saveReceipt.current = { fingerprint, id: crypto.randomUUID() }
    saveInFlight.current = true
    saveMutation.mutate({ client: heyClient, path: { name: projectName, templateId: saveReceipt.current.id }, body })
  }
  const visibleErrors = [...new Set([...(showErrors || source.trim() ? setupErrors : []), ...rowErrors])]
  const selectableTemplates = templates.filter(template => {
    const available = mode === 'once' ? researchTemplateBindings(directScope, locationFor(directLocationLabel))
      : researchTemplateBindings(mode === 'markets' ? { kind: 'market', label: 'Market' } : mode === 'properties' ? { kind: 'property', label: 'Property' } : null, { label: 'Location' })
    return template.variables.every(variable => available[variable] !== undefined)
  })

  return <Card className="surface-card min-w-0">
    <div className="section-head"><div><h3>Test queries</h3><p className="mt-1 max-w-prose text-sm text-secondary">See how an answer engine responds. Results are saved separately from tracked queries and AI Visibility metrics.</p></div></div>
    <fieldset aria-label="Research setup" className="mt-5 min-w-0 space-y-5" disabled={props.isPending || saveMutation.isPending}>
      <label className="block"><span className="text-sm font-medium text-heading">Run mode</span>
        <select className={INPUT_CLASS} value={mode} disabled={props.isPending} onChange={event => changeMode(event.target.value as ResearchMode)}>
          <option value="once">Run once</option>
          <option value="markets" disabled={!allDestinations.some(item => item.kind === 'market')}>Repeat across markets</option>
          <option value="properties" disabled={!allDestinations.some(item => item.kind === 'property')}>Repeat across properties</option>
          <option value="locations" disabled={!locations.length}>Repeat across locations</option>
        </select>
      </label>
      {mode === 'once' && <div className="grid gap-4 sm:grid-cols-2">
        {(allDestinations.length > 0 || scopeKey !== 'project') && <label className="block"><span className="text-sm font-medium text-heading">Save results under</span>
          <select className={INPUT_CLASS} value={scopeKey} onChange={event => { setScopeKey(event.target.value); setSelectedTemplate(null) }}>
            <option value="project">Whole site</option>
            {scopeKey !== 'project' && !directScopeOption && <option value={scopeKey} disabled>Selected destination unavailable</option>}
            {allDestinations.map(option => <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>{option.label} ({option.kind})</option>)}
          </select>
        </label>}
        <LocationSelect label="Answer engine location" value={directLocationLabel} locations={locations} onChange={value => { setDirectLocation(value); setSelectedTemplate(null) }} />
      </div>}
      {mode !== 'once' && <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-heading">{mode === 'locations' ? 'Select locations' : `Select ${mode}`}</legend>
        <p className="text-sm text-secondary">Choose each destination explicitly. Each selected destination gets its own saved research run.</p>
        <input type="search" aria-label="Search destinations" className={INPUT_CLASS} placeholder={`Search ${mode}`} value={search} onChange={event => setSearch(event.target.value)} />
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {(mode === 'locations' ? locations.map(location => ({ key: location.label, label: location.label })) : destinations.map(option => ({ key: `${option.kind}:${option.id}`, label: option.label })))
            .filter(option => option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(option => {
              const checked = selectedKeys.includes(option.key)
              return <div key={option.key} className="grid items-center gap-2 border-b border-default pb-2 sm:grid-cols-[minmax(0,1fr)_16rem]">
                <label className="flex min-h-11 items-center gap-3 text-sm text-heading"><input type="checkbox" checked={checked} onChange={() => setSelectedKeys(current => checked ? current.filter(key => key !== option.key) : [...current, option.key])} />{option.label}</label>
                {checked && mode !== 'locations' && <LocationSelect label={`Answer engine location for ${option.label}`} value={destinationLocations[option.key] ?? NO_LOCATION} locations={locations} onChange={value => setDestinationLocations(current => ({ ...current, [option.key]: value }))} />}
              </div>
            })}
        </div>
        <p className="text-sm text-secondary">{selectedKeys.length} selected. A market or property name changes query text, not the answer engine's location.</p>
      </fieldset>}
      {props.scopeError && <p className="text-sm text-caution">Markets and properties could not load. Whole-site and location research remain available. <Button variant="outline" onClick={props.onRetryScope}>Retry destinations</Button></p>}
      <div>
        <label className="block" htmlFor="research-query-editor"><span className="text-sm font-medium text-heading">{mode === 'once' ? 'Queries' : 'Query pattern'}</span></label>
        <p id="research-query-guidance" className="mt-1 text-sm text-secondary">{mode === 'once' ? 'Enter one query per line. The answer engine receives exactly this text.' : `Use {${mode === 'markets' ? 'market' : mode === 'properties' ? 'property' : 'location'}} where each name belongs. Preview the resolved queries before running.`}</p>
        <textarea id="research-query-editor" ref={patternRef} className={`${INPUT_CLASS} min-h-32`} aria-describedby="research-query-guidance research-query-count" value={source} placeholder={mode === 'once' ? RESEARCH_COPY.queryPlaceholder : mode === 'markets' ? 'Best apartments in {market}' : mode === 'properties' ? 'What amenities does {property} offer?' : 'Best apartments in {location}'} onChange={event => {
          if (mode === 'once') setQueryText(event.target.value)
          else { setPattern(event.target.value); setSelectedTemplate(null) }
        }} />
        {mode !== 'once' && <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => insertToken(mode === 'markets' ? 'market' : mode === 'properties' ? 'property' : 'location')}>Insert {mode === 'markets' ? 'market' : mode === 'properties' ? 'property' : 'location'} name</Button>
          <span className="self-center text-sm text-secondary">One pattern per line.</span>
        </div>}
        <p id="research-query-count" className="mt-2 text-sm text-secondary">{total} / {MAX_RESEARCH_BATCH_QUERIES} queries{mode === 'once' ? '' : ` across ${contexts.length} destinations`}</p>
      </div>
      {mode !== 'once' && <details className="border-t border-default pt-3"><summary className="cursor-pointer text-sm font-medium text-heading focus-visible:outline focus-visible:outline-2">Saved patterns <span className="font-normal text-secondary">(optional)</span></summary>
        <div className="mt-3 space-y-3"><p className="text-sm text-secondary">Reusable starting text, not active measurement templates. Saving a pattern does not run or track queries.</p>
          {!selectableTemplates.length ? <p className="text-sm text-secondary">No saved patterns for this selection.</p> : <div className="flex flex-wrap gap-2">{selectableTemplates.map(template => <Button size="sm" variant="outline" key={template.id} onClick={() => chooseTemplate(template)}>{template.label}</Button>)}</div>}
          {selectedTemplate && <p className="text-sm text-secondary">Using: {selectedTemplate.label}</p>}
          {props.canWrite && !props.isEmbed && <><Button size="sm" variant="outline" onClick={() => setSaveOpen(!saveOpen)}>{saveOpen ? 'Cancel save' : 'Save as a pattern'}</Button>
            {saveOpen && <div className="flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 text-sm text-heading">Pattern name<input className={INPUT_CLASS} value={saveName} maxLength={120} onChange={event => setSaveName(event.target.value)} /></label><Button size="sm" disabled={saveMutation.isPending || !saveName.trim() || !source.trim()} onClick={savePattern}>{saveMutation.isPending ? 'Saving…' : 'Save pattern'}</Button></div>}
          </>}
          {saveError && <p role="alert" className="text-sm text-negative">{saveError}</p>}
        </div>
      </details>}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium text-heading">Answer engine<select className={INPUT_CLASS} value={provider} onChange={event => props.onProviderChange(event.target.value)}><option value="" disabled>Choose an answer engine</option>{props.providerOptions.map(item => <option key={item.name} value={item.name}>{item.displayName ?? item.name}</option>)}</select></label>
        <label className="block text-sm font-medium text-heading">Model
          {props.limitedAccess ? <select className={INPUT_CLASS} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)}><option value="">Use AI Visibility model · {props.visibilityModel}</option>{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select>
            : <><input aria-label="Model" className={INPUT_CLASS} list="research-known-models" placeholder={resolvedModel ?? 'Choose an answer engine'} value={props.model} disabled={!provider || !props.configurableModel} onChange={event => props.onModelChange(event.target.value)} /><datalist id="research-known-models">{props.modelOptions.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist></>}
        </label>
      </div>
      {visibleErrors.length > 0 && <InlineErrors errors={visibleErrors} />}
      {mode !== 'once' && <div className="space-y-4 border-t border-default pt-4">
        <Button variant="outline" size="sm" disabled={props.isPending || !props.projectReady} onClick={createPreview}><RefreshCw size={14} />{preview ? RESEARCH_COPY.refreshPreview : 'Preview queries'}</Button>
        {preview && <><h4 className="font-medium text-heading">Queries to run</h4><p className="text-sm text-secondary">{rows.length} query executions in {groups.length} saved runs · {provider} · {resolvedModel}. Edit any query or location below.</p>
          <ConcretePreview rows={rows} locations={locations} onChange={(id, changes) => setPreview(current => current ? { ...current, rows: current.rows.map(row => row.id === id ? { ...row, ...changes } : row) } : current)} />
        </>}
      </div>}
      {props.errorMessage && <p role="alert" className="text-sm text-negative">{props.errorMessage} Your entries are preserved. Retry unchanged entries to avoid duplicate work.</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-default pt-4">
        {!props.isEmbed && <Button size="sm" disabled={!canRun} onClick={() => { if (canRun) { const request = buildRequest(); props.onSubmit(request, JSON.stringify({ projectName, ...request })) } }}><Play size={14} />{props.isPending ? 'Starting…' : RESEARCH_COPY.runAction}</Button>}
        <p className="text-sm text-secondary">{mode === 'once' ? `${directQueries.length} queries` : `${rows.length} reviewed queries`} · {provider || 'Choose an engine'} · {resolvedModel || 'Choose a model'}. Uses your configured answer engine.</p>
      </div>
    </fieldset>
  </Card>
}

function LocationSelect({ label, value, locations, onChange }: { label: string; value: string; locations: readonly LocationContext[]; onChange: (value: string) => void }) {
  return <label className="block"><span className="text-sm font-medium text-heading">{label}</span><select className={INPUT_CLASS} value={value} onChange={event => onChange(event.target.value)}><option value={NO_LOCATION}>No location context</option>{locations.map(location => <option key={location.label} value={location.label}>{location.label}</option>)}</select></label>
}
function ConcretePreview({ rows, locations, onChange }: { rows: readonly PreviewRow[]; locations: readonly LocationContext[]; onChange: (id: string, changes: Partial<Pick<PreviewRow, 'query' | 'location'>>) => void }) {
  return <ol className="divide-y divide-default">{rows.map((row, index) => <li key={row.id} className="grid gap-3 py-4 md:grid-cols-[10rem_minmax(0,1fr)_15rem]">
    <div className="text-sm"><span className="block text-secondary">Query {index + 1}</span><span className="font-medium text-heading">{row.scope?.label ?? row.location?.label ?? 'Whole site'}</span>{row.scope && <span className="block text-secondary">{row.scope.kind}</span>}</div>
    <label className="block text-sm font-medium text-heading">Query<textarea className={`${INPUT_CLASS} min-h-20`} aria-label={`Query ${index + 1} for ${row.scope?.label ?? row.location?.label ?? 'Whole site'}`} value={row.query} onChange={event => onChange(row.id, { query: event.target.value })} /></label>
    <LocationSelect label={`Location for query ${index + 1}`} value={row.location?.label ?? NO_LOCATION} locations={locations} onChange={value => onChange(row.id, { location: locations.find(location => location.label === value) ?? null })} />
  </li>)}</ol>
}
function InlineErrors({ errors }: { errors: readonly string[] }) {
  return <div role="alert" className="text-sm text-negative"><ul className="list-disc space-y-1 pl-5">{errors.map(error => <li key={error}>{error}</li>)}</ul></div>
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
          <h3>{detail ? `Research run ${shortId(detail.id)}` : RESEARCH_COPY.resultsEmpty}</h3>
        </div>
        {detail && <ToneBadge tone={toneForResearchRun(detail.status)}>{detail.status}</ToneBadge>}
      </div>
      {detail && <div className="mt-3 space-y-3 text-sm text-secondary">
        <dl className="flex flex-wrap gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
          <div><dt className="font-medium">Answer engine</dt><dd>{detail.provider}</dd></div>
          <div><dt className="font-medium">Requested model</dt><dd className="font-mono">{detail.requestedModel ?? detail.resolvedModel}</dd></div>
          <div><dt className="font-medium">Location</dt><dd>{detail.location?.label ?? 'No location'}</dd></div>
          <div><dt className="font-medium">Destination</dt><dd>{detail.scope?.label ?? 'Whole site'}</dd></div>
        </dl>
        {detail.template && <details>
          <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{RESEARCH_COPY.templateProvenance}</summary>
          <dl className="mt-2 space-y-2">
            <div><dt className="font-medium">Saved pattern</dt><dd className="whitespace-pre-wrap">{detail.template.template}</dd></div>
            <div><dt className="font-medium">Names used</dt><dd>{Object.entries(detail.template.bindings).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No variables'}</dd></div>
            <div><dt className="font-medium">Original resolved text</dt><dd className="whitespace-pre-wrap">{detail.template.output}</dd></div>
          </dl>
          <p className="mt-2">The queries below are the final text sent to the answer engine, including any edits.</p>
          <p className="mt-2 font-mono text-xs">{detail.template.templateId} · {detail.template.templateVersion}</p>
        </details>}
        <details>
          <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{RESEARCH_COPY.methodologySummary}</summary>
          <p className="mt-2 max-w-prose leading-6">{RESEARCH_COPY.methodology}</p>
        </details>
      </div>}
      {!detail ? (
        <p className="mt-4 text-sm text-muted">Select a saved run to inspect each answer and its source links.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="overflow-x-auto">
            <table className="evidence-table min-w-[760px] [overflow-wrap:anywhere]">
              <thead><tr><th>Query</th><th>Class</th><th>Status</th><th>Brand-name match</th><th>Project domain cited</th></tr></thead>
              <tbody>
                {detail.queries.map(item => (
                  <tr key={item.id} className={selected?.id === item.id ? 'bg-bg-elevated/40' : undefined}>
                    <td><button type="button" className="text-left font-medium text-heading hover:text-link focus:outline-none focus:underline" onClick={() => setSelectedQueryId(item.id)}>{item.query}</button></td>
                    <td><ToneBadge tone={item.queryClass === 'branded' ? 'positive' : item.queryClass === 'non-brand' ? 'neutral' : 'caution'}>{item.queryClass === 'branded' ? RESEARCH_COPY.brandedQuery : item.queryClass === 'non-brand' ? RESEARCH_COPY.discoveryQuery : RESEARCH_COPY.unclassifiedQuery}</ToneBadge></td>
                    <td><ToneBadge tone={toneForResearchQuery(item.status)}>{item.status}</ToneBadge></td>
                    <td><ToneBadge tone={item.answerMentioned === true ? 'positive' : item.answerMentioned === false ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.answerMentioned === null ? item.status === ResearchQueryStatuses.failed ? 'Unavailable' : 'Pending' : item.answerMentioned ? 'Matched' : 'No match'}</ToneBadge></td>
                    <td><ToneBadge tone={item.citationState === 'cited' ? 'positive' : item.citationState === 'not-cited' ? 'neutral' : item.status === ResearchQueryStatuses.failed ? 'negative' : 'caution'}>{item.citationState === null ? item.status === ResearchQueryStatuses.failed ? 'Unavailable' : 'Pending' : item.citationState === 'cited' ? 'Cited' : 'Not cited'}</ToneBadge></td>
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
  if (!query) return <p className="text-sm text-muted">{isLoading ? 'Loading saved answers…' : 'Select a query to inspect its answer.'}</p>
  return (
    <div className="min-w-0 space-y-4 border-t border-default pt-4 [overflow-wrap:anywhere]">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted">Selected query</p>
        <p className="mt-1 text-sm font-medium leading-6 text-heading">{query.query}</p>
      </div>
      {!isEmbed() && onReviewForTracking && (
        <div className="rounded-md border border-default bg-surface-subtle px-3 py-3">
          <WriteButton type="button" size="sm" onClick={() => onReviewForTracking({ researchRunQueryId: query.id, scope })}>
            Review for tracking
          </WriteButton>
          <p className="mt-2 text-xs leading-5 text-muted">Only this saved query text enters tracking review. Its answer remains research evidence.</p>
        </div>
      )}
      {query.error ? (
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">{query.error}</div>
      ) : query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Answer</p>
          <div className="mt-1"><AnswerMarkdown>{query.answerText}</AnswerMarkdown></div>
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

function toneForResearchQuery(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.completed) return 'positive'
  if (status === ResearchQueryStatuses.failed) return 'negative'
  return 'neutral'
}

async function refreshResearch(queryClient: Pick<ReturnType<typeof useQueryClient>, 'invalidateQueries'>) {
  await invalidateProjectQueryDomain(queryClient, 'researchRuns')
}

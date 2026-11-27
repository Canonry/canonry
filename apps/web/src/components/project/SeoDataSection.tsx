import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, History, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import {
  RatioUnits, RunKinds, SchedulableRunKinds, SeoAvailability, SeoCapabilities, SeoCompetitorSorts, SeoKeywordGapKinds, SeoKeywordGapSorts, SeoMarketRankingFilters, SeoMarketRankingGroupKinds, SeoMarketRankingOutcomes,
  SeoMarketRankingSearchStatuses, SeoMarketRankingSorts, SeoRunStatuses, SeoScopeKinds, SeoTargetKinds, SeoTrendKinds, TrendUnits,
  compareText, formatCalendarDay, formatDate, formatIsoDateInTimeZone, formatZonedTimestamp, formatPercent, marketRankingBands,
  SEO_TREND_DEFAULT_DAYS, SEO_TREND_METRICS_BY_KIND, seoCapabilitySchema, seoDatasetWithoutVendor, seoMarketRankingFilterSchema, seoMarketRankingSortSchema, seoProfileInputSchema, seoTrendDaysSchema, seoTrendMetricSchema,
  type MarketRankingBand, type SeoCapability, type SeoCompetitor, type SeoCompetitorSort, type SeoContext, type SeoDevice, type SeoDomainIntelligence, type SeoKeywordGap, type SeoKeywordGapKind, type SeoKeywordGapSort, type SeoKeywordMetrics,
  type SeoMarketRankingCounts, type SeoMarketRankingFilter, type SeoMarketRankingGroup, type SeoMarketRankingRow, type SeoMarketRankingSort,
  type SeoOverview, type SeoProfile, type SeoProfileInput, type SeoProvenance, type SeoRankedKeyword,
  type SeoRun, type SeoRunStatus, type SeoSyncInput, type SeoTarget, type SeoTask, type SeoTrendDays, type SeoTrendMetric, type SeoTrends,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameScheduleOptions,
  getApiV1ProjectsByNameSeoContextOptions,
  getApiV1ProjectsByNameSeoProfilesOptions,
  getApiV1ProjectsByNameSeoOverviewOptions,
  getApiV1ProjectsByNameSeoTrendsOptions,
  getApiV1ProjectsByNameSeoRankedKeywordsOptions,
  getApiV1ProjectsByNameSeoKeywordMetricsOptions,
  getApiV1ProjectsByNameSeoDomainIntelligenceOptions,
  getApiV1ProjectsByNameSeoCompetitorsOptions,
  getApiV1ProjectsByNameSeoKeywordGapsOptions,
  getApiV1ProjectsByNameSeoMarketRankingsOptions,
  getApiV1ProjectsByNameSeoMarketRankingsSummaryOptions,
  getApiV1ProjectsByNameSeoRunsOptions,
  getApiV1ProjectsByNameSeoRunsByIdOptions,
  postApiV1ProjectsByNameSeoRefreshIntentsMutation,
  postApiV1ProjectsByNameSeoSyncMutation,
  putApiV1ProjectsByNameSeoProfilesByIdMutation,
  postApiV1ProjectsByNameSeoRunsByIdCancelMutation,
} from '@canonry/canonry-api-client/react-query'
import { heyClient, isEmbed, isPublicDemo } from '../../api.js'
import { useAccount } from '../../contexts/account-context.js'
import { usePublishAeroView } from '../../contexts/aero-view-context.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { extractApiErrorInfo, extractErrorMessage } from '../../lib/extract-error-message.js'
import { trackRun } from '../../lib/run-tracker-store.js'
import { trackUiFilterChange } from '../../lib/ui-telemetry.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { Button } from '../ui/button.js'
import { Drawer } from '../layout/Drawer.js'
import { ActionMenu } from '../shared/ActionMenu.js'
import { DataTablePagination, DataTableSearch, MiddleTruncatedText } from '../shared/DataTableControls.js'
import {
  Bar, BarChart, CartesianGrid, Cell, CHART_AXIS_TICK, CHART_GRID_STROKE, CHART_SERIES_COLORS, CHART_TOOLTIP_STYLE,
  ComposedChart, LabelList, Line, RechartsTooltip, ResponsiveContainer, XAxis, YAxis,
} from '../shared/ChartPrimitives.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SourceLink } from '../shared/SourceLink.js'
import { levelTrendChange, sharedLevelBasis, trendSpanLabel, TrendCard, type TrendCardFigure } from '../shared/TrendCard.js'

const CAPABILITY_LABELS: Record<SeoCapability, string> = {
  [SeoCapabilities['keyword-metrics']]: 'Search demand',
  [SeoCapabilities['domain-intelligence']]: 'Domain comparison',
  [SeoCapabilities['ranked-keywords']]: 'Searches you rank for',
  [SeoCapabilities['market-rankings']]: 'Market rankings',
  [SeoCapabilities['competitor-discovery']]: 'Organic competitors',
  [SeoCapabilities['keyword-gaps']]: 'Search gaps',
}
const GAP_LABELS: Record<SeoKeywordGapKind, string> = {
  [SeoKeywordGapKinds.shared]: 'Shared',
  [SeoKeywordGapKinds.missing]: 'Missing',
  [SeoKeywordGapKinds.outranked]: 'Competitor ahead',
}
const RANK_GAP_HELP = 'Your organic position minus the competitor’s position. Positive means the competitor ranks higher; negative means you rank higher. No gap is calculated when either position is unavailable.'
const STATUS_LABELS: Record<SeoRunStatus, string> = {
  [SeoRunStatuses.queued]: 'Queued',
  [SeoRunStatuses.running]: 'Refreshing',
  [SeoRunStatuses.completed]: 'Completed',
  [SeoRunStatuses.partial]: 'Partial results',
  [SeoRunStatuses.failed]: 'Failed',
  [SeoRunStatuses.cancelled]: 'Cancelled',
  [SeoRunStatuses['reconciliation-required']]: 'Needs review',
}
const PAGE_SIZE = 25
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' })
const FIELD = 'min-h-11 w-full rounded-md border border-default bg-bg px-3 py-2 text-label-14 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
// Cells sit on the row's first line, so an opened Details panel never leaves the row label floating mid-row.
const CELL = 'px-4 py-3 text-right align-top tabular-nums whitespace-nowrap'
const ROW_HEADER = 'min-w-56 px-4 py-3 text-left align-top text-label-14'
/** The source's absolute rank, in plain words: it counts map packs and other result blocks, so it can differ from the organic rank. */
const PAGE_POSITION = 'Position on the page, counting maps and other blocks'
type SeoView = SeoCapability | 'overview' | 'latest-rankings'
const SEO_VIEW_LABELS: Record<SeoView, string> = { overview: 'Overview', 'latest-rankings': 'Latest rankings', ...CAPABILITY_LABELS }
const EVIDENCE_ORDER = [
  SeoCapabilities['market-rankings'], SeoCapabilities['ranked-keywords'], SeoCapabilities['keyword-metrics'],
  SeoCapabilities['domain-intelligence'], SeoCapabilities['competitor-discovery'], SeoCapabilities['keyword-gaps'],
]

function isActive(run: SeoRun | undefined | null): boolean {
  return run?.status === SeoRunStatuses.queued || run?.status === SeoRunStatuses.running
}

function hasResults(run: SeoRun): boolean {
  return run.status === SeoRunStatuses.completed || run.status === SeoRunStatuses.partial
}

function Value({ value, currency = false }: { value: number | null; currency?: boolean }) {
  return value === null
    ? <span className="text-muted" aria-label="Not supplied">—</span>
    : <>{currency ? USD.format(value) : NUMBER.format(value)}</>
}

function RunBadge({ status }: { status: SeoRunStatus }) {
  const tone = status === SeoRunStatuses.completed ? 'positive'
    : status === SeoRunStatuses.failed ? 'negative'
      : status === SeoRunStatuses.partial || status === SeoRunStatuses['reconciliation-required'] ? 'caution' : 'neutral'
  return <ToneBadge tone={tone}>{STATUS_LABELS[status]}</ToneBadge>
}

/** A dataset's kind without the vendor behind the source, e.g. "Searches you rank for". Customers see the connection label, never the vendor. */
function datasetLabel(dataset: string): string {
  const kind = seoDatasetWithoutVendor(dataset).split('/').at(-1) ?? dataset
  const capability = seoCapabilitySchema.safeParse(kind.replaceAll('_', '-'))
  return capability.success ? CAPABILITY_LABELS[capability.data] : kind.replaceAll(/[-_]/g, ' ')
}

/** What device a results page was collected for, in plain words. */
function deviceLabel(device: SeoDevice | 'unspecified'): string {
  return device === 'mobile' ? 'phone results' : device === 'desktop' ? 'computer results' : 'device not specified by source'
}

/** Where a refresh searched from. Market rankings search from each market's own location, never the profile's one location. */
function runLocation(run: Pick<SeoRun, 'capabilities' | 'locationCode'>): string {
  return run.capabilities.includes(SeoCapabilities['market-rankings']) ? 'Market locations' : `Location ${run.locationCode}`
}

function languageLabel(code: string): string {
  try {
    return LANGUAGE_NAMES.of(code) ?? code
  } catch {
    return code
  }
}

/** A refresh's units of work in the reader's words: each market-rankings task is one search. */
function taskNoun(run: Pick<SeoRun, 'capabilities'>): string {
  return run.capabilities.includes(SeoCapabilities['market-rankings']) ? 'searches' : 'tasks'
}

/**
 * Whether refresh details list this task. A market-rankings refresh runs one search per tracked query and market,
 * hundreds of identical lines, so it lists only the searches that ended without completing; the refresh line keeps the counts.
 */
function listedTask(task: SeoTask): boolean {
  return task.capability !== SeoCapabilities['market-rankings'] || !([SeoRunStatuses.queued, SeoRunStatuses.running, SeoRunStatuses.completed] as SeoRunStatus[]).includes(task.status)
}

/** A count of a refresh's units of work: "1 search", "12 searches", "2 tasks". */
function taskCount(run: Pick<SeoRun, 'capabilities'>, count: number): string {
  const searches = run.capabilities.includes(SeoCapabilities['market-rankings'])
  return `${count} ${count === 1 ? searches ? 'search' : 'task' : taskNoun(run)}`
}

/** A day in the shared date style ("Oct 25") in a timezone, or null for an unreadable instant. */
function calendarDay(iso: string, timeZone: string): string | null {
  return Number.isFinite(Date.parse(iso)) ? formatCalendarDay(formatIsoDateInTimeZone(iso, timeZone)) : null
}

const LATEST_REFRESH_PROBLEM: Partial<Record<SeoRunStatus, string>> = {
  [SeoRunStatuses.failed]: 'Latest refresh failed',
  [SeoRunStatuses.cancelled]: 'Latest refresh cancelled',
  [SeoRunStatuses['reconciliation-required']]: 'Latest refresh needs review',
}

/**
 * The one caveat about the data on screen, in a few words with the sentence in a tooltip: the
 * newest refresh ended without data (the page keeps the refresh before it), else searches in the
 * shown refresh failed, else the shown refresh is partial for another reason.
 */
function refreshCaveat(latest: SeoRun | null | undefined, evidence: SeoRun | null | undefined): { label: string; text: string } | null {
  const problem = latest && latest.id !== evidence?.id ? LATEST_REFRESH_PROBLEM[latest.status] : undefined
  if (latest && problem) return { label: problem, text: `${problem}. ${latest.error ?? 'Open Refresh history for details.'}${evidence ? ' Showing the refresh before it.' : ''}` }
  if (!evidence) return null
  if (evidence.failedTasks > 0) {
    const label = `${taskCount(evidence, evidence.failedTasks)} failed`
    const where = evidence.capabilities.includes(SeoCapabilities['market-rankings']) ? 'Their queries show as Failed.' : 'Open Refresh history for details.'
    return { label, text: `${label}: ${evidence.failedTasks} of ${taskCount(evidence, evidence.taskCount)} in this refresh returned no results. ${where}` }
  }
  return evidence.status === SeoRunStatuses.partial
    ? { label: 'Partial results', text: `Partial results: ${evidence.error ?? `some ${taskNoun(evidence)} returned only part of their results or did not run. Open Refresh history for details.`}` }
    : null
}

function DataProvenance({ source }: { source: SeoProvenance }) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-label-13 sm:grid-cols-2">
      <div><dt className="text-muted">Dataset</dt><dd>{datasetLabel(source.dataset)}</dd></div>
      <div><dt className="text-muted">Search engine</dt><dd>Google · {deviceLabel(source.device)}</dd></div>
      <div><dt className="text-muted">Provider geography</dt><dd>Location {source.locationCode} · {source.languageCode}</dd></div>
      <div><dt className="text-muted">Collected</dt><dd>{formatZonedTimestamp(source.collectedAt, TIME_ZONE)}</dd></div>
      <div><dt className="text-muted">Source updated</dt><dd>{source.sourceUpdatedAt ? formatDate(source.sourceUpdatedAt) : 'Not supplied'}</dd></div>
    </dl>
  )
}

/** A row's details. `source` is null for a search that returned nothing, which has no provenance to show. */
function EvidenceDetails({ label, source, children }: { label: string; source: SeoProvenance | null; children?: ReactNode }) {
  return (
    <details className="group/seo-evidence text-left">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-label-13 text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open/seo-evidence:rotate-90" aria-hidden="true" />Details<span className="sr-only"> for {label}</span></summary>
      <div className="min-w-56 space-y-4 pb-3 text-label-13 text-secondary">
        {children}
        {source && <DataProvenance source={source} />}
      </div>
    </details>
  )
}

function ReadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default p-4 text-label-14"><p>{extractErrorMessage(error)}</p><Button variant="secondary" className="pointer-coarse:min-h-11" onClick={retry}>Retry</Button></div>
}

function EmptyEvidence({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="py-12 text-center"><h3 className="text-heading-14 text-heading">{title}</h3><p className="mx-auto mt-2 max-w-lg text-copy-14 text-secondary">{children}</p>{action && <div className="mt-4">{action}</div>}</div>
}

function supportedReports(connection: SeoContext['connections'][number] | undefined, scope: SeoContext['scopes'][number] | undefined) {
  if (!connection || !scope?.supported) return []
  return EVIDENCE_ORDER.filter(capability => connection.capabilities.includes(capability) && (scope.capabilities?.includes(capability) ?? true))
}

export function SeoDataSection({ projectName }: { projectName: string }) {
  const { isAdmin } = useAccount()
  const search = useSearch({ strict: false }) as { seoProfileId?: string; seoRunId?: string }
  const navigate = useNavigate()
  const context = useQuery(getApiV1ProjectsByNameSeoContextOptions({ client: heyClient, path: { name: projectName } }))
  const profiles = useQuery(getApiV1ProjectsByNameSeoProfilesOptions({ client: heyClient, path: { name: projectName } }))
  const selectedRun = useQuery({ ...getApiV1ProjectsByNameSeoRunsByIdOptions({ client: heyClient, path: { name: projectName, id: search.seoRunId ?? '' } }), enabled: Boolean(search.seoRunId) })
  const [editor, setEditor] = useState<{ profile?: SeoProfile; id: string } | null>(null)
  const editorOpener = useRef<HTMLButtonElement | null>(null)
  const profileSelect = useRef<HTMLSelectElement | null>(null)
  const profileName = useRef<HTMLSpanElement | null>(null)
  const profileMenu = useRef<HTMLButtonElement | null>(null)
  const profileToFocus = useRef<string | null>(null)
  const requestedProfileId = search.seoProfileId ?? selectedRun.data?.profileId
  const selected = requestedProfileId
    ? profiles.data?.profiles.find(profile => profile.id === requestedProfileId)
    : search.seoRunId ? undefined : profiles.data?.profiles[0]
  const selectProfile = (id: string, restoreFocus = false) => {
    if (restoreFocus) profileToFocus.current = id
    setEditor(null)
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoProfileId: id, seoRunId: undefined, seoView: undefined, seoRegion: undefined, seoMarket: undefined, seoShow: undefined, seoSort: undefined, seoQ: undefined, seoTrendDays: undefined, seoTrendMetric: undefined, seoTrendKeyword: undefined }) })
  }
  const canWrite = context.data?.access.canWrite === true && !isEmbed() && !isPublicDemo()
  const closeEditor = () => {
    setEditor(null)
    editorOpener.current?.focus()
  }
  useEffect(() => {
    if (!search.seoProfileId && selected) {
      void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoProfileId: selected.id }), replace: true })
    }
  }, [navigate, projectName, search.seoProfileId, selected])
  useLayoutEffect(() => {
    if (profileToFocus.current === null || selected?.id !== profileToFocus.current || search.seoRunId || editor) return
    profileToFocus.current = null
    const control = profileSelect.current ?? profileName.current
    control?.focus()
  }, [editor, search.seoRunId, selected])

  if (context.error) return <ReadError error={context.error} retry={() => { void context.refetch() }} />
  if (profiles.error) return <ReadError error={profiles.error} retry={() => { void profiles.refetch() }} />
  if (!context.data || !profiles.data) return <p role="status" className="py-10 text-copy-14 text-secondary">Loading SEO data…</p>
  const sourceConfigured = context.data.available && context.data.connections.some(connection => connection.capabilities.length > 0)
  const reports = new Set(context.data.scopes.flatMap(scope => (
    context.data.connections.flatMap(connection => supportedReports(connection, scope))
  )))
  const marketReport = SeoCapabilities['market-rankings']
  const canCreateProfile = sourceConfigured && [...reports].some(capability => capability !== marketReport)
  const marketProfilesAvailable = sourceConfigured && reports.has(marketReport)
  const canEditProfile = selected && (canCreateProfile || (selected.rankings && marketProfilesAvailable))
  const setupGuide = isAdmin && !isEmbed() && !isPublicDemo()
    ? <Button asChild variant="secondary"><a href="https://github.com/Canonry/canonry/blob/main/docs/seo-data.md#host-configuration" target="_blank" rel="noopener noreferrer">SEO setup guide</a></Button>
    : undefined
  const scope = selected && context.data.scopes.find(item => item.kind === selected.scope.kind && item.key === (selected.scope.key ?? null))
  const showWorkspace = selected && (!search.seoRunId || (selectedRun.data?.profileId === selected.id && !selectedRun.error))
  const showProfileSelect = profiles.data.profiles.length > 1 || !showWorkspace
  const openProfileEditor = (opener: HTMLButtonElement | null, profile?: SeoProfile) => {
    editorOpener.current = opener
    setEditor({ profile, id: profile?.id ?? crypto.randomUUID() })
  }
  const profileControls = profiles.data.profiles.length > 0 && <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:w-auto">
    {showProfileSelect ? <label className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:max-w-64">
      <span className="text-label-13 text-secondary">Profile</span>
      <select ref={profileSelect} aria-label="SEO profile" value={selected?.id ?? ''} onChange={event => selectProfile(event.currentTarget.value, document.activeElement === event.currentTarget)} className={`${FIELD} min-w-0 sm:min-h-9`}>
        {!selected && <option value="" disabled>Profile unavailable</option>}
        {profiles.data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </label> : <span ref={profileName} tabIndex={-1} className="min-w-0 flex-1 break-words rounded-sm text-copy-14-strong text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">
      <span className="sr-only">SEO profile: </span>{selected?.name}
    </span>}
    {canWrite && (canCreateProfile || canEditProfile) && <div className="ml-auto sm:ml-0">
      <ActionMenu label="Manage profiles" menuLabel="SEO profile actions" triggerRef={profileMenu} items={[
        ...(canEditProfile ? [{ key: 'edit', label: 'Edit profile', onSelect: () => openProfileEditor(profileMenu.current, selected) }] : []),
        ...(canCreateProfile ? [{ key: 'new', label: 'New profile', onSelect: () => openProfileEditor(profileMenu.current) }] : []),
      ]} />
    </div>}
    {selected && selected.scope.kind !== SeoScopeKinds.project && <span className="w-full break-words text-copy-13 text-secondary md:w-auto">{scope?.label ?? selected.scope.key ?? selected.scope.kind}</span>}
  </div>

  return (
    <section aria-label="SEO" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-heading-20 text-heading">SEO</h2>
        {profileControls}
        {profiles.data.profiles.length === 0 && canWrite && canCreateProfile && <Button variant="secondary" className="ml-auto" onClick={event => openProfileEditor(event.currentTarget)}><Plus aria-hidden="true" className="size-4" />New profile</Button>}
      </div>

      {editor && <SeoProfileEditor key={editor.id} projectName={projectName} context={context.data} profile={editor.profile} id={editor.id} onClose={closeEditor} onSaved={id => selectProfile(id, true)} />}
      {!isPublicDemo() && !context.data.available && profiles.data.profiles.length > 0 && <p role="status" className="rounded-md border border-default px-4 py-3 text-copy-14 text-secondary">{context.data.reason ?? 'Configure an SEO data provider to refresh saved profiles.'}</p>}
      {search.seoRunId && selectedRun.error ? <div className="space-y-3"><ReadError error={selectedRun.error} retry={() => { void selectedRun.refetch() }} />{selected ? <Button variant="secondary" className="pointer-coarse:min-h-11" onClick={() => selectProfile(selected.id)}>View latest data</Button> : <p className="text-copy-14 text-secondary">Select a profile to view its latest data.</p>}</div> : search.seoRunId && selectedRun.isPending ? <p role="status" className="py-10 text-copy-14 text-secondary">Loading refresh…</p> : selected && selectedRun.data && selectedRun.data.profileId !== selected.id ? <EmptyEvidence title="Refresh belongs to another profile">Choose the refresh’s profile, or return to the selected profile’s latest data.<Button variant="secondary" className="mt-4 pointer-coarse:min-h-11" onClick={() => selectProfile(selected.id)}>View latest data</Button></EmptyEvidence> : selected ? <SeoProfileWorkspace key={`${selected.id}:${selected.revision}:${search.seoRunId ?? ''}`} projectName={projectName} profile={selected} context={context.data} selectedRunId={search.seoRunId} onLatest={() => selectProfile(selected.id)} /> : !canCreateProfile && profiles.data.profiles.length === 0 ? (
        !sourceConfigured ? <EmptyEvidence title="Configure an SEO data provider" action={setupGuide}>{setupGuide ? 'SEO sources are configured on the Canonry server.' : 'Ask your Canonry administrator to connect an SEO data source.'}</EmptyEvidence>
          : marketProfilesAvailable ? <EmptyEvidence title="No SEO profiles yet">Set up market rankings with the CLI or API.</EmptyEvidence>
            : <EmptyEvidence title="SEO scope unavailable">{context.data.scopes.find(item => item.reason)?.reason ?? 'No datasets are available for this project’s measurement scopes.'}</EmptyEvidence>
      ) : requestedProfileId ? (
        <EmptyEvidence title="Profile unavailable">This saved profile is no longer available. Select another profile to view its data.</EmptyEvidence>
      ) : !editor && <EmptyEvidence title="No SEO data yet">{canWrite ? 'Create a profile to choose the scope, source, and searches to measure.' : 'An SEO profile is needed before data can be collected.'}</EmptyEvidence>}
    </section>
  )
}

function SeoProfileWorkspace({ projectName, profile, context, selectedRunId, onLatest }: { projectName: string; profile: SeoProfile; context: SeoContext; selectedRunId?: string; onLatest: () => void }) {
  const queryClient = useQueryClient()
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const tabs = useRef<HTMLElement | null>(null)
  const historyTrigger = useRef<HTMLButtonElement | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingSync = useRef<SeoSyncInput | null>(null)
  const seenActiveRun = useRef<string | null>(null)
  const path = { name: projectName }
  const overviewOptions = getApiV1ProjectsByNameSeoOverviewOptions({ client: heyClient, path, query: { profileId: profile.id, runId: selectedRunId } })
  const overview = useQuery({
    ...overviewOptions,
    refetchInterval: query => isActive(query.state.data?.latestRun) ? 2000 : false,
  })
  const intent = useMutation({ ...postApiV1ProjectsByNameSeoRefreshIntentsMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const sync = useMutation({ ...postApiV1ProjectsByNameSeoSyncMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const latest = overview.data?.latestRun
  const evidence = overview.data?.evidenceRun
  const evidenceCapabilities = overview.data?.evidenceRun?.capabilities ?? profile.capabilities
  const views: SeoView[] = ['overview', ...EVIDENCE_ORDER.filter(capability => evidenceCapabilities.includes(capability))]
  const hasMarketInvestigation = search.seoRegion || search.seoMarket || search.seoShow || search.seoSort || search.seoQ
  const defaultView = !selectedRunId && hasMarketInvestigation && evidenceCapabilities.includes(SeoCapabilities['market-rankings']) ? SeoCapabilities['market-rankings'] : 'overview'
  const requestedView = search.seoView === 'latest-rankings' ? search.seoView : views.find(view => view === search.seoView)
  const selectedView = requestedView ?? defaultView
  const linkedHistory = search.seoView === 'activity' || Boolean(selectedRunId && !requestedView)
  const showingHistory = historyOpen || linkedHistory
  const closeHistory = () => {
    setHistoryOpen(false)
    if (linkedHistory && selectedRunId) onLatest()
    else if (linkedHistory) void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoView: undefined }), replace: true })
  }
  const viewSavedData = (runId: string) => {
    setHistoryOpen(false)
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoRunId: runId, seoView: 'overview', seoRegion: undefined, seoMarket: undefined, seoShow: undefined, seoSort: undefined, seoQ: undefined, seoTrendDays: undefined, seoTrendMetric: undefined, seoTrendKeyword: undefined }) })
  }
  const openView = (view: SeoView, focus = false) => {
    if (focus) tabs.current?.querySelector<HTMLButtonElement>(`[data-seo-view="${view}"]`)?.focus()
    const clearMarket = view === SeoCapabilities['market-rankings'] ? {} : { seoRegion: undefined, seoMarket: undefined, seoShow: undefined, seoSort: undefined, seoQ: undefined }
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, ...clearMarket, seoView: view === 'overview' && !selectedRunId ? undefined : view }) })
  }
  const active = isActive(latest)
  const busy = intent.isPending || sync.isPending
  const canRun = context.access.canRun && !isEmbed() && !isPublicDemo()
  const connection = context.connections.find(item => item.id === profile.connectionId)
  const scope = context.scopes.find(item => item.kind === profile.scope.kind && item.key === (profile.scope.key ?? null))
  // A project's SEO refresh schedule refreshes every saved profile; a missing schedule (404) means no date.
  const schedule = useQuery({ ...getApiV1ProjectsByNameScheduleOptions({ client: heyClient, path, query: { kind: SchedulableRunKinds['seo-sync'] } }), retry: false })
  const nextRunAt = !schedule.isError && schedule.data?.enabled && schedule.data.nextRunAt ? schedule.data.nextRunAt : null
  const nextRefresh = nextRunAt ? calendarDay(nextRunAt, schedule.data?.timezone ?? 'UTC') : null
  const savedDay = evidence?.finishedAt && hasResults(evidence) ? calendarDay(evidence.finishedAt, TIME_ZONE) : null
  const refreshHelp = canRun && connection && (profile.capabilities.includes(SeoCapabilities['market-rankings'])
    ? `Refresh now runs new Google searches through ${connection.label} for this profile’s tracked queries and markets.`
    : `Refresh now requests the latest data available from ${connection.label}. The source may return the same readings until its dataset updates.`)
  const refreshDetails = [
    savedDay && 'Last refresh shows when Canonry saved these results.',
    nextRefresh && `Next scheduled refresh ${nextRefresh}.`,
    refreshHelp,
  ].filter(Boolean).join(' ')
  const caveat = active ? null : refreshCaveat(latest, evidence)

  useEffect(() => {
    if (!latest) return
    if (isActive(latest)) {
      seenActiveRun.current = latest.id
    } else if (seenActiveRun.current === latest.id) {
      seenActiveRun.current = null
      void invalidateProjectQueryDomain(queryClient, 'seo', { projectName, profileId: profile.id })
    }
  }, [latest, profile.id, projectName, queryClient])

  const refresh = async () => {
    if (!canRun || selectedRunId || active || busy) return
    setError(null)
    try {
      if (!pendingSync.current) {
        const quote = await intent.mutateAsync({ path, body: { profileId: profile.id } })
        if (quote.availability !== SeoAvailability.ready) {
          setError(quote.reason ?? 'This profile cannot be refreshed. Review its scope and source.')
          return
        }
        pendingSync.current = { quoteToken: quote.token, idempotencyKey: crypto.randomUUID() }
      }
      const run = await sync.mutateAsync({ path, body: pendingSync.current })
      pendingSync.current = null
      if (isActive(run)) {
        seenActiveRun.current = run.id
        trackRun({ id: run.id, projectId: run.projectId, projectName, projectLabel: projectName, kind: RunKinds['seo-sync'], sourceAction: 'seo-sync', lastAnnouncedStatus: run.status })
      }
      queryClient.setQueryData(overviewOptions.queryKey, current => current && (!current.latestRun || current.latestRun === latest) ? { ...current, latestRun: run } : current)
      void overview.refetch({ cancelRefetch: false })
    } catch (cause) {
      if (extractApiErrorInfo(cause).code === 'VALIDATION_ERROR') pendingSync.current = null
      setError(extractErrorMessage(cause))
    }
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-subtle pt-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-copy-13 text-secondary" aria-live="polite">
        {overview.data && <p>
          {savedDay && evidence?.finishedAt ? <>{selectedRunId ? 'Viewing saved results from' : 'Last refresh'} <time dateTime={evidence.finishedAt} title={formatZonedTimestamp(evidence.finishedAt, TIME_ZONE) ?? undefined}>{savedDay}</time></> : 'No saved results'}
        </p>}
        {!selectedRunId && refreshDetails && <InfoTooltip placement="bottom" text={`About refreshes. ${refreshDetails}`} />}
        {active && latest && <p className="flex items-center gap-2"><Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />{latest.cancelRequested ? 'Cancellation requested' : STATUS_LABELS[latest.status]} · {latest.completedTasks} of {latest.taskCount} {taskNoun(latest)} completed</p>}
        {caveat && <InfoTooltip tone="caution" placement="bottom" label={caveat.label} text={caveat.text} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {latest && <Button ref={historyTrigger} variant="ghost" size="sm" aria-haspopup="dialog" aria-expanded={showingHistory} onClick={() => setHistoryOpen(true)}><History className="size-4" aria-hidden="true" />Refresh history</Button>}
        {selectedRunId ? <Button variant="secondary" onClick={onLatest}>View latest data</Button> : canRun && (
          <Button disabled={busy || active || !overview.data || !context.available || !connection} onClick={asyncHandler(refresh)}>
            <RefreshCw aria-hidden="true" className={`size-4 ${busy ? 'motion-safe:animate-spin' : ''}`} />
            {busy ? 'Starting refresh…' : active ? 'Refresh in progress' : pendingSync.current ? 'Retry refresh' : 'Refresh now'}
          </Button>
        )}
      </div>
    </div>
    {error && <p role="alert" className="rounded-md border border-default p-4 text-copy-14 text-secondary">{error}{pendingSync.current && ' Retry uses the same request, so it will not start a duplicate refresh.'}</p>}
    {!selectedRunId && evidence && evidence.profileRevision !== profile.revision && <p role="status" className="text-copy-13 text-secondary">Showing results from earlier profile settings.{canRun && context.available && connection && ' Refresh to use the current settings.'}</p>}
    {!isPublicDemo() && scope && !scope.supported && <p role="status" className="text-copy-14 text-secondary">{scope.reason ?? 'This scope is not supported for domain data.'}</p>}
    {overview.isRefetchError && <ReadError error={overview.error} retry={() => { void overview.refetch() }} />}
    <div>
      <nav ref={tabs} aria-label="SEO reports" className="flex min-w-0 flex-wrap gap-x-5 border-b border-subtle">
        {views.map(item => {
          const selected = selectedView === item || (selectedView === 'latest-rankings' && item === 'overview')
          return <button key={item} data-seo-view={item} type="button" aria-pressed={selected} className={`min-h-11 shrink-0 border-b-2 whitespace-nowrap text-button-14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mono-400 ${selected ? 'border-strong text-primary' : 'border-transparent text-secondary hover:text-primary'}`} onClick={() => openView(item)}>{SEO_VIEW_LABELS[item]}</button>
        })}
      </nav>
      {overview.isLoadingError ? <div className="pt-4"><ReadError error={overview.error} retry={() => { void overview.refetch() }} /></div>
          : overview.isPending ? <p role="status" className="py-8 text-copy-14 text-secondary">Loading saved data…</p>
            : selectedView === 'overview' || selectedView === 'latest-rankings' ? <SeoOverviewPanel projectName={projectName} profileId={profile.id} data={overview.data} active={active} canRun={canRun} nextRefresh={nextRefresh} snapshot={Boolean(selectedRunId) || selectedView === 'latest-rankings'} historical={Boolean(selectedRunId)} onOpen={view => openView(view, true)} />
              : <SeoEvidence key={`${profile.id}:${selectedView}:${overview.data.evidenceRunId ?? 'empty'}`} projectName={projectName} profileId={profile.id} runId={overview.data.evidenceRunId} view={selectedView} active={active} nextRefresh={nextRefresh} />}
    </div>
    <Drawer title="Refresh history" subtitle={profile.name} open={showingHistory} onClose={closeHistory} onCloseAutoFocus={event => {
      const trigger = historyTrigger.current
      if (trigger?.isConnected && !(linkedHistory && selectedRunId)) {
        event.preventDefault()
        trigger.focus()
      }
    }}>
      {showingHistory && <SeoRefreshHistory projectName={projectName} profileId={profile.id} canRun={canRun} selectedRunId={selectedRunId} exactRefresh={linkedHistory && Boolean(selectedRunId)} onViewSaved={viewSavedData} onLatest={onLatest} />}
    </Drawer>
    <details className="group/seo-data border-t border-subtle text-label-14 text-secondary">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-label-14-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 shrink-0 transition-transform group-open/seo-data:rotate-90" aria-hidden="true" />Data details</summary>
      <div className="space-y-4 pb-3 text-label-13">
        <p>Current profile source: {isPublicDemo() ? 'Fictional demo data' : connection?.label ?? 'Source unavailable'}. Google · {deviceLabel(profile.rankings?.device ?? 'unspecified')} · {profile.rankings ? 'Market locations' : `Location ${profile.locationCode}`} · {profile.languageCode}.</p>
        {overview.data?.evidenceRun && <p>Saved evidence: {overview.data.evidenceRun.scope.kind}{overview.data.evidenceRun.scope.key ? ` · ${overview.data.evidenceRun.scope.key}` : ''}{overview.data.evidenceRun.scope.expectedPlanRevision !== undefined ? ` · plan revision ${overview.data.evidenceRun.scope.expectedPlanRevision}` : ''}. {runLocation(overview.data.evidenceRun)} · {overview.data.evidenceRun.languageCode} · profile revision {overview.data.evidenceRun.profileRevision}.</p>}
        <p>These are provider estimates and observed search rankings. Missing values are shown as a dash. Difficulty is a source score out of 100.</p>
        <p>Current profile targets:</p><ul className="space-y-1">{profile.targets.map((target, index) => <li key={index} className="break-words">{target.value} · {target.includeSubdomains ? 'includes subdomains' : 'exact host'}</li>)}</ul>
        {profile.scope.expectedPlanRevision !== undefined && <p>Saved measurement plan revision {profile.scope.expectedPlanRevision}.</p>}
        {overview.data?.summary && <DataProvenance source={overview.data.summary.provenance} />}
      </div>
    </details>
  </div>
}

type SeoChartPoint = { label: string; value: number | null; tick?: string }
const PREVIEW_ROWS = 6
const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const SHORT_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const SEO_TREND_RANGES: ReadonlyArray<{ days: SeoTrendDays; label: string }> = [
  { days: 180, label: '180 days' }, { days: 90, label: '90 days' }, { days: 30, label: '30 days' },
]
const SEO_TREND_METRICS = {
  inTop10: { label: 'In the top 10' },
  organicKeywords: { label: 'Ranked searches' },
  estimatedOrganicTraffic: { label: 'Estimated organic traffic', help: 'Modeled search traffic for this target and geography. Site traffic is measured separately.' },
  page1: { label: 'On page 1', help: 'Non-brand tracked queries with a Google organic position from 1 to 10. Each query is counted separately in each of its markets.' },
  rankOrganic: { label: 'Organic position', help: 'Ranks come from the searches returned in each saved refresh. A gap means this search had no position in that refresh’s saved results.' },
} satisfies Record<SeoTrendMetric, { label: string; help?: string }>

function SeoTrendPanel({ projectName, data, days, metric, keyword, selectionPending, selectionFailed, onRangeChange, onMetricChange, onKeywordChange, refreshing, onLatest }: {
  projectName: string
  data: SeoTrends & { kind: NonNullable<SeoTrends['kind']> }
  days: SeoTrendDays
  metric?: SeoTrendMetric
  keyword?: string
  selectionPending: boolean
  selectionFailed: boolean
  onRangeChange: (days: SeoTrendDays) => void
  onMetricChange: (metric: SeoTrendMetric) => void
  onKeywordChange: (keyword: string) => void
  refreshing: boolean
  onLatest: () => void
}) {
  const isMarket = data.kind === SeoTrendKinds.market
  const isRanked = data.kind === SeoTrendKinds.ranked
  const metrics = SEO_TREND_METRICS_BY_KIND[data.kind]
  const figures: TrendCardFigure[] = metrics.map(key => {
    const latest = data.points.filter(point => point[key] != null).at(-1)
    const value = latest?.[key] ?? null
    return {
      ...SEO_TREND_METRICS[key],
      key,
      value: value === null ? '—' : NUMBER.format(value),
      stateValue: value === null,
      interactive: true,
      change: levelTrendChange(data.changes[key] ?? null, TrendUnits.count),
      series: data.points.map(point => ({ date: point.observedAt, current: point[key] ?? null })),
      formatValue: rank => isRanked ? NUMBER.format(rank) : COMPACT_NUMBER.format(rank),
      formatExact: value => NUMBER.format(value),
      allowDecimals: key === 'estimatedOrganicTraffic',
      reverseValueAxis: isRanked,
    }
  })
  const defaultMetric = metrics.find(key => data.changes[key] != null) ?? metrics.find(key => data.points.some(point => point[key] != null)) ?? metrics[0]!
  const selected = metric && metrics.includes(metric) ? metric : defaultMetric
  const title = isMarket ? 'Google rankings over time' : isRanked ? 'Ranked search trends' : 'Organic search performance'
  const scope = [data.target && targetLabel(data.target), 'Google', isMarket ? 'Market locations' : null, data.languageCode && languageLabel(data.languageCode)].filter(Boolean).join(' · ')
  const selectedKeyword = (selectionPending ? keyword ?? data.keyword : data.keyword) ?? ''
  const choices = data.rankedKeywords ?? []
  const includeSelectedKeyword = selectedKeyword !== '' && !choices.includes(selectedKeyword)
  usePublishAeroView(projectName, {
    view: 'seo', seoProfileId: data.profileId,
    seoTrend: { days: data.days, metric: selected, ...(isRanked && data.keyword ? { keyword: data.keyword } : {}) },
  })
  const first = data.points[0]?.observedAt
  const last = data.points.at(-1)?.observedAt
  const span = first && last && first !== last ? trendSpanLabel({ date: first, observedAt: first }, { date: last, observedAt: last }) : undefined
  const selectedReadings = data.points.filter(point => point[selected] != null)
  const readings = selectedReadings.length
  const lastReading = selectedReadings.at(-1)
  const readingDate = lastReading ? calendarDay(lastReading.observedAt, TIME_ZONE) : null
  const endsWithGap = lastReading && lastReading !== data.points.at(-1)
  const basis = metrics.length > 1 ? sharedLevelBasis(metrics.map(key => ({ change: data.changes[key] ?? null }))) : undefined
  const priorSelection = [isRanked && data.keyword ? `“${data.keyword}”` : null, `${data.days} days`].filter(Boolean).join(' · ')
  const trendNotice = selectionPending ? `${selectionFailed ? 'Showing previous selection' : 'Loading selection. Showing'} ${priorSelection}.` : undefined
  const chartDetails = [
    readingDate && endsWithGap && `Data through ${readingDate}.`,
    span && `Chart dates ${span}.`,
    readings >= 2 && `${NUMBER.format(readings)} comparable refreshes.`,
    readings === 1 && readingDate && !endsWithGap && `Reading from ${readingDate}.`,
    basis && `Change ${basis}.`,
    data.marketQueryCount !== null && `${NUMBER.format(data.marketQueryCount)} non-brand queries across markets.`,
    !isMarket && data.locationCode !== null && `Search location code ${data.locationCode}.`,
  ].filter(Boolean).join(' ')
  const noTrend = readings === 1
    ? days < SEO_TREND_DEFAULT_DAYS ? 'One saved reading in this range. Choose a longer range to see a trend.' : 'One saved reading in this range. Trends appear after another comparable refresh.'
    : days < SEO_TREND_DEFAULT_DAYS ? 'No comparable readings in this range. Choose a longer range.' : 'No comparable readings for this selection.'
  const changeRange = (value: string) => {
    const range = seoTrendDaysSchema.safeParse(Number(value))
    if (range.success) onRangeChange(range.data)
  }

  return <section aria-label={title} className="material-base min-w-0 px-4">
    <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-1 py-2 sm:py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-heading-20 text-heading">{title}</h3>
          {chartDetails && <InfoTooltip placement="bottom" text={`About this chart. ${chartDetails}`} />}
        </div>
        <p className="break-words text-copy-13 text-secondary">{scope}</p>
      </div>
      {isRanked && (choices.length > 0 || selectedKeyword) && <label className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label-13 text-secondary sm:w-auto sm:max-w-96">
        Search to chart
        <select className={`${FIELD} min-w-0 flex-1 sm:min-h-9`} value={selectedKeyword} aria-busy={refreshing} onChange={event => onKeywordChange(event.currentTarget.value)}>
          {keyword && <option value="">Profile default</option>}
          {includeSelectedKeyword && <option value={selectedKeyword}>{selectedKeyword}</option>}
          {choices.map(search => <option key={search} value={search}>{search}</option>)}
        </select>
      </label>}
    </div>
    <div className="border-t border-subtle">
      <TrendCard name={title} groups={[{ key: 'seo', figures, basis }]} selected={[selected]} onSelect={key => { const parsed = seoTrendMetricSchema.safeParse(key); if (parsed.success) onMetricChange(parsed.data) }}
        frame="none" cadence="refresh" compact instants chartHeight={180} minimumReadings={2} showChartData span={span} currentLabel={isRanked && data.keyword ? `“${data.keyword}”` : undefined} hideSpan basisInNotice refreshing={refreshing}
        emptyChartMessage={noTrend} notice={trendNotice}
        controls={<>
          <label className="flex items-center gap-2 text-label-13 text-secondary">Range
            <select className={`${FIELD} min-w-28 sm:min-h-9`} aria-label="SEO trend range" aria-busy={refreshing} value={days} onChange={event => changeRange(event.target.value)}>
              {SEO_TREND_RANGES.map(range => <option key={range.days} value={range.days}>{range.label}</option>)}
            </select>
          </label>
          <Button variant="ghost" size="sm" onClick={onLatest}>Latest rankings<ArrowRight className="size-4" aria-hidden="true" /></Button>
        </>} />
    </div>
  </section>
}

type SeoOverviewPanelProps = {
  projectName: string; profileId: string; data: SeoOverview; active: boolean; canRun: boolean; nextRefresh: string | null; onOpen: (view: SeoView) => void; snapshot?: boolean; historical?: boolean;
}

function SeoOverviewPanel({ snapshot = false, historical = false, ...props }: SeoOverviewPanelProps) {
  const search = useSearch({ strict: false })
  const navigate = useNavigate()
  const days = search.seoTrendDays ?? SEO_TREND_DEFAULT_DAYS
  const keyword = search.seoTrendKeyword
  const metric = search.seoTrendMetric
  const snapshotHeading = useRef<HTMLHeadingElement | null>(null)
  const { data, projectName, profileId, onOpen } = props
  const hasRankingProfile = data.evidenceRun?.capabilities.some(capability => capability === SeoCapabilities['domain-intelligence'] || capability === SeoCapabilities['market-rankings'] || capability === SeoCapabilities['ranked-keywords']) === true
  const trendOptions = getApiV1ProjectsByNameSeoTrendsOptions({ client: heyClient, path: { name: projectName }, query: { profileId, days, keyword } })
  const lastTrend = useRef<SeoTrends | undefined>(undefined)
  const trends = useQuery({
    ...trendOptions,
    enabled: !snapshot && hasRankingProfile,
    placeholderData: keepPreviousData,
  })
  useEffect(() => {
    if (trends.data && !trends.isPlaceholderData) lastTrend.current = trends.data
  }, [trends.data, trends.isPlaceholderData])
  useEffect(() => { if (snapshot) snapshotHeading.current?.focus() }, [snapshot])

  if (snapshot) return <div className="pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 ref={snapshotHeading} tabIndex={-1} className="text-heading-16 text-heading focus:outline-none">Saved rankings and search data</h3>
      {!historical && <Button variant="ghost" size="sm" onClick={() => onOpen('overview')}>Back to overview</Button>}
    </div>
    <SeoSnapshotPanel key={data.evidenceRunId ?? 'empty'} {...props} />
  </div>

  if (!hasRankingProfile) return <SeoSnapshotPanel key={data.evidenceRunId ?? 'empty'} {...props} />
  const trend = trends.data ?? lastTrend.current
  if (trends.error && !trend) return <div className="pt-4"><ReadError error={trends.error} retry={() => { void trends.refetch() }} /></div>
  if (!trend) return <p role="status" className="py-10 text-copy-14 text-secondary">Loading SEO trends…</p>

  const { kind } = trend
  if (!kind) return <SeoSnapshotPanel key={data.evidenceRunId ?? 'empty'} {...props} />
  const hasReadings = trend.hasRankingReadings ?? SEO_TREND_METRICS_BY_KIND[kind].some(key => trend.points.some(point => point[key] != null))
  if (!hasReadings && kind !== SeoTrendKinds.market && !(kind === SeoTrendKinds.ranked && keyword) && (data.keywordMetricsCount > 0 || data.rankedKeywordCount > 0)) {
    return <SeoSnapshotPanel key={data.evidenceRunId ?? 'empty'} {...props} />
  }

  const setTrendSearch = (selection: { seoTrendDays?: SeoTrendDays; seoTrendMetric?: SeoTrendMetric; seoTrendKeyword?: string }) => {
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, ...selection }), replace: true, resetScroll: false })
  }
  return <div className="space-y-3 pt-4">
    <SeoTrendPanel projectName={projectName} data={{ ...trend, kind }} days={days} metric={metric} keyword={keyword}
      selectionPending={trends.isPlaceholderData || !trends.data} selectionFailed={trends.isError}
      refreshing={trends.isFetching} onLatest={() => onOpen('latest-rankings')}
      onRangeChange={range => { setTrendSearch({ seoTrendDays: range }); trackUiFilterChange('window') }}
      onMetricChange={value => { setTrendSearch({ seoTrendMetric: value }); trackUiFilterChange('other') }}
      onKeywordChange={value => { setTrendSearch({ seoTrendKeyword: value || undefined }); trackUiFilterChange('other') }} />
    {trends.error && <ReadError error={trends.error} retry={() => { void trends.refetch() }} />}
  </div>
}

function SeoChart({ title, caption, category, unit, points, view, onOpen, controls, monthAxis = false, rankAxis = false }: {
  title: string; caption: string; category: string; unit: string; points: SeoChartPoint[]; view: SeoCapability;
  onOpen: (view: SeoView) => void; controls?: ReactNode; monthAxis?: boolean; rankAxis?: boolean;
}) {
  const heading = useId()
  const description = useId()
  const values = useId()
  const [showValues, setShowValues] = useState(false)
  // A zero-width mark keeps the category visible for a missing reading. Its label and table still say unavailable.
  const chartRows = points.map(point => ({ ...point, plotted: point.value ?? (rankAxis || monthAxis ? null : 0), display: point.value === null ? '—' : NUMBER.format(point.value) }))
  const ticks = new Map(points.map(point => [point.label, point.tick ?? point.label]))
  const numericTick = (value: number) => COMPACT_NUMBER.format(value)
  const categoryTick = (value: string) => ticks.get(value) ?? value
  const tooltip = <RechartsTooltip {...CHART_TOOLTIP_STYLE} labelFormatter={label => typeof label === 'string' ? label : ''} formatter={(value, _name, item) => {
    const row: unknown = item.payload
    const display = row && typeof row === 'object' && 'display' in row && typeof row.display === 'string' ? row.display : undefined
    return [display ?? (typeof value === 'number' ? NUMBER.format(value) : '—'), unit]
  }} />
  const color = CHART_SERIES_COLORS[1]

  return <section aria-labelledby={heading} className="material-base min-w-0 p-4 sm:p-5">
    <div className="space-y-1">
      <h3 id={heading} className="text-heading-20 text-heading">{title}</h3>
      <p id={description} className="break-words text-copy-13 text-secondary">{caption}</p>
    </div>
    {controls && <div className="mt-3">{controls}</div>}
    <p className="mt-4 text-label-12 text-secondary">{unit}</p>
    <div className="min-w-0 pt-1" aria-hidden="true">
      <ResponsiveContainer width="100%" height={monthAxis ? 220 : points.length * 38 + 34}>
        {monthAxis ? <BarChart data={chartRows} accessibilityLayer={false} margin={{ top: 12, right: 12, bottom: 2, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="label" tick={CHART_AXIS_TICK} tickFormatter={categoryTick} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis tick={CHART_AXIS_TICK} tickFormatter={numericTick} tickLine={false} axisLine={false} allowDecimals={false} width={46} />
          {tooltip}
          <Bar dataKey="plotted" fill={color} maxBarSize={46} minPointSize={1} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart> : <ComposedChart data={chartRows} layout="vertical" accessibilityLayer={false} margin={{ top: 3, right: 58, bottom: 2, left: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} horizontal={false} />
          <YAxis type="category" dataKey="label" tick={CHART_AXIS_TICK} tickFormatter={categoryTick} tickLine={false} axisLine={false} width={view === SeoCapabilities['domain-intelligence'] ? 48 : 112} interval={0} />
          <XAxis type="number" tick={CHART_AXIS_TICK} tickFormatter={(value: number) => rankAxis && value < 1 ? '' : numericTick(value)} tickLine={false} axisLine={false} allowDecimals={false} domain={rankAxis ? [1, 'auto'] : [0, 'auto']} />
          {tooltip}
          {rankAxis
            ? <Line dataKey="plotted" stroke="none" dot={{ r: 5, fill: color, stroke: color }} activeDot={false} isAnimationActive={false}><LabelList dataKey="display" position="right" fill={CHART_AXIS_TICK.fill} fontSize={12} /></Line>
            : <Bar dataKey="plotted" fill={color} barSize={18} minPointSize={1} radius={[0, 3, 3, 0]} isAnimationActive={false}>
              {chartRows.map((row, index) => <Cell key={`${row.label}:${index}`} fill={row.value === null ? 'transparent' : color} />)}
              <LabelList dataKey="display" position="right" fill={CHART_AXIS_TICK.fill} fontSize={12} />
            </Bar>}
        </ComposedChart>}
      </ResponsiveContainer>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-3 border-t border-subtle pt-2">
      <Button variant="ghost" size="sm" aria-expanded={showValues} aria-controls={values} onClick={() => setShowValues(visible => !visible)}>Chart data</Button>
      <Button variant="ghost" size="sm" aria-label={`Open ${CAPABILITY_LABELS[view]}`} onClick={() => onOpen(view)}>{CAPABILITY_LABELS[view]}<ArrowRight className="size-4" aria-hidden="true" /></Button>
    </div>
    <div id={values} className={showValues ? 'mt-3 border-t border-subtle' : 'sr-only'}>
      <table aria-label={title} aria-describedby={description} className="w-full text-label-13">
        <thead className="text-secondary"><tr><th scope="col" className="py-2 text-left">{category}</th><th scope="col" className="py-2 pl-4 text-right">{unit}</th></tr></thead>
        <tbody className="divide-y divide-subtle">{points.map((point, index) => <tr key={`${point.label}:${index}`}><th scope="row" className="break-words py-2 text-left">{point.label}</th><td className="py-2 pl-4 text-right tabular-nums"><Value value={point.value} /></td></tr>)}</tbody>
      </table>
    </div>
  </section>
}

function domainPositions(row: SeoDomainIntelligence): SeoChartPoint[] {
  return [
    { label: '1', value: row.top1 }, { label: '2–3', value: row.top2To3 },
    { label: '4–10', value: row.top4To10 }, { label: '11–20', value: row.top11To20 },
  ]
}

function targetLabel(target: SeoTarget): string {
  return `${target.value} · ${target.includeSubdomains ? 'includes subdomains' : 'exact host'}`
}

function DomainSummary({ summary }: { summary: NonNullable<SeoOverview['summary']> }) {
  return <dl aria-label="Organic search metrics" className="grid gap-x-6 gap-y-3 border-b border-subtle px-1 pb-4 sm:grid-cols-3">
    <div><dt className="text-label-13 text-secondary">Searches you rank for</dt><dd className="mt-1 text-heading-24 tabular-nums text-heading"><Value value={summary.organicKeywords} /></dd></div>
    <div><dt className="text-label-13 text-secondary">In the top 10</dt><dd className="mt-1 text-heading-24 tabular-nums text-heading"><Value value={summary.inTop10} /></dd></div>
    <div><dt className="flex items-center gap-1.5 text-label-13 text-secondary">Estimated organic traffic<InfoTooltip text="Modeled search traffic for this target and provider geography. Site traffic is measured separately." /></dt><dd className="mt-1 text-heading-24 tabular-nums text-heading"><Value value={summary.estimatedOrganicTraffic} /></dd></div>
  </dl>
}

function SeoSnapshotPanel({ projectName, profileId, data, active, canRun, nextRefresh, onOpen }: SeoOverviewPanelProps) {
  const [page, setPage] = useState(1)
  const [searchIndex, setSearchIndex] = useState<number>()
  const args = { client: heyClient, path: { name: projectName }, query: { profileId, runId: data.evidenceRunId ?? undefined } }
  const hasRun = data.evidenceRunId !== null
  const hasMarket = hasRun && data.marketRankingCount > 0
  const hasDomain = hasRun && data.summary !== null
  const market = useQuery({ ...getApiV1ProjectsByNameSeoMarketRankingsSummaryOptions(args), enabled: hasMarket })
  const domains = useQuery({ ...getApiV1ProjectsByNameSeoDomainIntelligenceOptions({ ...args, query: { ...args.query, limit: 20 } }), enabled: hasDomain })
  const target = data.summary?.target
  const domain = target && domains.data?.items.find(row => row.target.kind === target.kind && row.target.value === target.value && row.target.includeSubdomains === target.includeSubdomains)
  const positions = domain ? domainPositions(domain) : []
  const hasPositions = positions.some(point => point.value !== null)
  const readRanked = hasRun && !hasMarket && !hasPositions && (!hasDomain || domains.isSuccess) && data.rankedKeywordCount > 0
  const ranked = useQuery({ ...getApiV1ProjectsByNameSeoRankedKeywordsOptions({ ...args, query: { ...args.query, limit: PREVIEW_ROWS } }), enabled: readRanked })
  const rankedRows = ranked.data?.items ?? []
  const hasRanks = rankedRows.some(row => row.rankOrganic !== null)
  const readDemand = hasRun && !hasMarket && !hasPositions && !hasRanks && (!hasDomain || domains.isSuccess) && (!readRanked || ranked.isSuccess) && data.keywordMetricsCount > 0
  const keywords = useQuery({ ...getApiV1ProjectsByNameSeoKeywordMetricsOptions({ ...args, query: { ...args.query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } }), enabled: readDemand })
  const currentRead = hasMarket ? market : hasDomain && !domains.isSuccess ? domains : readRanked && !ranked.isSuccess ? ranked : readDemand ? keywords : null

  let chart: ReactNode
  if (currentRead?.error) {
    chart = <ReadError error={currentRead.error} retry={() => { void currentRead.refetch() }} />
  } else if (currentRead?.isPending) {
    chart = <p role="status" className="py-10 text-copy-14 text-secondary">Loading SEO overview…</p>
  } else if (hasMarket && market.data) {
    const { totals, depth } = market.data
    chart = <SeoChart title="Google rank across markets" caption={`Non-brand queries · ${marketRankingCoverage(totals)}`} category="Outcome" unit="Queries" points={marketRankingBands(depth, totals).map(band => ({ label: band.label, value: totals[band.count] }))} view={SeoCapabilities['market-rankings']} onOpen={onOpen} />
  } else if (domain && hasPositions) {
    chart = <SeoChart title="Organic positions in the top 20" caption={`${targetLabel(domain.target)} · Google · Location ${domain.provenance.locationCode} · ${domain.provenance.languageCode}`} category="Position" unit="Ranking searches" points={positions} view={SeoCapabilities['domain-intelligence']} onOpen={onOpen} />
  } else if (readRanked && hasRanks) {
    chart = <SeoChart title="Organic positions for saved searches" caption={`First ${rankedRows.length} of ${NUMBER.format(data.rankedKeywordCount)} saved results · Google`} category="Search and target" unit="Organic position" rankAxis view={SeoCapabilities['ranked-keywords']} onOpen={onOpen} points={rankedRows.map(row => ({ label: `${row.keyword} · ${targetLabel(row.target)}`, tick: shortSearch(row.keyword), value: row.rankOrganic }))} />
  } else if (readDemand && keywords.data?.items.length) {
    const rows = keywords.data.items
    const row = (searchIndex !== undefined ? rows[searchIndex] : undefined) ?? rows.find(item => item.monthlySearches.some(month => month.searchVolume !== null)) ?? rows[0]!
    const months = [...row.monthlySearches].sort((a, b) => a.year - b.year || a.month - b.month).map(month => {
      const date = new Date(Date.UTC(month.year, month.month - 1, 1))
      return { label: MONTH_LABEL.format(date), tick: SHORT_MONTH.format(date), value: month.searchVolume }
    })
    const hasMonths = months.some(month => month.value !== null)
    const controls = <>
      <label className="flex w-fit max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-label-13 text-secondary">Search to chart
        <select className={`${FIELD} min-w-0 sm:max-w-96`} value={rows.indexOf(row)} onChange={event => { setSearchIndex(Number(event.target.value)); trackUiFilterChange('other') }}>{rows.map((item, index) => <option key={`${item.keyword}:${index}`} value={index}>{item.keyword}</option>)}</select>
      </label>
      {keywords.data.total > PAGE_SIZE && <DataTablePagination page={page} pageSize={PAGE_SIZE} visibleRows={rows.length} totalRows={keywords.data.total} disabled={keywords.isFetching} itemLabel="searches" onPageChange={next => { setSearchIndex(undefined); setPage(next) }} />}
    </>
    const demandCaption = `${row.keyword} · Google · Location ${row.provenance.locationCode} · ${row.provenance.languageCode}`
    chart = hasMonths
      ? <SeoChart title="Monthly search demand" caption={demandCaption} category="Month" unit="Estimated searches" points={months} monthAxis view={SeoCapabilities['keyword-metrics']} onOpen={onOpen} controls={controls} />
      : row.searchVolume !== null
        ? <SeoChart title="Search demand estimate" caption={demandCaption} category="Search" unit="Estimated monthly searches" points={[{ label: row.keyword, tick: shortSearch(row.keyword), value: row.searchVolume }]} view={SeoCapabilities['keyword-metrics']} onOpen={onOpen} controls={controls} />
        : <div className="material-base p-4 sm:p-5"><h3 className="mb-3 text-heading-20 text-heading">Search demand</h3>{controls}<p className="mt-4 text-copy-14 text-secondary">The source did not report an estimate for this search.</p></div>
  } else {
    const view = EVIDENCE_ORDER.find(capability => data.evidenceRun?.capabilities.includes(capability))
    chart = <div className="material-base">
      <EmptyEvidence title={active ? 'Refresh in progress' : hasRun ? 'No rankings or search demand to chart' : 'No SEO results yet'}>
        {active ? 'Results will appear after the refresh saves data.' : hasRun ? 'Open the saved evidence for this profile.' : nextRefresh ? `First refresh ${nextRefresh}.` : canRun ? 'Refresh this profile to collect its first results.' : 'Results will appear after this profile is refreshed.'}
      </EmptyEvidence>
      {hasRun && view && <div className="pb-4 text-center"><Button variant="secondary" aria-label={`Open ${SEO_VIEW_LABELS[view]}`} onClick={() => onOpen(view)}>{SEO_VIEW_LABELS[view]}<ArrowRight className="size-4" aria-hidden="true" /></Button></div>}
    </div>
  }

  return <div className="space-y-4 pt-4">{chart}{data.summary && <DomainSummary summary={data.summary} />}</div>
}

function shortSearch(value: string): string {
  return value.length > 16 ? `${value.slice(0, 15)}…` : value
}

function SeoEvidence({ projectName, profileId, runId, view, active, nextRefresh }: { projectName: string; profileId: string; runId: string | null; view: SeoCapability; active: boolean; nextRefresh: string | null }) {
  if (view === SeoCapabilities['market-rankings']) {
    return runId
      ? <MarketRankingsView projectName={projectName} profileId={profileId} runId={runId} active={active} />
      : <EmptyEvidence title="No market rankings yet">{nextRefresh ? `First refresh ${nextRefresh}` : 'Refresh this profile to rank its tracked queries in each market.'}</EmptyEvidence>
  }
  return <SeoEvidenceTable projectName={projectName} profileId={profileId} runId={runId} view={view} active={active} />
}

function SeoEvidenceTable({ projectName, profileId, runId, view, active }: { projectName: string; profileId: string; runId: string | null; view: Exclude<SeoCapability, 'market-rankings'>; active: boolean }) {
  const [page, setPage] = useState(1)
  const [gapKind, setGapKind] = useState<SeoKeywordGapKind | ''>('')
  const [competitorSort, setCompetitorSort] = useState<SeoCompetitorSort>()
  const [gapSort, setGapSort] = useState<SeoKeywordGapSort>()
  const args = { client: heyClient, path: { name: projectName }, query: { profileId, runId: runId ?? undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } }
  const ranked = useQuery({ ...getApiV1ProjectsByNameSeoRankedKeywordsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['ranked-keywords'] })
  const keywords = useQuery({ ...getApiV1ProjectsByNameSeoKeywordMetricsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['keyword-metrics'] })
  const domains = useQuery({ ...getApiV1ProjectsByNameSeoDomainIntelligenceOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['domain-intelligence'] })
  const competitors = useQuery({ ...getApiV1ProjectsByNameSeoCompetitorsOptions({ ...args, query: { ...args.query, sort: competitorSort } }), placeholderData: keepPreviousData, enabled: Boolean(runId) && view === SeoCapabilities['competitor-discovery'] })
  const gaps = useQuery({ ...getApiV1ProjectsByNameSeoKeywordGapsOptions({ ...args, query: { ...args.query, kind: gapKind || undefined, sort: gapSort } }), placeholderData: keepPreviousData, enabled: Boolean(runId) && view === SeoCapabilities['keyword-gaps'] })
  const selected = view === SeoCapabilities['ranked-keywords'] ? ranked : view === SeoCapabilities['keyword-metrics'] ? keywords
    : view === SeoCapabilities['competitor-discovery'] ? competitors : view === SeoCapabilities['keyword-gaps'] ? gaps : domains
  if (!runId) return <EmptyEvidence title="No saved data yet">Refresh this profile to collect {CAPABILITY_LABELS[view].toLowerCase()} for its saved scope.</EmptyEvidence>
  return <div className="space-y-3 pt-4">
    {view === SeoCapabilities['keyword-gaps'] && <div className="flex items-center gap-3">
      <label className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-label-14"><span>Comparison</span><select className={`${FIELD} w-auto max-w-full`} value={gapKind} onChange={event => { setGapKind(event.target.value as SeoKeywordGapKind | ''); setPage(1) }}><option value="">All comparisons</option><option value={SeoKeywordGapKinds.missing}>Missing</option><option value={SeoKeywordGapKinds.shared}>Shared</option><option value={SeoKeywordGapKinds.outranked}>Competitor ahead</option></select></label>
      <InfoTooltip placement="bottom" text="Missing: the source lists the search for the competitor but not your domain. Shared includes searches where the competitor ranks higher. These are bounded observations from the source’s organic search database, not a live check of every Google result." />
    </div>}
    {view === SeoCapabilities['competitor-discovery'] && <p className="flex items-center gap-1.5 text-label-13 text-secondary">Domains sharing organic searches<InfoTooltip text="Discovery uses this profile’s whole domains, location and language. Suggested domains are not automatically added to tracked competitors. Counts describe the source’s database; the table is limited to this refresh’s saved results." /></p>}
    {selected.error ? <ReadError error={selected.error} retry={() => { void selected.refetch() }} />
      : !selected.data ? <p role="status" className="py-8 text-label-14 text-secondary">Loading {CAPABILITY_LABELS[view].toLowerCase()}…</p>
        : selected.data.items.length === 0 ? <EmptyEvidence title={active ? 'Refresh in progress' : gapKind ? 'No matching comparisons' : 'No results returned'}>{active ? 'This profile is collecting data.' : gapKind ? 'Choose another comparison filter to see the remaining saved results.' : 'The source did not return records for this scope. Review the refresh in Refresh history.'}</EmptyEvidence>
          : <>
      <div className="relative overflow-x-auto material-base" role="region" aria-label={`${CAPABILITY_LABELS[view]} table`} aria-busy={selected.isFetching} tabIndex={0}>
      {view === SeoCapabilities['ranked-keywords'] && ranked.data && <RankedTable rows={ranked.data.items} />}
      {view === SeoCapabilities['keyword-metrics'] && keywords.data && <KeywordTable rows={keywords.data.items} />}
      {view === SeoCapabilities['domain-intelligence'] && domains.data && <DomainTable rows={domains.data.items} />}
      {view === SeoCapabilities['competitor-discovery'] && competitors.data && <CompetitorTable rows={competitors.data.items} sort={competitorSort} onSort={sort => { setCompetitorSort(sort); setPage(1) }} />}
      {view === SeoCapabilities['keyword-gaps'] && gaps.data && <KeywordGapTable rows={gaps.data.items} sort={gapSort} onSort={sort => { setGapSort(sort); setPage(1) }} />}
    </div>
    <DataTablePagination page={page} pageSize={PAGE_SIZE} visibleRows={selected.data.items.length} totalRows={selected.data.total} onPageChange={setPage} disabled={selected.isFetching} className="text-label-13 [&_button]:min-h-11" />
    </>}
  </div>
}

function RankGap({ value }: { value: number | null }) {
  return value === null ? <Value value={null} /> : <>{value > 0 ? '+' : ''}{NUMBER.format(value)}</>
}

function EvidenceSortHeader<T extends SeoCompetitorSort | SeoKeywordGapSort>({ label, sort, ascending, descending, align = 'right', onSort, help }: { label: string; sort: T | undefined; ascending: T; descending: T; align?: 'left' | 'right'; onSort: (sort: T) => void; help?: string }) {
  return <SortHeader label={label} align={align} sorted={sort === ascending ? 'ascending' : sort === descending ? 'descending' : null} onSort={() => onSort(sort === ascending ? descending : ascending)} help={help} showUnsorted />
}

function CompetitorTable({ rows, sort, onSort }: { rows: SeoCompetitor[]; sort: SeoCompetitorSort | undefined; onSort: (sort: SeoCompetitorSort) => void }) {
  return <table className="w-full text-label-14"><caption className="sr-only">Organic competitors, from the selected refresh</caption><thead className="bg-surface text-label-13 text-secondary"><tr>
    <EvidenceSortHeader label="Competitor" align="left" sort={sort} ascending={SeoCompetitorSorts.domain} descending={SeoCompetitorSorts['-domain']} onSort={onSort} />
    <EvidenceSortHeader label="Shared searches" sort={sort} ascending={SeoCompetitorSorts.shared} descending={SeoCompetitorSorts['-shared']} onSort={onSort} />
    <EvidenceSortHeader label="Avg. position" sort={sort} ascending={SeoCompetitorSorts.position} descending={SeoCompetitorSorts['-position']} onSort={onSort} />
    <EvidenceSortHeader label="Est. organic traffic" sort={sort} ascending={SeoCompetitorSorts.traffic} descending={SeoCompetitorSorts['-traffic']} onSort={onSort} />
    <th className="px-4"><span className="sr-only">Evidence</span></th>
  </tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${row.domain}:${index}`}>
    <th scope="row" className={ROW_HEADER}><p className="text-primary">{row.domain}</p><p className="mt-1 text-label-13 text-secondary">Compared with {row.target.value}</p></th>
    <td className={CELL}><Value value={row.sharedKeywords} /></td><td className={CELL}><Value value={row.averagePosition} /></td><td className={CELL}><Value value={row.estimatedOrganicTraffic} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={row.domain} source={row.provenance}><p>Average position covers shared searches. Traffic covers the competitor’s whole domain.</p><p>Competitor’s ranked searches: <Value value={row.organicKeywords} /></p><p>Target: {row.target.value} · includes subdomains</p></EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function KeywordGapTable({ rows, sort, onSort }: { rows: SeoKeywordGap[]; sort: SeoKeywordGapSort | undefined; onSort: (sort: SeoKeywordGapSort) => void }) {
  return <table className="w-full text-label-14"><caption className="sr-only">Search gaps, from the selected refresh</caption><thead className="bg-surface text-label-13 text-secondary"><tr>
    <EvidenceSortHeader label="Search" align="left" sort={sort} ascending={SeoKeywordGapSorts.keyword} descending={SeoKeywordGapSorts['-keyword']} onSort={onSort} />
    <EvidenceSortHeader label="Comparison" align="left" sort={sort} ascending={SeoKeywordGapSorts.kind} descending={SeoKeywordGapSorts['-kind']} onSort={onSort} />
    <EvidenceSortHeader label="Your rank" sort={sort} ascending={SeoKeywordGapSorts['target-rank']} descending={SeoKeywordGapSorts['-target-rank']} onSort={onSort} />
    <EvidenceSortHeader label="Competitor rank" sort={sort} ascending={SeoKeywordGapSorts['competitor-rank']} descending={SeoKeywordGapSorts['-competitor-rank']} onSort={onSort} />
    <EvidenceSortHeader label="Rank gap" sort={sort} ascending={SeoKeywordGapSorts['rank-gap']} descending={SeoKeywordGapSorts['-rank-gap']} onSort={onSort} help={RANK_GAP_HELP} />
    <EvidenceSortHeader label="Monthly searches" sort={sort} ascending={SeoKeywordGapSorts.volume} descending={SeoKeywordGapSorts['-volume']} onSort={onSort} />
    <th className="px-4"><span className="sr-only">Evidence</span></th>
  </tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${row.competitor.value}:${row.keyword}:${index}`}>
    <th scope="row" className={ROW_HEADER}><p className="text-primary">{row.keyword}</p><p className="mt-1 text-label-13 text-secondary">{row.target.value} · {row.competitor.value}</p></th>
    <td className="px-4 py-3 align-top"><ToneBadge tone={row.kind === SeoKeywordGapKinds.shared ? 'neutral' : 'caution'}>{GAP_LABELS[row.kind]}</ToneBadge></td>
    <td className={CELL}>{row.kind === SeoKeywordGapKinds.missing ? <span className="text-secondary">Not found</span> : <Value value={row.targetRankOrganic} />}</td><td className={CELL}><Value value={row.competitorRankOrganic} /></td><td className={CELL}><RankGap value={row.rankGap} /></td><td className={CELL}><Value value={row.searchVolume} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={`${row.keyword} against ${row.competitor.value}`} source={row.provenance}><p>Your ranking page: {row.targetUrl ? <SourceLink url={row.targetUrl} /> : 'Not supplied'}</p><p>Competitor’s ranking page: {row.competitorUrl ? <SourceLink url={row.competitorUrl} /> : 'Not supplied'}</p><p>Difficulty /100: <Value value={row.keywordDifficulty} /></p><p>CPC: <Value value={row.cpcUsd} currency /></p></EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function RankedTable({ rows }: { rows: SeoRankedKeyword[] }) {
  return <table className="w-full text-label-14"><caption className="sr-only">Searches you rank for, from the selected refresh</caption><thead className="bg-surface text-label-13 text-secondary"><tr><th className="px-4 py-3 text-left text-label-13-strong">Search</th><th className={`${CELL} text-label-13-strong`}>Position</th><th className={`${CELL} text-label-13-strong`}>Monthly searches</th><th className={`${CELL} text-label-13-strong`}>Est. traffic</th><th className={`${CELL} text-label-13-strong`}>Difficulty /100</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${row.keyword}:${index}`}>
    <th scope="row" className={ROW_HEADER}><p className="text-primary">{row.keyword}</p><p className="mt-1 text-copy-13 text-secondary"><MiddleTruncatedText value={row.url ?? row.target.value} /></p></th>
    <td className={CELL}><Value value={row.rankOrganic} /></td><td className={CELL}><Value value={row.searchVolume} /></td><td className={CELL}><Value value={row.estimatedTraffic} /></td><td className={CELL}><Value value={row.keywordDifficulty} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={row.keyword} source={row.provenance}><p className="break-all">{row.url ?? 'Ranking URL not supplied'}</p><p>Target: {row.target.value} · {row.target.includeSubdomains ? 'includes subdomains' : 'exact host'}</p><p>{PAGE_POSITION}: <Value value={row.rankAbsolute} /></p><p>CPC: <Value value={row.cpcUsd} currency /></p><p>Results page features: {row.serpFeatures.length ? row.serpFeatures.map(feature => feature.replaceAll('_', ' ')).join(', ') : 'Not supplied'}</p></EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function KeywordTable({ rows }: { rows: SeoKeywordMetrics[] }) {
  return <table className="w-full text-label-14"><caption className="sr-only">Search demand from the selected refresh</caption><thead className="bg-surface text-label-13 text-secondary"><tr><th className="px-4 py-3 text-left text-label-13-strong">Search</th><th className={`${CELL} text-label-13-strong`}>Monthly searches</th><th className={`${CELL} text-label-13-strong`}>CPC</th><th className={`${CELL} text-label-13-strong`}>Difficulty /100</th><th className="px-4 py-3 text-left text-label-13-strong">Intent</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.keyword}:${index}`}>
    <th scope="row" className={`${ROW_HEADER} text-primary`}>{row.keyword}</th><td className={CELL}><Value value={row.searchVolume} /></td><td className={CELL}><Value value={row.cpcUsd} currency /></td><td className={CELL}><Value value={row.keywordDifficulty} /></td><td className="px-4 py-3 align-top">{row.searchIntent ?? 'Not supplied'}</td>
    <td className="px-4 align-top"><EvidenceDetails label={row.keyword} source={row.provenance}><p>Ad competition: {row.adCompetition === null ? 'Not supplied' : formatPercent(row.adCompetition, RatioUnits.fraction)}</p><p>Core search: {row.coreKeyword ?? 'Not supplied'}</p>{row.monthlySearches.length > 0 && <dl>{row.monthlySearches.map(month => <div key={`${month.year}-${month.month}`} className="flex justify-between gap-5"><dt>{month.year}-{String(month.month).padStart(2, '0')}</dt><dd><Value value={month.searchVolume} /></dd></div>)}</dl>}</EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function DomainTable({ rows }: { rows: SeoDomainIntelligence[] }) {
  return <table className="w-full text-label-14"><caption className="sr-only">Domain comparison from the selected refresh</caption><thead className="bg-surface text-label-13 text-secondary"><tr><th className="px-4 py-3 text-left text-label-13-strong">Domain</th><th className={`${CELL} text-label-13-strong`}>Searches ranked for</th><th className={`${CELL} text-label-13-strong`}>Est. organic traffic</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${index}`}>
    <th scope="row" className={ROW_HEADER}><p className="text-primary">{row.target.value}</p><p className="mt-1 text-copy-13 text-secondary">{row.target.includeSubdomains ? 'Includes subdomains' : 'Exact host'}</p></th><td className={CELL}><Value value={row.organicKeywords} /></td><td className={CELL}><Value value={row.estimatedOrganicTraffic} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={row.target.value} source={row.provenance}><dl className="grid grid-cols-2 gap-2"><dt>Position 1</dt><dd><Value value={row.top1} /></dd><dt>Positions 2–3</dt><dd><Value value={row.top2To3} /></dd><dt>Positions 4–10</dt><dd><Value value={row.top4To10} /></dd><dt>Positions 11–20</dt><dd><Value value={row.top11To20} /></dd><dt>Est. traffic value</dt><dd><Value value={row.estimatedOrganicTrafficValueUsd} currency /></dd></dl></EvidenceDetails></td>
  </tr>)}</tbody></table>
}

const GROUP_PAGE_SIZE = 5
const QUERY_PAGE_SIZE = 10
const SHOW_ALL = 'all'
/** A queries filter: one outcome filter, or every row. */
type MarketShow = SeoMarketRankingFilter | typeof SHOW_ALL
/** Market-rankings URL state: the region or market open, and the queries' filter, order and search. */
interface MarketSearch { seoRegion?: string; seoMarket?: string; seoShow?: string; seoSort?: string; seoQ?: string }
/** A Show choice from the URL, or null for the scope's default (an unknown value counts as none). */
function parseShow(value: string | undefined): MarketShow | null {
  if (value === SHOW_ALL) return SHOW_ALL
  return seoMarketRankingFilterSchema.safeParse(value).data ?? null
}
type GroupColumn = 'label' | 'queries' | MarketRankingBand['count'] | 'rivalAhead'
interface GroupOrder { column: GroupColumn; descending: boolean }
/** The order the API returns groups in, led by the most queries ranking 11-20. */
const API_GROUP_ORDER: GroupOrder = { column: 'ranks11To20', descending: true }
const TILE_COLUMNS: Record<number, string> = { 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5' }
const SORT_BUTTON = 'inline-flex min-h-11 cursor-pointer select-none items-center rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const CRUMB_LINK = 'inline-flex min-h-11 items-center rounded-sm text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'

/** What a rank band counts, in plain words. */
function bandHelp(band: MarketRankingBand, depth: number | null): string {
  switch (band.count) {
    case 'page1': return 'Google rank 1 to 10.'
    case 'ranks11To20': return 'Google rank 11 to 20: the closest to page 1.'
    case 'ranks21Plus': return depth !== null && depth > 21 ? `Google rank 21 to ${depth}.` : 'Google rank 21 or deeper.'
    case 'notRanked': return depth === null
      ? 'Searched, and the site is not in the results checked.'
      : `Searched, and the site is not in the top ${depth} results. A search that returned only part of them counts as partly checked instead.`
    default: {
      const unknown: never = band.count
      return unknown
    }
  }
}

function rivalHelp(depth: number | null): string {
  return `Overlaps the figures beside it: queries where a tracked competitor ranks above the site, or ranks while the site is not in ${depth === null ? 'the results' : `the top ${depth}`}.`
}

/** What the groups under a scope are: regions (a metro, say), markets, or both at the top level. */
function groupNoun(groups: SeoMarketRankingGroup[]): { label: string; plural: string } {
  const regions = groups.filter(group => group.kind === SeoMarketRankingGroupKinds.region).length
  if (regions === groups.length) return { label: 'Region', plural: 'regions' }
  return regions === 0 ? { label: 'Market', plural: 'markets' } : { label: 'Region or market', plural: 'regions and markets' }
}

function groupCount(group: SeoMarketRankingGroup, column: Exclude<GroupColumn, 'label'>): number {
  return group.counts[column]
}

function compareGroups(order: GroupOrder): (a: SeoMarketRankingGroup, b: SeoMarketRankingGroup) => number {
  const direction = order.descending ? -1 : 1
  const column = order.column
  if (column === 'label') return (a, b) => direction * (compareText(a.label, b.label) || compareText(a.key, b.key))
  return (a, b) => direction * (groupCount(a, column) - groupCount(b, column)) || compareText(a.label, b.label) || compareText(a.key, b.key)
}

/** The text a search box settles on once typing pauses, so each keystroke is not a request. Clearing the box applies at once. */
function useSettledText(value: string, delayMs = 250): string {
  const [settled, setSettled] = useState(value)
  const cleared = value.trim() === ''
  useEffect(() => {
    if (cleared) { setSettled(''); return }
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [cleared, value, delayMs])
  return cleared ? '' : settled
}

function SortHeader({ label, align, sorted, onSort, help, showUnsorted = false }: { label: string; align: 'left' | 'right'; sorted: 'ascending' | 'descending' | null; onSort: () => void; help?: string; showUnsorted?: boolean }) {
  return <th scope="col" aria-sort={sorted ?? undefined} className={`px-4 text-label-14-strong whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    <span className="inline-flex items-center gap-1"><button type="button" onClick={onSort} className={`${SORT_BUTTON} ${sorted ? 'text-primary' : ''}`}>{label}{(sorted || showUnsorted) && <span aria-hidden="true" className="ml-0.5">{sorted === 'ascending' ? '↑' : sorted === 'descending' ? '↓' : '↕'}</span>}</button>{help && <InfoTooltip text={help} />}</span>
  </th>
}

/**
 * Market rankings by outcome: how many tracked queries rank on page 1, close to it, deeper, or
 * not at all, by region and market, then the queries themselves. Every count, filter and order
 * comes from the API; the view drills into a region or market through the URL.
 */
function MarketRankingsView({ projectName, profileId, runId, active }: { projectName: string; profileId: string; runId: string; active: boolean }) {
  const search = useSearch({ strict: false }) as MarketSearch
  const navigate = useNavigate()
  const regionKey = search.seoRegion
  const marketKey = search.seoMarket
  // The investigation lives in the URL, so a reload or a shared link reopens it.
  const chosenShow = parseShow(search.seoShow)
  const sort = seoMarketRankingSortSchema.safeParse(search.seoSort).data ?? SeoMarketRankingSorts.rank
  const setInvestigation = (patch: Pick<MarketSearch, 'seoShow' | 'seoSort' | 'seoQ'>) => {
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, ...patch }), replace: true })
  }
  const figuresHeading = useId()
  const summary = useQuery(getApiV1ProjectsByNameSeoMarketRankingsSummaryOptions({ client: heyClient, path: { name: projectName }, query: { profileId, runId, regionKey, marketKey } }))
  if (summary.error) return <div className="py-4"><ReadError error={summary.error} retry={() => { void summary.refetch() }} /></div>
  if (!summary.data) return <p role="status" className="py-8 text-copy-14 text-secondary">Loading market rankings…</p>
  const { totals, depth, groups } = summary.data
  const scopeKey = `${regionKey ?? ''}\u0000${marketKey ?? ''}`
  const scoped = regionKey !== undefined || marketKey !== undefined
  const trail = scoped && <MarketScopeTrail projectName={projectName} regionKey={regionKey} marketKey={marketKey} regionLabel={summary.data.regionLabel} marketLabel={summary.data.marketLabel} />
  if (totals.queries === 0) {
    return <div className="pt-4">{trail}{scoped
      ? <EmptyEvidence title="No rankings here">This refresh has no rankings for this {marketKey !== undefined ? 'market' : 'region'}.</EmptyEvidence>
      : <EmptyEvidence title={active ? 'Refresh in progress' : 'No results returned'}>{active ? 'This profile is collecting data.' : 'The source did not return records for this scope. Review the refresh in Refresh history.'}</EmptyEvidence>}</div>
  }
  const bands = marketRankingBands(depth, totals)
  // Needs work leads; a scope with nothing off page 1 opens on every query instead of an empty list.
  const show: MarketShow = chosenShow ?? (totals.needsWork > 0 ? SeoMarketRankingFilters['needs-work'] : SHOW_ALL)
  // One region holds markets worth opening; a lone market would only repeat the queries below.
  const showGroups = groups.length > 1 || groups.some(group => group.kind === SeoMarketRankingGroupKinds.region)
  return <div className="space-y-6 pt-4">
    {trail}
    <section aria-labelledby={figuresHeading} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 id={figuresHeading} className="text-heading-16 text-heading">Google rank</h3>
        <p className="text-copy-13 tabular-nums text-secondary">{marketRankingCoverage(totals)}</p>
      </div>
      <dl className={`grid grid-cols-2 gap-5 border-b border-subtle pb-5 ${TILE_COLUMNS[bands.length + 1] ?? 'sm:grid-cols-5'}`}>
        {bands.map(band => <RankTile key={band.count} label={band.label} help={bandHelp(band, depth)} value={totals[band.count]} />)}
        {/* Set apart: it overlaps the rank figures rather than adding to them. */}
        <RankTile label="Rival ahead" help={rivalHelp(depth)} value={totals.rivalAhead} className="sm:border-l sm:border-subtle sm:pl-5" />
      </dl>
    </section>
    {showGroups && <MarketGroups key={`groups\u0000${scopeKey}`} projectName={projectName} groups={groups} bands={bands} />}
    <MarketQueries
      key={`queries\u0000${scopeKey}`} projectName={projectName} profileId={profileId} runId={runId} regionKey={regionKey} marketKey={marketKey}
      totals={totals} bands={bands} depth={depth} show={show} onShow={next => setInvestigation({ seoShow: next })}
      sort={sort} onSort={next => setInvestigation({ seoSort: next === SeoMarketRankingSorts.rank ? undefined : next })}
      urlQ={search.seoQ ?? ''} onQ={q => setInvestigation({ seoQ: q || undefined })}
      onClear={() => setInvestigation({ seoShow: SHOW_ALL, seoQ: undefined })}
    />
  </div>
}

function marketRankingCoverage(totals: SeoMarketRankingCounts): string {
  return [
    `${NUMBER.format(totals.queries)} ${totals.queries === 1 ? 'query' : 'queries'}`,
    ...(totals.partlyChecked > 0 ? [`${NUMBER.format(totals.partlyChecked)} partly checked`] : []),
    ...(totals.failed > 0 ? [`${NUMBER.format(totals.failed)} failed`] : []),
    ...(totals.cancelled > 0 ? [`${NUMBER.format(totals.cancelled)} not searched`] : []),
  ].join(' · ')
}

function RankTile({ label, help, value, className }: { label: string; help: string; value: number; className?: string }) {
  return <div className={className}>
    <dt className="flex items-center gap-1.5 text-label-13 text-secondary">{label}<InfoTooltip text={help} placement="bottom" /></dt>
    <dd className="mt-2 text-heading-32 tabular-nums text-heading">{NUMBER.format(value)}</dd>
  </div>
}

/** Where the view is: every market, one region, or one market, each step a link back up. */
function MarketScopeTrail({ projectName, regionKey, marketKey, regionLabel, marketLabel }: { projectName: string; regionKey?: string; marketKey?: string; regionLabel: string | null; marketLabel: string | null }) {
  const region = regionLabel ?? 'Region not in this refresh'
  return <nav aria-label="Market rankings scope" className="flex flex-wrap items-center gap-x-2 text-label-14">
    <Link to="/projects/$projectName/seo-data" params={{ projectName }} search={previous => ({ ...previous, seoView: SeoCapabilities['market-rankings'], seoRegion: undefined, seoMarket: undefined })} className={CRUMB_LINK}>All markets</Link>
    {regionKey !== undefined && <><span aria-hidden="true" className="text-muted">/</span>{marketKey !== undefined
      ? <Link to="/projects/$projectName/seo-data" params={{ projectName }} search={previous => ({ ...previous, seoMarket: undefined })} className={CRUMB_LINK}>{region}</Link>
      : <span aria-current="page" className="text-label-14-strong text-primary">{region}</span>}</>}
    {marketKey !== undefined && <><span aria-hidden="true" className="text-muted">/</span><span aria-current="page" className="text-label-14-strong text-primary">{marketLabel ?? 'Market not in this refresh'}</span></>}
  </nav>
}

/** The regions or markets under the scope, five at a time, each one a way in. */
function MarketGroups({ projectName, groups, bands }: { projectName: string; groups: SeoMarketRankingGroup[]; bands: MarketRankingBand[] }) {
  const navigate = useNavigate()
  const [order, setOrder] = useState<GroupOrder | null>(null)
  const [page, setPage] = useState(1)
  const noun = groupNoun(groups)
  const sorted = order === null ? groups : [...groups].sort(compareGroups(order))
  const visible = sorted.slice((page - 1) * GROUP_PAGE_SIZE, page * GROUP_PAGE_SIZE)
  // Until a header is chosen, the API's order shows on the column that leads it.
  const shown = order ?? (bands.some(band => band.count === API_GROUP_ORDER.column) ? API_GROUP_ORDER : null)
  const columns: { column: Exclude<GroupColumn, 'label'>; label: string }[] = [
    { column: 'queries', label: 'Queries' },
    ...bands.map(band => ({ column: band.count, label: band.label })),
    { column: 'rivalAhead', label: 'Rival ahead' },
  ]
  const sortBy = (column: GroupColumn) => {
    const current = order ?? API_GROUP_ORDER
    setOrder(current.column === column ? { column, descending: !current.descending } : { column, descending: column !== 'label' })
    setPage(1)
  }
  const sortedState = (column: GroupColumn) => shown?.column === column ? shown.descending ? 'descending' : 'ascending' : null
  const into = (group: SeoMarketRankingGroup) => group.kind === SeoMarketRankingGroupKinds.region
    ? (previous: Record<string, unknown>) => ({ ...previous, seoRegion: group.key, seoMarket: undefined })
    : (previous: Record<string, unknown>) => ({ ...previous, seoMarket: group.key })
  const label = `Google rank by ${noun.label.toLowerCase()}`
  return <div className="space-y-3">
    <h3 className="text-heading-16 text-heading">By {noun.label.toLowerCase()}</h3>
    <div className="relative overflow-x-auto rounded-md border border-default" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full text-label-14">
        <caption className="sr-only">{label}</caption>
        <thead className="bg-surface text-label-13 text-secondary"><tr>
          <SortHeader label={noun.label} align="left" sorted={sortedState('label')} onSort={() => sortBy('label')} />
          {columns.map(column => <SortHeader key={column.column} label={column.label} align="right" sorted={sortedState(column.column)} onSort={() => sortBy(column.column)} />)}
          <th className="px-4"><span className="sr-only">Open</span></th>
        </tr></thead>
        <tbody className="divide-y divide-subtle">{visible.map(group => <tr
          key={`${group.kind}:${group.key}`}
          className="cursor-pointer hover:bg-surface-hover"
          onClick={event => {
            if ((event.target as HTMLElement).closest('a, button')) return
            void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: into(group) })
          }}
        >
          <th scope="row" className="min-w-36 px-4 py-3 text-left align-top text-label-14"><Link to="/projects/$projectName/seo-data" params={{ projectName }} search={into(group)} className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">{group.label}</Link></th>
          {columns.map(column => <td key={column.column} className={CELL}>{NUMBER.format(group.counts[column.column])}</td>)}
          <td className="px-4 py-3 text-right align-top"><ChevronRight aria-hidden="true" className="ml-auto size-4 text-muted" /></td>
        </tr>)}</tbody>
      </table>
    </div>
    <DataTablePagination page={page} pageSize={GROUP_PAGE_SIZE} visibleRows={visible.length} totalRows={groups.length} onPageChange={setPage} itemLabel={noun.plural} className="text-label-13 [&_button]:min-h-11" />
  </div>
}

/** The queries in the scope, filtered by outcome and text and ordered by the API, ten at a time. */
function MarketQueries({ projectName, profileId, runId, regionKey, marketKey, totals, bands, depth, show, onShow, sort, onSort, urlQ, onQ, onClear }: {
  projectName: string; profileId: string; runId: string; regionKey?: string; marketKey?: string
  totals: SeoMarketRankingCounts; bands: MarketRankingBand[]; depth: number | null
  show: MarketShow; onShow: (show: MarketShow) => void
  sort: SeoMarketRankingSort; onSort: (sort: SeoMarketRankingSort) => void
  /** The search saved in the URL, how to save a settled one, and how to clear the filter and search in one step. */
  urlQ: string; onQ: (q: string) => void; onClear: () => void
}) {
  const helpId = useId()
  const [searchText, setSearchText] = useState(urlQ)
  const q = useSettledText(searchText).trim().slice(0, 200)
  // The search last written to (or read from) the URL. Saving only a newly settled one keeps each change to a
  // single URL update: two in a row would build the second from the URL before the first.
  const savedQ = useRef(urlQ)
  useEffect(() => {
    if (q === savedQ.current) return
    savedQ.current = q
    onQ(q)
  }, [q])
  // A new filter, order or search starts again at the first page, including one that returns to an earlier filter.
  const filterKey = `${show}\u0000${sort}\u0000${q}`
  const [paging, setPaging] = useState({ filterKey, page: 1 })
  if (paging.filterKey !== filterKey) setPaging({ filterKey, page: 1 })
  const page = paging.filterKey === filterKey ? paging.page : 1
  const rows = useQuery({
    ...getApiV1ProjectsByNameSeoMarketRankingsOptions({ client: heyClient, path: { name: projectName }, query: {
      profileId, runId, regionKey, marketKey, outcome: show === SHOW_ALL ? undefined : show, q: q || undefined, sort,
      limit: QUERY_PAGE_SIZE, offset: (page - 1) * QUERY_PAGE_SIZE,
    } }),
    placeholderData: keepPreviousData,
  })
  const options: { value: MarketShow; label: string; count: number }[] = [
    { value: SeoMarketRankingFilters['needs-work'], label: 'Needs work', count: totals.needsWork },
    ...bands.map(band => ({ value: band.filter, label: band.label, count: totals[band.count] })),
    { value: SeoMarketRankingFilters['rival-ahead'], label: 'Rival ahead', count: totals.rivalAhead },
    { value: SeoMarketRankingFilters['partly-checked'], label: 'Partly checked', count: totals.partlyChecked },
    { value: SeoMarketRankingFilters.failed, label: 'Failed', count: totals.failed },
    { value: SeoMarketRankingFilters.cancelled, label: 'Not searched', count: totals.cancelled },
    { value: SHOW_ALL, label: 'All', count: totals.queries },
  ]
  // Searches with an incomplete or no result are offered only when there are some, or when one is the current choice.
  const occasional: MarketShow[] = [SeoMarketRankingFilters['partly-checked'], SeoMarketRankingFilters.failed, SeoMarketRankingFilters.cancelled]
  const offered = options.filter(option => option.value === show || option.count > 0 || !occasional.includes(option.value))
  const showLabel = offered.find(option => option.value === show)?.label ?? 'All'
  const rankSort = sort === SeoMarketRankingSorts.rank ? 'ascending' : sort === SeoMarketRankingSorts['-rank'] ? 'descending' : null
  const querySort = sort === SeoMarketRankingSorts.query ? 'ascending' : sort === SeoMarketRankingSorts['-query'] ? 'descending' : null
  const items = rows.data?.items ?? []
  const outside = depth === null ? 'not ranked' : `not in the top ${depth}`
  // One settled sentence for screen readers: the count after a filter or search, never each keystroke.
  const result = !rows.data || rows.isPlaceholderData ? null
    : rows.data.total === 0 ? 'No queries match' : `${NUMBER.format(rows.data.total)} ${rows.data.total === 1 ? 'query' : 'queries'}: ${showLabel}`
  const clearFilters = () => {
    savedQ.current = ''
    setSearchText('')
    onClear()
  }
  return <div className="space-y-3">
    <div className="flex items-center gap-1.5">
      <h3 className="text-heading-16 text-heading" id={helpId}>Queries</h3>
      <InfoTooltip placement="bottom" text={`Needs work: queries ranking 11 or deeper, ${outside}, or partly checked. Rival ahead: a tracked competitor ranks above the site.`} />
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-0 items-center gap-3"><span className="text-label-13 text-secondary">Ranking filter</span>
        <select value={show} onChange={event => onShow(event.target.value as MarketShow)} className={`${FIELD} min-w-0 sm:w-56`}>
          {offered.map(option => <option key={option.value} value={option.value}>{option.label} ({NUMBER.format(option.count)})</option>)}
        </select>
      </label>
      <DataTableSearch value={searchText} onChange={setSearchText} label="Find a query" placeholder="Find a query" className="min-w-48 flex-1 sm:max-w-xs [&_input]:h-11" />
    </div>
    <p role="status" className="sr-only">{result}</p>
    {rows.error ? <ReadError error={rows.error} retry={() => { void rows.refetch() }} />
      : !rows.data ? <p className="py-8 text-copy-14 text-secondary">Loading queries…</p>
        : rows.data.total === 0 ? <div className="py-12 text-center">
          <h4 className="text-heading-14 text-heading">No queries match</h4>
          <Button variant="secondary" className="mt-4 pointer-coarse:min-h-11" onClick={clearFilters}>Clear filters</Button>
        </div>
          : <>
            <div className={`relative overflow-x-auto rounded-md border border-default ${rows.isPlaceholderData ? 'opacity-60' : ''}`} role="region" aria-label="Queries" aria-busy={rows.isPlaceholderData} tabIndex={0}>
              <table className="w-full text-label-14">
                <caption className="sr-only">Queries: {showLabel}</caption>
                <thead className="bg-surface text-label-13 text-secondary"><tr>
                  <SortHeader label="Query" align="left" sorted={querySort} onSort={() => onSort(sort === SeoMarketRankingSorts.query ? SeoMarketRankingSorts['-query'] : SeoMarketRankingSorts.query)} />
                  <SortHeader label="Google rank" align="right" sorted={rankSort} onSort={() => onSort(sort === SeoMarketRankingSorts.rank ? SeoMarketRankingSorts['-rank'] : SeoMarketRankingSorts.rank)} />
                  <th className="px-4 py-3 text-left text-label-13-strong whitespace-nowrap">Top rival</th>
                  <th className={`${CELL} text-label-13-strong`}>Rival rank</th>
                  <th className={`${CELL} text-label-13-strong`}><span className="inline-flex items-center gap-1">Rank gap<InfoTooltip text={RANK_GAP_HELP} placement="bottom" /></span></th>
                  <th className="px-4"><span className="sr-only">Evidence</span></th>
                </tr></thead>
                <tbody className="divide-y divide-subtle">{items.map((row, index) => <MarketRankingRow key={`${row.marketKey}\u0000${row.queryId ?? row.queryText}\u0000${index}`} row={row} requested={depth} />)}</tbody>
              </table>
            </div>
            <DataTablePagination page={page} pageSize={QUERY_PAGE_SIZE} visibleRows={items.length} totalRows={rows.data.total} onPageChange={next => setPaging({ filterKey, page: next })} disabled={rows.isFetching} itemLabel="queries" className="text-label-13 [&_button]:min-h-11" />
          </>}
  </div>
}

/**
 * One tracked query in one market, searched on Google from the market's location; its evidence
 * opens in a full-width row below it. `requested` is the depth the refresh asked for, so a
 * partial search can say how much of it came back.
 */
function MarketRankingRow({ row, requested }: { row: SeoMarketRankingRow; requested: number | null }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  return <>
    <tr className={open ? 'border-b-0' : undefined}>
      <th scope="row" className={ROW_HEADER}><p className="text-primary">{row.queryText}</p><p className="mt-1 text-copy-13 text-secondary">{row.marketLabel}</p></th>
      <td className={CELL}><MarketRank row={row} requested={requested} /></td>
      <td className="px-4 py-3 align-top text-label-13"><TopRival row={row} /></td>
      <td className={CELL}><Value value={row.topCompetitor?.rankOrganic ?? null} /></td>
      <td className={CELL}><RankGap value={row.rankGap} /></td>
      <td className="px-4 text-right align-top">
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-sm text-button-14 text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">
          {open ? 'Hide details' : 'Details'}<span className="sr-only"> for {row.queryText} in {row.marketLabel}</span>
        </button>
      </td>
    </tr>
    <tr id={detailsId} hidden={!open}>
      <td colSpan={6} className="bg-surface-subtle px-4 pb-4 pt-3"><MarketRankingDetails row={row} requested={requested} /></td>
    </tr>
  </>
}

function noResult(row: SeoMarketRankingRow): boolean {
  return row.outcome === SeoMarketRankingOutcomes.failed || row.outcome === SeoMarketRankingOutcomes.cancelled
}

function MarketRank({ row, requested }: { row: SeoMarketRankingRow; requested: number | null }) {
  if (row.outcome === SeoMarketRankingOutcomes.failed) return <InfoTooltip tone="caution" label="Failed" placement="bottom" text="Failed: the source returned no results for this search in this refresh." />
  if (row.outcome === SeoMarketRankingOutcomes.cancelled) return <span className="inline-flex items-center gap-1.5 text-secondary">Not searched<InfoTooltip placement="bottom" text="The refresh was cancelled, or reached a spending limit, before this search ran." /></span>
  if (row.rankOrganic !== null) return <>{row.rankOrganic}</>
  return row.outcome === SeoMarketRankingOutcomes['partly-checked']
    ? <span className="inline-flex items-center gap-1.5 text-secondary">Not in top {row.depth}<InfoTooltip placement="bottom" text={`Only the top ${row.depth}${requested === null ? '' : ` of ${requested}`} results came back for this search, so ranks past ${row.depth} are unknown.`} /></span>
    : <span className="text-secondary">Not in top {row.depth}</span>
}

/** The best-ranked tracked competitor in the same results, marked when it ranks above the site. */
function TopRival({ row }: { row: SeoMarketRankingRow }) {
  if (noResult(row)) return <span className="text-muted"><span aria-hidden="true">—</span><span className="sr-only">No result</span></span>
  const rival = row.topCompetitor
  if (!rival) return <span className="text-secondary">None in top {row.depth}</span>
  return <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
    <span className="text-primary">{rival.domain}</span>
    {row.rivalAhead && <ToneBadge tone="caution">Ahead</ToneBadge>}
  </span>
}

/** A row's evidence in compact groups: the ranking page first, then the search, the position, the rivals and the source. */
function MarketRankingDetails({ row, requested }: { row: SeoMarketRankingRow; requested: number | null }) {
  const label = 'text-muted'
  const value = 'mt-0.5 text-primary'
  const noPage = row.outcome === SeoMarketRankingOutcomes.failed ? 'No result: the search failed'
    : row.outcome === SeoMarketRankingOutcomes.cancelled ? 'No result: not searched' : `Not in the top ${row.depth}`
  return <div className="grid gap-x-8 gap-y-3 text-label-13 text-secondary sm:grid-cols-2 lg:grid-cols-4">
    <div className="sm:col-span-2 lg:col-span-4"><p className={label}>Ranking page</p>{row.url ? <SourceLink url={row.url} /> : <p className={value}>{noPage}</p>}</div>
    <div className="lg:col-span-2"><p className={label}>Searched as</p><p className={value}>“{row.searchText}” from {row.locationLabel}</p></div>
    <div><p className={label}>Target</p><p className={`${value} break-words`}>{row.target.value} · {row.target.includeSubdomains ? 'includes subdomains' : 'exact host'}</p></div>
    {row.rankOrganic !== null && <div><p className={label}>{PAGE_POSITION}</p><p className={`${value} tabular-nums`}><Value value={row.rankAbsolute} /></p></div>}
    {row.searchStatus === SeoMarketRankingSearchStatuses.partial && <div><p className={label}>Results checked</p><p className={`${value} tabular-nums`}>Top {row.depth}{requested === null ? '' : ` of ${requested}`}</p></div>}
    {!noResult(row) && <div className="sm:col-span-2 lg:col-span-2">
      <p className={label}>Tracked competitors in these results</p>
      {row.competitors.length
        ? <dl className="mt-0.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1">{row.competitors.map(competitor => <Fragment key={competitor.domain}><dt className="break-all text-primary">{competitor.domain}</dt><dd className="text-right tabular-nums text-primary">#{competitor.rankOrganic}</dd></Fragment>)}</dl>
        : <p className={value}>None in the top {row.depth}</p>}
    </div>}
    {row.provenance && <div className="sm:col-span-2 lg:col-span-4"><DataProvenance source={row.provenance} /></div>}
  </div>
}

function SeoRefreshHistory({ projectName, profileId, canRun, selectedRunId, exactRefresh, onViewSaved, onLatest }: {
  projectName: string
  profileId: string
  canRun: boolean
  selectedRunId?: string
  exactRefresh: boolean
  onViewSaved: (runId: string) => void
  onLatest: () => void
}) {
  const queryClient = useQueryClient()
  const [detailId, setDetailId] = useState<string | null>(selectedRunId ?? null)
  const [error, setError] = useState<string | null>(null)
  const path = { name: projectName }
  const runs = useQuery({ ...getApiV1ProjectsByNameSeoRunsOptions({ client: heyClient, path, query: { profileId } }), enabled: !exactRefresh, refetchInterval: query => query.state.data?.runs.some(isActive) ? 2000 : false })
  const detail = useQuery({ ...getApiV1ProjectsByNameSeoRunsByIdOptions({ client: heyClient, path: { ...path, id: detailId ?? '' } }), enabled: Boolean(detailId), refetchInterval: query => isActive(query.state.data) ? 2000 : false })
  const cancel = useMutation({ ...postApiV1ProjectsByNameSeoRunsByIdCancelMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const stop = async (id: string) => {
    if (!canRun || cancel.isPending) return
    setError(null)
    try {
      await cancel.mutateAsync({ path: { ...path, id } })
      await invalidateProjectQueryDomain(queryClient, 'seo', { projectName })
    } catch (cause) {
      setError(extractErrorMessage(cause))
    }
  }
  const loaded = exactRefresh ? detail : runs
  if (loaded.error) return <ReadError error={loaded.error} retry={() => { void loaded.refetch() }} />
  if (!loaded.data) return <p role="status" className="py-4 text-copy-14 text-secondary">{exactRefresh ? 'Loading refresh details…' : 'Loading refresh history…'}</p>
  const history = exactRefresh && detail.data ? [detail.data] : runs.data?.runs ?? []
  if (!history.length) return <EmptyEvidence title="No refreshes yet">Refresh this profile to collect its first saved results.</EmptyEvidence>

  const listedTasks = detail.data?.tasks.filter(listedTask) ?? []
  return <>
    {error && <p role="alert" className="text-copy-14 text-negative">{error}</p>}
    <ul className="divide-y divide-subtle" aria-label="SEO refreshes">
      {history.map(run => {
        const expanded = exactRefresh || detailId === run.id
        return <li key={run.id} className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <time dateTime={run.createdAt} className="text-label-14">{formatZonedTimestamp(run.createdAt, TIME_ZONE)}</time>
                <RunBadge status={run.status} />
              </div>
              <p className="text-copy-13 text-secondary">{run.completedTasks} of {run.taskCount} {taskNoun(run)} completed{run.failedTasks > 0 ? ` · ${run.failedTasks} failed` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!exactRefresh && <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`seo-run-${run.id}`} onClick={() => setDetailId(expanded ? null : run.id)}>Details<span className="sr-only"> for refresh {run.id}</span></Button>}
              {canRun && isActive(run) && <Button variant="secondary" size="sm" disabled={cancel.isPending || run.cancelRequested} onClick={asyncHandler(() => stop(run.id))}>{run.cancelRequested ? 'Cancellation requested' : 'Cancel refresh'}</Button>}
            </div>
          </div>
          {expanded && <div id={`seo-run-${run.id}`} className="mt-3 space-y-2 border-t border-subtle pt-3 text-label-13 text-secondary">
            <p className="break-all">Refresh {run.id}</p>
            <p>Profile revision {run.profileRevision} · {runLocation(run)} · {run.languageCode}</p>
            <p>Scope {run.scope.kind}{run.scope.key ? ` · ${run.scope.key}` : ''}{run.scope.expectedPlanRevision !== undefined ? ` · plan revision ${run.scope.expectedPlanRevision}` : ''}</p>
            {run.error && <p>{run.error}</p>}
            {detail.error ? <ReadError error={detail.error} retry={() => { void detail.refetch() }} /> : detail.data ? listedTasks.length > 0 && <ul className="space-y-3" aria-label="Refresh tasks">
              {listedTasks.map(task => <li key={task.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{CAPABILITY_LABELS[task.capability]}{task.searchText !== null ? ` · “${task.searchText}” from ${task.locationLabel ?? 'its market'}` : task.target ? ` · ${task.target.value}` : ''}{task.comparison ? ` · ${task.comparison.competitor.value} · ${GAP_LABELS[task.comparison.mode]} searches` : ''}{task.retried ? ' · retried once' : ''}</span><RunBadge status={task.status} />
                </div>
                {task.error && <p className="mt-1">{task.error}</p>}
              </li>)}
            </ul> : <p role="status">Loading refresh details…</p>}
            {hasResults(run) && <Button variant="secondary" size="sm" onClick={() => onViewSaved(run.id)}>View saved data</Button>}
          </div>}
        </li>
      })}
    </ul>
    {exactRefresh && <div><Button variant="ghost" onClick={onLatest}>View latest data</Button></div>}
  </>
}

function SeoProfileEditor({ projectName, context, profile, id, onClose, onSaved }: { projectName: string; context: SeoContext; profile?: SeoProfile; id: string; onClose: () => void; onSaved: (id: string) => void }) {
  const queryClient = useQueryClient()
  const marketReport = SeoCapabilities['market-rankings']
  const availableReports = (connection: SeoContext['connections'][number] | undefined, scope: SeoContext['scopes'][number] | undefined) => (
    supportedReports(connection, scope).filter(capability => capability !== marketReport || profile?.rankings)
  )
  const usableSources = context.connections.filter(connection => context.scopes.some(scope => availableReports(connection, scope).length > 0))
  const projectScope = context.scopes.find(scope => scope.kind === SeoScopeKinds.project)
  const [connectionId, setConnectionId] = useState(() => profile?.connectionId ?? (usableSources.find(connection => availableReports(connection, projectScope).length > 0) ?? usableSources[0])?.id ?? '')
  const [selectedScope, setSelectedScope] = useState(profile ? `${profile.scope.kind}:${profile.scope.key ?? ''}` : `${SeoScopeKinds.project}:`)
  const source = context.connections.find(connection => connection.id === connectionId)
  const scope = context.scopes.find(item => `${item.kind}:${item.key ?? ''}` === selectedScope)
  const availableCapabilities = availableReports(source, scope)
  const defaultReports = (available: readonly SeoCapability[]): SeoCapability[] => {
    const preferred = SeoCapabilities['ranked-keywords']
    const first = available.includes(preferred) ? preferred : available[0]
    return first ? [first] : []
  }
  const [name, setName] = useState(profile?.name ?? '')
  const [capabilities, setCapabilities] = useState<SeoCapability[]>(() => profile?.capabilities ?? defaultReports(availableCapabilities))
  const [targets, setTargets] = useState<SeoTarget[]>(profile?.targets ?? [{ kind: SeoTargetKinds.domain, value: '', includeSubdomains: true }])
  const [competitors, setCompetitors] = useState(profile?.competitors?.map(target => target.value).join('\n') ?? '')
  const [keywords, setKeywords] = useState(profile?.keywords.join('\n') ?? '')
  const [locationCode, setLocationCode] = useState(profile?.locationCode.toString() ?? '')
  const [languageCode, setLanguageCode] = useState(profile?.languageCode ?? 'en')
  const [limit, setLimit] = useState(profile?.limit.toString() ?? '100')
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({ ...putApiV1ProjectsByNameSeoProfilesByIdMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const sources = context.connections.filter(connection => connection === source || usableSources.includes(connection))
  const scopes = context.scopes.filter(item => item === scope || item.supported)
  const selectedCapabilities = capabilities.filter(capability => availableCapabilities.includes(capability))
  const needsGaps = selectedCapabilities.includes(SeoCapabilities['keyword-gaps'])
  const domainResearch = needsGaps || selectedCapabilities.includes(SeoCapabilities['competitor-discovery'])
  const needsTargets = selectedCapabilities.some(capability => capability !== SeoCapabilities['keyword-metrics'])
  const needsRankedLimit = selectedCapabilities.includes(SeoCapabilities['ranked-keywords']) || domainResearch
  const needsSearches = selectedCapabilities.includes(SeoCapabilities['keyword-metrics'])
  const ranksMarkets = selectedCapabilities.includes(marketReport)
  // Market rankings keep their own profile, and only a saved market-rankings profile carries their search settings.
  const reportChoices = availableCapabilities.filter(capability => ranksMarkets ? capability === marketReport : capability !== marketReport || selectedCapabilities.length === 0)
  const marketAvailable = source?.capabilities.includes(marketReport) && (scope?.capabilities?.includes(marketReport) ?? true)
  const scopeNote = scope?.reason ?? (scope && !scope.supported ? 'SEO reports are unavailable for this scope.' : null)
  const scopeHelp = profile && !scope ? 'The saved scope is unavailable. Choose a current scope.' : scopeNote
  const scopeNoteId = useId()
  const sourceNoteId = useId()
  const searchSettingsId = useId()
  const updateReports = (available: SeoCapability[]) => setCapabilities(previous => {
    const remaining = previous.filter(capability => available.includes(capability))
    return profile || remaining.length ? remaining : defaultReports(available)
  })
  const submit = async () => {
    if (!context.access.canWrite || isEmbed() || isPublicDemo() || save.isPending) return
    if (!scope) { setError('Choose a measurement scope.'); return }
    const searches = keywords.split('\n').map(keyword => keyword.trim()).filter(Boolean)
    if (needsSearches && searches.length === 0) { setError('Enter at least one search to measure demand.'); return }
    if (needsTargets && targets.length === 0) { setError('Add at least one domain or host to measure.'); return }
    if (domainResearch && targets.some(target => target.kind !== SeoTargetKinds.domain || !target.includeSubdomains)) { setError('Organic competitors and search gaps require whole-domain targets including subdomains.'); return }
    const input: SeoProfileInput = {
      name, connectionId, capabilities: selectedCapabilities, targets: needsTargets ? targets : [], keywords: searches,
      locationCode: Number(locationCode), languageCode, limit: needsRankedLimit ? Number(limit) : profile?.limit ?? 100,
      scope: { kind: scope.kind, ...(scope.key ? { key: scope.key } : {}), ...(scope.planRevision !== undefined ? { expectedPlanRevision: scope.planRevision } : {}) },
      // Market-rankings settings (locations, depth, device) are kept as saved; the editor does not change them.
      ...(ranksMarkets && profile?.rankings ? { rankings: profile.rankings } : {}),
      ...(needsGaps ? { competitors: competitors.split('\n').map(value => value.trim()).filter(Boolean).map(value => ({ kind: SeoTargetKinds.domain, value, includeSubdomains: true })) } : {}),
    }
    const parsed = seoProfileInputSchema.safeParse(input)
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' ')); return }
    setError(null)
    try {
      await save.mutateAsync({ path: { name: projectName, id }, body: parsed.data })
      await queryClient.fetchQuery(getApiV1ProjectsByNameSeoProfilesOptions({ client: heyClient, path: { name: projectName } }))
      onSaved(id)
    } catch (cause) { setError(extractErrorMessage(cause)) }
  }
  const updateTarget = (index: number, patch: Partial<SeoTarget>) => setTargets(previous => previous.map((target, targetIndex) => targetIndex === index ? { ...target, ...patch } : target))
  return <form aria-label={profile ? 'Edit SEO profile' : 'New SEO profile'} className="material-base space-y-5 p-4 sm:p-5" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-heading-16 text-heading">{profile ? 'Edit profile' : 'New profile'}</h3><Button type="button" variant="ghost" className="size-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-0" aria-label="Close profile editor" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button></div>
    <label className="block max-w-lg space-y-1.5 text-label-14"><span>Profile name</span><input className={FIELD} required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="min-w-0 space-y-1.5">
        {scope && scopes.length === 1 ? <dl className="space-y-1"><dt className="text-label-13 text-secondary">Measurement scope</dt><dd className="break-words text-label-14 text-primary">{scope.label}</dd></dl>
          : <label className="block space-y-1.5 text-label-14"><span>Measurement scope</span><select className={FIELD} required value={scope ? selectedScope : ''} aria-describedby={scopeHelp ? scopeNoteId : undefined} onChange={event => {
            const nextScope = context.scopes.find(item => `${item.kind}:${item.key ?? ''}` === event.target.value)
            setSelectedScope(event.target.value)
            updateReports(availableReports(source, nextScope))
          }}><option value="" disabled>Choose a scope</option>{scopes.map(item => <option key={`${item.kind}:${item.key}`} value={`${item.kind}:${item.key ?? ''}`}>{item.label}</option>)}</select></label>}
        {scopeHelp && <p id={scopeNoteId} className="text-copy-13 text-secondary">{scopeHelp}</p>}
      </div>
      <div className="min-w-0 space-y-1.5">
        {source && sources.length === 1 ? <dl className="space-y-1"><dt className="text-label-13 text-secondary">Data source</dt><dd className="break-words text-label-14 text-primary">{source.label}</dd></dl>
          : <label className="block space-y-1.5 text-label-14"><span>Data source</span><select className={FIELD} required value={source ? connectionId : ''} aria-describedby={profile && !source ? sourceNoteId : undefined} onChange={event => {
            const nextSource = context.connections.find(connection => connection.id === event.target.value)
            setConnectionId(event.target.value)
            updateReports(availableReports(nextSource, scope))
          }}><option value="" disabled>Choose a source</option>{sources.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>}
        {profile && !source && <p id={sourceNoteId} className="text-copy-13 text-secondary">The saved data source is unavailable. Choose a configured source.</p>}
      </div>
    </div>
    <div className="border-t border-subtle pt-4">
      <fieldset className="space-y-2">
        <legend className="text-heading-14 text-heading">Reports to collect</legend>
        {reportChoices.length ? <div className="grid gap-x-6 sm:grid-cols-2">{reportChoices.map(capability => (
          <label key={capability} className="flex min-h-11 items-center gap-2 text-label-14"><input type="checkbox" className="size-4 shrink-0 accent-accent" checked={selectedCapabilities.includes(capability)} onChange={event => {
            const checked = event.currentTarget.checked
            setCapabilities(previous => checked ? [...previous, capability] : previous.filter(item => item !== capability))
          }} />{CAPABILITY_LABELS[capability]}</label>
        ))}</div> : <p className="text-copy-13 text-secondary">{scope && source ? 'No reports can be set up here with this scope and data source.' : 'Choose a scope and data source to see available reports.'}</p>}
        {marketAvailable && !profile?.rankings && <p className="text-copy-13 text-secondary">Set up market rankings with the CLI or API.</p>}
        {ranksMarkets && <p className="text-copy-13 text-secondary">Market rankings use their own profile.</p>}
      </fieldset>
    </div>
    {needsTargets && <fieldset className="space-y-3"><legend className="mb-1 text-heading-14 text-heading">Sites to measure</legend><p className="text-copy-13 text-secondary">{ranksMarkets ? 'Choose one of this project’s own domains.' : domainResearch || selectedCapabilities.includes(SeoCapabilities['domain-intelligence']) ? 'Use a domain with its subdomains for domain reports.' : 'Enter a domain or an exact host. Leave out paths and ports.'}</p>
      {targets.map((target, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_13rem_auto]">
        <label className="space-y-1 text-label-14"><span className="sr-only">Target {index + 1}</span><input className={FIELD} value={target.value} placeholder="example.com" aria-label={`Target ${index + 1}`} onChange={event => updateTarget(index, { value: event.target.value })} required maxLength={253} /></label>
        <label className="space-y-1 text-label-14"><span className="sr-only">Target {index + 1} kind</span><select className={FIELD} aria-label={`Target ${index + 1} kind`} value={target.kind} onChange={event => updateTarget(index, { kind: event.target.value as SeoTarget['kind'], includeSubdomains: event.target.value === SeoTargetKinds.domain })}><option value={SeoTargetKinds.domain}>Domain + subdomains</option><option value={SeoTargetKinds.host}>Exact host</option></select></label>
        <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setTargets(previous => previous.filter((_, targetIndex) => targetIndex !== index))} aria-label={`Remove target ${index + 1}`}>Remove</Button>
      </div>)}
      <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" disabled={targets.length >= (ranksMarkets ? 1 : 20)} onClick={() => setTargets(previous => [...previous, { kind: SeoTargetKinds.domain, value: '', includeSubdomains: true }])}>Add target</Button>
    </fieldset>}
    {needsGaps && <label className="block space-y-1.5 text-label-14"><span>Comparison domains</span><textarea className={`${FIELD} min-h-24`} value={competitors} onChange={event => setCompetitors(event.target.value)} placeholder="competitor.com" required /><span className="block text-copy-13 text-secondary">One domain per line, up to 5. Includes subdomains. Each is compared with every target in this profile.</span></label>}
    {needsSearches && <label className="block space-y-1.5 text-label-14"><span>Searches</span><textarea className={`${FIELD} min-h-28`} value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="One search per line" required /><span className="block text-copy-13 text-secondary">Enter up to 700 searches, with at most 10 words and 80 characters each.</span></label>}
    <div className="border-t border-subtle pt-4">
      <fieldset className="space-y-3" aria-describedby={searchSettingsId}>
        <legend className="text-heading-14 text-heading">Search settings</legend>
        <p id={searchSettingsId} className="text-copy-13 text-secondary">{ranksMarkets ? 'The profile’s location code applies only when the project has no markets or locations.' : 'Use the location code from your data source and a language code such as en for English.'}</p>
        <div className={`grid gap-4 ${needsRankedLimit ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          <label className="space-y-1.5 text-label-14"><span>Provider location code</span><input className={FIELD} type="number" min={1} step={1} required value={locationCode} onChange={event => setLocationCode(event.target.value)} /></label>
          <label className="space-y-1.5 text-label-14"><span>Language code</span><input className={FIELD} required minLength={2} maxLength={10} value={languageCode} onChange={event => setLanguageCode(event.target.value)} /></label>
          {needsRankedLimit && <label className="space-y-1.5 text-label-14"><span>{domainResearch ? 'Result limit' : 'Ranked searches per target'}</span><input className={FIELD} type="number" min={1} max={1000} step={1} required value={limit} onChange={event => setLimit(event.target.value)} />{domainResearch && <span className="block text-copy-13 text-secondary">{needsGaps ? 'Each gap comparison uses this limit separately for shared and missing searches.' : 'Maximum rows per target.'}</span>}</label>}
        </div>
      </fieldset>
    </div>
    {error && <p role="alert" className="text-copy-14 text-secondary">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="pointer-coarse:min-h-11" disabled={save.isPending || !scope?.supported || !source || !selectedCapabilities.length}>{save.isPending ? 'Saving…' : 'Save profile'}</Button><Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={onClose}>Cancel</Button></div>
  </form>
}

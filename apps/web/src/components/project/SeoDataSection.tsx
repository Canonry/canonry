import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import {
  RatioUnits, SchedulableRunKinds, SeoAvailability, SeoCapabilities, SeoMarketRankingFilters, SeoMarketRankingGroupKinds, SeoMarketRankingOutcomes,
  SeoMarketRankingSearchStatuses, SeoMarketRankingSorts, SeoRunStatuses, SeoScopeKinds, SeoTargetKinds,
  compareText, formatCalendarDay, formatDate, formatIsoDateInTimeZone, formatZonedTimestamp, formatPercent, marketRankingBands,
  seoCapabilitySchema, seoDatasetWithoutVendor, seoMarketRankingFilterSchema, seoMarketRankingSortSchema, seoProfileInputSchema,
  type MarketRankingBand, type SeoCapability, type SeoContext, type SeoDevice, type SeoDomainIntelligence, type SeoKeywordMetrics,
  type SeoMarketRankingCounts, type SeoMarketRankingFilter, type SeoMarketRankingGroup, type SeoMarketRankingRow, type SeoMarketRankingSort,
  type SeoProfile, type SeoProfileInput, type SeoProvenance, type SeoRankedKeyword,
  type SeoRun, type SeoRunStatus, type SeoSyncInput, type SeoTarget, type SeoTask,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameScheduleOptions,
  getApiV1ProjectsByNameSeoContextOptions,
  getApiV1ProjectsByNameSeoProfilesOptions,
  getApiV1ProjectsByNameSeoOverviewOptions,
  getApiV1ProjectsByNameSeoRankedKeywordsOptions,
  getApiV1ProjectsByNameSeoKeywordMetricsOptions,
  getApiV1ProjectsByNameSeoDomainIntelligenceOptions,
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
import { asyncHandler } from '../../lib/async-handler.js'
import { extractApiErrorInfo, extractErrorMessage } from '../../lib/extract-error-message.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { Button } from '../ui/button.js'
import { DataTablePagination, DataTableSearch, MiddleTruncatedText } from '../shared/DataTableControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SourceLink } from '../shared/SourceLink.js'

const CAPABILITY_LABELS: Record<SeoCapability, string> = {
  [SeoCapabilities['keyword-metrics']]: 'Search demand',
  [SeoCapabilities['domain-intelligence']]: 'Domain comparison',
  [SeoCapabilities['ranked-keywords']]: 'Searches you rank for',
  [SeoCapabilities['market-rankings']]: 'Market rankings',
}
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
const FIELD = 'min-h-11 w-full rounded-md border border-default bg-bg px-3 py-2 text-label-14 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
// Cells sit on the row's first line, so an opened Details panel never leaves the row label floating mid-row.
const CELL = 'px-4 py-3 text-right align-top tabular-nums whitespace-nowrap'
const ROW_HEADER = 'min-w-56 px-4 py-3 text-left align-top text-label-14'
/** The source's absolute rank, in plain words: it counts map packs and other result blocks, so it can differ from the organic rank. */
const PAGE_POSITION = 'Position on the page, counting maps and other blocks'
type SeoView = SeoCapability | 'activity'

function isActive(run: SeoRun | undefined | null): boolean {
  return run?.status === SeoRunStatuses.queued || run?.status === SeoRunStatuses.running
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
  if (latest && problem) return { label: problem, text: `${problem}. ${latest.error ?? 'Open Activity for refresh details.'}${evidence ? ' Showing the refresh before it.' : ''}` }
  if (!evidence) return null
  if (evidence.failedTasks > 0) {
    const label = `${taskCount(evidence, evidence.failedTasks)} failed`
    const where = evidence.capabilities.includes(SeoCapabilities['market-rankings']) ? 'Their queries show as Failed.' : 'Open Activity for details.'
    return { label, text: `${label}: ${evidence.failedTasks} of ${taskCount(evidence, evidence.taskCount)} in this refresh returned no results. ${where}` }
  }
  return evidence.status === SeoRunStatuses.partial
    ? { label: 'Partial results', text: `Partial results: ${evidence.error ?? `some ${taskNoun(evidence)} returned only part of their results or did not run. Open Activity for details.`}` }
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
    <details className="text-left">
      <summary className="flex min-h-11 cursor-pointer items-center text-label-13 text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">Details<span className="sr-only"> for {label}</span></summary>
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

function EmptyEvidence({ title, children }: { title: string; children: ReactNode }) {
  return <div className="py-12 text-center"><h3 className="text-heading-14 text-heading">{title}</h3><p className="mx-auto mt-2 max-w-lg text-copy-14 text-secondary">{children}</p></div>
}

export function SeoDataSection({ projectName }: { projectName: string }) {
  const search = useSearch({ strict: false }) as { seoProfileId?: string; seoRunId?: string }
  const navigate = useNavigate()
  const context = useQuery(getApiV1ProjectsByNameSeoContextOptions({ client: heyClient, path: { name: projectName } }))
  const profiles = useQuery(getApiV1ProjectsByNameSeoProfilesOptions({ client: heyClient, path: { name: projectName } }))
  const selectedRun = useQuery({ ...getApiV1ProjectsByNameSeoRunsByIdOptions({ client: heyClient, path: { name: projectName, id: search.seoRunId ?? '' } }), enabled: Boolean(search.seoRunId) })
  const [editor, setEditor] = useState<{ profile?: SeoProfile; id: string } | null>(null)
  const editorOpener = useRef<HTMLButtonElement | null>(null)
  const profileSelect = useRef<HTMLSelectElement | null>(null)
  const requestedProfileId = search.seoProfileId ?? selectedRun.data?.profileId
  const selected = requestedProfileId
    ? profiles.data?.profiles.find(profile => profile.id === requestedProfileId)
    : search.seoRunId ? undefined : profiles.data?.profiles[0]
  const selectProfile = (id: string) => {
    setEditor(null)
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoProfileId: id, seoRunId: undefined, seoRegion: undefined, seoMarket: undefined, seoShow: undefined, seoSort: undefined, seoQ: undefined }) })
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

  if (context.error) return <ReadError error={context.error} retry={() => { void context.refetch() }} />
  if (profiles.error) return <ReadError error={profiles.error} retry={() => { void profiles.refetch() }} />
  if (!context.data || !profiles.data) return <p role="status" className="py-10 text-copy-14 text-secondary">Loading SEO data…</p>
  const sourceConfigured = context.data.available && context.data.connections.some(connection => connection.capabilities.length > 0)
  const canConfigure = sourceConfigured && context.data.connections.some(connection => connection.capabilities.some(capability => context.data.scopes.some(scope => scope.capabilities?.includes(capability) ?? true)))
  const scope = selected && context.data.scopes.find(item => item.kind === selected.scope.kind && item.key === (selected.scope.key ?? null))

  return (
    <section aria-label="SEO" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-heading-20 text-heading">SEO</h2><p className="mt-1 text-copy-14 text-secondary">Search demand and organic rankings.</p></div>
        {canWrite && canConfigure && <div className="flex flex-wrap gap-2">
          {selected && <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={event => { editorOpener.current = event.currentTarget; setEditor({ profile: selected, id: selected.id }) }}>Edit profile</Button>}
          <Button variant="secondary" className="pointer-coarse:min-h-11" onClick={event => { editorOpener.current = event.currentTarget; setEditor({ id: crypto.randomUUID() }) }}><Plus aria-hidden="true" className="size-4" />New profile</Button>
        </div>}
      </div>

      {profiles.data.profiles.length > 0 && <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-subtle py-3">
        <label className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none"><span className="text-label-13 text-secondary">Profile</span><select ref={profileSelect} aria-label="SEO profile" value={selected?.id ?? ''} onChange={event => selectProfile(event.target.value)} className={`${FIELD} min-w-0 sm:w-64`}>
          {!selected && <option value="" disabled>Profile unavailable</option>}
          {profiles.data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        {selected && <div className="min-w-0 text-label-13 text-secondary"><p className="break-words text-copy-13-strong text-primary">{scope?.label ?? `${selected.scope.kind}${selected.scope.key ? `: ${selected.scope.key}` : ''}`}</p><p>{selected.rankings ? `${selected.rankings.locations.length} search location${selected.rankings.locations.length === 1 ? '' : 's'}` : `Location ${selected.locationCode}`} · {selected.languageCode}</p></div>}
      </div>}

      {editor && <SeoProfileEditor key={editor.id} projectName={projectName} context={context.data} profile={editor.profile} id={editor.id} onClose={closeEditor} onSaved={id => { selectProfile(id); requestAnimationFrame(() => profileSelect.current?.focus()) }} />}
      {!isPublicDemo() && !context.data.available && profiles.data.profiles.length > 0 && <p role="status" className="rounded-md border border-default px-4 py-3 text-copy-14 text-secondary">{context.data.reason ?? 'Configure an SEO data provider to refresh saved profiles.'}</p>}
      {search.seoRunId && selectedRun.error ? <div className="space-y-3"><ReadError error={selectedRun.error} retry={() => { void selectedRun.refetch() }} />{selected ? <Button variant="secondary" className="pointer-coarse:min-h-11" onClick={() => selectProfile(selected.id)}>View latest data</Button> : <p className="text-copy-14 text-secondary">Select a profile to view its latest data.</p>}</div> : search.seoRunId && selectedRun.isPending ? <p role="status" className="py-10 text-copy-14 text-secondary">Loading refresh…</p> : selected && selectedRun.data && selectedRun.data.profileId !== selected.id ? <EmptyEvidence title="Refresh belongs to another profile">Choose the refresh’s profile, or return to the selected profile’s latest data.<Button variant="secondary" className="mt-4 pointer-coarse:min-h-11" onClick={() => selectProfile(selected.id)}>View latest data</Button></EmptyEvidence> : selected ? <SeoProfileWorkspace key={`${selected.id}:${selected.revision}:${search.seoRunId ?? ''}`} projectName={projectName} profile={selected} context={context.data} selectedRunId={search.seoRunId} onLatest={() => selectProfile(selected.id)} /> : !canConfigure && profiles.data.profiles.length === 0 ? <EmptyEvidence title={sourceConfigured ? 'SEO scope unavailable' : 'Configure an SEO data provider'}>{sourceConfigured ? context.data.scopes.find(item => item.reason)?.reason ?? 'No datasets are available for this project’s measurement scopes.' : 'Connect a provider before creating an SEO profile.'}</EmptyEvidence> : requestedProfileId ? (
        <EmptyEvidence title="Profile unavailable">This saved profile is no longer available. Select another profile to view its data.</EmptyEvidence>
      ) : !editor && <EmptyEvidence title="No SEO data yet">{canWrite ? 'Create a profile to choose the scope, source, and searches to measure.' : 'An SEO profile is needed before data can be collected.'}</EmptyEvidence>}
    </section>
  )
}

function SeoProfileWorkspace({ projectName, profile, context, selectedRunId, onLatest }: { projectName: string; profile: SeoProfile; context: SeoContext; selectedRunId?: string; onLatest: () => void }) {
  const queryClient = useQueryClient()
  const [view, setView] = useState<SeoView>(selectedRunId ? 'activity' : profile.capabilities.includes(SeoCapabilities['ranked-keywords']) ? SeoCapabilities['ranked-keywords'] : profile.capabilities.at(0) ?? 'activity')
  const [error, setError] = useState<string | null>(null)
  const pendingSync = useRef<SeoSyncInput | null>(null)
  const seenActiveRun = useRef<string | null>(null)
  const path = { name: projectName }
  const overview = useQuery({
    ...getApiV1ProjectsByNameSeoOverviewOptions({ client: heyClient, path, query: { profileId: profile.id, runId: selectedRunId } }),
    refetchInterval: query => isActive(query.state.data?.latestRun) ? 2000 : false,
  })
  const intent = useMutation({ ...postApiV1ProjectsByNameSeoRefreshIntentsMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const sync = useMutation({ ...postApiV1ProjectsByNameSeoSyncMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const latest = overview.data?.latestRun
  const evidence = overview.data?.evidenceRun
  const evidenceCapabilities = overview.data?.evidenceRun?.capabilities ?? profile.capabilities
  const selectedView = view === 'activity' || evidenceCapabilities.includes(view) ? view : evidenceCapabilities.at(0) ?? 'activity'
  const active = isActive(latest)
  const busy = intent.isPending || sync.isPending
  const canRun = context.access.canRun && !isEmbed() && !isPublicDemo()
  const connection = context.connections.find(item => item.id === profile.connectionId)
  const scope = context.scopes.find(item => item.kind === profile.scope.kind && item.key === (profile.scope.key ?? null))
  // A project's SEO refresh schedule refreshes every saved profile; a missing schedule (404) means no date.
  const schedule = useQuery({ ...getApiV1ProjectsByNameScheduleOptions({ client: heyClient, path, query: { kind: SchedulableRunKinds['seo-sync'] } }), retry: false })
  const nextRunAt = !schedule.isError && schedule.data?.enabled && schedule.data.nextRunAt ? schedule.data.nextRunAt : null
  const nextRefresh = nextRunAt ? calendarDay(nextRunAt, schedule.data?.timezone ?? 'UTC') : null
  const updated = evidence?.finishedAt && (evidence.status === SeoRunStatuses.completed || evidence.status === SeoRunStatuses.partial) ? calendarDay(evidence.finishedAt, TIME_ZONE) : null
  // While a refresh runs the status line is about that refresh, so the shown data's caveat waits for it to finish.
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
      if (isActive(run)) seenActiveRun.current = run.id
      await queryClient.fetchQuery(getApiV1ProjectsByNameSeoOverviewOptions({ client: heyClient, path, query: { profileId: profile.id } }))
    } catch (cause) {
      if (extractApiErrorInfo(cause).code === 'VALIDATION_ERROR') pendingSync.current = null
      setError(extractErrorMessage(cause))
    }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-label-14 text-secondary">
        <div aria-live="polite">{active && latest ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{latest.cancelRequested ? 'Cancellation requested' : STATUS_LABELS[latest.status]} · {latest.completedTasks} of {latest.taskCount} {taskNoun(latest)} completed</p>
          : <p>{updated && evidence?.finishedAt ? <>Updated <time dateTime={evidence.finishedAt} title={formatZonedTimestamp(evidence.finishedAt, TIME_ZONE) ?? undefined}>{updated}</time></> : 'No completed refresh'}{nextRefresh && nextRunAt && <> · Next refresh <time dateTime={nextRunAt}>{nextRefresh}</time></>}</p>}</div>
        {caveat && <InfoTooltip tone="caution" placement="bottom" label={caveat.label} text={caveat.text} />}
      </div>
      {selectedRunId ? <Button variant="secondary" className="pointer-coarse:min-h-11" onClick={onLatest}>View latest data</Button> : canRun && <Button className="pointer-coarse:min-h-11" disabled={busy || active || !context.available || !connection} onClick={asyncHandler(refresh)}><RefreshCw aria-hidden="true" className={`size-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Starting refresh…' : active ? 'Refresh in progress' : pendingSync.current ? 'Retry refresh' : 'Refresh data'}</Button>}
    </div>
    {error && <p role="alert" className="rounded-md border border-default p-4 text-copy-14 text-secondary">{error}{pendingSync.current && ' Retry uses the same request, so it will not start a duplicate refresh.'}</p>}
    {selectedRunId && <p className="break-all text-copy-13 text-secondary">Viewing saved refresh {selectedRunId}.</p>}
    {overview.data?.evidenceRun && overview.data.evidenceRun.profileRevision !== profile.revision && <p role="status" className="text-copy-14 text-secondary">Saved data uses profile revision {overview.data.evidenceRun.profileRevision} · {runLocation(overview.data.evidenceRun)} · {overview.data.evidenceRun.languageCode}. The current profile has changed.</p>}
    {!isPublicDemo() && scope && !scope.supported && <p role="status" className="text-copy-14 text-secondary">{scope.reason ?? 'This scope is not supported for domain data.'}</p>}
    {overview.error ? <ReadError error={overview.error} retry={() => { void overview.refetch() }} /> : overview.data?.summary && <div>
      <p className="mb-3 break-words text-copy-13 text-secondary">{overview.data.summary.target.value}{overview.data.summary.target.includeSubdomains ? ' · includes subdomains' : ' · exact host'}</p>
      <dl className="grid grid-cols-1 gap-5 border-b border-subtle pb-5 sm:grid-cols-3">
        <div><dt className="text-label-13 text-secondary">Searches you rank for</dt><dd className="mt-2 text-heading-32 tabular-nums text-heading"><Value value={overview.data.summary.organicKeywords} /></dd></div>
        <div><dt className="text-label-13 text-secondary">In the top 10</dt><dd className="mt-2 text-heading-32 tabular-nums text-heading"><Value value={overview.data.summary.inTop10} /></dd></div>
        <div><dt className="flex items-center gap-1.5 text-label-13 text-secondary">Estimated organic traffic<InfoTooltip text="Modeled search traffic for this target and provider geography. This is not measured site traffic." /></dt><dd className="mt-2 text-heading-32 tabular-nums text-heading"><Value value={overview.data.summary.estimatedOrganicTraffic} /></dd></div>
      </dl>
    </div>}
    <div>
      <div className="flex flex-wrap gap-x-5 border-b border-subtle" aria-label="SEO views">
        {[...evidenceCapabilities, 'activity' as const].map(item => <button key={item} type="button" aria-pressed={selectedView === item} className={`min-h-11 border-b-2 text-button-14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${selectedView === item ? 'border-strong text-primary' : 'border-transparent text-secondary hover:text-primary'}`} onClick={() => setView(item)}>{item === 'activity' ? 'Activity' : CAPABILITY_LABELS[item]}</button>)}
      </div>
      {selectedView === 'activity' ? <SeoActivity projectName={projectName} profileId={profile.id} canRun={canRun} selectedRunId={selectedRunId} />
        : overview.isPending ? <p role="status" className="py-8 text-copy-14 text-secondary">Loading saved data…</p>
          : overview.data && <SeoEvidence key={`${profile.id}:${selectedView}:${overview.data.evidenceRunId ?? 'empty'}`} projectName={projectName} profileId={profile.id} runId={overview.data.evidenceRunId} view={selectedView} active={active} nextRefresh={nextRefresh} />}
    </div>
    <details className="border-t border-subtle text-label-14 text-secondary">
      <summary className="flex min-h-11 cursor-pointer items-center text-label-14-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">Data details</summary>
      <div className="space-y-4 pb-3 text-label-13">
        <p>Current profile source: {isPublicDemo() ? 'Fictional demo data' : connection?.label ?? 'Source unavailable'}. Google; {deviceLabel(profile.rankings?.device ?? 'unspecified')}.</p>
        {overview.data?.evidenceRun && <p>Saved evidence: {overview.data.evidenceRun.scope.kind}{overview.data.evidenceRun.scope.key ? ` · ${overview.data.evidenceRun.scope.key}` : ''}{overview.data.evidenceRun.scope.expectedPlanRevision !== undefined ? ` · plan revision ${overview.data.evidenceRun.scope.expectedPlanRevision}` : ''}. {runLocation(overview.data.evidenceRun)} · {overview.data.evidenceRun.languageCode} · profile revision {overview.data.evidenceRun.profileRevision}.</p>}
        <p>These are provider estimates and observed search rankings. Missing values are shown as a dash. Difficulty is a source score out of 100.</p>
        <p>Current profile targets:</p><ul className="space-y-1">{profile.targets.map((target, index) => <li key={index} className="break-words">{target.value} · {target.includeSubdomains ? 'includes subdomains' : 'exact host'}</li>)}</ul>
        {profile.scope.expectedPlanRevision !== undefined && <p>Saved measurement plan revision {profile.scope.expectedPlanRevision}.</p>}
        {overview.data?.summary && <DataProvenance source={overview.data.summary.provenance} />}
      </div>
    </details>
  </div>
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
  const args = { client: heyClient, path: { name: projectName }, query: { profileId, runId: runId ?? undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } }
  const ranked = useQuery({ ...getApiV1ProjectsByNameSeoRankedKeywordsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['ranked-keywords'] })
  const keywords = useQuery({ ...getApiV1ProjectsByNameSeoKeywordMetricsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['keyword-metrics'] })
  const domains = useQuery({ ...getApiV1ProjectsByNameSeoDomainIntelligenceOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['domain-intelligence'] })
  const selected = view === SeoCapabilities['ranked-keywords'] ? ranked : view === SeoCapabilities['keyword-metrics'] ? keywords : domains
  if (!runId) return <EmptyEvidence title="No saved data yet">Refresh this profile to collect {CAPABILITY_LABELS[view].toLowerCase()} for its saved scope.</EmptyEvidence>
  if (selected.error) return <div className="py-4"><ReadError error={selected.error} retry={() => { void selected.refetch() }} /></div>
  if (!selected.data) return <p role="status" className="py-8 text-copy-14 text-secondary">Loading {CAPABILITY_LABELS[view].toLowerCase()}…</p>
  if (selected.data.items.length === 0) return <EmptyEvidence title={active ? 'Refresh in progress' : 'No results returned'}>{active ? 'This profile is collecting data.' : 'The source did not return records for this scope. Review the refresh in Activity before changing the profile.'}</EmptyEvidence>
  return <div className="pt-4">
      <div className="relative overflow-x-auto rounded-md border border-default" role="region" aria-label={`${CAPABILITY_LABELS[view]} table`} tabIndex={0}>
      {view === SeoCapabilities['ranked-keywords'] && ranked.data && <RankedTable rows={ranked.data.items} />}
      {view === SeoCapabilities['keyword-metrics'] && keywords.data && <KeywordTable rows={keywords.data.items} />}
      {view === SeoCapabilities['domain-intelligence'] && domains.data && <DomainTable rows={domains.data.items} />}
    </div>
    <DataTablePagination page={page} pageSize={PAGE_SIZE} visibleRows={selected.data.items.length} totalRows={selected.data.total} onPageChange={setPage} disabled={selected.isFetching} className="text-label-13 [&_button]:min-h-11" />
  </div>
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

function SortHeader({ label, align, sorted, onSort }: { label: string; align: 'left' | 'right'; sorted: 'ascending' | 'descending' | null; onSort: () => void }) {
  return <th scope="col" aria-sort={sorted ?? undefined} className={`px-4 text-label-14-strong whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
    <button type="button" onClick={onSort} className={`${SORT_BUTTON} ${sorted ? 'text-primary' : ''}`}>{label}{sorted && <span aria-hidden="true" className="ml-0.5">{sorted === 'ascending' ? '↑' : '↓'}</span>}</button>
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
      : <EmptyEvidence title={active ? 'Refresh in progress' : 'No results returned'}>{active ? 'This profile is collecting data.' : 'The source did not return records for this scope. Review the refresh in Activity before changing the profile.'}</EmptyEvidence>}</div>
  }
  const bands = marketRankingBands(depth, totals)
  // Needs work leads; a scope with nothing off page 1 opens on every query instead of an empty list.
  const show: MarketShow = chosenShow ?? (totals.needsWork > 0 ? SeoMarketRankingFilters['needs-work'] : SHOW_ALL)
  // One region holds markets worth opening; a lone market would only repeat the queries below.
  const showGroups = groups.length > 1 || groups.some(group => group.kind === SeoMarketRankingGroupKinds.region)
  // The rank figures leave out queries with an incomplete or no result; the caption names them, so the figures reconcile with the total.
  const coverage = [
    `${NUMBER.format(totals.queries)} ${totals.queries === 1 ? 'query' : 'queries'}`,
    ...(totals.partlyChecked > 0 ? [`${NUMBER.format(totals.partlyChecked)} partly checked`] : []),
    ...(totals.failed > 0 ? [`${NUMBER.format(totals.failed)} failed`] : []),
    ...(totals.cancelled > 0 ? [`${NUMBER.format(totals.cancelled)} not searched`] : []),
  ].join(' · ')
  return <div className="space-y-6 pt-4">
    {trail}
    <section aria-labelledby={figuresHeading} className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 id={figuresHeading} className="text-heading-16 text-heading">Google rank</h3>
        <p className="text-copy-13 tabular-nums text-secondary">{coverage}</p>
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
    <Link to="/projects/$projectName/seo-data" params={{ projectName }} search={previous => ({ ...previous, seoRegion: undefined, seoMarket: undefined })} className={CRUMB_LINK}>All markets</Link>
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
      <label className="flex min-w-0 items-center gap-3"><span className="text-label-13 text-secondary">Show</span>
        <select aria-label="Show queries" value={show} onChange={event => onShow(event.target.value as MarketShow)} className={`${FIELD} min-w-0 sm:w-56`}>
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
      <td className="px-4 text-right align-top">
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(value => !value)} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-sm text-button-14 text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">
          {open ? 'Hide details' : 'Details'}<span className="sr-only"> for {row.queryText} in {row.marketLabel}</span>
        </button>
      </td>
    </tr>
    <tr id={detailsId} hidden={!open}>
      <td colSpan={4} className="bg-surface-subtle px-4 pb-4 pt-3"><MarketRankingDetails row={row} requested={requested} /></td>
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
  const rival = row.competitors[0]
  if (!rival) return <span className="text-secondary">None in top {row.depth}</span>
  return <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
    <span className="text-primary">{rival.domain}</span><span className="tabular-nums text-secondary">#{rival.rankOrganic}</span>
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

function SeoActivity({ projectName, profileId, canRun, selectedRunId }: { projectName: string; profileId: string; canRun: boolean; selectedRunId?: string }) {
  const [detailId, setDetailId] = useState<string | null>(selectedRunId ?? null)
  const [error, setError] = useState<string | null>(null)
  const runs = useQuery({ ...getApiV1ProjectsByNameSeoRunsOptions({ client: heyClient, path: { name: projectName }, query: { profileId } }), refetchInterval: query => query.state.data?.runs.some(isActive) ? 2000 : false })
  const detail = useQuery({ ...getApiV1ProjectsByNameSeoRunsByIdOptions({ client: heyClient, path: { name: projectName, id: detailId ?? '' } }), enabled: Boolean(detailId), refetchInterval: query => isActive(query.state.data) ? 2000 : false })
  const cancel = useMutation({ ...postApiV1ProjectsByNameSeoRunsByIdCancelMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const stop = async (id: string) => {
    if (!canRun || cancel.isPending) return
    setError(null)
    try { await cancel.mutateAsync({ path: { name: projectName, id } }) } catch (cause) { setError(extractErrorMessage(cause)) }
  }
  if (runs.error) return <div className="py-4"><ReadError error={runs.error} retry={() => { void runs.refetch() }} /></div>
  if (!runs.data) return <p role="status" className="py-8 text-copy-14 text-secondary">Loading activity…</p>
  const activityRuns = detail.data && !runs.data.runs.some(run => run.id === detail.data.id) ? [detail.data, ...runs.data.runs] : runs.data.runs
  if (!activityRuns.length) return <EmptyEvidence title="No refreshes yet">Refresh this profile to collect its first saved results.</EmptyEvidence>
  return <div className="divide-y divide-subtle">
    {error && <p role="alert" className="py-3 text-copy-14">{error}</p>}
    {activityRuns.map(run => <div key={run.id} className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-2"><div className="flex flex-wrap items-center gap-3"><RunBadge status={run.status} /><span className="text-label-14">{formatZonedTimestamp(run.createdAt, TIME_ZONE)}</span></div><p className="text-copy-13 text-secondary">{run.completedTasks} of {run.taskCount} {taskNoun(run)} completed{run.failedTasks > 0 ? ` · ${run.failedTasks} failed` : ''}</p></div><div className="flex gap-2"><Button variant="ghost" className="pointer-coarse:min-h-11" aria-expanded={detailId === run.id} aria-controls={`seo-run-${run.id}`} onClick={() => setDetailId(detailId === run.id ? null : run.id)}>Details<span className="sr-only"> for refresh {run.id}</span></Button>{canRun && isActive(run) && <Button variant="secondary" className="pointer-coarse:min-h-11" disabled={cancel.isPending || run.cancelRequested} onClick={asyncHandler(() => stop(run.id))}>{run.cancelRequested ? 'Cancellation requested' : 'Cancel refresh'}</Button>}</div></div>
      {detailId === run.id && <div id={`seo-run-${run.id}`} className="mt-4 space-y-3 rounded-md bg-surface p-4 text-label-13 text-secondary">
        <p className="break-all">Refresh {run.id}</p><p>Profile revision {run.profileRevision} · {runLocation(run)} · {run.languageCode}</p><p>Scope: {run.scope.kind}{run.scope.key ? ` · ${run.scope.key}` : ''}{run.scope.expectedPlanRevision !== undefined ? ` · plan revision ${run.scope.expectedPlanRevision}` : ''}</p>{run.error && <p>{run.error}</p>}
        {detail.error ? <ReadError error={detail.error} retry={() => { void detail.refetch() }} /> : detail.data ? detail.data.tasks.some(listedTask) && <ul className="space-y-3">{detail.data.tasks.filter(listedTask).map(task => <li key={task.id}><div className="flex flex-wrap items-center justify-between gap-2"><span>{CAPABILITY_LABELS[task.capability]}{task.searchText !== null ? ` · “${task.searchText}” from ${task.locationLabel ?? 'its market'}` : task.target ? ` · ${task.target.value}` : ''}{task.retried ? ' · retried once' : ''}</span><RunBadge status={task.status} /></div>{task.error && <p className="mt-1">{task.error}</p>}</li>)}</ul> : <p role="status">Loading refresh details…</p>}
      </div>}
    </div>)}
  </div>
}

function SeoProfileEditor({ projectName, context, profile, id, onClose, onSaved }: { projectName: string; context: SeoContext; profile?: SeoProfile; id: string; onClose: () => void; onSaved: (id: string) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(profile?.name ?? '')
  const [connectionId, setConnectionId] = useState(profile?.connectionId ?? context.connections.at(0)?.id ?? '')
  const [capabilities, setCapabilities] = useState<SeoCapability[]>(profile?.capabilities ?? [SeoCapabilities['ranked-keywords']])
  const [targets, setTargets] = useState<SeoTarget[]>(profile?.targets ?? [{ kind: SeoTargetKinds.domain, value: '', includeSubdomains: true }])
  const [keywords, setKeywords] = useState(profile?.keywords.join('\n') ?? '')
  const [locationCode, setLocationCode] = useState(profile?.locationCode.toString() ?? '')
  const [languageCode, setLanguageCode] = useState(profile?.languageCode ?? 'en')
  const [limit, setLimit] = useState(profile?.limit.toString() ?? '100')
  const [selectedScope, setSelectedScope] = useState(profile ? `${profile.scope.kind}:${profile.scope.key ?? ''}` : `${SeoScopeKinds.project}:`)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({ ...putApiV1ProjectsByNameSeoProfilesByIdMutation({ client: heyClient }), meta: { skipGlobalErrorToast: true } })
  const source = context.connections.find(connection => connection.id === connectionId)
  const scope = context.scopes.find(item => `${item.kind}:${item.key ?? ''}` === selectedScope)
  const availableCapabilities = source?.capabilities.filter(capability => scope?.capabilities?.includes(capability) ?? true) ?? []
  const selectedCapabilities = capabilities.filter(capability => availableCapabilities.includes(capability))
  const needsTargets = selectedCapabilities.includes(SeoCapabilities['ranked-keywords']) || selectedCapabilities.includes(SeoCapabilities['domain-intelligence']) || selectedCapabilities.includes(SeoCapabilities['market-rankings'])
  const needsRankedLimit = selectedCapabilities.includes(SeoCapabilities['ranked-keywords'])
  const marketNoteId = useId()
  const ranksMarkets = selectedCapabilities.includes(SeoCapabilities['market-rankings'])
  // Market rankings keep their own profile, and only a saved market-rankings profile carries their search settings.
  const blockedByMarkets = (capability: SeoCapability) => capability === SeoCapabilities['market-rankings']
    ? !profile?.rankings || selectedCapabilities.some(item => item !== SeoCapabilities['market-rankings'])
    : ranksMarkets
  const marketNote = availableCapabilities.includes(SeoCapabilities['market-rankings'])
    ? profile?.rankings ? 'Market rankings use their own profile.' : 'Set up market rankings with the CLI or API.'
    : null
  const submit = async () => {
    if (!context.access.canWrite || isEmbed() || isPublicDemo() || save.isPending) return
    if (!scope) { setError('Choose a measurement scope.'); return }
    const input: SeoProfileInput = {
      name, connectionId, capabilities: selectedCapabilities, targets: needsTargets ? targets : [], keywords: keywords.split('\n').map(keyword => keyword.trim()).filter(Boolean),
      locationCode: Number(locationCode), languageCode, limit: needsRankedLimit ? Number(limit) : profile?.limit ?? 100,
      scope: { kind: scope.kind, ...(scope.key ? { key: scope.key } : {}), ...(scope.planRevision !== undefined ? { expectedPlanRevision: scope.planRevision } : {}) },
      // Market-rankings settings (locations, depth, device) are kept as saved; the editor does not change them.
      ...(selectedCapabilities.includes(SeoCapabilities['market-rankings']) && profile?.rankings ? { rankings: profile.rankings } : {}),
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
  return <form aria-label={profile ? 'Edit SEO profile' : 'New SEO profile'} className="space-y-5 rounded-md border border-default p-4 sm:p-5" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-heading-14 text-heading">{profile ? 'Edit profile' : 'New profile'}</h3><Button type="button" variant="ghost" className="size-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-0" aria-label="Close profile editor" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-label-14"><span>Profile name</span><input className={FIELD} required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
      <label className="space-y-1.5 text-label-14"><span>Source</span><select className={FIELD} required value={connectionId} onChange={event => {
        const nextSource = context.connections.find(connection => connection.id === event.target.value)
        setConnectionId(event.target.value)
        setCapabilities(previous => previous.filter(capability => nextSource?.capabilities.includes(capability)))
      }}><option value="" disabled>Select a source</option>{context.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
      <label className="space-y-1.5 text-label-14 sm:col-span-2"><span>Measurement scope</span><select className={FIELD} required value={scope ? selectedScope : ''} onChange={event => {
        const nextScope = context.scopes.find(item => `${item.kind}:${item.key ?? ''}` === event.target.value)
        setSelectedScope(event.target.value)
        setCapabilities(previous => previous.filter(capability => nextScope?.capabilities?.includes(capability) ?? true))
      }}><option value="" disabled>Select a scope</option>{context.scopes.map(item => <option key={`${item.kind}:${item.key}`} value={`${item.kind}:${item.key ?? ''}`}>{item.label}</option>)}</select>{scope?.reason ? <span className="block text-label-13 text-secondary">{scope.reason}</span> : scope && !scope.supported && <span className="block text-label-13 text-secondary">Domain data is not supported for this scope.</span>}</label>
    </div>
    <fieldset><legend className="mb-2 text-label-14">Collect</legend><div className="flex flex-wrap gap-x-6 gap-y-2">{Object.values(SeoCapabilities).map(capability => {
      const blocked = blockedByMarkets(capability)
      return <label key={capability} className="flex min-h-11 items-center gap-2 text-label-14"><input type="checkbox" checked={selectedCapabilities.includes(capability)} disabled={!availableCapabilities.includes(capability) || blocked} aria-describedby={blocked && marketNote ? marketNoteId : undefined} onChange={event => setCapabilities(previous => event.target.checked ? [...previous, capability] : previous.filter(item => item !== capability))} />{CAPABILITY_LABELS[capability]}</label>
    })}</div>{scope?.capabilities && <p className="mt-1 text-copy-13 text-secondary">Available datasets follow this scope and source. Changing scope clears unsupported selections.</p>}{marketNote && <p id={marketNoteId} className="mt-1 text-copy-13 text-secondary">{marketNote}</p>}</fieldset>
    {needsTargets && <fieldset className="space-y-3"><legend className="mb-2 text-label-14">Targets</legend><p className="text-copy-13 text-secondary">{ranksMarkets ? 'Market rankings report the Google rank of one target: one of this project’s own domains.' : 'Domain comparison requires a domain including its subdomains. Exact hosts are supported only by compatible datasets.'}</p>
      {targets.map((target, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_13rem_auto]">
        <label className="space-y-1 text-label-14"><span className="sr-only">Target {index + 1}</span><input className={FIELD} value={target.value} placeholder="example.com" aria-label={`Target ${index + 1}`} onChange={event => updateTarget(index, { value: event.target.value })} required maxLength={253} /></label>
        <label className="space-y-1 text-label-14"><span className="sr-only">Target {index + 1} kind</span><select className={FIELD} aria-label={`Target ${index + 1} kind`} value={target.kind} onChange={event => updateTarget(index, { kind: event.target.value as SeoTarget['kind'], includeSubdomains: event.target.value === SeoTargetKinds.domain })}><option value={SeoTargetKinds.domain}>Domain + subdomains</option><option value={SeoTargetKinds.host}>Exact host</option></select></label>
        <Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={() => setTargets(previous => previous.filter((_, targetIndex) => targetIndex !== index))} aria-label={`Remove target ${index + 1}`}>Remove</Button>
      </div>)}
      <Button type="button" variant="secondary" className="pointer-coarse:min-h-11" disabled={targets.length >= (ranksMarkets ? 1 : 20)} onClick={() => setTargets(previous => [...previous, { kind: SeoTargetKinds.domain, value: '', includeSubdomains: true }])}>Add target</Button>
    </fieldset>}
    {selectedCapabilities.includes(SeoCapabilities['keyword-metrics']) && <label className="block space-y-1.5 text-label-14"><span>Searches</span><textarea className={`${FIELD} min-h-28`} value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="One search per line" /><span className="block text-label-13 text-secondary">Up to 700 searches to measure, each at most 10 words and 80 characters.</span></label>}
    <div className={`grid gap-4 ${needsRankedLimit ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}><label className="space-y-1.5 text-label-14"><span>Provider location code</span><input className={FIELD} type="number" min={1} step={1} required value={locationCode} onChange={event => setLocationCode(event.target.value)} /><span className="block text-label-13 text-secondary">{ranksMarkets ? 'Used only when the project has no markets or locations.' : 'The source’s location identifier.'}</span></label><label className="space-y-1.5 text-label-14"><span>Language code</span><input className={FIELD} required minLength={2} maxLength={10} value={languageCode} onChange={event => setLanguageCode(event.target.value)} /></label>{needsRankedLimit && <label className="space-y-1.5 text-label-14"><span>Ranked searches per target</span><input className={FIELD} type="number" min={1} max={1000} step={1} required value={limit} onChange={event => setLimit(event.target.value)} /></label>}</div>
    {error && <p role="alert" className="text-copy-14 text-secondary">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="pointer-coarse:min-h-11" disabled={save.isPending || !source || !selectedCapabilities.length}>{save.isPending ? 'Saving…' : 'Save profile'}</Button><Button type="button" variant="ghost" className="pointer-coarse:min-h-11" onClick={onClose}>Cancel</Button></div>
  </form>
}

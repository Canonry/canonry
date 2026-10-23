import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Loader2, Plus, RefreshCw, X } from 'lucide-react'
import {
  RatioUnits, SeoAvailability, SeoCapabilities, SeoProviders, SeoRunStatuses, SeoScopeKinds,
  SeoTargetKinds, formatDate, formatZonedTimestamp, formatPercent, seoProfileInputSchema,
  type SeoCapability, type SeoContext, type SeoDomainIntelligence, type SeoKeywordMetrics,
  type SeoProfile, type SeoProfileInput, type SeoProvenance, type SeoRankedKeyword,
  type SeoRun, type SeoRunStatus, type SeoSyncInput, type SeoTarget,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameSeoContextOptions,
  getApiV1ProjectsByNameSeoProfilesOptions,
  getApiV1ProjectsByNameSeoOverviewOptions,
  getApiV1ProjectsByNameSeoRankedKeywordsOptions,
  getApiV1ProjectsByNameSeoKeywordMetricsOptions,
  getApiV1ProjectsByNameSeoDomainIntelligenceOptions,
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
import { DataTablePagination, MiddleTruncatedText } from '../shared/DataTableControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

const CAPABILITY_LABELS: Record<SeoCapability, string> = {
  [SeoCapabilities['keyword-metrics']]: 'Keyword metrics',
  [SeoCapabilities['domain-intelligence']]: 'Domain comparison',
  [SeoCapabilities['ranked-keywords']]: 'Ranked keywords',
}
const PROVIDER_LABELS: Record<SeoProvenance['provider'], string> = {
  [SeoProviders.dataforseo]: 'DataForSEO',
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
const FIELD = 'min-h-11 w-full rounded-md border border-default bg-bg px-3 py-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const CELL = 'px-4 py-3 text-right tabular-nums whitespace-nowrap'
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

function DataProvenance({ source }: { source: SeoProvenance }) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
      <div><dt className="text-muted">Source</dt><dd>{PROVIDER_LABELS[source.provider]} · {source.dataset}</dd></div>
      <div><dt className="text-muted">Search engine</dt><dd>Google · device not specified by source</dd></div>
      <div><dt className="text-muted">Provider geography</dt><dd>Location {source.locationCode} · {source.languageCode}</dd></div>
      <div><dt className="text-muted">Collected</dt><dd>{formatZonedTimestamp(source.collectedAt, TIME_ZONE)}</dd></div>
      <div><dt className="text-muted">Source updated</dt><dd>{source.sourceUpdatedAt ? formatDate(source.sourceUpdatedAt) : 'Not supplied'}</dd></div>
    </dl>
  )
}

function EvidenceDetails({ label, source, children }: { label: string; source: SeoProvenance; children?: ReactNode }) {
  return (
    <details className="text-left">
      <summary className="flex min-h-11 cursor-pointer items-center text-[13px] text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">Details<span className="sr-only"> for {label}</span></summary>
      <div className="min-w-56 space-y-4 pb-3 text-[13px] leading-relaxed text-secondary">
        {children}
        <DataProvenance source={source} />
      </div>
    </details>
  )
}

function ReadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default p-4 text-sm"><p>{extractErrorMessage(error)}</p><Button variant="secondary" className="min-h-11" onClick={retry}>Retry</Button></div>
}

function EmptyEvidence({ title, children }: { title: string; children: ReactNode }) {
  return <div className="py-12 text-center"><h3 className="font-medium text-heading">{title}</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-secondary">{children}</p></div>
}

export function SeoDataSection({ projectName }: { projectName: string }) {
  const search = useSearch({ strict: false }) as { seoProfileId?: string; seoRunId?: string }
  const navigate = useNavigate()
  const context = useQuery(getApiV1ProjectsByNameSeoContextOptions({ client: heyClient, path: { name: projectName } }))
  const profiles = useQuery(getApiV1ProjectsByNameSeoProfilesOptions({ client: heyClient, path: { name: projectName } }))
  const selectedRun = useQuery({ ...getApiV1ProjectsByNameSeoRunsByIdOptions({ client: heyClient, path: { name: projectName, id: search.seoRunId ?? '' } }), enabled: Boolean(search.seoRunId) })
  const [editor, setEditor] = useState<{ profile?: SeoProfile; id: string } | null>(null)
  const requestedProfileId = search.seoProfileId ?? selectedRun.data?.profileId
  const selected = requestedProfileId
    ? profiles.data?.profiles.find(profile => profile.id === requestedProfileId)
    : search.seoRunId ? undefined : profiles.data?.profiles[0]
  const selectProfile = (id: string) => {
    setEditor(null)
    void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoProfileId: id, seoRunId: undefined }) })
  }
  const canWrite = context.data?.access.canWrite === true && !isEmbed() && !isPublicDemo()
  useEffect(() => {
    if (!search.seoProfileId && selected) {
      void navigate({ to: '/projects/$projectName/seo-data', params: { projectName }, search: previous => ({ ...previous, seoProfileId: selected.id }), replace: true })
    }
  }, [navigate, projectName, search.seoProfileId, selected])

  if (context.error) return <ReadError error={context.error} retry={() => { void context.refetch() }} />
  if (profiles.error) return <ReadError error={profiles.error} retry={() => { void profiles.refetch() }} />
  if (search.seoRunId && selectedRun.error) return <ReadError error={selectedRun.error} retry={() => { void selectedRun.refetch() }} />
  if (search.seoRunId && selectedRun.isPending) return <p role="status" className="py-10 text-sm text-secondary">Loading refresh…</p>
  if (!context.data || !profiles.data) return <p role="status" className="py-10 text-sm text-secondary">Loading SEO data…</p>
  const scope = selected && context.data.scopes.find(item => item.kind === selected.scope.kind && item.key === (selected.scope.key ?? null))

  return (
    <section aria-label="SEO data" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-xl font-semibold tracking-tight text-heading">SEO data</h2><p className="mt-1 text-sm text-secondary">Search demand and organic rankings.</p></div>
        {canWrite && <div className="flex flex-wrap gap-2">
          {selected && <Button variant="ghost" className="min-h-11" onClick={() => setEditor({ profile: selected, id: selected.id })}>Edit profile</Button>}
          <Button variant="secondary" className="min-h-11" onClick={() => setEditor({ id: crypto.randomUUID() })}><Plus aria-hidden="true" className="size-4" />New profile</Button>
        </div>}
      </div>

      {profiles.data.profiles.length > 0 && <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-subtle py-3">
        <label className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none"><span className="text-[13px] text-secondary">Profile</span><select aria-label="SEO profile" value={selected?.id ?? ''} onChange={event => selectProfile(event.target.value)} className={`${FIELD} min-w-0 sm:w-64`}>
          {!selected && <option value="" disabled>Profile unavailable</option>}
          {profiles.data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        {selected && <div className="min-w-0 text-[13px] text-secondary"><p className="break-words font-medium text-primary">{scope?.label ?? `${selected.scope.kind}${selected.scope.key ? `: ${selected.scope.key}` : ''}`}</p><p>Location {selected.locationCode} · {selected.languageCode}</p></div>}
      </div>}

      {editor && <SeoProfileEditor key={editor.id} projectName={projectName} context={context.data} profile={editor.profile} id={editor.id} onClose={() => setEditor(null)} onSaved={selectProfile} />}
      {!context.data.available && <p role="status" className="rounded-md border border-default px-4 py-3 text-sm text-secondary">{context.data.reason ?? 'SEO data is not configured. Ask your administrator to connect a source.'}</p>}
      {selected && selectedRun.data && selectedRun.data.profileId !== selected.id ? <EmptyEvidence title="Refresh belongs to another profile">Choose the refresh’s profile, or return to the selected profile’s latest data.<Button variant="secondary" className="mt-4 min-h-11" onClick={() => selectProfile(selected.id)}>View latest data</Button></EmptyEvidence> : selected ? <SeoProfileWorkspace key={`${selected.id}:${selected.revision}:${search.seoRunId ?? ''}`} projectName={projectName} profile={selected} context={context.data} selectedRunId={search.seoRunId} onLatest={() => selectProfile(selected.id)} /> : requestedProfileId ? (
        <EmptyEvidence title="Profile unavailable">This saved profile is no longer available. Select another profile to view its data.</EmptyEvidence>
      ) : !editor && <EmptyEvidence title="No SEO data yet">{canWrite ? 'Create a profile to choose the scope, source, and keywords to measure.' : 'Ask a project administrator to create an SEO profile.'}</EmptyEvidence>}
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
      <div className="min-w-0 text-sm text-secondary" aria-live="polite">
        {active && latest ? <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{latest.cancelRequested ? 'Cancellation requested' : STATUS_LABELS[latest.status]} · {latest.completedTasks} of {latest.taskCount} tasks completed</p>
          : evidence?.finishedAt && (evidence.status === SeoRunStatuses.completed || evidence.status === SeoRunStatuses.partial) ? <p>{evidence.status === SeoRunStatuses.partial ? 'Partial refresh finished' : 'Last completed'} <time dateTime={evidence.finishedAt}>{formatZonedTimestamp(evidence.finishedAt, TIME_ZONE)}</time></p> : <p>No completed refresh</p>}
      </div>
      {selectedRunId ? <Button variant="secondary" className="min-h-11" onClick={onLatest}>View latest data</Button> : canRun ? <Button className="min-h-11" disabled={busy || active || !context.available || !connection} onClick={asyncHandler(refresh)}><RefreshCw aria-hidden="true" className={`size-4 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Starting refresh…' : active ? 'Refresh in progress' : pendingSync.current ? 'Retry refresh' : 'Refresh data'}</Button>
        : <span className="text-[13px] text-secondary">Read-only access</span>}
    </div>
    {error && <p role="alert" className="rounded-md border border-default p-4 text-sm text-secondary">{error}{pendingSync.current && ' Retry uses the same request, so it will not start a duplicate refresh.'}</p>}
    {selectedRunId && <p className="break-all text-[13px] text-secondary">Viewing saved refresh {selectedRunId}.</p>}
    {overview.data?.evidenceRun && overview.data.evidenceRun.profileRevision !== profile.revision && <p role="status" className="text-sm text-secondary">Saved data uses profile revision {overview.data.evidenceRun.profileRevision} · Location {overview.data.evidenceRun.locationCode} · {overview.data.evidenceRun.languageCode}. The current profile has changed.</p>}
    {scope && !scope.supported && <p role="status" className="text-sm text-secondary">{scope.reason ?? 'This scope is not supported for domain data.'}</p>}
    {latest && !active && latest.status !== SeoRunStatuses.completed && <div className="flex flex-wrap items-center gap-3 text-sm text-secondary"><RunBadge status={latest.status} /><span>{latest.error ?? 'Open Activity for refresh details.'}</span></div>}
    {overview.error ? <ReadError error={overview.error} retry={() => { void overview.refetch() }} /> : overview.data?.summary && <div>
      <p className="mb-3 break-words text-[13px] text-secondary">{overview.data.summary.target.value}{overview.data.summary.target.includeSubdomains ? ' · includes subdomains' : ' · exact host'}</p>
      <dl className="grid grid-cols-1 gap-5 border-b border-subtle pb-5 sm:grid-cols-3">
        <div><dt className="text-[13px] text-secondary">Organic keywords</dt><dd className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-heading"><Value value={overview.data.summary.organicKeywords} /></dd></div>
        <div><dt className="text-[13px] text-secondary">In the top 10</dt><dd className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-heading"><Value value={overview.data.summary.inTop10} /></dd></div>
        <div><dt className="flex items-center gap-1.5 text-[13px] text-secondary">Estimated organic traffic<InfoTooltip text={`${PROVIDER_LABELS[overview.data.summary.provenance.provider]}'s modeled search traffic for this target and provider geography. This is not measured site traffic.`} /></dt><dd className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-heading"><Value value={overview.data.summary.estimatedOrganicTraffic} /></dd></div>
      </dl>
    </div>}
    <div>
      <div className="flex flex-wrap gap-x-5 border-b border-subtle" aria-label="SEO views">
        {[...evidenceCapabilities, 'activity' as const].map(item => <button key={item} type="button" aria-pressed={selectedView === item} className={`min-h-11 border-b-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 ${selectedView === item ? 'border-strong text-primary' : 'border-transparent text-secondary hover:text-primary'}`} onClick={() => setView(item)}>{item === 'activity' ? 'Activity' : CAPABILITY_LABELS[item]}</button>)}
      </div>
      {selectedView === 'activity' ? <SeoActivity projectName={projectName} profileId={profile.id} canRun={canRun} selectedRunId={selectedRunId} />
        : overview.isPending ? <p role="status" className="py-8 text-sm text-secondary">Loading saved data…</p>
          : overview.data && <SeoEvidence key={`${profile.id}:${selectedView}:${overview.data.evidenceRunId ?? 'empty'}`} projectName={projectName} profileId={profile.id} runId={overview.data.evidenceRunId} view={selectedView} active={active} />}
    </div>
    <details className="border-t border-subtle text-sm text-secondary">
      <summary className="flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400">Data details</summary>
      <div className="space-y-4 pb-3 text-[13px] leading-relaxed">
        <p>Current profile source: {connection?.label ?? 'Source unavailable'}. Google; device not specified by source.</p>
        {overview.data?.evidenceRun && <p>Saved evidence: {overview.data.evidenceRun.scope.kind}{overview.data.evidenceRun.scope.key ? ` · ${overview.data.evidenceRun.scope.key}` : ''}{overview.data.evidenceRun.scope.expectedPlanRevision !== undefined ? ` · plan revision ${overview.data.evidenceRun.scope.expectedPlanRevision}` : ''}. Location {overview.data.evidenceRun.locationCode} · {overview.data.evidenceRun.languageCode} · profile revision {overview.data.evidenceRun.profileRevision}.</p>}
        <p>These are provider estimates and observed search rankings. Missing values are shown as a dash. Keyword difficulty is a source score out of 100.</p>
        <p>Current profile targets:</p><ul className="space-y-1">{profile.targets.map((target, index) => <li key={index} className="break-words">{target.value} · {target.includeSubdomains ? 'includes subdomains' : 'exact host'}</li>)}</ul>
        {profile.scope.expectedPlanRevision !== undefined && <p>Saved measurement plan revision {profile.scope.expectedPlanRevision}.</p>}
        {overview.data?.summary && <DataProvenance source={overview.data.summary.provenance} />}
      </div>
    </details>
  </div>
}

function SeoEvidence({ projectName, profileId, runId, view, active }: { projectName: string; profileId: string; runId: string | null; view: SeoCapability; active: boolean }) {
  const [page, setPage] = useState(1)
  const args = { client: heyClient, path: { name: projectName }, query: { profileId, runId: runId ?? undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE } }
  const ranked = useQuery({ ...getApiV1ProjectsByNameSeoRankedKeywordsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['ranked-keywords'] })
  const keywords = useQuery({ ...getApiV1ProjectsByNameSeoKeywordMetricsOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['keyword-metrics'] })
  const domains = useQuery({ ...getApiV1ProjectsByNameSeoDomainIntelligenceOptions(args), enabled: Boolean(runId) && view === SeoCapabilities['domain-intelligence'] })
  const selected = view === SeoCapabilities['ranked-keywords'] ? ranked : view === SeoCapabilities['keyword-metrics'] ? keywords : domains
  if (!runId) return <EmptyEvidence title="No saved data yet">Refresh this profile to collect {CAPABILITY_LABELS[view].toLowerCase()} for its saved scope.</EmptyEvidence>
  if (selected.error) return <div className="py-4"><ReadError error={selected.error} retry={() => { void selected.refetch() }} /></div>
  if (!selected.data) return <p role="status" className="py-8 text-sm text-secondary">Loading {CAPABILITY_LABELS[view].toLowerCase()}…</p>
  if (selected.data.items.length === 0) return <EmptyEvidence title={active ? 'Refresh in progress' : 'No results returned'}>{active ? 'This profile is collecting data.' : 'The source did not return records for this scope. Review the refresh in Activity before changing the profile.'}</EmptyEvidence>
  return <div className="pt-4">
      <div className="relative overflow-x-auto rounded-md border border-default" role="region" aria-label={`${CAPABILITY_LABELS[view]} table`} tabIndex={0}>
      {view === SeoCapabilities['ranked-keywords'] && ranked.data && <RankedTable rows={ranked.data.items} />}
      {view === SeoCapabilities['keyword-metrics'] && keywords.data && <KeywordTable rows={keywords.data.items} />}
      {view === SeoCapabilities['domain-intelligence'] && domains.data && <DomainTable rows={domains.data.items} />}
    </div>
    <DataTablePagination page={page} pageSize={PAGE_SIZE} visibleRows={selected.data.items.length} totalRows={selected.data.total} onPageChange={setPage} disabled={selected.isFetching} className="text-[13px] [&_button]:min-h-11" />
  </div>
}

function RankedTable({ rows }: { rows: SeoRankedKeyword[] }) {
  return <table className="w-full text-sm"><caption className="sr-only">Ranked keywords from the selected refresh</caption><thead className="bg-surface text-[13px] text-secondary"><tr><th className="px-4 py-3 text-left font-medium">Keyword</th><th className={`${CELL} font-medium`}>Position</th><th className={`${CELL} font-medium`}>Volume</th><th className={`${CELL} font-medium`}>Est. traffic</th><th className={`${CELL} font-medium`}>Difficulty /100</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${row.keyword}:${index}`}>
    <th scope="row" className="min-w-56 px-4 py-3 text-left font-normal"><p className="text-primary">{row.keyword}</p><p className="mt-1 text-[13px] text-secondary"><MiddleTruncatedText value={row.url ?? row.target.value} /></p></th>
    <td className={CELL}><Value value={row.rankOrganic} /></td><td className={CELL}><Value value={row.searchVolume} /></td><td className={CELL}><Value value={row.estimatedTraffic} /></td><td className={CELL}><Value value={row.keywordDifficulty} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={row.keyword} source={row.provenance}><p className="break-all">{row.url ?? 'Ranking URL not supplied'}</p><p>Target: {row.target.value} · {row.target.includeSubdomains ? 'includes subdomains' : 'exact host'}</p><p>Absolute position: <Value value={row.rankAbsolute} /> · CPC: <Value value={row.cpcUsd} currency /></p><p>SERP features: {row.serpFeatures.length ? row.serpFeatures.join(', ') : 'Not supplied'}</p></EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function KeywordTable({ rows }: { rows: SeoKeywordMetrics[] }) {
  return <table className="w-full text-sm"><caption className="sr-only">Keyword metrics from the selected refresh</caption><thead className="bg-surface text-[13px] text-secondary"><tr><th className="px-4 py-3 text-left font-medium">Keyword</th><th className={`${CELL} font-medium`}>Volume</th><th className={`${CELL} font-medium`}>CPC</th><th className={`${CELL} font-medium`}>Difficulty /100</th><th className="px-4 py-3 text-left font-medium">Intent</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.keyword}:${index}`}>
    <th scope="row" className="min-w-56 px-4 py-3 text-left font-normal text-primary">{row.keyword}</th><td className={CELL}><Value value={row.searchVolume} /></td><td className={CELL}><Value value={row.cpcUsd} currency /></td><td className={CELL}><Value value={row.keywordDifficulty} /></td><td className="px-4 py-3">{row.searchIntent ?? 'Not supplied'}</td>
    <td className="px-4 align-top"><EvidenceDetails label={row.keyword} source={row.provenance}><p>Ad competition: {row.adCompetition === null ? 'Not supplied' : formatPercent(row.adCompetition, RatioUnits.fraction)}</p><p>Core keyword: {row.coreKeyword ?? 'Not supplied'}</p>{row.monthlySearches.length > 0 && <dl>{row.monthlySearches.map(month => <div key={`${month.year}-${month.month}`} className="flex justify-between gap-5"><dt>{month.year}-{String(month.month).padStart(2, '0')}</dt><dd><Value value={month.searchVolume} /></dd></div>)}</dl>}</EvidenceDetails></td>
  </tr>)}</tbody></table>
}

function DomainTable({ rows }: { rows: SeoDomainIntelligence[] }) {
  return <table className="w-full text-sm"><caption className="sr-only">Domain comparison from the selected refresh</caption><thead className="bg-surface text-[13px] text-secondary"><tr><th className="px-4 py-3 text-left font-medium">Domain</th><th className={`${CELL} font-medium`}>Organic keywords</th><th className={`${CELL} font-medium`}>Est. organic traffic</th><th className="px-4"><span className="sr-only">Evidence</span></th></tr></thead><tbody className="divide-y divide-subtle">{rows.map((row, index) => <tr key={`${row.target.value}:${index}`}>
    <th scope="row" className="min-w-56 px-4 py-3 text-left font-normal"><p className="text-primary">{row.target.value}</p><p className="mt-1 text-[13px] text-secondary">{row.target.includeSubdomains ? 'Includes subdomains' : 'Exact host'}</p></th><td className={CELL}><Value value={row.organicKeywords} /></td><td className={CELL}><Value value={row.estimatedOrganicTraffic} /></td>
    <td className="px-4 align-top"><EvidenceDetails label={row.target.value} source={row.provenance}><dl className="grid grid-cols-2 gap-2"><dt>Position 1</dt><dd><Value value={row.top1} /></dd><dt>Positions 2–3</dt><dd><Value value={row.top2To3} /></dd><dt>Positions 4–10</dt><dd><Value value={row.top4To10} /></dd><dt>Positions 11–20</dt><dd><Value value={row.top11To20} /></dd><dt>Est. traffic value</dt><dd><Value value={row.estimatedOrganicTrafficValueUsd} currency /></dd></dl></EvidenceDetails></td>
  </tr>)}</tbody></table>
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
  if (!runs.data) return <p role="status" className="py-8 text-sm text-secondary">Loading activity…</p>
  const activityRuns = detail.data && !runs.data.runs.some(run => run.id === detail.data.id) ? [detail.data, ...runs.data.runs] : runs.data.runs
  if (!activityRuns.length) return <EmptyEvidence title="No refreshes yet">Refresh this profile to collect its first saved results.</EmptyEvidence>
  return <div className="divide-y divide-subtle">
    {error && <p role="alert" className="py-3 text-sm">{error}</p>}
    {activityRuns.map(run => <div key={run.id} className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="space-y-2"><div className="flex flex-wrap items-center gap-3"><RunBadge status={run.status} /><span className="text-sm">{formatZonedTimestamp(run.createdAt, TIME_ZONE)}</span></div><p className="text-[13px] text-secondary">{run.completedTasks} of {run.taskCount} tasks completed{run.failedTasks > 0 ? ` · ${run.failedTasks} failed` : ''}</p></div><div className="flex gap-2"><Button variant="ghost" className="min-h-11" aria-expanded={detailId === run.id} aria-controls={`seo-run-${run.id}`} onClick={() => setDetailId(detailId === run.id ? null : run.id)}>Details<span className="sr-only"> for refresh {run.id}</span></Button>{canRun && isActive(run) && <Button variant="secondary" className="min-h-11" disabled={cancel.isPending || run.cancelRequested} onClick={asyncHandler(() => stop(run.id))}>{run.cancelRequested ? 'Cancellation requested' : 'Cancel refresh'}</Button>}</div></div>
      {detailId === run.id && <div id={`seo-run-${run.id}`} className="mt-4 space-y-3 rounded-md bg-surface p-4 text-[13px] text-secondary">
        <p className="break-all">Refresh {run.id}</p><p>Profile revision {run.profileRevision} · Location {run.locationCode} · {run.languageCode}</p><p>Scope: {run.scope.kind}{run.scope.key ? ` · ${run.scope.key}` : ''}{run.scope.expectedPlanRevision !== undefined ? ` · plan revision ${run.scope.expectedPlanRevision}` : ''}</p>{run.error && <p>{run.error}</p>}
        {detail.error ? <ReadError error={detail.error} retry={() => { void detail.refetch() }} /> : detail.data ? <ul className="space-y-3">{detail.data.tasks.map(task => <li key={task.id}><div className="flex flex-wrap items-center justify-between gap-2"><span>{CAPABILITY_LABELS[task.capability]}{task.target ? ` · ${task.target.value}` : ''}</span><RunBadge status={task.status} /></div>{task.error && <p className="mt-1">{task.error}</p>}</li>)}</ul> : <p role="status">Loading refresh details…</p>}
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
  const submit = async () => {
    if (!context.access.canWrite || isEmbed() || isPublicDemo() || save.isPending) return
    if (!scope) { setError('Choose a measurement scope.'); return }
    const input: SeoProfileInput = {
      name, connectionId, capabilities: selectedCapabilities, targets, keywords: keywords.split('\n').map(keyword => keyword.trim()).filter(Boolean),
      locationCode: Number(locationCode), languageCode, limit: Number(limit),
      scope: { kind: scope.kind, ...(scope.key ? { key: scope.key } : {}), ...(scope.planRevision !== undefined ? { expectedPlanRevision: scope.planRevision } : {}) },
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
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium text-heading">{profile ? 'Edit profile' : 'New profile'}</h3><Button type="button" variant="ghost" className="size-11 p-0" aria-label="Close profile editor" onClick={onClose}><X className="size-4" aria-hidden="true" /></Button></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-sm"><span>Profile name</span><input className={FIELD} required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label>
      <label className="space-y-1.5 text-sm"><span>Source</span><select className={FIELD} required value={connectionId} onChange={event => {
        const nextSource = context.connections.find(connection => connection.id === event.target.value)
        setConnectionId(event.target.value)
        setCapabilities(previous => previous.filter(capability => nextSource?.capabilities.includes(capability)))
      }}><option value="" disabled>Select a source</option>{context.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
      <label className="space-y-1.5 text-sm sm:col-span-2"><span>Measurement scope</span><select className={FIELD} required value={scope ? selectedScope : ''} onChange={event => {
        const nextScope = context.scopes.find(item => `${item.kind}:${item.key ?? ''}` === event.target.value)
        setSelectedScope(event.target.value)
        setCapabilities(previous => previous.filter(capability => nextScope?.capabilities?.includes(capability) ?? true))
      }}><option value="" disabled>Select a scope</option>{context.scopes.map(item => <option key={`${item.kind}:${item.key}`} value={`${item.kind}:${item.key ?? ''}`}>{item.label}</option>)}</select>{scope?.reason ? <span className="block text-[13px] text-secondary">{scope.reason}</span> : scope && !scope.supported && <span className="block text-[13px] text-secondary">Domain data is not supported for this scope.</span>}</label>
    </div>
    <fieldset><legend className="mb-2 text-sm">Collect</legend><div className="flex flex-wrap gap-x-6 gap-y-2">{Object.values(SeoCapabilities).map(capability => <label key={capability} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selectedCapabilities.includes(capability)} disabled={!availableCapabilities.includes(capability)} onChange={event => setCapabilities(previous => event.target.checked ? [...previous, capability] : previous.filter(item => item !== capability))} />{CAPABILITY_LABELS[capability]}</label>)}</div>{scope?.capabilities && <p className="mt-1 text-[13px] text-secondary">Available datasets follow this scope and source. Changing scope clears unsupported selections.</p>}</fieldset>
    <fieldset className="space-y-3"><legend className="mb-2 text-sm">Targets</legend><p className="text-[13px] text-secondary">Domain comparison requires a domain including its subdomains. Exact hosts are supported only by compatible datasets.</p>
      {targets.map((target, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_13rem_auto]">
        <label className="space-y-1 text-sm"><span className="sr-only">Target {index + 1}</span><input className={FIELD} value={target.value} placeholder="example.com" aria-label={`Target ${index + 1}`} onChange={event => updateTarget(index, { value: event.target.value })} required maxLength={253} /></label>
        <label className="space-y-1 text-sm"><span className="sr-only">Target {index + 1} kind</span><select className={FIELD} aria-label={`Target ${index + 1} kind`} value={target.kind} onChange={event => updateTarget(index, { kind: event.target.value as SeoTarget['kind'], includeSubdomains: event.target.value === SeoTargetKinds.domain })}><option value={SeoTargetKinds.domain}>Domain + subdomains</option><option value={SeoTargetKinds.host}>Exact host</option></select></label>
        <Button type="button" variant="ghost" className="min-h-11" onClick={() => setTargets(previous => previous.filter((_, targetIndex) => targetIndex !== index))} aria-label={`Remove target ${index + 1}`}>Remove</Button>
      </div>)}
      <Button type="button" variant="secondary" className="min-h-11" disabled={targets.length >= 20} onClick={() => setTargets(previous => [...previous, { kind: SeoTargetKinds.domain, value: '', includeSubdomains: true }])}>Add target</Button>
    </fieldset>
    {selectedCapabilities.includes(SeoCapabilities['keyword-metrics']) && <label className="block space-y-1.5 text-sm"><span>Keywords</span><textarea className={`${FIELD} min-h-28`} value={keywords} onChange={event => setKeywords(event.target.value)} placeholder="One keyword per line" /><span className="block text-[13px] text-secondary">Up to 700 keywords, 10 words and 80 characters each. These are explicit search terms for this profile.</span></label>}
    <div className="grid gap-4 sm:grid-cols-3"><label className="space-y-1.5 text-sm"><span>Provider location code</span><input className={FIELD} type="number" min={1} step={1} required value={locationCode} onChange={event => setLocationCode(event.target.value)} /><span className="block text-[13px] text-secondary">The {source ? PROVIDER_LABELS[source.provider] : 'source'} location identifier.</span></label><label className="space-y-1.5 text-sm"><span>Language code</span><input className={FIELD} required minLength={2} maxLength={10} value={languageCode} onChange={event => setLanguageCode(event.target.value)} /></label><label className="space-y-1.5 text-sm"><span>Ranked rows per target</span><input className={FIELD} type="number" min={1} max={1000} step={1} required value={limit} onChange={event => setLimit(event.target.value)} /></label></div>
    {error && <p role="alert" className="text-sm text-secondary">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11" disabled={save.isPending || !source || !selectedCapabilities.length}>{save.isPending ? 'Saving…' : 'Save profile'}</Button><Button type="button" variant="ghost" className="min-h-11" onClick={onClose}>Cancel</Button></div>
  </form>
}

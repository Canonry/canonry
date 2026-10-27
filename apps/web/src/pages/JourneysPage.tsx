import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  AgentJourneyAttributions, AgentJourneyCorrelationBases, JourneyKeyBases,
  JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY, JOURNEY_VISIT_IDLE_MINUTES, RatioUnits,
  UserRoles, VerificationStatuses, formatPercent, journeyEventKindSchema,
  type AgentJourney, type AgentJourneyContext, type AgentJourneyEvent, type AgentJourneysQuery,
  type JourneyDetailResponse, type JourneyEntryClass, type JourneyPartialSources,
  type JourneysQuery, type JourneyVisitorDto, type VerificationStatus,
} from '@canonry/canonry-contracts'
import type { JourneySummaryResponse } from '@canonry/canonry-api-client'
import {
  getApiV1ProjectsOptions,
  getApiV1ProjectsByNameJourneysOptions,
  getApiV1ProjectsByNameJourneysSummaryOptions,
  getApiV1ProjectsByNameJourneysByVisitorKeyOptions,
  getApiV1ProjectsByNameTrafficAgentJourneysOptions,
  getApiV1ProjectsByNameTrafficAgentJourneysByJourneyIdOptions,
} from '@canonry/canonry-api-client/react-query'
import { heyClient, isEmbed } from '../api.js'
import { Button } from '../components/ui/button.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { useAccount } from '../contexts/account-context.js'
import { extractErrorMessage } from '../lib/extract-error-message.js'
import { formatTimestamp, localTimeZoneLabel } from '../lib/format-helpers.js'
import { trackUiAction, trackUiFilterChange } from '../lib/ui-telemetry.js'

type JourneysSearch = { project?: string; tab?: 'visitors' | 'agents' }

export function JourneysPage() {
  const { account } = useAccount()
  const search = useSearch({ strict: false }) as JourneysSearch
  const navigate = useNavigate()
  const tab = search.tab === 'agents' ? 'agents' : 'visitors'
  const allowed = !isEmbed() && account?.role !== UserRoles.viewer
  const projectsQuery = useQuery({ ...getApiV1ProjectsOptions({ client: heyClient }), enabled: allowed })
  const projects = projectsQuery.data ?? []
  const firstProject = projects.at(0)
  const activeProject = search.project ?? firstProject?.name ?? ''
  const selectedProject = projects.find(project => project.name === activeProject)
  useEffect(() => {
    if (!allowed || search.project !== undefined || !firstProject) return
    void navigate({ to: '/journeys', search: { project: firstProject.name, tab }, replace: true })
  }, [allowed, search.project, firstProject, tab, navigate])

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Journeys</h1>
        </div>
        {allowed && projects.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-secondary">
            Project
            <select className={`${JOURNEY_SELECT_CLASS} min-w-44 max-w-full`} value={activeProject} onChange={event => {
              trackUiFilterChange('other')
              void navigate({ to: '/journeys', search: { project: event.target.value, tab }, replace: true })
            }}>
              {!selectedProject && <option value={activeProject}>Project unavailable</option>}
              {projects.map(project => <option key={project.id} value={project.name}>{project.displayName ?? project.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {!allowed ? <p className="text-sm text-secondary">Journey details are unavailable for viewer accounts and embedded reports.</p>
        : projectsQuery.isPending ? <p role="status" className="py-6 text-sm text-secondary">Loading projects…</p>
          : projectsQuery.isError ? <div role="alert" className="space-y-2 text-sm text-secondary"><p>Could not load projects. {extractErrorMessage(projectsQuery.error)}</p><Button size="sm" variant="outline" onClick={() => { void projectsQuery.refetch() }}>Retry projects</Button></div>
            : projects.length === 0 ? <p className="py-6 text-sm text-secondary">Create a project and connect a traffic source to start recording journeys.</p>
              : !selectedProject ? <p className="py-6 text-sm text-secondary">This project is not available. Select another project.</p>
                : (
                  <>
                    <nav aria-label="Journey views" className="mb-6 flex gap-6 border-b border-default">
                      {([{ value: 'visitors', label: 'Visitor journeys' }, { value: 'agents', label: 'Agent journeys' }] as const).map(item => (
                        <Link key={item.value} to="/journeys" search={{ project: activeProject, tab: item.value }} aria-current={tab === item.value ? 'page' : undefined} onClick={() => { if (tab !== item.value) trackUiFilterChange('other') }} className={`border-b-2 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500 ${tab === item.value ? 'border-mono-200 text-heading' : 'border-transparent text-secondary hover:border-strong hover:text-heading'}`}>
                          {item.label}
                        </Link>
                      ))}
                    </nav>
                    {tab === 'visitors' ? <VisitorJourneysSection key={`visitors:${activeProject}`} projectName={activeProject} /> : <AgentJourneysSection key={`agents:${activeProject}`} projectName={activeProject} />}
                  </>
                )}
    </div>
  )
}

const JOURNEY_PAGE_SIZE = 20
const VISIT_PAGE_SIZE = 10
const REQUEST_PAGE_SIZE = 50
const JOURNEY_SELECT_CLASS = 'h-8 rounded-md border border-base bg-bg px-2 text-sm text-heading outline-none transition hover:border-strong focus-visible:ring-2 focus-visible:ring-mono-500 disabled:opacity-50'
const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  [VerificationStatuses.verified]: 'Verified operator',
  [VerificationStatuses.claimed_unverified]: 'Unverified identity',
  [VerificationStatuses.unknown_ai_like]: 'Unknown identity',
}
const ATTRIBUTION_LABELS: Record<AgentJourneyEvent['attribution'], string> = {
  [AgentJourneyAttributions.matched]: 'Matched',
  [AgentJourneyAttributions.unmatched]: 'No URL match',
  [AgentJourneyAttributions.ambiguous]: 'Ambiguous URL match',
  [AgentJourneyAttributions['unknown-host']]: 'Host not recorded',
  [AgentJourneyAttributions.redacted]: 'URL redacted',
  [AgentJourneyAttributions['not-configured']]: 'No Property plan',
}

const ENTRY_LABELS: Record<JourneyEntryClass, string> = {
  ai: 'AI referral', search: 'Search', social: 'Social', paid: 'Paid', referral: 'Referral', direct: 'Direct',
}

function VisitorJourneysSection({ projectName }: { projectName: string }) {
  const [days, setDays] = useState('30')
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString())
  const [engine, setEngine] = useState('')
  const [returned, setReturned] = useState<NonNullable<JourneysQuery['returned']> | ''>('')
  const [offset, setOffset] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const window = { since: new Date(Date.parse(windowEnd) - Number(days) * 86_400_000).toISOString(), until: windowEnd }
  const summaryQuery = useQuery({
    ...getApiV1ProjectsByNameJourneysSummaryOptions({ client: heyClient, path: { name: projectName }, query: window }),
    staleTime: 30_000,
  })
  const query = useQuery({
    ...getApiV1ProjectsByNameJourneysOptions({ client: heyClient, path: { name: projectName }, query: { ...window, engine: engine || undefined, returned: returned || undefined, limit: JOURNEY_PAGE_SIZE, offset } }),
    staleTime: 30_000,
  })
  const data = query.data
  const resetPage = () => { setOffset(0); setSelectedKey(null) }
  const engines = summaryQuery.data?.byEngine ?? []

  return (
    <section className="space-y-5" aria-labelledby="visitor-journeys-heading">
      <h2 id="visitor-journeys-heading" className="sr-only">Visitor journeys</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-secondary">
            Period
            <select className={JOURNEY_SELECT_CLASS} value={days} onChange={event => { trackUiFilterChange('window'); setDays(event.target.value); resetPage(); setWindowEnd(new Date().toISOString()) }}>
              <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="180">Last 180 days</option>
            </select>
          </label>
          <InfoTooltip placement="bottom" text="The period selects visitors by their first recorded AI referral. Return history can extend beyond it. Visitors are inferred from server requests, not identified people. Shared networks or browser versions can combine different people, and an address change can split one person." />
        </div>
        <Button variant="outline" size="sm" disabled={query.isFetching || summaryQuery.isFetching} onClick={() => { resetPage(); setWindowEnd(new Date().toISOString()) }}>Refresh visitors</Button>
      </div>
      {summaryQuery.isPending ? <p role="status" className="py-4 text-sm text-secondary">Loading visitor summary…</p>
        : summaryQuery.isError ? <div role="alert" className="space-y-2 text-sm text-secondary"><p>Could not load the visitor summary. {extractErrorMessage(summaryQuery.error)}</p><Button size="sm" variant="outline" onClick={() => { void summaryQuery.refetch() }}>Retry summary</Button></div>
          : <VisitorSummary summary={summaryQuery.data} />}

      <div className="space-y-4 border-t border-default pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <details className="text-sm text-secondary">
            <summary className="w-fit cursor-pointer rounded font-medium hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Filter visitors{(engine || returned) && <span className="ml-2 font-normal">{[engine, returned === 'true' ? 'Returned' : returned === 'false' ? 'No recorded return' : ''].filter(Boolean).join(' · ')}</span>}</summary>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm text-secondary">
                First AI engine
                <select className={JOURNEY_SELECT_CLASS} value={engine} onChange={event => { trackUiFilterChange('other'); setEngine(event.target.value); resetPage() }}>
                  <option value="">All engines</option>
                  {engine && !engines.some(item => item.engine === engine) && <option value={engine}>{engine}</option>}
                  {engines.map(item => <option key={item.engine} value={item.engine}>{item.engine}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-sm text-secondary">
                Return visits
                <select className={JOURNEY_SELECT_CLASS} value={returned} onChange={event => { trackUiFilterChange('other'); setReturned(event.target.value as typeof returned); resetPage() }}>
                  <option value="">All visitors</option><option value="true">Returned</option><option value="false">No recorded return</option>
                </select>
              </label>
            </div>
            <p className="mt-3 max-w-prose">Filters apply to this list. The summary includes all engines and return states.</p>
          </details>
          {data && <p role="status" className="text-sm text-secondary">{data.totalVisitors.toLocaleString()} visitors in this selection</p>}
        </div>
        {query.isPending ? <p role="status" className="py-6 text-sm text-secondary">Loading visitor journeys…</p>
          : query.isError ? <div role="alert" className="space-y-2 text-sm text-secondary"><p>Could not load visitor journeys. {extractErrorMessage(query.error)}</p><Button size="sm" variant="outline" onClick={() => { void query.refetch() }}>Retry visitors</Button></div>
            : data ? (
              <>
                {data.partialSources.length > 0 && <div className="flex items-center gap-2 text-sm text-caution"><span>Some later visits may be missing</span><InfoTooltip placement="bottom" text="Some sources do not record later visits. Open Visitor capture coverage for affected sources and their recording limits." /></div>}
                {data.visitors.length === 0 ? <div className="border-y border-default py-8 text-sm text-secondary"><p className="font-medium text-heading">No retained visitor journeys in this selection.</p><p className="mt-1 max-w-prose">Try a different period or filter. Journeys appear after connected traffic sources record AI referrals and subsequent requests.</p><Link to="/traffic" className="mt-2 inline-block text-link hover:underline">Review traffic sources</Link></div>
                  : <div className="overflow-x-auto rounded-md border border-default">
                    <table className="w-full text-sm" aria-label="AI-referred visitors">
                      <thead className="bg-surface-subtle text-left text-[13px] text-secondary"><tr><th className="px-4 py-3">Visitor</th><th className="px-4 py-3">First AI referral</th><th className="px-4 py-3 text-right">Visits</th></tr></thead>
                      <tbody className="divide-y divide-default">{data.visitors.map(visitor => {
                        const expanded = selectedKey === visitor.visitorKey
                        return <Fragment key={visitor.visitorKey}>
                          <tr className={expanded ? 'bg-surface-active' : 'hover:bg-surface-hover'}>
                            <td className="px-4 py-4 align-top"><button type="button" aria-label={`${visitor.device} visitor journey starting ${formatTimestamp(visitor.firstAiAt)}`} aria-expanded={expanded} aria-controls={`visitor-journey-${visitor.visitorKey}`} className="inline-flex items-center gap-1.5 rounded text-left font-medium text-heading hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500" onClick={() => { if (!expanded) trackUiAction('journeys.visitor_open'); setSelectedKey(expanded ? null : visitor.visitorKey) }}>{expanded ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}{visitor.device}</button><p className="mt-1 text-secondary">via {visitor.firstAiEngine}</p>{visitor.keyBasis === JourneyKeyBases.ua && <p className="mt-1 text-[13px] text-caution">Browser-only match</p>}{visitor.cappedDays > 0 && <p className="mt-1 text-[13px] text-caution">Incomplete history</p>}</td>
                            <td className="px-4 py-4 align-top text-secondary"><time dateTime={visitor.firstAiAt}>{formatTimestamp(visitor.firstAiAt)}</time></td>
                            <td className="px-4 py-4 text-right align-top text-heading"><span className="tabular-nums">{visitor.visitCount.toLocaleString()}</span><p className="mt-1 text-[13px] text-secondary">{visitor.returned ? 'Returned' : 'No return recorded'}</p></td>
                          </tr>
                          {expanded && <tr><td colSpan={3} className="bg-surface-subtle p-4 sm:p-6"><VisitorJourneyTimeline key={visitor.visitorKey} projectName={projectName} visitor={visitor} /></td></tr>}
                        </Fragment>
                      })}</tbody>
                    </table>
                  </div>}
                {(data.totalVisitors > data.limit || data.offset > 0) && <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={data.offset === 0 || query.isFetching} onClick={() => { setOffset(Math.max(0, data.offset - data.limit)); setSelectedKey(null) }}>Previous visitors</Button><Button variant="outline" size="sm" disabled={data.offset + data.limit >= data.totalVisitors || query.isFetching} onClick={() => { setOffset(data.offset + data.limit); setSelectedKey(null) }}>Next visitors</Button></div>}
                <VisitorCoverage partialSources={data.partialSources} lookbackDays={data.lookbackDays} retentionDays={data.retentionDays} windowStart={data.windowStart} windowEnd={data.windowEnd} />
              </>
            ) : null}
      </div>
    </section>
  )
}

function VisitorSummary({ summary }: { summary: JourneySummaryResponse }) {
  return (
    <div className="space-y-5 py-2">
      <div>
        <dl className="grid grid-cols-3 gap-x-4 gap-y-5 sm:flex sm:flex-wrap sm:gap-x-12">
          <div><dt className="min-h-10 text-sm text-secondary sm:min-h-0">AI-referred visitors</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-heading">{summary.aiVisitors.toLocaleString()}</dd></div>
          <div><dt className="min-h-10 text-sm text-secondary sm:min-h-0">Returned visitors</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-heading">{summary.returningVisitors.toLocaleString()}</dd></div>
          <div><dt className="min-h-10 text-sm text-secondary sm:min-h-0">Return rate</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-heading">{summary.returnRate === null ? 'Not available' : formatPercent(summary.returnRate, RatioUnits.fraction)}</dd></div>
        </dl>
        <p className="mt-2 text-[13px] text-secondary">First AI referral in period</p>
      </div>
      <details className="text-sm text-secondary">
        <summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Referral and return breakdown</summary>
        <dl className="mt-4 flex flex-wrap gap-x-12 gap-y-4">
          <div><dt>Median time to return</dt><dd className="mt-1 font-medium tabular-nums text-heading">{summary.medianDaysToReturn === null ? 'Not available' : `${summary.medianDaysToReturn} days`}</dd></div>
          <div><dt>AI-referred visits</dt><dd className="mt-1 font-medium tabular-nums text-heading">{summary.aiVisits.toLocaleString()}</dd><p className="mt-1">Started in period, including earlier visitors</p></div>
        </dl>
        <div className="mt-3 grid gap-6 md:grid-cols-2">
          <div><h3 className="mb-2 font-medium text-heading">By first AI engine</h3><table className="w-full text-sm" aria-label="Visitors by first AI engine"><thead className="text-left text-[13px] text-secondary"><tr><th className="py-2">Engine</th><th className="py-2 text-right">Visitors</th><th className="py-2 text-right">Returned visitors</th></tr></thead><tbody className="divide-y divide-default">{summary.byEngine.map(item => <tr key={item.engine}><td className="py-2">{item.engine}</td><td className="py-2 text-right tabular-nums">{item.visitors.toLocaleString()}</td><td className="py-2 text-right tabular-nums">{item.returningVisitors.toLocaleString()}</td></tr>)}</tbody></table>{summary.byEngine.length === 0 && <p className="py-2">No first AI referrals in this period.</p>}</div>
          <div><h3 className="mb-2 font-medium text-heading">Later visits by channel</h3><p>Return visits, not visitors. These can occur after the selected period.</p><dl className="mt-2 divide-y divide-default">{Object.entries(summary.returnedVia).map(([channel, count]) => <div key={channel} className="flex justify-between gap-3 py-2"><dt>{ENTRY_LABELS[channel as JourneyEntryClass]}</dt><dd className="tabular-nums">{count.toLocaleString()}</dd></div>)}</dl></div>
        </div>
        <p className="mt-3">Matching basis: {summary.keyBasis.ipUa.toLocaleString()} network + browser; {summary.keyBasis.ua.toLocaleString()} browser only. Shared networks or browser versions can merge different people, and a changed address can split one person.</p>
      </details>
    </div>
  )
}

function VisitorJourneyTimeline({ projectName, visitor }: { projectName: string; visitor: JourneyVisitorDto }) {
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    ...getApiV1ProjectsByNameJourneysByVisitorKeyOptions({ client: heyClient, path: { name: projectName, visitorKey: visitor.visitorKey }, query: { limit: VISIT_PAGE_SIZE, offset } }),
    staleTime: 30_000,
  })
  return (
    <div id={`visitor-journey-${visitor.visitorKey}`} role="region" aria-label={`${visitor.device} visitor timeline`} className="space-y-4 text-sm">
      <div className="flex items-center gap-2"><h3 className="font-semibold text-heading">Retained visit history</h3><InfoTooltip placement="bottom" text="All retained visits for this visitor, including outside the selected period. Engine and return filters do not narrow this history. These are recorded requests; HTTP responses do not establish a conversion." /></div>
      {query.isPending ? <p role="status" className="text-secondary">Loading retained visits…</p>
        : query.isError ? <div role="alert" className="space-y-2 text-secondary"><p>Could not load this visitor timeline. {extractErrorMessage(query.error)}</p><Button size="sm" variant="outline" onClick={() => { void query.refetch() }}>Retry visitor timeline</Button></div>
          : (
            <>
              <p className="text-secondary">{query.data.totalVisits.toLocaleString()} retained visits · All periods · {localTimeZoneLabel()}</p>
              {query.data.visitor.keyBasis === JourneyKeyBases.ua && <div className="flex items-center gap-2 text-caution"><span>Browser-only match; may include several people</span><InfoTooltip placement="bottom" text="Browser-only matching can combine everyone using the same browser version. This timeline may represent several people." /></div>}
              {query.data.visitor.cappedDays > 0 && <p className="text-caution">Some steps are missing: request limit reached on {query.data.visitor.cappedDays} days.</p>}
              {query.data.visits.length === 0 && <p className="text-secondary">No retained visits on this page.</p>}
              <div className="divide-y divide-default border-y border-default">
                {query.data.visits.map(visit => <VisitorVisit key={visit.id} visit={visit} />)}
              </div>
              {(query.data.totalVisits > query.data.limit || query.data.offset > 0) && <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={query.data.offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, query.data!.offset - query.data!.limit))}>Previous visits</Button><Button variant="outline" size="sm" disabled={query.data.offset + query.data.limit >= query.data.totalVisits || query.isFetching} onClick={() => setOffset(query.data!.offset + query.data!.limit)}>Next visits</Button></div>}
              <details className="text-secondary"><summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Recorded identity</summary><dl className="mt-2 space-y-2"><div><dt className="font-medium text-heading">Visitor key</dt><dd className="break-all font-mono">{query.data.visitor.visitorKey}</dd></div><div><dt className="font-medium text-heading">Matching basis</dt><dd>{query.data.visitor.keyBasis === JourneyKeyBases.ua ? 'Browser only; shared browser versions may combine people.' : 'Network address + browser; shared networks may combine people, and address changes may split them.'}</dd></div><div><dt className="font-medium text-heading">Last recorded request</dt><dd><time dateTime={query.data.visitor.lastSeenAt}>{formatTimestamp(query.data.visitor.lastSeenAt)}</time></dd></div><div><dt className="font-medium text-heading">User agent</dt><dd className="max-w-prose break-all font-mono">{query.data.visitor.userAgent ?? 'Not recorded'}</dd></div></dl></details>
            </>
          )}
    </div>
  )
}

function VisitorVisit({ visit }: { visit: JourneyDetailResponse['visits'][number] }) {
  const [open, setOpen] = useState(false)
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="py-4">
      <summary className="cursor-pointer rounded text-heading hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">
        <span className="ml-1 font-medium">{visit.entryName ?? ENTRY_LABELS[visit.entryClass]}</span>
        {visit.entryName && <span className="ml-2 text-secondary">{ENTRY_LABELS[visit.entryClass]}</span>}{visit.paid && <span className="ml-2 text-secondary">Paid</span>}
        <time dateTime={visit.startedAt} className="ml-3 whitespace-nowrap text-secondary">{formatTimestamp(visit.startedAt)}</time>
        <span className="mt-1 block break-all font-mono">{visit.landingPath}</span>
        <span className="mt-1 block text-secondary">{visit.requestCount.toLocaleString()} {visit.requestCount === 1 ? 'request' : 'requests'}</span>
      </summary>
      {open && (
        <>
          <div className="mt-5">
            <ol className="ml-1 border-l border-default" aria-label={`${visit.entryName ?? ENTRY_LABELS[visit.entryClass]} visit requests`}>
              {visit.events.map((event, eventIndex) => (
                <li key={`${event.ts}:${eventIndex}`} className="relative pb-6 pl-5 last:pb-0">
                  <span aria-hidden="true" className="absolute -left-1 top-1.5 size-2 rounded-full border border-strong bg-bg" />
                  <time dateTime={event.ts} className="text-[13px] text-secondary">{formatTimestamp(event.ts)}</time>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-secondary">{event.method ?? 'Unknown'} </span>
                    <span className="min-w-0 flex-1 break-all font-mono text-heading">{event.path}</span>
                    <span className="text-secondary">HTTP {event.status ?? 'not recorded'}</span>
                  </div>
                  <details className="mt-2 text-[13px] text-secondary"><summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Request details</summary><dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2"><div><dt>Request type</dt><dd className="text-heading">{event.kind === journeyEventKindSchema.enum.page ? 'Page' : 'Data / API'}</dd></div>{event.aiTouch && <div><dt>Referral</dt><dd className="text-heading">AI referral</dd></div>}</dl></details>
                </li>
              ))}
            </ol>
            {visit.events.length === 0 && <p className="py-3 text-secondary">No retained requests for this visit.</p>}
          </div>
          <p className="mt-5 text-[13px] text-secondary">{visit.pageCount.toLocaleString()} page requests · Visit ended {formatTimestamp(visit.endedAt)}{visit.entryHost ? ` · Referral host: ${visit.entryHost}` : ''}</p>
        </>
      )}
    </details>
  )
}

function VisitorCoverage({ partialSources, lookbackDays, retentionDays, windowStart, windowEnd }: { partialSources: JourneyPartialSources; lookbackDays: number; retentionDays: number; windowStart: string; windowEnd: string }) {
  return <details className="text-sm text-secondary">
    <summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Visitor capture coverage</summary>
    <div className="mt-3 max-w-prose space-y-3">
      <p>First recorded AI referral: {formatTimestamp(windowStart)} to {formatTimestamp(windowEnd)}. Later visits are included from retained history, even after this period.</p>
      <p>Project-wide for Simple and Advanced projects. Visitor journeys have no Property, market, tracked query, query class, or model attribution.</p>
      <p>Requests are eligible for {lookbackDays} days after an AI referral and retained for {retentionDays} days. A new visit starts after {JOURNEY_VISIT_IDLE_MINUTES} minutes of inactivity.</p>
      <p>Up to {JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY.toLocaleString()} requests per visitor key per UTC day are stored; AI referrals are always kept. Affected visitors show their capped days.</p>
      <p>Network + browser matches can merge people or split one person. Browser-only matches are weaker and can combine everyone using the same browser version. Page counts include repeat requests, and HTTP responses do not establish a conversion.</p>
      {partialSources.map(source => <div key={source.sourceId}><p className="font-medium text-heading">{source.sourceType}</p><p>{source.reason}</p></div>)}
      <Link to="/traffic" className="inline-block text-link hover:underline">Review traffic sources</Link>
    </div>
  </details>
}

/** Stored requests only. The API owns grouping, attribution, counts and coverage. */
function AgentJourneysSection({ projectName }: { projectName: string }) {
  const [hours, setHours] = useState('24')
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString())
  const [sourceId, setSourceId] = useState('')
  const [agent, setAgent] = useState<{ id: string; label: string } | null>(null)
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus | ''>('')
  const [targetKey, setTargetKey] = useState('')
  const [propertySearch, setPropertySearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterOptions, setFilterOptions] = useState<{ properties: AgentJourneyContext['properties']; sources: AgentJourneyContext['coverage']['sources'] }>({ properties: [], sources: [] })
  const propertyPicker = useRef<HTMLDetailsElement>(null)
  const selection: AgentJourneysQuery = {
    since: new Date(Date.parse(windowEnd) - Number(hours) * 3_600_000).toISOString(),
    until: windowEnd,
    sourceId: sourceId || undefined,
    agentId: agent?.id,
    verificationStatus: verificationStatus || undefined,
    targetKey: targetKey || undefined,
  }
  const query = useQuery({
    ...getApiV1ProjectsByNameTrafficAgentJourneysOptions({
      client: heyClient, path: { name: projectName }, query: { ...selection, limit: JOURNEY_PAGE_SIZE, offset },
    }),
    staleTime: 30_000,
  })
  const data = query.data
  // Keep full-project options during reads and errors, so changing one filter
  // cannot remove another filter's selected option while its request is pending.
  useEffect(() => {
    if (data) setFilterOptions({ properties: data.properties, sources: data.coverage.sources })
  }, [data])
  const properties = data?.properties ?? filterOptions.properties
  const sources = data?.coverage.sources ?? filterOptions.sources
  const selectedProperty = properties.find(property => property.key === targetKey)
  const selectedSource = sources.find(source => source.sourceId === sourceId)
  const resetPage = () => { setOffset(0); setSelectedId(null) }

  return (
    <section className="space-y-4" aria-labelledby="agent-journeys-heading">
      <h2 id="agent-journeys-heading" className="sr-only">Recorded requests</h2>
      <div className="relative flex flex-wrap items-center gap-3">
        <label className="text-sm text-secondary">
          <span className="sr-only">Period</span>
          <select className={JOURNEY_SELECT_CLASS} value={hours} onChange={event => { trackUiFilterChange('window'); setHours(event.target.value); resetPage(); setWindowEnd(new Date().toISOString()) }}>
            <option value="1">Last hour</option>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
            <option value="720">Last 30 days</option>
          </select>
        </label>
        <details className="text-sm">
          <summary className={`${JOURNEY_SELECT_CLASS} cursor-pointer py-1.5`}>Filter agents</summary>
          <div className="absolute left-0 top-full z-20 mt-2 w-72 max-w-full space-y-3 rounded-md border border-strong bg-bg p-3 shadow-lg">
            <label className="grid gap-1 text-sm text-secondary">
              Source
              <select className={`${JOURNEY_SELECT_CLASS} w-full`} value={sourceId} onChange={event => { trackUiFilterChange('other'); setSourceId(event.target.value); resetPage() }}>
                <option value="">All sources</option>
                {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-secondary">
              Identity
              <select className={`${JOURNEY_SELECT_CLASS} w-full`} value={verificationStatus} onChange={event => { trackUiFilterChange('other'); setVerificationStatus(event.target.value as VerificationStatus | ''); resetPage() }}>
                <option value="">All identities</option>
                <option value={VerificationStatuses.verified}>Verified operators</option>
                <option value={VerificationStatuses.claimed_unverified}>Unverified identities</option>
              </select>
            </label>
            {properties.length > 0 && (
              <details ref={propertyPicker}>
                <summary className={`${JOURNEY_SELECT_CLASS} cursor-pointer py-1.5`}>
                  Property: {selectedProperty?.label ?? 'All properties'}
                </summary>
                <div className="mt-2">
                  <input aria-label="Find a property" type="search" value={propertySearch} onChange={event => setPropertySearch(event.target.value)} placeholder="Find a property" className={`${JOURNEY_SELECT_CLASS} mb-2 w-full`} />
                  <div className="max-h-64 overflow-y-auto" role="group" aria-label="Properties">
                    {[{ key: '', label: 'All properties' }, ...properties.filter(property => property.label.toLowerCase().includes(propertySearch.toLowerCase()))].map(property => (
                      <button key={property.key} type="button" aria-pressed={targetKey === property.key} className="block w-full rounded px-2 py-2 text-left text-secondary hover:bg-surface-hover hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500 aria-pressed:bg-surface-active aria-pressed:text-heading" onClick={() => {
                        trackUiFilterChange('other'); setTargetKey(property.key); resetPage()
                        if (propertyPicker.current) { propertyPicker.current.open = false; propertyPicker.current.querySelector('summary')?.focus() }
                      }}>{property.label}</button>
                    ))}
                  </div>
                </div>
              </details>
            )}
          </div>
        </details>
        <Button className="ml-auto" variant="outline" size="sm" disabled={query.isFetching} onClick={() => { resetPage(); setWindowEnd(new Date().toISOString()) }}>
          {query.isFetching ? 'Loading…' : 'Refresh journeys'}
        </Button>
      </div>
      {(sourceId || verificationStatus || targetKey || agent) && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-secondary">
        {sourceId && <span>Source: {selectedSource?.label ?? sourceId}</span>}
        {verificationStatus && <span>Identity: {VERIFICATION_LABELS[verificationStatus]}</span>}
        {targetKey && <span>Property: {selectedProperty?.label ?? targetKey}</span>}
        {agent && <Button size="sm" variant="outline" onClick={() => { trackUiFilterChange('other'); setAgent(null); resetPage() }}>Clear agent: {agent.label}</Button>}
      </div>}

      {query.isPending ? <p role="status" className="py-6 text-sm text-secondary">Loading agent journeys…</p>
        : query.isError ? <div role="alert" className="space-y-2 text-sm text-secondary"><p>Could not load agent journeys. {extractErrorMessage(query.error)}</p><Button size="sm" variant="outline" onClick={() => { void query.refetch() }}>Retry journeys</Button></div>
          : data ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-secondary">
                <p role="status">{data.totalJourneys.toLocaleString()} request sequences · {data.observedRequests.toLocaleString()} recorded requests</p>
                <InfoTooltip placement="bottom" text="Requests from agents acting on behalf of users. An inferred sequence groups the same network address and agent within an inactivity window; shared infrastructure can combine different tasks. Operator verification does not verify a user session. Requests do not prove clicks or completed tasks." />
                {!data.coverage.recordingEnabled && <InfoTooltip placement="bottom" tone="caution" label="Recording disabled" text="Recording disabled. Agent request recording is not enabled on this instance. Saved journeys remain available." />}
                {data.coverage.cappedSourceDays.length > 0 && <InfoTooltip placement="bottom" tone="caution" label="Some requests missing" text="Some requests missing. A source reached its daily recording limit. See capture coverage for affected days and sources." />}
              </div>
              {data.journeys.length === 0 ? (
                <div className="border-y border-default py-8 text-sm text-secondary">
                  <p className="font-medium text-heading">No recorded agent journeys in this selection.</p>
                  <p className="mt-1 max-w-prose">Try a different period or filter. Journeys appear after a connected source records recognized user-triggered agent requests.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-default">
                  <table role="table" className="block w-full min-w-0 text-sm sm:table" aria-label="Agent request sequences">
                    <thead role="rowgroup" className="hidden bg-surface-subtle text-left text-[13px] text-secondary sm:table-header-group">
                      <tr role="row"><th scope="col" className="px-4 py-3">Agent</th><th scope="col" className="px-4 py-3">First request</th><th scope="col" className="px-4 py-3 text-right">Requests</th><th scope="col" className="px-4 py-3">Identity</th></tr>
                    </thead>
                    <tbody role="rowgroup" className="block min-w-0 divide-y divide-default sm:table-row-group">
                      {data.journeys.map(journey => {
                        const expanded = selectedId === journey.id
                        return (
                          <Fragment key={journey.id}>
                            <tr role="row" className={`grid min-w-0 grid-cols-2 sm:table-row ${expanded ? 'bg-surface-active' : 'hover:bg-surface-hover'}`}>
                              <td role="cell" className="order-1 block min-w-0 px-4 pt-4 align-top sm:table-cell sm:py-4">
                                <button type="button" aria-label={`${journey.product} journey starting ${formatTimestamp(journey.startedAt)}`} aria-expanded={expanded} aria-controls={`agent-journey-${journey.id}`} className="inline-flex items-center gap-1.5 rounded text-left font-medium text-heading hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500" onClick={() => { if (!expanded) trackUiAction('journeys.agent_open'); setSelectedId(expanded ? null : journey.id) }}>
                                  {expanded ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
                                  {journey.product}
                                </button>
                              </td>
                              <td role="cell" className="order-3 col-span-2 block min-w-0 px-4 pt-3 align-top sm:table-cell sm:py-4"><span className="mb-1 block text-[13px] text-secondary sm:hidden">First request</span><p className="break-all font-mono text-heading sm:max-w-80 sm:truncate" title={`${journey.firstHost ?? ''}${journey.firstPath}`}>{journey.firstHost}{journey.firstPath}</p><time dateTime={journey.startedAt} className="mt-1 block text-secondary sm:whitespace-nowrap">{formatTimestamp(journey.startedAt)}</time></td>
                              <td role="cell" className="order-2 block min-w-0 px-4 pt-4 text-right align-top tabular-nums text-heading sm:table-cell sm:py-4">{journey.requestCount.toLocaleString()}<span className="ml-1 text-[13px] text-secondary sm:hidden"> {journey.requestCount === 1 ? 'request' : 'requests'}</span>{journey.errorCount > 0 && <p className="mt-1 text-caution sm:whitespace-nowrap">{journey.errorCount.toLocaleString()} HTTP {journey.errorCount === 1 ? 'error' : 'errors'}</p>}</td>
                              <td role="cell" className="order-4 col-span-2 block min-w-0 px-4 py-4 align-top sm:table-cell"><div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:block">{journey.verificationStatuses.map(status => <div key={status} className="sm:mb-1"><ToneBadge tone={status === VerificationStatuses.verified ? 'positive' : 'caution'}>{VERIFICATION_LABELS[status]}</ToneBadge></div>)}<p className="text-secondary">{journey.correlationBasis === AgentJourneyCorrelationBases['ip-ua'] ? 'Inferred sequence' : 'Unlinked request'}</p></div></td>
                            </tr>
                            {expanded && <tr role="row" className="block min-w-0 sm:table-row"><td role="cell" colSpan={4} className="block min-w-0 bg-surface-subtle p-4 sm:table-cell sm:p-6"><AgentJourneyTimeline key={journey.id} projectName={projectName} journey={journey} selection={{ ...selection, since: data.windowStart, until: data.windowEnd }} onSelectAgent={() => { trackUiFilterChange('other'); setAgent({ id: journey.agentId, label: journey.product }); resetPage() }} /></td></tr>}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {(data.totalJourneys > data.limit || data.offset > 0) && <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={data.offset === 0 || query.isFetching} onClick={() => { setOffset(Math.max(0, data.offset - data.limit)); setSelectedId(null) }}>Previous journeys</Button>
                <Button variant="outline" size="sm" disabled={data.offset + data.limit >= data.totalJourneys || query.isFetching} onClick={() => { setOffset(data.offset + data.limit); setSelectedId(null) }}>Next journeys</Button>
              </div>}
              <AgentJourneyCoverage context={data} />
            </>
          ) : null}
    </section>
  )
}

function AgentJourneyTimeline({ projectName, journey, selection, onSelectAgent }: { projectName: string; journey: AgentJourney; selection: AgentJourneysQuery; onSelectAgent: () => void }) {
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    ...getApiV1ProjectsByNameTrafficAgentJourneysByJourneyIdOptions({ client: heyClient, path: { name: projectName, journeyId: journey.id }, query: { ...selection, limit: REQUEST_PAGE_SIZE, offset } }),
    staleTime: 30_000,
  })
  return (
    <div id={`agent-journey-${journey.id}`} role="region" aria-label={`${journey.product} request timeline`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-heading">Requests in order</h3>
          <InfoTooltip placement="bottom" text={journey.correlationBasis === AgentJourneyCorrelationBases['ip-ua']
            ? 'Inferred sequence. Requests are linked by network address and agent identity and may combine different user tasks. Operator verification does not verify a user session; HTTP responses do not prove task completion.'
            : 'Unlinked request. This request has no usable identifier to link it to another request. Operator verification does not verify a user session; HTTP responses do not prove task completion.'} />
        </div>
        <Button size="sm" variant="outline" onClick={onSelectAgent}>Only {journey.product}</Button>
      </div>
      {query.isPending ? <p role="status" className="text-secondary">Loading recorded requests…</p>
        : query.isError ? <div role="alert" className="space-y-2 text-secondary"><p>Could not load this timeline. {extractErrorMessage(query.error)}</p><Button size="sm" variant="outline" onClick={() => { void query.refetch() }}>Retry timeline</Button></div>
          : (
            <>
              <p className="text-secondary">{query.data.coverage.sources.find(source => source.sourceId === query.data.journey.sourceId)?.label ?? query.data.journey.sourceId} · {query.data.totalEvents.toLocaleString()} recorded requests · Times in {localTimeZoneLabel()}</p>
              <ol aria-label={`${journey.product} recorded requests`} className="divide-y divide-default">
                {query.data.events.map(event => (
                  <li key={event.id} className="grid gap-2 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-5">
                    <time dateTime={event.ts} className="text-secondary">{formatTimestamp(event.ts)}</time>
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-1">
                        <div className="min-w-0 flex-1 font-mono text-heading">
                          <span className="mr-2 text-secondary">{event.method ?? 'Unknown method'} </span>
                          <span className="break-all">{event.host ?? 'Unknown host'}{event.path}</span>
                        </div>
                        <span className="whitespace-nowrap tabular-nums text-secondary">{event.status === null ? 'HTTP status not recorded' : `HTTP ${event.status}`}</span>
                      </div>
                      <details className="text-sm text-secondary">
                        <summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Request details</summary>
                        <dl className="mt-2 flex flex-wrap gap-x-8 gap-y-3">
                          <div><dt className="text-secondary">Latency</dt><dd className="mt-1 tabular-nums text-heading">{event.latencyMs === null ? 'Not recorded' : `${event.latencyMs} ms`}</dd></div>
                          <div><dt className="text-secondary">Identity</dt><dd className="mt-1 text-heading">{VERIFICATION_LABELS[event.verificationStatus]}</dd></div>
                          {query.data.scope.mode === 'advanced' && <div><dt className="text-secondary">Property</dt><dd className="mt-1 text-heading">{event.targetKey ? query.data.properties.find(property => property.key === event.targetKey)?.label ?? event.targetKey : ATTRIBUTION_LABELS[event.attribution]}</dd></div>}
                        </dl>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
              {query.data.events.length === 0 && <p className="text-secondary">No recorded requests on this page.</p>}
              {(query.data.totalEvents > query.data.limit || query.data.offset > 0) && <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={query.data.offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, query.data!.offset - query.data!.limit))}>Previous requests</Button><Button variant="outline" size="sm" disabled={query.data.offset + query.data.limit >= query.data.totalEvents || query.isFetching} onClick={() => setOffset(query.data!.offset + query.data!.limit)}>Next requests</Button></div>}
            </>
          )}
    </div>
  )
}

function AgentJourneyCoverage({ context }: { context: AgentJourneyContext }) {
  return (
    <details className="text-sm text-secondary">
      <summary className="w-fit cursor-pointer rounded hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500">Capture coverage</summary>
      <div className="mt-3 max-w-prose space-y-3">
        <p><time dateTime={context.windowStart}>{formatTimestamp(context.windowStart)}</time> to <time dateTime={context.windowEnd}>{formatTimestamp(context.windowEnd)}</time>. Sequences are limited to this period.</p>
        <p>Requests are retained for {context.coverage.retentionDays} days, up to {context.coverage.dailyEventLimit.toLocaleString()} per source per day. Inferred sequences split after {context.coverage.idleMinutes} minutes of inactivity.</p>
        {context.scope.planRevision !== null && <p>Property attribution uses URL matches in current plan revision {context.scope.planRevision}.</p>}
        <p>These requests do not establish the user’s task, market, tracked query, query class, or model.</p>
        <ul className="list-disc space-y-1 pl-5">{context.coverage.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
        {context.coverage.cappedSourceDays.map(cap => <p key={`${cap.sourceId}:${cap.day}`}>Daily limit reached: {context.coverage.sources.find(source => source.sourceId === cap.sourceId)?.label ?? cap.sourceId}, {cap.day} (UTC).</p>)}
        {context.coverage.sources.map(source => <div key={source.sourceId}><p className="font-medium text-heading">{source.label}</p><ul className="list-disc space-y-1 pl-5">{source.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul></div>)}
      </div>
    </details>
  )
}

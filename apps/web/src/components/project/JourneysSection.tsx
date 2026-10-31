import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Filter } from 'lucide-react'
import {
  AgentJourneyAttributions, AgentJourneyCorrelationBases, AgentTrustLevels, JourneyEventFilters, JourneyKeyBases,
  JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY, JOURNEY_VISIT_IDLE_MINUTES, RatioUnits, UserRoles, formatPercent, isJourneyWriteMethod,
  type AgentJourney, type AgentJourneyContext, type AgentJourneyEvent, type AgentJourneysQuery, type AgentTrustReason, type JourneyDetailResponse,
  type JourneyEntryClass, type JourneyEventFilter, type JourneyPartialSources, type JourneyVisitDto, type JourneysQuery,
  type JourneysResponse, type StoredAgentTrust,
} from '@canonry/canonry-contracts'
import type { JourneySummaryResponse } from '@canonry/canonry-api-client'
import {
  getApiV1ProjectsByNameJourneysByVisitorKeyOptions,
  getApiV1ProjectsByNameJourneysOptions,
  getApiV1ProjectsByNameJourneysSummaryOptions,
  getApiV1ProjectsByNameTrafficAgentJourneysByJourneyIdOptions,
  getApiV1ProjectsByNameTrafficAgentJourneysOptions,
} from '@canonry/canonry-api-client/react-query'
import { heyClient, isEmbed } from '../../api.js'
import { Button } from '../ui/button.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { useAccount } from '../../contexts/account-context.js'
import { extractErrorMessage } from '../../lib/extract-error-message.js'
import { formatSweepDay, formatSweepInstant, formatTimestamp, localTimeZoneLabel } from '../../lib/format-helpers.js'
import { trackUiAction, trackUiFilterChange } from '../../lib/ui-telemetry.js'
import { LIKELY_FAKE_HELP, TRUST_LABELS, trustReasonLabel } from '../../lib/agent-trust-copy.js'

/**
 * Project Journeys: AI-referred visitors and the agent requests made on a
 * person's behalf. Every number and grouping comes from the API; the page only
 * lays out stored values. Selection lives in the URL so a view can be shared.
 */
type JourneysSearch = {
  journeyView?: string
  journeyDays?: string
  journeyVisitor?: string
  journeyEngine?: string
  journeyReturned?: string
  journeyOffset?: string
  agentHours?: string
}

const VISITOR_PERIODS = [{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: '180', label: '180d' }] as const
const AGENT_PERIODS = [{ value: '1', label: '1h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }, { value: '720', label: '30d' }] as const
const VISITOR_PAGE_SIZE = 20
const VISIT_PAGE_SIZE = 12
const AGENT_PAGE_SIZE = 20
const REQUEST_PAGE_SIZE = 50
const MAX_CHAIN_STEPS = 4
const SELECT_CLASS = 'h-8 rounded-md border border-base bg-bg px-2 text-sm text-heading outline-none transition hover:border-strong focus-visible:ring-2 focus-visible:ring-mono-500 disabled:opacity-50'
const DISCLOSURE_CLASS = 'inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded text-sm text-secondary hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500 [&::-webkit-details-marker]:hidden'
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500'

const ENTRY_LABELS: Record<JourneyEntryClass, string> = {
  ai: 'AI referral', search: 'Search', social: 'Social', paid: 'Paid', referral: 'Referral', direct: 'Direct',
}
const SOURCE_LABELS: Record<string, string> = {
  cloudflare: 'Cloudflare', vercel: 'Vercel', 'cloud-run': 'Cloud Run', wordpress: 'WordPress',
}
const ATTRIBUTION_LABELS: Record<AgentJourneyEvent['attribution'], string> = {
  [AgentJourneyAttributions.matched]: 'Matched',
  [AgentJourneyAttributions.unmatched]: 'No URL match',
  [AgentJourneyAttributions.ambiguous]: 'Ambiguous URL match',
  [AgentJourneyAttributions['unknown-host']]: 'Host not recorded',
  [AgentJourneyAttributions.redacted]: 'URL redacted',
  [AgentJourneyAttributions['not-configured']]: 'No Property plan',
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`
const visitName = (visit: Pick<JourneyVisitDto, 'entryName' | 'entryClass'>) => visit.entryName ?? ENTRY_LABELS[visit.entryClass]
const timeOnly = (iso: string) => formatSweepInstant(iso, iso)

function useJourneysSearch() {
  const search = useSearch({ strict: false }) as JourneysSearch
  const navigate = useNavigate()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const update = (patch: Partial<JourneysSearch>) => {
    void navigate({ to: pathname, search: (previous: Record<string, unknown>) => ({ ...previous, ...patch }), replace: true })
  }
  return { search, update }
}

export function JourneysSection({ projectName }: { projectName: string }) {
  const { account } = useAccount()
  const { search, update } = useJourneysSearch()
  if (isEmbed() || account?.role === UserRoles.viewer) {
    return <p className="py-6 text-sm text-secondary">Journeys are unavailable for view-only accounts and embedded reports.</p>
  }
  const view = search.journeyView === 'agents' ? 'agents' : 'visitors'
  return (
    <section aria-labelledby="journeys-heading" className="space-y-5">
      <h2 id="journeys-heading" className="sr-only">Journeys</h2>
      <nav aria-label="Journey view" className="flex gap-6 border-b border-default">
        {([{ value: 'visitors', label: 'Visitors' }, { value: 'agents', label: 'Agent requests' }] as const).map(item => (
          <button key={item.value} type="button" aria-current={view === item.value ? 'page' : undefined}
            onClick={() => { if (view !== item.value) { trackUiFilterChange('other'); update({ journeyView: item.value === 'visitors' ? undefined : item.value }) } }}
            className={`-mb-px border-b-2 pb-2 text-sm transition-colors ${FOCUS_RING} ${view === item.value ? 'border-mono-100 text-heading' : 'border-transparent text-secondary hover:text-heading'}`}>
            {item.label}
          </button>
        ))}
      </nav>
      {view === 'visitors'
        ? <VisitorJourneys key={`visitors:${projectName}`} projectName={projectName} />
        : <AgentRequests key={`agents:${projectName}`} projectName={projectName} />}
    </section>
  )
}

/**
 * One rectangular segmented control for a small, mutually exclusive period
 * choice. A radio group: one tab stop, arrow keys move and select.
 */
function PeriodControl({ options, value, onChange, label }: { options: ReadonlyArray<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const select = (index: number) => {
    const option = options[(index + options.length) % options.length]!
    buttons.current[(index + options.length) % options.length]?.focus()
    if (option.value !== value) onChange(option.value)
  }
  const current = Math.max(0, options.findIndex(option => option.value === value))
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-base"
      onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); select(current + 1) }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); select(current - 1) }
      }}>
      {options.map((option, index) => (
        <button key={option.value} ref={element => { buttons.current[index] = element }} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1}
          onClick={() => { if (option.value !== value) onChange(option.value) }}
          className={`px-3 py-1.5 text-sm transition-colors ${FOCUS_RING} ${option.value === value ? 'bg-surface-active text-heading' : 'text-secondary hover:text-heading'}`}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Shape carries the entry class; the text label always travels with it. */
export function EntryMarker({ entryClass, className = 'size-3' }: { entryClass: JourneyEntryClass; className?: string }) {
  const shapes: Record<JourneyEntryClass, ReactNode> = {
    ai: <path d="M12 2 22 12 12 22 2 12Z" fill="currentColor" />,
    search: <circle cx="12" cy="12" r="9" fill="currentColor" />,
    social: <rect x="3.5" y="3.5" width="17" height="17" fill="currentColor" />,
    paid: <path d="M12 3 22 20H2Z" fill="currentColor" />,
    referral: <rect x="4" y="4" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" />,
    direct: <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="3" />,
  }
  return <svg className={`${className} shrink-0`} viewBox="0 0 24 24" aria-hidden="true">{shapes[entryClass]}</svg>
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="text-sm text-secondary">
      <summary className={DISCLOSURE_CLASS}>{open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function ReadFailure({ what, error, retry }: { what: string; error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2 text-sm text-secondary">
      <p>Could not load {what}. {extractErrorMessage(error)}</p>
      <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
    </div>
  )
}

function PartialSourceNotes({ projectName, partialSources }: { projectName: string; partialSources: JourneyPartialSources }) {
  if (partialSources.length === 0) return null
  return (
    <ul className="space-y-1">
      {partialSources.map(source => (
        <li key={source.sourceId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <AlertTriangle className="size-3.5 shrink-0 text-caution" aria-hidden="true" />
          <span className="text-heading">{SOURCE_LABELS[source.sourceType] ?? source.sourceType}: later visits are not recorded.</span>
          <span className="text-secondary">{source.reason}</span>
          <Link to="/traffic/$projectName/$sourceId" params={{ projectName, sourceId: source.sourceId }} className={`rounded text-link underline-offset-4 hover:underline ${FOCUS_RING}`}>Review source</Link>
        </li>
      ))}
    </ul>
  )
}

function VisitorJourneys({ projectName }: { projectName: string }) {
  const { search, update } = useJourneysSearch()
  const days = VISITOR_PERIODS.some(period => period.value === search.journeyDays) ? search.journeyDays! : '30'
  const engine = search.journeyEngine ?? ''
  const returned = search.journeyReturned === 'true' || search.journeyReturned === 'false' ? search.journeyReturned : ''
  const offset = Math.max(0, Number.parseInt(search.journeyOffset ?? '0', 10) || 0)
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString())
  const window = { since: new Date(Date.parse(windowEnd) - Number(days) * 86_400_000).toISOString(), until: windowEnd }
  const summaryQuery = useQuery({ ...getApiV1ProjectsByNameJourneysSummaryOptions({ client: heyClient, path: { name: projectName }, query: window }), staleTime: 30_000 })
  const listQuery: JourneysQuery = { ...window, engine: engine || undefined, returned: returned || undefined, limit: VISITOR_PAGE_SIZE, offset }
  const query = useQuery({ ...getApiV1ProjectsByNameJourneysOptions({ client: heyClient, path: { name: projectName }, query: listQuery }), staleTime: 30_000 })
  const data = query.data
  const selectedKey = search.journeyVisitor ?? data?.visitors[0]?.visitorKey ?? null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
        {summaryQuery.isPending ? <p role="status" className="text-sm text-secondary">Loading visitor summary…</p>
          : summaryQuery.isError ? <ReadFailure what="the visitor summary" error={summaryQuery.error} retry={() => { void summaryQuery.refetch() }} />
            : <VisitorSummary summary={summaryQuery.data} />}
        <PeriodControl label="First AI visit within" options={VISITOR_PERIODS} value={days} onChange={value => {
          trackUiFilterChange('window'); setWindowEnd(new Date().toISOString()); update({ journeyDays: value === '30' ? undefined : value, journeyOffset: undefined, journeyVisitor: undefined })
        }} />
      </div>
      {data && <PartialSourceNotes projectName={projectName} partialSources={data.partialSources} />}

      {query.isPending ? <p role="status" className="py-6 text-sm text-secondary">Loading visitors…</p>
        : query.isError ? <ReadFailure what="visitors" error={query.error} retry={() => { void query.refetch() }} />
          : data && data.visitors.length === 0 && !engine && !returned ? (
            <div className="border-y border-default py-8 text-sm text-secondary">
              <p className="font-medium text-heading">No AI-referred visitors in this period.</p>
              <p className="mt-1 max-w-prose">Visitors appear after a connected traffic source records an AI referral. Try a longer period.</p>
              <Link to="/traffic" className="mt-2 inline-block text-link hover:underline">Review traffic sources</Link>
            </div>
          ) : data ? (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              <VisitorList data={data} engines={summaryQuery.data?.byEngine.map(item => item.engine) ?? []} engine={engine} returned={returned} selectedKey={selectedKey} onSelect={key => { trackUiAction('journeys.visitor_open'); update({ journeyVisitor: key }) }}
                onFilter={patch => { trackUiFilterChange('other'); update({ ...patch, journeyOffset: undefined, journeyVisitor: undefined }) }}
                onPage={next => update({ journeyOffset: next === 0 ? undefined : String(next), journeyVisitor: undefined })} />
              {selectedKey
                ? <VisitorDetail key={selectedKey} projectName={projectName} visitorKey={selectedKey} partialSources={data.partialSources} />
                : <p className="rounded-md border border-default p-5 text-sm text-secondary">Select a visitor to see their journey.</p>}
            </div>
          ) : null}

      <Disclosure summary="Capture coverage and matching">
        <div className="max-w-prose space-y-3">
          {summaryQuery.data && <SummaryBreakdown summary={summaryQuery.data} />}
          {data && <CoverageNotes data={data} />}
        </div>
      </Disclosure>
    </div>
  )
}

function VisitorSummary({ summary }: { summary: JourneySummaryResponse }) {
  const channels = (Object.entries(summary.returnedVia) as Array<[JourneyEntryClass, number]>).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
  const returnRate = summary.returnRate === null ? null : formatPercent(summary.returnRate, RatioUnits.fraction)
  return (
    <dl className="flex flex-wrap items-start gap-x-12 gap-y-4">
      <div><dt className="text-sm text-secondary">AI-referred visitors</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-heading">{summary.aiVisitors.toLocaleString()}</dd></div>
      <div>
        <dt className="flex items-center gap-1 text-sm text-secondary">Came back{returnRate && <InfoTooltip placement="bottom" text={`${returnRate} of AI-referred visitors came back in a later visit.`} />}</dt>
        <dd className="mt-1 text-xl font-semibold tabular-nums text-heading">
          {summary.returningVisitors.toLocaleString()} <span className="text-sm font-normal text-secondary">of {summary.aiVisitors.toLocaleString()}</span>
          {returnRate && <span className="sr-only">, a {returnRate} return rate</span>}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-secondary">Median time to return</dt>
        <dd className="mt-1 text-xl font-semibold tabular-nums text-heading">{summary.medianDaysToReturn === null ? <span className="text-base font-normal text-secondary">Not available</span> : <>{summary.medianDaysToReturn} <span className="text-sm font-normal text-secondary">days</span></>}</dd>
      </div>
      <div>
        <dt className="text-sm text-secondary">Return visits by channel</dt>
        <dd className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-heading">
          {channels.length === 0 ? <span className="text-secondary">None yet</span> : channels.map(([channel, count]) => (
            <span key={channel} className="inline-flex items-center gap-1.5"><EntryMarker entryClass={channel} className="size-2.5" />{ENTRY_LABELS[channel]} <span className="tabular-nums text-secondary">{count.toLocaleString()}</span></span>
          ))}
        </dd>
      </div>
    </dl>
  )
}

function ThenChain({ visitor }: { visitor: JourneysResponse['visitors'][number] }) {
  const aiIndex = visitor.visits.findIndex(visit => visit.entryClass === 'ai')
  const later = visitor.visits.slice(aiIndex + 1)
  if (later.length === 0) return <span className="text-secondary">{visitor.returned ? 'Came back' : 'No return yet'}</span>
  const shown = later.slice(0, MAX_CHAIN_STEPS)
  const more = later.length > MAX_CHAIN_STEPS || visitor.visitCount > visitor.visits.length
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {shown.map((visit, index) => (
        <Fragment key={visit.id}>
          {index > 0 && <><ArrowRight className="size-3 text-secondary" aria-hidden="true" /><span className="sr-only">then</span></>}
          <span className="text-heading">{visitName(visit)}{visit.paid ? ' (paid)' : ''}</span>
        </Fragment>
      ))}
      {more && <span className="text-secondary">…<span className="sr-only">and more visits</span></span>}
    </span>
  )
}

function VisitorList({ data, engines, engine, returned, selectedKey, onSelect, onFilter, onPage }: {
  data: JourneysResponse
  engines: string[]
  engine: string
  returned: string
  selectedKey: string | null
  onSelect: (key: string) => void
  onFilter: (patch: Partial<JourneysSearch>) => void
  onPage: (offset: number) => void
}) {
  const filtered = Boolean(engine || returned)
  const first = data.totalVisitors === 0 ? 0 : data.offset + 1
  const last = data.offset + data.visitors.length
  return (
    <section aria-label="AI-referred visitors" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
        <p role="status" className="text-secondary">{first.toLocaleString()} to {last.toLocaleString()} of {plural(data.totalVisitors, 'visitor')}</p>
        <details className="text-sm" open={filtered || undefined}>
          <summary className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-base px-2.5 py-1 text-secondary hover:text-heading ${FOCUS_RING} [&::-webkit-details-marker]:hidden`}>
            <Filter className="size-3" aria-hidden="true" />Filter{filtered && <span className="text-heading">{[engine, returned === 'true' ? 'Came back' : returned === 'false' ? 'No return yet' : ''].filter(Boolean).join(' · ')}</span>}
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm text-secondary">
              First AI engine
              <select className={SELECT_CLASS} value={engine} onChange={event => onFilter({ journeyEngine: event.target.value || undefined })}>
                <option value="">All engines</option>
                {engine && !engines.includes(engine) && <option value={engine}>{engine}</option>}
                {engines.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm text-secondary">
              Came back
              <select className={SELECT_CLASS} value={returned} onChange={event => onFilter({ journeyReturned: event.target.value || undefined })}>
                <option value="">All visitors</option><option value="true">Came back</option><option value="false">No return yet</option>
              </select>
            </label>
            {filtered && <Button size="sm" variant="outline" onClick={() => onFilter({ journeyEngine: undefined, journeyReturned: undefined })}>Clear filters</Button>}
          </div>
        </details>
      </div>
      {data.visitors.length === 0 ? <p className="rounded-md border border-default p-5 text-sm text-secondary">No visitors match these filters.</p> : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="w-full text-sm" aria-label="AI-referred visitors">
            <thead className="bg-surface-subtle text-left text-[13px] text-secondary">
              <tr><th scope="col" className="py-2 pl-3 pr-2 font-medium">First AI visit</th><th scope="col" className="px-2 py-2 font-medium">Then</th><th scope="col" className="px-2 py-2 text-right font-medium">Visits</th><th scope="col" className="py-2 pl-2 pr-3 text-right font-medium">Last seen</th></tr>
            </thead>
            <tbody className="divide-y divide-default">
              {data.visitors.map(visitor => {
                const selected = visitor.visitorKey === selectedKey
                const aiVisit = visitor.visits.find(visit => visit.entryClass === 'ai') ?? visitor.visits[0]
                return (
                  <tr key={visitor.visitorKey} className={selected ? 'bg-surface-active' : 'hover:bg-surface-hover'}>
                    <td className="py-2.5 pl-3 pr-2 align-top">
                      <button type="button" aria-current={selected ? 'true' : undefined} aria-label={`${visitor.firstAiEngine} visitor, first AI visit ${formatSweepInstant(visitor.firstAiAt)}`} onClick={() => onSelect(visitor.visitorKey)} className={`flex items-start gap-1.5 rounded text-left ${FOCUS_RING}`}>
                        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                        <span><span className="block text-label-14-strong text-heading">{visitor.firstAiEngine}</span>{aiVisit && <span className="mt-0.5 block break-all font-mono text-[13px] text-heading">{aiVisit.landingPath}</span>}</span>
                      </button>
                    </td>
                    <td className="px-2 py-2.5 align-top"><ThenChain visitor={visitor} /></td>
                    <td className="px-2 py-2.5 text-right align-top tabular-nums text-heading">{visitor.visitCount.toLocaleString()}</td>
                    <td className="py-2.5 pl-2 pr-3 text-right align-top text-secondary"><time dateTime={visitor.lastSeenAt}>{formatSweepDay(visitor.lastSeenAt)}</time></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {(data.totalVisitors > data.limit || data.offset > 0) && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => onPage(Math.max(0, data.offset - data.limit))}>Previous</Button>
          <Button variant="outline" size="sm" disabled={data.offset + data.limit >= data.totalVisitors} onClick={() => onPage(data.offset + data.limit)}>Next visitors</Button>
        </div>
      )}
    </section>
  )
}

function VisitorDetail({ projectName, visitorKey, partialSources }: { projectName: string; visitorKey: string; partialSources: JourneyPartialSources }) {
  const [offset, setOffset] = useState(0)
  const [events, setEvents] = useState<JourneyEventFilter>(JourneyEventFilters.pages)
  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null)
  const query = useQuery({
    ...getApiV1ProjectsByNameJourneysByVisitorKeyOptions({ client: heyClient, path: { name: projectName, visitorKey }, query: { limit: VISIT_PAGE_SIZE, offset, events } }),
    staleTime: 30_000,
    placeholderData: previous => previous,
  })
  if (query.isPending) return <p role="status" className="rounded-md border border-default p-5 text-sm text-secondary">Loading journey…</p>
  if (query.isError) return <div className="rounded-md border border-default p-5"><ReadFailure what="this journey" error={query.error} retry={() => { void query.refetch() }} /></div>
  const detail = query.data
  const { visitor } = detail
  const selectedIndex = Math.max(0, detail.visits.findIndex(visit => visit.id === selectedVisitId))
  const selectedVisit = detail.visits[selectedIndex]
  const loadedAll = detail.offset + detail.visits.length >= detail.totalVisits
  const lastVisit = detail.visits.at(-1)
  const partialSource = loadedAll && lastVisit ? partialSources.find(source => source.sourceId === lastVisit.sourceId) : undefined
  return (
    <section aria-label="Selected visitor" className="min-w-0 rounded-md border border-default p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-label-16 font-semibold text-heading">First AI visit: {visitor.firstAiEngine}, {formatSweepDay(visitor.firstAiAt)}</h3>
        <span className="text-sm text-secondary">{visitor.device}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-secondary">
        <span>{plural(detail.totalVisits, 'visit')}, {formatSweepDay(visitor.firstAiAt)} to {formatSweepDay(visitor.lastSeenAt)}, times in {localTimeZoneLabel()}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          {visitor.keyBasis === JourneyKeyBases.ua ? 'Matched by browser only' : 'Matched by network and browser'}
          <InfoTooltip placement="bottom" text={visitor.keyBasis === JourneyKeyBases.ua
            ? 'Everyone using the same browser version shares this match, so this journey may combine several people.'
            : 'People on a shared network with the same browser can be combined, and an address change can split one person.'} />
        </span>
      </p>
      {visitor.cappedDays > 0 && <p className="mt-2 flex items-center gap-2 text-sm"><AlertTriangle className="size-3.5 text-caution" aria-hidden="true" /><span className="text-heading">Some requests are missing</span><span className="text-secondary">The daily limit of {JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY.toLocaleString()} requests was reached on {plural(visitor.cappedDays, 'day')}.</span></p>}

      <div className="mt-5">
        <JourneyFlow visits={detail.visits} offset={detail.offset} total={detail.totalVisits} selectedId={selectedVisit?.id ?? null} onSelect={id => { trackUiAction('journeys.visit_open'); setSelectedVisitId(id) }}
          partialSourceLabel={partialSource ? SOURCE_LABELS[partialSource.sourceType] ?? partialSource.sourceType : null} />
        {(detail.totalVisits > detail.limit || detail.offset > 0) && (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={detail.offset === 0 || query.isFetching} onClick={() => { setOffset(Math.max(0, detail.offset - detail.limit)); setSelectedVisitId(null) }}>Earlier visits</Button>
            <Button variant="outline" size="sm" disabled={loadedAll || query.isFetching} onClick={() => { setOffset(detail.offset + detail.limit); setSelectedVisitId(null) }}>Later visits</Button>
          </div>
        )}
      </div>

      {selectedVisit && (
        <div className="mt-6 border-t border-default pt-4">
          <VisitRequests visit={selectedVisit} position={detail.offset + selectedIndex + 1} total={detail.totalVisits} events={detail.events} loading={query.isFetching}
            onToggleEvents={() => setEvents(events === JourneyEventFilters.pages ? JourneyEventFilters.all : JourneyEventFilters.pages)} />
        </div>
      )}

      <div className="mt-5">
        <Disclosure summary="How this visitor was matched">
          <dl className="max-w-prose space-y-2">
            <div><dt className="font-medium text-heading">Visitor key</dt><dd className="break-all font-mono">{visitor.visitorKey}</dd></div>
            <div><dt className="font-medium text-heading">Last recorded request</dt><dd><time dateTime={visitor.lastSeenAt}>{formatTimestamp(visitor.lastSeenAt)}</time></dd></div>
            <div><dt className="font-medium text-heading">User agent</dt><dd className="break-all font-mono">{visitor.userAgent ?? 'Not recorded'}</dd></div>
          </dl>
        </Disclosure>
      </div>
    </section>
  )
}

/**
 * Visits in time order, left to right, as an ordered list of buttons. Spacing
 * is ordinal, not proportional to time: gaps range from minutes to weeks. A
 * `//` marks a new calendar day. Requests that are not GET or HEAD are printed
 * as recorded under their visit; the page never names what a request did.
 */
export function JourneyFlow({ visits, offset, total, selectedId, onSelect, partialSourceLabel }: {
  visits: JourneyDetailResponse['visits']
  offset: number
  total: number
  selectedId: string | null
  onSelect: (id: string) => void
  partialSourceLabel: string | null
}) {
  return (
    <div>
      <ol aria-label="Visits in time order" className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-0">
        {visits.map((visit, index) => {
          const selected = visit.id === selectedId
          const previous = visits[index - 1]
          const newDay = previous !== undefined && new Date(previous.startedAt).toDateString() !== new Date(visit.startedAt).toDateString()
          const writes = visit.events.filter(event => isJourneyWriteMethod(event.method))
          const name = visitName(visit)
          return (
            <Fragment key={visit.id}>
              {index > 0 && (
                <li aria-hidden="true" className="hidden w-10 shrink-0 items-center self-start pt-[19px] md:flex">
                  <span className="h-px flex-1 bg-border-strong" />
                  {newDay && <span className="px-1 text-[13px] text-secondary">//</span>}
                  <span className="h-px flex-1 bg-border-strong" />
                </li>
              )}
              <li className="min-w-0 md:flex-1">
                <button type="button" aria-current={selected ? 'step' : undefined} onClick={() => onSelect(visit.id)}
                  aria-label={`Visit ${offset + index + 1} of ${total}: ${name}, ${ENTRY_LABELS[visit.entryClass]}${visit.paid ? ', paid' : ''}, ${formatSweepInstant(visit.startedAt)}, ${plural(visit.pageCount, 'page')}`}
                  className={`flex h-full w-full flex-col items-stretch justify-start rounded-md border px-3 py-2.5 text-left transition-colors ${FOCUS_RING} ${selected ? 'border-mono-200 bg-surface-active' : 'border-default hover:bg-surface-hover'}`}>
                  <span className="flex items-center gap-2 text-heading"><EntryMarker entryClass={visit.entryClass} /><span className={visit.entryClass === 'ai' ? 'text-label-14-strong' : 'text-sm font-medium'}>{name}</span></span>
                  {ENTRY_LABELS[visit.entryClass] !== name && <span className="mt-0.5 block text-[13px] text-secondary">{ENTRY_LABELS[visit.entryClass]}{visit.paid ? ', paid' : ''}</span>}
                  <span className="mt-0.5 block whitespace-nowrap text-[13px] text-secondary">{formatSweepInstant(visit.startedAt)}</span>
                  <span className="mt-1 block font-mono text-[13px] text-heading [overflow-wrap:anywhere]">{visit.landingPath}</span>
                  <span className="mt-1 block text-[13px] text-secondary">{plural(visit.pageCount, 'page')} · {plural(visit.requestCount, 'request')}</span>
                  {writes.length > 0 && (
                    <span className="mt-2 block space-y-1 border-t border-default pt-2">
                      {writes.map((event, writeIndex) => <span key={`${event.ts}:${writeIndex}`} className="block font-mono text-[13px] text-heading"><span className="block">{event.method}</span><span className="block [overflow-wrap:anywhere]">{event.path}</span></span>)}
                    </span>
                  )}
                </button>
              </li>
            </Fragment>
          )
        })}
      </ol>
      {partialSourceLabel && (
        <p className="mt-2 flex items-center justify-end gap-2 text-[13px] text-secondary">
          <span aria-hidden="true" className="h-px w-6 border-t border-dashed border-strong" />
          Later visits not recorded by {partialSourceLabel}
        </p>
      )}
      <ul aria-label="Legend" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-secondary">
        {(['ai', 'search', 'social', 'paid', 'referral', 'direct'] as const).map(entryClass => (
          <li key={entryClass} className="inline-flex items-center gap-1.5"><EntryMarker entryClass={entryClass} className="size-2.5" />{ENTRY_LABELS[entryClass]}</li>
        ))}
        <li className="inline-flex items-center gap-1.5"><span aria-hidden="true">//</span>New day</li>
      </ul>
    </div>
  )
}

function VisitRequests({ visit, position, total, events, loading, onToggleEvents }: {
  visit: JourneyDetailResponse['visits'][number]
  position: number
  total: number
  events: JourneyEventFilter
  loading: boolean
  onToggleEvents: () => void
}) {
  const name = visitName(visit)
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium text-heading">Visit {position} of {total} · {name}{ENTRY_LABELS[visit.entryClass] !== name ? ` ${ENTRY_LABELS[visit.entryClass].toLowerCase()}` : ''} · {formatSweepInstant(visit.startedAt)}</h4>
        <button type="button" disabled={loading} onClick={onToggleEvents} className={`rounded text-sm text-link hover:underline disabled:opacity-50 ${FOCUS_RING}`}>
          {events === JourneyEventFilters.pages ? `Show all ${plural(visit.requestCount, 'request')}` : 'Show pages and non-GET requests'}
        </button>
      </div>
      <p className="mt-1 text-[13px] text-secondary">{events === JourneyEventFilters.pages ? 'Pages and non-GET requests' : 'Every recorded request'} · {plural(visit.pageCount, 'page')} · {plural(visit.requestCount, 'request')}</p>
      {visit.events.length === 0 ? <p className="mt-2 text-sm text-secondary">No requests to show for this visit.</p> : (
        <table className="mt-2 w-full" aria-label={`${name} visit requests`}>
          <thead className="sr-only"><tr><th scope="col">Time</th><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Status</th></tr></thead>
          <tbody className="divide-y divide-default">
            {visit.events.map((event, index) => (
              <tr key={`${event.ts}:${index}`}>
                <td className="whitespace-nowrap py-1.5 pr-3 align-top text-[13px] tabular-nums text-secondary"><time dateTime={event.ts}>{timeOnly(event.ts)}</time></td>
                <td className={`py-1.5 pr-3 align-top font-mono text-[13px] ${isJourneyWriteMethod(event.method) ? 'text-heading' : 'text-secondary'}`}>{event.method ?? '-'}</td>
                <td className="break-all py-1.5 pr-3 align-top font-mono text-[13px] text-heading">{event.path}</td>
                <td className={`py-1.5 text-right align-top font-mono text-[13px] tabular-nums ${event.status !== null && event.status >= 400 ? 'text-caution' : 'text-secondary'}`}>{event.status ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SummaryBreakdown({ summary }: { summary: JourneySummaryResponse }) {
  return (
    <div className="space-y-3">
      <p>{plural(summary.aiVisits, 'AI-referred visit')} started in this period, including visits from earlier visitors.</p>
      {summary.byEngine.length > 0 && (
        <table className="w-full max-w-md text-sm" aria-label="Visitors by first AI engine">
          <thead className="text-left text-[13px]"><tr><th scope="col" className="py-1.5 font-medium">First AI engine</th><th scope="col" className="py-1.5 text-right font-medium">Visitors</th><th scope="col" className="py-1.5 text-right font-medium">Came back</th></tr></thead>
          <tbody className="divide-y divide-default">{summary.byEngine.map(item => <tr key={item.engine}><td className="py-1.5 text-heading">{item.engine}</td><td className="py-1.5 text-right tabular-nums text-heading">{item.visitors.toLocaleString()}</td><td className="py-1.5 text-right tabular-nums text-heading">{item.returningVisitors.toLocaleString()}</td></tr>)}</tbody>
        </table>
      )}
      <p>Matching: {plural(summary.keyBasis.ipUa, 'visitor')} by network and browser, {plural(summary.keyBasis.ua, 'visitor')} by browser only.</p>
    </div>
  )
}

function CoverageNotes({ data }: { data: JourneysResponse }) {
  return (
    <div className="space-y-3">
      <p>The period selects visitors by their first recorded AI visit, from {formatSweepInstant(data.windowStart)} to {formatSweepInstant(data.windowEnd)}. Their later visits are shown even after the period.</p>
      <p>Requests are eligible for {data.lookbackDays} days after an AI visit and kept for {data.retentionDays} days. A new visit starts after {JOURNEY_VISIT_IDLE_MINUTES} minutes without requests. Up to {JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY.toLocaleString()} requests per visitor per UTC day are stored; AI visits are always kept.</p>
      <p>Visitors are inferred from server requests, not identified people. Recorded requests show what was asked for; they do not prove a booking, sale or sign-up. Visitor journeys have no Property, market, tracked query, query class or model.</p>
      {data.partialSources.map(source => <p key={source.sourceId}><span className="font-medium text-heading">{SOURCE_LABELS[source.sourceType] ?? source.sourceType}:</span> {source.reason}</p>)}
    </div>
  )
}

/** Stored agent requests only. The API owns grouping, attribution, counts and coverage. */
function AgentRequests({ projectName }: { projectName: string }) {
  const { search, update } = useJourneysSearch()
  const hours = AGENT_PERIODS.some(period => period.value === search.agentHours) ? search.agentHours! : '24'
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString())
  const [sourceId, setSourceId] = useState('')
  const [agent, setAgent] = useState<{ id: string; label: string } | null>(null)
  const [trust, setTrust] = useState<StoredAgentTrust | ''>('')
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
    trust: trust || undefined,
    targetKey: targetKey || undefined,
  }
  const query = useQuery({
    ...getApiV1ProjectsByNameTrafficAgentJourneysOptions({ client: heyClient, path: { name: projectName }, query: { ...selection, limit: AGENT_PAGE_SIZE, offset } }),
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
  const filtered = Boolean(sourceId || trust || targetKey || agent)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-secondary">
          {data ? <p role="status"><span className="tabular-nums text-heading">{data.totalJourneys.toLocaleString()}</span> request sequences · <span className="tabular-nums text-heading">{data.observedRequests.toLocaleString()}</span> recorded requests</p> : <p>Requests made by AI assistants on a person's behalf</p>}
          <InfoTooltip placement="bottom" text="Requests from agents acting for a person. Verified means the request came from an IP the company publishes. Likely real and Unknown are estimates from the user agent, the requested path and that IP check. An inferred sequence groups the same network address and agent within an inactivity window; shared infrastructure can combine different tasks. Requests do not prove clicks or completed tasks." />
          {data && data.coverage.likelyFakeRequests > 0 && <InfoTooltip placement="bottom" label={`${data.coverage.likelyFakeRequests.toLocaleString()} likely fake`} text={`${plural(data.coverage.likelyFakeRequests, 'likely fake request')}. ${LIKELY_FAKE_HELP}`} />}
          {data && !data.coverage.recordingEnabled && <InfoTooltip placement="bottom" tone="caution" label="Recording off" text="Recording off. Agent request recording is not enabled on this instance. Saved sequences remain available." />}
          {data && data.coverage.cappedSourceDays.length > 0 && <InfoTooltip placement="bottom" tone="caution" label="Some requests missing" text="Some requests missing. A source reached its daily recording limit. See capture coverage for the affected days and sources." />}
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <details className="text-sm" open={filtered || undefined}>
            <summary className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-base px-2.5 py-1.5 text-secondary hover:text-heading ${FOCUS_RING} [&::-webkit-details-marker]:hidden`}><Filter className="size-3" aria-hidden="true" />Filter</summary>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm text-secondary">
                Source
                <select className={SELECT_CLASS} value={sourceId} onChange={event => { trackUiFilterChange('other'); setSourceId(event.target.value); resetPage() }}>
                  <option value="">All sources</option>
                  {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-sm text-secondary">
                Trust
                <select className={SELECT_CLASS} value={trust} onChange={event => { trackUiFilterChange('other'); setTrust(event.target.value as StoredAgentTrust | ''); resetPage() }}>
                  <option value="">All trust levels</option>
                  {Object.values(AgentTrustLevels).filter((level): level is StoredAgentTrust => level !== AgentTrustLevels.likely_fake).map(level => <option key={level} value={level}>{TRUST_LABELS[level]}</option>)}
                </select>
              </label>
              {properties.length > 0 && (
                <details ref={propertyPicker} className="relative">
                  <summary className={`${SELECT_CLASS} inline-flex cursor-pointer list-none items-center py-1.5 [&::-webkit-details-marker]:hidden`}>Property: {selectedProperty?.label ?? 'All properties'}</summary>
                  <div className="mt-2 w-72 max-w-full">
                    <input aria-label="Find a property" type="search" value={propertySearch} onChange={event => setPropertySearch(event.target.value)} placeholder="Find a property" className={`${SELECT_CLASS} mb-2 w-full`} />
                    <div className="max-h-64 overflow-y-auto" role="group" aria-label="Properties">
                      {[{ key: '', label: 'All properties' }, ...properties.filter(property => property.label.toLowerCase().includes(propertySearch.toLowerCase()))].map(property => (
                        <button key={property.key} type="button" aria-pressed={targetKey === property.key} className={`block w-full rounded px-2 py-2 text-left text-secondary hover:bg-surface-hover hover:text-heading aria-pressed:bg-surface-active aria-pressed:text-heading ${FOCUS_RING}`} onClick={() => {
                          trackUiFilterChange('other'); setTargetKey(property.key); resetPage()
                          if (propertyPicker.current) { propertyPicker.current.open = false; propertyPicker.current.querySelector('summary')?.focus() }
                        }}>{property.label}</button>
                      ))}
                    </div>
                  </div>
                </details>
              )}
              {filtered && <Button size="sm" variant="outline" onClick={() => { trackUiFilterChange('other'); setSourceId(''); setTrust(''); setTargetKey(''); setAgent(null); resetPage() }}>Clear filters</Button>}
            </div>
          </details>
          <PeriodControl label="Period" options={AGENT_PERIODS} value={hours} onChange={value => { trackUiFilterChange('window'); setWindowEnd(new Date().toISOString()); resetPage(); update({ agentHours: value === '24' ? undefined : value }) }} />
        </div>
      </div>
      {filtered && <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary">
        {sourceId && <span>Source: <span className="text-heading">{selectedSource?.label ?? sourceId}</span></span>}
        {trust && <span>Trust: <span className="text-heading">{TRUST_LABELS[trust]}</span></span>}
        {targetKey && <span>Property: <span className="text-heading">{selectedProperty?.label ?? targetKey}</span></span>}
        {agent && <span>Agent: <span className="text-heading">{agent.label}</span></span>}
      </p>}

      {query.isPending ? <p role="status" className="py-6 text-sm text-secondary">Loading request sequences…</p>
        : query.isError ? <ReadFailure what="request sequences" error={query.error} retry={() => { void query.refetch() }} />
          : data ? (
            <>
              {data.journeys.length === 0 ? (
                <div className="border-y border-default py-8 text-sm text-secondary">
                  <p className="font-medium text-heading">No agent requests in this selection.</p>
                  <p className="mt-1 max-w-prose">Try a longer period or clear filters. Sequences appear after a connected source records requests from a recognized AI assistant.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-default">
                  <table className="w-full min-w-[44rem] text-sm" aria-label="Agent request sequences">
                    <thead className="bg-surface-subtle text-left text-[13px] text-secondary">
                      <tr><th scope="col" className="px-3 py-2 font-medium">Agent</th><th scope="col" className="px-3 py-2 font-medium">Trust</th><th scope="col" className="px-3 py-2 font-medium">First request</th><th scope="col" className="px-3 py-2 font-medium">Started</th><th scope="col" className="px-3 py-2 text-right font-medium">Requests</th></tr>
                    </thead>
                    <tbody className="divide-y divide-default">
                      {data.journeys.map(journey => {
                        const expanded = selectedId === journey.id
                        return (
                          <Fragment key={journey.id}>
                            <tr className={expanded ? 'bg-surface-active' : 'hover:bg-surface-hover'}>
                              <td className="px-3 py-2.5 align-top">
                                <button type="button" aria-expanded={expanded} aria-controls={`agent-sequence-${journey.id}`} aria-label={`${journey.product} sequence starting ${formatSweepInstant(journey.startedAt)}`}
                                  onClick={() => { if (!expanded) trackUiAction('journeys.agent_open'); setSelectedId(expanded ? null : journey.id) }}
                                  className={`inline-flex items-center gap-1.5 rounded text-left text-label-14-strong text-heading ${FOCUS_RING}`}>
                                  {expanded ? <ChevronDown className="size-3.5 shrink-0 text-secondary" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />}
                                  {journey.product}
                                </button>
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                {journey.trustLevels.map(level => <span key={level} className={`block ${level === AgentTrustLevels.unknown ? 'text-secondary' : 'text-heading'}`}>{TRUST_LABELS[level]}</span>)}
                                <span className="block text-[13px] text-secondary">{journey.correlationBasis === AgentJourneyCorrelationBases['ip-ua'] ? 'Inferred sequence' : 'Unlinked request'}</span>
                              </td>
                              <td className="px-3 py-2.5 align-top"><span className="block text-[13px] text-secondary">{journey.firstHost ?? 'Host not recorded'}</span><span className="break-all font-mono text-[13px] text-heading">{journey.firstPath}</span></td>
                              <td className="whitespace-nowrap px-3 py-2.5 align-top text-secondary"><time dateTime={journey.startedAt}>{formatSweepInstant(journey.startedAt)}</time></td>
                              <td className="px-3 py-2.5 text-right align-top tabular-nums text-heading">{journey.requestCount.toLocaleString()}{journey.errorCount > 0 && <span className="block text-[13px] text-caution">{plural(journey.errorCount, 'error')}</span>}</td>
                            </tr>
                            {expanded && <tr><td colSpan={5} className="bg-surface-subtle px-4 py-4 sm:px-10"><AgentSequence projectName={projectName} journey={journey} selection={{ ...selection, since: data.windowStart, until: data.windowEnd }} onSelectAgent={() => { trackUiFilterChange('other'); setAgent({ id: journey.agentId, label: journey.product }); resetPage() }} /></td></tr>}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {(data.totalJourneys > data.limit || data.offset > 0) && <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" disabled={data.offset === 0 || query.isFetching} onClick={() => { setOffset(Math.max(0, data.offset - data.limit)); setSelectedId(null) }}>Previous</Button>
                <Button variant="outline" size="sm" disabled={data.offset + data.limit >= data.totalJourneys || query.isFetching} onClick={() => { setOffset(data.offset + data.limit); setSelectedId(null) }}>Next sequences</Button>
              </div>}
              <Disclosure summary="Capture coverage"><AgentCoverage context={data} /></Disclosure>
            </>
          ) : null}
    </div>
  )
}

function AgentSequence({ projectName, journey, selection, onSelectAgent }: { projectName: string; journey: AgentJourney; selection: AgentJourneysQuery; onSelectAgent: () => void }) {
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    ...getApiV1ProjectsByNameTrafficAgentJourneysByJourneyIdOptions({ client: heyClient, path: { name: projectName, journeyId: journey.id }, query: { ...selection, limit: REQUEST_PAGE_SIZE, offset } }),
    staleTime: 30_000,
  })
  return (
    <div id={`agent-sequence-${journey.id}`} role="region" aria-label={`${journey.product} requests`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-secondary">
          {query.data ? <span>{query.data.coverage.sources.find(source => source.sourceId === query.data.journey.sourceId)?.label ?? query.data.journey.sourceId} · {plural(query.data.totalEvents, 'recorded request')} · times in {localTimeZoneLabel()}</span> : <span>Requests in order</span>}
          <InfoTooltip placement="bottom" text={journey.correlationBasis === AgentJourneyCorrelationBases['ip-ua']
            ? 'Inferred sequence. Requests are linked by network address and agent identity and may combine different tasks. Operator verification does not verify a user session; responses do not prove a completed task.'
            : 'Unlinked request. This request has nothing to link it to another request. Operator verification does not verify a user session; responses do not prove a completed task.'} />
        </p>
        <Button size="sm" variant="outline" onClick={onSelectAgent}>Only {journey.product}</Button>
      </div>
      {query.data && query.data.events.length > 0 && <TrustReasons operator={journey.operator} events={query.data.events} />}
      {query.isPending ? <p role="status" className="text-sm text-secondary">Loading requests…</p>
        : query.isError ? <ReadFailure what="these requests" error={query.error} retry={() => { void query.refetch() }} />
          : (
            <>
              {query.data.events.length === 0 ? <p className="text-sm text-secondary">No recorded requests on this page.</p> : (
                <table className="w-full max-w-4xl" aria-label={`${journey.product} recorded requests`}>
                  <thead className="text-left text-[13px] text-secondary"><tr><th scope="col" className="py-1.5 pr-3 font-medium">Time</th><th scope="col" className="py-1.5 pr-3 font-medium">Method</th><th scope="col" className="py-1.5 pr-3 font-medium">Request</th>{query.data.scope.mode === 'advanced' && <th scope="col" className="py-1.5 pr-3 font-medium">Property</th>}<th scope="col" className="py-1.5 pr-3 text-right font-medium">Latency</th><th scope="col" className="py-1.5 text-right font-medium">Status</th></tr></thead>
                  <tbody className="divide-y divide-default">
                    {query.data.events.map(event => (
                      <tr key={event.id}>
                        <td className="whitespace-nowrap py-1.5 pr-3 align-top text-[13px] tabular-nums text-secondary"><time dateTime={event.ts}>{new Date(event.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></td>
                        <td className={`py-1.5 pr-3 align-top font-mono text-[13px] ${isJourneyWriteMethod(event.method) ? 'text-heading' : 'text-secondary'}`}>{event.method ?? '-'}</td>
                        <td className="break-all py-1.5 pr-3 align-top font-mono text-[13px] text-heading"><span className="text-secondary">{event.host ?? ''}</span>{event.path}</td>
                        {query.data.scope.mode === 'advanced' && <td className="py-1.5 pr-3 align-top text-[13px] text-heading">{event.targetKey ? query.data.properties.find(property => property.key === event.targetKey)?.label ?? event.targetKey : ATTRIBUTION_LABELS[event.attribution]}</td>}
                        <td className="whitespace-nowrap py-1.5 pr-3 text-right align-top text-[13px] tabular-nums text-secondary">{event.latencyMs === null ? '-' : `${event.latencyMs} ms`}</td>
                        <td className={`py-1.5 text-right align-top font-mono text-[13px] tabular-nums ${event.status !== null && event.status >= 400 ? 'text-caution' : 'text-secondary'}`}>{event.status ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(query.data.totalEvents > query.data.limit || query.data.offset > 0) && <div className="flex justify-end gap-2"><Button variant="outline" size="sm" disabled={query.data.offset === 0 || query.isFetching} onClick={() => setOffset(Math.max(0, query.data!.offset - query.data!.limit))}>Earlier requests</Button><Button variant="outline" size="sm" disabled={query.data.offset + query.data.limit >= query.data.totalEvents || query.isFetching} onClick={() => setOffset(query.data!.offset + query.data!.limit)}>Later requests</Button></div>}
            </>
          )}
    </div>
  )
}

/** The trust level and its reasons for the requests on this page, as the API stored them. */
function TrustReasons({ operator, events }: { operator: string; events: AgentJourneyEvent[] }) {
  const groups = new Map<StoredAgentTrust, Set<AgentTrustReason>>()
  for (const event of events) {
    const reasons = groups.get(event.trust) ?? new Set<AgentTrustReason>()
    for (const reason of event.trustReasons) reasons.add(reason)
    groups.set(event.trust, reasons)
  }
  return (
    <ul className="space-y-1 text-sm">
      {[...groups].map(([level, reasons]) => (
        <li key={level}><span className="text-heading">{TRUST_LABELS[level]}</span><span className="text-secondary">: {[...reasons].map(reason => trustReasonLabel(reason, operator)).join(' · ')}</span></li>
      ))}
    </ul>
  )
}

function AgentCoverage({ context }: { context: AgentJourneyContext }) {
  return (
    <div className="max-w-prose space-y-3">
      <p>{formatSweepInstant(context.windowStart)} to {formatSweepInstant(context.windowEnd)}. Sequences are limited to this period.</p>
      <p>Requests are kept for {context.coverage.retentionDays} days, up to {context.coverage.dailyEventLimit.toLocaleString()} per source per day. Inferred sequences split after {context.coverage.idleMinutes} minutes without requests.</p>
      {context.scope.planRevision !== null && <p>Property attribution uses URL matches in plan revision {context.scope.planRevision}.</p>}
      <p>These requests do not establish the person's task, market, tracked query, query class or model.</p>
      <ul className="list-disc space-y-1 pl-5">{context.coverage.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
      {context.coverage.cappedSourceDays.map(cap => <p key={`${cap.sourceId}:${cap.day}`}>Daily limit reached: {context.coverage.sources.find(source => source.sourceId === cap.sourceId)?.label ?? cap.sourceId}, {cap.day} (UTC).</p>)}
      {context.coverage.sources.map(source => <div key={source.sourceId}><p className="font-medium text-heading">{source.label}</p><ul className="list-disc space-y-1 pl-5">{source.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul></div>)}
    </div>
  )
}

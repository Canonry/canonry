import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import { AlertTriangle, ChevronDown, ChevronRight, Filter } from 'lucide-react'
import {
  AgentJourneyAttributions, AgentTrustLevels, JourneyEventFilters, JourneyKeyBases,
  JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY, JOURNEY_VISIT_IDLE_MINUTES, RatioUnits, UserRoles, formatDayDuration, formatPercent, pathWithoutQuery,
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
import { formatSweepDay, formatSweepInstant, formatTimestamp } from '../../lib/format-helpers.js'
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
  /** `ua`: list the visitors matched by browser only, each of which can be many people. */
  journeyMatching?: string
  journeyOffset?: string
  agentHours?: string
}

const VISITOR_PERIODS = [{ value: '7', label: '7d' }, { value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: '180', label: '180d' }] as const
const AGENT_PERIODS = [{ value: '1', label: '1h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }, { value: '720', label: '30d' }] as const
const VISITOR_PAGE_SIZE = 20
const VISIT_PAGE_SIZE = 12
const AGENT_PAGE_SIZE = 20
const REQUEST_PAGE_SIZE = 50
const MAX_RETURN_STEPS = 3
const SELECT_CLASS = 'h-8 rounded-md border border-base bg-bg px-2 text-label-14 text-heading outline-none transition hover:border-strong focus-visible:ring-2 focus-visible:ring-mono-500 disabled:opacity-50'
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500'
const DISCLOSURE_CLASS = `inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded text-label-14 text-secondary hover:text-heading ${FOCUS_RING} [&::-webkit-details-marker]:hidden`
const ROW_TOGGLE = `inline-flex items-center gap-1.5 rounded text-left ${FOCUS_RING}`

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
const TRUST_TONES: Record<StoredAgentTrust, string> = {
  [AgentTrustLevels.verified]: 'text-positive',
  [AgentTrustLevels.likely_real]: 'text-heading',
  [AgentTrustLevels.unknown]: 'text-secondary',
}

const NOT_MEASURABLE_HELP = 'This project\'s traffic source logs no IP address, so one person can\'t be told from another. AI-referred visits are still counted.'
const BROWSER_GROUP_NOTE = 'Each row is everyone on one browser version, so its visits are not one person\'s.'
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`
const visitName = (visit: Pick<JourneyVisitDto, 'entryName' | 'entryClass'>) => visit.entryName ?? ENTRY_LABELS[visit.entryClass]
/** How a visit arrived, said once: "Google, paid search" reads "Google · Paid" and an unnamed paid search "Search · Paid", never "Paid, paid". */
const visitChannel = (visit: Pick<JourneyVisitDto, 'entryName' | 'entryClass' | 'paid'>) => {
  if (!visit.entryName) return visit.paid && visit.entryClass !== 'paid' ? 'Paid' : null
  const channel = visit.paid && visit.entryClass !== 'paid' ? `${ENTRY_LABELS[visit.entryClass]}, paid` : ENTRY_LABELS[visit.entryClass]
  return channel === visitName(visit) ? null : channel
}
const timeOnly = (iso: string) => formatSweepInstant(iso, iso)
/** The method to print before a path: every method but GET. */
const shownMethod = (method: string | null) => (method && method.toUpperCase() !== 'GET' ? method.toUpperCase() : null)

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
    return <p className="py-6 text-copy-14 text-secondary">Journeys are unavailable for view-only accounts and embedded reports.</p>
  }
  const view = search.journeyView === 'agents' ? 'agents' : 'visitors'
  return (
    <section aria-labelledby="journeys-heading" className="space-y-6">
      <h2 id="journeys-heading" className="sr-only">Journeys</h2>
      <nav aria-label="Journey view" className="flex gap-6 border-b border-default">
        {([{ value: 'visitors', label: 'Visitors' }, { value: 'agents', label: 'Agent requests' }] as const).map(item => (
          <button key={item.value} type="button" aria-current={view === item.value ? 'page' : undefined}
            onClick={() => { if (view !== item.value) { trackUiFilterChange('other'); update({ journeyView: item.value === 'visitors' ? undefined : item.value }) } }}
            className={`-mb-px border-b-2 pb-2 text-label-14 transition-colors ${FOCUS_RING} ${view === item.value ? 'border-mono-100 text-heading' : 'border-transparent text-secondary hover:text-heading'}`}>
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
          className={`px-3 py-1.5 text-label-14 transition-colors ${FOCUS_RING} ${option.value === value ? 'bg-surface-active text-heading' : 'text-secondary hover:text-heading'}`}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="text-copy-14 text-secondary">
      <summary className={DISCLOSURE_CLASS}>{open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function ReadFailure({ what, error, retry }: { what: string; error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2 text-copy-14 text-secondary">
      <p>Could not load {what}. {extractErrorMessage(error)}</p>
      <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
    </div>
  )
}

/** One labelled figure in a summary strip; help is a short tooltip beside the label. */
function Figure({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-label-13 text-secondary">{label}{help && <InfoTooltip placement="bottom" text={help} />}</dt>
      <dd className="mt-1 text-heading-20 tabular-nums text-heading">{children}</dd>
    </div>
  )
}

function PartialSourceNotes({ projectName, partialSources }: { projectName: string; partialSources: JourneyPartialSources }) {
  if (partialSources.length === 0) return null
  return (
    <ul className="space-y-1">
      {partialSources.map(source => (
        <li key={source.sourceId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-14">
          <AlertTriangle className="size-3.5 shrink-0 text-caution" aria-hidden="true" />
          <span className="text-heading">Later visits are not recorded for {SOURCE_LABELS[source.sourceType] ?? source.sourceType}.</span>
          <InfoTooltip placement="bottom" text={source.reason} />
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
  const matching = search.journeyMatching === JourneyKeyBases.ua ? JourneyKeyBases.ua : ''
  const offset = Math.max(0, Number.parseInt(search.journeyOffset ?? '0', 10) || 0)
  const [windowEnd, setWindowEnd] = useState(() => new Date().toISOString())
  const window = { since: new Date(Date.parse(windowEnd) - Number(days) * 86_400_000).toISOString(), until: windowEnd }
  const summaryQuery = useQuery({ ...getApiV1ProjectsByNameJourneysSummaryOptions({ client: heyClient, path: { name: projectName }, query: window }), staleTime: 30_000 })
  const listQuery: JourneysQuery = { ...window, engine: engine || undefined, returned: returned || undefined, keyBasis: matching || JourneyKeyBases['ip-ua'], limit: VISITOR_PAGE_SIZE, offset }
  const query = useQuery({ ...getApiV1ProjectsByNameJourneysOptions({ client: heyClient, path: { name: projectName }, query: listQuery }), staleTime: 30_000 })
  const data = query.data
  const openKey = search.journeyVisitor ?? null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
        {summaryQuery.isPending ? <p role="status" className="text-copy-14 text-secondary">Loading visitor summary…</p>
          : summaryQuery.isError ? <ReadFailure what="the visitor summary" error={summaryQuery.error} retry={() => { void summaryQuery.refetch() }} />
            : <VisitorSummary summary={summaryQuery.data} />}
        <PeriodControl label="First AI visit within" options={VISITOR_PERIODS} value={days} onChange={value => {
          trackUiFilterChange('window'); setWindowEnd(new Date().toISOString()); update({ journeyDays: value === '30' ? undefined : value, journeyOffset: undefined, journeyVisitor: undefined })
        }} />
      </div>
      {data && <PartialSourceNotes projectName={projectName} partialSources={data.partialSources} />}

      {query.isPending ? <p role="status" className="py-6 text-copy-14 text-secondary">Loading visitors…</p>
        : query.isError ? <ReadFailure what="visitors" error={query.error} retry={() => { void query.refetch() }} />
          : data && data.visitors.length === 0 && !engine && !returned && !matching && summaryQuery.data?.aiVisitors === null ? (
            <div className="border-y border-default py-8 text-copy-14 text-secondary">
              <p className="text-label-14-strong text-heading">Visitors can't be measured here.</p>
              <p className="mt-1 max-w-prose">{NOT_MEASURABLE_HELP}</p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => { trackUiFilterChange('other'); update({ journeyMatching: JourneyKeyBases.ua, journeyOffset: undefined, journeyVisitor: undefined }) }}>Show browser groups</Button>
            </div>
          ) : data && data.visitors.length === 0 && !engine && !returned && !matching ? (
            <div className="border-y border-default py-8 text-copy-14 text-secondary">
              <p className="text-label-14-strong text-heading">No AI-referred visitors in this period.</p>
              <p className="mt-1 max-w-prose">Visitors appear after a connected traffic source records an AI referral. Try a longer period.</p>
              <Link to="/traffic" className="mt-2 inline-block text-link hover:underline">Review traffic sources</Link>
            </div>
          ) : data ? (
            <VisitorTable projectName={projectName} data={data} engines={summaryQuery.data?.byEngine.map(item => item.engine) ?? []} engine={engine} returned={returned} matching={matching} openKey={openKey}
              onToggle={key => { if (key) trackUiAction('journeys.visitor_open'); update({ journeyVisitor: key ?? undefined }) }}
              onFilter={patch => { trackUiFilterChange('other'); update({ ...patch, journeyOffset: undefined, journeyVisitor: undefined }) }}
              onPage={next => update({ journeyOffset: next === 0 ? undefined : String(next), journeyVisitor: undefined })} />
          ) : null}

      <Disclosure summary="About this data">
        <div className="max-w-prose space-y-3">
          {summaryQuery.data && <SummaryBreakdown summary={summaryQuery.data} />}
          {data && <CoverageNotes data={data} />}
        </div>
      </Disclosure>
    </div>
  )
}

function VisitorSummary({ summary }: { summary: JourneySummaryResponse }) {
  const visits = <Figure label="AI-referred visits">{summary.aiVisits.toLocaleString()}</Figure>
  if (summary.aiVisitors === null || summary.returningVisitors === null || summary.returnedVia === null) {
    return (
      <dl className="flex flex-wrap items-start gap-x-12 gap-y-4">
        {visits}
        <Figure label="Visitors and returns" help={NOT_MEASURABLE_HELP}><span className="text-label-14 text-secondary">Not measurable</span></Figure>
      </dl>
    )
  }
  const channels = (Object.entries(summary.returnedVia) as Array<[JourneyEntryClass, number]>).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
  const returnRate = summary.returnRate === null ? null : formatPercent(summary.returnRate, RatioUnits.fraction)
  const uncounted = summary.keyBasis.ua > 0
    ? `${plural(summary.keyBasis.ua, 'more visitor')} matched by browser only ${summary.keyBasis.ua === 1 ? 'is' : 'are'} not counted: one browser version can be many people.`
    : undefined
  return (
    <dl className="flex flex-wrap items-start gap-x-12 gap-y-4">
      {visits}
      <Figure label="AI-referred visitors" help={uncounted}>{summary.aiVisitors.toLocaleString()}</Figure>
      <Figure label="Came back" help={returnRate ? `${returnRate} came back in a later visit.` : undefined}>
        {summary.returningVisitors.toLocaleString()} <span className="text-label-14 text-secondary">of {summary.aiVisitors.toLocaleString()}</span>
        {returnRate && <span className="sr-only">, a {returnRate} return rate</span>}
      </Figure>
      <Figure label="Median time to return">
        {summary.medianDaysToReturn === null ? <span className="text-label-14 text-secondary">Not available</span> : formatDayDuration(summary.medianDaysToReturn)}
      </Figure>
      <Figure label="Return visits by channel">
        {channels.length === 0 ? <span className="text-label-14 text-secondary">None yet</span> : (
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-label-14 text-heading">
            {channels.map(([channel, count]) => <span key={channel}>{ENTRY_LABELS[channel]} <span className="tabular-nums text-secondary">{count.toLocaleString()}</span></span>)}
          </span>
        )}
      </Figure>
    </dl>
  )
}

/**
 * Later visits as the API sent them, from the first AI visit on, with back to
 * back visits through the same channel said once ("Google ×2").
 * `returnChannels` counts every later visit, including any not listed.
 */
function ReturnSummary({ visitor }: { visitor: JourneysResponse['visitors'][number] }) {
  const aiIndex = visitor.visits.findIndex(visit => visit.entryClass === 'ai')
  const later = aiIndex === -1 ? [] : visitor.visits.slice(aiIndex + 1)
  if (later.length === 0) return <span className="text-secondary">{visitor.returned ? 'Came back' : 'No return yet'}</span>
  const groups: Array<{ label: string; visits: number }> = []
  for (const visit of later) {
    const label = `${visitName(visit)}${visit.paid ? ' (paid)' : ''}`
    const previous = groups.at(-1)
    if (previous?.label === label) previous.visits++
    else groups.push({ label, visits: 1 })
  }
  const shown = groups.slice(0, MAX_RETURN_STEPS)
  const more = visitor.returnChannels.length - shown.reduce((sum, group) => sum + group.visits, 0)
  return (
    <span className="text-heading">
      {shown.map(group => (group.visits > 1 ? `${group.label} ×${group.visits}` : group.label)).join(', ')}
      {more > 0 && <span className="text-secondary"> +{more.toLocaleString()} more</span>}
    </span>
  )
}

function VisitorTable({ projectName, data, engines, engine, returned, matching, openKey, onToggle, onFilter, onPage }: {
  projectName: string
  data: JourneysResponse
  engines: string[]
  engine: string
  returned: string
  matching: string
  openKey: string | null
  onToggle: (key: string | null) => void
  onFilter: (patch: Partial<JourneysSearch>) => void
  onPage: (offset: number) => void
}) {
  const filtered = Boolean(engine || returned || matching)
  const groups = matching === JourneyKeyBases.ua
  const first = data.totalVisitors === 0 ? 0 : data.offset + 1
  const last = data.offset + data.visitors.length
  const openOffPage = openKey !== null && !data.visitors.some(visitor => visitor.visitorKey === openKey)
  return (
    <section aria-label="AI-referred visitors" className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-label-13 text-secondary">{first.toLocaleString()} to {last.toLocaleString()} of {plural(data.totalVisitors, groups ? 'browser group' : 'visitor')}</p>
        <details className="text-label-14" open={filtered || undefined}>
          <summary className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-base px-2.5 py-1 text-secondary hover:text-heading ${FOCUS_RING} [&::-webkit-details-marker]:hidden`}>
            <Filter className="size-3" aria-hidden="true" />Filter{filtered && <span className="text-heading">{[engine, returned === 'true' ? 'Came back' : returned === 'false' ? 'No return yet' : '', groups ? 'Browser groups' : ''].filter(Boolean).join(' · ')}</span>}
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-label-13 text-secondary">
              First AI engine
              <select className={SELECT_CLASS} value={engine} onChange={event => onFilter({ journeyEngine: event.target.value || undefined })}>
                <option value="">All engines</option>
                {engine && !engines.includes(engine) && <option value={engine}>{engine}</option>}
                {engines.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-label-13 text-secondary">
              Came back
              <select className={SELECT_CLASS} value={returned} onChange={event => onFilter({ journeyReturned: event.target.value || undefined })}>
                <option value="">All visitors</option><option value="true">Came back</option><option value="false">No return yet</option>
              </select>
            </label>
            <label className="grid gap-1 text-label-13 text-secondary">
              Matched by
              <select className={SELECT_CLASS} value={matching} onChange={event => onFilter({ journeyMatching: event.target.value || undefined })}>
                <option value="">Network and browser</option><option value={JourneyKeyBases.ua}>Browser only (groups)</option>
              </select>
            </label>
            {filtered && <Button size="sm" variant="outline" onClick={() => onFilter({ journeyEngine: undefined, journeyReturned: undefined, journeyMatching: undefined })}>Clear filters</Button>}
          </div>
        </details>
      </div>
      {groups && <p className="flex items-center gap-2 text-label-14 text-heading"><AlertTriangle className="size-3.5 shrink-0 text-caution" aria-hidden="true" />{BROWSER_GROUP_NOTE}</p>}
      {openKey && openOffPage && (
        <div className="rounded-md border border-default bg-surface-subtle px-4 py-4 sm:px-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-label-13 text-secondary">This visitor is not on this page of the list.</p>
            <Button size="sm" variant="outline" onClick={() => onToggle(null)}>Close</Button>
          </div>
          <VisitorDetail projectName={projectName} visitorKey={openKey} partialSources={data.partialSources} />
        </div>
      )}
      {data.visitors.length === 0 ? <p className="rounded-md border border-default p-5 text-copy-14 text-secondary">No visitors match these filters.</p> : (
        <div className="overflow-x-auto rounded-md border border-default">
          <table className="w-full min-w-[42rem]" aria-label="AI-referred visitors">
            <thead className="bg-surface-subtle text-left text-label-13 text-secondary">
              <tr>
                <th scope="col" className="py-2 pl-3 pr-2 font-normal">First AI visit</th>
                <th scope="col" className="px-2 py-2 font-normal">Landing page</th>
                <th scope="col" className="px-2 py-2 font-normal">Came back through</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Visits</th>
                <th scope="col" className="py-2 pl-2 pr-3 text-right font-normal">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {data.visitors.map(visitor => {
                const open = visitor.visitorKey === openKey
                const aiVisit = visitor.visits.find(visit => visit.entryClass === 'ai')
                const panelId = `journey-visitor-${visitor.visitorKey}`
                return (
                  <Fragment key={visitor.visitorKey}>
                    <tr className={open ? 'bg-surface-active' : 'hover:bg-surface-hover'}>
                      <td className="py-2.5 pl-3 pr-2 align-top">
                        <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`${visitor.firstAiEngine} visitor, first AI visit ${formatSweepInstant(visitor.firstAiAt)}`}
                          onClick={() => onToggle(open ? null : visitor.visitorKey)} className={`${ROW_TOGGLE} whitespace-nowrap`}>
                          {open ? <ChevronDown className="size-3.5 shrink-0 text-secondary" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />}
                          <span className="text-label-14-strong text-heading">{visitor.firstAiEngine}</span>
                          <time dateTime={visitor.firstAiAt} className="text-label-14 text-secondary">{formatSweepDay(visitor.firstAiAt)}</time>
                        </button>
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        {aiVisit ? <span className="block max-w-[18rem] truncate text-label-13-mono text-heading" title={aiVisit.landingPath}>{pathWithoutQuery(aiVisit.landingPath)}</span> : <span className="text-label-14 text-secondary">Not kept</span>}
                      </td>
                      <td className="px-2 py-2.5 align-top text-label-14"><ReturnSummary visitor={visitor} /></td>
                      <td className="px-2 py-2.5 text-right align-top text-label-14 tabular-nums text-heading">{visitor.visitCount.toLocaleString()}</td>
                      <td className="py-2.5 pl-2 pr-3 text-right align-top text-label-14 text-secondary"><time dateTime={visitor.lastSeenAt}>{formatSweepDay(visitor.lastSeenAt)}</time></td>
                    </tr>
                    {open && (
                      <tr id={panelId}>
                        <td colSpan={5} className="bg-surface-subtle px-4 py-4 sm:px-8">
                          <VisitorDetail projectName={projectName} visitorKey={visitor.visitorKey} partialSources={data.partialSources} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
  const [openVisitId, setOpenVisitId] = useState<string | null>(null)
  const query = useQuery({
    ...getApiV1ProjectsByNameJourneysByVisitorKeyOptions({ client: heyClient, path: { name: projectName, visitorKey }, query: { limit: VISIT_PAGE_SIZE, offset, events } }),
    staleTime: 30_000,
    placeholderData: previous => previous,
  })
  if (query.isPending) return <p role="status" className="text-copy-14 text-secondary">Loading visits…</p>
  if (query.isError) return <ReadFailure what="this visitor's visits" error={query.error} retry={() => { void query.refetch() }} />
  const detail = query.data
  const { visitor } = detail
  const loadedAll = detail.offset + detail.visits.length >= detail.totalVisits
  const lastVisit = detail.visits.at(-1)
  const partialSource = loadedAll && lastVisit ? partialSources.find(source => source.sourceId === lastVisit.sourceId) : undefined
  return (
    <div className="space-y-4" role="region" aria-label="Visits by this visitor">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-13 text-secondary">
        <span className="text-heading">{visitor.device}</span>
        <span aria-hidden="true">·</span>
        <span>{plural(detail.totalVisits, 'visit')}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          {visitor.keyBasis === JourneyKeyBases.ua ? 'Matched by browser only' : 'Matched by network and browser'}
          <InfoTooltip placement="bottom" text={visitor.keyBasis === JourneyKeyBases.ua
            ? 'May combine people who use the same browser version.'
            : 'May combine people on one network, or split one person whose address changed.'} />
        </span>
      </p>
      {visitor.cappedDays > 0 && (
        <p className="flex items-center gap-2 text-label-14">
          <AlertTriangle className="size-3.5 text-caution" aria-hidden="true" />
          <span className="text-heading">Some requests are missing on {plural(visitor.cappedDays, 'day')}.</span>
          <InfoTooltip placement="bottom" text={`At most ${JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY.toLocaleString()} requests per visitor are kept each day.`} />
        </p>
      )}

      <VisitTimeline visits={detail.visits} openId={openVisitId} events={detail.events} loading={query.isFetching}
        onToggle={id => { if (id) trackUiAction('journeys.visit_open'); setOpenVisitId(id) }}
        onToggleEvents={() => setEvents(events === JourneyEventFilters.pages ? JourneyEventFilters.all : JourneyEventFilters.pages)} />
      {partialSource && <p className="text-label-13 text-secondary">Later visits are not recorded by {SOURCE_LABELS[partialSource.sourceType] ?? partialSource.sourceType}.</p>}
      {(detail.totalVisits > detail.limit || detail.offset > 0) && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={detail.offset === 0 || query.isFetching} onClick={() => { setOffset(Math.max(0, detail.offset - detail.limit)); setOpenVisitId(null) }}>Earlier visits</Button>
          <Button variant="outline" size="sm" disabled={loadedAll || query.isFetching} onClick={() => { setOffset(detail.offset + detail.limit); setOpenVisitId(null) }}>Later visits</Button>
        </div>
      )}

      <Disclosure summary="Technical details">
        <dl className="max-w-prose space-y-2">
          <div><dt className="text-label-13-strong text-heading">Visitor key</dt><dd className="break-all text-label-13-mono">{visitor.visitorKey}</dd></div>
          <div><dt className="text-label-13-strong text-heading">Last recorded request</dt><dd><time dateTime={visitor.lastSeenAt}>{formatTimestamp(visitor.lastSeenAt)}</time></dd></div>
          <div><dt className="text-label-13-strong text-heading">User agent</dt><dd className="break-all text-label-13-mono">{visitor.userAgent ?? 'Not recorded'}</dd></div>
        </dl>
      </Disclosure>
    </div>
  )
}

/**
 * Visits top to bottom in time order. Each row says when, how the visit
 * arrived, where it landed and how many pages it saw; opening a visit lists
 * its pages. Requests are printed as recorded; the page never names what one
 * did.
 */
function VisitTimeline({ visits, openId, events, loading, onToggle, onToggleEvents }: {
  visits: JourneyDetailResponse['visits']
  openId: string | null
  events: JourneyEventFilter
  loading: boolean
  onToggle: (id: string | null) => void
  onToggleEvents: () => void
}) {
  return (
    <table className="w-full" aria-label="Visits in time order">
      <thead className="text-left text-label-12 text-secondary">
        <tr>
          <th scope="col" className="pb-1.5 pr-4 font-normal">When</th>
          <th scope="col" className="pb-1.5 pr-4 font-normal">Came from</th>
          <th scope="col" className="pb-1.5 pr-4 font-normal">Landing page</th>
          <th scope="col" className="pb-1.5 text-right font-normal">Pages</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-default">
        {visits.map(visit => {
          const open = visit.id === openId
          const channel = visitChannel(visit)
          return (
            <Fragment key={visit.id}>
              <tr>
                <td className="whitespace-nowrap py-2 pr-4 align-top">
                  <button type="button" aria-expanded={open} onClick={() => onToggle(open ? null : visit.id)} className={`${ROW_TOGGLE} text-label-14 text-heading`}>
                    {open ? <ChevronDown className="size-3.5 shrink-0 text-secondary" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />}
                    <time dateTime={visit.startedAt}>{formatSweepInstant(visit.startedAt)}</time>
                  </button>
                </td>
                <td className="py-2 pr-4 align-top text-label-14">
                  <span className={visit.entryClass === 'ai' ? 'text-label-14-strong text-heading' : 'text-heading'}>{visitName(visit)}</span>
                  {channel && <span className="text-secondary"> · {channel}</span>}
                </td>
                <td className="py-2 pr-4 align-top"><span className="block max-w-[22rem] truncate text-label-13-mono text-heading" title={visit.landingPath}>{pathWithoutQuery(visit.landingPath)}</span></td>
                <td className="py-2 text-right align-top text-label-14 tabular-nums text-heading">{visit.pageCount.toLocaleString()}</td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={4} className="pb-3 pl-6">
                    <VisitPages visit={visit} events={events} loading={loading} onToggleEvents={onToggleEvents} />
                  </td>
                </tr>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function VisitPages({ visit, events, loading, onToggleEvents }: {
  visit: JourneyDetailResponse['visits'][number]
  events: JourneyEventFilter
  loading: boolean
  onToggleEvents: () => void
}) {
  return (
    <div className="space-y-2">
      {visit.events.length === 0 ? <p className="text-copy-13 text-secondary">{events === JourneyEventFilters.pages ? 'No pages recorded for this visit.' : 'No requests recorded for this visit.'}</p> : (
        <ol aria-label={`${visitName(visit)} visit requests`} className="space-y-1">
          {visit.events.map((event, index) => (
            <li key={`${event.ts}:${index}`} className="flex items-baseline gap-3">
              <time dateTime={event.ts} className="w-20 shrink-0 text-label-13 tabular-nums text-secondary">{timeOnly(event.ts)}</time>
              <span className="min-w-0 break-all text-label-13-mono text-heading">
                {shownMethod(event.method) && <span className="text-secondary">{shownMethod(event.method)} </span>}{event.path}
              </span>
              {event.status !== null && event.status >= 400 && <span className="text-label-13 tabular-nums text-caution">{event.status}</span>}
            </li>
          ))}
        </ol>
      )}
      <button type="button" disabled={loading} onClick={onToggleEvents} className={`rounded text-label-13 text-link hover:underline disabled:opacity-50 ${FOCUS_RING}`}>
        {events === JourneyEventFilters.pages ? `Show all ${plural(visit.requestCount, 'request')}` : 'Show fewer requests'}
      </button>
    </div>
  )
}

function SummaryBreakdown({ summary }: { summary: JourneySummaryResponse }) {
  return (
    <div className="space-y-3">
      <p>{plural(summary.aiVisits, 'AI-referred visit')} started in this period, including visits from earlier visitors.</p>
      {summary.byEngine.length > 0 && (
        <table className="w-full max-w-md text-label-14" aria-label="Visitors by first AI engine">
          <thead className="text-left text-label-13"><tr><th scope="col" className="py-1.5 font-normal">First AI engine</th><th scope="col" className="py-1.5 text-right font-normal">Visitors</th><th scope="col" className="py-1.5 text-right font-normal">Came back</th></tr></thead>
          <tbody className="divide-y divide-default">{summary.byEngine.map(item => <tr key={item.engine}><td className="py-1.5 text-heading">{item.engine}</td><td className="py-1.5 text-right tabular-nums text-heading">{item.visitors.toLocaleString()}</td><td className="py-1.5 text-right tabular-nums text-heading">{item.returningVisitors.toLocaleString()}</td></tr>)}</tbody>
        </table>
      )}
      <p>Matching: {plural(summary.keyBasis.ipUa, 'visitor')} by network and browser, {plural(summary.keyBasis.ua, 'visitor')} by browser only. Visitor figures count only the first: one browser version can be many people.</p>
    </div>
  )
}

function CoverageNotes({ data }: { data: JourneysResponse }) {
  return (
    <div className="space-y-3">
      <p>Visitors are picked by their first AI visit, from {formatSweepInstant(data.windowStart)} to {formatSweepInstant(data.windowEnd)}. Their later visits show even after that.</p>
      <p>A new visit starts after {JOURNEY_VISIT_IDLE_MINUTES} minutes without requests. Requests count for {data.lookbackDays} days after an AI visit and are kept {data.retentionDays} days, up to {JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY.toLocaleString()} per visitor per UTC day.</p>
      <p>Visitors are inferred from server requests, not identified people, and a request does not prove a booking, sale or sign-up.</p>
      {data.partialSources.map(source => <p key={source.sourceId}><span className="text-label-14-strong text-heading">{SOURCE_LABELS[source.sourceType] ?? source.sourceType}:</span> {source.reason}</p>)}
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
        {data ? <AgentSummary context={data} /> : <p className="text-copy-14 text-secondary">Requests AI assistants made for a person</p>}
        <div className="flex flex-wrap items-start gap-3">
          <details className="text-label-14" open={filtered || undefined}>
            <summary className={`inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-base px-2.5 py-1.5 text-secondary hover:text-heading ${FOCUS_RING} [&::-webkit-details-marker]:hidden`}><Filter className="size-3" aria-hidden="true" />Filter</summary>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-label-13 text-secondary">
                Source
                <select className={SELECT_CLASS} value={sourceId} onChange={event => { trackUiFilterChange('other'); setSourceId(event.target.value); resetPage() }}>
                  <option value="">All sources</option>
                  {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-label-13 text-secondary">
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
      {filtered && <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label-14 text-secondary">
        {sourceId && <span>Source: <span className="text-heading">{selectedSource?.label ?? sourceId}</span></span>}
        {trust && <span>Trust: <span className="text-heading">{TRUST_LABELS[trust]}</span></span>}
        {targetKey && <span>Property: <span className="text-heading">{selectedProperty?.label ?? targetKey}</span></span>}
        {agent && <span>Agent: <span className="text-heading">{agent.label}</span></span>}
      </p>}

      {query.isPending ? <p role="status" className="py-6 text-copy-14 text-secondary">Loading agent requests…</p>
        : query.isError ? <ReadFailure what="agent requests" error={query.error} retry={() => { void query.refetch() }} />
          : data ? (
            <>
              {data.journeys.length === 0 ? (
                <div className="border-y border-default py-8 text-copy-14 text-secondary">
                  <p className="text-label-14-strong text-heading">No agent requests in this period.</p>
                  <p className="mt-1 max-w-prose">Try a longer period or clear filters.</p>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border border-default">
                  <table className="w-full min-w-[40rem]" aria-label="Agent visits">
                    <thead className="bg-surface-subtle text-left text-label-13 text-secondary">
                      <tr><th scope="col" className="px-3 py-2 font-normal">Agent</th><th scope="col" className="px-3 py-2 font-normal">Trust</th><th scope="col" className="px-3 py-2 font-normal">First page</th><th scope="col" className="px-3 py-2 font-normal">Started</th><th scope="col" className="px-3 py-2 text-right font-normal">Requests</th></tr>
                    </thead>
                    <tbody className="divide-y divide-default">
                      {data.journeys.map(journey => {
                        const expanded = selectedId === journey.id
                        return (
                          <Fragment key={journey.id}>
                            <tr className={expanded ? 'bg-surface-active' : 'hover:bg-surface-hover'}>
                              <td className="px-3 py-2.5 align-top">
                                <button type="button" aria-expanded={expanded} aria-controls={expanded ? `agent-sequence-${journey.id}` : undefined} aria-label={`${journey.product} visit starting ${formatSweepInstant(journey.startedAt)}`}
                                  onClick={() => { if (!expanded) trackUiAction('journeys.agent_open'); setSelectedId(expanded ? null : journey.id) }}
                                  className={`${ROW_TOGGLE} text-label-14-strong text-heading`}>
                                  {expanded ? <ChevronDown className="size-3.5 shrink-0 text-secondary" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />}
                                  {journey.product}
                                </button>
                              </td>
                              <td className="px-3 py-2.5 align-top text-label-14">
                                {journey.trustLevels.map(level => <span key={level} className={`block ${TRUST_TONES[level]}`}>{TRUST_LABELS[level]}</span>)}
                              </td>
                              <td className="px-3 py-2.5 align-top"><span className="block max-w-[22rem] truncate text-label-13-mono text-heading" title={`${journey.firstHost ?? ''}${journey.firstPath}`}>{journey.firstPath}</span></td>
                              <td className="whitespace-nowrap px-3 py-2.5 align-top text-label-14 text-secondary"><time dateTime={journey.startedAt}>{formatSweepInstant(journey.startedAt)}</time></td>
                              <td className="px-3 py-2.5 text-right align-top text-label-14 tabular-nums text-heading">{journey.requestCount.toLocaleString()}{journey.errorCount > 0 && <span className="block text-label-13 text-caution">{plural(journey.errorCount, 'error')}</span>}</td>
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
                <Button variant="outline" size="sm" disabled={data.offset + data.limit >= data.totalJourneys || query.isFetching} onClick={() => { setOffset(data.offset + data.limit); setSelectedId(null) }}>Next agent visits</Button>
              </div>}
              <Disclosure summary="About this data"><AgentCoverage context={data} /></Disclosure>
            </>
          ) : null}
    </div>
  )
}

function AgentSummary({ context }: { context: AgentJourneyContext & { totalJourneys: number; observedRequests: number } }) {
  const fake = context.coverage.likelyFakeRequests
  return (
    <div className="space-y-2">
      <dl className="flex flex-wrap items-start gap-x-12 gap-y-4">
        <Figure label="Agent visits" help="Requests an AI assistant made for a person, grouped when they come close together.">{context.totalJourneys.toLocaleString()}</Figure>
        <Figure label="Requests">{context.observedRequests.toLocaleString()}</Figure>
        {fake !== null && fake > 0 && <Figure label="Fake, not shown" help={LIKELY_FAKE_HELP}>{fake.toLocaleString()}</Figure>}
      </dl>
      {!context.coverage.recordingEnabled && <p className="flex items-center gap-2 text-label-14 text-heading"><AlertTriangle className="size-3.5 text-caution" aria-hidden="true" />Recording is off on this instance.</p>}
      {context.coverage.cappedSourceDays.length > 0 && <p className="flex items-center gap-2 text-label-14 text-heading"><AlertTriangle className="size-3.5 text-caution" aria-hidden="true" />Some requests are missing: a source reached its daily limit.</p>}
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        {query.data && query.data.events.length > 0 ? <TrustReasons operator={journey.operator} events={query.data.events} /> : <span />}
        <Button size="sm" variant="outline" onClick={onSelectAgent}>Only {journey.product}</Button>
      </div>
      {query.isPending ? <p role="status" className="text-copy-14 text-secondary">Loading requests…</p>
        : query.isError ? <ReadFailure what="these requests" error={query.error} retry={() => { void query.refetch() }} />
          : (
            <>
              {query.data.events.length === 0 ? <p className="text-copy-14 text-secondary">No recorded requests on this page.</p> : (
                <table className="w-full max-w-4xl" aria-label={`${journey.product} recorded requests`}>
                  <thead className="text-left text-label-12 text-secondary"><tr><th scope="col" className="py-1.5 pr-3 font-normal">Time</th><th scope="col" className="py-1.5 pr-3 font-normal">Request</th>{query.data.scope.mode === 'advanced' && <th scope="col" className="py-1.5 pr-3 font-normal">Property</th>}<th scope="col" className="py-1.5 pr-3 text-right font-normal">Latency</th><th scope="col" className="py-1.5 text-right font-normal">Status</th></tr></thead>
                  <tbody className="divide-y divide-default">
                    {query.data.events.map(event => (
                      <tr key={event.id}>
                        <td className="whitespace-nowrap py-1.5 pr-3 align-top text-label-13 tabular-nums text-secondary"><time dateTime={event.ts}>{new Date(event.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></td>
                        <td className="break-all py-1.5 pr-3 align-top text-label-13-mono text-heading">{shownMethod(event.method) && <span className="text-secondary">{shownMethod(event.method)} </span>}<span className="text-secondary">{event.host ?? ''}</span>{event.path}</td>
                        {query.data.scope.mode === 'advanced' && <td className="py-1.5 pr-3 align-top text-label-13 text-heading">{event.targetKey ? query.data.properties.find(property => property.key === event.targetKey)?.label ?? event.targetKey : ATTRIBUTION_LABELS[event.attribution]}</td>}
                        <td className="whitespace-nowrap py-1.5 pr-3 text-right align-top text-label-13 tabular-nums text-secondary">{event.latencyMs === null ? '-' : `${event.latencyMs} ms`}</td>
                        <td className={`py-1.5 text-right align-top text-label-13 tabular-nums ${event.status !== null && event.status >= 400 ? 'text-caution' : 'text-secondary'}`}>{event.status ?? '-'}</td>
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
    <ul className="space-y-1 text-label-14">
      {[...groups].map(([level, reasons]) => (
        <li key={level}><span className={TRUST_TONES[level]}>{TRUST_LABELS[level]}</span><span className="text-secondary">: {[...reasons].map(reason => trustReasonLabel(reason, operator)).join(' · ')}</span></li>
      ))}
    </ul>
  )
}

function AgentCoverage({ context }: { context: AgentJourneyContext }) {
  return (
    <div className="max-w-prose space-y-3">
      <p>{formatSweepInstant(context.windowStart)} to {formatSweepInstant(context.windowEnd)}. Agent visits are limited to this period.</p>
      <p>Requests are kept {context.coverage.retentionDays} days, up to {context.coverage.dailyEventLimit.toLocaleString()} per source per day. An agent visit ends after {context.coverage.idleMinutes} minutes without requests, and one network address can combine different tasks.</p>
      {context.scope.planRevision !== null && <p>Property attribution uses URL matches in plan revision {context.scope.planRevision}.</p>}
      <p>These requests do not show the person's task, market, tracked query, query class or model.</p>
      <ul className="list-disc space-y-1 pl-5">{context.coverage.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
      {context.coverage.cappedSourceDays.map(cap => <p key={`${cap.sourceId}:${cap.day}`}>Daily limit reached: {context.coverage.sources.find(source => source.sourceId === cap.sourceId)?.label ?? cap.sourceId}, {cap.day} (UTC).</p>)}
      {context.coverage.sources.map(source => <div key={source.sourceId}><p className="text-label-14-strong text-heading">{source.label}</p><ul className="list-disc space-y-1 pl-5">{source.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul></div>)}
    </div>
  )
}

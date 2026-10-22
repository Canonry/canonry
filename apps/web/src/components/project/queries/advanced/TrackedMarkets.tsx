import { Fragment, useId, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ChevronRight, Inbox, SearchX } from 'lucide-react'
import type { QueryTrackingResultGroup, QueryTrackingResultRow, QueryTrackingResultsResponse } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameQueryTrackingResultsOptions } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../../../../api.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { ChangeMark, EngineCount } from '../../../shared/EngineCount.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import type { TrackedSignal } from './tracked-types.js'
import { locationCountLabel } from './tracked-view-model.js'

type GroupType = QueryTrackingResultGroup['types'][number]
type Rate = GroupType['mentionCoverage']

const whole = (value: number) => value.toLocaleString('en-US')
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const HEAD = 'border-b border-default px-2 py-2 text-left text-[13px] font-medium leading-5 text-secondary first:pl-0 last:pr-0'
const CELL = 'border-b border-subtle px-2 py-2.5 align-middle text-[13px] leading-5 first:pl-0 last:pr-0'
const NUM = 'text-right tabular-nums'
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
/** The bar's share is the server's rate; at zero it is the track alone. A phone has no room for it. */
const BAR = 'relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-mono-800 max-md:hidden'
const PHONE_HIDDEN = 'max-md:hidden'

/** The order the list reads in: the server's share, losing or winning first, or by name. */
export type TrackedMarketOrder = 'losing' | 'winning' | 'name'

/** The non-brand result of a market: what a market list ranks on and what "who won" reads. */
const nonBrandOf = (group: QueryTrackingResultGroup) => group.types.find(type => type.queryClass === 'non-brand')
const rateOf = (type: GroupType | undefined, signal: TrackedSignal): Rate | undefined => type && (signal === 'cited' ? type.citationCoverage : type.mentionCoverage)

/** "0/12", the server's two counts; a rate that is withheld has no counts to show. */
function RateCounts({ rate }: { rate: Rate | undefined }) {
  if (!rate || rate.numerator === null || rate.denominator === null || rate.rate === null) return <span className="text-muted">Not measured</span>
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden="true" className={BAR}><span className="absolute inset-0 origin-left rounded-full bg-positive-fill" style={{ transform: `scaleX(${rate.rate})` }} /></span>
      <span className="font-medium text-strong">{whole(rate.numerator)}/{whole(rate.denominator)}</span>
    </span>
  )
}

/** Won and lost on the same queries since the previous sweep, for the switch's signal: "▲2 ▼1", blank when nothing moved. */
function ChangeCounts({ type, signal }: { type: GroupType | undefined; signal: TrackedSignal }) {
  const change = type?.change
  if (!change) return null
  const [won, lost] = signal === 'cited' ? [change.citationsWon, change.citationsLost] : [change.mentionsWon, change.mentionsLost]
  if (won === 0 && lost === 0) return null
  const noun = (count: number) => signal === 'cited' ? (count === 1 ? 'citation' : 'citations') : (count === 1 ? 'mention' : 'mentions')
  return (
    <span className="inline-flex items-center gap-2.5 font-medium tabular-nums">
      {won > 0 ? <span className="inline-flex items-center gap-1 text-positive-400"><ChangeMark change="won" />{whole(won)}<span className="sr-only"> {noun(won)} won</span></span> : null}
      {lost > 0 ? <span className="inline-flex items-center gap-1 text-negative-400"><ChangeMark change="lost" />{whole(lost)}<span className="sr-only"> {noun(lost)} lost</span></span> : null}
    </span>
  )
}

/** Who the answers gave instead: the first name (or site) and how many more. Values lead; the label recedes. */
function WhoWon({ group, signal }: { group: QueryTrackingResultGroup; signal: TrackedSignal }) {
  const names = signal === 'cited' ? group.citedInstead.map(entry => entry.host) : group.namedInstead.map(entry => entry.name)
  if (names.length === 0) return <span className="text-muted">None</span>
  return (
    <span className="min-w-0">
      <span className="text-secondary">{signal === 'cited' ? 'Cited ' : 'Lost to '}</span>
      <span className="font-medium text-strong">{names[0]}</span>
      {names.length > 1 ? <span className="text-secondary"> +{names.length - 1}</span> : null}
    </span>
  )
}

/** Names with their answer counts, "Rival Lofts 3 · Brook Commons 1": the value in front, the count after it. */
function CountedList({ items }: { items: readonly { label: string; answers: number }[] }) {
  if (items.length === 0) return <span className="text-muted">None</span>
  return (
    <span>
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? <span aria-hidden="true" className="text-muted"> · </span> : null}
          <span className="font-medium text-strong">{item.label}</span> <span className="tabular-nums text-secondary">{whole(item.answers)}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** One line of a fact under an opened market: its label muted, its value strong. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <dt className="shrink-0 text-secondary">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/**
 * Markets as rows, losing first: one line per market (or group of markets)
 * with its non-brand share of answers for the switch's signal, what changed
 * since the previous sweep, and who the answers named (or cited) instead. The
 * line is as wide with one engine as with ten: each engine's counts are the
 * opened market's. Every number is a field of the grouped results read.
 * Opening a market lists the facts its line leaves out: answers that named
 * another of the project's locations, each engine's counts, its own queries
 * with how many engines show the signal on each, every name and site given
 * instead, the tracked competitors, and its location queries' Branded result.
 * The arrow opens the market's queries.
 */
export function TrackedMarkets({ projectName, results, grouping, signal, order, search, engines, onOpenQueries, onOpenedChange }: {
  projectName: string
  /** The grouped read (`useTrackedGroups`), which the strip over the list reads too. */
  results: { data: QueryTrackingResultsResponse | undefined; isPending: boolean; isError: boolean; refetch: () => unknown }
  grouping: 'market' | 'group'
  signal: TrackedSignal
  order: TrackedMarketOrder
  search: string
  /** The page's engines, in its one order. */
  engines: readonly string[]
  /** Lists the queries of a market (or of a group of markets). */
  onOpenQueries: (place: { kind: 'market' | 'group'; key: string; label: string }) => void
  /** The market last opened, or null once none is open: what Aero reads as the opened row. */
  onOpenedChange?: (opened: { kind: 'market' | 'group'; key: string } | null) => void
}) {
  const query = results
  const [openKeys, setOpenKeys] = useState<readonly string[]>([])
  const tableId = useId()
  const toggle = (group: QueryTrackingResultGroup) => {
    const next = openKeys.includes(group.key) ? openKeys.filter(key => key !== group.key) : [...openKeys, group.key]
    setOpenKeys(next)
    const last = next.at(-1)
    onOpenedChange?.(last === undefined ? null : { kind: group.kind, key: last })
  }

  if (query.isPending && !query.isError) return (
    <div role="status" aria-label="Loading markets" className="space-y-3 py-3">
      {Array.from({ length: 8 }, (_, index) => <div key={index} aria-hidden="true" className="flex items-center gap-6"><div className="skeleton-text w-48" /><div className="skeleton-text w-20" /><div className="skeleton-text w-32" /><div className="skeleton-text w-40" /></div>)}
    </div>
  )
  if (query.isError) return (
    <div role="alert" className="flex flex-wrap items-center gap-3 py-6">
      <StatusNote icon={AlertTriangle} tone="caution" label="Markets unavailable" detail="The last sweep's markets did not load." />
      <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={() => { void query.refetch() }}>Retry</Button>
    </div>
  )
  const data = query.data
  if (!data) return null
  if (!data.run) return <div className="py-6 text-center"><StatusNote icon={Inbox} label="No sweep yet" detail="Markets are ranked once a sweep has answers." /></div>
  const tokens = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const groups = (data.groups ?? [])
    .filter(group => tokens.every(token => group.label.toLocaleLowerCase().includes(token)))
  const listed = order === 'name' ? [...groups].sort((left, right) => left.label.localeCompare(right.label, 'en', { sensitivity: 'base', numeric: true })) : groups
  if (listed.length === 0) return (
    <div className="py-6 text-center">
      {tokens.length > 0 ? <StatusNote icon={SearchX} label="No markets match" /> : <StatusNote icon={Inbox} label="No markets" detail="No market has a query in the last sweep." />}
    </div>
  )
  const noun = grouping === 'group' ? 'Group' : 'Market'
  const signalLabel = signal === 'cited' ? 'Cited' : 'Mentioned'
  const columns = 5

  return (
    <div className="overflow-x-auto">
      {/* On a phone a market is its name, its share and who won: the change waits in the opened market. */}
      <table id={tableId} aria-label={grouping === 'group' ? 'Groups of markets' : 'Markets'} className="w-full border-separate border-spacing-0 md:min-w-[56rem]">
        <thead>
          <tr>
            <th scope="col" className={HEAD}>{noun}</th>
            <th scope="col" className={`${HEAD} ${NUM}`}>{signalLabel}<span className="block text-[11px] font-normal leading-4 text-muted">non-brand</span></th>
            <th scope="col" className={`${HEAD} ${NUM} ${PHONE_HIDDEN}`}>Change<span className="block text-[11px] font-normal leading-4 text-muted">vs previous sweep</span></th>
            <th scope="col" className={HEAD}>{signal === 'cited' ? 'Cited instead' : 'Lost to'}</th>
            <th scope="col" className={HEAD}><span className="sr-only">Queries</span></th>
          </tr>
        </thead>
        <tbody>
          {listed.map(group => {
            const open = openKeys.includes(group.key)
            const nonBrand = nonBrandOf(group)
            const detailId = `${tableId}-${group.key}`
            return (
              <Fragment key={group.key}>
                <tr data-open={open ? '' : undefined}>
                  <td className={CELL}>
                    <button type="button" className={`inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 rounded-sm text-left ${FOCUS}`} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => toggle(group)}>
                      <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 self-center text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                      <span className="font-medium text-strong">{group.label}</span>
                      <span className="whitespace-nowrap text-secondary">{locationCountLabel(group.locations)}</span>
                    </button>
                  </td>
                  <td className={`${CELL} ${NUM}`}><RateCounts rate={rateOf(nonBrand, signal)} /></td>
                  <td className={`${CELL} ${NUM} ${PHONE_HIDDEN}`}><ChangeCounts type={nonBrand} signal={signal} /></td>
                  <td className={CELL}><WhoWon group={group} signal={signal} /></td>
                  <td className={`${CELL} w-10 text-right`}>
                    <Button type="button" variant="ghost" size="icon" className="size-8 pointer-coarse:size-11 max-md:size-11" aria-label={`Queries of ${group.label}`} onClick={() => onOpenQueries({ kind: group.kind, key: group.key, label: group.label })}>
                      <ArrowRight aria-hidden="true" className="size-4" />
                    </Button>
                  </td>
                </tr>
                {open ? (
                  <tr id={detailId}>
                    <td colSpan={columns} className="border-b border-subtle bg-surface/40 px-3 py-3">
                      <OpenedMarket projectName={projectName} group={group} signal={signal} engines={engines} runId={data.run?.id} onOpenQueries={onOpenQueries} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * What an opened market holds: answers that named another of the project's
 * locations, each engine's counts of both signals, every name and site given
 * instead, the tracked competitors, and its queries, each with how many
 * engines show the signal (`EngineCount`). A group of markets lists its
 * markets in their place. Counts are the grouped read's; the queries are a
 * read of the market narrowed to it, of the same sweep.
 */
function OpenedMarket({ projectName, group, signal, engines, runId, onOpenQueries }: {
  projectName: string
  group: QueryTrackingResultGroup
  signal: TrackedSignal
  engines: readonly string[]
  runId: string | undefined
  onOpenQueries: (place: { kind: 'market' | 'group'; key: string; label: string }) => void
}) {
  const nonBrand = nonBrandOf(group)
  const branded = group.types.find(type => type.queryClass === 'branded')
  // A market's own queries, from the same sweep. A group of markets lists its markets instead, so it reads none.
  const rows = useQuery({
    ...getApiV1ProjectsByNameQueryTrackingResultsOptions({
      client: heyClient,
      path: { name: projectName },
      query: { scope: 'market', scopeKey: group.key, ...(runId ? { runId } : {}), ...(signal === 'cited' ? { signal } : {}), sort: 'losing', compare: 'previous' },
    }),
    enabled: group.kind === 'market',
  })
  const marketRows: QueryTrackingResultRow[] = (rows.data?.rows ?? []).filter(row => row.queryClass === 'non-brand')
  return (
    <div className="space-y-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-1 text-[13px] leading-5">
        {nonBrand && signal === 'mentioned' ? (
          <Fact label="Other location"><span className="font-medium tabular-nums text-strong">{whole(nonBrand.otherLocationMentionedAnswers)} of {whole(nonBrand.answers)}</span></Fact>
        ) : null}
        {nonBrand ? (
          <Fact label="By engine">
            <span className="inline-flex flex-wrap gap-x-3">
              {engines.map(engine => {
                const entry = nonBrand.engines.find(candidate => candidate.provider === engine)
                if (!entry) return null
                return (
                  <span key={engine} className="whitespace-nowrap">
                    <span className="text-secondary">{providerDisplayName(engine)} </span>
                    <span className="font-medium tabular-nums text-strong">{whole(entry.mentionedAnswers)}</span><span className="text-secondary"> mentioned · </span>
                    <span className="font-medium tabular-nums text-strong">{whole(entry.citedAnswers)}</span><span className="text-secondary"> cited of {whole(entry.answers)}</span>
                  </span>
                )
              })}
            </span>
          </Fact>
        ) : null}
      </dl>
      {group.kind === 'market' ? (
        rows.isPending ? <div role="status" aria-label="Loading queries" className="space-y-2">{[0, 1, 2].map(index => <div key={index} aria-hidden="true" className="skeleton-text w-80" />)}</div>
          : rows.isError ? <StatusNote icon={AlertTriangle} tone="caution" label="Queries unavailable" detail="This market's queries did not load." />
            : marketRows.length > 0 ? (
              <table aria-label={`${group.label} queries`} className="w-full border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th scope="col" className={HEAD}>Market query</th>
                    <th scope="col" className={`${HEAD} w-36`}>{signal === 'cited' ? 'Cited by' : 'Mentioned by'}</th>
                  </tr>
                </thead>
                <tbody>
                  {marketRows.map(row => (
                    <tr key={`${row.queryId}:${row.queryClass}`}>
                      <td className={`${CELL} font-medium text-strong`}>{row.queryText}</td>
                      <td className={CELL}><EngineCount counts={row.engineCounts ?? null} which={signal} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null
      ) : null}
      <dl className="flex flex-wrap gap-x-8 gap-y-1 text-[13px] leading-5">
        {signal === 'mentioned'
          ? <Fact label="Named instead"><CountedList items={group.namedInstead.map(entry => ({ label: entry.name, answers: entry.answers }))} /></Fact>
          : <Fact label="Cited instead"><CountedList items={group.citedInstead.map(entry => ({ label: entry.host, answers: entry.answers }))} /></Fact>}
        <Fact label="Competitors">
          <CountedList items={group.competitors
            .map(entry => ({ label: entry.domain, answers: signal === 'cited' ? entry.citedAnswers : entry.mentionedAnswers }))
            .filter(entry => entry.answers > 0)} />
        </Fact>
        {branded ? (
          <Fact label="Location queries">
            <span className="text-secondary">{whole(branded.queries)} Branded · </span>
            <BrandedRate rate={rateOf(branded, signal)} signal={signal} />
          </Fact>
        ) : null}
      </dl>
      <Button type="button" variant="outline" size="sm" className={`gap-1.5 ${TOUCH}`} onClick={() => onOpenQueries({ kind: group.kind, key: group.key, label: group.label })}>
        {group.kind === 'group' ? `Markets and queries of ${group.label}` : `All queries of ${group.label}`}
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  )
}

/** "16 of 16 mentioned": the Branded type's own rate, never pooled with the market's. */
function BrandedRate({ rate, signal }: { rate: Rate | undefined; signal: TrackedSignal }) {
  if (!rate || rate.numerator === null || rate.denominator === null) return <span className="text-muted">not measured</span>
  return <span><span className="font-medium tabular-nums text-strong">{whole(rate.numerator)} of {whole(rate.denominator)}</span><span className="text-secondary"> {signal}</span></span>
}


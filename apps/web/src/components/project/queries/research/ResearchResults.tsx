import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { AlertTriangle, Ban, Clock, Info, MousePointerClick } from 'lucide-react'
import {
  answerCompletionLabel,
  answerCostBasisLabel,
  CitationStates,
  normalizeIdentityText,
  ResearchQueryStatuses,
  ResearchRunStatuses,
  type AnswerEvidence as AnswerEvidenceDto,
  type AnswerSource as AnswerSourceDto,
  type ResearchRunDetailDto,
  type ResearchRunQueryDto,
  type ResearchRunScope,
  type ResearchRunStatus,
  type ResearchRunSummaryDto,
} from '@canonry/canonry-contracts'

import { isEmbed } from '../../../../api.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { AnswerMarkdown } from '../../../shared/AnswerMarkdown.js'
import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { SignalLegend, SignalPair, type EngineSignal } from '../../../shared/SignalCells.js'
import { SourceLink } from '../../../shared/SourceLink.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { ToneBadge } from '../../../shared/ToneBadge.js'
import { Button } from '../../../ui/button.js'
import { Card } from '../../../ui/card.js'
import type { TrackResearchItem } from './TrackResearchSheet.js'

/** The words of the Results card. `RESEARCH_COPY` in `ResearchQueriesSection.tsx` holds them with the rest of the Research copy. */
export const RESEARCH_RESULTS_COPY = {
  subject: 'Subject',
  notSet: 'Not set',
  searchLocation: 'Search location',
  noSearchLocation: 'No search location',
  resultsTitle: 'Results',
  resultsLoading: 'Loading results',
  resultsEmpty: 'No run selected',
  lastBatch: 'Last batch',
  pickRun: 'Pick a run',
  methodologySummary: 'Company names only',
  methodology: "Named checks the answer text for this project's company names and domains. Cited checks the source links for this project's domain. Neither checks a location's own names.",
  templateProvenance: 'Pattern details',
  resolvedTextHelp: 'The queries below are the final text sent to the engine, including any edits.',
  reviewHelp: 'Only this saved query text goes to tracking review. Its answer stays research evidence.',
  trackHelp: "Tick queries, then Track. Only the query text is tracked, for its run's Subject. Its answer stays research evidence. Nothing here starts a sweep.",
  citedCompetitorsHelp: 'Cited as a source, not only named in the answer.',
  noAnswer: 'No answer',
  answerPending: 'Answer pending',
  waitingUpstream: 'Waiting on service',
  partialAnswer: 'Partial answer, not measured',
  serviceEvidence: 'Answer service evidence',
  citationsNotMeasured: 'Not measured',
  citationsNotMeasuredHelp: 'This service does not tie its sources to the answer.',
  brandedQuery: 'Branded',
  nonBrandQuery: 'Non-brand',
  untypedQuery: 'Not set',
  tracked: 'Tracked',
  notTracked: 'No',
  notLoaded: 'Not loaded',
  trackedNotLoaded: 'Tracked not loaded',
  trackedError: 'Tracked queries did not load, so no row can say whether it is tracked.',
  selectAll: 'Select all rows',
  selectedActions: 'Selected actions',
} as const

export type ResearchTrackingSource = { researchRunQueryId: string; scope?: ResearchRunScope | null }

/**
 * What a Research table needs to mark the queries that are already tracked
 * and to tick the rest, on an Advanced project. A Simple project gives none,
 * and keeps "Review for tracking".
 */
export type ResearchTracking = {
  /** Each tracked query's Subject, as the Tracked table words it, by the query's identity text. Undefined until the tracked queries have loaded. */
  subjects: ReadonlyMap<string, string> | undefined
  /** The tracked queries did not load: no row is marked or ticked until `onRetry` reads them. */
  failed: boolean
  onRetry: () => void
  /** Left out for an account that cannot track: no row gets a box. */
  selection?: {
    pickedIds: ReadonlySet<string>
    onPick: (items: readonly TrackResearchItem[], picked: boolean) => void
    /** The id of the bar for the ticked rows, which follows the page: the table holds a link to it. */
    barId: string
  }
}
/** The Results card reads this from its page, not from props: the form between them only passes a run along. */
export const ResearchTrackingContext = createContext<ResearchTracking | null>(null)

/** The Subject a tracked query has, or null when the query is not tracked. Undefined until the tracked queries have loaded. */
export function trackedSubjectOf(tracking: ResearchTracking, query: string): string | null | undefined {
  return tracking.subjects ? tracking.subjects.get(normalizeIdentityText(query)) ?? null : undefined
}

/** The Tracked cell of a Research table: the Subject of a tracked query, or No. A read that failed is not a No. */
export function TrackedCell({ tracking, subject }: { tracking: ResearchTracking; subject: string | null | undefined }) {
  if (subject === undefined) return tracking.failed ? <span className="text-muted">{RESEARCH_RESULTS_COPY.notLoaded}</span> : <span aria-hidden="true" className="skeleton-text block w-12" />
  return subject === null ? <span className="text-muted">{RESEARCH_RESULTS_COPY.notTracked}</span> : subject
}

/** Over a Research table whose tracked queries did not load. Named for what is missing and in the caution tone: the table's own rows did load. */
export function TrackedReadFailed({ tracking }: { tracking: ResearchTracking }) {
  return (
    <div role="alert">
      <StatusNote icon={AlertTriangle} tone="caution" label={RESEARCH_RESULTS_COPY.trackedNotLoaded} detail={RESEARCH_RESULTS_COPY.trackedError} action={<Button type="button" variant="outline" size="sm" className="pointer-coarse:min-h-11 max-md:min-h-11" aria-label="Retry tracked queries" onClick={tracking.onRetry}>Retry</Button>} />
    </div>
  )
}

/** A box in a Research table, drawn as the Tracked table draws its own. A dash is some of the rows. */
export function TrackBox({ label, checked, indeterminate = false, disabled = false, onChange }: { label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <label className="tracked-check">
      <input ref={box} type="checkbox" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

/** The way from a table to the bar for its ticked rows, drawn only under focus: the bar follows the whole page. */
export function SelectedActionsLink({ barId }: { barId: string }) {
  return (
    <div className="relative">
      <a href={`#${barId}`} className="tracked-skip" onClick={event => { event.preventDefault(); document.getElementById(barId)?.querySelector<HTMLElement>('button:not(:disabled)')?.focus() }}>{RESEARCH_RESULTS_COPY.selectedActions}</a>
    </div>
  )
}

export const RESEARCH_STATUS_LABEL: Record<ResearchRunStatus, string> = {
  [ResearchRunStatuses.queued]: 'Queued',
  [ResearchRunStatuses.running]: 'Running',
  [ResearchRunStatuses['waiting-upstream']]: 'Waiting',
  [ResearchRunStatuses.completed]: 'Completed',
  [ResearchRunStatuses.partial]: 'Partial',
  [ResearchRunStatuses.failed]: 'Failed',
}
// The two Research tables share one look: a sentence-case 13px header over compact rows.
export const RESEARCH_TABLE = 'w-full border-separate border-spacing-0 text-[13.5px] leading-5 text-neutral [overflow-wrap:anywhere]'
const TH = 'whitespace-nowrap border-b border-default py-2 text-[13px] font-medium text-secondary'
const TD = 'border-b border-subtle py-2 align-middle'
export const RESEARCH_TH = `${TH} px-2.5 text-left`
export const RESEARCH_TD = `${TD} px-2.5`
export const RESEARCH_ROW_BUTTON = 'rounded-sm text-left font-medium text-heading hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 pointer-coarse:min-h-11 max-md:min-h-11'
// The results header stays under the topbar while the rows scroll, as the Tracked table's does. A phone gets closer cells, and the chips column a narrow one in every width.
const STICKY = 'sticky top-(--topbar-h) z-10 bg-bg'
const RESULT_TH = `${TH} ${STICKY} px-2.5 text-left max-sm:px-1.5`
const RESULT_TD = `${TD} px-2.5 max-sm:px-1.5`
const FIELD = 'mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 max-md:min-h-11'
// The column of boxes: as wide as one box, which is 44px where a finger is the pointer, and with no padding, so a box adds nothing to a row's height.
const SELECT_COLUMN = 'w-8 p-0 text-center align-middle pointer-coarse:w-11 max-md:w-11'
export const RESEARCH_SELECT_TH = `border-b border-default ${SELECT_COLUMN}`
export const RESEARCH_SELECT_TD = `border-b border-subtle ${SELECT_COLUMN}`

/**
 * What tells each run of a batch from the others, in the batch's order: its
 * Subject, or its search location when no run has a Subject. Runs under one
 * Subject add their search location, because a preview edit can split a place
 * across two.
 */
function batchRunNames(runs: readonly Pick<ResearchRunSummaryDto, 'scope' | 'location'>[], bySubject: boolean): string[] {
  const searchLocation = (run: Pick<ResearchRunSummaryDto, 'location'>) => run.location?.label ?? RESEARCH_RESULTS_COPY.noSearchLocation
  if (!bySubject) return runs.map(searchLocation)
  const subjects = runs.map(run => run.scope?.label ?? RESEARCH_RESULTS_COPY.notSet)
  return runs.map((run, index) => subjects.indexOf(subjects[index]!) === subjects.lastIndexOf(subjects[index]!) ? subjects[index]! : `${subjects[index]} · ${searchLocation(run)}`)
}

/** When a run was made, as Past research and the Results card both show it. */
export function formatResearchDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

/**
 * The results of one saved research run: what was asked and where, one row
 * per query with the engine's two chips, and the selected query's answer.
 * Research checks the company's names and the project's domain, so the first
 * chip is N. A query still queued, running or waiting on an upstream job draws
 * skeleton chips; a signal the engine never returned is a dashed box, never a No.
 *
 * On an Advanced project (`ResearchTrackingContext`) a Tracked column says
 * which queries are tracked already, with their Subject, and an account that
 * can track gets a box on every other row. A ticked row carries the Subject
 * its run was saved under, and stays ticked while another run is in view.
 */
export function ResearchRunDetail({
  detail,
  isLoading,
  failedRunId,
  failure,
  batch,
  headingRef,
  company,
  domain,
  onReviewForTracking,
}: {
  detail: ResearchRunDetailDto | null
  isLoading: boolean
  /** The selected run when its results did not load: the card keeps its heading and shows `failure` as its body. */
  failedRunId: string | null
  failure: ReactNode
  /** The runs the last batch made, when it made more than one: the card gets a select over them, which stays while another run is in view. */
  batch?: { runs: readonly ResearchRunSummaryDto[]; selectedRunId: string | null; onSelect: (runId: string) => void; selectRef?: Ref<HTMLSelectElement> }
  /** The heading takes focus when a run is picked or saved elsewhere on the page. */
  headingRef?: Ref<HTMLHeadingElement>
  /** What the legend says the chips check: the company's name and the project's domain. */
  company: string
  domain: string
  onReviewForTracking?: (source: ResearchTrackingSource) => void
}) {
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const headingId = useId()
  const tracking = useContext(ResearchTrackingContext)
  const selection = tracking?.selection

  useEffect(() => {
    setSelectedQueryId(detail?.queries[0]?.id ?? null)
  }, [detail?.id])

  const selected = detail?.queries.find(item => item.id === selectedQueryId) ?? detail?.queries[0] ?? null
  const engine = detail ? providerDisplayName(detail.provider) : ''
  // A batch across search locations saves every run under no Subject, so its select is named for what does differ. Over a run from outside the batch it names the batch, with no run chosen.
  const bySubject = batch?.runs.some(run => run.scope) ?? false
  const inBatch = batch?.runs.some(run => run.id === batch.selectedRunId) ?? false
  const batchLabel = !batch ? null : !inBatch ? RESEARCH_RESULTS_COPY.lastBatch : bySubject ? RESEARCH_RESULTS_COPY.subject : RESEARCH_RESULTS_COPY.searchLocation
  const batchNames = batch ? batchRunNames(batch.runs, bySubject) : []
  // A ticked row is tracked for the place its run was saved under. The wire calls a location a property.
  const runSubject = detail?.scope ? { kind: detail.scope.kind === 'property' ? 'location' as const : 'market' as const, key: detail.scope.key } : undefined
  const trackItem = (item: ResearchRunQueryDto): TrackResearchItem => ({ text: item.query, input: { source: 'research', researchRunQueryId: item.id }, ...(runSubject ? { subject: runSubject } : {}) })
  // A query that is tracked already has nothing to tick. Until the tracked queries have loaded, no row can say.
  const tickable = detail && tracking?.subjects ? detail.queries.filter(item => trackedSubjectOf(tracking, item.query) === null) : []
  const ticked = selection ? tickable.filter(item => selection.pickedIds.has(item.id)).length : 0

  return (
    <Card className="surface-card min-w-0" role="region" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-3">
          {/* Lands under the topbar when a pick or a run scrolls the page to it. */}
          <h3 id={headingId} ref={headingRef} tabIndex={-1} className="scroll-mt-[calc(var(--topbar-h)+1.5rem)] rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg">{RESEARCH_RESULTS_COPY.resultsTitle}</h3>
          {detail && <ToneBadge tone={toneForResearchRun(detail.status)}>{RESEARCH_STATUS_LABEL[detail.status]}</ToneBadge>}
          {/* What a tick does, where rows have boxes. After the status, close to it, so the heading and its status still read as one. */}
          {detail && selection ? <span className="-ml-3 flex"><InfoTooltip text={RESEARCH_RESULTS_COPY.trackHelp} placement="bottom" /></span> : null}
        </div>
        {detail && <SignalLegend variant="research" company={company} domain={domain} />}
      </div>
      {batch && <label className="mt-3 block max-w-md text-sm font-medium text-heading">{batchLabel}
        <select ref={batch.selectRef} className={FIELD} value={inBatch ? batch.selectedRunId ?? '' : ''} onChange={event => { if (event.target.value) batch.onSelect(event.target.value) }}>
          {!inBatch && <option value="">{RESEARCH_RESULTS_COPY.pickRun}</option>}
          {batch.runs.map((run, index) => <option key={run.id} value={run.id}>{batchNames[index]} · {RESEARCH_STATUS_LABEL[run.status]}</option>)}
        </select>
      </label>}
      {failedRunId && <div role="alert" className="mt-4">
        <p className="mb-2 text-sm text-secondary">Run <span className="font-mono">{shortId(failedRunId)}</span></p>
        {failure}
      </div>}
      {!detail && !failedRunId && (isLoading
        ? <div role="status" aria-label={RESEARCH_RESULTS_COPY.resultsLoading} className="mt-4">{[0, 1, 2, 3].map(row => <div key={row} aria-hidden="true" className="flex items-center gap-8 border-b border-subtle py-3"><span className="skeleton-text w-2/5" /><span className="skeleton-text ml-auto w-16" /><span className="skeleton-text w-10" /></div>)}</div>
        : <div className="mt-3"><StatusNote icon={MousePointerClick} label={RESEARCH_RESULTS_COPY.resultsEmpty} /></div>)}
      {detail && <div className="mt-3 space-y-3 text-sm text-secondary">
        {/* What the two chips check sits under the legend it qualifies, on the line of the run's own facts. */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <dl className="flex flex-wrap gap-x-6 gap-y-2 [overflow-wrap:anywhere]">
            {/* The run's date, as its row in Past research shows it. */}
            <div><dt className="font-medium">Run</dt><dd className="tabular-nums">{formatResearchDate(detail.createdAt)}</dd></div>
            <div><dt className="font-medium">Engine</dt><dd>{engine}</dd></div>
            <div><dt className="font-medium">Model</dt><dd className="font-mono">{detail.requestedModel ?? detail.resolvedModel}</dd></div>
            {/* The select over a batch already names this run by what its runs differ in. */}
            {batchLabel !== RESEARCH_RESULTS_COPY.searchLocation && <div><dt className="font-medium">{RESEARCH_RESULTS_COPY.searchLocation}</dt><dd>{detail.location?.label ?? RESEARCH_RESULTS_COPY.noSearchLocation}</dd></div>}
            {batchLabel !== RESEARCH_RESULTS_COPY.subject && <div><dt className="font-medium">{RESEARCH_RESULTS_COPY.subject}</dt><dd>{detail.scope?.label ?? RESEARCH_RESULTS_COPY.notSet}</dd></div>}
          </dl>
          <StatusNote icon={Info} label={RESEARCH_RESULTS_COPY.methodologySummary} detail={RESEARCH_RESULTS_COPY.methodology} />
        </div>
        {detail.template && <details>
          <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{RESEARCH_RESULTS_COPY.templateProvenance}</summary>
          <dl className="mt-2 space-y-2">
            <div><dt className="font-medium">Saved pattern</dt><dd className="whitespace-pre-wrap">{detail.template.template}</dd></div>
            <div><dt className="font-medium">Names used</dt><dd>{Object.entries(detail.template.bindings).map(([key, value]) => `{${key}}: ${value}`).join(' · ') || 'None'}</dd></div>
            <div><dt className="flex items-center font-medium">Resolved text<InfoTooltip text={RESEARCH_RESULTS_COPY.resolvedTextHelp} placement="bottom" /></dt><dd className="whitespace-pre-wrap">{detail.template.output}</dd></div>
          </dl>
          <p className="mt-2 font-mono text-xs">{detail.template.templateId} · {detail.template.templateVersion}</p>
        </details>}
      </div>}
      {detail && (
        <div className="mt-3 space-y-4">
          {tracking?.failed ? <TrackedReadFailed tracking={tracking} /> : null}
          {selection && selection.pickedIds.size > 0 ? <SelectedActionsLink barId={selection.barId} /> : null}
          {/* Fixed columns, so the table fits a phone with no frame to scroll: below sm the Type sits under its query, and below xl, where the sidebar leaves the Query little room, so does what it is tracked for.
              Beside a column of boxes a phone has no room for a Status column either, so its badge joins the Type. */}
          <table className={`${RESEARCH_TABLE} table-fixed [&_tbody_tr:last-child_td]:border-b-0`}>
            <thead><tr>
              {selection ? <th scope="col" className={`${RESEARCH_SELECT_TH} ${STICKY}`}>
                <TrackBox label={RESEARCH_RESULTS_COPY.selectAll} checked={tickable.length > 0 && ticked === tickable.length} indeterminate={ticked > 0 && ticked < tickable.length} disabled={tickable.length === 0} onChange={checked => selection.onPick(tickable.map(trackItem), checked)} />
              </th> : null}
              <th scope="col" className={RESULT_TH}>Query</th>
              <th scope="col" className={`${RESULT_TH} w-28 max-sm:hidden`}>Type</th>
              <th scope="col" className={`${RESULT_TH} w-[6.75rem] ${selection ? 'max-sm:hidden' : 'max-sm:w-[5.75rem]'}`}>Status</th>
              {tracking ? <th scope="col" className={`${RESULT_TH} w-[16rem] max-xl:hidden`}>{RESEARCH_RESULTS_COPY.tracked}</th> : null}
              <th scope="col" className={`${TH} ${STICKY} w-20 px-1 text-center max-sm:w-16`}>{engine}</th>
            </tr></thead>
            <tbody>
              {detail.queries.map(item => {
                const type = item.queryClass === 'branded' ? RESEARCH_RESULTS_COPY.brandedQuery : item.queryClass === 'non-brand' ? RESEARCH_RESULTS_COPY.nonBrandQuery : RESEARCH_RESULTS_COPY.untypedQuery
                const trackedFor = tracking ? trackedSubjectOf(tracking, item.query) : null
                const status = <ToneBadge tone={toneForResearchQuery(item.status)}>{RESEARCH_STATUS_LABEL[item.status]}</ToneBadge>
                return (
                  <tr key={item.id} className={selected?.id === item.id ? 'bg-bg-elevated/40' : undefined}>
                    {selection ? <td className={RESEARCH_SELECT_TD}>
                      {/* A tracked query keeps its cell and has no box. */}
                      {trackedFor ? null : <TrackBox label={`Select ${item.query}`} checked={selection.pickedIds.has(item.id)} disabled={trackedFor === undefined} onChange={checked => selection.onPick([trackItem(item)], checked)} />}
                    </td> : null}
                    <td className={RESULT_TD}>
                      <button type="button" className={RESEARCH_ROW_BUTTON} aria-pressed={selected?.id === item.id} onClick={() => setSelectedQueryId(item.id)}>{item.query}</button>
                      <span className={`${selection ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'block'} text-[13px] text-secondary sm:hidden`}>{type}{selection ? status : null}</span>
                      {trackedFor ? <span className="block text-[13px] text-secondary xl:hidden">{RESEARCH_RESULTS_COPY.tracked} · {trackedFor}</span> : null}
                    </td>
                    <td className={`${RESULT_TD} whitespace-nowrap max-sm:hidden ${item.queryClass ? '' : 'text-muted'}`}>{type}</td>
                    <td className={`${RESULT_TD} whitespace-nowrap${selection ? ' max-sm:hidden' : ''}`}>{status}</td>
                    {tracking ? <td className={`${RESULT_TD} text-secondary max-xl:hidden`}><TrackedCell tracking={tracking} subject={trackedFor} /></td> : null}
                    <td className={`${TD} px-1 text-center`}><SignalPair variant="research" engineLabel={engine} signal={researchSignal(item)} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ResearchAnswer query={selected} scope={detail.scope ?? null} isLoading={isLoading} onReviewForTracking={onReviewForTracking} />
        </div>
      )}
    </Card>
  )
}

export function ResearchAnswer({
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
          <InfoTooltip text={RESEARCH_RESULTS_COPY.reviewHelp} placement="bottom" />
        </div>
      )}
      {query.error && (
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">{query.error}</div>
      )}
      {query.error && query.evidence && query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">{RESEARCH_RESULTS_COPY.partialAnswer}</p>
          <div className="mt-1"><AnswerMarkdown headingLevel={4} copyable>{query.answerText}</AnswerMarkdown></div>
        </div>
      ) : query.error ? null : query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Answer</p>
          <div className="mt-1"><AnswerMarkdown headingLevel={4} copyable>{query.answerText}</AnswerMarkdown></div>
        </div>
      ) : (
        <div>{query.status === ResearchQueryStatuses.queued || query.status === ResearchQueryStatuses.running
          ? <StatusNote icon={Clock} label={RESEARCH_RESULTS_COPY.answerPending} />
          : query.status === ResearchQueryStatuses['waiting-upstream']
            ? <StatusNote icon={Clock} label={RESEARCH_RESULTS_COPY.waitingUpstream} detail={waitingUpstreamDetail(query.upstreamJobId)} />
            : <StatusNote icon={Ban} label={RESEARCH_RESULTS_COPY.noAnswer} />}</div>
      )}
      {query.namedCompetitors.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Competitors named</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {query.namedCompetitors.map(name => <span key={name} className="mention-chip mention-chip--competitor">{name}</span>)}
          </div>
        </div>
      )}
      {query.citedCompetitorDomains.length > 0 && (
        <div>
          <p className="flex items-center text-[10px] uppercase tracking-wide text-muted">Cited competitor domains<InfoTooltip text={RESEARCH_RESULTS_COPY.citedCompetitorsHelp} placement="bottom" /></p>
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
      {query.evidence && <AnswerServiceEvidence evidence={query.evidence} />}
    </div>
  )
}

/** Why a query has no answer yet while its service works on it as an upstream job. */
function waitingUpstreamDetail(upstreamJobId: string | null | undefined): string {
  return `The service is still working on this query as an upstream job${upstreamJobId ? ` (${upstreamJobId})` : ''}. It is followed by that job and never sent again.`
}

const SOURCE_RELATIONSHIP_LABELS: Record<AnswerSourceDto['relationship'], string> = {
  'explicit-citation': 'Cited in the answer',
  'answer-support': 'Used for the answer',
  'search-result': 'Search result',
  'page-read': 'Page read',
}

/** What a search answer service returned beyond the answer: status, identity and every source with its relationship. */
function AnswerServiceEvidence({ evidence }: { evidence: AnswerEvidenceDto }) {
  const otherSources = evidence.sources.filter(source => source.relationship === 'search-result' || source.relationship === 'page-read')
  return (
    <div className="space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-muted">{RESEARCH_RESULTS_COPY.serviceEvidence}</p>
      <dl className="definition-list">
        <div><dt>Status</dt><dd>{answerCompletionLabel(evidence.completion.status)}</dd></div>
        <div><dt>Profile</dt><dd className="font-mono text-xs">{evidence.identity.route}</dd></div>
        <div><dt>Model</dt><dd>{evidence.identity.disclosedModel ? `${evidence.identity.disclosedModel}${evidence.identity.disclosedModelKind === 'service-tier' ? ' (service tier)' : ''}` : 'Not disclosed'}</dd></div>
        <div><dt>Cost</dt><dd>{answerCostBasisLabel(evidence.usage.cost)}</dd></div>
        {!evidence.citationMeasurable && <div><dt>Citations</dt><dd className="flex items-center">{RESEARCH_RESULTS_COPY.citationsNotMeasured}<InfoTooltip text={RESEARCH_RESULTS_COPY.citationsNotMeasuredHelp} placement="bottom" /></dd></div>}
      </dl>
      {otherSources.length > 0 && (
        <ul className="space-y-3">
          {otherSources.map((source, index) => (
            <li key={`${source.url}-${index}`} className="min-w-0">
              <p className="text-xs text-muted">{SOURCE_RELATIONSHIP_LABELS[source.relationship]}</p>
              <SourceLink url={source.url} title={source.title ?? source.url} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One query's two signals, each from its own field. A query still queued,
 * running or waiting on an upstream job has no result yet, so its pair is a
 * skeleton; once it has finished or failed, a signal with no value is not
 * checked, never a No. A service whose sources are not tied to the answer
 * leaves `citationState` null, so its Cited chip reads not checked.
 */
function researchSignal(query: ResearchRunQueryDto): EngineSignal | undefined {
  if (query.status === ResearchQueryStatuses.queued || query.status === ResearchQueryStatuses.running || query.status === ResearchQueryStatuses['waiting-upstream']) return undefined
  return {
    mentioned: query.answerMentioned,
    cited: query.citationState === null ? null : query.citationState === CitationStates.cited,
  }
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function toneForResearchRun(status: ResearchRunStatus) {
  if (status === ResearchRunStatuses.completed) return 'positive'
  if (status === ResearchRunStatuses.partial || status === ResearchRunStatuses['waiting-upstream']) return 'caution'
  if (status === ResearchRunStatuses.failed) return 'negative'
  return 'neutral'
}

function toneForResearchQuery(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.completed) return 'positive'
  if (status === ResearchQueryStatuses.failed) return 'negative'
  if (status === ResearchQueryStatuses['waiting-upstream']) return 'caution'
  return 'neutral'
}

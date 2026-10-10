import { useEffect, useId, useState, type ReactNode } from 'react'
import { Ban, Clock, Info, MousePointerClick } from 'lucide-react'
import {
  CitationStates,
  ResearchQueryStatuses,
  ResearchRunStatuses,
  type ResearchRunDetailDto,
  type ResearchRunQueryDto,
  type ResearchRunScope,
  type ResearchRunStatus,
  type ResearchRunSummaryDto,
} from '@ainyc/canonry-contracts'

import { isEmbed } from '../../../../api.js'
import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { WriteButton } from '../../../shared/AccessControls.js'
import { AnswerMarkdown } from '../../../shared/AnswerMarkdown.js'
import { InfoTooltip } from '../../../shared/InfoTooltip.js'
import { SignalLegend, SignalPair, type EngineSignal } from '../../../shared/SignalCells.js'
import { SourceLink } from '../../../shared/SourceLink.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { ToneBadge } from '../../../shared/ToneBadge.js'
import { Card } from '../../../ui/card.js'

/** The words of the Results card. `RESEARCH_COPY` in `ResearchQueriesSection.tsx` holds them with the rest of the Research copy. */
export const RESEARCH_RESULTS_COPY = {
  subject: 'Subject',
  notSet: 'Not set',
  searchLocation: 'Search location',
  noSearchLocation: 'No search location',
  resultsTitle: 'Results',
  resultsLoading: 'Loading results',
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

export type ResearchTrackingSource = { researchRunQueryId: string; scope?: ResearchRunScope | null }

export const RESEARCH_STATUS_LABEL: Record<ResearchRunStatus, string> = {
  [ResearchRunStatuses.queued]: 'Queued',
  [ResearchRunStatuses.running]: 'Running',
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
const FIELD = 'mt-1 w-full rounded border border-strong bg-transparent px-3 py-2 text-sm text-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'

/** What tells one run of a batch from the next: its Subject, then its search location when it has one. */
function researchRunName(run: Pick<ResearchRunSummaryDto, 'scope' | 'location'>): string {
  return [run.scope?.label, run.location?.label].filter(Boolean).join(' · ') || RESEARCH_RESULTS_COPY.notSet
}

/**
 * The results of one saved research run: what was asked and where, one row
 * per query with the engine's two chips, and the selected query's answer.
 * Research checks the company's names and the project's domain, so the first
 * chip is N. A query still queued or running draws skeleton chips; a signal
 * the engine never returned is a dashed box, never a No.
 */
export function ResearchRunDetail({
  detail,
  isLoading,
  failedRunId,
  failure,
  batch,
  company,
  domain,
  onReviewForTracking,
}: {
  detail: ResearchRunDetailDto | null
  isLoading: boolean
  /** The selected run when its results did not load: the card keeps its heading and shows `failure` as its body. */
  failedRunId: string | null
  failure: ReactNode
  /** The runs the last batch made, when it made more than one and the run in view is one of them: the card gets a select over them. */
  batch?: { runs: readonly ResearchRunSummaryDto[]; selectedRunId: string; onSelect: (runId: string) => void }
  /** What the legend says the chips check: the company's name and the project's domain. */
  company: string
  domain: string
  onReviewForTracking?: (source: ResearchTrackingSource) => void
}) {
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(null)
  const headingId = useId()

  useEffect(() => {
    setSelectedQueryId(detail?.queries[0]?.id ?? null)
  }, [detail?.id])

  const selected = detail?.queries.find(item => item.id === selectedQueryId) ?? detail?.queries[0] ?? null
  const engine = detail ? providerDisplayName(detail.provider) : ''
  // A batch across search locations saves every run under no Subject, so its select is named for what does differ.
  const batchLabel = !batch ? null : batch.runs.some(run => run.scope) ? RESEARCH_RESULTS_COPY.subject : RESEARCH_RESULTS_COPY.searchLocation

  return (
    <Card className="surface-card min-w-0" role="region" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-3">
          <h3 id={headingId}>{RESEARCH_RESULTS_COPY.resultsTitle}</h3>
          {detail && <ToneBadge tone={toneForResearchRun(detail.status)}>{RESEARCH_STATUS_LABEL[detail.status]}</ToneBadge>}
        </div>
        {detail && <SignalLegend variant="research" company={company} domain={domain} />}
      </div>
      {batch && <label className="mt-3 block max-w-md text-sm font-medium text-heading">{batchLabel}
        <select className={FIELD} value={batch.selectedRunId} onChange={event => batch.onSelect(event.target.value)}>
          {batch.runs.map(run => <option key={run.id} value={run.id}>{researchRunName(run)} · {RESEARCH_STATUS_LABEL[run.status]}</option>)}
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
            <div><dt className="font-medium">Run</dt><dd className="font-mono">{shortId(detail.id)}</dd></div>
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
          {/* Fixed columns, so the table fits a phone with no frame to scroll: below sm the Type sits under its query. */}
          <table className={`${RESEARCH_TABLE} table-fixed [&_tbody_tr:last-child_td]:border-b-0`}>
            <thead><tr>
              <th scope="col" className={RESULT_TH}>Query</th>
              <th scope="col" className={`${RESULT_TH} w-28 max-sm:hidden`}>Type</th>
              <th scope="col" className={`${RESULT_TH} w-[6.75rem] max-sm:w-[5.75rem]`}>Status</th>
              <th scope="col" className={`${TH} ${STICKY} w-20 px-1 text-center max-sm:w-16`}>{engine}</th>
            </tr></thead>
            <tbody>
              {detail.queries.map(item => {
                const type = item.queryClass === 'branded' ? RESEARCH_RESULTS_COPY.brandedQuery : item.queryClass === 'non-brand' ? RESEARCH_RESULTS_COPY.nonBrandQuery : RESEARCH_RESULTS_COPY.untypedQuery
                return (
                  <tr key={item.id} className={selected?.id === item.id ? 'bg-bg-elevated/40' : undefined}>
                    <td className={RESULT_TD}>
                      <button type="button" className={RESEARCH_ROW_BUTTON} aria-pressed={selected?.id === item.id} onClick={() => setSelectedQueryId(item.id)}>{item.query}</button>
                      <span className="block text-[13px] text-secondary sm:hidden">{type}</span>
                    </td>
                    <td className={`${RESULT_TD} whitespace-nowrap max-sm:hidden ${item.queryClass ? '' : 'text-muted'}`}>{type}</td>
                    <td className={`${RESULT_TD} whitespace-nowrap`}><ToneBadge tone={toneForResearchQuery(item.status)}>{RESEARCH_STATUS_LABEL[item.status]}</ToneBadge></td>
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
      {query.error ? (
        <div className="rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">{query.error}</div>
      ) : query.answerText ? (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Answer</p>
          <div className="mt-1"><AnswerMarkdown headingLevel={4} copyable>{query.answerText}</AnswerMarkdown></div>
        </div>
      ) : (
        <div>{query.status === ResearchQueryStatuses.queued || query.status === ResearchQueryStatuses.running
          ? <StatusNote icon={Clock} label={RESEARCH_RESULTS_COPY.answerPending} />
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
    </div>
  )
}

/**
 * One query's two signals, each from its own field. A query still queued or
 * running has no result yet, so its pair is a skeleton; once it has finished
 * or failed, a signal with no value is not checked, never a No.
 */
function researchSignal(query: ResearchRunQueryDto): EngineSignal | undefined {
  if (query.status === ResearchQueryStatuses.queued || query.status === ResearchQueryStatuses.running) return undefined
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
  if (status === ResearchRunStatuses.partial) return 'caution'
  if (status === ResearchRunStatuses.failed) return 'negative'
  return 'neutral'
}

function toneForResearchQuery(status: ResearchRunQueryDto['status']) {
  if (status === ResearchQueryStatuses.completed) return 'positive'
  if (status === ResearchQueryStatuses.failed) return 'negative'
  return 'neutral'
}

import {
  CitationStates,
  QueryClasses,
  type CitationState,
  type ObservedQueryCounts,
  type QueryClass,
  type RunQueryCountsByClass,
} from '@canonry/canonry-contracts'

import { AnswerMarkdown } from '../shared/AnswerMarkdown.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { ANSWER_CITATION_LABEL } from '../../lib/format-helpers.js'
import { CITATION_NOT_MEASURED } from '../../lib/citation-not-measured-copy.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'

/** Characters of the first saved answer shown before "Read full answer". */
const FIRST_ANSWER_PREVIEW_LENGTH = 650

/**
 * The answer that best shows what the first check found. A branded query hands
 * the engine the brand's name, so its mention says little; a non-brand answer
 * that names or cites the brand is the proof.
 */
export function featuredSetupAnswer<T extends { queryId: string; answerText?: string | null; answerMentioned?: boolean | null; citationState: CitationState }>(
  snapshots: readonly T[],
  queryClassOf: (queryId: string) => QueryClass | null | undefined = () => undefined,
): T | undefined {
  const answered = snapshots.filter(snapshot => Boolean(snapshot.answerText?.trim()))
  const nonBrand = answered.filter(snapshot => queryClassOf(snapshot.queryId) === QueryClasses['non-brand'])
  return nonBrand.find(snapshot => snapshot.answerMentioned === true)
    ?? nonBrand.find(snapshot => snapshot.citationState === CitationStates.cited)
    ?? answered.find(snapshot => snapshot.answerMentioned === true)
    ?? answered.find(snapshot => snapshot.citationState === CitationStates.cited)
    ?? answered[0]
}

/**
 * The first result's rows: non-brand first, branded beside it, each with its
 * own denominator. One pooled row only when the run's queries have no class
 * (no usable brand name) or the server predates the split.
 */
export function firstResultRows(
  byClass: RunQueryCountsByClass | null | undefined,
  pooled: ObservedQueryCounts | null | undefined,
): { label: string; counts: ObservedQueryCounts | undefined }[] {
  if (!byClass) return [{ label: 'All queries', counts: pooled ?? undefined }]
  const rows = [
    { label: 'Non-brand', counts: byClass.nonBrand },
    { label: 'Branded', counts: byClass.branded },
  ].filter(row => row.counts.totalQueries > 0)
  return rows.length > 0 ? rows : [{ label: 'Non-brand', counts: byClass.nonBrand }]
}

/** Every query an engine without sources answered: whether it cites the site was never observed. */
export function citationUnmeasured(counts: ObservedQueryCounts | undefined): boolean {
  return Boolean(counts && counts.totalQueries > 0 && (counts.citationNotMeasuredQueries ?? 0) === counts.totalQueries)
}

/** "3 of 7 queries", or Unavailable when the run reports no query counts. */
function QueryShare({ count, total }: { count: number | undefined; total: number | undefined }) {
  if (count === undefined || total === undefined) return <span className="text-label-14 text-secondary">Unavailable</span>
  return (
    <>
      <span className="text-heading-20 tabular-nums text-heading">{count}</span>{' '}
      <span className="text-label-14 text-secondary">of {total} {total === 1 ? 'query' : 'queries'}</span>
    </>
  )
}

/**
 * Mentioned and cited for the first check, one row per query class. Branded and
 * non-brand queries never share a denominator, and "cited" counts only the
 * queries some answer's sources were checked for.
 */
export function FirstResultTable({
  byClass,
  pooled,
}: {
  byClass: RunQueryCountsByClass | null | undefined
  pooled: ObservedQueryCounts | null | undefined
}) {
  const rows = firstResultRows(byClass, pooled)
  const unclassifiedQueries = byClass?.unclassifiedQueries ?? 0
  return (
    <div>
      <table className="w-full text-left">
        <caption className="sr-only">First AI Visibility check by query class</caption>
        <thead>
          <tr className="text-label-14 text-secondary">
            <th scope="col" className="py-2 pr-4 font-normal">Queries</th>
            <th scope="col" className="py-2 pr-4 font-normal">Mentioned</th>
            <th scope="col" className="py-2 font-normal">Cited</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default border-t border-default">
          {rows.map(row => (
            <tr key={row.label}>
              <th scope="row" className="py-3 pr-4 text-label-14-strong text-heading">{row.label}</th>
              <td className="py-3 pr-4"><QueryShare count={row.counts?.mentionedQueries} total={row.counts?.totalQueries} /></td>
              <td className="py-3">
                {/* An engine that returns no sources is not measured, never 0. */}
                {citationUnmeasured(row.counts)
                  ? <span className="inline-flex items-center gap-1 text-label-14 text-secondary">{CITATION_NOT_MEASURED.label}<InfoTooltip text={CITATION_NOT_MEASURED.sources} /></span>
                  : <QueryShare count={row.counts?.citedQueries} total={row.counts ? row.counts.totalQueries - (row.counts.citationNotMeasuredQueries ?? 0) : undefined} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {unclassifiedQueries > 0 ? <p className="mt-2 text-label-14 text-secondary">{unclassifiedQueries} {unclassifiedQueries === 1 ? 'query has' : 'queries have'} no single query class and {unclassifiedQueries === 1 ? 'is' : 'are'} not counted above.</p> : null}
    </div>
  )
}

/** One saved answer, with its engine and both signals, as the first check recorded it. */
export function FeaturedAnswer({
  answer,
}: {
  answer: {
    provider: string
    query?: string | null
    answerText?: string | null
    answerMentioned?: boolean | null
    citationState: CitationState
  }
}) {
  const text = answer.answerText ?? ''
  // AnswerMarkdown cuts its preview past this many parsed characters. Markdown
  // syntax and link URLs only make the written text longer, so an answer within
  // the limit always shows in full.
  const truncated = Array.from(text).length > FIRST_ANSWER_PREVIEW_LENGTH
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ProviderBadge provider={answer.provider} displayName={providerDisplayName(answer.provider)} />
        <ToneBadge tone={answer.answerMentioned ? 'positive' : 'neutral'}>{answer.answerMentioned === true ? 'Mentioned' : answer.answerMentioned === false ? 'Not mentioned' : 'Mention not measured'}</ToneBadge>
        <ToneBadge tone={answer.citationState === CitationStates.cited ? 'positive' : 'neutral'}>{ANSWER_CITATION_LABEL[answer.citationState]}</ToneBadge>
      </div>
      {answer.query ? <h3 className="text-heading-16 text-heading">{answer.query}</h3> : null}
      {/* A preview that shows the whole answer carries its copy action; a cut one leaves it to the full answer. */}
      <div className="mt-3 text-copy-14 text-secondary"><AnswerMarkdown previewLength={FIRST_ANSWER_PREVIEW_LENGTH} copyable={!truncated}>{text}</AnswerMarkdown></div>
      {truncated ? <details className="mt-3"><summary className="cursor-pointer text-label-14 text-link">Read full answer</summary><div className="mt-3 text-copy-14 text-secondary"><AnswerMarkdown copyable>{text}</AnswerMarkdown></div></details> : null}
    </div>
  )
}

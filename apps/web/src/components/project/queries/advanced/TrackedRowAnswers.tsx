import { Fragment, useId, useState } from 'react'
import { AlertTriangle, Clock, Info } from 'lucide-react'
import type { QueryTrackingAnswerRow, QueryTrackingResultRow } from '@canonry/canonry-contracts'

import { providerDisplayName } from '../../../../lib/visibility-trend-helpers.js'
import { AnswerText } from '../../../shared/AnswerText.js'
import { SignalPair } from '../../../shared/SignalCells.js'
import { StatusNote } from '../../../shared/StatusNote.js'
import { Button } from '../../../ui/button.js'
import type { QueriesSectionProps } from '../../DiscoverySection.js'
import { useTrackedAnswers } from '../use-tracked-answers.js'
import { typeLabel } from './tracked-view-model.js'

const PAD = 'px-2.5 py-1.5 first:pl-0 last:pr-0 @max-[40rem]:px-1.5'
const HEAD = `border-b border-default text-left text-[13px] font-medium leading-5 text-secondary ${PAD}`
const CELL = `border-b border-subtle align-top ${PAD}`
const TOUCH = 'pointer-coarse:min-h-11 max-md:min-h-11'
/** As many names as a cell shows; the rest are its count. */
const NAMES_SHOWN = 3

type Line = { key: string; provider: string; engine: string; type: string; answer: QueryTrackingAnswerRow }
type Source = NonNullable<QueryTrackingAnswerRow['citedSources']>[number]

/** As many sites as a cell shows; the rest are its count. */
const SITES_SHOWN = 2

/**
 * The sites an answer cited, each once, in the order it cited them: a few,
 * then how many more. One of the project's own is marked as yours, and a
 * tracked competitor's as a competitor's.
 */
function CitedSites({ sources }: { sources: readonly Source[] }) {
  const sites = [...new Map(sources.map(source => [source.host, source])).values()]
  if (sites.length === 0) return <span className="text-muted">None</span>
  const shown = sites.slice(0, SITES_SHOWN)
  return (
    <span title={sites.map(site => site.host).join(' · ')}>
      {shown.map((site, index) => (
        <Fragment key={site.host}>
          {index > 0 ? <span aria-hidden="true" className="text-muted"> · </span> : null}
          <span className={site.ours ? 'font-medium text-positive-400' : site.competitor ? 'font-medium text-strong' : 'text-strong'}>{site.host}</span>
          {site.ours ? <span className="text-secondary"> (yours)</span> : site.competitor ? <span className="text-secondary"> (competitor)</span> : null}
        </Fragment>
      ))}
      {sites.length > SITES_SHOWN ? <span className="text-secondary"> +{sites.length - SITES_SHOWN}</span> : null}
    </span>
  )
}

/** Names in a cell: a few, then how many more. A name can hold a comma, so a dot parts two of them. */
function someNames(names: readonly string[]): string {
  if (names.length === 0) return 'None'
  const shown = names.slice(0, NAMES_SHOWN).join(' · ')
  return names.length > NAMES_SHOWN ? `${shown} +${names.length - NAMES_SHOWN}` : shown
}

/**
 * What each engine answered for one tracked query on the sweep the list reads:
 * one line per answer, with that answer's own marks, the locations it
 * mentioned when the query counts for more than one, who it mentioned
 * instead, and the answer itself one press away. Every value is a field of
 * the results read narrowed to the query.
 */
export function TrackedRowAnswers({ projectName, selection, queryId, runId, targetLabel, engines }: {
  projectName: string
  selection: Pick<NonNullable<QueriesSectionProps['selection']>, 'measurementScope' | 'measurementScopeKey'>
  queryId: string
  /** The sweep the list reads, so the answers are that sweep's. */
  runId: string | undefined
  targetLabel: (key: string) => string
  /** The page's engines in its one order, so the lines run as its columns do. Another engine follows them. */
  engines?: readonly string[]
}) {
  const headingId = useId()
  const [opened, setOpened] = useState<string | null>(null)
  const query = useTrackedAnswers(projectName, selection, queryId, runId)

  if (query.isPending) return (
    <div role="status" aria-label="Loading answers" className="space-y-2 pb-3">
      {[0, 1, 2].map(index => <div key={index} aria-hidden="true" className="flex items-center gap-4"><div className="skeleton-text w-16" /><div className="skeleton-text w-10" /><div className="skeleton-text w-40" /></div>)}
    </div>
  )
  if (query.isError) return (
    <div role="alert" className="flex flex-wrap items-center gap-3 pb-3">
      <StatusNote icon={AlertTriangle} tone="negative" label="Answers unavailable" detail="This query's answers did not load." />
      <Button type="button" variant="outline" size="sm" className={TOUCH} aria-label="Retry answers" onClick={() => { void query.refetch() }}>Retry</Button>
    </div>
  )
  const data = query.data
  if (!data?.run) return <div className="pb-3"><StatusNote icon={Info} label="Not measured" detail="No sweep has finished yet." /></div>
  const rows: QueryTrackingResultRow[] = data.rows.filter(row => row.queryId === queryId)
  if (rows.length === 0) return <div className="pb-3"><StatusNote icon={Clock} label="Not in last sweep" detail="Added or changed since the last sweep. Results come with the next one." /></div>

  const order = (provider: string) => {
    const at = engines?.indexOf(provider) ?? -1
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  const lines: Line[] = rows.flatMap(row => [...row.engines].sort((left, right) => order(left.provider) - order(right.provider)).flatMap(engine => (engine.answerRows ?? []).map((answer, index) => ({
    key: `${row.queryClass}:${engine.provider}:${index}`,
    provider: engine.provider,
    engine: providerDisplayName(engine.provider),
    type: typeLabel(row.queryClass === 'unknown' ? 'not-set' : row.queryClass),
    answer,
  }))))
  // A column only where it can tell the lines apart, or has something to say.
  const showType = new Set(rows.map(row => row.queryClass)).size > 1
  const showSearch = new Set(lines.map(line => line.answer.searchLocation)).size > 1
  const showLocations = lines.some(line => line.answer.targetKeys.length > 1)
  // Names given in place of ours, from the answers that did not mention us; the names an answer gave beside ours are another column.
  const showInstead = lines.some(line => line.answer.mentioned === false)
  const showAlso = lines.some(line => (line.answer.alsoNamed ?? []).length > 0)
  const showCited = lines.some(line => line.answer.citedSources !== undefined)
  const columns = 3 + (showType ? 1 : 0) + (showSearch ? 1 : 0) + (showLocations ? 1 : 0) + (showInstead ? 1 : 0) + (showAlso ? 1 : 0) + (showCited ? 1 : 0)

  return (
    <div className="pb-3">
      <h4 id={headingId} className="text-[13px] font-medium leading-5 text-strong">Answers</h4>
      <div className="mt-1 overflow-x-auto">
        <table aria-labelledby={headingId} className="w-full border-separate border-spacing-0 text-[13px] leading-5 text-neutral">
          <thead>
            <tr>
              <th scope="col" className={HEAD}>Engine</th>
              {showType ? <th scope="col" className={HEAD}>Type</th> : null}
              {showSearch ? <th scope="col" className={HEAD}>Search location</th> : null}
              <th scope="col" className={HEAD}>Result</th>
              {showLocations ? <th scope="col" className={HEAD}>Location mentioned</th> : null}
              {showInstead ? <th scope="col" className={HEAD}>Named instead</th> : null}
              {showAlso ? <th scope="col" className={HEAD}>Also named</th> : null}
              {showCited ? <th scope="col" className={HEAD}>Cited</th> : null}
              <th scope="col" className={HEAD}><span className="sr-only">Answer</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map(line => {
              const open = opened === line.key
              const { answer } = line
              return (
                <Fragment key={line.key}>
                  <tr>
                    <td className={`${CELL} whitespace-nowrap font-medium text-strong`}>{line.engine}</td>
                    {showType ? <td className={`${CELL} whitespace-nowrap`}>{line.type}</td> : null}
                    {showSearch ? <td className={`${CELL} text-secondary`}>{answer.searchLocation ?? 'None'}</td> : null}
                    <td className={CELL}><SignalPair signal={{ mentioned: answer.mentioned, cited: answer.cited }} engineLabel={line.engine} /></td>
                    {showLocations ? <td className={`${CELL} text-secondary`}>{someNames(answer.mentionedTargetKeys.map(targetLabel))}</td> : null}
                    {/* A name is "instead" only on an answer that did not mention us; a blank cell is an answer that did, or could not be checked. */}
                    {showInstead ? <td className={`${CELL} text-strong`}>{answer.mentioned === false ? someNames(answer.namedInstead) : null}</td> : null}
                    {showAlso ? <td className={`${CELL} text-strong`}>{(answer.alsoNamed ?? []).length > 0 ? someNames(answer.alsoNamed ?? []) : null}</td> : null}
                    {showCited ? <td className={CELL}><CitedSites sources={answer.citedSources ?? []} /></td> : null}
                    <td className={`${CELL} py-0 text-right`}>
                      {answer.resultId ? (
                        <Button type="button" variant="ghost" size="sm" className={`h-7 px-2 text-strong md:h-7 ${TOUCH}`} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Read'} the ${line.engine} answer`} onClick={() => setOpened(open ? null : line.key)}>
                          {open ? 'Hide answer' : 'Read answer'}
                        </Button>
                      ) : <StatusNote icon={AlertTriangle} tone="caution" label="No answer saved" detail="This engine's answer was not stored." />}
                    </td>
                  </tr>
                  {open && answer.resultId ? (
                    <tr>
                      <td colSpan={columns} className={`${CELL} pl-0`}>
                        <AnswerText project={projectName} targetKey={answer.targetKeys[0]!} resultId={answer.resultId} headingLevel={5} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

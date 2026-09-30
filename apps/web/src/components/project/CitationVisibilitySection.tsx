import React, { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatPercent, RatioUnits, type CitationVisibilityResponse } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameCitationsVisibilityOptions } from '@ainyc/canonry-api-client/react-query'
import { heyClient, isDashboardManagedSweeps } from '../../api.js'
import type { ProjectCommandCenterVm } from '../../view-models.js'
import { MANAGED_SWEEPS_COPY } from './ManagedSweepStatus.js'
import { STATIC_VISIBILITY_STALE_MS } from '../../queries/query-client.js'
import {
  coverageTone,
  VISIBILITY_ROW_LABEL,
  VISIBILITY_ROW_ORDER,
  type QueryClassLookup,
  type VisibilityRowKey,
} from '../../lib/answer-movement.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { METRIC_TONE_TEXT_CLASS } from '../../lib/tone-helpers.js'
import { Disclosure } from '../shared/Disclosure.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { SegmentedRadioGroup } from '../shared/SegmentedRadioGroup.js'
import { Button } from '../ui/button.js'

export interface ByEngineCounts {
  provider: string
  /** Queries this engine has a latest answer for. */
  answered: number
  mentioned: number
  cited: number
}

/** One query class of the By engine card, from each query's latest answer per engine. */
export interface ByEngineClass {
  key: VisibilityRowKey
  /** Queries with at least one engine answer. */
  queries: number
  /** Queries no engine has answered yet. */
  unanswered: number
  engines: ByEngineCounts[]
  /** Engine answers: one per query and engine. */
  answers: number
  /** Answers citing a tracked competitor's site and not yours. */
  competitorCited: number
  /** Those answers, in the server's order, with the competitors each one cites. */
  competitorGaps: { query: string; provider: string; competitors: string[] }[]
  /** Queries some engine cites you on and some engine names you on. */
  citedAndNamed: number
  /** Queries some engine cites you on while none names you. */
  citedNotNamed: number
  /** Queries some engine names you on while none cites you. */
  namedNotCited: number
  /** Queries no engine cites you on or names you on. */
  neither: number
}

/**
 * The By engine figures per query class. GET /citations/visibility carries no
 * class, so each query is classified by its text with the page's classifier,
 * the one the Visibility card and the query table use. Branded and non-brand
 * never share a count; a project that cannot classify gets one Unclassified
 * class. Classes come back in the card's order and only when they have queries.
 */
export function byEngineClasses(data: CitationVisibilityResponse, classify: QueryClassLookup): ByEngineClass[] {
  const providers = [...new Set(data.byQuery.flatMap(row => row.providers.map(entry => entry.provider)))].sort()
  const classes = new Map<VisibilityRowKey, ByEngineClass>()
  const classOf = (query: string): ByEngineClass => {
    const key = classify(query) ?? 'unclassified'
    let entry = classes.get(key)
    if (!entry) {
      entry = {
        key,
        queries: 0,
        unanswered: 0,
        engines: providers.map(provider => ({ provider, answered: 0, mentioned: 0, cited: 0 })),
        answers: 0,
        competitorCited: 0,
        competitorGaps: [],
        citedAndNamed: 0,
        citedNotNamed: 0,
        namedNotCited: 0,
        neither: 0,
      }
      classes.set(key, entry)
    }
    return entry
  }

  // The (query, engine) pairs the grid counts. A gap outside them, such as one
  // from an engine no longer configured, would count an answer outside the base.
  const answered = new Map<string, string>()
  for (const row of data.byQuery) {
    const entry = classOf(row.query)
    if (row.providers.length === 0) {
      entry.unanswered++
      continue
    }
    entry.queries++
    for (const answer of row.providers) {
      answered.set(`${row.queryId}::${answer.provider}`, row.query)
      const engine = entry.engines.find(counts => counts.provider === answer.provider)!
      engine.answered++
      if (answer.mentioned) engine.mentioned++
      if (answer.cited) engine.cited++
      entry.answers++
    }
    const anyCited = row.providers.some(answer => answer.cited)
    const anyMentioned = row.providers.some(answer => answer.mentioned)
    if (anyCited && anyMentioned) entry.citedAndNamed++
    else if (anyCited) entry.citedNotNamed++
    else if (anyMentioned) entry.namedNotCited++
    else entry.neither++
  }
  // Each gap row is one engine's latest answer to one query.
  for (const gap of data.competitorGaps) {
    const query = answered.get(`${gap.queryId}::${gap.provider}`)
    if (query === undefined) continue
    const entry = classOf(query)
    entry.competitorCited++
    entry.competitorGaps.push({ query, provider: gap.provider, competitors: gap.citingCompetitors })
  }

  return VISIBILITY_ROW_ORDER
    .map(key => classes.get(key))
    .filter((entry): entry is ByEngineClass => entry !== undefined && entry.queries > 0)
}

const SPOKEN_CLASS: Record<VisibilityRowKey, string> = {
  'non-brand': 'non-brand queries',
  branded: 'branded queries',
  unclassified: 'unclassified queries',
}

const BY_ENGINE_TOOLTIP = 'Each engine\'s latest answer to each query, spot checks left out. Mentioned: the answer names you. Cited: its sources link to your site. Competitor cited instead of you: answers that cite a tracked competitor\'s site and not yours.'

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/**
 * "By engine": Mentioned and Cited query counts per engine for ONE query
 * class, one competitor line with its base, and in Details the mention/citation
 * split, the competitors on each gap answer, and the all-queries engine counts
 * and per-model citation rates. A Non-brand/Branded control sits where the
 * card's meta goes; a single class shows its name there instead.
 */
export function CitationVisibilitySection({
  projectName,
  classify,
  hasCompetitors,
  providerScores = [],
}: {
  projectName: string
  classify: QueryClassLookup
  /** Without tracked competitors the competitor line has nothing to count. */
  hasCompetitors: boolean
  /** GET /overview's per-model citation rates: all queries, so never in the class grid. */
  providerScores?: ProjectCommandCenterVm['providerScores']
}) {
  const titleId = useId()
  const [selected, setSelected] = useState<VisibilityRowKey>('non-brand')
  const visibilityQuery = useQuery({
    ...getApiV1ProjectsByNameCitationsVisibilityOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: STATIC_VISIBILITY_STALE_MS,
  })
  const data = visibilityQuery.data ?? null
  const classes = data?.status === 'ready' ? byEngineClasses(data, classify) : []
  const active: ByEngineClass | undefined = classes.find(entry => entry.key === selected) ?? classes.at(0)

  let body: React.ReactNode
  if (visibilityQuery.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-3 text-sm text-secondary">
        <span>Could not load engine results.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => { void visibilityQuery.refetch() }}>Retry</Button>
      </div>
    )
  } else if (!data) {
    body = <p role="status" className="text-sm text-secondary">Loading engine results…</p>
  } else if (data.status === 'no-data') {
    body = (
      <p className="text-sm text-secondary">
        {data.reason === 'no-queries'
          ? 'Add queries to start tracking AI citations.'
          : isDashboardManagedSweeps() ? MANAGED_SWEEPS_COPY : 'Engine results appear after the first AI Visibility sweep.'}
      </p>
    )
  } else if (!active) {
    body = <p className="text-sm text-secondary">No engine answers yet.</p>
  }

  const details: React.ReactNode[] = []
  if (active && data?.status === 'ready') {
    const queries = plural(active.queries, 'query', 'queries')
    details.push(<>Cited and named: <strong>{active.citedAndNamed} of {active.queries}</strong> {queries}</>)
    details.push(<>Cited but not named: <strong>{active.citedNotNamed} of {active.queries}</strong> {queries}</>)
    details.push(<>Named but not cited: <strong>{active.namedNotCited} of {active.queries}</strong> {queries}</>)
    details.push(<>Not cited or named: <strong>{active.neither} of {active.queries}</strong> {queries}</>)
    for (const engine of active.engines) {
      if (engine.answered < active.queries) {
        details.push(<>{providerDisplayName(engine.provider)}: answered <strong>{engine.answered} of {active.queries}</strong> {queries}</>)
      }
    }
    if (active.unanswered > 0) details.push(<>No answers yet: <strong>{active.unanswered}</strong> {plural(active.unanswered, 'query', 'queries')}</>)
    // The server's engine counts span every query, so they say so.
    const { providersCiting, providersMentioning, providersConfigured } = data.summary
    details.push(<>All queries: cited by <strong>{providersCiting} of {providersConfigured}</strong> {plural(providersConfigured, 'engine', 'engines')}, named by <strong>{providersMentioning} of {providersConfigured}</strong></>)
    for (const score of providerScores) {
      details.push(
        <>
          {providerDisplayName(score.provider)}{score.model ? ` (${score.model})` : ''} citation rate:{' '}
          <strong>{formatPercent(score.score, RatioUnits.percent)}</strong>, <strong>{score.cited} of {score.total}</strong> {plural(score.total, 'answer', 'answers')}, all queries
        </>,
      )
    }
    for (const gap of active.competitorGaps) {
      details.push(`"${gap.query}" (${providerDisplayName(gap.provider)}): ${gap.competitors.join(', ')} cited instead of you`)
    }
  }

  // Only non-brand is a competitive read; branded sits near every answer by
  // construction and unclassified pools both, so neither is tone-coloured.
  const toneClass = (count: number, total: number) => active?.key === 'non-brand'
    ? METRIC_TONE_TEXT_CLASS[coverageTone(count, total)]
    : 'text-primary'

  return (
    <section className="overview-brief" aria-labelledby={titleId}>
      <div className="av-card-head">
        {/* A sibling of the heading, so the heading's name stays "By engine". */}
        <div className="inline-flex items-center">
          <h2 id={titleId} className="av-card-title">By engine</h2>
          {active && <InfoTooltip text={BY_ENGINE_TOOLTIP} />}
        </div>
        {classes.length > 1 ? (
          <SegmentedRadioGroup
            label="Query type"
            className="flex-wrap"
            options={classes.map(entry => ({ value: entry.key, label: VISIBILITY_ROW_LABEL[entry.key] }))}
            value={active!.key}
            onChange={setSelected}
          />
        ) : active ? (
          <span className="mention-share-class">{VISIBILITY_ROW_LABEL[active.key]}</span>
        ) : null}
      </div>

      <div className="av-card-body">
        {body ?? (active && (
          <>
            <table className="av-grid av-grid-dense" aria-label={`By engine, ${SPOKEN_CLASS[active.key]}`}>
              <thead>
                <tr>
                  <th scope="col">Of {active.queries} {plural(active.queries, 'query', 'queries')}</th>
                  {active.engines.map(engine => <th key={engine.provider} scope="col">{providerDisplayName(engine.provider)}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className="av-row-label">Mentioned</th>
                  {active.engines.map(engine => (
                    <td key={engine.provider}><span className={`av-n-sm ${toneClass(engine.mentioned, engine.answered)}`}>{engine.mentioned}</span></td>
                  ))}
                </tr>
                <tr>
                  <th scope="row" className="av-row-label">Cited</th>
                  {active.engines.map(engine => (
                    <td key={engine.provider}><span className={`av-n-sm ${toneClass(engine.cited, engine.answered)}`}>{engine.cited}</span></td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="av-card-line">
              <span className="av-card-line-label">Competitor cited instead of you</span>
              {hasCompetitors ? (
                <span>
                  <span className="av-n-sm text-primary">{active.competitorCited}</span>{' '}
                  <span className="av-of">of {active.answers} {plural(active.answers, 'answer', 'answers')}</span>
                  <span className="sr-only"> · {SPOKEN_CLASS[active.key]}</span>
                </span>
              ) : (
                <span className="text-[13px] text-secondary">No competitors tracked</span>
              )}
            </p>
          </>
        ))}
      </div>
      <Disclosure items={details} />
    </section>
  )
}

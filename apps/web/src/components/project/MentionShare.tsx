import React, { useId, useState } from 'react'
import { formatPercent, RatioUnits } from '@ainyc/canonry-contracts'
import type { GapAnalysisDto, GapQuery } from '@ainyc/canonry-contracts'
import type { ProjectCommandCenterVm } from '../../view-models.js'
import type { QueryClassLookup } from '../../lib/answer-movement.js'
import { splitPercentSign } from '../../lib/format-helpers.js'
import { METRIC_TONE_TEXT_CLASS } from '../../lib/tone-helpers.js'
import { Disclosure } from '../shared/Disclosure.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

export type MentionShareBreakdownVm = ProjectCommandCenterVm['mentionShareSummary']['breakdown']

const MENTION_CLASS_OPTIONS = [
  { value: 'non-brand', label: 'Non-brand' },
  { value: 'branded', label: 'Branded' },
] as const

type MentionClassKey = (typeof MENTION_CLASS_OPTIONS)[number]['value']
export type MentionScopeKey = MentionClassKey | 'pooled'

/** The population's name, shown as visible text beside the title when there
 *  is no control. Never demoted to a tooltip: a cropped screenshot of the card
 *  must still carry which class its figures belong to. */
const MENTION_SCOPE_WORD: Record<MentionScopeKey, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  pooled: 'All answers',
}

/** Each figure's class in its own accessible text, so a figure heard alone still names its instrument. */
const MENTION_SCOPE_SPOKEN: Record<MentionScopeKey, string> = {
  'non-brand': 'non-brand queries',
  branded: 'branded queries',
  pooled: 'all queries',
}

/** The answers the share is measured over ("44 non-brand answers"). */
const MENTION_SCOPE_BASE: Record<MentionScopeKey, string> = {
  'non-brand': 'non-brand answers',
  branded: 'branded answers',
  pooled: 'answers',
}

const GAP_DEFINITIONS = 'Named instead of you: queries where an engine named a tracked competitor and none named you. Cited instead of you: queries where an engine cited a tracked competitor\'s site and none cited yours.'

/** One tooltip per scope, selected by what is actually rendered, so the
 *  explanation can never describe a population other than the one on screen. */
const COMPETITIVE_CARD_TOOLTIP: Record<MentionScopeKey, string> = {
  'non-brand': `Queries that do not contain your name. Mention share: your share of tracked-brand mentions in the answers, where each answer counts you and each tracked competitor once. ${GAP_DEFINITIONS} Branded queries are scored separately because you are named on nearly all of them and a competitor cannot be.`,
  branded: `Queries that contain your name. Mention share: your share of tracked-brand mentions in the answers. This is recognition, not competitive placement, and it is never pooled with the non-brand figures. ${GAP_DEFINITIONS}`,
  pooled: `This project has no brand name or domain to match on, so branded and non-brand queries could not be separated. These figures pool both and are not a competitive read. ${GAP_DEFINITIONS}`,
}

/**
 * Headline and state detail for ONE class, derived only from that class's own
 * counters. Nothing here can read the other class, so no figure can be read
 * against the other class's denominator.
 */
export function mentionClassFigures(
  breakdown: MentionShareBreakdownVm,
  opts: { hasCompetitors: boolean; noRun: boolean; unavailable: boolean; otherClassHasData: boolean },
): { headline: string; numeric: boolean; detail: string } {
  // Checked BEFORE `noRun`, because the two produce an identical all-zero
  // payload. `/overview` failing is swallowed by the dashboard fan-out, so
  // without this a project with a year of sweeps would be told, with no error
  // banner to contradict it, that it has never swept.
  if (opts.unavailable) {
    return { headline: 'No data', numeric: false, detail: 'could not load, refresh to retry' }
  }
  if (opts.noRun) {
    return { headline: 'No data', numeric: false, detail: 'no sweep has run yet' }
  }
  if (breakdown.snapshotsTotal === 0) {
    // "none tracked" is only true when NOTHING is tracked. A basket that is
    // entirely branded has real snapshots one click away, and the server says
    // so: `buildMentionShare` returns the value 'No non-brand queries' for
    // exactly this case. Saying "none tracked" there contradicts the control
    // sitting beside it.
    return opts.otherClassHasData
      ? { headline: 'No non-brand queries', numeric: false, detail: 'every tracked query names your brand' }
      : { headline: 'No queries', numeric: false, detail: 'none tracked' }
  }
  if (breakdown.snapshotsWithAnswerText === 0) {
    return { headline: 'No answers', numeric: false, detail: 'no answer text in this run' }
  }
  // A project-only denominator is never rendered as a 100% share.
  if (!opts.hasCompetitors) {
    return {
      headline: 'Add competitors',
      numeric: false,
      detail: `you were named in ${breakdown.projectMentionSnapshots} of ${breakdown.snapshotsWithAnswerText} answers`,
    }
  }
  if (breakdown.combinedMentionSnapshots === 0 || breakdown.score === null) {
    return {
      headline: 'No mentions',
      numeric: false,
      detail: `no brand named in ${breakdown.snapshotsWithAnswerText} answers`,
    }
  }
  return {
    // The API's 0..100 share, shown through the one percent format.
    headline: formatPercent(breakdown.score, RatioUnits.percent),
    numeric: true,
    detail: `${breakdown.projectMentionSnapshots} of ${breakdown.combinedMentionSnapshots} tracked-brand mentions`,
  }
}

export interface ScopeGaps {
  /** Queries answered in the latest sweep, in this scope. */
  total: number
  /** Queries where a competitor was named and you were not, in the server's order. */
  named: string[]
  /** Queries where a competitor was cited and you were not, in the server's order. */
  cited: string[]
}

/**
 * One scope's gap lanes from GET /analytics/gaps (the latest sweep). The
 * endpoint carries no class, so each query is classified by its text with the
 * page's classifier, the same one the Visibility card uses. The denominator is
 * every query the endpoint classified, since every query lands in exactly one
 * citation lane.
 */
export function scopeGaps(gaps: GapAnalysisDto, scope: MentionScopeKey, classify: QueryClassLookup): ScopeGaps {
  const inScope = (row: GapQuery) => scope === 'pooled' || classify(row.query) === scope
  return {
    total: new Set([...gaps.cited, ...gaps.gap, ...gaps.uncited].filter(inScope).map(row => row.queryId)).size,
    named: gaps.mentionGap.filter(inScope).map(row => row.query),
    cited: gaps.gap.filter(inScope).map(row => row.query),
  }
}

/** Details lines naming the gap queries; a query in both lanes is named once. */
export function gapQueryLines(named: readonly string[], cited: readonly string[]): string[] {
  const quote = (queries: readonly string[]) => queries.map(query => `"${query}"`).join(', ')
  const both = named.filter(query => cited.includes(query))
  const namedOnly = named.filter(query => !cited.includes(query))
  const citedOnly = cited.filter(query => !named.includes(query))
  return [
    both.length > 0 ? `Named and cited instead: ${quote(both)}` : null,
    namedOnly.length > 0 ? `Named instead: ${quote(namedOnly)}` : null,
    citedOnly.length > 0 ? `Cited instead: ${quote(citedOnly)}` : null,
  ].filter((line): line is string => line !== null)
}

export type CompetitiveGapsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: GapAnalysisDto }

type GapCountState = ScopeGaps | 'loading' | 'error'

function GapCount({ lane, state, spoken }: { lane: 'named' | 'cited'; state: GapCountState; spoken: string }) {
  if (state === 'loading') return <span role="status" className="text-[13px] text-secondary">Loading…</span>
  if (state === 'error') return <span className="text-[13px] text-secondary">Could not load</span>
  if (state.total === 0) return <span className="text-[13px] text-secondary">No queries</span>
  return (
    <>
      <span className="av-n text-primary">{state[lane].length}</span>{' '}
      <span className="av-of">of {state.total} {state.total === 1 ? 'query' : 'queries'}</span>
      <span className="sr-only"> · {spoken}</span>
    </>
  )
}

/**
 * "Where competitors beat you": mention share and the two gap counts for ONE
 * class, with the brand counts and gap queries in Details. Branded and
 * non-brand are never on screen together, so no figure can be read against the
 * other class's denominator. The class control sits where the card's meta goes,
 * and a class without branded queries shows its name there instead.
 */
export function CompetitiveCard({
  summary,
  competitorDomains,
  gaps,
  classify,
  hasBaseline,
}: {
  summary: ProjectCommandCenterVm['mentionShareSummary']
  competitorDomains: string[]
  /** GET /analytics/gaps for the latest sweep. */
  gaps: CompetitiveGapsState
  classify: QueryClassLookup
  /** A completed sweep exists; before it the card only says what will appear. */
  hasBaseline: boolean
}) {
  const [selected, setSelected] = useState<MentionClassKey>('non-brand')
  const titleId = useId()

  const pooled = summary.scope === 'pooled'
  // `pooled` means no split ever happened, so the branded tally is structurally
  // empty and there is nothing to switch to. The explicit guard also stops a
  // future server change from ever putting a "Non-brand" chip on a pooled figure.
  const hasBranded = !pooled && summary.branded.snapshotsTotal > 0
  const activeKey: MentionClassKey = hasBranded ? selected : 'non-brand'
  const scopeKey: MentionScopeKey = pooled ? 'pooled' : activeKey
  const active = activeKey === 'branded' ? summary.branded : summary.breakdown

  const other = activeKey === 'branded' ? summary.breakdown : summary.branded
  const figures = mentionClassFigures(active, {
    hasCompetitors: competitorDomains.length > 0,
    unavailable: summary.unavailable === true,
    noRun: summary.breakdown.snapshotsTotal === 0 && summary.branded.snapshotsTotal === 0,
    otherClassHasData: other.snapshotsTotal > 0,
  })
  // The figure and its sign, so the sign can be set apart as the other cards do.
  const headline = splitPercentSign(figures.headline)
  // Tone bands are calibrated for competitive placement. Branded sits near 100
  // by construction and pooled is not a competitive read at all, so neither is
  // ever tone-coloured: a structural high number must not render as a green win.
  const toneClass = scopeKey === 'non-brand' ? METRIC_TONE_TEXT_CLASS[summary.tone] : 'text-primary'
  const scoped = gaps.status === 'ready' ? scopeGaps(gaps.data, scopeKey, classify) : null

  const details: React.ReactNode[] = []
  if (figures.numeric) {
    const competitors = active.ranking.filter(row => row.kind === 'competitor')
    details.push(
      <>
        Mention share: you <strong>{active.projectMentionSnapshots}</strong>
        {competitors.map(row => <React.Fragment key={row.domain ?? ''}>, {row.domain} <strong>{row.mentionSnapshots}</strong></React.Fragment>)}
        {' '}tracked-brand mentions
      </>,
    )
  } else {
    details.push(`Mention share: ${figures.detail}`)
  }
  if (!summary.unavailable && active.snapshotsWithAnswerText > 0) {
    details.push(<>Base: <strong>{active.snapshotsWithAnswerText}</strong> {MENTION_SCOPE_BASE[scopeKey]}</>)
  }
  if (scoped) details.push(...gapQueryLines(scoped.named, scoped.cited))
  if (pooled) details.push('Set a brand name to split branded from non-brand.')

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = MENTION_CLASS_OPTIONS.findIndex(o => o.value === activeKey)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MENTION_CLASS_OPTIONS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + MENTION_CLASS_OPTIONS.length) % MENTION_CLASS_OPTIONS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = MENTION_CLASS_OPTIONS.length - 1
    if (next === null) return
    event.preventDefault()
    setSelected(MENTION_CLASS_OPTIONS[next]!.value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  const spoken = MENTION_SCOPE_SPOKEN[scopeKey]
  const gapState: GapCountState = scoped ?? (gaps.status === 'error' ? 'error' : 'loading')

  return (
    <section className="overview-brief" aria-labelledby={titleId}>
      <div className="av-card-head">
        {/* The tooltip is a SIBLING of the heading: a heading takes its
            accessible name from its content, and InfoTooltip puts its whole
            text on the trigger's aria-label. */}
        <div className="inline-flex items-center">
          <h2 id={titleId} className="av-card-title">Where competitors beat you</h2>
          {hasBaseline && <InfoTooltip text={COMPETITIVE_CARD_TOOLTIP[scopeKey]} />}
        </div>
        {!hasBaseline ? null : hasBranded ? (
          <div
            role="radiogroup"
            aria-label="Query type"
            className="segmented flex-wrap"
            onKeyDown={handleKeyDown}
          >
            {MENTION_CLASS_OPTIONS.map(option => {
              const checked = option.value === activeKey
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setSelected(option.value)}
                  className={`segmented-option min-h-11 ${checked ? 'segmented-option-active' : ''}`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        ) : (
          <span className="mention-share-class">{MENTION_SCOPE_WORD[scopeKey]}</span>
        )}
      </div>

      <div className="av-card-body">
        {!hasBaseline ? (
          <p className="text-sm text-secondary">
            Competitive mention and citation gaps appear after the first AI Visibility sweep.
          </p>
        ) : (
          <table className="av-grid" aria-label={`Where competitors beat you, ${spoken}`}>
            <tbody>
              <tr>
                <th scope="row" className="av-row-label">Mention share</th>
                <td>
                  {figures.numeric ? (
                    <span className={`av-n ${toneClass}`}>
                      {headline.figure}
                      {headline.sign ? <span className="text-faint">{headline.sign}</span> : null}
                      <span className="sr-only"> · {spoken}</span>
                    </span>
                  ) : (
                    <span className="mention-share-value-text">{figures.headline}</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row" className="av-row-label">Named instead of you</th>
                <td><GapCount lane="named" state={gapState} spoken={spoken} /></td>
              </tr>
              <tr>
                <th scope="row" className="av-row-label">Cited instead of you</th>
                <td><GapCount lane="cited" state={gapState} spoken={spoken} /></td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {hasBaseline && <Disclosure items={details} />}
    </section>
  )
}

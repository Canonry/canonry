import React, { useId, useState } from 'react'
import { formatPercent } from '@ainyc/canonry-contracts'
import type { ProjectCommandCenterVm } from '../../view-models.js'
import { METRIC_TONE_TEXT_CLASS } from '../../lib/tone-helpers.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

export type MentionShareBreakdownVm = ProjectCommandCenterVm['mentionShareSummary']['breakdown']

const MENTION_CLASS_OPTIONS = [
  { value: 'non-brand', label: 'Non-brand' },
  { value: 'branded', label: 'Branded' },
] as const

type MentionClassKey = (typeof MENTION_CLASS_OPTIONS)[number]['value']
type MentionScopeKey = MentionClassKey | 'pooled'

/** The denominator's name, rendered as visible text in the caption. Never
 *  demoted to a tooltip: a cropped screenshot of the figure must still carry
 *  which class it belongs to. */
const MENTION_SCOPE_WORD: Record<MentionScopeKey, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  pooled: 'All queries',
}

/** One tooltip per scope, selected by what is actually rendered, so the
 *  explanation can never describe a denominator other than the one on screen. */
const MENTION_SCOPE_TOOLTIP: Record<MentionScopeKey, string> = {
  'non-brand': 'On queries that do not contain your name: of the brand names written into the answer text, the share that were yours. Branded queries are scored separately because you are named on nearly all of them and a competitor cannot be.',
  branded: 'On queries that contain your name: of the brand names written into the answer text, the share that were yours. This is recognition, not competitive placement, and it is never pooled with the non-brand figure.',
  pooled: 'This project has no brand name or domain to match on, so branded and non-brand queries could not be separated. This figure pools both and is not a competitive read. Set a display name or aliases to split them.',
}

const MENTION_COUNT_TOOLTIP = 'Mentioned = brand in the answer. Cited = domain in the sources. Neither implies the other.'

/**
 * Headline and caption detail for ONE class, derived only from that class's own
 * counters. Nothing here can read the other class, so no figure can be captioned
 * with the other class's denominator.
 */
export function mentionClassFigures(
  breakdown: MentionShareBreakdownVm,
  opts: { hasCompetitors: boolean; noRun: boolean; unavailable: boolean; otherClassHasData: boolean },
): { headline: string; numeric: boolean; detail: string; showRows: boolean } {
  // Checked BEFORE `noRun`, because the two produce an identical all-zero
  // payload. `/overview` failing is swallowed by the dashboard fan-out, so
  // without this a project with a year of sweeps would be told, with no error
  // banner to contradict it, that it has never swept.
  if (opts.unavailable) {
    return { headline: 'No data', numeric: false, detail: 'could not load, refresh to retry', showRows: false }
  }
  if (opts.noRun) {
    return { headline: 'No data', numeric: false, detail: 'no sweep has run yet', showRows: false }
  }
  if (breakdown.snapshotsTotal === 0) {
    // "none tracked" is only true when NOTHING is tracked. A basket that is
    // entirely branded has real snapshots one click away, and the server says
    // so — `buildMentionShare` returns the value 'No non-brand queries' for
    // exactly this case. Saying "none tracked" there contradicts the control
    // sitting beside it.
    return opts.otherClassHasData
      ? { headline: 'No non-brand queries', numeric: false, detail: 'every tracked query names your brand', showRows: false }
      : { headline: 'No queries', numeric: false, detail: 'none tracked', showRows: false }
  }
  if (breakdown.snapshotsWithAnswerText === 0) {
    return { headline: 'No answers', numeric: false, detail: 'no answer text in this run', showRows: false }
  }
  // A project-only denominator is never rendered as a 100% share chart.
  if (!opts.hasCompetitors) {
    return {
      headline: 'Add competitors',
      numeric: false,
      detail: `you were named in ${breakdown.projectMentionSnapshots} of ${breakdown.snapshotsWithAnswerText} answers`,
      showRows: false,
    }
  }
  const named = breakdown.projectMentionSnapshots + breakdown.competitorMentionSnapshots
  if (named === 0 || breakdown.score === null) {
    return {
      headline: 'No mentions',
      numeric: false,
      detail: `no brand named in ${breakdown.snapshotsWithAnswerText} answers`,
      showRows: false,
    }
  }
  return {
    headline: `${breakdown.score}`,
    numeric: true,
    detail: `${breakdown.projectMentionSnapshots} of ${named} brand mentions`,
    showRows: true,
  }
}

/**
 * One class's ranked list. Every tracked competitor gets a row, including the
 * ones at zero, so "no competitor was named in this class" is visible instead of
 * being an absent row. Bar width is the share itself, so the bar and the printed
 * number can never disagree.
 */
function MentionShareRows({
  breakdown,
  projectLabel,
  competitorDomains,
}: {
  breakdown: MentionShareBreakdownVm
  projectLabel: string
  competitorDomains: string[]
}) {
  const total = breakdown.projectMentionSnapshots + breakdown.competitorMentionSnapshots
  if (total === 0) return null

  const byDomain = new Map(breakdown.perCompetitor.map(c => [c.domain, c.mentionSnapshots]))
  const rows = [
    { label: `${projectLabel} (you)`, mentions: breakdown.projectMentionSnapshots, isYou: true },
    ...competitorDomains.map(domain => ({
      label: domain,
      mentions: byDomain.get(domain) ?? 0,
      isYou: false,
    })),
  ].sort((a, b) => b.mentions - a.mentions || (a.label < b.label ? -1 : 1))

  // A real table, not a header div over an unlabelled list. The columns carry
  // meaning that only the visual arrangement was expressing, so a screen reader
  // was reading "9" and "30.0%" with nothing to attach them to. `scope` on each
  // header is what associates them; the bar is decorative and aria-hidden,
  // since its width is the share the next cell already states.
  return (
    <table className="mention-share-table">
      <caption className="sr-only">Brand mentions by domain, most mentioned first</caption>
      <thead>
        <tr className="mention-share-row mention-share-row-head">
          <th scope="col" className="mention-share-row-label">Domain</th>
          <th aria-hidden="true" />
          <th scope="col" className="mention-share-count">
            Mentions
            <InfoTooltip text={MENTION_COUNT_TOOLTIP} />
          </th>
          <th scope="col" className="mention-share-share">Share</th>
        </tr>
      </thead>
      <tbody className="mention-share-rows">
        {rows.map(row => {
          const share = row.mentions / total
          return (
            <tr key={row.label} className="mention-share-row">
              <th scope="row" className={`mention-share-row-label ${row.isYou ? 'text-heading font-medium' : 'text-secondary'}`}>
                {row.label}
              </th>
              <td aria-hidden="true">
                <div className="mention-share-bar">
                  <div
                    className={`mention-share-bar-fill ${row.isYou ? 'bg-positive-500/70' : 'bg-mono-500/60'}`}
                    style={{ width: `${share > 0 ? Math.max(share * 100, 1.5) : 0}%` }}
                  />
                </div>
              </td>
              <td className="mention-share-count">{row.mentions}</td>
              <td className="mention-share-share">{formatPercent(share)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * Mention share as a single object: one chrome line that names the metric and
 * owns the class, one figure, one list. Branded and non-brand are never on
 * screen together, so they can never be read against one denominator. The class
 * name is duplicated into the caption on purpose: a crop that contains the
 * number contains the name of its denominator.
 */
export function MentionShare({
  summary,
  projectLabel,
  competitorDomains,
}: {
  summary: ProjectCommandCenterVm['mentionShareSummary']
  projectLabel: string
  competitorDomains: string[]
}) {
  const [selected, setSelected] = useState<MentionClassKey>('non-brand')
  const labelId = useId()

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
  // Tone bands are calibrated for competitive placement. Branded sits near 100
  // by construction and pooled is not a competitive read at all, so neither is
  // ever tone-coloured: a structural high number must not render as a green win.
  const toneClass = scopeKey === 'non-brand' ? METRIC_TONE_TEXT_CLASS[summary.tone] : 'text-secondary'

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

  return (
    <div className="mention-share">
      <div className="mention-share-head">
        {/* The tooltip is a SIBLING of the heading, matching SiteHealthSection.
            A heading takes its accessible name from its content, and InfoTooltip
            puts its whole text on the trigger's aria-label, so nesting it made
            the h3 announce the entire methodology paragraph as the heading. */}
        <div className="mention-share-label">
          <h3 id={labelId} className="mention-share-label-text">Mention share</h3>
          <InfoTooltip text={MENTION_SCOPE_TOOLTIP[scopeKey]} />
        </div>
        {hasBranded ? (
          <div
            role="radiogroup"
            aria-labelledby={labelId}
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

      {figures.numeric ? (
        <p className={`mention-share-value ${toneClass}`}>
          {figures.headline}
          <span className="text-faint">%</span>
        </p>
      ) : (
        <p className="mention-share-value-text">{figures.headline}</p>
      )}

      <p className="mention-share-caption">
        <span className="mention-share-caption-scope">{MENTION_SCOPE_WORD[scopeKey]}</span>
        {` · ${figures.detail}`}
      </p>

      {pooled && (
        <p className="mention-share-note">Set a brand name to split branded from non-brand.</p>
      )}

      {figures.showRows && (
        <MentionShareRows
          breakdown={active}
          projectLabel={projectLabel}
          competitorDomains={competitorDomains}
        />
      )}
    </div>
  )
}

import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CitationStates, brandLabelFromDomain } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import { highlightTermsInText, type HighlightTermGroup } from '../../lib/highlight.js'
import type { CitationInsightVm, CitationState, RunHistoryPoint } from '../../view-models.js'

type CoverageMode = 'citations' | 'mentions'
type Density = 'compact' | 'detailed'

const ANSWER_PREVIEW_MAX = 320

/** Map a snapshot to the state value driving the column for the active mode.
 *  In citations mode we read `citationState` directly. In mentions mode we
 *  collapse to `cited`/`not-cited`/`pending` based on `answerMentioned` (with
 *  `visibilityState` as a fallback) so the visualization can reuse the same
 *  dot palette and badge component. */
function deriveStateForMode(
  input: { citationState: string; answerMentioned?: boolean; visibilityState?: string },
  mode: CoverageMode,
): CitationState {
  if (mode === 'citations') return input.citationState as CitationState
  if (input.visibilityState === 'pending') return 'pending'
  if (input.answerMentioned == null && input.visibilityState == null) return 'pending'
  const mentioned = input.visibilityState === 'visible' || input.answerMentioned === true
  return mentioned ? 'cited' : 'not-cited'
}

function statusLabelForMode(state: CitationState, mode: CoverageMode): string {
  if (mode === 'mentions') {
    switch (state) {
      case 'cited': return 'Mentioned'
      case 'not-cited': return 'Not Mentioned'
      case 'pending': return 'Pending'
      // 'emerging' / 'lost' are collapsed by deriveStateForMode in mentions mode,
      // but fall through here defensively if a caller passes them anyway.
      case 'emerging': return 'Newly Mentioned'
      case 'lost': return 'No Longer Mentioned'
    }
  }
  switch (state) {
    case 'cited': return 'Cited'
    case 'not-cited': return 'Not Cited'
    case 'lost': return 'Lost'
    case 'emerging': return 'Emerging'
    case 'pending': return 'Pending'
  }
}

function describeChange(history: RunHistoryPoint[], mode: CoverageMode): string {
  const verb = mode === 'mentions' ? 'mentioned' : 'cited'
  const verbCap = mode === 'mentions' ? 'Mentioned' : 'Cited'
  if (history.length === 0) return 'Awaiting first run'
  if (history.length === 1) return 'First observation'
  const latest = history[history.length - 1]!.citationState
  const prev = history[history.length - 2]!.citationState
  if (prev !== 'cited' && latest === 'cited') return `Newly ${verb}`
  if (prev === 'cited' && latest !== 'cited') return 'Lost since last run'
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.citationState === latest) streak++
    else break
  }
  if (latest === 'cited') return streak <= 1 ? `${verbCap} in latest run` : `${verbCap} for ${streak} runs`
  return streak <= 1 ? `Not ${verb} in latest run` : `Not ${verb} across ${streak} runs`
}

function projectItemsForMode(items: CitationInsightVm[], mode: CoverageMode): CitationInsightVm[] {
  if (mode === 'citations') return items
  return items.map(item => ({
    ...item,
    citationState: deriveStateForMode(item, mode),
    runHistory: item.runHistory.map(h => ({ ...h, citationState: deriveStateForMode(h, mode) })),
  }))
}

export function EvidenceTable({
  evidence,
  compareLocations = false,
  defaultDensity = 'detailed',
}: {
  evidence: CitationInsightVm[]
  compareLocations?: boolean
  defaultDensity?: Density
}) {
  const { openEvidence } = useDrawer()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<CoverageMode>('mentions')
  const [density, setDensity] = useState<Density>(defaultDensity)

  const groups = useMemo(() => {
    const projected = projectItemsForMode(evidence, mode)
    type Group = { key: string; phrase: string; location: string | null; items: CitationInsightVm[] }
    const map = new Map<string, Group>()
    for (const item of projected) {
      const phrase = item.query
      const location = compareLocations ? (item.location ?? null) : null
      const key = compareLocations ? JSON.stringify([phrase, location]) : phrase
      const existing = map.get(key) ?? { key, phrase, location, items: [] }
      existing.items.push(item)
      map.set(key, existing)
    }
    return [...map.values()]
  }, [evidence, mode, compareLocations])

  const toggleRow = (key: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const presenceVerb = mode === 'mentions' ? 'mentioned' : 'cited'
  const historyHeader = mode === 'mentions' ? 'Mention History' : 'Citation History'
  const countNoun = mode === 'mentions' ? 'mentioned' : 'cited'

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">View by</span>
        <div
          className="inline-flex gap-0.5 p-0.5 rounded-md bg-zinc-900/60 border border-zinc-800/40"
          role="tablist"
          aria-label="Citation tracking view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'mentions'}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
              mode === 'mentions'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => setMode('mentions')}
          >
            Mentions
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'citations'}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
              mode === 'citations'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => setMode('citations')}
          >
            Citations
          </button>
        </div>
        <span className="text-[11px] text-zinc-500">
          {mode === 'mentions'
            ? 'Brand or domain in answer text'
            : 'Brand or domain in source links'}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => {
              setExpandedRows(prev =>
                prev.size === groups.length
                  ? new Set()
                  : new Set(groups.map(g => g.key)),
              )
            }}
          >
            {expandedRows.size === groups.length && groups.length > 0 ? 'Collapse all' : 'Expand all'}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Density</span>
            <div
              className="inline-flex gap-0.5 p-0.5 rounded-md bg-zinc-900/60 border border-zinc-800/40"
              role="tablist"
              aria-label="Evidence row density"
            >
              <button
                type="button"
                role="tab"
                aria-selected={density === 'compact'}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  density === 'compact'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                onClick={() => setDensity('compact')}
              >
                Compact
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={density === 'detailed'}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                  density === 'detailed'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
                onClick={() => setDensity('detailed')}
              >
                Detailed
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th style={{ width: '2rem' }} />
              <th scope="col">Query</th>
              <th scope="col">Status</th>
              <th scope="col">{historyHeader}</th>
              <th scope="col">Change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map(({ key: groupKey, phrase, location, items }) => {
              const isExpanded = expandedRows.has(groupKey)
              const states = items.map(i => i.citationState)
              const aggState: CitationState =
                states.includes('cited') ? 'cited' :
                states.includes('emerging') ? 'emerging' :
                states.includes('lost') ? 'lost' :
                states.every(s => s === 'pending') ? 'pending' : 'not-cited'

              const mergedHistory = mergeProviderHistories(items)
              const presentCount = items.filter(i => i.citationState === CitationStates.cited || i.citationState === 'emerging').length
              const aggChangeLabel = describeChange(mergedHistory, mode)

              return (
                <Fragment key={groupKey}>
                  <tr
                    className="evidence-phrase-row cursor-pointer hover:bg-zinc-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                    onClick={() => toggleRow(groupKey)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleRow(groupKey)
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={isExpanded}
                  >
                    <td>
                      <ChevronRight
                        size={14}
                        className={`transition-transform duration-150 text-zinc-500 ${isExpanded ? 'rotate-90' : ''}`}
                      />
                    </td>
                    <td className="evidence-query-cell">
                      <div>
                        <span className="font-medium text-zinc-100">{phrase}</span>
                        {compareLocations && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-zinc-500">
                            {location ?? 'No location'}
                          </span>
                        )}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {items.map(item => (
                            <ProviderBadge key={item.id} provider={item.provider} />
                          ))}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <CitationBadge state={aggState} label={statusLabelForMode(aggState, mode)} />
                        <span
                          className="text-[11px] text-zinc-500"
                          title={`${presentCount} of ${items.length} engines ${countNoun}`}
                        >
                          {presentCount}/{items.length}
                        </span>
                      </div>
                    </td>
                    <td>
                      <CitationTimeline history={mergedHistory} />
                    </td>
                    <td className="evidence-change-cell">
                      {aggChangeLabel}
                    </td>
                    <td />
                  </tr>
                  {isExpanded && items.map(item => (
                    <Fragment key={item.id}>
                      <tr className="bg-zinc-900/30">
                        <td />
                        <td className="evidence-query-cell pl-5">
                          <ProviderBadge provider={item.provider} />
                        </td>
                        <td>
                          <CitationBadge
                            state={item.citationState}
                            label={statusLabelForMode(item.citationState, mode)}
                          />
                        </td>
                        <td>
                          <CitationTimeline history={item.runHistory} />
                        </td>
                        <td className="evidence-change-cell">
                          {describeChange(item.runHistory, mode)}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void openEvidence(item.id) }}
                          >
                            View
                          </Button>
                        </td>
                      </tr>
                      {density === 'detailed' && (
                        <tr className="bg-zinc-900/20">
                          <td />
                          <td colSpan={5} className="px-5 pb-4">
                            <AnswerInlinePanel
                              item={item}
                              onViewFull={() => openEvidence(item.id)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="sr-only" aria-live="polite">
        Showing {presenceVerb === 'cited' ? 'citations (sources)' : 'mentions (answer text)'}.
      </p>
    </div>
  )
}

function buildHighlightGroups(item: CitationInsightVm): HighlightTermGroup[] {
  const brandTerms = (item.matchedTerms ?? []).filter(t => t.trim().length > 2)
  const competitorTerms = [
    ...item.competitorDomains.flatMap(d => {
      const brand = brandLabelFromDomain(d)
      return brand.length >= 4 ? [brand] : []
    }),
    ...(item.recommendedCompetitors ?? []),
  ].filter(t => t.trim().length > 2)
  const groups: HighlightTermGroup[] = []
  if (brandTerms.length > 0) groups.push({ terms: brandTerms, className: 'answer-highlight-brand' })
  if (competitorTerms.length > 0) groups.push({ terms: competitorTerms, className: 'answer-highlight-competitor' })
  return groups
}

function truncate(text: string, max: number): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false }
  const cut = text.lastIndexOf(' ', max)
  const body = text.slice(0, cut > max - 40 ? cut : max).trimEnd()
  return { body: `${body}…`, truncated: true }
}

function AnswerInlinePanel({
  item,
  onViewFull,
}: {
  item: CitationInsightVm
  onViewFull: () => void
}) {
  const hasAnswer = item.answerSnippet.trim().length > 0
  if (!hasAnswer) {
    return (
      <p className="text-[11px] text-zinc-500 italic">
        No answer text captured for this run.
      </p>
    )
  }

  const { body, truncated } = truncate(item.answerSnippet, ANSWER_PREVIEW_MAX)
  const groups = buildHighlightGroups(item)

  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">Answer text</p>
      <p className="text-sm leading-relaxed text-zinc-300">
        {highlightTermsInText(body, groups)}
      </p>
      {(item.citedDomains.length > 0 || item.competitorDomains.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {item.citedDomains.length > 0 && (
            <>
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">Cited:</span>
              {item.citedDomains.slice(0, 6).map(d => (
                <span
                  key={`c-${d}`}
                  className="rounded-full border border-zinc-700/60 bg-zinc-900/60 px-2 py-0.5 text-[11px] text-zinc-300"
                >
                  {d}
                </span>
              ))}
              {item.citedDomains.length > 6 && (
                <span className="text-[10px] text-zinc-500">+{item.citedDomains.length - 6} more</span>
              )}
            </>
          )}
          {item.competitorDomains.length > 0 && (
            <>
              <span className="ml-2 text-[10px] uppercase tracking-wide text-rose-500/80">Competitors:</span>
              {item.competitorDomains.slice(0, 4).map(d => (
                <span
                  key={`co-${d}`}
                  className="rounded-full border border-rose-900/40 bg-rose-950/30 px-2 py-0.5 text-[11px] text-rose-300"
                >
                  {d}
                </span>
              ))}
              {item.competitorDomains.length > 4 && (
                <span className="text-[10px] text-zinc-500">+{item.competitorDomains.length - 4} more</span>
              )}
            </>
          )}
        </div>
      )}
      {truncated && (
        <button
          type="button"
          className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
          onClick={(e) => { e.stopPropagation(); onViewFull() }}
        >
          View full answer →
        </button>
      )}
    </div>
  )
}

import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CitationStates } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import type { CitationInsightVm, CitationState, RunHistoryPoint } from '../../view-models.js'

type CoverageMode = 'citations' | 'mentions'

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
}: {
  evidence: CitationInsightVm[]
}) {
  const { openEvidence } = useDrawer()
  const [expandedPhrases, setExpandedPhrases] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<CoverageMode>('citations')

  const groups = useMemo(() => {
    const projected = projectItemsForMode(evidence, mode)
    const map = new Map<string, CitationInsightVm[]>()
    for (const item of projected) {
      const existing = map.get(item.query) ?? []
      map.set(item.query, [...existing, item])
    }
    return [...map.entries()].map(([phrase, items]) => ({ phrase, items }))
  }, [evidence, mode])

  const togglePhrase = (phrase: string) => {
    setExpandedPhrases(prev => {
      const next = new Set(prev)
      if (next.has(phrase)) next.delete(phrase)
      else next.add(phrase)
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
        </div>
        <span className="text-[11px] text-zinc-500">
          {mode === 'mentions'
            ? 'Brand or domain in answer text'
            : 'Brand or domain in source links'}
        </span>
      </div>
      <div className="evidence-table-wrap">
        <table className="evidence-table">
          <thead>
            <tr>
              <th style={{ width: '2rem' }} />
              <th>Query</th>
              <th>Status</th>
              <th>{historyHeader}</th>
              <th>Change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map(({ phrase, items }) => {
              const isExpanded = expandedPhrases.has(phrase)
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
                <Fragment key={phrase}>
                  <tr
                    className="evidence-phrase-row cursor-pointer hover:bg-zinc-800/40"
                    onClick={() => togglePhrase(phrase)}
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
                    <tr key={item.id} className="bg-zinc-900/30">
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
                          onClick={(e) => { e.stopPropagation(); openEvidence(item.id) }}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
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

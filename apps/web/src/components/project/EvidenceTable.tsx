import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { Button } from '../ui/button.js'
import { CitationBadge } from '../shared/CitationBadge.js'
import { ProviderBadge } from '../shared/ProviderBadge.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import { useDrawer } from '../../hooks/use-drawer.js'
import type { CitationInsightVm, CitationState } from '../../view-models.js'

export function EvidenceTable({
  evidence,
}: {
  evidence: CitationInsightVm[]
}) {
  const { openEvidence } = useDrawer()
  const [expandedPhrases, setExpandedPhrases] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const map = new Map<string, CitationInsightVm[]>()
    for (const item of evidence) {
      const existing = map.get(item.keyword) ?? []
      map.set(item.keyword, [...existing, item])
    }
    return [...map.entries()].map(([phrase, items]) => ({ phrase, items }))
  }, [evidence])

  const togglePhrase = (phrase: string) => {
    setExpandedPhrases(prev => {
      const next = new Set(prev)
      if (next.has(phrase)) next.delete(phrase)
      else next.add(phrase)
      return next
    })
  }

  return (
    <div className="evidence-table-wrap">
      <table className="evidence-table">
        <thead>
          <tr>
            <th style={{ width: '2rem' }} />
            <th>Key Phrase</th>
            <th>Status</th>
            <th>Citation History</th>
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
            const citedCount = items.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length

            // Compute phrase-level change label from merged history
            const aggChangeLabel = (() => {
              if (mergedHistory.length === 0) return 'Awaiting first run'
              if (mergedHistory.length === 1) return 'First observation'
              const latest = mergedHistory[mergedHistory.length - 1]!.citationState
              const prev = mergedHistory[mergedHistory.length - 2]!.citationState
              if (prev !== 'cited' && latest === 'cited') return 'Newly cited'
              if (prev === 'cited' && latest !== 'cited') return 'Lost since last run'
              // Count streak
              let streak = 0
              for (let i = mergedHistory.length - 1; i >= 0; i--) {
                if (mergedHistory[i]!.citationState === latest) streak++
                else break
              }
              if (latest === 'cited') return streak <= 1 ? 'Cited in latest run' : `Cited for ${streak} runs`
              return streak <= 1 ? 'Not cited in latest run' : `Not cited across ${streak} runs`
            })()

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
                  <td className="evidence-keyword-cell">
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
                      <CitationBadge state={aggState} />
                      <span className="text-[11px] text-zinc-500">{citedCount}/{items.length}</span>
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
                    <td className="evidence-keyword-cell pl-5">
                      <ProviderBadge provider={item.provider} />
                    </td>
                    <td><CitationBadge state={item.citationState} /></td>
                    <td>
                      <CitationTimeline history={item.runHistory} />
                    </td>
                    <td className="evidence-change-cell">{item.changeLabel}</td>
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
  )
}

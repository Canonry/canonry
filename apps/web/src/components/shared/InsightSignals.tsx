import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ProjectCommandCenterVm } from '../../view-models.js'
import { ToneBadge } from './ToneBadge.js'
import { CitationBadge } from './CitationBadge.js'
import { ProviderBadge } from './ProviderBadge.js'

export function InsightSignals({
  insights,
  onOpenEvidence,
}: {
  insights: ProjectCommandCenterVm['insights']
  onOpenEvidence: (evidenceId: string) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="insight-list">
      {insights.map((insight) => {
        const isExpanded = expandedId === insight.id
        const hasAffected = insight.affectedPhrases.length > 0

        return (
          <div key={insight.id}>
            <div
              className={`insight-row insight-row-${insight.tone} ${hasAffected ? 'cursor-pointer' : ''}`}
              onClick={hasAffected ? () => setExpandedId(isExpanded ? null : insight.id) : undefined}
            >
              <div className="flex items-center gap-2 min-w-0">
                {hasAffected && (
                  <ChevronRight
                    size={12}
                    className={`shrink-0 text-zinc-500 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                  />
                )}
                <ToneBadge tone={insight.tone}>{insight.actionLabel}</ToneBadge>
                <span className="text-sm font-medium text-zinc-100 truncate">{insight.title}</span>
                <span className="hidden sm:inline text-xs text-zinc-500 truncate">{insight.detail}</span>
              </div>
              {hasAffected && (
                <span className="text-[11px] text-zinc-600 whitespace-nowrap">
                  {insight.affectedPhrases.length} phrase{insight.affectedPhrases.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
            {isExpanded && (
              <div className="divide-y divide-zinc-800/20">
                {insight.affectedPhrases.map((ap) => (
                  <div
                    key={ap.evidenceId}
                    className="flex items-center justify-between gap-3 px-4 py-2 pl-9 bg-zinc-900/40"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <CitationBadge state={ap.citationState} />
                      <span className="text-sm text-zinc-200 truncate">{ap.keyword}</span>
                      <div className="hidden sm:flex gap-1">
                        {ap.provider && <ProviderBadge provider={ap.provider} />}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-zinc-400 hover:text-zinc-200 whitespace-nowrap transition-colors"
                      onClick={(e) => { e.stopPropagation(); onOpenEvidence(ap.evidenceId) }}
                    >
                      View &rarr;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

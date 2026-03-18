import { useMemo } from 'react'

import { CitationBadge } from '../shared/CitationBadge.js'
import { CitationTimeline, mergeProviderHistories } from './CitationTimeline.js'
import type { CitationInsightVm, CitationState } from '../../view-models.js'

function EvidencePhraseCard({
  phrase,
  items,
  onOpenEvidence,
  showLocationLabels = true,
  compareLocations = false,
  timelineLoading = false,
  onDeleteKeyword,
}: {
  phrase: string
  items: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
  showLocationLabels?: boolean
  compareLocations?: boolean
  timelineLoading?: boolean
  onDeleteKeyword?: () => void
}) {
  const states = items.map(i => i.citationState)
  const aggState: CitationState =
    states.includes('cited') ? 'cited' :
    states.includes('emerging') ? 'emerging' :
    states.includes('lost') ? 'lost' :
    states.every(s => s === 'pending') ? 'pending' : 'not-cited'

  const mergedHistory = mergeProviderHistories(items)
  const citedCount = items.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length

  const trendDir: 'up' | 'down' | 'flat' = (() => {
    if (mergedHistory.length < 4) return 'flat'
    const recent = mergedHistory.slice(-3)
    const older = mergedHistory.slice(-6, -3)
    if (older.length === 0) return 'flat'
    const recentCited = recent.filter(p => p.citationState === 'cited' || p.citationState === 'emerging').length
    const olderCited = older.filter(p => p.citationState === 'cited' || p.citationState === 'emerging').length
    if (recentCited > olderCited) return 'up'
    if (recentCited < olderCited) return 'down'
    return 'flat'
  })()

  const changeLabel = (() => {
    if (mergedHistory.length === 0) return 'Awaiting first run'
    if (mergedHistory.length === 1) return 'First observation'
    const latest = mergedHistory[mergedHistory.length - 1]!.citationState
    const prev = mergedHistory[mergedHistory.length - 2]!.citationState
    const latestCited = latest === 'cited' || latest === 'emerging'
    const prevCited = prev === 'cited' || prev === 'emerging'
    if (!prevCited && latestCited) return 'Newly cited'
    if (prevCited && !latestCited) return 'Lost citation'
    let streak = 0
    for (let i = mergedHistory.length - 1; i >= 0; i--) {
      const s = mergedHistory[i]!.citationState
      const isCited = s === 'cited' || s === 'emerging'
      if (isCited === latestCited) streak++
      else break
    }
    if (latestCited) return streak <= 1 ? 'Cited in latest run' : `Cited ${streak} runs in a row`
    return streak <= 1 ? 'Missed in latest run' : `Missed for ${streak} runs`
  })()

  const trendIcon = trendDir === 'up' ? '\u2191' : trendDir === 'down' ? '\u2193' : '\u2192'

  return (
    <div className={`evidence-phrase-card evidence-phrase-card--${aggState}`}>
      <div className="evidence-card-header">
        <div className="min-w-0 flex-1">
          <p className="evidence-card-keyword">{phrase}</p>
          <div className="evidence-card-status-row">
            <CitationBadge state={aggState} />
            <span className={`evidence-card-trend evidence-card-trend--${trendDir}`}>
              <span aria-hidden="true">{trendIcon}</span>
              <span>{changeLabel}</span>
            </span>
          </div>
        </div>
        {onDeleteKeyword && (
          <button
            type="button"
            className="ml-2 shrink-0 text-zinc-600 hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500"
            onClick={onDeleteKeyword}
            title={`Remove "${phrase}"`}
            aria-label={`Remove key phrase "${phrase}"`}
          >
            ×
          </button>
        )}
      </div>

      <div className={`evidence-card-timeline-row${timelineLoading ? ' opacity-40 pointer-events-none' : ''}`}>
        {timelineLoading
          ? <span className="text-[10px] text-zinc-500 italic animate-pulse">Loading…</span>
          : <CitationTimeline history={mergedHistory} maxDots={14} />
        }
        <span className="evidence-card-ratio">
          {citedCount}/{items.length} provider{items.length !== 1 ? 's' : ''}
        </span>
      </div>

      {compareLocations ? (() => {
        // Group items by location for side-by-side comparison
        const locationGroups = Array.from(
          items.reduce((map, item) => {
            const key = item.location ?? ''
            const existing = map.get(key) ?? []
            map.set(key, [...existing, item])
            return map
          }, new Map<string, CitationInsightVm[]>()),
        ).map(([loc, locItems]) => ({ loc: loc || 'No location', locItems }))
        return (
          <div className="evidence-card-location-compare">
            {locationGroups.map(({ loc, locItems }) => {
              const locCited = locItems.filter(i => i.citationState === 'cited' || i.citationState === 'emerging').length
              return (
                <div key={loc} className="evidence-card-location-row">
                  <span className="evidence-card-location-label">{loc}</span>
                  <div className="evidence-card-location-providers">
                    {locItems.filter(i => i.citationState !== 'pending').map(item => (
                      <button
                        key={item.id}
                        type="button"
                        className={`evidence-provider-btn evidence-provider-btn--${item.citationState} evidence-provider-btn--compact`}
                        onClick={() => onOpenEvidence(item.id)}
                        title={`View ${item.provider} evidence for "${phrase}" in ${loc}`}
                      >
                        <span className="capitalize">{item.provider}</span>
                        <span aria-hidden="true" className="font-bold">
                          {item.citationState === 'cited' || item.citationState === 'emerging' ? '\u2713' : item.citationState === 'lost' ? '\u2717' : '\u2013'}
                        </span>
                      </button>
                    ))}
                    {locItems.every(i => i.citationState === 'pending') && (
                      <span className="text-xs text-zinc-500 italic">Pending</span>
                    )}
                  </div>
                  <span className="evidence-card-location-score">{locCited}/{locItems.length}</span>
                </div>
              )
            })}
          </div>
        )
      })() : (
        <div className="evidence-card-providers">
          {items.filter(item => item.citationState !== 'pending').map(item => (
            <button
              key={item.id}
              type="button"
              className={`evidence-provider-btn evidence-provider-btn--${item.citationState}`}
              onClick={() => onOpenEvidence(item.id)}
              title={`View ${item.provider} evidence for "${phrase}"`}
            >
              <span className="capitalize">{item.provider}</span>
              {item.location && showLocationLabels && <span className="text-[9px] opacity-60">{item.location}</span>}
              <span aria-hidden="true" className="font-bold">
                {item.citationState === 'cited' || item.citationState === 'emerging' ? '\u2713' : item.citationState === 'lost' ? '\u2717' : '\u2013'}
              </span>
              <span className="opacity-50 text-[10px]">View →</span>
            </button>
          ))}
          {items.every(item => item.citationState === 'pending') && (
            <span className="text-xs text-zinc-500 italic py-1">Awaiting first run</span>
          )}
        </div>
      )}
    </div>
  )
}

export function EvidencePhraseCards({
  evidence,
  onOpenEvidence,
  showLocationLabels = true,
  compareLocations = false,
  timelineLoading = false,
  onDeleteKeyword,
}: {
  evidence: CitationInsightVm[]
  onOpenEvidence: (evidenceId: string) => void
  showLocationLabels?: boolean
  compareLocations?: boolean
  timelineLoading?: boolean
  onDeleteKeyword?: (phrase: string) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, CitationInsightVm[]>()
    for (const item of evidence) {
      const existing = map.get(item.keyword) ?? []
      map.set(item.keyword, [...existing, item])
    }
    return [...map.entries()].map(([phrase, items]) => ({ phrase, items }))
  }, [evidence])

  if (groups.length === 0) {
    return <p className="supporting-copy">No key phrases tracked yet.</p>
  }

  return (
    <div className="evidence-card-grid">
      {groups.map(({ phrase, items }) => (
        <EvidencePhraseCard
          key={phrase}
          phrase={phrase}
          items={items}
          onOpenEvidence={onOpenEvidence}
          showLocationLabels={showLocationLabels}
          compareLocations={compareLocations}
          timelineLoading={timelineLoading}
          onDeleteKeyword={onDeleteKeyword ? () => onDeleteKeyword(phrase) : undefined}
        />
      ))}
    </div>
  )
}

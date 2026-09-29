import type { CitationInsightVm, RunHistoryPoint } from '../../view-models.js'

export function CitationTimeline({ history, maxDots = 12, signal = 'citations' }: {
  history: RunHistoryPoint[]
  maxDots?: number
  /** Names the signal already projected into each point's citationState. */
  signal?: 'mentions' | 'citations'
}) {
  const dots = history.slice(-maxDots)
  if (dots.length === 0) return <span className="text-[13px] text-secondary">No data</span>

  const signalLabel = signal === 'mentions' ? 'Mention' : 'Citation'
  const stateLabels: Record<string, string> = signal === 'mentions'
    ? { cited: 'mentioned', 'not-cited': 'not mentioned', lost: 'mention lost', emerging: 'new mention', pending: 'mention pending' }
    : { cited: 'cited', 'not-cited': 'not cited', lost: 'citation lost', emerging: 'new citation', pending: 'citation pending' }

  const colorMap: Record<string, string> = {
    cited: 'bg-positive-400',
    'not-cited': 'bg-mono-600',
    lost: 'bg-negative-400',
    emerging: 'bg-caution-400 ring-1 ring-caution-300/60',
  }
  const shapeMap: Record<string, string> = {
    cited: 'rounded-full',
    'not-cited': 'rounded-sm',
    lost: 'rotate-45 rounded-[1px]',
    emerging: 'rounded-full',
  }

  const lastIndex = dots.length - 1
  const firstDate = new Date(dots[0].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const lastDate = new Date(dots[lastIndex].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const runCountLabel = `${dots.length} ${dots.length === 1 ? 'run' : 'runs'}`
  const timelineLabel = dots.map((dot, i) => {
    const date = new Date(dot.createdAt).toLocaleDateString()
    const prefix = i === lastIndex ? 'Latest run, ' : ''
    return `${prefix}${date}: ${stateLabels[dot.citationState] ?? dot.citationState}${dot.model ? `, model ${dot.model}` : ''}`
  }).join('; ')

  return (
    <div className="inline-flex w-max items-center gap-2 whitespace-nowrap" role="img" aria-label={`${signalLabel} history across ${runCountLabel}. ${timelineLabel}`}>
      {dots.length > 1 ? <span className="text-[11px] text-secondary shrink-0" aria-hidden="true">{firstDate}</span> : null}
      <div className="flex shrink-0 items-center gap-[3px]" title={runCountLabel} aria-hidden="true">
        {dots.map((d, i) => {
          // The ring means "the model changed on this run", NOT "this is the
          // newest run". Without a separate marker for the latest run, a strip
          // whose model changed mid-history reads as if an older run were the
          // current one. The two markers use different CSS properties
          // (box-shadow vs outline) so a run that is both still shows both.
          const modelChanged = Boolean(d.model && i > 0 && dots[i - 1]?.model && dots[i - 1]!.model !== d.model)
          const isLatest = i === lastIndex
          return (
            <span
              key={`${d.runId}:${d.createdAt}`}
              className={`h-2.5 w-2.5 shrink-0 ${shapeMap[d.citationState] ?? 'rounded-sm'} ${colorMap[d.citationState] ?? 'bg-mono-700'} ${
                modelChanged ? 'ring-1 ring-caution-300/80 ring-offset-1 ring-offset-bg' : ''
              } ${isLatest ? 'outline outline-1 outline-offset-2 outline-mono-400' : ''}`}
              title={[
                stateLabels[d.citationState] ?? d.citationState,
                new Date(d.createdAt).toLocaleDateString(),
                d.model ? `model ${d.model}` : null,
                modelChanged ? 'model changed' : null,
                isLatest ? 'latest run' : null,
              ].filter(Boolean).join(' · ')}
            />
          )
        })}
      </div>
      <span className="text-[11px] shrink-0 text-secondary" aria-hidden="true">
        {lastDate} <span>latest</span>
      </span>
    </div>
  )
}

/** Aggregate citation timeline from multiple provider histories into a single merged timeline. */
export function mergeProviderHistories(items: CitationInsightVm[]): RunHistoryPoint[] {
  // Collect all states + runId per run timestamp across providers.
  const byRun = new Map<string, { states: string[]; runId: string }>()
  for (const item of items) {
    for (const h of item.runHistory) {
      const existing = byRun.get(h.createdAt)
      if (existing) existing.states.push(h.citationState)
      else byRun.set(h.createdAt, { states: [h.citationState], runId: h.runId })
    }
  }
  // For each run, pick the best state: cited > emerging > not-cited
  const sorted = [...byRun.entries()].sort(([a], [b]) => a.localeCompare(b))
  return sorted.map(([createdAt, { states, runId }]) => ({
    runId,
    createdAt,
    citationState: states.includes('cited') ? 'cited'
      : states.includes('emerging') ? 'emerging'
      : 'not-cited',
  }))
}

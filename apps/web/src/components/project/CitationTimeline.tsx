import type { CitationInsightVm, RunHistoryPoint } from '../../view-models.js'

export function CitationTimeline({ history, maxDots = 12 }: { history: RunHistoryPoint[]; maxDots?: number }) {
  const dots = history.slice(-maxDots)
  if (dots.length === 0) return <span className="text-[11px] text-zinc-600">No data</span>

  const colorMap: Record<string, string> = {
    cited: 'bg-emerald-400',
    'not-cited': 'bg-zinc-600',
    lost: 'bg-rose-400',
    emerging: 'bg-amber-400 ring-1 ring-amber-300/60',
  }

  const firstDate = new Date(dots[0].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const lastDate = new Date(dots[dots.length - 1].createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] text-zinc-600 shrink-0">{firstDate}</span>
      <div className="flex items-center gap-[3px]" title={`${dots.length} runs`}>
        {dots.map((d, i) => (
          <div
            key={i}
            className={`h-2.5 w-2.5 rounded-sm ${colorMap[d.citationState] ?? 'bg-zinc-700'} ${
              d.model && i > 0 && dots[i - 1]?.model && dots[i - 1]!.model !== d.model
                ? 'ring-1 ring-amber-300/80 ring-offset-1 ring-offset-zinc-950'
                : ''
            }`}
            title={[
              d.citationState,
              new Date(d.createdAt).toLocaleDateString(),
              d.model ? `model ${d.model}` : null,
              d.model && i > 0 && dots[i - 1]?.model && dots[i - 1]!.model !== d.model ? 'model changed' : null,
            ].filter(Boolean).join(' — ')}
          />
        ))}
      </div>
      <span className="text-[9px] text-zinc-600 shrink-0">{lastDate}</span>
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

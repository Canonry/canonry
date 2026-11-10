import { formatSweepInstant } from '../../lib/format-helpers.js'

/**
 * Progress for one background job, the Agent Readiness audit scan or the AI
 * Visibility check, as the server reports it. The bar fills only against a total
 * the server sent; without one, or before the first result, it pulses. It never
 * shows a percentage or an estimate, and it stays neutral: running is not a
 * success or a warning.
 */
export function JobProgress({
  label,
  phase,
  count,
  done,
  total,
  startedAt,
  queuedAt,
  noun,
}: {
  /** The bar's accessible name, such as "AI Visibility check progress". */
  label: string
  /** What is happening now, such as "Asking engines". */
  phase: string
  /** The count beside the phase, such as "6 of 15 answers saved". */
  count?: string | null
  done?: number | null
  total?: number | null
  startedAt?: string | null
  queuedAt?: string | null
  noun: 'scan' | 'check'
}) {
  const bounded = typeof done === 'number' && typeof total === 'number' && total > 0
  const share = bounded ? Math.min(1, done / total) : 0
  const since = startedAt ?? queuedAt ?? null
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-copy-14-strong text-primary">{phase}</p>
        {/* Not a live region: a count that ticks every few seconds would talk over everything. */}
        {count ? <p className="text-label-14 tabular-nums text-secondary">{count}</p> : null}
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-inset"
        role="progressbar"
        aria-label={label}
        aria-valuemin={bounded ? 0 : undefined}
        aria-valuemax={bounded ? total : undefined}
        aria-valuenow={bounded ? Math.min(done, total) : undefined}
      >
        {bounded && done > 0
          ? <div className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(2, share * 100)}%` }} />
          : <div className="h-full w-full rounded-full bg-accent/25 motion-safe:animate-pulse" />}
      </div>
      <p className="mt-2 text-copy-13 text-secondary">
        {since ? <>{startedAt ? 'Started' : 'Queued'} <time dateTime={since}>{formatSweepInstant(since, new Date().toISOString())}</time>. </> : null}
        You can leave this page. The {noun} keeps running.
      </p>
    </div>
  )
}

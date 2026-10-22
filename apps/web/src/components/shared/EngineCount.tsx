import { Triangle } from 'lucide-react'
import type { QueryTrackingRowEngineCounts } from '@canonry/canonry-contracts'

/** What an engine won or lost of a signal since the previous sweep. */
export type SignalChange = 'won' | 'lost'

export const CHANGE_WORDS: Record<SignalChange, string> = { won: 'Won in last sweep', lost: 'Lost in last sweep' }

const whole = (value: number) => value.toLocaleString('en-US')

/** ▲ for a signal won since the previous sweep, ▼ for one lost: a shape as well as a color. Its words are its caller's. */
export function ChangeMark({ change, className = '' }: { change: SignalChange; className?: string }) {
  return <Triangle aria-hidden="true" className={`size-2.5 shrink-0 fill-current ${change === 'won' ? 'text-positive-400' : 'rotate-180 text-negative-400'} ${className}`} />
}

/**
 * How many engines show one signal for one query, of the engines that checked
 * it: "2 of 3", the server's `engineCounts`, read and never counted here. On a
 * compared row a ▲ and a ▼ count the engines that won or lost it since the
 * previous sweep, each left out at zero. An engine that did not check the
 * signal is in neither number. `counts` undefined is still loading; null is a
 * query with no result in the sweep. Which engines they are is the opened
 * row's.
 */
export function EngineCount({ counts, which }: { counts: QueryTrackingRowEngineCounts | null | undefined; which: 'mentioned' | 'cited' }) {
  if (counts === undefined) return <span aria-hidden="true" className="skeleton-text inline-block w-12 align-middle" />
  const [shown, checked] = which === 'cited' ? [counts?.cited, counts?.citationChecked] : [counts?.mentioned, counts?.mentionChecked]
  // A state, not metadata: it reads at the contrast of every other cell.
  if (!counts || !checked) return <span className="text-secondary">Not checked</span>
  const change = counts.change
  const [won, lost] = !change ? [0, 0] : which === 'cited' ? [change.citationsWon, change.citationsLost] : [change.mentionsWon, change.mentionsLost]
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap tabular-nums">
      <span className="font-medium text-strong">{whole(shown!)} of {whole(checked)}<span className="sr-only">{checked === 1 ? ' engine' : ' engines'}</span></span>
      {/* Heard as one line: "2 of 3 engines, 1 won in last sweep, 1 lost in last sweep". */}
      {won > 0 ? <span className="inline-flex items-center gap-1 font-medium text-positive-400"><span className="sr-only">, </span><ChangeMark change="won" />{whole(won)}<span className="sr-only"> won in last sweep</span></span> : null}
      {lost > 0 ? <span className="inline-flex items-center gap-1 font-medium text-negative-400"><span className="sr-only">, </span><ChangeMark change="lost" />{whole(lost)}<span className="sr-only"> lost in last sweep</span></span> : null}
    </span>
  )
}

/** What a ▲ and a ▼ beside a count are, beside the list that draws them. */
export function ChangeLegend() {
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-5 text-secondary">
      {(['won', 'lost'] as const).map(change => (
        <li key={change} className="inline-flex items-center gap-1.5 whitespace-nowrap"><ChangeMark change={change} />{CHANGE_WORDS[change]}</li>
      ))}
    </ul>
  )
}

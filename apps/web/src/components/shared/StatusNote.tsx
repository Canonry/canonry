import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import type { MetricTone } from '../../view-models.js'
import { useTooltipBubble } from './InfoTooltip.js'

const TONE: Record<MetricTone, string> = {
  neutral: 'text-secondary',
  caution: 'text-caution',
  negative: 'text-negative',
  positive: 'text-positive',
}
const TONE_HOVER: Record<MetricTone, string> = {
  neutral: 'hover:text-heading',
  caution: 'hover:text-caution-200',
  negative: 'hover:text-negative-200',
  positive: 'hover:text-positive-200',
}
// The label wraps under itself when its box is too narrow, with the icon on its first line (a 14px icon in a 20px line).
// Where a finger is the pointer every note is a 44px row, so a table of notes keeps one row height.
const NOTE = 'inline-grid max-w-full grid-cols-[auto_minmax(0,1fr)] content-center items-start gap-x-1.5 text-left text-[13px] font-medium leading-5 pointer-coarse:min-h-11 max-md:min-h-11'

/**
 * A caveat, status or helper: an icon and a label of at most four words. The
 * sentence behind it is `detail`, shown in the `InfoTooltip` bubble on hover,
 * focus and tap, and read after the label as part of the accessible name
 * ("{label}. {detail}"). Never a `title`, which shows on neither a tap nor
 * keyboard focus. A label with a sentence behind it has a dotted underline.
 * Inside a sheet, Escape closes the open bubble and leaves the sheet up. A
 * sheet focuses its first focusable control when it opens, and focus opens the
 * bubble: never put a note with a sentence first in a sheet. A note with no
 * `detail` has nothing to open, so it is plain text, not a button. `action` is
 * the one control that goes with the note, such as Retry; it sits beside the
 * note as a sibling, outside its name.
 */
export function StatusNote({ icon: Icon, label, detail, tone = 'neutral', action }: {
  icon: LucideIcon
  label: string
  detail?: string
  tone?: MetricTone
  action?: ReactNode
}) {
  const content = <>
    <Icon className="mt-[3px] size-3.5" aria-hidden="true" />
    {label}
  </>
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 align-middle">
      {detail
        ? <StatusNoteButton label={label} detail={detail} tone={tone}>{content}</StatusNoteButton>
        : <span className={`${NOTE} ${TONE[tone]}`}>{content}</span>}
      {action}
    </span>
  )
}

/** Its own component, so a note that gains or loses its sentence never carries an open bubble across. */
function StatusNoteButton({ label, detail, tone, children }: { label: string; detail: string; tone: MetricTone; children: ReactNode }) {
  // Opens below, the placement that keeps the bubble inside a narrow viewport, and from the label's own edge, which keeps it inside a sheet.
  const bubble = useTooltipBubble(detail, { placement: 'bottom', align: 'start' })
  return <>
    <button
      type="button"
      className={`${NOTE} ${TONE[tone]} ${TONE_HOVER[tone]} cursor-help rounded-sm underline decoration-current/40 decoration-dotted underline-offset-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
      aria-label={`${label}. ${detail}`}
      {...bubble.wrapper}
      {...bubble.trigger}
    >
      {children}
    </button>
    {bubble.bubble}
  </>
}

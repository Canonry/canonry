import type { CitationInsightVm } from '../../view-models.js'
import { toneFromCitationState } from '../../lib/tone-helpers.js'
import { toTitleCase } from '../../lib/format-helpers.js'
import { CITATION_NOT_MEASURED } from '../../lib/citation-not-measured-copy.js'
import { ToneBadge } from './ToneBadge.js'

export function CitationBadge({
  state,
  label,
  className,
}: {
  state: CitationInsightVm['citationState']
  /** Optional override for the rendered text — lets callers swap "Cited" for
   *  "Mentioned" while keeping the same tone color. */
  label?: string
  className?: string
}) {
  return <ToneBadge tone={toneFromCitationState(state)} className={className}>{label ?? (state === 'not-measured' ? CITATION_NOT_MEASURED.label : toTitleCase(state))}</ToneBadge>
}

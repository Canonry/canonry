import type { CitationInsightVm } from '../../view-models.js'
import { toneFromCitationState } from '../../lib/tone-helpers.js'
import { toTitleCase } from '../../lib/format-helpers.js'
import { ToneBadge } from './ToneBadge.js'

export function CitationBadge({ state }: { state: CitationInsightVm['citationState'] }) {
  return <ToneBadge tone={toneFromCitationState(state)}>{toTitleCase(state)}</ToneBadge>
}

import { CitationStates, combineCitationStates, type CitationState as AnswerCitationState } from '@canonry/canonry-contracts'
import type { CitationState } from '../view-models.js'

/**
 * One query's status over the engine rows shown (an engine filter or a
 * location split narrows them, so this runs on the rows in view). Whether the
 * query reads cited, not cited or not measured is the API's own rule,
 * `combineCitationStates`: cited when any engine cites it, not cited when at
 * least one engine's sources were checked and none cites it, not measured only
 * when no engine's answer carries sources. The rows' transitions then say how
 * it got there: emerging when no engine was already citing it, lost when an
 * engine stopped. Rows that have not answered yet are pending.
 */
export function queryCitationState(states: readonly CitationState[]): CitationState {
  const answered = states.filter((state): state is Exclude<CitationState, 'pending'> => state !== 'pending')
  if (answered.length === 0) return 'pending'
  const combined = combineCitationStates(answered.map(steadyState))
  if (combined === CitationStates.cited) return answered.includes('cited') ? 'cited' : 'emerging'
  if (combined === CitationStates['not-cited']) return answered.includes('lost') ? 'lost' : 'not-cited'
  return 'not-measured'
}

function steadyState(state: Exclude<CitationState, 'pending'>): AnswerCitationState {
  switch (state) {
    case 'cited':
    case 'emerging':
      return CitationStates.cited
    case 'not-cited':
    case 'lost':
      return CitationStates['not-cited']
    case 'not-measured':
      return CitationStates['not-measured']
  }
}

import { CitationStates, type CitationState } from '@canonry/canonry-contracts'

/**
 * The legend printed above every two-glyph snapshot cell (citation first,
 * mention second). `·` is an answer whose engine returns no sources: its
 * citation was never measured, which is not a miss.
 */
export const SNAPSHOT_CELL_LEGEND = '(cell = [citation][mention];  C=cited c=not ·=not measured, M=mentioned m=not, –=no data)'

/** The citation half of a snapshot cell. */
export function citationGlyph(state: CitationState): string {
  switch (state) {
    case CitationStates.cited: return 'C'
    case CitationStates['not-cited']: return 'c'
    case CitationStates['not-measured']: return '·'
  }
}

/** The mention half of a snapshot cell: `–` when the answer text was never checked. */
export function mentionGlyph(mentioned: boolean | null | undefined): string {
  if (mentioned === true) return 'M'
  if (mentioned === false) return 'm'
  return '–'
}

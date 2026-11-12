import { CITATION_NOT_MEASURED_REASON } from '@canonry/canonry-contracts'

/**
 * An answer whose engine returns no sources (a local model has no web access),
 * so whether it cites the project was never observed. It is neither cited nor
 * not cited. Shared by the query evidence table, its timelines and the answer
 * panel, so every surface says the same thing.
 */
export const CITATION_NOT_MEASURED = {
  /** A status badge. */
  label: 'Not measured',
  /** The latest-run signal line beside a query or engine. */
  signal: 'Citation not measured',
  /** One run on a citation timeline. */
  timeline: 'citation not measured',
  /** Where the answer's sources would be listed: the reason every surface (API, CLI, dashboard) gives. */
  sources: CITATION_NOT_MEASURED_REASON,
} as const

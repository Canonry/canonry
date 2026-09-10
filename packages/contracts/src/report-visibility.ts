import { z } from 'zod'
import {
  visibilityReportPopulationSchema,
  visibilityReportSelectionSchema,
  type VisibilityReportPopulationClass,
  type VisibilityReportRate,
} from './visibility-report.js'

/** Canonical frozen populations shared by the dashboard and both report renderers. */
export const reportVisibilitySchema = z.object({
  selection: visibilityReportSelectionSchema,
  /** History window only; the latest summary remains available even outside it. */
  historyWindow: z.object({ from: z.string().datetime(), to: z.string().datetime() }).optional(),
  populations: z.array(visibilityReportPopulationSchema.pick({ queryClass: true, summary: true, trend: true })),
})
export type ReportVisibility = z.infer<typeof reportVisibilitySchema>

export const REPORT_VISIBILITY_COPY = {
  title: 'AI visibility',
  description: 'Each answer is counted once for its assigned properties. Branded and non-brand queries are measured separately.',
  simpleDescription: 'Each saved answer is counted once. Branded and non-brand queries are measured separately.',
  queryType: 'Query type',
  queries: 'Queries measured',
  answers: 'Answers measured',
  mentioned: 'Mentioned',
  cited: 'Cited',
  history: 'Measurement history',
  latestMeasurement: 'Latest measurement',
  allLocations: 'All measured locations',
  noLocation: 'No provider location',
  location: 'Location',
  previousOutsideWindow: 'Previous measurement outside this period',
  date: 'Date',
  comparison: 'Comparison',
  notMeasured: 'Not measured',
  incomplete: 'Evidence incomplete',
  ambiguous: 'Property identity unverified',
  noPopulation: 'No measured answers',
  notApplicable: 'Not applicable',
  comparable: 'Comparable',
  baseline: 'Baseline',
  changed: 'Measurement changed',
  unknownHistory: 'Comparison unavailable',
} as const

export function reportQueryClassLabel(value: VisibilityReportPopulationClass): string {
  return { branded: 'Branded', 'non-brand': 'Non-brand', unknown: 'Unclassified' }[value]
}

export function reportVisibilityRate(value: VisibilityReportRate): string {
  return value.rate === null ? REPORT_VISIBILITY_COPY.notMeasured : `${Number((value.rate * 100).toFixed(1))}%`
}

export function reportVisibilityEvidence(value: VisibilityReportRate): string {
  if (value.numerator !== null && value.denominator !== null) return `${value.numerator} of ${value.denominator} answers`
  switch (value.reason) {
    case 'no-population': return REPORT_VISIBILITY_COPY.noPopulation
    case 'not-applicable': return REPORT_VISIBILITY_COPY.notApplicable
    // Identity ambiguity is an explicit evidence state, never a negative result.
    case 'identity-ambiguous': return REPORT_VISIBILITY_COPY.ambiguous
    default: return REPORT_VISIBILITY_COPY.incomplete
  }
}

export function reportVisibilityComparison(state: ReportVisibility['populations'][number]['trend'][number]['continuity']['state'], outsideWindow = false): string {
  const label = state === 'first' ? REPORT_VISIBILITY_COPY.baseline
    : state === 'comparable' ? REPORT_VISIBILITY_COPY.comparable
    : state === 'legacy-unknown' ? REPORT_VISIBILITY_COPY.unknownHistory
    : REPORT_VISIBILITY_COPY.changed
  return outsideWindow ? `${label} · ${REPORT_VISIBILITY_COPY.previousOutsideWindow}` : label
}

export function reportVisibilityMeasurementLabel(visibility: ReportVisibility): string {
  const date = visibility.selection.measurement.completedAt?.slice(0, 10) ?? REPORT_VISIBILITY_COPY.notMeasured
  return `${REPORT_VISIBILITY_COPY.latestMeasurement}: ${date}`
}

export function reportVisibilityHistoryLabel(visibility: ReportVisibility): string {
  const window = visibility.historyWindow
  return window === undefined ? REPORT_VISIBILITY_COPY.history
    : `${REPORT_VISIBILITY_COPY.history} (${window.from.slice(0, 10)} – ${window.to.slice(0, 10)})`
}


/** Caption follows the frozen report selection, never a separate latest-run drawer. */
export function reportVisibilityLocationLabel(visibility: ReportVisibility): string {
  const location = visibility.selection.location
  if (location.kind === 'all') return REPORT_VISIBILITY_COPY.allLocations
  if (location.kind === 'none') return REPORT_VISIBILITY_COPY.noLocation
  return `${REPORT_VISIBILITY_COPY.location}: ${location.value}`
}

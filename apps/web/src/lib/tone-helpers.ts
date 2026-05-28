import type { MetricTone, ServiceStatus } from '../view-models.js'
import type { CitationInsightVm, RunListItemVm } from '../view-models.js'

export function toneFromService(status: ServiceStatus): MetricTone {
  if (status.state === 'ok') {
    return 'positive'
  }

  if (status.state === 'checking') {
    return 'neutral'
  }

  return 'negative'
}

export function toneFromRunStatus(status: RunListItemVm['status']): MetricTone {
  switch (status) {
    case 'completed':
      return 'positive'
    case 'partial':
      return 'caution'
    case 'failed':
      return 'negative'
    case 'cancelled':
      return 'caution'
    case 'queued':
    case 'running':
      return 'neutral'
    default:
      return 'neutral'
  }
}

export function toneFromCitationState(state: CitationInsightVm['citationState']): MetricTone {
  switch (state) {
    case 'cited':
      return 'positive'
    case 'emerging':
      return 'caution'
    case 'not-cited':
      return 'caution'
    case 'lost':
      return 'negative'
    case 'pending':
      return 'neutral'
    default:
      return 'neutral'
  }
}

export function competitorTone(label: string): MetricTone {
  if (label === 'High') return 'negative'
  if (label === 'Moderate') return 'caution'
  if (label === 'Low') return 'neutral'
  return 'neutral'
}

/**
 * Single source of truth for the 0-100 score → tone thresholds. Consumed by the
 * per-model breakdown text color and its trend sparkline so the cutoffs never
 * drift apart.
 */
export function toneFromScore(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

/** Maps a metric tone to its Tailwind text-color utility. */
export const METRIC_TONE_TEXT_CLASS: Record<MetricTone, string> = {
  positive: 'text-emerald-400',
  caution: 'text-amber-400',
  negative: 'text-rose-400',
  neutral: 'text-zinc-400',
}

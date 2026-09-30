import type { MetricTone, ServiceStatus } from '../view-models.js'
import type { CitationInsightVm, RunListItemVm } from '../view-models.js'

export function toneFromService(status: ServiceStatus): MetricTone {
  if (status.state === 'ok') {
    return 'positive'
  }

  if (status.state === 'checking' || status.state === 'disabled') {
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

/** Maps a metric tone to its Tailwind text-color utility. */
export const METRIC_TONE_TEXT_CLASS: Record<MetricTone, string> = {
  positive: 'text-positive-400',
  caution: 'text-caution-400',
  negative: 'text-negative-400',
  neutral: 'text-secondary',
}

/**
 * Tone for a non-brand mention share (0..100). Same bands as the server's
 * `mentionShareTone` (packages/intelligence/src/mention-share.ts): 50% and up
 * positive, 25% and up caution, below that negative. Looser than coverage
 * because the frame is already competitive.
 */
export function mentionShareTone(percent: number): MetricTone {
  if (percent >= 50) return 'positive'
  if (percent >= 25) return 'caution'
  return 'negative'
}

/**
 * Tone for a gap count out of the queries it was drawn from. Same bands as the
 * server's `gapTone` (packages/intelligence/src/score-tones.ts): no gap
 * positive, 30% of queries and up negative, anything between caution.
 */
export function gapTone(gapCount: number, totalCount: number): MetricTone {
  if (gapCount === 0) return 'positive'
  const ratio = totalCount > 0 ? gapCount / totalCount : 0
  if (ratio >= 0.3) return 'negative'
  return 'caution'
}

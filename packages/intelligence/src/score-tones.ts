import type { MetricTone } from '@ainyc/canonry-contracts'

/** 70+ = positive, 40–69 = caution, <40 = negative. Used by visibility, gap, and per-model gauges. */
export function scoreTone(score: number): MetricTone {
  if (score >= 70) return 'positive'
  if (score >= 40) return 'caution'
  return 'negative'
}

/** Pressure label → tone. High = negative, Moderate = caution, Low/None = neutral. */
export function pressureTone(label: 'None' | 'Low' | 'Moderate' | 'High'): MetricTone {
  if (label === 'High') return 'negative'
  if (label === 'Moderate') return 'caution'
  return 'neutral'
}

/** Gap-query gauge tone. Inverted from scoreTone — fewer gaps is better. */
export function gapTone(gapCount: number, totalCount: number): MetricTone {
  if (gapCount === 0) return 'positive'
  const ratio = totalCount > 0 ? gapCount / totalCount : 0
  if (ratio >= 0.3) return 'negative'
  return 'caution'
}

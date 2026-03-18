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

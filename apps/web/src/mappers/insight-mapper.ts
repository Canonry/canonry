import type { InsightDto } from '@ainyc/canonry-contracts'
import type { MetricTone, CitationState, InsightActionGroup, ProjectInsightVm } from '../view-models.js'

const TONE_MAP: Record<InsightDto['type'], MetricTone> = {
  regression: 'negative',
  gain: 'positive',
  opportunity: 'caution',
  'first-citation': 'positive',
  'provider-pickup': 'positive',
  'persistent-gap': 'caution',
  'competitor-gained': 'negative',
  'competitor-lost': 'neutral',
  // GBP (local-AEO) insights.
  'gbp-lodging-gap': 'negative',
  'gbp-cta-gap': 'caution',
  'gbp-metric-drop': 'negative',
  'gbp-keyword-drop': 'negative',
}

const ACTION_GROUP_MAP: Record<InsightDto['type'], InsightActionGroup> = {
  // Content-required: a missing/competitive answer needs new or updated material.
  opportunity: 'write',
  'persistent-gap': 'write',
  'competitor-gained': 'write',
  'competitor-lost': 'write',
  // Diagnostic: something previously cited dropped — figure out why first.
  regression: 'investigate',
  // Observational: positive movement; keep watching it doesn't reverse.
  gain: 'monitor',
  'first-citation': 'monitor',
  'provider-pickup': 'monitor',
  // GBP: profile gaps need content/profile work; metric & keyword drops need diagnosis.
  'gbp-lodging-gap': 'write',
  'gbp-cta-gap': 'write',
  'gbp-metric-drop': 'investigate',
  'gbp-keyword-drop': 'investigate',
}

const CITATION_STATE_MAP: Record<InsightDto['type'], CitationState> = {
  regression: 'lost',
  gain: 'emerging',
  opportunity: 'not-cited',
  'first-citation': 'emerging',
  'provider-pickup': 'emerging',
  'persistent-gap': 'not-cited',
  'competitor-gained': 'cited',
  'competitor-lost': 'not-cited',
  // GBP insights aren't citation-state events; map gaps to not-cited, drops to lost.
  'gbp-lodging-gap': 'not-cited',
  'gbp-cta-gap': 'not-cited',
  'gbp-metric-drop': 'lost',
  'gbp-keyword-drop': 'lost',
}

const ACTION_LABEL_FALLBACK: Record<InsightDto['type'], string> = {
  regression: 'Regression',
  gain: 'Gain',
  opportunity: 'Opportunity',
  'first-citation': 'First citation',
  'provider-pickup': 'Pickup',
  'persistent-gap': 'Gap',
  'competitor-gained': 'Competitor',
  'competitor-lost': 'Competitor',
  'gbp-lodging-gap': 'Lodging gap',
  'gbp-cta-gap': 'Booking CTA',
  'gbp-metric-drop': 'Metric drop',
  'gbp-keyword-drop': 'Keyword drop',
}

export function mapInsightDtoToVm(dto: InsightDto): ProjectInsightVm {
  return {
    id: dto.id,
    tone: TONE_MAP[dto.type],
    title: dto.title,
    detail: dto.cause?.details ?? dto.cause?.cause ?? '',
    actionLabel: dto.recommendation?.action ?? ACTION_LABEL_FALLBACK[dto.type],
    actionGroup: ACTION_GROUP_MAP[dto.type],
    affectedPhrases: [{
      query: dto.query,
      evidenceId: '',
      provider: dto.provider,
      citationState: CITATION_STATE_MAP[dto.type],
    }],
  }
}

export function mapInsightDtosToVms(dtos: InsightDto[]): ProjectInsightVm[] {
  return dtos.filter(d => !d.dismissed).map(mapInsightDtoToVm)
}

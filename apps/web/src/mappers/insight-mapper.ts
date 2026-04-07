import type { InsightDto } from '@ainyc/canonry-contracts'
import type { MetricTone, CitationState, ProjectInsightVm } from '../view-models.js'

const TONE_MAP: Record<InsightDto['type'], MetricTone> = {
  regression: 'negative',
  gain: 'positive',
  opportunity: 'caution',
}

const CITATION_STATE_MAP: Record<InsightDto['type'], CitationState> = {
  regression: 'lost',
  gain: 'emerging',
  opportunity: 'not-cited',
}

const ACTION_LABEL_FALLBACK: Record<InsightDto['type'], string> = {
  regression: 'Regression',
  gain: 'Gain',
  opportunity: 'Opportunity',
}

export function mapInsightDtoToVm(dto: InsightDto): ProjectInsightVm {
  return {
    id: dto.id,
    tone: TONE_MAP[dto.type],
    title: dto.title,
    detail: dto.cause?.details ?? dto.cause?.cause ?? '',
    actionLabel: dto.recommendation?.action ?? ACTION_LABEL_FALLBACK[dto.type],
    affectedPhrases: [{
      keyword: dto.keyword,
      evidenceId: '',
      provider: dto.provider,
      citationState: CITATION_STATE_MAP[dto.type],
    }],
  }
}

export function mapInsightDtosToVms(dtos: InsightDto[]): ProjectInsightVm[] {
  return dtos.filter(d => !d.dismissed).map(mapInsightDtoToVm)
}

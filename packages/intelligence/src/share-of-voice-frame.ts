import type { ShareOfVoiceContext } from '@ainyc/canonry-contracts'

// Three rivals seen in three distinct answers each rules out a lone alternative
// or a one-answer list. This is a publication floor, not a confidence interval.
// Apply it AFTER every class/window/market/provider/model filter, before row caps.
export const MIN_OBSERVED_COMPETITORS = 3
export const MIN_OBSERVED_ANSWERS = 3

export function buildShareOfVoiceFrame(input: {
  tracked: boolean
  classSelected: boolean
  projectMentions: number
  answeredResults: number
  competitors: readonly { domain: string; mentions: number }[]
}): ShareOfVoiceContext & {
  score: number | null
  denominator: number
  competitorMentions: number
  domains: string[]
} {
  const selected = input.tracked ? input.competitors
    : input.competitors.filter(row => row.mentions >= MIN_OBSERVED_ANSWERS)
  const domains = selected.map(row => row.domain)
  const competitorMentions = selected.reduce((sum, row) => sum + row.mentions, 0)
  const denominator = input.projectMentions + competitorMentions
  const basis = input.tracked ? 'tracked' : input.competitors.length > 0 ? 'observed' : null
  const reason: ShareOfVoiceContext['reason'] = !input.classSelected ? 'select-query-class'
    : basis === null ? 'no-competitors'
      : !input.tracked && domains.length < MIN_OBSERVED_COMPETITORS ? 'insufficient-observed'
        : input.answeredResults === 0 ? 'no-answers'
          : denominator === 0 ? 'no-mentions' : null
  return {
    basis, reason, availability: reason === null ? 'measured' : 'not-measured',
    score: reason === null ? Math.round(input.projectMentions / denominator * 1000) / 10 : null,
    denominator, competitorMentions, domains,
  }
}

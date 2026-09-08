import { z } from 'zod'

export const shareOfVoiceContextSchema = z.object({
  basis: z.enum(['tracked', 'observed']).nullable(),
  availability: z.enum(['measured', 'not-measured', 'unavailable']),
  reason: z.enum(['select-query-class', 'no-competitors', 'insufficient-observed', 'no-answers', 'no-mentions', 'unavailable']).nullable(),
})
export type ShareOfVoiceContext = z.infer<typeof shareOfVoiceContextSchema>

// Additive wire fields: older servers and saved reports may omit the context.
export const shareOfVoiceContextFields = shareOfVoiceContextSchema.partial().shape

/** One copy source for CLI, dashboard, and both report renderers. */
export function shareOfVoiceReason(reason: ShareOfVoiceContext['reason']): string {
  switch (reason) {
    case 'select-query-class': return 'Select a query class.'
    case 'no-competitors': return 'No competitors configured.'
    case 'insufficient-observed': return 'Requires 3 observed competitors mentioned in at least 3 answers each.'
    case 'no-answers': return 'No answer text in scope.'
    case 'no-mentions': return 'No brands mentioned in scope.'
    case 'unavailable': return 'Competitor evidence is unavailable.'
    default: return ''
  }
}

export function shareOfVoiceLabel(percent: number | null, context?: Partial<ShareOfVoiceContext>): string {
  const value = context?.availability === 'unavailable' ? 'Unavailable'
    : context?.availability === 'not-measured' || percent === null ? 'Not measured'
      : `${percent.toFixed(1)}%`
  return context?.basis ? `${value} · ${context.basis} competitors` : value
}

export function shareOfVoiceSummary(percent: number | null, queryClass: string, context?: Partial<ShareOfVoiceContext> & { measurementScope?: 'project' | 'all-markets' }): string {
  return `Share of voice · ${queryClass} queries: ${shareOfVoiceLabel(percent, context)}${context?.measurementScope === 'all-markets' ? ' · all markets' : ''}`
}

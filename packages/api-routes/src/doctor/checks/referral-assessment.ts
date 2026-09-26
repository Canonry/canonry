import { CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, calendarMonthBounds, reportMonthsForDoctor } from '@ainyc/canonry-contracts'
import { trafficSources } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { buildReferralAssessment } from '../../referral-assessment.js'
import type { CheckDefinition } from '../types.js'

export const REFERRAL_ASSESSMENT_CHECKS: readonly CheckDefinition[] = [{
  id: 'report.ai-referral-ratio',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'AI referral comparison evidence',
  notificationPolicy: CheckNotificationPolicies.silent,
  run: ctx => {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.ai-referral-ratio.no-project', summary: 'Select a project to inspect referral evidence.' }
    if (!ctx.db.select({ id: trafficSources.id }).from(trafficSources).where(eq(trafficSources.projectId, ctx.project.id)).get()) {
      return { status: CheckStatuses.skipped, code: 'report.ai-referral-ratio.not-configured', summary: 'No server traffic source is configured for this project.' }
    }
    const months = reportMonthsForDoctor(ctx.reportMonth).map(month => {
      const bounds = calendarMonthBounds(month)
      const assessment = buildReferralAssessment(ctx.db, ctx.project!.name, { startDate: bounds.since.slice(0, 10), endDate: bounds.until.slice(0, 10), limit: 1 })
      return { month, comparison: assessment.comparison, suspected: assessment.totals.suspected, candidateHours: assessment.evidence.total, rule: assessment.rule }
    })
    // Coverage is unproven by construction, so it cannot be the signal: warn
    // only when threshold-qualified bursts exist to review. A high observed
    // quotient stays descriptive, never a warning.
    const bursts = months.filter(month => month.suspected.total > 0)
    if (bursts.length === 0) {
      return {
        status: CheckStatuses.ok,
        code: 'report.ai-referral-ratio.no-bursts',
        summary: `No threshold-qualified AI referral bursts in ${months.map(month => month.month).join(', ')}. Server/GA matching coverage stays unproven, so any observed quotient is descriptive only.`,
        details: { months },
      }
    }
    const first = bursts[0]!
    return {
      status: CheckStatuses.warn,
      code: 'report.ai-referral-ratio.bursts',
      summary: `${bursts.map(month => `${month.month}: ${month.suspected.total} suspected hits in ${month.candidateHours} candidate hour${month.candidateHours === 1 ? '' : 's'}`).join('; ')}. Raw headlines are unchanged; review before quoting AI referral totals.`,
      remediation: `Inspect canonry traffic referral-assessment ${ctx.project.name} --start-date ${first.month}-01 --end-date ${calendarMonthBounds(first.month).until.slice(0, 10)} --format json. Candidate bursts are not confirmed automation. Current records cannot verify complete server intervals or the GA reporting timezone. Keep raw counts and GA evidence separate; a high quotient does not confirm automation.`,
      details: { months },
    }
  },
}]

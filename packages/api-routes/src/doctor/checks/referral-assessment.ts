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
      return { month, comparison: assessment.comparison, suspected: assessment.totals.suspected, rule: assessment.rule }
    })
    return {
      status: CheckStatuses.warn,
      code: 'report.ai-referral-ratio.coverage-unknown',
      summary: 'Stored server and GA referral counts do not prove complete matching coverage; any observed quotient is descriptive only.',
      remediation: `Inspect canonry traffic referral-assessment ${ctx.project.name} --start-date ${months[0]!.month}-01 --end-date ${calendarMonthBounds(months[0]!.month).until.slice(0, 10)} --format json. Current records cannot verify complete server intervals or the GA reporting timezone. Keep raw counts and GA evidence separate; a high quotient does not confirm automation.`,
      details: { months },
    }
  },
}]

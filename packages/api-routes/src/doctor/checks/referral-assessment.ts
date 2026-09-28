import { CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, TrafficSourceStatuses, calendarMonthBounds, gradedReportMonths, reportMonthsForDoctor } from '@ainyc/canonry-contracts'
import { trafficSources } from '@ainyc/canonry-db'
import { and, eq, ne } from 'drizzle-orm'
import { buildReferralAssessment } from '../../referral-assessment.js'
import type { CheckDefinition } from '../types.js'

export const REFERRAL_ASSESSMENT_CHECKS: readonly CheckDefinition[] = [{
  id: 'report.ai-referral-bursts',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'AI referral burst evidence',
  notificationPolicy: CheckNotificationPolicies.silent,
  run: ctx => {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.ai-referral-bursts.no-project', summary: 'Select a project to inspect referral evidence.' }
    // An archived source is not connected, as `traffic.source.connected` and
    // the report's server activity section read it.
    const configured = ctx.db.select({ id: trafficSources.id }).from(trafficSources)
      .where(and(eq(trafficSources.projectId, ctx.project.id), ne(trafficSources.status, TrafficSourceStatuses.archived))).get()
    if (!configured) {
      return { status: CheckStatuses.skipped, code: 'report.ai-referral-bursts.not-configured', summary: 'No non-archived server traffic source is configured for this project.' }
    }
    const now = new Date()
    const reportMonths = reportMonthsForDoctor(ctx.reportMonth, now)
    const graded = gradedReportMonths(reportMonths, now)
    const months = reportMonths.map(month => {
      const bounds = calendarMonthBounds(month)
      const assessment = buildReferralAssessment(ctx.db, ctx.project!.name, { startDate: bounds.since.slice(0, 10), endDate: bounds.until.slice(0, 10), limit: 1 })
      // `evidence.total` counts source × product × normalized path × UTC hour
      // groups, not hours: one hour can hold several candidate groups.
      // Through day 3 the new month is shown but only the closed month is graded.
      return { month, graded: graded.has(month), comparison: assessment.comparison, suspected: assessment.totals.suspected, candidateGroups: assessment.evidence.total, rule: assessment.rule }
    })
    // Coverage is unproven by construction, so it cannot be the signal: warn
    // only when threshold-qualified bursts exist to review. A high observed
    // quotient stays descriptive, never a warning.
    const bursts = months.filter(month => month.graded && month.suspected.total > 0)
    if (bursts.length === 0) {
      return {
        status: CheckStatuses.ok,
        code: 'report.ai-referral-bursts.no-bursts',
        summary: `No threshold-qualified AI referral bursts in ${months.filter(month => month.graded).map(month => month.month).join(', ')}. Server/GA matching coverage stays unproven, so any observed quotient is descriptive only.`,
        details: { months },
      }
    }
    const first = bursts[0]!
    return {
      status: CheckStatuses.warn,
      code: 'report.ai-referral-bursts.bursts',
      summary: `${bursts.map(month => `${month.month}: ${month.suspected.total} suspected hits in ${month.candidateGroups} candidate group${month.candidateGroups === 1 ? '' : 's'}`).join('; ')}. Raw headlines are unchanged; review before quoting AI referral totals.`,
      remediation: `Inspect canonry traffic referral-assessment ${ctx.project.name} --start-date ${first.month}-01 --end-date ${calendarMonthBounds(first.month).until.slice(0, 10)} --format json. A candidate group is one source, product, normalized path and UTC hour whose countable hits reach the threshold; it is not confirmed automation. Current records cannot verify complete server intervals or the GA reporting timezone. Keep raw counts and GA evidence separate; a high quotient does not confirm automation.`,
      details: { months },
    }
  },
}]

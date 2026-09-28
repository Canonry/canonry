import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, gradedReportMonths, reportMonthsForDoctor, RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import { querySnapshots, runs } from '@ainyc/canonry-db'
import { notProbeRun } from '../../helpers.js'
import { readVisibilityContinuity } from '../../visibility-stats.js'
import type { CheckDefinition } from '../types.js'

export const reportModelsCheck: CheckDefinition = {
  id: 'report.models', category: CheckCategories.providers, scope: CheckScopes.project,
  notificationPolicy: CheckNotificationPolicies.silent, title: 'Monthly report model continuity',
  run(ctx) {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.models.no-project', summary: 'Project context required.' }
    const now = new Date()
    const reportMonths = reportMonthsForDoctor(ctx.reportMonth, now)
    const graded = gradedReportMonths(reportMonths, now)
    const months = reportMonths.flatMap(month => {
      const bounds = calendarMonthBounds(month)
      const previous = new Date(Date.parse(bounds.since) - 1).toISOString().slice(0, 7)
      const observations = ctx.db.select({ provider: querySnapshots.provider, model: querySnapshots.model, at: runs.createdAt })
        .from(querySnapshots).innerJoin(runs, eq(runs.id, querySnapshots.runId))
        .where(and(eq(runs.projectId, ctx.project!.id), eq(runs.kind, RunKinds['answer-visibility']), inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]), notProbeRun(), gte(runs.createdAt, bounds.since), lte(runs.createdAt, bounds.until))).all()
      // The comparison's own gates, without its answer-matching metrics: the
      // project frame always, and the frozen class frame when it applies.
      return readVisibilityContinuity(ctx.db, ctx.project!.name, { from: previous, to: month }).map(({ frame, continuity }) => ({
        month,
        previousMonth: previous,
        // Through day 3 the new month is shown but only the closed month is graded.
        graded: graded.has(month),
        selection: {},
        frame,
        continuity: continuity.status,
        providers: continuity.providers.map(provider => {
          const modelDates = provider.toModels.map(model => ({
            model,
            firstObservedAt: observations.filter(observation => observation.provider === provider.provider && observation.model?.trim() === model)
              .map(observation => observation.at).sort()[0] ?? null,
          }))
          const addedModelDates = modelDates.filter(model => !provider.fromModels.includes(model.model))
          return {
            ...provider,
            // Dates are project observations in this report month, not provider deployment dates.
            firstObservedAtBasis: 'new-project-provider-model-in-report-month',
            firstObservedAt: addedModelDates.map(model => model.firstObservedAt).filter((at): at is string => at !== null).sort()[0] ?? null,
            modelDates,
          }
        }),
      }))
    })
    const frameLabel = (month: (typeof months)[number]) => month.frame === 'class' ? `${month.month}, class basket` : month.month
    const gradedMonths = months.filter(month => month.graded)
    const excluded = gradedMonths.flatMap(month => month.providers.filter(provider => provider.status !== 'included').map(provider => `${provider.provider}: ${provider.fromModels.join(', ') || 'unknown'} → ${provider.toModels.join(', ') || 'unknown'} (${frameLabel(month)}; ${provider.firstObservedAt ? `new model first observed ${provider.firstObservedAt}` : 'change date unknown'})`))
    const insufficient = gradedMonths.filter(month => month.providers.length === 0)
    const flagged = gradedMonths.find(month => month.providers.length === 0 || month.providers.some(provider => provider.status !== 'included')) ?? gradedMonths[0]!
    return {
      status: excluded.length || insufficient.length ? CheckStatuses.warn : CheckStatuses.ok,
      code: excluded.length ? 'report.models.excluded' : insufficient.length ? 'report.models.insufficient' : 'report.models.continuous',
      summary: excluded.length
        ? `Monthly comparison excludes ${excluded.join('; ')}.`
        : insufficient.length
          ? `No common query/provider evidence establishes model continuity for ${insufficient.map(frameLabel).join(', ')}.`
          : 'All compared providers have continuous snapshot model evidence.',
      remediation: excluded.length || insufficient.length ? `Inspect canonry visibility-compare ${ctx.project.name} --from ${flagged.previousMonth} --to ${flagged.month} --format json; do not pool excluded providers into a trend.` : null,
      details: { months },
    }
  },
}

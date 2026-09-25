import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses, reportMonthsForDoctor, RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import { querySnapshots, runs } from '@ainyc/canonry-db'
import { notProbeRun } from '../../helpers.js'
import { readVisibilityCompare } from '../../visibility-stats.js'
import type { CheckDefinition } from '../types.js'

export const reportModelsCheck: CheckDefinition = {
  id: 'report.models', category: CheckCategories.providers, scope: CheckScopes.project,
  notificationPolicy: CheckNotificationPolicies.silent, title: 'Monthly report model continuity',
  run(ctx) {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.models.no-project', summary: 'Project context required.' }
    const months = reportMonthsForDoctor(ctx.reportMonth).map(month => {
      const bounds = calendarMonthBounds(month)
      const previous = new Date(Date.parse(bounds.since) - 1).toISOString().slice(0, 7)
      const comparison = readVisibilityCompare(ctx.db, ctx.project!.name, { from: previous, to: month })
      const frame = comparison.classComparison ?? comparison
      const observations = ctx.db.select({ provider: querySnapshots.provider, model: querySnapshots.model, at: runs.createdAt })
        .from(querySnapshots).innerJoin(runs, eq(runs.id, querySnapshots.runId))
        .where(and(eq(runs.projectId, ctx.project!.id), eq(runs.kind, RunKinds['answer-visibility']), inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]), notProbeRun(), gte(runs.createdAt, bounds.since), lte(runs.createdAt, bounds.until))).all()
      const providers = frame.continuity.providers.map(provider => {
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
      })
      return { month, previousMonth: previous, selection: comparison.selection ?? { scope: 'project' }, continuity: frame.continuity.status, providers }
    })
    const excluded = months.flatMap(month => month.providers.filter(provider => provider.status !== 'included').map(provider => `${provider.provider}: ${provider.fromModels.join(', ') || 'unknown'} → ${provider.toModels.join(', ') || 'unknown'} (${month.month}; ${provider.firstObservedAt ? `new model first observed ${provider.firstObservedAt}` : 'change date unknown'})`))
    const insufficient = months.some(month => month.providers.length === 0)
    return {
      status: excluded.length || insufficient ? CheckStatuses.warn : CheckStatuses.ok,
      code: excluded.length ? 'report.models.excluded' : insufficient ? 'report.models.insufficient' : 'report.models.continuous',
      summary: excluded.length ? `Monthly comparison excludes ${excluded.join('; ')}.` : insufficient ? 'No common query/provider evidence establishes model continuity for every report month.' : 'All compared providers have continuous snapshot model evidence.',
      remediation: excluded.length || insufficient ? `Inspect canonry visibility-compare ${ctx.project.name} --from ${months[0]!.previousMonth} --to ${months[0]!.month} --format json; do not pool excluded providers into a trend.` : null,
      details: { months },
    }
  },
}

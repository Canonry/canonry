import { and, eq, getTableColumns, gte, lte } from 'drizzle-orm'
import {
  calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION, parseStoredMeasurementPlanAnyVersion,
  reportMonthsForDoctor, RunKinds, RunStatuses, simpleMeasurementDefinitionSchema,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, projects, queries, querySnapshots, runs, simpleMeasurementDefinitions } from '@ainyc/canonry-db'
import { notProbeRun } from '../../helpers.js'
import { buildMeasurementPlanV2ReportInput, measurementRunExpectedSlots } from '../../measurement-report-adapter.js'
import { buildQueryAttribution, resolveCurrentQuery } from '../../visibility-attribution.js'
import type { CheckDefinition, DoctorContext } from '../types.js'

// Raw provider payloads are irrelevant to sweep completeness and can dwarf all other columns.
const { rawResponse: ignoredRawResponse, ...snapshotColumns } = getTableColumns(querySnapshots)
void ignoredRawResponse

type StoredRun = typeof runs.$inferSelect
function inspectSweep(ctx: DoctorContext, run: StoredRun) {
  const base = { runId: run.id, planVersionId: run.measurementPlanVersionId }
  if (run.measurementScope !== null) return { ...base, complete: false, reason: 'spot-check' }
  if (run.status !== RunStatuses.completed && run.status !== RunStatuses.partial) return { ...base, complete: false, reason: 'not-terminal' }
  const snapshots = ctx.db.select(snapshotColumns).from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
  if (snapshots.length === 0) return { ...base, complete: false, reason: 'no-answers' }
  try {
    if (run.measurementPlanVersionId) {
      const version = ctx.db.select().from(measurementPlanVersions).where(and(eq(measurementPlanVersions.projectId, ctx.project!.id), eq(measurementPlanVersions.id, run.measurementPlanVersionId))).get()
      if (!version) return { ...base, complete: false, reason: 'missing-plan' }
      const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
      if (plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) return { ...base, complete: false, reason: 'legacy-plan-unverified' }
      // Validate the manifest against its frozen graph. A truncated manifest is not a full sweep.
      const manifest = measurementRunExpectedSlots(run, plan)
      const { input } = buildMeasurementPlanV2ReportInput(version.revision, plan, manifest, snapshots.map(s => ({ ...s, rawResponse: null })))
      const expected = new Set(input.expectedSlots.map(slot => JSON.stringify([slot.executionId, slot.provider])))
      const recorded = new Set<string>()
      let ambiguous = false
      for (const observation of input.observations) {
        const key = JSON.stringify([observation.executionId, observation.provider])
        if (!expected.has(key) || recorded.has(key) || observation.answerText === null) { ambiguous = true; continue }
        recorded.add(key)
      }
      return {
        ...base, complete: expected.size > 0 && !ambiguous && recorded.size === expected.size,
        reason: 'frozen-plan', expected: expected.size, answered: recorded.size,
        targetKeys: plan.targets.map(target => target.stableKey),
        marketKeys: (plan.reportingScopes ?? []).map(market => market.stableKey),
        queryClasses: [...new Set(plan.assignments.map(assignment => assignment.queryClass))],
        providers: [...new Set(manifest.expectedSlots.map(slot => slot.provider))],
      }
    }
    const stored = ctx.db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, run.id)).get()
    const frozen = stored ? simpleMeasurementDefinitionSchema.parse(stored.definition) : null
    const project = ctx.db.select().from(projects).where(eq(projects.id, ctx.project!.id)).get()!
    const basket = frozen ? frozen.queries.map(query => ({ id: query.queryId, query: query.queryText }))
      : ctx.db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
    const providers = frozen ? frozen.engines.map(engine => engine.provider) : project.providers
    const attribution = buildQueryAttribution(basket)
    const expected = new Set(basket.flatMap(query => providers.map(provider => JSON.stringify([query.id, provider.trim().toLowerCase()]))))
    const recorded = new Set<string>()
    for (const snapshot of snapshots) {
      const query = resolveCurrentQuery(attribution, snapshot)
      if (!query || (snapshot.answerMentioned === null && !snapshot.answerText)) continue
      const key = JSON.stringify([query.id, snapshot.provider.trim().toLowerCase()])
      if (expected.has(key)) recorded.add(key)
    }
    return { ...base, complete: expected.size > 0 && recorded.size === expected.size, reason: frozen ? 'frozen-simple' : 'current-basket', expected: expected.size, answered: recorded.size, providers }
  } catch {
    return { ...base, complete: false, reason: 'unreadable-evidence' }
  }
}

export const reportSweepsCheck: CheckDefinition = {
  id: 'report.sweeps', category: CheckCategories.schedules, scope: CheckScopes.project,
  notificationPolicy: CheckNotificationPolicies.silent, title: 'Monthly report sweep readiness',
  run(ctx) {
    if (!ctx.project) return { status: CheckStatuses.skipped, code: 'report.sweeps.no-project', summary: 'Project context required.' }
    const now = new Date()
    const months = reportMonthsForDoctor(ctx.reportMonth, now).map(month => {
      const bounds = calendarMonthBounds(month)
      const monthRuns = ctx.db.select().from(runs).where(and(eq(runs.projectId, ctx.project!.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun(), gte(runs.createdAt, bounds.since), lte(runs.createdAt, bounds.until))).all()
      const evidence = monthRuns.map(run => inspectSweep(ctx, run))
      return { month, daysRemaining: Math.max(0, Math.ceil((Date.parse(bounds.until) - Date.now()) / 86_400_000) - 1), eligibleRunIds: evidence.filter(run => run.complete).map(run => run.runId), runs: evidence }
    })
    const missing = months.filter(month => month.eligibleRunIds.length === 0)
    return {
      status: missing.length ? CheckStatuses.warn : CheckStatuses.ok,
      code: missing.length ? 'report.sweeps.missing' : 'report.sweeps.ready',
      summary: missing.length ? `No complete whole-project sweep for ${missing.map(month => `${month.month} (${month.daysRemaining} days left)`).join(', ')}.` : `Complete whole-project sweep available for ${months.map(month => month.month).join(', ')}.`,
      remediation: missing.length ? `Review the monthly schedule and sweep scope for ${ctx.project.name}; running a sweep spends provider quota.` : null,
      details: { months },
    }
  },
}

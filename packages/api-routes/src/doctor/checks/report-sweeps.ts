import { and, asc, eq, gte, lte } from 'drizzle-orm'
import {
  calendarMonthBounds, CheckCategories, CheckNotificationPolicies, CheckScopes, CheckStatuses,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION, parseStoredMeasurementPlanAnyVersion,
  reportMonthsForDoctor, RunKinds, RunStatuses, simpleMeasurementDefinitionSchema,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, projects, queries, querySnapshots, runs, simpleMeasurementDefinitions } from '@ainyc/canonry-db'
import { notProbeRun } from '../../helpers.js'
import { measurementRunExpectedSlots } from '../../measurement-report-adapter.js'
import { measurementSlotKey } from '../../measurement-run-completeness.js'
import { buildQueryAttribution, resolveCurrentQuery } from '../../visibility-attribution.js'
import type { CheckDefinition, DoctorContext } from '../types.js'

type StoredRun = typeof runs.$inferSelect

/** The slots one run was expected to answer and the ones it usably answered. */
interface SlotCoverage {
  /** Runs with the same expected slots measure the same thing and pool into one month. */
  signature: string
  expected: ReadonlySet<string>
  answered: ReadonlySet<string>
}

function slotCoverage(expected: ReadonlySet<string>, answered: ReadonlySet<string>): SlotCoverage {
  return { signature: JSON.stringify([...expected].sort()), expected, answered }
}

function inspectSweep(ctx: DoctorContext, run: StoredRun): { detail: Record<string, unknown>; coverage?: SlotCoverage } {
  const base = { runId: run.id, planVersionId: run.measurementPlanVersionId }
  if (run.measurementScope !== null) return { detail: { ...base, complete: false, reason: 'spot-check' } }
  if (run.status !== RunStatuses.completed && run.status !== RunStatuses.partial) return { detail: { ...base, complete: false, reason: 'not-terminal' } }
  // Raw provider payloads are irrelevant to sweep coverage and can dwarf every other column.
  const snapshots = ctx.db.select({
    queryId: querySnapshots.queryId,
    queryText: querySnapshots.queryText,
    provider: querySnapshots.provider,
    answerMentioned: querySnapshots.answerMentioned,
    answerText: querySnapshots.answerText,
    measurementExecutionId: querySnapshots.measurementExecutionId,
  }).from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
  if (snapshots.length === 0) return { detail: { ...base, complete: false, reason: 'no-answers' } }
  try {
    if (run.measurementPlanVersionId) {
      const version = ctx.db.select().from(measurementPlanVersions).where(and(eq(measurementPlanVersions.projectId, ctx.project!.id), eq(measurementPlanVersions.id, run.measurementPlanVersionId))).get()
      if (!version) return { detail: { ...base, complete: false, reason: 'missing-plan' } }
      const plan = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
      // Validate the manifest against its frozen graph (either schema). A
      // truncated manifest is not a full sweep.
      const manifest = measurementRunExpectedSlots(run, plan)
      const expected = new Set(manifest.expectedSlots.map(slot => measurementSlotKey(slot.executionId, slot.provider)))
      const answered = new Set<string>()
      let unbound = false
      for (const snapshot of snapshots) {
        const executionId = snapshot.measurementExecutionId?.trim()
        // An answer with no execution id cannot be reconciled to the frozen denominator.
        if (!executionId) { unbound = true; continue }
        const key = measurementSlotKey(executionId, snapshot.provider)
        if (expected.has(key) && snapshot.answerText !== null) answered.add(key)
      }
      const detail = {
        ...base, schemaVersion: plan.schemaVersion,
        complete: expected.size > 0 && !unbound && answered.size === expected.size,
        reason: unbound ? 'unbound-answers' : 'frozen-plan', expected: expected.size, answered: answered.size,
        providers: [...new Set(manifest.expectedSlots.map(slot => slot.provider))],
        ...(plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION ? {
          targetKeys: plan.targets.map(target => target.stableKey),
          marketKeys: (plan.reportingScopes ?? []).map(market => market.stableKey),
          queryClasses: [...new Set(plan.assignments.map(assignment => assignment.queryClass))],
        } : {}),
      }
      return unbound ? { detail } : { detail, coverage: slotCoverage(expected, answered) }
    }
    const stored = ctx.db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, run.id)).get()
    const frozen = stored ? simpleMeasurementDefinitionSchema.parse(stored.definition) : null
    const project = ctx.db.select().from(projects).where(eq(projects.id, ctx.project!.id)).get()!
    const basket = frozen ? frozen.queries.map(query => ({ id: query.queryId, query: query.queryText }))
      : ctx.db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
    const providers = frozen ? frozen.engines.map(engine => engine.provider) : project.providers
    const attribution = buildQueryAttribution(basket)
    const expected = new Set(basket.flatMap(query => providers.map(provider => JSON.stringify([query.id, provider.trim().toLowerCase()]))))
    const answered = new Set<string>()
    for (const snapshot of snapshots) {
      const query = resolveCurrentQuery(attribution, snapshot)
      if (!query || (snapshot.answerMentioned === null && !snapshot.answerText)) continue
      const key = JSON.stringify([query.id, snapshot.provider.trim().toLowerCase()])
      if (expected.has(key)) answered.add(key)
    }
    return {
      detail: { ...base, complete: expected.size > 0 && answered.size === expected.size, reason: frozen ? 'frozen-simple' : 'current-basket', expected: expected.size, answered: answered.size, providers },
      coverage: slotCoverage(expected, answered),
    }
  } catch {
    return { detail: { ...base, complete: false, reason: 'unreadable-evidence' } }
  }
}

/**
 * A month is ready when its whole-project sweeps together answered every slot
 * they were expected to, as the monthly comparison pools a month's answers:
 * a slot one sweep missed and another answered is covered. Only sweeps with
 * the same expected slots pool, so a plan change never lends coverage across
 * definitions.
 */
function monthCoverage(evidence: ReadonlyArray<{ detail: Record<string, unknown>; coverage?: SlotCoverage }>) {
  const groups = new Map<string, { expected: ReadonlySet<string>; answered: Set<string>; runIds: string[] }>()
  for (const { detail, coverage } of evidence) {
    if (!coverage) continue
    const group = groups.get(coverage.signature) ?? { expected: coverage.expected, answered: new Set<string>(), runIds: [] }
    for (const key of coverage.answered) group.answered.add(key)
    group.runIds.push(String(detail.runId))
    groups.set(coverage.signature, group)
  }
  const ranked = [...groups.values()]
    .map(group => ({ ...group, covered: group.expected.size > 0 && [...group.expected].every(key => group.answered.has(key)) }))
    .sort((left, right) => Number(right.covered) - Number(left.covered)
      || right.answered.size / Math.max(1, right.expected.size) - left.answered.size / Math.max(1, left.expected.size))
  const best = ranked[0]
  return {
    eligibleRunIds: ranked.filter(group => group.covered).flatMap(group => group.runIds),
    coverage: best ? { expected: best.expected.size, answered: best.answered.size, sweeps: best.runIds.length } : null,
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
      const monthRuns = ctx.db.select().from(runs)
        .where(and(eq(runs.projectId, ctx.project!.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun(), gte(runs.createdAt, bounds.since), lte(runs.createdAt, bounds.until)))
        .orderBy(asc(runs.createdAt), asc(runs.id)).all()
      const evidence = monthRuns.map(run => inspectSweep(ctx, run))
      return {
        month,
        daysRemaining: Math.max(0, Math.ceil((Date.parse(bounds.until) - Date.now()) / 86_400_000) - 1),
        ...monthCoverage(evidence),
        runs: evidence.map(run => run.detail),
      }
    })
    const missing = months.filter(month => month.eligibleRunIds.length === 0)
    return {
      status: missing.length ? CheckStatuses.warn : CheckStatuses.ok,
      code: missing.length ? 'report.sweeps.missing' : 'report.sweeps.ready',
      summary: missing.length
        ? `Whole-project sweeps do not yet answer every expected slot for ${missing.map(month => `${month.month} (${month.daysRemaining} days left)`).join(', ')}.`
        : `Whole-project sweeps answer every expected slot for ${months.map(month => month.month).join(', ')}.`,
      remediation: missing.length ? `Review the monthly schedule and sweep scope for ${ctx.project.name}; running a sweep spends provider quota.` : null,
      details: { months },
    }
  },
}

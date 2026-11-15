/**
 * How one Property's mention and citation moved between two Advanced sweeps.
 *
 * The overview's "What changed" counts the losses and the change webhooks
 * send both directions, and they read every answer through the same rule, so
 * an alert never names a change the dashboard does not show. A Property's
 * mention and citation come from the frozen report kernel (the run's
 * reconstructed definition and observations), never from the project-level
 * snapshot columns, which describe the project's own brand and domain.
 *
 * Mention and citation are compared apart; neither is read from the other.
 * An answer whose state is unknown on a signal moves neither in nor out of it.
 */

import { and, eq } from 'drizzle-orm'
import { measurementPlanVersions, runs, type DatabaseClient } from '@canonry/canonry-db'
import {
  CitationStates,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  compareText,
  MentionStates,
  type CitationState,
  type MentionState,
  type OverviewWhatChangedComparisonDto,
  type QueryClass,
  visibilityReportPopulationClassSchema,
} from '@canonry/canonry-contracts'
import {
  pairContinuity,
  type VisibilityReportObservationInput,
  type VisibilityReportPreviousRunInput,
  type VisibilityReportRunInput,
  type VisibilityReportTargetInput,
} from './visibility-report-reader.js'
import { readAdvancedSweepPair, type OverviewAdvancedSweeps } from './visibility-report.js'

export type AdvancedUnavailableReason = Extract<OverviewWhatChangedComparisonDto, { state: 'unavailable' }>['reason']

type AdvancedComparisonBasis =
  | { state: 'available'; previous: VisibilityReportRunInput }
  | { state: 'unavailable'; reason: AdvancedUnavailableReason }

/**
 * Whether a sweep can be compared with the one before it, under the visibility
 * report's continuity rule (same plan definition chain, same engines and
 * models, neither sweep partial). `since` is a reader's window: an earlier
 * sweep before it is not a previous check.
 */
function advancedComparisonBasis(
  current: VisibilityReportRunInput,
  previous: VisibilityReportPreviousRunInput | null,
  since: string | null,
): AdvancedComparisonBasis {
  if (previous === null) return { state: 'unavailable', reason: 'no-previous-check' }
  if ('unreadable' in previous) return { state: 'unavailable', reason: 'unreadable' }
  // A schema v1 predecessor has no frozen v2 definition to compare with.
  if ('incomparable' in previous) return { state: 'unavailable', reason: 'definition-changed' }
  if (since !== null && previous.run.createdAt < since) return { state: 'unavailable', reason: 'no-previous-check' }
  switch (pairContinuity(previous.run, current)) {
    case 'comparable':
      break
    case 'model-changed':
      return { state: 'unavailable', reason: 'model-changed' }
    case 'definition-changed':
    case 'legacy-unknown':
      return { state: 'unavailable', reason: 'definition-changed' }
  }
  if (current.state === 'partial' || previous.run.state === 'partial') return { state: 'unavailable', reason: 'partial-run' }
  return { state: 'available', previous: previous.run }
}

type SignalChange = 'lost' | 'gained' | null

/**
 * One Property's mention on one answer: null when it is unknown. An aliasless
 * Property has no mention to measure, and an answer whose mention check did
 * not complete, or whose identity for this Property is unresolved, is unknown
 * unless it names the Property anyway.
 */
function mentionOf(target: VisibilityReportTargetInput, answer: VisibilityReportObservationInput): boolean | null {
  if (!target.mentionEligible) return null
  if (answer.mentionedTargetKeys.includes(target.id)) return true
  if (answer.mentionComplete === false || (answer.unknownMentionTargetKeys ?? []).includes(target.id)) return null
  return false
}

/**
 * One Property's citation on one answer: null when it is unknown. An engine
 * that returns no sources measured no citation, and a citation read from an
 * incomplete source capture is unknown either way.
 */
function citedOf(target: VisibilityReportTargetInput, answer: VisibilityReportObservationInput): boolean | null {
  if (answer.citationMeasured === false || !answer.citationComplete) return null
  return answer.citedTargetKeys.includes(target.id)
}

function change(before: boolean | null, now: boolean | null): SignalChange {
  if (before === null || now === null || before === now) return null
  return now ? 'gained' : 'lost'
}

/** How one Property's mention moved between two answers of the same slot. */
function advancedMentionChange(
  target: VisibilityReportTargetInput,
  before: VisibilityReportObservationInput,
  now: VisibilityReportObservationInput,
): SignalChange {
  return change(mentionOf(target, before), mentionOf(target, now))
}

/** How one Property's citation moved between two answers of the same slot. */
function advancedCitationChange(
  target: VisibilityReportTargetInput,
  before: VisibilityReportObservationInput,
  now: VisibilityReportObservationInput,
): SignalChange {
  return change(citedOf(target, before), citedOf(target, now))
}

/** One Property's answer that changed on one signal. */
export interface AdvancedSignalTransition<State extends string> {
  query: string
  queryId: string | null
  provider: string
  location: string | null
  from: State
  to: State
  /** Null when the Property's assignments of this query disagree, or carry no class. */
  queryClass: QueryClass | null
  property: { key: string; label: string }
  /** Frozen reporting markets of the Property's assignments of this query, by label. */
  markets: Array<{ key: string; label: string }>
}

export type AdvancedSignalTransitions =
  | {
    state: 'available'
    previousRunId: string
    citation: Array<AdvancedSignalTransition<CitationState>>
    mention: Array<AdvancedSignalTransition<MentionState>>
  }
  | { state: 'unavailable'; reason: AdvancedUnavailableReason }

function compareTransitions(left: AdvancedSignalTransition<string>, right: AdvancedSignalTransition<string>): number {
  return compareText(left.query, right.query)
    || compareText(left.provider, right.provider)
    || compareText(left.location ?? '', right.location ?? '')
    || compareText(left.property.label, right.property.label)
    || compareText(left.property.key, right.property.key)
}

/**
 * Every Property answer whose mention or citation moved between the sweep the
 * pair holds and the comparable sweep before it, one per slot and Property
 * however many assignments link them. `since` is a reader's window: a
 * previous sweep before it is no previous check. The overview's What changed
 * keeps the losses; the change webhooks send both directions.
 */
export function advancedSignalTransitions(sweeps: Extract<OverviewAdvancedSweeps, { plan: 'v2' }>, since: string | null = null): AdvancedSignalTransitions {
  const { current } = sweeps
  if (current === null) return { state: 'unavailable', reason: 'not-measured' }
  const basis = advancedComparisonBasis(current, sweeps.previous, since)
  if (basis.state === 'unavailable') return basis

  const { definition } = current
  const targets = new Map(definition.targets.map(target => [target.id, target]))
  const marketLabels = new Map(definition.scopeOptions
    .filter(option => option.kind === 'market')
    .map(option => [option.id, option.label]))
  const edgesByExecution = new Map<string, Array<typeof definition.edges[number]>>()
  for (const edge of definition.edges) {
    const edges = edgesByExecution.get(edge.executionId)
    if (edges) edges.push(edge)
    else edgesByExecution.set(edge.executionId, [edge])
  }
  const currentBySlot = new Map(current.observations.map(observation => [observation.slotId, observation]))
  const previousBySlot = new Map(basis.previous.observations.map(observation => [observation.slotId, observation]))

  const citation: Array<AdvancedSignalTransition<CitationState>> = []
  const mention: Array<AdvancedSignalTransition<MentionState>> = []
  for (const slot of definition.slots) {
    const now = currentBySlot.get(slot.id)
    const before = previousBySlot.get(slot.id)
    // A slot either sweep did not answer has nothing to compare.
    if (now === undefined || before === undefined) continue
    const edgesByTarget = new Map<string, Array<typeof definition.edges[number]>>()
    for (const edge of edgesByExecution.get(slot.executionId) ?? []) {
      const edges = edgesByTarget.get(edge.targetKey)
      if (edges) edges.push(edge)
      else edgesByTarget.set(edge.targetKey, [edge])
    }
    for (const [targetKey, edges] of edgesByTarget) {
      const target = targets.get(targetKey)
      if (target === undefined) continue
      const classes = new Set(edges.map(edge => edge.queryClass))
      const onlyClass = classes.size === 1 ? [...classes][0] : undefined
      const marketKeys = [...new Set(edges.flatMap(edge => edge.marketKeys))]
      const answer = {
        query: slot.query,
        queryId: slot.queryId,
        provider: slot.provider,
        location: slot.location,
        queryClass: onlyClass === undefined || onlyClass === visibilityReportPopulationClassSchema.enum.unknown ? null : onlyClass,
        property: { key: target.id, label: target.label },
        markets: marketKeys
          .map(key => ({ key, label: marketLabels.get(key) ?? key }))
          .sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key)),
      }
      const mentionMoved = advancedMentionChange(target, before, now)
      if (mentionMoved !== null) {
        const [from, to] = mentionMoved === 'gained'
          ? [MentionStates['not-mentioned'], MentionStates.mentioned]
          : [MentionStates.mentioned, MentionStates['not-mentioned']]
        mention.push({ ...answer, from, to })
      }
      const citationMoved = advancedCitationChange(target, before, now)
      if (citationMoved !== null) {
        const [from, to] = citationMoved === 'gained'
          ? [CitationStates['not-cited'], CitationStates.cited]
          : [CitationStates.cited, CitationStates['not-cited']]
        citation.push({ ...answer, from, to })
      }
    }
  }
  citation.sort(compareTransitions)
  mention.sort(compareTransitions)
  return { state: 'available', previousRunId: basis.previous.id, citation, mention }
}

/**
 * The per-Property changes one run made, when it is a sweep of a schema v2
 * plan revision and the project's active plan is schema v2. Null otherwise
 * (a planless run, a run of a schema v1 revision, no active plan, or an
 * active schema v1 plan): nothing freezes a Property to compare, so the run's
 * changes are the project-level ones. Throws only when a v2 sweep's stored
 * evidence cannot be read.
 */
export function readAdvancedSignalTransitions(
  db: DatabaseClient,
  projectId: string,
  runId: string,
): AdvancedSignalTransitions | null {
  const run = db.select({ versionId: runs.measurementPlanVersionId }).from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.id, runId))).get()
  if (!run?.versionId) return null
  const version = db.select({ schemaVersion: measurementPlanVersions.schemaVersion }).from(measurementPlanVersions)
    .where(and(eq(measurementPlanVersions.projectId, projectId), eq(measurementPlanVersions.id, run.versionId))).get()
  if (version?.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) return null
  const sweeps = readAdvancedSweepPair(db, projectId, runId)
  if (sweeps === null || sweeps.plan === 'legacy') return null
  return advancedSignalTransitions(sweeps)
}

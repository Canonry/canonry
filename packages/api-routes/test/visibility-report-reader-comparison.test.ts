import { describe, expect, it } from 'vitest'
import type { VisibilityReportPopulationClass, VisibilityReportResponse } from '@ainyc/canonry-contracts'
import {
  buildVisibilityReport,
  type VisibilityReportDefinitionInput,
  type VisibilityReportReaderInput,
  type VisibilityReportReaderSelection,
  type VisibilityReportRunInput,
} from '../src/visibility-report-reader.js'

/**
 * Change since the previous eligible sweep, one comparison per query class.
 *
 * Fixture: 18 North and 18 South non-brand answers (indexes 0-8 in market
 * Alpha, 9-17 in Beta) and 6 branded North answers in Alpha. Every answer is
 * one provider slot with one frozen edge, so each numerator below is a count
 * of the answers a signal list names.
 */

const EARLIEST_AT = '2026-08-30T12:00:00.000Z'
const PREVIOUS_AT = '2026-09-06T12:00:00.000Z'
const PREVIOUS_DONE = '2026-09-06T12:40:00.000Z'
const CURRENT_AT = '2026-09-13T12:00:00.000Z'
const CURRENT_DONE = '2026-09-13T12:40:00.000Z'
const PREVIOUS_RUN = { id: 'run-previous', createdAt: PREVIOUS_AT, completedAt: PREVIOUS_DONE }

interface SlotSpec {
  id: string
  targetKey: 'north' | 'south'
  queryClass: VisibilityReportPopulationClass
  marketKey: 'alpha' | 'beta'
}

interface Signals {
  mentioned: readonly string[]
  cited: readonly string[]
}

const SLOT_SPECS: readonly SlotSpec[] = [
  ...(['north', 'south'] as const).flatMap(targetKey => Array.from({ length: 18 }, (_, index): SlotSpec => ({
    id: `${targetKey}-${index}`,
    targetKey,
    queryClass: 'non-brand',
    marketKey: index < 9 ? 'alpha' : 'beta',
  }))),
  ...Array.from({ length: 6 }, (_, index): SlotSpec => ({
    id: `brand-${index}`,
    targetKey: 'north',
    queryClass: 'branded',
    marketKey: 'alpha',
  })),
]

/** Answer ids `${prefix}-${from}` through `${prefix}-${to - 1}`. */
function answers(prefix: 'north' | 'south' | 'brand', from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, offset) => `${prefix}-${from + offset}`)
}

function combine(...parts: readonly Signals[]): Signals {
  return { mentioned: parts.flatMap(part => part.mentioned), cited: parts.flatMap(part => part.cited) }
}

/** Non-brand: 18/36 mentioned (all North), 9/36 cited, 1 of 2 Properties named. */
const PREVIOUS_NON_BRAND: Signals = { mentioned: answers('north', 0, 18), cited: answers('north', 0, 9) }
/** Non-brand: 24/36 mentioned, 12/36 cited, 2 of 2 Properties named. */
const CURRENT_NON_BRAND: Signals = {
  mentioned: [...answers('north', 0, 18), ...answers('south', 0, 6)],
  cited: answers('north', 0, 12),
}
/** Branded: 3/6 mentioned, 0/6 cited. */
const PREVIOUS_BRANDED: Signals = { mentioned: answers('brand', 0, 3), cited: [] }
/** Branded: 6/6 mentioned, 2/6 cited. */
const CURRENT_BRANDED: Signals = { mentioned: answers('brand', 0, 6), cited: answers('brand', 0, 2) }

function definition(): VisibilityReportDefinitionInput {
  return {
    revision: 3,
    provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
    scopeOptions: [
      { id: 'project', label: 'Project', kind: 'project', targetCount: 2 },
      { id: 'collection', label: 'Collection', kind: 'group', targetCount: 2 },
      { id: 'alpha', label: 'Alpha', kind: 'market', targetCount: 2 },
      { id: 'beta', label: 'Beta', kind: 'market', targetCount: 2 },
      { id: 'north', label: 'North', kind: 'property', targetCount: 1 },
      { id: 'south', label: 'South', kind: 'property', targetCount: 1 },
    ],
    targets: [
      { id: 'north', label: 'North', mentionEligible: true },
      { id: 'south', label: 'South', mentionEligible: true },
    ],
    groups: [{ id: 'collection', label: 'Collection', targetKeys: ['north', 'south'] }],
    competitorAvailability: { state: 'available' },
    slots: SLOT_SPECS.map(spec => ({
      id: spec.id,
      executionId: `exec-${spec.id}`,
      queryKey: `query-${spec.id}`,
      queryId: `q-${spec.id}`,
      query: `Query ${spec.id}`,
      provider: 'openai',
      location: null,
    })),
    edges: SLOT_SPECS.map(spec => ({
      id: `edge-${spec.id}`,
      executionId: `exec-${spec.id}`,
      targetKey: spec.targetKey,
      queryId: `q-${spec.id}`,
      queryClass: spec.queryClass,
      groupKeys: ['collection'],
      marketKeys: [spec.marketKey],
      competitorDomains: [],
    })),
  }
}

function run(
  id: string,
  createdAt: string,
  completedAt: string,
  signals: Signals,
  overrides: Partial<VisibilityReportRunInput> = {},
): VisibilityReportRunInput {
  const frozen = overrides.definition ?? definition()
  const targetByExecution = new Map(frozen.edges.map(edge => [edge.executionId, edge.targetKey]))
  const mentioned = new Set(signals.mentioned)
  const cited = new Set(signals.cited)
  return {
    id,
    createdAt,
    completedAt,
    state: 'measured',
    probe: false,
    scoped: false,
    definition: frozen,
    definitionId: 'plan-v3',
    comparableDefinitionIds: [],
    modelFingerprint: 'openai:gpt-5',
    observations: frozen.slots.map(slot => {
      const targetKey = targetByExecution.get(slot.executionId)!
      return {
        slotId: slot.id,
        answerId: `${id}:${slot.id}`,
        model: 'gpt-5',
        answerText: 'Stored answer.',
        mentionedTargetKeys: mentioned.has(slot.id) ? [targetKey] : [],
        citedTargetKeys: cited.has(slot.id) ? [targetKey] : [],
        citationComplete: true,
        competitorMentionDomains: [],
        competitorCitationDomains: [],
        observedCompetitorNames: [],
        sources: [],
        createdAt,
      }
    }),
    ...overrides,
  }
}

function previousRun(overrides: Partial<VisibilityReportRunInput> = {}, signals = combine(PREVIOUS_NON_BRAND, PREVIOUS_BRANDED)) {
  return run('run-previous', PREVIOUS_AT, PREVIOUS_DONE, signals, overrides)
}

function currentRun(overrides: Partial<VisibilityReportRunInput> = {}, signals = combine(CURRENT_NON_BRAND, PREVIOUS_BRANDED)) {
  return run('run-current', CURRENT_AT, CURRENT_DONE, signals, overrides)
}

const NON_BRAND: VisibilityReportReaderSelection = { queryClass: 'non-brand', scope: 'project', location: { kind: 'all' }, limit: 50 }
const ALL_CLASSES: VisibilityReportReaderSelection = { ...NON_BRAND, queryClass: 'all' }

function input(
  runs: readonly VisibilityReportRunInput[],
  previous: VisibilityReportReaderInput['previous'],
  selection: VisibilityReportReaderSelection = NON_BRAND,
): VisibilityReportReaderInput {
  return {
    mode: 'advanced',
    activeRevision: 3,
    pendingAssignmentCount: 0,
    selection,
    activeDefinition: definition(),
    runs,
    ...(previous === undefined ? {} : { previous }),
  }
}

function comparisonOf(report: VisibilityReportResponse, queryClass: VisibilityReportPopulationClass = 'non-brand') {
  return report.populations.find(population => population.queryClass === queryClass)?.comparison
}

/** 18/36 then 24/36 mentioned, 9/36 then 12/36 cited, 1/2 then 2/2 Properties named. */
const NON_BRAND_CHANGE = {
  state: 'available',
  previousRun: PREVIOUS_RUN,
  mentionCoverage: { state: 'available', previous: { numerator: 18, denominator: 36, rate: 0.5 }, delta: 24 / 36 - 0.5 },
  citationCoverage: { state: 'available', previous: { numerator: 9, denominator: 36, rate: 0.25 }, delta: 12 / 36 - 0.25 },
  propertyReach: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0.5 },
}

const NON_BRAND_UNCHANGED = {
  state: 'available',
  previousRun: PREVIOUS_RUN,
  mentionCoverage: { state: 'available', previous: { numerator: 18, denominator: 36, rate: 0.5 }, delta: 0 },
  citationCoverage: { state: 'available', previous: { numerator: 9, denominator: 36, rate: 0.25 }, delta: 0 },
  propertyReach: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0 },
}

/** South has no branded assignment, so branded reach is incomplete in both sweeps. */
const BRANDED_UNCHANGED = {
  state: 'available',
  previousRun: PREVIOUS_RUN,
  mentionCoverage: { state: 'available', previous: { numerator: 3, denominator: 6, rate: 0.5 }, delta: 0 },
  citationCoverage: { state: 'available', previous: { numerator: 0, denominator: 6, rate: 0 }, delta: 0 },
  propertyReach: { state: 'unavailable', reason: 'current-unavailable' },
}

const BRANDED_CHANGE = {
  state: 'available',
  previousRun: PREVIOUS_RUN,
  mentionCoverage: { state: 'available', previous: { numerator: 3, denominator: 6, rate: 0.5 }, delta: 0.5 },
  citationCoverage: { state: 'available', previous: { numerator: 0, denominator: 6, rate: 0 }, delta: 2 / 6 },
  propertyReach: { state: 'unavailable', reason: 'current-unavailable' },
}

describe('visibility report comparison math', () => {
  it('returns the previous rate and the exact server delta for 18/36 then 24/36', () => {
    const report = buildVisibilityReport(input([previousRun(), currentRun()], { run: previousRun() }))
    const population = report.populations[0]!

    expect(population.summary.mentionCoverage).toEqual({ numerator: 24, denominator: 36, rate: 24 / 36 })
    expect(population.summary.citationCoverage).toEqual({ numerator: 12, denominator: 36, rate: 12 / 36 })
    expect(population.summary.propertyReach).toEqual({ numerator: 2, denominator: 2, rate: 1 })
    expect(population.comparison).toEqual(NON_BRAND_CHANGE)
    expect(population).toHaveProperty(['comparison', 'mentionCoverage', 'previous', 'rate'], 0.5)
    // Unrounded current minus previous, never a display value.
    expect(population).toHaveProperty(['comparison', 'mentionCoverage', 'delta'], 0.16666666666666663)
  })

  it('reports an unchanged rate as an available zero change', () => {
    const unchanged = currentRun({}, combine(PREVIOUS_NON_BRAND, PREVIOUS_BRANDED))
    const report = buildVisibilityReport(input([previousRun(), unchanged], { run: previousRun() }))

    expect(report.populations[0]!.comparison).toEqual(NON_BRAND_UNCHANGED)
    expect(report.populations[0]).toHaveProperty(['comparison', 'citationCoverage', 'delta'], 0)
  })

  it('reports no-previous-run for the first sweep', () => {
    const report = buildVisibilityReport(input([currentRun()], null, ALL_CLASSES))

    expect(report.populations.map(population => population.comparison)).toEqual([
      { state: 'unavailable', reason: 'no-previous-run', previousRun: null },
      { state: 'unavailable', reason: 'no-previous-run', previousRun: null },
      { state: 'unavailable', reason: 'no-previous-run', previousRun: null },
    ])
  })

  it('reports no-selected-run when no sweep is selected', () => {
    const report = buildVisibilityReport(input([], null, ALL_CLASSES))

    expect(report.selection.run.id).toBeNull()
    expect(report.populations.map(population => population.comparison)).toEqual([
      { state: 'unavailable', reason: 'no-selected-run', previousRun: null },
      { state: 'unavailable', reason: 'no-selected-run', previousRun: null },
      { state: 'unavailable', reason: 'no-selected-run', previousRun: null },
    ])
  })

  it('omits the field when the caller does not request a comparison', () => {
    const report = buildVisibilityReport(input([previousRun(), currentRun()], undefined, ALL_CLASSES))

    expect(report.populations.map(population => Object.hasOwn(population, 'comparison'))).toEqual([false, false, false])
  })
})

describe('visibility report comparison availability', () => {
  it('reports definition-changed for a material publication or an incomparable predecessor', () => {
    const material = previousRun({ definitionId: 'plan-v2' })
    const changed = buildVisibilityReport(input([material, currentRun()], { run: material }))
    expect(comparisonOf(changed)).toEqual({ state: 'unavailable', reason: 'definition-changed', previousRun: PREVIOUS_RUN })
    // The trend boundary and the comparison use one continuity rule.
    expect(changed.populations[0]!.trend[1]!.continuity).toEqual({ state: 'definition-changed', comparedRunId: 'run-previous' })

    const incomparable = buildVisibilityReport(input([currentRun()], { incomparable: PREVIOUS_RUN }))
    expect(comparisonOf(incomparable)).toEqual({ state: 'unavailable', reason: 'definition-changed', previousRun: PREVIOUS_RUN })

    const relabelled = currentRun({ definitionId: 'plan-v4', comparableDefinitionIds: ['plan-v4', 'plan-v3'] })
    const labelOnly = buildVisibilityReport(input([previousRun(), relabelled], { run: previousRun() }))
    expect(comparisonOf(labelOnly)).toEqual(NON_BRAND_CHANGE)
  })

  it('reports model-changed when either sweep has a different or unknown model series', () => {
    for (const modelFingerprint of ['openai:gpt-4.1', null]) {
      const previous = previousRun({ modelFingerprint })
      const report = buildVisibilityReport(input([previous, currentRun()], { run: previous }))
      expect(comparisonOf(report)).toEqual({ state: 'unavailable', reason: 'model-changed', previousRun: PREVIOUS_RUN })
      expect(report.populations[0]!.trend[1]!.continuity.state).toBe('model-changed')
    }
  })

  it('reports legacy-unknown when either sweep is legacy simple history', () => {
    const legacy: VisibilityReportDefinitionInput = {
      ...definition(),
      revision: null,
      provenance: { kind: 'legacy-simple', definitionRevision: null },
    }
    const legacyPrevious = previousRun({ definition: legacy, definitionId: null })
    const olderLegacy = buildVisibilityReport(input([legacyPrevious, currentRun()], { run: legacyPrevious }))
    expect(comparisonOf(olderLegacy)).toEqual({ state: 'unavailable', reason: 'legacy-unknown', previousRun: PREVIOUS_RUN })

    const legacyCurrent = currentRun({ definition: legacy, definitionId: null })
    const newerLegacy = buildVisibilityReport(input([previousRun(), legacyCurrent], { run: previousRun() }))
    expect(comparisonOf(newerLegacy)).toEqual({ state: 'unavailable', reason: 'legacy-unknown', previousRun: PREVIOUS_RUN })
  })

  it('reports partial-run when the selected or the previous sweep was partial', () => {
    const partialCurrent = buildVisibilityReport(input([previousRun(), currentRun({ state: 'partial' })], { run: previousRun() }))
    expect(comparisonOf(partialCurrent)).toEqual({ state: 'unavailable', reason: 'partial-run', previousRun: PREVIOUS_RUN })

    const partialPrevious = previousRun({ state: 'partial' })
    const report = buildVisibilityReport(input([partialPrevious, currentRun()], { run: partialPrevious }))
    expect(comparisonOf(report)).toEqual({ state: 'unavailable', reason: 'partial-run', previousRun: PREVIOUS_RUN })
  })

  it('reports scoped-run for a selected spot check without naming a previous sweep', () => {
    const report = buildVisibilityReport(input([previousRun(), currentRun({ scoped: true })], { run: previousRun() }))

    expect(comparisonOf(report)).toEqual({ state: 'unavailable', reason: 'scoped-run', previousRun: null })
  })

  it.each([
    {
      name: 'a spot check before a missing predecessor',
      current: { scoped: true },
      previous: null,
      expected: { state: 'unavailable', reason: 'scoped-run', previousRun: null },
    },
    {
      name: 'a spot check before a partial sweep',
      current: { scoped: true, state: 'partial' as const },
      previous: { run: previousRun() },
      expected: { state: 'unavailable', reason: 'scoped-run', previousRun: null },
    },
    {
      name: 'a missing predecessor before a partial sweep',
      current: { state: 'partial' as const },
      previous: null,
      expected: { state: 'unavailable', reason: 'no-previous-run', previousRun: null },
    },
    {
      name: 'an incomparable predecessor before a partial sweep',
      current: { state: 'partial' as const },
      previous: { incomparable: PREVIOUS_RUN },
      expected: { state: 'unavailable', reason: 'definition-changed', previousRun: PREVIOUS_RUN },
    },
    {
      name: 'a model change before a partial sweep',
      current: { state: 'partial' as const },
      previous: { run: previousRun({ modelFingerprint: 'openai:gpt-4.1', state: 'partial' }) },
      expected: { state: 'unavailable', reason: 'model-changed', previousRun: PREVIOUS_RUN },
    },
  ])('checks $name in order', ({ current, previous, expected }) => {
    const report = buildVisibilityReport(input([currentRun(current)], previous))

    expect(comparisonOf(report)).toEqual(expected)
  })
})

describe('visibility report comparison selection', () => {
  it('marks every metric previous-unavailable when the older definition lacks the selected scope', () => {
    const base = definition()
    const withCoastal: VisibilityReportDefinitionInput = {
      ...base,
      groups: [...base.groups, { id: 'coastal', label: 'Coastal', targetKeys: ['north', 'south'] }],
      scopeOptions: [...base.scopeOptions, { id: 'coastal', label: 'Coastal', kind: 'group', targetCount: 2 }],
    }
    const selection: VisibilityReportReaderSelection = { ...NON_BRAND, scope: 'group', scopeKey: 'coastal' }
    const report = buildVisibilityReport({
      ...input([previousRun(), currentRun({ definition: withCoastal })], { run: previousRun() }, selection),
      activeDefinition: withCoastal,
    })
    const population = report.populations[0]!

    expect(population.summary.mentionCoverage).toEqual({ numerator: 24, denominator: 36, rate: 24 / 36 })
    expect(population.trend.map(point => point.answerCount)).toEqual([0, 36])
    expect(population.comparison).toEqual({
      state: 'available',
      previousRun: PREVIOUS_RUN,
      mentionCoverage: { state: 'unavailable', reason: 'previous-unavailable' },
      citationCoverage: { state: 'unavailable', reason: 'previous-unavailable' },
      propertyReach: { state: 'unavailable', reason: 'previous-unavailable' },
    })
  })

  it('reports Property reach as not-applicable for a Property scope while comparing its coverage', () => {
    const selection: VisibilityReportReaderSelection = { ...NON_BRAND, scope: 'property', scopeKey: 'north' }
    const report = buildVisibilityReport(input([previousRun(), currentRun()], { run: previousRun() }, selection))
    const population = report.populations[0]!

    expect(population.summary.propertyReach).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect(population.comparison).toEqual({
      state: 'available',
      previousRun: PREVIOUS_RUN,
      mentionCoverage: { state: 'available', previous: { numerator: 18, denominator: 18, rate: 1 }, delta: 0 },
      citationCoverage: { state: 'available', previous: { numerator: 9, denominator: 18, rate: 0.5 }, delta: 12 / 18 - 0.5 },
      propertyReach: { state: 'unavailable', reason: 'not-applicable' },
    })
  })

  it('keeps each class comparison independent in an all-class report', () => {
    const brandedMoved = currentRun({}, combine(PREVIOUS_NON_BRAND, CURRENT_BRANDED))
    const brandedOnly = buildVisibilityReport(input([previousRun(), brandedMoved], { run: previousRun() }, ALL_CLASSES))
    expect(comparisonOf(brandedOnly, 'non-brand')).toEqual(NON_BRAND_UNCHANGED)
    expect(comparisonOf(brandedOnly, 'branded')).toEqual(BRANDED_CHANGE)

    const nonBrandMoved = currentRun({}, combine(CURRENT_NON_BRAND, PREVIOUS_BRANDED))
    const nonBrandOnly = buildVisibilityReport(input([previousRun(), nonBrandMoved], { run: previousRun() }, ALL_CLASSES))
    expect(comparisonOf(nonBrandOnly, 'non-brand')).toEqual(NON_BRAND_CHANGE)
    expect(comparisonOf(nonBrandOnly, 'branded')).toEqual(BRANDED_UNCHANGED)
    // No unclassified work: no population, which is not a zero change.
    expect(comparisonOf(nonBrandOnly, 'unknown')).toEqual({
      state: 'available',
      previousRun: PREVIOUS_RUN,
      mentionCoverage: { state: 'unavailable', reason: 'current-unavailable' },
      citationCoverage: { state: 'unavailable', reason: 'current-unavailable' },
      propertyReach: { state: 'unavailable', reason: 'current-unavailable' },
    })

    for (const queryClass of ['branded', 'non-brand'] as const) {
      const single = buildVisibilityReport(input([previousRun(), brandedMoved], { run: previousRun() }, { ...NON_BRAND, queryClass }))
      expect(single.populations[0]!.comparison).toEqual(comparisonOf(brandedOnly, queryClass))
    }
  })

  it('compares only the answers inside a selected market refinement', () => {
    const group: VisibilityReportReaderSelection = { ...NON_BRAND, scope: 'group', scopeKey: 'collection' }
    const alpha = buildVisibilityReport(input([previousRun(), currentRun()], { run: previousRun() }, { ...group, marketKey: 'alpha' }))
    const population = alpha.populations[0]!

    // Alpha holds North and South 0-8: 15/18 mentioned, 9/18 cited now.
    expect(population.summary.mentionCoverage).toEqual({ numerator: 15, denominator: 18, rate: 15 / 18 })
    expect(population.summary.citationCoverage).toEqual({ numerator: 9, denominator: 18, rate: 0.5 })
    expect(population.comparison).toEqual({
      state: 'available',
      previousRun: PREVIOUS_RUN,
      mentionCoverage: { state: 'available', previous: { numerator: 9, denominator: 18, rate: 0.5 }, delta: 15 / 18 - 0.5 },
      // The new citations (North 9-11) are Beta answers.
      citationCoverage: { state: 'available', previous: { numerator: 9, denominator: 18, rate: 0.5 }, delta: 0 },
      propertyReach: { state: 'available', previous: { numerator: 1, denominator: 2, rate: 0.5 }, delta: 0.5 },
    })

    const unrefined = buildVisibilityReport(input([previousRun(), currentRun()], { run: previousRun() }, group))
    expect(unrefined.populations[0]!.comparison).toEqual(NON_BRAND_CHANGE)
  })

  it.each([
    { selected: 'run-current', previous: 'run-previous' },
    { selected: 'run-previous', previous: 'run-earliest' },
  ])('matches the preceding trend point when $selected follows $previous', ({ selected, previous }) => {
    const earliest = run('run-earliest', EARLIEST_AT, EARLIEST_AT, combine(
      { mentioned: answers('north', 0, 12), cited: answers('north', 0, 3) },
      PREVIOUS_BRANDED,
    ))
    const runs = [earliest, previousRun(), currentRun()]
    const report = buildVisibilityReport(input(
      runs,
      { run: runs.find(candidate => candidate.id === previous)! },
      { ...NON_BRAND, runId: selected },
    ))
    const population = report.populations[0]!
    const index = population.trend.findIndex(point => point.runId === selected)
    const point = population.trend[index]!
    const before = population.trend[index - 1]!

    expect(before.runId).toBe(previous)
    expect(point.continuity).toEqual({ state: 'comparable', comparedRunId: previous })
    expect(population.comparison).toEqual({
      state: 'available',
      previousRun: expect.objectContaining({ id: before.runId, createdAt: before.createdAt }),
      mentionCoverage: {
        state: 'available',
        previous: before.mentionCoverage,
        delta: point.mentionCoverage.rate! - before.mentionCoverage.rate!,
      },
      citationCoverage: {
        state: 'available',
        previous: before.citationCoverage,
        delta: point.citationCoverage.rate! - before.citationCoverage.rate!,
      },
      propertyReach: expect.objectContaining({ state: 'available' }),
    })
  })
})

/** The previous sweep with a second stored answer for its first slot: the run builds, but its answers cannot be indexed. */
function duplicatedAnswerRun(): VisibilityReportRunInput {
  const readable = previousRun()
  return { ...readable, observations: [...readable.observations, readable.observations[0]!] }
}

describe('visibility report comparison with an unreadable previous sweep', () => {
  it('omits comparison on every class population when the caller could not read the previous sweep', () => {
    const report = buildVisibilityReport(input([currentRun()], { unreadable: true }, ALL_CLASSES))

    expect(report.populations.map(population => population.queryClass)).toEqual(['branded', 'non-brand', 'unknown'])
    expect(report.populations.map(population => Object.hasOwn(population, 'comparison'))).toEqual([false, false, false])
    expect(report.populations[1]!.summary.mentionCoverage).toEqual({ numerator: 24, denominator: 36, rate: 24 / 36 })
    // Absent means not computed: every other figure is the report that never asked for a change.
    expect(report).toStrictEqual(buildVisibilityReport(input([currentRun()], undefined, ALL_CLASSES)))
  })

  it('omits comparison on every class population when a previous sweep outside the report runs cannot be summarized', () => {
    const report = buildVisibilityReport(input([currentRun()], { run: duplicatedAnswerRun() }, ALL_CLASSES))

    expect(report.populations.map(population => Object.hasOwn(population, 'comparison'))).toEqual([false, false, false])
    expect(report).toStrictEqual(buildVisibilityReport(input([currentRun()], undefined, ALL_CLASSES)))
  })

  it('still fails closed when the unreadable previous sweep is one of the report runs', () => {
    const duplicated = duplicatedAnswerRun()

    expect(() => buildVisibilityReport(input([duplicated, currentRun()], { run: duplicated }, ALL_CLASSES)))
      .toThrow('Duplicate visibility observation for slot north-0')
  })
})

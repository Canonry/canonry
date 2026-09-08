/**
 * Pure, frozen-definition visibility report reader.
 *
 * Database and Fastify code deliberately stay out of this module. A caller
 * supplies each candidate run with the definition it actually used, which is
 * what prevents a material plan publication from relabelling an older run with
 * the active assignment graph.
 */

import { createHash } from 'node:crypto'
import {
  visibilityReportResponseSchema,
  type VisibilityReportLocationSelection,
  type VisibilityReportCompetitorAvailability,
  type VisibilityReportPopulationClass,
  type VisibilityReportProvenance,
  type VisibilityReportRate,
  type VisibilityReportResponse,
  type VisibilityReportScopeKind,
  type VisibilityReportScopeOption,
} from '@ainyc/canonry-contracts'

export interface VisibilityReportTargetInput {
  id: string
  label: string
  /** Aliasless Properties are not a 0% mention result. */
  mentionEligible: boolean
}

export interface VisibilityReportGroupInput {
  id: string
  label: string
  targetKeys: readonly string[]
}

/** One expected provider answer. Multiple target edges may reuse it. */
export interface VisibilityReportSlotInput {
  id: string
  executionId: string
  queryKey: string
  queryId: string | null
  query: string
  provider: string
  location: string | null
}

/**
 * An assignment/node edge. `marketKeys` is populated only from a frozen
 * `reportingScopes[].usageEdges` triple — never inferred from target membership.
 */
export interface VisibilityReportEdgeInput {
  id: string
  executionId: string
  targetKey: string
  queryId: string | null
  queryClass: VisibilityReportPopulationClass
  groupKeys: readonly string[]
  marketKeys: readonly string[]
  competitorDomains: readonly string[]
}

/** Stored answer evidence for an expected slot. Absence means the slot did not answer. */
export interface VisibilityReportObservationInput {
  slotId: string
  answerId: string
  /** Provider-disclosed served model; null is evidence missing, not a default. */
  model: string | null
  answerText: string | null
  /** A persisted legacy mention boolean can be complete even where answer text was not retained. */
  mentionComplete?: boolean
  mentionedTargetKeys: readonly string[]
  citedTargetKeys: readonly string[]
  citationComplete: boolean
  competitorMentionDomains: readonly string[]
  competitorCitationDomains: readonly string[]
  /** Stored named alternatives from this answer, never promoted into a rate. */
  observedCompetitorNames: readonly string[]
  sources: readonly string[]
  createdAt: string
}

/** One immutable definition reconstructed from one run's frozen inputs. */
export interface VisibilityReportDefinitionInput {
  revision: number | null
  provenance: VisibilityReportProvenance
  scopeOptions: readonly VisibilityReportScopeOption[]
  targets: readonly VisibilityReportTargetInput[]
  groups: readonly VisibilityReportGroupInput[]
  /** Frozen competitor identity exists for this definition (including an intentionally empty set). */
  competitorAvailability: VisibilityReportCompetitorAvailability
  slots: readonly VisibilityReportSlotInput[]
  edges: readonly VisibilityReportEdgeInput[]
}

export interface VisibilityReportRunInput {
  id: string
  createdAt: string
  completedAt: string | null
  state: 'measured' | 'partial'
  /** Probe and research work must not enter official report selection. */
  probe: boolean
  definition: VisibilityReportDefinitionInput
  /** Immutable plan version id, or a simple-run semantic id when available. */
  definitionId: string | null
  /** Prior ids in this revision's label-only comparable chain (#1062). */
  comparableDefinitionIds: readonly string[]
  /** Exact provider/model series identity; null means continuity cannot claim a model match. */
  modelFingerprint: string | null
  observations: readonly VisibilityReportObservationInput[]
}

export interface VisibilityReportReaderSelection {
  queryClass: 'branded' | 'non-brand' | 'unknown' | 'all'
  scope: VisibilityReportScopeKind
  scopeKey?: string
  provider?: string
  model?: string
  location: VisibilityReportLocationSelection
  from?: string
  to?: string
  runId?: string
  queryKey?: string
  queryId?: string
  /** Query-list-only refinement. */
  search?: string
  cursor?: string
  limit: number
}

export interface VisibilityReportReaderInput {
  mode: 'simple' | 'advanced'
  /** Current active advanced revision, if one exists. */
  activeRevision: number | null
  /** Frozen assignment count the current plan has not yet measured. */
  pendingAssignmentCount: number
  selection: VisibilityReportReaderSelection
  /** Used for no-run responses; a selected historical run always supplies its own definition. */
  activeDefinition: VisibilityReportDefinitionInput
  /** Default selected run when a compatible label-only chain beats unrelated history. */
  preferredRunId?: string
  runs: readonly VisibilityReportRunInput[]
}

export class VisibilityReportCursorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisibilityReportCursorError'
  }
}

export class VisibilityReportScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VisibilityReportScopeError'
  }
}

interface Candidate {
  run: VisibilityReportRunInput
  slot: VisibilityReportSlotInput
  edges: VisibilityReportEdgeInput[]
  observation: VisibilityReportObservationInput | null
}

interface ScopeResolution {
  option: VisibilityReportScopeOption
  edgeIds: Set<string>
}

interface CursorEnvelope {
  v: 1
  kind: 'queries' | 'evidence'
  queryClass: VisibilityReportPopulationClass
  key: string
  fingerprint: string
}

const ALL_CLASSES: readonly VisibilityReportPopulationClass[] = ['branded', 'non-brand', 'unknown']

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function locationMatches(location: string | null, selected: VisibilityReportLocationSelection): boolean {
  if (selected.kind === 'all') return true
  if (selected.kind === 'none') return location === null
  return location !== null && normalizeText(location) === normalizeText(selected.value)
}

function selectedClasses(value: VisibilityReportReaderSelection['queryClass']): readonly VisibilityReportPopulationClass[] {
  return value === 'all' ? ALL_CLASSES : [value]
}

function unavailable(reason: 'no-population' | 'incomplete' | 'evidence-incomplete' | 'not-applicable'): VisibilityReportRate {
  return { numerator: null, denominator: null, rate: null, reason }
}

function rate(values: readonly (boolean | null)[], expected: number): VisibilityReportRate {
  if (expected === 0) return unavailable('no-population')
  if (values.length !== expected) return unavailable('incomplete')
  if (values.some(value => value === null)) return unavailable('evidence-incomplete')
  const denominator = values.length
  if (denominator === 0) return unavailable('no-population')
  const numerator = values.filter(Boolean).length
  return { numerator, denominator, rate: numerator / denominator }
}

function scopeResolution(
  definition: VisibilityReportDefinitionInput,
  selection: VisibilityReportReaderSelection,
): ScopeResolution {
  const project = definition.scopeOptions.find(option => option.kind === 'project')
  if (!project) throw new VisibilityReportScopeError('Frozen definition has no project scope.')
  if (selection.scope === 'project') {
    return { option: project, edgeIds: new Set(definition.edges.map(edge => edge.id)) }
  }

  const key = selection.scopeKey
  if (!key) throw new VisibilityReportScopeError(`${selection.scope} scope requires a scope key.`)
  const option = definition.scopeOptions.find(candidate => candidate.kind === selection.scope && candidate.id === key)
  if (!option) throw new VisibilityReportScopeError(`${selection.scope} scope "${key}" is not in this frozen definition.`)

  if (selection.scope === 'property') {
    return {
      option,
      edgeIds: new Set(definition.edges.filter(edge => edge.targetKey === key).map(edge => edge.id)),
    }
  }
  if (selection.scope === 'group') {
    const group = definition.groups.find(candidate => candidate.id === key)
    if (!group) throw new VisibilityReportScopeError(`Group "${key}" is not in this frozen definition.`)
    const targetKeys = new Set(group.targetKeys)
    return {
      option,
      edgeIds: new Set(definition.edges.filter(edge => targetKeys.has(edge.targetKey)).map(edge => edge.id)),
    }
  }

  // Crucial: market scope selects only exact frozen triples. A Target that has
  // an Alpha and a Beta node does NOT let Alpha borrow Beta merely because both
  // edges name the same Target.
  return {
    option,
    edgeIds: new Set(definition.edges.filter(edge => edge.marketKeys.includes(key)).map(edge => edge.id)),
  }
}

/**
 * The Property population comes from the frozen scope itself, not only from
 * edges that happened to have the selected class/filter. Otherwise a
 * non-brand report would silently drop Properties with no non-brand work and
 * make its outcome denominator look measured.
 */
function scopeTargetKeys(
  definition: VisibilityReportDefinitionInput,
  selection: VisibilityReportReaderSelection,
): string[] {
  const resolution = scopeResolution(definition, selection)
  if (selection.scope === 'project') return definition.targets.map(target => target.id).sort(compareText)
  if (selection.scope === 'property') return [resolution.option.id]
  if (selection.scope === 'group') {
    const group = definition.groups.find(candidate => candidate.id === resolution.option.id)
    if (!group) throw new VisibilityReportScopeError(`Group "${resolution.option.id}" is not in this frozen definition.`)
    return [...group.targetKeys].sort(compareText)
  }
  return [...new Set(definition.edges
    .filter(edge => resolution.edgeIds.has(edge.id))
    .map(edge => edge.targetKey))].sort(compareText)
}

function observationIndex(run: VisibilityReportRunInput): Map<string, VisibilityReportObservationInput> {
  const index = new Map<string, VisibilityReportObservationInput>()
  for (const observation of run.observations) {
    if (index.has(observation.slotId)) throw new Error(`Duplicate visibility observation for slot ${observation.slotId}`)
    index.set(observation.slotId, observation)
  }
  return index
}

function candidatesFor(
  run: VisibilityReportRunInput,
  selection: VisibilityReportReaderSelection,
  queryClass: VisibilityReportPopulationClass,
): { resolution: ScopeResolution; candidates: Candidate[] } {
  const resolution = scopeResolution(run.definition, selection)
  const slotsByExecution = new Map<string, VisibilityReportSlotInput[]>()
  const slotsById = new Map<string, VisibilityReportSlotInput>()
  for (const slot of run.definition.slots) {
    if (slotsById.has(slot.id)) throw new Error(`Duplicate visibility slot ${slot.id}`)
    slotsById.set(slot.id, slot)
    const slots = slotsByExecution.get(slot.executionId) ?? []
    slots.push(slot)
    slotsByExecution.set(slot.executionId, slots)
  }
  const observations = observationIndex(run)
  const bySlot = new Map<string, VisibilityReportEdgeInput[]>()
  for (const edge of run.definition.edges) {
    if (!resolution.edgeIds.has(edge.id) || edge.queryClass !== queryClass) continue
    const slots = slotsByExecution.get(edge.executionId)
    if (!slots || slots.length === 0) throw new Error(`Frozen usage edge ${edge.id} has no execution slot`)
    for (const slot of slots) {
      if (edge.queryId !== null && slot.queryId !== null && edge.queryId !== slot.queryId) {
        throw new Error(`Frozen usage edge ${edge.id} has a mismatched query id`)
      }
      const list = bySlot.get(slot.id) ?? []
      list.push(edge)
      bySlot.set(slot.id, list)
    }
  }

  const provider = selection.provider === undefined ? undefined : normalizeText(selection.provider)
  const model = selection.model === undefined ? undefined : normalizeText(selection.model)
  const candidates: Candidate[] = []
  for (const [slotId, edges] of bySlot) {
    const slot = slotsById.get(slotId)
    if (!slot) throw new Error(`Frozen slot ${slotId} disappeared during reconstruction`)
    const observation = observations.get(slot.id) ?? null
    if (provider !== undefined && normalizeText(slot.provider) !== provider) continue
    if (!locationMatches(slot.location, selection.location)) continue
    // A model filter is evidence-only. An absent served model cannot be treated
    // as a match for the requested adapter model.
    if (model !== undefined && (observation === null || observation.model === null || normalizeText(observation.model) !== model)) continue
    candidates.push({ run, slot, edges, observation })
  }
  return { resolution, candidates }
}

function targetMap(definition: VisibilityReportDefinitionInput): ReadonlyMap<string, VisibilityReportTargetInput> {
  return new Map(definition.targets.map(target => [target.id, target]))
}

function targetValues(
  candidate: Candidate,
  targets: ReadonlyMap<string, VisibilityReportTargetInput>,
  targetKey?: string,
): {
  mention: boolean | null
  citation: boolean | null
} {
  const targetKeys = targetKey === undefined
    ? [...new Set(candidate.edges.map(edge => edge.targetKey))]
    : [targetKey]
  const eligible = targetKeys.filter(key => targets.get(key)?.mentionEligible === true)
  const observation = candidate.observation
  const mentionComplete = observation !== null && (observation.mentionComplete ?? observation.answerText !== null)
  if (!observation || !mentionComplete || eligible.length === 0) {
    return {
      mention: null,
      citation: observation?.citationComplete === true && targetKeys.length > 0
        ? targetKeys.some(key => observation.citedTargetKeys.includes(key))
        : null,
    }
  }
  return {
    mention: eligible.some(key => observation.mentionedTargetKeys.includes(key)),
    citation: observation.citationComplete
      ? targetKeys.some(key => observation.citedTargetKeys.includes(key))
      : null,
  }
}

function answered(candidate: Candidate): boolean {
  return candidate.observation !== null
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.run.id}\u0000${candidate.slot.id}`
}

function selectedTargetKeys(candidates: readonly Candidate[]): string[] {
  return [...new Set(candidates.flatMap(candidate => candidate.edges.map(edge => edge.targetKey)))].sort(compareText)
}

function targetMetrics(
  candidates: readonly Candidate[],
  targets: ReadonlyMap<string, VisibilityReportTargetInput>,
  targetKey: string,
): { mentionCoverage: VisibilityReportRate; citationCoverage: VisibilityReportRate } {
  const own = candidates.filter(candidate => candidate.edges.some(edge => edge.targetKey === targetKey))
  return {
    mentionCoverage: rate(own.map(candidate => targetValues(candidate, targets, targetKey).mention), own.length),
    citationCoverage: rate(own.map(candidate => targetValues(candidate, targets, targetKey).citation), own.length),
  }
}

function outcomeCounts(
  candidates: readonly Candidate[],
  targets: ReadonlyMap<string, VisibilityReportTargetInput>,
  targetKeys: readonly string[],
) {
  const counts = { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: targetKeys.length }
  for (const targetKey of targetKeys) {
    const metrics = targetMetrics(candidates, targets, targetKey)
    if (metrics.mentionCoverage.numerator === null || metrics.citationCoverage.numerator === null) {
      counts.notMeasured++
    } else if (metrics.mentionCoverage.numerator > 0 && metrics.citationCoverage.numerator > 0) {
      counts.bothSignals++
    } else if (metrics.mentionCoverage.numerator > 0) {
      counts.mentionedOnly++
    } else if (metrics.citationCoverage.numerator > 0) {
      counts.citedOnly++
    } else {
      counts.neither++
    }
  }
  return counts
}

function coverageSummary(
  candidates: readonly Candidate[],
  definition: VisibilityReportDefinitionInput,
  targets = targetMap(definition),
) {
  const unique = new Map(candidates.map(candidate => [candidateKey(candidate), candidate]))
  const rows = [...unique.values()]
  return {
    rows,
    queryCount: new Set(rows.map(candidate => candidate.slot.queryKey)).size,
    answerCount: rows.filter(answered).length,
    mentionCoverage: rate(rows.map(candidate => targetValues(candidate, targets).mention), rows.length),
    citationCoverage: rate(rows.map(candidate => targetValues(candidate, targets).citation), rows.length),
  }
}

function summary(
  candidates: readonly Candidate[],
  definition: VisibilityReportDefinitionInput,
  populationTargetKeys = selectedTargetKeys(candidates),
) {
  const targets = targetMap(definition)
  const base = coverageSummary(candidates, definition, targets)
  const { rows } = base
  const targetRows = populationTargetKeys
    .map(targetKey => ({ targetKey, ...targetMetrics(rows, targets, targetKey) }))
  const eligibleTargets = targetRows.filter(row => targets.get(row.targetKey)?.mentionEligible === true)
  const propertyReach = rate(
    eligibleTargets.map(row => row.mentionCoverage.numerator === null ? null : row.mentionCoverage.numerator > 0),
    eligibleTargets.length,
  )
  return {
    queryCount: base.queryCount,
    answerCount: base.answerCount,
    mentionCoverage: base.mentionCoverage,
    citationCoverage: base.citationCoverage,
    propertyReach,
    outcomes: outcomeCounts(rows, targets, populationTargetKeys),
  }
}

function queryRows(candidates: readonly Candidate[], definition: VisibilityReportDefinitionInput, selection: VisibilityReportReaderSelection) {
  const targets = targetMap(definition)
  const narrowed = candidates.filter(candidate => (
    (selection.queryKey === undefined || candidate.slot.queryKey === selection.queryKey)
    && (selection.queryId === undefined || candidate.slot.queryId === selection.queryId)
    && (selection.search === undefined || normalizeText(candidate.slot.query).includes(normalizeText(selection.search)))
  ))
  const groups = new Map<string, Candidate[]>()
  for (const candidate of narrowed) {
    const model = candidate.observation?.model ?? null
    const key = [candidate.slot.queryKey, candidate.slot.provider, model ?? '', candidate.slot.location ?? ''].join('\u0000')
    const rows = groups.get(key) ?? []
    rows.push(candidate)
    groups.set(key, rows)
  }
  return [...groups.values()].map(rows => {
    const first = rows[0]!
    const value = coverageSummary(rows, definition, targets)
    return {
      queryKey: first.slot.queryKey,
      queryId: first.slot.queryId,
      query: first.slot.query,
      provider: first.slot.provider,
      model: first.observation?.model ?? null,
      location: first.slot.location,
      targetKeys: selectedTargetKeys(rows),
      answerCount: value.answerCount,
      mentionCoverage: value.mentionCoverage,
      citationCoverage: value.citationCoverage,
    }
  }).sort((left, right) => (
    compareText(normalizeText(left.query), normalizeText(right.query))
    || compareText(left.provider, right.provider)
    || compareText(left.model ?? '', right.model ?? '')
    || compareText(left.location ?? '', right.location ?? '')
    || compareText(left.queryKey, right.queryKey)
  ))
}

function evidenceRows(candidates: readonly Candidate[], definition: VisibilityReportDefinitionInput, selection: VisibilityReportReaderSelection) {
  if (selection.queryKey === undefined && selection.queryId === undefined) return []
  const targets = targetMap(definition)
  return candidates
    .filter(candidate => (
      (selection.queryKey === undefined || candidate.slot.queryKey === selection.queryKey)
      && (selection.queryId === undefined || candidate.slot.queryId === selection.queryId)
      && candidate.observation !== null
    ))
    .map(candidate => {
      const observation = candidate.observation!
      const signals = targetValues(candidate, targets)
      return {
        answerId: observation.answerId,
        runId: candidate.run.id,
        queryKey: candidate.slot.queryKey,
        query: candidate.slot.query,
        provider: candidate.slot.provider,
        model: observation.model,
        location: candidate.slot.location,
        targetKeys: selectedTargetKeys([candidate]),
        mentioned: signals.mention,
        cited: signals.citation,
        // Answer bodies are intentionally limited to the stable query-key
        // drill-in. A query-id is enough to locate an evidence page, but it
        // is not a client-side invitation to enumerate every answer body.
        answerText: selection.queryKey === undefined ? null : observation.answerText,
        createdAt: observation.createdAt,
        sources: [...observation.sources],
        observedCompetitors: [...observation.observedCompetitorNames],
      }
    })
    .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.answerId, right.answerId))
}

function competitorRows(candidates: readonly Candidate[]) {
  const domains = [...new Set(candidates.flatMap(candidate => candidate.edges.flatMap(edge => edge.competitorDomains)))].sort(compareText)
  return domains.map(domain => {
    // A competitor is eligible only on the frozen edges that explicitly
    // carried its identity. A union of domains across a scope must not make a
    // group-local competitor borrow another group's answers as its denominator.
    const eligible = candidates
      .map(candidate => {
        const edges = candidate.edges.filter(edge => edge.competitorDomains.includes(domain))
        return edges.length === 0 ? null : { ...candidate, edges }
      })
      .filter((candidate): candidate is Candidate => candidate !== null)
    const unique = [...new Map(eligible.map(candidate => [candidateKey(candidate), candidate])).values()]
    const mentionValues = unique.map(candidate => {
      const observation = candidate.observation
      return observation === null || observation.answerText === null
        ? null
        : observation.competitorMentionDomains.includes(domain)
    })
    const citationValues = unique.map(candidate => {
      const observation = candidate.observation
      return observation === null || !observation.citationComplete
        ? null
        : observation.competitorCitationDomains.includes(domain)
    })
    return {
      domain,
      answerCount: unique.filter(answered).length,
      mentionCoverage: rate(mentionValues, unique.length),
      citationCoverage: rate(citationValues, unique.length),
    }
  })
}

function observedCompetitorRows(candidates: readonly Candidate[]) {
  const answersByName = new Map<string, Set<string>>()
  for (const candidate of candidates) {
    const observation = candidate.observation
    if (observation === null) continue
    for (const name of observation.observedCompetitorNames) {
      const answers = answersByName.get(name) ?? new Set<string>()
      answers.add(candidateKey(candidate))
      answersByName.set(name, answers)
    }
  }
  return [...answersByName].map(([name, answers]) => ({ name, answerCount: answers.size }))
    .sort((left, right) => compareText(left.name, right.name))
}

function narrowedToTargetKeys(candidate: Candidate, targetKeys: ReadonlySet<string>): Candidate | null {
  const edges = candidate.edges.filter(edge => targetKeys.has(edge.targetKey))
  return edges.length === 0 ? null : { ...candidate, edges }
}

function breakdown(
  candidates: readonly Candidate[],
  definition: VisibilityReportDefinitionInput,
  populationTargetKeys = selectedTargetKeys(candidates),
) {
  const targets = targetMap(definition)
  const properties = populationTargetKeys.map(id => {
    const target = targets.get(id)
    if (!target) throw new Error(`Frozen report edge references unknown target ${id}`)
    const metrics = targetMetrics(candidates, targets, id)
    const own = candidates.filter(candidate => candidate.edges.some(edge => edge.targetKey === id))
    return {
      id,
      label: target.label,
      queryCount: new Set(own.map(candidate => candidate.slot.queryKey)).size,
      ...metrics,
    }
  }).sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id))
  const groups = definition.groups.map(group => {
    const groupTargetKeys = new Set(group.targetKeys)
    const own = candidates
      .map(candidate => narrowedToTargetKeys(candidate, groupTargetKeys))
      .filter((candidate): candidate is Candidate => candidate !== null)
    const metrics = rate(own.map(candidate => targetValues(candidate, targets).mention), own.length)
    const citations = rate(own.map(candidate => targetValues(candidate, targets).citation), own.length)
    return {
      id: group.id,
      label: group.label,
      queryCount: new Set(own.map(candidate => candidate.slot.queryKey)).size,
      mentionCoverage: metrics,
      citationCoverage: citations,
    }
  }).filter(group => group.queryCount > 0).sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id))
  return { properties, groups }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url')
}

function cursorOf(cursor: CursorEnvelope): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function parseCursor(value: string | undefined): CursorEnvelope | null {
  if (value === undefined) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const cursor = parsed as Record<string, unknown>
    if (cursor.v !== 1 || (cursor.kind !== 'queries' && cursor.kind !== 'evidence')) return null
    if ((cursor.queryClass !== 'branded' && cursor.queryClass !== 'non-brand' && cursor.queryClass !== 'unknown')
      || typeof cursor.key !== 'string' || typeof cursor.fingerprint !== 'string') return null
    return {
      v: 1,
      kind: cursor.kind,
      queryClass: cursor.queryClass,
      key: cursor.key,
      fingerprint: cursor.fingerprint,
    }
  } catch {
    return null
  }
}

function page<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  kind: CursorEnvelope['kind'],
  queryClass: VisibilityReportPopulationClass,
  input: VisibilityReportReaderInput,
  run: VisibilityReportRunInput | undefined,
): { items: Row[]; total: number; nextCursor: string | null } {
  const selectionFingerprint = fingerprint({
    mode: input.mode,
    activeRevision: input.activeRevision,
    runId: run?.id ?? null,
    definitionRevision: run?.definition.revision ?? input.activeDefinition.revision,
    queryClass,
    scope: input.selection.scope,
    scopeKey: input.selection.scopeKey ?? null,
    provider: input.selection.provider ?? null,
    model: input.selection.model ?? null,
    location: input.selection.location,
    from: input.selection.from ?? null,
    to: input.selection.to ?? null,
    queryKey: input.selection.queryKey ?? null,
    queryId: input.selection.queryId ?? null,
    search: input.selection.search ?? null,
    evidence: rows.map(keyOf),
  })
  const cursor = parseCursor(input.selection.cursor)
  let offset = 0
  if (input.selection.cursor !== undefined) {
    if (!cursor) throw new VisibilityReportCursorError('Visibility report cursor is invalid.')
    // The response contains both collections. A query-list cursor must leave
    // evidence at its first page (and vice versa), while `all` keeps one
    // independent cursor per population. An explicit class cannot borrow a
    // cursor from another population.
    if (cursor.queryClass !== queryClass) {
      if (input.selection.queryClass !== 'all') {
        throw new VisibilityReportCursorError('Visibility report cursor belongs to another population.')
      }
    } else if (cursor.kind === kind) {
      if (cursor.fingerprint !== selectionFingerprint) {
        throw new VisibilityReportCursorError('Visibility report cursor does not match the current selection or evidence.')
      }
      const index = rows.findIndex(row => keyOf(row) === cursor.key)
      if (index < 0) throw new VisibilityReportCursorError('Visibility report cursor does not belong to this page.')
      offset = index + 1
    }
  }
  const items = rows.slice(offset, offset + input.selection.limit)
  const last = items.at(-1)
  return {
    items: [...items],
    total: rows.length,
    nextCursor: last === undefined || rows.at(offset + input.selection.limit) === undefined
      ? null
      : cursorOf({ v: 1, kind, queryClass, key: keyOf(last), fingerprint: selectionFingerprint }),
  }
}

function filterOptions(definition: VisibilityReportDefinitionInput, selection: VisibilityReportReaderSelection, run?: VisibilityReportRunInput) {
  const resolution = scopeResolution(definition, selection)
  const slots = definition.slots.filter(slot => definition.edges.some(edge => edge.executionId === slot.executionId && resolution.edgeIds.has(edge.id)))
  const observations = run ? observationIndex(run) : new Map<string, VisibilityReportObservationInput>()
  const providers = [...new Set(slots.map(slot => slot.provider))].sort(compareText)
  const models = [...new Map(slots.flatMap(slot => {
    const observation = observations.get(slot.id)
    return observation?.model === null || observation === undefined
      ? []
      : [[`${slot.provider}\u0000${observation.model}`, { provider: slot.provider, model: observation.model }] as const]
  })).values()].sort((left, right) => compareText(left.provider, right.provider) || compareText(left.model, right.model))
  const locations: VisibilityReportLocationSelection[] = [{ kind: 'all' }]
  const seen = new Set<string>(['all'])
  for (const slot of slots) {
    const value: VisibilityReportLocationSelection = slot.location === null ? { kind: 'none' } : { kind: 'exact', value: slot.location }
    const key = value.kind === 'exact' ? `exact:${normalizeText(value.value)}` : value.kind
    if (!seen.has(key)) {
      seen.add(key)
      locations.push(value)
    }
  }
  return { providers, models, locations }
}

function continuity(
  previous: VisibilityReportRunInput | undefined,
  current: VisibilityReportRunInput,
) {
  if (!previous) return { state: 'first' as const, comparedRunId: null }
  const currentLegacy = current.definition.provenance.kind === 'legacy-simple'
  const previousLegacy = previous.definition.provenance.kind === 'legacy-simple'
  if (currentLegacy || previousLegacy) return { state: 'legacy-unknown' as const, comparedRunId: previous.id }
  const sameDefinition = current.definitionId !== null && previous.definitionId !== null && (
    current.definitionId === previous.definitionId || current.comparableDefinitionIds.includes(previous.definitionId)
  )
  if (!sameDefinition) return { state: 'definition-changed' as const, comparedRunId: previous.id }
  if (current.modelFingerprint === null || previous.modelFingerprint === null || current.modelFingerprint !== previous.modelFingerprint) {
    return { state: 'model-changed' as const, comparedRunId: previous.id }
  }
  return { state: 'comparable' as const, comparedRunId: previous.id }
}

function inTime(run: VisibilityReportRunInput, selection: VisibilityReportReaderSelection): boolean {
  return (selection.from === undefined || run.createdAt >= selection.from)
    && (selection.to === undefined || run.createdAt <= selection.to)
}

function emptyPopulation(
  queryClass: VisibilityReportPopulationClass,
  definition: VisibilityReportDefinitionInput,
  input: VisibilityReportReaderInput,
) {
  const { candidates } = { candidates: [] as Candidate[] }
  const populationTargetKeys = scopeTargetKeys(definition, input.selection)
  return {
    queryClass,
    summary: summary(candidates, definition, populationTargetKeys),
    trend: [],
    queries: page([], () => '', 'queries', queryClass, input, undefined),
    evidence: page([], () => '', 'evidence', queryClass, input, undefined),
    competitorAvailability: definition.competitorAvailability,
    competitors: [],
    observedCompetitors: [],
    breakdown: breakdown(candidates, definition, populationTargetKeys),
  }
}

/**
 * Build a selection-consistent report from frozen runs.
 *
 * The selected run drives summary/query/evidence/competitors. Trend walks
 * independently frozen runs under the same scope/context filters and marks
 * every definition/model boundary, so it cannot draw continuity over a
 * material publication.
 */
export function buildVisibilityReport(input: VisibilityReportReaderInput): VisibilityReportResponse {
  const runs = input.runs.filter(run => !run.probe && inTime(run, input.selection))
    .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id))
  const selectedRun = input.selection.runId === undefined
    ? (input.preferredRunId === undefined ? runs.at(-1) : runs.find(run => run.id === input.preferredRunId))
    : runs.find(run => run.id === input.selection.runId)
  const definition = selectedRun?.definition ?? input.activeDefinition
  const selectedScope = scopeResolution(definition, input.selection).option
  const populationTargetKeys = scopeTargetKeys(definition, input.selection)
  const classes = selectedClasses(input.selection.queryClass)
  const runCandidates = new Map<string, Map<VisibilityReportPopulationClass, Candidate[]>>()
  for (const run of runs) {
    const byClass = new Map<VisibilityReportPopulationClass, Candidate[]>()
    for (const queryClass of classes) {
      try {
        byClass.set(queryClass, candidatesFor(run, input.selection, queryClass).candidates)
      } catch (error) {
        // A scope added after this run's material definition is not a reason to
        // fail the whole trend. Its point is a gap. The selected definition,
        // however, must contain the requested scope or the request is invalid.
        if (!(error instanceof VisibilityReportScopeError) || selectedRun?.id === run.id) throw error
        byClass.set(queryClass, [])
      }
    }
    runCandidates.set(run.id, byClass)
  }

  const populations = classes.map(queryClass => {
    if (!selectedRun) return emptyPopulation(queryClass, definition, input)
    const selected = runCandidates.get(selectedRun.id)?.get(queryClass) ?? []
    const trend = runs.map((run, index) => {
      const candidates = runCandidates.get(run.id)?.get(queryClass) ?? []
      // Trend points expose only answer/query coverage. Do not rebuild the
      // selected-population Property reach and outcome partition for every
      // historical run in a large portfolio.
      const point = coverageSummary(candidates, run.definition)
      return {
        runId: run.id,
        createdAt: run.createdAt,
        revision: run.definition.revision,
        provenance: run.definition.provenance,
        queryCount: point.queryCount,
        answerCount: point.answerCount,
        mentionCoverage: point.mentionCoverage,
        citationCoverage: point.citationCoverage,
        continuity: continuity(runs[index - 1], run),
      }
    })
    const rows = queryRows(selected, definition, input.selection)
    const evidence = evidenceRows(selected, definition, input.selection)
    return {
      queryClass,
      summary: summary(selected, definition, populationTargetKeys),
      trend,
      queries: page(rows, row => [row.queryKey, row.provider, row.model ?? '', row.location ?? ''].join('\u0000'), 'queries', queryClass, input, selectedRun),
      evidence: page(evidence, row => [row.answerId, row.runId].join('\u0000'), 'evidence', queryClass, input, selectedRun),
      competitorAvailability: definition.competitorAvailability,
      competitors: competitorRows(selected),
      observedCompetitors: observedCompetitorRows(selected),
      breakdown: breakdown(selected, definition, populationTargetKeys),
    }
  })

  const measuredRevision = selectedRun?.definition.revision ?? null
  const awaitingSweep = input.activeRevision !== null && measuredRevision !== input.activeRevision
  return visibilityReportResponseSchema.parse({
    selection: {
      mode: input.mode,
      queryClass: input.selection.queryClass,
      scope: selectedScope,
      provider: input.selection.provider ?? null,
      model: input.selection.model ?? null,
      location: input.selection.location,
      time: { from: input.selection.from ?? null, to: input.selection.to ?? null },
      revision: measuredRevision,
      run: { id: selectedRun?.id ?? null, explicit: input.selection.runId !== undefined },
      provenance: definition.provenance,
      measurement: {
        state: selectedRun?.state ?? 'not-measured',
        activeRevision: input.activeRevision,
        measuredRevision,
        awaitingSweep,
        pendingAssignmentCount: awaitingSweep ? input.pendingAssignmentCount : 0,
        completedAt: selectedRun?.completedAt ?? null,
      },
      availability: { state: 'available' },
    },
    scopeOptions: definition.scopeOptions,
    filterOptions: filterOptions(definition, input.selection, selectedRun),
    populations,
  })
}

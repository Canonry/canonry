import {
  MEASUREMENT_DRAFT_MAX_ASSIGNMENTS,
  MEASUREMENT_DRAFT_MAX_ASSIGNMENTS_PER_ACTION,
  MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES,
  MEASUREMENT_DRAFT_MAX_GROUPS,
  measurementDraftApplyAssignmentsRequestSchema,
  measurementDraftApplyPairedAssignmentsRequestSchema,
  measurementDraftClassifyAssignmentsRequestSchema,
  measurementDraftClearAssignmentsRequestSchema,
  measurementDraftExcludeTargetRequestSchema,
  measurementDraftMergeTargetsRequestSchema,
  measurementDraftRebindTargetRequestSchema,
  measurementDraftRemoveAssignmentRequestSchema,
  measurementDraftRemoveCompetitorRequestSchema,
  measurementDraftRemoveGroupRequestSchema,
  measurementDraftReplaceAssignmentsRequestSchema,
  measurementDraftRenameTargetRequestSchema,
  measurementDraftUpsertCompetitorRequestSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementDraftUpsertTargetRequestSchema,
  notFound,
  validationError,
  type MeasurementDraftAssignment,
  type MeasurementDraftAssignmentAudienceRequest,
  type MeasurementDraftAudience,
  type MeasurementDraftAuthoring,
  type MeasurementDraftGroup,
  type MeasurementDraftResolvedAudienceGroup,
  type MeasurementDraftTarget,
  type MeasurementDraftWarning,
} from '@ainyc/canonry-contracts'
import { proposeQueryClassForTarget } from './measurement-draft-compile.js'
import type { ZodType } from 'zod'

/** Every typed action the draft service owns. Sitemap import and rebind selection live in the discovery slice. */
export const MEASUREMENT_DRAFT_ACTIONS = [
  'upsert-target',
  'rename-target',
  'merge-targets',
  'exclude-target',
  'rebind-target',
  'apply-assignments',
  'replace-assignments',
  'apply-paired-assignments',
  'remove-assignment',
  'clear-assignments',
  'classify-assignments',
  'upsert-group',
  'remove-group',
  'upsert-competitor',
  'remove-competitor',
] as const
export type MeasurementDraftActionName = (typeof MEASUREMENT_DRAFT_ACTIONS)[number]

/**
 * Ceiling on assignments one cross-product call may create. Set well above any
 * deliberate action (20 questions x 50 Properties is 1,000) and below the
 * 45,369 that one mis-shaped pattern apply produced.
 */
export const MAX_ASSIGNMENTS_PER_ACTION = MEASUREMENT_DRAFT_MAX_ASSIGNMENTS_PER_ACTION

export interface DraftActionContext {
  brandNames: readonly string[]
  queriesById: ReadonlyMap<string, string>
}

export interface DraftActionResult {
  authoring: MeasurementDraftAuthoring
  warnings: MeasurementDraftWarning[]
}

export interface ResolvedDraftAudience {
  targetKeys: string[]
  groups: MeasurementDraftResolvedAudienceGroup[]
  /** Selected source memberships that collapsed onto an already-selected Target. */
  overlapCount: number
}

export interface AssignmentAuthoringResult extends DraftActionResult {
  audience: ResolvedDraftAudience
  assignments: {
    requested: number
    added: number
    alreadyPresent: number
  }
}

function parseBody<T>(schema: ZodType<T>, body: unknown, action: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw validationError(`Invalid "${action}" payload`, { issues: parsed.error.issues })
  }
  return parsed.data
}

function requireTarget(authoring: MeasurementDraftAuthoring, targetKey: string): MeasurementDraftTarget {
  const target = authoring.targets.find(candidate => candidate.stableKey === targetKey)
  if (!target) throw notFound('Measurement draft Target', targetKey)
  return target
}

function requireGroup(authoring: MeasurementDraftAuthoring, groupKey: string): MeasurementDraftGroup {
  const group = authoring.groups.find(candidate => candidate.stableKey === groupKey)
  if (!group) throw notFound('Measurement draft group', groupKey)
  return group
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function knownQueryIds(queryIds: readonly string[], context: DraftActionContext): string[] {
  const uniqueQueryIds = unique(queryIds)
  const unknown = uniqueQueryIds.filter(queryId => !context.queriesById.has(queryId))
  if (unknown.length) {
    throw validationError(
      `The project has no query ${unknown.map(id => `"${id}"`).join(', ')}. Add it before assigning it.`,
      { displayToOperator: true },
    )
  }
  return uniqueQueryIds
}

/**
 * Resolves the operator's audience at the only boundary that matters: the
 * draft server. A group cannot stand in for a Target later in the graph, so
 * this returns concrete stable keys and rejects stale or unreviewed membership
 * before any assignment count is shown.
 */
export function resolveDraftAudience(
  authoring: MeasurementDraftAuthoring,
  audience: MeasurementDraftAudience,
): ResolvedDraftAudience {
  const targetsByKey = new Map(authoring.targets.map(target => [target.stableKey, target]))
  const selected = unique(audience.targetKeys ?? [])
  for (const targetKey of unique(audience.targetKeys ?? [])) {
    const target = requireTarget(authoring, targetKey)
    if (target.status !== 'included') {
      throw validationError(`Property "${target.label}" is ${target.status}, not included.`, {
        displayToOperator: true,
        audienceError: 'target-not-included',
      })
    }
  }

  const groups: MeasurementDraftResolvedAudienceGroup[] = []
  for (const groupKey of unique(audience.groupKeys ?? [])) {
    const group = authoring.groups.find(candidate => candidate.stableKey === groupKey)
    if (!group) {
      throw validationError('A selected group is no longer available. Choose the audience again.', {
        displayToOperator: true,
        audienceError: 'group-not-found',
      })
    }
    const memberKeys = unique(group.targetKeys)
    if (memberKeys.length === 0) {
      throw validationError(`Group "${group.label}" has no Properties to assign.`, { displayToOperator: true })
    }
    for (const targetKey of memberKeys) {
      const target = targetsByKey.get(targetKey)
      if (!target) {
        throw validationError(`Group "${group.label}" references an unknown Property. Review its membership.`, {
          displayToOperator: true,
        })
      }
      if (target.status !== 'included') {
        throw validationError(
          `Group "${group.label}" contains Property "${target.label}" that is ${target.status}, not included.`,
          { displayToOperator: true },
        )
      }
    }
    groups.push({ groupKey: group.stableKey, label: group.label, memberCount: memberKeys.length })
    selected.push(...memberKeys)
  }

  const targetKeys = unique(selected).sort(compareText)
  return {
    targetKeys,
    groups,
    overlapCount: selected.length - targetKeys.length,
  }
}

function assertAssignmentActionLimit(
  audience: ResolvedDraftAudience,
  queryIds: readonly string[],
) {
  const pairCount = audience.targetKeys.length * queryIds.length
  if (pairCount <= MAX_ASSIGNMENTS_PER_ACTION) return
  const groupDetail = audience.groups.length
    ? ` Audience groups: ${audience.groups.map(group => `"${group.label}" (${group.memberCount} Properties)`).join(', ')}.`
    : ''
  throw validationError(
    `This would create ${pairCount.toLocaleString('en-US')} assignments `
    + `(${queryIds.length} questions across ${audience.targetKeys.length} unique Properties), `
    + `over the ${MAX_ASSIGNMENTS_PER_ACTION.toLocaleString('en-US')} limit for one action.`
    + groupDetail
    + ' Apply a question to the Properties it is about, or use "apply-paired-assignments" '
    + 'when each question names its own Property.',
    { displayToOperator: true, pairCount, maximum: MAX_ASSIGNMENTS_PER_ACTION },
  )
}

/** Global draft preflight for every generic action, not just the new audience operations. */
export function assertMeasurementDraftAuthoringLimits(
  before: MeasurementDraftAuthoring,
  candidate: MeasurementDraftAuthoring,
) {
  const assertCount = (
    label: string,
    current: number,
    requested: number,
    maximum: number,
  ) => {
    if (requested <= maximum || requested <= current) return
    throw validationError(
      `Measurement draft ${label} limit exceeded: current ${current.toLocaleString('en-US')}, `
      + `requested ${requested.toLocaleString('en-US')}, maximum ${maximum.toLocaleString('en-US')}.`,
      { current, requested, maximum, resource: label, displayToOperator: true },
    )
  }
  assertCount('groups', before.groups.length, candidate.groups.length, MEASUREMENT_DRAFT_MAX_GROUPS)
  assertCount('assignments', before.assignments.length, candidate.assignments.length, MEASUREMENT_DRAFT_MAX_ASSIGNMENTS)

  const requested = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
  if (requested > MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES) {
    // Serialize the prior draft only on the exceptional oversized path. Most
    // actions pay one size check, while grandfathered drafts may still shrink.
    const current = Buffer.byteLength(JSON.stringify(before), 'utf8')
    if (requested <= current) return
    throw validationError(
      `Measurement draft authoring size limit exceeded: current ${current.toLocaleString('en-US')} bytes, `
      + `requested ${requested.toLocaleString('en-US')} bytes, `
      + `maximum ${MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES.toLocaleString('en-US')} bytes.`,
      {
        current,
        requested,
        maximum: MEASUREMENT_DRAFT_MAX_AUTHORING_BYTES,
        resource: 'authoring bytes',
        displayToOperator: true,
      },
    )
  }
}

function warn(code: string, message: string, path: (string | number)[]): MeasurementDraftWarning {
  return { code, message, path }
}

/**
 * Seeded v2 assignments carry exact frozen execution nodes. A routine
 * assignment action must leave those alone unless the operator explicitly
 * supplied a new mutable override; otherwise touching an audience would widen
 * the old provider/model/location surface on the next publish.
 */
function withRequestedContext(
  assignment: MeasurementDraftAssignment,
  contextOverride: MeasurementDraftAssignmentAudienceRequest['contextOverride'],
): MeasurementDraftAssignment {
  if (contextOverride === undefined) return assignment
  const { executionContexts: _frozenContexts, ...withoutFrozenContexts } = assignment
  return { ...withoutFrozenContexts, contextOverride }
}

function upsertTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { target } = parseBody(measurementDraftUpsertTargetRequestSchema, body, 'upsert-target')
  const index = authoring.targets.findIndex(candidate => candidate.stableKey === target.stableKey)
  const targets = [...authoring.targets]
  if (index === -1) targets.push(target)
  else targets[index] = target
  return { authoring: { ...authoring, targets }, warnings: [] }
}

function renameTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, label } = parseBody(measurementDraftRenameTargetRequestSchema, body, 'rename-target')
  requireTarget(authoring, targetKey)
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, label } : target)),
    },
    warnings: [],
  }
}

/**
 * The survivor keeps its stable key, so its assignments and group membership
 * survive untouched; everything the merged Targets carried is folded into it.
 * A class the survivor already decided wins over the merged Target's, because
 * the merge is not an occasion to reopen a classification.
 */
function mergeTargets(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, mergedKeys } = parseBody(measurementDraftMergeTargetsRequestSchema, body, 'merge-targets')
  const survivor = requireTarget(authoring, targetKey)
  const absorbed = mergedKeys.filter(key => key !== targetKey)
  for (const key of absorbed) requireTarget(authoring, key)
  if (absorbed.length === 0) {
    return {
      authoring,
      warnings: [warn('merge-targets-noop', 'The merge named only the surviving Target.', ['targets', authoring.targets.indexOf(survivor)])],
    }
  }

  const absorbedSet = new Set(absorbed)
  const merged: MeasurementDraftTarget = {
    ...survivor,
    aliases: unique([...survivor.aliases, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.aliases)]),
    urlMatchers: unique([...survivor.urlMatchers, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.urlMatchers)]),
  }

  const assignments: MeasurementDraftAssignment[] = []
  const seen = new Set<string>()
  for (const assignment of authoring.assignments) {
    const owner = absorbedSet.has(assignment.targetKey) ? targetKey : assignment.targetKey
    const key = `${owner} ${assignment.queryId}`
    if (seen.has(key)) continue
    seen.add(key)
    assignments.push({ ...assignment, targetKey: owner })
  }

  return {
    authoring: {
      ...authoring,
      targets: authoring.targets
        .filter(target => !absorbedSet.has(target.stableKey))
        .map(target => (target.stableKey === targetKey ? merged : target)),
      assignments,
      groups: authoring.groups.map(group => ({
        ...group,
        targetKeys: unique(group.targetKeys.map(key => (absorbedSet.has(key) ? targetKey : key))),
      })),
    },
    warnings: [],
  }
}

function excludeTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, cleanup } = parseBody(measurementDraftExcludeTargetRequestSchema, body, 'exclude-target')
  const target = requireTarget(authoring, targetKey)
  const targetIndex = authoring.targets.indexOf(target)
  const stranded = authoring.assignments.filter(assignment => assignment.targetKey === targetKey).length
  if (cleanup === 'assignments-and-group-memberships') {
    return {
      authoring: {
        ...authoring,
        targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, status: 'excluded' as const } : target)),
        assignments: authoring.assignments.filter(assignment => assignment.targetKey !== targetKey),
        groups: authoring.groups.map(group => ({
          ...group,
          targetKeys: group.targetKeys.filter(key => key !== targetKey),
        })),
      },
      warnings: [],
    }
  }
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, status: 'excluded' as const } : target)),
    },
    // The assignments are kept rather than deleted: an exclusion is a review
    // decision that can be undone, and silently dropping the operator's query
    // selection would make undoing it a retype. Publish names them instead.
    warnings: stranded > 0
      ? [warn('excluded-target-has-assignments', `Target "${targetKey}" still has ${stranded} assignment(s); remove them or include the Target before publishing.`, ['targets', targetIndex, 'assignments'])]
      : [],
  }
}

/**
 * Rebinding follows a Target across a site restructure. The stable key is
 * untouched by construction, so assignments and group membership follow it; the
 * matcher that pointed at the old discovered URL is replaced rather than added
 * to, or the new one is appended when nothing matched.
 */
function rebindTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, discoveryIdentity, discoveredUrl } = parseBody(measurementDraftRebindTargetRequestSchema, body, 'rebind-target')
  const target = requireTarget(authoring, targetKey)
  const previous = target.discoveredUrl
  const replaced = previous
    ? target.urlMatchers.map(matcher => (matcher === previous ? discoveredUrl : matcher))
    : target.urlMatchers
  const urlMatchers = replaced.includes(discoveredUrl) ? unique(replaced) : unique([...replaced, discoveredUrl])
  return {
    authoring: {
      ...authoring,
      targets: authoring.targets.map(candidate => (candidate.stableKey === targetKey
        ? { ...candidate, discoveryIdentity, discoveredUrl, urlMatchers }
        : candidate)),
    },
    warnings: [],
  }
}

/**
 * Assigns project queries to a fully resolved audience and proposes a class
 * for new rows. It is deliberately pure so preview, apply, and replace cannot
 * drift in their dedupe or classification behavior.
 */
export function applyAssignmentsToAuthoring(
  authoring: MeasurementDraftAuthoring,
  request: MeasurementDraftAssignmentAudienceRequest,
  context: DraftActionContext,
): AssignmentAuthoringResult {
  const audience = resolveDraftAudience(authoring, request)
  const queryIds = knownQueryIds(request.queryIds, context)
  assertAssignmentActionLimit(audience, queryIds)

  const targetByKey = new Map(authoring.targets.map(target => [target.stableKey, target]))
  const assignments = [...authoring.assignments]
  const assignmentIndexes = new Map(assignments.map((assignment, index) => [
    `${assignment.targetKey}\u0000${assignment.queryId}`,
    index,
  ]))
  let added = 0
  for (const targetKey of audience.targetKeys) {
    for (const queryId of queryIds) {
      const key = `${targetKey}\u0000${queryId}`
      const index = assignmentIndexes.get(key)
      if (index === undefined) {
        assignmentIndexes.set(key, assignments.length)
        added++
        assignments.push({
          targetKey,
          queryId,
          ...(request.contextOverride ? { contextOverride: request.contextOverride } : {}),
          queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)),
          classificationSource: 'rule',
        })
        continue
      }
      const existing = assignments[index]!
      assignments[index] = {
        ...withRequestedContext(existing, request.contextOverride),
        ...(existing.classificationSource === 'operator'
          ? {}
          : { queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)) }),
      }
    }
  }
  const requested = audience.targetKeys.length * queryIds.length
  return {
    authoring: { ...authoring, assignments },
    warnings: [],
    audience,
    assignments: { requested, added, alreadyPresent: requested - added },
  }
}

/**
 * Removes only pairs outside the replacement audience, then writes any missing
 * pairs. A surviving pair keeps its operator classification and context
 * override exactly as an additive apply would.
 */
export function replaceAssignmentsInAuthoring(
  authoring: MeasurementDraftAuthoring,
  request: MeasurementDraftAssignmentAudienceRequest,
  context: DraftActionContext,
): AssignmentAuthoringResult {
  const queryIds = knownQueryIds(request.queryIds, context)
  // Resolve and cap before constructing the replacement candidate, so an
  // invalid group or oversized request never looks like it partially cleared.
  const audience = resolveDraftAudience(authoring, request)
  assertAssignmentActionLimit(audience, queryIds)
  const wantedQueries = new Set(queryIds)
  const wantedTargets = new Set(audience.targetKeys)
  const cleared: MeasurementDraftAuthoring = {
    ...authoring,
    assignments: authoring.assignments.filter(assignment => (
      !wantedQueries.has(assignment.queryId) || wantedTargets.has(assignment.targetKey)
    )),
  }
  const result = applyAssignmentsToAuthoring(cleared, { ...request, queryIds }, context)
  return { ...result, audience }
}

/**
 * Legacy `targetKey` stays exactly as it was; the bulk branch carries the
 * shared audience and can name groups. Both paths delegate to the same pure
 * concrete-assignment implementation after parsing.
 */
function applyAssignments(
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const parsed = parseBody(measurementDraftApplyAssignmentsRequestSchema, body, 'apply-assignments')
  const request: MeasurementDraftAssignmentAudienceRequest = 'targetKey' in parsed
    ? { targetKeys: [parsed.targetKey], queryIds: parsed.queryIds, ...(parsed.contextOverride ? { contextOverride: parsed.contextOverride } : {}) }
    : parsed
  return applyAssignmentsToAuthoring(authoring, request, context)
}

function replaceAssignments(
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const request = parseBody(measurementDraftReplaceAssignmentsRequestSchema, body, 'replace-assignments')
  return replaceAssignmentsInAuthoring(authoring, request, context)
}

/**
 * Each pair is one question on the one Target it names. Unlike
 * `apply-assignments` this never multiplies: N pairs produce at most N
 * assignments, so a per-Target question pattern can express what it promises.
 */
function applyPairedAssignments(
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const { pairs, contextOverride } = parseBody(measurementDraftApplyPairedAssignmentsRequestSchema, body, 'apply-paired-assignments')
  for (const pair of pairs) requireTarget(authoring, pair.targetKey)
  const unknown = pairs.filter(pair => !context.queriesById.has(pair.queryId)).map(pair => pair.queryId)
  if (unknown.length) {
    throw validationError(`The project has no query ${unique(unknown).map(id => `"${id}"`).join(', ')}. Add it before assigning it.`)
  }
  const distinctPairCount = new Set(pairs.map(pair => `${pair.targetKey}\u0000${pair.queryId}`)).size
  if (distinctPairCount > MAX_ASSIGNMENTS_PER_ACTION) {
    throw validationError(
      `This would create ${distinctPairCount.toLocaleString('en-US')} paired assignments, `
      + `over the ${MAX_ASSIGNMENTS_PER_ACTION.toLocaleString('en-US')} limit for one action.`,
    )
  }

  const targetByKey = new Map(authoring.targets.map(target => [target.stableKey, target]))
  const assignments = [...authoring.assignments]
  const assignmentIndexes = new Map(assignments.map((assignment, index) => [
    `${assignment.targetKey}\u0000${assignment.queryId}`,
    index,
  ]))
  for (const { targetKey, queryId } of pairs) {
    const key = `${targetKey}\u0000${queryId}`
    const index = assignmentIndexes.get(key)
    if (index === undefined) {
      assignmentIndexes.set(key, assignments.length)
      assignments.push({
        targetKey,
        queryId,
        ...(contextOverride ? { contextOverride } : {}),
        queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)),
        classificationSource: 'rule',
      })
      continue
    }
    // An operator classification outranks the rule, exactly as in the cross-product path.
    const existing = assignments[index]!
    assignments[index] = {
      ...withRequestedContext(existing, contextOverride),
      ...(existing.classificationSource === 'operator'
        ? {}
        : { queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)) }),
    }
  }
  return { authoring: { ...authoring, assignments }, warnings: [] }
}

function removeAssignment(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const parsed = parseBody(measurementDraftRemoveAssignmentRequestSchema, body, 'remove-assignment')
  const { queryId } = parsed
  const targetKeys = new Set('targetKeys' in parsed ? parsed.targetKeys : [parsed.targetKey])
  // The project query itself is never touched: other Targets may still assign
  // it, and every published snapshot of it has to stay readable.
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.filter(assignment => !(targetKeys.has(assignment.targetKey) && assignment.queryId === queryId)),
    },
    warnings: [],
  }
}

function clearAssignments(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey } = parseBody(measurementDraftClearAssignmentsRequestSchema, body, 'clear-assignments')
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.filter(assignment => assignment.targetKey !== targetKey),
    },
    warnings: [],
  }
}

/** An explicit classification is operator-sourced by definition; the server records that, not the caller. */
function classifyAssignments(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { queryClass, assignments: selected } = parseBody(measurementDraftClassifyAssignmentsRequestSchema, body, 'classify-assignments')
  const wanted = new Set(selected.map(entry => `${entry.targetKey} ${entry.queryId}`))
  const missing = selected.filter(entry => !authoring.assignments.some(
    assignment => assignment.targetKey === entry.targetKey && assignment.queryId === entry.queryId,
  ))
  if (missing.length) {
    throw notFound('Measurement draft assignment', `${missing[0]!.targetKey}/${missing[0]!.queryId}`)
  }
  return {
    authoring: {
      ...authoring,
      assignments: authoring.assignments.map(assignment => (
        wanted.has(`${assignment.targetKey} ${assignment.queryId}`)
          ? { ...assignment, queryClass, classificationSource: 'operator' as const }
          : assignment
      )),
    },
    warnings: [],
  }
}

/**
 * Reporting membership only. A legacy payload omits competitors and carries
 * the confirmed list forward. A full editor save includes competitors and
 * replaces the complete list in this same draft mutation.
 */
function upsertGroup(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { group } = parseBody(measurementDraftUpsertGroupRequestSchema, body, 'upsert-group')
  const index = authoring.groups.findIndex(candidate => candidate.stableKey === group.stableKey)
  const groups = [...authoring.groups]
  const next: MeasurementDraftGroup = {
    stableKey: group.stableKey,
    label: group.label,
    targetKeys: unique(group.targetKeys),
    competitors: group.competitors === undefined
      ? (index === -1 ? [] : groups[index]!.competitors)
      : group.competitors,
  }
  if (index === -1) groups.push(next)
  else groups[index] = next
  const groupIndex = index === -1 ? groups.length - 1 : index
  const unknown = next.targetKeys.filter(key => !authoring.targets.some(target => target.stableKey === key))
  return {
    authoring: { ...authoring, groups },
    warnings: unknown.length
      ? [warn('group-unknown-target', `Group "${group.stableKey}" names ${unknown.length} Target(s) the draft does not hold yet.`, ['groups', groupIndex, 'targetKeys'])]
      : [],
  }
}

function removeGroup(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey } = parseBody(measurementDraftRemoveGroupRequestSchema, body, 'remove-group')
  return {
    authoring: { ...authoring, groups: authoring.groups.filter(group => group.stableKey !== groupKey) },
    warnings: [],
  }
}

function upsertCompetitor(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey, competitor } = parseBody(measurementDraftUpsertCompetitorRequestSchema, body, 'upsert-competitor')
  const group = requireGroup(authoring, groupKey)
  const index = group.competitors.findIndex(candidate => candidate.stableKey === competitor.stableKey)
  const competitors = [...group.competitors]
  if (index === -1) competitors.push(competitor)
  else competitors[index] = competitor
  return {
    authoring: {
      ...authoring,
      groups: authoring.groups.map(candidate => (candidate.stableKey === groupKey ? { ...candidate, competitors } : candidate)),
    },
    warnings: [],
  }
}

function removeCompetitor(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey, competitorKey } = parseBody(measurementDraftRemoveCompetitorRequestSchema, body, 'remove-competitor')
  requireGroup(authoring, groupKey)
  return {
    authoring: {
      ...authoring,
      groups: authoring.groups.map(group => (group.stableKey === groupKey
        ? { ...group, competitors: group.competitors.filter(competitor => competitor.stableKey !== competitorKey) }
        : group)),
    },
    warnings: [],
  }
}

export function applyDraftAction(
  action: MeasurementDraftActionName,
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const result = (() => {
    switch (action) {
      case 'upsert-target': return upsertTarget(authoring, body)
      case 'rename-target': return renameTarget(authoring, body)
      case 'merge-targets': return mergeTargets(authoring, body)
      case 'exclude-target': return excludeTarget(authoring, body)
      case 'rebind-target': return rebindTarget(authoring, body)
      case 'apply-assignments': return applyAssignments(authoring, body, context)
      case 'replace-assignments': return replaceAssignments(authoring, body, context)
      case 'apply-paired-assignments': return applyPairedAssignments(authoring, body, context)
      case 'remove-assignment': return removeAssignment(authoring, body)
      case 'clear-assignments': return clearAssignments(authoring, body)
      case 'classify-assignments': return classifyAssignments(authoring, body)
      case 'upsert-group': return upsertGroup(authoring, body)
      case 'remove-group': return removeGroup(authoring, body)
      case 'upsert-competitor': return upsertCompetitor(authoring, body)
      case 'remove-competitor': return removeCompetitor(authoring, body)
    }
  })()
  assertMeasurementDraftAuthoringLimits(authoring, result.authoring)
  return result
}

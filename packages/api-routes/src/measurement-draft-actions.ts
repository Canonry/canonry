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
  measurementDraftRouteMarketsRequestSchema,
  measurementDraftRenameTargetRequestSchema,
  measurementDraftUpsertCompetitorRequestSchema,
  measurementDraftUpsertGroupRequestSchema,
  measurementDraftUpsertMarketRequestSchema,
  measurementV2UsageEdgeKey,
  measurementDraftUpsertTargetRequestSchema,
  measurementTargetNameIssueMessage,
  measurementTargetNameIssues,
  notFound,
  validationError,
  type MeasurementDraftAssignment,
  type MeasurementDraftAssignmentAudienceRequest,
  type MeasurementDraftAudience,
  type MeasurementDraftAuthoring,
  type MeasurementDraftGroup,
  type MeasurementDraftResolvedAudienceGroup,
  type MeasurementDraftRouteMarketsRequest,
  type MeasurementDraftTarget,
  type MeasurementDraftWarning,
  type LocationContext,
  compareText,
  openRouterRouteModel,
} from '@ainyc/canonry-contracts'
import { proposeQueryClassForTarget } from './measurement-draft-compile.js'
import { canonicalJson, sha256Hex } from './measurement-draft-repo.js'
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
  'route-markets',
  'remove-assignment',
  'clear-assignments',
  'classify-assignments',
  'upsert-group',
  'upsert-market',
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
  locationsByLabel?: ReadonlyMap<string, LocationContext>
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

export interface MarketRoutingAuthoringResult extends DraftActionResult {
  markets: Array<{
    marketKey: string
    label: string
    matchedEdges: number
    changedEdges: number
  }>
  matchedEdges: number
  changedEdges: number
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

type ExactExecutionContext = NonNullable<MeasurementDraftAssignment['executionContexts']>[number]
type ProviderModelOverride = Pick<NonNullable<MeasurementDraftAssignment['contextOverride']>, 'providers' | 'models'>
type UsageEdge = NonNullable<MeasurementDraftAuthoring['reportingScopes']>[number]['usageEdges'][number]

function normalizedProviders(values: readonly string[]): string[] {
  return unique(values.map(value => value.trim().toLowerCase()).filter(Boolean)).sort(compareText)
}

function normalizedModels(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values)
    .map(([provider, model]) => [provider.trim().toLowerCase(), model] as const)
    .sort(([left], [right]) => compareText(left, right)))
}

function normalizedExactContext(
  exact: ExactExecutionContext,
  queryId: string,
  override: ProviderModelOverride,
): ExactExecutionContext {
  const providers = normalizedProviders(override.providers ?? exact.providers)
  const models = normalizedModels(override.models ?? (override.providers === undefined ? exact.models : {}))
  for (const provider of providers) {
    const pinned = openRouterRouteModel(provider)
    if (pinned) models[provider] = pinned
  }
  const next = { providers, models, location: exact.location }
  const current = {
    providers: normalizedProviders(exact.providers),
    models: normalizedModels(exact.models),
    location: exact.location,
  }
  if (canonicalJson(next) === canonicalJson(current)) return exact
  return {
    ...next,
    executionNodeKey: `execution-${sha256Hex(canonicalJson({ queryId, ...next }))}`,
  }
}

function edgeKey(targetKey: string, queryId: string, executionNodeKey: string): string {
  return measurementV2UsageEdgeKey({ targetKey, queryId, executionNodeKey })
}

function remapReportingScopeEdges(
  reportingScopes: MeasurementDraftAuthoring['reportingScopes'],
  remaps: ReadonlyMap<string, UsageEdge>,
): MeasurementDraftAuthoring['reportingScopes'] {
  if (reportingScopes === undefined || remaps.size === 0) return reportingScopes
  return reportingScopes.map(scope => {
    const seen = new Set<string>()
    const usageEdges: UsageEdge[] = []
    for (const edge of scope.usageEdges) {
      const next = remaps.get(measurementV2UsageEdgeKey(edge)) ?? edge
      const key = measurementV2UsageEdgeKey(next)
      if (seen.has(key)) continue
      seen.add(key)
      usageEdges.push(next)
    }
    return { ...scope, usageEdges }
  })
}

function pruneReportingScopeEdges(
  reportingScopes: MeasurementDraftAuthoring['reportingScopes'],
  assignments: readonly MeasurementDraftAssignment[],
): MeasurementDraftAuthoring['reportingScopes'] {
  if (reportingScopes === undefined) return undefined
  // Keep context-stale membership while its target/query pair survives. The
  // compiler can deterministically rebuild a one-to-one successor after an
  // explicit location change; only a deleted assignment makes membership
  // unequivocally stale at authoring time.
  const validPairs = new Set(assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
  return reportingScopes.map(scope => ({
    ...scope,
    usageEdges: scope.usageEdges.filter(edge => validPairs.has(`${edge.targetKey}\u0000${edge.queryId}`)),
  }))
}

function authoringWithAssignments(
  authoring: MeasurementDraftAuthoring,
  assignments: MeasurementDraftAssignment[],
  reportingScopes: MeasurementDraftAuthoring['reportingScopes'] = authoring.reportingScopes,
): MeasurementDraftAuthoring {
  return {
    ...authoring,
    assignments,
    ...(reportingScopes === undefined
      ? {}
      : { reportingScopes: pruneReportingScopeEdges(reportingScopes, assignments) }),
  }
}

function mutableAssignmentContext(
  authoring: MeasurementDraftAuthoring,
  assignment: MeasurementDraftAssignment,
): { providers: string[]; models: Record<string, string>; locationLabels: string[] } {
  const override = assignment.contextOverride
  const providers = normalizedProviders(override?.providers ?? authoring.defaultContext.providers)
  const rawModels = normalizedModels(override?.models ?? authoring.defaultContext.models ?? {})
  const models = Object.fromEntries(Object.entries(rawModels).filter(([provider]) => providers.includes(provider)))
  for (const provider of providers) {
    const pinned = openRouterRouteModel(provider)
    if (pinned) models[provider] = pinned
  }
  const locationLabels = unique(override?.locations ?? authoring.defaultContext.locations).sort(compareText)
  return { providers, models, locationLabels }
}

function mutableAssignmentExactContext(
  authoring: MeasurementDraftAuthoring,
  assignment: MeasurementDraftAssignment,
  context: DraftActionContext,
): ExactExecutionContext {
  const { providers, models, locationLabels } = mutableAssignmentContext(authoring, assignment)
  if (locationLabels.length > 1) {
    throw validationError(
      `Market routing cannot safely choose among ${locationLabels.length} locations for ${assignment.targetKey}/${assignment.queryId}. Route the Property to one location first.`,
      { displayToOperator: true },
    )
  }
  const location = locationLabels.length === 0
    ? null
    : context.locationsByLabel?.get(locationLabels[0]!)
  if (locationLabels.length === 1 && !location) {
    throw validationError(`Location "${locationLabels[0]}" is unavailable for market routing. Reload the draft and try again.`, {
      displayToOperator: true,
    })
  }
  const resolvedLocation = location ?? null
  const locationIdentity = resolvedLocation
    ? [resolvedLocation.label, resolvedLocation.city, resolvedLocation.region, resolvedLocation.country].join('\u0000')
    : ''
  const executionNodeKey = `execution-${sha256Hex(canonicalJson({
    queryId: assignment.queryId,
    location: locationIdentity,
    providers,
    models,
  }))}`
  return { providers, models, location: resolvedLocation, executionNodeKey }
}

function normalizeSelectedOneToOneMarketEdges(
  authoring: MeasurementDraftAuthoring,
  selectedMarkets: ReadonlySet<string>,
  selectsEdge: (edge: UsageEdge) => boolean,
  context: DraftActionContext,
): MeasurementDraftAuthoring {
  const assignmentsByPair = new Map(authoring.assignments.map((assignment, index) => [
    `${assignment.targetKey}\u0000${assignment.queryId}`,
    { assignment, index },
  ]))
  const successorByPair = new Map<string, ExactExecutionContext>()
  const mutableIndexes = new Set<number>()

  for (const scope of authoring.reportingScopes ?? []) {
    if (!selectedMarkets.has(scope.stableKey)) continue
    for (const edge of scope.usageEdges) {
      if (!selectsEdge(edge)) continue
      const pair = `${edge.targetKey}\u0000${edge.queryId}`
      const found = assignmentsByPair.get(pair)
      if (!found) continue
      if (found.assignment.executionContexts?.some(exact => exact.executionNodeKey === edge.executionNodeKey)) continue
      if (successorByPair.has(pair)) continue

      if (found.assignment.executionContexts !== undefined) {
        if (found.assignment.executionContexts.length !== 1 || !found.assignment.executionContexts[0]!.executionNodeKey) {
          throw validationError(
            `Market routing cannot safely map stale membership for ${edge.targetKey}/${edge.queryId} across multiple contexts. Publish or restore one exact context first.`,
            { displayToOperator: true, marketEdge: edge },
          )
        }
        successorByPair.set(pair, found.assignment.executionContexts[0]!)
        continue
      }

      successorByPair.set(pair, mutableAssignmentExactContext(authoring, found.assignment, context))
      mutableIndexes.add(found.index)
    }
  }
  if (successorByPair.size === 0) return authoring

  const assignments = authoring.assignments.map((assignment, index) => {
    if (!mutableIndexes.has(index)) return assignment
    const successor = successorByPair.get(`${assignment.targetKey}\u0000${assignment.queryId}`)!
    const { contextOverride: _contextOverride, ...frozen } = assignment
    return { ...frozen, executionContexts: [successor] }
  })
  const reportingScopes = authoring.reportingScopes?.map(scope => {
    const seen = new Set<string>()
    const usageEdges: UsageEdge[] = []
    for (const edge of scope.usageEdges) {
      const successor = successorByPair.get(`${edge.targetKey}\u0000${edge.queryId}`)
      const next = successor?.executionNodeKey
        ? { ...edge, executionNodeKey: successor.executionNodeKey }
        : edge
      const key = measurementV2UsageEdgeKey(next)
      if (seen.has(key)) continue
      seen.add(key)
      usageEdges.push(next)
    }
    return { ...scope, usageEdges }
  })
  return authoringWithAssignments(authoring, assignments, reportingScopes)
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
  edgeRemaps?: Map<string, UsageEdge>,
): MeasurementDraftAssignment {
  if (contextOverride === undefined) return assignment
  if (assignment.executionContexts !== undefined && contextOverride.locations === undefined) {
    const contextsByIdentity = new Map<string, ExactExecutionContext>()
    for (const exact of assignment.executionContexts) {
      const rewritten = normalizedExactContext(exact, assignment.queryId, contextOverride)
      const identity = canonicalJson({
        providers: normalizedProviders(rewritten.providers),
        models: normalizedModels(rewritten.models),
        location: rewritten.location,
      })
      const kept = contextsByIdentity.get(identity) ?? rewritten
      contextsByIdentity.set(identity, kept)
      if (edgeRemaps && exact.executionNodeKey && kept.executionNodeKey && exact.executionNodeKey !== kept.executionNodeKey) {
        edgeRemaps.set(
          edgeKey(assignment.targetKey, assignment.queryId, exact.executionNodeKey),
          { targetKey: assignment.targetKey, queryId: assignment.queryId, executionNodeKey: kept.executionNodeKey },
        )
      }
    }
    return { ...assignment, executionContexts: [...contextsByIdentity.values()] }
  }
  const { executionContexts: _frozenContexts, ...withoutFrozenContexts } = assignment
  return { ...withoutFrozenContexts, contextOverride }
}

/**
 * Name advice rides on the response rather than refusing the write: a short or
 * brand-less name is sometimes the operator's deliberate choice, and the publish
 * review still refuses a qualified name with no stored name inside it.
 */
function upsertTarget(authoring: MeasurementDraftAuthoring, body: unknown, context: DraftActionContext): DraftActionResult {
  const { target } = parseBody(measurementDraftUpsertTargetRequestSchema, body, 'upsert-target')
  const index = authoring.targets.findIndex(candidate => candidate.stableKey === target.stableKey)
  const targets = [...authoring.targets]
  if (index === -1) targets.push(target)
  else targets[index] = target
  const warnings = measurementTargetNameIssues({
    aliases: target.aliases,
    ...(target.identityAliases === undefined ? {} : { identityAliases: target.identityAliases }),
    brandNames: context.brandNames,
  }).map(issue => warn(issue.code, measurementTargetNameIssueMessage(issue), ['target', issue.field, issue.index]))
  return { authoring: { ...authoring, targets }, warnings }
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
    ...([survivor, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey))].some(target => target.identityAliases !== undefined)
      ? { identityAliases: unique([...(survivor.identityAliases ?? []), ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.identityAliases ?? [])]) }
      : {}),
    urlMatchers: unique([...survivor.urlMatchers, ...authoring.targets.filter(target => absorbedSet.has(target.stableKey)).flatMap(target => target.urlMatchers)]),
  }

  const assignments: MeasurementDraftAssignment[] = []
  const assignmentIndexes = new Map<string, number>()
  for (const assignment of authoring.assignments) {
    const owner = absorbedSet.has(assignment.targetKey) ? targetKey : assignment.targetKey
    const key = `${owner}\u0000${assignment.queryId}`
    const mapped = { ...assignment, targetKey: owner }
    const index = assignmentIndexes.get(key)
    if (index === undefined) {
      assignmentIndexes.set(key, assignments.length)
      assignments.push(mapped)
      continue
    }

    const existing = assignments[index]!
    if ((existing.executionContexts === undefined) !== (mapped.executionContexts === undefined)) {
      throw validationError(
        `Cannot merge duplicate assignment ${targetKey}/${assignment.queryId} because it combines exact and editable execution contexts. Publish the editable context first or remove one duplicate assignment, then merge.`,
        { displayToOperator: true },
      )
    }
    if (
      existing.executionContexts === undefined
      && mapped.executionContexts === undefined
      && canonicalJson(mutableAssignmentContext(authoring, existing)) !== canonicalJson(mutableAssignmentContext(authoring, mapped))
    ) {
      throw validationError(
        `Cannot merge duplicate assignment ${targetKey}/${assignment.queryId} because its editable execution contexts differ. Align their providers, models, and locations or remove one duplicate assignment, then merge.`,
        { displayToOperator: true },
      )
    }
    const currentIsSurvivor = assignment.targetKey === targetKey
    const winner = currentIsSurvivor ? mapped : existing
    if (existing.executionContexts === undefined || mapped.executionContexts === undefined) {
      assignments[index] = winner
      continue
    }
    const contexts = new Map<string, ExactExecutionContext>()
    for (const exact of [...existing.executionContexts, ...mapped.executionContexts]) {
      const identity = exact.executionNodeKey ?? canonicalJson({
        providers: normalizedProviders(exact.providers),
        models: normalizedModels(exact.models),
        location: exact.location,
      })
      if (!contexts.has(identity)) contexts.set(identity, exact)
    }
    assignments[index] = { ...winner, executionContexts: [...contexts.values()] }
  }

  const reportingScopes = authoring.reportingScopes?.map(scope => {
    const seenEdges = new Set<string>()
    const usageEdges: UsageEdge[] = []
    for (const edge of scope.usageEdges) {
      const next = absorbedSet.has(edge.targetKey) ? { ...edge, targetKey } : edge
      const key = measurementV2UsageEdgeKey(next)
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      usageEdges.push(next)
    }
    return { ...scope, usageEdges }
  })

  return {
    authoring: authoringWithAssignments({
      ...authoring,
      targets: authoring.targets
        .filter(target => !absorbedSet.has(target.stableKey))
        .map(target => (target.stableKey === targetKey ? merged : target)),
      groups: authoring.groups.map(group => ({
        ...group,
        targetKeys: unique(group.targetKeys.map(key => (absorbedSet.has(key) ? targetKey : key))),
      })),
    }, assignments, reportingScopes),
    warnings: [],
  }
}

function excludeTarget(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey, cleanup } = parseBody(measurementDraftExcludeTargetRequestSchema, body, 'exclude-target')
  const target = requireTarget(authoring, targetKey)
  const targetIndex = authoring.targets.indexOf(target)
  const stranded = authoring.assignments.filter(assignment => assignment.targetKey === targetKey).length
  if (cleanup === 'assignments-and-group-memberships') {
    const assignments = authoring.assignments.filter(assignment => assignment.targetKey !== targetKey)
    return {
      authoring: authoringWithAssignments({
        ...authoring,
        targets: authoring.targets.map(target => (target.stableKey === targetKey ? { ...target, status: 'excluded' as const } : target)),
        groups: authoring.groups.map(group => ({
          ...group,
          targetKeys: group.targetKeys.filter(key => key !== targetKey),
        })),
      }, assignments),
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
  const edgeRemaps = new Map<string, UsageEdge>()
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
        ...withRequestedContext(existing, request.contextOverride, edgeRemaps),
        ...(existing.classificationSource === 'operator'
          ? {}
          : { queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)) }),
      }
    }
  }
  const requested = audience.targetKeys.length * queryIds.length
  return {
    authoring: authoringWithAssignments(
      authoring,
      assignments,
      remapReportingScopeEdges(authoring.reportingScopes, edgeRemaps),
    ),
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
  const edgeRemaps = new Map<string, UsageEdge>()
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
      ...withRequestedContext(existing, contextOverride, edgeRemaps),
      ...(existing.classificationSource === 'operator'
        ? {}
        : { queryClass: proposeQueryClassForTarget(context.queriesById.get(queryId)!, context.brandNames, targetByKey.get(targetKey)) }),
    }
  }
  return {
    authoring: authoringWithAssignments(
      authoring,
      assignments,
      remapReportingScopeEdges(authoring.reportingScopes, edgeRemaps),
    ),
    warnings: [],
  }
}

/**
 * Route the exact edges that one or more markets own. A context shared with an
 * unselected market is cloned; an exclusive context is replaced. Either way,
 * the location bytes stay frozen and unrelated market membership is untouched.
 */
export function routeMarketsInAuthoring(
  authoring: MeasurementDraftAuthoring,
  request: MeasurementDraftRouteMarketsRequest,
  context: DraftActionContext,
): MarketRoutingAuthoringResult {
  const assignmentPairs = new Set(authoring.assignments.map(assignment => `${assignment.targetKey}\u0000${assignment.queryId}`))
  const originalScopesByKey = new Map((authoring.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  const pairPrunedAuthoring = authoringWithAssignments(authoring, authoring.assignments)
  const marketKeys = unique(request.marketKeys)
  const availableScopesByKey = new Map((pairPrunedAuthoring.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  for (const marketKey of marketKeys) {
    const scope = availableScopesByKey.get(marketKey)
    if (!scope) {
      throw validationError(`Selected market "${marketKey}" is no longer available. Reload the draft and try again.`, {
        displayToOperator: true,
      })
    }
  }

  const targetFilter = request.targetKeys ? new Set(unique(request.targetKeys)) : null
  if (targetFilter) {
    for (const targetKey of targetFilter) {
      const target = requireTarget(pairPrunedAuthoring, targetKey)
      if (target.status !== 'included') {
        throw validationError(`Property "${target.label}" is ${target.status}, not included.`, { displayToOperator: true })
      }
    }
  }
  const queryFilter = request.queryIds ? new Set(knownQueryIds(request.queryIds, context)) : null
  const selectedMarkets = new Set(marketKeys)
  const selectsEdge = (edge: UsageEdge) => (
    (targetFilter === null || targetFilter.has(edge.targetKey))
    && (queryFilter === null || queryFilter.has(edge.queryId))
  )
  const routableAuthoring = normalizeSelectedOneToOneMarketEdges(
    pairPrunedAuthoring,
    selectedMarkets,
    selectsEdge,
    context,
  )
  const routableScopesByKey = new Map((routableAuthoring.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  const markets = marketKeys.map(marketKey => routableScopesByKey.get(marketKey)!)

  const staleSelectedEdges = new Map<string, UsageEdge>()
  for (const scope of authoring.reportingScopes ?? []) {
    if (!selectedMarkets.has(scope.stableKey)) continue
    for (const edge of scope.usageEdges) {
      if (!selectsEdge(edge) || assignmentPairs.has(`${edge.targetKey}\u0000${edge.queryId}`)) continue
      staleSelectedEdges.set(measurementV2UsageEdgeKey(edge), edge)
    }
  }

  const selectedEdges = new Map<string, UsageEdge>()
  const unselectedUses = new Set<string>()
  for (const scope of routableAuthoring.reportingScopes ?? []) {
    for (const edge of scope.usageEdges) {
      const key = measurementV2UsageEdgeKey(edge)
      if (selectedMarkets.has(scope.stableKey) && selectsEdge(edge)) selectedEdges.set(key, edge)
      else unselectedUses.add(key)
    }
  }

  const assignmentsByPair = new Map(routableAuthoring.assignments.map((assignment, index) => [
    `${assignment.targetKey}\u0000${assignment.queryId}`,
    { assignment, index },
  ]))
  const selectedKeysByAssignment = new Map<number, Set<string>>()
  for (const edge of selectedEdges.values()) {
    const found = assignmentsByPair.get(`${edge.targetKey}\u0000${edge.queryId}`)
    const exact = found?.assignment.executionContexts?.find(item => item.executionNodeKey === edge.executionNodeKey)
    if (!found || !exact) {
      throw validationError('A selected market contains a stale execution edge. Reload the draft and review its membership.', {
        displayToOperator: true,
        marketEdge: edge,
      })
    }
    const keys = selectedKeysByAssignment.get(found.index) ?? new Set<string>()
    keys.add(edge.executionNodeKey)
    selectedKeysByAssignment.set(found.index, keys)
  }

  const selectedEdgeRemaps = new Map<string, UsageEdge>()
  const assignments = routableAuthoring.assignments.map((assignment, assignmentIndex) => {
    const selectedKeys = selectedKeysByAssignment.get(assignmentIndex)
    if (!selectedKeys || assignment.executionContexts === undefined) return assignment

    const rewrittenByKey = new Map<string, ExactExecutionContext>()
    for (const exact of assignment.executionContexts) {
      if (!exact.executionNodeKey || !selectedKeys.has(exact.executionNodeKey)) continue
      rewrittenByKey.set(
        exact.executionNodeKey,
        normalizedExactContext(exact, assignment.queryId, request.contextOverride),
      )
    }

    // Retain every unselected/shared context first so a selected edge that is
    // routed to an already-existing context can reuse its stable key.
    const contextsByIdentity = new Map<string, ExactExecutionContext>()
    const identityOf = (exact: ExactExecutionContext) => canonicalJson({
      providers: normalizedProviders(exact.providers),
      models: normalizedModels(exact.models),
      location: exact.location,
    })
    for (const exact of assignment.executionContexts) {
      const rewritten = exact.executionNodeKey ? rewrittenByKey.get(exact.executionNodeKey) : undefined
      const changed = rewritten !== undefined && identityOf(rewritten) !== identityOf(exact)
      const originalEdgeKey = exact.executionNodeKey
        ? edgeKey(assignment.targetKey, assignment.queryId, exact.executionNodeKey)
        : null
      if (!changed || (originalEdgeKey !== null && unselectedUses.has(originalEdgeKey))) {
        contextsByIdentity.set(identityOf(exact), exact)
      }
    }

    for (const exact of assignment.executionContexts) {
      if (!exact.executionNodeKey || !selectedKeys.has(exact.executionNodeKey)) continue
      const rewritten = rewrittenByKey.get(exact.executionNodeKey)!
      const identity = identityOf(rewritten)
      const kept = contextsByIdentity.get(identity) ?? rewritten
      contextsByIdentity.set(identity, kept)
      if (!kept.executionNodeKey) continue
      selectedEdgeRemaps.set(
        edgeKey(assignment.targetKey, assignment.queryId, exact.executionNodeKey),
        { targetKey: assignment.targetKey, queryId: assignment.queryId, executionNodeKey: kept.executionNodeKey },
      )
    }
    return { ...assignment, executionContexts: [...contextsByIdentity.values()] }
  })

  const marketStats = markets.map(scope => {
    const matched = scope.usageEdges.filter(selectsEdge)
    const stale = (originalScopesByKey.get(scope.stableKey)?.usageEdges ?? [])
      .filter(edge => selectsEdge(edge) && !assignmentPairs.has(`${edge.targetKey}\u0000${edge.queryId}`))
    return {
      marketKey: scope.stableKey,
      label: scope.label,
      matchedEdges: matched.length + stale.length,
      changedEdges: stale.length + matched.filter(edge => {
        const next = selectedEdgeRemaps.get(measurementV2UsageEdgeKey(edge))
        return next !== undefined && next.executionNodeKey !== edge.executionNodeKey
      }).length,
    }
  })
  const reroutedEdges = [...selectedEdges.entries()].filter(([key, edge]) => {
    const next = selectedEdgeRemaps.get(key)
    return next !== undefined && next.executionNodeKey !== edge.executionNodeKey
  }).length
  const matchedEdges = new Set([...selectedEdges.keys(), ...staleSelectedEdges.keys()]).size
  const changedEdges = reroutedEdges + staleSelectedEdges.size
  if (changedEdges === 0) {
    return {
      authoring: routableAuthoring,
      warnings: [],
      markets: marketStats,
      matchedEdges,
      changedEdges: 0,
    }
  }

  const reportingScopes = (routableAuthoring.reportingScopes ?? []).map(scope => {
    if (!selectedMarkets.has(scope.stableKey)) return scope
    const seen = new Set<string>()
    const usageEdges: UsageEdge[] = []
    for (const edge of scope.usageEdges) {
      const next = selectsEdge(edge)
        ? selectedEdgeRemaps.get(measurementV2UsageEdgeKey(edge)) ?? edge
        : edge
      const key = measurementV2UsageEdgeKey(next)
      if (seen.has(key)) continue
      seen.add(key)
      usageEdges.push(next)
    }
    return { ...scope, usageEdges }
  })
  return {
    authoring: authoringWithAssignments(routableAuthoring, assignments, reportingScopes),
    warnings: [],
    markets: marketStats,
    matchedEdges,
    changedEdges,
  }
}

function routeMarkets(
  authoring: MeasurementDraftAuthoring,
  body: unknown,
  context: DraftActionContext,
): DraftActionResult {
  const request = parseBody(measurementDraftRouteMarketsRequestSchema, body, 'route-markets')
  return routeMarketsInAuthoring(authoring, request, context)
}

function removeAssignment(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const parsed = parseBody(measurementDraftRemoveAssignmentRequestSchema, body, 'remove-assignment')
  const { queryId } = parsed
  const targetKeys = new Set('targetKeys' in parsed ? parsed.targetKeys : [parsed.targetKey])
  // The project query itself is never touched: other Targets may still assign
  // it, and every published snapshot of it has to stay readable.
  const assignments = authoring.assignments.filter(assignment => !(targetKeys.has(assignment.targetKey) && assignment.queryId === queryId))
  return {
    authoring: authoringWithAssignments(authoring, assignments),
    warnings: [],
  }
}

function clearAssignments(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { targetKey } = parseBody(measurementDraftClearAssignmentsRequestSchema, body, 'clear-assignments')
  const assignments = authoring.assignments.filter(assignment => assignment.targetKey !== targetKey)
  return {
    authoring: authoringWithAssignments(authoring, assignments),
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
    ...(group.parentGroupKey === undefined
      ? (index === -1 || groups[index].parentGroupKey === undefined ? {} : { parentGroupKey: groups[index].parentGroupKey })
      : group.parentGroupKey === null ? {} : { parentGroupKey: group.parentGroupKey }),
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

function upsertMarket(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { market } = parseBody(measurementDraftUpsertMarketRequestSchema, body, 'upsert-market')
  if (market.groupKey !== undefined) {
    const group = authoring.groups.find(group => group.stableKey === market.groupKey)
    if (!group || market.usageEdges.some(edge => !group.targetKeys.includes(edge.targetKey))) throw validationError('A market must link to an existing group containing all its assigned properties.')
  }
  const included = new Set(authoring.targets.filter(target => target.status === 'included').map(target => target.stableKey))
  const frozen = new Set(authoring.assignments.flatMap(assignment => (assignment.executionContexts ?? [])
    .filter(context => context.executionNodeKey !== undefined)
    .map(context => measurementV2UsageEdgeKey({ targetKey: assignment.targetKey, queryId: assignment.queryId, executionNodeKey: context.executionNodeKey! }))))
  const seen = new Set<string>()
  for (const edge of market.usageEdges) {
    const key = measurementV2UsageEdgeKey(edge)
    if (!included.has(edge.targetKey) || !frozen.has(key)) throw validationError('Market members must be existing frozen assignments on included Properties.')
    if (seen.has(key)) throw validationError('Market membership contains a duplicate assignment.')
    seen.add(key)
  }
  const reportingScopes = [...(authoring.reportingScopes ?? [])]
  const index = reportingScopes.findIndex(scope => scope.stableKey === market.stableKey)
  if (index === -1) reportingScopes.push(market)
  else reportingScopes[index] = market
  return { authoring: { ...authoring, reportingScopes }, warnings: [] }
}

function removeGroup(authoring: MeasurementDraftAuthoring, body: unknown): DraftActionResult {
  const { groupKey } = parseBody(measurementDraftRemoveGroupRequestSchema, body, 'remove-group')
  const children = authoring.groups.filter(group => group.parentGroupKey === groupKey)
  if (children.length) {
    throw validationError('Cannot remove group ' + groupKey + ' while it is the explicit parent of: ' + children.map(group => group.stableKey).join(', ') + '. Reparent or remove its child groups first.', { displayToOperator: true })
  }
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
      case 'upsert-target': return upsertTarget(authoring, body, context)
      case 'rename-target': return renameTarget(authoring, body)
      case 'merge-targets': return mergeTargets(authoring, body)
      case 'exclude-target': return excludeTarget(authoring, body)
      case 'rebind-target': return rebindTarget(authoring, body)
      case 'apply-assignments': return applyAssignments(authoring, body, context)
      case 'replace-assignments': return replaceAssignments(authoring, body, context)
      case 'apply-paired-assignments': return applyPairedAssignments(authoring, body, context)
      case 'route-markets': return routeMarkets(authoring, body, context)
      case 'remove-assignment': return removeAssignment(authoring, body)
      case 'clear-assignments': return clearAssignments(authoring, body)
      case 'classify-assignments': return classifyAssignments(authoring, body)
      case 'upsert-group': return upsertGroup(authoring, body)
      case 'upsert-market': return upsertMarket(authoring, body)
      case 'remove-group': return removeGroup(authoring, body)
      case 'upsert-competitor': return upsertCompetitor(authoring, body)
      case 'remove-competitor': return removeCompetitor(authoring, body)
    }
  })()
  assertMeasurementDraftAuthoringLimits(authoring, result.authoring)
  return result
}

/**
 * One stored-evidence visibility report endpoint.
 *
 * The route only reconstructs frozen inputs and reads persisted snapshots. It
 * has no provider dependency and deliberately does not share browser drawer
 * state: `runId` is a request parameter for this response only.
 */

import { createHash } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunKinds,
  RunStatuses,
  RunTriggers,
  compileBrandAliases,
  effectiveBrandNames,
  matcherMatchesText,
  measurementV2UsageEdgeKey,
  normalizeMeasurementHost,
  parseStoredMeasurementPlanAnyVersion,
  validationError,
  visibilityReportQuerySchema,
  visibilityReportResponseSchema,
  type MeasurementPlanV2,
  type SimpleMeasurementDefinition,
  type VisibilityReportPopulationClass,
  type VisibilityReportQuery,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions,
  querySnapshots,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import {
  buildMeasurementPlanV2Manifest,
  buildMeasurementPlanV2ReportInput,
  measurementRunExpectedSlots,
} from './measurement-report-adapter.js'
import { buildMeasurementEvidence } from './measurement-report.js'
import {
  buildVisibilityReport,
  VisibilityReportCursorError,
  VisibilityReportScopeError,
  type VisibilityReportDefinitionInput,
  type VisibilityReportObservationInput,
  type VisibilityReportReaderInput,
  type VisibilityReportRunInput,
} from './visibility-report-reader.js'

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

/** Provider-supplied alternative names are observations, never identities. */
function observedCompetitorNames(values: readonly string[] | null | undefined): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    const name = value.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function parseQuery(raw: Record<string, unknown>): VisibilityReportQuery {
  const candidate = {
    ...raw,
    ...(raw.revision === undefined ? {} : { revision: Number(raw.revision) }),
    ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
  }
  const parsed = visibilityReportQuerySchema.safeParse(candidate)
  if (!parsed.success) {
    throw validationError('Invalid visibility report query', { issues: parsed.error.issues })
  }
  return parsed.data
}

function modelFingerprint(run: typeof runs.$inferSelect): string | null {
  if (run.measurementExecutionIdentity?.checksum) return run.measurementExecutionIdentity.checksum
  return null
}

/** Trend detail is bounded; query and answer collections carry their own cursors. */
const VISIBILITY_REPORT_MAX_RUNS = 100

/** The report deliberately never reads raw provider payloads. */
type VisibilitySnapshot = Pick<typeof querySnapshots.$inferSelect,
  | 'id'
  | 'runId'
  | 'queryId'
  | 'queryText'
  | 'provider'
  | 'model'
  | 'servedModel'
  | 'citationState'
  | 'answerMentioned'
  | 'answerText'
  | 'recommendedCompetitors'
  | 'citedDomains'
  | 'citedUrls'
  | 'captureStatus'
  | 'location'
  | 'measurementExecutionId'
  | 'requestedContext'
  | 'supportedContext'
  | 'createdAt'
>

function loadVisibilitySnapshots(db: DatabaseClient, runIds: readonly string[]): Map<string, VisibilitySnapshot[]> {
  const byRun = new Map<string, VisibilitySnapshot[]>()
  if (runIds.length === 0) return byRun
  const rows = db.select({
    id: querySnapshots.id,
    runId: querySnapshots.runId,
    queryId: querySnapshots.queryId,
    queryText: querySnapshots.queryText,
    provider: querySnapshots.provider,
    model: querySnapshots.model,
    servedModel: querySnapshots.servedModel,
    citationState: querySnapshots.citationState,
    answerMentioned: querySnapshots.answerMentioned,
    answerText: querySnapshots.answerText,
    recommendedCompetitors: querySnapshots.recommendedCompetitors,
    citedDomains: querySnapshots.citedDomains,
    citedUrls: querySnapshots.citedUrls,
    captureStatus: querySnapshots.captureStatus,
    location: querySnapshots.location,
    measurementExecutionId: querySnapshots.measurementExecutionId,
    requestedContext: querySnapshots.requestedContext,
    supportedContext: querySnapshots.supportedContext,
    createdAt: querySnapshots.createdAt,
  }).from(querySnapshots).where(inArray(querySnapshots.runId, [...runIds])).all()
  for (const row of rows) {
    const snapshots = byRun.get(row.runId) ?? []
    snapshots.push(row)
    byRun.set(row.runId, snapshots)
  }
  return byRun
}

/** Adapter compatibility seam: every field it reads is selected above; raw fallback is disabled. */
function adapterSnapshots(snapshots: readonly VisibilitySnapshot[]): readonly (typeof querySnapshots.$inferSelect)[] {
  return snapshots.map(snapshot => ({ ...snapshot, rawResponse: null }) as unknown as typeof querySnapshots.$inferSelect)
}

function frozenCompetitorMatchers(
  competitors: readonly { domain: string; label: string; aliases: readonly string[] }[],
): Map<string, ReturnType<typeof compileBrandAliases>> {
  const aliases = new Map<string, string[]>()
  for (const competitor of competitors) {
    const values = aliases.get(competitor.domain) ?? []
    values.push(competitor.label, ...competitor.aliases)
    aliases.set(competitor.domain, values)
  }
  return new Map([...aliases].map(([domain, values]) => [domain, compileBrandAliases(values)]))
}

function exactCompetitorMatchers(plan: MeasurementPlanV2): Map<string, ReturnType<typeof compileBrandAliases>> {
  return frozenCompetitorMatchers(plan.groups.flatMap(group => group.competitors))
}

function competitorSignals(
  snapshot: Pick<VisibilitySnapshot, 'answerText' | 'citedDomains'>,
  matchers: ReadonlyMap<string, ReturnType<typeof compileBrandAliases>>,
): { mentioned: string[]; cited: string[] } {
  const mentioned = snapshot.answerText === null
    ? []
    : [...matchers].filter(([, matcher]) => matcherMatchesText(matcher, snapshot.answerText)).map(([domain]) => domain)
  const citedDomains = new Set(snapshot.citedDomains.map(value => {
    try {
      return normalizeMeasurementHost(value)
    } catch {
      return normalizedText(value)
    }
  }))
  const cited = [...matchers.keys()].filter(domain => citedDomains.has(normalizeMeasurementHost(domain)))
  return { mentioned, cited }
}

function activeV2Definition(plan: MeasurementPlanV2, revision: number): VisibilityReportDefinitionInput {
  return v2Definition(plan, revision, buildMeasurementPlanV2Manifest(plan), null)
}

function v2Definition(
  plan: MeasurementPlanV2,
  revision: number,
  manifest: ReturnType<typeof buildMeasurementPlanV2Manifest>,
  run: typeof runs.$inferSelect | null,
): VisibilityReportDefinitionInput {
  const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
  const classes = new Map<string, VisibilityReportPopulationClass>(plan.assignments.map(assignment => [
    // Authoring currently forbids duplicate target/query assignments, but a
    // frozen edge also owns its execution context. Keep the lookup at that
    // exact granularity so a malformed or future context-specific plan cannot
    // borrow a class from a sibling execution.
    `${assignment.executionNodeKey}\u0000${assignment.targetKey}\u0000${assignment.queryId}`,
    assignment.queryClass,
  ]))
  const groupsForTarget = new Map<string, string[]>()
  const competitorsForTarget = new Map<string, string[]>()
  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) {
      const groups = groupsForTarget.get(targetKey) ?? []
      groups.push(group.stableKey)
      groupsForTarget.set(targetKey, groups)
      const competitors = competitorsForTarget.get(targetKey) ?? []
      competitors.push(...group.competitors.map(competitor => competitor.domain))
      competitorsForTarget.set(targetKey, competitors)
    }
  }
  const marketsForEdge = new Map<string, string[]>()
  for (const market of plan.reportingScopes ?? []) {
    for (const edge of market.usageEdges) {
      const key = measurementV2UsageEdgeKey(edge)
      const markets = marketsForEdge.get(key) ?? []
      markets.push(market.stableKey)
      marketsForEdge.set(key, markets)
    }
  }
  const manifestExecutions = new Set(manifest.expectedSlots.map(slot => slot.executionId))
  const scopedTargets = run?.measurementScope?.resolvedTargets.length
    ? new Set(run.measurementScope.resolvedTargets)
    : null
  const edges = plan.usageEdges
    .filter(edge => manifestExecutions.has(edge.executionNodeKey))
    .filter(edge => scopedTargets === null || scopedTargets.has(edge.targetKey))
    .map(edge => {
      const queryClass: VisibilityReportPopulationClass = classes.get(
        `${edge.executionNodeKey}\u0000${edge.targetKey}\u0000${edge.queryId}`,
      ) ?? 'unknown'
      return {
      id: `target:${edge.targetKey}:${edge.queryId}:${edge.executionNodeKey}`,
      executionId: edge.executionNodeKey,
      targetKey: edge.targetKey,
      queryId: edge.queryId,
      // A frozen v2 assignment should have a class. Treat an unexpected hole
      // as explicit unknown rather than inventing non-brand.
      queryClass,
      groupKeys: [...new Set(groupsForTarget.get(edge.targetKey) ?? [])],
      marketKeys: [...new Set(marketsForEdge.get(measurementV2UsageEdgeKey(edge)) ?? [])],
      competitorDomains: [...new Set(competitorsForTarget.get(edge.targetKey) ?? [])],
      }
    })
  const slots = manifest.expectedSlots.map(slot => {
    const node = nodes.get(slot.executionId)
    if (!node) throw new Error(`Measurement manifest references unknown execution ${slot.executionId}`)
    return {
      id: `slot:${slot.executionId}:${slot.provider}`,
      executionId: slot.executionId,
      queryKey: `${node.queryId}:${node.stableKey}`,
      queryId: node.queryId,
      query: node.queryText,
      provider: slot.provider,
      location: slot.context?.label ?? null,
    }
  })
  const scopeOptions = [
    { id: 'project', label: 'Project', kind: 'project' as const, targetCount: plan.targets.length },
    ...plan.groups.map(group => ({ id: group.stableKey, label: group.label, kind: 'group' as const, targetCount: group.targetKeys.length })),
    ...plan.reportingScopes?.map(market => ({
      id: market.stableKey,
      label: market.label,
      kind: 'market' as const,
      targetCount: new Set(market.usageEdges.map(edge => edge.targetKey)).size,
    })) ?? [],
    ...plan.targets.map(target => ({ id: target.stableKey, label: target.label, kind: 'property' as const, targetCount: 1 })),
  ]
  return {
    revision,
    provenance: { kind: 'frozen-advanced', definitionRevision: revision },
    scopeOptions,
    targets: plan.targets.map(target => ({ id: target.stableKey, label: target.label, mentionEligible: !target.mentionNotApplicable })),
    groups: plan.groups.map(group => ({ id: group.stableKey, label: group.label, targetKeys: group.targetKeys })),
    competitorAvailability: { state: 'available' },
    slots,
    edges,
  }
}

function v2Observations(
  plan: MeasurementPlanV2,
  revision: number,
  run: typeof runs.$inferSelect,
  snapshots: readonly VisibilitySnapshot[],
) {
  const manifest = measurementRunExpectedSlots(run, plan)
  const materialized = buildMeasurementPlanV2ReportInput(revision, plan, manifest, adapterSnapshots(snapshots))
  const evidence = buildMeasurementEvidence(materialized.input)
  const rawById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]))
  const answersByObservation = new Map<string, typeof evidence.answers>()
  for (const answer of evidence.answers) {
    const rows = answersByObservation.get(answer.observationId) ?? []
    rows.push(answer)
    answersByObservation.set(answer.observationId, rows)
  }
  const edgeById = new Map(materialized.input.usageEdges.map(edge => [edge.id, edge]))
  const competitors = exactCompetitorMatchers(plan)
  const output: VisibilityReportObservationInput[] = []
  for (const observation of materialized.input.observations) {
    const raw = rawById.get(observation.id)
    if (!raw || observation.executionId === null) continue
    const answers = answersByObservation.get(observation.id) ?? []
    const targetFor = (answer: typeof answers[number]) => {
      const edge = edgeById.get(answer.usageEdgeId)
      return edge?.type === 'target' ? edge.targetId : null
    }
    const signals = competitorSignals(raw, competitors)
    output.push({
      slotId: `slot:${observation.executionId}:${observation.provider}`,
      answerId: raw.id,
      model: raw.servedModel?.trim() || null,
      answerText: raw.answerText,
      // `answerMentioned` is the legacy project-level boolean. It cannot say
      // WHICH Property an answer named, so a portfolio may use it neither as
      // a positive nor as a measured negative when the answer body is absent.
      mentionComplete: raw.answerText !== null,
      mentionedTargetKeys: answers.filter(answer => answer.mentioned === true).map(targetFor).filter((value): value is string => value !== null),
      citedTargetKeys: answers.filter(answer => answer.cited === true).map(targetFor).filter((value): value is string => value !== null),
      citationComplete: answers.length > 0 && answers.every(answer => answer.evidenceComplete),
      competitorMentionDomains: signals.mentioned,
      competitorCitationDomains: signals.cited,
      observedCompetitorNames: observedCompetitorNames(raw.recommendedCompetitors),
      sources: [...new Set(answers.flatMap(answer => answer.sources.map(source => source.sourceUrl)))],
      createdAt: raw.createdAt,
    })
  }
  return { manifest, observations: output }
}

function advancedRun(
  run: typeof runs.$inferSelect,
  version: typeof measurementPlanVersions.$inferSelect,
  plan: MeasurementPlanV2,
  snapshots: readonly VisibilitySnapshot[],
  comparableDefinitionIds: readonly string[],
): VisibilityReportRunInput {
  const populated = v2Observations(plan, version.revision, run, snapshots)
  return {
    id: run.id,
    createdAt: run.createdAt,
    completedAt: run.finishedAt,
    state: run.status === RunStatuses.partial ? 'partial' : 'measured',
    probe: false,
    definition: v2Definition(plan, version.revision, populated.manifest, run),
    definitionId: version.id,
    comparableDefinitionIds,
    modelFingerprint: modelFingerprint(run),
    observations: populated.observations,
  }
}

function simpleScope(label: string, mentionEligible: boolean) {
  return {
    revision: null,
    provenance: { kind: 'legacy-simple' as const, definitionRevision: null },
    scopeOptions: [{ id: 'project', label: 'Project', kind: 'project' as const, targetCount: 1 }],
    targets: [{ id: 'project', label, mentionEligible }],
    groups: [],
    competitorAvailability: { state: 'unavailable' as const, reason: 'frozen-competitor-identity-missing' as const },
  }
}

function stableSimpleDefinitionId(definition: SimpleMeasurementDefinition): string {
  const source = {
    schemaVersion: definition.schemaVersion,
    identity: {
      displayName: definition.identity.displayName,
      aliases: [...definition.identity.aliases].sort(),
      canonicalDomain: definition.identity.canonicalDomain,
      ownedDomains: [...definition.identity.ownedDomains].sort(),
    },
    country: definition.country,
    language: definition.language,
    location: definition.location,
    queries: [...definition.queries]
      .map(query => ({ queryId: query.queryId, queryText: query.queryText, provenance: query.provenance, queryClass: query.queryClass }))
      .sort((left, right) => left.queryId.localeCompare(right.queryId, 'en')),
    // `undefined` deliberately differs from `[]`: historical sidecars did
    // not freeze a competitor set, whereas a newly captured empty list did.
    competitors: definition.competitors === undefined
      ? null
      : [...definition.competitors]
        .map(competitor => ({ domain: competitor.domain, label: competitor.label, aliases: [...competitor.aliases].sort() }))
        .sort((left, right) => left.domain.localeCompare(right.domain, 'en')),
  }
  return `simple:${createHash('sha256').update(JSON.stringify(source)).digest('hex')}`
}

function simpleModelFingerprint(definition: SimpleMeasurementDefinition): string {
  const engines = [...definition.engines]
    .map(engine => ({ provider: normalizedText(engine.provider), requestedModel: engine.requestedModel }))
    .sort((left, right) => left.provider.localeCompare(right.provider, 'en'))
  return `simple-model:${createHash('sha256').update(JSON.stringify(engines)).digest('hex')}`
}

function frozenSimpleRun(
  run: typeof runs.$inferSelect,
  definition: SimpleMeasurementDefinition,
  snapshots: readonly VisibilitySnapshot[],
): VisibilityReportRunInput {
  const matcher = compileBrandAliases(effectiveBrandNames({
    displayName: definition.identity.displayName,
    aliases: definition.identity.aliases,
    canonicalDomain: definition.identity.canonicalDomain,
    ownedDomains: definition.identity.ownedDomains,
  }))
  const queriesById = new Map(definition.queries.map(query => [query.queryId, query]))
  const queriesByText = new Map<string, SimpleMeasurementDefinition['queries'][number][]>()
  for (const query of definition.queries) {
    const matches = queriesByText.get(query.queryText) ?? []
    matches.push(query)
    queriesByText.set(query.queryText, matches)
  }
  const enginesByProvider = new Map(definition.engines.map(engine => [normalizedText(engine.provider), engine]))
  const competitors = definition.competitors === undefined
    ? null
    : frozenCompetitorMatchers(definition.competitors)
  const slots = definition.queries.flatMap(query => definition.engines.map(engine => ({
    id: `slot:simple:${query.queryId}:${normalizedText(engine.provider)}`,
    executionId: `simple:${query.queryId}`,
    queryKey: query.queryId,
    queryId: query.queryId,
    query: query.queryText,
    provider: normalizedText(engine.provider),
    location: definition.location?.label ?? null,
  })))
  const slotKeys = new Set(slots.map(slot => slot.id))
  const observations: VisibilityReportObservationInput[] = []
  for (const snapshot of snapshots) {
    const provider = normalizedText(snapshot.provider)
    const engine = enginesByProvider.get(provider)
    if (!engine) throw new Error(`Frozen simple definition has no provider ${snapshot.provider} for stored snapshot ${snapshot.id}`)
    const query = snapshot.queryId === null
      ? (() => {
          if (snapshot.queryText === null) throw new Error(`Frozen simple snapshot ${snapshot.id} has no query identity`)
          const matches = queriesByText.get(snapshot.queryText) ?? []
          if (matches.length !== 1) throw new Error(`Frozen simple snapshot ${snapshot.id} cannot uniquely resolve its query text`)
          return matches[0]!
        })()
      : queriesById.get(snapshot.queryId)
    if (!query) throw new Error(`Frozen simple definition has no query ${snapshot.queryId} for stored snapshot ${snapshot.id}`)
    if (snapshot.queryText !== query.queryText) {
      throw new Error(`Frozen simple query text is corrupt for stored snapshot ${snapshot.id}`)
    }
    if (engine.requestedModel !== null && snapshot.model !== engine.requestedModel) {
      throw new Error(`Frozen simple requested model is corrupt for stored snapshot ${snapshot.id}`)
    }
    const slotId = `slot:simple:${query.queryId}:${provider}`
    if (!slotKeys.has(slotId)) throw new Error(`Frozen simple definition has no slot for stored snapshot ${snapshot.id}`)
    const mentioned = snapshot.answerText !== null
      ? matcherMatchesText(matcher, snapshot.answerText)
      : snapshot.answerMentioned === true
    const competitorSignalsForSnapshot = competitors === null
      ? { mentioned: [], cited: [] }
      : competitorSignals(snapshot, competitors)
    observations.push({
      slotId,
      answerId: snapshot.id,
      model: snapshot.servedModel?.trim() || null,
      answerText: snapshot.answerText,
      mentionComplete: snapshot.answerText !== null || snapshot.answerMentioned !== null,
      mentionedTargetKeys: mentioned ? ['project'] : [],
      citedTargetKeys: snapshot.citationState === 'cited' ? ['project'] : [],
      citationComplete: true,
      competitorMentionDomains: competitorSignalsForSnapshot.mentioned,
      competitorCitationDomains: competitorSignalsForSnapshot.cited,
      observedCompetitorNames: observedCompetitorNames(snapshot.recommendedCompetitors),
      sources: snapshot.citedUrls ?? [],
      createdAt: snapshot.createdAt,
    })
  }
  return {
    id: run.id,
    createdAt: run.createdAt,
    completedAt: run.finishedAt,
    state: run.status === RunStatuses.partial ? 'partial' : 'measured',
    probe: false,
    definition: {
      ...simpleScope(definition.identity.displayName, matcher.keys.size > 0),
      provenance: { kind: 'frozen-simple', definitionRevision: null },
      competitorAvailability: definition.competitors === undefined
        ? { state: 'unavailable' as const, reason: 'frozen-competitor-identity-missing' as const }
        : { state: 'available' as const },
      slots,
      edges: definition.queries.map(query => ({
        id: `simple:${query.queryId}`,
        executionId: `simple:${query.queryId}`,
        targetKey: 'project',
        queryId: query.queryId,
        queryClass: query.queryClass ?? 'unknown',
        groupKeys: [],
        marketKeys: [],
        competitorDomains: definition.competitors?.map(competitor => competitor.domain) ?? [],
      })),
    },
    definitionId: stableSimpleDefinitionId(definition),
    comparableDefinitionIds: [],
    modelFingerprint: simpleModelFingerprint(definition),
    observations,
  }
}

function legacySimpleRun(
  project: { displayName: string; canonicalDomain: string },
  run: typeof runs.$inferSelect,
  snapshots: readonly VisibilitySnapshot[],
): VisibilityReportRunInput {
  const slots = snapshots.map(snapshot => ({
    id: `slot:legacy:${snapshot.id}`,
    executionId: `legacy:${snapshot.id}`,
    queryKey: snapshot.queryId ?? `legacy:${snapshot.queryText ?? snapshot.id}`,
    queryId: snapshot.queryId,
    query: snapshot.queryText ?? '',
    provider: normalizedText(snapshot.provider),
    location: snapshot.location,
  }))
  return {
    id: run.id,
    createdAt: run.createdAt,
    completedAt: run.finishedAt,
    state: run.status === RunStatuses.partial ? 'partial' : 'measured',
    probe: false,
    definition: {
      ...simpleScope(project.displayName, true),
      slots,
      edges: slots.map(slot => ({
        id: `edge:${slot.id}`,
        executionId: slot.executionId,
        targetKey: 'project',
        queryId: slot.queryId,
        // There is no frozen identity/classification basis to recover here.
        queryClass: 'unknown' as const,
        groupKeys: [],
        marketKeys: [],
        competitorDomains: [],
      })),
    },
    definitionId: null,
    comparableDefinitionIds: [],
    modelFingerprint: null,
    observations: snapshots.map(snapshot => ({
      slotId: `slot:legacy:${snapshot.id}`,
      answerId: snapshot.id,
      model: snapshot.servedModel?.trim() || null,
      answerText: snapshot.answerText,
      // A legacy answer body cannot be matched against today's identity. Only
      // the stored boolean is a frozen mention fact; null stays incomplete.
      mentionComplete: snapshot.answerMentioned !== null,
      mentionedTargetKeys: snapshot.answerMentioned === true ? ['project'] : [],
      citedTargetKeys: snapshot.citationState === 'cited' ? ['project'] : [],
      citationComplete: true,
      competitorMentionDomains: [],
      competitorCitationDomains: [],
      observedCompetitorNames: observedCompetitorNames(snapshot.recommendedCompetitors),
      sources: snapshot.citedUrls ?? [],
      createdAt: snapshot.createdAt,
    })),
  }
}

function simpleActiveDefinition(project: { displayName: string; canonicalDomain: string }): VisibilityReportDefinitionInput {
  return {
    ...simpleScope(project.displayName, false),
    slots: [],
    edges: [],
  }
}

function unsupportedAdvancedResponse(query: VisibilityReportQuery, active: NonNullable<ReturnType<typeof activeMeasurementPlan>>) {
  const classes = query.queryClass === 'all' ? ['branded', 'non-brand', 'unknown'] as const : [query.queryClass]
  if (query.scope !== 'project') throw validationError('Advanced schema v1 supports only the project scope in this report.')
  const targets = active.plan.targets
  const rate = { numerator: null, denominator: null, rate: null, reason: 'not-applicable' as const }
  const population = (queryClass: typeof classes[number]) => ({
    queryClass,
    summary: {
      queryCount: 0,
      answerCount: 0,
      mentionCoverage: rate,
      citationCoverage: rate,
      propertyReach: rate,
      outcomes: { bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: targets.length, total: targets.length },
    },
    trend: [],
    queries: { items: [], nextCursor: null, total: 0 },
    evidence: { items: [], nextCursor: null, total: 0 },
    competitorAvailability: { state: 'unavailable' as const, reason: 'frozen-competitor-identity-missing' as const },
    competitors: [],
    observedCompetitors: [],
    breakdown: {
      properties: targets.map(target => ({ id: target.stableKey, label: target.label, queryCount: 0, mentionCoverage: rate, citationCoverage: rate })),
      groups: [],
    },
  })
  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'advanced',
      queryClass: query.queryClass,
      scope: { id: 'project', label: 'Project', kind: 'project', targetCount: targets.length },
      provider: query.provider ?? null,
      model: query.model ?? null,
      location: query.location,
      time: { from: query.from ?? null, to: query.to ?? null },
      revision: active.version.revision,
      run: { id: null, explicit: query.runId !== undefined },
      provenance: { kind: 'unsupported-advanced-v1', definitionRevision: active.version.revision },
      measurement: {
        state: 'not-measured',
        activeRevision: active.version.revision,
        measuredRevision: null,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: null,
      },
      availability: { state: 'unsupported', reason: 'advanced-v1' },
    },
    scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: targets.length }],
    filterOptions: { providers: [], models: [], locations: [{ kind: 'all' }] },
    populations: classes.map(population),
  })
}

function completedVisibilityRuns(
  db: DatabaseClient,
  projectId: string,
  planless: boolean,
  query: Pick<VisibilityReportQuery, 'from' | 'to' | 'runId'>,
) {
  return db.select().from(runs).where(and(
    eq(runs.projectId, projectId),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    ne(runs.trigger, RunTriggers.probe),
    planless ? isNull(runs.measurementPlanVersionId) : isNotNull(runs.measurementPlanVersionId),
    // A scoped spot check is never a whole-project sweep. It can be inspected
    // by its exact id, but must not win the default latest-result selection.
    query.runId === undefined ? isNull(runs.measurementScope) : undefined,
    query.runId === undefined ? undefined : eq(runs.id, query.runId),
    query.from === undefined ? undefined : gte(runs.createdAt, query.from),
    query.to === undefined ? undefined : lte(runs.createdAt, query.to),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(VISIBILITY_REPORT_MAX_RUNS).all()
}

type ParsedV2Version = { row: typeof measurementPlanVersions.$inferSelect; plan: MeasurementPlanV2 }

function parseV2Versions(rows: readonly (typeof measurementPlanVersions.$inferSelect)[]): Map<string, ParsedV2Version> {
  const versions = new Map<string, ParsedV2Version>()
  for (const row of rows) {
    const plan = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
    if (plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) versions.set(row.id, { row, plan })
  }
  return versions
}

function comparableVersionIds(
  rows: ReadonlyMap<string, typeof measurementPlanVersions.$inferSelect>,
  versionId: string,
): string[] {
  const ids = [versionId]
  const seen = new Set(ids)
  let cursor = versionId
  for (let step = 0; step < 32; step++) {
    const next = rows.get(cursor)?.comparableToVersionId ?? null
    if (next === null || seen.has(next)) break
    ids.push(next)
    seen.add(next)
    cursor = next
  }
  return ids
}

function assignmentSignature(plan: MeasurementPlanV2, assignment: MeasurementPlanV2['assignments'][number]): string {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === assignment.executionNodeKey)
  if (!node) throw new Error(`Frozen assignment references missing execution node ${assignment.executionNodeKey}`)
  return JSON.stringify({
    targetKey: assignment.targetKey,
    queryId: assignment.queryId,
    queryClass: assignment.queryClass,
    queryText: node.queryText,
    providers: [...node.context.providers].sort(),
    models: Object.fromEntries(Object.entries(node.context.models).sort(([left], [right]) => left.localeCompare(right, 'en'))),
    location: node.context.location,
  })
}

function pendingAssignments(
  activePlan: MeasurementPlanV2,
  measuredPlan: MeasurementPlanV2 | undefined,
  measuredDefinition: VisibilityReportDefinitionInput | undefined,
): number {
  if (!measuredPlan || !measuredDefinition) return activePlan.assignments.length
  const measuredEdges = new Set(measuredDefinition.edges.map(edge => [edge.executionId, edge.targetKey, edge.queryId].join('\u0000')))
  const measuredSignatures = new Set(measuredPlan.assignments
    .filter(assignment => measuredEdges.has([assignment.executionNodeKey, assignment.targetKey, assignment.queryId].join('\u0000')))
    .map(assignment => assignmentSignature(measuredPlan, assignment)))
  return activePlan.assignments.filter(assignment => !measuredSignatures.has(assignmentSignature(activePlan, assignment))).length
}

function advancedReaderInput(
  db: DatabaseClient,
  projectId: string,
  active: NonNullable<ReturnType<typeof activeMeasurementPlan>>,
  query: VisibilityReportQuery,
): VisibilityReportReaderInput {
  if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) throw new Error('Expected a v2 active plan')
  const allVersionRows = db.select().from(measurementPlanVersions)
    .where(eq(measurementPlanVersions.projectId, projectId)).all()
  const allVersionRowsById = new Map(allVersionRows.map(row => [row.id, row]))
  const versions = parseV2Versions(allVersionRows)
  let presentationVersion = active.version
  let presentationPlan = active.plan
  if (query.revision !== undefined) {
    const version = allVersionRows.find(candidate => candidate.revision === query.revision)
    const parsed = version === undefined ? undefined : versions.get(version.id)
    if (!version) throw validationError(`Measurement revision ${query.revision} does not exist.`)
    if (!parsed) throw validationError('The requested advanced revision is schema v1 and cannot be reconstructed.')
    presentationVersion = parsed.row
    presentationPlan = parsed.plan
  }
  const presentationComparableIds = new Set(comparableVersionIds(allVersionRowsById, presentationVersion.id))
  const activeComparableIds = new Set(comparableVersionIds(allVersionRowsById, active.version.id))
  const sourceRuns = completedVisibilityRuns(db, projectId, false, query)
  const snapshotsByRun = loadVisibilitySnapshots(db, sourceRuns.map(run => run.id))
  const sourceCandidates = sourceRuns.flatMap(run => {
    if (run.measurementPlanVersionId === null) return []
    const source = versions.get(run.measurementPlanVersionId)
    if (!source) return []
    const own = advancedRun(
      run,
      source.row,
      source.plan,
      snapshotsByRun.get(run.id) ?? [],
      comparableVersionIds(allVersionRowsById, source.row.id),
    )
    return [{ run, source, own }]
  }).filter(candidate => query.revision === undefined || presentationComparableIds.has(candidate.source.row.id))
  if (query.runId !== undefined && !sourceCandidates.some(candidate => candidate.run.id === query.runId)) {
    throw validationError(`Measurement run "${query.runId}" is not an eligible advanced result.`)
  }
  const candidates = sourceCandidates.map(candidate => {
    // #1062's link is emitted only for an execution-identical label-only
    // republish. In that case the active/requested frozen plan is the report
    // definition; a material predecessor keeps its own definition instead.
    // The source already uses that exact frozen revision, so rebuilding its
    // manifest/evidence would only duplicate a large portfolio read.
    if (candidate.source.row.id === presentationVersion.id) return candidate.own
    if (!presentationComparableIds.has(candidate.source.row.id)) return candidate.own
    return advancedRun(
      candidate.run,
      presentationVersion,
      presentationPlan,
      snapshotsByRun.get(candidate.run.id) ?? [],
      [...presentationComparableIds],
    )
  })
  const compatibleSourceCandidates = sourceCandidates.filter(candidate => activeComparableIds.has(candidate.source.row.id))
  const preferredSource = query.runId === undefined
    ? (compatibleSourceCandidates.at(0) ?? sourceCandidates.at(0))
    : undefined
  const selectedSource = query.runId === undefined
    ? preferredSource
    : sourceCandidates.find(candidate => candidate.run.id === query.runId)
  return {
    mode: 'advanced',
    activeRevision: active.version.revision,
    pendingAssignmentCount: selectedSource !== undefined && activeComparableIds.has(selectedSource.source.row.id)
      ? 0
      : pendingAssignments(active.plan, selectedSource?.source.plan, selectedSource?.own.definition),
    selection: query,
    activeDefinition: activeV2Definition(presentationPlan, presentationVersion.revision),
    ...(preferredSource === undefined ? {} : { preferredRunId: preferredSource.run.id }),
    runs: candidates,
  }
}

function simpleReaderInput(
  db: DatabaseClient,
  project: { id: string; displayName: string; canonicalDomain: string },
  query: VisibilityReportQuery,
): VisibilityReportReaderInput {
  const sourceRuns = completedVisibilityRuns(db, project.id, true, query)
  // Apply the run/time predicate before touching sidecars. A long-lived
  // project may have many historical captures, but this report's bounded run
  // selection is the only history it is entitled to reconstruct.
  const frozen = new Map<string, SimpleMeasurementDefinition>(sourceRuns.length === 0
    ? []
    : db.select().from(simpleMeasurementDefinitions)
      .where(and(
        eq(simpleMeasurementDefinitions.projectId, project.id),
        inArray(simpleMeasurementDefinitions.runId, sourceRuns.map(run => run.id)),
      )).all()
      .map(row => [row.runId, row.definition] as const))
  const snapshotsByRun = loadVisibilitySnapshots(db, sourceRuns.map(run => run.id))
  const candidates = sourceRuns.map(run => {
    const snapshots = snapshotsByRun.get(run.id) ?? []
    const definition = frozen.get(run.id)
    return definition
      ? frozenSimpleRun(run, definition, snapshots)
      : legacySimpleRun(project, run, snapshots)
  })
  if (query.runId !== undefined && !candidates.some(run => run.id === query.runId)) {
    throw validationError(`Measurement run "${query.runId}" is not an eligible simple result.`)
  }
  return {
    mode: 'simple',
    activeRevision: null,
    pendingAssignmentCount: 0,
    selection: query,
    activeDefinition: simpleActiveDefinition(project),
    runs: candidates,
  }
}

export async function visibilityReportRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/visibility-report',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseQuery(request.query)
      const active = activeMeasurementPlan(app.db, project.id)
      const mode = query.mode === 'auto' ? (active === null ? 'simple' : 'advanced') : query.mode
      if (mode === 'advanced') {
        if (active === null) throw validationError('This project has no advanced measurement plan.')
        if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
          return unsupportedAdvancedResponse(query, active)
        }
        try {
          return buildVisibilityReport(advancedReaderInput(app.db, project.id, active, query))
        } catch (error) {
          if (error instanceof VisibilityReportCursorError || error instanceof VisibilityReportScopeError) {
            throw validationError(error.message)
          }
          throw error
        }
      }
      try {
        return buildVisibilityReport(simpleReaderInput(app.db, project, query))
      } catch (error) {
        if (error instanceof VisibilityReportCursorError || error instanceof VisibilityReportScopeError) {
          throw validationError(error.message)
        }
        throw error
      }
    },
  )
}

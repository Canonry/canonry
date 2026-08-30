import {
  brandKeyFromText,
  canonicalMeasurementPlanV2,
  compileBrandAliases,
  matcherMatchesText,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  normalizeMeasurementExactUrl,
  normalizeMeasurementHost,
  normalizeMeasurementPathPrefix,
  type LocationContext,
  type MeasurementDraftAuthoring,
  type MeasurementDraftCompileCheck,
  type MeasurementDraftDiff,
  type MeasurementDraftQueryClass,
  type MeasurementPlanV2,
  type MeasurementV2Assignment,
  type MeasurementV2ExecutionContext,
  type MeasurementV2ExecutionNode,
  type MeasurementV2Group,
  type MeasurementV2QuerySnapshot,
  type MeasurementV2Target,
  type MeasurementV2UrlMatcher,
  type MeasurementV2UsageEdge,
} from '@ainyc/canonry-contracts'
import { canonicalJson, canonicalJsonValue, sha256Hex } from './measurement-draft-repo.js'
import { measurementMentionAliasKey } from './measurement-report.js'

/**
 * Spec §6 requires the Target collections to serve a thousand rows. The
 * compiler refuses past that rather than letting a runaway sitemap import
 * become a plan nobody can publish and nobody can shrink.
 */
export const MEASUREMENT_DRAFT_MAX_TARGETS = 1_000
export const MEASUREMENT_DRAFT_MAX_QUERIES = 1_000
/** A published revision is read whole on every run pin, so it stays small enough to hold in memory. */
export const MEASUREMENT_PLAN_V2_MAX_BYTES = 4 * 1024 * 1024

/** Placeholder while the document that carries it is being hashed. */
const CHECKSUM_PLACEHOLDER = '0'.repeat(64)

/**
 * A frozen provenance timestamp.
 *
 * `compiledChecksum` excludes timestamps by definition, so a real capture time
 * inside `querySnapshots` would be left out of the hash while still differing
 * between two publishes of identical content — leaving two byte-different rows
 * claiming one checksum. The real publish time lives on the version row.
 */
export const MEASUREMENT_V2_PROVENANCE_EPOCH = '1970-01-01T00:00:00.000Z'

export interface MeasurementDraftCompileContext {
  canonicalDomain: string
  ownedDomains: readonly string[]
  brandNames: readonly string[]
  locations: readonly LocationContext[]
  trackedQueries: ReadonlyArray<{ id: string; query: string }>
  /** Optional handoff provenance for a newly introduced question. */
  queryProvenanceById?: ReadonlyMap<string, Pick<MeasurementV2QuerySnapshot['provenance'], 'source' | 'sourceId'>>
}

export type MeasurementDraftCompileResult =
  | { ok: true; plan: MeasurementPlanV2; checks: MeasurementDraftCompileCheck[] }
  | { ok: false; checks: MeasurementDraftCompileCheck[] }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

/**
 * The deterministic classification proposal of spec §7.3.
 *
 * Normalization — NFKC, case folding, whitespace collapse and
 * punctuation-boundary tokenization — is the shared brand matcher rather than a
 * second copy of those rules: a query classified one way here and matched
 * another way in reporting would be a silent disagreement about the same text.
 */
export function proposeQueryClass(queryText: string, brandNames: readonly string[]): MeasurementDraftQueryClass {
  const matcher = compileBrandAliases(brandNames.filter(name => brandKeyFromText(name).length > 0))
  return matcherMatchesText(matcher, queryText) ? 'branded' : 'non-brand'
}

/**
 * A question that names the Property it is assigned to is branded for that
 * Property, even when the Property's own name is not a project brand alias.
 * "is <community> a good place to live" is asked by someone who already knows
 * the community, so pooling it with discovery questions overstates non-brand
 * reach — and the project brand list holds the parent brand, not 200 community
 * names, so the plain classifier called every one of them non-brand.
 */
export function proposeQueryClassForTarget(
  queryText: string,
  brandNames: readonly string[],
  target: { label: string; aliases: readonly string[] } | undefined,
): MeasurementDraftQueryClass {
  const names = target ? [...brandNames, target.label, ...target.aliases] : brandNames
  return proposeQueryClass(queryText, names)
}

/** True for the host itself and for its dot-boundary subdomains, never for a suffix match. */
function isOwnedHost(host: string, ownedHosts: readonly string[]): boolean {
  return ownedHosts.some(owned => host === owned || host.endsWith(`.${owned}`))
}

/**
 * A draft matcher is a plain string because that is what an operator types.
 * The grammar is deliberately three cases and no more: a trailing `/*` is a
 * path prefix, any other absolute URL is an exact route, and a bare hostname
 * covers the whole host. `pathCase` is always `insensitive` because a draft
 * string has nowhere to say otherwise, and guessing `sensitive` would silently
 * drop real traffic whose path casing differs.
 */
function parseDraftMatcher(value: string): MeasurementV2UrlMatcher {
  const trimmed = value.trim()
  if (trimmed.endsWith('/*')) {
    const base = trimmed.slice(0, -2)
    const parsed = new URL(base)
    return {
      kind: 'prefix',
      host: normalizeMeasurementHost(parsed.hostname),
      pathPrefix: normalizeMeasurementPathPrefix(parsed.pathname || '/'),
      pathCase: 'insensitive',
    }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'exact', url: normalizeMeasurementExactUrl(trimmed), pathCase: 'insensitive' }
  }
  return { kind: 'host', host: normalizeMeasurementHost(trimmed) }
}

function matcherHost(matcher: MeasurementV2UrlMatcher): string {
  return matcher.kind === 'exact' ? new URL(matcher.url).hostname : matcher.host
}

/** Identity of a matcher for precedence analysis: kind, host and path decide a tie. */
function matcherIdentity(matcher: MeasurementV2UrlMatcher): string {
  switch (matcher.kind) {
    case 'exact': return `exact\u0000${new URL(matcher.url).hostname}\u0000${new URL(matcher.url).pathname}`
    case 'prefix': return `prefix\u0000${matcher.host}\u0000${matcher.pathPrefix}`
    case 'host': return `host\u0000${matcher.host}\u0000`
  }
}

function locationKey(location: LocationContext | null): string {
  return location ? [location.label, location.city, location.region, location.country].join('\u0000') : ''
}

interface CheckSink {
  fail(ruleId: string, message: string, path: (string | number)[]): void
  warn(ruleId: string, message: string, path: (string | number)[]): void
}

function createChecks(): { checks: MeasurementDraftCompileCheck[]; sink: CheckSink; failed: () => boolean } {
  const checks: MeasurementDraftCompileCheck[] = []
  let failures = 0
  return {
    checks,
    failed: () => failures > 0,
    sink: {
      fail(ruleId, message, path) {
        failures++
        checks.push({ ruleId, severity: 'fail', message, path })
      },
      warn(ruleId, message, path) {
        checks.push({ ruleId, severity: 'warn', message, path })
      },
    },
  }
}

interface ResolvedContext {
  providers: string[]
  models: Record<string, string>
  locations: Array<LocationContext | null>
}

interface ResolvedExecutionContext {
  providers: string[]
  models: Record<string, string>
  location: LocationContext | null
}

function normalizeProviders(values: readonly string[]): string[] {
  return canonicalStrings(values.map(value => value.trim().toLowerCase()).filter(Boolean))
}

/**
 * Compile the authoring intent into the immutable v2 document.
 *
 * Never throws on authoring the operator can fix: every such problem comes back
 * as a `fail` check with a stable rule id and a field path, so the browser can
 * point at the field rather than showing a stack.
 */
export function compileMeasurementDraft(
  authoring: MeasurementDraftAuthoring,
  context: MeasurementDraftCompileContext,
): MeasurementDraftCompileResult {
  const { checks, sink, failed } = createChecks()

  let canonicalHost = ''
  try {
    canonicalHost = normalizeMeasurementHost(context.canonicalDomain)
  } catch {
    sink.fail('invalid-project-identity', 'The project canonical domain is not a valid hostname.', ['identities', 'projectBrand', 'canonicalHost'])
  }
  const ownedHosts = canonicalStrings([context.canonicalDomain, ...context.ownedDomains].flatMap(value => {
    try {
      return [normalizeMeasurementHost(value)]
    } catch {
      return []
    }
  }))

  const locationsByLabel = new Map(context.locations.map(location => [location.label, location]))
  const queriesById = new Map(context.trackedQueries.map(query => [query.id, query.query]))

  const targets = authoring.targets
  if (targets.length > MEASUREMENT_DRAFT_MAX_TARGETS) {
    sink.fail('target-limit-exceeded', `A draft holds at most ${MEASUREMENT_DRAFT_MAX_TARGETS} Targets.`, ['targets'])
  }
  const seenTargetKeys = new Set<string>()
  targets.forEach((target, index) => {
    if (seenTargetKeys.has(target.stableKey)) {
      sink.fail('duplicate-target-key', `Duplicate Target stable key: ${target.stableKey}`, ['targets', index, 'stableKey'])
    }
    seenTargetKeys.add(target.stableKey)
  })

  const included = targets
    .map((target, targetIndex) => ({ target, targetIndex }))
    .filter(entry => entry.target.status === 'included')
  if (included.length === 0) {
    sink.fail('no-included-targets', 'A published plan needs at least one included Target.', ['targets'])
  }

  // Keyed rather than scanned: §6 sizes these collections at a thousand
  // Targets, where a linear search per matcher is a quadratic walk.
  const matcherClaims = new Map<string, string>()
  const aliasClaims = new Map<string, string>()
  const compiledTargets: Array<{ target: MeasurementV2Target; targetIndex: number }> = []
  for (const { target, targetIndex } of included) {
    const matchers: MeasurementV2UrlMatcher[] = []
    target.urlMatchers.forEach((raw, matcherIndex) => {
      let matcher: MeasurementV2UrlMatcher
      try {
        matcher = parseDraftMatcher(raw)
      } catch {
        sink.fail('target-url-matcher-invalid', `Target URL matcher is not a URL, a "/*" path prefix, or a hostname: ${raw}`, ['targets', targetIndex, 'urlMatchers', matcherIndex])
        return
      }
      if (!isOwnedHost(matcherHost(matcher), ownedHosts)) {
        sink.fail('target-url-matcher-unowned', `Target URL matcher host must be a project-owned host or its subdomain: ${raw}`, ['targets', targetIndex, 'urlMatchers', matcherIndex])
        return
      }
      const identity = matcherIdentity(matcher)
      const claimedBy = matcherClaims.get(identity)
      if (claimedBy !== undefined && claimedBy !== target.stableKey) {
        sink.fail('target-url-matcher-ambiguous', `Target URL matcher is claimed at equal precedence by Target ${claimedBy}: ${raw}`, ['targets', targetIndex, 'urlMatchers', matcherIndex])
        return
      }
      matcherClaims.set(identity, target.stableKey)
      matchers.push(matcher)
    })
    target.aliases.forEach((alias, aliasIndex) => {
      const identity = measurementMentionAliasKey(alias)
      if (!identity) return
      const claimedBy = aliasClaims.get(identity)
      if (claimedBy !== undefined && claimedBy !== target.stableKey) {
        sink.fail(
          'target-alias-ambiguous',
          `Target alias normalizes to the same mention identity claimed by Target ${claimedBy}: ${alias}`,
          ['targets', targetIndex, 'aliases', aliasIndex],
        )
        return
      }
      aliasClaims.set(identity, target.stableKey)
    })
    const aliases = canonicalStrings(target.aliases)
    if (aliases.length === 0) {
      sink.warn('target-without-aliases', `Target "${target.label}" has no aliases, so it can be cited but never mentioned.`, ['targets', targetIndex, 'aliases'])
    }
    compiledTargets.push({
      target: {
        stableKey: target.stableKey,
        label: target.label,
        aliases,
        urlMatchers: matchers,
        mentionNotApplicable: aliases.length === 0,
        discoveryIdentity: target.discoveryIdentity ?? null,
      },
      targetIndex,
    })
  }

  const includedKeys = new Set(included.map(entry => entry.target.stableKey))
  const knownKeys = new Set(targets.map(target => target.stableKey))

  const compiledGroups: MeasurementV2Group[] = []
  const seenGroupKeys = new Set<string>()
  authoring.groups.forEach((group, groupIndex) => {
    const normalizedKey = group.stableKey.toLowerCase()
    if (seenGroupKeys.has(normalizedKey)) {
      sink.fail('duplicate-group-key', `Duplicate group stable key: ${group.stableKey}`, ['groups', groupIndex, 'stableKey'])
    }
    seenGroupKeys.add(normalizedKey)
    group.targetKeys.forEach((targetKey, keyIndex) => {
      if (!knownKeys.has(targetKey)) {
        sink.fail('group-unknown-target', `Group references a Target the draft does not hold: ${targetKey}`, ['groups', groupIndex, 'targetKeys', keyIndex])
      } else if (!includedKeys.has(targetKey)) {
        sink.fail('group-excluded-target', `Group references an excluded Target: ${targetKey}`, ['groups', groupIndex, 'targetKeys', keyIndex])
      }
    })
    const seenCompetitorKeys = new Set<string>()
    const seenCompetitorDomains = new Set<string>()
    group.competitors.forEach((competitor, competitorIndex) => {
      let host: string
      try {
        host = normalizeMeasurementHost(competitor.domain)
      } catch {
        sink.fail('competitor-invalid-domain', `Competitor domain is not a valid hostname: ${competitor.domain}`, ['groups', groupIndex, 'competitors', competitorIndex, 'domain'])
        return
      }
      if (isOwnedHost(host, ownedHosts)) {
        sink.fail('competitor-matches-project', `Competitor "${competitor.label}" is a project-owned host.`, ['groups', groupIndex, 'competitors', competitorIndex, 'domain'])
      }
      if (seenCompetitorKeys.has(competitor.stableKey) || seenCompetitorDomains.has(host)) {
        sink.fail('competitor-duplicate', `Competitor is listed twice in group ${group.stableKey}: ${competitor.domain}`, ['groups', groupIndex, 'competitors', competitorIndex])
      }
      seenCompetitorKeys.add(competitor.stableKey)
      seenCompetitorDomains.add(host)
    })
    compiledGroups.push({
      stableKey: group.stableKey,
      label: group.label,
      targetKeys: canonicalStrings(group.targetKeys),
      competitors: [...group.competitors]
        .map(competitor => ({ ...competitor, aliases: canonicalStrings(competitor.aliases) }))
        .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    })
  })

  const resolveContext = (
    override: MeasurementDraftAuthoring['assignments'][number]['contextOverride'],
    path: (string | number)[],
  ): ResolvedContext => {
    const providers = normalizeProviders(override?.providers ?? authoring.defaultContext.providers)
    if (providers.length === 0) {
      sink.fail('execution-context-no-provider', 'An execution context must name at least one provider.', [...path, 'providers'])
    }
    const rawModels = override?.models ?? authoring.defaultContext.models ?? {}
    const models: Record<string, string> = {}
    for (const [provider, model] of Object.entries(rawModels)) {
      const normalized = provider.trim().toLowerCase()
      if (!providers.includes(normalized)) {
        sink.fail('invalid-provider-model', `Model "${model}" names provider "${provider}", which this execution context does not run.`, [...path, 'models', provider])
        continue
      }
      models[normalized] = model
    }
    const labels = canonicalStrings(override?.locations ?? authoring.defaultContext.locations)
    const locations: Array<LocationContext | null> = []
    labels.forEach((label, labelIndex) => {
      const location = locationsByLabel.get(label)
      if (!location) {
        sink.fail('invalid-location', `Execution context names a location the project does not configure: ${label}`, [...path, 'locations', labelIndex])
        return
      }
      locations.push(location)
    })
    // No configured location means the questions are asked without one, which
    // is a single slot rather than none at all.
    return { providers, models, locations: locations.length ? locations : [null] }
  }

  /**
   * A draft seeded from a v2 revision carries the exact node contexts that
   * revision froze. Do not run these through the draft defaults: doing so
   * turns heterogeneous providers/models/locations into a Cartesian product
   * and changes which provider work the revision represents.
   */
  const resolveExactContext = (
    exact: MeasurementV2ExecutionContext,
    path: (string | number)[],
  ): ResolvedExecutionContext | null => {
    const providers = normalizeProviders(exact.providers)
    if (providers.length === 0) {
      sink.fail('execution-context-no-provider', 'An execution context must name at least one provider.', [...path, 'providers'])
      return null
    }
    const models: Record<string, string> = {}
    for (const [provider, model] of Object.entries(exact.models)) {
      const normalized = provider.trim().toLowerCase()
      if (!providers.includes(normalized)) {
        sink.fail('invalid-provider-model', `Model "${model}" names provider "${provider}", which this execution context does not run.`, [...path, 'models', provider])
        continue
      }
      // An exact context intentionally does not inherit the current default
      // model. An empty map is a frozen request for the provider default.
      models[normalized] = model
    }
    if (exact.location === null) return { providers, models, location: null }
    const configured = locationsByLabel.get(exact.location.label)
    if (!configured) {
      sink.fail('invalid-location', `Execution context names a location the project does not configure: ${exact.location.label}`, [...path, 'location', 'label'])
      return null
    }
    // A matching label with different location facts is still a changed
    // provider context. Refuse instead of silently swapping it for the live
    // config and claiming a no-op republish.
    if (locationKey(configured) !== locationKey(exact.location)) {
      sink.fail('execution-context-location-mismatch', `Execution context no longer matches the configured location: ${exact.location.label}`, [...path, 'location'])
      return null
    }
    return { providers, models, location: exact.location }
  }

  const nodesByKey = new Map<string, MeasurementV2ExecutionNode>()
  const assignments: MeasurementV2Assignment[] = []
  const usageEdges = new Map<string, MeasurementV2UsageEdge>()
  const usedQueryIds = new Set<string>()
  const claimedPairs = new Set<string>()
  const frozenProvenanceByQuery = new Map<string, MeasurementV2QuerySnapshot['provenance']>()

  authoring.assignments.forEach((assignment, index) => {
    const path: (string | number)[] = ['assignments', index]
    // One row per Target/question pair. Two rows would compile to two
    // assignments that can disagree about the class, and the published document
    // would then say both with nothing able to tell which was meant.
    const pair = `${assignment.targetKey} ${assignment.queryId}`
    if (claimedPairs.has(pair)) {
      sink.fail('duplicate-assignment', `Target "${assignment.targetKey}" assigns query "${assignment.queryId}" twice.`, path)
      return
    }
    claimedPairs.add(pair)
    if (!knownKeys.has(assignment.targetKey)) {
      sink.fail('assignment-unknown-target', `Assignment references a Target the draft does not hold: ${assignment.targetKey}`, [...path, 'targetKey'])
      return
    }
    if (!includedKeys.has(assignment.targetKey)) {
      sink.fail('assignment-excluded-target', `Assignment references an excluded Target: ${assignment.targetKey}`, [...path, 'targetKey'])
      return
    }
    const queryText = queriesById.get(assignment.queryId)
    if (queryText === undefined) {
      sink.fail('assignment-unknown-query', `Assignment references a project query that no longer exists: ${assignment.queryId}`, [...path, 'queryId'])
      return
    }
    if (assignment.queryClass === 'unclassified') {
      sink.fail('assignment-unclassified', 'Every assignment must be classified as Branded or Non-brand before publishing.', [...path, 'queryClass'])
      return
    }
    if (assignment.queryProvenance !== undefined) {
      const existing = frozenProvenanceByQuery.get(assignment.queryId)
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(assignment.queryProvenance)) {
        sink.fail('assignment-query-provenance-conflict', `Assignments for query "${assignment.queryId}" disagree about its frozen provenance.`, [...path, 'queryProvenance'])
        return
      }
      frozenProvenanceByQuery.set(assignment.queryId, assignment.queryProvenance)
    }
    usedQueryIds.add(assignment.queryId)
    const executionContexts: ResolvedExecutionContext[] = assignment.executionContexts === undefined
      ? (() => {
          const resolved = resolveContext(assignment.contextOverride, [...path, 'contextOverride'])
          return resolved.providers.length === 0
            ? []
            : resolved.locations.map(location => ({ providers: resolved.providers, models: resolved.models, location }))
        })()
      : assignment.executionContexts.map((exact, exactIndex) => resolveExactContext(exact, [...path, 'executionContexts', exactIndex]))
        .filter((exact): exact is ResolvedExecutionContext => exact !== null)
    const seenExactContexts = new Set<string>()

    for (const execution of executionContexts) {
      const contextIdentity = canonicalJson({
        location: locationKey(execution.location),
        providers: execution.providers,
        models: execution.models,
      })
      if (assignment.executionContexts !== undefined && seenExactContexts.has(contextIdentity)) {
        sink.fail('duplicate-execution-context', 'An assignment repeats the same exact execution context.', [...path, 'executionContexts'])
        continue
      }
      seenExactContexts.add(contextIdentity)
      // The dedup identity of §11: one provider request per unique question,
      // location and provider/model map. Hashing the canonical form is what
      // keeps two machines agreeing on the key.
      const signature = canonicalJson({
        queryId: assignment.queryId,
        location: locationKey(execution.location),
        providers: execution.providers,
        models: execution.models,
      })
      const stableKey = `execution-${sha256Hex(signature)}`
      if (!nodesByKey.has(stableKey)) {
        nodesByKey.set(stableKey, {
          stableKey,
          queryId: assignment.queryId,
          queryText,
          context: { providers: execution.providers, models: execution.models, location: execution.location },
          expectedSnapshots: execution.providers.length,
        })
      }
      assignments.push({
        targetKey: assignment.targetKey,
        queryId: assignment.queryId,
        queryClass: assignment.queryClass,
        executionNodeKey: stableKey,
      })
      const edge: MeasurementV2UsageEdge = { executionNodeKey: stableKey, targetKey: assignment.targetKey, queryId: assignment.queryId }
      usageEdges.set(JSON.stringify(edge), edge)
    }
  })

  if (usedQueryIds.size > MEASUREMENT_DRAFT_MAX_QUERIES) {
    sink.fail('query-limit-exceeded', `A draft assigns at most ${MEASUREMENT_DRAFT_MAX_QUERIES} distinct queries.`, ['assignments'])
  }
  const assignedTargetKeys = new Set(assignments.map(assignment => assignment.targetKey))
  for (const { target, targetIndex } of compiledTargets) {
    if (!assignedTargetKeys.has(target.stableKey)) {
      sink.warn('target-without-assignments', `Target "${target.label}" has no assigned questions, so nothing will be measured for it.`, ['targets', targetIndex])
    }
  }

  if (failed()) return { ok: false, checks }

  const querySnapshots: MeasurementV2QuerySnapshot[] = [...usedQueryIds].sort(compareText).map(queryId => {
    const frozenProvenance = frozenProvenanceByQuery.get(queryId)
    const supplied = context.queryProvenanceById?.get(queryId)
    return {
      queryId,
      queryText: queriesById.get(queryId)!,
      // Provenance is frozen at publish time so a later reader can explain the
      // basket without the live authoring assets. `capturedAt` is deliberately
      // absent from the checksum input, which excludes timestamps.
      provenance: frozenProvenance !== undefined
        ? frozenProvenance
        : {
            ...(supplied ?? { source: 'manual' as const, sourceId: null }),
            capturedAt: MEASUREMENT_V2_PROVENANCE_EPOCH,
          },
    }
  })

  const draft: MeasurementPlanV2 = {
    schemaVersion: 2,
    identities: {
      projectBrand: {
        canonicalHost,
        ownedHosts,
        names: canonicalStrings(context.brandNames),
      },
    },
    targets: compiledTargets.map(({ target }) => target),
    groups: compiledGroups,
    querySnapshots,
    assignments,
    executionNodes: [...nodesByKey.values()],
    usageEdges: [...usageEdges.values()],
    compiledChecksum: CHECKSUM_PLACEHOLDER,
  }
  const compiledChecksum = sha256Hex(measurementPlanV2ChecksumJson(draft))
  const parsed = measurementPlanV2Schema.safeParse({ ...draft, compiledChecksum })
  if (!parsed.success) {
    return {
      ok: false,
      checks: [...checks, ...parsed.error.issues.map(issue => ({
        ruleId: 'invalid-compiled-plan',
        severity: 'fail' as const,
        message: issue.message,
        path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
      }))],
    }
  }
  const plan = parsed.data
  const size = Buffer.byteLength(measurementPlanV2ChecksumJson(plan), 'utf8')
  if (size > MEASUREMENT_PLAN_V2_MAX_BYTES) {
    sink.fail('compiled-plan-too-large', `The compiled plan is ${size} bytes, over the ${MEASUREMENT_PLAN_V2_MAX_BYTES} byte limit.`, [])
    return { ok: false, checks }
  }
  return { ok: true, plan, checks }
}

/**
 * Compile only the authoring fields that can change assignment execution.
 * Group competitors, URL matchers, and mention aliases do not affect provider
 * calls, so an unrelated review failure in those fields must not block an
 * operator from previewing or applying a question audience.
 */
export function compileMeasurementDraftAssignmentExecution(
  authoring: MeasurementDraftAuthoring,
  context: MeasurementDraftCompileContext,
): MeasurementDraftCompileResult {
  const includedTargetKeys = new Set(authoring.targets
    .filter(target => target.status === 'included')
    .map(target => target.stableKey))
  const queryIds = new Set(context.trackedQueries.map(query => query.id))
  return compileMeasurementDraft({
    ...authoring,
    targets: authoring.targets
      .filter(target => target.status === 'included')
      .map(target => ({ ...target, aliases: [], urlMatchers: [] })),
    groups: [],
    assignments: authoring.assignments.filter(assignment => (
      includedTargetKeys.has(assignment.targetKey)
      && queryIds.has(assignment.queryId)
      && assignment.queryClass !== 'unclassified'
    )),
  }, context)
}

function keyedDiff<T extends { stableKey: string }>(before: readonly T[], after: readonly T[]) {
  const beforeByKey = new Map(before.map(value => [value.stableKey, value]))
  const afterByKey = new Map(after.map(value => [value.stableKey, value]))
  const added: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []
  for (const stableKey of [...afterByKey.keys()].sort(compareText)) {
    const beforeValue = beforeByKey.get(stableKey)
    if (!beforeValue) added.push(stableKey)
    else if (JSON.stringify(canonicalJsonValue(beforeValue)) === JSON.stringify(canonicalJsonValue(afterByKey.get(stableKey)))) unchanged.push(stableKey)
    else changed.push(stableKey)
  }
  const removed = [...beforeByKey.keys()].filter(key => !afterByKey.has(key)).sort(compareText)
  return { added, removed, changed, unchanged }
}

/** One row per Target/query pair; the per-node fan-out is reported as execution keys instead. */
function assignmentClasses(plan: MeasurementPlanV2 | null): Map<string, string> {
  const classes = new Map<string, string>()
  for (const assignment of plan?.assignments ?? []) {
    classes.set(`${assignment.targetKey}\u0000${assignment.queryId}`, assignment.queryClass)
  }
  return classes
}

export function diffCompiledPlans(
  active: MeasurementPlanV2 | null,
  candidate: MeasurementPlanV2,
  activeRevision: number | null,
): MeasurementDraftDiff {
  const before = assignmentClasses(active)
  const after = assignmentClasses(candidate)
  let addedAssignments = 0
  let reclassified = 0
  for (const [key, queryClass] of after) {
    const previous = before.get(key)
    if (previous === undefined) addedAssignments++
    else if (previous !== queryClass) reclassified++
  }
  const removedAssignments = [...before.keys()].filter(key => !after.has(key)).length
  const beforeNodes = new Set((active?.executionNodes ?? []).map(node => node.stableKey))
  const afterNodes = new Set(candidate.executionNodes.map(node => node.stableKey))
  return {
    activeRevision,
    targets: keyedDiff(active?.targets ?? [], candidate.targets),
    groups: keyedDiff(active?.groups ?? [], candidate.groups),
    assignments: { added: addedAssignments, removed: removedAssignments, reclassified },
    execution: {
      addedNodeKeys: [...afterNodes].filter(key => !beforeNodes.has(key)).sort(compareText),
      removedNodeKeys: [...beforeNodes].filter(key => !afterNodes.has(key)).sort(compareText),
    },
  }
}

/**
 * True when two compiled revisions froze the IDENTICAL execution surface: same
 * node keys, and byte-identical canonical node content (question text, frozen
 * location context, provider roster, model map, expected slot counts).
 *
 * This is deliberately stricter than "added and removed node keys both empty".
 * A node's stable key hashes queryId/location/providers/models but NOT the
 * query text, so a tracked query edited in place could keep its key while the
 * frozen text moved — and a prior run served under the new revision would then
 * fail manifest validation as corruption. Whole-node equality is exactly the
 * condition under which a run pinned to the superseded revision satisfies the
 * new revision's manifest checks, which is what publish-time continuity
 * (`measurement_plan_versions.comparable_to_version_id`) promises the reads.
 */
export function plansAreLabelOnlyVariants(active: MeasurementPlanV2, candidate: MeasurementPlanV2): boolean {
  /**
   * Continuity is promised ONLY for a label-only republish, so the comparison
   * is the FULL canonical document with display labels neutralized - not the
   * execution nodes alone. Execution-node equality looked sufficient and was
   * not: queryClass lives on assignments, aliases and urlMatchers on targets,
   * brand names on identities, competitors on groups - all invisible to the
   * node comparison, and every one of them changes what stored evidence MEANS
   * when the reads hand the active plan to the report adapter. Admitting any
   * of them as "cosmetic" reinterprets old answers under new semantics with
   * zero new measurement, which is exactly what the frozen-revision doctrine
   * exists to prevent.
   */
  const surface = (plan: MeasurementPlanV2): string => {
    const doc = canonicalMeasurementPlanV2(plan)
    const stripped = {
      ...doc,
      // compiledChecksum is DERIVED over the full document, labels included,
      // so keeping it would smuggle the stripped labels back into the
      // comparison. Everything else in the doc is semantic and stays.
      compiledChecksum: '',
      targets: doc.targets.map((target) => ({ ...target, label: '' })),
      groups: doc.groups.map((group) => ({
        ...group,
        label: '',
        competitors: group.competitors.map((competitor) => ({ ...competitor, label: '' })),
      })),
    }
    return JSON.stringify(canonicalJsonValue(stripped))
  }
  return surface(active) === surface(candidate)
}

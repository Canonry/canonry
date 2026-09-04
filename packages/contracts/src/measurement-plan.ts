import { z } from 'zod'
import { brandKeyFromText } from './brand-matching.js'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  measurementPlanV2Schema,
} from './measurement-plan-v2.js'
import { locationContextSchema, type LocationContext } from './provider.js'
import { brandLabelFromDomain, hostOf } from './url-normalize.js'

/**
 * v1 is intentionally frozen. A future shape gets a new version and an
 * upcaster; it must not silently reinterpret a stored v1 revision.
 */
export const MEASUREMENT_PLAN_SCHEMA_VERSION = 1 as const
const measurementPlanRevisionSchema = z.number().int().positive()

/** Stable keys are safe to expose in URLs and API scope identifiers. */
export const measurementStableKeySchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][\w.~-]*$/i, 'Must be a URL-safe stable key')

const measurementQueryIdSchema = z.string().trim().min(1).max(256)
const pathCaseSchema = z.enum(['sensitive', 'insensitive'])

export function normalizeMeasurementHost(value: string): string {
  const host = hostOf(value)
  if (!host) throw new Error(`Invalid measurement host: ${value}`)
  return host
}

function canonicalizeMeasurementPathname(value: string): string {
  const output: string[] = []
  let previousWasSlash = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === '/') {
      if (!previousWasSlash) output.push(char)
      previousWasSlash = true
    } else {
      output.push(char)
      previousWasSlash = false
    }
  }
  while (output.length > 1 && output.at(-1) === '/') output.pop()
  return output.length ? output.join('') : '/'
}

function foldPathCase(value: string): string {
  try {
    return decodeURI(value).normalize('NFC').toLowerCase()
  } catch {
    return value.normalize('NFC').toLowerCase()
  }
}

function canonicalizeMeasurementPath(value: string): string {
  const pathname = new URL(`https://measurement.invalid${value}`).pathname
  return canonicalizeMeasurementPathname(pathname.replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase()))
}

/**
 * A matcher path has no query/fragment and rejects dot segments before URL
 * parsing can erase them. Repeated slashes are canonicalized to one slash.
 */
export function normalizeMeasurementPathPrefix(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('?') || trimmed.includes('#') || trimmed.includes('://') || trimmed.includes('\\')) {
    throw new Error(`Invalid measurement path prefix: ${value}`)
  }
  const absolute = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  for (const segment of absolute.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new Error(`Invalid measurement path prefix: ${value}`)
    }
    if (decoded === '.' || decoded === '..') throw new Error(`Invalid measurement path prefix: ${value}`)
  }
  try {
    return canonicalizeMeasurementPath(absolute)
  } catch {
    throw new Error(`Invalid measurement path prefix: ${value}`)
  }
}

function rawPathFromAbsoluteUrl(value: string): string {
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(value)
  if (!origin) throw new Error(`Invalid exact measurement URL: ${value}`)
  const suffix = value.slice(origin[0].length)
  return suffix.split(/[?#]/, 1)[0] || '/'
}

/** Normalizes an exact route to a scheme-independent host + pathname identity. */
export function normalizeMeasurementExactUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\\')) throw new Error(`Invalid exact measurement URL: ${value}`)
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid exact measurement URL: ${value}`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error(`Invalid exact measurement URL: ${value}`)
  }
  const host = normalizeMeasurementHost(parsed.hostname)
  const pathname = normalizeMeasurementPathPrefix(rawPathFromAbsoluteUrl(trimmed))
  return `https://${host}${pathname}`
}

const normalizedHostSchema = z.string().trim().min(1)
  .refine(value => {
    try {
      normalizeMeasurementHost(value)
      return true
    } catch {
      return false
    }
  }, 'A target URL matcher host must be a valid hostname')
  .overwrite(value => normalizeMeasurementHost(value))

const normalizedPathPrefixSchema = z.string().trim().min(1)
  .refine(value => {
    try {
      normalizeMeasurementPathPrefix(value)
      return true
    } catch {
      return false
    }
  }, 'A target URL matcher pathPrefix must be an absolute path without query or fragment')
  .overwrite(value => normalizeMeasurementPathPrefix(value))

const normalizedExactUrlSchema = z.string().trim().min(1)
  .refine(value => {
    try {
      normalizeMeasurementExactUrl(value)
      return true
    } catch {
      return false
    }
  }, 'A target exact matcher must be an HTTP(S) URL without credentials, port, query, or fragment')
  .overwrite(value => normalizeMeasurementExactUrl(value))

/**
 * The one Target URL matcher vocabulary. Exact routes win over prefixes;
 * longer prefixes win over shorter ones; host-only is the fallback.
 */
export const measurementTargetUrlMatcherSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exact'),
    url: normalizedExactUrlSchema,
    pathCase: pathCaseSchema,
  }).strict(),
  z.object({
    kind: z.literal('prefix'),
    host: normalizedHostSchema,
    pathPrefix: normalizedPathPrefixSchema,
    pathCase: pathCaseSchema,
  }).strict(),
  z.object({
    kind: z.literal('host'),
    host: normalizedHostSchema,
  }).strict(),
])
export type MeasurementTargetUrlMatcher = z.output<typeof measurementTargetUrlMatcherSchema>

const aliasSchema = z.string().trim().min(1).max(256)
  .refine(value => brandKeyFromText(value).length > 0, 'A target alias must contain mention text')
const metadataSchema = z.record(z.string().trim().min(1), z.string())
const competitorSchema = normalizedHostSchema

export const measurementTargetSchema = z.object({
  stableKey: measurementStableKeySchema,
  label: z.string().trim().min(1),
  urls: z.array(measurementTargetUrlMatcherSchema).min(1),
  aliases: z.array(aliasSchema),
  metadata: metadataSchema.optional(),
}).strict()
export type MeasurementTarget = z.output<typeof measurementTargetSchema>

export const measurementGroupSchema = z.object({
  stableKey: measurementStableKeySchema,
  label: z.string().trim().min(1),
  targetKeys: z.array(measurementStableKeySchema).min(1),
  competitors: z.array(competitorSchema).optional(),
}).strict()
export type MeasurementGroup = z.output<typeof measurementGroupSchema>

export const measurementTargetQuerySelectionSchema = z.object({
  targetKey: measurementStableKeySchema,
  queryIds: z.array(measurementQueryIdSchema).min(1),
  context: locationContextSchema.nullable().optional(),
}).strict()
export type MeasurementTargetQuerySelection = z.output<typeof measurementTargetQuerySelectionSchema>

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function duplicateValues(values: readonly string[], normalize = (value: string) => value): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    const key = normalize(value)
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  return duplicates
}

function addDuplicateIssues(
  ctx: z.RefinementCtx,
  values: readonly string[],
  path: readonly (string | number)[],
  label: string,
  normalize?: (value: string) => string,
): void {
  for (const duplicate of duplicateValues(values, normalize)) {
    ctx.addIssue({ code: 'custom', path: [...path], message: `Duplicate ${label}: ${duplicate}` })
  }
}

function matcherParts(matcher: MeasurementTargetUrlMatcher): { host: string; pathname: string | null } {
  if (matcher.kind === 'host') return { host: matcher.host, pathname: null }
  if (matcher.kind === 'prefix') return { host: matcher.host, pathname: matcher.pathPrefix }
  const parsed = new URL(matcher.url)
  return { host: normalizeMeasurementHost(parsed.hostname), pathname: canonicalizeMeasurementPath(parsed.pathname || '/') }
}

function matcherSpecificity(matcher: MeasurementTargetUrlMatcher): number {
  switch (matcher.kind) {
    case 'exact': return 3
    case 'prefix': return 2
    case 'host': return 1
  }
}

function pathTie(left: string, leftCase: 'sensitive' | 'insensitive', right: string, rightCase: 'sensitive' | 'insensitive'): boolean {
  return left === right || ((leftCase === 'insensitive' || rightCase === 'insensitive') && foldPathCase(left) === foldPathCase(right))
}

/** True only where an actual URL can match two different Targets at the same precedence. */
function matcherHasEqualSpecificityTie(left: MeasurementTargetUrlMatcher, right: MeasurementTargetUrlMatcher): boolean {
  if (left.kind !== right.kind) return false
  const leftParts = matcherParts(left)
  const rightParts = matcherParts(right)
  if (leftParts.host !== rightParts.host) return false
  if (left.kind === 'host' || right.kind === 'host') return true
  return pathTie(leftParts.pathname!, left.pathCase, rightParts.pathname!, right.pathCase)
}

function matcherCanonicalKey(matcher: MeasurementTargetUrlMatcher): string {
  const parts = matcherParts(matcher)
  return [matcher.kind, parts.host, parts.pathname ?? '', matcher.kind === 'host' ? '' : matcher.pathCase].join('\u0000')
}

function compareMatchers(left: MeasurementTargetUrlMatcher, right: MeasurementTargetUrlMatcher): number {
  const leftParts = matcherParts(left)
  const rightParts = matcherParts(right)
  return compareText(leftParts.host, rightParts.host)
    || matcherSpecificity(right) - matcherSpecificity(left)
    || compareText(leftParts.pathname ?? '', rightParts.pathname ?? '')
    || compareText(left.kind === 'host' ? '' : left.pathCase, right.kind === 'host' ? '' : right.pathCase)
}

function canonicalAliases(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return [...values].sort(compareText).filter(alias => {
    const key = brandKeyFromText(alias)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function canonicalMatchers(values: readonly MeasurementTargetUrlMatcher[]): MeasurementTargetUrlMatcher[] {
  return [...new Map(values.map(matcher => [matcherCanonicalKey(matcher), matcher])).values()].sort(compareMatchers)
}

function canonicalMetadata(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value || Object.keys(value).length === 0) return undefined
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)))
}

/**
 * Frozen v1 authoring decoder. The stored decoder below is intentionally
 * separate because a persisted revision includes compiler output.
 */
export const measurementPlanAuthoringSchema = z.object({
  schemaVersion: z.literal(MEASUREMENT_PLAN_SCHEMA_VERSION),
  targets: z.array(measurementTargetSchema).min(1),
  groups: z.array(measurementGroupSchema).optional(),
  targetQuerySelections: z.array(measurementTargetQuerySelectionSchema).optional(),
}).strict().superRefine((plan, ctx) => {
  const groups = plan.groups ?? []
  const targetQuerySelections = plan.targetQuerySelections ?? []
  addDuplicateIssues(ctx, plan.targets.map(target => target.stableKey), ['targets'], 'target stable key')
  addDuplicateIssues(ctx, groups.map(group => group.stableKey), ['groups'], 'group stable key')
  const targetKeys = new Set(plan.targets.map(target => target.stableKey))
  const groupKeys = new Set(groups.map(group => group.stableKey))
  for (const stableKey of targetKeys) {
    if (groupKeys.has(stableKey)) {
      ctx.addIssue({ code: 'custom', path: ['groups'], message: `Target and group stable keys must be globally unique: ${stableKey}` })
    }
  }

  const aliasClaims = new Map<string, string>()
  const matcherClaims: Array<{ targetKey: string; matcher: MeasurementTargetUrlMatcher }> = []
  plan.targets.forEach((target, targetIndex) => {
    for (const alias of canonicalAliases(target.aliases)) {
      const key = brandKeyFromText(alias)
      const previousTarget = aliasClaims.get(key)
      if (previousTarget && previousTarget !== target.stableKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', targetIndex, 'aliases'],
          message: `Target alias is already assigned to target ${previousTarget}: ${alias}`,
        })
      }
      aliasClaims.set(key, target.stableKey)
    }
    target.urls.forEach((matcher, matcherIndex) => {
      const conflict = matcherClaims.find(claim => (
        claim.targetKey !== target.stableKey && matcherHasEqualSpecificityTie(claim.matcher, matcher)
      ))
      if (conflict) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', targetIndex, 'urls', matcherIndex],
          message: 'Target URL matcher has an equal-specificity cross-target tie',
        })
      }
      matcherClaims.push({ targetKey: target.stableKey, matcher })
    })
  })

  groups.forEach((group, groupIndex) => {
    addDuplicateIssues(ctx, group.targetKeys, ['groups', groupIndex, 'targetKeys'], 'group target key')
    for (let targetIndex = 0; targetIndex < group.targetKeys.length; targetIndex++) {
      const targetKey = group.targetKeys[targetIndex]!
      if (!targetKeys.has(targetKey)) {
        ctx.addIssue({ code: 'custom', path: ['groups', groupIndex, 'targetKeys', targetIndex], message: `Unknown target: ${targetKey}` })
      }
    }
  })
  targetQuerySelections.forEach((selection, selectionIndex) => {
    if (!targetKeys.has(selection.targetKey)) {
      ctx.addIssue({ code: 'custom', path: ['targetQuerySelections', selectionIndex, 'targetKey'], message: `Unknown target: ${selection.targetKey}` })
    }
  })
})

export const measurementPlanV1InputSchema = measurementPlanAuthoringSchema.transform(plan => ({
  ...plan,
  groups: plan.groups ?? [],
  targetQuerySelections: plan.targetQuerySelections ?? [],
}))

export const measurementPlanInputSchema = measurementPlanV1InputSchema
/** Author-facing input keeps omitted optional group/selection arrays optional. */
export type MeasurementPlanInput = z.input<typeof measurementPlanInputSchema>
type ParsedMeasurementPlanInput = z.output<typeof measurementPlanInputSchema>

/**
 * Publishing is a compare-and-swap over the immutable active revision. `null`
 * means the caller observed a planless project; a positive revision pins the
 * exact active plan the caller reviewed.
 */
export const measurementPlanPublishRequestSchema = z.object({
  expectedActiveRevision: measurementPlanRevisionSchema.nullable(),
  plan: measurementPlanAuthoringSchema,
}).strict()
export type MeasurementPlanPublishRequest = z.input<typeof measurementPlanPublishRequestSchema>

export const measurementQuerySnapshotSchema = z.object({
  queryId: measurementQueryIdSchema,
  queryText: z.string().min(1),
}).strict()
export type MeasurementQuerySnapshot = z.output<typeof measurementQuerySnapshotSchema>

export const measurementExecutionNodeSchema = z.object({
  stableKey: z.string().min(1),
  queryText: z.string().min(1),
  context: locationContextSchema.nullable(),
  expectedSnapshots: z.number().int().nonnegative(),
}).strict()
export type MeasurementExecutionNode = z.output<typeof measurementExecutionNodeSchema>

const baselineUsageEdgeSchema = z.object({
  kind: z.literal('baseline'),
  executionNodeKey: z.string().min(1),
  queryId: measurementQueryIdSchema,
}).strict()
const targetUsageEdgeSchema = z.object({
  kind: z.literal('target'),
  executionNodeKey: z.string().min(1),
  queryId: measurementQueryIdSchema,
  targetKey: measurementStableKeySchema,
}).strict()
export const measurementUsageEdgeSchema = z.discriminatedUnion('kind', [
  baselineUsageEdgeSchema,
  targetUsageEdgeSchema,
])
export type MeasurementUsageEdge = z.output<typeof measurementUsageEdgeSchema>

export const measurementPlanWarningSchema = z.object({
  code: z.literal('target-alias-prefix-overlap'),
  message: z.string().min(1),
  targetKeys: z.array(measurementStableKeySchema).min(1),
  aliases: z.array(z.string().min(1)).min(1),
}).strict()
export type MeasurementPlanWarning = z.output<typeof measurementPlanWarningSchema>

export const compiledMeasurementTargetSchema = measurementTargetSchema.extend({
  mentionNotApplicable: z.boolean(),
})
export type CompiledMeasurementTarget = z.output<typeof compiledMeasurementTargetSchema>

/** Frozen persisted v1 decoder. */
export const measurementPlanV1Schema = z.object({
  schemaVersion: z.literal(MEASUREMENT_PLAN_SCHEMA_VERSION),
  defaultContext: locationContextSchema.nullable(),
  effectiveOwnedHosts: z.array(normalizedHostSchema),
  projectCanonicalHost: normalizedHostSchema,
  /** Revision-frozen project identity used by historical mention and SoV reads. */
  projectBrandNames: z.array(aliasSchema),
  targets: z.array(compiledMeasurementTargetSchema),
  groups: z.array(measurementGroupSchema),
  targetQuerySelections: z.array(measurementTargetQuerySelectionSchema),
  querySnapshots: z.array(measurementQuerySnapshotSchema),
  executionNodes: z.array(measurementExecutionNodeSchema),
  usageEdges: z.array(measurementUsageEdgeSchema),
  warnings: z.array(measurementPlanWarningSchema),
}).strict()
export const measurementPlanSchema = measurementPlanV1Schema
export type MeasurementPlan = z.output<typeof measurementPlanSchema>

/** Every stored revision shape, discriminated by `schemaVersion`. */
export const storedMeasurementPlanSchema = z.discriminatedUnion('schemaVersion', [
  measurementPlanV1Schema,
  measurementPlanV2Schema,
])
export type StoredMeasurementPlan = z.output<typeof storedMeasurementPlanSchema>

/** Explicit version dispatch prevents a future compiler from reinterpreting stored v1 rows. */
export function parseStoredMeasurementPlanAnyVersion(value: unknown): StoredMeasurementPlan {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('Stored measurement plan JSON is invalid')
    }
  }
  if (!value || typeof value !== 'object') throw new Error('Stored measurement plan is invalid')
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion
  switch (schemaVersion) {
    case MEASUREMENT_PLAN_SCHEMA_VERSION: {
      const parsed = measurementPlanV1Schema.safeParse(value)
      if (!parsed.success) throw new Error('Stored measurement plan v1 is invalid')
      return parsed.data
    }
    case MEASUREMENT_PLAN_V2_SCHEMA_VERSION: {
      const parsed = measurementPlanV2Schema.safeParse(value)
      if (!parsed.success) throw new Error('Stored measurement plan v2 is invalid')
      return parsed.data
    }
    default:
      throw new Error(`Unsupported stored measurement plan schema version: ${String(schemaVersion)}`)
  }
}

/**
 * v1-only reader. Callers that understand only the frozen v1 shape keep this
 * signature and get a hard error on a later revision, because handing them a v2
 * document typed as v1 would leave every field they read undefined at runtime.
 */
export function parseStoredMeasurementPlan(value: unknown): MeasurementPlan {
  const plan = parseStoredMeasurementPlanAnyVersion(value)
  if (plan.schemaVersion !== MEASUREMENT_PLAN_SCHEMA_VERSION) {
    throw new Error(
      `Stored measurement plan revision is schema v${plan.schemaVersion}, which this reader does not understand`,
    )
  }
  return plan
}

const measurementPlanChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/)
const measurementPlanCreatedAtSchema = z.string().datetime()

/**
 * Measuring one slice of a published plan.
 *
 * A full sweep measures every execution node the revision froze, and its
 * expected work is the run manifest in `measurement-service.ts`. A scoped run
 * is a spot check: the operator names groups and/or targets, and only the
 * execution nodes those targets selected are measured. Resolution happens once,
 * at queue time, against the revision the run pins — never against whatever
 * plan is active when the run is later read.
 */

/**
 * What a run measured WITH, as opposed to what it measured.
 *
 * A plan revision freezes the questions, the contexts and how many snapshots
 * each question expects. It deliberately does not freeze which engines answer
 * them or which models those engines are pointed at, because a same-count swap
 * changes neither the questions nor the shape of the expected work — there is
 * nothing for a republish to change, so refusing such a run would leave the
 * operator unable to comply.
 *
 * So engine and model identity is recorded per run instead. A comparable
 * series is one plan revision measured under one execution identity; a change
 * of engine or model starts a new series under the same revision, and charts
 * break and annotate at that boundary exactly as they do at a revision
 * boundary. Nothing is refused and nothing drifts silently.
 */
const measurementExecutionIdentityV1Schema = z.object({
  schemaVersion: z.literal(1),
  /** Sorted, lower-cased provider names. */
  providers: z.array(z.string().min(1)).min(1),
  /** Provider → the model that will actually answer, however it was resolved. */
  models: z.record(z.string().min(1), z.string().min(1)),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

/**
 * The exact route policy a v2 run requested. These are configuration facts,
 * frozen at queue time. They deliberately do not claim what an upstream
 * gateway eventually served; that is per-snapshot observation evidence.
 */
/** Immutable, non-secret policy facts supplied by the execution host. */
export const measurementExecutionRouteDescriptorSchema = z.object({
  routeId: z.string().min(1),
  routeRevision: z.number().int().positive(),
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type MeasurementExecutionRouteDescriptor = z.output<typeof measurementExecutionRouteDescriptorSchema>

export const measurementExecutionRouteIdentitySchema = measurementExecutionRouteDescriptorSchema.extend({
  requestedProvider: z.string().min(1),
  requestedModel: z.string().min(1),
}).strict()
export type MeasurementExecutionRouteIdentity = z.output<typeof measurementExecutionRouteIdentitySchema>

const measurementExecutionIdentityV2Schema = z.object({
  schemaVersion: z.literal(2),
  /** Retained for v1 readers and summary surfaces. These are requested IDs. */
  providers: z.array(z.string().min(1)).min(1),
  /** Retained for v1 readers and summary surfaces. These are requested IDs. */
  models: z.record(z.string().min(1), z.string().min(1)),
  /** Requested route revision and policy for each requested provider key. */
  routes: z.record(z.string().min(1), measurementExecutionRouteIdentitySchema),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, ctx) => {
  for (const provider of value.providers) {
    const route = value.routes[provider]
    if (!route) {
      ctx.addIssue({ code: 'custom', path: ['routes', provider], message: 'Every provider must have frozen route identity' })
      continue
    }
    if (route.requestedProvider !== provider) {
      ctx.addIssue({ code: 'custom', path: ['routes', provider, 'requestedProvider'], message: 'Route requestedProvider must match its provider key' })
    }
    if (value.models[provider] !== route.requestedModel) {
      ctx.addIssue({ code: 'custom', path: ['routes', provider, 'requestedModel'], message: 'Route requestedModel must match models[provider]' })
    }
  }
})

/** v1 stays parseable verbatim; v2 adds immutable route-policy provenance. */
export const measurementExecutionIdentitySchema = z.discriminatedUnion('schemaVersion', [
  measurementExecutionIdentityV1Schema,
  measurementExecutionIdentityV2Schema,
])
export type MeasurementExecutionIdentity = z.output<typeof measurementExecutionIdentitySchema>

export interface MeasurementExecutionIdentityInput {
  providers: readonly string[]
  models: Readonly<Record<string, string>>
  /**
   * Supply every selected provider to stamp v2. Omit it (or omit a provider)
   * only for legacy callers that cannot yet identify their route safely.
   */
  routes?: Readonly<Record<string, MeasurementExecutionRouteDescriptor | MeasurementExecutionRouteIdentity>>
}

function normalizeExecutionIdentity(input: MeasurementExecutionIdentityInput): MeasurementExecutionIdentityInput {
  const providers = [...new Set(input.providers.map(value => value.trim().toLocaleLowerCase('en')).filter(Boolean))].sort(compareText)
  const models: Record<string, string> = {}
  for (const provider of providers) {
    const model = input.models[provider]
    if (model && model.trim()) models[provider] = model.trim()
  }
  const rawRoutes = new Map<string, MeasurementExecutionRouteDescriptor>()
  for (const [provider, route] of Object.entries(input.routes ?? {})) {
    const normalizedProvider = provider.trim().toLocaleLowerCase('en')
    if (!normalizedProvider) continue
    // Callers may pass a prior full identity when rebuilding/checking one.
    // Strip request facts before strict descriptor validation; they are always
    // rebuilt from this run's selected provider/model below.
    rawRoutes.set(normalizedProvider, measurementExecutionRouteDescriptorSchema.parse({
      routeId: route.routeId,
      routeRevision: route.routeRevision,
      policyFingerprint: route.policyFingerprint,
    }))
  }
  const routes: Record<string, MeasurementExecutionRouteIdentity> = {}
  for (const provider of providers) {
    const route = rawRoutes.get(provider)
    const model = models[provider]
    if (!route || !model) continue
    routes[provider] = measurementExecutionRouteIdentitySchema.parse({
      ...route,
      requestedProvider: provider,
      requestedModel: model,
    })
  }
  // A partial provenance map is worse than explicit v1 compatibility: never
  // create a v2 row that appears fully auditable while omitting one engine.
  const completeRoutes = providers.length > 0 && providers.every(provider => routes[provider] !== undefined)
  return completeRoutes ? { providers, models, routes } : { providers, models }
}

/**
 * Stable, browser-safe serialization of an execution identity. The checksum is
 * taken over exactly this string by whichever layer owns hashing.
 */
export function canonicalMeasurementExecutionIdentityJson(input: MeasurementExecutionIdentityInput): string {
  const normalized = normalizeExecutionIdentity(input)
  return JSON.stringify(canonicalJsonValue({
    schemaVersion: normalized.routes ? 2 : 1,
    providers: normalized.providers,
    models: normalized.models,
    ...(normalized.routes ? { routes: normalized.routes } : {}),
  }))
}

export function buildMeasurementExecutionIdentity(
  input: MeasurementExecutionIdentityInput,
  checksum: string,
): MeasurementExecutionIdentity {
  const normalized = normalizeExecutionIdentity(input)
  return measurementExecutionIdentitySchema.parse({
    schemaVersion: normalized.routes ? 2 : 1,
    providers: normalized.providers,
    models: normalized.models,
    ...(normalized.routes ? { routes: normalized.routes } : {}),
    checksum,
  })
}

export function parseStoredMeasurementExecutionIdentity(value: unknown): MeasurementExecutionIdentity {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('Stored measurement execution identity JSON is invalid')
    }
  }
  const parsed = measurementExecutionIdentitySchema.safeParse(value)
  if (!parsed.success) throw new Error('Stored measurement execution identity is invalid')
  return parsed.data
}

/** Plain-language summary for a chart annotation or an operator surface. */
export function describeMeasurementExecutionIdentity(identity: MeasurementExecutionIdentity): string {
  return identity.providers
    .map(provider => (identity.models[provider] ? `${provider} on ${identity.models[provider]}` : provider))
    .join(', ')
}

/** Caller-supplied scope on a run trigger. Both lists are optional; omitting both means a full sweep. */
export const measurementRunScopeRequestSchema = z.object({
  groups: z.array(measurementStableKeySchema).optional(),
  targets: z.array(measurementStableKeySchema).optional(),
}).strict()
export type MeasurementRunScopeRequest = z.output<typeof measurementRunScopeRequestSchema>

/**
 * The scope as resolved against the pinned revision, recorded on the run.
 * `groups` and `targets` are what the caller asked for; `resolvedTargets` is
 * the expansion actually measured, so a reader can tell a spot check from a
 * full sweep without re-deriving group membership from a plan that has since
 * moved on.
 */
export const measurementRunScopeSchema = z.object({
  groups: z.array(measurementStableKeySchema),
  targets: z.array(measurementStableKeySchema),
  /** Question texts, when the slice was chosen by question rather than by target. */
  queries: z.array(z.string().min(1)),
  resolvedTargets: z.array(measurementStableKeySchema),
}).strict().superRefine((value, ctx) => {
  if (value.resolvedTargets.length === 0 && value.queries.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['resolvedTargets'], message: 'A recorded scope must name something it measured' })
  }
})
export type MeasurementRunScope = z.output<typeof measurementRunScopeSchema>

export function parseStoredMeasurementRunScope(value: unknown): MeasurementRunScope {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error('Stored measurement run scope JSON is invalid')
    }
  }
  const parsed = measurementRunScopeSchema.safeParse(value)
  if (!parsed.success) throw new Error('Stored measurement run scope is invalid')
  return parsed.data
}

/**
 * A scope that names something the pinned revision does not contain, or that
 * resolves to nothing runnable. Callers turn this into a 400 that names the
 * key — a silently-empty or silently-widened run is the failure this prevents.
 */
export class MeasurementRunScopeError extends Error {
  readonly unknownGroups: string[]
  readonly unknownTargets: string[]
  readonly unknownQueries: string[]
  readonly emptyTargets: string[]

  constructor(input: {
    message: string
    unknownGroups?: string[]
    unknownTargets?: string[]
    unknownQueries?: string[]
    emptyTargets?: string[]
  }) {
    super(input.message)
    this.name = 'MeasurementRunScopeError'
    this.unknownGroups = input.unknownGroups ?? []
    this.unknownTargets = input.unknownTargets ?? []
    this.unknownQueries = input.unknownQueries ?? []
    this.emptyTargets = input.emptyTargets ?? []
  }
}

function quotedList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ')
}

/** True when a scope names nothing, i.e. the caller asked for a full sweep. */
export function measurementRunScopeIsEmpty(scope: MeasurementRunScopeRequest | null | undefined): boolean {
  return !scope || ((scope.groups?.length ?? 0) === 0 && (scope.targets?.length ?? 0) === 0)
}

export interface MeasurementRunScopeResolution {
  scope: MeasurementRunScope
  executionNodes: MeasurementExecutionNode[]
}

/**
 * Expand a scope into the execution nodes it actually covers.
 *
 * Groups stand for their member targets; the nodes are the ones those targets
 * selected. Baseline edges are deliberately not followed: baseline coverage is
 * a property of a full sweep, and a spot check that pulled baseline nodes in
 * would measure questions nobody asked for and read as though more of the plan
 * had been swept than was.
 */
export function resolveMeasurementRunScope(
  plan: MeasurementPlan,
  scope: MeasurementRunScopeRequest,
): MeasurementRunScopeResolution {
  const requestedGroups = canonicalStrings(scope.groups ?? [])
  const requestedTargets = canonicalStrings(scope.targets ?? [])
  const groupsByKey = new Map(plan.groups.map(group => [group.stableKey, group]))
  const targetKeys = new Set(plan.targets.map(target => target.stableKey))

  const unknownGroups = requestedGroups.filter(key => !groupsByKey.has(key))
  const unknownTargets = requestedTargets.filter(key => !targetKeys.has(key))
  if (unknownGroups.length || unknownTargets.length) {
    const parts: string[] = []
    if (unknownGroups.length) parts.push(`no group named ${quotedList(unknownGroups)}`)
    if (unknownTargets.length) parts.push(`no target named ${quotedList(unknownTargets)}`)
    throw new MeasurementRunScopeError({
      message: `The published measurement plan has ${parts.join(', and ')}. Check the spelling against the plan, or publish a plan that includes it.`,
      unknownGroups,
      unknownTargets,
    })
  }

  const selected = new Set<string>(requestedTargets)
  for (const key of requestedGroups) {
    for (const targetKey of groupsByKey.get(key)!.targetKeys) selected.add(targetKey)
  }
  const resolvedTargets = [...selected].sort(compareText)

  const usedNodeKeys = new Set(plan.usageEdges
    .filter(edge => edge.kind !== 'baseline' && selected.has(edge.targetKey))
    .map(edge => edge.executionNodeKey))
  const executionNodes = plan.executionNodes.filter(node => usedNodeKeys.has(node.stableKey))

  if (executionNodes.length === 0) {
    throw new MeasurementRunScopeError({
      message: `Nothing to measure: ${quotedList(resolvedTargets)} has no queries selected in the published measurement plan.`,
      emptyTargets: resolvedTargets,
    })
  }

  return {
    scope: measurementRunScopeSchema.parse({ groups: requestedGroups, targets: requestedTargets, queries: [], resolvedTargets }),
    executionNodes,
  }
}

/**
 * Expand a list of questions into the execution nodes that measure them.
 *
 * The unit being sliced here is the question, not the target, so every node the
 * revision compiled for that text is in — including the one baseline asks for.
 * Excluding it would drop the very measurement the operator named. A question
 * the pinned revision does not measure is named back rather than dropped: a
 * silently smaller run is the failure this prevents.
 */
export function resolveMeasurementRunQueryScope(
  plan: MeasurementPlan,
  queryTexts: readonly string[],
): MeasurementRunScopeResolution {
  const requested = canonicalStrings(queryTexts.map(normalizeMeasurementExecutionQueryText).filter(Boolean))
  const nodesByText = new Map<string, MeasurementExecutionNode[]>()
  for (const node of plan.executionNodes) {
    const key = normalizeMeasurementExecutionQueryText(node.queryText)
    nodesByText.set(key, [...(nodesByText.get(key) ?? []), node])
  }

  const unknown = requested.filter(text => !nodesByText.has(text))
  if (unknown.length) {
    throw new MeasurementRunScopeError({
      message: `The published measurement plan does not measure ${quotedList(unknown)}. `
        + 'Publish a revision that includes it, or run a question the plan already measures.',
      unknownQueries: unknown,
    })
  }

  const executionNodes = plan.executionNodes.filter(node => (
    requested.includes(normalizeMeasurementExecutionQueryText(node.queryText))
  ))
  return {
    scope: measurementRunScopeSchema.parse({ groups: [], targets: [], queries: requested, resolvedTargets: [] }),
    executionNodes,
  }
}

/** Kept generic while API retirement moves from legacy segments to Target/Group records. */
export const measurementSegmentRetirementResponseSchema = z.object({
  stableKey: measurementStableKeySchema,
  retiredAt: z.string().datetime(),
})
export type MeasurementSegmentRetirementResponse = z.output<typeof measurementSegmentRetirementResponseSchema>
export const measurementTargetRetirementResponseSchema = measurementSegmentRetirementResponseSchema
export type MeasurementTargetRetirementResponse = MeasurementSegmentRetirementResponse

export const measurementPlanResponseSchema = z.object({
  active: z.object({
    revision: measurementPlanRevisionSchema,
    checksum: measurementPlanChecksumSchema,
    createdAt: measurementPlanCreatedAtSchema,
    plan: storedMeasurementPlanSchema,
  }).nullable(),
})
export type MeasurementPlanResponse = z.output<typeof measurementPlanResponseSchema>

export const measurementPlanVersionsResponseSchema = z.object({
  versions: z.array(z.object({
    revision: measurementPlanRevisionSchema,
    checksum: measurementPlanChecksumSchema,
    createdAt: measurementPlanCreatedAtSchema,
    active: z.boolean(),
  })),
})
export type MeasurementPlanVersionsResponse = z.output<typeof measurementPlanVersionsResponseSchema>

export const measurementPlanVersionResponseSchema = z.object({
  version: z.object({
    revision: measurementPlanRevisionSchema,
    checksum: measurementPlanChecksumSchema,
    createdAt: measurementPlanCreatedAtSchema,
    active: z.boolean(),
    plan: storedMeasurementPlanSchema,
  }),
})
export type MeasurementPlanVersionResponse = z.output<typeof measurementPlanVersionResponseSchema>

export const measurementPlanCountsSchema = z.object({
  targets: z.number().int(),
  groups: z.number().int(),
  queries: z.number().int(),
  executionNodes: z.number().int(),
  usageEdges: z.number().int(),
  baselineEdges: z.number().int(),
  targetEdges: z.number().int(),
  dedupSavings: z.number().int(),
}).strict()
export type MeasurementPlanCounts = z.output<typeof measurementPlanCountsSchema>

export const measurementPlanCompileCheckIdSchema = z.enum([
  'invalid-authoring',
  'duplicate-identity',
  'unknown-target',
  'unknown-query',
  'invalid-project-context',
  'unowned-target-url',
  'owned-competitor',
  'target-query-context-conflict',
  'target-url-ownership-tie',
  'target-alias-cross-target-collision',
  'target-alias-project-brand-collision',
  'target-alias-prefix-overlap',
])
export type MeasurementPlanCompileCheckId = z.output<typeof measurementPlanCompileCheckIdSchema>

export const measurementPlanCompileCheckSchema = z.object({
  id: measurementPlanCompileCheckIdSchema,
  severity: z.enum(['fail', 'warn']),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number().int()])),
}).strict()
export type MeasurementPlanCompileCheck = z.output<typeof measurementPlanCompileCheckSchema>

const measurementPlanPreviewUsageCountsSchema = z.object({
  baseline: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
}).strict()

export const measurementPlanCompilePreviewSuccessSchema = z.object({
  ok: z.literal(true),
  checks: z.array(measurementPlanCompileCheckSchema),
  executionNodes: z.array(measurementExecutionNodeSchema),
  dedupSaved: z.number().int().nonnegative(),
  usageEdges: measurementPlanPreviewUsageCountsSchema,
  estCostUsd: z.null(),
  plan: measurementPlanSchema,
  warnings: z.array(measurementPlanWarningSchema),
  counts: measurementPlanCountsSchema,
}).strict()

export const measurementPlanCompilePreviewInvalidSchema = z.object({
  ok: z.literal(false),
  checks: z.array(measurementPlanCompileCheckSchema).min(1),
  executionNodes: z.array(measurementExecutionNodeSchema).length(0),
  dedupSaved: z.literal(0),
  usageEdges: z.object({
    baseline: z.literal(0),
    target: z.literal(0),
  }).strict(),
  estCostUsd: z.null(),
}).strict()

export const measurementPlanCompilePreviewResponseSchema = z.discriminatedUnion('ok', [
  measurementPlanCompilePreviewSuccessSchema,
  measurementPlanCompilePreviewInvalidSchema,
])
export type MeasurementPlanCompilePreviewResponse = z.output<typeof measurementPlanCompilePreviewResponseSchema>

const measurementSemanticSelectionSchema = z.object({
  targetKey: measurementStableKeySchema,
  context: locationContextSchema.nullable(),
  queryIds: z.array(measurementQueryIdSchema),
}).strict()

function keyedMeasurementDiffSchema<T extends z.ZodType>(valueSchema: T) {
  return z.object({
    added: z.array(valueSchema),
    removed: z.array(valueSchema),
    changed: z.array(z.object({
      stableKey: measurementStableKeySchema,
      before: valueSchema,
      after: valueSchema,
    }).strict()),
    unchanged: z.array(measurementStableKeySchema),
  }).strict()
}

export const measurementPlanDiffPreviewSuccessSchema = measurementPlanCompilePreviewSuccessSchema.extend({
  diff: z.object({
    activeRevision: measurementPlanRevisionSchema.nullable(),
    targets: keyedMeasurementDiffSchema(compiledMeasurementTargetSchema),
    groups: keyedMeasurementDiffSchema(measurementGroupSchema),
    querySelections: z.object({
      added: z.array(measurementSemanticSelectionSchema),
      removed: z.array(measurementSemanticSelectionSchema),
      changed: z.array(z.object({
        targetKey: measurementStableKeySchema,
        before: measurementSemanticSelectionSchema,
        after: measurementSemanticSelectionSchema,
      }).strict()),
      unchanged: z.array(z.object({
        targetKey: measurementStableKeySchema,
        context: locationContextSchema.nullable(),
      }).strict()),
    }).strict(),
    execution: z.object({
      addedNodeKeys: z.array(z.string().min(1)),
      removedNodeKeys: z.array(z.string().min(1)),
      addedUsageEdges: z.array(measurementUsageEdgeSchema),
      removedUsageEdges: z.array(measurementUsageEdgeSchema),
      counts: z.object({
        before: measurementPlanCountsSchema.nullable(),
        after: measurementPlanCountsSchema,
        delta: measurementPlanCountsSchema.nullable(),
      }).strict(),
    }).strict(),
  }).strict(),
}).strict()
export const measurementPlanDiffPreviewInvalidSchema = measurementPlanCompilePreviewInvalidSchema.extend({
  diff: z.null(),
}).strict()
export const measurementPlanDiffPreviewResponseSchema = z.discriminatedUnion('ok', [
  measurementPlanDiffPreviewSuccessSchema,
  measurementPlanDiffPreviewInvalidSchema,
])
export type MeasurementPlanDiffPreviewResponse = z.output<typeof measurementPlanDiffPreviewResponseSchema>

export interface MeasurementPlanContext {
  canonicalDomain: string
  ownedDomains: readonly string[]
  /** Explicit project display names and aliases; effective domain labels are added by the compiler. */
  brandNames?: readonly string[]
  /** Frozen expected provider/model snapshots per unique execution node. */
  expectedSnapshots: number
  /** Baseline edges always use this context; null means project-wide/default provider context. */
  defaultContext?: LocationContext | null
  trackedQueries: readonly { id: string; query: string }[]
  locations: readonly LocationContext[]
}

export interface MeasurementPlanValidationIssue {
  id: MeasurementPlanCompileCheckId
  path: (string | number)[]
  message: string
}

export class MeasurementPlanValidationError extends Error {
  readonly issues: MeasurementPlanValidationIssue[]

  constructor(issues: { path: (string | number)[]; message: string }[]) {
    super('Measurement plan validation failed')
    this.name = 'MeasurementPlanValidationError'
    this.issues = issues.map(issue => ({
      ...issue,
      id: compileCheckIdForIssue(issue.message),
    }))
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    )
  }
  return value
}

function contextKey(value: LocationContext | null): string {
  return value === null ? 'null' : JSON.stringify(canonicalJsonValue(value))
}

function contextsEqual(left: LocationContext | null, right: LocationContext | null): boolean {
  return contextKey(left) === contextKey(right)
}

function resolveContext(override: LocationContext | null | undefined, defaultContext: LocationContext | null): LocationContext | null {
  return override === undefined ? defaultContext : override
}

function ownedBy(host: string, roots: readonly string[]): boolean {
  return roots.some(root => host === root || host.endsWith(`.${root}`))
}

/**
 * The exact text an execution node carries. Exported so a runner can match a
 * node back to the tracked query row it came from using the compiler's own
 * rule rather than a lookalike of it.
 */
export function normalizeMeasurementExecutionQueryText(value: string): string {
  return value.trim().normalize('NFC').replace(/\s+/gu, ' ')
}

function base64UrlEncode(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const bytes = new TextEncoder().encode(value)
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes.at(index + 1)
    const third = bytes.at(index + 2)
    output += alphabet[first >>> 2]!
    output += alphabet[((first & 0b00000011) << 4) | ((second ?? 0) >>> 4)]!
    if (second !== undefined) output += alphabet[((second & 0b00001111) << 2) | ((third ?? 0) >>> 6)]!
    if (third !== undefined) output += alphabet[third & 0b00111111]!
  }
  return output
}

function issuePathKey(path: readonly (string | number)[]): string {
  return path.map(part => String(part)).join('\u0000')
}

function sortedIssues(issues: readonly { path: (string | number)[]; message: string }[]): { path: (string | number)[]; message: string }[] {
  return [...issues].sort((left, right) => compareText(issuePathKey(left.path), issuePathKey(right.path)) || compareText(left.message, right.message))
}

function throwValidation(issues: readonly { path: (string | number)[]; message: string }[]): never {
  throw new MeasurementPlanValidationError(sortedIssues(issues))
}

function parseContext(value: unknown): LocationContext | null {
  if (value == null) return null
  const parsed = locationContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

interface KnownQuery {
  queryId: string
  queryText: string
  executionQueryText: string
}

interface PendingUsage {
  kind: MeasurementUsageEdge['kind']
  queryId: string
  targetKey?: string
  context: LocationContext | null
  nodeSignature: string
}

function usageEdgeKey(edge: PendingUsage): string {
  return [edge.kind, edge.targetKey ?? '', edge.queryId, edge.nodeSignature].join('\u0000')
}

function compareUsageEdges(left: MeasurementUsageEdge, right: MeasurementUsageEdge): number {
  return compareText(left.kind, right.kind)
    || compareText('targetKey' in left ? left.targetKey : '', 'targetKey' in right ? right.targetKey : '')
    || compareText(left.queryId, right.queryId)
    || compareText(left.executionNodeKey, right.executionNodeKey)
}

function warningsForAliases(targets: readonly CompiledMeasurementTarget[]): MeasurementPlanWarning[] {
  const warnings: MeasurementPlanWarning[] = []
  const targetAliases = targets.flatMap(target => target.aliases.map(alias => ({
    targetKey: target.stableKey,
    alias,
    key: brandKeyFromText(alias),
  })))
  for (let index = 0; index < targetAliases.length; index++) {
    const left = targetAliases[index]!
    for (let otherIndex = index + 1; otherIndex < targetAliases.length; otherIndex++) {
      const right = targetAliases[otherIndex]!
      if (left.targetKey === right.targetKey || left.key === right.key) continue
      if (left.key.startsWith(right.key) || right.key.startsWith(left.key)) {
        warnings.push({
          code: 'target-alias-prefix-overlap',
          message: 'Target aliases overlap by mention prefix',
          targetKeys: canonicalStrings([left.targetKey, right.targetKey]),
          aliases: canonicalStrings([left.alias, right.alias]),
        })
      }
    }
  }

  const deduped = new Map<string, MeasurementPlanWarning>()
  for (const warning of warnings) {
    const key = [warning.code, warning.targetKeys.join('\u0000'), warning.aliases.join('\u0000')].join('\u0000')
    deduped.set(key, warning)
  }
  return [...deduped.values()].sort((left, right) => (
    compareText(left.code, right.code)
    || compareText(left.targetKeys.join('\u0000'), right.targetKeys.join('\u0000'))
    || compareText(left.aliases.join('\u0000'), right.aliases.join('\u0000'))
  ))
}

/**
 * Compile an authoring plan against the project definition. The returned
 * object is the complete immutable persisted revision; provider materializing
 * is deliberately outside this contract.
 */
export function compileMeasurementPlan(input: MeasurementPlanInput, context: MeasurementPlanContext): MeasurementPlan {
  const parsed = measurementPlanInputSchema.safeParse(input)
  if (!parsed.success) {
    throwValidation(parsed.error.issues.map(issue => ({
      path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
      message: issue.message,
    })))
  }
  const plan: ParsedMeasurementPlanInput = parsed.data
  const issues: { path: (string | number)[]; message: string }[] = []

  if (!Number.isInteger(context.expectedSnapshots) || context.expectedSnapshots < 0) {
    issues.push({ path: ['context', 'expectedSnapshots'], message: 'Expected snapshots must be a nonnegative integer' })
  }

  const roots: string[] = []
  let projectCanonicalHost = ''
  const rootValues = [context.canonicalDomain, ...context.ownedDomains]
  rootValues.forEach((value, index) => {
    try {
      const host = normalizeMeasurementHost(value)
      roots.push(host)
      if (index === 0) projectCanonicalHost = host
    } catch {
      issues.push({ path: ['context', index === 0 ? 'canonicalDomain' : 'ownedDomains', index - 1], message: 'Project owned domain is invalid' })
    }
  })
  const effectiveOwnedHosts = canonicalStrings(roots)
  const projectBrandNames = canonicalAliases([
    ...(context.brandNames ?? []).filter(name => brandKeyFromText(name).length > 0),
    ...effectiveOwnedHosts
      .map(brandLabelFromDomain)
      .filter(name => brandKeyFromText(name).length >= 4),
  ])

  const configuredLocations: LocationContext[] = []
  context.locations.forEach((location, index) => {
    const parsedLocation = parseContext(location)
    if (!parsedLocation) {
      issues.push({ path: ['context', 'locations', index], message: 'Configured project location is invalid' })
    } else {
      configuredLocations.push(parsedLocation)
    }
  })
  let defaultContext: LocationContext | null = null
  if (context.defaultContext !== undefined && context.defaultContext !== null) {
    const parsedDefault = parseContext(context.defaultContext)
    if (!parsedDefault) {
      issues.push({ path: ['context', 'defaultContext'], message: 'Project default context is invalid' })
    } else {
      defaultContext = parsedDefault
      if (!configuredLocations.some(location => contextsEqual(location, defaultContext))) {
        issues.push({ path: ['context', 'defaultContext'], message: 'Project default context must exactly match a configured project location' })
      }
    }
  }

  const knownQueries = new Map<string, KnownQuery>()
  context.trackedQueries.forEach((query, index) => {
    const queryId = typeof query.id === 'string' ? query.id.trim() : ''
    const queryText = typeof query.query === 'string' ? query.query : ''
    const executionQueryText = normalizeMeasurementExecutionQueryText(queryText)
    if (!queryId) {
      issues.push({ path: ['context', 'trackedQueries', index, 'id'], message: 'Tracked query id is invalid' })
    } else if (knownQueries.has(queryId)) {
      issues.push({ path: ['context', 'trackedQueries', index, 'id'], message: `Duplicate tracked query: ${queryId}` })
    } else if (!executionQueryText) {
      issues.push({ path: ['context', 'trackedQueries', index, 'query'], message: 'Tracked query text is invalid' })
    } else {
      knownQueries.set(queryId, { queryId, queryText, executionQueryText })
    }
  })

  plan.groups.forEach((group, groupIndex) => {
    group.competitors?.forEach((competitor, competitorIndex) => {
      if (ownedBy(competitor, effectiveOwnedHosts)) {
        issues.push({ path: ['groups', groupIndex, 'competitors', competitorIndex], message: 'Group competitor must be independent from project-owned hosts' })
      }
    })
  })

  const resolvedSelectionContexts = new Map<number, LocationContext | null>()
  plan.targetQuerySelections.forEach((selection, selectionIndex) => {
    const resolved = resolveContext(selection.context, defaultContext)
    resolvedSelectionContexts.set(selectionIndex, resolved)
    if (resolved && !configuredLocations.some(location => contextsEqual(location, resolved))) {
      issues.push({ path: ['targetQuerySelections', selectionIndex, 'context'], message: 'Target selection context must exactly match a configured project location' })
    }
    selection.queryIds.forEach((queryId, queryIndex) => {
      if (!knownQueries.has(queryId)) {
        issues.push({ path: ['targetQuerySelections', selectionIndex, 'queryIds', queryIndex], message: `Unknown tracked query: ${queryId}` })
      }
    })
  })

  plan.targets.forEach((target, targetIndex) => target.urls.forEach((matcher, matcherIndex) => {
    if (!ownedBy(matcherParts(matcher).host, effectiveOwnedHosts)) {
      issues.push({
        path: ['targets', targetIndex, 'urls', matcherIndex, 'host'],
        message: 'Target URL matcher host must be an owned host or its dot-boundary subdomain',
      })
    }
  }))

  const assignmentContexts = new Map<string, LocationContext | null>()
  const noteTargetQueryAssignment = (
    targetKey: string,
    queryId: string,
    resolvedContext: LocationContext | null,
    path: (string | number)[],
  ): void => {
    if (!knownQueries.has(queryId)) return
    const key = `${targetKey}\u0000${queryId}`
    const previous = assignmentContexts.get(key)
    if (previous !== undefined && !contextsEqual(previous, resolvedContext)) {
      issues.push({ path, message: 'Target/query assignment has conflicting resolved contexts' })
    } else if (!assignmentContexts.has(key)) {
      assignmentContexts.set(key, resolvedContext)
    }
  }
  plan.targetQuerySelections.forEach((selection, selectionIndex) => {
    const resolved = resolvedSelectionContexts.get(selectionIndex) ?? null
    for (const queryId of canonicalStrings(selection.queryIds)) {
      noteTargetQueryAssignment(selection.targetKey, queryId, resolved, ['targetQuerySelections', selectionIndex, 'context'])
    }
  })

  const projectBrandKeys = new Set(projectBrandNames.map(brandKeyFromText).filter(key => key.length >= 4))
  plan.targets.forEach((target, targetIndex) => {
    target.aliases.forEach((alias, aliasIndex) => {
      const key = brandKeyFromText(alias)
      if (key.length >= 4 && projectBrandKeys.has(key)) {
        issues.push({
          path: ['targets', targetIndex, 'aliases', aliasIndex],
          message: 'Target alias must not equal an effective project brand term',
        })
      }
    })
  })
  if (issues.length) throwValidation(issues)

  const targets: CompiledMeasurementTarget[] = plan.targets.map(target => {
    const aliases = canonicalAliases(target.aliases)
    const metadata = canonicalMetadata(target.metadata)
    return {
      stableKey: target.stableKey,
      label: target.label,
      urls: canonicalMatchers(target.urls),
      aliases,
      ...(metadata ? { metadata } : {}),
      mentionNotApplicable: aliases.length === 0,
    }
  }).sort((left, right) => compareText(left.stableKey, right.stableKey))

  const groups: MeasurementGroup[] = plan.groups.map(group => ({
    stableKey: group.stableKey,
    label: group.label,
    targetKeys: canonicalStrings(group.targetKeys),
    ...(group.competitors && group.competitors.length > 0 ? { competitors: canonicalStrings(group.competitors) } : {}),
  })).sort((left, right) => compareText(left.stableKey, right.stableKey))

  const mergedSelections = new Map<string, {
    targetKey: string
    resolvedContext: LocationContext | null
    queryIds: Set<string>
  }>()
  plan.targetQuerySelections.forEach((selection, selectionIndex) => {
    const resolvedContext = resolvedSelectionContexts.get(selectionIndex) ?? null
    const key = `${selection.targetKey}\u0000${contextKey(resolvedContext)}`
    const existing = mergedSelections.get(key)
    if (existing) {
      for (const queryId of selection.queryIds) existing.queryIds.add(queryId)
    } else {
      mergedSelections.set(key, {
        targetKey: selection.targetKey,
        resolvedContext,
        queryIds: new Set(selection.queryIds),
      })
    }
  })
  const targetQuerySelections: MeasurementTargetQuerySelection[] = [...mergedSelections.values()].map(selection => ({
    targetKey: selection.targetKey,
    queryIds: canonicalStrings([...selection.queryIds]),
    ...(contextsEqual(selection.resolvedContext, defaultContext) ? {} : { context: selection.resolvedContext }),
  })).sort((left, right) => (
    compareText(left.targetKey, right.targetKey)
    || compareText(contextKey(resolveContext(left.context, defaultContext)), contextKey(resolveContext(right.context, defaultContext)))
    || compareText(left.queryIds.join('\u0000'), right.queryIds.join('\u0000'))
  ))

  const querySnapshots = [...knownQueries.values()]
    .map(query => ({ queryId: query.queryId, queryText: query.queryText }))
    .sort((left, right) => compareText(left.queryId, right.queryId))

  const pendingUsages = new Map<string, PendingUsage>()
  const nodeSeeds = new Map<string, { queryText: string; context: LocationContext | null }>()
  const addUsage = (
    kind: MeasurementUsageEdge['kind'],
    queryId: string,
    resolvedContext: LocationContext | null,
    targetKey?: string,
  ): void => {
    const query = knownQueries.get(queryId)
    if (!query) return
    const nodeSignature = `${query.executionQueryText}\u0000${contextKey(resolvedContext)}`
    nodeSeeds.set(nodeSignature, { queryText: query.executionQueryText, context: resolvedContext })
    const pending: PendingUsage = { kind, queryId, context: resolvedContext, nodeSignature, ...(targetKey ? { targetKey } : {}) }
    pendingUsages.set(usageEdgeKey(pending), pending)
  }

  for (const query of querySnapshots) addUsage('baseline', query.queryId, defaultContext)
  targetQuerySelections.forEach((selection) => {
    const resolved = resolveContext(selection.context, defaultContext)
    for (const queryId of canonicalStrings(selection.queryIds)) addUsage('target', queryId, resolved, selection.targetKey)
  })
  const executionNodes: MeasurementExecutionNode[] = [...nodeSeeds.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([signature, node]) => ({
      stableKey: `execution-${base64UrlEncode(signature)}`,
      queryText: node.queryText,
      context: node.context,
      expectedSnapshots: context.expectedSnapshots,
    }))
  const executionNodeKeys = new Map<string, string>()
  executionNodes.forEach(node => {
    const signature = `${node.queryText}\u0000${contextKey(node.context)}`
    executionNodeKeys.set(signature, node.stableKey)
  })
  const usageEdges: MeasurementUsageEdge[] = [...pendingUsages.values()].map((pending): MeasurementUsageEdge => {
    const executionNodeKey = executionNodeKeys.get(pending.nodeSignature)!
    switch (pending.kind) {
      case 'baseline':
        return { kind: 'baseline', executionNodeKey, queryId: pending.queryId }
      case 'target':
        return { kind: 'target', executionNodeKey, queryId: pending.queryId, targetKey: pending.targetKey! }
    }
  }).sort(compareUsageEdges)

  return {
    schemaVersion: MEASUREMENT_PLAN_SCHEMA_VERSION,
    defaultContext,
    effectiveOwnedHosts,
    projectCanonicalHost,
    projectBrandNames,
    targets,
    groups,
    targetQuerySelections,
    querySnapshots,
    executionNodes,
    usageEdges,
    warnings: warningsForAliases(targets),
  }
}

function compileCheckIdForIssue(message: string): MeasurementPlanCompileCheckId {
  if (message.includes('must not equal an effective project brand term')) return 'target-alias-project-brand-collision'
  if (message.includes('equal-specificity cross-target tie')) return 'target-url-ownership-tie'
  if (message.includes('already assigned to target')) return 'target-alias-cross-target-collision'
  if (message.startsWith('Duplicate ') || message.includes('globally unique')) return 'duplicate-identity'
  if (message.includes('Unknown target')) return 'unknown-target'
  if (message.includes('Unknown tracked query')) return 'unknown-query'
  if (message.includes('conflicting resolved contexts')) return 'target-query-context-conflict'
  if (message.includes('owned host or its dot-boundary subdomain')) return 'unowned-target-url'
  if (message.includes('competitor must be independent')) return 'owned-competitor'
  if (message.includes('context') || message.includes('location') || message.includes('Expected snapshots')) return 'invalid-project-context'
  return 'invalid-authoring'
}

/** Converts compiler validation into stable, transport-safe checks. */
export function measurementPlanValidationChecks(error: MeasurementPlanValidationError): MeasurementPlanCompileCheck[] {
  return error.issues.map(issue => ({
    id: issue.id,
    severity: 'fail',
    message: issue.message,
    path: issue.path,
  }))
}

export function measurementPlanCounts(plan: MeasurementPlan): MeasurementPlanCounts {
  const baselineEdges = plan.usageEdges.filter(edge => edge.kind === 'baseline').length
  const targetEdges = plan.usageEdges.filter(edge => edge.kind === 'target').length
  return {
    targets: plan.targets.length,
    groups: plan.groups.length,
    queries: plan.querySnapshots.length,
    executionNodes: plan.executionNodes.length,
    usageEdges: plan.usageEdges.length,
    baselineEdges,
    targetEdges,
    dedupSavings: Math.max(0, plan.usageEdges.length - plan.executionNodes.length),
  }
}

/** Non-throwing compile boundary used by HTTP preview adapters. */
export function compileMeasurementPlanPreview(
  input: unknown,
  context: MeasurementPlanContext,
): MeasurementPlanCompilePreviewResponse {
  try {
    const plan = compileMeasurementPlan(input as MeasurementPlanInput, context)
    const counts = measurementPlanCounts(plan)
    const checks: MeasurementPlanCompileCheck[] = plan.warnings.map(warning => ({
      id: 'target-alias-prefix-overlap',
      severity: 'warn',
      message: warning.message,
      path: ['targets'],
    }))
    return {
      ok: true,
      checks,
      executionNodes: plan.executionNodes,
      dedupSaved: counts.dedupSavings,
      usageEdges: { baseline: counts.baselineEdges, target: counts.targetEdges },
      estCostUsd: null,
      plan,
      warnings: plan.warnings,
      counts,
    }
  } catch (error) {
    if (error instanceof MeasurementPlanValidationError) {
      return {
        ok: false,
        checks: measurementPlanValidationChecks(error),
        executionNodes: [],
        dedupSaved: 0,
        usageEdges: { baseline: 0, target: 0 },
        estCostUsd: null,
      }
    }
    return {
      ok: false,
      checks: [{
        id: 'invalid-authoring',
        severity: 'fail',
        message: error instanceof Error ? error.message : 'Measurement plan compilation failed',
        path: [],
      }],
      executionNodes: [],
      dedupSaved: 0,
      usageEdges: { baseline: 0, target: 0 },
      estCostUsd: null,
    }
  }
}

/** Stable, browser-safe serialization used by checksum callers outside this package. */
export function canonicalMeasurementPlanJson(plan: MeasurementPlan): string {
  return JSON.stringify(canonicalJsonValue(plan))
}

function parseMeasurementUrl(value: string): { host: string; pathname: string } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = normalizeMeasurementHost(parsed.hostname)
    return { host, pathname: canonicalizeMeasurementPath(parsed.pathname || '/') }
  } catch {
    return null
  }
}

function equalPath(left: string, right: string, pathCase: 'sensitive' | 'insensitive'): boolean {
  return pathCase === 'insensitive' ? foldPathCase(left) === foldPathCase(right) : left === right
}

function hasPathPrefix(pathname: string, prefix: string, pathCase: 'sensitive' | 'insensitive'): boolean {
  const actual = pathCase === 'insensitive' ? foldPathCase(pathname) : pathname
  const expected = pathCase === 'insensitive' ? foldPathCase(prefix) : prefix
  return expected === '/' || actual === expected || actual.startsWith(`${expected}/`)
}

/** Matches a URL against one normalized Target matcher, including strict path boundaries. */
export function matchesMeasurementTargetUrl(url: string, input: MeasurementTargetUrlMatcher): boolean {
  const parsedMatcher = measurementTargetUrlMatcherSchema.safeParse(input)
  const parsedUrl = parseMeasurementUrl(url)
  if (!parsedMatcher.success || !parsedUrl) return false
  const matcher = parsedMatcher.data
  const parts = matcherParts(matcher)
  if (parsedUrl.host !== parts.host) return false
  switch (matcher.kind) {
    case 'host': return true
    case 'prefix': return hasPathPrefix(parsedUrl.pathname, matcher.pathPrefix, matcher.pathCase)
    case 'exact': return equalPath(parsedUrl.pathname, parts.pathname!, matcher.pathCase)
  }
}

export type MeasurementTargetResolution =
  | { status: 'matched'; targetKey: string; matcher: MeasurementTargetUrlMatcher }
  | { status: 'ambiguous'; candidates: Array<{ targetKey: string; matcher: MeasurementTargetUrlMatcher }> }
  | null

/**
 * Resolves one captured URL without an arbitrary lexical tie-break. Compiled
 * plans reject cross-target ties; the ambiguity branch protects callers that
 * pass an ad-hoc/uncompiled Target list.
 */
export function resolveMeasurementTarget(
  url: string,
  targets: readonly Pick<MeasurementTarget, 'stableKey' | 'urls'>[],
): MeasurementTargetResolution {
  const candidates: Array<{ targetKey: string; matcher: MeasurementTargetUrlMatcher }> = []
  for (const target of targets) {
    for (const inputMatcher of target.urls) {
      const parsedMatcher = measurementTargetUrlMatcherSchema.safeParse(inputMatcher)
      if (!parsedMatcher.success || !matchesMeasurementTargetUrl(url, parsedMatcher.data)) continue
      candidates.push({ targetKey: target.stableKey, matcher: parsedMatcher.data })
    }
  }
  if (candidates.length === 0) return null
  const highestSpecificity = Math.max(...candidates.map(candidate => matcherSpecificity(candidate.matcher)))
  let highest = candidates.filter(candidate => matcherSpecificity(candidate.matcher) === highestSpecificity)
  if (highestSpecificity === 2) {
    const longestPrefix = Math.max(...highest.map(candidate => matcherParts(candidate.matcher).pathname!.length))
    highest = highest.filter(candidate => matcherParts(candidate.matcher).pathname!.length === longestPrefix)
  }
  const winners = new Map<string, { targetKey: string; matcher: MeasurementTargetUrlMatcher }>()
  for (const candidate of highest.sort((left, right) => compareMatchers(left.matcher, right.matcher))) {
    if (!winners.has(candidate.targetKey)) winners.set(candidate.targetKey, candidate)
  }
  const resolved = [...winners.values()].sort((left, right) => compareText(left.targetKey, right.targetKey) || compareMatchers(left.matcher, right.matcher))
  if (resolved.length === 1) return { status: 'matched', ...resolved[0]! }
  return { status: 'ambiguous', candidates: resolved }
}

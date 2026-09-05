import { z } from 'zod'
import { locationContextSchema, providerNameSchema } from './provider.js'
import { effectiveBrandNames } from './project.js'
import { compileQueryClassifier, queryClassSchema } from './query-class.js'
import { hostOf } from './url-normalize.js'

/** First immutable snapshot format for a planless simple measurement run. */
export const SIMPLE_MEASUREMENT_DEFINITION_SCHEMA_VERSION = 1 as const

const nonBlankStringSchema = z.string().refine(value => value.trim().length > 0, {
  message: 'Must not be blank',
})

const simpleMeasurementIdentitySchema = z.object({
  // These fields intentionally preserve their stored presentation. The shared
  // matcher derives its normalized form separately when classifying queries.
  displayName: z.string(),
  aliases: z.array(z.string()),
  canonicalDomain: z.string(),
  ownedDomains: z.array(z.string()),
}).strict()

const simpleMeasurementEngineSchema = z.object({
  provider: providerNameSchema.refine(value => value.trim().length > 0, {
    message: 'Provider must not be blank',
  }),
  // Preserve the requested model exactly; null does not claim a served model.
  // A legacy empty value can resolve to an adapter default.
  requestedModel: z.string().nullable(),
}).strict()

/**
 * Frozen competitor identity for a planless run. Omission is meaningful: rows
 * captured before this field existed did not promise a competitor set and must
 * not be relabelled from today's project configuration.
 */
const simpleMeasurementCompetitorSchema = z.object({
  domain: z.string().trim().min(1).refine(value => hostOf(value) !== null, 'A competitor domain must be a valid hostname'),
  label: z.string().trim().min(1),
  aliases: z.array(z.string()),
}).strict()

const simpleMeasurementQueryInputSchema = z.object({
  queryId: nonBlankStringSchema,
  // The legacy runner can dispatch a stored empty query. Preserve that exact
  // selected input rather than making first capture change its behavior.
  queryText: z.string(),
  provenance: z.string().nullable(),
}).strict()

const simpleMeasurementQuerySchema = simpleMeasurementQueryInputSchema.extend({
  queryClass: queryClassSchema.nullable(),
}).strict()

function addCollectionIssues(
  value: {
    engines: readonly { provider: string }[]
    queries: readonly { queryId: string }[]
    competitors?: readonly { domain: string }[]
  },
  ctx: z.RefinementCtx,
): void {
  const engineProviders = new Set<string>()
  value.engines.forEach((engine, index) => {
    const key = engine.provider.trim().toLocaleLowerCase('en')
    if (engineProviders.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engines', index, 'provider'],
        message: `Duplicate engine provider "${engine.provider}"`,
      })
    }
    engineProviders.add(key)
  })

  const queryIds = new Set<string>()
  value.queries.forEach((query, index) => {
    if (queryIds.has(query.queryId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queries', index, 'queryId'],
        message: `Duplicate query id "${query.queryId}"`,
      })
    }
    queryIds.add(query.queryId)
  })

  const competitorDomains = new Set<string>()
  value.competitors?.forEach((competitor, index) => {
    const key = competitor.domain.trim().toLocaleLowerCase('en')
    if (competitorDomains.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['competitors', index, 'domain'],
        message: `Duplicate competitor domain "${competitor.domain}"`,
      })
    }
    competitorDomains.add(key)
  })
}

const simpleMeasurementDefinitionInputSchema = z.object({
  capturedAt: z.string().datetime(),
  identity: simpleMeasurementIdentitySchema,
  country: z.string(),
  language: z.string(),
  location: locationContextSchema.nullable(),
  engines: z.array(simpleMeasurementEngineSchema).min(1),
  /** Missing on historical sidecars; an empty array means the captured set was intentionally empty. */
  competitors: z.array(simpleMeasurementCompetitorSchema).optional(),
  queries: z.array(simpleMeasurementQueryInputSchema),
}).strict().superRefine(addCollectionIssues)

/** Inputs captured at dispatch. Query classes are derived only from this identity snapshot. */
export type SimpleMeasurementDefinitionInput = z.input<typeof simpleMeasurementDefinitionInputSchema>

/**
 * An immutable input snapshot for a future simple measurement run.
 *
 * It is deliberately separate from measurement-plan v2: a planless run has no
 * assignment graph, but it still needs a frozen basket, identity, context, and
 * engine/model selection before provider work begins.
 */
export const simpleMeasurementDefinitionSchema = z.object({
  schemaVersion: z.literal(SIMPLE_MEASUREMENT_DEFINITION_SCHEMA_VERSION),
  capturedAt: z.string().datetime(),
  identity: simpleMeasurementIdentitySchema,
  country: z.string(),
  language: z.string(),
  // Requested adapter input, not proof that the provider applied this context.
  location: locationContextSchema.nullable(),
  engines: z.array(simpleMeasurementEngineSchema).min(1),
  competitors: z.array(simpleMeasurementCompetitorSchema).optional(),
  queries: z.array(simpleMeasurementQuerySchema),
}).strict().superRefine(addCollectionIssues)

export type SimpleMeasurementDefinition = z.output<typeof simpleMeasurementDefinitionSchema>

/**
 * Clone and validate a dispatch-time simple-run definition.
 *
 * `compileQueryClassifier` and `effectiveBrandNames` remain the only class
 * authority. An unusable captured identity produces null rather than claiming
 * every query is non-brand.
 */
export function buildSimpleMeasurementDefinition(
  input: SimpleMeasurementDefinitionInput,
): SimpleMeasurementDefinition {
  const parsed = simpleMeasurementDefinitionInputSchema.parse(input)
  const classifier = compileQueryClassifier(effectiveBrandNames(parsed.identity))

  return simpleMeasurementDefinitionSchema.parse({
    schemaVersion: SIMPLE_MEASUREMENT_DEFINITION_SCHEMA_VERSION,
    capturedAt: parsed.capturedAt,
    identity: {
      displayName: parsed.identity.displayName,
      aliases: [...parsed.identity.aliases],
      canonicalDomain: parsed.identity.canonicalDomain,
      ownedDomains: [...parsed.identity.ownedDomains],
    },
    country: parsed.country,
    language: parsed.language,
    location: parsed.location === null
      ? null
      : {
          label: parsed.location.label,
          city: parsed.location.city,
          region: parsed.location.region,
          country: parsed.location.country,
          ...(parsed.location.timezone === undefined ? {} : { timezone: parsed.location.timezone }),
        },
    engines: parsed.engines.map(engine => ({
      provider: engine.provider,
      requestedModel: engine.requestedModel,
    })),
    ...(parsed.competitors === undefined ? {} : {
      competitors: parsed.competitors.map(competitor => ({
        domain: competitor.domain,
        label: competitor.label,
        aliases: [...competitor.aliases],
      })),
    }),
    // Do not normalize or deduplicate text here. Different selected query IDs
    // can legitimately have equivalent text and represent separate executions.
    queries: parsed.queries.map(query => ({
      queryId: query.queryId,
      queryText: query.queryText,
      provenance: query.provenance,
      queryClass: classifier?.classify(query.queryText) ?? null,
    })),
  })
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Stable serialization for checksums and equality checks. It orders set-like
 * arrays without altering the exact strings retained by the definition.
 */
export function canonicalSimpleMeasurementDefinitionJson(definition: SimpleMeasurementDefinition): string {
  const parsed = simpleMeasurementDefinitionSchema.parse(definition)
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    capturedAt: parsed.capturedAt,
    identity: {
      displayName: parsed.identity.displayName,
      aliases: [...parsed.identity.aliases].sort(compareText),
      canonicalDomain: parsed.identity.canonicalDomain,
      ownedDomains: [...parsed.identity.ownedDomains].sort(compareText),
    },
    country: parsed.country,
    language: parsed.language,
    location: parsed.location === null
      ? null
      : {
          label: parsed.location.label,
          city: parsed.location.city,
          region: parsed.location.region,
          country: parsed.location.country,
          ...(parsed.location.timezone === undefined ? {} : { timezone: parsed.location.timezone }),
        },
    engines: [...parsed.engines]
      .map(engine => ({ provider: engine.provider, requestedModel: engine.requestedModel }))
      .sort((left, right) => compareText(left.provider, right.provider)),
    ...(parsed.competitors === undefined ? {} : {
      competitors: [...parsed.competitors]
        .map(competitor => ({
          domain: competitor.domain,
          label: competitor.label,
          aliases: [...competitor.aliases].sort(compareText),
        }))
        .sort((left, right) => compareText(left.domain, right.domain)),
    }),
    queries: [...parsed.queries]
      .map(query => ({
        queryId: query.queryId,
        queryText: query.queryText,
        provenance: query.provenance,
        queryClass: query.queryClass,
      }))
      .sort((left, right) => compareText(left.queryId, right.queryId)),
  })
}

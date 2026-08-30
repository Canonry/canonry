import type { FastifyInstance } from 'fastify'
import {
  AGENT_PROVIDER_IDS,
  AdsAdGroupBillingEventTypes,
  AdsCampaignBiddingTypes,
  AdsOperationStates,
} from '@ainyc/canonry-contracts'
import {
  buildComponentSchemas,
  errorResponse,
  jsonArrayResponse,
  jsonResponse,
  looseObjectSchema,
  rawJsonResponse,
  type RegisteredSchemaName,
} from './openapi-schemas.js'

export interface OpenApiInfo {
  title?: string
  version?: string
  description?: string
  /** API route prefix (default: '/api/v1') */
  routePrefix?: string
  /**
   * Include canonry-local routes (Aero agent endpoints) in the generated
   * spec. Set only when calling from canonry — the shared api-routes
   * package itself doesn't register them, so the contract test omits them.
   */
  includeCanonryLocal?: boolean
}

type HttpMethod = 'get' | 'post' | 'put' | 'delete'

interface OpenApiParameter {
  name: string
  /** `header` covers the concurrency and idempotency guards on draft mutations. */
  in: 'path' | 'query' | 'header'
  required?: boolean
  description: string
  schema: Record<string, unknown>
}

/**
 * A response definition. `description` alone is the legacy shape used for
 * status codes without a body (204 No Content, error responses where the
 * envelope is documented elsewhere). The `content`-bearing shape declares a
 * typed body so codegen tools can produce strongly typed clients.
 */
type ResponseDefinition =
  | { description: string }
  | { description: string; content: Record<string, { schema: Record<string, unknown> }> }

interface OpenApiOperation {
  method: HttpMethod
  path: string
  summary: string
  tags: string[]
  auth?: boolean
  description?: string
  parameters?: OpenApiParameter[]
  requestBody?: {
    required?: boolean
    description?: string
    content: Record<string, { schema: Record<string, unknown> }>
  }
  responses: Record<string, ResponseDefinition>
}

const stringSchema = { type: 'string' }
const booleanSchema = { type: 'boolean' }
const integerSchema = { type: 'integer' }
const objectSchema = { type: 'object', additionalProperties: true }
const stringArraySchema = { type: 'array', items: stringSchema }
const adsOperationKeySchema = {
  type: 'string',
  minLength: 8,
  maxLength: 128,
  pattern: '^[\\w.:-]+$',
}
const adsEntityIdSchema = { type: 'string', minLength: 1, maxLength: 200 }
const adsActivationEntityRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'expectedUpdatedAt'],
  properties: {
    id: adsEntityIdSchema,
    expectedUpdatedAt: { type: 'integer', minimum: 0 },
  },
}
const adsActivationManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['campaign'],
  properties: {
    campaign: {
      ...adsActivationEntityRefSchema,
      required: ['id', 'expectedUpdatedAt', 'adGroups'],
      properties: {
        ...adsActivationEntityRefSchema.properties,
        adGroups: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: {
            ...adsActivationEntityRefSchema,
            required: ['id', 'expectedUpdatedAt', 'ads'],
            properties: {
              ...adsActivationEntityRefSchema.properties,
              ads: {
                type: 'array',
                minItems: 1,
                maxItems: 1000,
                items: adsActivationEntityRefSchema,
              },
            },
          },
        },
      },
    },
  },
}
const adsCreativeRequestSchema = {
  type: 'object',
  required: ['title', 'body', 'targetUrl', 'fileId'],
  properties: {
    title: { type: 'string', minLength: 3, maxLength: 50 },
    body: { type: 'string', minLength: 1, maxLength: 100 },
    targetUrl: { type: 'string', format: 'uri' },
    fileId: stringSchema,
  },
}
const googleConnectionTypeSchema = { type: 'string', enum: ['gsc', 'ga4', 'gbp'] }
const locationSchema = {
  type: 'object',
  required: ['label', 'city', 'region', 'country'],
  properties: {
    label: stringSchema,
    city: stringSchema,
    region: stringSchema,
    country: stringSchema,
    timezone: stringSchema,
  },
}

const nameParameter: OpenApiParameter = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Project name.',
  schema: stringSchema,
}

const userNameParameter: OpenApiParameter = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Account name. Matched without regard to letter case.',
  schema: stringSchema,
}

const measurementPlanRevisionParameter: OpenApiParameter = {
  name: 'revision',
  in: 'path',
  required: true,
  description: 'Immutable project-local measurement-plan revision.',
  schema: { type: 'integer', minimum: 1 },
}

const measurementReportRevisionParameter: OpenApiParameter = {
  name: 'revision',
  in: 'query',
  required: true,
  description: 'Immutable project-local measurement-plan revision to report.',
  schema: { type: 'integer', minimum: 1 },
}

const measurementReportRunParameter: OpenApiParameter = {
  name: 'runId',
  in: 'query',
  required: false,
  description: 'Eligible full measurement run to reconstruct. Omit to use the latest run for the revision.',
  schema: stringSchema,
}

const runIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Run ID.',
  schema: stringSchema,
}

const queryIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Query ID.',
  schema: stringSchema,
}

const competitorIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Competitor ID.',
  schema: stringSchema,
}

const notificationIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Notification ID.',
  schema: stringSchema,
}

const keyIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'API key ID.',
  schema: stringSchema,
}

const providerNameParameter: OpenApiParameter = {
  name: 'name',
  in: 'path',
  required: true,
  description: 'Provider name.',
  schema: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'local'] },
}

const locationLabelParameter: OpenApiParameter = {
  name: 'label',
  in: 'path',
  required: true,
  description: 'Location label.',
  schema: stringSchema,
}

const googleTypeParameter: OpenApiParameter = {
  name: 'type',
  in: 'path',
  required: true,
  description: 'Google connection type.',
  schema: googleConnectionTypeSchema,
}

const projectRunIdParameter: OpenApiParameter = {
  name: 'runId',
  in: 'path',
  required: true,
  description: 'Run ID for a project run.',
  schema: stringSchema,
}

const snapshotIdParameter: OpenApiParameter = {
  name: 'snapshotId',
  in: 'path',
  required: true,
  description: 'Snapshot ID.',
  schema: stringSchema,
}

const conversionTrackingContractIdParameter: OpenApiParameter = {
  name: 'contractId',
  in: 'path',
  required: true,
  description: 'Project-scoped conversion tracking contract ID.',
  schema: stringSchema,
}

const googleMarketingAccountIdParameter: OpenApiParameter = {
  name: 'accountId',
  in: 'path',
  required: true,
  description: 'Google Tag Manager account ID.',
  schema: stringSchema,
}

const googleMarketingContainerIdParameter: OpenApiParameter = {
  name: 'containerId',
  in: 'path',
  required: true,
  description: 'Google Tag Manager container ID.',
  schema: stringSchema,
}

const googleMarketingSnapshotCursorParameter: OpenApiParameter = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque cursor returned by the preceding Google Marketing snapshot page.',
  schema: stringSchema,
}

const googleAdsMetricsWindowParameter: OpenApiParameter = {
  name: 'window',
  in: 'query',
  description: 'Reporting window over closed days: 7d, 14d, or 30d. Defaults to 14d.',
  schema: { type: 'string', enum: ['7d', '14d', '30d'] },
}

const limitQueryParameter: OpenApiParameter = {
  name: 'limit',
  in: 'query',
  description: 'Maximum number of records to return.',
  schema: integerSchema,
}

const offsetQueryParameter: OpenApiParameter = {
  name: 'offset',
  in: 'query',
  description: 'Number of records to skip.',
  schema: integerSchema,
}

const locationQueryParameter: OpenApiParameter = {
  name: 'location',
  in: 'query',
  description: 'Filter by location label. Use an empty value to request locationless results.',
  schema: stringSchema,
}

const scheduleKindQueryParameter: OpenApiParameter = {
  name: 'kind',
  in: 'query',
  description: 'Schedulable run kind. Defaults to "answer-visibility" for backward compatibility.',
  schema: { $ref: '#/components/schemas/SchedulableRunKind' },
}

const runsListKindQueryParameter: OpenApiParameter = {
  name: 'kind',
  in: 'query',
  description: 'Restrict results to a single run kind. Without this filter, integration syncs (bing-inspect, gsc-sync, ga-sync) can fill the default 500-row cap within minutes on busy projects and push answer-visibility runs out of the response.',
  schema: {
    type: 'string',
    enum: [
      'answer-visibility',
      'site-audit',
      'gsc-sync',
      'inspect-sitemap',
      'ga-sync',
      'bing-inspect',
      'bing-inspect-sitemap',
      'backlink-extract',
      'traffic-sync',
      'aeo-discover-seed',
      'aeo-discover-probe',
    ],
  },
}

const runsListSinceQueryParameter: OpenApiParameter = {
  name: 'since',
  in: 'query',
  description: 'Only return runs with created_at >= this ISO 8601 timestamp. Defaults to 30 days ago.',
  schema: stringSchema,
}

const runsListIncludeProbeQueryParameter: OpenApiParameter = {
  name: 'includeProbe',
  in: 'query',
  description: 'Set to "1" or "true" to include probe runs. Probes are excluded by default because they are operator/agent test runs and must not pollute dashboard aggregates.',
  schema: stringSchema,
}

const reportAudienceQueryParameter: OpenApiParameter = {
  name: 'audience',
  in: 'query',
  description: 'HTML report audience mode. Defaults to agency.',
  schema: { type: 'string', enum: ['agency', 'client'] },
}

const analyticsWindowParameter: OpenApiParameter = {
  name: 'window',
  in: 'query',
  description: 'Time window for analytics queries. An unrecognised value is rejected with 400; it is never widened to the full history.',
  schema: { type: 'string', enum: ['7d', '30d', '90d', 'all'] },
}

const analyticsStartDateParameter: OpenApiParameter = {
  name: 'startDate',
  in: 'query',
  description: 'Inclusive lower bound as a calendar date (YYYY-MM-DD). Takes precedence over "window", which is rolling from now and cannot name a calendar month.',
  schema: stringSchema,
}

const analyticsEndDateParameter: OpenApiParameter = {
  name: 'endDate',
  in: 'query',
  description: 'Inclusive upper bound as a calendar date (YYYY-MM-DD).',
  schema: stringSchema,
}

const organicEvidencePeriodQueryParameter: OpenApiParameter = {
  name: 'period',
  in: 'query',
  description:
    'Evidence window in days — 60 or 90 (default 90). GSC and GA4 retain source-specific 30-day cohort dates.',
  schema: { type: 'integer', enum: [60, 90] },
}

const reportPeriodQueryParameter: OpenApiParameter = {
  name: 'period',
  in: 'query',
  description:
    'Report window in days — one of 7, 14, 30, 90 (default 30). Scopes the GSC, GA4, and server-side AI activity sections and the period-over-period comparisons to this window.',
  schema: { type: 'integer', enum: [7, 14, 30, 90] },
}

const sinceQueryParameter: OpenApiParameter = {
  name: 'since',
  in: 'query',
  description:
    'Inclusive lower bound on run createdAt (ISO 8601). A date-only value (YYYY-MM-DD) is the start of that UTC day. Mutually exclusive with "lastRuns".',
  schema: stringSchema,
}

const untilQueryParameter: OpenApiParameter = {
  name: 'until',
  in: 'query',
  description:
    'Inclusive upper bound on run createdAt (ISO 8601). A date-only value (YYYY-MM-DD) covers the whole UTC day (through 23:59:59.999). Mutually exclusive with "lastRuns".',
  schema: stringSchema,
}

const lastRunsQueryParameter: OpenApiParameter = {
  name: 'lastRuns',
  in: 'query',
  description: 'Aggregate only the most recent N answer-visibility runs. Mutually exclusive with "since"/"until".',
  schema: integerSchema,
}

const groupByProviderQueryParameter: OpenApiParameter = {
  name: 'groupBy',
  in: 'query',
  description: 'Set to "provider" to include a per-provider breakdown whose counts sum to the pooled counts.',
  schema: { type: 'string', enum: ['provider'] },
}

const monthQueryParameter: OpenApiParameter = {
  name: 'month',
  in: 'query',
  description:
    'Aggregate a single calendar month (YYYY-MM), expanded to that month\'s inclusive UTC bounds. Mutually exclusive with "since"/"until"/"lastRuns".',
  schema: stringSchema,
}

const compareFromQueryParameter: OpenApiParameter = {
  name: 'from',
  in: 'query',
  required: true,
  description: 'Earlier calendar month (YYYY-MM) — the baseline period. Must be strictly before "to".',
  schema: stringSchema,
}

const compareToQueryParameter: OpenApiParameter = {
  name: 'to',
  in: 'query',
  required: true,
  description: 'Later calendar month (YYYY-MM) — the reporting period compared against "from".',
  schema: stringSchema,
}

const shareOfVoiceQueryParameter: OpenApiParameter = {
  name: 'shareOfVoice',
  in: 'query',
  description:
    'Set to "1" to include share of voice (project vs tracked-competitor brand mentions in answer text) across the window. Scoped by `queryClass`, which defaults to non-brand.',
  schema: { type: 'string', enum: ['1'] },
}

const shareOfVoiceQueryClassParameter: OpenApiParameter = {
  name: 'queryClass',
  in: 'query',
  description:
    'Which query class `shareOfVoice` covers. Defaults to `non-brand`: a branded query names the project, so it is mentioned on nearly all of them and a competitor structurally cannot be, and one shared denominator would report brand recall as category placement. Never pooled across classes.',
  schema: { type: 'string', enum: ['branded', 'non-brand'], default: 'non-brand' },
}

const wordpressEnvQueryParameter: OpenApiParameter = {
  name: 'env',
  in: 'query',
  description: 'WordPress environment to target.',
  schema: { type: 'string', enum: ['live', 'staging'] },
}

const wordpressSlugQueryParameter: OpenApiParameter = {
  name: 'slug',
  in: 'query',
  required: true,
  description: 'WordPress page slug.',
  schema: stringSchema,
}

const measurementIfMatchParameter: OpenApiParameter = {
  name: 'If-Match',
  in: 'header',
  required: true,
  description: 'Current draft ETag. Missing returns 428; stale returns 412.',
  schema: stringSchema,
}

const measurementIdempotencyKeyParameter: OpenApiParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Replay key. The same key with a different request body returns 409.',
  schema: stringSchema,
}

const measurementSearchParameter: OpenApiParameter = {
  name: 'search',
  in: 'query',
  description: 'Case-insensitive filter over the returned rows. It never changes a metric denominator.',
  schema: stringSchema,
}

const measurementCursorParameter: OpenApiParameter = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque cursor from the previous page.',
  schema: stringSchema,
}

const crawlCursorParameter: OpenApiParameter = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque cursor from the previous bounded crawl response.',
  schema: stringSchema,
}

const crawlLimitParameter: OpenApiParameter = {
  name: 'limit',
  in: 'query',
  description: 'Page size. Defaults to 100 (50 for structure/neighbors); maximum 200 (100 for structure/neighbors).',
  schema: { type: 'integer', minimum: 1, maximum: 200 },
}

const linkKindParameter: OpenApiParameter = {
  name: 'linkKind',
  in: 'query',
  description: 'Restrict links to `content` (excludes nav, header, and footer links) or `template` (only those). Defaults to `all`. A link neither rule could classify matches neither filter, which is why every link response also carries `templateDetection` and every edge carries `templateSource`: an empty `content` list means "could not tell" under an `unavailable-*` detection, and `templateSource` says whether a link that IS classified was decided by where it sits in the page (`placement`) or by how many pages repeat it (`ubiquity`).',
  schema: { type: 'string', enum: ['all', 'content', 'template'], default: 'all' },
}

const measurementOverviewSortParameter: OpenApiParameter = {
  name: 'sort',
  in: 'query',
  description: 'Snapshot row order. label-asc is the default. For coverage sorts, unavailable rows form the first bucket in either direction; available rates then follow the requested direction.',
  schema: {
    type: 'string',
    enum: [
      'label-asc',
      'label-desc',
      'citationCoverage-asc',
      'citationCoverage-desc',
      'mentionCoverage-asc',
      'mentionCoverage-desc',
    ],
    default: 'label-asc',
  },
}

const measurementOverviewCursorParameter: OpenApiParameter = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque, sort-aware cursor from the previous page. It pins pagination to the active revision, displayed run, evidence snapshot, and same filters even if a newer run completes. Reuse it unchanged with the same sort and filters; a mismatch or newly appended evidence is rejected. A legacy label cursor works only when sort is omitted; an explicit sort requires a new sort-bound cursor.',
  schema: stringSchema,
}

const measurementPropertyEvidenceShapeParameter: OpenApiParameter = {
  name: 'shape',
  in: 'query',
  description: 'What one row is. sources (the default) returns one row per cited URL under evidence, which is what a caller written before this parameter existed reads. answers returns one row per measured answer under answers, with the cited URLs nested inside it, so the answers that cited nothing at all are present rather than missing. Exactly one of the two keys is returned; the other is absent, not empty.',
  schema: { type: 'string', enum: ['sources', 'answers'], default: 'sources' },
}

const measurementPropertyEvidenceCursorParameter: OpenApiParameter = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque cursor from the previous page. It pins pagination to the active revision, displayed run, evidence snapshot, same filters, and the shape it was issued for; a mismatch or newly appended evidence is rejected rather than silently paged across. An answer page is keyed on the slot, so a boundary never falls between one answer and its own cited URLs.',
  schema: stringSchema,
}

const measurementLimitParameter: OpenApiParameter = {
  name: 'limit',
  in: 'query',
  description: 'Page size. Defaults to 50, maximum 100.',
  schema: { type: 'integer', minimum: 1, maximum: 100 },
}

const measurementQuerySetIdParameter: OpenApiParameter = {
  name: 'setId',
  in: 'path',
  required: true,
  description: 'Measurement query-set ID.',
  schema: stringSchema,
}

const measurementQueryTemplateIdParameter: OpenApiParameter = {
  name: 'templateId',
  in: 'path',
  required: true,
  description: 'Measurement query-template ID.',
  schema: stringSchema,
}

const measurementDraftCollectionParameters: OpenApiParameter[] = [
  nameParameter,
  measurementSearchParameter,
  measurementCursorParameter,
  measurementLimitParameter,
]

/**
 * One typed draft action. Every one is a POST under the same prefix and
 * carries an idempotency key. Actions against an existing draft also carry
 * its ETag and answer with the new ETag plus counts, so the shared half is
 * built once here rather than repeated per action.
 */
function measurementDraftAction(input: {
  action: string
  summary: string
  description?: string
  request?: RegisteredSchemaName
  response?: RegisteredSchemaName
  responseDescription?: string
  /** Set for the previews, which compile the stored draft and write nothing. */
  readOnly?: boolean
  /** False only when the action creates the draft and no current ETag exists. */
  requiresDraftEtag?: boolean
  /** The route enforces a bounded request body in addition to schema limits. */
  payloadTooLarge?: boolean
  /** The route has a per-caller request budget and can return HTTP 429. */
  rateLimited?: boolean
}): OpenApiOperation {
  const requiresDraftEtag = !input.readOnly && input.requiresDraftEtag !== false
  const parameters = input.readOnly
    ? [nameParameter]
    : [
        nameParameter,
        ...(requiresDraftEtag ? [measurementIfMatchParameter] : []),
        measurementIdempotencyKeyParameter,
      ]
  return {
    method: 'post',
    path: `/api/v1/projects/{name}/measurement-plan/draft/actions/${input.action}`,
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    tags: ['measurement-plans'],
    parameters,
    ...(input.request
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${input.request}` } } },
          },
        }
      : {}),
    responses: {
      200: jsonResponse(
        input.responseDescription ?? 'Draft mutated; the new ETag and counts are returned.',
        input.response ?? 'MeasurementDraftMutationResponse',
      ),
      400: errorResponse('The action payload is invalid.'),
      403: errorResponse('The caller may read the draft but not mutate it.'),
      404: errorResponse('Project or draft not found.'),
      ...(input.payloadTooLarge ? { 413: errorResponse('The request body or embedded CSV exceeds its limit.') } : {}),
      ...(input.rateLimited ? { 429: errorResponse('The preview request budget has been exceeded.') } : {}),
      ...(input.readOnly
        ? {}
        : {
            409: errorResponse('The idempotency key was already used with a different request body.'),
            ...(requiresDraftEtag
              ? {
                  412: errorResponse('The draft changed since it was loaded.'),
                  428: errorResponse('The draft ETag was not supplied in `If-Match`.'),
                }
              : {}),
          }),
    },
  }
}

const routeCatalog: OpenApiOperation[] = [
  {
    method: 'get',
    path: '/api/v1/openapi.json',
    summary: 'Get the OpenAPI document',
    description: 'Machine-readable description of the Canonry API surface.',
    tags: ['meta'],
    auth: false,
    responses: {
      200: rawJsonResponse('OpenAPI document.', looseObjectSchema),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/sitemaps/submit',
    summary: 'Submit GSC sitemaps',
    description: 'Submits sitemap URLs to Google Search Console sequentially. An accepted result means Google accepted the submit/refetch request; it does not indicate indexing.',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['sitemapUrls'],
            additionalProperties: false,
            properties: {
              sitemapUrls: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', format: 'uri', pattern: '^https?://' } },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Per-sitemap submission results returned.', 'GscSubmitSitemapsResponseDto'),
      400: errorResponse('Invalid sitemap request, property ownership, or OAuth scope.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects',
    summary: 'Create a project',
    description:
      'Creates a new project with create-only semantics for the domain-first launchpad. The server normalizes the project name and canonical domain; a normalized-name collision returns 409 and never updates the existing project.',
    tags: ['projects'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ProjectCreateRequest' },
        },
      },
    },
    responses: {
      201: jsonResponse('Project created.', 'ProjectDto'),
      400: errorResponse('Invalid project payload, normalized name, or canonical domain.'),
      403: errorResponse('The caller lacks broad projects.write authority.'),
      409: errorResponse('A project with the normalized name already exists.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}',
    summary: 'Create or update a project',
    tags: ['projects'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ProjectUpsertRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('Project updated.', 'ProjectDto'),
      201: jsonResponse('Project created.', 'ProjectDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-discovery',
    summary: 'Discover measurement Targets from a sitemap',
    description: 'Fetches a public sitemap under bounded network policy and applies the supplied deterministic route rule to project-owned URLs. Every accepted URL is classified as proposed, alias, shared, unmatched, or excluded; no plan is published.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/MeasurementDiscoveryRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('Deterministic sitemap classification returned.', 'MeasurementDiscoveryResponse'),
      400: errorResponse('The sitemap URL or discovery rule is invalid.'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('The sitemap could not be fetched safely.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan',
    summary: 'Get the active measurement plan',
    description: 'Returns the active immutable measurement-plan revision, or an explicit null active state for a planless project.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Active measurement plan returned.', 'MeasurementPlanResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/measurement-plan',
    summary: 'Publish a measurement-plan revision (legacy schema v1)',
    description: 'Legacy schema-v1 publish. Compares the caller-observed active revision, then validates and canonicalizes the plan against current project domains, locations, and tracked queries. Identical active content is idempotent; restoring older content creates a new immutable revision. Refuses when the active revision is schema v2 rather than downgrade it; publish v2 plans through the draft flow (POST .../measurement-plan/draft/actions/publish).',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/MeasurementPlanPublishRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('The identical active revision was returned.', 'MeasurementPlanResponse'),
      201: jsonResponse('A new immutable revision was published.', 'MeasurementPlanResponse'),
      400: errorResponse('The measurement plan or publish request is invalid.'),
      409: errorResponse('The active measurement-plan revision changed after the caller loaded it.'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-plan/compile-preview',
    summary: 'Compile a measurement plan without publishing',
    description: 'Validates and compiles a candidate Target/group plan without writing state. Invalid authoring returns HTTP 200 with ok=false and typed checks; valid authoring returns frozen execution counts, expected snapshot slots, deduplication savings, and warnings.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/MeasurementPlanInput' },
        },
      },
    },
    responses: {
      200: jsonResponse('Compiled measurement-plan preview returned.', 'MeasurementPlanCompilePreviewResponse'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-plan/diff-preview',
    summary: 'Preview a measurement-plan change',
    description: 'Compiles a candidate plan and compares its Targets, groups, query selections, and execution graph with the active immutable revision without writing state. Invalid authoring returns HTTP 200 with ok=false, typed checks, and a null diff.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/MeasurementPlanInput' },
        },
      },
    },
    responses: {
      200: jsonResponse('Semantic measurement-plan diff returned.', 'MeasurementPlanDiffPreviewResponse'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/versions',
    summary: 'List measurement-plan revisions',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Measurement-plan revision metadata returned.', 'MeasurementPlanVersionsResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-plan/segments/{stableKey}/retire',
    summary: 'Permanently retire a measurement segment key',
    description: 'Retires an inactive stable Target or group key so it cannot be reused. Idempotent. First publish a revision without the segment; retirement does not unretire.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, { name: 'stableKey', in: 'path', required: true, description: 'Stable Target or group key to retire.', schema: stringSchema }],
    responses: {
      200: jsonResponse('Segment retirement state returned.', 'MeasurementSegmentRetirementResponse'),
      400: errorResponse('The segment remains in the active measurement-plan revision.'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project or measurement segment not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/versions/{revision}',
    summary: 'Get a measurement-plan revision',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementPlanRevisionParameter],
    responses: {
      200: jsonResponse('Immutable measurement-plan revision returned.', 'MeasurementPlanVersionResponse'),
      404: errorResponse('Project or revision not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-report',
    summary: 'Get a revision-pinned measurement report',
    description: 'Builds the Target, group, and evidence report from the immutable plan revision and either its latest eligible stored run or the exact eligible runId supplied by the caller. Missing run population remains explicit and never triggers live provider execution.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementReportRevisionParameter, measurementReportRunParameter],
    responses: {
      200: jsonResponse('Revision-pinned measurement report returned.', 'MeasurementReportResponse'),
      400: errorResponse('The revision query parameter is invalid.'),
      404: errorResponse('Project, measurement-plan revision, or requested run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-setup',
    summary: 'Get the measurement setup state',
    description: 'Returns exactly one state, evaluated in a fixed precedence: republish_required, setup_in_progress, awaiting_first_run, operational, simple. A draft over an active v1 plan is republish_required, because republishing is the blocking action.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Setup state and its next action returned.', 'MeasurementSetupResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-query-statuses',
    summary: 'Get server-derived measurement readiness for tracked queries',
    description: 'Returns one deterministic row per current tracked query. Membership, eligible official full-run selection, manifest validation, and completeness are resolved on the server against the active immutable plan; no provider work occurs.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Tracked-query measurement statuses returned.', 'MeasurementQueryStatusesResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/draft',
    summary: 'Get the server-side setup draft',
    description: 'Returns the single draft for the project, or an explicit null for a project with none. The response ETag is required on every subsequent mutation.',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Draft and its ETag returned.', 'MeasurementDraftResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/draft/targets',
    summary: 'Page the draft Targets',
    description: 'Cursor-paginated and deterministically ordered by normalized label then stable key. Serves a thousand Targets without client-side truncation.',
    tags: ['measurement-plans'],
    parameters: measurementDraftCollectionParameters,
    responses: {
      200: jsonResponse('Draft Target page returned.', 'MeasurementDraftTargetPage'),
      404: errorResponse('Project or draft not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/draft/assignments',
    summary: 'Page the draft assignments',
    description: 'Cursor-paginated Target-owned query assignments, each carrying its class and where that class came from.',
    tags: ['measurement-plans'],
    parameters: measurementDraftCollectionParameters,
    responses: {
      200: jsonResponse('Draft assignment page returned.', 'MeasurementDraftAssignmentPage'),
      404: errorResponse('Project or draft not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-plan/draft/groups',
    summary: 'Page the draft groups',
    description: 'Cursor-paginated reporting groups and their confirmed competitors. Groups never hold queries or execution context.',
    tags: ['measurement-plans'],
    parameters: measurementDraftCollectionParameters,
    responses: {
      200: jsonResponse('Draft group page returned.', 'MeasurementDraftGroupPage'),
      404: errorResponse('Project or draft not found.'),
    },
  },
  measurementDraftAction({
    action: 'create',
    summary: 'Start a setup draft',
    description: 'Creates the single draft for the project, recording the active revision it was created from. A draft never changes the active mode.',
    request: 'MeasurementDraftCreateRequest',
    requiresDraftEtag: false,
  }),
  measurementDraftAction({
    action: 'import-sitemap',
    summary: 'Import a sitemap into the draft',
    description: 'Fetches an operator-supplied sitemap under strict egress policy and records the deterministic discovery inputs on the draft. It proposes Targets for review; it never publishes a plan or starts a run.',
    request: 'MeasurementDraftImportSitemapRequest',
  }),
  measurementDraftAction({
    action: 'apply-sitemap-selection',
    summary: 'Apply the operator selection from discovery',
    description: 'Turns reviewed discovery proposals into new or rebound Targets. An optional complete Property selection also applies inclusion, assignment cleanup and group cleanup in the same ETag-guarded commit. Ambiguity is never resolved automatically.',
    request: 'MeasurementDraftApplySitemapSelectionRequest',
  }),
  measurementDraftAction({
    action: 'upsert-target',
    summary: 'Add or update a draft Target',
    request: 'MeasurementDraftUpsertTargetRequest',
  }),
  measurementDraftAction({
    action: 'rename-target',
    summary: 'Rename a draft Target',
    description: 'Changes the label only. The stable key, its assignments and its group membership are untouched.',
    request: 'MeasurementDraftRenameTargetRequest',
  }),
  measurementDraftAction({
    action: 'merge-targets',
    summary: 'Merge draft Targets into one',
    description: 'The survivor keeps its stable key, and the merged Targets contribute their assignments and group membership.',
    request: 'MeasurementDraftMergeTargetsRequest',
  }),
  measurementDraftAction({
    action: 'exclude-target',
    summary: 'Exclude a draft Target',
    description: 'Excluded Targets stay in the draft for review but never compile. The optional `assignments-and-group-memberships` cleanup removes that Target\'s query assignments and every group membership in the same ETag-guarded mutation; omitting it preserves the reversible legacy behavior.',
    request: 'MeasurementDraftExcludeTargetRequest',
  }),
  measurementDraftAction({
    action: 'rebind-target',
    summary: 'Rebind a draft Target to a new discovered URL',
    description: 'Preserves the stable key, the assignments and the group membership, so history follows the Target across a site restructure.',
    request: 'MeasurementDraftRebindTargetRequest',
  }),
  measurementDraftAction({
    action: 'apply-assignments',
    summary: 'Assign project queries to draft Targets',
    description: 'Accepts the compatible singular `targetKey` or a bulk audience of `targetKeys` and `groupKeys`. Groups resolve server-side to included Properties; the server validates the full cross product and writes one canonical draft mutation.',
    request: 'MeasurementDraftApplyAssignmentsRequest',
  }),
  measurementDraftAction({
    action: 'preview-assignments',
    summary: 'Preview audience assignment impact',
    description: 'Resolves the selected Properties and groups, then returns exact new assignment and provider-call impact without changing the draft or starting provider work.',
    request: 'MeasurementDraftPreviewAssignmentsRequest',
    response: 'MeasurementDraftPreviewAssignmentsResponse',
    responseDescription: 'Resolved audience and assignment execution impact returned.',
    readOnly: true,
    rateLimited: true,
  }),
  measurementDraftAction({
    action: 'replace-assignments',
    summary: 'Replace the audience for project queries',
    description: 'Atomically removes every prior Property assignment for the named questions and writes the exact resolved audience. Other questions are untouched.',
    request: 'MeasurementDraftReplaceAssignmentsRequest',
  }),
  measurementDraftAction({
    action: 'apply-paired-assignments',
    summary: 'Assign each query to the one Target it names',
    description: 'Takes explicit (targetKey, queryId) pairs, so N pairs create at most N assignments. Use it when each question names its own Property; `apply-assignments` is a cross product and would multiply the two lists together.',
    request: 'MeasurementDraftApplyPairedAssignmentsRequest',
  }),
  measurementDraftAction({
    action: 'remove-assignment',
    summary: 'Remove one query assignment from draft Targets',
    description: 'Accepts the compatible singular `targetKey` or a bulk `targetKeys` selection. It removes assignments only; the project query behind them is never deleted.',
    request: 'MeasurementDraftRemoveAssignmentRequest',
  }),
  measurementDraftAction({
    action: 'clear-assignments',
    summary: 'Clear every assignment on a draft Target',
    request: 'MeasurementDraftClearAssignmentsRequest',
  }),
  measurementDraftAction({
    action: 'classify-assignments',
    summary: 'Classify assignments as Branded or Non-brand',
    description: 'Always records the class as operator-sourced, so a later rule proposal cannot overwrite it. The class belongs to the assignment, so one query can be Branded for one Target and Non-brand for another.',
    request: 'MeasurementDraftClassifyAssignmentsRequest',
  }),
  measurementDraftAction({
    action: 'upsert-group',
    summary: 'Add or update a draft group',
    description: 'Reporting membership only. When `competitors` is present it replaces the complete competitor list atomically; omission preserves the existing list for backward compatibility. A payload carrying queries, providers, locations or models is rejected.',
    request: 'MeasurementDraftUpsertGroupRequest',
  }),
  measurementDraftAction({
    action: 'remove-group',
    summary: 'Remove a draft group',
    request: 'MeasurementDraftRemoveGroupRequest',
  }),
  measurementDraftAction({
    action: 'preview-group-membership',
    summary: 'Preview group membership CSV',
    description: 'Parses and resolves a bounded CSV against the current draft, returning deterministic row outcomes and checksums. It writes nothing.',
    request: 'MeasurementDraftPreviewGroupMembershipRequest',
    response: 'MeasurementDraftPreviewGroupMembershipResponse',
    responseDescription: 'CSV row outcomes and proposed group changes returned.',
    readOnly: true,
    payloadTooLarge: true,
    rateLimited: true,
  }),
  measurementDraftAction({
    action: 'apply-group-membership',
    summary: 'Apply reviewed group membership CSV rows',
    description: 'Reparses the CSV under the previewed draft ETag, verifies both checksums, and atomically applies only the explicitly accepted matched rows.',
    request: 'MeasurementDraftApplyGroupMembershipRequest',
    response: 'MeasurementDraftApplyGroupMembershipResponse',
    responseDescription: 'Reviewed group memberships applied.',
    payloadTooLarge: true,
  }),
  measurementDraftAction({
    action: 'upsert-competitor',
    summary: 'Add or update a group competitor',
    request: 'MeasurementDraftUpsertCompetitorRequest',
  }),
  measurementDraftAction({
    action: 'remove-competitor',
    summary: 'Remove a group competitor',
    request: 'MeasurementDraftRemoveCompetitorRequest',
  }),
  measurementDraftAction({
    action: 'compile-preview',
    summary: 'Compile the draft without publishing',
    description: 'Compiles the stored draft and returns the compiled checksum the publish guard expects. Writes nothing, so a view-only account can call it.',
    response: 'MeasurementDraftCompilePreviewResponse',
    responseDescription: 'Compiled draft preview returned. Invalid authoring returns ok=false with typed checks.',
    readOnly: true,
  }),
  measurementDraftAction({
    action: 'diff-preview',
    summary: 'Compare the draft with the active revision',
    description: 'Compiles the stored draft and reports the keys that changed against the active revision. Writes nothing.',
    response: 'MeasurementDraftDiffPreviewResponse',
    responseDescription: 'Draft diff returned. Invalid authoring returns ok=false with a null diff.',
    readOnly: true,
  }),
  measurementDraftAction({
    action: 'publish',
    summary: 'Publish the draft as a new revision',
    description: 'Recompiles server-side and refuses content that changed after review. Content identical to the active revision is a no-op returning it; content identical to an older revision publishes as a new revision, so a revert is a first-class operation. Publishing never starts a run.',
    request: 'MeasurementDraftPublishRequest',
    response: 'MeasurementPlanV2PublishResponse',
    responseDescription: 'The published revision, or the unchanged active revision when the content was identical to it.',
  }),
  measurementDraftAction({
    action: 'discard',
    summary: 'Discard the draft',
    response: 'MeasurementDraftDiscardResponse',
    responseDescription: 'Draft discarded.',
  }),
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-plan/actions/deactivate',
    summary: 'Deactivate the active measurement plan',
    description: 'Deletes the active-plan pointer and nothing else. Schedules, runs, queries, versions and evidence are untouched, and the revisions stay readable.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementIdempotencyKeyParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/MeasurementPlanDeactivateRequest' } },
      },
    },
    responses: {
      200: jsonResponse('The plan pointer was removed.', 'MeasurementPlanDeactivateResponse'),
      403: errorResponse('The caller may read the plan but not deactivate it.'),
      404: errorResponse('Project or active plan not found.'),
      409: errorResponse('The active revision changed after the caller loaded it.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-overview',
    summary: 'Get the scoped measurement overview',
    description: 'Aggregates one revision-pinned run snapshot for All Properties, a group, or a single Property. This is snapshot ranking only: it never infers a trend or compares evidence across revisions. Without runId the most recent completed run pinned to the active revision is used; once paging begins, the cursor pins that revision, displayed run, evidence snapshot, and result filters. A run pinned to another revision is refused rather than joined, and appended evidence on a mutable named run invalidates its cursor. Metrics are computed before search is applied, and a metric with no evidence is unavailable rather than zero. For coverage sorts, unavailable rows form the first bucket in either direction before available numeric rates follow the requested direction.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'scope', in: 'query', required: true, description: 'Reporting scope.', schema: { type: 'string', enum: ['all', 'group', 'property'] } },
      { name: 'groupKey', in: 'query', description: 'Group stable key, required when scope is "group".', schema: stringSchema },
      { name: 'targetKey', in: 'query', description: 'Target stable key, required when scope is "property".', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Restrict to one question class. Never pooled across classes.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'] } },
      { name: 'provider', in: 'query', description: 'Restrict to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict to one execution location label.', schema: stringSchema },
      { name: 'from', in: 'query', description: 'Inclusive start of the window (YYYY-MM-DD).', schema: stringSchema },
      { name: 'to', in: 'query', description: 'Inclusive end of the window (YYYY-MM-DD).', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Display this run. It must be pinned to the active revision. This is also the only way to display a scoped spot check.', schema: stringSchema },
      measurementSearchParameter,
      measurementOverviewSortParameter,
      measurementOverviewCursorParameter,
      measurementLimitParameter,
    ],
    responses: {
      200: jsonResponse('Scoped measurement overview returned.', 'MeasurementOverviewResponse'),
      400: errorResponse('The scope or its required key is invalid.'),
      404: errorResponse('Project not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-property-evidence',
    summary: 'Page one Property\'s evidence',
    description: 'Returns the evidence rows for exactly one Property out of one revision-pinned run, optionally narrowed to a question class, provider, or location. shape chooses what a row is: sources (the default) is one row per cited URL, answers is one row per measured answer with its cited URLs nested inside. Prefer answers to explain a gap — an answer that mentioned the Property without linking it, or that named nobody, has no URL to hang a source row on and is invisible in the default shape. Run selection matches the overview: the most recent completed run pinned to the active revision unless runId names another. Use this rather than GET /measurement-report when you want one Property — the report reconstructs every group and Target for a revision and does not paginate. Not available for a schema v1 revision, which records no question class to scope by. An empty page under measurement.state = not_measured means the Property has not been measured, which is not the same statement as a measured Property with no evidence.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'targetKey', in: 'query', required: true, description: 'Target stable key of the Property to read.', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Restrict to one question class. Never pooled across classes.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'] } },
      { name: 'provider', in: 'query', description: 'Restrict to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict to one execution location label.', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Display this run. It must be pinned to the active revision.', schema: stringSchema },
      measurementPropertyEvidenceShapeParameter,
      measurementPropertyEvidenceCursorParameter,
      measurementLimitParameter,
    ],
    responses: {
      200: jsonResponse('One Property\'s evidence page returned.', 'MeasurementPropertyEvidenceResponse'),
      400: errorResponse('The Property key, cursor, or revision schema version is invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-portfolio-summary',
    summary: 'Get the weakest measured Properties',
    description: 'Returns a compact, revision-pinned portfolio ranking from stored results, plus a worst-first roll-up of every named market. It defaults to Non-brand questions, ranks measured mention coverage before citation coverage, and keeps unavailable rows separate from measured weakness. Every market is scoped to the displayed run, so a market row matches that market read with groupKey; markets may share Properties and never sum to the portfolio totals. The markets array is empty when the request already narrowed to one group. Replacement names come only from stored answer extraction. It never starts provider work.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'groupKey', in: 'query', description: 'Optional reporting group stable key.', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Question class. Defaults to non-brand.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'], default: 'non-brand' } },
      { name: 'provider', in: 'query', description: 'Restrict to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict to one execution location label.', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Read this completed or partial active-revision run, including a named spot check.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Maximum Property rows. Defaults to 10, maximum 50.', schema: { type: 'integer', minimum: 1, maximum: 50 } },
    ],
    responses: {
      200: jsonResponse('Compact portfolio summary returned.', 'MeasurementPortfolioSummaryResponse'),
      400: errorResponse('The filters, group, or active plan schema are invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-property-questions',
    summary: 'List one Property’s measured questions',
    description: 'Returns compact provider-expanded question rows from one immutable plan and stored run. Missing answers and incomplete citation capture remain null rather than false. Full answer text and sources are deliberately omitted; use the returned resultId with the question-result read. It never starts provider work.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'targetKey', in: 'query', required: true, description: 'Property stable key.', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Restrict to one question class.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'] } },
      { name: 'provider', in: 'query', description: 'Restrict to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict to one execution location label.', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Read this completed or partial active-revision run, including a named spot check.', schema: stringSchema },
      { name: 'offset', in: 'query', description: 'Zero-based row offset for paging through the full question population.', schema: { type: 'integer', minimum: 0 } },
      measurementLimitParameter,
    ],
    responses: {
      200: jsonResponse('Compact Property question rows returned.', 'MeasurementPropertyQuestionsResponse'),
      400: errorResponse('The Property, filters, run status, or active plan schema are invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-question-result',
    summary: 'Get one full stored question result',
    description: 'Expands one resultId returned by the Property-question read into the full stored answer and source attribution for that Property. Raw provider payloads are never returned. It never starts provider work.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'targetKey', in: 'query', required: true, description: 'Property stable key used for mention and citation attribution.', schema: stringSchema },
      { name: 'resultId', in: 'query', required: true, description: 'Stored result ID returned by measurement-property-questions.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Full stored question result returned.', 'MeasurementQuestionResultResponse'),
      400: errorResponse('The Property, result, run status, or active plan schema are invalid.'),
      404: errorResponse('Project, active plan, Property assignment, or result not found.'),
      422: errorResponse('The result belongs to a run pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-property-competitors',
    summary: 'Get repeated replacements for one Property',
    description: 'Counts stored recommended names only for answered slots where the Property was neither mentioned nor assigned a complete citation. It never reparses an answer or starts provider work.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'targetKey', in: 'query', required: true, description: 'Property stable key.', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Restrict to one question class.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'] } },
      { name: 'provider', in: 'query', description: 'Restrict to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict to one execution location label.', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Read this completed or partial active-revision run, including a named spot check.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Maximum competitor rows. Defaults to 10, maximum 50.', schema: { type: 'integer', minimum: 1, maximum: 50 } },
    ],
    responses: {
      200: jsonResponse('Repeated Property replacements returned.', 'MeasurementPropertyCompetitorsResponse'),
      400: errorResponse('The Property, filters, run status, or active plan schema are invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-changes',
    summary: 'Compare the latest two comparable measurements',
    description: 'Compares stored runs only when plan revision, execution identity, and full-or-spot-check scope agree. Deltas are current minus previous; it never crosses a revision or silently joins an engine/model change.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'scope', in: 'query', description: 'Reporting scope. Defaults to all.', schema: { type: 'string', enum: ['all', 'group', 'property'], default: 'all' } },
      { name: 'groupKey', in: 'query', description: 'Required for group scope.', schema: stringSchema },
      { name: 'targetKey', in: 'query', description: 'Required for Property scope.', schema: stringSchema },
      { name: 'queryClass', in: 'query', description: 'Question class. Defaults to all.', schema: { type: 'string', enum: ['all', 'branded', 'non-brand'], default: 'all' } },
      { name: 'provider', in: 'query', description: 'Restrict both runs to one answer provider.', schema: stringSchema },
      { name: 'location', in: 'query', description: 'Restrict both runs to one execution location label.', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Use this completed or partial run as the current side.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Maximum changed Property rows. Defaults to 10, maximum 50.', schema: { type: 'integer', minimum: 1, maximum: 50 } },
    ],
    responses: {
      200: jsonResponse('Comparable change summary, or an explicit unavailable reason, returned.', 'MeasurementChangesResponse'),
      400: errorResponse('The scope, filters, run status, or active plan schema are invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-data-quality',
    summary: 'Inspect measurement completeness and comparability',
    description: 'Returns exact expected, executed, answer, citation-capture, and retrieval counts plus full-versus-spot-check scope and same-series predecessor availability. It invents no statistical sample threshold and never starts provider work.',
    tags: ['measurement-plans'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Inspect this completed or partial active-revision run. Omit for the latest completed full run.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Measurement data quality returned.', 'MeasurementDataQualityResponse'),
      400: errorResponse('The run status or active plan schema is invalid.'),
      404: errorResponse('Project, active measurement plan, or requested run not found.'),
      422: errorResponse('The named run is pinned to a different plan revision.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-query-sets',
    summary: 'List measurement query sets',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Query sets returned.', 'MeasurementQuerySetListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-query-sets/{setId}',
    summary: 'Get a measurement query set',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQuerySetIdParameter],
    responses: {
      200: jsonResponse('Query set and its ordered members returned.', 'MeasurementQuerySetDetail'),
      404: errorResponse('Project or query set not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/measurement-query-sets/{setId}',
    summary: 'Create or replace a measurement query set',
    description: 'A set holds ordered references to project query IDs. Membership changes never create or delete a query.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQuerySetIdParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/MeasurementQuerySetUpsertRequest' } },
      },
    },
    responses: {
      200: jsonResponse('Query set replaced.', 'MeasurementQuerySetDetail'),
      201: jsonResponse('Query set created.', 'MeasurementQuerySetDetail'),
      400: errorResponse('The query set payload is invalid.'),
      403: errorResponse('The caller may read query assets but not manage them.'),
      404: errorResponse('Project or referenced query not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/measurement-query-sets/{setId}',
    summary: 'Delete a measurement query set',
    description: 'Deletes the set and its membership rows. It never deletes a query or a published snapshot.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQuerySetIdParameter],
    responses: {
      204: { description: 'Query set deleted.' },
      403: errorResponse('The caller may read query assets but not manage them.'),
      404: errorResponse('Project or query set not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/measurement-query-templates',
    summary: 'List measurement query templates',
    tags: ['measurement-plans'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Query templates returned.', 'MeasurementQueryTemplateListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/measurement-query-templates/{templateId}',
    summary: 'Create or replace a measurement query template',
    description: 'Templates are authoring assets. A published plan contains only the immutable snapshots an expansion produced.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQueryTemplateIdParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/MeasurementQueryTemplateUpsertRequest' } },
      },
    },
    responses: {
      200: jsonResponse('Query template replaced.', 'MeasurementQueryTemplateDto'),
      201: jsonResponse('Query template created.', 'MeasurementQueryTemplateDto'),
      400: errorResponse('The template payload is invalid.'),
      403: errorResponse('The caller may read query assets but not manage them.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/measurement-query-templates/{templateId}',
    summary: 'Delete a measurement query template',
    description: 'Deletes the authoring template. Queries it already expanded, and every published snapshot of them, are untouched.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQueryTemplateIdParameter],
    responses: {
      204: { description: 'Query template deleted.' },
      403: errorResponse('The caller may read query assets but not manage them.'),
      404: errorResponse('Project or query template not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/measurement-query-templates/{templateId}/apply',
    summary: 'Expand a query template into project queries',
    description: 'Expands one binding per concrete query. Expansion is additive: a query that already exists is reported rather than duplicated.',
    tags: ['measurement-plans'],
    parameters: [nameParameter, measurementQueryTemplateIdParameter, measurementIdempotencyKeyParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/MeasurementQueryTemplateApplyRequest' } },
      },
    },
    responses: {
      200: jsonResponse('Expansion result returned.', 'MeasurementQueryTemplateApplyResponse'),
      400: errorResponse('A binding does not satisfy the template variables.'),
      403: errorResponse('The caller may read query assets but not manage them.'),
      404: errorResponse('Project or query template not found.'),
      409: errorResponse('The idempotency key was already used with a different request body.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects',
    summary: 'List projects',
    tags: ['projects'],
    responses: {
      200: jsonArrayResponse('Projects returned.', 'ProjectDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}',
    summary: 'Get a project',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Project returned.', 'ProjectDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}',
    summary: 'Delete a project',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'Project deleted.' },
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/delete-preview',
    summary: 'Preview the cascade impact of deleting a project',
    description: 'Read-only impact summary backing `canonry project delete --dry-run`. Returns counts of rows that would cascade-delete (queries, competitors, runs, snapshots, insights) and rows that would be detached (audit_log — `project_id` set to NULL).',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      // TODO: Define `ProjectDeletePreviewDto` Zod schema in contracts and reference here.
      200: rawJsonResponse('Preview of cascade impact.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/research/runs',
    summary: 'Start an isolated research query batch',
    description: 'Runs one to fifty ad-hoc queries through one API provider and saves the answer evidence. Research never creates tracked queries, shared runs, snapshots, insights, or notifications.',
    tags: ['research'], parameters: [nameParameter],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ResearchRunCreate' } } } },
    responses: { 200: jsonResponse('Idempotent request returned its existing research run.', 'ResearchRunDetailDto'), 202: jsonResponse('Research batch queued.', 'ResearchRunDetailDto'), 400: errorResponse('Invalid provider, model, location, or request.'), 404: errorResponse('Project not found.'), 409: errorResponse('Idempotency key was reused with a different payload.'), 422: errorResponse('Research executor is unavailable on this deployment.') },
  },
  {
    method: 'get', path: '/api/v1/projects/{name}/research/runs', summary: 'List saved research query batches', tags: ['research'],
    parameters: [nameParameter, { name: 'limit', in: 'query', description: 'Max runs, default 20 and maximum 100.', schema: integerSchema }],
    responses: { 200: jsonResponse('Research runs returned newest first.', 'ResearchRunListDto'), 404: errorResponse('Project not found.') },
  },
  {
    method: 'get', path: '/api/v1/projects/{name}/research/runs/{runId}', summary: 'Get a research query batch and saved answers', tags: ['research'],
    parameters: [nameParameter, { name: 'runId', in: 'path', required: true, description: 'Research run ID.', schema: stringSchema }],
    responses: { 200: jsonResponse('Research run detail returned.', 'ResearchRunDetailDto'), 404: errorResponse('Project or research run not found.') },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/research/runs/{runId}/queries/{queryId}/promotion-preview',
    summary: 'Preview promotion of a saved research query',
    description: 'Projects a tracked-query promotion without writing a tracked query, measurement draft, audit record, receipt, or provider result. It remains POST because advanced target/group selections can be sizeable; read-only API keys cannot invoke POST routes.',
    tags: ['research'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'path', required: true, description: 'Research run ID.', schema: stringSchema },
      { name: 'queryId', in: 'path', required: true, description: 'Completed saved research query ID.', schema: stringSchema },
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ResearchPromotionPreviewRequest' } } },
    },
    responses: {
      200: jsonResponse('Deterministic simple, advanced, or refused promotion projection.', 'ResearchPromotionPreviewResponse'),
      400: errorResponse('Invalid promotion selection.'),
      404: errorResponse('Project, research run, or research query not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/research/runs/{runId}/queries/{queryId}/promotion',
    summary: 'Commit promotion of a saved research query',
    description: 'Atomically promotes one completed saved research query into the tracked basket. With an active v2 measurement plan it publishes exactly the previewed additive revision, unless the query and selected assignment are already active, in which case it returns an explicit no-op without minting a revision. The supplied preview checksum, source IDs, selection, absence of a draft, and active plan state are all rechecked inside one transaction. No research answer or evidence is copied into official measurements.',
    tags: ['research'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'path', required: true, description: 'Research run ID.', schema: stringSchema },
      { name: 'queryId', in: 'path', required: true, description: 'Completed saved research query ID.', schema: stringSchema },
      measurementIdempotencyKeyParameter,
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ResearchPromotionCommitRequest' } } },
    },
    responses: {
      200: jsonResponse('Promotion committed, or already tracked with no revision published.', 'ResearchPromotionCommitResult'),
      400: errorResponse('Invalid request, source, audience, or promotion state.'),
      403: errorResponse('The API key lacks measurement-plan.write.'),
      404: errorResponse('Project, research run, or research query not found.'),
      409: errorResponse('Promotion preview, active plan, draft, or idempotency key conflict.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/locations',
    summary: 'Add a project location',
    tags: ['projects'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: locationSchema,
        },
      },
    },
    responses: {
      201: jsonResponse('Location created.', 'LocationContext'),
      400: errorResponse('Invalid location.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/locations',
    summary: 'List project locations',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      // TODO: Define `ProjectLocationsResponse` Zod schema (`{ locations: LocationContext[]; defaultLocation: string | null }`) in contracts.
      200: rawJsonResponse('Locations returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/locations/{label}',
    summary: 'Remove a project location',
    tags: ['projects'],
    parameters: [nameParameter, locationLabelParameter],
    responses: {
      204: { description: 'Location removed.' },
      400: errorResponse('Invalid location.'),
      404: errorResponse('Project or location not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/locations/default',
    summary: 'Set the default project location',
    tags: ['projects'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['label'],
            properties: {
              label: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Default location updated.', 'ProjectDto'),
      400: errorResponse('Invalid location.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/export',
    summary: 'Export a project as config',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Project configuration returned.', 'ProjectConfig'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/results/export',
    summary: 'Download historical answer-engine results',
    tags: ['exports'],
    description:
      'Downloads one record per persisted answer-visibility query × provider observation. Citation and mention stay independent: `citationState` describes source-list attribution, while nullable `answerMentioned` describes answer-text presence. Excludes probe runs by default. JSON is a versioned portable artifact; CSV is its flat spreadsheet representation. Raw provider payloads, credentials, and local paths are never included.',
    parameters: [
      nameParameter,
      {
        name: 'format',
        in: 'query',
        description: 'Download format. Defaults to `json`.',
        schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
      },
      {
        name: 'since',
        in: 'query',
        description: 'Inclusive ISO 8601 lower bound on run creation time.',
        schema: stringSchema,
      },
      {
        name: 'until',
        in: 'query',
        description: 'Inclusive ISO 8601 upper bound on run creation time. A date-only value includes that whole UTC day.',
        schema: stringSchema,
      },
      {
        name: 'includeProbes',
        in: 'query',
        description: 'Include operator/agent probe runs. Defaults to `false`.',
        schema: booleanSchema,
      },
    ],
    responses: {
      200: {
        description: 'Results attachment returned.',
        content: {
          // The query-selected attachment can be JSON or CSV. OpenAPI cannot
          // express that the `format` parameter selects a media type, so keep
          // the generated SDK honest with a union rather than promising JSON
          // to a caller that requested CSV.
          'application/json': {
            schema: {
              oneOf: [
                { $ref: '#/components/schemas/ResultsExportDto' },
                { type: 'string' },
              ],
            },
          },
          'text/csv': { schema: { type: 'string' } },
        },
      },
      400: errorResponse('Invalid export filters.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/queries',
    summary: 'List queries',
    tags: ['queries'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Queries returned.', 'QueryDto'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/queries',
    summary: 'Replace queries',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['queries'],
            properties: {
              queries: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Queries replaced.', 'QueryDto'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/queries',
    summary: 'Delete specific queries',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['queries'],
            properties: {
              queries: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Remaining queries returned.', 'QueryDto'),
      400: errorResponse('Invalid query delete request.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/queries/{id}',
    summary: 'Delete one query by ID',
    tags: ['queries'],
    parameters: [nameParameter, queryIdParameter],
    responses: {
      204: { description: 'Query deleted.' },
      404: errorResponse('Project or query not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/queries',
    summary: 'Append queries',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['queries'],
            properties: {
              queries: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Queries appended.', 'QueryDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/queries/replace-preview',
    summary: 'Preview the impact of replacing tracked queries',
    description: 'Read-only impact summary backing `canonry query replace --dry-run`. Returns current vs proposed query sets, the added/removed/unchanged diff, and the count of snapshots that would detach (queryId → NULL; queryText preserved).',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['queries'],
            properties: {
              queries: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `QueriesReplacePreviewDto` Zod schema in contracts.
      200: rawJsonResponse('Replace preview returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/queries/generate',
    summary: 'Generate query suggestions',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['provider'],
            properties: {
              provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'local'] },
              count: integerSchema,
            },
          },
        },
      },
    },
    responses: {
      200: rawJsonResponse('Query suggestions returned.', { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'string' } } } }),
      501: errorResponse('Query generation is not available.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'List keywords (legacy alias for queries)',
    tags: ['queries'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Legacy keyword-shaped queries returned.', 'KeywordDto'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Replace keywords (legacy alias for queries)',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['keywords'],
            properties: {
              keywords: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Legacy keyword-shaped queries replaced.', 'KeywordDto'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Delete keywords (legacy alias for queries)',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['keywords'],
            properties: {
              keywords: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Remaining legacy keyword-shaped queries returned.', 'KeywordDto'),
      400: errorResponse('Invalid legacy keyword delete request.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Append keywords (legacy alias for queries)',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['keywords'],
            properties: {
              keywords: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Legacy keyword-shaped queries appended.', 'KeywordDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/keywords/generate',
    summary: 'Generate keyword suggestions (legacy alias for queries)',
    tags: ['queries'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['provider'],
            properties: {
              provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'local'] },
              count: integerSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `KeywordGenerateResponse` Zod schema (`{ suggestions: string[] }`) in contracts.
      200: rawJsonResponse('Legacy keyword suggestions returned.', looseObjectSchema),
      501: errorResponse('Legacy keyword generation is not available.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/competitors',
    summary: 'List competitors',
    tags: ['competitors'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Competitors returned.', 'CompetitorDto'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/competitors',
    summary: 'Replace competitors',
    tags: ['competitors'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['competitors'],
            properties: {
              competitors: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Competitors replaced.', 'CompetitorDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/competitors',
    summary: 'Append competitors',
    tags: ['competitors'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['competitors'],
            properties: {
              competitors: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Competitors appended.', 'CompetitorDto'),
      400: errorResponse('Invalid competitor append request.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/competitors',
    summary: 'Delete specific competitors',
    tags: ['competitors'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['competitors'],
            properties: {
              competitors: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonArrayResponse('Remaining competitors returned.', 'CompetitorDto'),
      400: errorResponse('Invalid competitor delete request.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/competitors/{id}',
    summary: 'Delete competitor',
    tags: ['competitors'],
    parameters: [nameParameter, competitorIdParameter],
    responses: {
      204: { description: 'Competitor deleted.' },
      404: errorResponse('Project or competitor not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/runs',
    summary: 'Trigger a project run',
    tags: ['runs'],
    parameters: [nameParameter],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              kind: stringSchema,
              trigger: stringSchema,
              providers: stringArraySchema,
              queries: stringArraySchema,
              measurementScope: {
                type: 'object',
                description: 'Spot-check a slice of the published measurement plan. Groups expand to their member targets.',
                properties: {
                  groups: stringArraySchema,
                  targets: stringArraySchema,
                },
              },
              location: stringSchema,
              allLocations: booleanSchema,
              noLocation: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      201: jsonResponse('Run queued.', 'RunDto'),
      400: errorResponse(
        'Invalid request: an untracked query, a measurement scope naming a group/target/question the published plan does not contain, '
        + 'a scope combined with a query list, a per-run location on a plan project, or a provider roster the plan was not published for.',
      ),
      422: errorResponse('Project has no tracked queries.'),
      409: errorResponse('Run already in progress.'),
      503: errorResponse('No runnable answer provider is configured.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs',
    summary: 'List project runs',
    tags: ['runs'],
    parameters: [nameParameter, limitQueryParameter, runsListKindQueryParameter],
    responses: {
      200: jsonArrayResponse('Runs returned.', 'RunDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs/latest',
    summary: 'Get the latest project run',
    tags: ['runs'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Latest run returned.', 'LatestProjectRunDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/runs',
    summary: 'List all runs',
    tags: ['runs'],
    parameters: [
      limitQueryParameter,
      runsListSinceQueryParameter,
      runsListIncludeProbeQueryParameter,
      runsListKindQueryParameter,
    ],
    responses: {
      200: jsonArrayResponse('Runs returned.', 'RunDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/runs',
    summary: 'Trigger runs for all projects',
    tags: ['runs'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              kind: stringSchema,
              providers: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `TriggerAllRunsResponse` Zod schema in contracts.
      207: rawJsonResponse(
        'One row per project: either a queued run or an error for that project alone. A project that cannot be measured '
        + '(for example one whose published measurement plan expects a different number of answers per question) never '
        + 'prevents or hides the others.',
        { type: 'array', items: looseObjectSchema },
      ),
      400: errorResponse('Invalid request: an unknown provider name, or an unsupported run kind.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/runs/{id}',
    summary: 'Get a run and its snapshots',
    tags: ['runs'],
    parameters: [runIdParameter],
    responses: {
      200: jsonResponse('Run returned.', 'RunDetailDto'),
      404: errorResponse('Run not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/runs/{id}/cancel',
    summary: 'Cancel a queued or running run',
    tags: ['runs'],
    parameters: [runIdParameter],
    responses: {
      200: jsonResponse('Run cancelled.', 'RunDto'),
      404: errorResponse('Run not found.'),
      409: errorResponse('Run is not cancellable.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/apply',
    summary: 'Apply a Canonry config document',
    tags: ['config'],
    requestBody: {
      required: true,
      description: 'Canonry project configuration as JSON.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ProjectConfig' },
        },
      },
    },
    responses: {
      // TODO: Add `ApplyResultDto` Zod schema in contracts (single-doc apply result).
      200: jsonResponse('Config applied.', 'ProjectDto'),
      400: errorResponse('Invalid config.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/history',
    summary: 'Get project audit history',
    tags: ['history'],
    parameters: [
      nameParameter,
      limitQueryParameter,
      offsetQueryParameter,
      { name: 'since', in: 'query', description: 'ISO 8601 lower bound.', schema: stringSchema },
      { name: 'action', in: 'query', description: 'Exact audit action filter.', schema: stringSchema },
      { name: 'actor', in: 'query', description: 'Exact actor filter.', schema: stringSchema },
      { name: 'entityType', in: 'query', description: 'Exact entity type filter.', schema: stringSchema },
    ],
    responses: {
      200: jsonArrayResponse('Audit history returned.', 'AuditLogEntry'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/history',
    summary: 'Get global audit history',
    tags: ['history'],
    parameters: [
      limitQueryParameter,
      offsetQueryParameter,
      { name: 'since', in: 'query', description: 'ISO 8601 lower bound.', schema: stringSchema },
      { name: 'action', in: 'query', description: 'Exact audit action filter.', schema: stringSchema },
      { name: 'actor', in: 'query', description: 'Exact actor filter.', schema: stringSchema },
      { name: 'entityType', in: 'query', description: 'Exact entity type filter.', schema: stringSchema },
    ],
    responses: {
      200: jsonArrayResponse('Audit history returned.', 'AuditLogEntry'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/snapshots',
    summary: 'List query snapshots',
    tags: ['history'],
    parameters: [
      nameParameter,
      limitQueryParameter,
      offsetQueryParameter,
      locationQueryParameter,
    ],
    responses: {
      200: jsonResponse('Snapshots returned.', 'SnapshotListResponse'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/timeline',
    summary: 'Get query timeline',
    tags: ['history'],
    parameters: [
      nameParameter,
      locationQueryParameter,
      { name: 'limit', in: 'query', description: 'Restrict each query timeline to snapshots from the most recent N project runs. Omit for full history.', schema: { ...integerSchema, minimum: 1, maximum: 100 } },
    ],
    responses: {
      // TODO: Add `ProjectTimelineDto` Zod schema in contracts.
      200: rawJsonResponse('Timeline returned.', looseObjectSchema),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/metrics',
    summary: 'Get citation trend analytics',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: jsonResponse('Citation metrics returned.', 'BrandMetricsDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/gaps',
    summary: 'Get brand gap analysis',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      // TODO: Add `GapAnalysisDto` Zod schema in contracts.
      200: rawJsonResponse('Gap analysis returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/sources',
    summary: 'Get source origin analytics',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter, limitQueryParameter],
    responses: {
      200: jsonResponse('Source breakdown returned.', 'SourceBreakdownDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/visibility-stats',
    summary: 'Get aggregated mention/citation stats per query',
    description:
      'Per-query mention (answer-text) and citation (source-list) counts with a sample size, pooled across many answer-visibility runs (probe-excluded). Tri-state aware: `checked` counts only snapshots where answerMentioned was recorded (null = not checked is excluded). Lets a consumer compute confidence-aware (e.g. Wilson) proportions without N+1 run fetches. With no since/until/lastRuns, EVERY completed/partial answer-visibility run is pooled — `window.runCount` reports how many; bound the window with lastRuns, since/until, or month=YYYY-MM for a recent sample. Set groupBy=provider for a per-provider breakdown whose counts sum to the pooled counts, or shareOfVoice=1 to add share of voice vs tracked competitors (non-brand queries by default; set queryClass=branded for brand recall).',
    tags: ['analytics'],
    parameters: [
      nameParameter,
      sinceQueryParameter,
      untilQueryParameter,
      lastRunsQueryParameter,
      groupByProviderQueryParameter,
      monthQueryParameter,
      shareOfVoiceQueryParameter,
      shareOfVoiceQueryClassParameter,
    ],
    responses: {
      200: jsonResponse('Aggregated visibility stats returned.', 'VisibilityStatsDto'),
      400: errorResponse('Invalid query parameters.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/visibility-compare',
    summary: 'Compare AEO visibility month over month',
    description:
      'Statistically honest month-over-month AEO comparison in one call. PRIMARY metric is share of voice (brand vs competitor mentions in the same answers), which is less exposed to broad model-wide naming propensity than an absolute rate but never bypasses model continuity. Rates are pooled per-snapshot over each month (invariant to sweep count), restricted to query/provider pairs present in BOTH months, and then restricted again to providers with exactly one known, identical configured model id in both months. `continuity` reports every provider and its model evidence; changed, mixed mid-month, or legacy-unknown models are excluded. When no provider remains, metrics return a continuity-blocked verdict rather than a directional call. `from` must be a month strictly before `to`. A silent upstream version bump under an unchanged configured id remains undetectable.',
    tags: ['analytics'],
    parameters: [nameParameter, compareFromQueryParameter, compareToQueryParameter],
    responses: {
      200: jsonResponse('Month-over-month visibility comparison returned.', 'VisibilityCompareDto'),
      400: errorResponse('Invalid or missing from/to months.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/snapshots/diff',
    summary: 'Compare two runs',
    tags: ['history'],
    parameters: [
      nameParameter,
      {
        name: 'run1',
        in: 'query',
        required: true,
        description: 'First run ID.',
        schema: stringSchema,
      },
      {
        name: 'run2',
        in: 'query',
        required: true,
        description: 'Second run ID.',
        schema: stringSchema,
      },
    ],
    responses: {
      200: jsonResponse('Diff returned.', 'SnapshotDiffResponse'),
      400: errorResponse('Missing run IDs.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/settings',
    summary: 'Get provider settings summary',
    tags: ['settings'],
    responses: {
      200: jsonResponse('Settings returned.', 'SettingsDto'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/settings/providers/{name}',
    summary: 'Update provider settings',
    tags: ['settings'],
    parameters: [providerNameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              apiKey: stringSchema,
              baseUrl: stringSchema,
              model: stringSchema,
              quota: objectSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `ProviderSettingsDto` Zod schema in contracts.
      200: rawJsonResponse('Provider updated.', looseObjectSchema),
      400: errorResponse('Invalid provider settings.'),
      501: errorResponse('Provider updates are not supported.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/settings/google',
    summary: 'Update Google OAuth settings',
    tags: ['settings'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['clientId', 'clientSecret'],
            properties: {
              clientId: stringSchema,
              clientSecret: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `GoogleSettingsDto` Zod schema in contracts.
      200: rawJsonResponse('Google settings updated.', looseObjectSchema),
      400: errorResponse('Invalid Google settings.'),
      501: errorResponse('Google settings updates are not supported.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/keys',
    summary: 'List API keys',
    description:
      'Returns every API key on the instance, newest first, as SAFE metadata only — id, name, key prefix, scopes, created / last-used / revoked timestamps. The stored hash and the plaintext token are NEVER returned here; the raw token is shown exactly once at creation. Ungated: any valid bearer can list.',
    tags: ['keys'],
    responses: {
      200: jsonResponse('Keys returned.', 'ApiKeyListDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/keys/self',
    summary: 'Introspect the current API key',
    description:
      'Returns SAFE metadata for the key that authenticated this request, including the derived `readOnly` flag. Lets a caller (or the MCP adapter at startup) discover whether its configured key is read-only without listing every key on the instance. Ungated read — a read-only key can call it.',
    tags: ['keys'],
    responses: {
      200: jsonResponse('Current key returned.', 'ApiKeyDto'),
      404: errorResponse('No key on the request (auth skipped).'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/keys',
    summary: 'Create an API key',
    description:
      'Mints a new `cnry_…` API key. Requires the `keys.write` scope (the default `*` key satisfies it). The response includes the plaintext `key` field exactly ONCE — it is stored only as a sha256 hash and cannot be recovered later, so persist it on receipt. Omit `scopes` to default to `["*"]`.',
    tags: ['keys'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreateApiKeyRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('Key created. Includes the one-time plaintext `key`.', 'CreatedApiKeyDto'),
      400: errorResponse('Invalid request body.'),
      403: errorResponse('Missing the keys.write scope.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/keys/{id}/revoke',
    summary: 'Revoke an API key',
    description:
      'Revokes the key by id. Requires the `keys.write` scope. Revocation is immediate — the auth layer rejects a revoked key on the next request. Idempotent: revoking an already-revoked key returns it unchanged. Refuses to revoke the key the caller is currently authenticating with (use a different key).',
    tags: ['keys'],
    parameters: [keyIdParameter],
    responses: {
      200: jsonResponse('Key revoked (or already revoked).', 'ApiKeyDto'),
      400: errorResponse('Cannot revoke the currently-authenticating key.'),
      403: errorResponse('Missing the keys.write scope.'),
      404: errorResponse('Key not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/auth/session',
    summary: 'Check whether this install requires a sign-in',
    description:
      'Answers two things at once: whether this install has any accounts (`authRequired`), and who is signed in right now (`user`). An install with no accounts always answers `{ authRequired: false, user: null }` and never asks anyone to sign in — that is the historical behavior and it is preserved exactly. Public: the sign-in screen has to be able to ask this before it holds any credential.',
    tags: ['auth'],
    auth: false,
    responses: {
      200: jsonResponse('Sign-in state returned.', 'AuthSessionDto'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/auth/login',
    summary: 'Sign in with an account name and password',
    description:
      'Signs in and sets an HttpOnly, SameSite=Lax session cookie. Every failure — unknown name, wrong password — returns the same message, so the form never reveals which names exist. Repeated failures for one name are paused for a few minutes.',
    tags: ['auth'],
    auth: false,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/LoginRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('Signed in. The session cookie is set on this response.', 'AuthSessionDto'),
      400: errorResponse('Name or password missing.'),
      401: errorResponse('Incorrect name or password.'),
      429: errorResponse('Too many failed attempts for this name.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/auth/logout',
    summary: 'Sign out',
    description:
      'Ends the session on the server and clears the cookie. Always succeeds, including when the session had already expired — the point is that the browser ends up holding nothing.',
    tags: ['auth'],
    auth: false,
    responses: {
      204: { description: 'Signed out.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/auth/sessions',
    summary: 'See where you are signed in',
    description:
      'Lists the caller\'s OWN live sessions — when each began and when it expires. Never returns the session token or its digest, so this list cannot itself become a way in. An administrator cannot enumerate somebody else\'s sessions from here.',
    tags: ['auth'],
    auth: false,
    responses: {
      200: rawJsonResponse('Your sessions.', looseObjectSchema),
      401: errorResponse('Not signed in.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/auth/sessions',
    summary: 'End every session on this account',
    description:
      'Ends all of the caller\'s sessions, including the one making the request — the answer to "my laptop was stolen". Without it, a leaked cookie could only be ended by deleting the whole account with a root key. Signing out just this browser is `POST /auth/logout`.',
    tags: ['auth'],
    auth: false,
    responses: {
      204: { description: 'Every session ended.' },
      401: errorResponse('Not signed in.'),
      403: errorResponse('The request did not come from the dashboard.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/users',
    summary: 'List accounts',
    description:
      'Returns every account, oldest first, as safe metadata only — name, role, created and last-signed-in timestamps. The stored password digest is never returned. Administrators only.',
    tags: ['users'],
    responses: {
      200: jsonResponse('Accounts returned.', 'UserListDto'),
      403: errorResponse('View-only accounts cannot list accounts.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/users',
    summary: 'Create an account',
    description:
      'Creates a named account. Creating the FIRST account is what turns sign-in on for the whole install: from that point on the dashboard asks for a name and password, and API keys keep working exactly as before. Requires the `users.write` scope (the default `*` key satisfies it) and, once accounts exist, an administrator.',
    tags: ['users'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreateUserRequest' },
        },
      },
    },
    responses: {
      201: jsonResponse('Account created.', 'UserDto'),
      400: errorResponse('Invalid name, password, or role.'),
      403: errorResponse('Not permitted to create accounts.'),
      409: errorResponse('That name is already taken.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/users/{name}',
    summary: 'Delete an account',
    description:
      'Deletes the account and ends its sessions immediately. Refuses to delete the last administrator, which would leave an install nobody can administer from the dashboard.',
    tags: ['users'],
    parameters: [userNameParameter],
    responses: {
      200: rawJsonResponse('Account deleted.', looseObjectSchema),
      400: errorResponse('This is the only administrator account.'),
      403: errorResponse('Not permitted to delete accounts.'),
      404: errorResponse('Account not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/snapshot',
    summary: 'Generate a one-shot AI perception snapshot',
    tags: ['snapshot'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['companyName', 'domain'],
            properties: {
              companyName: stringSchema,
              domain: stringSchema,
              queries: stringArraySchema,
              competitors: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Snapshot report returned.', 'SnapshotReportDto'),
      400: errorResponse('Invalid snapshot input.'),
      501: errorResponse('Snapshot reporting is not supported.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/settings/bing',
    summary: 'Update Bing settings',
    tags: ['settings'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['apiKey'],
            properties: {
              apiKey: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `BingSettingsDto` Zod schema in contracts.
      200: rawJsonResponse('Bing settings updated.', looseObjectSchema),
      400: errorResponse('Invalid Bing settings.'),
      501: errorResponse('Bing settings updates are not supported.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/settings/cdp',
    summary: 'Update CDP endpoint settings',
    tags: ['settings', 'cdp'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['host'],
            properties: {
              host: stringSchema,
              port: integerSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `CdpEndpointConfigDto` Zod schema in contracts.
      200: rawJsonResponse('CDP endpoint updated.', looseObjectSchema),
      400: errorResponse('Invalid CDP settings.'),
      501: errorResponse('CDP updates are not supported.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Create or update a schedule',
    tags: ['schedules'],
    parameters: [nameParameter, scheduleKindQueryParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              kind: { $ref: '#/components/schemas/SchedulableRunKind' },
              preset: stringSchema,
              cron: stringSchema,
              timezone: stringSchema,
              providers: stringArraySchema,
              enabled: booleanSchema,
              sourceId: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Schedule updated.', 'ScheduleDto'),
      201: jsonResponse('Schedule created.', 'ScheduleDto'),
      400: errorResponse('Invalid payload (e.g. sourceId missing for kind=traffic-sync, or providers set for kind=traffic-sync).'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Get a schedule',
    tags: ['schedules'],
    parameters: [nameParameter, scheduleKindQueryParameter],
    responses: {
      200: jsonResponse('Schedule returned.', 'ScheduleDto'),
      404: errorResponse('Schedule not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Delete a schedule',
    tags: ['schedules'],
    parameters: [nameParameter, scheduleKindQueryParameter],
    responses: {
      204: { description: 'Schedule deleted.' },
      404: errorResponse('Schedule not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/notifications/events',
    summary: 'List notification event types',
    tags: ['notifications'],
    responses: {
      200: rawJsonResponse('Events returned.', { type: 'array', items: stringSchema }),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/notifications',
    summary: 'Create a notification',
    tags: ['notifications'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['channel', 'url', 'events'],
            properties: {
              channel: stringSchema,
              url: stringSchema,
              events: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      201: jsonResponse('Notification created.', 'NotificationDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/notifications',
    summary: 'List notifications',
    tags: ['notifications'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Notifications returned.', 'NotificationDto'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/notifications/{id}',
    summary: 'Delete a notification',
    tags: ['notifications'],
    parameters: [nameParameter, notificationIdParameter],
    responses: {
      204: { description: 'Notification deleted.' },
      404: errorResponse('Notification not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/notifications/{id}/test',
    summary: 'Send a test notification',
    tags: ['notifications'],
    parameters: [nameParameter, notificationIdParameter],
    responses: {
      // TODO: Add `NotificationTestResult` Zod schema in contracts.
      200: rawJsonResponse('Test notification sent.', looseObjectSchema),
      400: errorResponse('Stored notification config is invalid.'),
      404: errorResponse('Notification not found.'),
      502: errorResponse('Notification delivery failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/telemetry',
    summary: 'Get telemetry status',
    tags: ['telemetry'],
    responses: {
      // TODO: Add `TelemetryStatusDto` Zod schema in contracts.
      200: rawJsonResponse('Telemetry status returned.', looseObjectSchema),
      501: errorResponse('Telemetry status is not available.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/telemetry',
    summary: 'Update telemetry status',
    tags: ['telemetry'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['enabled'],
            properties: {
              enabled: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `TelemetryStatusDto` Zod schema in contracts.
      200: rawJsonResponse('Telemetry updated.', looseObjectSchema),
      400: errorResponse('Invalid telemetry request.'),
      501: errorResponse('Telemetry configuration is not available.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/telemetry/onboarding',
    summary: 'Record a privacy-safe onboarding milestone',
    tags: ['telemetry'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/OnboardingTelemetryEvent' },
        },
      },
    },
    responses: {
      202: jsonResponse('Onboarding milestone accepted.', 'TelemetryEventAcceptedDto'),
      400: errorResponse('Invalid onboarding telemetry event.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/screenshots/{snapshotId}',
    summary: 'Fetch a stored browser screenshot',
    tags: ['cdp'],
    parameters: [snapshotIdParameter],
    responses: {
      // Returns image bytes, not JSON. Codegen consumers should treat this as a binary stream.
      200: { description: 'Screenshot returned.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
      404: errorResponse('Screenshot not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/cdp/status',
    summary: 'Get CDP connection status',
    tags: ['cdp'],
    responses: {
      200: jsonResponse('CDP status returned.', 'CdpStatusDto'),
      501: errorResponse('CDP is not configured.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/cdp/screenshot',
    summary: 'Run a one-off browser query and capture screenshots',
    tags: ['cdp'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['query'],
            properties: {
              query: stringSchema,
              targets: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `CdpScreenshotResultDto` Zod schema in contracts.
      200: rawJsonResponse('CDP screenshot results returned.', looseObjectSchema),
      400: errorResponse('Invalid CDP screenshot request.'),
      501: errorResponse('CDP screenshot support is not available.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs/{runId}/browser-diff',
    summary: 'Compare API and browser provider results for a run',
    tags: ['cdp', 'runs'],
    parameters: [nameParameter, projectRunIdParameter],
    responses: {
      // TODO: Add `BrowserDiffDto` Zod schema in contracts.
      200: rawJsonResponse('Browser diff returned.', looseObjectSchema),
      404: errorResponse('Project or run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/google/callback',
    summary: 'Handle the shared Google OAuth callback',
    tags: ['google'],
    auth: false,
    parameters: [
      { name: 'code', in: 'query', description: 'OAuth authorization code.', schema: stringSchema },
      { name: 'state', in: 'query', description: 'Signed OAuth state payload.', schema: stringSchema },
      { name: 'error', in: 'query', description: 'OAuth error code.', schema: stringSchema },
    ],
    responses: {
      200: rawJsonResponse('OAuth callback handled.', { type: 'object', properties: { status: { type: 'string' } } }),
      400: errorResponse('Invalid callback request.'),
      500: errorResponse('OAuth configuration is incomplete.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/callback',
    summary: 'Handle the legacy project-scoped Google OAuth callback',
    tags: ['google'],
    auth: false,
    parameters: [
      nameParameter,
      { name: 'code', in: 'query', description: 'OAuth authorization code.', schema: stringSchema },
      { name: 'state', in: 'query', description: 'Signed OAuth state payload.', schema: stringSchema },
      { name: 'error', in: 'query', description: 'OAuth error code.', schema: stringSchema },
    ],
    responses: {
      200: rawJsonResponse('OAuth callback handled.', { type: 'object', properties: { status: { type: 'string' } } }),
      400: errorResponse('Invalid callback request.'),
      500: errorResponse('OAuth configuration is incomplete.'),
    },
  },
  // Google Ads + Tag Manager are a separate, read-only product surface from
  // OpenAI Ads. Every live discovery/sync call requires an administrator user
  // or explicitly scoped API key with `google-marketing.read-live`; mutations
  // require `google-marketing.write` and never mutate a provider resource.
  {
    method: 'get',
    path: '/api/v1/google-marketing/callback',
    summary: 'Handle the shared Google Ads or GTM OAuth callback',
    tags: ['google-marketing'],
    auth: false,
    parameters: [
      { name: 'code', in: 'query', description: 'OAuth authorization code.', schema: stringSchema },
      { name: 'state', in: 'query', description: 'Short-lived signed OAuth state.', schema: stringSchema },
      { name: 'error', in: 'query', description: 'OAuth provider error code.', schema: stringSchema },
    ],
    responses: {
      200: { description: 'OAuth code exchanged; explicit same-browser confirmation requested.', content: { 'text/html': { schema: stringSchema } } },
      400: { description: 'Invalid, expired, or rejected callback.', content: { 'text/html': { schema: stringSchema } } },
      500: { description: 'OAuth host configuration is incomplete.', content: { 'text/html': { schema: stringSchema } } },
      502: { description: 'OAuth code exchange failed.', content: { 'text/html': { schema: stringSchema } } },
      503: { description: 'Too many pending OAuth confirmations.', content: { 'text/html': { schema: stringSchema } } },
    },
  },
  {
    method: 'post',
    path: '/api/v1/google-marketing/callback/confirm/{confirmationId}',
    summary: 'Explicitly confirm a Google Ads or GTM OAuth connection',
    tags: ['google-marketing'],
    description: 'Same-browser form endpoint. It requires the cookie-carried administrator who started OAuth and persists the exchanged credential only after this explicit confirmation.',
    parameters: [{
      name: 'confirmationId',
      in: 'path',
      required: true,
      description: 'Short-lived, single-use OAuth confirmation identifier.',
      schema: stringSchema,
    }],
    responses: {
      200: { description: 'OAuth connection confirmed.', content: { 'text/html': { schema: stringSchema } } },
      400: { description: 'Confirmation is invalid, expired, replaced, or already used.', content: { 'text/html': { schema: stringSchema } } },
      403: errorResponse('The original signed-in browser is required.'),
      500: { description: 'OAuth host configuration is incomplete.', content: { 'text/html': { schema: stringSchema } } },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google-ads/status',
    summary: 'Get stored Google Ads connection status',
    tags: ['google-ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Google Ads connection status returned.', 'GoogleAdsConnectionStatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google-ads/oauth/connect',
    summary: 'Start a Google Ads OAuth flow',
    tags: ['google-ads'],
    description: 'Requires a signed-in browser with `google-marketing.write`; completion requires an explicit same-browser confirmation. The Google Ads developer token is accepted only by the host credential store and is never returned.',
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/GoogleMarketingOAuthConnectRequest' } } },
    },
    responses: {
      200: jsonResponse('Safe OAuth browser hand-off returned.', 'GoogleMarketingOAuthConnectResponse'),
      400: errorResponse('Invalid OAuth request or missing developer token.'),
      403: errorResponse('OAuth must start from a signed-in browser.'),
      429: errorResponse('Too many pending OAuth starts.'),
      501: errorResponse('OAuth is not configured.'),
      502: errorResponse('OAuth authorization URL could not be built.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google-ads/customers',
    summary: 'Discover accessible Google Ads customers',
    tags: ['google-ads'],
    description: 'Live read-only discovery. Requires an administrator user or full-instance API key with `google-marketing.read-live`; project-scoped keys are refused because the response spans every customer visible to the connected Google principal.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Accessible Google Ads customers returned.', 'GoogleAdsAccessibleCustomersResponse'),
      400: errorResponse('Google Ads is not connected.'),
      403: errorResponse('Live-read authority is required.'),
      501: errorResponse('Live discovery is not configured.'),
      502: errorResponse('Google Ads discovery failed.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/google-ads/selection',
    summary: 'Select a Google Ads customer context',
    tags: ['google-ads'],
    description: 'Requires `google-marketing.write`. This changes Canonry selection metadata only; it never changes a Google Ads account.',
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/GoogleAdsCustomerSelectionRequest' } } },
    },
    responses: {
      200: jsonResponse('Google Ads selection updated.', 'GoogleAdsConnectionStatusDto'),
      400: errorResponse('Google Ads is not connected or the selection is invalid.'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google-ads/sync',
    summary: 'Queue a read-only Google Ads evidence sync',
    tags: ['google-ads'],
    description: 'Requires an administrator user or explicitly scoped API key with `google-marketing.read-live` and `google-marketing.write`. The host performs bounded read-only queries, including Google Ads SearchStream POSTs, and writes sanitized append-only snapshots.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Google Ads sync run queued.', 'RunDto'),
      400: errorResponse('Google Ads is not connected.'),
      403: errorResponse('Live-read and write authority are required.'),
      501: errorResponse('Google Ads sync is not configured.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google-ads/performance',
    summary: 'Read computed Google Ads performance from the stored snapshot',
    tags: ['google-ads'],
    parameters: [nameParameter, googleAdsMetricsWindowParameter],
    responses: {
      200: jsonResponse('Google Ads performance returned.', 'GoogleAdsPerformanceDto'),
      400: errorResponse('Invalid window.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google-ads/snapshots',
    summary: 'List sanitized Google Ads snapshots',
    tags: ['google-ads'],
    parameters: [nameParameter, limitQueryParameter, googleMarketingSnapshotCursorParameter],
    responses: {
      200: jsonResponse('Google Ads snapshot page returned.', 'GoogleAdsStoredSnapshotPage'),
      400: errorResponse('Invalid snapshot cursor or limit.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google-ads/snapshots/{snapshotId}',
    summary: 'Read one sanitized Google Ads snapshot',
    tags: ['google-ads'],
    parameters: [nameParameter, snapshotIdParameter],
    responses: {
      200: jsonResponse('Google Ads snapshot returned.', 'GoogleAdsStoredSnapshotReadEnvelope'),
      404: errorResponse('Project or snapshot not found.'),
      502: errorResponse('Stored snapshot is invalid.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/google-ads/connection',
    summary: 'Disconnect Google Ads from a project',
    tags: ['google-ads'],
    description: 'Requires `google-marketing.write`. Removes the private credential and selection metadata; retained sanitized evidence remains append-only.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Google Ads disconnect completed.', 'GoogleMarketingDisconnectResponse'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/status',
    summary: 'Get stored GTM connection status',
    tags: ['gtm'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GTM connection status returned.', 'GtmConnectionStatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/gtm/oauth/connect',
    summary: 'Start a GTM OAuth flow',
    tags: ['gtm'],
    description: 'Requires a signed-in browser with `google-marketing.write`; completion requires an explicit same-browser confirmation.',
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/GoogleMarketingOAuthConnectRequest' } } },
    },
    responses: {
      200: jsonResponse('Safe OAuth browser hand-off returned.', 'GoogleMarketingOAuthConnectResponse'),
      400: errorResponse('Invalid OAuth request.'),
      403: errorResponse('OAuth must start from a signed-in browser.'),
      429: errorResponse('Too many pending OAuth starts.'),
      501: errorResponse('OAuth is not configured.'),
      502: errorResponse('OAuth authorization URL could not be built.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/accounts',
    summary: 'Discover accessible GTM accounts',
    tags: ['gtm'],
    description: 'Live GET-only discovery. Requires an administrator user or full-instance API key with `google-marketing.read-live`; project-scoped keys are refused because the response spans every account visible to the connected Google principal.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GTM accounts returned.', 'GtmAccountsResponse'),
      400: errorResponse('GTM is not connected.'),
      403: errorResponse('Live-read authority is required.'),
      501: errorResponse('Live discovery is not configured.'),
      502: errorResponse('GTM discovery failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/accounts/{accountId}/containers',
    summary: 'Discover containers in a GTM account',
    tags: ['gtm'],
    description: 'Live GET-only discovery. Requires an administrator user or full-instance API key with `google-marketing.read-live`; project-scoped keys are refused because the response spans the connected Google principal\'s account tree.',
    parameters: [nameParameter, googleMarketingAccountIdParameter],
    responses: {
      200: jsonResponse('GTM containers returned.', 'GtmContainerListResponse'),
      400: errorResponse('GTM is not connected.'),
      403: errorResponse('Live-read authority is required.'),
      501: errorResponse('Live discovery is not configured.'),
      502: errorResponse('GTM discovery failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/accounts/{accountId}/containers/{containerId}/workspaces',
    summary: 'Discover workspaces in a GTM container',
    tags: ['gtm'],
    description: 'Live GET-only discovery. Requires an administrator user or full-instance API key with `google-marketing.read-live`; project-scoped keys are refused because the response spans the connected Google principal\'s account tree.',
    parameters: [nameParameter, googleMarketingAccountIdParameter, googleMarketingContainerIdParameter],
    responses: {
      200: jsonResponse('GTM workspaces returned.', 'GtmWorkspaceListResponse'),
      400: errorResponse('GTM is not connected.'),
      403: errorResponse('Live-read authority is required.'),
      501: errorResponse('Live discovery is not configured.'),
      502: errorResponse('GTM discovery failed.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/gtm/selection',
    summary: 'Select GTM account, container, and workspace',
    tags: ['gtm'],
    description: 'Requires `google-marketing.write`. This changes Canonry selection metadata only; no GTM workspace is edited or published.',
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/GtmResourceSelectionRequest' } } },
    },
    responses: {
      200: jsonResponse('GTM selection updated.', 'GtmConnectionStatusDto'),
      400: errorResponse('GTM is not connected or the selection is invalid.'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/gtm/sync',
    summary: 'Queue a read-only GTM evidence sync',
    tags: ['gtm'],
    description: 'Requires an administrator user or explicitly scoped API key with `google-marketing.read-live` and `google-marketing.write`. The host reads configuration only; there is no GTM edit, version, or publish operation.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GTM sync run queued.', 'RunDto'),
      400: errorResponse('GTM is not connected.'),
      403: errorResponse('Live-read and write authority are required.'),
      501: errorResponse('GTM sync is not configured.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/snapshots',
    summary: 'List sanitized GTM snapshots',
    tags: ['gtm'],
    parameters: [nameParameter, limitQueryParameter, googleMarketingSnapshotCursorParameter],
    responses: {
      200: jsonResponse('GTM snapshot page returned.', 'GtmStoredSnapshotPage'),
      400: errorResponse('Invalid snapshot cursor or limit.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gtm/snapshots/{snapshotId}',
    summary: 'Read one sanitized GTM snapshot',
    tags: ['gtm'],
    parameters: [nameParameter, snapshotIdParameter],
    responses: {
      200: jsonResponse('GTM snapshot returned.', 'GtmStoredSnapshotReadEnvelope'),
      404: errorResponse('Project or snapshot not found.'),
      502: errorResponse('Stored snapshot is invalid.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/gtm/connection',
    summary: 'Disconnect GTM from a project',
    tags: ['gtm'],
    description: 'Requires `google-marketing.write`. Removes the private credential and selection metadata; retained sanitized evidence remains append-only.',
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GTM disconnect completed.', 'GoogleMarketingDisconnectResponse'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/conversion-tracking/options',
    summary: 'Selectable Google Ads conversion actions and GTM tags from stored snapshots',
    tags: ['conversion-tracking'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Conversion tracking options returned.', 'ConversionTrackingOptionsDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts',
    summary: 'List project conversion tracking contracts',
    tags: ['conversion-tracking'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Conversion tracking contracts returned.', 'ConversionTrackingContract'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts',
    summary: 'Create a project conversion tracking contract',
    tags: ['conversion-tracking'],
    description: 'Requires `google-marketing.write`. Identity, project ownership, and timestamps are server-owned.',
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversionTrackingContractWriteRequest' } } },
    },
    responses: {
      200: jsonResponse('Conversion tracking contract created.', 'ConversionTrackingContract'),
      400: errorResponse('Invalid contract request.'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('A contract with that name already exists.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
    summary: 'Read a conversion tracking contract',
    tags: ['conversion-tracking'],
    parameters: [nameParameter, conversionTrackingContractIdParameter],
    responses: {
      200: jsonResponse('Conversion tracking contract returned.', 'ConversionTrackingContract'),
      404: errorResponse('Project or contract not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
    summary: 'Replace a conversion tracking contract',
    tags: ['conversion-tracking'],
    description: 'Requires `google-marketing.write`. Identity, project ownership, and creation time remain server-owned.',
    parameters: [nameParameter, conversionTrackingContractIdParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversionTrackingContractWriteRequest' } } },
    },
    responses: {
      200: jsonResponse('Conversion tracking contract updated.', 'ConversionTrackingContract'),
      400: errorResponse('Invalid contract request.'),
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project or contract not found.'),
      409: errorResponse('A contract with that name already exists.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts/{contractId}',
    summary: 'Delete a conversion tracking contract',
    tags: ['conversion-tracking'],
    description: 'Requires `google-marketing.write`.',
    parameters: [nameParameter, conversionTrackingContractIdParameter],
    responses: {
      204: { description: 'Conversion tracking contract deleted.' },
      403: errorResponse('Write authority is required.'),
      404: errorResponse('Project or contract not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/conversion-tracking/contracts/{contractId}/integrity',
    summary: 'Assess stored conversion tracking integrity',
    tags: ['conversion-tracking'],
    description: 'Evaluates the declared contract against sanitized stored Google Ads/GTM evidence. It does not initiate provider reads.',
    parameters: [nameParameter, conversionTrackingContractIdParameter],
    responses: {
      200: jsonResponse('Conversion tracking integrity returned.', 'ConversionTrackingIntegrityReadEnvelope'),
      404: errorResponse('Project or contract not found.'),
      501: errorResponse('Integrity assessment is not configured.'),
      502: errorResponse('Integrity assessment failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/connections',
    summary: 'List Google connections for a project',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Google connections returned.', 'GoogleConnectionDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/connect',
    summary: 'Start a Google OAuth connection flow',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['type'],
            properties: {
              type: googleConnectionTypeSchema,
              propertyId: stringSchema,
              publicUrl: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: rawJsonResponse('Google auth URL returned.', { type: 'object', properties: { url: { type: 'string' } } }),
      400: errorResponse('Invalid Google connection request.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/google/connections/{type}',
    summary: 'Delete a Google connection',
    tags: ['google'],
    parameters: [nameParameter, googleTypeParameter],
    responses: {
      204: { description: 'Google connection deleted.' },
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/properties',
    summary: 'List available Google Search Console properties',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Google properties returned.', 'GscSiteListResponseDto'),
      400: errorResponse('Google OAuth is not configured.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/google/connections/{type}/property',
    summary: 'Set the property for a Google connection',
    tags: ['google'],
    parameters: [nameParameter, googleTypeParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['propertyId'],
            properties: {
              propertyId: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Google property updated.', 'GoogleConnectionDto'),
      400: errorResponse('Invalid property request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/google/connections/{type}/sitemap',
    summary: 'Set the sitemap URL for a Google connection',
    tags: ['google'],
    parameters: [nameParameter, googleTypeParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['sitemapUrl'],
            properties: {
              sitemapUrl: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Google sitemap updated.', 'GoogleConnectionDto'),
      400: errorResponse('Invalid sitemap request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/sync',
    summary: 'Queue a GSC sync run',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              days: integerSchema,
              full: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('GSC sync run returned.', 'RunDto'),
      400: errorResponse('Invalid GSC sync request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/performance',
    summary: 'Get GSC search performance data',
    tags: ['google'],
    parameters: [
      nameParameter,
      { name: 'startDate', in: 'query', description: 'Filter by start date.', schema: stringSchema },
      { name: 'endDate', in: 'query', description: 'Filter by end date.', schema: stringSchema },
      {
        name: 'days',
        in: 'query',
        description:
          'Relative span in days, resolved server-side against the last published GSC date. '
          + 'Prefer this over client-computed start/end dates: those bypass the published-day '
          + 'anchoring and are pinned to the caller\'s clock rather than Google\'s Pacific calendar.',
        schema: stringSchema,
      },
      { name: 'query', in: 'query', description: 'Filter by search query.', schema: stringSchema },
      { name: 'page', in: 'query', description: 'Filter by page URL.', schema: stringSchema },
      {
        name: 'orderBy',
        in: 'query',
        description: 'Row ordering, always descending. Defaults to clicks. Use date for time-series reads.',
        schema: { type: 'string', enum: ['clicks', 'impressions', 'date'] },
      },
      limitQueryParameter,
      offsetQueryParameter,
      analyticsWindowParameter,
    ],
    responses: {
      // Envelope, not a bare array: `totalMatching` / `truncated` are how a
      // caller tells a page from a complete answer, and `latestAvailableDate`
      // is how it tells "no data" from "asked past the GSC reporting lag".
      200: jsonResponse('GSC performance page plus match count and data freshness.', 'GscPerformanceResponseDto'),
      400: errorResponse('Invalid orderBy value.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/performance/daily',
    summary: 'Get GSC performance aggregated by day with window totals',
    tags: ['google'],
    parameters: [
      nameParameter,
      { name: 'startDate', in: 'query', description: 'Filter by start date.', schema: stringSchema },
      { name: 'endDate', in: 'query', description: 'Filter by end date.', schema: stringSchema },
      analyticsWindowParameter,
    ],
    responses: {
      200: jsonResponse('Daily aggregate (date → clicks/impressions/ctr) plus window totals.', 'GscPerformanceDailyDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/top-pages',
    summary: 'Get top GSC pages ranked by clicks',
    description: 'One row per page, aggregated in SQL and ranked by summed clicks descending. The rows are a RANKING built from the dimensioned search-data table; `totals` is NOT their sum. Google withholds rare queries (summed clicks under-count) and fans one impression across every query/page/country/device combination (summed impressions over-count), so `totals` is read from the un-dimensioned property-level daily table and labelled `totalsSource: property-daily`. It is null when that table has no rows in the window.',
    tags: ['google'],
    parameters: [
      nameParameter,
      { name: 'startDate', in: 'query', description: 'Filter by start date.', schema: stringSchema },
      { name: 'endDate', in: 'query', description: 'Filter by end date.', schema: stringSchema },
      limitQueryParameter,
      analyticsWindowParameter,
    ],
    responses: {
      200: jsonResponse('Ranked pages plus the property-level window total.', 'GscTopPagesDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/inspect',
    summary: 'Inspect a URL through Google Search Console',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('GSC inspection result returned.', 'GscUrlInspectionDto'),
      400: errorResponse('Invalid inspection request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/inspections',
    summary: 'List GSC URL inspections',
    tags: ['google'],
    parameters: [nameParameter, { name: 'url', in: 'query', description: 'Filter by URL.', schema: stringSchema }, limitQueryParameter],
    responses: {
      200: jsonArrayResponse('GSC inspections returned.', 'GscUrlInspectionDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/deindexed',
    summary: 'List GSC deindexed pages',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Deindexed pages returned.', 'GscDeindexedRowDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/coverage',
    summary: 'Get GSC coverage summary',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GSC coverage returned.', 'GscCoverageSummaryDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/coverage/history',
    summary: 'Get GSC coverage history',
    tags: ['google'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: jsonArrayResponse('GSC coverage history returned.', 'GscCoverageSnapshotDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/sitemaps',
    summary: 'List GSC sitemaps',
    tags: ['google'],
    parameters: [
      nameParameter,
      {
        name: 'sitemapIndex',
        in: 'query',
        description: 'Optional owned sitemap-index URL. When present, returns that index\'s child entries.',
        schema: { type: 'string', format: 'uri', pattern: '^https?://' },
      },
    ],
    responses: {
      200: jsonResponse('GSC sitemaps returned.', 'GscSitemapListResponseDto'),
      400: errorResponse('Invalid sitemap request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/discover-sitemaps',
    summary: 'Discover sitemaps and queue sitemap inspection',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Discovered sitemaps and queued run returned.', 'GscDiscoverSitemapsResponseDto'),
      400: errorResponse('Invalid sitemap discovery request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/inspect-sitemap',
    summary: 'Queue a sitemap inspection run',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              sitemapUrl: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Sitemap inspection run returned.', 'RunDto'),
      400: errorResponse('Invalid sitemap inspection request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/indexing/request',
    summary: 'Request Google indexing notifications',
    tags: ['google'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              urls: stringArraySchema,
              allUnindexed: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Indexing request results returned.', 'IndexingRequestResponseDto'),
      400: errorResponse('Invalid indexing request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/gbp/locations/discover',
    summary: 'Discover Google Business Profile locations and persist selection state',
    tags: ['gbp'],
    parameters: [nameParameter],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              selectAllNew: booleanSchema,
              accountName: stringSchema,
              switchAccount: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('List of discovered locations and selection summary returned.', 'GbpLocationListResponse'),
      400: errorResponse('Invalid discover request, unknown account, account-switch not opted into, or scope/API problem.'),
      404: errorResponse('Project not found.'),
      429: errorResponse('GBP API quota exceeded (access form may not be approved).'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/accounts',
    summary: 'List Google Business Profile accounts the connected user can access',
    tags: ['gbp'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Accounts the OAuth user manages or owns.', 'GbpAccountListResponse'),
      400: errorResponse('No GBP connection or scope/API problem.'),
      404: errorResponse('Project not found.'),
      429: errorResponse('GBP API quota exceeded (access form may not be approved).'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/locations',
    summary: 'List Google Business Profile locations + selection state',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'selected', required: false, description: 'Filter to selected=true or selected=false', schema: { type: 'string', enum: ['true', 'false'] } },
    ],
    responses: {
      200: jsonResponse('List of locations returned.', 'GbpLocationListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/gbp/locations/{locationName}/selection',
    summary: 'Toggle a Google Business Profile location\'s sync selection',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'path', name: 'locationName', required: true, schema: stringSchema, description: 'URL-encoded "locations/{n}" resource name' },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['selected'],
            properties: { selected: booleanSchema },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Updated location returned.', 'GbpLocationDto'),
      400: errorResponse('Invalid selection request.'),
      404: errorResponse('Project or location not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/gbp/connection',
    summary: 'Disconnect Google Business Profile and remove discovered locations',
    tags: ['gbp'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'Disconnected.' },
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/gbp/sync',
    summary: 'Trigger a Google Business Profile performance sync (daily metrics + monthly keywords)',
    tags: ['gbp'],
    parameters: [nameParameter],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              locationNames: stringArraySchema,
              daysOfMetrics: integerSchema,
              monthsOfKeywords: integerSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Sync run queued.', 'GbpSyncResponse'),
      400: errorResponse('Invalid sync request or no GBP connection.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/metrics',
    summary: 'List stored Google Business Profile daily performance metrics',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
      { in: 'query', name: 'metric', required: false, description: 'Filter to one DailyMetric', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Daily metrics returned.', 'GbpDailyMetricListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/keywords',
    summary: 'List stored Google Business Profile monthly keyword impressions',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
      { in: 'query', name: 'month', required: false, description: 'Filter to one YYYY-MM month', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Keyword impressions returned.', 'GbpKeywordImpressionListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/place-actions',
    summary: 'List stored Google Business Profile place action links (booking CTAs)',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Place actions returned.', 'GbpPlaceActionListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/lodging',
    summary: 'List latest Google Business Profile lodging snapshots per location',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Lodging snapshots returned.', 'GbpLodgingListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/attributes',
    summary: 'List latest Google Business Profile owner-set attribute snapshots per location',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Attribute snapshots returned.', 'GbpAttributesListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/places',
    summary: 'List latest Google Places rendered-listing snapshots per location',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Filter to one location resource name', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Place Details snapshots returned.', 'GbpPlaceDetailsListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/gbp/summary',
    summary: 'Composite Google Business Profile local-AEO summary (all derived metrics)',
    tags: ['gbp'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'locationName', required: false, description: 'Scope to one location (omit = aggregate across selected)', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Summary returned.', 'GbpSummaryDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/connect',
    summary: 'Connect an OpenAI ad account (ChatGPT ads) with an Ads Manager SDK key',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['apiKey'],
            properties: {
              apiKey: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Connected; key validated against the upstream ad account.', 'AdsConnectionStatusDto'),
      400: errorResponse('Missing/invalid key or credential storage unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/ads/connection',
    summary: 'Disconnect the OpenAI ad account (removes the stored credential)',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Disconnected (idempotent).', 'AdsDisconnectResponse'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/status',
    summary: 'OpenAI ads connection status and last sync time',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Connection status.', 'AdsConnectionStatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/account',
    summary: 'Read the connected OpenAI ad account and live review state',
    description:
      'Calls the OpenAI Ads API right now with the stored connection. Because it spends on the operator\'s ad account rather than returning stored data, it requires a credential granted ads authority (the wildcard key, or one of ads.write / ads.approve / ads.activate) and is refused to a view-only account. A read-only or unrelated-scope key is refused.',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Live ad-account metadata and review state.', 'AdsAccountDto'),
      400: errorResponse('Ads connection or live reader unavailable.'),
      403: errorResponse('The credential was not granted OpenAI Ads paid reads.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('OpenAI Ads API read failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/geo/search',
    summary: 'Search OpenAI Ads targetable geographic locations',
    description:
      'Searches the provider geo catalog live. Because it spends on the operator\'s ad account rather than returning stored data, it requires a credential granted ads authority (the wildcard key, or one of ads.write / ads.approve / ads.activate) and is refused to a view-only account. A read-only or unrelated-scope key is refused.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'q', required: true, description: 'Location name or code.', schema: { type: 'string', minLength: 1, maxLength: 200 } },
      { in: 'query', name: 'limit', required: false, description: 'Maximum results.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    ],
    responses: {
      200: jsonResponse('Targetable geographic locations.', 'AdsGeoSearchResponse'),
      400: errorResponse('Invalid query or ads connection unavailable.'),
      403: errorResponse('The credential was not granted OpenAI Ads paid reads.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('OpenAI Ads API read failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/conversions/pixels',
    summary: 'List OpenAI Ads conversion pixels',
    description:
      'Lists conversion pixels live from the provider, auto-paginating up to 100 pages. Because it spends on the operator\'s ad account rather than returning stored data, it requires a credential granted ads authority (the wildcard key, or one of ads.write / ads.approve / ads.activate) and is refused to a view-only account. A read-only or unrelated-scope key is refused.',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Conversion pixels.', 'AdsConversionPixelListResponse'),
      400: errorResponse('Ads connection or live reader unavailable.'),
      403: errorResponse('The credential was not granted OpenAI Ads paid reads.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('OpenAI Ads API read failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/conversions/event-settings',
    summary: 'List OpenAI Ads conversion event settings',
    description:
      'Lists conversion event settings live from the provider, auto-paginating up to 100 pages. Because it spends on the operator\'s ad account rather than returning stored data, it requires a credential granted ads authority (the wildcard key, or one of ads.write / ads.approve / ads.activate) and is refused to a view-only account. A read-only or unrelated-scope key is refused.',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Conversion event settings.', 'AdsConversionEventSettingListResponse'),
      400: errorResponse('Ads connection or live reader unavailable.'),
      403: errorResponse('The credential was not granted OpenAI Ads paid reads.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('OpenAI Ads API read failed.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/operations',
    summary: 'List unresolved OpenAI Ads mutation receipts',
    description:
      'Lists bounded pending, unknown, or actively reconciling receipts for operator recovery in stable creation order. The state filter is a comma-separated set and defaults to every unresolved state. Pass nextCursor back unchanged to advance beyond permanently unresolved rows. A cursor is bound to its project and state filter. This read never retries the original mutation.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      {
        name: 'state',
        in: 'query',
        description: 'Comma-separated unresolved states.',
        schema: {
          type: 'string',
          default: [
            AdsOperationStates.pending,
            AdsOperationStates.unknown,
            AdsOperationStates.reconciling,
          ].join(','),
        },
      },
      {
        name: 'limit',
        in: 'query',
        description: 'Maximum receipts to return.',
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      {
        name: 'cursor',
        in: 'query',
        description: 'Opaque keyset cursor returned as nextCursor by the previous page.',
        schema: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    ],
    responses: {
      200: jsonResponse('Unresolved operation receipts.', 'AdsUnresolvedOperationListResponse'),
      400: errorResponse('Invalid unresolved-state filter.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/operations/{operationKey}',
    summary: 'Read a durable OpenAI Ads mutation receipt by operation key',
    tags: ['ads'],
    parameters: [
      nameParameter,
      { name: 'operationKey', in: 'path', required: true, description: 'Caller-supplied idempotency key.', schema: adsOperationKeySchema },
    ],
    responses: {
      200: jsonResponse('Operation receipt.', 'AdsOperationResponse'),
      404: errorResponse('Project or operation not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/operations/{operationKey}/reconcile',
    summary: 'Reconcile an unresolved OpenAI Ads mutation receipt',
    description:
      'Verifies a checkpointed provider entity against the receipt-bound ad account without retrying the mutation. A fresh pending receipt is rejected for the configured minimum idle window because the original mutation may still be in flight. Automatic inspections use bounded exponential backoff and every inspection path is quarantined after the configured attempt cap. An uncheckpointed create remains unresolved because mutable-field matching cannot prove provenance; if another lease already owns reconciliation, the canonical reconciling receipt is returned with resolved=false. Campaign-tree activation receipts are rejected here and must use resume-activation so their approval grant, exact executor, and ordered step ledger remain authoritative.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      {
        name: 'operationKey',
        in: 'path',
        required: true,
        description: 'Caller-supplied idempotency key.',
        schema: adsOperationKeySchema,
      },
    ],
    responses: {
      200: jsonResponse('Reconciliation result and updated receipt.', 'AdsOperationReconcileResponse'),
      400: errorResponse('Receipt is not reconcilable.'),
      409: errorResponse('The original mutation may still be in flight.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project or operation not found.'),
      502: errorResponse('OpenAI Ads state verification failed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/operations/{operationKey}/resume-activation',
    summary: 'Resume recovery for an approval-bound OpenAI Ads activation',
    description:
      'Bodyless recovery surface for an existing campaign_tree_activate receipt. Requires ads.activate on the exact executor key already bound to the approval grant. Canonry resumes from the durable ordered step ledger and current provider state; it cannot select a different grant, manifest, campaign, account, or operation, and it never blindly resends an ambiguous activation mutation.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      {
        name: 'operationKey',
        in: 'path',
        required: true,
        description: 'Operation key of the existing campaign-tree activation receipt.',
        schema: adsOperationKeySchema,
      },
    ],
    responses: {
      200: jsonResponse('Canonical activation grant, receipt, and ordered step ledger.', 'AdsActivateTreeResponse'),
      400: errorResponse('A request body was supplied or activation recovery is not configured.'),
      403: errorResponse('The key lacks ads.activate or is not the grant-bound executor.'),
      404: errorResponse('Project, activation operation, or bound grant not found.'),
      409: errorResponse('The grant expired, its account/manifest binding changed, or its receipt conflicts.'),
      500: errorResponse('The activation receipt and approval grant binding is invalid.'),
      502: errorResponse('Activation or rollback recovery failed closed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/activation-grants',
    summary: 'Approve one exact paused OpenAI Ads campaign tree for activation',
    description:
      'Human-only approval surface. The authenticated ads.approve key is recorded as approver and must differ from the named executor key. Canonry verifies account eligibility, exact parent-child membership, paused state, upstream timestamps, and ad review approval before issuing a short-lived single-use grant.',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['manifest', 'executorApiKeyId', 'expiresAt'],
            properties: {
              manifest: adsActivationManifestSchema,
              executorApiKeyId: adsEntityIdSchema,
              expiresAt: { type: 'string', format: 'date-time' },
              versionPolicy: {
                type: 'string',
                enum: ['exact', 'refresh_semantically_unchanged'],
                default: 'exact',
                description:
                  'Exact rejects any provider version drift. refresh_semantically_unchanged rebinds versions only when the live paused tree still matches its durable create receipts field-for-field.',
              },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Approval grant created.', 'AdsActivationGrantResponse'),
      400: errorResponse('Invalid, stale, ineligible, or non-paused campaign tree.'),
      403: errorResponse('The key lacks ads.approve.'),
      404: errorResponse('Project or executor API key not found.'),
      502: errorResponse('OpenAI Ads preflight read failed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/activation-grants/{grantId}/revoke',
    summary: 'Revoke or cancel an OpenAI Ads activation grant',
    description: 'Human-only kill switch. Before execution, the grant becomes revoked. After execution starts, or while an activation outcome is unknown, revocationRequestedAt is recorded atomically. Subsequent activation steps are blocked, and the recovery worker rolls back confirmed active entities. Unknown outcomes remain explicitly unknown unless revocation was requested, the provider settlement window elapsed, and the watchdog can enumerate the complete provider tree and verify every entity paused. A provider request already authorized or in flight may still settle before containment. Verified rollback leaves the single-use grant consumed and the operation failed.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      { name: 'grantId', in: 'path', required: true, description: 'Activation grant ID.', schema: adsEntityIdSchema },
    ],
    responses: {
      200: jsonResponse('Grant revoked, cancellation requested, or prior cancellation replayed.', 'AdsActivationGrantResponse'),
      400: errorResponse('A completed grant cannot accept a new cancellation request.'),
      403: errorResponse('The key lacks ads.approve.'),
      404: errorResponse('Project or activation grant not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/campaigns/{id}/activate-tree',
    summary: 'Execute a grant-bound OpenAI Ads campaign-tree activation',
    description:
      'Requires ads.activate and a nonexpired single-use grant bound to the exact executor key, project, advertiser account, manifest hash, campaign, entity IDs, and upstream timestamps. Canonry activates ads first, then ad groups, then the campaign; every step is durably checkpointed and verified. Failure rolls back the campaign before children and ambiguous outcomes fail closed as unknown.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Approved campaign ID.', schema: adsEntityIdSchema },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['operationKey', 'grantId', 'manifestHash'],
            properties: {
              operationKey: adsOperationKeySchema,
              grantId: adsEntityIdSchema,
              manifestHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Canonical activation grant, receipt, and ordered step ledger.', 'AdsActivateTreeResponse'),
      400: errorResponse('Malformed request or campaign path mismatch.'),
      403: errorResponse('The key lacks ads.activate or is not the grant-bound executor.'),
      404: errorResponse('Project, campaign, or activation grant not found.'),
      409: errorResponse('Grant expired, account/manifest/entity state changed, operation key conflicted, or the grant was already used.'),
      502: errorResponse('Activation or rollback outcome failed closed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/files',
    summary: 'Upload an OpenAI Ads image from a public HTTPS URL',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'imageUrl'],
        properties: { operationKey: adsOperationKeySchema, imageUrl: { type: 'string', format: 'uri' } },
      } } },
    },
    responses: {
      200: jsonResponse('Upload receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/campaigns',
    summary: 'Create a paused OpenAI Ads campaign',
    description: 'The server always creates the campaign paused. Click bidding requires at least one unique conversion event-setting ID. Omit both bidding fields for legacy impressions mode. Status is not accepted from the caller.',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'name', 'lifetimeSpendLimitMicros', 'locationIds'],
        properties: {
          operationKey: adsOperationKeySchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          description: stringSchema,
          startTime: integerSchema,
          endTime: integerSchema,
          lifetimeSpendLimitMicros: { type: 'integer', minimum: 1000000 },
          locationIds: { type: 'array', minItems: 1, maxItems: 100, items: stringSchema },
          biddingType: { type: 'string', enum: Object.values(AdsCampaignBiddingTypes) },
          conversionEventSettingIds: {
            type: 'array',
            uniqueItems: true,
            items: stringSchema,
            description: 'Required and non-empty when biddingType is clicks.',
          },
        },
      } } },
    },
    responses: {
      200: jsonResponse('Paused campaign creation receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ad-groups',
    summary: 'Create a paused OpenAI Ads ad group',
    description: 'The server always creates the ad group paused and verifies its billing event against the live parent campaign before mutation. Omit billingEventType for legacy impression billing.',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'campaignId', 'name', 'contextHints', 'maxBidMicros'],
        properties: {
          operationKey: adsOperationKeySchema,
          campaignId: stringSchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          description: stringSchema,
          contextHints: { type: 'array', minItems: 1, maxItems: 100, items: stringSchema },
          maxBidMicros: { type: 'integer', minimum: 1, maximum: 100000000 },
          billingEventType: { type: 'string', enum: Object.values(AdsAdGroupBillingEventTypes) },
        },
      } } },
    },
    responses: {
      200: jsonResponse('Paused ad-group creation receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ads',
    summary: 'Create a paused OpenAI Ads chat-card ad',
    description: 'The server always creates the ad paused and fixes creative.type to chat_card.',
    tags: ['ads'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'adGroupId', 'name', 'creative'],
        properties: {
          operationKey: adsOperationKeySchema,
          adGroupId: stringSchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          creative: adsCreativeRequestSchema,
        },
      } } },
    },
    responses: {
      200: jsonResponse('Paused ad creation receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/campaigns/{id}',
    summary: 'Update an OpenAI Ads campaign with optimistic concurrency',
    description: 'The campaign must already be paused. Pause and sync first, then pass the refreshed upstreamUpdatedAt. Activation remains human-only.',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Campaign ID.', schema: stringSchema }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'expectedUpdatedAt'],
        properties: {
          operationKey: adsOperationKeySchema,
          expectedUpdatedAt: integerSchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          description: { type: 'string', nullable: true },
          startTime: { type: 'integer', nullable: true },
          endTime: { type: 'integer', nullable: true },
          lifetimeSpendLimitMicros: { type: 'integer', minimum: 1000000 },
          locationIds: { type: 'array', minItems: 1, maxItems: 100, items: stringSchema },
        },
      } } },
    },
    responses: {
      200: jsonResponse('Campaign update receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request, active entity, or stale expectedUpdatedAt.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ad-groups/{id}',
    summary: 'Update an OpenAI Ads ad group with optimistic concurrency',
    description: 'The ad group must already be paused. Pause and sync first, then pass the refreshed upstreamUpdatedAt. Activation remains human-only.',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Ad group ID.', schema: stringSchema }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'expectedUpdatedAt'],
        properties: {
          operationKey: adsOperationKeySchema,
          expectedUpdatedAt: integerSchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          description: { type: 'string', nullable: true },
          contextHints: { type: 'array', minItems: 1, maxItems: 100, items: stringSchema },
          maxBidMicros: { type: 'integer', minimum: 1, maximum: 100000000 },
        },
      } } },
    },
    responses: {
      200: jsonResponse('Ad-group update receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request, active entity, or stale expectedUpdatedAt.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ads/{id}',
    summary: 'Update an OpenAI Ads chat-card ad with optimistic concurrency',
    description: 'The ad must already be paused. Pause and sync first, then pass the refreshed upstreamUpdatedAt. Activation remains human-only.',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Ad ID.', schema: stringSchema }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: {
        type: 'object',
        required: ['operationKey', 'expectedUpdatedAt'],
        properties: {
          operationKey: adsOperationKeySchema,
          expectedUpdatedAt: integerSchema,
          name: { type: 'string', minLength: 3, maxLength: 1000 },
          creative: adsCreativeRequestSchema,
        },
      } } },
    },
    responses: {
      200: jsonResponse('Ad update receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request, active entity, or stale expectedUpdatedAt.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/campaigns/{id}/pause',
    summary: 'Pause an OpenAI Ads campaign',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Campaign ID.', schema: stringSchema }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['operationKey'], properties: { operationKey: adsOperationKeySchema },
    } } } },
    responses: {
      200: jsonResponse('Campaign pause receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ad-groups/{id}/pause',
    summary: 'Pause an OpenAI Ads ad group',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Ad group ID.', schema: stringSchema }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['operationKey'], properties: { operationKey: adsOperationKeySchema },
    } } } },
    responses: {
      200: jsonResponse('Ad-group pause receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/ads/{id}/pause',
    summary: 'Pause an OpenAI Ads ad',
    tags: ['ads'],
    parameters: [nameParameter, { name: 'id', in: 'path', required: true, description: 'Ad ID.', schema: stringSchema }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['operationKey'], properties: { operationKey: adsOperationKeySchema },
    } } } },
    responses: {
      200: jsonResponse('Ad pause receipt.', 'AdsOperationResponse'),
      400: errorResponse('Invalid request or ads connection unavailable.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Operation key was already used for a different request.'),
      502: errorResponse('Upstream outcome failed or is unknown.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ads/sync',
    summary: 'Trigger an ads-sync run (entity snapshots + daily paid-performance rollups)',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Sync run queued.', 'AdsSyncResponse'),
      400: errorResponse('No ads connection for this project.'),
      403: errorResponse('The key lacks ads.write.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/campaigns',
    summary: 'Synced campaign snapshots with lifecycle timestamps, targeting, nested ad groups, and ads',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Campaign snapshots.', 'AdsCampaignListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/insights',
    summary: 'Daily paid-performance rollups (spend in integer micros; ctr/cpc derived server-side)',
    tags: ['ads'],
    parameters: [
      nameParameter,
      { in: 'query', name: 'level', required: false, description: 'campaign | ad_group', schema: stringSchema },
      { in: 'query', name: 'entityId', required: false, description: 'Scope to one upstream entity id', schema: stringSchema },
      { in: 'query', name: 'from', required: false, description: 'Inclusive start date (YYYY-MM-DD)', schema: stringSchema },
      { in: 'query', name: 'to', required: false, description: 'Inclusive end date (YYYY-MM-DD)', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Daily rollup rows.', 'AdsInsightsResponse'),
      400: errorResponse('Invalid level filter.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/summary',
    summary: 'Composite paid-performance summary (campaign-level totals; all derived metrics)',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Summary returned.', 'AdsSummaryDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/delivery-diagnostics',
    summary: 'Stored ads snapshot provenance, configuration facts, and historical campaign activity',
    description: 'Read-only local evidence. It does not call OpenAI and never determines provider eligibility or serving.',
    tags: ['ads'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Stored diagnostics returned.', 'AdsDeliveryDiagnosticsDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ads/live-delivery',
    summary: 'Live provider read of ads status and metrics, with the local snapshot delta',
    description: 'Calls the OpenAI Ads API right now with the stored connection and returns the provider\'s current status and metrics unaggregated, alongside the corresponding local snapshot values and an explicit per-entity delta. Dates on both sides are the ad account\'s local calendar dates. The first day of the window is measured from 00:00 in the account timezone on both sides, so it is a whole day either way and a difference on it is real; the current local day is in progress on both sides, so a difference there is snapshot staleness. Read-only: it never creates, updates, pauses, or activates anything, and it never waits for a sync run. The window counts calendar days in the account timezone, not fixed 24-hour periods, so a daylight-saving transition cannot move the first day. The walk is bounded by per-level caps and a budget of 40 reader calls (see bounds). Admission has two rules: a project may have only one live read running at a time (a second request is refused for as long as the first is actually walking, which can exceed any interval), and consecutive reads are spaced by at least one minute. The interval is counted as soon as the provider is called, so a read that fails upstream still holds it; only a read rejected before the provider was called leaves the next one free. A reader call is not one HTTP request: each list or insight read auto-paginates up to 100 pages, so the worst-case upstream cost of a single request is about 4000 HTTP requests, reported as bounds.maxUpstreamHttpRequests.',
    tags: ['ads'],
    parameters: [
      nameParameter,
      {
        name: 'campaignId',
        in: 'query',
        description: 'Scope the walk to a single campaign.',
        schema: stringSchema,
      },
      {
        name: 'lookbackDays',
        in: 'query',
        description: 'Metrics window in calendar days of the ad account timezone (1-30, default 7).',
        schema: integerSchema,
      },
    ],
    responses: {
      200: jsonResponse('Live provider state and snapshot delta returned.', 'AdsLiveDeliveryDto'),
      400: errorResponse('Invalid query, or no ads connection for this project.'),
      403: errorResponse('The credential was not granted OpenAI Ads paid reads.'),
      404: errorResponse('Project not found.'),
      429: errorResponse('Another live read for this project is still running, or the minimum interval since the last provider read has not elapsed. error.details.reason says which.'),
      502: errorResponse('The OpenAI Ads API read failed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/bing/connect',
    summary: 'Connect Bing Webmaster Tools',
    tags: ['bing'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['apiKey'],
            properties: {
              apiKey: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Bing connection returned.', 'BingConnectResponseDto'),
      400: errorResponse('Invalid Bing connection request.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/bing/disconnect',
    summary: 'Disconnect Bing Webmaster Tools',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'Bing connection deleted.' },
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/status',
    summary: 'Get Bing connection status',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Bing status returned.', 'BingStatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/sites',
    summary: 'List Bing sites for the current connection',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Bing sites returned.', 'BingSitesResponseDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/bing/set-site',
    summary: 'Set the active Bing site',
    tags: ['bing'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['siteUrl'],
            properties: {
              siteUrl: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Active Bing site updated.', 'BingSetSiteResponseDto'),
      400: errorResponse('Invalid Bing site request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/coverage',
    summary: 'Get Bing index coverage',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      // Was incorrectly mapped to `BingCoverageSnapshotDto` (the daily
      // history snapshot — 4 fields). The /coverage handler actually
      // returns the nested summary shape with indexed/notIndexed/unknown
      // arrays. `BingCoverageSummaryDto` is the right ref.
      200: jsonResponse('Bing coverage returned.', 'BingCoverageSummaryDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/coverage/history',
    summary: 'Get Bing coverage history snapshots',
    tags: ['bing'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: jsonArrayResponse('Bing coverage history returned.', 'BingCoverageSnapshotDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/inspections',
    summary: 'List Bing URL inspections',
    tags: ['bing'],
    parameters: [nameParameter, { name: 'url', in: 'query', description: 'Filter by URL.', schema: stringSchema }, limitQueryParameter],
    responses: {
      200: jsonArrayResponse('Bing inspections returned.', 'BingUrlInspectionDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/bing/inspect-url',
    summary: 'Inspect a URL through Bing Webmaster Tools',
    tags: ['bing'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Bing inspection result returned.', 'BingUrlInspectionDto'),
      400: errorResponse('Invalid inspection request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/bing/inspect-sitemap',
    summary: 'Inspect every URL in a sitemap through Bing Webmaster Tools',
    tags: ['bing'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              sitemapUrl: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Sitemap inspection run queued.', 'RunDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/bing/request-indexing',
    summary: 'Submit URLs to Bing for indexing',
    tags: ['bing'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              urls: stringArraySchema,
              allUnindexed: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Bing indexing request results returned.', 'BingIndexingRequestResponseDto'),
      400: errorResponse('Invalid indexing request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/performance',
    summary: 'Get Bing keyword performance',
    tags: ['bing'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: jsonArrayResponse('Bing performance returned.', 'BingKeywordStatsDto'),
      400: errorResponse('Bing is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/connect',
    summary: 'Connect WordPress REST access',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['url', 'username', 'appPassword'],
            properties: {
              url: stringSchema,
              stagingUrl: stringSchema,
              username: stringSchema,
              appPassword: stringSchema,
              defaultEnv: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('WordPress connection status returned.', 'WordpressStatusDto'),
      400: errorResponse('Invalid WordPress connection request.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/wordpress/disconnect',
    summary: 'Disconnect WordPress',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'WordPress connection deleted.' },
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/status',
    summary: 'Get WordPress connection status',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('WordPress status returned.', 'WordpressStatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/pages',
    summary: 'List WordPress pages',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: jsonArrayResponse('WordPress pages returned.', 'WordpressPageSummaryDto'),
      400: errorResponse('Invalid environment or missing connection.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/page',
    summary: 'Get a WordPress page by slug',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter, wordpressEnvQueryParameter],
    responses: {
      200: jsonResponse('WordPress page returned.', 'WordpressPageDetailDto'),
      400: errorResponse('Invalid slug or environment.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/pages',
    summary: 'Create a WordPress page',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['title', 'slug', 'content'],
            properties: {
              title: stringSchema,
              slug: stringSchema,
              content: stringSchema,
              status: stringSchema,
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('WordPress page created.', 'WordpressPageDetailDto'),
      400: errorResponse('Invalid page creation request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/wordpress/page',
    summary: 'Update a WordPress page by slug',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['currentSlug'],
            properties: {
              currentSlug: stringSchema,
              title: stringSchema,
              slug: stringSchema,
              content: stringSchema,
              status: stringSchema,
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('WordPress page updated.', 'WordpressPageDetailDto'),
      400: errorResponse('Invalid page update request.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/page/meta',
    summary: 'Update REST-exposed WordPress SEO meta',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['slug'],
            properties: {
              slug: stringSchema,
              title: stringSchema,
              description: stringSchema,
              noindex: booleanSchema,
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `WordpressSeoStateDto` to the schema table (already in contracts).
      200: rawJsonResponse('WordPress SEO meta updated.', looseObjectSchema),
      400: errorResponse('SEO meta is unsupported or the request is invalid.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/pages/meta/bulk',
    summary: 'Bulk update SEO meta for multiple pages',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['entries'],
            properties: {
              entries: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['slug'],
                  properties: {
                    slug: stringSchema,
                    title: stringSchema,
                    description: stringSchema,
                    noindex: booleanSchema,
                  },
                },
              },
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Bulk SEO meta update results returned.', 'WordpressBulkMetaResultDto'),
      400: errorResponse('Invalid entries or environment.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/schema',
    summary: 'Read rendered JSON-LD schema for a page',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter, wordpressEnvQueryParameter],
    responses: {
      200: jsonArrayResponse('WordPress schema blocks returned.', 'WordpressSchemaBlockDto'),
      400: errorResponse('Invalid slug or environment.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/schema/manual',
    summary: 'Generate a manual schema update payload',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['slug', 'json'],
            properties: {
              slug: stringSchema,
              type: stringSchema,
              json: stringSchema,
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Manual schema instructions returned.', 'WordpressManualAssistDto'),
      400: errorResponse('Invalid schema request.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/schema/deploy',
    summary: 'Deploy JSON-LD schema to WordPress pages',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['profile'],
            properties: {
              profile: {
                type: 'object',
                description: 'Business profile and per-slug schema mapping',
              },
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Schema deployment results returned.', 'WordpressSchemaDeployResultDto'),
      400: errorResponse('Invalid profile or environment.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/schema/status',
    summary: 'Get JSON-LD schema status for all pages',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: jsonResponse('Schema status per page returned.', 'WordpressSchemaStatusResultDto'),
      400: errorResponse('Invalid environment.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/llms-txt',
    summary: 'Read /llms.txt for a WordPress environment',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      // Returns raw text/plain content of llms.txt.
      200: { description: 'llms.txt returned.', content: { 'text/plain': { schema: { type: 'string' } } } },
      400: errorResponse('Invalid environment or missing connection.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/llms-txt/manual',
    summary: 'Generate a manual llms.txt update payload',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['content'],
            properties: {
              content: stringSchema,
              env: { type: 'string', enum: ['live', 'staging'] },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Manual llms.txt instructions returned.', 'WordpressManualAssistDto'),
      400: errorResponse('Invalid llms.txt request.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/audit',
    summary: 'Audit WordPress pages for SEO and content issues',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: jsonArrayResponse('WordPress audit returned.', 'WordpressAuditPageDto'),
      400: errorResponse('Invalid environment or missing connection.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/diff',
    summary: 'Compare live and staging versions of a WordPress page',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter],
    responses: {
      200: jsonResponse('WordPress diff returned.', 'WordpressDiffDto'),
      400: errorResponse('Invalid slug or missing staging configuration.'),
      404: errorResponse('Project, connection, or page not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/staging/status',
    summary: 'Get WordPress staging configuration status',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `WordpressSiteStatusDto` to the schema table (already in contracts).
      200: rawJsonResponse('WordPress staging status returned.', looseObjectSchema),
      400: errorResponse('WordPress is not configured for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/staging/push',
    summary: 'Generate a manual staging push handoff',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Manual staging push instructions returned.', 'WordpressManualAssistDto'),
      400: errorResponse('Missing staging configuration.'),
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/onboard',
    summary: 'Full WordPress onboarding workflow',
    tags: ['wordpress'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['url', 'username', 'appPassword'],
            properties: {
              url: stringSchema,
              stagingUrl: stringSchema,
              username: stringSchema,
              appPassword: stringSchema,
              defaultEnv: { type: 'string', enum: ['live', 'staging'] },
              profile: objectSchema,
              skipSchema: booleanSchema,
              skipSubmit: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Onboarding result with step-by-step status.', 'WordpressOnboardResultDto'),
      400: errorResponse('Invalid onboarding request.'),
      404: errorResponse('Project not found.'),
    },
  },
  // GA4 routes
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ga/connect',
    summary: 'Connect Google Analytics 4 (service account or existing OAuth connection)',
    tags: ['ga4'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['propertyId'],
            properties: {
              propertyId: stringSchema,
              // Optional: omit it to select a property on an existing OAuth
              // connection (canonry google connect --type ga4). Required only
              // for service-account auth.
              keyJson: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `GaConnectResponse` Zod schema in contracts.
      200: rawJsonResponse('GA4 connection established.', looseObjectSchema),
      400: errorResponse('Invalid GA4 connection request.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/ga/disconnect',
    summary: 'Disconnect Google Analytics 4',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'GA4 connection deleted.' },
      404: errorResponse('Project or connection not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/status',
    summary: 'Get GA4 connection status',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GA4 status returned.', 'GA4StatusDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/properties',
    summary: 'List GA4 properties the connected account can read',
    description:
      'Lists every GA4 property visible to the project\'s OAuth connection, so the numeric property id needed by ga/connect can be discovered without leaving canonry. Requires an OAuth GA4 connection; service-account connections already carry their property id.',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('GA4 properties returned.', 'GA4PropertiesDto'),
      400: errorResponse('No OAuth GA4 connection for this project.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/measurement-analysis',
    summary: 'Get GA4 measurement analysis',
    tags: ['ga4'],
    parameters: [
      nameParameter,
      {
        name: 'window',
        in: 'query',
        description: '30-day cohorts to return.',
        schema: { type: 'string', enum: ['30d', '60d', '90d'], default: '90d' },
      },
      {
        name: 'hostScope',
        in: 'query',
        description: 'Configured marketing hosts or every observed host.',
        schema: { type: 'string', enum: ['marketing', 'all'], default: 'marketing' },
      },
      {
        name: 'pathPrefix',
        in: 'query',
        description: 'Optional boundary-safe normalized landing-page prefix.',
        schema: stringSchema,
      },
      {
        name: 'limit',
        in: 'query',
        description: 'Maximum page and query detail rows. Native channels are never truncated.',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
      },
    ],
    responses: {
      200: jsonResponse(
        'GA4 measurement analysis returned.',
        'GA4MeasurementAnalysisDto',
      ),
      400: errorResponse('Invalid measurement analysis filters.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/ga/sync',
    summary: 'Sync GA4 traffic and AI referral data',
    description: 'Syncs a window of GA4 history. `days` is bounded to GA4\'s supported sync range (1-90); a request outside it is clamped rather than rejected. The response reports the window ACTUALLY written as `days`, the unbounded request as `requestedDays`, and sets `clamped` when the two differ.',
    tags: ['ga4'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              days: { ...integerSchema, description: 'Days of history to sync. Clamped to 1-90; check `clamped` in the response to detect truncation. Defaults to 30.' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('GA4 sync completed.', 'GA4SyncResponseDto'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/traffic',
    summary: 'Get GA4 landing page traffic, channel breakdown, and AI referral landing pages',
    tags: ['ga4'],
    parameters: [nameParameter, limitQueryParameter, analyticsWindowParameter, analyticsStartDateParameter, analyticsEndDateParameter],
    responses: {
      // TODO: Add `GaTrafficResponse` Zod schema in contracts.
      200: rawJsonResponse('GA4 traffic data returned.', looseObjectSchema),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/ai-referral-history',
    summary: 'Get raw AI referral detail rows per day, landing page, and attribution dimension',
    description: 'Detail rows, not totals. One row per landing page per attribution dimension, so a single day of one source is many rows and each is commonly worth one session. Use /ga/ai-referral-daily for per-date or per-source session counts.',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter, analyticsStartDateParameter, analyticsEndDateParameter],
    responses: {
      200: jsonArrayResponse('AI referral history returned.', 'GA4AiReferralHistoryEntry'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/ai-referral-daily',
    summary: 'Get AI referral sessions per day and per source',
    description: 'Sums landing pages within one attribution dimension and never across dimensions, so totalSessions equals the aiSessionsDeduped reported by /ga/traffic for the same window. Sessions only: GA counts users as a distinct count at the grain requested, so an AI-referral user total cannot be summed from these rows and no un-dimensioned AI-referral fetch exists to supply one.',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter, analyticsStartDateParameter, analyticsEndDateParameter],
    responses: {
      200: jsonResponse('AI referral daily series returned.', 'GA4AiReferralDailyDto'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/social-referral-history',
    summary: 'Get social media referral sessions per day grouped by source',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter, analyticsStartDateParameter, analyticsEndDateParameter],
    responses: {
      200: jsonArrayResponse('Social referral history returned.', 'GA4SocialReferralHistoryEntry'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/social-referral-trend',
    summary: 'Get social referral trend (7d/30d) with biggest mover',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `GaSocialReferralTrendResponse` Zod schema in contracts.
      200: rawJsonResponse('Social referral trend returned.', looseObjectSchema),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/attribution-trend',
    summary: 'Get per-channel attribution trends (7d/30d) for organic, AI, and social',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `GaAttributionTrendResponse` Zod schema in contracts.
      200: rawJsonResponse('Attribution trend returned.', looseObjectSchema),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/session-history',
    summary: 'Get total sessions per day for the project',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter, analyticsStartDateParameter, analyticsEndDateParameter],
    responses: {
      200: jsonArrayResponse('Session history returned.', 'GA4SessionHistoryEntry'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/coverage',
    summary: 'Get GA4 page coverage with traffic overlay',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `GaCoverageResponse` Zod schema in contracts.
      200: rawJsonResponse('GA4 coverage data returned.', looseObjectSchema),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },

  // Intelligence
  {
    method: 'get',
    path: '/api/v1/projects/{name}/insights',
    summary: 'List intelligence insights for a project',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'dismissed', in: 'query', description: 'Include dismissed insights (true/false).', schema: stringSchema },
      { name: 'runId', in: 'query', description: 'Filter by run ID.', schema: stringSchema },
      { name: 'type', in: 'query', description: 'Filter by insight type. Exact match, or a trailing `*` for a prefix (e.g. `gbp-*`).', schema: stringSchema },
      { name: 'severity', in: 'query', description: 'Minimum severity (low|medium|high|critical); e.g. `high` returns high + critical.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Cap the number of (newest-first) insights returned.', schema: stringSchema },
    ],
    responses: {
      // TODO: Add `InsightDto` Zod schema in contracts.
      200: rawJsonResponse('Insights returned.', { type: 'array', items: looseObjectSchema }),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/insights/{id}',
    summary: 'Get a single insight',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Insight ID.', schema: stringSchema },
    ],
    responses: {
      // TODO: Add `InsightDto` Zod schema in contracts.
      200: rawJsonResponse('Insight returned.', looseObjectSchema),
      404: errorResponse('Insight not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/insights/{id}/dismiss',
    summary: 'Dismiss an insight',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Insight ID.', schema: stringSchema },
    ],
    responses: {
      // TODO: Add `InsightDto` Zod schema in contracts.
      200: rawJsonResponse('Insight dismissed.', looseObjectSchema),
      404: errorResponse('Insight not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/organic-evidence',
    summary: 'Reconciled organic and AI evidence',
    tags: ['analytics'],
    description:
      'Returns a decision-ready evidence ladder across GSC visibility, native GA4 channels and lead events, server-observed AI crawling/user fetches/referrals, and the latest answer-visibility sweep. Sources retain native units and source-specific cohort dates; URL-agnostic page evidence is reported separately. Sync, coverage, attribution-scope, and causality caveats are machine-readable.',
    parameters: [nameParameter, organicEvidencePeriodQueryParameter],
    responses: {
      200: jsonResponse('Organic evidence returned.', 'OrganicEvidenceDto'),
      400: errorResponse('Invalid evidence period.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/report',
    summary: 'Aggregated canonical AEO report',
    tags: ['report'],
    description:
      'Bundles every section the canonry-report HTML output needs (executive summary, client summary, agency diagnostics, action plan, citation scorecard, competitor landscape — citation + mention landscapes, AI citation sources, GSC, GA4, social/AI referrals, indexing health, citations trend, insights, and recommended next steps) into a single canonical JSON payload. Backs `canonry report <project>` and MCP report reads.',
    parameters: [nameParameter, reportPeriodQueryParameter],
    responses: {
      200: jsonResponse('Report returned.', 'ProjectReportDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/report.html',
    summary: 'Standalone HTML AEO report',
    tags: ['report'],
    description:
      'Server-rendered self-contained HTML version of the project report. Same data as `/projects/{name}/report` (JSON), rendered through the canonry HTML report renderer in agency or client mode. Returns `text/html` with `Content-Disposition: attachment` so browsers download it as `canonry-report-<project>-<audience>-YYYY-MM-DD.html`. Open in a browser and Print → Save as PDF for a PDF copy.',
    parameters: [nameParameter, reportAudienceQueryParameter, reportPeriodQueryParameter],
    responses: {
      200: { description: 'HTML report returned.', content: { 'text/html': { schema: { type: 'string' } } } },
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/health/latest',
    summary: 'Get latest health snapshot',
    description:
      'Returns the latest health snapshot. Always 200 once the project exists: when no snapshot exists yet (newly-created project, or only failed runs), the response carries `status: "no-data"` with `reason: "no-runs-yet"` and zeroed metrics. Real snapshots carry `status: "ready"`.',
    tags: ['intelligence'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Health snapshot or no-data sentinel returned.', 'HealthSnapshotDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/health/history',
    summary: 'Get health trend over time',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max results.', schema: { ...integerSchema, minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: jsonArrayResponse('Health history returned.', 'HealthSnapshotDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/citations/visibility',
    summary: 'Citation visibility headline (citation + answer-mention, by engine + query)',
    description:
      'Single-call read for the AI citation surface. Returns two parallel headline metrics (`providersCiting` = engines that cite the project in their grounding/source list, `providersMentioning` = engines that name the project in answer prose), per-query cross-tab buckets (`queriesCitedAndMentioned` / `queriesCitedOnly` / `queriesMentionedOnly` / `queriesInvisible` — mutually exclusive over queries that have at least one snapshot), per-query engine coverage rows from the latest snapshot per (query × provider) with both `cited` and `mentioned` flags, and a competitor-gap list (queries where the project is not cited but a configured competitor is). Status `no-data` with `reason: "no-runs-yet"` or `"no-queries"` when the project lacks the inputs.',
    tags: ['intelligence'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Citation visibility report or no-data sentinel returned.', 'CitationVisibilityResponse'),
      404: errorResponse('Project not found.'),
    },
  },

  // Content opportunity engine
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/targets',
    summary: 'Ranked, action-typed content opportunities',
    description:
      'Returns the canonical opportunity list. Each row is `{query, action, ourBestPage?, winningCompetitor?, score, scoreBreakdown, drivers[], demandSource, actionConfidence, existingAction?, winnabilityClass, winnability?}`. `winnabilityClass` is the deterministic winnability gate (`ownable` worth a brief, `ceded` an aggregator/editorial head term to skip). Ownable rows sort first. Hides rows with in-progress actions by default; pass `?include-in-progress=true` to include them annotated.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max rows returned.', schema: stringSchema },
      { name: 'include-in-progress', in: 'query', description: 'Include rows with in-flight tracked actions.', schema: stringSchema },
      { name: 'winnability-class', in: 'query', description: 'Filter by winnability: "ownable" or "ceded".', schema: stringSchema },
      { name: 'ownable', in: 'query', description: 'Convenience alias for winnability-class=ownable when "true".', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Targets returned.', 'ContentTargetsResponseDto'),
      400: errorResponse('Invalid limit or winnability-class.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/dismissals',
    summary: 'List content-target dismissals for a project',
    description:
      'Returns every persisted "mark addressed" record for the project. Each row is `{targetRef, addressedUrl?, note?, dismissedAt}`. The report filters out any opportunity whose `targetRef` appears here; un-dismiss via `DELETE`.',
    tags: ['content'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Dismissals returned.', 'ContentTargetDismissalsResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/content/dismissals',
    summary: 'Mark a content opportunity as addressed',
    description:
      'Persists a dismissal for one content recommendation, identified by its stable `targetRef` (the value `ContentTargetRowDto.targetRef` exposes — hashed from project + query + action + targetPage by `computeTargetRef`). Idempotent upsert: re-dismissing the same ref overwrites `addressedUrl`/`note` and refreshes `dismissedAt`. The row drops off the report and the dedicated content endpoints on the next read.',
    tags: ['content'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['targetRef'],
            properties: {
              targetRef: stringSchema,
              addressedUrl: stringSchema,
              note: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Dismissal saved.', 'ContentTargetDismissalDto'),
      400: errorResponse('Invalid request body.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/content/dismissals/{targetRef}',
    summary: 'Un-dismiss a content opportunity',
    description:
      'Removes a persisted dismissal. The recommendation reappears on the report on the next read if the orchestrator still surfaces it. 404 if no dismissal exists for that `(project, targetRef)`.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'targetRef', in: 'path', required: true, description: 'Stable hash from ContentTargetRowDto.targetRef.', schema: stringSchema },
    ],
    responses: {
      204: { description: 'Dismissal removed.' },
      404: errorResponse('Project or dismissal not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/recommendations/{targetRef}/analysis',
    summary: 'Get cached LLM explanation for a content recommendation',
    description:
      'Returns the most recent cached LLM-generated rationale + recommended next steps for one content recommendation, or 404 if none exists. Triggered by the report SPA when rendering an already-analyzed card without re-paying the LLM cost. Use `POST /analyze` to generate one (idempotent — POST returns the cached row if present).',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'targetRef', in: 'path', required: true, description: 'Stable hash from ContentTargetRowDto.targetRef.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Cached explanation.', 'RecommendationExplanationDto'),
      404: errorResponse('No cached explanation for this targetRef yet.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/content/recommendations/{targetRef}/analyze',
    summary: 'Generate (or fetch cached) LLM explanation for a recommendation',
    description:
      'Returns an LLM-generated rationale + recommended next steps for one content recommendation. Cached per (project, targetRef, promptVersion) — repeat calls without `forceRefresh` return the cached row free. Uses the `analyze` capability tier on the project\'s configured agent provider (Claude → sonnet, OpenAI → mini, Gemini → flash, Zai → turbo). Pass `provider` to force a specific one; pass `model` to override the tier\'s default within that provider.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'targetRef', in: 'path', required: true, description: 'Stable hash from ContentTargetRowDto.targetRef.', schema: stringSchema },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              provider: stringSchema,
              model: stringSchema,
              forceRefresh: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Explanation generated or returned from cache.', 'RecommendationExplanationDto'),
      400: errorResponse('Invalid request body or unknown provider.'),
      404: errorResponse('Project not found or targetRef does not match any current recommendation.'),
      503: errorResponse('No AI provider configured for this project.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/recommendations/{targetRef}/brief',
    summary: 'Get cached structured content brief for a recommendation',
    description:
      'Returns the cached structured brief (`{targetQuery, winnabilityClass, angle, whyWinnable, schemaHookup, controllableSurfaceRationale}`) for one content recommendation at the current prompt version, or 404 if none exists. Cache-only read from the dedicated recommendation_briefs table — never collides with the prose explanation. Use `POST /brief` to synthesize one.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'targetRef', in: 'path', required: true, description: 'Stable hash from ContentTargetRowDto.targetRef.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Cached brief.', 'RecommendationBriefDto'),
      404: errorResponse('No cached brief for this targetRef yet.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/content/recommendations/{targetRef}/brief',
    summary: 'Synthesize (or fetch cached) a structured content brief',
    description:
      'Synthesizes a STRUCTURED content brief for one recommendation, reusing the `analyze` capability tier. GATED to `ownable` targets — a `ceded` head term (cited surface dominated by aggregators/editorial) is rejected with 400 before any LLM call. Cached per (project, targetRef, promptVersion) in a dedicated table; repeat calls without `forceRefresh` return the cached row free. Pass `provider`/`model` to override.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'targetRef', in: 'path', required: true, description: 'Stable hash from ContentTargetRowDto.targetRef.', schema: stringSchema },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              provider: stringSchema,
              model: stringSchema,
              forceRefresh: { type: 'boolean' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Brief synthesized or returned from cache.', 'RecommendationBriefDto'),
      400: errorResponse('Invalid request body, unknown provider, or target is ceded (not winnable).'),
      404: errorResponse('Project not found or targetRef does not match any current recommendation.'),
      503: errorResponse('No AI provider configured for this project.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/domain-classifications',
    summary: 'List per-domain cited-surface classifications',
    description:
      'Returns every cited-surface domain classification discovery has produced for the project (`{domain, competitorType, hits, updatedAt}`), ranked by recurrence. This is the read surface behind the winnabilityClass winnability gate; running discovery improves coverage.',
    tags: ['content'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Classifications returned.', 'DomainClassificationsResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/sources',
    summary: 'URL-level competitive grounding-source map per query',
    description:
      'Returns one row per blog-shaped query containing the grounding URLs the LLM cited. Distinguishes our domain (isOurDomain) from competitor URLs (isCompetitor). Pure DB read — canonry surfaces URLs but never fetches them.',
    tags: ['content'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Sources returned.', 'ContentSourcesResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/content/gaps',
    summary: 'Queries where competitors are cited but you are not',
    description:
      'Returns gap rows ranked by miss rate then by competitor count. Excludes queries with no competitor citations and queries where our cited rate is 100%.',
    tags: ['content'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Gaps returned.', 'ContentGapsResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/overview',
    summary: 'Get a composite overview of project health',
    description:
      'Bundles project info, latest run, top undismissed insights, health, independent mention and citation coverage, query-basket comparability, and separate mention/citation movement over the shared query cohort. Designed for the "how is project X doing?" question so agents can answer in one call.',
    tags: ['intelligence'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Overview returned.', 'ProjectOverviewDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/search',
    summary: 'Search query snapshots and insights for text',
    description:
      'Returns the most recent snapshots and insights whose answer text, cited domains, captured cited URLs, raw response, or insight title/query/recommendation/cause matches the query. Use to find anything mentioning a competitor, term, or URL without paginating snapshots.',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'q', in: 'query', required: true, description: 'Search term (>= 2 chars).', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max combined hits (1-50, default 25).', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Search hits returned.', 'ProjectSearchResponseDto'),
      400: errorResponse('Query string missing or too short.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/doctor',
    summary: 'Run global health checks',
    description:
      'Runs all global-scope checks (provider keys, etc.). Use ?check=<id> or ?check=<prefix>* (comma-separated) to filter. Returns a structured DoctorReport with per-check status, code, summary, remediation, and details.',
    tags: ['doctor'],
    parameters: [
      {
        name: 'check',
        in: 'query',
        description: 'Optional comma-separated list of check IDs or wildcard prefixes (e.g. "config.*").',
        schema: stringSchema,
      },
    ],
    responses: {
      200: jsonResponse('Doctor report returned.', 'DoctorReportDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/doctor',
    summary: 'Run project health checks',
    description:
      'Runs project-scoped checks (Google auth, GA auth, etc.). Use ?check=<id> or ?check=<prefix>* (comma-separated) to filter — e.g. ?check=google.* for just Google auth checks. Returns a structured DoctorReport.',
    tags: ['doctor'],
    parameters: [
      nameParameter,
      {
        name: 'check',
        in: 'query',
        description: 'Optional comma-separated list of check IDs or wildcard prefixes (e.g. "google.auth.*").',
        schema: stringSchema,
      },
    ],
    responses: {
      200: jsonResponse('Doctor report returned.', 'DoctorReportDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/status',
    summary: 'Get the Common Crawl DuckDB plugin install status',
    description:
      'Reports whether @duckdb/node-api is installed in the local plugin dir. Returns MISSING_DEPENDENCY (422) on deployments that cannot host the plugin (e.g. the cloud API).',
    tags: ['backlinks'],
    responses: {
      200: jsonResponse('Install status returned.', 'BacklinksInstallStatusDto'),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/backlinks/install',
    summary: 'Install the @duckdb/node-api plugin',
    description:
      'Idempotently installs DuckDB into the canonry plugin dir. Returns MISSING_DEPENDENCY (422) when the host cannot perform the install.',
    tags: ['backlinks'],
    responses: {
      200: jsonResponse('Installed (or already present).', 'BacklinksInstallResultDto'),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/backlinks/syncs',
    summary: 'Queue a workspace-wide Common Crawl release sync',
    description:
      'Creates a `cc_release_syncs` row and fires the sync callback. Idempotent: an existing in-flight row for the same release is returned. When `release` is omitted, the server auto-discovers the latest available Common Crawl release.',
    tags: ['backlinks'],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              release: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Existing in-flight sync returned.', 'CcReleaseSyncDto'),
      201: jsonResponse('Sync queued.', 'CcReleaseSyncDto'),
      400: errorResponse('Invalid release id.'),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/syncs',
    summary: 'List Common Crawl release syncs',
    description: 'Returns syncs ordered by updatedAt DESC — re-queued rows surface ahead of untouched newer rows.',
    tags: ['backlinks'],
    responses: {
      200: jsonArrayResponse('Sync history returned.', 'CcReleaseSyncDto'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/syncs/latest',
    summary: 'Get the most recently-updated Common Crawl release sync',
    tags: ['backlinks'],
    responses: {
      // Returns CcReleaseSyncDto | null
      200: rawJsonResponse('Latest sync returned, or null when no sync exists.', {
        oneOf: [{ $ref: '#/components/schemas/CcReleaseSyncDto' }, { type: 'null' }],
      }),
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/releases',
    summary: 'List cached Common Crawl releases on the local filesystem',
    tags: ['backlinks'],
    responses: {
      200: jsonArrayResponse('Cached release metadata returned.', 'CcCachedRelease'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/latest-release',
    summary: 'Auto-discover the latest available Common Crawl hyperlinkgraph release',
    description:
      'Probes Common Crawl by HEAD-checking quarterly release slugs and returns the newest one published. The local server caches the result for ~5 minutes so repeated calls do not hammer Common Crawl.',
    tags: ['backlinks'],
    responses: {
      200: rawJsonResponse('Latest available release, or null when no candidate slug responded.', {
        oneOf: [{ $ref: '#/components/schemas/CcAvailableRelease' }, { type: 'null' }],
      }),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/backlinks/cache/{release}',
    summary: 'Prune a cached Common Crawl release',
    tags: ['backlinks'],
    parameters: [
      {
        name: 'release',
        in: 'path',
        required: true,
        description: 'Release id (e.g. cc-main-2026-jan-feb-mar).',
        schema: stringSchema,
      },
    ],
    responses: {
      // TODO: Add `BacklinksCachePruneResultDto` Zod schema in contracts.
      200: rawJsonResponse('Cache pruned.', looseObjectSchema),
      400: errorResponse('Invalid release id.'),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/backlinks/extract',
    summary: 'Extract backlinks for a single project from a cached release',
    description:
      'Creates a `runs` row with kind="backlink-extract" and fires the extract callback. Defaults to the most recent ready release when `release` is omitted.',
    tags: ['backlinks'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              release: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      201: jsonResponse('Extract run queued.', 'RunDto'),
      400: errorResponse('Invalid release id.'),
      404: errorResponse('Project not found.'),
      422: errorResponse('Backlinks feature is not available on this deployment.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/backlinks/summary',
    summary: 'Get the latest backlink summary for a project',
    tags: ['backlinks'],
    parameters: [
      nameParameter,
      { name: 'release', in: 'query', description: 'Release id filter.', schema: stringSchema },
      { name: 'source', in: 'query', description: 'Stored source. Common Crawl is active; bing-webmaster is historical-only.', schema: stringSchema },
    ],
    responses: {
      200: rawJsonResponse('Summary returned, or null when no backlinks exist.', {
        oneOf: [{ $ref: '#/components/schemas/BacklinkSummaryDto' }, { type: 'null' }],
      }),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/backlinks/domains',
    summary: 'Paginate backlink domains for a project',
    tags: ['backlinks'],
    parameters: [
      nameParameter,
      { name: 'release', in: 'query', description: 'Release id filter.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max results (1-500).', schema: stringSchema },
      { name: 'offset', in: 'query', description: 'Pagination offset.', schema: stringSchema },
      { name: 'source', in: 'query', description: 'Stored source. Common Crawl is active; bing-webmaster is historical-only.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Domain list returned.', 'BacklinkListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/backlinks/history',
    summary: 'Get per-release backlink summaries for a project',
    tags: ['backlinks'],
    parameters: [
      nameParameter,
      { name: 'source', in: 'query', description: 'Stored source. Common Crawl is active; bing-webmaster is historical-only.', schema: stringSchema },
    ],
    responses: {
      200: jsonArrayResponse('History returned oldest-first by queriedAt.', 'BacklinkHistoryEntry'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/backlinks/sources',
    summary: 'Report per-source backlink availability for a project',
    description:
      'Returns Common Crawl readiness plus any inert historical source data retained from older Canonry versions.',
    tags: ['backlinks'],
    parameters: [
      nameParameter,
      { name: 'excludeCrawlers', in: 'query', description: 'When "1"/"true", count linking domains excluding crawler/proxy hosts (matches the dashboard). Default off.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Per-source availability returned.', 'BacklinkSourcesResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/connect/cloud-run',
    summary: 'Connect a Cloud Run traffic source',
    description:
      'Stores the service-account JSON in `~/.canonry/config.yaml` and creates a `traffic_sources` row for the project. Reconnecting updates the existing active source rather than creating a duplicate.',
    tags: ['traffic'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['gcpProjectId', 'keyJson'],
            properties: {
              gcpProjectId: stringSchema,
              serviceName: stringSchema,
              location: stringSchema,
              displayName: stringSchema,
              keyJson: { ...stringSchema, description: 'Service-account JSON content.' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Traffic source DTO returned.', 'TrafficSourceDto'),
      400: errorResponse('Invalid Cloud Run connection request.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/connect/wordpress',
    summary: 'Connect a WordPress traffic-logger source',
    description:
      'Probes the WordPress traffic-logger plugin endpoint with the supplied Application Password (single page, `limit=1`) before persisting. On success, stores the credential in `~/.canonry/config.yaml` and creates / updates the project\'s active WordPress `traffic_sources` row. Changing `baseUrl` archives the old source lineage and creates a fresh source so historical rollups cannot mix across endpoints. A probe failure (HTTP 4xx/5xx, network error) surfaces as 502 with the upstream status in the message so the caller learns about a bad credential up front instead of at the first sync.',
    tags: ['traffic'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['baseUrl', 'username', 'applicationPassword'],
            properties: {
              baseUrl: { ...stringSchema, description: 'Absolute base URL of the WordPress site (e.g. `https://example.com`).' },
              username: { ...stringSchema, description: 'WordPress username paired with the Application Password.' },
              applicationPassword: { ...stringSchema, description: 'WordPress Application Password (raw; the server base64-encodes it for Basic auth).' },
              displayName: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Traffic source DTO returned.', 'TrafficSourceDto'),
      400: errorResponse('Invalid WordPress connection request.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('WordPress plugin endpoint probe failed (bad credentials, unreachable host, etc.).'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/connect/vercel',
    summary: 'Connect a Vercel traffic source',
    description:
      'Probes Vercel\'s internal `request-logs` endpoint with the supplied personal access token (single page, 60-minute window) before persisting. On success, stores the token in `~/.canonry/config.yaml` and creates / updates the project\'s active Vercel `traffic_sources` row. A probe failure (bad token, wrong project / team id, unreachable host) surfaces as 502 with the upstream status in the message so the caller learns about it up front instead of at the first sync. The project id, team id, and environment are stored as non-secret config on the row; only the personal access token lives in the credential file.',
    tags: ['traffic'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['projectId', 'teamId', 'token'],
            properties: {
              projectId: { ...stringSchema, description: 'Vercel project id (e.g. `prj_...`) — from the Vercel dashboard or `.vercel/project.json`.' },
              teamId: { ...stringSchema, description: 'Vercel team or account id: the org that owns the project (`orgId` in `.vercel/project.json`).' },
              token: { ...stringSchema, description: 'Vercel personal access token. Stored in `~/.canonry/config.yaml`, never the DB or response.' },
              environment: { type: 'string', enum: ['production', 'preview'], description: 'Which deployment environment\'s request logs to pull. Default: `production`.' },
              displayName: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Traffic source DTO returned.', 'TrafficSourceDto'),
      400: errorResponse('Invalid Vercel connection request.'),
      404: errorResponse('Project not found.'),
      502: errorResponse('Vercel request-logs endpoint probe failed (bad token, wrong project / team id, unreachable host, etc.).'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/connect/cloudflare',
    summary: 'Connect a Cloudflare Worker traffic source',
    description:
      'Creates or updates a Cloudflare `direct-push` or `queue-pull` traffic source and returns a secret-free ES-module Worker plus Wrangler configuration. Direct bearer/HMAC credentials and the Queue API token remain in Canonry\'s local credential store; none appears in source, TOML, DB config, response, or MCP output. Reconnect is idempotent by source mode. A different mode is staged paused when another project traffic source is active, and requires the explicit activation operation after deployment. Wrangler deploys the Worker without a route; the operator attaches the exact site route manually with Request limit failure mode set to Fail open.',
    tags: ['traffic'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/TrafficConnectCloudflareRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse('Connect response with generated Worker script.', 'TrafficConnectCloudflareResponse'),
      400: errorResponse('Invalid Cloudflare connection request or credential storage not configured.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/cloudflare/ingest',
    summary: 'Ingest a batch of Cloudflare Worker events',
    description:
      'Direct-push protocol endpoint. The customer Worker sends selected edge-event batches authenticated by a per-source bearer and HMAC-SHA256 over `${timestamp}.${canonicalJson(payload)}`; object keys are sorted recursively before signing. The global cnry_* bearer does not apply. Headers: `Authorization: Bearer <per-source-token>`, `X-Canonry-Timestamp` (unix seconds), `X-Canonry-Signature` (hex HMAC), `X-Canonry-Source-Id`, and `X-Canonry-Worker-Version`. Authentication completes before project resolution and every auth/path/source mismatch returns the same 401. Accepted event ids are claimed durably in the same transaction as shared crawler, user-fetch, and paid/organic referral rollups.',
    tags: ['traffic'],
    auth: false,
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CloudflareWorkerIngestRequest' },
        },
      },
    },
    responses: {
      200: jsonResponse(
        'Ingest acknowledged; droppedEvents includes normalization failures and durable-receipt duplicates.',
        'CloudflareWorkerIngestResponse',
      ),
      400: errorResponse('Invalid ingest payload.'),
      401: errorResponse('Authentication failed (bearer, signature, timestamp, or source id mismatch).'),
      413: errorResponse('The ingest payload exceeds 256 KiB.'),
      429: errorResponse('The per-IP or authenticated-source ingest request budget was exceeded.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/sources/{id}/activate',
    summary: 'Activate a staged traffic source',
    description:
      'Explicit single-team cutover. Atomically pauses every sibling project traffic source and connects the selected Cloudflare, Cloud Run, WordPress, or Vercel source after validating its local credential. Pull delivery creates or repoints the one project traffic-sync schedule; Cloudflare direct push removes it. Deployment and provider-side routing remain separate operator actions.',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Staged traffic source ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Activated traffic source DTO returned.', 'TrafficSourceDto'),
      400: errorResponse('Source is archived, unsupported, or cannot be activated.'),
      404: errorResponse('Project or traffic source not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/sources/{id}/sync',
    summary: 'Trigger a sync run for a traffic source',
    description:
      'Pulls from the selected Cloud Run, WordPress, Vercel, or Cloudflare Queue source, classifies crawler hits / user fetches / AI-referral sessions, and commits hourly buckets plus a bounded sample tail. WordPress uses a fixed half-open `[since, until)` window and a source lease; its first or idle sync defaults to the plugin maximum retention horizon (365d) unless `sinceMinutes` is supplied. Queue pull also uses a durable source lease and acknowledges each Cloudflare message only after its event receipts and rollups commit.',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Traffic source ID.', schema: stringSchema },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              sinceMinutes: { ...integerSchema, description: 'Optional lookback for time-window sources. Defaults are adapter-specific; a new or idle WordPress source uses 365d to cover the plugin’s maximum configurable retention. Cloudflare Queue pull ignores it.' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Sync summary returned.', 'TrafficSyncResponse'),
      400: errorResponse('Invalid sync request or missing credentials.'),
      409: errorResponse('Another WordPress or Queue sync currently owns the source lease.'),
      404: errorResponse('Project or traffic source not found.'),
      502: errorResponse('Upstream pull, acknowledgement, or credential resolution failed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/sources/{id}/backfill',
    summary: 'Reclassify historical traffic-source logs',
    description:
      'Async one-shot reclassification: pulls the last `days` of events, classifies them with current rules, and replaces hourly rollup buckets plus the sample slice in that window inside one transaction. Adapter limits apply (Cloud Logging `_Default` is typically 30d; request payloads are capped at 90d). Generic replace backfill supports `cloud-run` and `vercel`. WordPress is always rejected because its retained event feed cannot prove it covers every bucket; use a retention-aware repair that explicitly declares any unrecoverable span. Returns immediately with `{ runId, status: "running" }`; poll `GET /runs/{id}` for completion. lastSyncedAt only advances forward.',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Traffic source ID.', schema: stringSchema },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              days: { ...integerSchema, description: 'Lookback window in days (default 30, capped by the adapter; generic WordPress replace backfill is unavailable).' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Backfill submitted; poll the returned runId for completion.', 'TrafficBackfillResponse'),
      400: errorResponse('Invalid backfill request or missing credentials.'),
      404: errorResponse('Project or traffic source not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/sources/{id}/reset',
    summary: 'Advance lastSyncedAt to NOW and clear the error state',
    description:
      'Operator recovery: advances `lastSyncedAt` to NOW, sets `status` back to `connected`, and clears `last_error`. WordPress resets also clear `last_cursor` and the pending-window marker, then record an unrecovered skip through the reset instant so the next drain cannot combine an old cursor with a new window. That prevents replay but is not a historical repair. Generic WordPress replace-mode backfill is unavailable because the plugin feed cannot prove retained coverage; use a retention-aware repair and explicitly declare any unrecoverable span. Common trigger: an idle Vercel/Cloud Run source whose `lastSyncedAt` has aged past upstream retention (`request-logs` ~14d, Cloud Logging 30d) and now throws on every sync. `advanceToNow: true` is required (no implicit reset). Archived sources are rejected with 400 — re-connect them via the appropriate `traffic/connect/*` endpoint instead.',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Traffic source ID.', schema: stringSchema },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['advanceToNow'],
            properties: {
              advanceToNow: { type: 'boolean', enum: [true], description: 'Must be `true` — explicit gate against accidental resets.' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Source reset; lastSyncedAt advanced to NOW.', 'TrafficSourceDetailDto'),
      400: errorResponse('Missing or invalid `advanceToNow` flag, or the source is archived.'),
      404: errorResponse('Project or traffic source not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/traffic/sources',
    summary: 'List non-archived traffic sources for a project',
    tags: ['traffic'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Source list returned.', 'TrafficSourceListResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/traffic/status',
    summary: 'List non-archived traffic sources with last-24h totals and the latest sync run for each',
    description:
      'Single-call composite for the `canonry traffic status` view: same shape as `GET /traffic/sources/{id}` but returned as `{ sources: TrafficSourceDetailDto[] }` for every non-archived source. Lets agents and the dashboard avoid an N+1 fan-out.',
    tags: ['traffic'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Status returned.', 'TrafficStatusResponse'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/traffic/sources/{id}',
    summary: 'Get a single traffic source with last-24h totals and the latest sync run',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Traffic source ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Source detail returned.', 'TrafficSourceDetailDto'),
      404: errorResponse('Project or source not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/traffic/events',
    summary: 'List rolled-up crawler hits, AI user-fetch hits, and AI-referral sessions within a window',
    description:
      'Returns full-window hourly or daily chart series plus newest-first detail rows from `crawler_events_hourly`, `ai_user_fetch_events_hourly`, and `ai_referral_events_hourly`. Defaults to the last 24h. Totals and `series.points` reflect the full window; only the `events` array is capped by `limit` (default 500, max 5000). `eventRows` reports the true pre-limit row count.',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'since', in: 'query', description: 'ISO-8601 window start (defaults to 24h ago).', schema: stringSchema },
      { name: 'until', in: 'query', description: 'ISO-8601 window end (defaults to now).', schema: stringSchema },
      { name: 'kind', in: 'query', description: 'Filter to "crawler", "ai-user-fetch", "ai-referral", or "all" (default).', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max newest combined detail rows in the events array (default 500, max 5000).', schema: stringSchema },
      { name: 'sourceId', in: 'query', description: 'Restrict to a single traffic source.', schema: stringSchema },
      { name: 'granularity', in: 'query', description: 'Full-window series bucket size: "hour" (default) or "day".', schema: { type: 'string', enum: ['hour', 'day'] } },
    ],
    responses: {
      200: jsonResponse('Events returned with windowed totals.', 'TrafficEventsResponse'),
      400: errorResponse('Invalid query parameters.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/discover/run',
    summary: 'Start a tracked-basket discovery session',
    description:
      'Kicks off a discovery session for the project. The pipeline: ICP description → Gemini grounded seed prompt → embed + cluster (cosine ≥ 0.95 by default) → pick canonical representatives → probe each canonical via Gemini grounding → classify into cited / aspirational / wasted-surface → aggregate competitor map. Returns immediately with `{ runId, sessionId, status: "running", consolidated }`; the actual work runs in the background. Poll `GET /projects/{name}/discover/sessions/{id}` until `status` is `completed` or `failed`. Concurrent/duplicate requests for the same (project, ICP) are consolidated onto a single in-flight session: the response carries `consolidated: true` and `200 OK` instead of `201`, and the request\'s `dedupThreshold` / `maxProbes` / `probeConcurrency` are ignored (the in-flight session keeps its original config).',
    tags: ['discovery'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              icpDescription: { type: 'string', description: 'Free-text ICP. Required if the project does not have spec.icpDescription stored.' },
              buyerDescription: { type: 'string', description: 'Who evaluates or buys the offering, separate from the ICP. When present, every generated seed query is anchored on this buyer and the seed prompt enforces buyer-fit.' },
              seedProviders: { type: 'array', items: { type: 'string', enum: ['gemini', 'openai'] }, minItems: 1, description: 'Which providers generate seed candidates. Omit for the Gemini-only default. Canonicalized (deduped + sorted); part of the session consolidation identity.' },
              dedupThreshold: { type: 'number', description: 'Cosine similarity threshold for clustering. Defaults to 0.95.' },
              maxProbes: { type: 'integer', description: 'Max canonical queries to probe in this session. Default 100, hard cap 500.' },
              probeConcurrency: {
                type: 'integer',
                minimum: 1,
                maximum: 8,
                description: 'How many probes may run in parallel. Default 1 (strictly serial — the historical behaviour), hard cap 8. Probe rows are persisted in canonical order regardless of concurrency, so this only shortens wall-clock time.',
              },
              locations: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional override of the project location labels used to geo-constrain seed generation. Each label must match a configured project location; an unknown label is a 400. Omit to use every project location.',
              },
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `DiscoveryRunResponse` Zod schema in contracts (`{ runId, sessionId, status, consolidated }`).
      200: rawJsonResponse('An in-flight session with the same project + ICP was reused; returns { runId, sessionId, status, consolidated: true }. The request\'s dedupThreshold / maxProbes are ignored.', looseObjectSchema),
      201: rawJsonResponse('New discovery session enqueued; returns { runId, sessionId, status, consolidated: false }.', looseObjectSchema),
      400: errorResponse('Missing or invalid ICP / parameters.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/discover/sessions',
    summary: 'List discovery sessions for a project',
    description: 'Returns sessions newest-first. Each row carries seed counts, bucket counts, the competitor map, and timing fields. Drill into `GET /projects/{name}/discover/sessions/{id}` for per-query probe rows.',
    tags: ['discovery'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max sessions returned. Default 50.', schema: stringSchema },
    ],
    responses: {
      200: jsonArrayResponse('Sessions returned.', 'DiscoverySessionDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/discover/sessions/{id}',
    summary: 'Get a discovery session with its probe list',
    description: 'Returns one discovery session plus the full list of per-canonical probes (query, bucket, cited domains, citation state). Use this to answer "what did discovery find for project X?" in a single call.',
    tags: ['discovery'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Discovery session ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Session detail returned.', 'DiscoverySessionDetailDto'),
      404: errorResponse('Project or session not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/discover/sessions/{id}/harvest',
    summary: 'Harvest issued search queries (grounding fan-out) from a session',
    description:
      "Reads the search queries the answer engine actually issued to answer each probe (Gemini's `groundingMetadata.webSearchQueries` fan-out) back out of the session's stored probe payloads, then runs a mandatory quality gate and returns the survivors as candidate seeds, ranked by how many distinct probes issued each one. The gate drops navigational/phone lookups, over-specific outliers, off-subject acronym collisions, exact already-tracked matches, and — via an embedding cosine pass over the project's tracked queries — semantic duplicates (paraphrases/synonyms an exact match can't see). `semanticNoveltyApplied` reports whether that embedding pass ran (it falls back to exact-match when embeddings are unavailable). These are a THIRD signal — *issued retrieval queries* — distinct from `mention` (answer text) and `cited` (source list); they carry no demand of their own. Read-only and derived: nothing is probed, tracked, or promoted. `minProbeHits` raises the recurrence floor; `anchor=false` disables the subject anchor for new-subject discovery on a well-scoped project. `stats` carries the raw count and a per-reason rejection tally. Issue #713.",
    tags: ['discovery'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Discovery session ID.', schema: stringSchema },
      { name: 'minProbeHits', in: 'query', required: false, description: 'Minimum number of distinct probes a candidate must appear in to be admitted (recurrence floor). Default 1.', schema: stringSchema },
      { name: 'anchor', in: 'query', required: false, description: 'Set to "false" to disable the subject-anchor filter. Default applies it (when the subject corpus is rich enough).', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Harvested candidate seeds + gate stats returned.', 'DiscoveryHarvestDto'),
      404: errorResponse('Project or session not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/discover/sessions/{id}/promote',
    summary: 'Preview a discovery promotion plan (read-only)',
    description: 'Returns available promotion candidates: queries grouped by bucket, plus recurring suggested competitor domains not already tracked. Read-only — use the POST to actually adopt the default subset or an explicit bucket subset.',
    tags: ['discovery'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Discovery session ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Promote preview returned.', 'DiscoveryPromotePreview'),
      404: errorResponse('Project or session not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/discover/sessions/{id}/promote',
    summary: 'Promote a discovery session into the tracked basket',
    description:
      "Adopts a completed session's bucketed queries into the project's tracked basket, tagged with `provenance=\"discovery:<sessionId>\"`. By default, only `cited` and `aspirational` queries are promoted; include `wasted-surface` explicitly when off-ICP competitor gaps should also be tracked. Recurring discovered competitor domains classified as `direct-competitor` are also merged by default — pass `competitorTypes` to adopt other classified types or to recover legacy `unknown` entries. Add-only and idempotent: queries/domains already tracked are returned under `skipped` rather than inserted twice. Only sessions with `status: \"completed\"` can be promoted.",
    tags: ['discovery'],
    parameters: [
      nameParameter,
      { name: 'id', in: 'path', required: true, description: 'Discovery session ID.', schema: stringSchema },
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              buckets: {
                type: 'array',
                items: { type: 'string', enum: ['cited', 'aspirational', 'wasted-surface'] },
                description: 'Which probe buckets to promote. Omitted means cited + aspirational.',
              },
              includeCompetitors: {
                type: 'boolean',
                description: 'Whether to also merge recurring discovered competitor domains. Defaults to true.',
              },
              competitorTypes: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['direct-competitor', 'ota-aggregator', 'editorial-media', 'other', 'unknown'],
                },
                description:
                  'Which classified competitor types to merge. Omitted means direct-competitor only. Ignored when includeCompetitors is false.',
              },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Promotion applied; returns promoted + skipped query/competitor lists.', 'DiscoveryPromoteResult'),
      400: errorResponse('Session is not completed, or invalid request body.'),
      404: errorResponse('Project or session not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo',
    summary: 'Get the Technical AEO scorecard for a project',
    description:
      'Returns the latest completed/partial site-audit, or the historical audit selected by `runId`: aggregate 0–100 score, page counts, the full per-factor scorecard (site-level averages with pass/partial/fail distribution), cross-cutting issues, prioritized fixes, and the delta vs the audit immediately before it. When the project has never been audited, `hasData` is false and the numeric fields are zeroed — render an onboarding state.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest audit.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Technical AEO scorecard returned.', 'SiteAuditScoreDto'),
      404: errorResponse('Project or site-audit run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/pages',
    summary: 'List audited pages from a site-audit run',
    description:
      'Returns the per-page breakdown of the latest completed/partial site-audit run, or the historical audit selected by `runId` (paginated). Filter to `status=error` to surface unreachable pages; sort `score-asc` (default) to surface the worst-scoring pages first.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest audit.', schema: stringSchema },
      { name: 'status', in: 'query', description: 'Filter by page audit status: `success` or `error`.', schema: { type: 'string', enum: ['success', 'error'] } },
      { name: 'sort', in: 'query', description: 'Sort order: `score-asc` (default), `score-desc`, or `url`.', schema: { type: 'string', enum: ['score-asc', 'score-desc', 'url'] } },
      limitQueryParameter,
      offsetQueryParameter,
    ],
    responses: {
      200: jsonResponse('Audited pages returned.', 'SiteAuditPagesResponseDto'),
      404: errorResponse('Project or site-audit run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/trend',
    summary: 'Get the Technical AEO aggregate-score trend',
    description: 'Returns historical aggregate scores across completed/partial site-audit runs, oldest-first, for the trend chart.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max data points returned (most recent runs). Default 30.', schema: integerSchema },
    ],
    responses: {
      200: jsonResponse('Technical AEO trend returned.', 'SiteAuditTrendResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/crawl',
    summary: 'Get persisted Technical AEO crawl metadata',
    description: 'Returns the latest complete non-probe site-audit crawl, or the selected historical run (which may be partial). `hasCrawlData=false` never synthesizes a graph from legacy scorecard rows; `legacyAuditAvailable` says that the old score/pages/trend data can still be read separately.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Persisted crawl summary returned.', 'SiteCrawlSummaryDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/graph',
    summary: 'Get a persisted Site Health graph projection',
    description: 'Returns the deterministic graph projection computed once when the latest complete or selected historical crawl was published. ForceAtlas2 positions and the exact internal-anchor edge sample are persisted, so reads run no layout physics and never rescan the crawl edge table. Nav, header, and footer links are excluded from the layout physics but retained in the sample and tagged `isTemplate`, so a viewer can draw them without a refetch and without any node moving. The response is bounded to 20,000 nodes / 50,000 edges; `layout`, `omittedNodes`, `omittedEdges`, and `sampled` disclose legacy/unavailable layouts and intentional truncation, and `templateDetection` says whether template links could be told apart at all and by which rule.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest complete crawl.', schema: stringSchema },
      { name: 'maxNodes', in: 'query', description: 'Maximum graph nodes. Defaults to and is capped at 20,000.', schema: { type: 'integer', minimum: 1, maximum: 20_000 } },
      { name: 'maxEdges', in: 'query', description: 'Maximum graph edges. Defaults to and is capped at 50,000.', schema: { type: 'integer', minimum: 1, maximum: 50_000 } },
      linkKindParameter,
    ],
    responses: {
      200: jsonResponse('Bounded Site Health graph projection returned.', 'SiteCrawlGraphResponseDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/subgraph',
    summary: 'Get a bounded canonical Site Health neighborhood',
    description: 'Agent-oriented canonical crawl neighborhood around one page. Reads full crawl page/link rows rather than the sampled visualization, excludes layout coordinates, and returns snapshot completeness/termination. When a hard bound is reached, countAccuracy=lower-bound makes totalNodes, totalEdges, omittedNodes, and omittedEdges explicit minimums rather than false exact totals.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest complete crawl.', schema: stringSchema },
      { name: 'nodeKey', in: 'query', description: 'Focus page canonical node key. Omit nodeKey and url to use the crawl root.', schema: stringSchema },
      { name: 'url', in: 'query', description: 'Focus page canonical URL. Omit nodeKey and url to use the crawl root.', schema: stringSchema },
      { name: 'hops', in: 'query', description: 'Undirected neighborhood radius. Defaults to 1; maximum 3.', schema: { type: 'integer', minimum: 0, maximum: 3 } },
      { name: 'maxNodes', in: 'query', description: 'Maximum canonical nodes. Defaults to 25; maximum 200.', schema: { type: 'integer', minimum: 1, maximum: 200 } },
      { name: 'maxEdges', in: 'query', description: 'Maximum canonical edges. Defaults to 50; maximum 500.', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: {
      200: jsonResponse('Bounded canonical Site Health neighborhood returned.', 'SiteHealthSubgraphResponseDto'),
      404: errorResponse('Project, crawl-bearing run, or focus page not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/path',
    summary: 'Find a directed internal-link path between pages',
    description: 'Returns the shortest directed path over followable internal anchor links. The source defaults to the crawl root; the target must be identified by toNodeKey or toUrl. Exploration is bounded to 5,000 nodes and returns an explicit unreachable or truncated state. Snapshot complete and termination provenance prevents an unreachable result from a selected partial crawl being mistaken for a site-wide claim.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest complete crawl.', schema: stringSchema },
      { name: 'fromNodeKey', in: 'query', description: 'Source canonical node key. Omit both source selectors to start at the crawl root.', schema: stringSchema },
      { name: 'fromUrl', in: 'query', description: 'Source canonical URL. Omit both source selectors to start at the crawl root.', schema: stringSchema },
      { name: 'toNodeKey', in: 'query', description: 'Target canonical node key. Required when toUrl is omitted.', schema: stringSchema },
      { name: 'toUrl', in: 'query', description: 'Target canonical URL. Required when toNodeKey is omitted.', schema: stringSchema },
      { name: 'maxDepth', in: 'query', description: 'Maximum directed link depth. Defaults to 12; maximum 24.', schema: { type: 'integer', minimum: 1, maximum: 24 } },
    ],
    responses: {
      200: jsonResponse('Directed internal-link path result returned.', 'SiteHealthPathResponseDto'),
      400: errorResponse('A target selector is required.'),
      404: errorResponse('Project, crawl-bearing run, source page, or target page not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/changes',
    summary: 'Compare canonical Site Health snapshots',
    description: 'Returns exact page and internal-link additions, removals, and semantic field changes between immutable complete crawl snapshots. Omitted toRunId selects the latest complete crawl; omitted fromRunId selects the complete crawl immediately before the target. ForceAtlas2 positions are presentation data and never count as a change. The first page includes exact post-filter summary counts; cursor pages set summary and total to null so they never repeat full snapshot joins or trust caller-carried counts. Results use a snapshot- and filter-bound keyset cursor.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'fromRunId', in: 'query', description: 'Baseline complete crawl. Omit for the complete crawl immediately before the target.', schema: stringSchema },
      { name: 'toRunId', in: 'query', description: 'Target complete crawl. Omit for the latest complete crawl.', schema: stringSchema },
      { name: 'scope', in: 'query', description: 'Restrict records and first-page summary counts to pages, links, or both.', schema: { type: 'string', enum: ['all', 'pages', 'links'], default: 'all' } },
      { name: 'change', in: 'query', description: 'Restrict records and first-page summary counts to one change kind.', schema: { type: 'string', enum: ['all', 'added', 'removed', 'changed'], default: 'all' } },
      { name: 'cursor', in: 'query', description: 'Opaque keyset cursor bound to both run IDs and the selected filters.', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Maximum change records. Defaults to 25; maximum 100.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: jsonResponse('Canonical Site Health snapshot comparison returned.', 'SiteHealthChangesResponseDto'),
      400: errorResponse('Invalid filters, run direction, or cursor context.'),
      404: errorResponse('Project or selected crawl-bearing run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/crawl/pages/audit',
    summary: 'Get exact audit evidence for one persisted crawl page',
    description: 'Returns one page score with the exact weighted-factor findings, recommendations, applicability, and independent critical defects persisted for the selected crawl. Exactly one of nodeKey or url is required. The discriminated state preserves crawl completeness and termination provenance, distinguishes a page that was not audited from one that was not found, and marks legacy score-only rows without fabricating missing evidence. This one-page read keeps verbose evidence out of the bounded interactive graph projection.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest complete crawl.', schema: stringSchema },
      { name: 'nodeKey', in: 'query', description: 'Exact canonical crawl node key. Required when url is omitted.', schema: stringSchema },
      { name: 'url', in: 'query', description: 'Exact persisted crawl URL. Required when nodeKey is omitted.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Page audit evidence state returned.', 'SiteCrawlPageAuditDto'),
      400: errorResponse('Exactly one page selector is required.'),
      404: errorResponse('Project or explicitly selected crawl-bearing run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/crawl/pages',
    summary: 'List persisted Technical AEO crawl pages',
    description: 'Cursor-paged canonical crawl nodes for the latest or selected crawl. `inventoryEligible` is Canonry technical-inventory eligibility, not a statement about actual Google index state.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
      { name: 'inventoryEligible', in: 'query', description: 'Filter Canonry technical inventory eligibility (`true` or `false`).', schema: booleanSchema },
      { name: 'fetchState', in: 'query', description: 'Filter by persisted fetch state.', schema: stringSchema },
      { name: 'indexabilityState', in: 'query', description: 'Filter by crawler-derived indexability state; this is not Google index coverage.', schema: stringSchema },
      { name: 'nodeKey', in: 'query', description: 'Return only the page with this node key. Combined with a filter it answers whether that exact page is in the filtered set, without paging through the list.', schema: stringSchema },
      { name: 'healthState', in: 'query', description: 'Filter by the derived Site Health state shared with the dashboard and agents. Unlike `indexabilityState` this folds fetch state, canonical identity, and the crawler reasons into one decision. `hidden` means the SITE told answer engines not to index the page (noindex, canonical-away, robots.txt); a non-HTML file is `resource` and a redirect is `redirect`, because neither is suppressed. Values: `eligible`, `hidden`, `resource`, `redirect`, `failed`, `unchecked`.', schema: { type: 'string', enum: ['eligible', 'hidden', 'resource', 'redirect', 'failed', 'unchecked'] } },
      { name: 'auditState', in: 'query', description: 'Filter by audit state.', schema: stringSchema },
      { name: 'sort', in: 'query', description: 'Sort order. Defaults to `url`.', schema: { type: 'string', enum: ['url', 'path', 'score-asc', 'score-desc'] } },
      crawlCursorParameter,
      crawlLimitParameter,
    ],
    responses: {
      200: jsonResponse('Crawl pages returned.', 'SiteCrawlPagesResponseDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/structure',
    summary: 'List one level of Technical AEO crawl structure',
    description: 'Returns immediate children under `parentPath` only. It is deliberately bounded and never emits a full site tree.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
      { name: 'parentPath', in: 'query', description: 'Parent URL path. Defaults to `/`.', schema: stringSchema },
      crawlCursorParameter,
      { name: 'limit', in: 'query', description: 'Maximum immediate children. Defaults to 50; maximum 100.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: jsonResponse('Immediate crawl children returned.', 'SiteCrawlStructureResponseDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/internal-links',
    summary: 'List persisted internal crawl links',
    description: 'Cursor-paged internal edges for the latest or selected crawl. Optional source/target/followability/link-kind filters remain project-, run-, and attempt-scoped. `total` counts exactly what the requested filters match, `templateDetection` says whether nav and footer links could be told apart for this scan and by which rule, and the `templateSource` plus `placementOccurrences` on each edge show the evidence behind its own classification.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
      { name: 'sourceUrl', in: 'query', description: 'Restrict to a source URL.', schema: stringSchema },
      { name: 'targetUrl', in: 'query', description: 'Restrict to a target URL.', schema: stringSchema },
      { name: 'followable', in: 'query', description: 'Restrict to followable or nofollow link observations.', schema: booleanSchema },
      linkKindParameter,
      crawlCursorParameter,
      crawlLimitParameter,
    ],
    responses: {
      200: jsonResponse('Internal crawl links returned.', 'SiteCrawlInternalLinksResponseDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/internal-links/neighbors',
    summary: 'Get a bounded internal-link neighborhood',
    description: 'Returns bounded inbound and outbound internal edges for one `nodeKey` or URL; this is not a full graph traversal.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
      { name: 'nodeKey', in: 'query', description: 'Canonical crawl node key.', schema: stringSchema },
      { name: 'url', in: 'query', description: 'Canonical crawl URL.', schema: stringSchema },
      linkKindParameter,
      { name: 'limit', in: 'query', description: 'Maximum inbound and outbound edges independently. Defaults to 50; maximum 100.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: jsonResponse('Bounded internal-link neighborhood returned.', 'SiteCrawlNeighborsResponseDto'),
      400: errorResponse('A nodeKey or URL is required.'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/dead-links',
    summary: 'List dead-link findings when checks were enabled',
    description: 'Returns a discriminated `disabled`, `complete`, `partial`, or `unavailable` state. A disabled check is never returned as an empty zero-result list.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'query', description: 'Historical site-audit run ID. Omit for the latest crawl.', schema: stringSchema },
      crawlCursorParameter,
      crawlLimitParameter,
    ],
    responses: {
      200: jsonResponse('Dead-link status and findings returned.', 'SiteCrawlDeadLinksResponseDto'),
      404: errorResponse('Project or site-audit run not found. A known run that published no crawl returns 200 with the no-crawl state instead.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/runs',
    summary: 'List Site Health scan history',
    description: 'Returns every non-probe `site-audit` run for the project, newest first, including runs still queued or running and runs that failed. `hasCrawlData` says whether that scan published a page and internal-link crawl: a legacy score-only scan is listed with `hasCrawlData=false` rather than hidden, and the crawl-scoped reads answer it with their no-crawl state instead of a 404.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max scans returned (most recent first). Defaults to 20; max 100.', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: jsonResponse('Site Health scan history returned.', 'SiteHealthScansResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/runs/{runId}/progress',
    summary: 'Get exact stored Site Health run progress',
    description:
      'Returns durable run, crawl-attempt, and terminal graph-layout state for one exact non-probe site-audit run. It performs no network work and intentionally returns raw counters instead of a completion percentage.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'path', required: true, description: 'Exact site-audit run ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Exact stored Site Health progress returned.', 'SiteAuditRunProgressDto'),
      404: errorResponse('Project or non-probe site-audit run not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/technical-aeo/runs/{runId}/page-health-preview',
    summary: 'Get a bounded, provisional Page Health preview',
    description:
      'Returns a small durable, provisional preview for one exact non-probe site-audit run while it is running: the count of audited pages plus at most 12 actionable low-score examples without finding prose. Queued scans return waiting. Terminal scans return no examples so callers use the immutable Page Health results instead. It performs no network work.',
    tags: ['technical-aeo'],
    parameters: [
      nameParameter,
      { name: 'runId', in: 'path', required: true, description: 'Exact site-audit run ID.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Bounded provisional Page Health preview returned.', 'SiteAuditLivePageHealthDto'),
      404: errorResponse('Project or non-probe site-audit run not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/technical-aeo/runs',
    summary: 'Trigger a Technical AEO site-audit run',
    description:
      'Queues a `site-audit` run. The run discovers pages from the root, recursive sitemaps, and internal links. An active run is reused only when its persisted effective sitemap, budgets, depth, and dead-link option match exactly; a semantic mismatch returns 409.',
    tags: ['technical-aeo'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              sitemapUrl: { ...stringSchema, description: 'Deprecated compatibility alias for the sitemap override.' },
              limit: { ...integerSchema, minimum: 1, maximum: 2_000, description: 'Deprecated compatibility alias for maxPages. Max 2000.' },
              maxPages: { ...integerSchema, minimum: 1, maximum: 50_000, description: 'Crawl page budget. Defaults to 1000; max 50000.' },
              maxEdges: { ...integerSchema, minimum: 1, maximum: 1_000_000, description: 'Internal-link observation budget. Defaults to 100000; max 1000000.' },
              maxDepth: { ...integerSchema, minimum: 0, maximum: 100, description: 'Maximum crawl depth from the root. Max 100.' },
              checkDeadLinks: { ...booleanSchema, default: false, description: 'Enable dead-link checking. Defaults to false.' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Site-audit run queued (or the in-flight run returned).', 'SiteAuditRunResponseDto'),
      400: errorResponse('Invalid site-audit request.'),
      409: errorResponse('A crawl with different effective options is already queued or running.'),
      422: errorResponse('The site-audit executor is unavailable on this deployment.'),
      404: errorResponse('Project not found.'),
    },
  },
]

/**
 * Canonry-local routes not shipped by the shared api-routes package — added
 * at server startup through `ApiRoutesOptions.registerAuthenticatedRoutes`.
 * Surfaced here so the OpenAPI spec lists them. Consumers embedding api-routes
 * without the local Aero plugin will see `registerAuthenticatedRoutes` as
 * undefined and these entries will still appear in the spec, reflecting the
 * canonical canonry deployment contract.
 */
/**
 * Routes registered by canonry itself (the Aero agent layer in
 * `packages/canonry/src/agent/agent-routes.ts`) rather than this shared
 * api-routes plugin. Surfaced here so the OpenAPI spec emitted by
 * `canonry serve` (and consumed by the SDK codegen) lists them, but the
 * api-routes test app does NOT register the underlying handlers. Tests
 * that compare observed-routes-vs-spec-routes use this list to subtract
 * the canonry-local paths before asserting equality.
 */
export const canonryLocalRouteCatalog: OpenApiOperation[] = [
  {
    method: 'get',
    path: '/api/v1/projects/{name}/agent/transcript',
    summary: 'Get the rolling Aero transcript for this project',
    description:
      'Returns the full message history of the project-scoped Aero session plus the persisted model provider/id and last-updated timestamp. Empty messages array when the project has no session yet.',
    tags: ['agent'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `AgentTranscriptDto` Zod schema in contracts.
      200: rawJsonResponse('Transcript returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/agent/transcript',
    summary: 'Reset the Aero transcript + queued follow-ups',
    description:
      'Evicts any live Agent instance, clears the persisted messages and follow_up_queue. A subsequent prompt starts a fresh session.',
    tags: ['agent'],
    parameters: [nameParameter],
    responses: {
      // Returns { status: 'reset' } sentinel.
      200: rawJsonResponse('Session reset.', { type: 'object', properties: { status: { type: 'string', enum: ['reset'] } } }),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/agent/memory',
    summary: 'List durable Aero memory entries for a project',
    description:
      'Returns the project-scoped agent_memory rows newest-first. Includes both operator-authored notes (source `user`/`aero`) and LLM-authored compaction summaries (source `compaction`, key prefix `compaction:`). The N most-recent rows are also injected into the system prompt at every new session start.',
    tags: ['agent'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `AgentMemoryListResponse` Zod schema in contracts.
      200: rawJsonResponse('Memory entries returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/agent/memory',
    summary: 'Upsert a durable Aero memory entry',
    description:
      'Creates or replaces a project-scoped note (max 2 KB, max 128-char key). Same key replaces the prior value. Keys with the reserved `compaction:` prefix are rejected — that namespace is owned by transcript compaction.',
    tags: ['agent'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['key', 'value'],
            properties: {
              key: { type: 'string', description: 'Stable identifier for this note (max 128 chars).' },
              value: { type: 'string', description: 'Plain-text note body (max 2 KB).' },
            },
          },
        },
      },
    },
    responses: {
      // TODO: Add `AgentMemoryEntryDto` Zod schema in contracts.
      200: rawJsonResponse('Entry upserted.', looseObjectSchema),
      400: errorResponse('Validation failed (key length, value size, reserved prefix).'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/agent/memory',
    summary: 'Delete a durable Aero memory entry',
    description:
      'Removes a single project-scoped note by key. Returns `status: missing` (non-error) when the key never existed. Keys with the reserved `compaction:` prefix are rejected — those notes are pruned automatically.',
    tags: ['agent'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['key'],
            properties: {
              key: { type: 'string', description: 'Exact key of the note to remove.' },
            },
          },
        },
      },
    },
    responses: {
      // Returns { status: 'removed' | 'missing' } sentinel.
      200: rawJsonResponse('Entry removed or already absent.', { type: 'object', properties: { status: { type: 'string', enum: ['removed', 'missing'] } } }),
      400: errorResponse('Validation failed (reserved prefix).'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/agent/providers',
    summary: 'List the LLM providers Aero can route to',
    description:
      'Returns every provider Aero knows about with its default model, whether a usable API key is configured, and where the key resolved from (`config` | `env`). `defaultProvider` is the one Aero auto-picks when a caller omits `provider` on the prompt endpoint. Path is project-scoped for auth symmetry; the response does not vary per project today.',
    tags: ['agent'],
    parameters: [nameParameter],
    responses: {
      200: jsonResponse('Providers returned.', 'AgentProvidersResponseDto'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/agent/prompt',
    summary: 'Send a prompt to Aero and stream events back as SSE',
    description:
      'Posts a prompt into the project\'s Aero session and streams `AgentEvent` frames as `text/event-stream`. Each frame is `data: <JSON>\\n\\n`. The server brackets the stream with `{"type":"stream_open"}` and `{"type":"stream_close"}` control frames; `{"type":"error","message":"..."}` surfaces in-stream failures without collapsing the stream. Returns 409 `AGENT_BUSY` if another turn is already in flight for this project. Body field `scope` accepts "all" | "read-only"; omitted defaults to "read-only" (safe dashboard surface). Body field `profile` accepts "default" | "ads-operator"; omitted keeps the default full Canonry operator surface. The CLI passes "all" to keep write tools available.',
    tags: ['agent'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['prompt'],
            properties: {
              prompt: { type: 'string', description: "The user's message for Aero." },
              provider: {
                type: 'string',
                enum: [...AGENT_PROVIDER_IDS],
                description: 'Override the persisted LLM provider for this and subsequent turns.',
              },
              modelId: {
                type: 'string',
                description: 'Override the persisted model id for this and subsequent turns.',
              },
              scope: {
                type: 'string',
                enum: ['all', 'read-only'],
                description: 'Tool surface scope. Default "read-only". Set "all" to enable write tools.',
              },
              profile: {
                type: 'string',
                enum: ['default', 'ads-operator'],
                description: 'Tool profile. Default "default". Set "ads-operator" to use the narrower ads SaaS operator surface plus the ads context tool.',
              },
            },
          },
        },
      },
    },
    responses: {
      // Returns text/event-stream — codegen consumers should treat as a stream.
      200: { description: 'SSE stream of AgentEvent frames.', content: { 'text/event-stream': { schema: { type: 'string' } } } },
      400: errorResponse('Missing or empty prompt.'),
      404: errorResponse('Project not found.'),
      409: errorResponse('Another Aero turn is already in flight.'),
    },
  },
]

export function buildOpenApiDocument(info: OpenApiInfo = {}) {
  const BASE_PREFIX = '/api/v1'
  const prefix = info.routePrefix ?? BASE_PREFIX
  // Merge canonry-local routes (Aero) into the spec iff the caller opts in.
  // Api-routes' shared contract test builds the app without the local Aero
  // plugin, so we don't want to surface those entries in that path. canonry's
  // real `buildOpenApiDocument` call passes `includeCanonryLocal: true`.
  const fullCatalog = info.includeCanonryLocal
    ? [...routeCatalog, ...canonryLocalRouteCatalog]
    : routeCatalog
  const paths = fullCatalog.reduce<Record<string, Record<string, unknown>>>((acc, route) => {
    // Strip the hardcoded prefix from the route path, then prepend the configured prefix
    const subpath = route.path.startsWith(BASE_PREFIX) ? route.path.slice(BASE_PREFIX.length) : route.path
    const fullPath = prefix + subpath
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: route.tags,
      responses: route.responses,
      operationId: buildOperationId(route.method, route.path),
    }

    if (route.description) operation.description = route.description
    if (route.parameters) operation.parameters = route.parameters
    if (route.requestBody) operation.requestBody = route.requestBody
    if (route.auth === false) operation.security = []

    const pathItem = acc[fullPath] ?? {}
    pathItem[route.method] = operation
    acc[fullPath] = pathItem
    return acc
  }, {})

  // Emit every registered Zod response schema as `components.schemas`.
  // Routes reference them via `$ref` so the spec stays DRY and codegen tools
  // can produce one TS type per schema. Conversion uses Zod v4's built-in
  // `z.toJSONSchema` — no third-party converter required.
  const schemas = buildComponentSchemas()

  return {
    // OpenAPI 3.0 (not 3.1) so `nullable: true` on emitted schemas is the
    // canonical nullability marker. `z.toJSONSchema(..., { target: 'openapi-3.0' })`
    // outputs `nullable: true`; declaring 3.1 would tell consumers (and the
    // hey-api codegen) to expect 3.1-style `type: ["string", "null"]` instead,
    // and they'd silently strip the `null` from optional fields.
    openapi: '3.0.0',
    info: {
      title: info.title ?? 'Canonry API',
      version: info.version ?? '0.0.0',
      description: info.description ?? 'REST API for Canonry projects, runs, analytics, integrations, and operator workflows.',
    },
    servers: [
      {
        url: '/',
      },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API key',
        },
      },
      schemas,
    },
    paths,
  }
}

export async function openApiRoutes(app: FastifyInstance, opts: OpenApiInfo = {}) {
  app.get('/openapi.json', async (_request, reply) => {
    return reply.type('application/json').send(buildOpenApiDocument(opts))
  })
}

function buildOperationId(method: HttpMethod, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('{') && part.endsWith('}')) {
        return `by-${part.slice(1, -1)}`
      }
      return part
    })

  return [method, ...parts]
    .join('-')
    .replace(/[^a-z0-9]+(.)/gi, (_match, char: string) => char.toUpperCase())
    .replace(/^[^a-z]+/i, '')
}

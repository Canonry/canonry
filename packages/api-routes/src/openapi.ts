import type { FastifyInstance } from 'fastify'
import { AGENT_PROVIDER_IDS } from '@ainyc/canonry-contracts'
import {
  buildComponentSchemas,
  errorResponse,
  jsonArrayResponse,
  jsonResponse,
  looseObjectSchema,
  rawJsonResponse,
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
  in: 'path' | 'query'
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

const runIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Run ID.',
  schema: stringSchema,
}

const notificationIdParameter: OpenApiParameter = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Notification ID.',
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
  schema: { type: 'string', enum: ['answer-visibility', 'traffic-sync'] },
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
  description: 'Time window for analytics queries.',
  schema: { type: 'string', enum: ['7d', '30d', '90d', 'all'] },
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
    method: 'put',
    path: '/api/v1/projects/{name}',
    summary: 'Create or update a project',
    tags: ['projects'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['displayName', 'canonicalDomain', 'country', 'language'],
            properties: {
              displayName: stringSchema,
              canonicalDomain: stringSchema,
              ownedDomains: stringArraySchema,
              aliases: stringArraySchema,
              country: stringSchema,
              language: stringSchema,
              tags: stringArraySchema,
              labels: objectSchema,
              providers: stringArraySchema,
              locations: { type: 'array', items: locationSchema },
              defaultLocation: stringSchema,
              configSource: stringSchema,
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Project updated.', 'ProjectDto'),
      201: jsonResponse('Project created.', 'ProjectDto'),
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
      // TODO: Define an `ExportedProjectConfig` Zod schema in contracts (mirrors canonry.yaml shape).
      200: rawJsonResponse('Project configuration returned.', looseObjectSchema),
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
      409: errorResponse('Run already in progress.'),
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
      207: rawJsonResponse('Run results returned.', looseObjectSchema),
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
          schema: objectSchema,
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
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('Audit history returned.', 'AuditLogEntry'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/history',
    summary: 'Get global audit history',
    tags: ['history'],
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
    parameters: [nameParameter, locationQueryParameter],
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
      // TODO: Add `BrandMetricsDto` Zod schema in contracts.
      200: rawJsonResponse('Citation metrics returned.', looseObjectSchema),
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
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      // TODO: Add `SourceBreakdownDto` Zod schema in contracts.
      200: rawJsonResponse('Source breakdown returned.', looseObjectSchema),
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
              kind: { type: 'string', enum: ['answer-visibility', 'traffic-sync'] },
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
      { name: 'query', in: 'query', description: 'Filter by search query.', schema: stringSchema },
      { name: 'page', in: 'query', description: 'Filter by page URL.', schema: stringSchema },
      limitQueryParameter,
      offsetQueryParameter,
      analyticsWindowParameter,
    ],
    responses: {
      // Handler returns an array of GscSearchDataDto rows (web's
      // ApiGscPerformanceRow[] confirms). Was incorrectly spec'd as a
      // single object, which silently truncated client types to one row.
      200: jsonArrayResponse('GSC performance rows returned.', 'GscSearchDataDto'),
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
    parameters: [nameParameter],
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
      // TODO: Add `DiscoverSitemapsResponse` Zod schema in contracts.
      200: rawJsonResponse('Discovered sitemaps and queued run returned.', looseObjectSchema),
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
            properties: { selectAllNew: booleanSchema },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('List of discovered locations and selection summary returned.', 'GbpLocationListResponse'),
      400: errorResponse('Invalid discover request or scope/API problem.'),
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
    summary: 'Connect Google Analytics 4 via service account',
    tags: ['ga4'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['propertyId', 'keyJson'],
            properties: {
              propertyId: stringSchema,
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
    method: 'post',
    path: '/api/v1/projects/{name}/ga/sync',
    summary: 'Sync GA4 traffic and AI referral data',
    tags: ['ga4'],
    parameters: [nameParameter],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              days: integerSchema,
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
    parameters: [nameParameter, limitQueryParameter, analyticsWindowParameter],
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
    summary: 'Get AI referral sessions per day grouped by source and landing page',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: jsonArrayResponse('AI referral history returned.', 'GA4AiReferralHistoryEntry'),
      400: errorResponse('GA4 is not connected.'),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/social-referral-history',
    summary: 'Get social media referral sessions per day grouped by source',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter],
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
    parameters: [nameParameter, analyticsWindowParameter],
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
    path: '/api/v1/projects/{name}/report',
    summary: 'Aggregated canonical AEO report',
    tags: ['report'],
    description:
      'Bundles every section the canonry-report HTML output needs (executive summary, client summary, agency diagnostics, action plan, citation scorecard, competitor landscape — citation + mention landscapes, AI citation sources, GSC, GA4, social/AI referrals, indexing health, citations trend, insights, and recommended next steps) into a single canonical JSON payload. Backs `canonry report <project>` and MCP report reads.',
    parameters: [nameParameter],
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
    parameters: [nameParameter, reportAudienceQueryParameter],
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
      // TODO: Add `HealthSnapshotDto` Zod schema in contracts.
      200: rawJsonResponse('Health snapshot or no-data sentinel returned.', looseObjectSchema),
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
      { name: 'limit', in: 'query', description: 'Max results.', schema: stringSchema },
    ],
    responses: {
      // TODO: Add `HealthSnapshotDto` Zod schema in contracts.
      200: rawJsonResponse('Health history returned.', { type: 'array', items: looseObjectSchema }),
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
      'Returns the canonical opportunity list. Each row is `{query, action, ourBestPage?, winningCompetitor?, score, scoreBreakdown, drivers[], demandSource, actionConfidence, existingAction?}`. Hides rows with in-progress actions by default; pass `?include-in-progress=true` to include them annotated.',
    tags: ['content'],
    parameters: [
      nameParameter,
      { name: 'limit', in: 'query', description: 'Max rows returned.', schema: stringSchema },
      { name: 'include-in-progress', in: 'query', description: 'Include rows with in-flight tracked actions.', schema: stringSchema },
    ],
    responses: {
      200: jsonResponse('Targets returned.', 'ContentTargetsResponseDto'),
      400: errorResponse('Invalid limit.'),
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
      'Bundles project info, latest run, top undismissed insights, the latest health snapshot, query cited rate, per-provider breakdown, and transitions vs. the previous run. Designed for the "how is project X doing?" question so agents can answer in one call.',
    tags: ['intelligence'],
    parameters: [nameParameter],
    responses: {
      // TODO: Add `ProjectOverviewDto` Zod schema in contracts.
      200: rawJsonResponse('Overview returned.', looseObjectSchema),
      404: errorResponse('Project not found.'),
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/search',
    summary: 'Search query snapshots and insights for text',
    description:
      'Returns the most recent snapshots and insights whose answer text, cited domains, raw response, or insight title/query/recommendation/cause matches the query. Use to find anything mentioning a competitor, term, or URL without paginating snapshots.',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'q', in: 'query', required: true, description: 'Search term (>= 2 chars).', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max combined hits (1-50, default 25).', schema: stringSchema },
    ],
    responses: {
      // TODO: Add `ProjectSearchResponseDto` Zod schema in contracts (projectSearchResponseSchema exists).
      200: rawJsonResponse('Search hits returned.', looseObjectSchema),
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
    parameters: [nameParameter],
    responses: {
      200: jsonArrayResponse('History returned oldest-first by queriedAt.', 'BacklinkHistoryEntry'),
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
      'Probes the WordPress traffic-logger plugin endpoint with the supplied Application Password (single page, `limit=1`) before persisting. On success, stores the credential in `~/.canonry/config.yaml` and creates / updates the project\'s active WordPress `traffic_sources` row. A probe failure (HTTP 4xx/5xx, network error) surfaces as 502 with the upstream status in the message so the caller learns about a bad credential up front instead of at the first sync.',
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
    path: '/api/v1/projects/{name}/traffic/sources/{id}/sync',
    summary: 'Trigger a sync run for a traffic source',
    description:
      'Pulls request logs from the configured Cloud Run service for the lookback window, classifies crawler hits / AI-referral sessions, and upserts hourly buckets and a bounded sample tail.',
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
              sinceMinutes: { ...integerSchema, description: 'Lookback window in minutes (default 60).' },
            },
          },
        },
      },
    },
    responses: {
      200: jsonResponse('Sync summary returned.', 'TrafficSyncResponse'),
      400: errorResponse('Invalid sync request or missing credentials.'),
      404: errorResponse('Project or traffic source not found.'),
      502: errorResponse('Upstream Cloud Run pull or auth-token resolution failed.'),
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/traffic/sources/{id}/backfill',
    summary: 'Reclassify historical traffic-source logs',
    description:
      'Async one-shot backfill: pulls the last `days` of events (clamped server-side to the upstream retention ceiling — 30d for Cloud Logging `_Default`; the WordPress plugin honours the same window via `since`/`until` query params), classifies them with the current rules, and replaces the hourly rollup buckets + sample slice in the window inside one transaction. Returns immediately with `{ runId, status: "running" }`; poll `GET /runs/{id}` for completion. lastSyncedAt only advances forward, so a backfill never undoes incremental sync progress that ran ahead of it. Supported source types: `cloud-run`, `wordpress`, `vercel`.',
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
              days: { ...integerSchema, description: 'Lookback window in days (default 30, capped at the upstream retention ceiling).' },
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
      'Operator recovery: advances `lastSyncedAt` to NOW, sets `status` back to `connected`, and clears `last_error`. Accepts any non-archived source — the `lastSyncedAt` advance determines the next sync window for time-windowed sources (Vercel, Cloud Run) and is informational for cursor-based sources (WordPress, where `last_cursor` governs the next drain and is preserved). Common trigger: an idle Vercel/Cloud Run source whose `lastSyncedAt` has aged past the upstream retention window (`request-logs` ~14d, Cloud Logging 30d) and now throws on every sync. Any pre-existing rollup history stays in place; the skipped history is the explicit trade-off — run `traffic backfill` separately to recover any of it. `advanceToNow: true` is required (no implicit reset). Archived sources are rejected with 400 — re-connect them via the appropriate `traffic/connect/*` endpoint instead.',
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
      'Returns hourly rollup rows from `crawler_events_hourly`, `ai_user_fetch_events_hourly`, and `ai_referral_events_hourly`. Defaults to the last 24h. Totals reflect the full window; the `events` array is capped by `limit` (default 500, max 5000).',
    tags: ['traffic'],
    parameters: [
      nameParameter,
      { name: 'since', in: 'query', description: 'ISO-8601 window start (defaults to 24h ago).', schema: stringSchema },
      { name: 'until', in: 'query', description: 'ISO-8601 window end (defaults to now).', schema: stringSchema },
      { name: 'kind', in: 'query', description: 'Filter to "crawler", "ai-user-fetch", "ai-referral", or "all" (default).', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max rows per kind in the events array (default 500, max 5000).', schema: stringSchema },
      { name: 'sourceId', in: 'query', description: 'Restrict to a single traffic source.', schema: stringSchema },
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
      'Kicks off a discovery session for the project. The pipeline: ICP description → Gemini grounded seed prompt → embed + cluster (cosine ≥ 0.85 by default) → pick canonical representatives → probe each canonical via Gemini grounding → classify into cited / aspirational / wasted-surface → aggregate competitor map. Returns immediately with `{ runId, sessionId, status: "running", consolidated }`; the actual work runs in the background. Poll `GET /projects/{name}/discover/sessions/{id}` until `status` is `completed` or `failed`. Concurrent/duplicate requests for the same (project, ICP) are consolidated onto a single in-flight session: the response carries `consolidated: true` and `200 OK` instead of `201`, and the request\'s `dedupThreshold` / `maxProbes` are ignored (the in-flight session keeps its original config).',
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
              dedupThreshold: { type: 'number', description: 'Cosine similarity threshold for clustering. Defaults to 0.85.' },
              maxProbes: { type: 'integer', description: 'Max canonical queries to probe in this session. Default 100, hard cap 500.' },
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
      'Posts a prompt into the project\'s Aero session and streams `AgentEvent` frames as `text/event-stream`. Each frame is `data: <JSON>\\n\\n`. The server brackets the stream with `{"type":"stream_open"}` and `{"type":"stream_close"}` control frames; `{"type":"error","message":"..."}` surfaces in-stream failures without collapsing the stream. Returns 409 `AGENT_BUSY` if another turn is already in flight for this project. Body field `scope` accepts "all" | "read-only"; omitted defaults to "read-only" (safe dashboard surface). The CLI passes "all" to keep write tools available.',
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

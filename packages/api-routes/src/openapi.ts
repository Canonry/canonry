import type { FastifyInstance } from 'fastify'
import { AGENT_PROVIDER_IDS } from '@ainyc/canonry-contracts'

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
  responses: Record<string, { description: string }>
}

const stringSchema = { type: 'string' }
const booleanSchema = { type: 'boolean' }
const integerSchema = { type: 'integer' }
const objectSchema = { type: 'object', additionalProperties: true }
const stringArraySchema = { type: 'array', items: stringSchema }
const googleConnectionTypeSchema = { type: 'string', enum: ['gsc', 'ga4'] }
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
      200: { description: 'OpenAPI document.' },
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
      200: { description: 'Project updated.' },
      201: { description: 'Project created.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects',
    summary: 'List projects',
    tags: ['projects'],
    responses: {
      200: { description: 'Projects returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}',
    summary: 'Get a project',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Project returned.' },
      404: { description: 'Project not found.' },
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
      404: { description: 'Project not found.' },
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
      201: { description: 'Location created.' },
      400: { description: 'Invalid location.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/locations',
    summary: 'List project locations',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Locations returned.' },
      404: { description: 'Project not found.' },
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
      400: { description: 'Invalid location.' },
      404: { description: 'Project or location not found.' },
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
      200: { description: 'Default location updated.' },
      400: { description: 'Invalid location.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/export',
    summary: 'Export a project as config',
    tags: ['projects'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Project configuration returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'List keywords',
    tags: ['keywords'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Keywords returned.' },
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Replace keywords',
    tags: ['keywords'],
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
      200: { description: 'Keywords replaced.' },
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Delete specific keywords',
    tags: ['keywords'],
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
      200: { description: 'Remaining keywords returned.' },
      400: { description: 'Invalid keyword delete request.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/keywords',
    summary: 'Append keywords',
    tags: ['keywords'],
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
      200: { description: 'Keywords appended.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/keywords/generate',
    summary: 'Generate keyword suggestions',
    tags: ['keywords'],
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
      200: { description: 'Keyword suggestions returned.' },
      501: { description: 'Keyword generation is not available.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/competitors',
    summary: 'List competitors',
    tags: ['competitors'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Competitors returned.' },
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
      200: { description: 'Competitors replaced.' },
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
      200: { description: 'Competitors appended.' },
      400: { description: 'Invalid competitor append request.' },
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
      200: { description: 'Remaining competitors returned.' },
      400: { description: 'Invalid competitor delete request.' },
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
              location: stringSchema,
              allLocations: booleanSchema,
              noLocation: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Run queued.' },
      409: { description: 'Run already in progress.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs',
    summary: 'List project runs',
    tags: ['runs'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: { description: 'Runs returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs/latest',
    summary: 'Get the latest project run',
    tags: ['runs'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Latest run returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/runs',
    summary: 'List all runs',
    tags: ['runs'],
    responses: {
      200: { description: 'Runs returned.' },
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
      207: { description: 'Run results returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/runs/{id}',
    summary: 'Get a run and its snapshots',
    tags: ['runs'],
    parameters: [runIdParameter],
    responses: {
      200: { description: 'Run returned.' },
      404: { description: 'Run not found.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/runs/{id}/cancel',
    summary: 'Cancel a queued or running run',
    tags: ['runs'],
    parameters: [runIdParameter],
    responses: {
      200: { description: 'Run cancelled.' },
      404: { description: 'Run not found.' },
      409: { description: 'Run is not cancellable.' },
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
      200: { description: 'Config applied.' },
      400: { description: 'Invalid config.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/history',
    summary: 'Get project audit history',
    tags: ['history'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Audit history returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/history',
    summary: 'Get global audit history',
    tags: ['history'],
    responses: {
      200: { description: 'Audit history returned.' },
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
      200: { description: 'Snapshots returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/timeline',
    summary: 'Get keyword timeline',
    tags: ['history'],
    parameters: [nameParameter, locationQueryParameter],
    responses: {
      200: { description: 'Timeline returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/metrics',
    summary: 'Get citation trend analytics',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'Citation metrics returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/gaps',
    summary: 'Get brand gap analysis',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'Gap analysis returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/analytics/sources',
    summary: 'Get source origin analytics',
    tags: ['analytics'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'Source breakdown returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Diff returned.' },
      400: { description: 'Missing run IDs.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/settings',
    summary: 'Get provider settings summary',
    tags: ['settings'],
    responses: {
      200: { description: 'Settings returned.' },
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
      200: { description: 'Provider updated.' },
      400: { description: 'Invalid provider settings.' },
      501: { description: 'Provider updates are not supported.' },
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
      200: { description: 'Google settings updated.' },
      400: { description: 'Invalid Google settings.' },
      501: { description: 'Google settings updates are not supported.' },
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
              phrases: stringArraySchema,
              competitors: stringArraySchema,
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Snapshot report returned.' },
      400: { description: 'Invalid snapshot input.' },
      501: { description: 'Snapshot reporting is not supported.' },
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
      200: { description: 'Bing settings updated.' },
      400: { description: 'Invalid Bing settings.' },
      501: { description: 'Bing settings updates are not supported.' },
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
      200: { description: 'CDP endpoint updated.' },
      400: { description: 'Invalid CDP settings.' },
      501: { description: 'CDP updates are not supported.' },
    },
  },
  {
    method: 'put',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Create or update a schedule',
    tags: ['schedules'],
    parameters: [nameParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              preset: stringSchema,
              cron: stringSchema,
              timezone: stringSchema,
              providers: stringArraySchema,
              enabled: booleanSchema,
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Schedule updated.' },
      201: { description: 'Schedule created.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Get a schedule',
    tags: ['schedules'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Schedule returned.' },
      404: { description: 'Schedule not found.' },
    },
  },
  {
    method: 'delete',
    path: '/api/v1/projects/{name}/schedule',
    summary: 'Delete a schedule',
    tags: ['schedules'],
    parameters: [nameParameter],
    responses: {
      204: { description: 'Schedule deleted.' },
      404: { description: 'Schedule not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/notifications/events',
    summary: 'List notification event types',
    tags: ['notifications'],
    responses: {
      200: { description: 'Events returned.' },
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
      201: { description: 'Notification created.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/notifications',
    summary: 'List notifications',
    tags: ['notifications'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Notifications returned.' },
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
      404: { description: 'Notification not found.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/notifications/{id}/test',
    summary: 'Send a test notification',
    tags: ['notifications'],
    parameters: [nameParameter, notificationIdParameter],
    responses: {
      200: { description: 'Test notification sent.' },
      400: { description: 'Stored notification config is invalid.' },
      404: { description: 'Notification not found.' },
      502: { description: 'Notification delivery failed.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/telemetry',
    summary: 'Get telemetry status',
    tags: ['telemetry'],
    responses: {
      200: { description: 'Telemetry status returned.' },
      501: { description: 'Telemetry status is not available.' },
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
      200: { description: 'Telemetry updated.' },
      400: { description: 'Invalid telemetry request.' },
      501: { description: 'Telemetry configuration is not available.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/screenshots/{snapshotId}',
    summary: 'Fetch a stored browser screenshot',
    tags: ['cdp'],
    parameters: [snapshotIdParameter],
    responses: {
      200: { description: 'Screenshot returned.' },
      404: { description: 'Screenshot not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/cdp/status',
    summary: 'Get CDP connection status',
    tags: ['cdp'],
    responses: {
      200: { description: 'CDP status returned.' },
      501: { description: 'CDP is not configured.' },
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
      200: { description: 'CDP screenshot results returned.' },
      400: { description: 'Invalid CDP screenshot request.' },
      501: { description: 'CDP screenshot support is not available.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/runs/{runId}/browser-diff',
    summary: 'Compare API and browser provider results for a run',
    tags: ['cdp', 'runs'],
    parameters: [nameParameter, projectRunIdParameter],
    responses: {
      200: { description: 'Browser diff returned.' },
      404: { description: 'Project or run not found.' },
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
      200: { description: 'OAuth callback handled.' },
      400: { description: 'Invalid callback request.' },
      500: { description: 'OAuth configuration is incomplete.' },
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
      200: { description: 'OAuth callback handled.' },
      400: { description: 'Invalid callback request.' },
      500: { description: 'OAuth configuration is incomplete.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/connections',
    summary: 'List Google connections for a project',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Google connections returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Google auth URL returned.' },
      400: { description: 'Invalid Google connection request.' },
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
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/properties',
    summary: 'List available Google Search Console properties',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Google properties returned.' },
      400: { description: 'Google OAuth is not configured.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Google property updated.' },
      400: { description: 'Invalid property request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Google sitemap updated.' },
      400: { description: 'Invalid sitemap request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'GSC sync run returned.' },
      400: { description: 'Invalid GSC sync request.' },
      404: { description: 'Project or connection not found.' },
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
      analyticsWindowParameter,
    ],
    responses: {
      200: { description: 'GSC performance rows returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'GSC inspection result returned.' },
      400: { description: 'Invalid inspection request.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/inspections',
    summary: 'List GSC URL inspections',
    tags: ['google'],
    parameters: [nameParameter, { name: 'url', in: 'query', description: 'Filter by URL.', schema: stringSchema }, limitQueryParameter],
    responses: {
      200: { description: 'GSC inspections returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/deindexed',
    summary: 'List GSC deindexed pages',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Deindexed pages returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/coverage',
    summary: 'Get GSC coverage summary',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'GSC coverage returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/coverage/history',
    summary: 'Get GSC coverage history',
    tags: ['google'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: { description: 'GSC coverage history returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/google/gsc/sitemaps',
    summary: 'List GSC sitemaps',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'GSC sitemaps returned.' },
      400: { description: 'Invalid sitemap request.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/google/gsc/discover-sitemaps',
    summary: 'Discover sitemaps and queue sitemap inspection',
    tags: ['google'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Discovered sitemaps and queued run returned.' },
      400: { description: 'Invalid sitemap discovery request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Sitemap inspection run returned.' },
      400: { description: 'Invalid sitemap inspection request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Indexing request results returned.' },
      400: { description: 'Invalid indexing request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Bing connection returned.' },
      400: { description: 'Invalid Bing connection request.' },
      404: { description: 'Project not found.' },
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
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/status',
    summary: 'Get Bing connection status',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Bing status returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/sites',
    summary: 'List Bing sites for the current connection',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Bing sites returned.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Active Bing site updated.' },
      400: { description: 'Invalid Bing site request.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/coverage',
    summary: 'Get Bing index coverage',
    tags: ['bing'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Bing coverage returned.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/coverage/history',
    summary: 'Get Bing coverage history snapshots',
    tags: ['bing'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: { description: 'Bing coverage history returned.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/inspections',
    summary: 'List Bing URL inspections',
    tags: ['bing'],
    parameters: [nameParameter, { name: 'url', in: 'query', description: 'Filter by URL.', schema: stringSchema }, limitQueryParameter],
    responses: {
      200: { description: 'Bing inspections returned.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Bing inspection result returned.' },
      400: { description: 'Invalid inspection request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Sitemap inspection run queued.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Bing indexing request results returned.' },
      400: { description: 'Invalid indexing request.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/bing/performance',
    summary: 'Get Bing keyword performance',
    tags: ['bing'],
    parameters: [nameParameter, limitQueryParameter],
    responses: {
      200: { description: 'Bing performance returned.' },
      400: { description: 'Bing is not configured for this project.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'WordPress connection status returned.' },
      400: { description: 'Invalid WordPress connection request.' },
      404: { description: 'Project not found.' },
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
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/status',
    summary: 'Get WordPress connection status',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'WordPress status returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/pages',
    summary: 'List WordPress pages',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'WordPress pages returned.' },
      400: { description: 'Invalid environment or missing connection.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/page',
    summary: 'Get a WordPress page by slug',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'WordPress page returned.' },
      400: { description: 'Invalid slug or environment.' },
      404: { description: 'Project, connection, or page not found.' },
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
      200: { description: 'WordPress page created.' },
      400: { description: 'Invalid page creation request.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'WordPress page updated.' },
      400: { description: 'Invalid page update request.' },
      404: { description: 'Project, connection, or page not found.' },
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
      200: { description: 'WordPress SEO meta updated.' },
      400: { description: 'SEO meta is unsupported or the request is invalid.' },
      404: { description: 'Project, connection, or page not found.' },
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
      200: { description: 'Bulk SEO meta update results returned.' },
      400: { description: 'Invalid entries or environment.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/schema',
    summary: 'Read rendered JSON-LD schema for a page',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'WordPress schema blocks returned.' },
      400: { description: 'Invalid slug or environment.' },
      404: { description: 'Project, connection, or page not found.' },
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
      200: { description: 'Manual schema instructions returned.' },
      400: { description: 'Invalid schema request.' },
      404: { description: 'Project, connection, or page not found.' },
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
      200: { description: 'Schema deployment results returned.' },
      400: { description: 'Invalid profile or environment.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/schema/status',
    summary: 'Get JSON-LD schema status for all pages',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'Schema status per page returned.' },
      400: { description: 'Invalid environment.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/llms-txt',
    summary: 'Read /llms.txt for a WordPress environment',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'llms.txt returned.' },
      400: { description: 'Invalid environment or missing connection.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Manual llms.txt instructions returned.' },
      400: { description: 'Invalid llms.txt request.' },
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/audit',
    summary: 'Audit WordPress pages for SEO and content issues',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressEnvQueryParameter],
    responses: {
      200: { description: 'WordPress audit returned.' },
      400: { description: 'Invalid environment or missing connection.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/diff',
    summary: 'Compare live and staging versions of a WordPress page',
    tags: ['wordpress'],
    parameters: [nameParameter, wordpressSlugQueryParameter],
    responses: {
      200: { description: 'WordPress diff returned.' },
      400: { description: 'Invalid slug or missing staging configuration.' },
      404: { description: 'Project, connection, or page not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/wordpress/staging/status',
    summary: 'Get WordPress staging configuration status',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'WordPress staging status returned.' },
      400: { description: 'WordPress is not configured for this project.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'post',
    path: '/api/v1/projects/{name}/wordpress/staging/push',
    summary: 'Generate a manual staging push handoff',
    tags: ['wordpress'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Manual staging push instructions returned.' },
      400: { description: 'Missing staging configuration.' },
      404: { description: 'Project or connection not found.' },
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
      200: { description: 'Onboarding result with step-by-step status.' },
      400: { description: 'Invalid onboarding request.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'GA4 connection established.' },
      400: { description: 'Invalid GA4 connection request.' },
      404: { description: 'Project not found.' },
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
      404: { description: 'Project or connection not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/status',
    summary: 'Get GA4 connection status',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'GA4 status returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'GA4 sync completed.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/traffic',
    summary: 'Get GA4 landing page traffic and AI referral sources',
    tags: ['ga4'],
    parameters: [nameParameter, limitQueryParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'GA4 traffic data returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/ai-referral-history',
    summary: 'Get AI referral sessions per day grouped by source',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'AI referral history returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/social-referral-history',
    summary: 'Get social media referral sessions per day grouped by source',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'Social referral history returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/social-referral-trend',
    summary: 'Get social referral trend (7d/30d) with biggest mover',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Social referral trend returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/attribution-trend',
    summary: 'Get per-channel attribution trends (7d/30d) for organic, AI, and social',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Attribution trend returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/session-history',
    summary: 'Get total sessions per day for the project',
    tags: ['ga4'],
    parameters: [nameParameter, analyticsWindowParameter],
    responses: {
      200: { description: 'Session history returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/ga/coverage',
    summary: 'Get GA4 page coverage with traffic overlay',
    tags: ['ga4'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'GA4 coverage data returned.' },
      400: { description: 'GA4 is not connected.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Insights returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Insight returned.' },
      404: { description: 'Insight not found.' },
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
      200: { description: 'Insight dismissed.' },
      404: { description: 'Insight not found.' },
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
      200: { description: 'Health snapshot or no-data sentinel returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Health history returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Targets returned.' },
      400: { description: 'Invalid limit.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Sources returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Gaps returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/overview',
    summary: 'Get a composite overview of project health',
    description:
      'Bundles project info, latest run, top undismissed insights, the latest health snapshot, keyword cited rate, per-provider breakdown, and transitions vs. the previous run. Designed for the "how is project X doing?" question so agents can answer in one call.',
    tags: ['intelligence'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Overview returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/search',
    summary: 'Search query snapshots and insights for text',
    description:
      'Returns the most recent snapshots and insights whose answer text, cited domains, raw response, or insight title/keyword/recommendation/cause matches the query. Use to find anything mentioning a competitor, term, or URL without paginating snapshots.',
    tags: ['intelligence'],
    parameters: [
      nameParameter,
      { name: 'q', in: 'query', required: true, description: 'Search term (>= 2 chars).', schema: stringSchema },
      { name: 'limit', in: 'query', description: 'Max combined hits (1-50, default 25).', schema: stringSchema },
    ],
    responses: {
      200: { description: 'Search hits returned.' },
      400: { description: 'Query string missing or too short.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Doctor report returned.' },
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
      200: { description: 'Doctor report returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Install status returned.' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
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
      200: { description: 'Installed (or already present).' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
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
      200: { description: 'Existing in-flight sync returned.' },
      201: { description: 'Sync queued.' },
      400: { description: 'Invalid release id.' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/syncs',
    summary: 'List Common Crawl release syncs',
    description: 'Returns syncs ordered by updatedAt DESC — re-queued rows surface ahead of untouched newer rows.',
    tags: ['backlinks'],
    responses: {
      200: { description: 'Sync history returned.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/syncs/latest',
    summary: 'Get the most recently-updated Common Crawl release sync',
    tags: ['backlinks'],
    responses: {
      200: { description: 'Latest sync returned, or null when no sync exists.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/backlinks/releases',
    summary: 'List cached Common Crawl releases on the local filesystem',
    tags: ['backlinks'],
    responses: {
      200: { description: 'Cached release metadata returned.' },
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
      200: { description: 'Latest available release, or null when no candidate slug responded.' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
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
      200: { description: 'Cache pruned.' },
      400: { description: 'Invalid release id.' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
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
      201: { description: 'Extract run queued.' },
      400: { description: 'Invalid release id.' },
      404: { description: 'Project not found.' },
      422: { description: 'Backlinks feature is not available on this deployment.' },
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
      200: { description: 'Summary returned, or null when no backlinks exist.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Domain list returned.' },
      404: { description: 'Project not found.' },
    },
  },
  {
    method: 'get',
    path: '/api/v1/projects/{name}/backlinks/history',
    summary: 'Get per-release backlink summaries for a project',
    tags: ['backlinks'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'History returned oldest-first by queriedAt.' },
      404: { description: 'Project not found.' },
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
const canonryLocalRouteCatalog: OpenApiOperation[] = [
  {
    method: 'get',
    path: '/api/v1/projects/{name}/agent/transcript',
    summary: 'Get the rolling Aero transcript for this project',
    description:
      'Returns the full message history of the project-scoped Aero session plus the persisted model provider/id and last-updated timestamp. Empty messages array when the project has no session yet.',
    tags: ['agent'],
    parameters: [nameParameter],
    responses: {
      200: { description: 'Transcript returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Session reset.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Memory entries returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Entry upserted.' },
      400: { description: 'Validation failed (key length, value size, reserved prefix).' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Entry removed or already absent.' },
      400: { description: 'Validation failed (reserved prefix).' },
      404: { description: 'Project not found.' },
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
      200: { description: 'Providers returned.' },
      404: { description: 'Project not found.' },
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
      200: { description: 'SSE stream of AgentEvent frames.' },
      400: { description: 'Missing or empty prompt.' },
      404: { description: 'Project not found.' },
      409: { description: 'Another Aero turn is already in flight.' },
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

  return {
    openapi: '3.1.0',
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
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, char: string) => char.toUpperCase())
    .replace(/^[^a-zA-Z]+/, '')
}

import type { FastifyInstance } from 'fastify'

export interface OpenApiInfo {
  title?: string
  version?: string
  description?: string
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
  schema: { type: 'string', enum: ['gemini', 'openai', 'claude', 'local'] },
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
              provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'local'] },
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
]

export function buildOpenApiDocument(info: OpenApiInfo = {}) {
  const paths = routeCatalog.reduce<Record<string, Record<string, unknown>>>((acc, route) => {
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

    const pathItem = acc[route.path] ?? {}
    pathItem[route.method] = operation
    acc[route.path] = pathItem
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

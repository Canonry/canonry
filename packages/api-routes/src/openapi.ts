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
              country: stringSchema,
              language: stringSchema,
              tags: stringArraySchema,
              labels: objectSchema,
              providers: stringArraySchema,
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
    parameters: [nameParameter],
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
      {
        name: 'limit',
        in: 'query',
        description: 'Maximum number of snapshots to return.',
        schema: integerSchema,
      },
      {
        name: 'offset',
        in: 'query',
        description: 'Number of snapshots to skip.',
        schema: integerSchema,
      },
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
    parameters: [nameParameter],
    responses: {
      200: { description: 'Timeline returned.' },
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
      description: info.description ?? 'REST API for Canonry projects, runs, schedules, and notifications.',
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

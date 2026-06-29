import type { FastifyInstance, FastifyRequest } from 'fastify'

const TEST_LOCATIONS = new Set(['nyc', 'lax', 'chi'])

export interface TelemetryCollectorEvent {
  anonymousId?: unknown
  sessionId?: unknown
  source?: unknown
  event?: unknown
  timestamp?: unknown
  version?: unknown
  properties?: Record<string, unknown>
}

export interface TelemetryCollectorOptions {
  writeTelemetryTest?: (event: TelemetryCollectorEvent, request: FastifyRequest) => void | Promise<void>
}

function asTelemetryCollectorEvent(value: unknown): TelemetryCollectorEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as TelemetryCollectorEvent
}

export function isGhostTelemetryEvent(event: TelemetryCollectorEvent): boolean {
  if (event.event !== 'run.completed' && event.event !== 'run.aborted') return false
  const properties = event.properties
  if (!properties) return false
  if (properties.providerCount !== 0) return false
  const location = typeof properties.location === 'string'
    ? properties.location.trim().toLowerCase()
    : ''
  return TEST_LOCATIONS.has(location)
}

export function registerTelemetryCollectorRoutes(
  app: FastifyInstance,
  opts: TelemetryCollectorOptions = {},
): void {
  app.post<{ Body: unknown }>('/api/telemetry', async (request, reply) => {
    const event = asTelemetryCollectorEvent(request.body)

    if (isGhostTelemetryEvent(event)) {
      if (opts.writeTelemetryTest) {
        await opts.writeTelemetryTest(event, request)
      } else {
        request.log.info(
          {
            collection: 'telemetry_test',
            event,
          },
          'dropped test telemetry event',
        )
      }
      return reply.send({ ok: true, accepted: false })
    }

    return reply.send({ ok: true, accepted: true })
  })
}

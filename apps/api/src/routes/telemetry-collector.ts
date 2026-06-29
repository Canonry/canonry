import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isGhostTelemetryEvent } from '@ainyc/canonry-contracts'

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

export function registerTelemetryCollectorRoutes(
  app: FastifyInstance,
  opts: TelemetryCollectorOptions = {},
): void {
  app.post<{ Body: unknown }>('/api/telemetry', async (request, reply) => {
    const event = asTelemetryCollectorEvent(request.body)

    if (isGhostTelemetryEvent(event.event, event.properties)) {
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

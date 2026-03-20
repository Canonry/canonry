import type { FastifyInstance } from 'fastify'
import { notImplemented, validationError } from '@ainyc/canonry-contracts'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => { enabled: boolean; anonymousId?: string }
  setTelemetryEnabled?: (enabled: boolean) => void
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async (_request, reply) => {
    if (!opts.getTelemetryStatus) {
      const err = notImplemented('Telemetry status is not available in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const status = opts.getTelemetryStatus()
    return {
      enabled: status.enabled,
      anonymousId: status.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })

  app.put<{ Body: { enabled: boolean } }>('/telemetry', async (request, reply) => {
    if (!opts.setTelemetryEnabled) {
      const err = notImplemented('Telemetry configuration is not available in this deployment')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      const err = validationError('enabled (boolean) is required')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    opts.setTelemetryEnabled(enabled)
    const status = opts.getTelemetryStatus?.()
    return {
      enabled: status?.enabled ?? enabled,
      anonymousId: status?.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })
}

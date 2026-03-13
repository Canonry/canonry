import type { FastifyInstance } from 'fastify'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => { enabled: boolean; anonymousId?: string }
  setTelemetryEnabled?: (enabled: boolean) => void
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async (_request, reply) => {
    if (!opts.getTelemetryStatus) {
      return reply.status(501).send({ error: 'Telemetry status is not available in this deployment' })
    }

    const status = opts.getTelemetryStatus()
    return {
      enabled: status.enabled,
      anonymousId: status.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })

  app.put<{ Body: { enabled: boolean } }>('/telemetry', async (request, reply) => {
    if (!opts.setTelemetryEnabled) {
      return reply.status(501).send({ error: 'Telemetry configuration is not available in this deployment' })
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled (boolean) is required' })
    }

    opts.setTelemetryEnabled(enabled)
    const status = opts.getTelemetryStatus?.()
    return {
      enabled: status?.enabled ?? enabled,
      anonymousId: status?.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })
}

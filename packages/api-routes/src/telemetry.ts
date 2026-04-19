import type { FastifyInstance } from 'fastify'
import { notImplemented, validationError } from '@ainyc/canonry-contracts'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => { enabled: boolean; anonymousId?: string }
  setTelemetryEnabled?: (enabled: boolean) => void
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async () => {
    if (!opts.getTelemetryStatus) {
      throw notImplemented('Telemetry status is not available in this deployment')
    }

    const status = opts.getTelemetryStatus()
    return {
      enabled: status.enabled,
      anonymousId: status.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })

  app.put<{ Body: { enabled: boolean } }>('/telemetry', async (request) => {
    if (!opts.setTelemetryEnabled) {
      throw notImplemented('Telemetry configuration is not available in this deployment')
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      throw validationError('enabled (boolean) is required')
    }

    opts.setTelemetryEnabled(enabled)
    const status = opts.getTelemetryStatus?.()
    return {
      enabled: status?.enabled ?? enabled,
      anonymousId: status?.anonymousId ? status.anonymousId.slice(0, 8) + '...' : undefined,
    }
  })
}

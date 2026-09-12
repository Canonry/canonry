import type { FastifyInstance } from 'fastify'
import {
  notImplemented,
  normalizeTelemetryStatus,
  normalizeOnboardingEventForCollection,
  onboardingTelemetryEventSchema,
  validationError,
  type OnboardingTelemetryEvent,
  type TelemetryStatusInput,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => TelemetryStatusInput
  setTelemetryEnabled?: (enabled: boolean) => void
  recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async () => {
    if (!opts.getTelemetryStatus) {
      throw notImplemented('Telemetry status is not available in this deployment')
    }

    return normalizeTelemetryStatus(opts.getTelemetryStatus())
  })

  app.put<{ Body?: { enabled?: boolean } }>('/telemetry', async (request) => {
    requireScope(request, SETTINGS_WRITE_SCOPE)
    if (!opts.setTelemetryEnabled) {
      throw notImplemented('Telemetry configuration is not available in this deployment')
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      throw validationError('enabled (boolean) is required')
    }

    opts.setTelemetryEnabled(enabled)
    const status = opts.getTelemetryStatus?.()
    const effective = normalizeTelemetryStatus(status ?? { enabled })

    // The host persists config and this route persists audit history in
    // separate stores. Do not report a successful setting change as failed
    // merely because the best-effort audit insert is unavailable.
    if (app.hasDecorator('db')) {
      try {
        writeAuditLog(app.db, auditFromRequest(request, {
          actor: 'api',
          action: 'telemetry.updated',
          entityType: 'telemetry',
          diff: {
            target: effective.target,
            configuredEnabled: effective.configuredEnabled,
            reason: effective.reason,
          },
        }))
      } catch {
        app.log.warn({ action: 'telemetry.updated' }, 'Telemetry setting audit write failed')
      }
    }
    return effective
  })

  app.post<{ Body: unknown }>('/telemetry/onboarding', async (request, reply) => {
    const parsed = onboardingTelemetryEventSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid onboarding telemetry event', {
        issues: parsed.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path.join('.'),
        })),
      })
    }

    // Missing wiring is a supported deployment posture. The dashboard should
    // never fail onboarding because its host does not collect product
    // telemetry (for example, apps/api or an opted-out local instance).
    opts.recordOnboardingEvent?.(normalizeOnboardingEventForCollection(parsed.data))
    return reply.status(202).send({ accepted: Boolean(opts.recordOnboardingEvent) })
  })
}

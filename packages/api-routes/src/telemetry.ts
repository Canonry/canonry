import type { FastifyInstance } from 'fastify'
import {
  notImplemented,
  maskTelemetryAnonymousId,
  normalizeOnboardingEventForCollection,
  onboardingTelemetryEventSchema,
  telemetryEffectiveReasonSchema,
  telemetryStatusDtoSchema,
  validationError,
  type OnboardingTelemetryEvent,
  type TelemetryEffectiveReason,
  type TelemetryStatusDto,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'

type LegacyTelemetryStatus = Pick<TelemetryStatusDto, 'enabled'> & Partial<Omit<TelemetryStatusDto, 'enabled'>>

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => LegacyTelemetryStatus
  setTelemetryEnabled?: (enabled: boolean) => void
  recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void
}

/** Map older host callbacks to the additive effective-state response safely. */
function toTelemetryStatus(status: LegacyTelemetryStatus, target: 'server' | 'local' = 'server'): TelemetryStatusDto {
  const configuredEnabled = status.configuredEnabled ?? status.enabled
  const fallbackReason: TelemetryEffectiveReason = status.enabled ? 'enabled' : 'configured_disabled'
  const parsedReason = telemetryEffectiveReasonSchema.safeParse(status.reason)
  const anonymousId = maskTelemetryAnonymousId(status.anonymousId)
  return telemetryStatusDtoSchema.parse({
    enabled: status.enabled,
    configuredEnabled,
    reason: parsedReason.success ? parsedReason.data : fallbackReason,
    target,
    ...(anonymousId ? { anonymousId } : {}),
  })
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async () => {
    if (!opts.getTelemetryStatus) {
      throw notImplemented('Telemetry status is not available in this deployment')
    }

    return toTelemetryStatus(opts.getTelemetryStatus())
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
    const effective = toTelemetryStatus(status ?? { enabled })

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

import type { FastifyInstance } from 'fastify'
import {
  notImplemented,
  normalizeTelemetryStatus,
  normalizeOnboardingEventForCollection,
  onboardingTelemetryEventSchema,
  validationError,
  type OnboardingTelemetryEvent,
  type TelemetryStatusInput,
  type UiTelemetryEvent,
  uiTelemetryEventSchema,
} from '@ainyc/canonry-contracts'
import { requireOperator, requireScope } from './auth.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { currentOutcomeAttribution, type OutcomeAttribution } from './outcome-telemetry.js'

export interface TelemetryRoutesOptions {
  getTelemetryStatus?: () => TelemetryStatusInput
  /** `attribution` is who asked, for the `telemetry.disabled` event's surface and agent. */
  setTelemetryEnabled?: (enabled: boolean, attribution?: OutcomeAttribution) => void
  recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void
  /**
   * Dashboard usage: page views, feature actions, UI errors, web vitals.
   * Returns whether the event was accepted: `false` while telemetry is off or
   * the host's rate limit is spent, which tells the dashboard to stop sending.
   */
  recordUiEvent?: (event: UiTelemetryEvent) => boolean
}

export async function telemetryRoutes(app: FastifyInstance, opts: TelemetryRoutesOptions) {
  app.get('/telemetry', async (request) => {
    requireOperator(request)
    if (!opts.getTelemetryStatus) {
      throw notImplemented('Telemetry status is not available in this deployment')
    }

    return normalizeTelemetryStatus(opts.getTelemetryStatus())
  })

  app.put<{ Body?: { enabled?: boolean } }>('/telemetry', async (request) => {
    requireOperator(request)
    requireScope(request, SETTINGS_WRITE_SCOPE)
    if (!opts.setTelemetryEnabled) {
      throw notImplemented('Telemetry configuration is not available in this deployment')
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      throw validationError('enabled (boolean) is required')
    }

    opts.setTelemetryEnabled(enabled, currentOutcomeAttribution())
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

  app.post<{ Body: unknown }>('/telemetry/ui', async (request, reply) => {
    const parsed = uiTelemetryEventSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid UI telemetry event', {
        issues: parsed.error.issues.map(issue => ({
          code: issue.code,
          path: issue.path.join('.'),
        })),
      })
    }

    // A host that does not collect telemetry (apps/api), an opted-out local
    // instance, or one past its rate limit answers accepted:false, and the
    // dashboard stops sending for the session.
    const accepted = opts.recordUiEvent ? opts.recordUiEvent(parsed.data) : false
    return reply.status(202).send({ accepted })
  })
}

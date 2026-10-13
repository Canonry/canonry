import {
  bucketDuration,
  classifyOutcomeError,
  normalizeAgentSlug,
  outcomeSurfaceSchema,
  PROVIDER_NAMES,
  type ConnectionStatus,
  type IntegrationConnectionProperties,
  type OutcomeReasonCode,
  type OutcomeSurface,
  type WebhookTarget,
} from '@ainyc/canonry-contracts'
import type { FastifyInstance } from 'fastify'
import { getRequestContext } from './request-context.js'
import { resolveDestination, type WebhookDestination } from './notifications/destinations.js'
import type { ResolveWebhookTargetResult } from './webhooks.js'

/** What a connection attempt is about; the status and reason come from how it ends. */
export type ConnectionSubject = Pick<IntegrationConnectionProperties, 'integration' | 'action' | 'provider' | 'target' | 'surface' | 'agent'>

type OutcomeProvider = NonNullable<IntegrationConnectionProperties['provider']>

const PROVIDER_NAME_SET: ReadonlySet<string> = new Set(PROVIDER_NAMES)

/** The provider name as the outcome schema knows it, or undefined for a name it does not. */
export function outcomeProviderName(name: string): OutcomeProvider | undefined {
  return PROVIDER_NAME_SET.has(name) ? (name as OutcomeProvider) : undefined
}

/** A read made only for telemetry (is there a connection to replace?); it never fails the route. */
export function telemetryRead<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** Route error codes whose HTTP status says less than the code itself. */
const APP_ERROR_REASONS: Readonly<Record<string, OutcomeReasonCode>> = {
  NOT_IMPLEMENTED: 'UNSUPPORTED',
  INTERNAL_ERROR: 'INTERNAL',
  MISSING_DEPENDENCY: 'UNSUPPORTED',
}

/**
 * A reason code and error class name for a caught error, never its message.
 * A route's FORBIDDEN is Canonry's own gate (scope, role, browser-only), unless
 * it carries the upstream status of a provider that refused.
 */
export function routeOutcomeFailure(err: unknown, reasonCode?: OutcomeReasonCode): { reasonCode: OutcomeReasonCode; errorName?: string } {
  const classified = classifyOutcomeError(err)
  if (reasonCode) return { ...classified, reasonCode }
  const { code, details } = err && typeof err === 'object' ? (err as { code?: unknown; details?: { upstreamStatus?: unknown } }) : {}
  if (code === 'FORBIDDEN') {
    const upstreamStatus = details?.upstreamStatus
    return {
      ...classified,
      reasonCode: typeof upstreamStatus === 'number' ? classifyOutcomeError({ status: upstreamStatus }).reasonCode : 'GATE_REFUSED',
    }
  }
  const mapped = typeof code === 'string' ? APP_ERROR_REASONS[code] : undefined
  return { ...classified, reasonCode: mapped ?? classified.reasonCode }
}

const DESTINATION_TARGETS: Readonly<Record<WebhookDestination, WebhookTarget>> = {
  'first-party': 'first_party',
  discord: 'discord',
  slack: 'slack',
}

/** The webhook destination kind for a URL, never the URL. */
export function webhookOutcomeTarget(rawUrl: string): WebhookTarget {
  return DESTINATION_TARGETS[resolveDestination(rawUrl).destination]
}

/** Why a webhook URL check refused a destination. */
export function webhookTargetRefusalReason(check: Extract<ResolveWebhookTargetResult, { ok: false }>): OutcomeReasonCode {
  if (check.blocked) return 'BLOCKED_UNSAFE_URL'
  if (check.unresolved) return 'NETWORK'
  return 'VALIDATION'
}

/** Why a delivered webhook did not succeed, from its HTTP status (0 when nothing answered). */
export function webhookResponseReason(result: { status: number; timedOut?: boolean }): OutcomeReasonCode | undefined {
  if (result.status >= 200 && result.status < 300) return undefined
  if (result.status === 0) return result.timedOut ? 'TIMEOUT' : 'NETWORK'
  if (result.status >= 500) return 'HTTP_5XX'
  if (result.status >= 400) return 'HTTP_4XX'
  // The sender never follows a redirect, so a 3xx destination cannot receive deliveries.
  return 'UNSUPPORTED'
}

/**
 * The surface and agent labels of the current request, validated, for an
 * OAuth flow to carry through its signed state: the browser that finishes the
 * flow is not the surface that started it.
 */
export function oauthStartAttribution(): { surface?: OutcomeSurface; agent?: string } {
  const context = getRequestContext()
  const surface = outcomeSurfaceSchema.safeParse(context?.usageSurface)
  const agent = normalizeAgentSlug(context?.usageAgent)
  return {
    ...(surface.success ? { surface: surface.data } : {}),
    ...(agent ? { agent } : {}),
  }
}

/** Read back what `oauthStartAttribution` put in a verified state. */
export function oauthStateAttribution(state: Record<string, unknown> | null | undefined): { surface?: OutcomeSurface; agent?: string } {
  if (!state) return {}
  const surface = outcomeSurfaceSchema.safeParse(state.surface)
  const agent = typeof state.agent === 'string' ? normalizeAgentSlug(state.agent) : null
  return {
    ...(surface.success ? { surface: surface.data } : {}),
    ...(agent ? { agent } : {}),
  }
}

/**
 * One field of an OAuth state's payload WITHOUT checking its signature, for
 * telemetry only: it names which integration an invalid or expired state was
 * for. Callers must map the value onto a closed enum and never trust it.
 */
export function unverifiedOAuthStateField(encoded: string | undefined, field: string): string | undefined {
  if (!encoded || encoded.length > 8_192) return undefined
  try {
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { payload?: unknown }
    if (typeof envelope.payload !== 'string') return undefined
    const value = (JSON.parse(envelope.payload) as Record<string, unknown>)[field]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export interface ConnectionAttempt {
  /** Refine the subject once the route knows more (an existing connection makes it a reauth). */
  update(patch: Partial<ConnectionSubject>): void
  /** A redirect flow began; the callback reports the result. */
  started(): void
  succeeded(): void
  failed(err: unknown, reasonCode?: OutcomeReasonCode): void
  cancelled(reasonCode: OutcomeReasonCode): void
  /** A later request reports the outcome (an OAuth confirmation step), so report nothing here. */
  deferred(): void
}

const NO_ATTEMPT: ConnectionAttempt = {
  update: () => {},
  started: () => {},
  succeeded: () => {},
  failed: () => {},
  cancelled: () => {},
  deferred: () => {},
}

/**
 * Track one `integration.connection` attempt. The first outcome wins, so a
 * route can report a specific reason before it throws a generic error. Never
 * throws, and a host without `emitOutcome` (a route registered on its own in a
 * test) makes it a no-op.
 */
export function startConnectionAttempt(app: FastifyInstance, subject: ConnectionSubject | undefined, now: () => number = Date.now): ConnectionAttempt {
  if (!subject) return NO_ATTEMPT
  const startedAt = now()
  let current: ConnectionSubject = { ...subject }
  let reported = false
  const report = (status: ConnectionStatus, failure?: { reasonCode: OutcomeReasonCode; errorName?: string }) => {
    if (reported) return
    reported = true
    try {
      const emit = (app as Partial<Pick<FastifyInstance, 'emitOutcome'>>).emitOutcome
      if (typeof emit !== 'function') return
      const properties: IntegrationConnectionProperties = {
        ...current,
        status,
        ...failure,
        ...(status === 'started' ? {} : { durationBucket: bucketDuration(now() - startedAt) }),
      }
      // Absent fields are omitted, never sent as undefined or null.
      for (const key of Object.keys(properties) as Array<keyof IntegrationConnectionProperties>) {
        if (properties[key] === undefined) delete properties[key]
      }
      emit.call(app, { event: 'integration.connection', properties })
    } catch {
      // Outcome telemetry never changes a response.
    }
  }
  return {
    update: (patch) => { current = { ...current, ...patch } },
    started: () => report('started'),
    succeeded: () => report('succeeded'),
    failed: (err, reasonCode) => report('failed', routeOutcomeFailure(err, reasonCode)),
    cancelled: (reasonCode) => report('cancelled', { reasonCode }),
    deferred: () => { reported = true },
  }
}

/**
 * Wrap a route handler as one attempt: it succeeded unless it throws, and a
 * throw is the failure. `subjectOf` returning undefined (an integration the
 * request does not name) reports nothing. The handler can report a more
 * specific outcome first through its `attempt`.
 */
export function connectionRoute<Request, Reply, Result>(
  app: FastifyInstance,
  subjectOf: (request: Request) => ConnectionSubject | undefined,
  handler: (request: Request, reply: Reply, attempt: ConnectionAttempt) => Promise<Result>,
): (request: Request, reply: Reply) => Promise<Result> {
  return async (request, reply) => {
    let subject: ConnectionSubject | undefined
    try {
      subject = subjectOf(request)
    } catch {
      subject = undefined
    }
    const attempt = startConnectionAttempt(app, subject)
    try {
      const result = await handler(request, reply, attempt)
      attempt.succeeded()
      return result
    } catch (err) {
      attempt.failed(err)
      throw err
    }
  }
}

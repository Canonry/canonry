import { AsyncLocalStorage } from 'node:async_hooks'
import { redactLogString, USAGE_TELEMETRY_HEADERS } from '@ainyc/canonry-contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { OutcomeAttribution } from './outcome-telemetry.js'

/**
 * Durable, non-secret request correlation that can safely accompany an audit
 * row or a runtime log entry. This intentionally never retains the Fastify
 * request: a request object can hold credentials and body data long after the
 * operation that needed it has completed.
 */
export interface RequestContext {
  requestId?: string
  actor?: string
  credentialId?: string
  userAgent?: string
  actorSession?: string
  method?: string
  route?: string
  statusCode?: number
  /** Raw `x-canonry-surface` / `x-canonry-agent` labels for outcome attribution; never identity. */
  usageSurface?: string
  usageAgent?: string
  /** Stable code of the error that failed this request (`NOT_FOUND`, `FST_ERR_VALIDATION`), never its message. */
  errorCode?: string
}

const requestContext = new AsyncLocalStorage<RequestContext & { completed?: boolean }>()
const MAX_REQUEST_CONTEXT_LENGTH = 512
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/
const MAX_ERROR_BODY_BYTES = 16_384

/** `error.code` from a serialized `{ error: { code } }` body, or undefined; never reads anything else. */
function errorCodeOfBody(payload: unknown): string | undefined {
  const text = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : undefined
  if (!text || text.length > MAX_ERROR_BODY_BYTES || !text.trimStart().startsWith('{')) return undefined
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code
    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Active HTTP context only. A request-bound logger may retain its own completed
 * context for completion logs; unrelated background continuations may not.
 */
export function getRequestContext(boundRequestId?: string): RequestContext | undefined {
  const context = requestContext.getStore()
  if (!context || (context.completed && context.requestId !== boundRequestId)) return undefined
  const { completed: _completed, ...safeContext } = context
  return safeContext
}

/** The current request's raw attribution labels, or undefined outside a request. */
export function currentOutcomeAttribution(): OutcomeAttribution | undefined {
  const context = getRequestContext()
  return context
    ? { userAgent: context.userAgent, surfaceLabel: context.usageSurface, agentLabel: context.usageAgent }
    : undefined
}

/**
 * Resolve an audit identity only from authentication state already attached by
 * authPlugin. Headers deliberately do not participate in identity selection.
 */
export function requestAuditIdentity(
  request: Pick<FastifyRequest, 'principal' | 'apiKey'>,
): Pick<RequestContext, 'actor' | 'credentialId'> {
  const principal = request.principal
  if (!principal) return {}

  // A delegated MCP key acts for the named account, but the actual key is
  // still recorded as the credential used for the request.
  if (principal.delegatedUser) {
    return {
      actor: `user:${principal.delegatedUser.id}`,
      credentialId: request.apiKey?.id ?? principal.id,
    }
  }
  if (principal.kind === 'user') return { actor: `user:${principal.id}` }
  return {
    actor: `api-key:${principal.id}`,
    credentialId: request.apiKey?.id ?? principal.id,
  }
}

/**
 * What a completed request can tell usage telemetry, and nothing more: the
 * route TEMPLATE (never a URL, parameter, or query string), the outcome, and
 * the caller-supplied usage labels. The labels are unvalidated here; the host
 * that turns them into telemetry must validate them, and they must never be
 * read as identity.
 */
export interface ApiRequestCompletedInfo {
  method: string
  route: string
  statusCode: number
  durationMs: number
  /** Stable code of the error that failed the request, when one was thrown. */
  errorCode?: string
  userAgent?: string
  actorSession?: string
  principalKind?: 'user' | 'api-key'
  usageLabels: {
    surface?: string
    agent?: string
    mcpClient?: string
    mcpTool?: string
    mcpCall?: string
  }
}

export interface RequestContextOptions {
  /** Called once per completed request with a matched route. Must not throw; failures are swallowed. */
  onRequestCompleted?: (info: ApiRequestCompletedInfo) => void
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return first ? first.slice(0, MAX_REQUEST_CONTEXT_LENGTH) : undefined
}

/**
 * Register the request scope before authPlugin. The callback-style onRequest
 * hook is important: Fastify resumes the rest of its lifecycle through
 * `done`, preserving this AsyncLocalStorage scope for concurrent requests.
 */
export function registerRequestContext(app: FastifyInstance, options: RequestContextOptions = {}): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    requestContext.run({
      requestId: sanitizeRequestContext(request.id) ?? undefined,
      userAgent: sanitizeRequestContext(request.headers['user-agent']) ?? undefined,
      actorSession: sanitizeRequestContext(request.headers['x-canonry-actor-session']) ?? undefined,
      method: request.method,
      // Route template only, never a raw URL, query string, or route parameter.
      route: request.routeOptions.url,
      usageSurface: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.surface]),
      usageAgent: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.agent]),
    }, done)
  })

  // authPlugin's onRequest hook has completed by preHandler. Mutating only
  // this request's store means code further down the async chain sees the
  // final trusted identity without retaining request or credential material.
  app.addHook('preHandler', (request, _reply, done) => {
    populateIdentity(request)
    done()
  })
  // Authorization or validation may reject an authenticated caller before
  // preHandler. Completion/error diagnostics still need the trusted identity.
  app.addHook('onError', (request, _reply, error, done) => {
    populateIdentity(request)
    const code = (error as { code?: unknown }).code
    const context = requestContext.getStore()
    if (context && typeof code === 'string' && ERROR_CODE_PATTERN.test(code)) context.errorCode = code
    done()
  })
  // Routes that reply with an error body without throwing, and the global
  // error handler's own serialization, are only visible here. The code the
  // client received is the one to report.
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (reply.statusCode >= 400) {
      const context = requestContext.getStore()
      const code = context ? errorCodeOfBody(payload) : undefined
      if (context && code) context.errorCode = code
    }
    done(null, payload)
  })
  app.addHook('onResponse', (request, reply, done) => {
    populateIdentity(request)
    const context = requestContext.getStore()
    if (context) context.statusCode = reply.statusCode
    const route = request.routeOptions.url
    if (options.onRequestCompleted && route) {
      try {
        const kind = request.principal?.kind
        options.onRequestCompleted({
          method: request.method,
          route,
          statusCode: reply.statusCode,
          durationMs: reply.elapsedTime,
          ...(context?.errorCode && reply.statusCode >= 400 ? { errorCode: context.errorCode } : {}),
          userAgent: headerValue(request.headers['user-agent']),
          actorSession: headerValue(request.headers['x-canonry-actor-session']),
          principalKind: kind === 'user' ? 'user' : kind ? 'api-key' : undefined,
          usageLabels: {
            surface: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.surface]),
            agent: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.agent]),
            mcpClient: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.mcpClient]),
            mcpTool: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.mcpTool]),
            mcpCall: headerValue(request.headers[USAGE_TELEMETRY_HEADERS.mcpCall]),
          },
        })
      } catch {
        // Usage telemetry must never affect a response that has already been sent.
      }
    }
    done()
    if (context) context.completed = true
  })
}

function populateIdentity(request: FastifyRequest): void {
  const context = requestContext.getStore()
  if (context) Object.assign(context, requestAuditIdentity(request))
}

/** Normalize caller-controlled correlation headers before durable storage. */
export function sanitizeRequestContext(value: string | string[] | null | undefined): string | null {
  const joined = Array.isArray(value) ? value.join(', ') : value
  if (!joined) return null
  const sanitized = redactLogString(joined).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_REQUEST_CONTEXT_LENGTH)
  return sanitized || null
}

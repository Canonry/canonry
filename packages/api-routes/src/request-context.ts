import { AsyncLocalStorage } from 'node:async_hooks'
import { redactLogString } from '@ainyc/canonry-contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

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
}

const requestContext = new AsyncLocalStorage<RequestContext & { completed?: boolean }>()
const MAX_REQUEST_CONTEXT_LENGTH = 512

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
 * Register the request scope before authPlugin. The callback-style onRequest
 * hook is important: Fastify resumes the rest of its lifecycle through
 * `done`, preserving this AsyncLocalStorage scope for concurrent requests.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    requestContext.run({
      requestId: sanitizeRequestContext(request.id) ?? undefined,
      userAgent: sanitizeRequestContext(request.headers['user-agent']) ?? undefined,
      actorSession: sanitizeRequestContext(request.headers['x-canonry-actor-session']) ?? undefined,
      method: request.method,
      // Route template only, never a raw URL, query string, or route parameter.
      route: request.routeOptions.url,
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
  app.addHook('onError', (request, _reply, _error, done) => {
    populateIdentity(request)
    done()
  })
  app.addHook('onResponse', (request, reply, done) => {
    populateIdentity(request)
    const context = requestContext.getStore()
    if (context) context.statusCode = reply.statusCode
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

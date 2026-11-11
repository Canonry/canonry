/**
 * Sign in with ChatGPT, over HTTP.
 *
 *   GET  /auth/chatgpt/status      what the install offers, and the signed-in person's link and plan
 *   GET  /auth/chatgpt/start       browser navigation: off to OpenAI (`intent=login` or `connect`)
 *   GET  /auth/chatgpt/callback    OpenAI's redirect back; signs in or connects, then back to the dashboard
 *   POST /auth/chatgpt/disconnect  withdraw the signed-in person's plan grant
 *   GET  /auth/chatgpt/models      models the signed-in person's plan offers
 *   PUT  /auth/chatgpt/model       choose which of them Aero uses
 *
 * All of these are on the auth skip-list and resolve the sign-in cookie
 * themselves: `start` and `callback` run before anyone is signed in, and the
 * rest are a person's own settings, which a view-only person must be able to
 * change even though the role gate refuses viewers every other write. The
 * writes run the same-origin check the role gate would otherwise have applied.
 *
 * The callback never shows provider text. It redirects to the dashboard with
 * `chatgpt_error=<code>` and the dashboard says what that code means.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AppError,
  authRequired,
  CHATGPT_USAGE_URL,
  chatGptModelSelectionRequestSchema,
  chatGptSignInIntentSchema,
  ChatGptSignInErrors,
  ChatGptSignInIntents,
  validationError,
  type ChatGptModelListDto,
  type ChatGptSignInError,
  type ChatGptStatusDto,
} from '@canonry/canonry-contracts'
import { ChatGptPlanError, CHATGPT_SIGN_IN_TTL_MS, pickChatGptPlanModel, type ChatGptAccounts } from './chatgpt-accounts.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { assertCookieWriteOrigin } from './same-origin.js'
import {
  cookieIsSecure,
  createUserSession,
  parseCookieHeader,
  resolveUserSession,
  serializeUserSessionCookie,
  USER_SESSION_COOKIE_NAME,
  type UserSessionCookieOptions,
} from './user-session.js'

/** Binds a started sign-in to the browser that started it, and carries the PKCE verifier. */
export const CHATGPT_SIGN_IN_COOKIE_NAME = 'canonry_chatgpt_signin'

const MAX_RETURN_TO_LENGTH = 512

export interface ChatGptRoutesOptions {
  accounts?: ChatGptAccounts
  /** The sign-in cookie's path and Secure setting, shared with /auth/login. */
  cookie?: UserSessionCookieOptions
  /** Where the dashboard lives, e.g. `/` or `/canonry/`. The callback returns there. */
  dashboardPath?: string
  /** The API route prefix, e.g. `/api/v1`. Scopes the binding cookie to these routes. */
  routePrefix?: string
  /** The install's own Aero model, preferred on a plan that lists it. */
  preferredModel?: () => string | null
}

/**
 * A return path is honored only when it is a plain path inside the dashboard:
 * no scheme, no host, no `//`, no backslash, no control characters. Anything
 * else returns to the dashboard root, so the callback can never be turned into
 * an open redirect.
 */
export function safeReturnTo(value: unknown, dashboardPath: string): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_RETURN_TO_LENGTH) return null
  if (!value.startsWith(dashboardPath) || !value.startsWith('/') || value.startsWith('//')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const parsed = new URL(value, 'http://canonry.invalid')
    if (parsed.origin !== 'http://canonry.invalid') return null
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return null
  }
}

function withParam(path: string, name: string, value: string): string {
  const url = new URL(path, 'http://canonry.invalid')
  url.searchParams.set(name, value)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Add a Set-Cookie without dropping one already set on this reply (e.g. a session renewal). */
function appendCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader('set-cookie')
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)]
  reply.header('set-cookie', [...list, cookie])
}

export async function chatGptRoutes(app: FastifyInstance, opts: ChatGptRoutesOptions) {
  const dashboardPath = opts.dashboardPath ?? '/'
  const bindingCookiePath = `${(opts.routePrefix ?? '/api/v1').replace(/\/$/, '')}/auth/chatgpt/`

  const bindingCookie = (request: FastifyRequest, value: string | null): string => {
    const parts = [
      `${CHATGPT_SIGN_IN_COOKIE_NAME}=${value ?? ''}`,
      `Path=${bindingCookiePath}`,
      'HttpOnly',
      // Lax, not Strict: OpenAI's redirect back is a cross-site top-level
      // navigation, and Strict would withhold the cookie from exactly it.
      'SameSite=Lax',
      value ? `Max-Age=${Math.floor(CHATGPT_SIGN_IN_TTL_MS / 1000)}` : 'Max-Age=0',
    ]
    if (cookieIsSecure(request, opts.cookie?.secure)) parts.push('Secure')
    return parts.join('; ')
  }

  const signedInUserId = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const token = parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
    if (!token) return null
    const resolved = resolveUserSession(app.db, token)
    if (!resolved) return null
    if (resolved.renewedExpiresAt) {
      appendCookie(reply, serializeUserSessionCookie({
        value: token,
        path: opts.cookie?.path,
        secure: cookieIsSecure(request, opts.cookie?.secure),
      }))
    }
    return resolved.user.id
  }

  const requireSignedIn = (request: FastifyRequest, reply: FastifyReply): string => {
    const userId = signedInUserId(request, reply)
    if (!userId) throw authRequired('Sign in to manage your ChatGPT connection.')
    return userId
  }

  const toAppError = (error: unknown): unknown => {
    if (!(error instanceof ChatGptPlanError)) return error
    const status = error.kind === 'unavailable' ? 503 : error.kind === 'not-eligible' ? 403 : 409
    return new AppError(status === 503 ? 'PROVIDER_ERROR' : status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR', error.message, status, { reason: error.kind })
  }

  const redirectWithError = (reply: FastifyReply, error: ChatGptSignInError, returnTo: string | null = null) => {
    reply.header('cache-control', 'no-store')
    return reply.redirect(withParam(returnTo ?? dashboardPath, 'chatgpt_error', error), 302)
  }

  app.get('/auth/chatgpt/status', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply): Promise<ChatGptStatusDto> => {
    reply.header('cache-control', 'no-store')
    const userId = signedInUserId(request, reply)
    if (!opts.accounts) {
      return { signInEnabled: false, planUsageEnabled: false, planRequired: false, usageUrl: CHATGPT_USAGE_URL, account: null }
    }
    return opts.accounts.status(userId)
  })

  // Public and writes a sign-in row, so it is budgeted per caller.
  app.get<{ Querystring: { intent?: string; returnTo?: string } }>('/auth/chatgpt/start', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsedIntent = chatGptSignInIntentSchema.safeParse(request.query.intent ?? ChatGptSignInIntents.login)
    const returnTo = safeReturnTo(request.query.returnTo, dashboardPath)
    if (!parsedIntent.success) return redirectWithError(reply, ChatGptSignInErrors.failed, returnTo)
    const intent = parsedIntent.data
    if (!opts.accounts) return redirectWithError(reply, ChatGptSignInErrors.disabled, returnTo)
    let userId: string | null = null
    if (intent === ChatGptSignInIntents.connect) {
      userId = signedInUserId(request, reply)
      if (!userId) return redirectWithError(reply, ChatGptSignInErrors.expired, returnTo)
    }
    let started: { url: string; cookie: string }
    try {
      started = await opts.accounts.begin({ intent, userId, returnTo })
    } catch {
      // Not configured, switched off for this intent, or OpenAI's discovery unreachable.
      const offForIntent = intent === ChatGptSignInIntents.login
        ? !opts.accounts.signInEnabled()
        : !opts.accounts.signInEnabled() && !opts.accounts.planUsageEnabled()
      return redirectWithError(reply, offForIntent ? ChatGptSignInErrors.disabled : ChatGptSignInErrors.failed, returnTo)
    }
    appendCookie(reply, bindingCookie(request, started.cookie))
    reply.header('cache-control', 'no-store')
    reply.header('referrer-policy', 'no-referrer')
    return reply.redirect(started.url, 302)
  })

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/chatgpt/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    // The binding cookie is single use whatever the outcome.
    appendCookie(reply, bindingCookie(request, null))
    reply.header('cache-control', 'no-store')
    reply.header('referrer-policy', 'no-referrer')
    if (!opts.accounts) return redirectWithError(reply, ChatGptSignInErrors.disabled)
    const result = await opts.accounts.complete({
      state: typeof request.query.state === 'string' ? request.query.state : undefined,
      code: typeof request.query.code === 'string' ? request.query.code : undefined,
      error: typeof request.query.error === 'string' ? request.query.error : undefined,
      cookie: parseCookieHeader(request.headers.cookie)[CHATGPT_SIGN_IN_COOKIE_NAME],
    })
    const returnTo = safeReturnTo(result.returnTo, dashboardPath)
    if (!result.ok) return redirectWithError(reply, result.error, returnTo)

    if (result.createdAccount) {
      writeAuditLog(app.db, auditFromRequest(request, {
        actor: 'chatgpt-sign-in',
        action: 'user.created',
        entityType: 'user',
        entityId: result.userId,
        diff: { name: result.createdAccount.name, role: result.createdAccount.role, invitationId: result.createdAccount.invitationId },
      }))
    }
    if (result.linked) {
      writeAuditLog(app.db, auditFromRequest(request, {
        actor: 'chatgpt-sign-in', action: 'user.chatgpt-linked', entityType: 'user', entityId: result.userId,
      }))
    }
    if (result.plan !== 'off') {
      writeAuditLog(app.db, auditFromRequest(request, {
        actor: 'chatgpt-sign-in',
        action: result.plan === 'connected' ? 'user.chatgpt-plan-connected' : 'user.chatgpt-plan-declined',
        entityType: 'user',
        entityId: result.userId,
      }))
    }

    if (result.intent === ChatGptSignInIntents.login) {
      const sessionId = createUserSession(app.db, result.userId)
      appendCookie(reply, serializeUserSessionCookie({
        value: sessionId,
        path: opts.cookie?.path,
        secure: cookieIsSecure(request, opts.cookie?.secure),
      }))
      return reply.redirect(returnTo ?? dashboardPath, 302)
    }
    return reply.redirect(withParam(returnTo ?? dashboardPath, 'chatgpt', result.plan === 'connected' ? 'connected' : 'linked'), 302)
  })

  app.post('/auth/chatgpt/disconnect', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    assertCookieWriteOrigin(request)
    const userId = requireSignedIn(request, reply)
    if (!opts.accounts) return { disconnected: false, revoked: false }
    const result = await opts.accounts.disconnect(userId)
    if (result.disconnected) {
      writeAuditLog(app.db, auditFromRequest(request, {
        actor: 'api', action: 'user.chatgpt-plan-disconnected', entityType: 'user', entityId: userId,
        diff: { revokedAtOpenAI: result.revoked },
      }))
    }
    return result
  })

  app.get('/auth/chatgpt/models', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply): Promise<ChatGptModelListDto> => {
    reply.header('cache-control', 'no-store')
    const userId = requireSignedIn(request, reply)
    if (!opts.accounts?.planUsageEnabled()) throw validationError('ChatGPT plan usage is not turned on for this dashboard.')
    try {
      const { models, selected } = await opts.accounts.models(userId)
      // What the next answer will use, by the same rule the turn applies.
      return { models, selected: pickChatGptPlanModel(models, selected, opts.preferredModel?.() ?? null) }
    } catch (error) {
      throw toAppError(error)
    }
  })

  app.put('/auth/chatgpt/model', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    assertCookieWriteOrigin(request)
    const userId = requireSignedIn(request, reply)
    if (!opts.accounts?.planUsageEnabled()) throw validationError('ChatGPT plan usage is not turned on for this dashboard.')
    const parsed = chatGptModelSelectionRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Choose a model.', { issues: parsed.error.issues })
    try {
      await opts.accounts.selectModel(userId, parsed.data.modelId)
    } catch (error) {
      throw toAppError(error)
    }
    return { modelId: parsed.data.modelId }
  })
}

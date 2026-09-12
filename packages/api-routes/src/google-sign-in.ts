import crypto from 'node:crypto'
import { and, eq, lte } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { googleLoginTransactions, userExternalIdentities, userInvitations, users } from '@ainyc/canonry-db'
import {
  AppError, authInvalid, authRequired, validationError, forbidden, googleLinkRequestSchema,
  googleStartRequestSchema, GOOGLE_LOGIN_TRANSACTION_TTL_MS, normalizeInvitationEmail,
  UserStatuses,
} from '@ainyc/canonry-contracts'
import {
  createCredentialChecker, createNamedUserSession, hashSessionToken, parseCookieHeader,
  resolveUserSession, serializeUserSessionCookie, USER_SESSION_COOKIE_NAME,
  type CredentialChecker, type UserSessionCookieOptions,
} from './user-session.js'
import { namedAuthenticationRequired, revokeUserAccess } from './user-access.js'
import { assertCookieWriteOrigin } from './same-origin.js'
import { createGoogleOidcClient, hasAuthoritativeGoogleEmail, type GoogleIdentity, type GoogleOidcClient } from './google-sign-in-client.js'
import { googleLoginUrls, openGoogleLoginState, safeAuthReturnPath, sealGoogleLoginState, type GoogleLoginState } from './google-login-state.js'
import type { GoogleSignInOptions } from './google-sign-in-options.js'
import { writeAuditLog } from './helpers.js'

export const GOOGLE_LOGIN_COOKIE = 'canonry_google_login'
const googleStartQuerySchema = googleStartRequestSchema.pick({ returnTo: true }).strict()

interface RouteOptions {
  googleSignIn?: GoogleSignInOptions
  cookie?: UserSessionCookieOptions
  credentials?: CredentialChecker
}

export function requireOwnAccount(app: FastifyInstance, request: FastifyRequest) {
  const token = parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
  const session = token ? resolveUserSession(app.db, token) : null
  if (!session) throw authRequired()
  return session.user
}

export async function googleSignInRoutes(app: FastifyInstance, opts: RouteOptions) {
  const credentialChecker = opts.credentials ?? createCredentialChecker({ db: app.db })
  let cachedClient: { key: string; client: GoogleOidcClient } | undefined

  const configured = () => {
    const settings = opts.googleSignIn
    const config = settings?.getConfig()
    if (!settings || !config?.enabled || !config.clientId || !config.clientSecret) {
      throw validationError('Google sign-in is not configured.')
    }
    const urls = googleLoginUrls(settings.publicUrl, settings.basePath)
    const secret = config.clientId + '\0' + config.clientSecret
    const key = hashSessionToken(secret + '\0' + urls.callbackUrl)
    if (!cachedClient || cachedClient.key !== key) {
      cachedClient = { key, client: (settings.clientFactory ?? createGoogleOidcClient)({ clientId: config.clientId, clientSecret: config.clientSecret }) }
    }
    return { urls, secret, key, client: cachedClient.client }
  }

  const headers = (reply: FastifyReply) => {
    reply.header('cache-control', 'no-store')
    reply.header('referrer-policy', 'no-referrer')
  }

  const stateCookie = (value: string, path: string, secure: boolean) =>
    `${GOOGLE_LOGIN_COOKIE}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.floor(GOOGLE_LOGIN_TRANSACTION_TTL_MS / 1000) : 0}${secure ? '; Secure' : ''}`

  async function begin(_request: FastifyRequest, reply: FastifyReply, input: { invitationToken?: string; returnTo?: string }, link?: { id: string; authVersion: number }) {
    if (!namedAuthenticationRequired(app.db)) throw forbidden('Create an administrator before enabling Google sign-in.')
    const current = configured()
    const now = Date.now()
    const state: GoogleLoginState = {
      state: crypto.randomBytes(32).toString('base64url'),
      nonce: crypto.randomBytes(32).toString('base64url'),
      codeVerifier: crypto.randomBytes(32).toString('base64url'),
      expiresAt: now + GOOGLE_LOGIN_TRANSACTION_TTL_MS,
      ...(input.invitationToken ? { invitationHash: hashSessionToken(input.invitationToken) } : {}),
      ...(link ? { linkUserId: link.id, linkAuthVersion: link.authVersion } : {}),
    }
    const returnTo = safeAuthReturnPath(input.returnTo, current.urls)
    const redirectUrl = await current.client.authorizationUrl({ ...state, redirectUri: current.urls.callbackUrl })
    if (configured().key !== current.key) throw authInvalid()
    app.db.transaction(tx => {
      if (link) {
        const account = tx.select().from(users).where(eq(users.id, link.id)).get()
        if (!account || account.status !== UserStatuses.active || account.authVersion !== link.authVersion) throw authInvalid()
      }
      tx.delete(googleLoginTransactions).where(lte(googleLoginTransactions.expiresAt, new Date(now).toISOString())).run()
      tx.insert(googleLoginTransactions).values({
        stateHash: hashSessionToken(state.state), userId: link?.id ?? null,
        returnTo, expiresAt: new Date(state.expiresAt).toISOString(),
      }).run()
    })
    headers(reply)
    reply.header('set-cookie', stateCookie(sealGoogleLoginState(state, current.secret, current.urls.callbackUrl),
      current.urls.basePath, current.urls.baseUrl.startsWith('https:')))
    return { redirectUrl }
  }

  app.get('/auth/providers', async (_request, reply) => {
    headers(reply)
    try {
      const current = configured()
      return { google: { enabled: namedAuthenticationRequired(app.db), startUrl: new URL('api/v1/auth/google/start', current.urls.baseUrl).href } }
    } catch {
      return { google: { enabled: false, startUrl: null } }
    }
  })

  // POST keeps invitation bearer material out of URLs, referrers and access logs.
  app.post('/auth/google/start', { logLevel: 'silent', config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    assertCookieWriteOrigin(request)
    const parsed = googleStartRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('The sign-in request is invalid.')
    return begin(request, reply, parsed.data)
  })

  // Direct navigation supports the existing server-rendered MCP consent page.
  app.get('/auth/google/start', { logLevel: 'silent', config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = googleStartQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) throw validationError('The sign-in request is invalid.')
    const result = await begin(request, reply, parsed.data)
    return reply.redirect(result.redirectUrl)
  })

  app.post('/auth/google/link', { logLevel: 'silent' }, async (request, reply) => {
    assertCookieWriteOrigin(request)
    const user = requireOwnAccount(app, request)
    const parsed = googleLinkRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Enter your current password to link Google.')
    const verified = await credentialChecker.verify(request, user.name, parsed.data.password)
    if (!verified.ok) {
      if (verified.reason === 'rate-limited') throw new AppError('QUOTA_EXCEEDED', verified.message, 429)
      throw authInvalid()
    }
    if (verified.user.id !== user.id || verified.user.authVersion !== user.authVersion) throw authInvalid()
    return begin(request, reply, { returnTo: configured().urls.basePath }, user)
  })

  function bindIdentity(identity: GoogleIdentity, state: GoogleLoginState, request: FastifyRequest) {
    const now = new Date().toISOString()
    return app.db.transaction(tx => {
      const existingIdentity = tx.select().from(userExternalIdentities)
        .where(and(eq(userExternalIdentities.issuer, identity.issuer), eq(userExternalIdentities.subject, identity.subject))).get()

      if (state.linkUserId) {
        const current = requireOwnAccount(app, request)
        if (current.id !== state.linkUserId || current.authVersion !== state.linkAuthVersion) throw authInvalid()
        if (existingIdentity && existingIdentity.userId !== current.id) throw forbidden('That Google account is already linked.')
        if (!existingIdentity) {
          tx.insert(userExternalIdentities).values({ id: crypto.randomUUID(), userId: current.id,
            issuer: identity.issuer, subject: identity.subject, email: identity.email, createdAt: now }).run()
          revokeUserAccess(tx, current.id, now)
          writeAuditLog(tx, { actor: 'api', actorUserId: current.id, actorName: current.name,
            action: 'user.google-linked', entityType: 'user', entityId: current.id })
        }
        return tx.select().from(users).where(eq(users.id, current.id)).get()!
      }

      if (state.invitationHash) {
        const invitation = tx.select().from(userInvitations).where(eq(userInvitations.tokenHash, state.invitationHash)).get()
        if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now
          || !hasAuthoritativeGoogleEmail(identity) || normalizeInvitationEmail(identity.email!) !== invitation.emailKey
          || existingIdentity) throw authInvalid()
        // Invitation acceptance never silently links a pre-existing password account.
        const email = normalizeInvitationEmail(identity.email!)
        if (tx.select({ email: users.email }).from(users).all().some(row => row.email && normalizeInvitationEmail(row.email) === email)) throw authInvalid()
        const id = crypto.randomUUID()
        const name = 'google-' + id
        tx.insert(users).values({ id, name, nameKey: name, displayName: identity.name?.slice(0, 200) ?? null,
          email: identity.email, role: invitation.role, passwordHash: null, status: UserStatuses.active,
          permissionsMigrated: true, createdAt: now }).run()
        tx.insert(userExternalIdentities).values({ id: crypto.randomUUID(), userId: id,
          issuer: identity.issuer, subject: identity.subject, email: identity.email, createdAt: now }).run()
        tx.update(userInvitations).set({ acceptedAt: now, acceptedUserId: id }).where(eq(userInvitations.id, invitation.id)).run()
        writeAuditLog(tx, { actor: 'api', actorUserId: id, actorName: name,
          action: 'user.invitation-accepted', entityType: 'user', entityId: id,
          diff: { invitationId: invitation.id, role: invitation.role } })
        return tx.select().from(users).where(eq(users.id, id)).get()!
      }

      if (!existingIdentity) throw authInvalid()
      const user = tx.select().from(users).where(eq(users.id, existingIdentity.userId)).get()
      if (!user || user.status !== UserStatuses.active) throw authInvalid()
      tx.update(userExternalIdentities).set({ lastLoginAt: now }).where(eq(userExternalIdentities.id, existingIdentity.id)).run()
      return user
    })
  }

  app.get('/auth/google/callback', { logLevel: 'silent', config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    headers(reply)
    let basePath = opts.cookie?.path ?? '/'
    let secure = opts.cookie?.secure ?? true
    let validatedAttempt = false
    let invitationAttempt = false
    try {
      const current = configured()
      basePath = current.urls.basePath
      secure = current.urls.baseUrl.startsWith('https:')
      const raw = parseCookieHeader(request.headers.cookie)[GOOGLE_LOGIN_COOKIE]
      if (!raw) throw authInvalid()
      const state = openGoogleLoginState(raw, current.secret, current.urls.callbackUrl)
      invitationAttempt = Boolean(state.invitationHash)
      const callback = new URL(current.urls.callbackUrl)
      callback.search = new URL(request.raw.url ?? '', current.urls.baseUrl).search
      if (callback.searchParams.get('state') !== state.state) throw authInvalid()
      const transaction = app.db.transaction(tx => {
        const row = tx.select().from(googleLoginTransactions).where(eq(googleLoginTransactions.stateHash, hashSessionToken(state.state))).get()
        if (!row || row.expiresAt <= new Date().toISOString()) return null
        tx.delete(googleLoginTransactions).where(eq(googleLoginTransactions.stateHash, row.stateHash)).run()
        return row
      })
      if (!transaction) throw authInvalid()
      validatedAttempt = true
      const identity = await current.client.authenticate({ ...state, callbackUrl: callback })
      if (configured().key !== current.key) throw authInvalid()
      const account = bindIdentity(identity, state, request)
      const session = createNamedUserSession(app.db, account.id, account.authVersion)
      if (!session) throw authInvalid()
      reply.header('set-cookie', [
        stateCookie('', basePath, secure),
        serializeUserSessionCookie({ value: session.token, path: basePath, secure }),
      ])
      // Existing rows predate server-side return storage; only they can use
      // the legacy encrypted-cookie field.
      return reply.redirect(safeAuthReturnPath(transaction.returnTo ?? state.returnTo, current.urls), 303)
    } catch {
      // Only record browser-bound, consumed attempts: random callback traffic
      // must not fill the security history. No provider error/token is stored.
      if (validatedAttempt) {
        writeAuditLog(app.db, { actor: 'api', action: 'auth.google.sign_in.failed',
          entityType: 'auth', entityId: 'google' })
      }
      // Provider errors and token contents never enter logs or the redirect.
      reply.header('set-cookie', stateCookie('', basePath, secure))
      const error = invitationAttempt ? 'google-invitation-failed' : 'google-sign-in-failed'
      return reply.redirect(basePath + '?authError=' + error, 303)
    }
  })
}

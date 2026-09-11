/** Instance-wide Google sign-in configuration (separate from Google integrations). */
import { and, eq, isNotNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  forbidden,
  googleSignInConfigSchema,
  type GoogleSignInConfig,
  updateGoogleSignInRequestSchema,
  UserRoles,
  UserStatuses,
  validationError,
} from '@ainyc/canonry-contracts'
import { apiKeys, googleLoginTransactions, users } from '@ainyc/canonry-db'
import { requireAdminSession, requireBroadInstanceKey, requireScope } from './auth.js'
import { googleLoginUrls } from './google-login-state.js'
import type { GoogleSignInOptions } from './google-sign-in-options.js'
import { parseCookieHeader, resolveUserSession, USER_SESSION_COOKIE_NAME } from './user-session.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { SETTINGS_WRITE_SCOPE } from './settings.js'

export interface GoogleSignInSettingsRoutesOptions {
  googleSignIn?: GoogleSignInOptions
}

type SafeConfig = {
  config: GoogleSignInConfig
  urls: ReturnType<typeof googleLoginUrls> | null
}

function configuredOptions(options: GoogleSignInSettingsRoutesOptions): GoogleSignInOptions | undefined {
  return options.googleSignIn
}

/** A malformed host config is never reflected back as partial secret metadata. */
function readSafeConfig(options: GoogleSignInSettingsRoutesOptions): SafeConfig | null {
  const google = configuredOptions(options)
  if (!google) return null
  const parsed = googleSignInConfigSchema.safeParse(google.getConfig())
  if (!parsed.success) return null
  try {
    return { config: parsed.data, urls: googleLoginUrls(google.publicUrl, google.basePath) }
  } catch {
    return null
  }
}

function toSettingsDto(options: GoogleSignInSettingsRoutesOptions) {
  const google = configuredOptions(options)
  const safe = readSafeConfig(options)
  if (!safe) {
    return {
      enabled: false,
      configured: false,
      clientId: null,
      hasClientSecret: false,
      callbackUrl: null,
      environmentOverride: google?.environmentOverride === true,
      editable: Boolean(google?.updateConfig) && google?.environmentOverride !== true,
    }
  }
  const configured = Boolean(safe.config.clientId && safe.config.clientSecret && safe.urls)
  return {
    enabled: configured && safe.config.enabled,
    configured,
    clientId: safe.config.clientId ?? null,
    hasClientSecret: Boolean(safe.config.clientSecret),
    callbackUrl: safe.urls?.callbackUrl ?? null,
    environmentOverride: google?.environmentOverride === true,
    editable: Boolean(google?.updateConfig) && google?.environmentOverride !== true,
  }
}

function authorizeRead(request: FastifyRequest): void {
  requireAdminSession(request)
  requireBroadInstanceKey(request)
}

function authorizeWrite(request: FastifyRequest): void {
  requireAdminSession(request)
  // Google sign-in is install-wide, so a project-bound credential is never a
  // valid settings credential. Unlike account-list reads, however, this write
  // deliberately accepts the explicit `settings.write` capability as well as
  // the root wildcard; requiring the users.* account capability here would
  // make that documented narrow authority unusable.
  if (request.apiKey?.projectId || request.principal?.projectId) {
    throw forbidden('This API key is limited to one project, and Google sign-in is an instance-wide setting.')
  }
  // `requireScope` is an allow-list: a root key or an explicit settings.write
  // key passes; unrelated scopes (including users.write) do not become
  // settings authority merely because this route is instance-wide.
  requireScope(request, SETTINGS_WRITE_SCOPE)
}

function activePasswordAdminExists(db: Pick<FastifyInstance['db'], 'select'>): boolean {
  return db.select({ id: users.id }).from(users).where(and(
    eq(users.role, UserRoles.admin),
    eq(users.status, UserStatuses.active),
    isNotNull(users.passwordHash),
  )).get() !== undefined
}

/**
 * Auth middleware resolves a principal before the handler starts. A host
 * configuration write may be async, so repeat the durable part of that check
 * after every await: a demoted/suspended person or revoked key must not carry
 * its entry-time permission across the callback boundary.
 */
function assertCurrentAuthority(app: FastifyInstance, request: FastifyRequest): void {
  const principal = request.principal
  if (!principal) return // `skipAuth` is intentionally supported by route tests.

  if (principal.kind === 'user' && principal.viaCookie) {
    const token = parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
    const session = token ? resolveUserSession(app.db, token) : null
    if (!session || session.user.id !== principal.id) {
      throw forbidden('This session no longer has authority to change Google sign-in.')
    }
  }

  const userId = principal.kind === 'user' ? principal.id : principal.delegatedUser?.id
  if (userId) {
    const current = app.db.select({ role: users.role, status: users.status }).from(users)
      .where(eq(users.id, userId)).get()
    if (!current || current.status !== UserStatuses.active || current.role !== UserRoles.admin) {
      throw forbidden('Only an administrator account can use this.')
    }
  }

  // API keys cannot have their scope edited, but revocation and project
  // deletion are durable changes that can happen while an async host callback
  // is pending. `requireBroadInstanceKey` additionally enforces the proper
  // scope shape at entry; this closes the revocation/project-scope race.
  if (principal.kind === 'api-key') {
    const current = app.db.select({
      revokedAt: apiKeys.revokedAt,
      projectId: apiKeys.projectId,
      scopes: apiKeys.scopes,
    }).from(apiKeys).where(eq(apiKeys.id, principal.id)).get()
    const scopes = Array.isArray(current?.scopes) ? current.scopes : []
    if (
      !current
      || current.revokedAt
      || current.projectId
      || (!scopes.includes('*') && !scopes.includes(SETTINGS_WRITE_SCOPE))
    ) {
      throw forbidden('This credential no longer has authority to change Google sign-in.')
    }
  }
}

function assertPasswordRecovery(app: FastifyInstance): void {
  if (!activePasswordAdminExists(app.db)) {
    throw validationError('At least one active administrator with a password is required to change Google sign-in.')
  }
}

function sameConfig(left: GoogleSignInConfig, right: GoogleSignInConfig): boolean {
  return left.enabled === right.enabled
    && left.clientId === right.clientId
    && left.clientSecret === right.clientSecret
}

/** Serialize host callbacks within this mounted route plugin. */
function serialMutation() {
  let tail: Promise<void> = Promise.resolve()
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      release()
    }
  }
}

export async function googleSignInSettingsRoutes(
  app: FastifyInstance,
  opts: GoogleSignInSettingsRoutesOptions = {},
) {
  const runSerialized = serialMutation()

  app.get('/settings/auth/google', async (request) => {
    authorizeRead(request)
    return toSettingsDto(opts)
  })

  app.put('/settings/auth/google', async (request) => {
    authorizeWrite(request)
    const google = configuredOptions(opts)
    const updateConfig = google?.updateConfig
    if (!google || !updateConfig || google.environmentOverride) {
      throw forbidden('Google sign-in is managed by the environment and cannot be changed here.')
    }
    const parsed = updateGoogleSignInRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('That Google sign-in configuration is invalid.', { issues: parsed.error.issues })
    }

    return runSerialized(async () => {
      // Re-run authority after waiting behind a prior update, before reading
      // host state or entering the async host callback.
      authorizeWrite(request)
      assertCurrentAuthority(app, request)

      const current = googleSignInConfigSchema.safeParse(google.getConfig())
      const base: GoogleSignInConfig = current.success ? current.data : { enabled: false }
      const nextParsed = googleSignInConfigSchema.safeParse({
        enabled: parsed.data.enabled ?? base.enabled,
        clientId: parsed.data.clientId ?? base.clientId,
        // Omitting a secret preserves it; this response never returns it.
        clientSecret: parsed.data.clientSecret ?? base.clientSecret,
      })
      if (!nextParsed.success) {
        throw validationError('That Google sign-in configuration is invalid.', { issues: nextParsed.error.issues })
      }
      const next = nextParsed.data
      const changed = !sameConfig(base, next)
      if (!changed) return toSettingsDto(opts)

      if (next.enabled) {
        if (!next.clientId || !next.clientSecret) {
          throw validationError('A client ID and client secret are required before enabling Google sign-in.')
        }
        try {
          googleLoginUrls(google.publicUrl, google.basePath)
        } catch {
          throw validationError('A valid public URL is required before enabling Google sign-in.')
        }
      }

      // Google may be disabled only while password recovery remains possible;
      // the same invariant guards enabling or rotating an enabled config.
      if (base.enabled || next.enabled) assertPasswordRecovery(app)
      assertCurrentAuthority(app, request)

      try {
        await updateConfig(next)

        // There is no cross-process transaction spanning a host-owned async
        // config writer and SQLite. We serialize this route locally, and
        // recheck authority/recovery on both sides of the await before changing
        // local login state. Hosts that mutate config elsewhere must provide
        // their own equivalent serialization.
        authorizeWrite(request)
        assertCurrentAuthority(app, request)
        if (base.enabled || next.enabled) assertPasswordRecovery(app)
        app.db.transaction((tx) => {
          tx.delete(googleLoginTransactions).run()
          writeAuditLog(tx, auditFromRequest(request, { actor: 'api', action: 'auth.google.settings.updated',
            entityType: 'auth', entityId: 'google', diff: {
              enabled: next.enabled, clientIdChanged: next.clientId !== base.clientId,
              clientSecretChanged: next.clientSecret !== base.clientSecret,
            } }))
        })
        return toSettingsDto(opts)
      } catch (error) {
        // A host callback can complete its write before yielding back to us.
        // If authority or recovery disappeared across that await, restore the
        // exact prior config while this route's mutation lock is still held.
        // Also covers a callback that committed and then threw.
        const live = googleSignInConfigSchema.safeParse(google.getConfig())
        if (live.success && sameConfig(live.data, next)) await updateConfig(base)
        throw error
      }
    })
  })
}

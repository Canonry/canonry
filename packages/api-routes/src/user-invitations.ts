/**
 * Instance-wide Google sign-in invitations.
 *
 * The fragment in an invitation URL deliberately keeps the bearer token out of
 * HTTP requests (and therefore out of access logs).  The callback route owns
 * consuming it after the browser has moved it into its signed login state.
 */
import crypto from 'node:crypto'
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  alreadyExists,
  createUserInvitationRequestSchema,
  forbidden,
  googleSignInConfigSchema,
  normalizeInvitationEmail,
  notFound,
  UserRoles,
  UserStatuses,
  USER_INVITATION_TTL_MS,
  validationError,
} from '@ainyc/canonry-contracts'
import {
  userExternalIdentities,
  userInvitations,
  users,
} from '@ainyc/canonry-db'
import {
  requireAdminSession,
  requireBroadInstanceKey,
  requireScope,
  USERS_READ_SCOPE,
  USERS_WRITE_SCOPE,
} from './auth.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { googleLoginUrls } from './google-login-state.js'
import type { GoogleSignInOptions } from './google-sign-in-options.js'

export interface UserInvitationRoutesOptions {
  googleSignIn?: GoogleSignInOptions
}

type InvitationRow = typeof userInvitations.$inferSelect

function hashInvitationToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function invitationStatus(row: InvitationRow, now: string) {
  if (row.acceptedAt) return 'accepted' as const
  if (row.revokedAt) return 'revoked' as const
  if (row.expiresAt <= now) return 'expired' as const
  return 'pending' as const
}

function toInvitationDto(row: InvitationRow, now: string) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: invitationStatus(row, now),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt ?? null,
  }
}

/**
 * Invitation management is an install-wide surface. `requireBroadInstanceKey`
 * already refuses ordinary scoped keys, but this explicit check also protects
 * a future auth carrier that happens to expose `projectId` on its principal.
 */
function refuseProjectScopedKey(request: FastifyRequest): void {
  if (!request.apiKey?.projectId && !request.principal?.projectId) return
  throw forbidden('This API key is limited to one project, and invitations are shared by the whole install.')
}

function authorize(request: FastifyRequest, scope: string): void {
  refuseProjectScopedKey(request)
  requireAdminSession(request)
  requireBroadInstanceKey(request)
  requireScope(request, scope)
}

function activePasswordAdminExists(db: Pick<FastifyInstance['db'], 'select'>): boolean {
  return db.select({ id: users.id }).from(users).where(and(
    eq(users.role, UserRoles.admin),
    eq(users.status, UserStatuses.active),
    isNotNull(users.passwordHash),
  )).get() !== undefined
}

/** Do a case-insensitive comparison without applying provider-specific rules. */
function emailAlreadyBelongsToAnAccount(db: Pick<FastifyInstance['db'], 'select'>, emailKey: string): boolean {
  const account = db.select({ email: users.email }).from(users).where(isNotNull(users.email)).all()
    .some(row => row.email !== null && normalizeInvitationEmail(row.email) === emailKey)
  if (account) return true
  return db.select({ email: userExternalIdentities.email }).from(userExternalIdentities)
    .where(isNotNull(userExternalIdentities.email)).all()
    .some(row => row.email !== null && normalizeInvitationEmail(row.email) === emailKey)
}

function configuredGoogleLogin(options: UserInvitationRoutesOptions): ReturnType<typeof googleLoginUrls> {
  const google = options.googleSignIn
  const parsed = googleSignInConfigSchema.safeParse(google?.getConfig())
  if (!google || !parsed.success || !parsed.data.enabled || !parsed.data.clientId || !parsed.data.clientSecret) {
    throw validationError('Configure and enable Google sign-in before inviting people.')
  }
  return googleLoginUrls(google.publicUrl, google.basePath)
}

function invitationUrl(urls: ReturnType<typeof googleLoginUrls>, token: string): string {
  const url = new URL(urls.baseUrl)
  url.hash = new URLSearchParams({ invitation: token }).toString()
  return url.href
}

function createdById(request: FastifyRequest): string | null {
  if (request.principal?.kind === 'user') return request.principal.id
  return request.principal?.delegatedUser?.id ?? null
}

export async function userInvitationRoutes(app: FastifyInstance, opts: UserInvitationRoutesOptions = {}) {
  app.get('/users/invitations', async (request) => {
    authorize(request, USERS_READ_SCOPE)
    const now = new Date().toISOString()
    const rows = app.db.select().from(userInvitations).orderBy(asc(userInvitations.createdAt)).all()
    return { invitations: rows.map(row => toInvitationDto(row, now)) }
  })

  app.post('/users/invitations', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request, reply) => {
    authorize(request, USERS_WRITE_SCOPE)
    const parsed = createUserInvitationRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('That invitation could not be created.', { issues: parsed.error.issues })
    }

    // Validate static configuration before making a durable change. The URL is
    // derived from configured public data only; request Host never participates.
    const urls = configuredGoogleLogin(opts)
    const token = crypto.randomBytes(32).toString('base64url')
    const now = new Date()
    const nowIso = now.toISOString()
    const expiresAt = new Date(now.getTime() + USER_INVITATION_TTL_MS).toISOString()
    const email = parsed.data.email.trim()
    const emailKey = normalizeInvitationEmail(email)

    const invitation = app.db.transaction((tx) => {
      if (!activePasswordAdminExists(tx)) {
        throw validationError('An active administrator with a password is required before inviting people.')
      }
      if (emailAlreadyBelongsToAnAccount(tx, emailKey)) {
        throw validationError('This email already belongs to an account. Ask that person to link Google sign-in from their account instead.')
      }

      // An expired unaccepted token is not authority. Mark it revoked inside
      // the same transaction that admits the new invitation so a concurrent
      // create observes a single pending invitation at most.
      tx.update(userInvitations).set({ revokedAt: nowIso }).where(and(
        eq(userInvitations.emailKey, emailKey),
        isNull(userInvitations.acceptedAt),
        isNull(userInvitations.revokedAt),
        lte(userInvitations.expiresAt, nowIso),
      )).run()

      const pending = tx.select({ id: userInvitations.id }).from(userInvitations).where(and(
        eq(userInvitations.emailKey, emailKey),
        isNull(userInvitations.acceptedAt),
        isNull(userInvitations.revokedAt),
      )).get()
      if (pending) throw alreadyExists('Invitation', email)

      const id = crypto.randomUUID()
      tx.insert(userInvitations).values({
        id,
        email,
        emailKey,
        role: parsed.data.role,
        tokenHash: hashInvitationToken(token),
        createdById: createdById(request),
        createdAt: nowIso,
        expiresAt,
      }).run()
      const row = tx.select().from(userInvitations).where(eq(userInvitations.id, id)).get()!
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.invitation_created',
        entityType: 'user_invitation',
        entityId: id,
        diff: { email, role: parsed.data.role },
      }))
      return row
    })

    return reply.status(201).send({
      invitation: toInvitationDto(invitation, nowIso),
      invitationUrl: invitationUrl(urls, token),
    })
  })

  app.post<{ Params: { id: string } }>('/users/invitations/:id/revoke', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request) => {
    authorize(request, USERS_WRITE_SCOPE)
    const now = new Date().toISOString()
    app.db.transaction((tx) => {
      const invitation = tx.select().from(userInvitations).where(eq(userInvitations.id, request.params.id)).get()
      if (!invitation) throw notFound('Invitation', request.params.id)
      if (!invitation.acceptedAt && !invitation.revokedAt) {
        tx.update(userInvitations).set({ revokedAt: now }).where(eq(userInvitations.id, invitation.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          actor: 'api',
          action: 'user.invitation_revoked',
          entityType: 'user_invitation',
          entityId: invitation.id,
          diff: { email: invitation.email },
        }))
      }
    })
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/users/invitations/:id/replace', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request) => {
    authorize(request, USERS_WRITE_SCOPE)
    const urls = configuredGoogleLogin(opts)
    const token = crypto.randomBytes(32).toString('base64url')
    const now = new Date()
    const nowIso = now.toISOString()
    const expiresAt = new Date(now.getTime() + USER_INVITATION_TTL_MS).toISOString()

    const invitation = app.db.transaction((tx) => {
      if (!activePasswordAdminExists(tx)) {
        throw validationError('An active administrator with a password is required before replacing an invitation.')
      }
      const current = tx.select().from(userInvitations).where(eq(userInvitations.id, request.params.id)).get()
      if (!current) throw notFound('Invitation', request.params.id)
      if (current.acceptedAt || current.revokedAt) {
        throw validationError('Accepted or revoked invitations cannot be replaced.')
      }
      if (emailAlreadyBelongsToAnAccount(tx, current.emailKey)) {
        throw validationError('This email already belongs to an account. Ask that person to link Google sign-in from their account instead.')
      }
      tx.update(userInvitations).set({
        tokenHash: hashInvitationToken(token),
        createdAt: nowIso,
        expiresAt,
      }).where(eq(userInvitations.id, current.id)).run()
      const row = tx.select().from(userInvitations).where(eq(userInvitations.id, current.id)).get()!
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.invitation_replaced',
        entityType: 'user_invitation',
        entityId: current.id,
        diff: { email: current.email, role: current.role },
      }))
      return row
    })

    return {
      invitation: toInvitationDto(invitation, nowIso),
      invitationUrl: invitationUrl(urls, token),
    }
  })
}

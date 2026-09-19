import { and, desc, eq, isNull, lte, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { auditLog, userExternalIdentities, users } from '@ainyc/canonry-db'
import { forbidden, notFound, USER_ACTIVITY_INTERVAL_MS, UserStatuses, validationError } from '@ainyc/canonry-contracts'
import { requireOwnAccount } from './google-sign-in.js'
import { requireAdminSession, requireBroadInstanceKey, requireScope, USERS_READ_SCOPE } from './auth.js'
import { assertCookieWriteOrigin } from './same-origin.js'
import { revokeUserAccess } from './user-access.js'
import { writeAuditLog } from './helpers.js'
import type { GoogleSignInOptions } from './google-sign-in-options.js'

export async function userAccountDetailsRoutes(app: FastifyInstance, opts: { googleSignIn?: GoogleSignInOptions }) {
  app.get('/auth/methods', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const account = requireOwnAccount(app, request)
    const identities = app.db.select().from(userExternalIdentities).where(eq(userExternalIdentities.userId, account.id)).all()
    return { methods: [
      ...(account.hasPassword ? [{ id: 'password', provider: 'password' as const, email: account.email, createdAt: account.createdAt }] : []),
      ...identities.map(identity => ({ id: identity.id, provider: 'google' as const, email: identity.email, createdAt: identity.createdAt })),
    ] }
  })

  app.delete<{ Params: { id: string } }>('/auth/methods/:id', async request => {
    assertCookieWriteOrigin(request)
    const account = requireOwnAccount(app, request)
    app.db.transaction(tx => {
      const current = tx.select().from(users).where(eq(users.id, account.id)).get()
      if (!current || current.status !== UserStatuses.active || current.authVersion !== account.authVersion) throw forbidden()
      const identity = tx.select().from(userExternalIdentities)
        .where(and(eq(userExternalIdentities.id, request.params.id), eq(userExternalIdentities.userId, current.id))).get()
      if (!identity) throw notFound('Sign-in method', request.params.id)
      const otherGoogle = tx.select().from(userExternalIdentities).where(eq(userExternalIdentities.userId, current.id)).all().length > 1
      const google = opts.googleSignIn?.getConfig()
      if (!current.passwordHash && !(otherGoogle && google?.enabled && google.clientId && google.clientSecret)) {
        throw validationError('Keep a working sign-in method before removing this one.')
      }
      tx.delete(userExternalIdentities).where(eq(userExternalIdentities.id, identity.id)).run()
      revokeUserAccess(tx, current.id)
      writeAuditLog(tx, { actor: 'api', actorUserId: current.id, actorName: current.displayName ?? current.name,
        action: 'user.google-unlinked', entityType: 'user', entityId: current.id })
    })
    return { ok: true as const }
  })

  app.post('/auth/activity', async request => {
    assertCookieWriteOrigin(request)
    const account = requireOwnAccount(app, request)
    const now = new Date()
    const cutoff = new Date(now.getTime() - USER_ACTIVITY_INTERVAL_MS).toISOString()
    app.db.update(users).set({ lastSeenAt: now.toISOString() }).where(and(
      eq(users.id, account.id), eq(users.status, UserStatuses.active), eq(users.authVersion, account.authVersion),
      or(isNull(users.lastSeenAt), lte(users.lastSeenAt, cutoff)),
    )).run()
    return { ok: true as const }
  })

  app.get<{ Params: { id: string } }>('/users/:id/access-history', async (request, reply) => {
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_READ_SCOPE)
    if (request.principal?.projectId) throw forbidden()
    reply.header('cache-control', 'no-store')
    const rows = app.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'user'), eq(auditLog.entityId, request.params.id)))
      .orderBy(desc(auditLog.createdAt)).limit(100).all()
    return { events: rows.map(row => ({ id: row.id, action: row.action,
      actorUserId: row.actorUserId, actorName: row.actorName, createdAt: row.createdAt })) }
  })
}

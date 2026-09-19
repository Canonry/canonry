/**
 * Account management.
 *
 * Creating the FIRST account is what turns sign-in on for the install, so it is
 * deliberately an act that requires the authority the install already had: the
 * root API key (or, once accounts exist, an admin who is signed in). There is
 * no unauthenticated bootstrap route — a network-reachable install must never
 * hand the first account to whoever arrives first.
 */
import crypto from 'node:crypto'
import { and, asc, eq, isNotNull, ne } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { apiKeys, userAuthState, users, userSessions } from '@ainyc/canonry-db'
import {
  alreadyExists,
  createUserRequestSchema,
  forbidden,
  normalizeUserName,
  notFound,
  updateUserRequestSchema,
  UserRoles,
  UserStatuses,
  validationError,
  WILDCARD_SCOPE,
} from '@ainyc/canonry-contracts'
import {
  requireAdminSession,
  requireBroadInstanceKey,
  requireScope,
  USERS_READ_SCOPE,
  USERS_WRITE_SCOPE,
} from './auth.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { hashUserPassword } from './user-password.js'
import { revokeUserAccess, toUserDto } from './user-access.js'
import { hashSessionToken, parseCookieHeader, USER_SESSION_COOKIE_NAME } from './user-session.js'

// The scope tokens live in `auth.ts` beside the gate that reads them, so the
// gate and the routes can never disagree about what grants what.
export { USERS_READ_SCOPE, USERS_WRITE_SCOPE } from './auth.js'

function countActivePasswordAdmins(db: Pick<DatabaseClient, 'select'>, excludingId?: string): number {
  const conditions = [
    eq(users.role, UserRoles.admin),
    eq(users.status, UserStatuses.active),
    isNotNull(users.passwordHash),
  ]
  if (excludingId) conditions.push(ne(users.id, excludingId))
  return db.select({ id: users.id }).from(users).where(and(...conditions)).all().length
}

/**
 * Accounts belong to the INSTALL, not to a project, so a key that is confined
 * to one project has no business touching them.
 *
 * Without this, a project-scoped key walks straight out of its own boundary:
 * it creates an administrator account, signs in as that account, and now
 * reaches every project on the install. The scope gate elsewhere works on the
 * URL, and `/users` carries no project in its path, so it never fires — the
 * refusal has to be here.
 */
function refuseProjectScopedKey(request: Parameters<typeof requireAdminSession>[0]): void {
  if (!request.principal?.projectId) return
  throw forbidden(
    'This API key is limited to one project, and accounts are shared by the whole install.',
  )
}

/** Revalidate the credential after the asynchronous password derivation. */
function assertCurrentCreateAuthority(
  db: Pick<DatabaseClient, 'select'>,
  request: FastifyRequest,
): void {
  const principal = request.principal
  if (!principal) return // `skipAuth` route harnesses deliberately have none.

  if (principal.kind === 'user') {
    const current = db.select().from(users).where(eq(users.id, principal.id)).get()
    const sessionToken = principal.viaCookie
      ? parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
      : undefined
    const session = sessionToken
      ? db.select().from(userSessions).where(eq(userSessions.tokenHash, hashSessionToken(sessionToken))).get()
      : undefined
    if (
      !current
      || current.status !== UserStatuses.active
      || current.role !== UserRoles.admin
      || (principal.viaCookie && (
        !session
        || session.userId !== current.id
        || session.authVersion !== current.authVersion
        || session.expiresAt <= new Date().toISOString()
      ))
    ) {
      throw forbidden('This account no longer has authority to create accounts.')
    }
    return
  }

  const currentKey = db.select().from(apiKeys).where(eq(apiKeys.id, principal.id)).get()
  const scopes = Array.isArray(currentKey?.scopes) ? currentKey.scopes : []
  const delegatedUser = currentKey?.delegatedUserId
    ? db.select().from(users).where(eq(users.id, currentKey.delegatedUserId)).get()
    : undefined
  if (
    !currentKey
    || currentKey.revokedAt
    || currentKey.projectId
    || (!scopes.includes(WILDCARD_SCOPE) && !scopes.includes(USERS_WRITE_SCOPE))
    || (currentKey.delegatedUserId && (
      !delegatedUser
      || delegatedUser.status !== UserStatuses.active
      || delegatedUser.role !== UserRoles.admin
      || (currentKey.delegatedUserAuthVersion === null
        ? delegatedUser.authVersion !== 0
        : currentKey.delegatedUserAuthVersion !== delegatedUser.authVersion)
    ))
  ) {
    throw forbidden('This credential no longer has authority to create accounts.')
  }
}

export async function userRoutes(app: FastifyInstance) {
  // Listing accounts tells you who can reach this install, which is not a
  // view-only concern — an admin (or an API key) only.
  app.get('/users', async (request) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    // The read was the one route here that never named a scope, which is
    // exactly the route an attacker wants: it hands over every account name.
    requireScope(request, USERS_READ_SCOPE)
    const rows = app.db.select().from(users).orderBy(asc(users.createdAt)).all()
    return { users: rows.map(toUserDto) }
  })

  app.post('/users', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request, reply) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    const parsed = createUserRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('That account could not be created.', { issues: parsed.error.issues })
    }
    const { name, password, role, displayName, email } = parsed.data
    const nameKey = normalizeUserName(name)

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const passwordHash = await hashUserPassword(password)

    const created = app.db.transaction((tx) => {
      assertCurrentCreateAuthority(tx, request)
      if (parsed.data.onlyIfFirstAdmin && (
        role !== UserRoles.admin
        || tx.select({ id: users.id }).from(users).limit(1).get()
        || tx.select().from(userAuthState).where(eq(userAuthState.id, 'instance')).get()?.namedAuthenticationRequired
      )) {
        throw validationError('Administrator setup is already complete. Sign in to manage accounts.')
      }
      // These checks must share the insertion transaction. Password hashing is
      // intentionally outside it, so concurrent first-account requests can
      // race only here, where one is atomically refused instead of creating an
      // unrecoverable non-admin protected install.
      if (tx.select({ id: users.id }).from(users).where(eq(users.nameKey, nameKey)).get()) {
        throw alreadyExists('Account', name)
      }
      const isFirstAccount = tx.select({ id: users.id }).from(users).limit(1).get() === undefined
      if (isFirstAccount && role !== UserRoles.admin) {
        throw validationError('The first account has to be an administrator.')
      }
      tx.insert(users).values({
        id,
        name: name.trim(),
        nameKey,
        passwordHash,
        role,
        status: UserStatuses.active,
        displayName: displayName ?? null,
        email: email ?? null,
        authVersion: 0,
        permissionsMigrated: true,
        createdAt: now,
      }).run()
      // Once protected, this flag never returns to false — even if every
      // account is later suspended or deleted.
      tx.insert(userAuthState).values({
        id: 'instance',
        namedAuthenticationRequired: true,
        permissionsMigrationComplete: true,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: userAuthState.id,
        set: { namedAuthenticationRequired: true, updatedAt: now },
      }).run()
      // The audit entry records WHO was created and with what authority. It
      // never records the password, in any form, hashed or otherwise.
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        diff: { name: name.trim(), displayName: displayName ?? null, email: email ?? null, role },
      }))
      return tx.select().from(users).where(eq(users.id, id)).get()!
    })

    return reply.status(201).send(toUserDto(created))
  })

  app.patch<{ Params: { id: string } }>('/users/:id', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    const parsed = updateUserRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('That account could not be updated.', { issues: parsed.error.issues })
    }
    const updated = app.db.transaction((tx) => {
      const current = tx.select().from(users).where(eq(users.id, request.params.id)).get()
      if (!current) throw notFound('Account', request.params.id)
      const nextRole = parsed.data.role ?? current.role
      const nextStatus = parsed.data.status ?? current.status
      const changesAccess = nextRole !== current.role || nextStatus !== current.status

      if (
        current.role === UserRoles.admin
        && current.status === UserStatuses.active
        && current.passwordHash !== null
        && (nextRole !== UserRoles.admin || nextStatus !== UserStatuses.active)
        && countActivePasswordAdmins(tx, current.id) === 0
      ) {
        throw validationError('At least one active administrator with a password must remain.')
      }

      tx.update(users).set({
        role: nextRole,
        status: nextStatus,
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      }).where(eq(users.id, current.id)).run()
      if (changesAccess) revokeUserAccess(tx, current.id)
      const row = tx.select().from(users).where(eq(users.id, current.id)).get()!
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.updated',
        entityType: 'user',
        entityId: current.id,
        diff: {
          before: { displayName: current.displayName, email: current.email, role: current.role, status: current.status },
          after: { displayName: row.displayName, email: row.email, role: row.role, status: row.status },
        },
      }))
      return row
    })
    return toUserDto(updated)
  })

  app.post<{ Params: { id: string } }>('/users/:id/revoke-access', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    app.db.transaction((tx) => {
      const user = tx.select({ id: users.id }).from(users).where(eq(users.id, request.params.id)).get()
      if (!user) throw notFound('Account', request.params.id)
      revokeUserAccess(tx, user.id)
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.access_revoked',
        entityType: 'user',
        entityId: user.id,
        diff: { accessRevoked: true },
      }))
    })
    return { revoked: true }
  })

  app.delete<{ Params: { name: string } }>('/users/:name', { config: { writeScope: USERS_WRITE_SCOPE } }, async (request) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    const nameKey = normalizeUserName(decodeURIComponent(request.params.name))
    const deleted = app.db.transaction((tx) => {
      const row = tx.select().from(users).where(eq(users.nameKey, nameKey)).get()
      if (!row) throw notFound('Account', request.params.name)
      if (
        row.role === UserRoles.admin
        && row.status === UserStatuses.active
        && row.passwordHash !== null
        && countActivePasswordAdmins(tx, row.id) === 0
      ) {
        throw validationError('At least one active administrator with a password must remain.')
      }
      revokeUserAccess(tx, row.id)
      tx.delete(users).where(eq(users.id, row.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.deleted',
        entityType: 'user',
        entityId: row.id,
        diff: { name: row.name, role: row.role, status: row.status },
      }))
      return row
    })

    return { deleted: true, name: deleted.name }
  })
}

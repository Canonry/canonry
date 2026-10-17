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
import { asc, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { users, userSessions } from '@canonry/canonry-db'
import {
  alreadyExists,
  createUserRequestSchema,
  forbidden,
  normalizeUserName,
  notFound,
  UserRoles,
  validationError,
  type UserDto,
} from '@canonry/canonry-contracts'
import {
  requireAdminSession,
  requireBroadInstanceKey,
  requireScope,
  USERS_READ_SCOPE,
  USERS_WRITE_SCOPE,
} from './auth.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'
import { hashUserPassword } from './user-password.js'

// The scope tokens live in `auth.ts` beside the gate that reads them, so the
// gate and the routes can never disagree about what grants what.
export { USERS_READ_SCOPE, USERS_WRITE_SCOPE } from './auth.js'

/** Map a stored row to the safe shape. Never carries the password digest. */
function toUserDto(row: typeof users.$inferSelect): UserDto {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
  }
}

function countAdmins(app: FastifyInstance): number {
  return app.db.select({ id: users.id }).from(users).where(eq(users.role, UserRoles.admin)).all().length
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

  app.post('/users', async (request, reply) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    const parsed = createUserRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('That account could not be created.', { issues: parsed.error.issues })
    }
    const { name, password, role } = parsed.data
    const nameKey = normalizeUserName(name)

    if (app.db.select({ id: users.id }).from(users).where(eq(users.nameKey, nameKey)).get()) {
      throw alreadyExists('Account', name)
    }

    // Creating the first account turns sign-in on for everyone. If that account
    // is view-only, the install lands somewhere nobody can get out of from the
    // dashboard: sign-in is required, and no signed-in person can change
    // anything, including creating the administrator who could.
    const isFirstAccount = app.db.select({ id: users.id }).from(users).limit(1).get() === undefined
    if (isFirstAccount && role !== UserRoles.admin) {
      throw validationError(
        'The first account has to be an administrator — creating it is what turns sign-in on, '
        + 'and a view-only account could not then set anything up.',
      )
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const passwordHash = await hashUserPassword(password)

    app.db.transaction((tx) => {
      tx.insert(users).values({
        id,
        name: name.trim(),
        nameKey,
        passwordHash,
        role,
        createdAt: now,
      }).run()
      // The audit entry records WHO was created and with what authority. It
      // never records the password, in any form, hashed or otherwise.
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.created',
        entityType: 'user',
        entityId: id,
        diff: { name: name.trim(), role },
      }))
    })

    return reply.status(201).send(toUserDto({
      id,
      name: name.trim(),
      nameKey,
      passwordHash: '',
      role,
      createdAt: now,
      lastLoginAt: null,
    }))
  })

  app.delete<{ Params: { name: string } }>('/users/:name', async (request) => {
    refuseProjectScopedKey(request)
    requireAdminSession(request)
    requireBroadInstanceKey(request)
    requireScope(request, USERS_WRITE_SCOPE)

    const nameKey = normalizeUserName(decodeURIComponent(request.params.name))
    const row = app.db.select().from(users).where(eq(users.nameKey, nameKey)).get()
    if (!row) throw notFound('Account', request.params.name)

    // Deleting the last admin would leave an install nobody can administer
    // from the dashboard. Refuse and say so.
    if (row.role === UserRoles.admin && countAdmins(app) === 1) {
      throw validationError(
        'This is the only administrator account. Create another administrator before deleting this one.',
      )
    }

    app.db.transaction((tx) => {
      // Sessions cascade with the row, but delete them explicitly so the intent
      // is legible: removing an account ends access now, not at expiry.
      tx.delete(userSessions).where(eq(userSessions.userId, row.id)).run()
      tx.delete(users).where(eq(users.id, row.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.deleted',
        entityType: 'user',
        entityId: row.id,
        diff: { name: row.name, role: row.role },
      }))
    })

    return { deleted: true, name: row.name }
  })
}

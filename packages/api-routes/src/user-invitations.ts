/**
 * Invitations to sign in with ChatGPT.
 *
 * An administrator (or a full-instance API key) invites an email address with
 * a role. The invited person then signs in with ChatGPT; if OpenAI reports
 * that address as verified on their ChatGPT account, their account is created
 * with the invited role. Nothing is sent: tell the person to open the
 * dashboard and choose "Continue with ChatGPT".
 *
 * Same authority as creating an account (`POST /users`), because accepting an
 * invitation creates one.
 */
import crypto from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { userInvitations, users } from '@canonry/canonry-db'
import {
  createUserInvitationRequestSchema,
  forbidden,
  normalizeInvitationEmail,
  notFound,
  USER_INVITATION_TTL_MS,
  UserInvitationStatuses,
  UserRoles,
  validationError,
  type UserInvitationDto,
  type UserInvitationListDto,
} from '@canonry/canonry-contracts'
import {
  requireAdminSession,
  requireBroadInstanceKey,
  requireScope,
  USERS_READ_SCOPE,
  USERS_WRITE_SCOPE,
} from './auth.js'
import { auditFromRequest, writeAuditLog } from './helpers.js'

type InvitationRow = typeof userInvitations.$inferSelect

export function invitationStatus(row: InvitationRow, now: number): UserInvitationDto['status'] {
  if (row.acceptedAt) return UserInvitationStatuses.accepted
  if (row.revokedAt) return UserInvitationStatuses.revoked
  if (Date.parse(row.expiresAt) <= now) return UserInvitationStatuses.expired
  return UserInvitationStatuses.pending
}

/** Invitations, like accounts, belong to the whole install. */
function authorize(request: FastifyRequest, scope: string): void {
  if (request.principal?.projectId) {
    throw forbidden('This API key is limited to one project, and invitations are shared by the whole install.')
  }
  requireAdminSession(request)
  requireBroadInstanceKey(request)
  requireScope(request, scope)
}

export interface UserInvitationRoutesOptions {
  /** Injectable clock for tests. */
  now?: () => number
}

export async function userInvitationRoutes(app: FastifyInstance, opts: UserInvitationRoutesOptions = {}) {
  const now = opts.now ?? Date.now

  const toDto = (row: InvitationRow): UserInvitationDto => {
    const accepted = row.acceptedUserId
      ? app.db.select({ name: users.name }).from(users).where(eq(users.id, row.acceptedUserId)).get()
      : undefined
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: invitationStatus(row, now()),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt ?? null,
      acceptedUserName: accepted?.name ?? null,
    }
  }

  app.get('/users/invitations', async (request): Promise<UserInvitationListDto> => {
    authorize(request, USERS_READ_SCOPE)
    const rows = app.db.select().from(userInvitations).orderBy(desc(userInvitations.createdAt)).all()
    return { invitations: rows.map(toDto) }
  })

  app.post('/users/invitations', async (request, reply) => {
    authorize(request, USERS_WRITE_SCOPE)
    const parsed = createUserInvitationRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('That invitation could not be created.', { issues: parsed.error.issues })
    const { email, role } = parsed.data
    // The first account turns sign-in on for everyone, so it has to be one
    // that can administer the install (the rule POST /users applies).
    const anyAccount = app.db.select({ id: users.id }).from(users).limit(1).get() !== undefined
    if (!anyAccount && role !== UserRoles.admin) {
      throw validationError(
        'The first account has to be an administrator. Invite an administrator first, or create one with a password.',
      )
    }
    const emailKey = normalizeInvitationEmail(email)
    const nowMs = now()
    const nowIso = new Date(nowMs).toISOString()
    const id = crypto.randomUUID()
    const createdById = request.principal?.kind === 'user' ? request.principal.id : request.principal?.delegatedUser?.id ?? null
    const row: InvitationRow = {
      id,
      email: email.trim(),
      emailKey,
      role,
      createdById,
      createdAt: nowIso,
      expiresAt: new Date(nowMs + USER_INVITATION_TTL_MS).toISOString(),
      acceptedAt: null,
      acceptedUserId: null,
      revokedAt: null,
    }
    app.db.transaction((tx) => {
      // One live invitation per address: inviting again replaces the role and
      // restarts the clock rather than leaving two that disagree.
      tx.update(userInvitations).set({ revokedAt: nowIso }).where(and(
        eq(userInvitations.emailKey, emailKey),
        isNull(userInvitations.acceptedAt),
        isNull(userInvitations.revokedAt),
      )).run()
      tx.insert(userInvitations).values(row).run()
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.invited',
        entityType: 'user-invitation',
        entityId: id,
        diff: { email: row.email, role },
      }))
    })
    return reply.status(201).send(toDto(row))
  })

  app.delete<{ Params: { id: string } }>('/users/invitations/:id', async (request) => {
    authorize(request, USERS_WRITE_SCOPE)
    const row = app.db.select().from(userInvitations).where(eq(userInvitations.id, request.params.id)).get()
    if (!row) throw notFound('Invitation', request.params.id)
    if (invitationStatus(row, now()) !== UserInvitationStatuses.pending) {
      throw validationError(`That invitation is already ${invitationStatus(row, now())}.`)
    }
    const nowIso = new Date(now()).toISOString()
    app.db.transaction((tx) => {
      tx.update(userInvitations).set({ revokedAt: nowIso }).where(eq(userInvitations.id, row.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        actor: 'api',
        action: 'user.invitation-revoked',
        entityType: 'user-invitation',
        entityId: row.id,
        diff: { email: row.email, role: row.role },
      }))
    })
    return toDto({ ...row, revokedAt: nowIso })
  })
}

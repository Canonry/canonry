/**
 * Durable named-account access state and cross-carrier revocation.
 *
 * This stays independent of Fastify so server startup, HTTP account routes,
 * and future Google/invitation flows share the exact same invariants.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import {
  apiKeys,
  googleLoginTransactions,
  oauthAuthorizationCodes,
  oauthTokens,
  userAuthState,
  users,
  userSessions,
} from '@ainyc/canonry-db'
import { UserRoles, type UserDto } from '@ainyc/canonry-contracts'

const INSTANCE_AUTH_STATE_ID = 'instance'

type UserAccessWriteDb = Pick<DatabaseClient, 'delete' | 'update'>

/** Map a database row to public account metadata, never including a digest. */
export function toUserDto(row: typeof users.$inferSelect): UserDto {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName ?? null,
    email: row.email ?? null,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    authVersion: row.authVersion,
    hasPassword: row.passwordHash !== null,
  }
}

/**
 * Apply the one-time role migration before authentication is admitted.
 *
 * The deployment's legacy Viewer Research flag is read exactly once. Existing
 * grants are intentionally untouched: a stored delegated scope ceiling never
 * expands merely because its originating Viewer became an Analyst.
 */
export function initializeUserAccess(db: DatabaseClient, allowViewers: boolean): void {
  const now = new Date().toISOString()
  db.transaction((tx) => {
    const existingState = tx.select().from(userAuthState)
      .where(eq(userAuthState.id, INSTANCE_AUTH_STATE_ID)).get()
    const shouldApplyLegacyViewerGrant = existingState?.permissionsMigrationComplete !== true
    const accountExists = tx.select({ id: users.id }).from(users).limit(1).get() !== undefined

    if (!existingState) {
      tx.insert(userAuthState).values({
        id: INSTANCE_AUTH_STATE_ID,
        namedAuthenticationRequired: accountExists,
        permissionsMigrationComplete: false,
        createdAt: now,
        updatedAt: now,
      }).run()
    } else if (accountExists && !existingState.namedAuthenticationRequired) {
      // An old row cannot weaken a protected installation. This state only
      // ever moves false → true; deleting accounts never reverses it.
      tx.update(userAuthState).set({ namedAuthenticationRequired: true, updatedAt: now })
        .where(eq(userAuthState.id, INSTANCE_AUTH_STATE_ID)).run()
    }

    const pending = tx.select({ id: users.id, role: users.role })
      .from(users).where(eq(users.permissionsMigrated, false)).all()
    if (pending.length > 0) {
      if (shouldApplyLegacyViewerGrant && allowViewers) {
        tx.update(users).set({ role: UserRoles.analyst })
          .where(and(eq(users.role, UserRoles.viewer), eq(users.permissionsMigrated, false))).run()
      }
      tx.update(users).set({ permissionsMigrated: true })
        .where(eq(users.permissionsMigrated, false)).run()
    }

    const state = tx.select().from(userAuthState)
      .where(eq(userAuthState.id, INSTANCE_AUTH_STATE_ID)).get()
    if (!state?.permissionsMigrationComplete) {
      tx.update(userAuthState).set({ permissionsMigrationComplete: true, updatedAt: now })
        .where(eq(userAuthState.id, INSTANCE_AUTH_STATE_ID)).run()
    }
  })
}

/** Whether this installation remains protected after named auth was enabled. */
export function namedAuthenticationRequired(db: DatabaseClient): boolean {
  const state = db.select().from(userAuthState)
    .where(eq(userAuthState.id, INSTANCE_AUTH_STATE_ID)).get()
  if (state) return state.namedAuthenticationRequired
  // Safe fallback before startup initialization: old databases with an account
  // are protected, while fresh zero-account installs retain the API-key flow.
  return db.select({ id: users.id }).from(users).limit(1).get() !== undefined
}

/**
 * Invalidate every credential that was issued on behalf of one person.
 * Service/root keys have no delegated user id and remain deliberately intact.
 */
export function revokeUserAccess(
  dbOrTransaction: UserAccessWriteDb,
  userId: string,
  nowISO = new Date().toISOString(),
): void {
  dbOrTransaction.update(users)
    .set({ authVersion: sql`${users.authVersion} + 1` })
    .where(eq(users.id, userId)).run()
  dbOrTransaction.delete(googleLoginTransactions).where(eq(googleLoginTransactions.userId, userId)).run()
  dbOrTransaction.delete(userSessions).where(eq(userSessions.userId, userId)).run()
  dbOrTransaction.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)).run()
  dbOrTransaction.update(oauthTokens).set({ revokedAt: nowISO })
    .where(and(eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt))).run()
  dbOrTransaction.update(apiKeys).set({ revokedAt: nowISO })
    .where(and(eq(apiKeys.delegatedUserId, userId), isNull(apiKeys.revokedAt))).run()
}

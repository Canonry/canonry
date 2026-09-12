import { z } from 'zod'
import { READ_ONLY_SCOPE, RESEARCH_RUN_SCOPE, WILDCARD_SCOPE } from './scopes.js'

/**
 * Named sign-in accounts for the dashboard.
 *
 * An install with NO accounts behaves exactly as it always has: the dashboard
 * opens without a sign-in and the API key remains the only credential. Creating
 * the first account turns sign-in on for the whole install — that is the single
 * switch, and it is deliberately the act of creating an account rather than a
 * separate setting nobody would remember to turn on.
 *
 * Roles describe a person's instance-wide authority:
 *   - `admin`  — everything the install could already do, now behind a sign-in.
 *   - `analyst` — reads plus bounded Research runs.
 *   - `viewer` — reads only. Every request that changes something is refused.
 *
 * API keys are unaffected by any of this. A key and a signed-in person are two
 * separate ways to reach the same API, and neither one gates the other.
 */
export const UserRoles = {
  admin: 'admin',
  analyst: 'analyst',
  viewer: 'viewer',
} as const

export type UserRole = (typeof UserRoles)[keyof typeof UserRoles]

export const userRoleSchema = z.enum(['admin', 'analyst', 'viewer'])

export const UserStatuses = {
  active: 'active',
  suspended: 'suspended',
} as const

export type UserStatus = (typeof UserStatuses)[keyof typeof UserStatuses]

export const userStatusSchema = z.enum(['active', 'suspended'])

/** The effective capability ceiling for a named account role. */
export function userRoleScopes(role: UserRole): string[] {
  switch (role) {
    case UserRoles.admin:
      return [WILDCARD_SCOPE]
    case UserRoles.analyst:
      return [READ_ONLY_SCOPE, RESEARCH_RUN_SCOPE]
    case UserRoles.viewer:
      return [READ_ONLY_SCOPE]
  }
}

/**
 * Account names are the thing people type into the sign-in box, so they are
 * deliberately narrow: letters, digits, and the three separators that survive
 * being read aloud. Case is preserved but names are compared case-insensitively
 * (see `normalizeUserName`) so "Sam" and "sam" can never both exist.
 */
export const USER_NAME_PATTERN = /^[a-z\d][\w.-]{0,63}$/i

export const userNameSchema = z.string().regex(
  USER_NAME_PATTERN,
  'A name may use letters, digits, dots, dashes and underscores, and must start with a letter or digit.',
)

/**
 * The floor for a password. Short enough that nobody is fighting the form,
 * long enough that a stolen database is not a wordlist away from every account.
 */
export const USER_PASSWORD_MIN_LENGTH = 12

export const userPasswordSchema = z.string().min(
  USER_PASSWORD_MIN_LENGTH,
  `A password must be at least ${USER_PASSWORD_MIN_LENGTH} characters.`,
)

/** Compare and store names case-insensitively so near-duplicates cannot exist. */
export function normalizeUserName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * SAFE, public-facing account metadata. This is the only shape the API returns
 * for an account: no password hash, no salt, nothing derived from either.
 */
export const userDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  role: userRoleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  authVersion: z.number().int().nonnegative(),
  hasPassword: z.boolean(),
})

export type UserDto = z.infer<typeof userDtoSchema>

/** List response for `GET /users`. */
export const userListDtoSchema = z.object({
  users: z.array(userDtoSchema),
})

export type UserListDto = z.infer<typeof userListDtoSchema>

/** Request body for `POST /users`. */
export const createUserRequestSchema = z.object({
  name: userNameSchema,
  password: userPasswordSchema,
  role: userRoleSchema,
  /** Refuse if this instance has ever enabled named accounts; used by first-run setup. */
  onlyIfFirstAdmin: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
})

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>

/** Request body for `PATCH /users/:id`. Null clears optional profile fields. */
export const updateUserRequestSchema = z.object({
  role: userRoleSchema.optional(),
  status: userStatusSchema.optional(),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
})

export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>

/** Request body for `POST /auth/login`. */
export const loginRequestSchema = z.object({
  name: z.string().min(1),
  password: z.string().min(1),
})

export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * Response for `GET /auth/session` — what the dashboard needs before it draws
 * anything.
 *
 * `authRequired: false` is the zero-accounts install: no sign-in screen, the
 * dashboard opens straight up, exactly as it always did.
 */
export const authSessionDtoSchema = z.object({
  /** True once at least one account exists, so the dashboard must sign in. */
  authRequired: z.boolean(),
  /** The signed-in person, or null when nobody is signed in. */
  user: userDtoSchema.nullable(),
})

export type AuthSessionDto = z.infer<typeof authSessionDtoSchema>

/** The message returned for every failed sign-in, whatever actually went wrong. */
export const LOGIN_FAILED_MESSAGE = 'Incorrect name or password.'

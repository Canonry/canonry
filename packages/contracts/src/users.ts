import { z } from 'zod'

/**
 * Named sign-in accounts for the dashboard.
 *
 * An install with NO accounts behaves exactly as it always has: the dashboard
 * opens without a sign-in and the API key remains the only credential. Creating
 * the first account turns sign-in on for the whole install — that is the single
 * switch, and it is deliberately the act of creating an account rather than a
 * separate setting nobody would remember to turn on.
 *
 * There are two roles and no plans for a third:
 *   - `admin`  — everything the install could already do, now behind a sign-in.
 *   - `viewer` — reads only. Every request that changes something is refused.
 *
 * API keys are unaffected by any of this. A key and a signed-in person are two
 * separate ways to reach the same API, and neither one gates the other.
 */
export const UserRoles = {
  admin: 'admin',
  viewer: 'viewer',
} as const

export type UserRole = (typeof UserRoles)[keyof typeof UserRoles]

export const userRoleSchema = z.enum(['admin', 'viewer'])

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
  role: userRoleSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
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
})

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>

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
  user: userDtoSchema.pick({ name: true, role: true }).nullable(),
  /**
   * Sign-in methods beyond name and password that the sign-in screen should
   * offer. Absent on an install that has none, so older dashboards and
   * clients read the same shape they always did.
   */
  signInMethods: z.object({
    chatgpt: z.boolean(),
  }).optional(),
})

export type AuthSessionDto = z.infer<typeof authSessionDtoSchema>

/** The message returned for every failed sign-in, whatever actually went wrong. */
export const LOGIN_FAILED_MESSAGE = 'Incorrect name or password.'

/**
 * Invitations let a person who has no account yet sign in with an external
 * identity (Sign in with ChatGPT). An administrator invites an email address
 * with a role; the first sign-in whose VERIFIED email matches creates the
 * account with that role and binds the external identity to it. From then on
 * the identity, not the email, is what signs that person in.
 *
 * An invitation never attaches to an account that already exists: a matching
 * email on an existing account is refused, and linking an existing account is
 * done by that account's owner while signed in.
 */
export const USER_INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const UserInvitationStatuses = {
  pending: 'pending',
  accepted: 'accepted',
  revoked: 'revoked',
  expired: 'expired',
} as const

export type UserInvitationStatus = (typeof UserInvitationStatuses)[keyof typeof UserInvitationStatuses]

/** Compare invitation emails case-insensitively; addresses are matched, never displayed, in this form. */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Domain labels exclude the dot that separates them, so the pattern cannot
// backtrack: every character has exactly one place it can match.
const INVITATION_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

export const invitationEmailSchema = z.string().trim().min(3).max(320)
  .regex(INVITATION_EMAIL_PATTERN, 'Enter an email address.')

/** Request body for `POST /users/invitations`. */
export const createUserInvitationRequestSchema = z.object({
  email: invitationEmailSchema,
  role: userRoleSchema,
})

export type CreateUserInvitationRequest = z.infer<typeof createUserInvitationRequestSchema>

export const userInvitationDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: userRoleSchema,
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  /** The account the invitation created, once accepted. */
  acceptedUserName: z.string().nullable(),
})

export type UserInvitationDto = z.infer<typeof userInvitationDtoSchema>

/** List response for `GET /users/invitations`. */
export const userInvitationListDtoSchema = z.object({
  invitations: z.array(userInvitationDtoSchema),
})

export type UserInvitationListDto = z.infer<typeof userInvitationListDtoSchema>

import { z } from 'zod'
import { userRoleSchema } from './users.js'

/** Login configuration is independent of Google's project integrations. */
export const googleSignInConfigSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().trim().min(1).max(512).optional(),
  clientSecret: z.string().min(1).max(4096).optional(),
})
export type GoogleSignInConfig = z.infer<typeof googleSignInConfigSchema>

export const updateGoogleSignInRequestSchema = googleSignInConfigSchema.partial()
export type UpdateGoogleSignInRequest = z.infer<typeof updateGoogleSignInRequestSchema>

export const googleSignInSettingsDtoSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  callbackUrl: z.string().nullable(),
  environmentOverride: z.boolean(),
  editable: z.boolean(),
})
export type GoogleSignInSettingsDto = z.infer<typeof googleSignInSettingsDtoSchema>

export const authProvidersDtoSchema = z.object({
  google: z.object({ enabled: z.boolean(), startUrl: z.string().nullable() }),
})
export type AuthProvidersDto = z.infer<typeof authProvidersDtoSchema>

export const USER_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const GOOGLE_LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000
export const USER_ACTIVITY_INTERVAL_MS = 5 * 60 * 1000

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired'])
export const InvitationStatuses = invitationStatusSchema.enum
export const invitationEmailSchema = z.string().trim().email().max(254)

/** Do not apply Gmail-specific dot/plus rewriting to another mailbox provider. */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase()
}

export const createUserInvitationRequestSchema = z.object({
  email: invitationEmailSchema,
  role: userRoleSchema,
})
export type CreateUserInvitationRequest = z.infer<typeof createUserInvitationRequestSchema>

export const userInvitationDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: userRoleSchema,
  status: invitationStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
})
export type UserInvitationDto = z.infer<typeof userInvitationDtoSchema>
export const userInvitationListDtoSchema = z.object({ invitations: z.array(userInvitationDtoSchema) })
export type UserInvitationListDto = z.infer<typeof userInvitationListDtoSchema>
export const createdUserInvitationDtoSchema = z.object({
  invitation: userInvitationDtoSchema,
  invitationUrl: z.string(),
})
export type CreatedUserInvitationDto = z.infer<typeof createdUserInvitationDtoSchema>

export const authMethodDtoSchema = z.object({
  id: z.string(),
  provider: z.enum(['password', 'google']),
  email: z.string().nullable(),
  createdAt: z.string(),
})
export const authMethodsDtoSchema = z.object({ methods: z.array(authMethodDtoSchema) })
export type AuthMethodsDto = z.infer<typeof authMethodsDtoSchema>

export const googleLinkRequestSchema = z.object({ password: z.string().min(1) })
export const authRedirectDtoSchema = z.object({ redirectUrl: z.string() })
export type AuthRedirectDto = z.infer<typeof authRedirectDtoSchema>
export const authActionDtoSchema = z.object({ ok: z.literal(true) })
export type AuthActionDto = z.infer<typeof authActionDtoSchema>

export const userAccessHistoryDtoSchema = z.object({
  events: z.array(z.object({
    id: z.string(),
    action: z.string(),
    actorUserId: z.string().nullable(),
    actorName: z.string().nullable(),
    createdAt: z.string(),
  })),
})
export type UserAccessHistoryDto = z.infer<typeof userAccessHistoryDtoSchema>

export const googleStartRequestSchema = z.object({ invitationToken: z.string().min(32).max(128).optional(), returnTo: z.string().max(4096).optional() })
export type GoogleStartRequest = z.infer<typeof googleStartRequestSchema>
export const revokeUserAccessDtoSchema = z.object({ revoked: z.literal(true) })

import { z } from 'zod'

/**
 * Sign in with ChatGPT: OpenAI's hosted OAuth 2.0 + OpenID Connect provider.
 *
 * Two separate things ride on it, and an install turns each on by itself:
 *
 *   - SIGN-IN. An invited person signs in to the dashboard with their ChatGPT
 *     account instead of a name and password. Only identity scopes are needed.
 *   - PLAN USAGE. Aero's model calls for that person run on their own ChatGPT
 *     plan. This needs OpenAI's plan scopes, which OpenAI grants a hosted app
 *     separately from sign-in, and the person consents to it on OpenAI's page.
 *
 * A login never quietly turns into plan usage, and plan usage never quietly
 * falls back to the install's own provider key: a person whose plan cannot
 * answer gets told so.
 */

/** The only issuer an ID token is accepted from. */
export const CHATGPT_ISSUER = 'https://auth.openai.com'

/** OpenID discovery document for the issuer. */
export const CHATGPT_DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`

/**
 * The resource plan tokens are issued for, and the only host they are ever
 * sent to. A configured OpenAI proxy (`OPENAI_BASE_URL`, a provider base URL)
 * must never receive a person's ChatGPT token.
 */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'

/**
 * `chatgpt.tokenKey`: 32 bytes as 64 hex characters (`openssl rand -hex 32`).
 * The one definition, shared by config validation and the key parser.
 */
export const CHATGPT_TOKEN_KEY_PATTERN = /^[\da-f]{64}$/i

export function isChatGptTokenKey(value: unknown): value is string {
  return typeof value === 'string' && CHATGPT_TOKEN_KEY_PATTERN.test(value.trim())
}

/** Where a person checks and manages their ChatGPT plan usage. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export const CHATGPT_IDENTITY_SCOPES = ['openid', 'profile', 'email'] as const

/** Plan usage: offline refresh plus the two scopes that let a token call models. */
export const CHATGPT_PLAN_SCOPES = ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] as const

/** Both must be granted for a token to call models. Granted scopes are authoritative. */
export const CHATGPT_INFERENCE_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'] as const

/**
 * Why the browser is going to OpenAI.
 *
 * - `login`: nobody is signed in; come back signed in (as an invited person
 *   or an already-linked account).
 * - `connect`: a signed-in person links their ChatGPT account, and on an
 *   install with plan usage on, lets Aero use their plan.
 */
export const ChatGptSignInIntents = {
  login: 'login',
  connect: 'connect',
} as const

export type ChatGptSignInIntent = (typeof ChatGptSignInIntents)[keyof typeof ChatGptSignInIntents]

export const chatGptSignInIntentSchema = z.enum(['login', 'connect'])

export const ChatGptPlanStatuses = {
  /** No plan grant: identity only, never connected, or disconnected. */
  notConnected: 'not-connected',
  /** A grant that can call models. */
  connected: 'connected',
  /** The grant stopped working (revoked in ChatGPT, refresh refused); connect again. */
  reconnectRequired: 'reconnect-required',
} as const

export type ChatGptPlanStatus = (typeof ChatGptPlanStatuses)[keyof typeof ChatGptPlanStatuses]

export const chatGptPlanStatusSchema = z.enum(['not-connected', 'connected', 'reconnect-required'])

/**
 * Why a ChatGPT sign-in came back without completing. The callback redirects
 * to the dashboard with one of these in `chatgpt_error`, never provider text.
 */
export const ChatGptSignInErrors = {
  disabled: 'disabled',
  notInvited: 'not-invited',
  denied: 'denied',
  expired: 'expired',
  alreadyLinked: 'already-linked',
  unverifiedEmail: 'unverified-email',
  failed: 'failed',
} as const

export type ChatGptSignInError = (typeof ChatGptSignInErrors)[keyof typeof ChatGptSignInErrors]

export const chatGptSignInErrorSchema = z.enum([
  'disabled',
  'not-invited',
  'denied',
  'expired',
  'already-linked',
  'unverified-email',
  'failed',
])

/** What the sign-in screen says for each error. Plain, and never names the account. */
export const CHATGPT_SIGN_IN_ERROR_MESSAGES: Readonly<Record<ChatGptSignInError, string>> = {
  disabled: 'Sign in with ChatGPT is not turned on for this dashboard.',
  'not-invited': 'That ChatGPT account has not been invited to this dashboard. Ask an administrator to invite the email address it uses.',
  denied: 'ChatGPT sign-in was cancelled.',
  expired: 'That sign-in took too long or was opened in another browser. Try again.',
  'already-linked': 'That ChatGPT account is already linked to a different account here.',
  'unverified-email': 'ChatGPT has not verified the email address on that account, so it cannot be matched to an invitation.',
  failed: 'ChatGPT sign-in did not complete. Try again.',
}

/** The signed-in person's ChatGPT link and plan. */
export const chatGptAccountStatusSchema = z.object({
  /** True once a ChatGPT account is linked to this person. */
  linked: z.boolean(),
  /** The linked ChatGPT account's email, as OpenAI reported it at the last sign-in. */
  email: z.string().nullable(),
  plan: z.object({
    status: chatGptPlanStatusSchema,
    /** The model Aero uses on this plan, once one has been chosen. */
    modelId: z.string().nullable(),
    connectedAt: z.string().nullable(),
  }),
})

export type ChatGptAccountStatus = z.infer<typeof chatGptAccountStatusSchema>

/** `GET /auth/chatgpt/status`. Safe to read before signing in: the account is null then. */
export const chatGptStatusDtoSchema = z.object({
  signInEnabled: z.boolean(),
  planUsageEnabled: z.boolean(),
  /** True when a viewer must connect their own ChatGPT plan to use Aero at all (`chatgpt.requirePlan`). */
  planRequired: z.boolean(),
  usageUrl: z.string(),
  account: chatGptAccountStatusSchema.nullable(),
})

export type ChatGptStatusDto = z.infer<typeof chatGptStatusDtoSchema>

/** One model the person's plan can use, in the order OpenAI listed them. */
export const chatGptModelDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export type ChatGptModelDto = z.infer<typeof chatGptModelDtoSchema>

/** `GET /auth/chatgpt/models`. */
export const chatGptModelListDtoSchema = z.object({
  models: z.array(chatGptModelDtoSchema),
  selected: z.string().nullable(),
})

export type ChatGptModelListDto = z.infer<typeof chatGptModelListDtoSchema>

/** `PUT /auth/chatgpt/model`. */
export const chatGptModelSelectionRequestSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
})

export type ChatGptModelSelectionRequest = z.infer<typeof chatGptModelSelectionRequestSchema>

/**
 * Error prefixes a plan-funded Aero turn uses. A viewer never sees raw
 * provider text, but these are written for them: they say what to do next.
 */
export const CHATGPT_AERO_ERRORS = {
  connectRequired: 'CHATGPT_CONNECT_REQUIRED: Connect your ChatGPT plan to use Aero on this dashboard.',
  reconnect: 'CHATGPT_RECONNECT_REQUIRED: Your ChatGPT connection stopped working. Connect ChatGPT again to keep using Aero on your plan.',
  usageLimit: `CHATGPT_USAGE_LIMIT: Your ChatGPT plan has reached its usage limit for now. Check your usage at ${CHATGPT_USAGE_URL}.`,
  notEligible: 'CHATGPT_PLAN_NOT_ELIGIBLE: Your ChatGPT plan cannot be used by other apps. Plan usage needs an eligible ChatGPT plan, such as Plus or Pro.',
  unavailable: 'CHATGPT_UNAVAILABLE: ChatGPT could not answer right now. Try again in a minute.',
  failed: 'CHATGPT_FAILED: ChatGPT could not finish this Aero answer. Try again.',
} as const

export type ChatGptAeroError = (typeof CHATGPT_AERO_ERRORS)[keyof typeof CHATGPT_AERO_ERRORS]

/** True for a message that is one of the plan errors above, which is safe to show a viewer as-is. */
export function isChatGptAeroError(message: string | undefined): boolean {
  if (!message) return false
  return (Object.values(CHATGPT_AERO_ERRORS) as string[]).includes(message)
}

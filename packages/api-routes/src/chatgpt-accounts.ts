/**
 * Who may sign in with ChatGPT, and each person's ChatGPT plan grant.
 *
 * Sign-in admits exactly two kinds of people:
 *
 *   - someone whose ChatGPT identity is already linked to an account here, and
 *   - someone holding a pending invitation for the VERIFIED email address on
 *     their ChatGPT account, which creates their account with the invited role.
 *
 * Anyone else is refused, however valid their ChatGPT account. An email match
 * never attaches to an account that already exists: an existing account links
 * ChatGPT only while its owner is signed in (`connect`).
 *
 * Plan grants are stored encrypted under the install's token key and used for
 * that person's own Aero turns only. A refresh is a compare-and-swap on the
 * row's revision, because OpenAI rotates refresh tokens and writing an older
 * refresh over a newer one would strand the account.
 */
import crypto from 'node:crypto'
import { and, eq, isNull, lte } from 'drizzle-orm'
import {
  chatgptLoginTransactions,
  chatgptPlanConnections,
  userExternalIdentities,
  userInvitations,
  users,
  type DatabaseClient,
} from '@canonry/canonry-db'
import {
  CHATGPT_AERO_ERRORS,
  CHATGPT_IDENTITY_SCOPES,
  CHATGPT_INFERENCE_SCOPES,
  CHATGPT_ISSUER,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_RESOURCE,
  CHATGPT_USAGE_URL,
  ChatGptPlanStatuses,
  ChatGptSignInErrors,
  ChatGptSignInIntents,
  normalizeInvitationEmail,
  normalizeUserName,
  USER_NAME_PATTERN,
  UserRoles,
  type ChatGptAeroError,
  type ChatGptSignInError,
  type ChatGptSignInIntent,
  type ChatGptStatusDto,
  type UserRole,
} from '@canonry/canonry-contracts'
import {
  buildAuthorizeUrl,
  ChatGptJwks,
  ChatGptProtocolError,
  createPkcePair,
  exchangeChatGptCode,
  fetchChatGptMetadata,
  listChatGptPlanModels,
  refreshChatGptTokens,
  revokeChatGptToken,
  verifyChatGptIdToken,
  type ChatGptClientCredentials,
  type ChatGptMetadata,
  type ChatGptPlanModel,
  type FetchLike,
} from './chatgpt-oidc.js'

/** How long a started sign-in may take before its state is refused. */
export const CHATGPT_SIGN_IN_TTL_MS = 10 * 60 * 1000

/** A plan token this close to expiry is refreshed before use. */
const ACCESS_REFRESH_MARGIN_MS = 3 * 60 * 1000

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000
const METADATA_TTL_MS = 60 * 60 * 1000

/**
 * Stored in `users.password_hash` for an account created through an
 * invitation. It is not an scrypt digest, so no password ever matches it, and
 * the password checker treats it as an unknown account (same cost, same
 * answer), so the sign-in form cannot be used to find these accounts.
 */
export const EXTERNAL_SIGN_IN_PASSWORD_HASH = 'external$chatgpt'

/** OAuth errors on refresh that mean the grant is gone, not that OpenAI is briefly unavailable. */
const REFRESH_GRANT_GONE = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

/** What the install has turned on, resolved from config on every call. */
export interface ChatGptSignInSettings {
  clientId: string
  /** Only for a confidential client. */
  clientSecret?: string
  /** Offer "Continue with ChatGPT" on the sign-in screen. */
  signIn: boolean
  /** Request plan scopes and run viewers' Aero on their own plan. Needs `tokenKey`. */
  planUsage: boolean
  /** Viewers must connect their own plan to use Aero; the install's key never funds viewer Aero. */
  requirePlan?: boolean
  /** 32-byte AES key for plan tokens at rest. Null turns plan usage off. */
  tokenKey: Buffer | null
  /** The exact callback URL registered with OpenAI. */
  redirectUri: string
}

export type ChatGptSettingsSource = () => ChatGptSignInSettings | null

export type ChatGptCallbackResult =
  | {
      ok: true
      intent: ChatGptSignInIntent
      userId: string
      /** Set when this sign-in created the account from an invitation. */
      createdAccount: { name: string; role: UserRole; invitationId: string } | null
      /** True when this sign-in linked a ChatGPT identity that was not linked before. */
      linked: boolean
      /** What happened to the plan grant. */
      plan: 'connected' | 'declined' | 'off'
      returnTo: string | null
    }
  | { ok: false; error: ChatGptSignInError; returnTo: string | null }

/** Why a plan-funded Aero turn cannot run. The message is safe to show the person. */
export class ChatGptPlanError extends Error {
  constructor(
    readonly kind: 'off' | 'not-connected' | 'reconnect' | 'unavailable' | 'usage-limit' | 'not-eligible',
    message: ChatGptAeroError | string,
  ) {
    super(message)
    this.name = 'ChatGptPlanError'
  }
}

export interface ChatGptPlanAccess {
  connectionId: string
  accessToken: string
  modelId: string | null
}

interface StoredTokens {
  accessToken: string
  refreshToken: string
}

/** Parse a 64-hex-character key. Anything else is null, and plan usage stays off. */
export function parseChatGptTokenKey(value: string | undefined | null): Buffer | null {
  if (!value || !/^[\da-f]{64}$/i.test(value.trim())) return null
  return Buffer.from(value.trim(), 'hex')
}

function tokensAad(connectionId: string, userId: string): Buffer {
  return Buffer.from(`canonry:chatgpt-plan:v1:${connectionId}:${userId}`)
}

export function encryptPlanTokens(key: Buffer, connectionId: string, userId: string, tokens: StoredTokens): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(tokensAad(connectionId, userId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

/** Null on any failure: wrong key, tampered row, or a row copied onto another connection. */
export function decryptPlanTokens(key: Buffer, connectionId: string, userId: string, value: string): StoredTokens | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return null
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1]!, 'base64url'))
    decipher.setAAD(tokensAad(connectionId, userId))
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()])
    const parsed = JSON.parse(plaintext.toString('utf8')) as Partial<StoredTokens>
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') return null
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function grantsInference(scopes: readonly string[]): boolean {
  return CHATGPT_INFERENCE_SCOPES.every(scope => scopes.includes(scope))
}

/** A name for an account created from an invitation: the email's local part, made unique. */
export function accountNameForEmail(email: string, taken: (nameKey: string) => boolean): string {
  const local = email.split('@')[0] ?? ''
  const base = local.toLowerCase()
    .replace(/[^a-z\d._-]+/g, '-')
    .replace(/^[^a-z\d]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 56) || 'chatgpt-user'
  for (let attempt = 1; attempt <= 99; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`
    if (USER_NAME_PATTERN.test(candidate) && !taken(candidate)) return candidate
  }
  return `${base.slice(0, 48)}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * The model a plan-funded turn uses: the person's choice while their plan
 * still lists it, else the install's own Aero model when listed, else the
 * plan's first model. Null when the plan lists none.
 */
export function pickChatGptPlanModel(models: readonly ChatGptPlanModel[], chosen: string | null, preferred: string | null): string | null {
  const listed = (id: string | null): id is string => id !== null && models.some(model => model.id === id)
  if (listed(chosen)) return chosen
  if (listed(preferred)) return preferred
  return models[0]?.id ?? null
}

export interface ChatGptAccountsOptions {
  db: DatabaseClient
  settings: ChatGptSettingsSource
  fetch?: FetchLike
  now?: () => number
}

export class ChatGptAccounts {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly jwks: ChatGptJwks
  private metadata: { value: ChatGptMetadata; fetchedAt: number } | null = null
  private readonly refreshes = new Map<string, Promise<ChatGptPlanAccess>>()
  private readonly modelCache = new Map<string, { models: ChatGptPlanModel[]; fetchedAt: number }>()

  constructor(private readonly opts: ChatGptAccountsOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    this.jwks = new ChatGptJwks(this.fetchImpl, this.now)
  }

  /** Current settings, or null when ChatGPT is not configured at all. */
  settings(): ChatGptSignInSettings | null {
    const settings = this.opts.settings()
    if (!settings || !settings.clientId.trim()) return null
    return settings
  }

  signInEnabled(): boolean {
    return this.settings()?.signIn === true
  }

  /** Plan usage needs both the switch and a token key to keep grants at rest. */
  planUsageEnabled(): boolean {
    const settings = this.settings()
    return settings?.planUsage === true && settings.tokenKey !== null
  }

  /** Viewer Aero runs only on the viewer's own plan; without one there is no viewer Aero. */
  planRequired(): boolean {
    return this.planUsageEnabled() && this.settings()?.requirePlan === true
  }

  private credentials(settings: ChatGptSignInSettings): ChatGptClientCredentials {
    return { clientId: settings.clientId, ...(settings.clientSecret ? { clientSecret: settings.clientSecret } : {}) }
  }

  private async discovery(): Promise<ChatGptMetadata> {
    if (this.metadata && this.now() - this.metadata.fetchedAt < METADATA_TTL_MS) return this.metadata.value
    const value = await fetchChatGptMetadata(this.fetchImpl)
    this.metadata = { value, fetchedAt: this.now() }
    return value
  }

  private requestedScopes(): string[] {
    return [...CHATGPT_IDENTITY_SCOPES, ...(this.planUsageEnabled() ? CHATGPT_PLAN_SCOPES : [])]
  }

  /**
   * Start a sign-in. Returns OpenAI's authorization URL and the value for the
   * browser-binding cookie, which carries the PKCE verifier. Nothing secret is
   * written to the database.
   */
  async begin(input: { intent: ChatGptSignInIntent; userId: string | null; returnTo: string | null }): Promise<{ url: string; cookie: string }> {
    const settings = this.settings()
    if (!settings) throw new ChatGptProtocolError('ChatGPT sign-in is not configured.')
    if (input.intent === ChatGptSignInIntents.login && !settings.signIn) {
      throw new ChatGptProtocolError('ChatGPT sign-in is off.')
    }
    if (input.intent === ChatGptSignInIntents.connect && (!input.userId || (!settings.signIn && !this.planUsageEnabled()))) {
      throw new ChatGptProtocolError('Connecting ChatGPT is off.')
    }
    const metadata = await this.discovery()
    const state = randomToken()
    const nonce = randomToken()
    const binding = randomToken()
    const pkce = createPkcePair()
    const scopes = this.requestedScopes()
    const nowMs = this.now()
    const nowIso = new Date(nowMs).toISOString()
    this.opts.db.delete(chatgptLoginTransactions).where(lte(chatgptLoginTransactions.expiresAt, nowIso)).run()
    this.opts.db.insert(chatgptLoginTransactions).values({
      stateHash: sha256(state),
      browserHash: sha256(binding),
      intent: input.intent,
      userId: input.intent === ChatGptSignInIntents.connect ? input.userId : null,
      nonce,
      scopes: scopes.join(' '),
      returnTo: input.returnTo,
      createdAt: nowIso,
      expiresAt: new Date(nowMs + CHATGPT_SIGN_IN_TTL_MS).toISOString(),
    }).run()
    const url = buildAuthorizeUrl(metadata, {
      clientId: settings.clientId,
      redirectUri: settings.redirectUri,
      scopes,
      state,
      nonce,
      codeChallenge: pkce.challenge,
      resource: this.planUsageEnabled() ? CHATGPT_RESOURCE : null,
      // A deliberate connect shows consent again, which is also how someone
      // who once declined plan usage gets to grant it.
      forceConsent: input.intent === ChatGptSignInIntents.connect,
    })
    return { url, cookie: `${binding}.${pkce.verifier}` }
  }

  /**
   * Finish a sign-in from OpenAI's redirect. The transaction is consumed
   * before any network call, so a state can only ever be tried once.
   */
  async complete(input: { state?: string; code?: string; error?: string; cookie?: string }): Promise<ChatGptCallbackResult> {
    const fail = (error: ChatGptSignInError, returnTo: string | null = null): ChatGptCallbackResult => ({ ok: false, error, returnTo })
    if (!input.state) return fail(ChatGptSignInErrors.expired)
    const stateHash = sha256(input.state)
    const nowMs = this.now()
    const transaction = this.opts.db.transaction((tx) => {
      const row = tx.select().from(chatgptLoginTransactions).where(eq(chatgptLoginTransactions.stateHash, stateHash)).get()
      if (row) tx.delete(chatgptLoginTransactions).where(eq(chatgptLoginTransactions.stateHash, stateHash)).run()
      return row
    })
    if (!transaction || Date.parse(transaction.expiresAt) <= nowMs) return fail(ChatGptSignInErrors.expired)
    const returnTo = transaction.returnTo
    const [binding, verifier] = (input.cookie ?? '').split('.')
    if (!binding || !verifier || sha256(binding) !== transaction.browserHash) {
      return fail(ChatGptSignInErrors.expired, returnTo)
    }
    if (input.error) {
      return fail(input.error === 'access_denied' ? ChatGptSignInErrors.denied : ChatGptSignInErrors.failed, returnTo)
    }
    const settings = this.settings()
    const intent = transaction.intent
    if (!settings || (intent === ChatGptSignInIntents.login && !settings.signIn)) return fail(ChatGptSignInErrors.disabled, returnTo)
    if (!input.code) return fail(ChatGptSignInErrors.failed, returnTo)

    const requested = transaction.scopes.split(' ').filter(Boolean)
    const planRequested = grantsInference(requested)
    let identity: Awaited<ReturnType<typeof verifyChatGptIdToken>>
    let tokens: Awaited<ReturnType<typeof exchangeChatGptCode>>
    try {
      const metadata = await this.discovery()
      tokens = await exchangeChatGptCode(this.fetchImpl, metadata, this.credentials(settings), {
        code: input.code,
        codeVerifier: verifier,
        redirectUri: settings.redirectUri,
        resource: planRequested ? CHATGPT_RESOURCE : null,
      })
      if (!tokens.idToken) return fail(ChatGptSignInErrors.failed, returnTo)
      identity = await verifyChatGptIdToken(tokens.idToken, {
        metadata, jwks: this.jwks, clientId: settings.clientId, nonce: transaction.nonce, now: this.now(),
      })
    } catch {
      return fail(ChatGptSignInErrors.failed, returnTo)
    }

    // Granted scopes are authoritative; an omitted scope list grants nothing extra.
    const granted = tokens.scopes ?? []
    const planGranted = planRequested && this.planUsageEnabled() && grantsInference(granted) && tokens.refreshToken !== null
    const nowIso = new Date(this.now()).toISOString()

    const settled = this.opts.db.transaction((tx): { outcome: ChatGptCallbackResult; revoke: StoredTokens | null } => {
      let revoke: StoredTokens | null = null
      const existing = tx.select().from(userExternalIdentities).where(and(
        eq(userExternalIdentities.issuer, CHATGPT_ISSUER),
        eq(userExternalIdentities.clientId, settings.clientId),
        eq(userExternalIdentities.subject, identity.subject),
      )).get()

      let userId: string
      let identityId: string
      let createdAccount: { name: string; role: UserRole; invitationId: string } | null = null
      let linked = false

      if (intent === ChatGptSignInIntents.connect) {
        const owner = transaction.userId ? tx.select().from(users).where(eq(users.id, transaction.userId)).get() : undefined
        if (!owner) {
          return { outcome: fail(ChatGptSignInErrors.expired, returnTo), revoke }
        }
        if (existing && existing.userId !== owner.id) {
          return { outcome: fail(ChatGptSignInErrors.alreadyLinked, returnTo), revoke }
        }
        userId = owner.id
        if (existing) {
          identityId = existing.id
          tx.update(userExternalIdentities).set({ email: identity.email, lastLoginAt: nowIso }).where(eq(userExternalIdentities.id, existing.id)).run()
        } else {
          // Linking a different ChatGPT account replaces the old link; its plan
          // grant goes with it, and its tokens are revoked below.
          const previous = tx.select().from(userExternalIdentities).where(and(
            eq(userExternalIdentities.userId, owner.id),
            eq(userExternalIdentities.provider, 'chatgpt'),
          )).get()
          if (previous) {
            revoke = this.readTokens(tx, owner.id)
            tx.delete(userExternalIdentities).where(eq(userExternalIdentities.id, previous.id)).run()
          }
          identityId = crypto.randomUUID()
          tx.insert(userExternalIdentities).values({
            id: identityId, userId: owner.id, provider: 'chatgpt', issuer: CHATGPT_ISSUER,
            clientId: settings.clientId, subject: identity.subject, email: identity.email,
            createdAt: nowIso, lastLoginAt: nowIso,
          }).run()
          linked = true
        }
      } else if (existing) {
        const account = tx.select().from(users).where(eq(users.id, existing.userId)).get()
        if (!account) {
          return { outcome: fail(ChatGptSignInErrors.notInvited, returnTo), revoke }
        }
        userId = account.id
        identityId = existing.id
        tx.update(userExternalIdentities).set({ email: identity.email, lastLoginAt: nowIso }).where(eq(userExternalIdentities.id, existing.id)).run()
        tx.update(users).set({ lastLoginAt: nowIso }).where(eq(users.id, account.id)).run()
      } else {
        if (!identity.email) {
          return { outcome: fail(ChatGptSignInErrors.notInvited, returnTo), revoke }
        }
        if (!identity.emailVerified) {
          return { outcome: fail(ChatGptSignInErrors.unverifiedEmail, returnTo), revoke }
        }
        const emailKey = normalizeInvitationEmail(identity.email)
        const invitation = tx.select().from(userInvitations).where(and(
          eq(userInvitations.emailKey, emailKey),
          isNull(userInvitations.acceptedAt),
          isNull(userInvitations.revokedAt),
        )).all()
          .filter(row => Date.parse(row.expiresAt) > nowMs)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        if (!invitation) {
          return { outcome: fail(ChatGptSignInErrors.notInvited, returnTo), revoke }
        }
        // The first account turns sign-in on for everyone; it has to be able
        // to administer the install (same rule as POST /users).
        const anyAccount = tx.select({ id: users.id }).from(users).limit(1).get() !== undefined
        if (!anyAccount && invitation.role !== UserRoles.admin) {
          return { outcome: fail(ChatGptSignInErrors.notInvited, returnTo), revoke }
        }
        const name = accountNameForEmail(identity.email, nameKey =>
          tx.select({ id: users.id }).from(users).where(eq(users.nameKey, nameKey)).get() !== undefined)
        userId = crypto.randomUUID()
        tx.insert(users).values({
          id: userId, name, nameKey: normalizeUserName(name), passwordHash: EXTERNAL_SIGN_IN_PASSWORD_HASH,
          role: invitation.role, createdAt: nowIso, lastLoginAt: nowIso,
        }).run()
        identityId = crypto.randomUUID()
        tx.insert(userExternalIdentities).values({
          id: identityId, userId, provider: 'chatgpt', issuer: CHATGPT_ISSUER,
          clientId: settings.clientId, subject: identity.subject, email: identity.email,
          createdAt: nowIso, lastLoginAt: nowIso,
        }).run()
        tx.update(userInvitations).set({ acceptedAt: nowIso, acceptedUserId: userId }).where(eq(userInvitations.id, invitation.id)).run()
        createdAccount = { name, role: invitation.role, invitationId: invitation.id }
        linked = true
      }

      let plan: 'connected' | 'declined' | 'off' = 'off'
      if (planGranted) {
        this.storeGrant(tx, { userId, identityId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken!, scopes: granted, expiresInSeconds: tokens.expiresInSeconds, nowIso })
        plan = 'connected'
      } else if (planRequested && this.planUsageEnabled()) {
        // The person declined plan usage this time. A grant they gave earlier
        // is withdrawn with it: the latest consent is what counts.
        const declined = this.readTokens(tx, userId)
        if (declined) revoke ??= declined
        tx.delete(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).run()
        plan = 'declined'
      }
      return { outcome: { ok: true, intent, userId, createdAccount, linked, plan, returnTo }, revoke }
    })

    if (!planGranted && tokens.refreshToken) {
      // A refresh token this sign-in will not keep is revoked rather than left live.
      void this.revoke(settings, tokens.refreshToken, 'refresh_token')
    }
    if (settled.revoke) void this.revoke(settings, settled.revoke.refreshToken, 'refresh_token')
    return settled.outcome
  }

  private storeGrant(
    tx: Pick<DatabaseClient, 'insert' | 'select'>,
    input: { userId: string; identityId: string; accessToken: string; refreshToken: string; scopes: string[]; expiresInSeconds: number; nowIso: string },
  ): void {
    const key = this.settings()?.tokenKey
    if (!key) return
    const id = crypto.randomUUID()
    const previous = tx.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, input.userId)).get()
    const tokens = encryptPlanTokens(key, id, input.userId, { accessToken: input.accessToken, refreshToken: input.refreshToken })
    const accessExpiresAt = new Date(Date.parse(input.nowIso) + input.expiresInSeconds * 1000).toISOString()
    tx.insert(chatgptPlanConnections).values({
      userId: input.userId, id, identityId: input.identityId, status: 'connected',
      scopes: input.scopes.join(' '), tokens, accessExpiresAt,
      // A reconnect keeps the person's model choice.
      modelId: previous?.modelId ?? null,
      revision: (previous?.revision ?? 0) + 1,
      connectedAt: input.nowIso, updatedAt: input.nowIso,
    }).onConflictDoUpdate({
      target: chatgptPlanConnections.userId,
      set: {
        id, identityId: input.identityId, status: 'connected', scopes: input.scopes.join(' '), tokens,
        accessExpiresAt, revision: (previous?.revision ?? 0) + 1, connectedAt: input.nowIso, updatedAt: input.nowIso,
      },
    }).run()
    if (previous) this.modelCache.delete(previous.id)
  }

  private readTokens(tx: Pick<DatabaseClient, 'select'>, userId: string): StoredTokens | null {
    const key = this.settings()?.tokenKey
    const row = tx.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).get()
    if (!key || !row) return null
    return decryptPlanTokens(key, row.id, row.userId, row.tokens)
  }

  private async revoke(settings: ChatGptSignInSettings, token: string, hint: 'refresh_token' | 'access_token'): Promise<boolean> {
    try {
      return await revokeChatGptToken(this.fetchImpl, await this.discovery(), this.credentials(settings), token, hint)
    } catch {
      return false
    }
  }

  /** The signed-in person's link and plan, plus what the install offers. */
  status(userId: string | null): ChatGptStatusDto {
    const base = {
      signInEnabled: this.signInEnabled(),
      planUsageEnabled: this.planUsageEnabled(),
      planRequired: this.planRequired(),
      usageUrl: CHATGPT_USAGE_URL,
    }
    if (!userId) return { ...base, account: null }
    const identity = this.opts.db.select().from(userExternalIdentities).where(and(
      eq(userExternalIdentities.userId, userId),
      eq(userExternalIdentities.provider, 'chatgpt'),
    )).get()
    const connection = this.opts.db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).get()
    const status = !connection
      ? ChatGptPlanStatuses.notConnected
      : connection.status === 'connected' ? ChatGptPlanStatuses.connected : ChatGptPlanStatuses.reconnectRequired
    return {
      ...base,
      account: {
        linked: identity !== undefined,
        email: identity?.email ?? null,
        plan: {
          status,
          modelId: connection?.modelId ?? null,
          connectedAt: connection?.connectedAt ?? null,
        },
      },
    }
  }

  /**
   * Withdraw the plan grant: tokens are deleted here first, then revoked at
   * OpenAI. The ChatGPT link stays, so the person can still sign in with it.
   */
  async disconnect(userId: string): Promise<{ disconnected: boolean; revoked: boolean }> {
    const settings = this.settings()
    const tokens = this.readTokens(this.opts.db, userId)
    const row = this.opts.db.select({ id: chatgptPlanConnections.id }).from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).get()
    if (!row) return { disconnected: false, revoked: false }
    this.opts.db.delete(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).run()
    this.modelCache.delete(row.id)
    if (!settings || !tokens) return { disconnected: true, revoked: false }
    const revoked = await this.revoke(settings, tokens.refreshToken, 'refresh_token')
    return { disconnected: true, revoked }
  }

  /** Mark a grant that OpenAI refused, so the person is asked to connect again. */
  markReconnectRequired(userId: string, connectionId: string): void {
    this.opts.db.update(chatgptPlanConnections)
      .set({ status: 'reconnect-required', updatedAt: new Date(this.now()).toISOString() })
      .where(and(eq(chatgptPlanConnections.userId, userId), eq(chatgptPlanConnections.id, connectionId)))
      .run()
    this.modelCache.delete(connectionId)
  }

  /**
   * A current access token for this person's plan, refreshed when it is close
   * to expiry. Concurrent callers share one refresh.
   */
  async planAccess(userId: string): Promise<ChatGptPlanAccess> {
    if (!this.planUsageEnabled()) throw new ChatGptPlanError('off', 'ChatGPT plan usage is not turned on for this dashboard.')
    const inFlight = this.refreshes.get(userId)
    if (inFlight) return inFlight
    const row = this.opts.db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, userId)).get()
    if (!row) throw new ChatGptPlanError('not-connected', 'Connect your ChatGPT plan to use Aero.')
    if (row.status !== 'connected') throw new ChatGptPlanError('reconnect', CHATGPT_AERO_ERRORS.reconnect)
    const key = this.settings()!.tokenKey!
    const tokens = decryptPlanTokens(key, row.id, row.userId, row.tokens)
    if (!tokens) {
      // Unreadable under the current key (rotated or tampered): ask for a fresh grant.
      this.markReconnectRequired(userId, row.id)
      throw new ChatGptPlanError('reconnect', CHATGPT_AERO_ERRORS.reconnect)
    }
    if (Date.parse(row.accessExpiresAt) - this.now() > ACCESS_REFRESH_MARGIN_MS) {
      return { connectionId: row.id, accessToken: tokens.accessToken, modelId: row.modelId }
    }
    const refresh = this.refresh(row, tokens.refreshToken).finally(() => this.refreshes.delete(userId))
    this.refreshes.set(userId, refresh)
    return refresh
  }

  private async refresh(row: typeof chatgptPlanConnections.$inferSelect, refreshToken: string): Promise<ChatGptPlanAccess> {
    const settings = this.settings()!
    let refreshed: Awaited<ReturnType<typeof refreshChatGptTokens>>
    try {
      refreshed = await refreshChatGptTokens(this.fetchImpl, await this.discovery(), this.credentials(settings), refreshToken)
    } catch (error) {
      if (error instanceof ChatGptProtocolError && (
        (error.oauthError !== null && REFRESH_GRANT_GONE.has(error.oauthError))
        || error.status === 401 || error.status === 403
      )) {
        this.markReconnectRequired(row.userId, row.id)
        throw new ChatGptPlanError('reconnect', CHATGPT_AERO_ERRORS.reconnect)
      }
      throw new ChatGptPlanError('unavailable', CHATGPT_AERO_ERRORS.unavailable)
    }
    // A refresh that names its scopes and drops plan usage ends the grant; one
    // that omits them keeps the grant it was refreshed from.
    const scopes = refreshed.scopes ?? row.scopes.split(' ').filter(Boolean)
    if (!grantsInference(scopes)) {
      this.markReconnectRequired(row.userId, row.id)
      throw new ChatGptPlanError('reconnect', CHATGPT_AERO_ERRORS.reconnect)
    }
    const nowIso = new Date(this.now()).toISOString()
    const next: StoredTokens = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? refreshToken }
    const written = this.opts.db.update(chatgptPlanConnections).set({
      tokens: encryptPlanTokens(settings.tokenKey!, row.id, row.userId, next),
      scopes: scopes.join(' '),
      accessExpiresAt: new Date(this.now() + refreshed.expiresInSeconds * 1000).toISOString(),
      revision: row.revision + 1,
      updatedAt: nowIso,
    }).where(and(
      eq(chatgptPlanConnections.userId, row.userId),
      eq(chatgptPlanConnections.id, row.id),
      eq(chatgptPlanConnections.revision, row.revision),
    )).run()
    if (written.changes !== 1) {
      // Someone else refreshed or reconnected first. Their row is the truth.
      const current = this.opts.db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, row.userId)).get()
      const tokens = current && current.status === 'connected' ? decryptPlanTokens(settings.tokenKey!, current.id, current.userId, current.tokens) : null
      if (!current || !tokens) throw new ChatGptPlanError('reconnect', CHATGPT_AERO_ERRORS.reconnect)
      return { connectionId: current.id, accessToken: tokens.accessToken, modelId: current.modelId }
    }
    return { connectionId: row.id, accessToken: next.accessToken, modelId: row.modelId }
  }

  /** The models this person's plan offers, cached briefly per grant. */
  async models(userId: string): Promise<{ models: ChatGptPlanModel[]; selected: string | null; connectionId: string }> {
    const access = await this.planAccess(userId)
    const cached = this.modelCache.get(access.connectionId)
    if (cached && this.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return { models: cached.models, selected: access.modelId, connectionId: access.connectionId }
    }
    let models: ChatGptPlanModel[]
    try {
      models = await listChatGptPlanModels(this.fetchImpl, access.accessToken)
    } catch (error) {
      if (error instanceof ChatGptProtocolError && (error.status === 401 || error.status === 403)) {
        if (error.status === 401) this.markReconnectRequired(userId, access.connectionId)
        throw new ChatGptPlanError(error.status === 401 ? 'reconnect' : 'not-eligible',
          error.status === 401 ? CHATGPT_AERO_ERRORS.reconnect : CHATGPT_AERO_ERRORS.notEligible)
      }
      throw new ChatGptPlanError('unavailable', CHATGPT_AERO_ERRORS.unavailable)
    }
    this.modelCache.set(access.connectionId, { models, fetchedAt: this.now() })
    return { models, selected: access.modelId, connectionId: access.connectionId }
  }

  /** Choose the model Aero uses on this person's plan. Must be one their plan lists. */
  async selectModel(userId: string, modelId: string): Promise<void> {
    const { models, connectionId } = await this.models(userId)
    if (!models.some(model => model.id === modelId)) {
      throw new ChatGptPlanError('not-eligible', 'Your ChatGPT plan does not offer that model.')
    }
    this.opts.db.update(chatgptPlanConnections)
      .set({ modelId, updatedAt: new Date(this.now()).toISOString() })
      .where(and(eq(chatgptPlanConnections.userId, userId), eq(chatgptPlanConnections.id, connectionId)))
      .run()
  }

  /** The model a plan-funded turn uses (`pickChatGptPlanModel`), with a current token for it. */
  async resolveModel(userId: string, preferredModelId: string | null): Promise<{ access: ChatGptPlanAccess; modelId: string }> {
    const { models } = await this.models(userId)
    const access = await this.planAccess(userId)
    const modelId = pickChatGptPlanModel(models, access.modelId, preferredModelId)
    if (!modelId) throw new ChatGptPlanError('not-eligible', CHATGPT_AERO_ERRORS.notEligible)
    return { access, modelId }
  }
}

/**
 * Sign-in sessions for named accounts.
 *
 * The whole feature hangs off one question: does this install have any accounts
 * yet? While the answer is no, nothing here engages — the dashboard opens
 * without a sign-in and the API key is still the only credential, exactly as
 * before. The moment the first account exists, the answer flips for every
 * request at once.
 *
 * Sessions live in the database rather than in memory so that signing out, or
 * deleting an account, actually ends access instead of asking a browser to
 * forget something. It also means a restart does not sign everybody out.
 */
import crypto from 'node:crypto'
import { eq, lte } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { users, userSessions } from '@ainyc/canonry-db'
import {
  AppError,
  authRequired,
  LOGIN_FAILED_MESSAGE,
  loginRequestSchema,
  normalizeUserName,
  validationError,
  type AuthSessionDto,
  UserStatuses,
} from '@ainyc/canonry-contracts'
import { namedAuthenticationRequired, toUserDto } from './user-access.js'
import { writeAuditLog } from './helpers.js'
import { verifyUserPassword } from './user-password.js'
import { resolveCallerKey } from './trust-proxy.js'
import { assertCookieWriteOrigin } from './same-origin.js'

/** Cookie carrying a sign-in session. Distinct from the older dashboard-password cookie. */
export const USER_SESSION_COOKIE_NAME = 'canonry_user_session'

/** How long a session lasts without being used. */
export const USER_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * A session is renewed on use once it is past its halfway point. Renewing on
 * every single request would write to the database constantly; renewing only
 * at the very end would sign people out mid-task.
 */
const RENEW_AFTER_MS = USER_SESSION_TTL_MS / 2

/**
 * The longest a single sign-in can live, no matter how much it is used.
 *
 * Sliding renewal on its own has no end: a cookie that keeps being presented
 * keeps being extended, so a stolen one never expires and the only way to end
 * it is to delete the account. This ceiling is measured from when the session
 * was CREATED and renewal cannot move it, which is what makes it a ceiling
 * rather than a longer window.
 */
export const USER_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Failed sign-ins tolerated for one name FROM ONE SOURCE before that pairing is
 * paused.
 *
 * The pairing is the whole point. Counting per name alone meant an attacker who
 * had read an account name off the list could hold that account out of its own
 * dashboard forever, at about one request every ninety seconds — the person
 * denied was the administrator, and the moment they are denied is exactly the
 * incident during which they need in. Counting per (name, source) keeps
 * guessing slow for whoever is guessing, and leaves everybody else alone.
 *
 * The per-source budget below still bounds an attacker who cycles names, and
 * the per-name-and-source budget bounds one who hammers a single name. What no
 * longer exists is a way for one caller's failures to deny a different caller.
 */
const LOGIN_MAX_FAILURES = 10

/**
 * Failed sign-ins tolerated from one caller, across ALL names. Higher than the
 * per-name budget because a shared office address is one caller with many
 * people behind it, but far below the point where the derivations start to
 * matter.
 */
const LOGIN_MAX_FAILURES_PER_CALLER = 30

/** How long a failure count is remembered. */
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * Password verifications allowed to be in flight at once, across the whole
 * server. The derivation runs on the threadpool, which is small and shared with
 * every other piece of file and crypto work the process does; without a ceiling
 * a burst of sign-in attempts monopolizes it and slows everything else down.
 * Over the ceiling, callers are turned away immediately rather than queued.
 */
const LOGIN_MAX_IN_FLIGHT = 8

/**
 * Verifications one identified caller may have running at once.
 *
 * The global ceiling alone is identity-blind: whoever fills it turns everybody
 * else away, which is the same denial it was meant to prevent. Bounding each
 * caller first means the global number is only ever reached by genuinely many
 * different callers.
 */
const LOGIN_MAX_IN_FLIGHT_PER_CALLER = 2

export interface UserSessionCookieOptions {
  /** Cookie path. Matches the install's base path so a sub-path mount works. */
  path?: string
  /**
   * Force the Secure attribute on or off. Leave unset and it is decided per
   * request from how the request actually arrived — see `cookieIsSecure`. A
   * host that knows better (it has the configured public URL in hand) can say
   * so explicitly.
   */
  secure?: boolean
}

/**
 * Whether this session cookie should be marked Secure.
 *
 * An explicit setting always wins. Otherwise the request decides: a request
 * that arrived over https, or that a proxy forwarded as https, gets a Secure
 * cookie. Defaulting to "not secure" would ship an https deployment a cookie
 * a network attacker can strip; defaulting to "secure" would break plain-http
 * local installs, where this feature is most likely to be tried first.
 */
export function cookieIsSecure(request: FastifyRequest, configured: boolean | undefined): boolean {
  if (configured !== undefined) return configured
  const forwarded = request.headers['x-forwarded-proto']
  const firstHop = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  if (firstHop) return firstHop === 'https'
  return request.protocol === 'https'
}

export type ResolvedUser = ReturnType<typeof toUserDto>

/**
 * Whether this install requires named authentication.
 *
 * The historical export name is retained for callers, but the durable marker
 * must win once named authentication has ever been enabled: deleting every
 * account cannot silently restore anonymous/shared access. It is deliberately
 * read per request rather than cached because that marker is a security
 * boundary across split processes.
 */
export function anyUsersExist(db: DatabaseClient): boolean {
  return namedAuthenticationRequired(db)
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {}

  return header
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const eqIdx = part.indexOf('=')
      if (eqIdx <= 0) return cookies
      const name = part.slice(0, eqIdx).trim()
      const value = part.slice(eqIdx + 1).trim()
      if (!name) return cookies
      try {
        cookies[name] = decodeURIComponent(value)
      } catch {
        cookies[name] = value
      }
      return cookies
    }, {})
}

/**
 * Serialize the sign-in cookie. `value: null` is the sign-out form — an empty
 * value with `Max-Age=0`, which is how a browser is told to drop it.
 *
 * `HttpOnly` keeps page scripts from reading it, and `SameSite=Lax` keeps
 * another site from riding it: a cross-site form post carries no cookie, so a
 * signed-in browser cannot be steered into changing anything here.
 */
export function serializeUserSessionCookie(opts: {
  value: string | null
  path?: string
  secure?: boolean
}): string {
  const parts = [
    `${USER_SESSION_COOKIE_NAME}=${opts.value ? encodeURIComponent(opts.value) : ''}`,
    `Path=${opts.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    opts.value ? `Max-Age=${Math.floor(USER_SESSION_TTL_MS / 1000)}` : 'Max-Age=0',
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * The value actually stored for a session token.
 *
 * Plain SHA-256 is the right choice here, and deliberately NOT the slow
 * derivation the passwords use: the token is 256 bits of randomness this server
 * generated, so there is no guessing to slow down. What it buys is that the
 * table holds a record of a session rather than a working copy of one.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a session and return the token for the COOKIE. The token itself is never
 * written down — only its digest — so this is the one and only moment it exists.
 */
export interface CreatedNamedUserSession {
  token: string
  user: ReturnType<typeof toUserDto>
}

/**
 * Establish a named-account session only when the account remains active at
 * the exact authorization version that completed authentication. The check,
 * session snapshot, and sign-in timestamp share one transaction so a
 * suspension or role change racing a password/OIDC callback cannot mint a
 * newly-live cookie with the old authority.
 */
export function createNamedUserSession(
  db: DatabaseClient,
  userId: string,
  expectedAuthVersion: number,
  now = new Date(),
): CreatedNamedUserSession | null {
  const nowIso = now.toISOString()
  return db.transaction((tx) => {
    tx.delete(userSessions).where(lte(userSessions.expiresAt, nowIso)).run()
    const user = tx.select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.status !== UserStatuses.active || user.authVersion !== expectedAuthVersion) return null

    const token = crypto.randomBytes(32).toString('hex')
    tx.insert(userSessions).values({
      tokenHash: hashSessionToken(token),
      userId,
      authVersion: user.authVersion,
      createdAt: nowIso,
      expiresAt: new Date(now.getTime() + USER_SESSION_TTL_MS).toISOString(),
    }).run()
    tx.update(users).set({ lastLoginAt: nowIso }).where(eq(users.id, userId)).run()
    writeAuditLog(tx, { actor: 'api', actorUserId: user.id, actorName: user.displayName ?? user.name, action: 'user.signed-in', entityType: 'user', entityId: user.id })
    return { token, user: toUserDto({ ...user, lastLoginAt: nowIso }) }
  })
}

/**
 * Compatibility helper for trusted in-process callers. New authentication
 * paths must use createNamedUserSession with the version captured before an
 * asynchronous credential verification.
 */
export function createUserSession(db: DatabaseClient, userId: string, now = new Date()): string {
  const user = db.select().from(users).where(eq(users.id, userId)).get()
  const created = user ? createNamedUserSession(db, userId, user.authVersion, now) : null
  if (!created) throw new Error('Cannot create a session for an inactive or missing account.')
  return created.token
}

export function deleteUserSession(db: DatabaseClient, token: string): void {
  db.delete(userSessions).where(eq(userSessions.tokenHash, hashSessionToken(token))).run()
}

export interface ResolvedSession {
  user: ResolvedUser
  /** Set when the session was extended on this request and the cookie must be re-sent. */
  renewedExpiresAt?: string
}

/**
 * Resolve a session cookie to the person it belongs to, extending the session
 * when it is past its halfway point. An expired session is deleted rather than
 * merely refused, so the table does not accumulate dead rows on a busy install.
 */
export function resolveUserSession(
  db: DatabaseClient,
  token: string,
  now = new Date(),
): ResolvedSession | null {
  const tokenHash = hashSessionToken(token)
  const session = db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get()
  if (!session) return null

  const expiresAtMs = Date.parse(session.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    deleteUserSession(db, token)
    return null
  }

  // The ceiling, checked independently of the sliding window. Constant use
  // moves `expiresAt` forever but cannot move `createdAt`.
  const createdAtMs = Date.parse(session.createdAt)
  if (!Number.isFinite(createdAtMs) || now.getTime() - createdAtMs >= USER_SESSION_ABSOLUTE_TTL_MS) {
    deleteUserSession(db, token)
    return null
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get()
  if (!user || user.status !== UserStatuses.active || session.authVersion !== user.authVersion) {
    deleteUserSession(db, token)
    return null
  }

  const resolved: ResolvedSession = {
    user: toUserDto(user),
  }

  if (expiresAtMs - now.getTime() < RENEW_AFTER_MS) {
    const renewed = new Date(now.getTime() + USER_SESSION_TTL_MS).toISOString()
    db.update(userSessions).set({ expiresAt: renewed }).where(eq(userSessions.tokenHash, tokenHash)).run()
    resolved.renewedExpiresAt = renewed
  }

  return resolved
}

/**
 * Failed sign-in counter.
 *
 * In-process and keyed by whatever it is handed — a name, or a caller's
 * address. Two instances of it do two different jobs:
 *
 *   - keyed by NAME, it slows password guessing against a specific account;
 *   - keyed by CALLER, it stops the far cheaper attack of never repeating a
 *     name at all. Every attempt costs a full key derivation whether or not the
 *     name exists, so an attacker who cycles names pays nothing and the server
 *     pays everything. The per-name counter cannot see that; this one can.
 *
 * Neither is a replacement for a real password. They are what make a weak one
 * take years instead of minutes, and what keeps a public route from being a
 * lever on the whole server.
 */
class LoginAttemptLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  /** True when this key has spent its allowance and must wait. */
  isBlocked(nameKey: string, nowMs: number): boolean {
    return this.recent(nameKey, nowMs).length >= this.maxFailures
  }

  recordFailure(nameKey: string, nowMs: number): void {
    const recent = this.recent(nameKey, nowMs)
    recent.push(nowMs)
    this.failures.set(nameKey, recent)
    this.prune(nowMs)
  }

  clear(nameKey: string): void {
    this.failures.delete(nameKey)
  }

  private recent(nameKey: string, nowMs: number): number[] {
    const all = this.failures.get(nameKey) ?? []
    return all.filter(at => nowMs - at < this.windowMs)
  }

  /** Keep the map bounded to the keys that failed inside one window. */
  private prune(nowMs: number): void {
    for (const [key, times] of this.failures) {
      const recent = times.filter(at => nowMs - at < this.windowMs)
      if (recent.length === 0) this.failures.delete(key)
      else this.failures.set(key, recent)
    }
  }
}

export interface UserSessionRoutesOptions {
  /**
   * The shared credential checker. Optional only so the plugin signature stays
   * valid; when the host also mounts the OAuth consent page it MUST pass the
   * same instance to both, or each sign-in door gets its own full brute-force
   * budget — which is exactly the bug this replaced.
   */
  credentials?: CredentialChecker

  cookie?: UserSessionCookieOptions
  /** See `ApiRoutesOptions.trustProxyConfigured`. */
  trustProxyConfigured?: boolean
}

/**
 * The credential check, with its four budgets, as ONE thing both sign-in doors
 * use.
 *
 * There are two: POST /auth/login for the dashboard and POST /oauth/authorize
 * for the OAuth consent page. They were separate implementations, and the
 * second had none of the budgets — which quietly made the first one's lockout
 * bypassable by aiming the guessing at the other door, and re-opened the
 * threadpool exhaustion the in-flight ceiling exists to prevent. Sharing the
 * implementation is the only thing that keeps them from drifting apart again.
 */
export interface CredentialChecker {
  verify(
    request: FastifyRequest,
    name: string,
    password: string,
  ): Promise<
    | { ok: true; user: typeof users.$inferSelect }
    | { ok: false; reason: 'invalid' | 'rate-limited'; message: string }
  >
}

export function createCredentialChecker(opts: {
  db: DatabaseClient
  trustProxyConfigured?: boolean
}): CredentialChecker {
  // Per-checker, not module-global: one set of counters per app instance, so
  // tests and co-hosted apps do not share lockout state.
  const perNameLimiter = new LoginAttemptLimiter(LOGIN_MAX_FAILURES, LOGIN_FAILURE_WINDOW_MS)
  const perCallerLimiter = new LoginAttemptLimiter(LOGIN_MAX_FAILURES_PER_CALLER, LOGIN_FAILURE_WINDOW_MS)
  let verificationsInFlight = 0
  const callerVerificationsInFlight = new Map<string, number>()

  return {
    async verify(request, name, password) {
      const nameKey = normalizeUserName(name)
      const caller = resolveCallerKey(request, opts.trustProxyConfigured ?? false)
      const nowMs = Date.now()
      const nameFromCaller = `${nameKey}\u0000${caller ?? 'unidentified'}`

      // All four checked BEFORE any derivation is paid for.
      if (perNameLimiter.isBlocked(nameFromCaller, nowMs)) {
        return { ok: false, reason: 'rate-limited', message: 'Too many attempts for this account. Wait a few minutes.' }
      }
      if (caller !== null && perCallerLimiter.isBlocked(caller, nowMs)) {
        return { ok: false, reason: 'rate-limited', message: 'Too many attempts. Wait a few minutes.' }
      }
      if (verificationsInFlight >= LOGIN_MAX_IN_FLIGHT) {
        return { ok: false, reason: 'rate-limited', message: 'The server is busy checking sign-ins. Try again in a moment.' }
      }
      if (caller !== null && (callerVerificationsInFlight.get(caller) ?? 0) >= LOGIN_MAX_IN_FLIGHT_PER_CALLER) {
        return { ok: false, reason: 'rate-limited', message: 'The server is busy checking sign-ins. Try again in a moment.' }
      }

      const account = opts.db.select().from(users).where(eq(users.nameKey, nameKey)).get()
      const storedHash = account?.passwordHash ?? UNKNOWN_ACCOUNT_DIGEST
      verificationsInFlight++
      if (caller !== null) {
        callerVerificationsInFlight.set(caller, (callerVerificationsInFlight.get(caller) ?? 0) + 1)
      }
      let matches: boolean
      try {
        matches = await verifyUserPassword(password, storedHash)
      } finally {
        verificationsInFlight--
        if (caller !== null) {
          const remaining = (callerVerificationsInFlight.get(caller) ?? 1) - 1
          if (remaining <= 0) callerVerificationsInFlight.delete(caller)
          else callerVerificationsInFlight.set(caller, remaining)
        }
      }

      // Password verification is deliberately asynchronous. Re-read after it
      // completes: an administrator may have suspended, demoted, or reset this
      // account while scrypt was running. The caller then passes this version
      // into createNamedUserSession, which closes the remaining issue race.
      const current = account
        ? opts.db.select().from(users).where(eq(users.id, account.id)).get()
        : undefined
      if (
        !account
        || !matches
        || !current
        || current.status !== UserStatuses.active
        || current.authVersion !== account.authVersion
        || current.passwordHash !== account.passwordHash
      ) {
        perNameLimiter.recordFailure(nameFromCaller, nowMs)
        if (caller !== null) perCallerLimiter.recordFailure(caller, nowMs)
        return { ok: false, reason: 'invalid', message: LOGIN_FAILED_MESSAGE }
      }
      perNameLimiter.clear(nameFromCaller)
      if (caller !== null) perCallerLimiter.clear(caller)
      return { ok: true, user: current }
    },
  }
}

export async function userSessionRoutes(app: FastifyInstance, opts: UserSessionRoutesOptions = {}) {
  const cookiePath = opts.cookie?.path ?? '/'
  const credentials = opts.credentials ?? createCredentialChecker({
    db: app.db,
    trustProxyConfigured: opts.trustProxyConfigured ?? false,
  })

  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, sessionId: string) => {
    reply.header('set-cookie', serializeUserSessionCookie({
      value: sessionId,
      path: cookiePath,
      secure: cookieIsSecure(request, opts.cookie?.secure),
    }))
  }

  const clearSessionCookie = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('set-cookie', serializeUserSessionCookie({
      value: null,
      path: cookiePath,
      secure: cookieIsSecure(request, opts.cookie?.secure),
    }))
  }

  const cookieSessionId = (request: FastifyRequest): string | undefined =>
    parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]

  // What the dashboard asks before it draws anything. Public on purpose: the
  // sign-in screen cannot ask whether a sign-in is needed while holding a
  // credential it does not have yet.
  app.get('/auth/session', async (request, reply): Promise<AuthSessionDto> => {
    if (!anyUsersExist(app.db)) return { authRequired: false, user: null }

    const token = cookieSessionId(request)
    const resolved = token ? resolveUserSession(app.db, token) : null
    // The dashboard polls this every minute, which means this route is where
    // most renewals actually happen. Extending the row without re-issuing the
    // cookie would leave the browser dropping a credential the server still
    // considers live — the session would die at its ORIGINAL expiry no matter
    // how long somebody kept working.
    if (token && resolved?.renewedExpiresAt) setSessionCookie(request, reply, token)
    return {
      authRequired: true,
      user: resolved ? resolved.user : null,
    }
  })

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Enter a name and a password.', { issues: parsed.error.issues })
    }

    // The SHARED checker, not a local copy. Extracting the code but leaving
    // this route running its own limiters gave each door its own full budget —
    // 10 failures here plus 10 there against the same name, and 8 concurrent
    // derivations each — which is not what "shared budgets" means. One instance,
    // one set of counters, both doors.
    const result = await credentials.verify(request, parsed.data.name, parsed.data.password)
    if (!result.ok) {
      if (result.reason === 'rate-limited') {
        throw new AppError('QUOTA_EXCEEDED', result.message, 429)
      }
      const err = authRequired(result.message)
      return reply.status(err.statusCode).send(err.toJSON())
    }
    // The checker already cleared the limiters on success.
    const account = result.user
    const now = new Date()
    const session = createNamedUserSession(app.db, account.id, account.authVersion, now)
    if (!session) {
      const err = authRequired(LOGIN_FAILED_MESSAGE)
      return reply.status(err.statusCode).send(err.toJSON())
    }
    setSessionCookie(request, reply, session.token)

    return reply.send({
      authRequired: true,
      user: session.user,
    } satisfies AuthSessionDto)
  })

  // Where this account is currently signed in. Only ever the caller's own
  // sessions — an admin cannot enumerate somebody else's from here.
  app.get('/auth/sessions', async (request, reply) => {
    const token = cookieSessionId(request)
    const resolved = token ? resolveUserSession(app.db, token) : null
    if (!token || !resolved) {
      const err = authRequired('Sign in to see where you are signed in.')
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const currentHash = hashSessionToken(token)
    const rows = app.db.select().from(userSessions)
      .where(eq(userSessions.userId, resolved.user.id)).all()
    return reply.send({
      sessions: rows.map(row => ({
        // Never the token or its digest — a list of your own sessions must not
        // itself become a way to become one of them.
        current: row.tokenHash === currentHash,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
    })
  })

  // End every session this account has, including the one asking.
  //
  // This is the answer to "I think my laptop was stolen": without it, ending a
  // leaked cookie means finding somebody with the root key to delete the whole
  // account. Signing out only the current browser is what `/auth/logout` does.
  app.delete('/auth/sessions', async (request, reply) => {
    const token = cookieSessionId(request)
    const resolved = token ? resolveUserSession(app.db, token) : null
    if (!token || !resolved) {
      const err = authRequired('Sign in to end your sessions.')
      return reply.status(err.statusCode).send(err.toJSON())
    }
    // This route is on the auth skip-list so it keeps working from a session the
    // rest of the API might refuse, which means the same-origin rule it would
    // normally inherit has to be applied here by hand. Without it, any site
    // could sign this person out of everything.
    assertCookieWriteOrigin(request)

    app.db.delete(userSessions).where(eq(userSessions.userId, resolved.user.id)).run()
    clearSessionCookie(request, reply)
    return reply.status(204).send()
  })

  // Signing out always succeeds, including from an already-dead session: the
  // point is that the browser ends up holding nothing.
  //
  // It is still origin-checked, for the same reason its sibling above is: this
  // route is on the auth skip-list, so it inherits nothing, and a same-site
  // sibling could otherwise sign a person out at will. Being annoying rather
  // than dangerous is not a reason to leave it open.
  app.post('/auth/logout', async (request, reply) => {
    assertCookieWriteOrigin(request)
    const sessionId = cookieSessionId(request)
    if (sessionId) deleteUserSession(app.db, sessionId)
    clearSessionCookie(request, reply)
    return reply.status(204).send()
  })
}

/**
 * A fixed, valid digest of a value nobody can supply. Verifying against it
 * costs the same as verifying a real account, which is the point: without it,
 * an unknown name would answer noticeably faster than a known one and the
 * sign-in form would quietly become an account-name oracle.
 */
export const UNKNOWN_ACCOUNT_DIGEST =
  'scrypt$1$AAAAAAAAAAAAAAAAAAAAAA==$'
  + Buffer.alloc(64, 0).toString('base64')

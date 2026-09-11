import crypto from 'node:crypto'
import Fastify from 'fastify'
import { afterEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { createClient, migrate, oauthClients, users, userInvitations, userExternalIdentities, googleLoginTransactions } from '@ainyc/canonry-db'
import { UserRoles, UserStatuses, normalizeInvitationEmail } from '@ainyc/canonry-contracts'
import { googleSignInRoutes, GOOGLE_LOGIN_COOKIE } from '../src/google-sign-in.js'
import { initializeUserAccess, revokeUserAccess } from '../src/user-access.js'
import { hashSessionToken, USER_SESSION_COOKIE_NAME, resolveUserSession, createNamedUserSession, createCredentialChecker, serializeUserSessionCookie, parseCookieHeader } from '../src/user-session.js'
import { registerOAuthRoutes } from '../src/oauth.js'
import { GOOGLE_ISSUER, type GoogleIdentity } from '../src/google-sign-in-client.js'

const apps: Array<ReturnType<typeof Fastify>> = []
const dbs: Array<ReturnType<typeof createClient>> = []
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const db of dbs.splice(0)) db.$client.close() })

async function fixture() {
  const db = createClient(':memory:')
  dbs.push(db)
  migrate(db)
  const now = new Date().toISOString()
  const owner = crypto.randomUUID()
  db.insert(users).values({ id: owner, name: owner, nameKey: owner, role: UserRoles.admin, passwordHash: crypto.randomUUID(), createdAt: now, permissionsMigrated: true }).run()
  initializeUserAccess(db, false)
  const config = { enabled: true, clientId: crypto.randomUUID(), clientSecret: crypto.randomUUID() }
  const identity: GoogleIdentity = { issuer: GOOGLE_ISSUER, subject: crypto.randomUUID(), email: `${crypto.randomUUID()}@example.test`, emailVerified: true, hostedDomain: 'example.test', name: crypto.randomUUID() }
  const app = Fastify()
  apps.push(app)
  app.decorate('db', db)
  await app.register(googleSignInRoutes, {
    prefix: '/nested/api/v1',
    cookie: { path: '/nested/', secure: true },
    googleSignIn: {
      getConfig: () => config, publicUrl: 'https://instance.example.test/nested/',
      clientFactory: () => ({
        authorizationUrl: async ({ state }) => 'https://accounts.google.com/?state=' + state,
        authenticate: async () => identity,
      }),
    },
  })
  registerOAuthRoutes(app, {
    db, issuer: 'https://instance.example.test', resourcePaths: ['/nested/api/v1/mcp'],
    authorizationBasePath: '/nested/', googleSignInUrl: () => '/nested/api/v1/auth/google/start',
    resolveUser: request => {
      const token = parseCookieHeader(request.headers.cookie)[USER_SESSION_COOKIE_NAME]
      return token ? resolveUserSession(db, token)?.user ?? null : null
    },
    credentials: createCredentialChecker({ db }),
    startSession: (id, version) => {
      const session = createNamedUserSession(db, id, version)
      return session ? serializeUserSessionCookie({ value: session.token, path: '/nested/', secure: true }) : null
    },
  })
  await app.ready()
  const invite = () => {
    const token = crypto.randomBytes(32).toString('hex')
    const id = crypto.randomUUID()
    db.insert(userInvitations).values({ id, email: identity.email!, emailKey: normalizeInvitationEmail(identity.email!), role: UserRoles.analyst, tokenHash: hashSessionToken(token), createdById: owner, createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() }).run()
    return { token, id }
  }
  const start = async (token?: string) => {
    const result = await app.inject({ method: 'POST', url: '/nested/api/v1/auth/google/start', headers: { host: 'instance.example.test', origin: 'https://instance.example.test' }, payload: token ? { invitationToken: token } : {} })
    expect(result.statusCode).toBe(200)
    const url = new URL(result.json<{ redirectUrl: string }>().redirectUrl)
    const cookies = result.cookies
    const cookie = cookies.find(value => value.name === GOOGLE_LOGIN_COOKIE)!
    expect(cookie.httpOnly).toBe(true)
    expect(cookie.secure).toBe(true)
    return { state: url.searchParams.get('state')!, cookie: `${cookie.name}=${cookie.value}` }
  }
  const finish = (start: {state:string;cookie:string}) => app.inject({ method: 'GET', url: '/nested/api/v1/auth/google/callback?code=' + crypto.randomUUID() + '&state=' + start.state, headers: { cookie: start.cookie } })
  return { db, app, config, identity, invite, start, finish }
}

test('an invitation binds a named Google-only Analyst and consumes the transaction', async () => {
  const f = await fixture()
  const invitation = f.invite()
  const started = await f.start(invitation.token)
  const response = await f.finish(started)
  expect(response.statusCode).toBe(303)
  const cookie = response.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)
  expect(cookie).toBeDefined()
  const session = resolveUserSession(f.db, cookie!.value)!
  expect(session.user).toMatchObject({ role: UserRoles.analyst, email: f.identity.email, hasPassword: false })
  expect(f.db.select().from(userInvitations).where(eq(userInvitations.id, invitation.id)).get()?.acceptedAt).not.toBeNull()
  expect(f.db.select().from(googleLoginTransactions).all()).toHaveLength(0)
  expect((await f.finish(started)).cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)?.value).toBeFalsy()
})

test.each(['uninvited', 'wrong-email', 'expired', 'revoked', 'unverified', 'third-party-email'] as const)('refuses %s invitation admission', async kind => {
  const f = await fixture()
  const invitation = kind === 'uninvited' ? undefined : f.invite()
  if (kind === 'wrong-email') f.identity.email = crypto.randomUUID() + '@example.test'
  if (kind === 'expired') f.db.update(userInvitations).set({ expiresAt: new Date(0).toISOString() }).run()
  if (kind === 'revoked') f.db.update(userInvitations).set({ revokedAt: new Date().toISOString() }).run()
  if (kind === 'unverified') f.identity.emailVerified = false
  if (kind === 'third-party-email') f.identity.hostedDomain = null
  const response = await f.finish(await f.start(invitation?.token))
  expect(new URL(String(response.headers.location), 'https://instance.example.test').searchParams.get('authError')).toBe(invitation ? 'google-invitation-failed' : 'google-sign-in-failed')
  expect(response.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)?.value).toBeFalsy()
  expect(f.db.select().from(users).all()).toHaveLength(1)
  expect(f.db.select().from(userExternalIdentities).all()).toHaveLength(0)
})

test('rejects callback browser-cookie substitution and secret rotation', async () => {
  const f = await fixture()
  const first = await f.start(f.invite().token)
  const second = await f.start()
  const switched = await f.finish({ ...first, cookie: second.cookie })
  expect(switched.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)?.value).toBeFalsy()
  f.config.clientSecret = crypto.randomUUID()
  const rotated = await f.finish(first)
  expect(rotated.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)?.value).toBeFalsy()
})

test('existing stable identity can sign in, but a suspended account cannot', async () => {
  const f = await fixture()
  const accepted = await f.finish(await f.start(f.invite().token))
  const user = resolveUserSession(f.db, accepted.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)!.value)!.user
  f.identity.email = crypto.randomUUID() + '@example.test'
  const again = await f.finish(await f.start())
  expect(again.cookies.some(value => value.name === USER_SESSION_COOKIE_NAME && value.value)).toBe(true)
  f.db.transaction(tx => {
    tx.update(users).set({ status: UserStatuses.suspended }).where(eq(users.id, user.id)).run()
    revokeUserAccess(tx, user.id)
  })
  const denied = await f.finish(await f.start())
  expect(denied.cookies.find(value => value.name === USER_SESSION_COOKIE_NAME)?.value).toBeFalsy()
})

test('Google-only users complete MCP consent under an instance subpath', async () => {
  const f = await fixture()
  await f.finish(await f.start(f.invite().token))
  const clientId = crypto.randomUUID()
  const redirectUri = 'https://client.example.test/callback'
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  f.db.insert(oauthClients).values({ id: clientId, name: crypto.randomUUID(), redirectUris: [redirectUri], createdAt: new Date().toISOString() }).run()
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read' })
  const authorizePath = '/nested/oauth/authorize?' + params
  const gate = await f.app.inject({ url: authorizePath })
  expect(gate.statusCode).toBe(200)
  const href = gate.body.match(/href="([^"]*auth\/google\/start[^"]*)"/)?.[1]?.replaceAll('&amp;', '&')
  expect(href).toBeDefined()
  const started = await f.app.inject({ url: href! })
  const state = new URL(started.headers.location!).searchParams.get('state')!
  const stateCookie = started.cookies.find(cookie => cookie.name === GOOGLE_LOGIN_COOKIE)!
  const signedIn = await f.finish({ state, cookie: stateCookie.name + '=' + stateCookie.value })
  expect(signedIn.headers.location).toBe(authorizePath)
  const session = signedIn.cookies.find(cookie => cookie.name === USER_SESSION_COOKIE_NAME)!
  const headers = { cookie: session.name + '=' + session.value, host: 'instance.example.test', origin: 'https://instance.example.test' }
  const consent = await f.app.inject({ url: authorizePath, headers })
  const csrf = consent.body.match(/name="csrf" value="([^"]+)"/)?.[1]
  expect(csrf).toBeDefined()
  const granted = await f.app.inject({ method: 'POST', url: '/nested/oauth/authorize/consent?' + params, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf: csrf!, approve: 'yes' }).toString() })
  expect(granted.statusCode).toBe(302)
  const code = new URL(granted.headers.location!).searchParams.get('code')!
  const tokens = await f.app.inject({ method: 'POST', url: '/nested/oauth/token', payload: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri } })
  expect(tokens.statusCode).toBe(200)
  expect(tokens.json<{scope:string}>().scope).toBe('read')
})

/**
 * Adversarial panel findings. Each hole is demonstrated before it is closed.
 *
 * The theme running through all of them: a rule written against the WRONG
 * attribute. "Is this a user principal" is not the same question as "did this
 * credential arrive in a cookie"; "what is `request.ip`" is not the same
 * question as "who is calling"; "is this a GET" is not the same question as
 * "is this free".
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  adsConnections,
  apiKeys,
  createClient,
  migrate,
  projects,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

/**
 * Every sign-in in this file pays a REAL scrypt derivation (N=32768,
 * `user-password.ts`), and the tests that exercise the per-caller budget
 * deliberately pay thirty of them in sequence, because thirty is where the
 * budget trips. Measured on an idle 12-core box: 111ms per derivation, and
 * 4.0-5.1s for the worst tests here — one of them already over vitest's 5000ms
 * default. On slower CI hardware they would fail outright, and the failure
 * would look like a hang rather than the arithmetic it is.
 *
 * The cost is the point: these tests assert that an expensive, unauthenticated
 * derivation is admitted under a budget and kept off the event loop, and a
 * cheaper hash would not exercise either property. The cost factor is also not
 * recorded in the stored digest (`scrypt$1$<salt>$<digest>`), so it is a global
 * invariant every stored password depends on — not something to make
 * environment-dependent for a faster suite.
 *
 * So: raise the ceiling for this file only. 30s still surfaces a real hang,
 * and every other suite keeps the 5s default.
 */
vi.setConfig({ testTimeout: 30_000 })

const ROOT_KEY = 'cnry_panel_root'
const READ_KEY = 'cnry_panel_read'
const NARROW_KEY = 'cnry_panel_narrow'
const ADS_OPERATOR_KEY = 'cnry_panel_ads_operator'
const LEGACY_COOKIE = 'canonry_session'
const LEGACY_SESSION_ID = 'legacy-dashboard-password-session'
const ADMIN_PASSWORD = 'a-long-enough-admin-password'
const VIEWER_PASSWORD = 'a-long-enough-viewer-password'
const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'

let tmpDir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let projectId: string
let rootKeyId: string
let liveDeliveryCalls: number
let planningReadCalls: number

/**
 * The other GETs that call the ads provider on the caller's behalf. Cheaper
 * than live-delivery per call — one upstream request for the account and geo
 * reads, up to `OPENAI_ADS_MAX_PAGES` for each conversions list — but the same
 * shape: they resolve the operator's advertiser credential and spend on it.
 */
const PAID_PLANNING_READS = [
  '/api/v1/projects/sample/ads/account',
  '/api/v1/projects/sample/ads/geo/search?q=San%20Francisco',
  '/api/v1/projects/sample/ads/conversions/pixels',
  '/api/v1/projects/sample/ads/conversions/event-settings',
] as const

function seedKey(name: string, token: string, scopes: string[]): string {
  const id = crypto.randomUUID()
  db.insert(apiKeys).values({
    id,
    name,
    keyHash: hashApiKey(token),
    keyPrefix: token.slice(0, 9),
    scopes,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function withKey(token: string) {
  return { authorization: `Bearer ${token}` }
}

async function createAccount(name: string, password: string, role: 'admin' | 'viewer') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: withKey(ROOT_KEY),
    payload: { name, password, role },
  })
}

async function signIn(name: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { name, password },
  })
  expect(res.statusCode).toBe(200)
  const raw = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'][0]!
    : String(res.headers['set-cookie'])
  return decodeURIComponent(raw.split(';')[0]!.split('=')[1]!)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-panel-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'sample',
    displayName: 'Sample',
    canonicalDomain: 'sample.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()

  rootKeyId = seedKey('root', ROOT_KEY, ['*'])
  seedKey('reader', READ_KEY, ['read'])
  // Scoped to something entirely unrelated to ads — not read-only, so the
  // OLD deny-list gate let it straight through.
  seedKey('narrow', NARROW_KEY, ['users.read'])

  db.insert(adsConnections).values({
    id: crypto.randomUUID(),
    projectId,
    adAccountId: 'sample-account',
    status: 'connected',
    createdAt: now,
    updatedAt: now,
  }).run()

  liveDeliveryCalls = 0
  planningReadCalls = 0

  app = Fastify()
  app.register(apiRoutes, {
    db,
    // The install's shared dashboard password mints a session bound to the
    // ROOT key — a cookie carrying full authority.
    sessionCookieName: LEGACY_COOKIE,
    resolveSessionApiKeyId: (id: string) => (id === LEGACY_SESSION_ID ? rootKeyId : null),
    adsCredentialStore: {
      getConnection: () => ({ apiKey: 'sample-token' }),
      upsertConnection: (connection: unknown) => connection,
      deleteConnection: () => true,
    } as never,
    // Matches the seeded `adsConnections.adAccountId` below, so a request that
    // gets PAST the auth gate reaches real (fake) provider I/O instead of
    // failing on an unrelated "wrong account" check first.
    verifyAdsAccount: async () => ({
      id: 'sample-account',
      name: 'Sample Ads Account',
      status: 'active',
      currencyCode: 'USD',
      timezone: 'UTC',
      reviewStatus: null,
      integrityReviewStatus: null,
      integrityDecision: null,
    }),
    adsLiveDeliveryReader: {
      listCampaigns: async () => { liveDeliveryCalls++; return [] },
      listAdGroups: async () => { liveDeliveryCalls++; return [] },
      listAds: async () => { liveDeliveryCalls++; return [] },
      getInsights: async () => { liveDeliveryCalls++; return [] },
    } as never,
    adsReader: {
      getAccount: async () => { planningReadCalls++; return {} },
      searchGeo: async () => { planningReadCalls++; return { count: 0, query: '', results: [] } },
      listConversionPixels: async () => { planningReadCalls++; return { pixels: [] } },
      listConversionEventSettings: async () => { planningReadCalls++; return { eventSettings: [] } },
    } as never,
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── P1.1 the CSRF rule keyed on the wrong attribute ───────────────────────

test('a cross-origin write riding the shared dashboard cookie is refused', async () => {
  // This cookie resolves to a wildcard API key, so the "API keys are exempt"
  // carve-out lets it straight through — a full-authority CSRF hole sitting
  // right next to the CSRF fix. What matters is that the credential arrived in
  // a COOKIE, not what it happens to resolve to.
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: {
      cookie: `${LEGACY_COOKIE}=${LEGACY_SESSION_ID}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
    payload: {},
  })

  expect(res.statusCode).toBe(403)
})

test('the shared dashboard cookie still works from the dashboard itself', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: { cookie: `${LEGACY_COOKIE}=${LEGACY_SESSION_ID}`, origin: ORIGIN, host: HOST },
    payload: {},
  })
  expect(res.statusCode).toBe(201)
})

test('a real header-carried API key is never subject to the origin rule', async () => {
  // Nothing attaches an Authorization header automatically, so there is no
  // request to ride. Checking it here would break every CLI and agent.
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects/sample/runs',
    headers: { ...withKey(ROOT_KEY), origin: 'http://anywhere.example' },
    payload: {},
  })
  expect(res.statusCode).toBe(201)
})

// ─── P1.2 the caller budget behind a proxy ─────────────────────────────────

/**
 * The same install, deployed the way it actually is: behind an edge proxy.
 *
 * The host has to DECLARE the trust, not just hand it to Fastify — everything
 * that budgets per caller reads the declaration, because a forwarded header on
 * its own is a string the caller chose.
 */
async function bootProxiedApp(trustProxy: boolean) {
  const proxied = Fastify({ trustProxy })
  proxied.register(apiRoutes, { db, trustProxyConfigured: trustProxy })
  await proxied.ready()
  return proxied
}

function guessFrom(server: ReturnType<typeof Fastify>, forwardedFor: string, attempt: number) {
  // Every request arrives from the SAME socket — the edge proxy — and only the
  // forwarded chain says who is really behind it.
  return server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: '10.0.0.2',
    headers: { 'x-forwarded-for': forwardedFor, origin: ORIGIN, host: HOST },
    payload: { name: `nobody-${attempt}`, password: 'a-wrong-guess' },
  })
}

test('callers behind a proxy are told apart when the forwarded chain is trusted', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const proxied = await bootProxiedApp(true)

  try {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses.push((await guessFrom(proxied, '203.0.113.9', attempt)).statusCode)
    }
    expect(statuses).toContain(429)

    // A different person, behind the SAME proxy, is unaffected — which is the
    // whole point. Keyed on the socket they would share one budget and this
    // sign-in would be refused.
    const bystander = await proxied.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.4', origin: ORIGIN, host: HOST },
      payload: { name: 'owner', password: ADMIN_PASSWORD },
    })
    expect(bystander.statusCode).toBe(200)
  } finally {
    await proxied.close()
  }
})

test('an undeclared proxy still budgets, and does so on the only honest address', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const proxied = await bootProxiedApp(false)

  try {
    // Nothing here was declared, so the forwarded header is just a string the
    // caller chose and carries no weight. The budget applies to the socket —
    // the only address that cannot be forged — and therefore still applies.
    const statuses: number[] = []
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses.push((await guessFrom(proxied, '203.0.113.9', attempt)).statusCode)
    }
    expect(statuses).toContain(429)

    // The cost of leaving it undeclared is that everyone behind the proxy
    // shares that bucket. That is a MISCONFIGURATION for the operator to fix
    // with CANONRY_TRUST_PROXY, and it is a far better failure than a budget an
    // attacker can switch off from outside by inventing a header.
    const bystander = await proxied.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '198.51.100.4', origin: ORIGIN, host: HOST },
      payload: { name: 'owner', password: ADMIN_PASSWORD },
    })
    expect(bystander.statusCode).toBe(429)
  } finally {
    await proxied.close()
  }
})

test('the trust setting reads the way an operator would write it', async () => {
  const { resolveTrustProxy } = await import('../src/trust-proxy.js')

  expect(resolveTrustProxy(undefined)).toBe(false)
  expect(resolveTrustProxy('')).toBe(false)
  expect(resolveTrustProxy('false')).toBe(false)
  expect(resolveTrustProxy('true')).toBe(true)
  expect(resolveTrustProxy('1')).toBe(1)
  expect(resolveTrustProxy('2')).toBe(2)
  expect(resolveTrustProxy('10.0.0.1, 192.168.0.0/16')).toEqual(['10.0.0.1', '192.168.0.0/16'])
})

// ─── P2.4 a GET that spends money ──────────────────────────────────────────

test('the paid live-delivery read is refused to a view-only account', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/ads/live-delivery',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewer}` },
  })

  // A GET, so nothing in the method-based gate can see it — but it fans out
  // thousands of billed provider calls.
  expect(res.statusCode).toBe(403)
  expect(liveDeliveryCalls).toBe(0)
})

test('the paid live-delivery read is refused to a read-only key', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/ads/live-delivery',
    headers: withKey(READ_KEY),
  })
  expect(res.statusCode).toBe(403)
  expect(liveDeliveryCalls).toBe(0)
})

test('the paid live-delivery read is refused to a key scoped to something unrelated', async () => {
  // A key scoped to `users.read` is not read-only (it never opted into the
  // `read` token), so the OLD deny-list gate — "refuse only if read-only" —
  // let it sail straight through to a route that fans out to ~4000 billed
  // OpenAI Ads requests. It was never granted any ads authority at all.
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/sample/ads/live-delivery',
    headers: withKey(NARROW_KEY),
  })
  expect(res.statusCode).toBe(403)
  expect(liveDeliveryCalls).toBe(0)
})

// ─── the OTHER GETs that spend money ───────────────────────────────────────
//
// live-delivery was gated on its own; the four planning reads next to it were
// not. They are a different shape of the same hole — no gate at all rather
// than a wrong-shaped one — and every credential below reached the provider
// through them while being refused by the route one door down.

test('the paid planning reads are refused to a read-only key', async () => {
  for (const url of PAID_PLANNING_READS) {
    const res = await app.inject({ method: 'GET', url, headers: withKey(READ_KEY) })
    expect(res.statusCode).toBe(403)
  }
  expect(planningReadCalls).toBe(0)
})

test('the paid planning reads are refused to a key scoped to something unrelated', async () => {
  for (const url of PAID_PLANNING_READS) {
    const res = await app.inject({ method: 'GET', url, headers: withKey(NARROW_KEY) })
    expect(res.statusCode).toBe(403)
  }
  expect(planningReadCalls).toBe(0)
})

test('the paid planning reads are refused to a view-only account', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  for (const url of PAID_PLANNING_READS) {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewer}` },
    })
    expect(res.statusCode).toBe(403)
  }
  expect(planningReadCalls).toBe(0)
})

test('the paid planning reads still serve the credentials that were granted ads authority', async () => {
  // The gate has to stay open for the key every operator actually holds: the
  // `canonry init` root key, and the ads-operator key the docs tell you to
  // mint. Otherwise this closes the hole by breaking onboarding.
  for (const url of PAID_PLANNING_READS) {
    expect((await app.inject({ method: 'GET', url, headers: withKey(ROOT_KEY) })).statusCode).toBe(200)
  }
  expect(planningReadCalls).toBe(PAID_PLANNING_READS.length)

  seedKey('ads-operator', ADS_OPERATOR_KEY, ['read', 'ads.write', 'ads.activate'])
  for (const url of PAID_PLANNING_READS) {
    expect((await app.inject({ method: 'GET', url, headers: withKey(ADS_OPERATOR_KEY) })).statusCode).toBe(200)
  }
  expect(planningReadCalls).toBe(PAID_PLANNING_READS.length * 2)
})

// ─── P2.3 the admin gate ignored what the key could do ─────────────────────

test('a read-only key cannot enumerate the accounts on this install', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')

  const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: withKey(READ_KEY) })
  expect(res.statusCode).toBe(403)
})

// ─── P2.6 a caller-supplied header widened the embed tab allowlist ─────────

/** The install's server-side embed tab allowlist for THIS boot. */
async function bootEmbedApp(configuredTabs: string[]) {
  const embedded = Fastify()
  embedded.register(apiRoutes, { db, embedProjectTabs: configuredTabs })
  await embedded.ready()
  return embedded
}

test('a caller-supplied embed-tabs header cannot widen the configured allowlist', async () => {
  // The install is configured for the "overview" tab only. The header is
  // supposed to be a per-request NARROWING of that — the OLD code let it
  // REPLACE the allowlist instead, so a header naming "technical-aeo" opened
  // a tab the operator never configured this embedded dashboard to expose.
  const embedded = await bootEmbedApp(['overview'])
  try {
    const res = await embedded.inject({
      method: 'GET',
      url: '/api/v1/projects/sample/technical-aeo',
      headers: { ...withKey(ROOT_KEY), 'x-canonry-embed-tabs': 'overview,technical-aeo' },
    })
    expect(res.statusCode).toBe(403)
  } finally {
    await embedded.close()
  }
})

test('a caller-supplied embed-tabs header still narrows within the configured allowlist', async () => {
  // The legitimate case: the install allows both tabs, and this particular
  // embedded dashboard is scoped down to just one of them.
  const embedded = await bootEmbedApp(['overview', 'technical-aeo'])
  try {
    const narrowed = await embedded.inject({
      method: 'GET',
      url: '/api/v1/projects/sample/technical-aeo',
      headers: { ...withKey(ROOT_KEY), 'x-canonry-embed-tabs': 'overview' },
    })
    expect(narrowed.statusCode).toBe(403)

    const stillAllowed = await embedded.inject({
      method: 'GET',
      url: '/api/v1/projects/sample/overview',
      headers: { ...withKey(ROOT_KEY), 'x-canonry-embed-tabs': 'overview' },
    })
    expect(stillAllowed.statusCode).toBe(200)
  } finally {
    await embedded.close()
  }
})

test('the overview embed reads measured visibility but cannot read or change the query workspace', async () => {
  const embedded = await bootEmbedApp(['overview'])
  try {
    const report = await embedded.inject({ method: 'GET', url: '/api/v1/projects/sample/visibility-report', headers: withKey(ROOT_KEY) })
    expect(report.statusCode).toBe(200)
    for (const [method, suffix] of [['GET', ''], ['POST', '/preview'], ['POST', '/commit']] as const) {
      const denied = await embedded.inject({ method, url: `/api/v1/projects/sample/query-tracking${suffix}`, headers: withKey(ROOT_KEY) })
      expect(denied.statusCode).toBe(403)
    }
  } finally {
    await embedded.close()
  }
})

// ─── P2.5 sessions that never end ──────────────────────────────────────────

test('the technical-aeo embed tab permits its Site Health graph and semantic reads', async () => {
  const embedded = await bootEmbedApp(['technical-aeo'])
  try {
    for (const url of [
      '/api/v1/projects/sample/technical-aeo/graph',
      '/api/v1/projects/sample/technical-aeo/crawl/pages/audit?nodeKey=home',
      '/api/v1/projects/sample/technical-aeo/subgraph',
      '/api/v1/projects/sample/technical-aeo/path?toUrl=https%3A%2F%2Fsample.example%2Ftarget',
      '/api/v1/projects/sample/technical-aeo/changes',
    ]) {
      const response = await embedded.inject({ method: 'GET', url, headers: withKey(ROOT_KEY) })
      expect(response.statusCode, `${url} must be available to the embedded Site Health tab`).toBe(200)
    }
  } finally {
    await embedded.close()
  }
})

test('a session cannot be renewed past its absolute lifetime', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)
  const tokenHash = crypto.createHash('sha256').update(session).digest('hex')

  // Sliding renewal on its own extends forever, so a stolen cookie that keeps
  // being used never expires. Age it past the ceiling and it must stop, even
  // though its sliding window is still wide open.
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  db.update(userSessions).set({ createdAt: longAgo }).where(eq(userSessions.tokenHash, tokenHash)).run()

  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(res.statusCode).toBe(401)
  expect(db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).get()).toBeUndefined()
})

test('somebody can end every session they have without needing a root key', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const laptop = await signIn('owner', ADMIN_PASSWORD)
  const phone = await signIn('owner', ADMIN_PASSWORD)

  const listed = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${laptop}` },
  })
  expect(listed.statusCode).toBe(200)
  const body = JSON.parse(listed.body) as { sessions: Array<{ current: boolean }> }
  expect(body.sessions).toHaveLength(2)
  expect(body.sessions.filter(s => s.current)).toHaveLength(1)

  const revoked = await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${laptop}`, origin: ORIGIN, host: HOST },
  })
  expect(revoked.statusCode).toBe(204)

  // Both are gone, including the one that asked.
  for (const token of [laptop, phone]) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${token}` },
    })
    expect(res.statusCode).toBe(401)
  }
})

test('one account cannot end another account sessions', async () => {
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  await createAccount('watcher', VIEWER_PASSWORD, 'viewer')
  const admin = await signIn('owner', ADMIN_PASSWORD)
  const viewer = await signIn('watcher', VIEWER_PASSWORD)

  await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${viewer}`, origin: ORIGIN, host: HOST },
  })

  const stillWorks = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${admin}` },
  })
  expect(stillWorks.statusCode).toBe(200)
})

test('another origin cannot end somebody else sessions for them', async () => {
  // The revoke route is on the auth skip-list so it works from a session the
  // rest of the API is refusing — which means it has to run the same-origin
  // check itself, or it becomes a cross-origin logout button.
  await createAccount('owner', ADMIN_PASSWORD, 'admin')
  const session = await signIn('owner', ADMIN_PASSWORD)

  const foreign = await app.inject({
    method: 'DELETE',
    url: '/api/v1/auth/sessions',
    headers: {
      cookie: `${USER_SESSION_COOKIE_NAME}=${session}`,
      origin: 'http://evil.localhost:4100',
      host: HOST,
    },
  })
  expect(foreign.statusCode).toBe(403)

  const stillWorks = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
    headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${session}` },
  })
  expect(stillWorks.statusCode).toBe(200)
})

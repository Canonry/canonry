import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import {
  createClient,
  migrate,
  projects,
  gbpLocations,
  apiKeys,
  auditLog,
} from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hotelEditorialDestination } from '../src/gbp-hotel-policy.js'
vi.mock('../src/gbp-hotel-policy.js', () => ({
  hotelEditorialDestination: vi.fn(async () => true),
}))
import { hashApiKey } from '../src/auth.js'

const NOW = new Date().toISOString()
const content = {
  languageCode: 'en',
  summary: 'A useful editorial article.',
  topicType: 'STANDARD',
  callToAction: {
    actionType: 'LEARN_MORE',
    url: 'https://one.example/article/',
  },
  media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://one.example/photo.jpg' }],
}
const body = {
  accountName: 'accounts/111',
  locationName: 'locations/222',
  attemptId: '00000000-0000-4000-8000-000000000001',
  packageId: 'a'.repeat(64),
  content,
}
const post = {
  ...content,
  name: 'accounts/111/locations/222/localPosts/333',
  state: 'PROCESSING',
  createTime: NOW,
  updateTime: NOW,
  searchUrl: 'https://local.google.com/place?id=123&use=posts&lpsid=abc',
}
async function fixture(options: { tokenExpiresAt?: string } = {}) {
  vi.mocked(hotelEditorialDestination).mockResolvedValue(true)
  const root = mkdtempSync(join(tmpdir(), 'cnry-gbp-posts-'))
  const db = createClient(join(root, 'test.db'))
  migrate(db)
  const app = Fastify()
  onTestFinished(async () => {
    vi.unstubAllGlobals()
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  for (const [id, name, domain] of [
    ['p1', 'one', 'one.example'],
    ['p2', 'two', 'two.example'],
  ])
    db.insert(projects)
      .values({
        id: id!,
        name: name!,
        displayName: name!,
        canonicalDomain: domain!,
        country: 'US',
        language: 'en',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run()
  db.insert(gbpLocations)
    .values({
      id: 'loc',
      projectId: 'p1',
      accountName: 'accounts/111',
      locationName: 'locations/222',
      displayName: 'Client One',
      primaryCategoryDisplayName: 'Roofing contractor',
      selected: true,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  for (const [raw, scopes, projectId] of [
    ['cnry_root', ['*'], null],
    ['cnry_reader', ['read'], null],
    ['cnry_gbpread', ['gbp.read'], null],
    ['cnry_gbpwrite', ['gbp.posts.write'], null],
    ['cnry_other', ['*'], 'p2'],
  ] as const)
    db.insert(apiKeys)
      .values({
        id: raw,
        name: raw,
        keyHash: hashApiKey(raw),
        keyPrefix: raw.slice(0, 9),
        scopes: [...scopes],
        projectId,
        createdAt: NOW,
      })
      .run()
  app.register(apiRoutes, {
    db,
    googleStateSecret: 'fixture-signing-key-not-a-real-secret',
    getGoogleAuthConfig: () => ({
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
    }),
    googleConnectionStore: {
      listConnections: () => [],
      getConnection: () => ({
        domain: 'one.example',
        connectionType: 'gbp',
        accessToken: 'fixture-token',
        refreshToken: 'fixture-refresh',
        tokenExpiresAt:
          options.tokenExpiresAt ?? new Date(Date.now() + 3600000).toISOString(),
        createdAt: NOW,
        updatedAt: NOW,
      }),
      upsertConnection: (value) => value,
      updateConnection: () => undefined,
      deleteConnection: () => false,
    },
  })
  await app.ready()
  const request = (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload?: unknown,
    key = 'cnry_root',
  ) =>
    app.inject({
      method,
      url: '/api/v1/projects/one/gbp/' + path,
      headers: { authorization: 'Bearer ' + key },
      ...(payload === undefined ? {} : { payload }),
    })
  return { app, db, request }
}
describe('GBP API transport authorization and send-once claim', () => {
  it('requires explicit live-read authority and refuses another project before provider access', async () => {
    const f = await fixture()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    expect(
      (
        await f.request(
          'GET',
          'local-posts?accountName=accounts/111&locationName=locations/222',
          undefined,
          'cnry_reader',
        )
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await f.request(
          'GET',
          'local-posts?accountName=accounts/111&locationName=locations/222',
          undefined,
          'cnry_other',
        )
      ).statusCode,
    ).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
    expect(
      (
        await f.request(
          'GET',
          'local-posts?accountName=accounts/111&locationName=locations/222',
          undefined,
          'cnry_gbpread',
        )
      ).statusCode,
    ).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects wrong account/location and narrowed write credentials on other routes', async () => {
    const f = await fixture()
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    expect(
      (
        await f.request('POST', 'local-posts', {
          ...body,
          accountName: 'accounts/999',
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await f.request('POST', 'local-posts', body, 'cnry_reader')).statusCode,
    ).toBe(403)
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/v1/projects/one',
      headers: { authorization: 'Bearer cnry_gbpwrite' },
      payload: { displayName: 'Changed' },
    })
    expect(response.statusCode).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(
    (['editorial preflight', 'OAuth refresh'] as const).flatMap((stage) =>
      (['deselection', 'account', 'location', 'project domain', 'project identity'] as const)
        .map((change) => [stage, change] as const),
    ),
  )('refuses a %s request after %s changes', async (stage, change) => {
    const f = await fixture(
      stage === 'OAuth refresh' ? { tokenExpiresAt: new Date(0).toISOString() } : {},
    )
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<boolean>()
    if (stage === 'editorial preflight') {
      vi.mocked(hotelEditorialDestination).mockImplementationOnce(() => {
        entered.resolve()
        return resume.promise
      })
    }
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        entered.resolve()
        await resume.promise
        return new Response(JSON.stringify({
          access_token: 'fresh-fixture-token', expires_in: 3600, token_type: 'Bearer',
        }))
      }
      return new Response(JSON.stringify(post))
    })
    vi.stubGlobal('fetch', fetch)
    const pending = f.request('POST', 'local-posts', body)
    await entered.promise
    switch (change) {
      case 'deselection':
        f.db.update(gbpLocations).set({ selected: false }).where(eq(gbpLocations.id, 'loc')).run()
        break
      case 'account':
        f.db.update(gbpLocations).set({ accountName: 'accounts/999' }).where(eq(gbpLocations.id, 'loc')).run()
        break
      case 'location':
        f.db.update(gbpLocations).set({ locationName: 'locations/999' }).where(eq(gbpLocations.id, 'loc')).run()
        break
      case 'project domain':
        f.db.update(projects).set({ canonicalDomain: 'changed.example' }).where(eq(projects.id, 'p1')).run()
        break
      case 'project identity':
        f.db.update(projects).set({ name: 'retired-one' }).where(eq(projects.id, 'p1')).run()
        f.db.update(projects).set({ name: 'one', canonicalDomain: 'one.example' }).where(eq(projects.id, 'p2')).run()
        f.db.insert(gbpLocations).values({
          id: 'new-loc', projectId: 'p2', accountName: body.accountName,
          locationName: body.locationName, displayName: 'Replacement project',
          selected: true, createdAt: NOW, updatedAt: NOW,
        }).run()
        break
    }
    resume.resolve(true)
    const response = await pending
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toContain(
      change.startsWith('project') ? 'GBP project changed' : 'account/location is not selected',
    )
    expect(fetch).toHaveBeenCalledTimes(stage === 'OAuth refresh' ? 1 : 0)
    expect(f.db.select().from(auditLog)
      .where(eq(auditLog.action, 'gbp.local-post-claimed')).all()).toHaveLength(0)
  })
  it('allows unchanged eligibility after token refresh without an extra provider POST', async () => {
    const f = await fixture({ tokenExpiresAt: new Date(0).toISOString() })
    const fetch = vi.fn(async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url) === 'https://oauth2.googleapis.com/token'
        ? { access_token: 'fresh-fixture-token', expires_in: 3600, token_type: 'Bearer' }
        : post)),
    )
    vi.stubGlobal('fetch', fetch)
    const response = await f.request('POST', 'local-posts', body)
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('accepted')
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts',
    ])
    expect(f.db.select().from(auditLog)
      .where(eq(auditLog.action, 'gbp.local-post-claimed')).all()).toHaveLength(1)
  })
  it('replays the saved result without another provider POST and rejects changed content', async () => {
    const f = await fixture()
    const fetch = vi.fn(async () => new Response(JSON.stringify(post)))
    vi.stubGlobal('fetch', fetch)
    const first = await f.request('POST', 'local-posts', body)
    expect(first.statusCode).toBe(200)
    expect(first.json().status).toBe('accepted')
    expect((await f.request('POST', 'local-posts', body)).json()).toEqual(
      first.json(),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      (
        await f.request('POST', 'local-posts', {
          ...body,
          content: { ...content, summary: 'Changed' },
        })
      ).statusCode,
    ).toBe(400)
    const saved = await f.request(
      'GET',
      `local-post-attempt?attemptId=${body.attemptId}&packageId=${body.packageId}`,
    )
    expect(saved.statusCode).toBe(200)
    expect(saved.json().post.name).toBe(post.name)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses a concurrent request that reuses the attempt with different content', async () => {
    // An expired token makes each request wait on a refresh between the
    // claimed-attempt check and the claim, so both pass the check before
    // either claims. The loser must not be answered with the winner's attempt.
    const f = await fixture({ tokenExpiresAt: new Date(0).toISOString() })
    let refreshes = 0
    let releaseRefreshes: () => void = () => {}
    const bothRefreshing = new Promise<void>((resolve) => { releaseRefreshes = resolve })
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify(post))
      refreshes += 1
      if (refreshes === 2) releaseRefreshes()
      await bothRefreshing
      return new Response(JSON.stringify({ access_token: 'fresh-fixture-token', expires_in: 3600, token_type: 'Bearer' }))
    })
    vi.stubGlobal('fetch', fetch)
    const changed = { ...body, content: { ...content, summary: 'A different editorial article.' } }
    const [first, second] = await Promise.all([
      f.request('POST', 'local-posts', body),
      f.request('POST', 'local-posts', changed),
    ])
    expect(refreshes).toBe(2)
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400])
    const refused = first.statusCode === 400 ? first : second
    expect(refused.body).toContain('different content')
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/localPosts'))).toHaveLength(1)
  })
  it('retains ambiguous sends across repeated calls and never repeats the POST', async () => {
    const f = await fixture()
    const fetch = vi.fn(async () => {
      throw new Error('response lost')
    })
    vi.stubGlobal('fetch', fetch)
    expect((await f.request('POST', 'local-posts', body)).json().status).toBe(
      'uncertain',
    )
    expect((await f.request('POST', 'local-posts', body)).json().status).toBe(
      'uncertain',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses OFFER, scheduling and additional media fields', async () => {
    const f = await fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const extra of [
      { topicType: 'OFFER' },
      { scheduledTime: '2026-10-24T12:00:00Z' },
      { media: [...content.media, ...content.media] },
    ])
      expect(
        (
          await f.request('POST', 'local-posts', {
            ...body,
            content: { ...content, ...extra },
          })
        ).statusCode,
      ).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([null, 'Hôtel', 'Hotel'])(
    'cannot bypass editorial guard with category %s',
    async (category) => {
      const f = await fixture()
      f.db
        .update(gbpLocations)
        .set({ primaryCategoryDisplayName: category })
        .run()
      vi.mocked(hotelEditorialDestination).mockResolvedValue(false)
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      expect((await f.request('POST', 'local-posts', body)).statusCode).toBe(
        403,
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it.each([
    [{ name: 'accounts/111/locations/222/reviews/one' }],
    [{ name: 'accounts/999/locations/222/reviews/one', updateTime: NOW }],
    [
      { name: 'accounts/111/locations/222/reviews/one', updateTime: NOW },
      { name: 'accounts/111/locations/222/reviews/one', updateTime: NOW },
    ],
  ])(
    'does not claim complete coverage for incomplete or wrong-location reviews',
    async (reviews) => {
      const f = await fixture()
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ reviews, totalReviewCount: reviews.length }),
            ),
        ),
      )
      expect(
        (
          await f.request(
            'GET',
            'reviews/live?accountName=accounts/111&locationName=locations/222',
          )
        ).statusCode,
      ).toBe(502)
    },
  )

  it('rejects declared review coverage larger than the actual complete listing', async () => {
    const f = await fixture()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              reviews: [
                {
                  name: 'accounts/111/locations/222/reviews/one',
                  updateTime: NOW,
                },
              ],
              totalReviewCount: 2,
            }),
          ),
      ),
    )
    expect(
      (
        await f.request(
          'GET',
          'reviews/live?accountName=accounts/111&locationName=locations/222',
        )
      ).statusCode,
    ).toBe(502)
  })
})

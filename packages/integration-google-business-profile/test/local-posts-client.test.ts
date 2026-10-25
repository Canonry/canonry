import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  createLocalPost,
  getLocalPost,
  listLocalPosts,
} from '../src/local-posts-client.js'
const parent = 'accounts/111/locations/222'
const name = parent + '/localPosts/333'
const content = {
  languageCode: 'en',
  summary: 'A useful article.',
  topicType: 'STANDARD' as const,
  callToAction: {
    actionType: 'LEARN_MORE' as const,
    url: 'https://example.com/article/',
  },
  media: [
    {
      mediaFormat: 'PHOTO' as const,
      sourceUrl: 'https://example.com/photo.jpg',
    },
  ] as [{ mediaFormat: 'PHOTO'; sourceUrl: string }],
}
const post = () => ({
  name,
  ...content,
  state: 'LIVE',
  createTime: '2026-10-23T17:00:00Z',
  updateTime: '2026-10-23T17:00:00Z',
  searchUrl: 'https://local.google.com/place?id=123&use=posts&lpsid=abc',
})
afterEach(() => vi.unstubAllGlobals())
describe('Google Local Posts fixed transport', () => {
  it('lists a bounded page, retaining its coverage token and media source', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ localPosts: [post()], nextPageToken: 'next' }),
        ),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await listLocalPosts(
      'secret',
      'accounts/111',
      'locations/222',
    )
    expect(result.nextPageToken).toBe('next')
    expect(result.posts[0]).toMatchObject({
      name,
      state: 'LIVE',
      articleUrl: content.callToAction.url,
      imageUrls: [content.media[0].sourceUrl],
      mediaSourceUrlsComplete: true,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://mybusiness.googleapis.com/v4/' +
        parent +
        '/localPosts?pageSize=100',
    )
  })
  it('refuses cross-location responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...post(),
              name: 'accounts/999/locations/222/localPosts/333',
            }),
          ),
      ),
    )
    await expect(getLocalPost('secret', name)).rejects.toThrow('identity')
  })
  it('retains every historical identity and continuation across pages with unavailable media sources', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ localPosts: [
        { ...post(), media: [{ mediaFormat: 'PHOTO', googleUrl: 'https://lh3.googleusercontent.com/old-photo' }] },
        { ...post(), name: parent + '/localPosts/444', media: [{ mediaFormat: 'VIDEO', sourceUrl: 'https://example.com/old-video.mp4' }] },
      ], nextPageToken: 'history-page+2/' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ localPosts: [
        { ...post(), name: parent + '/localPosts/555' },
      ] })))
    vi.stubGlobal('fetch', fetch)
    const first = await listLocalPosts('secret', 'accounts/111', 'locations/222')
    const second = await listLocalPosts('secret', 'accounts/111', 'locations/222', first.nextPageToken!)
    expect([...first.posts, ...second.posts].map(item => ({ name: item.name, articleUrl: item.articleUrl, imageUrls: item.imageUrls, complete: item.mediaSourceUrlsComplete }))).toEqual([
      { name, articleUrl: content.callToAction.url, imageUrls: [], complete: false },
      { name: parent + '/localPosts/444', articleUrl: content.callToAction.url, imageUrls: [], complete: false },
      { name: parent + '/localPosts/555', articleUrl: content.callToAction.url, imageUrls: [content.media[0].sourceUrl], complete: true },
    ])
    expect(second.nextPageToken).toBeNull()
    expect(fetch.mock.calls[1]?.[0]).toBe('https://mybusiness.googleapis.com/v4/' + parent + '/localPosts?pageSize=100&pageToken=history-page%2B2%2F')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([400, 403, 429, 503])(
    'never retries create HTTP %s',
    async (status) => {
      const fetch = vi.fn(async () => new Response('{}', { status }))
      vi.stubGlobal('fetch', fetch)
      await expect(
        createLocalPost('secret', 'accounts/111', 'locations/222', content),
      ).rejects.toThrow()
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('retains uncertainty after a transport failure without retry', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('lost response')
    })
    vi.stubGlobal('fetch', fetch)
    await expect(
      createLocalPost('secret', 'accounts/111', 'locations/222', content),
    ).rejects.toThrow('lost response')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('creates exactly STANDARD + LEARN_MORE + one photo, with no offer or schedule fields', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(post())))
    vi.stubGlobal('fetch', fetch)
    await createLocalPost('secret', 'accounts/111', 'locations/222', content)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual(content)
    await expect(
      createLocalPost('secret', 'accounts/111', 'locations/222', {
        ...content,
        topicType: 'OFFER',
      } as never),
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { mediaFormat: 'VIDEO', googleUrl: 'https://google.com/video' },
    { mediaFormat: 'PHOTO', googleUrl: 'https://google.com/photo' },
  ])(
    'refuses an extra attachment without an exact photo source',
    async (extra) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ ...post(), media: [...content.media, extra] }),
            ),
        ),
      )
      await expect(getLocalPost('secret', name)).rejects.toThrow('media')
    },
  )
})

describe('provider-hosted Local Post media', () => {
  it('exposes explicit rejection even when Google no longer supplies photo evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...post(), state: 'REJECTED', media: [{ mediaFormat: 'PHOTO' }] }))))
    await expect(getLocalPost('secret', name)).resolves.toMatchObject({ name, state: 'REJECTED', imageUrls: [], mediaSourceUrlsComplete: false })
  })
  it('exposes exact-resource Google image evidence without inventing source URLs', async () => {
    const googleUrl = 'https://lh3.googleusercontent.com/geougc/exact-photo'
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...post(), media: [{ mediaFormat: 'PHOTO', googleUrl }] })))
    vi.stubGlobal('fetch', fetch)
    const observed = await getLocalPost('secret', name)
    expect(observed).toMatchObject({ name, imageUrls: [], mediaSourceUrlsComplete: false, providerImageUrls: [googleUrl] })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('https://mybusiness.googleapis.com/v4/' + name)
  })
  it.each([
    'https://lh3.googleusercontent.com.evil.test/photo',
    'http://lh3.googleusercontent.com/photo',
    'https://secret@lh3.googleusercontent.com/photo',
    'https://lh3.googleusercontent.com:444/photo',
  ])('refuses unsupported provider image destination %s', async (googleUrl) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...post(), media: [{ mediaFormat: 'PHOTO', googleUrl }] }))))
    await expect(getLocalPost('secret', name)).rejects.toThrow('media')
  })
  it('never partially admits a mixed photo/video exact read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...post(), media: [
      { mediaFormat: 'PHOTO', googleUrl: 'https://lh3.googleusercontent.com/photo' },
      { mediaFormat: 'VIDEO', googleUrl: 'https://lh3.googleusercontent.com/video' },
    ] }))))
    await expect(getLocalPost('secret', name)).rejects.toThrow('media')
  })
})

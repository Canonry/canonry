import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient query edit', () => {
  it('sends the one-query replacement through the generated SDK without normalizing the CAS value', async () => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify({
        id: 'query-replacement',
        query: 'new question',
        createdAt: '2026-08-30T12:00:00.000Z',
      }), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const replacement = await client.replaceQuery('demo', 'query-original', {
      query: 'new question',
      expectedQuery: '  saved question  ',
    })

    expect(received?.method).toBe('POST')
    expect(new URL(received!.url).pathname).toBe('/api/v1/projects/demo/queries/query-original/replace')
    expect(await received!.json()).toEqual({
      query: 'new question',
      expectedQuery: '  saved question  ',
    })
    expect(replacement).toEqual({
      id: 'query-replacement',
      query: 'new question',
      createdAt: '2026-08-30T12:00:00.000Z',
    })
  })
})

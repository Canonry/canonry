import { describe, it, expect, vi } from 'vitest'
import {
  hotelEditorialDestination,
  hotelEditorialText,
} from '../src/gbp-hotel-policy.js'
describe('hotel editorial-only guard', () => {
  it.each([
    'Book now for a discount',
    'Special offers',
    'Travel deals',
    'Save 20 percent',
    'Get a promo code',
    'd&#105;scount',
    '<a href="/offers/">Read more</a>',
  ])('refuses promotional copy or links: %s', (text) => {
    expect(hotelEditorialText(text)).toBe(false)
  })
  it('allows a relevant editorial article and checks the whole public destination', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('<article>A guide to the neighborhood.</article>', {
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(
      await hotelEditorialDestination(
        'hotel.example',
        'A guide to the neighborhood.',
        'https://hotel.example/journal/guide/',
        fetch,
      ),
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['Hotel.Example', 'https://hotel.example/journal/guide/'],
    ['https://Hotel.Example/', 'https://hotel.example/journal/guide/'],
    ['https://www.Hotel.Example/about', 'https://hotel.example/journal/guide/'],
    ['www.Hotel.Example', 'https://www.hotel.example/journal/guide/'],
  ])('accepts the same editorial host stored as %s', async (domain, articleUrl) => {
    const fetch = vi.fn(async (_url: string | URL | Request) =>
      new Response('<article>A local guide.</article>', {
        headers: { 'content-type': 'text/html' },
      }),
    )
    expect(
      await hotelEditorialDestination(domain, 'A local guide.', articleUrl, fetch),
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(articleUrl))
  })
  it.each([
    ['', 'https://hotel.example/journal/guide/'],
    ['https://Hotel.Example/', 'https://hotel.example.evil.test/journal/guide/'],
    ['https://Hotel.Example/', 'https://other.hotel.example/journal/guide/'],
    ['https://Hotel.Example/', 'https://hotel.example@evil.test/journal/guide/'],
    ['https://Hotel.Example/', 'http://hotel.example/journal/guide/'],
  ])('retains destination confinement for %s and %s', async (domain, articleUrl) => {
    const fetch = vi.fn()
    expect(
      await hotelEditorialDestination(domain, 'A local guide.', articleUrl, fetch),
    ).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses promotions in the linked destination even when caption is editorial', async () => {
    expect(
      await hotelEditorialDestination(
        'hotel.example',
        'A local guide',
        'https://hotel.example/journal/guide/',
        async () =>
          new Response(
            '<article>A guide.</article><a href="/%6fffers">More</a>',
            { headers: { 'content-type': 'text/html' } },
          ),
      ),
    ).toBe(false)
  })
  it('refuses another host, an unavailable page and incomplete reads', async () => {
    const fetch = vi.fn(async () => new Response('A guide', { status: 503 }))
    expect(
      await hotelEditorialDestination(
        'hotel.example',
        'A local guide',
        'https://other.example/guide/',
        fetch,
      ),
    ).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(
      await hotelEditorialDestination(
        'hotel.example',
        'A local guide',
        'https://hotel.example/guide/',
        fetch,
      ),
    ).toBe(false)
  })
})

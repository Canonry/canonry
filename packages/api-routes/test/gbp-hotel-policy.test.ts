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

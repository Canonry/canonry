import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  hotelEditorialDestination,
  hotelEditorialText,
} from '../src/gbp-hotel-policy.js'

const editorialPage = (html: string, domain = 'hotel.example') =>
  hotelEditorialDestination(
    domain,
    'Plan roof access before panels go on.',
    `https://${domain}/journal/guide/`,
    async () =>
      new Response(html, { headers: { 'content-type': 'text/html' } }),
  )
const jsonLd = (value: unknown) =>
  `<article>A roof access guide.</article><script type="application/ld+json">${JSON.stringify(value)}</script>`

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
  ])(
    'accepts the same editorial host stored as %s',
    async (domain, articleUrl) => {
      const fetch = vi.fn(
        async (_url: string | URL | Request) =>
          new Response('<article>A local guide.</article>', {
            headers: { 'content-type': 'text/html' },
          }),
      )
      expect(
        await hotelEditorialDestination(
          domain,
          'A local guide.',
          articleUrl,
          fetch,
        ),
      ).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(articleUrl))
    },
  )
  it.each([
    ['', 'https://hotel.example/journal/guide/'],
    [
      'https://Hotel.Example/',
      'https://hotel.example.evil.test/journal/guide/',
    ],
    ['https://Hotel.Example/', 'https://other.hotel.example/journal/guide/'],
    [
      'https://Hotel.Example/',
      'https://hotel.example@evil.test/journal/guide/',
    ],
    ['https://Hotel.Example/', 'http://hotel.example/journal/guide/'],
  ])(
    'retains destination confinement for %s and %s',
    async (domain, articleUrl) => {
      const fetch = vi.fn()
      expect(
        await hotelEditorialDestination(
          domain,
          'A local guide.',
          articleUrl,
          fetch,
        ),
      ).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    },
  )
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

  it('accepts the actual AZ solar page service catalog without changing the all-client editorial restriction', async () => {
    const html = readFileSync(
      new URL('./fixtures/az-solar-service-catalog.html', import.meta.url),
      'utf8',
    )
    expect(await editorialPage(html, 'azcoatingsllc.com')).toBe(true)
    expect(
      await editorialPage(
        html.replace('A roof access guide.', 'Special offers'),
        'azcoatingsllc.com',
      ),
    ).toBe(false)
  })
  it('accepts schema identifiers in scalar, array and URL form while retaining editorial checks', async () => {
    const html = jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Hotel',
      offers: {
        '@type': [
          'https://schema.org/Offer',
          'http://schema.org/AggregateOffer',
        ],
        name: 'Standard room',
        price: '100',
        priceCurrency: 'USD',
      },
    })
    expect(await editorialPage(html)).toBe(true)
  })
  it.each([
    { name: 'Special offers' },
    { description: 'Book now for a discount' },
    { description: 'Book\nnow' },
    { description: 'Book\tnow' },
    { description: '20%\noff' },
    { description: 'Save\n20' },
    { url: 'https://hotel.example/offers/' },
    { url: 'https://hotel.example/%6fffers/' },
    { discountCode: 'SUMMER' },
    { '%64iscountCode': 'SUMMER' },
    { 'd&#105;scountCode': 'SUMMER' },
    { discount: 10 },
    { couponCode: 'SUMMER' },
    {
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        priceType: 'https://schema.org/SalePrice',
        price: 50,
      },
    },
    { priceSpecification: { priceType: 'StrikethroughPrice', price: 100 } },
    {
      priceSpecification: {
        priceType: 'https://schema.org/%53alePrice',
        price: 50,
      },
    },
    {
      priceSpecification: {
        priceType: 'https://schema.org/SalePr&#105;ce',
        price: 50,
      },
    },
  ])(
    'rejects genuine hotel promotion data after allowing schema type identifiers: %j',
    async (data) => {
      expect(
        await editorialPage(
          jsonLd({
            '@context': 'https://schema.org',
            '@type': 'Offer',
            ...data,
          }),
        ),
      ).toBe(false)
    },
  )
  it('decodes JSON escapes before scanning and never erases duplicate promotional members', async () => {
    const body = String.raw`{"@context":"https://schema.org","@type":"\u004ffer","name":"d\u0069scount","name":"A guide"}`
    expect(
      await editorialPage(
        `<script type="application/ld+json">${body}</script>`,
      ),
    ).toBe(false)
  })
  it.each([
    '{"@context":"https://schema.org","@type":"Offer",}',
    '{"@context":"https://unknown.example/context","@type":"Offer"}',
    '{"@context":"https://schema.org","nested":{"@context":"https://unknown.example/context","@type":"Offer"}}',
    '[]',
    '[null]',
  ])(
    'refuses malformed or unsupported JSON-LD instead of stripping it: %s',
    async (body) => {
      expect(
        await editorialPage(
          `<script type="application/ld+json">${body}</script>`,
        ),
      ).toBe(false)
    },
  )
  it('keeps promotional links, captions, attributes and prose outside JSON-LD authoritative', async () => {
    const page = jsonLd({
      '@context': 'https://schema.org',
      '@type': 'Offer',
      name: 'Standard service',
    })
    expect(await editorialPage(page + '<a href="/deals">Read more</a>')).toBe(
      false,
    )
    expect(await editorialPage(page + '<p>Special offers</p>')).toBe(false)
    expect(
      await editorialPage(
        page.replace(
          'type="application/ld+json"',
          'type="application/ld+json" data-note="discount"',
        ),
      ),
    ).toBe(false)
    expect(
      await hotelEditorialDestination(
        'hotel.example',
        'Book now for a discount',
        'https://hotel.example/journal/guide/',
        async () => new Response(page),
      ),
    ).toBe(false)
  })
  it('does not mistake schema-shaped text inside a JSON string for identifiers', async () => {
    expect(
      await editorialPage(
        jsonLd({ '@context': 'https://schema.org', name: '{"@type":"Offer"}' }),
      ),
    ).toBe(false)
  })
  it('bounds JSON-LD nesting and retains unknown type values instead of masking them', async () => {
    let nested: unknown = 'A guide'
    for (let i = 0; i < 35; i++) nested = { item: nested }
    expect(
      await editorialPage(jsonLd({ '@context': 'https://schema.org', nested })),
    ).toBe(false)
    expect(
      await editorialPage(
        jsonLd({
          '@context': 'https://schema.org',
          '@type': ['Offer', 'Special offers'],
        }),
      ),
    ).toBe(false)
  })
})

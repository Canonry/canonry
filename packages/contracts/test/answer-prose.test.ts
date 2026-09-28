import { describe, expect, it } from 'vitest'
import { answerProseForMentions, stripCitationChips } from '../src/answer-prose.js'
import { determineAnswerMentioned, extractAnswerMentions } from '../src/answer-visibility.js'

const BRAND = ['Harborview Living']
const DOMAINS = ['harborview.com']

/**
 * Shape of an OpenAI web-search answer (chat-latest): the brand appears ONLY
 * inside the inline source chips, while the property is named in prose.
 */
const CHATGPT_CHIPS_ONLY = `Yes. Bayside Flats is pet-friendly and accepts both cats and dogs, with a two-pet limit per apartment. ([harborview.com](https://harborview.com/apartments/ca/oakland/bayside-flats/?utm_source=chatgpt.com))

Key details:

- **Pet fees:** a one-time fee of $350 per pet plus monthly pet rent of $50. ([harborview.com](https://harborview.com/apartments/ca/oakland/bayside-flats/pet-policy/?utm_source=chatgpt.com))
- **Breed restrictions:** some breeds are not permitted, and a weight limit applies for dogs. ([Apartments.com](https://www.apartments.com/bayside-flats-oakland-ca/x1y2z3/?utm_source=chatgpt.com), [harborview.com](https://harborview.com/apartments/ca/oakland/bayside-flats/faq/?utm_source=chatgpt.com))
- **Amenities:** an on-site dog run and a pet wash station. ([Harborview Living](https://harborview.com/amenities/?utm_source=chatgpt.com))

If you are moving with a large dog, confirm the current weight limit with the leasing office before applying.`

/** Shape of a Gemini answer: plain markdown prose, bold list items and a table, no links. */
const GEMINI_PROSE = `For waterfront apartments in Oakland, a few communities stand out:

*   **Harborview Living, Bayside Flats:** Modern units with a rooftop deck and an on-site dog run.
*   **The Ferris at Jack London:** Larger floor plans, but higher rent.

| Community | Operator | Pet friendly |
| --- | --- | --- |
| Bayside Flats | Harborview Living | Yes |
| The Ferris | Ferris Residential | Yes |`

/** A ChatGPT answer that names the brand in prose AND carries brand chips. */
const CHATGPT_MIXED = `Harborview Living operates several waterfront communities in Oakland, including Bayside Flats and Marina Point. ([harborview.com](https://harborview.com/communities/?utm_source=chatgpt.com))

Residents often highlight the on-site maintenance team. ([Yelp](https://www.yelp.com/biz/bayside-flats-oakland?utm_source=chatgpt.com), [harborview.com](https://harborview.com/reviews/?utm_source=chatgpt.com))`

/** Shape of a Claude answer that links the brand name as the subject of a sentence. */
const CLAUDE_PROSE_LINK = `[Harborview Living](https://harborview.com/) offers month-to-month leases at Bayside Flats, which is unusual for the area.

| Community | Lease terms |
| --- | --- |
| [Bayside Flats](https://harborview.com/apartments/bayside-flats/) | 1 to 15 months |`

/** An answer that ends with reference definitions pointing at the brand's site. */
const REFERENCE_STYLE = `Two waterfront options are worth touring: Marina Point [1] and The Ferris [2].

Both allow pets [1][2].

[1]: https://harborview.com/apartments/marina-point
[2]: https://www.apartments.com/the-ferris-oakland-ca/`

describe('answerProseForMentions', () => {
  it('removes OpenAI citation chips, single and multi-link, whatever their labels say', () => {
    const prose = answerProseForMentions(CHATGPT_CHIPS_ONLY)
    expect(prose).not.toMatch(/harborview|apartments\.com|utm_source|\]\(/i)
    expect(prose).toContain('Yes. Bayside Flats is pet-friendly and accepts both cats and dogs, with a two-pet limit per apartment.')
    expect(prose).toContain('- **Amenities:** an on-site dog run and a pet wash station.')
  })

  it('leaves link-free prose byte for byte', () => {
    expect(answerProseForMentions(GEMINI_PROSE)).toBe(GEMINI_PROSE)
  })

  it('keeps an ordinary link label as prose and drops its URL', () => {
    expect(answerProseForMentions(CLAUDE_PROSE_LINK)).toBe(`Harborview Living offers month-to-month leases at Bayside Flats, which is unusual for the area.

| Community | Lease terms |
| --- | --- |
| Bayside Flats | 1 to 15 months |`)
    expect(answerProseForMentions('Tour **[Bayside Flats](https://harborview.com/x)** first.'))
      .toBe('Tour **Bayside Flats** first.')
  })

  it('keeps a domain written in prose outside any link', () => {
    const text = 'Book a tour at harborview.com or call the office. ([harborview.com](https://harborview.com/tours/?utm_source=chatgpt.com))'
    expect(answerProseForMentions(text)).toBe('Book a tour at harborview.com or call the office.  ')
  })

  it('drops a link whose label is a lowercase host, a URL, or a citation token, even outside parentheses', () => {
    expect(answerProseForMentions('Book at [harborview.com](https://harborview.com/tours).')).toBe('Book at  .')
    expect(answerProseForMentions('Book at [www.Harborview.com](https://harborview.com/tours).')).toBe('Book at  .')
    expect(answerProseForMentions('Book at [Harborview.com/tours](https://harborview.com/tours).')).toBe('Book at  .')
    expect(answerProseForMentions('See [https://harborview.com/tours](https://harborview.com/tours).')).toBe('See  .')
    expect(answerProseForMentions('Floor plans [harborview.com/floor-plans](https://harborview.com/floor-plans) vary.'))
      .toBe('Floor plans   vary.')
    expect(answerProseForMentions('Pets allowed [1](https://harborview.com/pets), [source](https://harborview.com/faq).'))
      .toBe('Pets allowed  ,  .')
    expect(answerProseForMentions('Pets allowed [[2]](https://harborview.com/pets).')).toBe('Pets allowed  .')
  })

  it('keeps a brand-cased host label as prose outside a chip, and drops it inside one', () => {
    // ChatGPT's list format names a product whose name is its domain as a
    // bold link. That is the subject of the sentence, not a source label.
    expect(answerProseForMentions('1. **[Harborview.ai](https://harborview.ai/?utm_source=chatgpt.com)** is the most popular leasing assistant.'))
      .toBe('1. **Harborview.ai** is the most popular leasing assistant.')
    expect(answerProseForMentions('It answers leads within a minute. ([Harborview.ai](https://harborview.ai/?utm_source=chatgpt.com))'))
      .toBe('It answers leads within a minute.  ')
  })

  it('treats a parenthesized group of links as a chip only when nothing but separators sits between them', () => {
    expect(answerProseForMentions('Rent is high ([Zillow](https://zillow.com/a); [Harborview Living](https://harborview.com/b) and [Redfin](https://redfin.com/c)).'))
      .toBe('Rent is high  .')
    expect(answerProseForMentions('Several operators (such as [Harborview Living](https://harborview.com/)) manage units here.'))
      .toBe('Several operators (such as Harborview Living) manage units here.')
  })

  it('removes reference definitions, footnotes, and bare numeric markers', () => {
    expect(answerProseForMentions(REFERENCE_STYLE)).toBe('Two waterfront options are worth touring: Marina Point   and The Ferris  .\n\nBoth allow pets  .\n\n \n ')
    expect(answerProseForMentions('Pets are welcome[^1].\n\n[^1]: Harborview Living pet policy, harborview.com/pets'))
      .toBe('Pets are welcome .\n\n ')
    expect(answerProseForMentions('Rents rose 4% [1, 3] last year [2-4].')).toBe('Rents rose 4%   last year  .')
    expect(answerProseForMentions('Tour [Harborview Living][1] or [harborview.com][2].\n\n[1]: harborview.com/tours "Tours"'))
      .toBe('Tour Harborview Living or  .\n\n ')
  })

  it('removes bare URLs, images, and provider citation markers', () => {
    expect(answerProseForMentions('Apply online at https://harborview.com/apply?utm_source=chatgpt.com today.'))
      .toBe('Apply online at   today.')
    expect(answerProseForMentions('![Harborview Living logo](https://harborview.com/logo.png) Bayside Flats opened in 2021.'))
      .toBe('  Bayside Flats opened in 2021.')
    expect(answerProseForMentions('Bayside Flats allows cats. \uE200cite\uE202turn0search3\uE202turn1news0\uE201 It also has a dog run.'))
      .toBe('Bayside Flats allows cats.   It also has a dog run.')
    expect(answerProseForMentions('Bayside Flats allows cats.citeturn0search3turn0search7 More.')).toBe('Bayside Flats allows cats.  More.')
    expect(answerProseForMentions('Bayside Flats allows cats.【4:0†harborview.com】')).toBe('Bayside Flats allows cats. ')
  })

  it('ends a bare URL at the first character a URL cannot hold', () => {
    // Chinese and Japanese answers put no space after a URL, and an unspaced
    // em dash (U+2014) can follow one in English.
    expect(answerProseForMentions('公式サイト（https://example.jp/）で予約できます。港景ホテルは駅の近くです。'))
      .toBe('公式サイト（ ）で予約できます。港景ホテルは駅の近くです。')
    expect(answerProseForMentions('详情请访问https://example.cn/，港景公寓也很受欢迎。')).toBe('详情请访问 ，港景公寓也很受欢迎。')
    expect(answerProseForMentions('Book at https://example.com/tours\u2014Harborview Living replies within a day.'))
      .toBe('Book at  \u2014Harborview Living replies within a day.')
    expect(answerProseForMentions('See https://example.com/wiki/Pier_(Oakland), then walk.')).toBe('See   then walk.')
  })

  it('keeps a host written in prose, with or without www', () => {
    expect(answerProseForMentions('You can apply through their website, www.harborview.com, in under ten minutes.'))
      .toBe('You can apply through their website, www.harborview.com, in under ten minutes.')
  })

  it('removes only dagger citation markers, never 【】 used as punctuation', () => {
    expect(answerProseForMentions('東京駅周辺のおすすめホテル\n\n【港景ホテル】\n駅から徒歩3分。'))
      .toBe('東京駅周辺のおすすめホテル\n\n【港景ホテル】\n駅から徒歩3分。')
    expect(answerProseForMentions('推荐：【港景公寓】位于黄浦江边【3†source】。')).toBe('推荐：【港景公寓】位于黄浦江边 。')
  })

  it('is idempotent and passes null through', () => {
    for (const text of [CHATGPT_CHIPS_ONLY, GEMINI_PROSE, CHATGPT_MIXED, CLAUDE_PROSE_LINK, REFERENCE_STYLE]) {
      const once = answerProseForMentions(text)
      expect(answerProseForMentions(once)).toBe(once)
    }
    expect(answerProseForMentions(null)).toBeNull()
    expect(answerProseForMentions(undefined)).toBeNull()
    expect(answerProseForMentions('')).toBe('')
  })

  it('stays linear on pathological markup', () => {
    // Each of these would hang a backtracking pattern with nested quantifiers.
    const inputs = [
      '['.repeat(200_000),
      '([a](u), '.repeat(20_000),
      '(' + '[a](u) '.repeat(20_000),
      '[a]('.repeat(50_000),
      '[1, '.repeat(50_000),
      'https://' + 'a('.repeat(100_000),
      '(' + ' '.repeat(100_000) + '[harborview.com](https://harborview.com)',
      'https://x(' + 'a'.repeat(100_000),
      '【' + 'a'.repeat(100_000) + '†',
      '【†'.repeat(50_000),
    ]
    for (const input of inputs) {
      expect(typeof answerProseForMentions(input)).toBe('string')
      expect(typeof stripCitationChips(input)).toBe('string')
    }
  })
})

describe('extractAnswerMentions reads the prose, not the citations', () => {
  it('a brand that appears only in citation chips is not mentioned', () => {
    expect(extractAnswerMentions(CHATGPT_CHIPS_ONLY, BRAND, DOMAINS)).toEqual({ mentioned: false, matchedTerms: [] })
    expect(extractAnswerMentions(
      'Pet-friendly with a dog park. ([Apartments.com](https://www.apartments.com/marina-point/xyz/?utm_source=chatgpt.com), [harborview.com](https://harborview.com/apartments/marina-point/?utm_source=chatgpt.com))',
      BRAND,
      DOMAINS,
    )).toEqual({ mentioned: false, matchedTerms: [] })
  })

  it('a brand named in Gemini-style prose, lists, and tables is mentioned', () => {
    expect(extractAnswerMentions(GEMINI_PROSE, BRAND, DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['Harborview Living', 'harborview'] })
    expect(answerProseForMentions(GEMINI_PROSE)).toBe(GEMINI_PROSE)
  })

  it('a prose mention beside chips is mentioned by the prose terms alone', () => {
    // The chips' domain is a citation; before the fix it was reported as the
    // strongest matched term. The domain's brand label is a prose word here.
    expect(extractAnswerMentions(CHATGPT_MIXED, BRAND, DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['Harborview Living', 'harborview'] })
  })

  it('reports a display name and its own domain label once when they differ only in case', () => {
    // With the chips gone, the domain no longer subsumes the label, so a
    // one-word brand used to be reported as ['Harborview', 'harborview'].
    const answer = 'Harborview manages Bayside Flats. ([harborview.com](https://harborview.com/bayside-flats/?utm_source=chatgpt.com))'
    expect(extractAnswerMentions(answer, ['Harborview'], DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['Harborview'] })
  })

  it('a brand written as the label of a prose link is mentioned', () => {
    expect(extractAnswerMentions(CLAUDE_PROSE_LINK, BRAND, DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['Harborview Living', 'harborview'] })
  })

  it('a brand domain written in prose outside any link is still mentioned', () => {
    const text = 'Book a tour at harborview.com or call the office. ([harborview.com](https://harborview.com/tours/?utm_source=chatgpt.com))'
    expect(extractAnswerMentions(text, BRAND, DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['harborview.com'] })
    expect(answerProseForMentions(text)).toContain('Book a tour at harborview.com or call the office.')
  })

  it('reference definitions pointing at the brand are not a mention', () => {
    expect(extractAnswerMentions(REFERENCE_STYLE, BRAND, DOMAINS)).toEqual({ mentioned: false, matchedTerms: [] })
  })

  it('a bare URL or a domain-labelled link to the brand is not a mention', () => {
    expect(determineAnswerMentioned('Apply online at https://harborview.com/apply today.', BRAND, DOMAINS)).toBe(false)
    expect(determineAnswerMentioned('Book at [harborview.com](https://harborview.com/tours).', BRAND, DOMAINS)).toBe(false)
  })

  it('a brand whose name is its domain, linked as the subject of a sentence, is mentioned', () => {
    const answer = '1. **[Harborview.ai](https://harborview.ai/?utm_source=chatgpt.com)** is the most popular leasing assistant for small operators.'
    expect(extractAnswerMentions(answer, ['Harborview.ai'], ['harborview.ai'])).toEqual({ mentioned: true, matchedTerms: ['harborview.ai'] })
    expect(determineAnswerMentioned(
      'It answers leads within a minute. ([Harborview.ai](https://harborview.ai/?utm_source=chatgpt.com))',
      ['Harborview.ai'],
      ['harborview.ai'],
    )).toBe(false)
  })

  it('a brand named in Chinese or Japanese prose next to a URL or in 【】 is mentioned', () => {
    expect(determineAnswerMentioned('公式サイト（https://example.jp/）で予約できます。港景ホテルは駅の近くです。', ['港景ホテル'], [])).toBe(true)
    expect(determineAnswerMentioned('详情请访问https://example.cn/，港景公寓也很受欢迎。', ['港景公寓'], [])).toBe(true)
    expect(determineAnswerMentioned('東京駅周辺のおすすめホテル\n\n【港景ホテル】\n駅から徒歩3分。', ['港景ホテル'], [])).toBe(true)
    expect(determineAnswerMentioned('Book at https://example.com/tours\u2014Harborview Living replies within a day.', BRAND, [])).toBe(true)
  })

  it('a brand website written in prose with www is mentioned, like one written without it', () => {
    const answer = 'You can apply through their website, www.harborview.com, in under ten minutes.'
    expect(extractAnswerMentions(answer, BRAND, DOMAINS)).toEqual({ mentioned: true, matchedTerms: ['harborview.com'] })
  })

  it('a competitor chip is not a competitor mention', () => {
    // mention-landscape asks exactly this per competitor: its domain label as
    // the alias, its domain as the identity.
    const answer = 'Bayside Flats has the lowest pet fees in the area. ([marinapointhomes.com](https://marinapointhomes.com/pets?utm_source=chatgpt.com))'
    expect(determineAnswerMentioned(answer, ['marinapointhomes'], ['marinapointhomes.com'])).toBe(false)
    expect(determineAnswerMentioned(`${answer} Marina Point Homes is a close second.`, ['Marina Point Homes'], ['marinapointhomes.com'])).toBe(true)
  })

  it('a caller-supplied answerDomains list is trusted as the prose hosts', () => {
    // Callers that share one parse across readers must pass prose domains; the
    // raw text's chip domains would reintroduce the citation.
    expect(determineAnswerMentioned(CHATGPT_CHIPS_ONLY, BRAND, DOMAINS, [])).toBe(false)
  })
})

describe('stripCitationChips', () => {
  it('removes chips and keeps every other link as written', () => {
    const answer = 'For lower fees, [Rival Homes](https://rival.example/pets) charges $200 per pet. ([Rival Homes](https://rival.example/pets/?utm_source=chatgpt.com), [harborview.com](https://harborview.com/pets/?utm_source=chatgpt.com))'
    expect(stripCitationChips(answer)).toBe('For lower fees, [Rival Homes](https://rival.example/pets) charges $200 per pet.  ')
    expect(stripCitationChips(GEMINI_PROSE)).toBe(GEMINI_PROSE)
  })
})

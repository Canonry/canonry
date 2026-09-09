import { describe, expect, it } from 'vitest'
import {
  brandKeyFromText,
  brandWords,
  compileBrandAliases,
  matchedAliasKeys,
  matcherMatchesText,
  prepareBrandMatchText,
  textContainsBrandAlias,
  textContainsAnyBrandAlias,
} from '../src/brand-matching.js'

describe('brand identity matching', () => {
  it('folds casing, punctuation, and spacing without changing spelling', () => {
    expect(brandKeyFromText('Demand-IQ')).toBe('demandiq')
    expect(textContainsBrandAlias('Demand IQ pricing', 'DemandIQ')).toBe(true)
    expect(textContainsBrandAlias('Try DemandIQ today', 'Demand IQ')).toBe(true)
  })

  it('matches complete adjacent words, not substrings', () => {
    expect(textContainsBrandAlias('Acme builds this.', 'Acme')).toBe(true)
    expect(textContainsBrandAlias('Acmeology is unrelated.', 'Acme')).toBe(false)
    expect(textContainsBrandAlias('Apply online.', 'Apple')).toBe(false)
    expect(textContainsBrandAlias('Compare price tiers.', 'Prime')).toBe(false)
  })

  it('supports short approved aliases without matching inside words', () => {
    expect(textContainsBrandAlias('LI announced a new product.', 'LI')).toBe(true)
    expect(textContainsBrandAlias('The polished finish lasts.', 'LI')).toBe(false)
  })

  it('normalizes Unicode compatibility and composed forms', () => {
    expect(textContainsBrandAlias('CAFÉ Canon is open.', 'Cafe\u0301 Canon')).toBe(true)
    expect(textContainsAnyBrandAlias('株式会社カノンリーを選ぶ', ['カノンリー'])).toBe(true)
  })

  it('never treats edit-distance neighbors as the same identity', () => {
    expect(textContainsBrandAlias('gelina venice', 'Gjelina')).toBe(false)
    expect(textContainsBrandAlias('selina venice', 'Gjelina')).toBe(false)
  })
})

describe('one segmentation for the whole alias set', () => {
  // The shape that matters: ONE alias list against MANY texts. Asking each
  // alias separately re-walked the entire text every time, so cost grew with
  // the alias count, which is exactly where an approval-driven design adds
  // them. Measured on a real corpus: 4,711ms -> 430ms at eight aliases.
  const aliases = ['Demand IQ', 'DemandIQ Inc', 'Demand Intelligence', 'Acme', 'Gjelina Hotel']

  it('is identical to asking each alias on its own', () => {
    const texts = [
      'We use Demand IQ for solar quotes.',
      'demand-iq is a lead platform.',
      'Nothing relevant here at all.',
      'Acmeology is a different company.', // substring, must NOT match
      'Stayed at the Gjelina Hotel in Venice.',
      'Gjelina is a restaurant on Abbot Kinney.', // the bare name is NOT an alias
    ]
    for (const text of texts) {
      const oneByOne = aliases.some(alias => textContainsBrandAlias(text, alias))
      expect(textContainsAnyBrandAlias(text, aliases)).toBe(oneByOne)
    }
  })

  it('rejects without segmenting when no alias can possibly be present', () => {
    // The cheap reject is sound because adjacent words are separated in the
    // source by non-word characters only, so a match must appear in the
    // letters-and-digits-only view as a contiguous run.
    expect(textContainsAnyBrandAlias('completely unrelated prose', aliases)).toBe(false)
  })

  it('a compiled matcher gives the same answer as the one-shot helper', () => {
    const matcher = compileBrandAliases(aliases)
    for (const text of ['Demand IQ rocks', 'nothing', 'the Gjelina Hotel']) {
      expect(matcherMatchesText(matcher, text)).toBe(textContainsAnyBrandAlias(text, aliases))
    }
  })

  it('reuses one prepared answer across competitor matchers without changing matches', () => {
    const answer = 'Totême works with Demand-IQ; acmeology is unrelated.'
    const prepared = prepareBrandMatchText(answer)
    const matchers = [
      compileBrandAliases(['Toteme']),
      compileBrandAliases(['Demand IQ']),
      compileBrandAliases(['Acme']),
    ]

    expect(prepared).not.toBeNull()
    expect(matchers.map(matcher => matcherMatchesText(matcher, prepared)))
      .toEqual(matchers.map(matcher => matcherMatchesText(matcher, answer)))
    expect(matchers.map(matcher => matcherMatchesText(matcher, prepared))).toEqual([true, true, false])
  })

  it('reports every alias that matched, not just the first', () => {
    const matcher = compileBrandAliases(['Acme', 'Gjelina Hotel'])
    const hits = matchedAliasKeys(matcher, 'Acme partnered with the Gjelina Hotel.')
    expect([...hits].sort()).toEqual(['acme', 'gjelinahotel'])
  })

  it('pins the segmenter locale so a KPI does not depend on the host', () => {
    // `undefined` resolves to the machine's default locale, which would let the
    // same answer segment one way on a laptop and another in a container.
    expect(brandWords('Gjelina Hotel')).toEqual(['gjelina', 'hotel'])
    expect(brandWords('DEMAND-IQ')).toEqual(['demand', 'iq'])
  })
})

describe('accent folding', () => {
  // An accented brand used to be invisible to every mention metric: the alias
  // derived from its domain carries no accents, so `eterne` never matched
  // `Éterne`. Measured on a real run, one competitor scored 0 against 2 real
  // mentions and another was undercounted by one.
  it('matches an accented brand from its unaccented domain alias', () => {
    expect(textContainsBrandAlias('Éterne 90s Ribbed Tank', 'eterne')).toBe(true)
    expect(textContainsBrandAlias('Totême is minimal', 'toteme')).toBe(true)
    expect(textContainsBrandAlias('Loewe and Lóewe', 'loewe')).toBe(true)
  })

  it('matches in both directions, so an accented alias finds unaccented prose', () => {
    expect(textContainsBrandAlias('Eterne makes ribbed tanks', 'Éterne')).toBe(true)
    expect(textContainsBrandAlias('Toteme is minimal', 'Totême')).toBe(true)
  })

  it('folds accents into the brand key, so the two spellings share one identity', () => {
    expect(brandKeyFromText('Totême')).toBe(brandKeyFromText('Toteme'))
    expect(brandKeyFromText('Éterne')).toBe('eterne')
    // Presentation folding still composes with the punctuation/spacing rules.
    expect(brandKeyFromText('Café-Noir')).toBe(brandKeyFromText('Cafe Noir'))
  })

  it('still refuses substrings and spelling guesses', () => {
    // Folding widens what counts as the SAME spelling, never as a similar one.
    expect(textContainsBrandAlias('Eterneless brands', 'eterne')).toBe(false)
    expect(textContainsBrandAlias('acmeology', 'acme')).toBe(false)
    expect(textContainsBrandAlias('price', 'prime')).toBe(false)
  })

  it('never folds a mark that distinguishes one letter from another', () => {
    // The decisive cases. All three marks below sit in the SAME Unicode
    // category as the acute on `E`, and `Script=Inherited` contains the first
    // two, so any rule phrased over the MARK folds them. They are not accents:
    // が/か and ぱ/は are different kana, أ/ا are different Arabic letters.
    expect(brandKeyFromText('が')).not.toBe(brandKeyFromText('か'))
    expect(brandKeyFromText('ガ')).not.toBe(brandKeyFromText('カ'))
    expect(brandKeyFromText('ぱ')).not.toBe(brandKeyFromText('は'))
    expect(brandKeyFromText('ヴ')).not.toBe(brandKeyFromText('ウ'))
    expect(brandKeyFromText('أ')).not.toBe(brandKeyFromText('ا'))
    expect(brandKeyFromText('إ')).not.toBe(brandKeyFromText('ا'))
    expect(brandKeyFromText('آ')).not.toBe(brandKeyFromText('ا'))

    // And they do not match each other in prose either.
    expect(textContainsBrandAlias('がっちり', 'か')).toBe(false)
    expect(textContainsBrandAlias('أحمد', 'ا')).toBe(false)
  })

  it('keeps key LENGTH stable, so the alias floors still gate what they were written to gate', () => {
    // Decomposition explodes a Hangul syllable into jamo. Left decomposed, a
    // two-character Korean brand counts as six and walks past a floor meant to
    // reject it (MIN_BRAND_ALIAS_KEY_LENGTH is 3, MIN_DOMAIN_BRAND_KEY_LENGTH 4).
    expect(brandKeyFromText('삼성')).toHaveLength(2)
    expect(brandKeyFromText('한')).toHaveLength(1)
    // Latin accents fold without changing length either.
    expect(brandKeyFromText('Totême')).toHaveLength(6)
    expect(brandKeyFromText('Éterne')).toHaveLength(6)
  })

  it('confines the fold to accent-bearing scripts, leaving other scripts as they already were', () => {
    // `WORD_RUNS` keeps only \p{L}\p{N}, so marks of EVERY script were already
    // dropped when word tokens are built. Accent folding must not change that
    // either way, so this pins the pre-existing behaviour rather than claiming
    // the fold protects it. Whether dropping Devanagari matras is right is a
    // real question, and a separate one from accents.
    expect(brandKeyFromText('की')).toBe(brandKeyFromText('क'))
    // The accent blocks are what this change touches, and only those.
    expect(brandKeyFromText('Ω')).toBe('ω')
    expect(brandKeyFromText('Ώ')).toBe(brandKeyFromText('Ω'))
  })
})

import { describe, expect, it } from 'vitest'
import { cleanBusinessNameCandidate, extractBusinessNameCandidates, extractLaidOutBusinessNames } from '../src/index.js'

describe('extractBusinessNameCandidates', () => {
  it('reads list leads, bold names, headings and named links, in pattern then text order', () => {
    const text = [
      '### 1. Spoke Garage',
      '- **TuneSpoke** - mobile tune-ups on the east side.',
      '2. Rim Doctor: wheel truing.',
      'Many riders also like **Chain Gang Cycles** for parts, or [Bolt Bikes](https://boltbikes.example/shop).',
    ].join('\n')
    expect(extractBusinessNameCandidates(text)).toEqual([
      'TuneSpoke',
      'Rim Doctor',
      'Chain Gang Cycles',
      'Spoke Garage',
      'Bolt Bikes',
    ])
  })

  it('drops layout words and sentences, and keeps one entry per spelling', () => {
    const text = [
      '- **Overview**: what to look for.',
      '- **Key Features** - fast service.',
      '- **TuneSpoke** - tune-ups.',
      'Ask **TuneSpoke** about it.',
      '- **This Is A Long Sentence That Runs On** - not a name.',
    ].join('\n')
    expect(extractBusinessNameCandidates(text)).toEqual(['TuneSpoke'])
  })

  it('never reads a name that only appears inside a citation chip', () => {
    const text = 'Tune-ups are popular ([TuneSpoke](https://spoketuneworks.example/?utm_source=openai)).'
    expect(extractBusinessNameCandidates(text)).toEqual([])
  })

  it('returns nothing for empty input', () => {
    expect(extractBusinessNameCandidates(null)).toEqual([])
    expect(extractBusinessNameCandidates('')).toEqual([])
  })

  it('reads names that open with dotted initials or a number followed by a capitalized word', () => {
    const text = [
      '### 3. **1 Spoke Lane** - a shop on the river path.',
      '- A.J. Wheelworks - licensed and insured.',
      '- 7 ways to save: start early.',
    ].join('\n')
    expect(extractBusinessNameCandidates(text)).toEqual(['A.J. Wheelworks', '1 Spoke Lane'])
    // The stored recommended-competitor extractor keeps its own layouts.
    expect(extractLaidOutBusinessNames(text)).toEqual([])
  })
})

describe('names written with letters outside ASCII', () => {
  const text = [
    '- **TuneSpóke** - mobile tune-ups.',
    '- Éclair Vélo: city bikes.',
    '### 2. Ünal Çark',
    'Riders also like [Søren Spokes](https://sorenspokes.example/), **Joe’s Spokes** and **東京スポーク**.',
    '- **Café Tunequill Cycles** - coffee and repairs.',
  ].join('\n')

  it('reads accented, curly-apostrophe and caseless names as written, in every layout', () => {
    expect(extractBusinessNameCandidates(text)).toEqual([
      'TuneSpóke',
      'Éclair Vélo',
      'Café Tunequill Cycles',
      'Joe’s Spokes',
      '東京スポーク',
      'Ünal Çark',
      'Søren Spokes',
    ])
    // The stored-value layouts read the same letters, but never a curly apostrophe.
    expect(extractLaidOutBusinessNames(text)).toEqual([
      'TuneSpóke',
      'Éclair Vélo',
      'Café Tunequill Cycles',
      '東京スポーク',
      'Ünal Çark',
      'Søren Spokes',
    ])
  })

  it('reads a name with a decomposed accent (a combining mark) whole', () => {
    expect(extractBusinessNameCandidates('- **TuneSpóke** - tune-ups.')).toEqual(['TuneSpóke'])
  })

  it('reads a name whose first letter carries a decomposed accent, as written, in the list, bold and link layouts', () => {
    // A capital followed by a combining acute (U+0301), not the composed letter.
    const E = 'E\u0301'
    const O = 'O\u0301'
    const text = [
      `- ${E}zrolin Velo: city bikes.`,
      `Riders also like **${E}zrolin Spokes** for parts.`,
      `Book with [${O}skvel Bikes](https://oskvelbikes.example/).`,
    ].join('\n')
    expect(extractBusinessNameCandidates(text)).toEqual([`${E}zrolin Velo`, `${E}zrolin Spokes`, `${O}skvel Bikes`])
    expect(extractLaidOutBusinessNames(text)).toEqual([`${E}zrolin Velo`, `${E}zrolin Spokes`, `${O}skvel Bikes`])
    // Dotted initials open the same way.
    expect(extractBusinessNameCandidates(`- ${E}.J. Wheelworks - licensed.`)).toEqual([`${E}.J. Wheelworks`])
  })

  it('still opens a name only at a capital, a digit or a caseless letter', () => {
    expect(extractBusinessNameCandidates('- **éclair vélo** - lowercase is not a name.')).toEqual([])
  })
})

describe('extractLaidOutBusinessNames', () => {
  it('keeps a possessive and a trailing parenthetical, which identify the name for an identity match', () => {
    const text = [
      "- **Joe's Spokes**: tune-ups.",
      '- **Rim Shop (rimdoctor.example)** - wheel truing.',
    ].join('\n')
    expect(extractLaidOutBusinessNames(text)).toEqual(["Joe's Spokes", 'Rim Shop (rimdoctor.example)'])
    expect(extractBusinessNameCandidates(text)).toEqual(["Joe's Spokes", 'Rim Shop'])
  })
})

describe('names written with apostrophes', () => {
  it('reads a possessive written with a left single quote, and a name that opens with a capital, an apostrophe and a capital', () => {
    const text = [
      '- **Joe\u2018s Spokes** - tune-ups.',
      "- **O'Quillan's Bikes** - wheel truing.",
      "- **D'Avrel Cycles** - city bikes.",
      '- **O\u2019Quillan Wheels** - rentals.',
    ].join('\n')
    const names = ['Joe\u2018s Spokes', "O'Quillan's Bikes", "D'Avrel Cycles", 'O\u2019Quillan Wheels']
    expect(extractBusinessNameCandidates(text)).toEqual(names)
    // The stored-value layouts keep the straight apostrophe only.
    expect(extractLaidOutBusinessNames(text)).toEqual(["O'Quillan's Bikes", "D'Avrel Cycles"])
  })

  it('never reads a stored-value name through a curly apostrophe, so contractions and possessive phrases stay out', () => {
    const text = [
      '- **If you\u2019re shopping in Lakeview**: compare three quotes.',
      '- **Don\u2019t block Google/Bing crawlers** - keep pages indexable.',
      '- Allow Spokebot\u2019s crawler: in robots.txt.',
      '### Rimworks\u2019 strict wheel codes',
      'Ask about **Tunequill\u2019s city bike page** first, or [Gearloft\u2018s list](https://gearloft.example/list).',
    ].join('\n')
    expect(extractLaidOutBusinessNames(text)).toEqual([])
  })

  it('never opens a name at an apostrophe followed by a lowercase letter', () => {
    expect(extractBusinessNameCandidates("- **L'orange spokes** - lowercase after the apostrophe.")).toEqual([])
  })
})

describe('cleanBusinessNameCandidate', () => {
  it('drops a trailing parenthetical, emphasis and closing punctuation', () => {
    expect(cleanBusinessNameCandidate('Acme Bikes (Springfield, IL)')).toBe('Acme Bikes')
    expect(cleanBusinessNameCandidate('Acme Bikes (Springfield) (2024)')).toBe('Acme Bikes')
    expect(cleanBusinessNameCandidate('Acme Bikes (Springfield')).toBe('Acme Bikes')
    expect(cleanBusinessNameCandidate('**TuneSpoke** *')).toBe('TuneSpoke')
    expect(cleanBusinessNameCandidate('  "Rim  Doctor": ')).toBe('Rim Doctor')
  })

  it('keeps names whose punctuation is part of the name, a possessive included', () => {
    expect(cleanBusinessNameCandidate('Guns & Gears')).toBe('Guns & Gears')
    expect(cleanBusinessNameCandidate("Joe's Spokes")).toBe("Joe's Spokes")
    // Dropping it would offer `Ana` for `anas.example`, whose label already matches `Ana's`.
    expect(cleanBusinessNameCandidate("Ana's")).toBe("Ana's")
    expect(cleanBusinessNameCandidate('Ana\u2019s')).toBe('Ana\u2019s')
    expect(cleanBusinessNameCandidate('Spoke.Works Co.')).toBe('Spoke.Works Co')
  })
})

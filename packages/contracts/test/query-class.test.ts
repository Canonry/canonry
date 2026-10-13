import { describe, expect, it } from 'vitest'
import { classifyQueryClass, compileQueryClassifier, reportedQueryClasses } from '../src/query-class.js'
import { effectiveBrandNames } from '../src/project.js'
import { measurementQueryClassSchema, measurementQueryClassFilterSchema } from '../src/measurement-plan-v2.js'
import { queryClassSchema, queryClassFilterSchema } from '../src/query-class.js'

describe('compileQueryClassifier', () => {
  it('classifies a query that names the brand as branded, and one that does not as non-brand', () => {
    const classifier = compileQueryClassifier(['Acme Tanks', 'AcmeTanks'])!
    expect(classifier.classify('what is Acme Tanks known for')).toBe('branded')
    expect(classifier.classify('does Acme Tanks run small')).toBe('branded')
    expect(classifier.classify('what is the best premium white tank')).toBe('non-brand')
    expect(classifier.classify('what are alternatives to RivalOne')).toBe('non-brand')
  })

  it('partitions a 13-query basket 5 branded / 8 non-brand', () => {
    // The shape of a real basket, identities replaced. The 5/8 split is what
    // makes the pooled mention-share figure wrong, so it is pinned here.
    // Note the two-word display name and the concatenated alias must both
    // match, and a query naming only a COMPETITOR stays non-brand.
    const classifier = compileQueryClassifier(effectiveBrandNames({
      displayName: 'Acme Tanks',
      aliases: ['AcmeTanks'],
      canonicalDomain: 'acmetanks.example',
      ownedDomains: ['acmetanksstudio.example'],
    }))!
    const basket = [
      'Acme Tanks Studio Tank',
      'are Acme Tanks tanks see through',
      'are Acme Tanks tanks worth the money',
      'does Acme Tanks run small',
      'what is Acme Tanks known for',
      'what are alternatives to RivalOne',
      'what are cool independent contemporary womenswear brands',
      'what are the best elevated basics brands',
      'what is a good tank top for a fuller bust',
      'what is a supportive tank top I can wear without a bra',
      'what is the best high-quality women\'s tank top',
      'what is the best premium white tank',
      'what is the best sculpting tank top',
    ]
    const classes = basket.map(q => classifier.classify(q))
    expect(classes.filter(c => c === 'branded')).toHaveLength(5)
    expect(classes.filter(c => c === 'non-brand')).toHaveLength(8)
  })

  it('matches presentation variants but never substrings or spelling guesses', () => {
    const classifier = compileQueryClassifier(['Nimbus IQ'])!
    expect(classifier.classify('is Nimbus-IQ worth it')).toBe('branded')
    expect(classifier.classify('is NimbusIQ worth it')).toBe('branded')
    expect(classifier.classify('is nimbus iq worth it')).toBe('branded')
    // "nimbus" alone is not the brand.
    expect(classifier.classify('how do I forecast nimbus coverage')).toBe('non-brand')
  })

  it('does not match a brand inside a longer word', () => {
    const classifier = compileQueryClassifier(['Acme'])!
    expect(classifier.classify('what is acmeology')).toBe('non-brand')
    expect(classifier.classify('what is acme')).toBe('branded')
  })

  it('classifies an exact short domain without treating its bare label as branded', () => {
    const classifier = compileQueryClassifier(effectiveBrandNames({ canonicalDomain: 'www.ai.com' }))!
    expect(classifier.classify('is ai.com worth using')).toBe('branded')
    expect(classifier.classify('what are the best AI tools')).toBe('non-brand')
  })

  it('returns null when no usable alias exists — unclassifiable is not "non-brand"', () => {
    expect(compileQueryClassifier([])).toBeNull()
    expect(compileQueryClassifier(['', '   '])).toBeNull()
    expect(compileQueryClassifier(['!!!'])).toBeNull()
    expect(classifyQueryClass('anything at all', [])).toBeNull()
  })

  it('treats null / empty query text as non-brand rather than throwing', () => {
    const classifier = compileQueryClassifier(['Acme'])!
    expect(classifier.classify(null)).toBe('non-brand')
    expect(classifier.classify(undefined)).toBe('non-brand')
    expect(classifier.classify('')).toBe('non-brand')
  })

  it('is the same enum advanced measurement publishes, so the two cannot drift apart', () => {
    expect(measurementQueryClassSchema).toBe(queryClassSchema)
    expect(measurementQueryClassFilterSchema).toBe(queryClassFilterSchema)
    expect(queryClassSchema.options).toEqual(['branded', 'non-brand'])
    expect(queryClassFilterSchema.options).toEqual(['all', 'branded', 'non-brand'])
  })
})

describe('reportedQueryClasses', () => {
  const rows = [
    { query: 'already tracked', queryClass: 'non-brand' as const },
    { query: 'acme pricing', queryClass: 'branded' as const },
    { query: 'best widgets', queryClass: 'non-brand' as const },
    { query: 'no single class', queryClass: null },
    { query: 'from an older server' },
  ]

  it('reads each requested query back in request order, once, ignoring rows that were not requested', () => {
    expect(reportedQueryClasses(['best widgets', 'acme pricing', 'best widgets'], rows)).toEqual([
      { query: 'best widgets', queryClass: 'non-brand' },
      { query: 'acme pricing', queryClass: 'branded' },
    ])
  })

  it('keeps the server null, and leaves the class off where the server reported none', () => {
    // `toStrictEqual` tells an absent key from one set to undefined or null.
    expect(reportedQueryClasses(['no single class', 'from an older server', 'not in the response'], rows)).toStrictEqual([
      { query: 'no single class', queryClass: null },
      { query: 'from an older server' },
      { query: 'not in the response' },
    ])
  })

  it('matches the stored text exactly, so a differently cased request is not given another row\'s class', () => {
    expect(reportedQueryClasses(['Acme Pricing'], rows)).toStrictEqual([{ query: 'Acme Pricing' }])
  })
})

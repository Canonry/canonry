import { describe, expect, it } from 'vitest'
import {
  MEASUREMENT_TARGET_NAME_MIN_KEY_LENGTH,
  MeasurementTargetNameIssueCodes,
  measurementNameKey,
  measurementNameWords,
  measurementTargetNameIssueMessage,
  measurementTargetNameIssues,
  qualifiedNameIncludesName,
} from '../src/index.js'

describe('measurementNameWords', () => {
  it('splits a name into lowercase runs of letters and digits, folding compatibility forms', () => {
    expect(measurementNameWords('Harbor-House  No.2')).toEqual(['harbor', 'house', 'no', '2'])
    // NFKC folds the fullwidth digit, so a pasted name keys like a typed one.
    expect(measurementNameKey('Harbor House ２')).toBe(measurementNameKey('harbor house 2'))
    expect(measurementNameWords('  ')).toEqual([])
  })
})

describe('qualifiedNameIncludesName', () => {
  it('accepts a stored name as whole words plus at least one more word', () => {
    expect(qualifiedNameIncludesName('Elm Court Larkfield', ['Elm Court'])).toBe(true)
    expect(qualifiedNameIncludesName('The Elm Court on Main', ['Elm Court'])).toBe(true)
  })

  it('refuses the bare name, a partial word, and a phrase with no stored name in it', () => {
    expect(qualifiedNameIncludesName('Elm Court', ['Elm Court'])).toBe(false)
    expect(qualifiedNameIncludesName('Elmcourt Larkfield', ['Elm Court'])).toBe(false)
    expect(qualifiedNameIncludesName('Court Elm Larkfield', ['Elm Court'])).toBe(false)
    expect(qualifiedNameIncludesName('Elm Court Larkfield', [])).toBe(false)
  })
})

describe('measurementTargetNameIssues', () => {
  const brandNames = ['Northstar Living']

  it('flags a name under the floor, counted in letters and digits rather than characters', () => {
    expect(MEASUREMENT_TARGET_NAME_MIN_KEY_LENGTH).toBe(4)
    // "Q-Rt2" is five characters with a hyphen but four letters and digits: at
    // the floor, so fine. "Q-R1" has three and is under it.
    expect(measurementTargetNameIssues({ aliases: ['Q-Rt2', 'Q-R1'], brandNames: [] })).toEqual([
      { code: MeasurementTargetNameIssueCodes.short, field: 'aliases', index: 1, value: 'Q-R1' },
    ])
  })

  it('flags a name without the brand, and only when the project has a usable brand name', () => {
    const aliases = ['Northstar Living Elm Court', 'Elm Court']
    expect(measurementTargetNameIssues({ aliases, brandNames })).toEqual([
      { code: MeasurementTargetNameIssueCodes.withoutBrand, field: 'aliases', index: 1, value: 'Elm Court' },
    ])
    // With no brand to look for there is nothing to check against, so nothing is flagged.
    expect(measurementTargetNameIssues({ aliases, brandNames: [] })).toEqual([])
    expect(measurementTargetNameIssues({ aliases, brandNames: ['NS'] })).toEqual([])
  })

  it('reports one issue per name, the short one first', () => {
    expect(measurementTargetNameIssues({ aliases: ['Ec'], brandNames }).map(issue => issue.code))
      .toEqual([MeasurementTargetNameIssueCodes.short])
  })

  it('flags a qualified name that does not contain one of the names plus more words', () => {
    const issues = measurementTargetNameIssues({
      aliases: ['Northstar Elm Court'],
      identityAliases: ['Northstar Elm Court Larkfield', 'Larkfield Commons', 'Northstar Elm Court'],
      brandNames: ['Northstar'],
    })
    expect(issues).toEqual([
      { code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index: 1, value: 'Larkfield Commons' },
      { code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index: 2, value: 'Northstar Elm Court' },
    ])
  })

  it('skips blank entries instead of reporting them', () => {
    expect(measurementTargetNameIssues({ aliases: ['  '], identityAliases: [''], brandNames })).toEqual([])
  })
})

describe('measurementTargetNameIssueMessage', () => {
  it('names the entry and what to do, in one plain sentence per issue', () => {
    expect(measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.short, field: 'aliases', index: 0, value: ' Q-R ' }))
      .toBe('"Q-R" is too short to match safely. A name needs at least 4 letters or numbers, or it can match unrelated words in an answer.')
    expect(measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.withoutBrand, field: 'aliases', index: 0, value: 'Elm Court' }))
      .toBe('"Elm Court" does not include your brand name, so answers about other places with this name can count for this property.')
    expect(measurementTargetNameIssueMessage({ code: MeasurementTargetNameIssueCodes.qualifiedWithoutName, field: 'identityAliases', index: 0, value: 'Larkfield Commons' }))
      .toBe('"Larkfield Commons" must include one of this property\'s names plus more words, such as a street or city. Publishing is refused until it does.')
  })
})

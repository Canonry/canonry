import { describe, expect, it } from 'vitest'
import { alternativeNames, brandKeyFromText } from '../src/index.js'

describe('alternativeNames', () => {
  it('cleans each name, drops what is not shaped like a business name, and lists each brand once', () => {
    expect(alternativeNames([
      'Rival Commons (12 Main St)',
      'Rival Commons',
      'listings.example',
      'Top Picks in Uptown (Resident Reviews)',
      '3. Brook Lofts',
    ], new Set())).toEqual(['Rival Commons', 'Brook Lofts'])
  })

  it('never lists one of the project\'s own names', () => {
    expect(alternativeNames(['Harbor Point', 'Brook Lofts'], new Set([brandKeyFromText('Harbor Point')]))).toEqual(['Brook Lofts'])
  })

  it('returns nothing for nothing', () => {
    expect(alternativeNames([], new Set())).toEqual([])
  })
})

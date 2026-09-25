import { describe, expect, test } from 'vitest'
import { shareOfVoiceLabel, shareOfVoiceSummary } from '../src/share-of-voice.js'

describe('shareOfVoiceLabel', () => {
  // `percent` is 0..100 on the wire, so it is shown the one way every percent is.
  test('a measured share reads as a percent with one decimal', () => {
    expect(shareOfVoiceLabel(25)).toBe('25.0%')
    expect(shareOfVoiceLabel(33.3)).toBe('33.3%')
    expect(shareOfVoiceLabel(57.5, { basis: 'tracked', availability: 'measured' })).toBe('57.5% · tracked competitors')
  })

  test('only an exact 0 or 100 drops the decimal, and the edges never round onto them', () => {
    expect(shareOfVoiceLabel(0)).toBe('0%')
    expect(shareOfVoiceLabel(100)).toBe('100%')
    expect(shareOfVoiceLabel(0.04)).toBe('<0.1%')
    expect(shareOfVoiceLabel(99.96)).toBe('>99.9%')
  })

  test('an unmeasured or unavailable share never reads as a number', () => {
    expect(shareOfVoiceLabel(null)).toBe('Not measured')
    expect(shareOfVoiceLabel(40, { availability: 'not-measured' })).toBe('Not measured')
    expect(shareOfVoiceLabel(40, { availability: 'unavailable', basis: 'observed' })).toBe('Unavailable · observed competitors')
  })
})

describe('shareOfVoiceSummary', () => {
  test('names the query class and the market scope beside the figure', () => {
    expect(shareOfVoiceSummary(25, 'non-brand', { basis: 'observed', availability: 'measured' })).toBe('Share of voice · non-brand queries: 25.0% · observed competitors')
    expect(shareOfVoiceSummary(100, 'branded', { measurementScope: 'all-markets' })).toBe('Share of voice · branded queries: 100% · all markets')
    expect(shareOfVoiceSummary(null, 'branded', { availability: 'not-measured' })).toBe('Share of voice · branded queries: Not measured')
  })
})

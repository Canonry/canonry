import { describe, expect, test } from 'vitest'
import { shareOfVoiceLabel } from '../src/share-of-voice.js'

describe('shareOfVoiceLabel', () => {
  // `percent` is 0..100 on the wire, so it is shown the one way every percent is.
  test('a measured share reads as a percent with one decimal', () => {
    expect(shareOfVoiceLabel(25)).toBe('25.0%')
    expect(shareOfVoiceLabel(33.3)).toBe('33.3%')
    expect(shareOfVoiceLabel(57.5, { basis: 'tracked', availability: 'measured' })).toBe('57.5% · tracked competitors')
  })

  test('an unmeasured or unavailable share never reads as a number', () => {
    expect(shareOfVoiceLabel(null)).toBe('Not measured')
    expect(shareOfVoiceLabel(40, { availability: 'not-measured' })).toBe('Not measured')
    expect(shareOfVoiceLabel(40, { availability: 'unavailable', basis: 'observed' })).toBe('Unavailable · observed competitors')
  })
})

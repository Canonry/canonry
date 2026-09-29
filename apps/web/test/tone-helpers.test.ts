import { describe, expect, it } from 'vitest'
import { mentionShareTone } from '../src/lib/tone-helpers.js'

describe('mentionShareTone', () => {
  it('uses the server bands: 50 and up positive, 25 and up caution, below that negative', () => {
    expect(mentionShareTone(100)).toBe('positive')
    expect(mentionShareTone(50)).toBe('positive')
    expect(mentionShareTone(49.9)).toBe('caution')
    // ainyc's non-brand 33.3% and 31.7% read amber, as the approved cards draw them.
    expect(mentionShareTone(33.3)).toBe('caution')
    expect(mentionShareTone(25)).toBe('caution')
    expect(mentionShareTone(24.9)).toBe('negative')
    expect(mentionShareTone(0)).toBe('negative')
  })
})

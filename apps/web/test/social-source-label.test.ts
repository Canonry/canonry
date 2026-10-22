import { describe, expect, test } from 'vitest'
import { decodeSocialSourceLabel } from '../src/lib/social-source-label.js'

describe('decodeSocialSourceLabel', () => {
  test('replaces + with space (UTM-encoded campaigns)', () => {
    expect(decodeSocialSourceLabel('HVAC+Facebook+Groups+Q1+2026')).toBe('HVAC Facebook Groups Q1 2026')
  })

  test('leaves non-+ characters intact', () => {
    expect(decodeSocialSourceLabel('m.facebook.com')).toBe('m.facebook.com')
    expect(decodeSocialSourceLabel('news|category')).toBe('news|category')
  })
})

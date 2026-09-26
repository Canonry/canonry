import { describe, expect, it } from 'vitest'

/**
 * A GBP keyword drop notified daily at 08:30 for over a month with byte-identical
 * text, because Google publishes GBP keyword data about a month behind so the
 * comparison window sat at 2026-06 -> 2026-07 while the calendar moved on.
 * Health is edge-triggered and citations are transition-based; insight dispatch
 * had no memory at all.
 *
 * These pin the identity rules the gate depends on. The gate itself is exercised
 * through the notifier's own suite.
 */
const fingerprint = (title: string) => title.replace(/\b\d+(?:\.\d+)?%/g, 'N%')
const magnitude = (title: string) => {
  const m = /\b(\d+(?:\.\d+)?)%/.exec(title)
  return m?.[1] === undefined ? null : Math.round(Number(m[1]))
}

const TITLE = 'A Hotel: "santa monica hotels" impressions down 79% month-over-month (2026-06→2026-07)'

describe('insight identity', () => {
  it('treats the same finding on the same window as one piece of news', () => {
    expect(fingerprint(TITLE)).toBe(fingerprint(TITLE.replace('79%', '80%')))
  })

  it('treats an ADVANCED window as new news', () => {
    const next = TITLE.replace('2026-06→2026-07', '2026-07→2026-08')
    expect(fingerprint(TITLE)).not.toBe(fingerprint(next))
  })

  it('does not collapse the dates in the window, only the percentage', () => {
    // Neutralising every number would make an advanced window look identical,
    // which is the exact bug this exists to stop.
    expect(fingerprint(TITLE)).toContain('2026-06')
    expect(fingerprint(TITLE)).toContain('2026-07')
    expect(fingerprint(TITLE)).toContain('N%')
  })

  it('reads the magnitude so a material deepening can re-notify', () => {
    expect(magnitude(TITLE)).toBe(79)
    expect(magnitude('no percentage here')).toBeNull()
  })

  it('distinguishes two different keywords on the same type', () => {
    const other = TITLE.replace('santa monica hotels', 'bayport hotels')
    expect(fingerprint(TITLE)).not.toBe(fingerprint(other))
  })
})

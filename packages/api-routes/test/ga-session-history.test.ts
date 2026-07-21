import { test, expect, describe } from 'vitest'
import { buildSessionHistory } from '../src/ga-session-history.js'

/**
 * The bug this guards: `users` is not additive across landing pages. A real
 * project's 2026-07-20 had 55 landing-page rows summing to 192 users while GA
 * reported 158 — a 22% overcount that made canonry look wrong next to the GA UI.
 */
describe('buildSessionHistory', () => {
  test('prefers the deduplicated daily total over the landing-page sum', () => {
    const result = buildSessionHistory(
      [{ date: '2026-07-20', sessions: 197, organicSessions: 120, users: 192 }],
      [{ date: '2026-07-20', users: 158 }],
    )

    expect(result).toEqual([{
      date: '2026-07-20',
      sessions: 197,
      organicSessions: 120,
      users: 158,
      usersSource: 'deduplicated',
    }])
  })

  test('falls back to the landing-page sum when the day has no total row', () => {
    const result = buildSessionHistory(
      [{ date: '2026-05-01', sessions: 40, organicSessions: 25, users: 61 }],
      [],
    )

    expect(result[0]!.users).toBe(61)
    expect(result[0]!.usersSource).toBe('landing-page-sum')
  })

  test('labels each day independently across a partially-backfilled series', () => {
    const result = buildSessionHistory(
      [
        { date: '2026-05-01', sessions: 40, organicSessions: 25, users: 61 },
        { date: '2026-07-20', sessions: 197, organicSessions: 120, users: 192 },
      ],
      [{ date: '2026-07-20', users: 158 }],
    )

    expect(result.map((r) => r.usersSource)).toEqual(['landing-page-sum', 'deduplicated'])
    expect(result.map((r) => r.users)).toEqual([61, 158])
  })

  test('never invents a day the landing-page series does not have', () => {
    // A total row outside the requested window must not add a point to the
    // series — the landing-page rows define which days exist.
    const result = buildSessionHistory(
      [{ date: '2026-07-20', sessions: 197, organicSessions: 120, users: 192 }],
      [{ date: '2026-07-20', users: 158 }, { date: '2026-07-19', users: 140 }],
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.date).toBe('2026-07-20')
  })

  test('keeps sessions and organicSessions from the landing-page rows', () => {
    // Sessions ARE additive (GA4 attributes one landing page per session), so
    // the dedup fix must not touch them.
    const result = buildSessionHistory(
      [{ date: '2026-07-20', sessions: 197, organicSessions: 120, users: 192 }],
      [{ date: '2026-07-20', users: 158 }],
    )

    expect(result[0]!.sessions).toBe(197)
    expect(result[0]!.organicSessions).toBe(120)
  })

  test('honors a zero deduplicated total instead of falling back', () => {
    // 0 is a real measurement; `?? fallback` on a nullish check must not treat
    // it as missing.
    const result = buildSessionHistory(
      [{ date: '2026-07-20', sessions: 0, organicSessions: 0, users: 3 }],
      [{ date: '2026-07-20', users: 0 }],
    )

    expect(result[0]!.users).toBe(0)
    expect(result[0]!.usersSource).toBe('deduplicated')
  })

  test('returns an empty series when the project has no traffic rows', () => {
    expect(buildSessionHistory([], [{ date: '2026-07-20', users: 158 }])).toEqual([])
  })
})

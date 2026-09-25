import { describe, expect, it } from 'vitest'
import { GaMoverChangeBases, MIN_PCT_BASE, gaSourceMoverSchema } from '@ainyc/canonry-contracts'
import { buildSourceMover, findBiggestMover, moverChangeBasis } from '../src/ga-source-mover.js'

describe('buildSourceMover', () => {
  it('calls growth from zero new, with no percentage', () => {
    const mover = buildSourceMover('perplexity.ai', 4, 0)
    expect(mover).toEqual({
      source: 'perplexity.ai',
      sessions7d: 4,
      sessionsPrev7d: 0,
      changeSessions: 4,
      changePct: null,
      changeBasis: GaMoverChangeBases.new,
    })
    // The old fallback read every new source as +100% whatever it sent.
    expect(mover.changePct).not.toBe(100)
  })

  it('reads a source that stopped sending sessions as -100%', () => {
    expect(buildSourceMover('reddit.com', 0, 40)).toEqual({
      source: 'reddit.com',
      sessions7d: 0,
      sessionsPrev7d: 40,
      changeSessions: -40,
      changePct: -100,
      changeBasis: GaMoverChangeBases.percent,
    })
    // Still -100% on a small base; the basis says to state the session change instead.
    expect(buildSourceMover('reddit.com', 0, 3)).toMatchObject({ changeSessions: -3, changePct: -100, changeBasis: GaMoverChangeBases['small-base'] })
  })

  it('keeps the rounded percent on a small base and flags it by MIN_PCT_BASE', () => {
    // (30 - 12) / 12 = +150%, but off a base of 12.
    expect(buildSourceMover('chatgpt.com', 30, 12)).toEqual({
      source: 'chatgpt.com',
      sessions7d: 30,
      sessionsPrev7d: 12,
      changeSessions: 18,
      changePct: 150,
      changeBasis: GaMoverChangeBases['small-base'],
    })
    // (5 - 3) / 3 = 66.67%, rounded half up to 67.
    expect(buildSourceMover('chatgpt.com', 5, 3)).toMatchObject({ changeSessions: 2, changePct: 67 })
  })

  it('states a percent from MIN_PCT_BASE up, and the session change just below it', () => {
    expect(MIN_PCT_BASE).toBe(30)
    expect(buildSourceMover('a.com', 45, MIN_PCT_BASE)).toMatchObject({ changeSessions: 15, changePct: 50, changeBasis: GaMoverChangeBases.percent })
    expect(buildSourceMover('a.com', 44, MIN_PCT_BASE - 1)).toMatchObject({ changeSessions: 15, changePct: 52, changeBasis: GaMoverChangeBases['small-base'] })
    expect(moverChangeBasis(0)).toBe(GaMoverChangeBases.new)
    expect(moverChangeBasis(1)).toBe(GaMoverChangeBases['small-base'])
    expect(moverChangeBasis(MIN_PCT_BASE - 1)).toBe(GaMoverChangeBases['small-base'])
    expect(moverChangeBasis(MIN_PCT_BASE)).toBe(GaMoverChangeBases.percent)
  })

  it('produces a mover the published contract accepts', () => {
    for (const [current, prior] of [[4, 0], [0, 40], [30, 12], [90, 60]] as const) {
      expect(gaSourceMoverSchema.parse(buildSourceMover('s', current, prior))).toEqual(buildSourceMover('s', current, prior))
    }
  })
})

describe('findBiggestMover', () => {
  it('picks the largest change in size, up or down', () => {
    const mover = findBiggestMover(
      [{ source: 'chatgpt.com', sessions: 60 }, { source: 'perplexity.ai', sessions: 10 }],
      [{ source: 'chatgpt.com', sessions: 50 }, { source: 'perplexity.ai', sessions: 35 }],
    )
    // chatgpt.com moved +10, perplexity.ai -25.
    expect(mover).toEqual({
      source: 'perplexity.ai',
      sessions7d: 10,
      sessionsPrev7d: 35,
      changeSessions: -25,
      changePct: -71,
      changeBasis: GaMoverChangeBases.percent,
    })
  })

  it('sees a source that sent sessions only in the prior period', () => {
    const mover = findBiggestMover(
      [{ source: 'chatgpt.com', sessions: 12 }],
      [{ source: 'chatgpt.com', sessions: 10 }, { source: 'gemini.google.com', sessions: 40 }],
    )
    expect(mover).toMatchObject({ source: 'gemini.google.com', sessions7d: 0, sessionsPrev7d: 40, changeSessions: -40, changePct: -100 })
  })

  it('calls a source that sent sessions only in the current period new', () => {
    const mover = findBiggestMover([{ source: 'claude.ai', sessions: 9 }, { source: 'chatgpt.com', sessions: 20 }], [{ source: 'chatgpt.com', sessions: 18 }])
    expect(mover).toMatchObject({ source: 'claude.ai', sessions7d: 9, sessionsPrev7d: 0, changeSessions: 9, changePct: null, changeBasis: GaMoverChangeBases.new })
  })

  it('breaks a tie by source name, not by row order', () => {
    const current = [{ source: 'b.com', sessions: 5 }, { source: 'a.com', sessions: 5 }]
    expect(findBiggestMover(current, [])?.source).toBe('a.com')
    expect(findBiggestMover([...current].reverse(), [])?.source).toBe('a.com')
  })

  it('returns null when nothing moved or there is no traffic', () => {
    expect(findBiggestMover([{ source: 'a.com', sessions: 7 }], [{ source: 'a.com', sessions: 7 }])).toBeNull()
    expect(findBiggestMover([], [])).toBeNull()
    expect(findBiggestMover([{ source: 'a.com', sessions: null }], [])).toBeNull()
  })
})

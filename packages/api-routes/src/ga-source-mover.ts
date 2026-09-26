import { GaMoverChangeBases, MIN_PCT_BASE, deltaPercent } from '@ainyc/canonry-contracts'
import type { GaMoverChangeBasis, GaSourceMover } from '@ainyc/canonry-contracts'

/**
 * The biggest-mover calculation behind `/ga/social-referral-trend` and
 * `/ga/attribution-trend`. Pure: no DB, no clock.
 */

/** One source's sessions over one 7-day period, as the trend queries return it. */
export interface SourceSessions {
  source: string
  sessions: number | null
}

/**
 * How a change from `prior` sessions may be stated. A change from zero has no
 * percentage at all, and one from a base below `MIN_PCT_BASE` has a percentage
 * too noisy to lead with, which is the rule the report's count tiles follow.
 */
export function moverChangeBasis(prior: number): GaMoverChangeBasis {
  if (prior <= 0) return GaMoverChangeBases.new
  return prior < MIN_PCT_BASE ? GaMoverChangeBases['small-base'] : GaMoverChangeBases.percent
}

/**
 * One source's movement between the prior 7 days and the last 7. Only called
 * for a source that moved: with no change at all there is no mover to state.
 */
export function buildSourceMover(source: string, sessions7d: number, sessionsPrev7d: number): GaSourceMover {
  return {
    source,
    sessions7d,
    sessionsPrev7d,
    changeSessions: sessions7d - sessionsPrev7d,
    // Null from a zero prior. It used to fall back to 100, so every source that
    // appeared this week read as "+100%" whatever it sent.
    changePct: deltaPercent(sessions7d, sessionsPrev7d),
    changeBasis: moverChangeBasis(sessionsPrev7d),
  }
}

/**
 * The source whose sessions moved the most, in either direction, from the
 * prior period to the current one.
 *
 * Every source seen in EITHER period is a candidate: a source that stopped
 * sending sessions moved by its whole prior count (-100%), and a read of the
 * current period alone never sees it. Ties go to the source that sorts first,
 * so the answer does not depend on row order. Null when no source moved.
 */
export function findBiggestMover(
  current: readonly SourceSessions[],
  prior: readonly SourceSessions[],
): GaSourceMover | null {
  const bySource = new Map<string, { current: number; prior: number }>()
  const entry = (source: string) => {
    let sessions = bySource.get(source)
    if (!sessions) {
      sessions = { current: 0, prior: 0 }
      bySource.set(source, sessions)
    }
    return sessions
  }
  for (const row of current) entry(row.source).current += row.sessions ?? 0
  for (const row of prior) entry(row.source).prior += row.sessions ?? 0

  let mover: GaSourceMover | null = null
  const sources = [...bySource.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const source of sources) {
    const sessions = bySource.get(source)!
    const size = Math.abs(sessions.current - sessions.prior)
    if (size > 0 && (mover === null || size > Math.abs(mover.changeSessions))) {
      mover = buildSourceMover(source, sessions.current, sessions.prior)
    }
  }
  return mover
}

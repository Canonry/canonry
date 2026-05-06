import type { Regression, Snapshot, CauseAnalysis } from './types.js'

export function analyzeCause(regression: Regression, currentSnapshots: Snapshot[]): CauseAnalysis {
  // A regression means our domain was cited previously but is NOT cited now.
  // Look for the current snapshot where we lost citation and check if a
  // competitor domain appeared in that same query+provider response.
  const currentSnap = currentSnapshots.find(
    s =>
      s.query === regression.query &&
      s.provider === regression.provider &&
      !s.cited &&
      s.competitorDomains && s.competitorDomains.length > 0
  )

  if (currentSnap) {
    const competitor = currentSnap.competitorDomains![0]!
    return {
      cause: 'competitor_gain',
      competitorDomain: competitor,
      details: `Competitor ${competitor} now cited for "${regression.query}" on ${regression.provider}`,
    }
  }

  return {
    cause: 'unknown',
    details: `No specific cause identified for loss of "${regression.query}" on ${regression.provider}`,
  }
}

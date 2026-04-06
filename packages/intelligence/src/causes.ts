import type { Regression, Snapshot, CauseAnalysis } from './types.js'

export function analyzeCause(regression: Regression, currentSnapshots: Snapshot[]): CauseAnalysis {
  // A regression means our domain was cited previously but is NOT cited now.
  // Look for the current snapshot where we lost citation and check if a
  // competitor domain appeared in that same keyword+provider response.
  const currentSnap = currentSnapshots.find(
    s =>
      s.keyword === regression.keyword &&
      s.provider === regression.provider &&
      !s.cited &&
      s.competitorDomain
  )

  if (currentSnap) {
    return {
      cause: 'competitor_gain',
      competitorDomain: currentSnap.competitorDomain,
      details: `Competitor ${currentSnap.competitorDomain} now cited for "${regression.keyword}" on ${regression.provider}`,
    }
  }

  return {
    cause: 'unknown',
    details: `No specific cause identified for loss of "${regression.keyword}" on ${regression.provider}`,
  }
}

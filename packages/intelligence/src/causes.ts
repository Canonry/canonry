import type { Regression, Snapshot, CauseAnalysis } from './types.js'

export function analyzeCause(regression: Regression, currentSnapshots: Snapshot[]): CauseAnalysis {
  // Check for competitor gain: did a competitor domain appear for this keyword+provider?
  const competitorSnap = currentSnapshots.find(
    s =>
      s.keyword === regression.keyword &&
      s.provider === regression.provider &&
      s.cited &&
      s.competitorDomain
  )

  if (competitorSnap) {
    return {
      cause: 'competitor_gain',
      competitorDomain: competitorSnap.competitorDomain,
      details: `Competitor ${competitorSnap.competitorDomain} now cited for "${regression.keyword}" on ${regression.provider}`,
    }
  }

  return {
    cause: 'unknown',
    details: `No specific cause identified for loss of "${regression.keyword}" on ${regression.provider}`,
  }
}

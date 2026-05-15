import type { Regression, Snapshot, CauseAnalysis } from './types.js'

export function analyzeCause(regression: Regression, currentSnapshots: Snapshot[]): CauseAnalysis {
  // A regression means our domain was cited previously but is NOT cited now.
  // Find the matching post-regression snapshot — the one where we lost the
  // citation. That's where displacing sources live.
  const matchingSnap = currentSnapshots.find(
    s => s.query === regression.query && s.provider === regression.provider && !s.cited,
  )

  // Tracked competitor displacement — strongest signal (the operator
  // already cares about this domain).
  if (matchingSnap?.competitorDomains?.length) {
    const competitor = matchingSnap.competitorDomains[0]!
    return {
      cause: 'competitor_gain',
      competitorDomain: competitor,
      details: `Competitor ${competitor} now cited for "${regression.query}" on ${regression.provider}`,
    }
  }

  // Third-party displacement — no tracked competitor in the response, but
  // the engine is grounding on somebody else (publisher, gov site, an
  // unrelated brand). Naming them is far more actionable than the old
  // "audit yourself, position unknown" recommendation that fired here.
  if (matchingSnap?.citedDomains?.length) {
    const top = matchingSnap.citedDomains.slice(0, 3)
    return {
      cause: 'third_party_displacement',
      details: `${regression.provider} now grounds on ${top.join(', ')} for "${regression.query}" — none are tracked competitors.`,
    }
  }

  return {
    cause: 'unknown',
    details: `No specific cause identified for loss of "${regression.query}" on ${regression.provider}`,
  }
}

import type { Regression, Snapshot, CauseAnalysis } from './types.js'

export function analyzeCause(regression: Regression, currentSnapshots: Snapshot[]): CauseAnalysis {
  // A regression means our domain was cited previously but is NOT cited now.
  // Look across ALL matching post-regression snapshots — multi-location
  // projects produce one snapshot per (query, provider, location), and the
  // intelligence-service select doesn't pin an order, so a `.find()` that
  // stops at the first match can pick a third-party-only snapshot and
  // miss a sibling snapshot that has the tracked competitor. Scan the
  // full set and prefer the strongest signal explicitly.
  const matchingSnaps = currentSnapshots.filter(
    s => s.query === regression.query && s.provider === regression.provider && !s.cited,
  )

  // Tracked competitor displacement — strongest signal (the operator
  // already cares about this domain). Wins over third-party even if a
  // third-party-only snapshot happens to come first in the array.
  const withCompetitor = matchingSnaps.find(s => s.competitorDomains?.length)
  if (withCompetitor) {
    const competitor = withCompetitor.competitorDomains![0]!
    return {
      cause: 'competitor_gain',
      competitorDomain: competitor,
      details: `Competitor ${competitor} now cited for "${regression.query}" on ${regression.provider}`,
    }
  }

  // Third-party displacement — no tracked competitor in any matching
  // snapshot, but the engine is grounding on somebody else (publisher,
  // gov site, an unrelated brand). Naming them is far more actionable
  // than the old "audit yourself, position unknown" recommendation that
  // fired here.
  const withCited = matchingSnaps.find(s => s.citedDomains?.length)
  if (withCited) {
    const top = withCited.citedDomains!.slice(0, 3)
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

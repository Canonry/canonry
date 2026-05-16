import type { MetricTone, ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { citedDomainBelongsToProject } from './domain-matching.js'

export interface ShareOfVoiceSnapshot {
  /** Cited-source domains for one (query × provider × model) snapshot.
   *  Already deduplicated by the provider extractors — each domain appears
   *  at most once per snapshot. */
  citedDomains: readonly string[]
}

export interface ShareOfVoiceOptions {
  /** Canonical + owned domains for the project. Matched with subdomain awareness
   *  (cited `docs.example.com` matches project `example.com`). */
  projectDomains: readonly string[]
  /** Configured tracked-competitor domains. Matched with subdomain awareness too
   *  — cited `offers.roofle.com` classifies as the competitor when `roofle.com`
   *  is configured. Pass the raw list from the competitors table, not the
   *  pre-computed per-snapshot `competitorOverlap` (which loses the cited
   *  subdomain string). */
  competitorDomains: readonly string[]
}

/**
 * SoV tone bands — different from `scoreTone` because the achievable range is
 * different. Citation Coverage of 70% is reachable; SoV of 70% means you own
 * 7 of every 10 citation slots and is essentially monopoly. Tuned for the
 * competitive-share interpretation:
 *
 *   - ≥30% : positive (dominant — you regularly win citation real-estate)
 *   - 10-29%: caution (meaningful voice but not dominant)
 *   - <10% : negative (minor source; competitors / other sources own the answer)
 */
function sovTone(score: number): MetricTone {
  if (score >= 30) return 'positive'
  if (score >= 10) return 'caution'
  return 'negative'
}

export interface ShareOfVoiceBreakdown {
  projectSlots: number
  competitorSlots: number
  otherSlots: number
  totalSlots: number
}

/**
 * Computes Share of Voice (SoV) — the % of cited-source slots across the
 * latest run that are the project's own domains, vs configured competitors,
 * vs unrelated sources.
 *
 * Distinct from Citation Coverage:
 *   - Citation Coverage = % of (query × provider) snapshots where the project
 *     was cited at least once. Binary per-snapshot.
 *   - Share of Voice    = % of every distinct cited-domain slot that was the
 *     project. A snapshot citing 10 distinct sources contributes 10 slots; if
 *     you're 1 of them you score 10% on that snapshot.
 *
 * Cited alone every snapshot ⇒ SoV approaches 100%. Cited alongside 9 other
 * sources every time ⇒ SoV ≈ 10% even at 100% citation coverage. That's the
 * competitive-position signal the analyst loses if they only watch coverage.
 *
 * Notes on semantics:
 * - "Slot" = one distinct domain in one snapshot's cited list. Provider
 *   extractors dedupe via `Set`, so the same domain cited 5 times in one
 *   answer is one slot, not five.
 * - Both project and competitor classification are subdomain-aware. A cited
 *   `offers.roofle.com` counts as competitor when `roofle.com` is configured.
 * - Heavy-citing providers (e.g. Perplexity, which cites ~10 sources per
 *   query) contribute proportionally more slots to the denominator. The
 *   aggregate score reflects "citation real-estate captured" — which the
 *   provider mix affects by design.
 *
 * `breakdown` is exposed on the returned DTO via `description` (prose) for
 * the CLI / tooltip and as the standalone `ShareOfVoiceBreakdown` shape via
 * `computeShareOfVoiceBreakdown` for UI surfaces that want the raw numbers.
 */
export function buildShareOfVoice(
  snapshots: readonly ShareOfVoiceSnapshot[],
  options: ShareOfVoiceOptions,
): ScoreSummaryDto {
  const tooltip = 'Your domain\'s share of every distinct cited-source slot across the latest run. Subdomain-aware (cited docs.you.com counts for you.com). Distinct from Citation Coverage — SoV measures how much of the answer real-estate you own, not just whether you appear.'

  if (snapshots.length === 0) {
    return {
      label: 'Share of Voice',
      value: 'No data',
      delta: 'Run a sweep first',
      tone: 'neutral',
      description: 'No SoV data yet. Trigger a run to start tracking.',
      tooltip,
      trend: [],
    }
  }

  const breakdown = computeShareOfVoiceBreakdown(snapshots, options)

  if (breakdown.totalSlots === 0) {
    return {
      label: 'Share of Voice',
      value: '0',
      delta: 'No citations in this run',
      tone: 'neutral',
      description: 'The latest run produced no source-list citations across any provider, so SoV cannot be measured. (Mention Coverage may still be non-zero — answers can mention you without grounding to a URL.)',
      tooltip,
      trend: [],
      progress: 0,
    }
  }

  const { projectSlots, competitorSlots, otherSlots, totalSlots } = breakdown
  const score = Math.round((projectSlots / totalSlots) * 100)
  const competitorShare = Math.round((competitorSlots / totalSlots) * 100)
  const otherShare = Math.max(0, 100 - score - competitorShare)

  const hasCompetitorsConfigured = options.competitorDomains.length > 0
  const description = describeBreakdown({
    projectSlots,
    competitorSlots,
    otherSlots,
    totalSlots,
    score,
    competitorShare,
    otherShare,
    hasCompetitorsConfigured,
  })

  return {
    label: 'Share of Voice',
    value: `${score}`,
    delta: `${projectSlots} of ${totalSlots} cited slots`,
    tone: sovTone(score),
    description,
    tooltip,
    trend: [],
    progress: score,
  }
}

/**
 * Standalone breakdown computation — exposed so UI surfaces can render a
 * stacked bar (project / competitor / other) without re-parsing the prose
 * description from `buildShareOfVoice`.
 */
export function computeShareOfVoiceBreakdown(
  snapshots: readonly ShareOfVoiceSnapshot[],
  options: ShareOfVoiceOptions,
): ShareOfVoiceBreakdown {
  let totalSlots = 0
  let projectSlots = 0
  let competitorSlots = 0

  for (const snap of snapshots) {
    for (const domain of snap.citedDomains) {
      totalSlots++
      if (citedDomainBelongsToProject(domain, options.projectDomains)) {
        projectSlots++
      } else if (citedDomainBelongsToProject(domain, options.competitorDomains)) {
        // Reuse the same subdomain-aware matcher — semantically identical
        // ("is this cited domain owned by one of these registered domains?").
        competitorSlots++
      }
    }
  }

  const otherSlots = totalSlots - projectSlots - competitorSlots
  return { projectSlots, competitorSlots, otherSlots, totalSlots }
}

function describeBreakdown(parts: {
  projectSlots: number
  competitorSlots: number
  otherSlots: number
  totalSlots: number
  score: number
  competitorShare: number
  otherShare: number
  hasCompetitorsConfigured: boolean
}): string {
  const { projectSlots, competitorSlots, totalSlots, score, competitorShare, otherShare, hasCompetitorsConfigured } = parts
  if (!hasCompetitorsConfigured) {
    return `${projectSlots} of ${totalSlots} cited slots were yours (${score}%). Add tracked competitors to break out the rest.`
  }
  if (competitorSlots === 0) {
    return `${projectSlots} of ${totalSlots} cited slots were yours (${score}%); no tracked competitors surfaced in the run. The remaining ${otherShare}% goes to unrelated sources.`
  }
  return `You own ${score}% of cited slots; tracked competitors hold ${competitorShare}%; the remaining ${otherShare}% goes to non-competitive sources.`
}

import type { ScoreSummaryDto } from '@ainyc/canonry-contracts'
import { citedDomainBelongsToProject } from './domain-matching.js'
import { scoreTone } from './score-tones.js'

export interface ShareOfVoiceSnapshot {
  citedDomains: readonly string[]
  competitorOverlap: readonly string[]
}

export interface ShareOfVoiceOptions {
  /** Canonical + owned domains for the project. Matched with subdomain awareness. */
  projectDomains: readonly string[]
}

/**
 * Computes Share of Voice (SoV) — the % of cited-domain slots across every
 * snapshot that are occupied by the project's own domains, as opposed to
 * competitors or unrelated sources.
 *
 * Distinct from Citation Coverage:
 *   - Citation Coverage = % of (query × provider) snapshots where the project
 *     was cited at least once.
 *   - Share of Voice    = % of every individual cited-domain slot that was
 *     the project (so a snapshot citing 10 sources contributes 10 slots, not 1).
 *
 * Cited alone in every snapshot ⇒ SoV approaches 100%. Cited alongside 9
 * other sources every time ⇒ SoV ≈ 10% even with 100% citation coverage.
 * That's the competitive-position signal the analyst loses if they only
 * look at coverage.
 *
 * The returned `description` carries the split: project / competitor /
 * other slot counts so the UI can render a stacked bar if it wants depth.
 */
export function buildShareOfVoice(
  snapshots: readonly ShareOfVoiceSnapshot[],
  options: ShareOfVoiceOptions,
): ScoreSummaryDto {
  const tooltip = 'Your domain\'s share of all cited-source slots across the latest run. 100% means every citation went to you; 10% means you got one slot out of ten on average.'

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

  let totalSlots = 0
  let projectSlots = 0
  let competitorSlots = 0

  for (const snap of snapshots) {
    for (const domain of snap.citedDomains) {
      totalSlots++
      if (citedDomainBelongsToProject(domain, options.projectDomains)) {
        projectSlots++
      } else if (snap.competitorOverlap.some(c => c.toLowerCase() === domain.toLowerCase())) {
        competitorSlots++
      }
    }
  }

  if (totalSlots === 0) {
    return {
      label: 'Share of Voice',
      value: '0',
      delta: 'No citations in this run',
      tone: 'neutral',
      description: 'The latest run produced no citations across any provider, so SoV cannot be measured.',
      tooltip,
      trend: [],
      progress: 0,
    }
  }

  const score = Math.round((projectSlots / totalSlots) * 100)
  const otherSlots = totalSlots - projectSlots - competitorSlots
  const competitorShare = Math.round((competitorSlots / totalSlots) * 100)

  return {
    label: 'Share of Voice',
    value: `${score}`,
    delta: `${projectSlots} of ${totalSlots} cited slots`,
    tone: scoreTone(score),
    description: competitorSlots > 0
      ? `Competitors hold ${competitorShare}% of cited slots; the remaining ${Math.max(0, 100 - score - competitorShare)}% goes to non-competitive sources.`
      : `Of ${totalSlots} citations across the run, ${projectSlots} were yours and ${otherSlots} were unrelated sources.`,
    tooltip,
    trend: [],
    progress: score,
  }
}

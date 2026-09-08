import {
  brandKeyFromText,
  brandLabelFromDomain,
  compileQueryClassifier,
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  hostOf,
  surfaceClassFromCompetitorType,
  MIN_DOMAIN_BRAND_KEY_LENGTH,
  type QueryClass,
  type VisibilityStatsShareOfVoice,
  type CompetitorLandscapeResponse,
} from '@ainyc/canonry-contracts'
import { storedDirectCompetitorDomains, usableBrandAliases, type MentionShareCompetitor, type MentionShareSnapshot, type CompetitorLandscapeSurfaceClass } from '@ainyc/canonry-intelligence'
import { domainClassifications, type DatabaseClient } from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'

/**
 * The one place mention-share inputs are assembled.
 *
 * Every surface that reports mention share — the project overview card, the
 * trend buckets, `visibility-stats --share-of-voice`, `visibility-compare`, the
 * client report — has to classify the same queries the same way and match the
 * same competitor aliases the same way, or the same run produces different
 * numbers depending on which screen you read it on. Assembling the inputs in
 * one module is what makes that true rather than aspirational.
 */

export interface MentionShareProject {
  displayName?: string | null
  aliases?: string[] | null
  canonicalDomain?: string | null
  ownedDomains?: string[] | null
}

export interface MentionShareSnapshotRow {
  queryId?: string | null
  queryText?: string | null
  answerMentioned: boolean | null
  answerText: string | null
}

export interface MentionShareInputs {
  snapshots: MentionShareSnapshot[]
  competitors: MentionShareCompetitor[]
  /** False when the project has no usable brand alias, so nothing could be split. */
  classified: boolean
}

/**
 * Competitor aliases for answer-prose matching.
 *
 * A single brand token derived from the registrable domain (`offers.roofle.com`
 * → `roofle`), filtered by the SAME minimum length the metric uses everywhere.
 * A future column of operator-curated aliases layers on here.
 */
export function mentionShareCompetitorsFromDomains(domains: readonly string[]): MentionShareCompetitor[] {
  return domains.map(domain => {
    const exactDomain = hostOf(domain)
    const domainLabel = brandLabelFromDomain(domain)
    return {
      domain,
      // A short registrable label is too noisy by itself (`AI`), but the full
      // written domain is operator-approved identity (`ai.com`). Feeding both
      // through the shared matcher keeps every mention-share surface aligned.
      brandTokens: usableBrandAliases([
        ...(brandKeyFromText(domainLabel).length >= MIN_DOMAIN_BRAND_KEY_LENGTH ? [domainLabel] : []),
        ...(exactDomain?.includes('.') ? [exactDomain] : []),
      ]),
    }
  })
}

/** Reuse discovery's stored domain taxonomy; a read never starts classification. */
export function readObservedCompetitorDomains(db: DatabaseClient, projectId: string): string[] {
  const rows = db.select({ domain: domainClassifications.domain, type: domainClassifications.competitorType })
    .from(domainClassifications).where(eq(domainClassifications.projectId, projectId)).all()
  return storedDirectCompetitorDomains(new Map(rows.map(row => [
    row.domain, (surfaceClassFromCompetitorType(row.type) ?? 'unknown') as CompetitorLandscapeSurfaceClass,
  ])))
}

/** Descriptive names stay listed, deduplicated per answer, outside every rate. */
export function observedCompetitorNames(snapshots: readonly { id?: string; recommendedCompetitors?: readonly string[] }[]): Array<{ name: string; answerCount: number }> {
  const answers = new Map<string, Set<string | number>>()
  snapshots.forEach((snapshot, i) => {
    for (const name of snapshot.recommendedCompetitors ?? []) {
      const trimmed = name.trim()
      if (!trimmed) continue
      const ids = answers.get(trimmed) ?? new Set<string | number>()
      ids.add(snapshot.id ?? i)
      answers.set(trimmed, ids)
    }
  })
  return [...answers].map(([name, ids]) => ({ name, answerCount: ids.size }))
    .sort((a, b) => b.answerCount - a.answerCount || a.name.localeCompare(b.name))
}

/**
 * Classify a project's tracked queries into branded / non-brand.
 *
 * Returns `null` when the project has no usable brand alias: callers must then
 * report a pooled figure AS pooled rather than passing an unsplit basket off as
 * a non-brand one.
 */
export function projectQueryClassifier(project: MentionShareProject): ((queryText: string | null | undefined) => QueryClass) | null {
  const classifier = compileQueryClassifier(effectiveBrandNames({
    displayName: project.displayName ?? null,
    aliases: project.aliases ?? null,
    canonicalDomain: project.canonicalDomain ?? null,
    ownedDomains: project.ownedDomains ?? null,
  }))
  return classifier ? (queryText) => classifier.classify(queryText) : null
}

/**
 * Build the snapshot + competitor inputs for `buildMentionShare`.
 *
 * `queryTextById` carries the CURRENT text of a tracked query; the snapshot's
 * own denormalized `queryText` is the fallback for rows whose query has since
 * been renamed or deleted. Classification reads whichever is available, so an
 * archived snapshot still lands in the class its text says it belongs to
 * instead of silently defaulting into the competitive figure.
 */
export function buildMentionShareInputs(opts: {
  project: MentionShareProject
  competitorDomains: readonly string[]
  snapshots: readonly MentionShareSnapshotRow[]
  queryTextById?: ReadonlyMap<string, string>
}): MentionShareInputs {
  const classify = projectQueryClassifier(opts.project)
  const projectBrandNames = effectiveBrandNames({
    displayName: opts.project.displayName ?? null,
    aliases: opts.project.aliases ?? null,
    canonicalDomain: opts.project.canonicalDomain ?? null,
    ownedDomains: opts.project.ownedDomains ?? null,
  })
  const projectDomains = effectiveDomains({
    canonicalDomain: opts.project.canonicalDomain ?? '',
    ownedDomains: opts.project.ownedDomains ?? [],
  })
  return {
    classified: classify !== null,
    competitors: mentionShareCompetitorsFromDomains(opts.competitorDomains),
    snapshots: opts.snapshots.map(snap => {
      const queryText = (snap.queryId ? opts.queryTextById?.get(snap.queryId) : undefined) ?? snap.queryText ?? null
      return {
        // Mention share is a current-identity metric. Recompute stored answer
        // text after an alias/domain rename; only text-less legacy rows need
        // the persisted run-time boolean as a fallback.
        projectMentioned: snap.answerText
          ? determineAnswerMentioned(snap.answerText, projectBrandNames, projectDomains)
          : snap.answerMentioned === true,
        answerText: snap.answerText,
        queryClass: classify ? classify(queryText) : null,
      }
    }),
  }
}

/** Adapt the full, uncapped comparison set; presentation rows may be truncated. */
export function shareOfVoiceFromLandscape(landscape: CompetitorLandscapeResponse, queryClass: QueryClass | 'pooled'): VisibilityStatsShareOfVoice {
  const comparison = landscape.comparison ?? []
  return {
    basis: landscape.basis, availability: landscape.availability, reason: landscape.reason,
    measurementScope: landscape.scope.kind === 'all-markets' ? 'all-markets' : 'project',
    queryClass, percent: landscape.project.shareOfVoice,
    competitorCount: comparison.length,
    projectMentions: landscape.project.mentionCount,
    competitorMentions: landscape.evidence.mentionCredits - landscape.project.mentionCount,
    snapshotsWithAnswerText: landscape.evidence.answeredResults,
    perCompetitor: comparison.filter(row => row.mentions > 0).sort((a, b) => b.mentions - a.mentions || a.domain.localeCompare(b.domain)),
  }
}

import { z } from 'zod'
import { categorizeSource, type SourceCategory } from './source-categories.js'
import { normalizeProjectDomain } from './project.js'

/**
 * Actionable classification of a cited domain, layered on top of the generic
 * `SourceCategory` taxonomy. Where `SourceCategory` answers "what kind of site
 * is this" (directory / news / forum / …), `SurfaceClass` answers the question
 * an operator actually acts on: is this domain mine, a rival I must out-rank,
 * a placement target I should pitch, or noise?
 *
 * - `own`               — the project's canonical domain or any owned alias /
 *   subdomain. Already winning.
 * - `direct-competitor` — a tracked project competitor. A rival to out-rank.
 * - `ota-aggregator`    — listing / marketplace surfaces that rank many
 *   businesses (directories, review platforms, marketplaces, e-commerce). A
 *   placement target: get listed and rank well within it.
 * - `editorial-media`   — content / editorial surfaces you earn placement in
 *   (news, blogs, "best of" round-ups, reference). A pitch target.
 * - `other`             — social, forums, video, academic, and anything off the
 *   competitive/placement map.
 *
 * Computed DETERMINISTICALLY with zero LLM calls — `own` / `direct-competitor`
 * read the project's own + tracked-competitor domains, the rest reuse the pure
 * `categorizeSource` allow-list. This mirrors the discovery competitor-type
 * taxonomy ({@link DiscoveryCompetitorType}) but resolves it from already-stored
 * data instead of re-running the discovery classifier's AI call.
 */
export const surfaceClassSchema = z.enum([
  'own',
  'direct-competitor',
  'ota-aggregator',
  'editorial-media',
  'other',
])
export type SurfaceClass = z.infer<typeof surfaceClassSchema>
export const SurfaceClasses = surfaceClassSchema.enum

const SURFACE_CLASS_LABELS: Record<SurfaceClass, string> = {
  own: 'Your domains',
  'direct-competitor': 'Direct competitors',
  'ota-aggregator': 'Aggregators & marketplaces',
  'editorial-media': 'Editorial & media',
  other: 'Other sources',
}

export function surfaceClassLabel(surfaceClass: SurfaceClass): string {
  return SURFACE_CLASS_LABELS[surfaceClass]
}

/**
 * True when `candidate` (already normalized) equals or is a subdomain of any
 * domain in `domains`. Same exact-or-subdomain rule as
 * `citedDomainBelongsToProject` (packages/intelligence) and `domainMatches`
 * (packages/canonry citation-utils) — kept here as the pure, dependency-free
 * form so the classifier can live in contracts.
 */
function matchesAnyDomain(candidate: string, domains: readonly string[]): boolean {
  if (!candidate) return false
  for (const domain of domains) {
    const normalized = normalizeProjectDomain(domain)
    if (!normalized) continue
    if (candidate === normalized || candidate.endsWith(`.${normalized}`)) return true
  }
  return false
}

export interface SurfaceClassContext {
  /** The project's own domains — `effectiveDomains(project)`. */
  projectDomains: readonly string[]
  /** The project's tracked competitor domains. */
  competitorDomains: readonly string[]
}

/**
 * Classify an already-categorized cited domain into a {@link SurfaceClass}.
 * Pure and deterministic. Resolution order is priority-ordered: own beats
 * competitor, competitor beats the generic category map — so a tracked
 * competitor that also happens to be a directory still reads `direct-competitor`.
 *
 * Use this when the caller already ran `categorizeSource` (e.g. an aggregation
 * loop that needs the `domain`/`label` anyway) so the rule scan isn't repeated.
 * {@link classifySurface} is the URI-level convenience wrapper over it.
 */
export function classifySurfaceFromCategory(
  domain: string,
  category: SourceCategory,
  context: SurfaceClassContext,
): SurfaceClass {
  const candidate = normalizeProjectDomain(domain)

  if (matchesAnyDomain(candidate, context.projectDomains)) return SurfaceClasses.own
  if (matchesAnyDomain(candidate, context.competitorDomains)) return SurfaceClasses['direct-competitor']

  switch (category) {
    case 'directory':
    case 'ecommerce':
      return SurfaceClasses['ota-aggregator']
    case 'news':
    case 'blog':
    case 'reference':
      return SurfaceClasses['editorial-media']
    case 'competitor':
      // categorizeSource only emits 'competitor' via the competitor-aware
      // variant, which this function does not call — but map defensively so the
      // switch stays exhaustive and correct if that ever changes.
      return SurfaceClasses['direct-competitor']
    case 'social':
    case 'forum':
    case 'video':
    case 'academic':
    case 'other':
      return SurfaceClasses.other
  }
}

/**
 * Classify a single cited domain (or URL) into a {@link SurfaceClass}. Pure and
 * deterministic — categorizes the URI, then delegates to
 * {@link classifySurfaceFromCategory}.
 */
export function classifySurface(uri: string, context: SurfaceClassContext): SurfaceClass {
  const { domain, category } = categorizeSource(uri)
  return classifySurfaceFromCategory(domain, category, context)
}

import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { siteCrawlEdges } from '@canonry/canonry-db'
import {
  classifyTemplateLinkEdge,
  createTemplateLinkDetectionTally,
  createTemplateLinkPairIndex,
  observeTemplateLinkDetection,
  observeTemplateLinkEdges,
  SiteHealthLinkClassificationSources,
  templateLinkDetection,
  templateLinkPlacementAvailable,
  templateLinkUbiquityAvailable,
  type SiteCrawlPlacementOccurrencesDto,
  type SiteHealthTemplateDetectionOutcome,
  type TemplateLinkEdgeInput,
} from '@canonry/canonry-contracts'

/**
 * Links are read and written in bounded batches. The crawl budget reaches one
 * million links, and neither pass may hold them all: the pair index is bounded
 * by DISTINCT (target, anchor) pairs, which is low hundreds on a real site.
 */
const TEMPLATE_LINK_READ_BATCH = 2_000
/** SQLite caps bound parameters; this stays well inside the default limit. */
const TEMPLATE_LINK_WRITE_BATCH = 500

export interface SiteCrawlTemplateLinkScope {
  projectId: string
  runId: string
  attemptId: string
}

export interface SiteCrawlTemplateLinkResult {
  detection: SiteHealthTemplateDetectionOutcome
  /** Links classified as nav, header, or footer chrome for this attempt. */
  templateEdgeCount: number
  /** Links decided by where they sit in the page rather than by repetition. */
  placementEdgeCount: number
}

/**
 * A link's three placement counts, or null when this scan recorded none.
 *
 * All three columns are written together or not at all, so one NULL means the
 * whole observation is absent. Reading a partial row as zeros would turn "we
 * never looked" into "the page said nothing", and those are different claims.
 */
function placementOccurrencesOf(row: {
  placementNavigationOccurrences: number | null
  placementContentOccurrences: number | null
  placementUnknownOccurrences: number | null
}): SiteCrawlPlacementOccurrencesDto | null {
  const { placementNavigationOccurrences: navigation } = row
  const { placementContentOccurrences: content } = row
  const { placementUnknownOccurrences: unknown } = row
  if (navigation == null || content == null || unknown == null) return null
  return { navigation, content, unknown }
}

/**
 * Keyset (not OFFSET) paging over `edge_key`, so the unique
 * `(project, run, attempt, edge_key)` index seeks straight to each batch
 * instead of re-walking every prior row at the maximum crawl budget.
 */
function* streamAttemptEdges(
  db: DatabaseClient,
  scope: SiteCrawlTemplateLinkScope,
): Generator<TemplateLinkEdgeInput[]> {
  let after = ''
  for (;;) {
    const rows = db.select({
      edgeKey: siteCrawlEdges.edgeKey,
      sourceNodeKey: siteCrawlEdges.sourceNodeKey,
      targetNodeKey: siteCrawlEdges.targetNodeKey,
      anchors: siteCrawlEdges.anchors,
      relation: siteCrawlEdges.relation,
      placementNavigationOccurrences: siteCrawlEdges.placementNavigationOccurrences,
      placementContentOccurrences: siteCrawlEdges.placementContentOccurrences,
      placementUnknownOccurrences: siteCrawlEdges.placementUnknownOccurrences,
    }).from(siteCrawlEdges)
      .where(and(
        eq(siteCrawlEdges.projectId, scope.projectId),
        eq(siteCrawlEdges.runId, scope.runId),
        eq(siteCrawlEdges.attemptId, scope.attemptId),
        gt(siteCrawlEdges.edgeKey, after),
      ))
      .orderBy(asc(siteCrawlEdges.edgeKey))
      .limit(TEMPLATE_LINK_READ_BATCH)
      .all()
    if (rows.length === 0) return
    yield rows.map((row) => ({
      edgeKey: row.edgeKey,
      sourceNodeKey: row.sourceNodeKey,
      targetNodeKey: row.targetNodeKey,
      anchors: row.anchors,
      relation: row.relation,
      placementOccurrences: placementOccurrencesOf(row),
    }))
    after = rows[rows.length - 1]!.edgeKey
    if (rows.length < TEMPLATE_LINK_READ_BATCH) return
  }
}

function* chunked<T>(values: readonly T[], size = TEMPLATE_LINK_WRITE_BATCH): Generator<T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size)
  }
}

/**
 * One UPDATE per distinct written value, so the statement count is bounded by
 * distinct decisions rather than by the link budget. The unit separator keeps
 * the two fields from running together into an ambiguous key.
 */
function writeGroupKey(isTemplate: boolean, templateRatio: number | null): string {
  return `${isTemplate ? '1' : '0'}\u001F${templateRatio ?? ''}`
}

/**
 * Mark one attempt's nav, header, and footer links.
 *
 * Runs after the crawl and BEFORE graph layout, because the layout excludes
 * template links from its physics. Classification itself lives in
 * `@canonry/canonry-contracts` so the migration backfill, the publish path, and
 * the tests all share one derivation.
 *
 * DOM placement decides every link the crawler recorded a landmark answer for.
 * Ubiquity is the fallback for links the page said nothing about, and for scans
 * captured before the crawler reported placement at all. That ordering is the
 * point of the pass: ubiquity keys on (target URL, anchor text) and therefore
 * cannot see an editorial link whose anchor text matches the nav's.
 *
 * With neither rule available (no placement, and fewer pages than the ubiquity
 * floor) nothing is measured and this returns `unavailable-too-few-pages`,
 * which the snapshot records: on a five-page site every link looks ubiquitous,
 * and an empty template-link list would read as "this site has no nav" rather
 * than "we could not tell".
 *
 * A link no rule could measure is written as a real `false` and reported
 * `unmeasured`. It is deliberately NOT a third stored state: `is_template` has
 * exactly two values plus the historical NULL for scans that were never
 * classified, so every downstream reader keeps one definition of a content link.
 *
 * Idempotent: every link in the attempt is reset before the classified writes,
 * so a retried publish produces the same rows.
 */
export function classifySiteCrawlTemplateLinks(
  db: DatabaseClient,
  scope: SiteCrawlTemplateLinkScope,
  pagesFetched: number,
  placementRulesetVersion: string | null,
): SiteCrawlTemplateLinkResult {
  const scopeFilter = and(
    eq(siteCrawlEdges.projectId, scope.projectId),
    eq(siteCrawlEdges.runId, scope.runId),
    eq(siteCrawlEdges.attemptId, scope.attemptId),
  )
  const placementAvailable = templateLinkPlacementAvailable(placementRulesetVersion)
  const ubiquityAvailable = templateLinkUbiquityAvailable(pagesFetched)

  // Every link in the attempt is reset to "classified, not chrome" and then
  // written over by whatever rule decides it. NOTHING here ever writes NULL:
  // NULL means "this row was never classified", and it is left for scans
  // published before classification existed. A link no rule could measure is a
  // real `false` with an `unmeasured` source, so `is_template` stays a strict
  // boolean and every reader downstream (the layout input, the graph sample,
  // both link filters, the totals, the map legend, the inspector tiles) keeps
  // the single definition of a content link it already assumed.
  db.update(siteCrawlEdges).set({ isTemplate: false, templateRatio: null }).where(scopeFilter).run()

  const index = createTemplateLinkPairIndex()
  if (ubiquityAvailable) {
    // The index measures how often a (target, anchor) pair repeats across the
    // whole scan, so it is built from EVERY link. Leaving placement-decided
    // links out would shrink the denominator of a rule they never enter.
    for (const batch of streamAttemptEdges(db, scope)) observeTemplateLinkEdges(index, batch)
  }

  // Grouped by the exact written value, so the number of UPDATE statements is
  // bounded by distinct decisions rather than by the link budget.
  const edgeKeysByValue = new Map<string, { isTemplate: boolean; templateRatio: number | null; edgeKeys: string[] }>()
  let templateEdgeCount = 0
  let placementEdgeCount = 0
  const tally = createTemplateLinkDetectionTally()
  for (const batch of streamAttemptEdges(db, scope)) {
    for (const edge of batch) {
      const decision = classifyTemplateLinkEdge(edge, { index, pagesFetched, placementAvailable, ubiquityAvailable })
      // One shared accumulator with the one-shot classifier, so the two writers
      // cannot reach different whole-scan states over the same links.
      observeTemplateLinkDetection(tally, edge, decision)
      if (decision.source === SiteHealthLinkClassificationSources.placement) placementEdgeCount += 1
      if (decision.isTemplate) templateEdgeCount += 1
      // Nothing to write when the decision already equals the reset value.
      if (!decision.isTemplate && decision.templateRatio == null) continue
      const key = writeGroupKey(decision.isTemplate, decision.templateRatio)
      const group = edgeKeysByValue.get(key)
      if (group) group.edgeKeys.push(decision.edgeKey)
      else {
        edgeKeysByValue.set(key, {
          isTemplate: decision.isTemplate,
          templateRatio: decision.templateRatio,
          edgeKeys: [decision.edgeKey],
        })
      }
    }
  }

  const now = new Date().toISOString()
  for (const group of edgeKeysByValue.values()) {
    for (const chunk of chunked(group.edgeKeys)) {
      db.update(siteCrawlEdges)
        .set({ isTemplate: group.isTemplate, templateRatio: group.templateRatio, updatedAt: now })
        .where(and(scopeFilter, inArray(siteCrawlEdges.edgeKey, chunk)))
        .run()
    }
  }
  return {
    detection: templateLinkDetection({ placementAvailable, ubiquityAvailable, tally }),
    templateEdgeCount,
    placementEdgeCount,
  }
}

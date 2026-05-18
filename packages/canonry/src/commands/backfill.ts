import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { GroundingSource, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { auditLog, createClient, gaAiReferrals, gaTrafficSnapshots, migrate, parseJsonColumn, competitors, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveBrandNames, effectiveDomains, normalizeUrlPath, ProviderNames, RunKinds } from '@ainyc/canonry-contracts'
import { reparseStoredResult as reparseOpenAIStoredResult } from '@ainyc/canonry-provider-openai'
import { reparseStoredResult as reparseClaudeStoredResult } from '@ainyc/canonry-provider-claude'
import { reparseStoredResult as reparseGeminiStoredResult } from '@ainyc/canonry-provider-gemini'
import { reparseStoredResult as reparsePerplexityStoredResult } from '@ainyc/canonry-provider-perplexity'
import { loadConfig } from '../config.js'
import type { CliFormat } from '../cli-error.js'
import {
  computeCompetitorOverlap,
  determineCitationState,
  extractRecommendedCompetitors,
} from '../citation-utils.js'

const SNAPSHOT_BATCH_SIZE = 500

export async function backfillAnswerVisibilityCommand(opts?: {
  project?: string
  dryRun?: boolean
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()
  const isDryRun = opts?.dryRun === true

  const scopedProjects = projectFilter
    ? db.select().from(projects).where(eq(projects.name, projectFilter)).all()
    : db.select().from(projects).all()

  let examined = 0
  let updated = 0
  let wouldUpdate = 0
  let mentioned = 0
  let reparsed = 0
  let providerErrors = 0
  if (scopedProjects.length > 0) {
    const runRows = projectFilter
      ? db
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(and(
          eq(runs.kind, RunKinds['answer-visibility']),
          inArray(runs.projectId, scopedProjects.map(project => project.id)),
        ))
        .all()
      : db
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(eq(runs.kind, RunKinds['answer-visibility']))
        .all()

    const runIdsByProject = new Map<string, string[]>()
    for (const run of runRows) {
      const existing = runIdsByProject.get(run.projectId)
      if (existing) existing.push(run.id)
      else runIdsByProject.set(run.projectId, [run.id])
    }

    for (const project of scopedProjects) {
      const competitorDomains = db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
        .map(row => row.domain)
      const runIds = runIdsByProject.get(project.id) ?? []
      if (runIds.length === 0) continue

      const projectDomains = effectiveDomains({
        canonicalDomain: project.canonicalDomain,
        ownedDomains: project.ownedDomains,
      })
      const projectBrandNames = effectiveBrandNames({
        displayName: project.displayName,
        aliases: project.aliases,
      })

      for (let offset = 0; offset < runIds.length; offset += SNAPSHOT_BATCH_SIZE) {
        const batchRunIds = runIds.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
        const snapshotRows = db.select({
          id: querySnapshots.id,
          provider: querySnapshots.provider,
          citationState: querySnapshots.citationState,
          answerMentioned: querySnapshots.answerMentioned,
          answerText: querySnapshots.answerText,
          citedDomains: querySnapshots.citedDomains,
          competitorOverlap: querySnapshots.competitorOverlap,
          recommendedCompetitors: querySnapshots.recommendedCompetitors,
          rawResponse: querySnapshots.rawResponse,
        }).from(querySnapshots)
          .where(inArray(querySnapshots.runId, batchRunIds))
          .all()
        const pendingUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

        for (const snapshot of snapshotRows) {
          examined++
          const reparsedResult = reparseProviderSnapshot(snapshot.provider, snapshot.rawResponse)
          if (reparsedResult) reparsed++
          if (reparsedResult?.providerError) providerErrors++

          const answerText = reparsedResult?.answerText ?? snapshot.answerText ?? ''
          const nextValue = determineAnswerMentioned(answerText, projectBrandNames, projectDomains)

          if (nextValue) mentioned++

          const nextPatch: Record<string, unknown> = {}

          if (snapshot.answerMentioned !== nextValue) {
            nextPatch.answerMentioned = nextValue
          }

          if ((snapshot.answerText ?? '') !== answerText) {
            nextPatch.answerText = answerText
          }

          if (reparsedResult) {
            const normalized: NormalizedQueryResult = {
              provider: snapshot.provider,
              answerText,
              citedDomains: reparsedResult.citedDomains,
              groundingSources: reparsedResult.groundingSources,
              searchQueries: reparsedResult.searchQueries,
            }

            const nextCitationState = determineCitationState(normalized, projectDomains)
            const nextCitedDomains = reparsedResult.citedDomains
            const nextCompetitorOverlap = computeCompetitorOverlap(normalized, competitorDomains)
            const nextRecommendedCompetitors = extractRecommendedCompetitors(
              normalized.answerText,
              projectDomains,
              normalized.citedDomains,
              competitorDomains,
              projectBrandNames,
            )
            const nextRawResponse = stringifyStoredSnapshotEnvelope(
              snapshot.rawResponse,
              reparsedResult,
            )

            if (snapshot.citationState !== nextCitationState) {
              nextPatch.citationState = nextCitationState
            }
            if (JSON.stringify(snapshot.citedDomains) !== JSON.stringify(nextCitedDomains)) {
              nextPatch.citedDomains = nextCitedDomains
            }
            if (JSON.stringify(snapshot.competitorOverlap) !== JSON.stringify(nextCompetitorOverlap)) {
              nextPatch.competitorOverlap = nextCompetitorOverlap
            }
            if (JSON.stringify(snapshot.recommendedCompetitors) !== JSON.stringify(nextRecommendedCompetitors)) {
              nextPatch.recommendedCompetitors = nextRecommendedCompetitors
            }
            if (snapshot.rawResponse !== nextRawResponse) {
              nextPatch.rawResponse = nextRawResponse
            }
          }

          if (Object.keys(nextPatch).length > 0) {
            pendingUpdates.push({ id: snapshot.id, patch: nextPatch })
          }
        }

        if (pendingUpdates.length > 0) {
          if (isDryRun) {
            wouldUpdate += pendingUpdates.length
          } else {
            db.transaction((tx) => {
              for (const update of pendingUpdates) {
                tx.update(querySnapshots)
                  .set(update.patch)
                  .where(eq(querySnapshots.id, update.id))
                  .run()
              }
            })
            updated += pendingUpdates.length
          }
        }
      }
    }
  }

  const result: Record<string, unknown> = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    mentioned,
    reparsed,
    providerErrors,
  }
  if (isDryRun) {
    result.dryRun = true
    result.wouldUpdate = wouldUpdate
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Answer visibility backfill ${isDryRun ? 'preview' : 'complete'}.\n`)
  if (projectFilter) {
    console.log(`  Project:  ${projectFilter}`)
  }
  console.log(`  Projects: ${scopedProjects.length}`)
  console.log(`  Examined:     ${examined}`)
  if (isDryRun) {
    console.log(`  Would update: ${wouldUpdate}`)
  } else {
    console.log(`  Updated:      ${updated}`)
  }
  console.log(`  Mentioned:    ${mentioned}`)
  console.log(`  Reparsed:     ${reparsed}`)
  console.log(`  Errors:       ${providerErrors}`)
  if (isDryRun) {
    console.log(`\nNo DB writes performed. Re-run without --dry-run to apply.`)
  }
}

export interface NormalizedPathsBackfillResult {
  examined: number
  updated: number
  unchanged: number
}

/**
 * Pure helper: backfill `ga_traffic_snapshots.landing_page_normalized` for
 * rows where it is currently null, using whatever DB client the caller has
 * already opened. Idempotent — only touches rows with null normalized.
 *
 * Used by both the CLI command (`canonry backfill normalized-paths`) and
 * the server startup path (`canonry serve` runs it post-migrate so users
 * never need to remember the manual command after upgrading).
 *
 * Read queries `GROUP BY COALESCE(landing_page_normalized, landing_page)`,
 * but COALESCE only collapses legacy rows whose raw path already equals
 * the canonical form. Click-ID-fragmented variants (e.g. `/?fbclid=A` vs
 * `/?fbclid=B`) only collapse after this backfill runs.
 */
export function backfillNormalizedPaths(
  db: ReturnType<typeof createClient>,
  opts?: { projectId?: string },
): NormalizedPathsBackfillResult {
  const baseConditions = []
  if (opts?.projectId) {
    baseConditions.push(eq(gaTrafficSnapshots.projectId, opts.projectId))
  }

  const rows = db
    .select({
      id: gaTrafficSnapshots.id,
      landingPage: gaTrafficSnapshots.landingPage,
      landingPageNormalized: gaTrafficSnapshots.landingPageNormalized,
    })
    .from(gaTrafficSnapshots)
    .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
    .all()

  let updated = 0
  let unchanged = 0

  if (rows.length > 0) {
    db.transaction((tx) => {
      for (const row of rows) {
        const next = normalizeUrlPath(row.landingPage)
        // If normalization still can't produce a canonical path, leave the
        // row as-is. Otherwise, rewrite whenever the stored normalized value
        // is missing or stale, so improved normalization logic can repair
        // older rows after upgrades.
        if (next === null) {
          unchanged++
          continue
        }
        if (row.landingPageNormalized === next) {
          unchanged++
          continue
        }
        tx.update(gaTrafficSnapshots)
          .set({ landingPageNormalized: next })
          .where(eq(gaTrafficSnapshots.id, row.id))
          .run()
        updated++
      }
    })
  }

  return { examined: rows.length, updated, unchanged }
}

/**
 * CLI entrypoint. Loads config, opens the DB, runs migrations, calls the
 * pure helper, and prints a human or JSON summary.
 */
export async function backfillNormalizedPathsCommand(opts?: {
  project?: string
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()
  let projectId: string | undefined
  if (projectFilter) {
    const project = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, projectFilter))
      .get()
    if (!project) {
      const result = {
        project: projectFilter,
        examined: 0,
        updated: 0,
        unchanged: 0,
      }
      if (opts?.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(`Backfill normalized-paths: project "${projectFilter}" not found.`)
      return
    }
    projectId = project.id
  }

  const { examined, updated, unchanged } = backfillNormalizedPaths(db, { projectId })

  const result = {
    project: projectFilter ?? null,
    examined,
    updated,
    unchanged,
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('Normalized-path backfill complete.\n')
  if (projectFilter) console.log(`  Project:   ${projectFilter}`)
  console.log(`  Examined:  ${examined}`)
  console.log(`  Updated:   ${updated}`)
  console.log(`  Unchanged: ${unchanged}`)
}

/**
 * Pure helper: backfill `ga_ai_referrals.landing_page_normalized` for rows
 * where it is currently null. Mirrors `backfillNormalizedPaths` but for the
 * AI referral table, which gained landing-page columns in v46. Idempotent.
 *
 * Used by both the CLI command (`canonry backfill ai-referral-paths`) and
 * the server startup path (`canonry serve` runs it post-migrate so legacy
 * rows surface in the dashboard's landing-page panel without a re-sync).
 */
export function backfillAiReferralPaths(
  db: ReturnType<typeof createClient>,
  opts?: { projectId?: string },
): NormalizedPathsBackfillResult {
  const baseConditions = []
  if (opts?.projectId) {
    baseConditions.push(eq(gaAiReferrals.projectId, opts.projectId))
  }

  const rows = db
    .select({
      id: gaAiReferrals.id,
      landingPage: gaAiReferrals.landingPage,
      landingPageNormalized: gaAiReferrals.landingPageNormalized,
    })
    .from(gaAiReferrals)
    .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
    .all()

  let updated = 0
  let unchanged = 0

  if (rows.length > 0) {
    db.transaction((tx) => {
      for (const row of rows) {
        const next = normalizeUrlPath(row.landingPage)
        if (next === null) {
          unchanged++
          continue
        }
        if (row.landingPageNormalized === next) {
          unchanged++
          continue
        }
        tx.update(gaAiReferrals)
          .set({ landingPageNormalized: next })
          .where(eq(gaAiReferrals.id, row.id))
          .run()
        updated++
      }
    })
  }

  return { examined: rows.length, updated, unchanged }
}

export async function backfillAiReferralPathsCommand(opts?: {
  project?: string
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()
  let projectId: string | undefined
  if (projectFilter) {
    const project = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, projectFilter))
      .get()
    if (!project) {
      const result = {
        project: projectFilter,
        examined: 0,
        updated: 0,
        unchanged: 0,
      }
      if (opts?.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        return
      }
      console.log(`Backfill ai-referral-paths: project "${projectFilter}" not found.`)
      return
    }
    projectId = project.id
  }

  const { examined, updated, unchanged } = backfillAiReferralPaths(db, { projectId })

  const result = {
    project: projectFilter ?? null,
    examined,
    updated,
    unchanged,
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('AI referral landing-page backfill complete.\n')
  if (projectFilter) console.log(`  Project:   ${projectFilter}`)
  console.log(`  Examined:  ${examined}`)
  console.log(`  Updated:   ${updated}`)
  console.log(`  Unchanged: ${unchanged}`)
}

export interface ProjectAnswerMentionsBackfillResult {
  examined: number
  updated: number
  wouldUpdate?: number
  mentioned: number
}

/**
 * Recomputes `answerMentioned`, `competitorOverlap`, and `recommendedCompetitors`
 * for every answer-visibility snapshot owned by `projectId` using the snapshot's
 * stored `answerText` + `citedDomains` and the `groundingSources` already cached
 * in the `rawResponse` envelope. Synchronous — better-sqlite3 has no async I/O.
 *
 * Does not touch `citationState`, `citedDomains`, or `rawResponse` — those are
 * computed by domain-to-domain matching which aliases do not affect.
 */
export function backfillProjectAnswerMentions(
  db: DatabaseClient,
  projectId: string,
  opts?: { dryRun?: boolean },
): ProjectAnswerMentionsBackfillResult {
  const isDryRun = opts?.dryRun === true
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return { examined: 0, updated: 0, mentioned: 0 }

  const competitorDomains = db
    .select({ domain: competitors.domain })
    .from(competitors)
    .where(eq(competitors.projectId, projectId))
    .all()
    .map(row => row.domain)

  const runRows = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.kind, RunKinds['answer-visibility']), eq(runs.projectId, projectId)))
    .all()
  const runIds = runRows.map(r => r.id)

  let examined = 0
  let updated = 0
  let wouldUpdate = 0
  let mentioned = 0
  if (runIds.length === 0) {
    return isDryRun ? { examined, updated, wouldUpdate, mentioned } : { examined, updated, mentioned }
  }

  const projectDomains = effectiveDomains({
    canonicalDomain: project.canonicalDomain,
    ownedDomains: project.ownedDomains,
  })
  const projectBrandNames = effectiveBrandNames({
    displayName: project.displayName,
    aliases: project.aliases,
  })

  for (let offset = 0; offset < runIds.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batchRunIds = runIds.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
    const snapshotRows = db.select({
      id: querySnapshots.id,
      provider: querySnapshots.provider,
      answerMentioned: querySnapshots.answerMentioned,
      answerText: querySnapshots.answerText,
      citedDomains: querySnapshots.citedDomains,
      competitorOverlap: querySnapshots.competitorOverlap,
      recommendedCompetitors: querySnapshots.recommendedCompetitors,
      rawResponse: querySnapshots.rawResponse,
    }).from(querySnapshots)
      .where(inArray(querySnapshots.runId, batchRunIds))
      .all()
    const pendingUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

    for (const snapshot of snapshotRows) {
      examined++

      const answerText = snapshot.answerText ?? ''
      const nextAnswerMentioned = determineAnswerMentioned(answerText, projectBrandNames, projectDomains)
      if (nextAnswerMentioned) mentioned++

      const citedDomains = snapshot.citedDomains
      const groundingSources = readStoredGroundingSources(snapshot.rawResponse)

      const normalized: NormalizedQueryResult = {
        provider: snapshot.provider,
        answerText,
        citedDomains,
        groundingSources,
        searchQueries: [],
      }

      const nextCompetitorOverlap = computeCompetitorOverlap(normalized, competitorDomains)
      const nextRecommendedCompetitors = extractRecommendedCompetitors(
        answerText,
        projectDomains,
        citedDomains,
        competitorDomains,
        projectBrandNames,
      )

      const nextPatch: Record<string, unknown> = {}
      if (snapshot.answerMentioned !== nextAnswerMentioned) {
        nextPatch.answerMentioned = nextAnswerMentioned
      }
      if (JSON.stringify(snapshot.competitorOverlap) !== JSON.stringify(nextCompetitorOverlap)) {
        nextPatch.competitorOverlap = nextCompetitorOverlap
      }
      if (JSON.stringify(snapshot.recommendedCompetitors) !== JSON.stringify(nextRecommendedCompetitors)) {
        nextPatch.recommendedCompetitors = nextRecommendedCompetitors
      }

      if (Object.keys(nextPatch).length > 0) {
        pendingUpdates.push({ id: snapshot.id, patch: nextPatch })
      }
    }

    if (pendingUpdates.length > 0) {
      if (isDryRun) {
        wouldUpdate += pendingUpdates.length
      } else {
        db.transaction((tx) => {
          for (const update of pendingUpdates) {
            tx.update(querySnapshots)
              .set(update.patch)
              .where(eq(querySnapshots.id, update.id))
              .run()
          }
        })
        updated += pendingUpdates.length
      }
    }
  }

  return isDryRun ? { examined, updated, wouldUpdate, mentioned } : { examined, updated, mentioned }
}

/**
 * Lighter sibling of `backfillAnswerVisibilityCommand` — recomputes only the
 * three fields affected by the brand-token matching fix (`answerMentioned`,
 * `competitorOverlap`, `recommendedCompetitors`) using the snapshot's stored
 * `answerText` + `citedDomains` and the `groundingSources` already cached in
 * the `rawResponse` envelope. No provider-specific reparse, so it covers
 * snapshots from providers without a reparse adapter (cdp, local, ...) and
 * is fast enough to re-run after any future matching-logic change.
 *
 * Does not touch `citationState`, `citedDomains`, or `rawResponse` — those
 * are computed by domain-to-domain matching, which this PR did not change.
 */
export async function backfillAnswerMentionsCommand(opts?: {
  project?: string
  dryRun?: boolean
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()
  const isDryRun = opts?.dryRun === true

  const scopedProjects = projectFilter
    ? db.select().from(projects).where(eq(projects.name, projectFilter)).all()
    : db.select().from(projects).all()

  let examined = 0
  let updated = 0
  let wouldUpdate = 0
  let mentioned = 0

  for (const project of scopedProjects) {
    const result = backfillProjectAnswerMentions(db, project.id, { dryRun: isDryRun })
    examined += result.examined
    updated += result.updated
    wouldUpdate += result.wouldUpdate ?? 0
    mentioned += result.mentioned
  }

  const result: Record<string, unknown> = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    mentioned,
  }
  if (isDryRun) {
    result.dryRun = true
    result.wouldUpdate = wouldUpdate
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Answer mentions backfill ${isDryRun ? 'preview' : 'complete'}.\n`)
  if (projectFilter) console.log(`  Project:      ${projectFilter}`)
  console.log(`  Projects:     ${scopedProjects.length}`)
  console.log(`  Examined:     ${examined}`)
  if (isDryRun) {
    console.log(`  Would update: ${wouldUpdate}`)
  } else {
    console.log(`  Updated:      ${updated}`)
  }
  console.log(`  Mentioned:    ${mentioned}`)
  if (isDryRun) {
    console.log(`\nNo DB writes performed. Re-run without --dry-run to apply.`)
  }
}

function readStoredGroundingSources(rawResponse: string | null): GroundingSource[] {
  const envelope = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const sources = envelope.groundingSources
  if (!Array.isArray(sources)) return []
  const result: GroundingSource[] = []
  for (const source of sources) {
    if (source && typeof source === 'object') {
      const uri = (source as { uri?: unknown }).uri
      const title = (source as { title?: unknown }).title
      if (typeof uri === 'string') {
        result.push({ uri, title: typeof title === 'string' ? title : '' })
      }
    }
  }
  return result
}

export async function backfillInsightsCommand(
  project: string,
  opts?: { fromRun?: string; toRun?: string; since?: string; dryRun?: boolean; format?: CliFormat },
): Promise<void> {
  // Lazy-load the intelligence graph so `backfill answer-visibility` can run and be
  // tested without pulling in the optional insights dependency chain.
  const { IntelligenceService } = await import('../intelligence-service.js')
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const service = new IntelligenceService(db)
  const isJson = opts?.format === 'json'
  const isDryRun = opts?.dryRun === true

  if (!isJson) {
    const scope = opts?.since ? ` (since ${opts.since})` : ''
    const mode = isDryRun ? ' [DRY RUN — no writes]' : ''
    process.stderr.write(`Backfilling insights for "${project}"${scope}${mode}...\n`)
  }

  const result = service.backfill(project, {
    fromRunId: opts?.fromRun,
    toRunId: opts?.toRun,
    since: opts?.since,
    dryRun: isDryRun,
  }, (info) => {
    if (!isJson) {
      process.stderr.write(`  [${info.index}/${info.total}] ${info.runId} — ${info.insights} insights\n`)
    }
  })

  const output: Record<string, unknown> = {
    project,
    processed: result.processed,
    skipped: result.skipped,
    totalInsights: result.totalInsights,
  }
  if (result.dryRun) {
    output.dryRun = true
    output.delta = result.delta
  }

  if (isJson) {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  console.log(`\nBackfill ${isDryRun ? 'preview' : 'complete'}.`)
  console.log(`  Processed: ${result.processed}`)
  console.log(`  Skipped:   ${result.skipped}`)
  console.log(`  Insights:  ${result.totalInsights}`)
  if (result.delta) {
    console.log(`  Delta:     -${result.delta.wouldDelete} existing  +${result.delta.wouldCreate} new  (net ${result.delta.netChange >= 0 ? '+' : ''}${result.delta.netChange})`)
    console.log(`             No DB writes performed. Re-run without --dry-run to apply.`)
  }
}

// ============================================================================
// Snapshot attribution backfill
//
// `query_text` was added to `query_snapshots` in 2026-04-08; rows inserted
// before that have NULL `query_text`. When the operator later runs
// `query replace` / `query remove`, the FK is `ON DELETE SET NULL` so
// `query_id` goes to NULL too — and pre-April snapshots end up with both
// fields NULL. The timeline endpoint can't attribute them to any current
// query, so dashboards show "limited history" even though the snapshot
// data exists.
//
// This command recovers attribution by:
//   1. Replaying the project's audit_log to reconstruct the active query
//      set at each historical run's `created_at`.
//   2. For each run with orphan snapshots: position-matching snapshots
//      (sorted by created_at within (run × provider)) to the active
//      queries when counts align (snap_count == query_count).
//   3. When counts mismatch (some queries failed mid-run), content-matching
//      via keyword overlap: tokens from each candidate query are scored
//      against the snapshot's first 200 chars of `answer_text`, and the
//      best-scoring query (above a minimum threshold) is chosen.
//   4. Writing `query_text` on every recovered snapshot in a transaction.
//
// Dry-run mode shows the planned attribution without writing.
// ============================================================================

interface SnapshotAttributionResult {
  project: string
  examinedRuns: number
  orphanSnapshots: number
  recoveredByPosition: number
  recoveredByContent: number
  unrecovered: number
  dryRun: boolean
  perRun: Array<{
    runId: string
    runCreatedAt: string
    activeQueryCount: number
    orphanSnaps: number
    recoveredPosition: number
    recoveredContent: number
    unrecovered: number
  }>
}

interface ActiveQueryEntry {
  text: string
  addedAt: string
  deletedAt: string | null
}

/**
 * Replay the project's audit log into an ordered list of query lifetimes.
 * Each entry is {text, addedAt, deletedAt|null}; a query was active at
 * time t iff `addedAt <= t < (deletedAt ?? +Inf)`.
 *
 * Handles four event kinds emitted by the queries routes:
 *   - keywords.appended / queries.appended → push new entry
 *   - keywords.deleted / queries.deleted   → mark latest matching entry as deleted
 *   - queries.replaced                     → mark all currently-active as deleted, then push new
 */
export function replayQueryAuditLog(events: Array<{ createdAt: string; action: string; diff: string | null }>): ActiveQueryEntry[] {
  const active: ActiveQueryEntry[] = []
  for (const ev of events) {
    let diff: Record<string, unknown>
    try {
      diff = ev.diff ? JSON.parse(ev.diff) as Record<string, unknown> : {}
    } catch {
      continue
    }
    if (ev.action === 'keywords.appended' || ev.action === 'queries.appended') {
      const added = Array.isArray(diff.added) ? diff.added as string[] : []
      for (const q of added) {
        active.push({ text: q, addedAt: ev.createdAt, deletedAt: null })
      }
    } else if (ev.action === 'keywords.deleted' || ev.action === 'queries.deleted') {
      const deleted = Array.isArray(diff.deleted) ? diff.deleted as string[] : []
      for (const q of deleted) {
        // Mark the most recent still-active entry with this text as deleted.
        for (let i = active.length - 1; i >= 0; i--) {
          if (active[i]!.text === q && active[i]!.deletedAt === null) {
            active[i]!.deletedAt = ev.createdAt
            break
          }
        }
      }
    } else if (ev.action === 'queries.replaced') {
      const newSet = Array.isArray(diff.queries) ? diff.queries as string[] : []
      for (const e of active) {
        if (e.deletedAt === null) e.deletedAt = ev.createdAt
      }
      for (const q of newSet) {
        active.push({ text: q, addedAt: ev.createdAt, deletedAt: null })
      }
    }
  }
  return active
}

/**
 * Queries active at time t, in insertion order. Insertion order matters
 * because the job runner sweeps queries in DB order — so the i-th snapshot
 * per provider in a run corresponds to the i-th active query.
 */
export function activeQueriesAt(history: ActiveQueryEntry[], t: string): string[] {
  return history
    .filter(e => e.addedAt <= t && (e.deletedAt === null || e.deletedAt > t))
    .map(e => e.text)
}

const CONTENT_MATCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what',
  'which', 'who', 'how', 'why', 'when', 'where', 'with', 'for', 'from',
  'of', 'in', 'on', 'at', 'to', 'by', 'as', 'best', 'most',
])

function tokenizeForMatch(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !CONTENT_MATCH_STOPWORDS.has(t))
}

/**
 * Score how well a query text matches a snapshot's answer text by
 * counting *distinguishing-token* coverage. Returns a value in [0, 1]
 * representing the fraction of the query's meaningful tokens that
 * appear in the answer head.
 *
 * "Distinguishing" matters because the azcoatings query set shares
 * heavy vocabulary ("commercial", "roof", "coating" appear in nearly
 * every query). A pure raw-count metric would tie multiple queries
 * for the same answer. We instead require coverage of EVERY query
 * token — so "polyurea roof coating Florida" can't match a snapshot
 * about Michigan, because "florida" wouldn't appear in the head.
 */
function contentMatchScore(queryText: string, answerText: string): number {
  const queryTokens = [...new Set(tokenizeForMatch(queryText))]
  if (queryTokens.length === 0) return 0
  const answerHead = answerText.slice(0, 300).toLowerCase()
  const hit = queryTokens.filter(t => answerHead.includes(t)).length
  return hit / queryTokens.length
}

export async function backfillSnapshotAttributionCommand(opts: {
  project: string
  dryRun?: boolean
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const project = db.select().from(projects).where(eq(projects.name, opts.project)).get()
  if (!project) {
    throw new Error(`Project "${opts.project}" not found`)
  }

  const isJson = opts.format === 'json'
  const isDryRun = opts.dryRun === true

  if (!isJson) {
    const mode = isDryRun ? ' [DRY RUN — no writes]' : ''
    process.stderr.write(`Recovering orphan snapshot attribution for "${project.name}"${mode}...\n`)
  }

  // Replay audit log → query lifetimes.
  const events = db
    .select({ createdAt: auditLog.createdAt, action: auditLog.action, diff: auditLog.diff })
    .from(auditLog)
    .where(and(
      eq(auditLog.projectId, project.id),
      inArray(auditLog.action, ['keywords.appended', 'keywords.deleted', 'queries.appended', 'queries.deleted', 'queries.replaced']),
    ))
    .orderBy(auditLog.createdAt)
    .all()
  const history = replayQueryAuditLog(events)

  // Find runs with at least one orphan snapshot (query_id IS NULL AND
  // query_text IS NULL — fully detached, can't display).
  const orphanRuns = db
    .select({
      runId: runs.id,
      createdAt: runs.createdAt,
      location: runs.location,
    })
    .from(runs)
    .innerJoin(querySnapshots, eq(querySnapshots.runId, runs.id))
    .where(and(
      eq(runs.projectId, project.id),
      isNull(querySnapshots.queryId),
      isNull(querySnapshots.queryText),
    ))
    .groupBy(runs.id)
    .orderBy(runs.createdAt)
    .all()

  const result: SnapshotAttributionResult = {
    project: project.name,
    examinedRuns: orphanRuns.length,
    orphanSnapshots: 0,
    recoveredByPosition: 0,
    recoveredByContent: 0,
    unrecovered: 0,
    dryRun: isDryRun,
    perRun: [],
  }

  // For each orphan run, pair its snapshots with the queries active at
  // that run's timestamp.
  const updates: Array<{ id: string; queryText: string }> = []

  for (const run of orphanRuns) {
    const activeAt = activeQueriesAt(history, run.createdAt)
    const orphanSnaps = db
      .select({
        id: querySnapshots.id,
        provider: querySnapshots.provider,
        createdAt: querySnapshots.createdAt,
        answerText: querySnapshots.answerText,
      })
      .from(querySnapshots)
      .where(and(
        eq(querySnapshots.runId, run.runId),
        isNull(querySnapshots.queryId),
        isNull(querySnapshots.queryText),
      ))
      .orderBy(querySnapshots.provider, querySnapshots.createdAt)
      .all()

    // Group by provider
    const byProvider = new Map<string, typeof orphanSnaps>()
    for (const s of orphanSnaps) {
      const arr = byProvider.get(s.provider)
      if (arr) arr.push(s)
      else byProvider.set(s.provider, [s])
    }

    let runPosition = 0
    let runContent = 0
    let runUnrecovered = 0

    for (const [, snaps] of byProvider) {
      if (snaps.length === activeAt.length) {
        // Clean 1:1 position match. The provider swept every query
        // successfully and the snapshots are in query-insertion order.
        for (let i = 0; i < snaps.length; i++) {
          updates.push({ id: snaps[i]!.id, queryText: activeAt[i]! })
          runPosition++
        }
      } else if (snaps.length < activeAt.length) {
        // Some queries failed for this provider. Walk both lists in
        // parallel: for each snapshot, find the next active query whose
        // tokens appear in the snapshot's answer head, then advance both.
        // Candidates without a content match get skipped (those are the
        // queries that failed for this provider — usually region-tagged
        // variants that hit the provider's safety filter). This is much
        // more accurate than pure best-match because it respects the
        // job-runner's insertion ordering: any candidate that matches
        // FROM the current position forward, with a meaningful score,
        // is preferred over a "globally best" match later in the list.
        // Walk both lists in parallel. For each snapshot, find the
        // first candidate (from current position forward, capped by
        // LOOKAHEAD) where EVERY query token appears in the answer
        // head. Full coverage is strict on purpose: it eliminates
        // false-positive attribution between queries that share most
        // tokens (e.g. "X Florida" vs "X Michigan" — the location
        // token must be present, so a Michigan snapshot can't be
        // attributed to a Florida query).
        //
        // Trade-off: some snapshots stay unrecovered when the LLM's
        // answer paraphrased away a query token. That's an acceptable
        // loss — better than mis-tagging the historical record.
        const LOOKAHEAD_LIMIT = 5
        let cidx = 0
        for (const snap of snaps) {
          const answerText = snap.answerText ?? ''
          let matchedIdx = -1
          for (let i = cidx; i < Math.min(activeAt.length, cidx + LOOKAHEAD_LIMIT); i++) {
            if (contentMatchScore(activeAt[i]!, answerText) >= 1.0) {
              matchedIdx = i
              break
            }
          }
          if (matchedIdx >= 0) {
            updates.push({ id: snap.id, queryText: activeAt[matchedIdx]! })
            runContent++
            cidx = matchedIdx + 1
          } else {
            runUnrecovered++
          }
        }
      } else {
        // snaps.length > activeAt.length — shouldn't happen (more snaps
        // than queries means we missed a query event in the audit log).
        // Skip safely; report as unrecovered.
        runUnrecovered += snaps.length
      }
    }

    result.orphanSnapshots += orphanSnaps.length
    result.recoveredByPosition += runPosition
    result.recoveredByContent += runContent
    result.unrecovered += runUnrecovered
    result.perRun.push({
      runId: run.runId,
      runCreatedAt: run.createdAt,
      activeQueryCount: activeAt.length,
      orphanSnaps: orphanSnaps.length,
      recoveredPosition: runPosition,
      recoveredContent: runContent,
      unrecovered: runUnrecovered,
    })

    if (!isJson) {
      process.stderr.write(
        `  ${run.createdAt} loc=${run.location ?? '-'} → ${orphanSnaps.length} orphan; `
        + `${runPosition} position-matched, ${runContent} content-matched, ${runUnrecovered} unrecovered\n`,
      )
    }
  }

  // Apply updates in a single transaction (or skip if dry-run).
  if (!isDryRun && updates.length > 0) {
    db.transaction((tx) => {
      for (const u of updates) {
        tx.update(querySnapshots).set({ queryText: u.queryText }).where(eq(querySnapshots.id, u.id)).run()
      }
    })
  }

  if (isJson) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`\nSnapshot attribution ${isDryRun ? 'preview' : 'recovery'} complete.`)
  console.log(`  Examined runs:        ${result.examinedRuns}`)
  console.log(`  Orphan snapshots:     ${result.orphanSnapshots}`)
  console.log(`  Position-matched:     ${result.recoveredByPosition}`)
  console.log(`  Content-matched:      ${result.recoveredByContent}`)
  console.log(`  Unrecovered:          ${result.unrecovered}`)
  if (isDryRun) {
    console.log(`\nNo DB writes performed. Re-run without --dry-run to apply.`)
  }
}

type ReparsedProviderSnapshot = {
  answerText: string
  citedDomains: string[]
  groundingSources: GroundingSource[]
  searchQueries: string[]
  providerError?: string
}

function reparseProviderSnapshot(
  provider: string,
  rawResponse: string | null,
): ReparsedProviderSnapshot | null {
  const envelope = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const apiResponse = resolveStoredApiResponse(envelope)
  if (!apiResponse) return null

  switch (provider) {
    case ProviderNames.openai:
      return reparseOpenAIStoredResult(apiResponse)
    case ProviderNames.claude:
      return reparseClaudeStoredResult(apiResponse)
    case ProviderNames.gemini:
      return reparseGeminiStoredResult(apiResponse)
    case ProviderNames.perplexity:
      return reparsePerplexityStoredResult(apiResponse)
    default:
      return null
  }
}

function resolveStoredApiResponse(
  parsed: Record<string, unknown>,
): Record<string, unknown> | null {
  const nested = parsed.apiResponse
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }

  if (looksLikeProviderApiResponse(parsed)) {
    return parsed
  }

  return null
}

function looksLikeProviderApiResponse(value: Record<string, unknown>): boolean {
  return Array.isArray(value.output)
    || Array.isArray(value.content)
    || Array.isArray(value.candidates)
    || Array.isArray(value.choices)
}

function stringifyStoredSnapshotEnvelope(
  rawResponse: string | null,
  reparsed: ReparsedProviderSnapshot,
): string {
  const parsed = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const apiResponse = resolveStoredApiResponse(parsed)
  const envelope = apiResponse === parsed ? {} : { ...parsed }

  // Snapshot columns remain the source of truth for these derived values. The stored raw
  // envelope only keeps provider telemetry plus the underlying API payload needed for
  // future reparsing/debugging.
  delete envelope.answerText
  delete envelope.citedDomains
  delete envelope.competitorOverlap
  delete envelope.recommendedCompetitors
  delete envelope.providerError

  return JSON.stringify({
    ...envelope,
    groundingSources: reparsed.groundingSources,
    searchQueries: reparsed.searchQueries,
    ...(reparsed.providerError ? { providerError: reparsed.providerError } : {}),
    ...(apiResponse ? { apiResponse } : {}),
  })
}

import { and, eq, inArray } from 'drizzle-orm'
import type { GroundingSource, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import { createClient, gaAiReferrals, gaTrafficSnapshots, migrate, parseJsonColumn, competitors, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveDomains, normalizeUrlPath, ProviderNames, RunKinds } from '@ainyc/canonry-contracts'
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
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()

  const scopedProjects = projectFilter
    ? db.select().from(projects).where(eq(projects.name, projectFilter)).all()
    : db.select().from(projects).all()

  let examined = 0
  let updated = 0
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
        ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
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
          const nextValue = determineAnswerMentioned(answerText, project.displayName, projectDomains)

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
            const nextCitedDomains = JSON.stringify(reparsedResult.citedDomains)
            const nextCompetitorOverlap = JSON.stringify(
              computeCompetitorOverlap(normalized, competitorDomains),
            )
            const nextRecommendedCompetitors = JSON.stringify(
              extractRecommendedCompetitors(
                normalized.answerText,
                projectDomains,
                normalized.citedDomains,
                competitorDomains,
              ),
            )
            const nextRawResponse = stringifyStoredSnapshotEnvelope(
              snapshot.rawResponse,
              reparsedResult,
            )

            if (snapshot.citationState !== nextCitationState) {
              nextPatch.citationState = nextCitationState
            }
            if (snapshot.citedDomains !== nextCitedDomains) {
              nextPatch.citedDomains = nextCitedDomains
            }
            if (snapshot.competitorOverlap !== nextCompetitorOverlap) {
              nextPatch.competitorOverlap = nextCompetitorOverlap
            }
            if (snapshot.recommendedCompetitors !== nextRecommendedCompetitors) {
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

  const result = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    mentioned,
    reparsed,
    providerErrors,
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('Answer visibility backfill complete.\n')
  if (projectFilter) {
    console.log(`  Project:  ${projectFilter}`)
  }
  console.log(`  Projects: ${scopedProjects.length}`)
  console.log(`  Examined:  ${examined}`)
  console.log(`  Updated:   ${updated}`)
  console.log(`  Mentioned: ${mentioned}`)
  console.log(`  Reparsed:  ${reparsed}`)
  console.log(`  Errors:    ${providerErrors}`)
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
  format?: CliFormat
}): Promise<void> {
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const projectFilter = opts?.project?.trim()

  const scopedProjects = projectFilter
    ? db.select().from(projects).where(eq(projects.name, projectFilter)).all()
    : db.select().from(projects).all()

  let examined = 0
  let updated = 0
  let mentioned = 0

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
        ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
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
          const nextAnswerMentioned = determineAnswerMentioned(answerText, project.displayName, projectDomains)
          if (nextAnswerMentioned) mentioned++

          const citedDomains = parseJsonColumn<string[]>(snapshot.citedDomains, [])
          const groundingSources = readStoredGroundingSources(snapshot.rawResponse)

          const normalized: NormalizedQueryResult = {
            provider: snapshot.provider,
            answerText,
            citedDomains,
            groundingSources,
            searchQueries: [],
          }

          const nextCompetitorOverlap = JSON.stringify(
            computeCompetitorOverlap(normalized, competitorDomains),
          )
          const nextRecommendedCompetitors = JSON.stringify(
            extractRecommendedCompetitors(
              answerText,
              projectDomains,
              citedDomains,
              competitorDomains,
            ),
          )

          const nextPatch: Record<string, unknown> = {}
          if (snapshot.answerMentioned !== nextAnswerMentioned) {
            nextPatch.answerMentioned = nextAnswerMentioned
          }
          if (snapshot.competitorOverlap !== nextCompetitorOverlap) {
            nextPatch.competitorOverlap = nextCompetitorOverlap
          }
          if (snapshot.recommendedCompetitors !== nextRecommendedCompetitors) {
            nextPatch.recommendedCompetitors = nextRecommendedCompetitors
          }

          if (Object.keys(nextPatch).length > 0) {
            pendingUpdates.push({ id: snapshot.id, patch: nextPatch })
          }
        }

        if (pendingUpdates.length > 0) {
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

  const result = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    mentioned,
  }

  if (opts?.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('Answer mentions backfill complete.\n')
  if (projectFilter) console.log(`  Project:   ${projectFilter}`)
  console.log(`  Projects:  ${scopedProjects.length}`)
  console.log(`  Examined:  ${examined}`)
  console.log(`  Updated:   ${updated}`)
  console.log(`  Mentioned: ${mentioned}`)
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
  opts?: { fromRun?: string; toRun?: string; format?: CliFormat },
): Promise<void> {
  // Lazy-load the intelligence graph so `backfill answer-visibility` can run and be
  // tested without pulling in the optional insights dependency chain.
  const { IntelligenceService } = await import('../intelligence-service.js')
  const config = loadConfig()
  const db = createClient(config.database)
  migrate(db)

  const service = new IntelligenceService(db)
  const isJson = opts?.format === 'json'

  if (!isJson) {
    process.stderr.write(`Backfilling insights for "${project}"...\n`)
  }

  const result = service.backfill(project, {
    fromRunId: opts?.fromRun,
    toRunId: opts?.toRun,
  }, (info) => {
    if (!isJson) {
      process.stderr.write(`  [${info.index}/${info.total}] ${info.runId} — ${info.insights} insights\n`)
    }
  })

  const output = {
    project,
    processed: result.processed,
    skipped: result.skipped,
    totalInsights: result.totalInsights,
  }

  if (isJson) {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  console.log(`\nBackfill complete.`)
  console.log(`  Processed: ${result.processed}`)
  console.log(`  Skipped:   ${result.skipped}`)
  console.log(`  Insights:  ${result.totalInsights}`)
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

import { eq, inArray } from 'drizzle-orm'
import type { GroundingSource, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import { createClient, migrate, parseJsonColumn, competitors, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveDomains } from '@ainyc/canonry-contracts'
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
} from '../job-runner.js'

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
  let visible = 0
  let reparsed = 0
  let providerErrors = 0
  if (scopedProjects.length > 0) {
    const runRows = projectFilter
      ? db
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(inArray(runs.projectId, scopedProjects.map(project => project.id)))
        .all()
      : db.select({ id: runs.id, projectId: runs.projectId }).from(runs).all()

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

        for (const snapshot of snapshotRows) {
          examined++
          const reparsedResult = reparseProviderSnapshot(snapshot.provider, snapshot.rawResponse)
          if (reparsedResult) reparsed++
          if (reparsedResult?.providerError) providerErrors++

          const answerText = reparsedResult?.answerText ?? snapshot.answerText ?? ''
          const nextValue = determineAnswerMentioned(answerText, project.displayName, projectDomains)

          if (nextValue) visible++

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
            db.update(querySnapshots)
              .set(nextPatch)
              .where(eq(querySnapshots.id, snapshot.id))
              .run()
            updated++
          }
        }
      }
    }
  }

  const result = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    visible,
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
  console.log(`  Examined: ${examined}`)
  console.log(`  Updated:  ${updated}`)
  console.log(`  Visible:  ${visible}`)
  console.log(`  Reparsed: ${reparsed}`)
  console.log(`  Errors:   ${providerErrors}`)
}

export async function backfillInsightsCommand(
  project: string,
  opts?: { fromRun?: string; toRun?: string; format?: CliFormat },
): Promise<void> {
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
    case 'openai':
      return reparseOpenAIStoredResult(apiResponse)
    case 'claude':
      return reparseClaudeStoredResult(apiResponse)
    case 'gemini':
      return reparseGeminiStoredResult(apiResponse)
    case 'perplexity':
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

import { eq, inArray } from 'drizzle-orm'
import { createClient, migrate, parseJsonColumn, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveDomains } from '@ainyc/canonry-contracts'
import { loadConfig } from '../config.js'
import { IntelligenceService } from '../intelligence-service.js'
import type { CliFormat } from '../cli-error.js'

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
      const runIds = runIdsByProject.get(project.id) ?? []
      if (runIds.length === 0) continue

      for (let offset = 0; offset < runIds.length; offset += SNAPSHOT_BATCH_SIZE) {
        const batchRunIds = runIds.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
        const snapshotRows = db.select({
          id: querySnapshots.id,
          answerMentioned: querySnapshots.answerMentioned,
          answerText: querySnapshots.answerText,
        }).from(querySnapshots)
          .where(inArray(querySnapshots.runId, batchRunIds))
          .all()

        for (const snapshot of snapshotRows) {
          examined++
          const nextValue = determineAnswerMentioned(
            snapshot.answerText,
            project.displayName,
            effectiveDomains({
              canonicalDomain: project.canonicalDomain,
              ownedDomains: parseJsonColumn<string[]>(project.ownedDomains, []),
            }),
          )

          if (nextValue) visible++

          if (snapshot.answerMentioned !== nextValue) {
            db.update(querySnapshots)
              .set({ answerMentioned: nextValue })
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
}

export async function backfillInsightsCommand(
  project: string,
  opts?: { fromRun?: string; toRun?: string; format?: CliFormat },
): Promise<void> {
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

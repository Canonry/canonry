import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { determineAnswerMentioned, effectiveDomains } from '@ainyc/canonry-contracts'
import { loadConfig } from '../config.js'
import type { CliFormat } from '../cli-error.js'

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

  const projectIds = new Set(scopedProjects.map(project => project.id))
  const projectById = new Map(scopedProjects.map(project => [project.id, project]))

  const runRows = db.select({ id: runs.id, projectId: runs.projectId }).from(runs).all()
  const runProjectId = new Map(
    runRows
      .filter(run => projectIds.has(run.projectId))
      .map(run => [run.id, run.projectId]),
  )

  const snapshotRows = db.select({
    id: querySnapshots.id,
    runId: querySnapshots.runId,
    answerMentioned: querySnapshots.answerMentioned,
    answerText: querySnapshots.answerText,
  }).from(querySnapshots).all()

  let examined = 0
  let updated = 0
  let visible = 0
  let skipped = 0

  for (const snapshot of snapshotRows) {
    const projectId = runProjectId.get(snapshot.runId)
    if (!projectId) continue

    const project = projectById.get(projectId)
    if (!project) {
      skipped++
      continue
    }

    examined++
    const nextValue = determineAnswerMentioned(
      snapshot.answerText,
      project.displayName,
      effectiveDomains({
        canonicalDomain: project.canonicalDomain,
        ownedDomains: tryParseJson(project.ownedDomains, [] as string[]),
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

  const result = {
    project: projectFilter ?? null,
    projects: scopedProjects.length,
    examined,
    updated,
    visible,
    skipped,
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
  if (skipped > 0) {
    console.log(`  Skipped:  ${skipped}`)
  }
}

function tryParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

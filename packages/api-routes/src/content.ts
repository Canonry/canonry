import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  buildContentTargetRows,
  buildContentSourceRows,
  buildContentGapRows,
} from '@ainyc/canonry-intelligence'
import {
  contentTargetDismissRequestSchema,
  notFound,
  validationError,
  type ContentGapsResponseDto,
  type ContentSourcesResponseDto,
  type ContentTargetDismissalDto,
  type ContentTargetDismissalsResponseDto,
  type ContentTargetsResponseDto,
} from '@ainyc/canonry-contracts'
import { contentTargetDismissals, type DatabaseClient } from '@ainyc/canonry-db'

import { resolveProject } from './helpers.js'
import { loadOrchestratorInput } from './content-data.js'

/**
 * Load the set of dismissed `targetRef`s for a project. Caller filters
 * orchestrator output through this set so dismissed recommendations don't
 * resurface on the next report load. Exported so `report.ts` can share the
 * same load path (single source of truth for the dismissal filter).
 */
export function loadDismissedTargetRefs(
  db: DatabaseClient,
  projectId: string,
): Set<string> {
  const rows = db
    .select({ targetRef: contentTargetDismissals.targetRef })
    .from(contentTargetDismissals)
    .where(eq(contentTargetDismissals.projectId, projectId))
    .all()
  return new Set(rows.map((r) => r.targetRef))
}

function formatDismissalRow(row: typeof contentTargetDismissals.$inferSelect): ContentTargetDismissalDto {
  return {
    targetRef: row.targetRef,
    addressedUrl: row.addressedUrl,
    note: row.note,
    dismissedAt: row.dismissedAt,
  }
}

export async function contentRoutes(app: FastifyInstance) {
  // GET /projects/:name/content/targets — ranked, action-typed opportunity list
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; ['include-in-progress']?: string }
  }>('/projects/:name/content/targets', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const includeInProgress = request.query['include-in-progress'] === 'true'
    const limit = parseLimitParam(request.query.limit)

    const input = loadOrchestratorInput(app.db, project)
    let rows = buildContentTargetRows(input)
    if (!includeInProgress) {
      rows = rows.filter((r) => r.existingAction === null)
    }
    // Filter persistently-dismissed recommendations. Same filter applied in
    // report.ts so SPA report, HTML report, and this endpoint stay aligned.
    const dismissed = loadDismissedTargetRefs(app.db, project.id)
    if (dismissed.size > 0) {
      rows = rows.filter((r) => !dismissed.has(r.targetRef))
    }
    if (limit !== undefined) {
      rows = rows.slice(0, limit)
    }

    const response: ContentTargetsResponseDto = {
      targets: rows,
      contextMetrics: {
        totalAiReferralSessions: input.totalAiReferralSessions,
        latestRunId: input.latestRunId,
        runTimestamp: input.latestRunTimestamp,
      },
    }
    return response
  })

  // GET /projects/:name/content/sources — URL-level competitive evidence map
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/sources', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentSourceRows(input)

    const response: ContentSourcesResponseDto = {
      sources: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })

  // GET /projects/:name/content/gaps — competitor-only-cited queries
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/gaps', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const input = loadOrchestratorInput(app.db, project)
    const rows = buildContentGapRows(input)

    const response: ContentGapsResponseDto = {
      gaps: rows,
      latestRunId: input.latestRunId,
    }
    return response
  })

  // GET /projects/:name/content/dismissals — list current dismissals
  app.get<{
    Params: { name: string }
  }>('/projects/:name/content/dismissals', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(contentTargetDismissals)
      .where(eq(contentTargetDismissals.projectId, project.id))
      .orderBy(contentTargetDismissals.dismissedAt)
      .all()
    const response: ContentTargetDismissalsResponseDto = {
      dismissals: rows.map(formatDismissalRow),
    }
    return response
  })

  // POST /projects/:name/content/dismissals — mark a recommendation addressed
  app.post<{
    Params: { name: string }
    Body: unknown
  }>('/projects/:name/content/dismissals', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = contentTargetDismissRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
    }
    const { targetRef, addressedUrl, note } = parsed.data
    const now = new Date().toISOString()

    // Idempotent upsert by (project_id, target_ref). Re-dismissing the same
    // ref overwrites addressed_url/note and refreshes dismissed_at so the
    // audit trail reflects the most recent action. Drizzle's
    // onConflictDoUpdate keeps this single-statement.
    app.db
      .insert(contentTargetDismissals)
      .values({
        id: crypto.randomUUID(),
        projectId: project.id,
        targetRef,
        addressedUrl: addressedUrl ?? null,
        note: note ?? null,
        dismissedAt: now,
      })
      .onConflictDoUpdate({
        target: [contentTargetDismissals.projectId, contentTargetDismissals.targetRef],
        set: {
          addressedUrl: addressedUrl ?? null,
          note: note ?? null,
          dismissedAt: now,
        },
      })
      .run()

    const row = app.db
      .select()
      .from(contentTargetDismissals)
      .where(and(
        eq(contentTargetDismissals.projectId, project.id),
        eq(contentTargetDismissals.targetRef, targetRef),
      ))
      .get()
    // `row` is non-null by construction — we just upserted it. The guard is
    // defensive against a deletion race; in practice the only way it returns
    // null is a CASCADE from a concurrent project delete.
    if (!row) throw notFound('contentTargetDismissal', targetRef)
    return formatDismissalRow(row)
  })

  // DELETE /projects/:name/content/dismissals/:targetRef — un-dismiss
  app.delete<{
    Params: { name: string; targetRef: string }
  }>('/projects/:name/content/dismissals/:targetRef', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const { targetRef } = request.params
    const result = app.db
      .delete(contentTargetDismissals)
      .where(and(
        eq(contentTargetDismissals.projectId, project.id),
        eq(contentTargetDismissals.targetRef, targetRef),
      ))
      .run()
    if (result.changes === 0) {
      throw notFound('contentTargetDismissal', targetRef)
    }
    return reply.status(204).send()
  })
}

function parseLimitParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw validationError('"limit" must be a non-negative integer')
  }
  return parsed
}

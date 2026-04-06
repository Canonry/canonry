import { eq, desc, and } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { insights, healthSnapshots, parseJsonColumn } from '@ainyc/canonry-db'
import { notFound, type InsightDto, type HealthSnapshotDto } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'

function mapInsightRow(r: typeof insights.$inferSelect): InsightDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    type: r.type as InsightDto['type'],
    severity: r.severity as InsightDto['severity'],
    title: r.title,
    keyword: r.keyword,
    provider: r.provider,
    recommendation: parseJsonColumn<InsightDto['recommendation']>(r.recommendation, undefined),
    cause: parseJsonColumn<InsightDto['cause']>(r.cause, undefined),
    dismissed: r.dismissed,
    createdAt: r.createdAt,
  }
}

function mapHealthRow(r: typeof healthSnapshots.$inferSelect): HealthSnapshotDto {
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId ?? null,
    overallCitedRate: Number(r.overallCitedRate),
    totalPairs: r.totalPairs,
    citedPairs: r.citedPairs,
    providerBreakdown: parseJsonColumn<HealthSnapshotDto['providerBreakdown']>(r.providerBreakdown, {}),
    createdAt: r.createdAt,
  }
}

export async function intelligenceRoutes(app: FastifyInstance) {
  // GET /projects/:name/insights — list insights for a project
  app.get<{
    Params: { name: string }
    Querystring: { dismissed?: string; runId?: string }
  }>('/projects/:name/insights', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const conditions = [eq(insights.projectId, project.id)]
    if (request.query.runId) {
      conditions.push(eq(insights.runId, request.query.runId))
    }

    const rows = app.db
      .select()
      .from(insights)
      .where(conditions.length === 1 ? conditions[0]! : and(...conditions))
      .orderBy(desc(insights.createdAt))
      .all()

    const showDismissed = request.query.dismissed === 'true'

    const result: InsightDto[] = rows
      .filter(r => showDismissed || !r.dismissed)
      .map(mapInsightRow)

    return reply.send(result)
  })

  // GET /projects/:name/insights/:id — get a single insight
  app.get<{
    Params: { name: string; id: string }
  }>('/projects/:name/insights/:id', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const row = app.db
      .select()
      .from(insights)
      .where(eq(insights.id, request.params.id))
      .get()

    if (!row || row.projectId !== project.id) {
      throw notFound('Insight', request.params.id)
    }

    return reply.send(mapInsightRow(row))
  })

  // POST /projects/:name/insights/:id/dismiss — dismiss an insight
  app.post<{
    Params: { name: string; id: string }
  }>('/projects/:name/insights/:id/dismiss', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const row = app.db
      .select()
      .from(insights)
      .where(eq(insights.id, request.params.id))
      .get()

    if (!row || row.projectId !== project.id) {
      throw notFound('Insight', request.params.id)
    }

    app.db
      .update(insights)
      .set({ dismissed: true })
      .where(eq(insights.id, request.params.id))
      .run()

    return reply.send({ ok: true })
  })

  // GET /projects/:name/health/latest — latest health snapshot
  app.get<{
    Params: { name: string }
  }>('/projects/:name/health/latest', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const row = app.db
      .select()
      .from(healthSnapshots)
      .where(eq(healthSnapshots.projectId, project.id))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(1)
      .get()

    if (!row) {
      throw notFound('Health data for project', request.params.name)
    }

    return reply.send(mapHealthRow(row))
  })

  // GET /projects/:name/health/history — health snapshot history
  app.get<{
    Params: { name: string }
    Querystring: { limit?: string }
  }>('/projects/:name/health/history', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const limit = request.query.limit ? Math.min(Number(request.query.limit), 100) : 30

    const rows = app.db
      .select()
      .from(healthSnapshots)
      .where(eq(healthSnapshots.projectId, project.id))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(limit)
      .all()

    return reply.send(rows.map(mapHealthRow))
  })
}

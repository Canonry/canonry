import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors } from '@ainyc/canonry-db'
import { competitorBatchRequestSchema, validationError } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export async function competitorRoutes(app: FastifyInstance) {
  // GET /projects/:name/competitors
  app.get<{ Params: { name: string } }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, domain: r.domain, createdAt: r.createdAt })))
  })

  // PUT /projects/:name/competitors — replace all
  app.put<{
    Params: { name: string }
    Body: { competitors: string[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.competitors)) {
      throw validationError('Body must contain a "competitors" array')
    }

    const now = new Date().toISOString()

    // Atomic replace: delete + insert in a single transaction
    app.db.transaction((tx) => {
      tx.delete(competitors).where(eq(competitors.projectId, project.id)).run()

      for (const domain of body.competitors) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          domain,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: { competitors: body.competitors },
      })
    })

    const rows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, domain: r.domain, createdAt: r.createdAt })))
  })

  // POST /projects/:name/competitors — append (skip duplicates)
  app.post<{
    Params: { name: string }
    Body: { competitors: string[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseCompetitorBatch(request.body)

    const now = new Date().toISOString()
    const requested = uniqueStrings(body.competitors)

    app.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
      const existingSet = new Set(existing.map(c => c.domain))
      const added = requested.filter(domain => !existingSet.has(domain))

      if (added.length === 0) return

      for (const domain of added) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          domain,
          createdAt: now,
        }).onConflictDoNothing({
          target: [competitors.projectId, competitors.domain],
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.appended',
        entityType: 'competitor',
        diff: { added },
      })
    })

    const rows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, domain: r.domain, createdAt: r.createdAt })))
  })

  // DELETE /projects/:name/competitors — remove specific competitors
  app.delete<{
    Params: { name: string }
    Body: { competitors: string[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseCompetitorBatch(request.body)

    const requested = new Set(uniqueStrings(body.competitors))

    app.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
      const rowsToDelete = existing.filter(c => requested.has(c.domain))

      if (rowsToDelete.length === 0) return

      for (const row of rowsToDelete) {
        tx.delete(competitors).where(eq(competitors.id, row.id)).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.deleted',
        entityType: 'competitor',
        diff: { deleted: rowsToDelete.map(row => row.domain) },
      })
    })

    const rows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, domain: r.domain, createdAt: r.createdAt })))
  })
}

function parseCompetitorBatch(value: unknown) {
  const result = competitorBatchRequestSchema.safeParse(value)
  if (result.success) return result.data
  throw validationError('Invalid competitor batch request', {
    issues: result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

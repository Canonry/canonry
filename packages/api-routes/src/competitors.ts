import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors } from '@ainyc/canonry-db'
import { validationError } from '@ainyc/canonry-contracts'
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
}

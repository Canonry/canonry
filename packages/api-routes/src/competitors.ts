import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors } from '@ainyc/aeo-platform-db'
import { validationError } from '@ainyc/aeo-platform-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export async function competitorRoutes(app: FastifyInstance) {
  // GET /projects/:name/competitors
  app.get<{ Params: { name: string } }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return
    const rows = app.db.select().from(competitors).where(eq(competitors.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, domain: r.domain, createdAt: r.createdAt })))
  })

  // PUT /projects/:name/competitors — replace all
  app.put<{
    Params: { name: string }
    Body: { competitors: string[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProjectSafe(app, request.params.name, reply)
    if (!project) return

    const body = request.body
    if (!body || !Array.isArray(body.competitors)) {
      const err = validationError('Body must contain a "competitors" array')
      return reply.status(err.statusCode).send(err.toJSON())
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

function resolveProjectSafe(app: FastifyInstance, name: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  try {
    return resolveProject(app.db, name)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e && 'toJSON' in e) {
      const err = e as { statusCode: number; toJSON(): unknown }
      reply.status(err.statusCode).send(err.toJSON())
      return null
    }
    throw e
  }
}

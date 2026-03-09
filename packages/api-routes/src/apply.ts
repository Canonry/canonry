import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { projects, keywords, competitors } from '@ainyc/aeo-platform-db'
import { projectConfigSchema, validationError } from '@ainyc/aeo-platform-contracts'
import { writeAuditLog } from './helpers.js'

export async function applyRoutes(app: FastifyInstance) {
  // POST /apply — accept a canonry.yaml body (JSON-parsed version)
  app.post('/apply', async (request, reply) => {
    const parsed = projectConfigSchema.safeParse(request.body)
    if (!parsed.success) {
      const err = validationError('Invalid project config', {
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      })
      return reply.status(err.statusCode).send(err.toJSON())
    }

    const config = parsed.data
    const now = new Date().toISOString()
    const name = config.metadata.name

    // Upsert project
    const existing = app.db.select().from(projects).where(eq(projects.name, name)).get()

    let projectId: string
    if (existing) {
      projectId = existing.id
      app.db.update(projects).set({
        displayName: config.spec.displayName,
        canonicalDomain: config.spec.canonicalDomain,
        country: config.spec.country,
        language: config.spec.language,
        labels: JSON.stringify(config.metadata.labels),
        configSource: 'config-file',
        configRevision: existing.configRevision + 1,
        updatedAt: now,
      }).where(eq(projects.id, existing.id)).run()

      writeAuditLog(app.db, {
        projectId,
        actor: 'api',
        action: 'project.applied',
        entityType: 'project',
        entityId: projectId,
      })
    } else {
      projectId = crypto.randomUUID()
      app.db.insert(projects).values({
        id: projectId,
        name,
        displayName: config.spec.displayName,
        canonicalDomain: config.spec.canonicalDomain,
        country: config.spec.country,
        language: config.spec.language,
        tags: '[]',
        labels: JSON.stringify(config.metadata.labels),
        configSource: 'config-file',
        configRevision: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      writeAuditLog(app.db, {
        projectId,
        actor: 'api',
        action: 'project.created',
        entityType: 'project',
        entityId: projectId,
      })
    }

    // Atomic replace: keywords + competitors in a single transaction
    app.db.transaction((tx) => {
      tx.delete(keywords).where(eq(keywords.projectId, projectId)).run()
      for (const kw of config.spec.keywords) {
        tx.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId,
          keyword: kw,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'keywords.replaced',
        entityType: 'keyword',
        diff: { keywords: config.spec.keywords },
      })

      tx.delete(competitors).where(eq(competitors.projectId, projectId)).run()
      for (const domain of config.spec.competitors) {
        tx.insert(competitors).values({
          id: crypto.randomUUID(),
          projectId,
          domain,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: { competitors: config.spec.competitors },
      })
    })

    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()!
    return reply.status(200).send({
      id: project.id,
      name: project.name,
      displayName: project.displayName,
      canonicalDomain: project.canonicalDomain,
      country: project.country,
      language: project.language,
      tags: JSON.parse(project.tags) as string[],
      labels: JSON.parse(project.labels) as Record<string, string>,
      configSource: project.configSource,
      configRevision: project.configRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })
  })
}

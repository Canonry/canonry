import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { keywords } from '@ainyc/canonry-db'
import { validationError, notImplemented } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface KeywordRoutesOptions {
  onGenerateKeywords?: (provider: string, count: number, project: {
    domain: string; displayName?: string; country: string; language: string; existingKeywords: string[]
  }) => Promise<string[]>
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function keywordRoutes(app: FastifyInstance, opts: KeywordRoutesOptions) {
  // GET /projects/:name/keywords
  app.get<{ Params: { name: string } }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })

  // PUT /projects/:name/keywords — replace all (declarative)
  app.put<{
    Params: { name: string }
    Body: { keywords: string[] }
  }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.keywords)) {
      throw validationError('Body must contain a "keywords" array')
    }

    const now = new Date().toISOString()

    // Atomic replace: delete + insert in a single transaction
    app.db.transaction((tx) => {
      tx.delete(keywords).where(eq(keywords.projectId, project.id)).run()

      for (const kw of body.keywords) {
        tx.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          keyword: kw,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'keywords.replaced',
        entityType: 'keyword',
        diff: { keywords: body.keywords },
      })
    })

    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })

  // DELETE /projects/:name/keywords — remove specific keywords
  app.delete<{
    Params: { name: string }
    Body: { keywords: string[] }
  }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.keywords) || body.keywords.length === 0) {
      throw validationError('Body must contain a non-empty "keywords" array')
    }

    const existing = app.db
      .select()
      .from(keywords)
      .where(eq(keywords.projectId, project.id))
      .all()

    const toDelete = new Set(body.keywords)
    const idsToDelete = existing.filter(k => toDelete.has(k.keyword)).map(k => k.id)

    if (idsToDelete.length > 0) {
      app.db.transaction((tx) => {
        for (const id of idsToDelete) {
          tx.delete(keywords).where(eq(keywords.id, id)).run()
        }

        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'keywords.deleted',
          entityType: 'keyword',
          diff: { deleted: body.keywords.filter(kw => existing.some(e => e.keyword === kw)) },
        })
      })
    }

    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })

  // POST /projects/:name/keywords — append (skip duplicates)
  app.post<{
    Params: { name: string }
    Body: { keywords: string[] }
  }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.keywords)) {
      throw validationError('Body must contain a "keywords" array')
    }

    const now = new Date().toISOString()
    const existing = app.db
      .select()
      .from(keywords)
      .where(eq(keywords.projectId, project.id))
      .all()
    const existingSet = new Set(existing.map(k => k.keyword))

    const added: string[] = []
    for (const kw of body.keywords) {
      if (!existingSet.has(kw)) {
        app.db.insert(keywords).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          keyword: kw,
          createdAt: now,
        }).run()
        added.push(kw)
        existingSet.add(kw)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'keywords.appended',
        entityType: 'keyword',
        diff: { added },
      })
    }

    const rows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.keyword, createdAt: r.createdAt })))
  })
  // POST /projects/:name/keywords/generate — auto-generate keyword suggestions
  app.post<{
    Params: { name: string }
    Body: { provider: string; count?: number }
  }>('/projects/:name/keywords/generate', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body?.provider || typeof body.provider !== 'string') {
      throw validationError('Body must contain a "provider" string')
    }

    const provider = body.provider.trim().toLowerCase()
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && !validNames.includes(provider)) {
      throw validationError(`Unknown provider "${body.provider}". Valid providers: ${validNames.join(', ')}`, {
        provider: body.provider,
        validProviders: validNames,
      })
    }
    if (body.count !== undefined && (typeof body.count !== 'number' || !Number.isFinite(body.count) || !Number.isInteger(body.count))) {
      throw validationError('"count" must be an integer')
    }
    const count = Math.min(Math.max(body.count ?? 5, 1), 20)

    if (!opts.onGenerateKeywords) {
      throw notImplemented('Key phrase generation is not supported in this deployment')
    }

    const existingRows = app.db.select().from(keywords).where(eq(keywords.projectId, project.id)).all()
    const existingKeywords = existingRows.map(r => r.keyword)

    try {
      const generated = await opts.onGenerateKeywords(provider, count, {
        domain: project.canonicalDomain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingKeywords,
      })
      return reply.send({ keywords: generated, provider })
    } catch (err) {
      request.log.error({ err }, 'Key phrase generation failed')
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Failed to generate key phrases',
        },
      })
    }
  })
}

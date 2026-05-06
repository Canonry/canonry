import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { queries } from '@ainyc/canonry-db'
import { keywordGenerateRequestSchema, queryGenerateRequestSchema, validationError, notImplemented, internalError } from '@ainyc/canonry-contracts'
import { resolveProject, writeAuditLog } from './helpers.js'

export interface QueryRoutesOptions {
  onGenerateQueries?: (provider: string, count: number, project: {
    domain: string; displayName?: string; country: string; language: string; existingQueries: string[]
  }) => Promise<string[]>
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

export async function queryRoutes(app: FastifyInstance, opts: QueryRoutesOptions) {
  // GET /projects/:name/queries
  app.get<{ Params: { name: string } }>('/projects/:name/queries', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  // PUT /projects/:name/queries — replace all (declarative)
  app.put<{
    Params: { name: string }
    Body: { queries: string[] }
  }>('/projects/:name/queries', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.queries)) {
      throw validationError('Body must contain a "queries" array')
    }

    const now = new Date().toISOString()

    // Atomic replace: delete + insert in a single transaction
    app.db.transaction((tx) => {
      tx.delete(queries).where(eq(queries.projectId, project.id)).run()

      for (const q of body.queries) {
        tx.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: q,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.queries },
      })
    })

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  // DELETE /projects/:name/queries — remove specific queries
  app.delete<{
    Params: { name: string }
    Body: { queries: string[] }
  }>('/projects/:name/queries', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.queries) || body.queries.length === 0) {
      throw validationError('Body must contain a non-empty "queries" array')
    }

    const existing = app.db
      .select()
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    const toDelete = new Set(body.queries)
    const idsToDelete = existing.filter(q => toDelete.has(q.query)).map(q => q.id)

    if (idsToDelete.length > 0) {
      app.db.transaction((tx) => {
        for (const id of idsToDelete) {
          tx.delete(queries).where(eq(queries.id, id)).run()
        }

        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'queries.deleted',
          entityType: 'query',
          diff: { deleted: body.queries.filter(q => existing.some(e => e.query === q)) },
        })
      })
    }

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  // POST /projects/:name/queries — append (skip duplicates)
  app.post<{
    Params: { name: string }
    Body: { queries: string[] }
  }>('/projects/:name/queries', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.queries)) {
      throw validationError('Body must contain a "queries" array')
    }

    const now = new Date().toISOString()
    const existing = app.db
      .select()
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const existingSet = new Set(existing.map(q => q.query))

    const added: string[] = []
    for (const q of body.queries) {
      if (!existingSet.has(q)) {
        app.db.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: q,
          createdAt: now,
        }).run()
        added.push(q)
        existingSet.add(q)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.appended',
        entityType: 'query',
        diff: { added },
      })
    }

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })
  // POST /projects/:name/queries/generate — auto-generate query suggestions
  app.post<{
    Params: { name: string }
    Body: { provider: string; count?: number }
  }>('/projects/:name/queries/generate', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = queryGenerateRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid query generation request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    const body = parsed.data
    const provider = body.provider.trim().toLowerCase()
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && !validNames.includes(provider)) {
      throw validationError(`Unknown provider "${body.provider}". Valid providers: ${validNames.join(', ')}`, {
        provider: body.provider,
        validProviders: validNames,
      })
    }
    const count = body.count ?? 5

    if (!opts.onGenerateQueries) {
      throw notImplemented('Query generation is not supported in this deployment')
    }

    const existingRows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    const existingQueries = existingRows.map(r => r.query)

    try {
      const generated = await opts.onGenerateQueries(provider, count, {
        domain: project.canonicalDomain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingQueries,
      })
      return reply.send({ queries: generated, provider })
    } catch (err) {
      request.log.error({ err }, 'Query generation failed')
      throw internalError(err instanceof Error ? err.message : 'Failed to generate queries')
    }
  })

  // Legacy aliases for pre-queries API clients. These keep old clients working
  // while storing everything in the canonical queries table.
  app.get<{ Params: { name: string } }>('/projects/:name/keywords', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.query, createdAt: r.createdAt })))
  })

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

    app.db.transaction((tx) => {
      tx.delete(queries).where(eq(queries.projectId, project.id)).run()

      for (const keyword of body.keywords) {
        tx.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: keyword,
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.keywords },
      })
    })

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.query, createdAt: r.createdAt })))
  })

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
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    const toDelete = new Set(body.keywords)
    const idsToDelete = existing.filter(q => toDelete.has(q.query)).map(q => q.id)

    if (idsToDelete.length > 0) {
      app.db.transaction((tx) => {
        for (const id of idsToDelete) {
          tx.delete(queries).where(eq(queries.id, id)).run()
        }

        writeAuditLog(tx, {
          projectId: project.id,
          actor: 'api',
          action: 'queries.deleted',
          entityType: 'query',
          diff: { deleted: body.keywords.filter(keyword => existing.some(e => e.query === keyword)) },
        })
      })
    }

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.query, createdAt: r.createdAt })))
  })

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
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
    const existingSet = new Set(existing.map(q => q.query))

    const added: string[] = []
    for (const keyword of body.keywords) {
      if (!existingSet.has(keyword)) {
        app.db.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: keyword,
          createdAt: now,
        }).run()
        added.push(keyword)
        existingSet.add(keyword)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.appended',
        entityType: 'query',
        diff: { added },
      })
    }

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, keyword: r.query, createdAt: r.createdAt })))
  })

  app.post<{
    Params: { name: string }
    Body: { provider: string; count?: number }
  }>('/projects/:name/keywords/generate', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const parsed = keywordGenerateRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid keyword generation request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    const body = parsed.data
    const provider = body.provider.trim().toLowerCase()
    const validNames = opts.validProviderNames ?? []
    if (validNames.length && !validNames.includes(provider)) {
      throw validationError(`Unknown provider "${body.provider}". Valid providers: ${validNames.join(', ')}`, {
        provider: body.provider,
        validProviders: validNames,
      })
    }
    const count = body.count ?? 5

    if (!opts.onGenerateQueries) {
      throw notImplemented('Keyword generation is not supported in this deployment')
    }

    const existingRows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    const existingQueries = existingRows.map(r => r.query)

    try {
      const generated = await opts.onGenerateQueries(provider, count, {
        domain: project.canonicalDomain,
        displayName: project.displayName,
        country: project.country,
        language: project.language,
        existingQueries,
      })
      return reply.send({ keywords: generated, provider })
    } catch (err) {
      request.log.error({ err }, 'Keyword generation failed')
      throw internalError(err instanceof Error ? err.message : 'Failed to generate keywords')
    }
  })
}

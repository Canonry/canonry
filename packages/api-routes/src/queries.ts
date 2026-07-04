import crypto from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { queries, querySnapshots } from '@ainyc/canonry-db'
import { keywordGenerateRequestSchema, queryGenerateRequestSchema, validationError, notImplemented, internalError, notFound } from '@ainyc/canonry-contracts'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'

export interface QueryRoutesOptions {
  onGenerateQueries?: (provider: string, count: number, project: {
    domain: string; displayName?: string; country: string; language: string; existingQueries: string[]
  }) => Promise<string[]>
  /** Valid provider names from registered adapters — used to reject unknown providers */
  validProviderNames?: string[]
}

/**
 * Pre-delete safety net: copy each query's `query` text into the
 * `query_text` column on every snapshot that references it. Snapshots
 * inserted since ~2026-04-08 already carry their `query_text` (the
 * job-runner populates it at insert time), so this is a no-op for new
 * data; the value is in covering ANY snapshot that somehow ended up
 * with NULL `query_text` (older inserts, manual fixups, future code
 * paths that forget). After this, deleting the query row sets
 * `query_id` to NULL via the FK but leaves `query_text` intact — so
 * the timeline endpoint's text-fallback can still attribute the
 * snapshot if a query with the same text exists later.
 *
 * Without this safeguard, `query replace` / `query remove` permanently
 * detaches the historical record from any query name — exactly the
 * azcoatings bug recovered by `cnry backfill snapshot-attribution`.
 *
 * Pass `queryIds` to scope to a specific subset; omit to cover every
 * query in the project (used by the full-replace path).
 */
function preserveSnapshotQueryText(
  tx: Pick<DatabaseClient, 'select' | 'update'>,
  projectId: string,
  queryIds?: string[],
): void {
  const candidates = queryIds && queryIds.length > 0
    ? tx.select({ id: queries.id, text: queries.query })
        .from(queries)
        .where(inArray(queries.id, queryIds))
        .all()
    : tx.select({ id: queries.id, text: queries.query })
        .from(queries)
        .where(eq(queries.projectId, projectId))
        .all()
  for (const q of candidates) {
    tx.update(querySnapshots)
      .set({ queryText: q.text })
      .where(eq(querySnapshots.queryId, q.id))
      .run()
  }
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

    // Atomic replace: delete + insert in a single transaction. Before
    // deleting, we denormalize `query_text` onto every snapshot that
    // references the about-to-be-deleted queries — so the FK going to
    // NULL doesn't lose attribution. (For snapshots created since
    // ~2026-04-08 the column is already populated at insert time; this
    // pre-delete fill is the safety net for any code path that might
    // have missed it.) See `cnry backfill snapshot-attribution` for the
    // recovery path when this safety net wasn't yet in place.
    app.db.transaction((tx) => {
      preserveSnapshotQueryText(tx, project.id)
      tx.delete(queries).where(eq(queries.projectId, project.id)).run()

      for (const q of body.queries) {
        tx.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: q,
          provenance: 'cli',
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.queries },
      }))
    })

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  app.post<{
    Params: { name: string }
    Body: { queries: string[] }
  }>('/projects/:name/queries/replace-preview', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const body = request.body
    if (!body || !Array.isArray(body.queries)) {
      throw validationError('Body must contain a "queries" array')
    }

    const currentRows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    const currentTexts = currentRows.map(r => r.query)
    const currentSet = new Set(currentTexts)
    const proposedSet = new Set(body.queries)

    const removed = currentTexts.filter(q => !proposedSet.has(q))
    const added = body.queries.filter(q => !currentSet.has(q))
    const unchanged = currentTexts.filter(q => proposedSet.has(q))

    // Replace wipes every queries row and re-inserts with fresh UUIDs, so
    // every existing snapshot for this project's queries gets detached
    // (queryId → NULL). queryText preserves the snapshot's self-description.
    const currentIds = currentRows.map(r => r.id)
    let snapshotsDetached = 0
    let affectedQueries = 0
    if (currentIds.length > 0) {
      const snapshotCount = app.db
        .select({ n: sql<number>`count(*)` })
        .from(querySnapshots)
        .where(inArray(querySnapshots.queryId, currentIds))
        .get()
      snapshotsDetached = snapshotCount?.n ?? 0
      const distinctAffected = app.db
        .select({ n: sql<number>`count(distinct ${querySnapshots.queryId})` })
        .from(querySnapshots)
        .where(inArray(querySnapshots.queryId, currentIds))
        .get()
      affectedQueries = distinctAffected?.n ?? 0
    }

    return reply.send({
      project: { id: project.id, name: project.name },
      current: currentTexts,
      proposed: body.queries,
      diff: { added, removed, unchanged },
      snapshotImpact: { affectedQueries, snapshotsDetached },
    })
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
        // Preserve query_text on associated snapshots before the FK
        // detaches. See queries.replaced handler above for rationale.
        preserveSnapshotQueryText(tx, project.id, idsToDelete)
        for (const id of idsToDelete) {
          tx.delete(queries).where(eq(queries.id, id)).run()
        }

        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'queries.deleted',
          entityType: 'query',
          diff: { deleted: body.queries.filter(q => existing.some(e => e.query === q)) },
        }))
      })
    }

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  // DELETE /projects/:name/queries/:id — remove one query by row id.
  app.delete<{
    Params: { name: string; id: string }
  }>('/projects/:name/queries/:id', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const query = app.db
      .select()
      .from(queries)
      .where(and(eq(queries.projectId, project.id), eq(queries.id, request.params.id)))
      .get()

    if (!query) {
      throw notFound('Query', request.params.id)
    }

    app.db.transaction((tx) => {
      // Preserve query_text on associated snapshots before the FK detaches.
      preserveSnapshotQueryText(tx, project.id, [query.id])
      tx.delete(queries).where(eq(queries.id, query.id)).run()

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.deleted',
        entityType: 'query',
        entityId: query.id,
        diff: { deleted: [query.query] },
      }))
    })

    return reply.status(204).send()
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
          provenance: 'cli',
          createdAt: now,
        }).run()
        added.push(q)
        existingSet.add(q)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.appended',
        entityType: 'query',
        diff: { added },
      }))
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
      preserveSnapshotQueryText(tx, project.id)
      tx.delete(queries).where(eq(queries.projectId, project.id)).run()

      for (const keyword of body.keywords) {
        tx.insert(queries).values({
          id: crypto.randomUUID(),
          projectId: project.id,
          query: keyword,
          provenance: 'cli',
          createdAt: now,
        }).run()
      }

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.keywords },
      }))
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
        preserveSnapshotQueryText(tx, project.id, idsToDelete)
        for (const id of idsToDelete) {
          tx.delete(queries).where(eq(queries.id, id)).run()
        }

        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'queries.deleted',
          entityType: 'query',
          diff: { deleted: body.keywords.filter(keyword => existing.some(e => e.query === keyword)) },
        }))
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
          provenance: 'cli',
          createdAt: now,
        }).run()
        added.push(keyword)
        existingSet.add(keyword)
      }
    }

    if (added.length > 0) {
      writeAuditLog(app.db, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.appended',
        entityType: 'query',
        diff: { added },
      }))
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

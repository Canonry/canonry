import crypto from 'node:crypto'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { measurementPlanDrafts, measurementPlans, measurementQuerySetItems, queries, querySnapshots, runs } from '@ainyc/canonry-db'
import { AppError, RunKinds, RunStatuses, alreadyExists, classifyProviderErrorMessage, describeError, internalError, keywordGenerateRequestSchema, normalizeQueryText, notFound, notImplemented, providerAuthError, providerError, queryGenerateRequestSchema, queryReplaceRequestSchema, quotaExceeded, runInProgress, validationError } from '@ainyc/canonry-contracts'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { assertQueryCatalogMutationAllowed, changedQueryIdsForReplace, diffProjectQueries, preserveSnapshotQueryText, replaceProjectQueries } from './query-replace.js'

/**
 * Turn a raw provider failure into an error that keeps its KIND.
 *
 * Generation calls an answer provider, so its failures are provider failures:
 * a bad key, a rate limit, a dropped connection. Collapsing all of them into
 * `INTERNAL_ERROR` left the dashboard unable to tell the caller what to do,
 * and left the onboarding funnel recording `unknown` for every block on the
 * step with the worst recovery. An `AppError` thrown from deeper in the stack
 * already carries a meaningful code and is passed through untouched.
 */
function generationFailure(err: unknown, fallbackMessage: string): AppError {
  if (err instanceof AppError) return err
  const message = err instanceof Error ? describeError(err) : fallbackMessage
  switch (classifyProviderErrorMessage(message)) {
    case 'PROVIDER_AUTH':
      return providerAuthError(message)
    case 'RATE_LIMITED':
      return quotaExceeded('provider requests', { message })
    case 'NETWORK':
    case 'TIMEOUT':
      return providerError(message)
    // A malformed provider response and an unrecognized failure are both ours
    // to explain, not the caller's to retry.
    case 'PARSE_ERROR':
    case 'UNKNOWN':
      return internalError(message)
  }
}

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

    // Atomic replace in a single transaction. Unchanged texts keep their
    // EXISTING rows (query row ids anchor every historical snapshot's FK);
    // only genuinely removed rows are deleted — after the query_text
    // safety net stamps their text onto any referencing snapshot. See
    // `cnry backfill snapshot-attribution` for the recovery path when
    // this safety net wasn't yet in place.
    app.db.transaction((tx) => {
      replaceProjectQueries(tx, { projectId: project.id, projectName: project.name }, body.queries, now)

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.queries },
      }))
    }, { behavior: 'immediate' })

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

    // Report exactly what the replace will do: the SAME diff that
    // replaceProjectQueries executes. Kept rows retain their ids (their
    // snapshots stay attached), same-normalized-text duplicates reparent onto
    // the kept row, and only genuinely removed rows detach their snapshots
    // (queryId → NULL; queryText preserves the snapshot's self-description).
    const diff = diffProjectQueries(
      currentRows.map(r => ({ id: r.id, text: r.query })),
      body.queries,
    )
    assertQueryCatalogMutationAllowed(
      app.db,
      { projectId: project.id, projectName: project.name },
      changedQueryIdsForReplace(diff),
    )
    const removed = diff.removed.map(r => r.text)
    const added = diff.insertedTexts
    const unchanged = diff.kept.map(k => k.currentText)

    const removedIds = diff.removed.map(r => r.id)
    let snapshotsDetached = 0
    let affectedQueries = 0
    if (removedIds.length > 0) {
      const snapshotCount = app.db
        .select({ n: sql<number>`count(*)` })
        .from(querySnapshots)
        .where(inArray(querySnapshots.queryId, removedIds))
        .get()
      snapshotsDetached = snapshotCount?.n ?? 0
      const distinctAffected = app.db
        .select({ n: sql<number>`count(distinct ${querySnapshots.queryId})` })
        .from(querySnapshots)
        .where(inArray(querySnapshots.queryId, removedIds))
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

    app.db.transaction((tx) => {
      const existing = tx.select()
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
      const toDelete = new Set(body.queries)
      const idsToDelete = existing.filter(q => toDelete.has(q.query)).map(q => q.id)
      assertQueryCatalogMutationAllowed(
        tx,
        { projectId: project.id, projectName: project.name },
        idsToDelete,
      )

      if (idsToDelete.length > 0) {
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
      }
    }, { behavior: 'immediate' })

    const rows = app.db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    return reply.send(rows.map(r => ({ id: r.id, query: r.query, createdAt: r.createdAt })))
  })

  // DELETE /projects/:name/queries/:id — remove one query by row id.
  app.delete<{
    Params: { name: string; id: string }
  }>('/projects/:name/queries/:id', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    app.db.transaction((tx) => {
      const query = tx.select()
        .from(queries)
        .where(and(eq(queries.projectId, project.id), eq(queries.id, request.params.id)))
        .get()
      if (!query) throw notFound('Query', request.params.id)
      assertQueryCatalogMutationAllowed(
        tx,
        { projectId: project.id, projectName: project.name },
        [query.id],
      )

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
    }, { behavior: 'immediate' })

    return reply.status(204).send()
  })

  // POST /projects/:name/queries/:id/replace — guarded, simple-mode only.
  // A semantic wording change deliberately mints a new catalog identity:
  // historical snapshots remain attached to their frozen text, never to a
  // later question that happens to occupy the same row id.
  app.post<{
    Params: { name: string; id: string }
    Body: unknown
  }>('/projects/:name/queries/:id/replace', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = queryReplaceRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid query replacement request', {
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    const body = parsed.data

    const replacement = app.db.transaction((tx) => {
      const source = tx.select().from(queries).where(and(
        eq(queries.projectId, project.id),
        eq(queries.id, request.params.id),
      )).get()
      if (!source) throw notFound('Query', request.params.id)

      // Compare the exact stored text, rather than its normalized form. This
      // stops a stale tab from replacing a query whose wording another
      // operator has already changed.
      if (source.query !== body.expectedQuery) {
        throw validationError('This query changed before the replacement could be saved. Reload and try again.', {
          reason: 'QUERY_TEXT_STALE',
          displayToOperator: 'Reload the tracked queries, then apply this wording change again.',
        })
      }

      // A generic catalog mutation must never bypass published-plan or draft
      // authoring. Both rows are checked in the same immediate transaction as
      // the source CAS and write.
      const activePlan = tx.select({ projectId: measurementPlans.projectId })
        .from(measurementPlans)
        .where(eq(measurementPlans.projectId, project.id))
        .get()
      const draft = tx.select({ projectId: measurementPlanDrafts.projectId })
        .from(measurementPlanDrafts)
        .where(eq(measurementPlanDrafts.projectId, project.id))
        .get()
      if (activePlan || draft) {
        throw validationError(
          'This tracked query is managed by a measurement plan or draft. Edit it in the measurement workspace, then publish the draft.',
          { displayToOperator: 'Use the measurement workspace to edit this query safely.' },
        )
      }

      const activeRun = tx.select({ id: runs.id })
        .from(runs)
        .where(and(
          eq(runs.projectId, project.id),
          eq(runs.kind, RunKinds['answer-visibility']),
          inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
        ))
        .get()
      if (activeRun) throw runInProgress(project.name)

      // Case/spacing-only input describes the existing question. It is a
      // true no-op: keep identity, provenance, history, and query-set edges.
      if (normalizeQueryText(source.query) === normalizeQueryText(body.query)) {
        return { id: source.id, query: source.query, createdAt: source.createdAt }
      }

      // The database unique index is raw-text only; reject a semantic
      // collision instead of merging histories or silently reusing another
      // operator's catalog identity.
      const collision = tx.select({ id: queries.id, query: queries.query })
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
        .find(row => row.id !== source.id && normalizeQueryText(row.query) === normalizeQueryText(body.query))
      if (collision) throw alreadyExists('Query', body.query)

      const now = new Date().toISOString()
      const replacementId = crypto.randomUUID()

      // Older snapshots can lack self-describing text. Backfill ONLY those
      // NULL values before the FK detaches; a pre-existing frozen wording is
      // historical evidence and must never be rewritten from today's catalog.
      tx.update(querySnapshots)
        .set({ queryText: source.query })
        .where(and(eq(querySnapshots.queryId, source.id), isNull(querySnapshots.queryText)))
        .run()

      tx.insert(queries).values({
        id: replacementId,
        projectId: project.id,
        query: body.query,
        // This is an API/UI wording edit, not a CLI add. Catalog provenance is
        // intentionally separate from compiled-plan provenance: generic
        // catalog rows compile as manual unless an explicit plan source says
        // otherwise (see compileContextFor).
        provenance: `query-edit:${source.id}`,
        createdAt: now,
      }).run()

      // Query-set items are ordered authoring references. Move only the rows
      // that name this source, in place, before deleting it: the query FK is
      // ON DELETE CASCADE, and recreating them would lose their row identity,
      // position, and creation time.
      tx.update(measurementQuerySetItems)
        .set({ queryId: replacementId })
        .where(eq(measurementQuerySetItems.queryId, source.id))
        .run()
      tx.delete(queries).where(and(
        eq(queries.projectId, project.id),
        eq(queries.id, source.id),
      )).run()

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        entityId: replacementId,
        diff: { previousQueryId: source.id, replacementQueryId: replacementId },
      }))

      return { id: replacementId, query: body.query, createdAt: now }
    }, { behavior: 'immediate' })

    return reply.send(replacement)
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
      throw generationFailure(err, 'Failed to generate queries')
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
      replaceProjectQueries(tx, { projectId: project.id, projectName: project.name }, body.keywords, now)

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'queries.replaced',
        entityType: 'query',
        diff: { queries: body.keywords },
      }))
    }, { behavior: 'immediate' })

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

    app.db.transaction((tx) => {
      const existing = tx.select()
        .from(queries)
        .where(eq(queries.projectId, project.id))
        .all()
      const toDelete = new Set(body.keywords)
      const idsToDelete = existing.filter(q => toDelete.has(q.query)).map(q => q.id)
      assertQueryCatalogMutationAllowed(
        tx,
        { projectId: project.id, projectName: project.name },
        idsToDelete,
      )

      if (idsToDelete.length > 0) {
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
      }
    }, { behavior: 'immediate' })

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
      throw generationFailure(err, 'Failed to generate keywords')
    }
  })
}

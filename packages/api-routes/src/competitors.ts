import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors } from '@ainyc/canonry-db'
import {
  competitorAliasesRequestSchema,
  competitorAppendRequestSchema,
  competitorBatchRequestSchema,
  competitorAliasProjectIdentity,
  normalizeCompetitorDomain,
  notFound,
  validationError,
  type CompetitorDto,
} from '@ainyc/canonry-contracts'
import type { ZodType } from 'zod'
import {
  applyCompetitorSetPlan,
  competitorAliasAuditFields,
  competitorWritesFromEntries,
  findStoredCompetitor,
  normalizeCompetitorList,
  planCompetitorSet,
  readStoredCompetitors,
  syncCompetitorSet,
} from './competitor-writes.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { readMarketCompetitorPins } from './plan-competitors.js'
import { pruneQualifiedAliasesForCompetitors } from './projects.js'

export interface CompetitorRoutesOptions {
  /**
   * Post-commit hook when a competitor's curated aliases change. The local
   * server re-derives the stored per-snapshot competitor columns
   * (`competitor_overlap`, `recommended_competitors`) from stored answers.
   */
  onCompetitorAliasesChanged?: (projectId: string, projectName: string) => void
}

function serializeCompetitor(row: typeof competitors.$inferSelect): CompetitorDto {
  return { id: row.id, domain: row.domain, aliases: row.aliases, createdAt: row.createdAt }
}

export async function competitorRoutes(app: FastifyInstance, opts: CompetitorRoutesOptions = {}) {
  const listCompetitors = (projectId: string) =>
    app.db.select().from(competitors).where(eq(competitors.projectId, projectId)).all().map(serializeCompetitor)

  // GET /projects/:name/competitors
  app.get<{ Params: { name: string } }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    return reply.send(listCompetitors(project.id))
  })

  // PUT /projects/:name/competitors: replace the domain set. Domains that stay
  // keep their row, so their curated aliases survive a domain-only replace.
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
    const normalizedCompetitors = normalizeCompetitorList(body.competitors)

    const aliasesChanged = app.db.transaction((tx) => {
      const plan = syncCompetitorSet(tx, project.id, normalizedCompetitors.map(domain => ({ domain })), {
        replace: true,
        project: competitorAliasProjectIdentity(project),
        now,
      })
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: {
          competitors: normalizedCompetitors,
          ...competitorAliasAuditFields(plan),
          ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
        },
      })
      return plan.aliasChanges.length > 0
    })

    if (aliasesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    return reply.send(listCompetitors(project.id))
  })

  // POST /projects/:name/competitors: append (skip duplicates). An entry may
  // be `{ domain, aliases }`; its aliases are added to that competitor's list.
  app.post<{
    Params: { name: string }
    Body: { competitors: unknown[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(competitorAppendRequestSchema, request.body, 'Invalid competitor batch request')

    const now = new Date().toISOString()
    const writes = competitorWritesFromEntries(body.competitors, 'add')

    const aliasesChanged = app.db.transaction((tx) => {
      const plan = syncCompetitorSet(tx, project.id, writes, {
        replace: false,
        project: competitorAliasProjectIdentity(project),
        now,
      })
      if (plan.added.length === 0 && plan.aliasChanges.length === 0) return false
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.appended',
        entityType: 'competitor',
        diff: {
          added: plan.added,
          ...competitorAliasAuditFields(plan),
          ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
        },
      })
      return plan.aliasChanges.length > 0
    })

    if (aliasesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    return reply.send(listCompetitors(project.id))
  })

  // PUT /projects/:name/competitors/:domain/aliases: set one competitor's
  // curated aliases exactly (`[]` clears). Idempotent: an unchanged list
  // writes nothing and records no audit row. Any spelling of the domain finds
  // the stored row, including one an older build stored unnormalized.
  app.put<{
    Params: { name: string; domain: string }
    Body: { aliases: string[] }
  }>('/projects/:name/competitors/:domain/aliases', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(competitorAliasesRequestSchema, request.body, 'Invalid competitor aliases request')
    const domain = normalizeCompetitorDomain(request.params.domain.trim())

    const now = new Date().toISOString()

    const { id, aliasesChanged } = app.db.transaction((tx) => {
      const stored = readStoredCompetitors(tx, project.id)
      const current = findStoredCompetitor(stored, domain)
      if (!current) throw notFound('Competitor', domain)

      const plan = planCompetitorSet(stored, [{ domain, aliases: body.aliases, aliasMode: 'set' }], {
        replace: false,
        project: competitorAliasProjectIdentity(project),
        marketPins: readMarketCompetitorPins(tx, project.id),
      })
      applyCompetitorSetPlan(tx, project.id, stored, plan, now)
      // Any alias change is audited and backfilled, including another
      // competitor's stored alias dropped because stored lists disagreed.
      if (plan.aliasChanges.length === 0) return { id: current.id, aliasesChanged: false }
      const change = plan.aliasChanges.find(item => item.domain === current.domain)
      const before = change?.before ?? current.aliases
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.aliases-updated',
        entityType: 'competitor',
        entityId: current.id,
        diff: {
          domain: current.domain,
          before,
          after: change?.after ?? before,
          ...competitorAliasAuditFields({
            aliasChanges: plan.aliasChanges.filter(item => item.domain !== current.domain),
            droppedAliases: plan.droppedAliases,
          }),
          ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
        },
      }))
      return { id: current.id, aliasesChanged: true }
    })

    if (aliasesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    const row = app.db.select().from(competitors)
      .where(and(eq(competitors.projectId, project.id), eq(competitors.id, id))).get()
    if (!row) throw notFound('Competitor', domain)
    return reply.send(serializeCompetitor(row))
  })

  // DELETE /projects/:name/competitors — remove specific competitors
  app.delete<{
    Params: { name: string }
    Body: { competitors: string[] }
  }>('/projects/:name/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(competitorBatchRequestSchema, request.body, 'Invalid competitor batch request')

    // Normalize delete targets so callers can pass either the original or the
    // subdomain form (e.g. `offers.quotebird.test`) and still hit the stored
    // registrable form (`quotebird.test`). Stored rows compare in that form
    // too, so a row an older build stored as a subdomain is removed as well,
    // and every row that is the named competitor goes, duplicates included.
    const requested = new Set(normalizeCompetitorList(body.competitors))

    app.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .all()
      const rowsToDelete = existing.filter(c => requested.has(normalizeCompetitorDomain(c.domain)))

      if (rowsToDelete.length === 0) return

      for (const row of rowsToDelete) {
        tx.delete(competitors).where(eq(competitors.id, row.id)).run()
      }

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.deleted',
        entityType: 'competitor',
        diff: {
          deleted: rowsToDelete.map(row => row.domain),
          ...deletedAliasesDiff(rowsToDelete),
        },
      })
    })

    return reply.send(listCompetitors(project.id))
  })

  // DELETE /projects/:name/competitors/:id — remove one competitor by row id.
  app.delete<{
    Params: { name: string; id: string }
  }>('/projects/:name/competitors/:id', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const competitor = app.db
      .select()
      .from(competitors)
      .where(and(eq(competitors.projectId, project.id), eq(competitors.id, request.params.id)))
      .get()

    if (!competitor) {
      throw notFound('Competitor', request.params.id)
    }

    app.db.transaction((tx) => {
      tx.delete(competitors).where(eq(competitors.id, competitor.id)).run()

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.deleted',
        entityType: 'competitor',
        entityId: competitor.id,
        diff: { deleted: [competitor.domain], ...deletedAliasesDiff([competitor]) },
      }))
    })

    return reply.status(204).send()
  })
}

/** Curated aliases a delete discards, kept in the audit row so they can be restored. */
function deletedAliasesDiff(rows: readonly { domain: string; aliases: string[] }[]): Record<string, unknown> {
  const withAliases = rows.filter(row => row.aliases.length > 0)
  return withAliases.length
    ? { deletedAliases: Object.fromEntries(withAliases.map(row => [row.domain, row.aliases])) }
    : {}
}

function parseBody<T>(schema: ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw validationError(message, {
    issues: result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  })
}

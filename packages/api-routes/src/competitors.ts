import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors, marketCompetitorNames, projects, type DatabaseClient } from '@ainyc/canonry-db'
import {
  brandKeyFromText,
  COMPETITOR_ALIAS_MAX_LENGTH,
  COMPETITOR_BLOCKED_ALIAS_LIMIT,
  competitorAliasBlockRequestSchema,
  competitorAliasesRequestSchema,
  competitorAppendRequestSchema,
  competitorBatchRequestSchema,
  competitorAliasProjectIdentity,
  normalizeCompetitorAliases,
  normalizeCompetitorDomain,
  notFound,
  validationError,
  type CompetitorAutoAlias,
  type CompetitorDto,
} from '@ainyc/canonry-contracts'
import type { ZodType } from 'zod'
import {
  applyCompetitorAutoAliases,
  previewCompetitorAutoAliases,
  type AppliedCompetitorAutoAliases,
  type CompetitorAnswerAnchorReader,
} from './competitor-auto-aliases.js'
import { createProjectPassQueue } from './project-pass-queue.js'
import {
  beginMarketNameWrite,
  marketCompetitorDto,
  marketNameAuditFields,
  readMarketCompetitors,
  writeMarketCompetitorNames,
  type MarketCompetitor,
} from './market-competitor-names.js'
import {
  applyCompetitorSetPlan,
  competitorAliasAuditFields,
  competitorIdentityChanged,
  competitorWritesFromEntries,
  findStoredCompetitor,
  keepBlockedAliasesOfRemovedCompetitors,
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
   * Post-commit hook when any name a competitor answers to changes (curated
   * or auto-detected, or a name learned for a competitor only an Advanced
   * market pins, `marketNameChanges` on the audit row). Both hosts (local serve after the response, Cloud
   * inside the request) re-derive the stored per-snapshot competitor columns
   * (`competitor_overlap`, `recommended_competitors`) from stored answers
   * (`src/snapshot-competitor-refresh.ts`).
   */
  onCompetitorAliasesChanged?: (projectId: string, projectName: string) => void
  /**
   * Post-commit hook asking for an answer-derived alias detection pass off
   * the request path: a competitor was added (its names may already be in
   * stored answers) or a name was unblocked. The local server schedules
   * `applyCompetitorAutoAliases`.
   */
  onCompetitorAutoAliasRescan?: (projectId: string, projectName: string) => void
  /**
   * Reads one stored snapshot's provider citation structure for detection
   * (packages/canonry `extractStoredAnswerAnchors`). Absent on a host without
   * provider packages: detection then counts only pairings the answer text
   * writes itself, and says so (`scan.providerCitations: false`).
   */
  competitorAnswerAnchors?: CompetitorAnswerAnchorReader
  /**
   * Runs one detection pass for the project through the host's per-project
   * queue, the one its post-run trigger uses, and resolves with that pass's
   * result (`null` when the project is gone). The host's pass refreshes the
   * stored competitor fields itself when names change. Without it,
   * `POST /competitor-auto-aliases` runs the pass in this process, one at a
   * time per project.
   */
  runCompetitorAutoAliasPass?: (projectId: string) => Promise<AppliedCompetitorAutoAliases | null>
}

function serializeCompetitor(row: typeof competitors.$inferSelect): CompetitorDto {
  return {
    id: row.id,
    domain: row.domain,
    aliases: row.aliases,
    autoAliases: row.autoAliases,
    blockedAliases: row.blockedAliases,
    createdAt: row.createdAt,
  }
}

export async function competitorRoutes(app: FastifyInstance, opts: CompetitorRoutesOptions = {}) {
  const listCompetitors = (projectId: string) =>
    app.db.select().from(competitors).where(eq(competitors.projectId, projectId)).orderBy(competitors.domain).all().map(serializeCompetitor)
  // Detection reads up to `AUTO_ALIAS_SCAN_MAX_SNAPSHOTS` stored answers, so
  // requests for one project never scan side by side: concurrent dry runs
  // share the scan under way, and concurrent applies share one follow-up.
  const previews = createProjectPassQueue(async (projectId) => {
    const project = app.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw notFound('Project', projectId)
    return previewCompetitorAutoAliases(app.db, project, { readAnchors: opts.competitorAnswerAnchors })
  }, { joinRunning: true })
  const localApplies = createProjectPassQueue(async (projectId) => {
    const result = await applyCompetitorAutoAliases(app.db, projectId, { readAnchors: opts.competitorAnswerAnchors })
    if (result?.namesChanged) opts.onCompetitorAliasesChanged?.(projectId, result.detection.project)
    return result
  })
  const runApply = opts.runCompetitorAutoAliasPass ?? ((projectId: string) => localApplies.request(projectId))
  app.addHook('onClose', async () => {
    await Promise.all([previews.settled(), localApplies.settled()])
  })

  const readCompetitorRow = (projectId: string, id: string, domain: string): CompetitorDto => {
    const row = app.db.select().from(competitors)
      .where(and(eq(competitors.projectId, projectId), eq(competitors.id, id))).get()
    if (!row) throw notFound('Competitor', domain)
    return serializeCompetitor(row)
  }

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

    const changes = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      const plan = syncCompetitorSet(tx, project.id, normalizedCompetitors.map(domain => ({ domain })), {
        replace: true,
        project: competitorAliasProjectIdentity(project),
        now,
      })
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)
      const marketNamesChanged = marketNames.finish()

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.replaced',
        entityType: 'competitor',
        diff: {
          competitors: normalizedCompetitors,
          ...competitorAliasAuditFields(plan),
          ...marketNameAuditFields(marketNamesChanged),
          ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
        },
      })
      return {
        identityChanged: competitorIdentityChanged(plan) || marketNamesChanged.length > 0,
        added: plan.added.length > 0,
      }
    })

    if (changes.identityChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    if (changes.added) opts.onCompetitorAutoAliasRescan?.(project.id, project.name)
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

    const changes = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      const plan = syncCompetitorSet(tx, project.id, writes, {
        replace: false,
        project: competitorAliasProjectIdentity(project),
        now,
      })
      if (plan.added.length === 0 && !competitorIdentityChanged(plan)) return { identityChanged: false, added: false }
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)
      // A new domain's label or curated alias can claim a name learned for a
      // competitor only a market pins, and adding that competitor itself
      // (a promotion) drops its learned names.
      const marketNamesChanged = marketNames.finish()

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.appended',
        entityType: 'competitor',
        diff: {
          added: plan.added,
          ...competitorAliasAuditFields(plan),
          ...marketNameAuditFields(marketNamesChanged),
          ...(droppedQualifiedAliases.length ? { droppedQualifiedAliases } : {}),
        },
      })
      return {
        identityChanged: competitorIdentityChanged(plan) || marketNamesChanged.length > 0,
        added: plan.added.length > 0,
      }
    })

    if (changes.identityChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    if (changes.added) opts.onCompetitorAutoAliasRescan?.(project.id, project.name)
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
      const marketNames = beginMarketNameWrite(tx, project.id)
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
      // competitor's stored alias dropped because stored lists disagreed, and
      // an auto-detected name the new curated list now claims.
      if (!competitorIdentityChanged(plan)) return { id: current.id, aliasesChanged: false }
      const change = plan.aliasChanges.find(item => item.domain === current.domain)
      const before = change?.before ?? current.aliases
      const droppedQualifiedAliases = pruneQualifiedAliasesForCompetitors(tx, project.id, now)
      const marketNamesChanged = marketNames.finish()

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
            autoAliasChanges: plan.autoAliasChanges,
            droppedAutoAliases: plan.droppedAutoAliases,
          }),
          ...marketNameAuditFields(marketNamesChanged),
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

  // GET /projects/:name/competitor-auto-aliases: a dry run of answer-derived
  // alias detection over the stored answers. Never writes, never calls a
  // provider or any competitor site.
  app.get<{ Params: { name: string } }>('/projects/:name/competitor-auto-aliases', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    return reply.send(await previews.request(project.id))
  })

  // POST /projects/:name/competitor-auto-aliases: run detection now and store
  // the result, in every `competitorAutoAliases` mode (the server's own pass
  // after a sweep stores only in `apply` mode), through the same per-project
  // queue, so it never races a storing post-run pass. Idempotent:
  // unchanged answers write nothing. The pass audits its change as `system`
  // (as the post-run pass does); when it changed names, this request also
  // records who asked for it (`competitors.auto-aliases-apply-requested`,
  // with the request's principal), so a key-, MCP- or operator-started
  // change is never mistaken for the post-sweep pass.
  app.post<{ Params: { name: string } }>('/projects/:name/competitor-auto-aliases', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const result = await runApply(project.id)
    if (!result) throw notFound('Project', request.params.name)
    if (result.namesChanged) {
      const changes = result.detection.competitors
        .filter(competitor => competitor.added.length > 0 || competitor.removed.length > 0)
        .map(competitor => ({
          domain: competitor.domain,
          ...(competitor.marketKeys ? { marketKeys: competitor.marketKeys } : {}),
          added: competitor.added,
          removed: competitor.removed,
        }))
      writeAuditLog(app.db, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.auto-aliases-apply-requested',
        entityType: 'competitor',
        diff: { changes, scan: { runs: result.detection.scan.runs, snapshots: result.detection.scan.snapshots } },
      }))
    }
    return reply.send(result.detection)
  })

  // POST /projects/:name/competitors/:domain/aliases/block: never auto-apply
  // these names to this competitor again; a stored auto name among them is
  // removed now. Curated aliases are the operator's own and are not blocked.
  // A competitor the active Advanced plan pins without a project competitors
  // row is blocked the same way, on its stored market names; its plan label
  // and aliases are its curated names.
  app.post<{
    Params: { name: string; domain: string }
    Body: { aliases: string[] }
  }>('/projects/:name/competitors/:domain/aliases/block', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(competitorAliasBlockRequestSchema, request.body, 'Invalid competitor alias block request')
    const names = requireBlockableNames(body.aliases)
    const domain = normalizeCompetitorDomain(request.params.domain.trim())
    const now = new Date().toISOString()

    const { target, namesChanged } = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      const target = findBlockTarget(tx, project.id, domain)
      const curatedKeys = new Set(target.curated.map(brandKeyFromText))
      const curated = names.filter(name => curatedKeys.has(brandKeyFromText(name)))
      if (curated.length > 0) {
        const remove = target.market
          ? `Change a market competitor's plan names in a measurement draft (markets: ${target.market.marketKeys.join(', ')}).`
          : `Remove a curated alias with: canonry competitor aliases ${project.name} ${target.domain} --remove <name>`
        throw validationError(
          `${curated.map(name => `"${name}"`).join(', ')} ${curated.length === 1 ? 'is a curated alias' : 'are curated aliases'} of ${target.domain}; blocking only stops auto-detection. ${remove}`,
          { domain: target.domain, curated },
        )
      }
      // A name the plan's own pin of this competitor carries (a label or
      // alias, active revision or pending draft) keeps counting in that pin's
      // markets whatever detection stores, so a block would report a name
      // gone that is not.
      const pin = currentPlanPin(tx, project.id, target.domain)
      const pinKeys = new Set((pin?.names ?? []).map(brandKeyFromText))
      const pinned = names.filter(name => pinKeys.has(brandKeyFromText(name)))
      if (pin && pinned.length > 0) {
        throw validationError(
          `${pinned.map(name => `"${name}"`).join(', ')} ${pinned.length === 1 ? 'is a name' : 'are names'} of the measurement plan's pin of ${target.domain} (markets: ${pin.markets.join(', ')}); blocking only stops auto-detection, and the pin keeps counting ${pinned.length === 1 ? 'it' : 'them'}. Change the pin's names in a measurement draft.`,
          { domain: target.domain, pinned, marketKeys: pin.markets },
        )
      }
      const blockedAliases = dedupeByBrandKey([...target.blockedAliases, ...names])
      if (blockedAliases.length > COMPETITOR_BLOCKED_ALIAS_LIMIT) {
        throw validationError(`${target.domain} would have ${blockedAliases.length} blocked names (at most ${COMPETITOR_BLOCKED_ALIAS_LIMIT})`, {
          domain: target.domain,
          limit: COMPETITOR_BLOCKED_ALIAS_LIMIT,
        })
      }
      const blockedKeys = new Set(blockedAliases.map(brandKeyFromText))
      const autoAliases = target.autoAliases.filter(record => !blockedKeys.has(brandKeyFromText(record.name)))
      const removed = target.autoAliases.filter(record => blockedKeys.has(brandKeyFromText(record.name))).map(record => record.name)
      if (blockedAliases.length === target.blockedAliases.length && removed.length === 0) {
        return { target, namesChanged: false }
      }
      const entityId = target.write(tx, { blockedAliases, autoAliases }, now)
      const marketNamesChanged = marketNames.finish()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.aliases-blocked',
        entityType: 'competitor',
        entityId,
        diff: {
          domain: target.domain,
          ...(target.market ? { marketKeys: target.market.marketKeys } : {}),
          blocked: names,
          before: target.blockedAliases,
          after: blockedAliases,
          ...(removed.length ? { removedAutoAliases: removed } : {}),
          ...marketNameAuditFields(marketNamesChanged),
        },
      }))
      return { target, namesChanged: removed.length > 0 || marketNamesChanged.length > 0 }
    })

    if (namesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    return reply.send(target.read())
  })

  // POST /projects/:name/competitors/:domain/aliases/unblock: let detection
  // apply these names again (a detection pass is requested; nothing is
  // applied by the unblock itself).
  app.post<{
    Params: { name: string; domain: string }
    Body: { aliases: string[] }
  }>('/projects/:name/competitors/:domain/aliases/unblock', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(competitorAliasBlockRequestSchema, request.body, 'Invalid competitor alias unblock request')
    const names = requireBlockableNames(body.aliases)
    const domain = normalizeCompetitorDomain(request.params.domain.trim())
    const now = new Date().toISOString()

    const { target, unblocked, namesChanged } = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      const target = findBlockTarget(tx, project.id, domain)
      const releaseKeys = new Set(names.map(brandKeyFromText))
      const blockedAliases = target.blockedAliases.filter(name => !releaseKeys.has(brandKeyFromText(name)))
      if (blockedAliases.length === target.blockedAliases.length) return { target, unblocked: false, namesChanged: false }
      const entityId = target.write(tx, { blockedAliases }, now)
      // A block never leaves a learned name stored, but a removed competitor's
      // blocks land on a market row that may still hold one
      // (`keepBlockedAliasesOfRemovedCompetitors`), so an unblock can release it.
      const marketNamesChanged = marketNames.finish()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.aliases-unblocked',
        entityType: 'competitor',
        entityId,
        diff: {
          domain: target.domain,
          ...(target.market ? { marketKeys: target.market.marketKeys } : {}),
          unblocked: names,
          before: target.blockedAliases,
          after: blockedAliases,
          ...marketNameAuditFields(marketNamesChanged),
        },
      }))
      return { target, unblocked: true, namesChanged: marketNamesChanged.length > 0 }
    })

    if (namesChanged) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    if (unblocked) opts.onCompetitorAutoAliasRescan?.(project.id, project.name)
    return reply.send(target.read())
  })

  /**
   * The competitor a block or unblock names: a project competitor, or else a
   * competitor the active Advanced plan pins without tracking it (its names
   * stored on `market_competitor_names`), or else a domain with a
   * `market_competitor_names` row and no active pin: names learned for a pin
   * a later revision dropped (they still score the runs measured under the
   * revision that pinned it), or the blocked names a removed project
   * competitor left. 404 when it is none of these. `read` returns the DTO as
   * stored, called after the transaction commits.
   */
  function findBlockTarget(tx: Pick<DatabaseClient, 'select'>, projectId: string, domain: string): {
    domain: string
    curated: string[]
    autoAliases: CompetitorAutoAlias[]
    blockedAliases: string[]
    market: MarketCompetitor | null
    write: (tx: Pick<DatabaseClient, 'insert' | 'update'>, next: { blockedAliases: string[]; autoAliases?: CompetitorAutoAlias[] }, now: string) => string
    read: () => CompetitorDto
  } {
    const tracked = readStoredCompetitors(tx, projectId)
    const current = findStoredCompetitor(tracked, domain)
    if (current) {
      return {
        domain: current.domain,
        curated: current.aliases,
        autoAliases: current.autoAliases,
        blockedAliases: current.blockedAliases,
        market: null,
        write: (writer, next) => {
          writer.update(competitors).set(next).where(eq(competitors.id, current.id)).run()
          return current.id
        },
        read: () => readCompetitorRow(projectId, current.id, domain),
      }
    }
    const market = readMarketCompetitors(tx, projectId, tracked).find(entry => entry.domain === domain)
      ?? storedMarketNamesTarget(tx, projectId, domain)
    if (!market) throw notFound('Competitor', domain)
    let stored = market.stored
    return {
      domain: market.domain,
      curated: market.names,
      autoAliases: market.stored?.autoAliases ?? [],
      blockedAliases: market.stored?.blockedAliases ?? [],
      market,
      write: (writer, next, now) => {
        stored = writeMarketCompetitorNames(writer, projectId, market, next, now)
        return stored.id
      },
      read: () => marketCompetitorDto(market, stored, new Date().toISOString()),
    }
  }

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

    const marketNamesMoved = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      const existing = tx
        .select()
        .from(competitors)
        .where(eq(competitors.projectId, project.id))
        .orderBy(competitors.domain)
        .all()
      const rowsToDelete = existing.filter(c => requested.has(normalizeCompetitorDomain(c.domain)))

      if (rowsToDelete.length === 0) return false

      for (const row of rowsToDelete) {
        tx.delete(competitors).where(eq(competitors.id, row.id)).run()
      }
      keepBlockedAliasesOfRemovedCompetitors(tx, project.id, rowsToDelete, new Date().toISOString())
      const marketNamesChanged = marketNames.finish()

      writeAuditLog(tx, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.deleted',
        entityType: 'competitor',
        diff: {
          deleted: rowsToDelete.map(row => row.domain),
          ...deletedAliasesDiff(rowsToDelete),
          ...marketNameAuditFields(marketNamesChanged),
        },
      })
      return marketNamesChanged.length > 0
    })

    if (marketNamesMoved) opts.onCompetitorAliasesChanged?.(project.id, project.name)
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

    const marketNamesMoved = app.db.transaction((tx) => {
      const marketNames = beginMarketNameWrite(tx, project.id)
      tx.delete(competitors).where(eq(competitors.id, competitor.id)).run()
      keepBlockedAliasesOfRemovedCompetitors(tx, project.id, [competitor], new Date().toISOString())
      const marketNamesChanged = marketNames.finish()

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'competitors.deleted',
        entityType: 'competitor',
        entityId: competitor.id,
        diff: { deleted: [competitor.domain], ...deletedAliasesDiff([competitor]), ...marketNameAuditFields(marketNamesChanged) },
      }))
      return marketNamesChanged.length > 0
    })

    if (marketNamesMoved) opts.onCompetitorAliasesChanged?.(project.id, project.name)
    return reply.status(204).send()
  })
}

/**
 * Names a delete discards (curated, auto-detected and blocked), kept in the
 * audit row so they can be restored.
 */
function deletedAliasesDiff(rows: readonly { domain: string; aliases: string[]; autoAliases: { name: string }[]; blockedAliases: string[] }[]): Record<string, unknown> {
  const withAliases = rows.filter(row => row.aliases.length > 0)
  const withAuto = rows.filter(row => row.autoAliases.length > 0)
  const withBlocked = rows.filter(row => row.blockedAliases.length > 0)
  return {
    ...(withAliases.length ? { deletedAliases: Object.fromEntries(withAliases.map(row => [row.domain, row.aliases])) } : {}),
    ...(withAuto.length ? { deletedAutoAliases: Object.fromEntries(withAuto.map(row => [row.domain, row.autoAliases.map(record => record.name)])) } : {}),
    ...(withBlocked.length ? { deletedBlockedAliases: Object.fromEntries(withBlocked.map(row => [row.domain, row.blockedAliases])) } : {}),
  }
}

/**
 * The active revision's and the pending draft's pin of `domain` (registrable
 * form), merged: its names and markets (`readMarketCompetitorPins`, without
 * the superseded revisions, which no draft can change). Null when neither
 * pins it.
 */
function currentPlanPin(tx: Pick<DatabaseClient, 'select'>, projectId: string, domain: string): { names: readonly string[]; markets: readonly string[] } | null {
  const key = normalizeCompetitorDomain(domain)
  return readMarketCompetitorPins(tx, projectId)
    .find(pin => pin.supersededRevision === undefined && normalizeCompetitorDomain(pin.domain) === key) ?? null
}

/**
 * A `market_competitor_names` row for `domain` as a block target when no
 * project competitor or active pin is that domain: no plan names (its pins,
 * if any, are in superseded revisions or the draft) and no markets.
 */
function storedMarketNamesTarget(tx: Pick<DatabaseClient, 'select'>, projectId: string, domain: string): MarketCompetitor | null {
  const stored = tx.select().from(marketCompetitorNames)
    .where(and(eq(marketCompetitorNames.projectId, projectId), eq(marketCompetitorNames.domain, domain)))
    .get()
  return stored ? { domain: stored.domain, names: [], marketKeys: [], stored } : null
}

/** Trimmed, deduplicated by brand key; each must be a name (at least one letter or digit, at most the alias length). */
function requireBlockableNames(raw: readonly string[]): string[] {
  const names = dedupeByBrandKey(normalizeCompetitorAliases(raw))
  const invalid = names.filter(name => !brandKeyFromText(name) || name.length > COMPETITOR_ALIAS_MAX_LENGTH)
  if (invalid.length > 0 || names.length === 0) {
    throw validationError(`Each name needs a letter or digit and at most ${COMPETITOR_ALIAS_MAX_LENGTH} characters`, { invalid })
  }
  return names
}

function dedupeByBrandKey(names: readonly string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = brandKeyFromText(name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

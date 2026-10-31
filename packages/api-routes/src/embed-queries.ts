import type { FastifyRequest } from 'fastify'
import {
  EMBED_QUERY_LIMIT_HEADER,
  EMBED_QUERIES_WRITE_SCOPE,
  WILDCARD_SCOPE,
  embedQueryLimitReached,
  forbidden,
  parseEmbedQueryLimit,
  type QueryTrackingMode,
  type QueryTrackingMutation,
} from '@canonry/canonry-contracts'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'

/**
 * Query changes from an embedded dashboard.
 *
 * When an agency lets its clients manage their own queries, the Embed v2
 * render proxy forwards the dashboard's review and save calls with a key that
 * holds only `embed.queries.write`, plus the plan's query limit in a
 * header. That key is restricted to the two query-tracking writes. The rules
 * here keep each change to what the client view offers, and keep the list
 * within the limit.
 */

/**
 * The query limit this request writes under, or undefined when the caller
 * holds full tracking authority and the embed rules do not apply.
 */
export function embedQueryWriteLimit(request: FastifyRequest): number | undefined {
  const principal = request.principal
  const scopes = principal?.scopes ?? request.apiKey?.scopes ?? []
  if (!scopes.includes(EMBED_QUERIES_WRITE_SCOPE)) return undefined
  // A caller that can already publish tracking keeps its full authority.
  if (scopes.includes(WILDCARD_SCOPE) || scopes.includes(MEASUREMENT_PLAN_WRITE_SCOPE)) return undefined
  // The project-scope gate pins a scoped key to its own project. An unscoped
  // embed key would reach every project, so it is refused outright.
  const projectId = principal?.kind === 'api-key' ? principal.projectId : request.apiKey?.projectId
  if (!projectId) throw forbidden('An embedded query key must be scoped to one project.')
  const limit = parseEmbedQueryLimit(request.headers[EMBED_QUERY_LIMIT_HEADER])
  if (limit === undefined) throw forbidden('An embedded query change needs the dashboard query limit.')
  return limit
}

/**
 * One written query added, or one query removed by id. That is all the
 * client view offers. Wording edits, saved research and discovery sources,
 * templates, audiences, contexts, and classification stay operator decisions.
 */
export function assertEmbedQueryChange(mutation: QueryTrackingMutation): void {
  const plain = mutation.additions.length + mutation.removals.length === 1
    && (mutation.edits ?? []).length === 0
    && mutation.additions.every(addition => addition.input.source === 'manual'
      && addition.audience === undefined
      && addition.contexts === undefined
      && addition.queryClass === undefined)
    && mutation.removals.every(removal => removal.queryId !== undefined && removal.audience === undefined)
  if (!plain) throw forbidden('An embedded dashboard can add or remove one query at a time.')
}

/** Embedded editing covers simple projects. An advanced portfolio stays with the agency. */
export function assertEmbedQueryWorkspace(mode: QueryTrackingMode): void {
  if (mode !== 'simple') throw forbidden('Your agency manages the queries for this project.')
}

/**
 * A change may not grow the list past the limit. Removals stay open when an
 * earlier, larger plan left the list above it, so a client can always get back
 * under.
 */
export function assertWithinEmbedQueryLimit(before: number, after: number, limit: number): void {
  if (after > limit && after > before) throw embedQueryLimitReached(limit, after)
}

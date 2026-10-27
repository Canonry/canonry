import type { FastifyRequest } from 'fastify'
import {
  EMBED_QUESTION_LIMIT_HEADER,
  EMBED_QUESTIONS_WRITE_SCOPE,
  WILDCARD_SCOPE,
  embedQuestionLimitReached,
  forbidden,
  parseEmbedQuestionLimit,
  type QueryTrackingMode,
  type QueryTrackingMutation,
} from '@canonry/canonry-contracts'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'

/**
 * Question changes from an embedded dashboard.
 *
 * When an agency lets its clients manage their own questions, the Embed v2
 * render proxy forwards the dashboard's review and save calls with a key that
 * holds only `embed.questions.write`, plus the plan's question limit in a
 * header. That key is restricted to the two query-tracking writes. The rules
 * here keep each change to what the client view offers, and keep the list
 * within the limit.
 */

/**
 * The question limit this request writes under, or undefined when the caller
 * holds full tracking authority and the embed rules do not apply.
 */
export function embedQuestionWriteLimit(request: FastifyRequest): number | undefined {
  const principal = request.principal
  const scopes = principal?.scopes ?? request.apiKey?.scopes ?? []
  if (!scopes.includes(EMBED_QUESTIONS_WRITE_SCOPE)) return undefined
  // A caller that can already publish tracking keeps its full authority.
  if (scopes.includes(WILDCARD_SCOPE) || scopes.includes(MEASUREMENT_PLAN_WRITE_SCOPE)) return undefined
  // The project-scope gate pins a scoped key to its own project. An unscoped
  // embed key would reach every project, so it is refused outright.
  const projectId = principal?.kind === 'api-key' ? principal.projectId : request.apiKey?.projectId
  if (!projectId) throw forbidden('An embedded question key must be scoped to one project.')
  const limit = parseEmbedQuestionLimit(request.headers[EMBED_QUESTION_LIMIT_HEADER])
  if (limit === undefined) throw forbidden('An embedded question change needs the dashboard question limit.')
  return limit
}

/**
 * One written question added, one question removed, or one question's wording
 * changed. Saved research and discovery sources, templates, audiences, contexts,
 * and classification are operator decisions, so the client view never sends them.
 */
export function assertEmbedQuestionChange(mutation: QueryTrackingMutation): void {
  const edits = mutation.edits ?? []
  const changes = mutation.additions.length + mutation.removals.length + edits.length
  const plain = changes === 1
    && mutation.additions.every(addition => addition.input.source === 'manual'
      && addition.audience === undefined
      && addition.contexts === undefined
      && addition.queryClass === undefined)
    && mutation.removals.every(removal => removal.queryId !== undefined && removal.audience === undefined)
    && edits.every(edit => edit.text !== undefined && edit.audience === undefined && edit.queryClass === undefined)
  if (!plain) throw forbidden('An embedded dashboard can add, edit, or remove one question at a time.')
}

/** Embedded editing covers simple projects. An advanced portfolio stays with the agency. */
export function assertEmbedQuestionWorkspace(mode: QueryTrackingMode): void {
  if (mode !== 'simple') throw forbidden('Your agency manages the questions for this project.')
}

/**
 * A change may not grow the list past the limit. Removals and edits stay open
 * when an earlier, larger plan left the list above it, so a client can always
 * get back under.
 */
export function assertWithinEmbedQuestionLimit(before: number, after: number, limit: number): void {
  if (after > limit && after > before) throw embedQuestionLimitReached(limit, after)
}

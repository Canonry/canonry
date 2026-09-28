import type { FastifyInstance } from 'fastify'
import {
  forbidden,
  logQuerySchema,
  notImplemented,
  OPERATIONAL_LOG_FIELDS_HEADER,
  OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS,
  operationalLogListDtoSchema,
  validationError,
  type LogQuery,
  type OperationalLogListDto,
  type OperationalLogOptInContextField,
} from '@ainyc/canonry-contracts'
import { requireOperator, requireScope } from './auth.js'

export interface OperationalLogsRoutesOptions {
  /**
   * Host-owned bounded runtime-log reader. It intentionally has no database or
   * filesystem fallback: an unwired deployment must say so rather than tailing
   * a file or implying durable history.
   */
  listOperationalLogs?: (query: LogQuery) => OperationalLogListDto | Promise<OperationalLogListDto>
}

/** Permission-gated instance runtime diagnostics, separate from audit history. */
export async function operationalLogsRoutes(app: FastifyInstance, opts: OperationalLogsRoutesOptions = {}): Promise<void> {
  app.get('/operations/logs', async (request, reply) => {
    requireOperator(request)
    requireScope(request, 'logs.read')
    if (request.apiKey?.projectId) {
      throw forbidden('This API key is scoped to one project and cannot read instance operational diagnostics.')
    }

    const parsed = logQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      throw validationError('Invalid operational logs query.', { issues: parsed.error.issues })
    }
    if (!opts.listOperationalLogs) {
      throw notImplemented('Operational logs are not available in this deployment.')
    }
    // Hosts normally return OperationalLogStore.list(). Parsing here keeps a
    // future host callback from accidentally widening this diagnostic surface.
    const page = operationalLogListDtoSchema.parse(await opts.listOperationalLogs(parsed.data))
    // The page depends on the opt-in header, so a cache must not serve one
    // caller's page to another that asked for different fields.
    reply.header('vary', OPERATIONAL_LOG_FIELDS_HEADER)
    return withoutUnrequestedFields(page, requestedFields(request.headers[OPERATIONAL_LOG_FIELDS_HEADER]))
  })
}

/** Opt-in context fields named in the header; unknown names are ignored. */
function requestedFields(header: string | string[] | undefined): Set<OperationalLogOptInContextField> {
  const names = (Array.isArray(header) ? header : [header ?? '']).flatMap(value => value.split(',')).map(name => name.trim())
  return new Set(OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS.filter(field => names.includes(field)))
}

/**
 * An older adapter validates pages with the strict contract it was built
 * with, and rejects the whole page on a context key it does not know. Opt-in
 * fields therefore reach only callers that asked for them.
 */
function withoutUnrequestedFields(page: OperationalLogListDto, requested: ReadonlySet<OperationalLogOptInContextField>): OperationalLogListDto {
  const omitted = OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS.filter(field => !requested.has(field))
  if (omitted.length === 0) return page
  return {
    ...page,
    entries: page.entries.map(entry => ({
      ...entry,
      context: Object.fromEntries(Object.entries(entry.context).filter(([key]) => !(omitted as readonly string[]).includes(key))),
    })),
  }
}

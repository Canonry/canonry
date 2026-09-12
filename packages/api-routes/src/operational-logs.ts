import type { FastifyInstance } from 'fastify'
import {
  forbidden,
  logQuerySchema,
  notImplemented,
  operationalLogListDtoSchema,
  validationError,
  type LogQuery,
  type OperationalLogListDto,
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
  app.get('/operations/logs', async (request) => {
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
    return operationalLogListDtoSchema.parse(await opts.listOperationalLogs(parsed.data))
  })
}

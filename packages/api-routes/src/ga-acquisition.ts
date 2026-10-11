import { and, asc, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { gaAcquisitionDaily as acquisition, gaMeasurementSyncStates } from '@ainyc/canonry-db'
import { gaAcquisitionDimensionSchema, gaAcquisitionQuerySchema, GaAcquisitionDimensions, normalizePathPrefix, parseWindow, resolveDateRange, validationError, type GaAcquisitionDimension, type GaAcquisitionResponse } from '@ainyc/canonry-contracts'
import { resolveProject } from './helpers.js'
import { literalPathPrefixCondition } from './path-prefix-condition.js'

/** SQL aggregation keeps both totals and grouped pagination independent of the page cap. */
export async function gaAcquisitionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> & { window?: string } }>('/projects/:name/ga/acquisition', async request => {
    const project = resolveProject(app.db, request.params.name)
    const input = { ...request.query }
    for (const key of ['limit', 'offset']) if (input[key] !== undefined) input[key] = Number(input[key])
    const parsed = gaAcquisitionQuerySchema.safeParse({ ...input, window: parseWindow(input.window) })
    if (!parsed.success) throw validationError(parsed.error.message)
    const query = parsed.data
    const range = resolveDateRange(query)
    const groupBy = query.groupBy === undefined ? [...gaAcquisitionDimensionSchema.options] : [...new Set(query.groupBy.split(',').map(key => gaAcquisitionDimensionSchema.parse(key.trim())))]
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const landingPage = sql<string>`coalesce(${acquisition.landingPageNormalized}, ${acquisition.landingPage})`
    const dimensions = {
      date: acquisition.date, channelGroup: acquisition.channelGroup, source: acquisition.source, medium: acquisition.medium, hostName: acquisition.hostName, landingPage,
    }
    const windowFilters: SQL[] = [eq(acquisition.projectId, project.id)]
    if (range.startDate) windowFilters.push(gte(acquisition.date, range.startDate))
    if (range.endDate) windowFilters.push(lte(acquisition.date, range.endDate))
    const filters = [...windowFilters]
    if (query.channel !== undefined) filters.push(sql`lower(${acquisition.channelGroup}) = lower(${query.channel})`)
    if (query.hostName !== undefined) filters.push(sql`lower(${acquisition.hostName}) = lower(${query.hostName})`)
    if (query.source !== undefined) filters.push(eq(acquisition.source, query.source))
    if (query.medium !== undefined) filters.push(eq(acquisition.medium, query.medium))
    if (query.landingPage !== undefined) filters.push(sql`${landingPage} = ${query.landingPage}`)
    const pathPrefix = normalizePathPrefix(query.pathPrefix)
    if (pathPrefix && pathPrefix !== '/') {
      const pathname = sql`case when instr(${landingPage}, '?') = 0 then ${landingPage} else substr(${landingPage}, 1, instr(${landingPage}, '?') - 1) end`
      filters.push(literalPathPrefixCondition(pathname, pathPrefix))
    }
    const where = and(...filters)
    const sessions = sql<number>`coalesce(sum(${acquisition.sessions}), 0)`.mapWith(Number)
    const selected = Object.fromEntries(groupBy.map(key => [key, dimensions[key]])) as Partial<Record<GaAcquisitionDimension, typeof dimensions[GaAcquisitionDimension]>>
    const grouped = app.db.select({ ...selected, sessions }).from(acquisition).where(where).groupBy(...groupBy.map(key => dimensions[key]))
    const totalRows = app.db.select({ total: count() }).from(grouped.as('grouped_acquisition')).get()!.total
    const totalSessions = app.db.select({ total: sessions }).from(acquisition).where(where).get()!.total
    const order = [
      ...(groupBy.includes(GaAcquisitionDimensions.date) ? [desc(acquisition.date)] : []), desc(sessions),
      ...groupBy.filter(key => key !== GaAcquisitionDimensions.date).map(key => asc(dimensions[key])),
    ]
    const rows = grouped.orderBy(...order).limit(limit).offset(offset).all()
    const coverage = app.db.select({ earliestDate: sql<string | null>`min(${acquisition.date})`, latestDate: sql<string | null>`max(${acquisition.date})` }).from(acquisition).where(eq(acquisition.projectId, project.id)).get()!
    const channelGroups = app.db.selectDistinct({ channel: acquisition.channelGroup }).from(acquisition).where(and(...windowFilters)).orderBy(asc(acquisition.channelGroup)).all().map(row => row.channel)
    const state = app.db.select().from(gaMeasurementSyncStates).where(eq(gaMeasurementSyncStates.projectId, project.id)).get()
    const response: GaAcquisitionResponse = {
      source: 'ga4-acquisition', status: state?.acquisitionStatus ?? 'never-synced', error: state?.acquisitionError ?? null, syncedAt: state?.acquisitionSyncedAt ?? null,
      scope: { project: project.name, attribution: 'project-only', unavailableDimensions: ['property', 'target', 'market'] },
      window: { startDate: range.startDate, endDate: range.endDate, window: range.window }, coverage,
      filters: { channel: query.channel ?? null, source: query.source ?? null, medium: query.medium ?? null, hostName: query.hostName ?? null, landingPage: query.landingPage ?? null, pathPrefix },
      groupBy, channelGroups, totalSessions, totalRows, limit, offset, rows,
    }
    return response
  })
}

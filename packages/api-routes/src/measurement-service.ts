import type { FastifyInstance } from 'fastify'
import {
  deliveryFailed,
  effectiveDomains,
  measurementDiscoveryRequestSchema,
  measurementDiscoveryResponseSchema,
  measurementQueryClassFilterSchema,
  measurementReportResponseSchema,
  notFound,
  type MeasurementQueryClassFilter,
  validationError,
  describeError,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'
import {
  classifyMeasurementSitemapUrls,
  MeasurementDiscoveryConfigurationError,
} from './measurement-discovery.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import { buildStoredMeasurementReport } from './measurement-report-adapter.js'
import {
  fetchMeasurementSitemap,
  type MeasurementSitemapFetchResult,
} from './measurement-sitemap-fetch.js'
import { resolveProject } from './helpers.js'

const DEFAULT_DISCOVERY_URL_LIMIT = 10_000

export interface MeasurementServiceRoutesOptions {
  fetchSitemap?: (sitemapUrl: string) => Promise<MeasurementSitemapFetchResult>
}

function messageOf(error: unknown): string {
  return describeError(error)
}

/** Network and persistence adapters around the pure Target discovery/report kernels. */
export async function measurementServiceRoutes(app: FastifyInstance, opts: MeasurementServiceRoutesOptions) {
  // A POST only because the rules it classifies against are too large for a
  // URL. It fetches a sitemap and sorts the URLs; it writes nothing and starts
  // nothing, so a view-only account can run it — see `readSemantic` in
  // `auth.ts`. This is the first step of the setup wizard, and a viewer who
  // could not run it could not look at the plan at all.
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-discovery', {
    config: { readSemantic: true },
  }, async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementDiscoveryRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid measurement discovery request', { issues: parsed.error.issues })
    }

    let fetched: MeasurementSitemapFetchResult
    try {
      fetched = await (opts.fetchSitemap ?? fetchMeasurementSitemap)(parsed.data.sitemapUrl)
    } catch (error) {
      throw deliveryFailed(`Unable to fetch sitemap: ${messageOf(error)}`)
    }

    try {
      return measurementDiscoveryResponseSchema.parse(classifyMeasurementSitemapUrls({
        ownedHosts: effectiveDomains(project),
        rules: parsed.data.rule,
        urls: fetched.urls,
        maxUrls: parsed.data.maxUrls ?? DEFAULT_DISCOVERY_URL_LIMIT,
      }))
    } catch (error) {
      if (error instanceof MeasurementDiscoveryConfigurationError) {
        throw validationError(error.message)
      }
      throw error
    }
  })

  app.get<{ Params: { name: string }; Querystring: { revision?: string; runId?: string; queryClass?: string } }>('/projects/:name/measurement-report', async request => {
    const project = resolveProject(app.db, request.params.name)
    const rawRevision = request.query.revision
    if (typeof rawRevision !== 'string' || !/^[1-9]\d*$/.test(rawRevision)) {
      throw validationError('"revision" must be a positive integer')
    }
    const revision = Number(rawRevision)
    if (!Number.isSafeInteger(revision)) throw validationError('"revision" must be a positive safe integer')
    const runId = request.query.runId
    if (runId !== undefined && (typeof runId !== 'string' || runId.trim() === '')) {
      throw validationError('"runId" must be a non-empty string')
    }

    let queryClass: MeasurementQueryClassFilter | undefined
    if (request.query.queryClass !== undefined) {
      const parsedClass = measurementQueryClassFilterSchema.safeParse(request.query.queryClass)
      if (!parsedClass.success) throw validationError('"queryClass" must be one of non-brand, branded or all')
      queryClass = parsedClass.data
    }

    const result = buildStoredMeasurementReport(app.db, project.id, revision, runId, queryClass)
    if (result.kind === 'no-plan') throw notFound('Measurement plan revision', rawRevision)
    if (runId !== undefined && result.report.run?.id !== runId) throw notFound('Measurement run', runId)
    return measurementReportResponseSchema.parse(result.report)
  })
}

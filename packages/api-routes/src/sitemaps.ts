import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { bingSitemaps, gscSitemaps, runs, siteCrawlPages, siteCrawlSnapshots, sitemapListSyncs } from '@canonry/canonry-db'
import { RunKinds, RunStatuses, hostMatchesDomain, type EngineSitemapDto, type SitemapCoverageResponseDto } from '@canonry/canonry-contracts'
import type { BingConnectionStore } from './bing.js'
import { isSitemapOwnedByProperty, type GoogleConnectionStore } from './google.js'
import { notProbeRun, resolveProject } from './helpers.js'
import { bingSitemapState, buildSitemapCoverage, googleSitemapState, type EngineList } from './sitemap-coverage.js'

export interface SitemapRoutesOptions {
  /** The project's Search Console property decides which sitemaps Google can take. */
  googleConnectionStore?: GoogleConnectionStore
  /** The project's Bing site decides which sitemaps Bing can take. */
  bingConnectionStore?: BingConnectionStore
}

export async function sitemapRoutes(app: FastifyInstance, opts: SitemapRoutesOptions) {
  // GET /projects/:name/sitemaps
  app.get<{ Params: { name: string } }>('/projects/:name/sitemaps', async (request): Promise<SitemapCoverageResponseDto> => {
    const project = resolveProject(app.db, request.params.name)

    // The site's own sitemaps: the files the latest surfaced Site Health scan
    // read pages from. Each crawled page records the sitemaps that listed it.
    const scan = app.db
      .select({ runId: siteCrawlSnapshots.runId, attemptId: siteCrawlSnapshots.attemptId, createdAt: siteCrawlSnapshots.createdAt })
      .from(siteCrawlSnapshots)
      .innerJoin(runs, eq(siteCrawlSnapshots.runId, runs.id))
      .where(and(
        eq(siteCrawlSnapshots.projectId, project.id),
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['site-audit']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        notProbeRun(),
      ))
      .orderBy(desc(siteCrawlSnapshots.createdAt), desc(siteCrawlSnapshots.runId))
      .limit(1)
      .get()
    const siteSitemaps = scan
      ? app.db.all<{ url: string }>(sql`
          select distinct source.value as url
          from ${siteCrawlPages}, json_each(${siteCrawlPages.sitemapMetadata}, '$.sources') as source
          where ${siteCrawlPages.projectId} = ${project.id}
            and ${siteCrawlPages.runId} = ${scan.runId}
            and (${scan.attemptId} is null or ${siteCrawlPages.attemptId} = ${scan.attemptId})
            and source.type = 'text'
          order by url`).map((row) => row.url)
      : []

    const listedAt = new Map(app.db
      .select({ engine: sitemapListSyncs.engine, syncedAt: sitemapListSyncs.syncedAt })
      .from(sitemapListSyncs)
      .where(eq(sitemapListSyncs.projectId, project.id))
      .all()
      .map((row) => [row.engine, row.syncedAt]))

    const googleRows = app.db.select().from(gscSitemaps).where(eq(gscSitemaps.projectId, project.id)).orderBy(asc(gscSitemaps.url)).all()
    const google: EngineList | null = listedAt.has('google')
      ? {
          syncedAt: listedAt.get('google')!,
          sitemaps: googleRows.map((row): EngineSitemapDto => ({
            url: row.url,
            parentUrl: row.parentUrl,
            isIndex: row.isIndex,
            type: row.type,
            ...googleSitemapState(row),
            warnings: row.warnings,
            errors: row.errors,
            urlCount: row.urlCount,
            submittedAt: row.submittedAt,
            lastReadAt: row.lastDownloadedAt,
          })),
        }
      : null

    const bingRows = app.db.select().from(bingSitemaps).where(eq(bingSitemaps.projectId, project.id)).orderBy(asc(bingSitemaps.url)).all()
    const bing: EngineList | null = listedAt.has('bing')
      ? {
          syncedAt: listedAt.get('bing')!,
          sitemaps: bingRows.map((row): EngineSitemapDto => ({
            url: row.url,
            parentUrl: row.parentUrl,
            isIndex: /index/i.test(row.type),
            type: row.type,
            state: bingSitemapState(row.status),
            statusLabel: row.status,
            warnings: null,
            errors: null,
            urlCount: row.urlCount,
            submittedAt: row.submittedAt,
            lastReadAt: row.lastCrawledAt,
          })),
        }
      : null

    const propertyId = opts.googleConnectionStore?.getConnection(project.canonicalDomain, 'gsc')?.propertyId ?? null
    const bingSite = opts.bingConnectionStore?.getConnection(project.canonicalDomain)?.siteUrl ?? null
    return buildSitemapCoverage({
      site: { scannedAt: scan?.createdAt ?? null, runId: scan?.runId ?? null, sitemaps: siteSitemaps },
      google,
      bing,
      accepts: {
        // Google rejects a sitemap outside the property, so it is never "missing" there.
        google: (url) => propertyId === null || isSitemapOwnedByProperty(url, propertyId, project.canonicalDomain),
        // Bing takes sitemaps on its site's host and subdomains.
        bing: (url) => bingSite === null || hostMatchesDomain(url, bingSite),
      },
    })
  })
}

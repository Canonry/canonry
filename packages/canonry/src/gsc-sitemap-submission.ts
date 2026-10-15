import type { GscSubmitSitemapsResponseDto } from '@canonry/canonry-contracts'
import type { ApiClient } from './client.js'
import { CliError, EXIT_SYSTEM_ERROR } from './cli-error.js'
import { describeError } from '@canonry/canonry-contracts'

export type DiscoveredGscSitemapMode = 'indexes' | 'all-files'

export function dedupeGscSitemapUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
}

export async function resolveDiscoveredGscSitemapUrls(
  client: ApiClient,
  project: string,
  mode: DiscoveredGscSitemapMode,
): Promise<string[]> {
  const topLevel = await client.gscSitemaps(project)
  if (mode === 'indexes') {
    return dedupeGscSitemapUrls(
      topLevel.preferredSubmissionUrls.length > 0
        ? topLevel.preferredSubmissionUrls
        : topLevel.sitemaps.map((sitemap) => sitemap.path),
    )
  }

  const indexes = topLevel.sitemaps
    .filter((sitemap) => sitemap.isSitemapsIndex)
    .map((sitemap) => sitemap.path)
  const expandedIndexUrls: string[] = []
  for (let offset = 0; offset < indexes.length; offset += 4) {
    const children = await Promise.all(
      indexes.slice(offset, offset + 4).map((sitemapIndex) => client.gscSitemaps(project, { sitemapIndex })),
    )
    children.forEach((result, index) => {
      const sitemapIndex = indexes[offset + index]!
      expandedIndexUrls.push(...(result.sitemaps.length > 0
        ? result.sitemaps.map((sitemap) => sitemap.path)
        : [sitemapIndex]))
    })
  }

  return dedupeGscSitemapUrls([
    ...topLevel.sitemaps.filter((sitemap) => !sitemap.isSitemapsIndex).map((sitemap) => sitemap.path),
    ...expandedIndexUrls,
  ])
}

export function requireGscSitemapUrls(project: string, sitemapUrls: string[]): void {
  if (sitemapUrls.length > 0) return
  throw new CliError({
    code: 'CLI_USAGE_ERROR',
    message: 'no GSC sitemaps found; provide a URL or use --configured',
    displayMessage: 'Error: no GSC sitemaps found; provide a URL or use --configured',
    details: { command: 'google.submit-sitemap', project },
  })
}

export async function submitGscSitemapBatches(
  client: ApiClient,
  project: string,
  sitemapUrls: string[],
  opts: { onProgress?: (completedBatches: number, totalBatches: number) => void } = {},
): Promise<GscSubmitSitemapsResponseDto> {
  const batches = Array.from(
    { length: Math.ceil(sitemapUrls.length / 50) },
    (_, index) => sitemapUrls.slice(index * 50, index * 50 + 50),
  )
  const aggregate: GscSubmitSitemapsResponseDto = {
    summary: { total: 0, accepted: 0, failed: 0 },
    results: [],
  }
  for (const [index, batchSitemapUrls] of batches.entries()) {
    try {
      const result = await client.gscSubmitSitemaps(project, { sitemapUrls: batchSitemapUrls })
      aggregate.summary.total += result.summary.total
      aggregate.summary.accepted += result.summary.accepted
      aggregate.summary.failed += result.summary.failed
      aggregate.results.push(...result.results)
      opts.onProgress?.(index + 1, batches.length)
    } catch (cause) {
      if (index === 0) throw cause
      const attempted = aggregate.summary.total + batchSitemapUrls.length
      const remaining = sitemapUrls.length - attempted
      throw new CliError({
        code: 'GOOGLE_SITEMAP_SUBMISSION_PARTIAL',
        message: `Sitemap submission stopped at batch ${index + 1}/${batches.length}; ${aggregate.summary.accepted} accepted, ${aggregate.summary.failed} failed, ${batchSitemapUrls.length} unconfirmed, ${remaining} not attempted.`,
        displayMessage: `Sitemap submission stopped at batch ${index + 1}/${batches.length}; ${aggregate.summary.accepted} accepted, ${aggregate.summary.failed} failed, ${batchSitemapUrls.length} unconfirmed, ${remaining} not attempted. Earlier accepted submissions were not rolled back.`,
        exitCode: cause instanceof CliError && cause.exitCode === 1 ? 1 : EXIT_SYSTEM_ERROR,
        details: {
          project,
          accepted: aggregate.summary.accepted,
          failed: aggregate.summary.failed,
          completed: aggregate.summary.total,
          attempted,
          unconfirmed: batchSitemapUrls.length,
          remaining,
          unconfirmedBatch: { index: index + 1, total: batches.length, sitemapUrls: batchSitemapUrls },
          partialResult: aggregate,
          cause: cause instanceof CliError
            ? { code: cause.code, message: cause.message, details: cause.details }
            : { message: describeError(cause) },
        },
      })
    }
  }
  return aggregate
}
